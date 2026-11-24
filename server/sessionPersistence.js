import fs from 'fs/promises';
import path from 'path';
import { isStorageCapacityError, toStorageWriteFailure } from '../shared/storageErrors.js';
import {
  getStatus,
  getSetlistFiles,
  getCurrentLyricsState,
  getOutputRegistry,
  buildCurrentState,
  restoreSessionStateInternal,
} from './events.js';

const SESSION_FILE_NAME = 'realtime-session-state.json';
const SAVE_DEBOUNCE_MS = 250;
export const CURRENT_SESSION_SCHEMA_VERSION = 2;

let sessionFilePath = null;
let saveTimer = null;
let saveInFlight = null;
let saveQueued = false;
let lastStorageFailureNoticeAt = 0;

const notifyStorageFailure = (error) => {
  if (!isStorageCapacityError(error) || typeof process.send !== 'function') return;
  const now = Date.now();
  if (now - lastStorageFailureNoticeAt < 60_000) return;
  lastStorageFailureNoticeAt = now;
  const failure = toStorageWriteFailure(error, { subject: 'session changes' });
  try {
    process.send({
      type: 'storage-write-failed',
      operation: 'session-persistence',
      ...failure,
    });
  } catch {
  }
};

const sanitizeStageTimerState = (timerState) => {
  if (!timerState || typeof timerState !== 'object' || Array.isArray(timerState)) return timerState;
  const status = typeof timerState.status === 'string' ? timerState.status : '';
  const isActiveRuntime = Boolean(timerState.running)
    || Boolean(timerState.paused)
    || status === 'running'
    || status === 'paused';
  if (!isActiveRuntime) return timerState;
  return {
    ...timerState,
    status: 'idle',
    running: false,
    paused: false,
    finished: false,
    remaining: null,
    endTime: null,
    updatedAt: Date.now(),
  };
};

const mapToObject = (map) => Object.fromEntries(map instanceof Map ? map.entries() : []);

const objectToMap = (value, fallback = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map(fallback);
  return new Map(Object.entries(value));
};

export const createSessionSnapshot = () => {
  const state = buildCurrentState({ type: 'desktop' });
  const lyrics = getCurrentLyricsState();
  return {
    version: CURRENT_SESSION_SCHEMA_VERSION,
    savedAt: Date.now(),
    currentLyrics: lyrics.lyrics,
    currentLyricsTimestamps: lyrics.timestamps,
    currentLyricsFileName: lyrics.fileName || '',
    currentRawLyricsContent: state.currentRawLyricsContent || '',
    currentSelectedLine: Number.isInteger(lyrics.selectedLine) ? lyrics.selectedLine : null,
    currentLyricsSections: lyrics.sections || [],
    currentLineToSection: lyrics.lineToSection || {},
    currentChordChart: lyrics.chordChart || null,
    isOutputOn: Boolean(state.isOutputOn),
    showState: state.showState || (Boolean(state.isOutputOn) ? 'LIVE' : 'BLACKOUT'),
    tickerQueue: Array.isArray(state.ticker?.queue) ? state.ticker.queue : [],
    tickerActiveId: state.ticker?.activeId ?? null,
    output1Settings: state.output1Settings || {},
    output2Settings: state.output2Settings || {},
    streamSettings: state.streamSettings || {},
    stageSettings: state.stageSettings || {},
    output1Enabled: state.output1Enabled !== false,
    output2Enabled: state.output2Enabled !== false,
    streamEnabled: state.streamEnabled !== false,
    stageEnabled: state.stageEnabled !== false,
    customOutputs: state.customOutputs || [],
    customOutputSettings: state.customOutputSettings || {},
    customOutputEnabled: state.customOutputEnabled || {},
    setlistFiles: getSetlistFiles(),
    stageTimerState: sanitizeStageTimerState(state.stageTimerState || null),
    modeTemplates: state.modeTemplates || {},
    contentMode: state.contentMode || 'song',
    bibleVersion: state.bibleVersion || '',
    currentContentFileName: state.lyricsFileName || '',
    schedule: state.schedule && typeof state.schedule === 'object' ? state.schedule : null,
  };
};

export const migrateSessionSnapshot = (snapshot) => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { valid: false, error: 'Invalid realtime session snapshot' };
  }
  const sourceVersion = snapshot.version == null ? 0 : Number(snapshot.version);
  if (!Number.isInteger(sourceVersion) || sourceVersion < 0) {
    return { valid: false, error: 'Invalid realtime session schema version' };
  }
  if (sourceVersion > CURRENT_SESSION_SCHEMA_VERSION) {
    return {
      valid: false,
      futureVersion: true,
      error: `Realtime session schema ${sourceVersion} requires a newer Selah version`,
    };
  }
  return {
    valid: true,
    migrated: sourceVersion !== CURRENT_SESSION_SCHEMA_VERSION,
    sourceVersion,
    snapshot: sourceVersion === CURRENT_SESSION_SCHEMA_VERSION
      ? snapshot
      : { ...snapshot, version: CURRENT_SESSION_SCHEMA_VERSION },
  };
};

export const applySessionSnapshot = (snapshot) => {
  const migration = migrateSessionSnapshot(snapshot);
  if (!migration.valid) {
    console.warn(`[SessionPersistence] ${migration.error}; snapshot was not applied`);
    return false;
  }
  snapshot = migration.snapshot;

  try {
    restoreSessionStateInternal(snapshot);
    return true;
  } catch (error) {
    console.warn('[SessionPersistence] Failed to apply snapshot:', error.message);
    return false;
  }
};

export async function loadPersistedSessionState({ dataRoot } = {}) {
  if (!dataRoot) return false;
  sessionFilePath = path.join(dataRoot, 'backend', SESSION_FILE_NAME);
  try {
    const raw = await fs.readFile(sessionFilePath, 'utf8');
    const snapshot = JSON.parse(raw);
    const applied = applySessionSnapshot(snapshot);
    if (applied) {
      console.log(`Loaded persisted realtime session state from ${sessionFilePath}`);
    }
    return applied;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('Failed to load persisted realtime session state:', error);
    }
    return false;
  }
}

async function writeSnapshot() {
  if (!sessionFilePath) return;
  if (saveInFlight) {
    saveQueued = true;
    return;
  }
  saveInFlight = (async () => {
    const snapshot = createSessionSnapshot();
    await fs.mkdir(path.dirname(sessionFilePath), { recursive: true });
    const tmpPath = `${sessionFilePath}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(snapshot), 'utf8');
      await fs.rename(tmpPath, sessionFilePath);
    } finally {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
    }
  })();
  try {
    await saveInFlight;
  } catch (error) {
    console.warn('Failed to persist realtime session state:', error);
    notifyStorageFailure(error);
  } finally {
    saveInFlight = null;
    if (saveQueued) {
      saveQueued = false;
      schedulePersistSessionState();
    }
  }
}

export function schedulePersistSessionState() {
  if (!sessionFilePath) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeSnapshot();
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

export async function flushSessionStateNow() {
  if (!sessionFilePath) return false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await writeSnapshot();
  return true;
}