import { createHash } from 'node:crypto';
import { processRawTextToLines, parseLrcContent, deriveSectionsFromProcessedLines } from '../shared/lyricsParsing.js';
import {
  normalizeShowState,
  showStateToMasterOn,
  masterOnToShowState,
  applyMasterToggleToShowState,
  sanitizeTickerText,
  createTickerItem,
  normalizeTickerTarget,
  resolveTickerActive,
  TICKER_MAX_QUEUE,
  DEFAULT_SHOW_STATE,
} from '../shared/showControl.js';
import { isChordChart, parseChordProSource } from '../shared/chords.js';
import createServerLogger from './logger.js';
import { scheduler, startScheduleTickLoop } from './realtime/timerScheduler.js';
import { outputPresence } from './realtime/outputPresence.js';
import {
  CLEARABLE_KEYS,
  stripRuntimeSettings,
  resolveTemplateForOutput,
  resolveTemplateById,
  getTemplateSettings,
  sanitizeModeTemplates,
  loadUserTemplatesForServer,
  getOutputSettingsForServer,
} from './utils/modeTemplates.js';

const log = createServerLogger('Events');

// Socket-boundary sanitizer for the optional bibleVerseLoaded `secondary`
// field (dual-translation parallel display). Returns a clean object or
// null. Never throws; caps sizes to bound broadcast payloads.
function sanitizeBibleParallel(secondary) {
  try {
    if (!secondary || typeof secondary !== 'object') return null;
    const bible = typeof secondary.bible === 'string' ? secondary.bible.slice(0, 120) : '';
    const text = typeof secondary.text === 'string' ? secondary.text.slice(0, 8000) : '';
    const fullText = typeof secondary.fullText === 'string' ? secondary.fullText.slice(0, 8000) : '';
    const slides = Array.isArray(secondary.slides)
      ? secondary.slides
        .map((s) => String(s ?? '').slice(0, 8000))
        .filter((s) => s.trim().length > 0)
        .slice(0, 50)
      : [];
    if (!bible && slides.length === 0 && !text && !fullText) return null;
    return { bible, text, fullText, slides };
  } catch {
    return null;
  }
}

let currentLyrics = [];
let currentLyricsTimestamps = [];
let currentLyricsFileName = '';
let currentSelectedLine = null;
let currentLyricsSections = [];
let currentLineToSection = {};
let currentChordChart = null;
let currentOutput1Settings = {};
let currentOutput2Settings = {};
let currentStageSettings = {};
let currentCustomOutputs = [];
let currentCustomOutputSettings = {};
let currentCustomOutputEnabled = {};
let currentIsOutputOn = false;
let currentShowState = DEFAULT_SHOW_STATE;
let currentTickerQueue = [];
let currentTickerActiveId = null;
let currentOutput1Enabled = true;
let currentOutput2Enabled = true;
let currentStageEnabled = true;
let setlistFiles = [];
let connectedClients = new Map();
let outputInstances = {
  output1: new Map(),
  output2: new Map(),
  stage: new Map()
};
let currentStageTimerState = { running: false, paused: false, endTime: null, remaining: null };
let currentStageMessages = [];
let pendingDrafts = new Map();
let lastStateFingerprintBySocket = new Map();

// Mode templates — server is source of truth
let currentModeTemplates = {
  output1: { enabled: false, song: null, bible: null },
  output2: { enabled: false, song: null, bible: null },
  stage: { enabled: false, song: null, bible: null },
};
let currentContentMode = 'song';
let currentBibleVersion = '';
// Optional linked-translation companion for dual-translation parallel
// display (#16). Null = single-translation. Sanitized subset of the
// bibleVerseLoaded `secondary` field: { bible, text, fullText, slides }.
let currentBibleParallel = null;
let currentContentFileName = '';

let ioInstance = null;
let sessionChangeListeners = [];

function buildSetlistMetadata() {
  return setlistFiles.map((file) => ({
    id: file.id,
    displayName: file.displayName,
    originalName: file.originalName,
    fileType: file.fileType,
    lastModified: file.lastModified,
    addedAt: file.addedAt,
  }));
}

function broadcastSetlistUpdate() {
  if (!ioInstance) return;
  const sockets = ioInstance.sockets?.sockets;
  if (!sockets || sockets.size === 0) {
    ioInstance.emit('setlistUpdate', setlistFiles);
    return;
  }
  const summary = buildSetlistMetadata();
  for (const socket of sockets.values()) {
    const clientInfo = connectedClients.get(socket.id);
    // Once a client has received the full setlist (desktop or via
    // requestSetlist) it keeps receiving the full payload; downgrading it to
    // the summary would wipe locally-held content on every unrelated update.
    if (clientInfo?.type === 'desktop' || socket.fullSetlistGranted) {
      socket.emit('setlistUpdate', setlistFiles);
    } else {
      socket.emit('setlistUpdate', summary);
    }
  }
}

export function onSessionStateChanged(listener) {
  if (typeof listener === 'function') sessionChangeListeners.push(listener);
}

function notifySessionStateChanged() {
  for (const listener of sessionChangeListeners) {
    try { listener(); } catch { }
  }
}

function computeStateFingerprint() {
  const schedule = scheduler.getSnapshot();
  const parts = [
    currentLyrics.length,
    currentLyricsTimestamps.length,
    currentSelectedLine,
    currentLyricsFileName,
    currentIsOutputOn,
    currentShowState,
    currentTickerQueue,
    currentTickerActiveId,
    currentOutput1Enabled,
    currentOutput2Enabled,
    currentStageEnabled,
    setlistFiles.length,
    setlistFiles.map(f => f.id).join(','),
    JSON.stringify(currentOutput1Settings),
    JSON.stringify(currentOutput2Settings),
    JSON.stringify(currentStageSettings),
    JSON.stringify(currentCustomOutputs),
    JSON.stringify(currentCustomOutputSettings),
    JSON.stringify(currentCustomOutputEnabled),
    currentLyricsSections.length,
    currentChordChart ? 1 : 0,
    JSON.stringify(currentModeTemplates),
    currentContentMode,
    currentBibleVersion,
    // Stable schedule identity only (never remainingMs/updatedAt — the
    // live countdown ticks every second and must not dirty the 60s sync).
    schedule.loaded ? `${schedule.schedule?.name}|${schedule.schedule?.items?.length}|${schedule.status}|${schedule.itemIndex}|${schedule.endEpochMs}` : 'no-schedule',
  ];
  return parts.join('|');
}

function getAllOutputsForServer() {
  const builtIns = [
    { id: 'output1', key: 'output1', name: 'Output 1', slug: 'output1', type: 'regular', builtIn: true },
    { id: 'output2', key: 'output2', name: 'Output 2', slug: 'output2', type: 'regular', builtIn: true },
    { id: 'stage', key: 'stage', name: 'Stage', slug: 'stage', type: 'stage', builtIn: true },
  ];
  const customs = (currentCustomOutputs || []).map((o) => ({ ...o, key: o.id, type: o.type === 'stage' ? 'stage' : 'regular', builtIn: false, name: o.name, slug: o.slug }));
  return [...builtIns, ...customs];
}

let modeTemplateGeneration = 0;

export async function applyTemplatesForMode(mode, { silent = false } = {}) {
  const generation = ++modeTemplateGeneration;
  const tMode = mode === 'bible' ? 'bible' : 'song';
  currentContentMode = tMode;
  log.info(`applyTemplatesForMode start mode=${tMode} gen=${generation} templates=${JSON.stringify(currentModeTemplates)} outputs=${getAllOutputsForServer().map(o=>o.key).join(',')}`);
  const outputs = getAllOutputsForServer();
  let userTemplatesCache = null;
  const loadUserTemplates = async () => {
    if (userTemplatesCache !== null) return userTemplatesCache;
    try { userTemplatesCache = await loadUserTemplatesForServer(); } catch { userTemplatesCache = []; }
    return userTemplatesCache;
  };
  const willNeedUser = outputs.some((o) => {
    const cfg = currentModeTemplates[o.key];
    return cfg?.enabled && cfg[tMode] && !resolveTemplateForOutput(cfg[tMode], o, []);
  });
  if (willNeedUser) {
    await loadUserTemplates();
    if (generation !== modeTemplateGeneration) {
      log.debug('applyTemplatesForMode superseded before loop', { generation, current: modeTemplateGeneration });
      return [];
    }
  }
  const outputsApplied = [];
  for (const out of outputs) {
    if (generation !== modeTemplateGeneration) {
      log.debug('applyTemplatesForMode superseded mid-loop', { generation, current: modeTemplateGeneration });
      break;
    }
    const key = out.key;
    const cfg = currentModeTemplates[key];
    if (!cfg?.enabled) continue;
    const templateId = cfg[tMode];
    if (templateId == null || templateId === '__none__') continue;
    let tpl = resolveTemplateForOutput(templateId, out, []);
    if (!tpl) {
      const uts = await loadUserTemplates();
      if (generation !== modeTemplateGeneration) break;
      tpl = resolveTemplateForOutput(templateId, out, uts);
    }
    if (!tpl) {
      const uts2 = await loadUserTemplates();
      if (generation !== modeTemplateGeneration) break;
      tpl = resolveTemplateById(templateId, key, uts2);
    }
    if (generation !== modeTemplateGeneration) break;
    if (!tpl) { log.warn(`Template not found on server: ${templateId} for ${key}`); continue; }
    let rawSettings;
    try { rawSettings = getTemplateSettings(tpl, out); } catch { continue; }
    if (!rawSettings) continue;
    const isStageTemplate = 'liveFontSize' in rawSettings || 'liveColor' in rawSettings;
    const isStageOutput = out.type === 'stage';
    if (isStageOutput && !isStageTemplate) { log.warn(`Skipping regular template for stage ${key}`); continue; }
    if (!isStageOutput && isStageTemplate) { log.warn(`Skipping stage template for regular ${key}`); continue; }
    const settings = stripRuntimeSettings(rawSettings);
    const current = stripRuntimeSettings(getOutputSettingsForServer({ output1Settings: currentOutput1Settings, output2Settings: currentOutput2Settings, stageSettings: currentStageSettings, customOutputSettings: currentCustomOutputSettings }, key));
    const payload = { ...settings };
    for (const k of CLEARABLE_KEYS) { if (!(k in settings) && k in current) payload[k] = null; }
    if (key === 'output1') currentOutput1Settings = { ...currentOutput1Settings, ...payload };
    else if (key === 'output2') currentOutput2Settings = { ...currentOutput2Settings, ...payload };
    else if (key === 'stage') currentStageSettings = { ...currentStageSettings, ...payload };
    else if (key && key.startsWith('custom_')) currentCustomOutputSettings = { ...currentCustomOutputSettings, [key]: { ...(currentCustomOutputSettings[key] || {}), ...payload } };
    if (ioInstance) ioInstance.emit('styleUpdate', { output: key, settings: payload });
    outputsApplied.push(key);
  }
  if (generation !== modeTemplateGeneration) {
    log.debug('applyTemplatesForMode superseded before emit', { generation, current: modeTemplateGeneration });
    return outputsApplied;
  }
  log.info(`applyTemplatesForMode done mode=${tMode} applied=${outputsApplied.join(',') || '(none)'} payloadKeys=${outputsApplied.length}`);
  if (outputsApplied.length === 0) {
    log.info(`No templates applied for ${tMode} — check enabled/bible mappings: ${JSON.stringify(currentModeTemplates)}`);
  }
  if (outputsApplied.length > 0) notifySessionStateChanged();
  if (!silent && outputsApplied.length > 0 && ioInstance) {
    ioInstance.emit('modeTemplateApplied', { mode: tMode, outputsApplied });
  }
  return outputsApplied;
}

export function getModeTemplates() { return { ...currentModeTemplates }; }
export function getContentModeState() { return { mode: currentContentMode, bibleVersion: currentBibleVersion, fileName: currentContentFileName }; }
export function setModeTemplatesInternal(templates) {
  const validKeys = new Set(['output1', 'output2', 'stage', ...currentCustomOutputs.map((o) => o.id)]);
  // allow custom keys even if not yet known — keep them, pruning only truly unknown built-ins is handled via validKeys expansion
  const sanitized = sanitizeModeTemplates(templates, null);
  // also keep any custom_* keys even if not in validKeys yet
  currentModeTemplates = sanitized;
  // ensure built-ins exist
  for (const k of ['output1', 'output2', 'stage']) if (!currentModeTemplates[k]) currentModeTemplates[k] = { enabled: false, song: null, bible: null };
  notifySessionStateChanged();
  return currentModeTemplates;
}

export function getIoInstance() {
  return ioInstance;
}

export function getStatus() {
  return {
    lyricsFile: currentLyricsFileName || '',
    selectedLine: currentSelectedLine,
    isOutputOn: currentIsOutputOn,
    showState: currentShowState,
    ticker: getTickerState(),
    output1Enabled: currentOutput1Enabled,
    output2Enabled: currentOutput2Enabled,
    stageEnabled: currentStageEnabled,
    setlistCount: setlistFiles.length,
    lyricsCount: currentLyrics.length,
    activeLyrics: currentLyrics.slice(0, 5),
    totalLyrics: currentLyrics.length,
    fileName: currentLyricsFileName,
    timestamp: Date.now(),
    hasLyrics: currentLyrics.length > 0,
  };
}

export function getSetlistFiles() {
  return [...setlistFiles];
}

export function getCurrentLyricsState() {
  return {
    lyrics: currentLyrics,
    timestamps: currentLyricsTimestamps,
    fileName: currentLyricsFileName,
    selectedLine: currentSelectedLine,
    sections: currentLyricsSections,
    lineToSection: currentLineToSection,
    chordChart: currentChordChart,
    isOutputOn: currentIsOutputOn,
    showState: currentShowState,
    ticker: getTickerState(),
  };
}

function normalizeSetlistName(value = '') {
  return String(value).trim().replace(/\.(txt|lrc)$/i, '').toLowerCase();
}

export function addSetlistFilesInternal(files, addedBy = { clientType: 'api', deviceId: 'api', sessionId: 'api' }) {
  if (!Array.isArray(files)) throw new Error('files must be an array');
  const totalAfterAdd = setlistFiles.length + files.length;
  if (totalAfterAdd > 50) throw new Error(`Cannot add ${files.length} files. Maximum 50 files allowed.`);

  const MAX_SETLIST_FILE_CONTENT_BYTES = 2 * 1024 * 1024;

  const newFiles = files.map((file, index) => {
    if (!file.name || !file.content) throw new Error(`File ${index + 1} is missing name or content`);
    if (typeof file.content !== 'string' || Buffer.byteLength(file.content, 'utf8') > MAX_SETLIST_FILE_CONTENT_BYTES) {
      throw new Error(`File ${index + 1} exceeds the ${Math.round(MAX_SETLIST_FILE_CONTENT_BYTES / 1024 / 1024)}MB content limit`);
    }
    const lowerName = file.name.toLowerCase();
    const isLrc = lowerName.endsWith('.lrc');
    const displayName = file.name.replace(/\.(txt|lrc)$/i, '');
    const normalizedIncoming = normalizeSetlistName(file.name);
    const alreadyExists = setlistFiles.some((existing) => {
      const candidate = existing?.displayName ?? existing?.originalName ?? '';
      return normalizeSetlistName(candidate) === normalizedIncoming;
    });
    if (alreadyExists) throw new Error(`File "${displayName}" already exists in setlist`);
    return {
      id: `setlist_${Date.now()}_${index}_${Math.random().toString(36).slice(2,7)}`,
      displayName,
      originalName: file.name,
      content: file.content,
      lastModified: file.lastModified || Date.now(),
      addedAt: Date.now(),
      fileType: isLrc ? 'lrc' : 'txt',
      metadata: file.metadata || null,
      addedBy,
    };
  });

  setlistFiles.push(...newFiles);
  log.info(`Added ${newFiles.length} files to setlist via API. Total: ${setlistFiles.length}`);
  broadcastSetlistUpdate();
  notifySessionStateChanged();
  return newFiles;
}

export function removeSetlistFileInternal(fileId) {
  const initialCount = setlistFiles.length;
  setlistFiles = setlistFiles.filter(file => file.id !== fileId);
  const removed = setlistFiles.length < initialCount;
  if (removed) broadcastSetlistUpdate();
  if (removed) notifySessionStateChanged();
  return removed;
}

export function clearSetlistInternal() {
  setlistFiles = [];
  broadcastSetlistUpdate();
  notifySessionStateChanged();
  log.info('Setlist cleared via API');
}

export function reorderSetlistInternal(orderedIds) {
  if (!Array.isArray(orderedIds)) throw new Error('Invalid reorder payload');
  if (orderedIds.length !== setlistFiles.length) throw new Error('Reorder payload does not match setlist size');
  const idToFile = new Map(setlistFiles.map((file) => [file.id, file]));
  const seen = new Set();
  const reordered = [];
  for (const id of orderedIds) {
    if (seen.has(id)) throw new Error('Duplicate entries in reorder payload');
    seen.add(id);
    const file = idToFile.get(id);
    if (!file) throw new Error('Unknown setlist entry in reorder payload');
    reordered.push(file);
  }
  if (reordered.length !== setlistFiles.length) throw new Error('Reorder payload incomplete');
  setlistFiles = reordered;
  broadcastSetlistUpdate();
  notifySessionStateChanged();
  return setlistFiles;
}

/** Parse a local song into an operator chord chart and clean audience lyrics. */
export function parseSongText(rawText, options = {}) {
  const source = typeof rawText === 'string' ? rawText : '';
  try {
    const { chart, lyricsText } = parseChordProSource(source);
    const processedLines = processRawTextToLines(lyricsText, {
      enableNormalGrouping: options.enableNormalGrouping,
      enableSplitting: options.enableSplitting,
    });
    const derived = deriveSectionsFromProcessedLines(processedLines);
    return {
      chart: chart?.sections?.length ? chart : null,
      lyricsText,
      processedLines,
      sections: derived.sections || [],
      lineToSection: derived.lineToSection || {},
    };
  } catch (err) {
    // Fail closed. Falling back to raw ChordPro could leak chord markup to
    // audience outputs, so surface no lyrics until the source can be parsed.
    log.warn('ChordPro parse failed; audience lyrics withheld:', err?.message || err);
    return {
      chart: null,
      lyricsText: '',
      processedLines: [],
      sections: [],
      lineToSection: {},
    };
  }
}

/** Returns null for lyric-only songs so every downstream view stays unchanged. */
function parseChordChartFromText(rawText) {
  return parseSongText(rawText).chart;
}

function emitChordChartToStages(chart = currentChordChart) {
  if (!ioInstance) return;
  for (const client of connectedClients.values()) {
    if (client.type === 'stage' && client.socket?.connected) {
      client.socket.emit('chordChartLoaded', isChordChart(chart) ? chart : null);
    }
  }
}

/** Broadcast clean lyrics everywhere, then send chart data only to Stage. */
function emitLyricsLoadToClients(lines) {
  if (!ioInstance) return;
  ioInstance.emit('lyricsLoad', lines);
  emitChordChartToStages(currentChordChart);
}

export function loadSetlistFileInternal(fileId, options = {}) {
  const file = setlistFiles.find(f => f.id === fileId);
  if (!file) throw new Error('File not found in setlist');
  let processedLines;
  let timestamps = [];
  let sanitizedRawContent = file.content;
  let sections = [];
  let lineToSection = {};
  let chordChart = null;
  const { enableNormalGrouping, enableSplitting } = options;
  const isLrc = (file.fileType === 'lrc') ||
    (typeof file.originalName === 'string' && file.originalName.toLowerCase().endsWith('.lrc'));
  if (isLrc) {
    const parsed = parseLrcContent(file.content, { enableNormalGrouping, enableSplitting });
    processedLines = parsed.processedLines;
    timestamps = parsed.timestamps || [];
    sanitizedRawContent = parsed.rawText;
    sections = parsed.sections || [];
    lineToSection = parsed.lineToSection || {};
  } else {
    const parsedSong = parseSongText(file.content, { enableNormalGrouping, enableSplitting });
    processedLines = parsedSong.processedLines;
    timestamps = [];
    chordChart = parsedSong.chart;
    sections = parsedSong.sections;
    lineToSection = parsedSong.lineToSection;
  }
  const cleanDisplayName = (file.displayName || file.originalName || '').replace(/\.(txt|lrc)$/i, '') || file.displayName;
  currentLyrics = processedLines;
  currentLyricsTimestamps = timestamps;
  currentSelectedLine = null;
  currentLyricsFileName = cleanDisplayName;
  currentLyricsSections = sections;
  currentLineToSection = lineToSection;
  currentChordChart = chordChart;
  // setlist files can be bible-type if metadata says so
  const isBibleFile = file.metadata?.type === 'bible' || file.metadata?.bibleId || file.metadata?.bible;
  currentContentMode = isBibleFile ? 'bible' : 'song';
  currentBibleVersion = isBibleFile ? (file.metadata?.bibleId || file.metadata?.bible || currentBibleVersion) : '';
  currentContentFileName = cleanDisplayName;
  log.info(`Loaded "${cleanDisplayName}" from setlist via API (${processedLines.length} lines) mode=${currentContentMode}`);
  notifySessionStateChanged();
  if (ioInstance) {
    emitLyricsLoadToClients(processedLines);
    ioInstance.emit('lyricsTimestampsUpdate', timestamps);
    ioInstance.emit('lyricsSectionsUpdate', { sections, lineToSection });
    ioInstance.emit('setlistLoadSuccess', {
      fileId,
      fileName: cleanDisplayName,
      originalName: file.originalName,
      fileType: file.fileType || (isLrc ? 'lrc' : 'txt'),
      linesCount: processedLines.length,
      rawContent: sanitizedRawContent,
      loadedBy: 'api',
      metadata: {
        ...(file.metadata || {}),
        sections,
        lineToSection,
      }
    });
    ioInstance.emit('contentModeUpdate', { mode: currentContentMode, bibleVersion: currentBibleVersion, fileName: cleanDisplayName });
  } 
  // Manual-only: no applyTemplatesForMode here. Templates change outputs
  // only via explicit control-panel action (styleUpdate relay below).
  return {
    fileId,
    fileName: cleanDisplayName,
    linesCount: processedLines.length,
    rawContent: sanitizedRawContent,
  };
}

export function setSelectedLineInternal(index) {
  if (index !== null && (!Number.isInteger(index) || index < 0)) throw new Error('Invalid line index');
  if (index !== null && currentLyrics.length > 0 && index >= currentLyrics.length) throw new Error('Line index out of bounds');
  currentSelectedLine = index;
  if (ioInstance) ioInstance.emit('lineUpdate', { index });
  notifySessionStateChanged();
  return currentSelectedLine;
}

export function nextLineInternal() {
  if (currentLyrics.length === 0) throw new Error('No lyrics loaded');
  if (currentSelectedLine === null || currentSelectedLine === undefined) {
    currentSelectedLine = 0;
  } else {
    currentSelectedLine = Math.min(currentSelectedLine + 1, currentLyrics.length - 1);
  }
  if (ioInstance) ioInstance.emit('lineUpdate', { index: currentSelectedLine });
  notifySessionStateChanged();
  return currentSelectedLine;
}

export function prevLineInternal() {
  if (currentLyrics.length === 0) throw new Error('No lyrics loaded');
  if (currentSelectedLine === null || currentSelectedLine === undefined) {
    currentSelectedLine = 0;
  } else {
    currentSelectedLine = Math.max(currentSelectedLine - 1, 0);
  }
  if (ioInstance) ioInstance.emit('lineUpdate', { index: currentSelectedLine });
  notifySessionStateChanged();
  return currentSelectedLine;
}

export function gotoLineInternal(lineIndex) {
  if (!Number.isInteger(lineIndex) || lineIndex < 0) throw new Error('Invalid line index');
  if (currentLyrics.length > 0 && lineIndex >= currentLyrics.length) throw new Error('Line index out of bounds');
  currentSelectedLine = lineIndex;
  if (ioInstance) ioInstance.emit('lineUpdate', { index: currentSelectedLine });
  notifySessionStateChanged();
  return currentSelectedLine;
}

export function loadRawTextInternal(title, content, options = {}) {
  if (!content || typeof content !== 'string') throw new Error('Content is required');
  const parsedSong = parseSongText(content, {
    enableNormalGrouping: options?.enableNormalGrouping,
    enableSplitting: options?.enableSplitting,
  });
  const processedLines = parsedSong.processedLines;
  currentLyrics = processedLines;
  currentLyricsTimestamps = [];
  currentLyricsSections = parsedSong.sections;
  currentLineToSection = parsedSong.lineToSection;
  currentChordChart = options?.contentMode === 'bible' ? null : parsedSong.chart;
  currentSelectedLine = null;
  currentLyricsFileName = title || 'Untitled';
  const requestedMode = options?.contentMode === 'bible' ? 'bible' : options?.contentMode === 'song' ? 'song' : null;
  if (requestedMode) {
    currentContentMode = requestedMode;
    if (requestedMode === 'bible') currentBibleVersion = options?.bibleVersion || currentBibleVersion || 'bible';
    else currentBibleVersion = '';
    currentContentFileName = currentLyricsFileName;
  } else if (title && currentContentMode === 'bible' && !options?.preserveMode) {
    // heuristic: if already bible mode and new title looks like bible reference, keep bible; else song logic handled by caller
  }
  log.info(`Loaded raw text via API: "${currentLyricsFileName}" (${processedLines.length} lines) mode=${currentContentMode}`);
  if (ioInstance) {
    emitLyricsLoadToClients(currentLyrics);
    ioInstance.emit('lyricsTimestampsUpdate', currentLyricsTimestamps);
    ioInstance.emit('lyricsSectionsUpdate', { sections: currentLyricsSections, lineToSection: currentLineToSection });
    ioInstance.emit('fileNameUpdate', currentLyricsFileName);
    ioInstance.emit('setlistLoadSuccess', {
      fileId: null,
      fileName: currentLyricsFileName,
      originalName: `${currentLyricsFileName}.txt`,
      fileType: 'txt',
      linesCount: currentLyrics.length,
      rawContent: content,
      loadedBy: 'api',
    });
    if (requestedMode) {
      ioInstance.emit('contentModeUpdate', { mode: currentContentMode, bibleVersion: currentBibleVersion, fileName: currentContentFileName });
      // Manual-only: no server template apply. Control applies explicitly.
    }
  }
  return {
    fileName: currentLyricsFileName,
    linesCount: processedLines.length,
    lines: processedLines,
  };
}

export function loadBibleVerseInternal(reference, content, options = {}) {
  return loadRawTextInternal(reference, content, { ...options, contentMode: 'bible', bibleVersion: options?.bibleVersion || options?.bible || '' });
}

export function restoreSessionStateInternal(snapshot = {}) {
  let restoredAnything = false;

  if (Array.isArray(snapshot.currentLyrics) && snapshot.currentLyrics.length > 0) {
    currentLyrics = snapshot.currentLyrics;
    currentLyricsTimestamps = Array.isArray(snapshot.currentLyricsTimestamps) ? snapshot.currentLyricsTimestamps : [];
    currentLyricsFileName = typeof snapshot.currentLyricsFileName === 'string' ? snapshot.currentLyricsFileName : '';
    currentLyricsSections = Array.isArray(snapshot.currentLyricsSections)
      ? snapshot.currentLyricsSections
      : deriveSectionsFromProcessedLines(currentLyrics).sections || [];
    currentLineToSection = snapshot.currentLineToSection && typeof snapshot.currentLineToSection === 'object'
      ? snapshot.currentLineToSection
      : {};
    currentSelectedLine = Number.isInteger(snapshot.currentSelectedLine) ? snapshot.currentSelectedLine : null;
    // Restore the chord chart when present; fall back to re-parsing the saved
    // raw text so pre-chart snapshots still chart correctly. Lyric-only songs
    // restore with a null chart, unchanged from before.
    currentChordChart = isChordChart(snapshot.currentChordChart)
      ? snapshot.currentChordChart
      : parseChordChartFromText(snapshot.currentRawLyricsContent);
    restoredAnything = true;
  }

  if (typeof snapshot.isOutputOn === 'boolean') {
    currentIsOutputOn = snapshot.isOutputOn;
    restoredAnything = true;
  }
  if (typeof snapshot.showState === 'string') {
    currentShowState = normalizeShowState(snapshot.showState, currentIsOutputOn ? 'LIVE' : 'BLACKOUT');
    currentIsOutputOn = showStateToMasterOn(currentShowState);
    restoredAnything = true;
  }
  if (Array.isArray(snapshot.tickerQueue)) {
    currentTickerQueue = snapshot.tickerQueue
      .filter((item) => item && typeof item.text === 'string' && item.text.trim().length > 0)
      .slice(0, TICKER_MAX_QUEUE)
      .map((item) => createTickerItem(item.text, {
        id: String(item.id || `ticker_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
        targetOutput: item.targetOutput,
        style: item.style,
      }));
    restoredAnything = true;
  }
  if (typeof snapshot.tickerActiveId === 'string' || snapshot.tickerActiveId === null) {
    currentTickerActiveId = snapshot.tickerActiveId;
    restoredAnything = true;
  }
  if (typeof snapshot.output1Enabled === 'boolean') {
    currentOutput1Enabled = snapshot.output1Enabled;
    restoredAnything = true;
  }
  if (typeof snapshot.output2Enabled === 'boolean') {
    currentOutput2Enabled = snapshot.output2Enabled;
    restoredAnything = true;
  }
  if (typeof snapshot.stageEnabled === 'boolean') {
    currentStageEnabled = snapshot.stageEnabled;
    restoredAnything = true;
  }
  if (snapshot.output1Settings && typeof snapshot.output1Settings === 'object') {
    currentOutput1Settings = snapshot.output1Settings;
    restoredAnything = true;
  }
  if (snapshot.output2Settings && typeof snapshot.output2Settings === 'object') {
    currentOutput2Settings = snapshot.output2Settings;
    restoredAnything = true;
  }
  if (snapshot.stageSettings && typeof snapshot.stageSettings === 'object') {
    currentStageSettings = snapshot.stageSettings;
    restoredAnything = true;
  }
  if (Array.isArray(snapshot.customOutputs)) {
    currentCustomOutputs = snapshot.customOutputs;
    restoredAnything = true;
  }
  if (snapshot.customOutputSettings && typeof snapshot.customOutputSettings === 'object') {
    currentCustomOutputSettings = snapshot.customOutputSettings;
    restoredAnything = true;
  }
  if (snapshot.customOutputEnabled && typeof snapshot.customOutputEnabled === 'object') {
    currentCustomOutputEnabled = snapshot.customOutputEnabled;
    restoredAnything = true;
  }
  if (snapshot.stageTimerState && typeof snapshot.stageTimerState === 'object') {
    currentStageTimerState = sanitizeRestoredStageTimer(snapshot.stageTimerState);
    restoredAnything = true;
  }
  // Service run-sheet clock: a reboot mid-service resumes paused with
  // remaining time intact — never silently running (see timerScheduler).
  if (snapshot.schedule && typeof snapshot.schedule === 'object' && snapshot.schedule.loaded === true) {
    try {
      if (scheduler.restoreSnapshot(snapshot.schedule)) restoredAnything = true;
    } catch (error) {
      log.warn('Schedule snapshot restore failed (non-critical):', error?.message || error);
    }
  }
  if (Array.isArray(snapshot.currentStageMessages) && snapshot.currentStageMessages.length > 0) {
    currentStageMessages = snapshot.currentStageMessages;
    restoredAnything = true;
  }

  if (snapshot.modeTemplates && typeof snapshot.modeTemplates === 'object') {
    currentModeTemplates = sanitizeModeTemplates(snapshot.modeTemplates, null);
    for (const k of ['output1', 'output2', 'stage']) if (!currentModeTemplates[k]) currentModeTemplates[k] = { enabled: false, song: null, bible: null, freenote: null };
    restoredAnything = true;
  }
  if (typeof snapshot.contentMode === 'string') {
    currentContentMode = snapshot.contentMode === 'bible' ? 'bible' : snapshot.contentMode === 'freenote' ? 'freenote' : 'song';
    restoredAnything = true;
  }
  if (typeof snapshot.bibleVersion === 'string') {
    currentBibleVersion = snapshot.bibleVersion;
    restoredAnything = true;
  }
  if (typeof snapshot.currentContentFileName === 'string') {
    currentContentFileName = snapshot.currentContentFileName;
    restoredAnything = true;
  }

  if (Array.isArray(snapshot.setlistFiles) && snapshot.setlistFiles.length > 0) {
    const restoredFiles = snapshot.setlistFiles
      .filter((file) => file && typeof file.name === 'string' && typeof file.content === 'string')
      .map((file) => ({
        id: file.id || `setlist_restored_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        displayName: file.displayName || file.name.replace(/\.(txt|lrc)$/i, ''),
        originalName: file.originalName || file.name,
        content: file.content,
        lastModified: file.lastModified || Date.now(),
        addedAt: file.addedAt || Date.now(),
        fileType: file.fileType || (file.name.toLowerCase().endsWith('.lrc') ? 'lrc' : 'txt'),
        metadata: file.metadata || null,
        addedBy: { clientType: 'api', deviceId: 'restore', sessionId: 'restore' },
      }))
      .slice(0, 50 - setlistFiles.length);
    setlistFiles.push(...restoredFiles);
    restoredAnything = true;
  }

  if (!restoredAnything) return false;

  if (currentIsOutputOn) {
    log.warn('Session restore: outputs are being re-enabled from pre-restart state. Verify outputs before the next service starts.');
  }

  if (ioInstance) {
    emitLyricsLoadToClients(currentLyrics);
    ioInstance.emit('lyricsTimestampsUpdate', currentLyricsTimestamps);
    ioInstance.emit('lyricsSectionsUpdate', { sections: currentLyricsSections, lineToSection: currentLineToSection });
    if (currentLyricsFileName) ioInstance.emit('fileNameUpdate', currentLyricsFileName);
    if (currentSelectedLine !== null && currentSelectedLine !== undefined) {
      ioInstance.emit('lineUpdate', { index: currentSelectedLine });
    }
    ioInstance.emit('outputToggle', currentIsOutputOn);
    ioInstance.emit('showStateUpdate', { state: currentShowState });
    ioInstance.emit('tickerUpdate', getTickerState());
    ioInstance.emit('individualOutputToggle', { output: 'output1', enabled: currentOutput1Enabled });
    ioInstance.emit('individualOutputToggle', { output: 'output2', enabled: currentOutput2Enabled });
    ioInstance.emit('individualOutputToggle', { output: 'stage', enabled: currentStageEnabled });
    ioInstance.emit('styleUpdate', { output: 'output1', settings: currentOutput1Settings });
    ioInstance.emit('styleUpdate', { output: 'output2', settings: currentOutput2Settings });
    ioInstance.emit('styleUpdate', { output: 'stage', settings: currentStageSettings });
    ioInstance.emit('outputRegistryUpdate', {
      customOutputs: currentCustomOutputs,
      customOutputSettings: currentCustomOutputSettings,
      customOutputEnabled: currentCustomOutputEnabled,
    });
    broadcastSetlistUpdate();
    if (currentStageMessages.length > 0) {
      ioInstance.emit('stageMessagesUpdate', currentStageMessages);
    }
  }
  notifySessionStateChanged();
  return true;
}

function sanitizeRestoredStageTimer(timerState) {
  const status = typeof timerState.status === 'string' ? timerState.status : '';
  const isActiveRuntime = Boolean(timerState.running)
    || Boolean(timerState.paused)
    || status === 'running'
    || status === 'paused';
  if (!isActiveRuntime) return { ...timerState };
  return {
    running: false,
    paused: false,
    endTime: null,
    remaining: null,
    updatedAt: Date.now(),
  };
}

export function getShowState() {
  return currentShowState;
}

export function getTickerState() {
  const queue = Array.isArray(currentTickerQueue) ? [...currentTickerQueue] : [];
  return {
    queue,
    activeId: currentTickerActiveId,
    active: resolveTickerActive(queue, currentTickerActiveId),
  };
}

/**
 * Set the explicit show-state (LIVE / CLEAR / BLACKOUT / LOGO).
 * The legacy master boolean is derived so old consumers keep working, and
 * both `showStateUpdate` and `outputToggle` are broadcast for compatibility.
 */
export function setShowStateInternal(state) {
  currentShowState = normalizeShowState(state);
  currentIsOutputOn = showStateToMasterOn(currentShowState);
  if (ioInstance) {
    ioInstance.emit('showStateUpdate', { state: currentShowState });
    ioInstance.emit('outputToggle', currentIsOutputOn);
  }
  notifySessionStateChanged();
  return currentShowState;
}

export function addTickerItemInternal(text, options = {}) {
  const clean = sanitizeTickerText(text);
  if (!clean) throw new Error('Announcement text required');
  if (currentTickerQueue.length >= TICKER_MAX_QUEUE) {
    throw new Error(`Announcement queue full (max ${TICKER_MAX_QUEUE})`);
  }
  const targetOutput = normalizeTickerTarget(options.targetOutput ?? options.targetOutputKey);
  const item = createTickerItem(clean, { targetOutput, style: options.style });
  currentTickerQueue = [...currentTickerQueue, item];
  if (!currentTickerActiveId) currentTickerActiveId = item.id;
  try {
    // Backend-only logging here: importing main-process modules from the
    // forked server breaks packaged builds (server ships unpacked, main
    // stays inside the asar, so ../main does not resolve in production).
    log.info('announcement queued', {
      id: item.id,
      targetOutput: item.targetOutput ?? 'all',
      textChars: item.text.length,
      style: item.style,
    });
  } catch {
    // Diagnostics must never break the queue.
  }
  if (ioInstance) ioInstance.emit('tickerUpdate', getTickerState());
  notifySessionStateChanged();
  return item;
}

export function removeTickerItemInternal(id) {
  const before = currentTickerQueue.length;
  currentTickerQueue = currentTickerQueue.filter((item) => item?.id !== id);
  if (currentTickerActiveId === id) {
    currentTickerActiveId = currentTickerQueue.length > 0 ? currentTickerQueue[0].id : null;
  }
  const removed = currentTickerQueue.length < before;
  if (removed) {
    if (ioInstance) ioInstance.emit('tickerUpdate', getTickerState());
    notifySessionStateChanged();
  }
  return removed;
}

export function clearTickerInternal() {
  currentTickerQueue = [];
  currentTickerActiveId = null;
  if (ioInstance) ioInstance.emit('tickerUpdate', getTickerState());
  notifySessionStateChanged();
}

export function showTickerItemInternal(id) {
  if (id !== null && id !== undefined) {
    const found = currentTickerQueue.find((item) => item?.id === id);
    if (!found) throw new Error('Announcement not found');
    currentTickerActiveId = found.id;
  } else {
    currentTickerActiveId = null;
  }
  if (ioInstance) ioInstance.emit('tickerUpdate', getTickerState());
  notifySessionStateChanged();
  return getTickerState();
}

export function toggleOutputInternal(on) {
  if (typeof on === 'boolean') {
    currentIsOutputOn = on;
    currentShowState = masterOnToShowState(on);
  } else if (typeof on === 'string' && (on.trim().toUpperCase() === 'LIVE' || on.trim().toUpperCase() === 'CLEAR' || on.trim().toUpperCase() === 'BLACKOUT' || on.trim().toUpperCase() === 'LOGO')) {
    currentShowState = normalizeShowState(on);
    currentIsOutputOn = showStateToMasterOn(currentShowState);
  } else if (on === undefined || on === null) {
    // Legacy bare toggle: flip the master boolean explicitly.
    currentIsOutputOn = !currentIsOutputOn;
    currentShowState = masterOnToShowState(currentIsOutputOn);
  } else {
    currentShowState = applyMasterToggleToShowState(currentShowState, Boolean(on));
    currentIsOutputOn = showStateToMasterOn(currentShowState);
  }
  if (ioInstance) {
    ioInstance.emit('outputToggle', currentIsOutputOn);
    ioInstance.emit('showStateUpdate', { state: currentShowState });
  }
  notifySessionStateChanged();
  return currentIsOutputOn;
}

export default function registerSocketEvents(io, { hasPermission }) {
  ioInstance = io;
  // Authoritative run-sheet clock emits through the socket server; the
  // 1s tick loop is process-wide (started once, unref'd).
  scheduler.setEmitter((event, payload) => {
    try { io.emit(event, payload); } catch { }
  });
  startScheduleTickLoop();
  if (typeof global !== 'undefined') {
    global.ioInstance = io;
  }

  const broadcastOutputPresence = () => {
    if (!ioInstance) return;
    ioInstance.emit('outputPresenceUpdate', outputPresence.snapshot());
  };
  io.on('connection', (socket) => {
    const { clientType, deviceId, sessionId } = socket.userData;
    log.info(`Authenticated user connected: ${clientType} (${deviceId}) - Socket: ${socket.id}`);

    connectedClients.set(socket.id, {
      type: clientType,
      deviceId,
      sessionId,
      socket,
      permissions: socket.userData.permissions,
      connectedAt: socket.userData.connectedAt
    });

    // Feature #03: track live output instances (clientType + declared purpose).
    const presenceEntry = outputPresence.register({
      socketId: socket.id,
      clientType,
      purpose: socket.handshake?.auth?.purpose,
      deviceId,
      sessionId,
    });
    if (presenceEntry) broadcastOutputPresence();

    socket.on('clientConnect', ({ type }) => {
      if (type !== clientType) {
        log.warn(`Client ${socket.id} claimed type ${type} but authenticated as ${clientType}`);
        socket.emit('authError', 'Client type mismatch with authentication');
        return;
      }

      log.info(`Client ${socket.id} confirmed as: ${type}`);
      const info = connectedClients.get(socket.id);
      if (type === 'mobile' || type === 'web') {
        socket.emit('currentState', buildStateSummary(info));
      } else {
        socket.emit('currentState', buildCurrentState(info));
      }
    });

    socket.on('requestCurrentState', (payload) => {
      if (!hasPermission(socket, 'lyrics:read')) {
        socket.emit('permissionError', 'Insufficient permissions to read current state');
        return;
      }

      log.info('State requested by authenticated client:', socket.id);
      const clientInfo = connectedClients.get(socket.id);
      // Mobile fast path: { light: true } gets the <4KB snapshot (no file
      // contents) instead of the full desktop state. Prevents a 1KB lyric
      // from costing 100KB+ over church Wi-Fi / Tailscale.
      const wantsLight = payload && typeof payload === 'object' && (payload.light === true || payload.summary === true);
      const isController = clientInfo?.type === 'mobile' || clientInfo?.type === 'web';
      if (wantsLight || (isController && payload === undefined && socket.lightStatePreferred)) {
        socket.emit('currentState', { ...buildLightState(clientInfo), light: true });
      } else if (isController && !socket.fullSetlistGranted) {
        // Controllers default to the summary shape (metadata only) unless
        // they explicitly asked for full content via requestSetlist.
        socket.emit('currentState', buildStateSummary(clientInfo));
      } else {
        socket.emit('currentState', buildCurrentState(clientInfo));
      }
      log.info(`Current state sent to: ${socket.id} (${currentLyrics.length} lyrics, ${setlistFiles.length} setlist items)`);
    });

    // Explicit light-state + fingerprint sync for phones on slow links.
    // requestLightState -> currentState (light:true); requestSync {since} ->
    // syncState { changed, fingerprint, state? } — ~100 bytes when unchanged.
    socket.on('requestLightState', () => {
      if (!hasPermission(socket, 'lyrics:read')) {
        socket.emit('permissionError', 'Insufficient permissions to read current state');
        return;
      }
      socket.lightStatePreferred = true;
      const clientInfo = connectedClients.get(socket.id);
      socket.emit('currentState', { ...buildLightState(clientInfo), light: true });
    });

    socket.on('requestSync', (payload) => {
      if (!hasPermission(socket, 'lyrics:read')) {
        socket.emit('permissionError', 'Insufficient permissions to read current state');
        return;
      }
      const since = payload && typeof payload === 'object' ? String(payload.since || payload.fingerprint || '') : String(payload || '');
      const fingerprint = getStateFingerprint();
      if (since && since === fingerprint) {
        socket.emit('syncState', { changed: false, fingerprint, timestamp: Date.now() });
        return;
      }
      const clientInfo = connectedClients.get(socket.id);
      socket.emit('syncState', { changed: true, fingerprint, state: buildLightState(clientInfo), timestamp: Date.now() });
    });

    socket.on('requestSetlist', () => {
      if (!hasPermission(socket, 'setlist:read')) {
        socket.emit('permissionError', 'Insufficient permissions to access setlist');
        return;
      }

      socket.fullSetlistGranted = true;
      socket.emit('setlistUpdate', setlistFiles);
      log.info('Setlist sent to authenticated client:', socket.id, `(${setlistFiles.length} items)`);
    });

    socket.on('setlistAdd', (files) => {
      if (!hasPermission(socket, 'setlist:write')) {
        socket.emit('permissionError', 'Insufficient permissions to modify setlist');
        return;
      }

      try {
        const added = addSetlistFilesInternal(files, { clientType, deviceId, sessionId });
        socket.emit('setlistAddSuccess', {
          addedCount: added.length,
          totalCount: setlistFiles.length
        });
      } catch (error) {
        log.error('setlistAdd error:', error.message);
        socket.emit('setlistError', error.message);
      }
    });

    socket.on('setlistRemove', (fileId) => {
      if (!hasPermission(socket, 'setlist:write')) {
        socket.emit('permissionError', 'Insufficient permissions to modify setlist');
        return;
      }

      try {
        const fileToRemove = setlistFiles.find(file => file.id === fileId);

        if (!hasPermission(socket, 'admin:full') &&
          fileToRemove?.addedBy?.sessionId !== sessionId) {
          socket.emit('permissionError', 'You can only remove files you added');
          return;
        }

        const removed = removeSetlistFileInternal(fileId);
        if (removed) {
          log.info(`${clientType} client removed file ${fileId} from setlist. Remaining: ${setlistFiles.length}`);
          socket.emit('setlistRemoveSuccess', fileId);
        } else {
          socket.emit('setlistError', 'File not found in setlist');
        }
      } catch (error) {
        log.error('setlistRemove error:', error.message);
        socket.emit('setlistError', error.message);
      }
    });

    socket.on('setlistLoad', (payload) => {
      if (!hasPermission(socket, 'setlist:read')) {
        socket.emit('permissionError', 'Insufficient permissions to read setlist');
        return;
      }

      try {
        const fileId = typeof payload === 'string' || typeof payload === 'number' ? payload : payload?.fileId;
        loadSetlistFileInternal(fileId, { enableNormalGrouping: payload?.enableNormalGrouping, enableSplitting: payload?.enableSplitting });
      } catch (error) {
        log.error('setlistLoad error:', error.message);
        socket.emit('setlistError', error.message);
      }
    });

    socket.on('setlistClear', () => {
      if (!hasPermission(socket, 'setlist:delete')) {
        socket.emit('permissionError', 'Insufficient permissions to clear setlist');
        return;
      }

      clearSetlistInternal();
      log.info(`Setlist cleared by ${clientType} client`);
      socket.emit('setlistClearSuccess');
    });

    socket.on('setlistReorder', (payload) => {
      if (!hasPermission(socket, 'setlist:write')) {
        socket.emit('permissionError', 'Insufficient permissions to modify setlist ordering');
        return;
      }

      try {
        const orderedIds = Array.isArray(payload) ? payload : payload?.orderedIds;
        reorderSetlistInternal(orderedIds);
        log.info(`${clientType} client reordered setlist (${setlistFiles.length} items)`);
        socket.emit('setlistReorderSuccess', {
          orderedIds,
          totalCount: setlistFiles.length,
        });
      } catch (e) {
        socket.emit('setlistError', e.message);
      }
    });

    socket.on('lineUpdate', ({ index }) => {
      if (!hasPermission(socket, 'output:control')) {
        socket.emit('permissionError', 'Insufficient permissions to control output');
        return;
      }

      try {
        setSelectedLineInternal(index);
        log.info(`Line updated to ${index} by ${clientType} client`);
      } catch (e) {
        socket.emit('permissionError', e.message);
      }
    });

    socket.on('outputToggle', (state) => {
      if (!hasPermission(socket, 'output:control')) {
        socket.emit('permissionError', 'Insufficient permissions to control output');
        return;
      }

      // Legacy master toggle maps onto the show-state machine (ON -> LIVE,
      // OFF -> BLACKOUT) so existing controllers keep working unchanged.
      if (typeof state === 'boolean') {
        setShowStateInternal(masterOnToShowState(state));
      } else if (typeof state === 'string' && ['LIVE', 'CLEAR', 'BLACKOUT', 'LOGO'].includes(state.trim().toUpperCase())) {
        setShowStateInternal(normalizeShowState(state));
      } else if (state && typeof state === 'object' && typeof state.state === 'string' && ['LIVE', 'CLEAR', 'BLACKOUT', 'LOGO'].includes(state.state.trim().toUpperCase())) {
        setShowStateInternal(normalizeShowState(state.state));
      } else {
        toggleOutputInternal(state);
      }
      log.info(`Output toggled to ${currentShowState} (master ${currentIsOutputOn ? 'on' : 'off'}) by ${clientType} client`);
    });

    socket.on('showStateUpdate', (payload) => {
      if (!hasPermission(socket, 'output:control')) {
        socket.emit('permissionError', 'Insufficient permissions to control output');
        return;
      }

      const next = payload && typeof payload === 'object' ? payload.state : payload;
      if (typeof next !== 'string' || !['LIVE', 'CLEAR', 'BLACKOUT', 'LOGO'].includes(next.trim().toUpperCase())) {
        socket.emit('showStateError', 'state must be one of LIVE, CLEAR, BLACKOUT, LOGO');
        return;
      }
      setShowStateInternal(normalizeShowState(next));
      log.info(`Show state set to ${currentShowState} by ${clientType} client`);
    });

    socket.on('tickerAdd', (payload) => {
      if (!hasPermission(socket, 'output:control')) {
        socket.emit('permissionError', 'Insufficient permissions to control announcements');
        return;
      }

      try {
        const text = payload && typeof payload === 'object' ? payload.text : payload;
        const targetOutput = payload && typeof payload === 'object'
          ? (payload.targetOutput ?? payload.targetOutputKey)
          : null;
        const style = payload && typeof payload === 'object' ? payload.style : undefined;
        const item = addTickerItemInternal(text, { targetOutput, style });
        log.info(`Announcement added by ${clientType} client (${item.id})`);
        socket.emit('tickerAddSuccess', { item });
      } catch (error) {
        log.error('tickerAdd error:', error.message);
        socket.emit('tickerError', error.message);
      }
    });

    socket.on('tickerRemove', (payload) => {
      if (!hasPermission(socket, 'output:control')) {
        socket.emit('permissionError', 'Insufficient permissions to control announcements');
        return;
      }

      const id = payload && typeof payload === 'object' ? payload.id : payload;
      const removed = removeTickerItemInternal(id);
      if (removed) {
        socket.emit('tickerRemoveSuccess', { id });
      } else {
        socket.emit('tickerError', 'Announcement not found');
      }
    });

    socket.on('tickerClear', () => {
      if (!hasPermission(socket, 'output:control')) {
        socket.emit('permissionError', 'Insufficient permissions to control announcements');
        return;
      }

      clearTickerInternal();
      log.info(`Announcements cleared by ${clientType} client`);
      socket.emit('tickerClearSuccess');
    });

    socket.on('tickerShow', (payload) => {
      if (!hasPermission(socket, 'output:control')) {
        socket.emit('permissionError', 'Insufficient permissions to control announcements');
        return;
      }

      try {
        const id = payload && typeof payload === 'object' ? payload.id : payload;
        showTickerItemInternal(id ?? null);
        socket.emit('tickerShowSuccess', { id: id ?? null });
      } catch (error) {
        socket.emit('tickerError', error.message);
      }
    });

    socket.on('individualOutputToggle', ({ output, enabled }) => {
      if (!hasPermission(socket, 'output:control')) {
        socket.emit('permissionError', 'Insufficient permissions to control individual outputs');
        return;
      }

      if (output === 'output1') {
        currentOutput1Enabled = enabled;
      } else if (output === 'output2') {
        currentOutput2Enabled = enabled;
      } else if (output === 'stage') {
        currentStageEnabled = enabled;
      } else if (output && output.startsWith('custom_')) {
        currentCustomOutputEnabled = { ...currentCustomOutputEnabled, [output]: enabled };
      }

      log.info(`Individual output ${output} toggled to ${enabled} by ${clientType} client`);
      io.emit('individualOutputToggle', { output, enabled });
      notifySessionStateChanged();
    });

    socket.on('lyricsLoad', (lyrics) => {
      if (!hasPermission(socket, 'lyrics:write')) {
        socket.emit('permissionError', 'Insufficient permissions to load lyrics');
        return;
      }

      // Accept the additive chord-chart envelope { lyrics, chords } from newer
      // control panels; older clients still send a bare array. The server
      // keeps the canonical array in currentLyrics and the chart separately.
      const incomingIsEnvelope = lyrics && typeof lyrics === 'object' && !Array.isArray(lyrics);
      const incomingLines = incomingIsEnvelope
        ? (Array.isArray(lyrics.lyrics) ? lyrics.lyrics : [])
        : (Array.isArray(lyrics) ? lyrics : []);
      currentLyrics = incomingLines;
      currentChordChart = incomingIsEnvelope && isChordChart(lyrics.chords) ? lyrics.chords : null;
      currentLyricsTimestamps = [];
      const derived = deriveSectionsFromProcessedLines(currentLyrics);
      currentLyricsSections = derived.sections || [];
      currentLineToSection = derived.lineToSection || {};
      currentSelectedLine = null;
      currentLyricsFileName = '';
      currentContentMode = 'song';
      currentBibleVersion = '';
      currentBibleParallel = null;
      log.info(`Lyrics loaded by ${clientType} client:`, currentLyrics?.length, 'lines', currentChordChart ? 'with chord chart' : 'lyric-only');
      emitLyricsLoadToClients(currentLyrics);
      io.emit('lyricsTimestampsUpdate', currentLyricsTimestamps);
      io.emit('lyricsSectionsUpdate', { sections: currentLyricsSections, lineToSection: currentLineToSection });
      io.emit('contentModeUpdate', { mode: 'song', bibleVersion: '', fileName: '' });
      notifySessionStateChanged();
      // Manual-only: templates change only via explicit styleUpdate from control.
    });

    socket.on('contentLoaded', (payload) => {
      if (!hasPermission(socket, 'lyrics:write')) return;
      const kind = payload?.kind === 'bible' ? 'bible' : payload?.kind === 'freenote' ? 'freenote' : 'song';
      currentContentMode = kind;
      if (payload?.fileName) {
        currentLyricsFileName = String(payload.fileName);
        currentContentFileName = currentLyricsFileName;
      }
      if (kind === 'bible' && payload?.bible) currentBibleVersion = String(payload.bible);
      if (kind === 'song' || kind === 'freenote') { currentBibleVersion = ''; currentBibleParallel = null; }
      io.emit('contentLoaded', payload);
      // Manual-only: no server template apply.
    });

    socket.on('bibleVerseLoaded', (payload) => {
      if (!hasPermission(socket, 'lyrics:write')) {
        socket.emit('permissionError', 'Insufficient permissions to load bible verse');
        return;
      }
      const reference = payload?.reference ? String(payload.reference) : '';
      const bible = payload?.bible ? String(payload.bible) : (payload?.bibleId ? String(payload.bibleId) : currentBibleVersion);
      // Ignore empty slides/text — they produce reference-only lines with no body.
      const nonEmptySlides = Array.isArray(payload?.slides) ? payload.slides.map((t) => String(t ?? '')).filter((t) => t.trim().length > 0) : [];
      const nonEmptyText = String(payload?.text || '').trim();
      // Build lyrics from slides if provided
      if (nonEmptySlides.length > 0) {
        const lines = nonEmptySlides.map((t) => `${t}\n\n${reference}`.trim());
        currentLyrics = lines;
        currentLyricsTimestamps = [];
        const derived = deriveSectionsFromProcessedLines(currentLyrics);
        currentLyricsSections = derived.sections || [];
        currentLineToSection = derived.lineToSection || {};
      } else if (nonEmptyText) {
        const lines = [`${payload.text}\n\n${reference}`.trim()];
        currentLyrics = lines;
        const derived = deriveSectionsFromProcessedLines(currentLyrics);
        currentLyricsSections = derived.sections || [];
        currentLineToSection = derived.lineToSection || {};
      } else {
        log.warn(`Bible verse with no text ignored (keeping previous lyrics): ${reference} (${bible})`);
      }
      currentSelectedLine = Number.isInteger(payload?.slideIndex) ? payload.slideIndex : 0;
      currentLyricsFileName = reference;
      currentChordChart = null; // bible content is never a chord chart
      currentContentFileName = reference;
      currentContentMode = 'bible';
      currentBibleVersion = bible || currentBibleVersion || 'bible';
      currentBibleParallel = sanitizeBibleParallel(payload?.secondary);
      log.info(`Bible verse loaded by ${clientType} client: ${reference} (${bible})`);
      // Generic first, specific last: bibleVerseLoaded carries the slide
      // index + reference, so it must land after lyricsLoad (which resets
      // receivers to slide 0) to avoid a wrong-slide flash.
      emitLyricsLoadToClients(currentLyrics);
      io.emit('lineUpdate', { index: currentSelectedLine });
      io.emit('fileNameUpdate', reference);
      // Re-emit with the sanitized parallel companion (or none) so every
      // receiver — including permission-filtered fan-out — sees one shape.
      if (currentBibleParallel) {
        io.emit('bibleVerseLoaded', { ...payload, secondary: currentBibleParallel });
      } else if (payload && typeof payload === 'object' && 'secondary' in payload) {
        const { secondary: _dropped, ...rest } = payload;
        io.emit('bibleVerseLoaded', rest);
      } else {
        io.emit('bibleVerseLoaded', payload);
      }
      io.emit('contentModeUpdate', { mode: 'bible', bibleVersion: currentBibleVersion, fileName: reference });
      notifySessionStateChanged();
      // also emit lyrics-derived updates
      io.emit('lyricsSectionsUpdate', { sections: currentLyricsSections, lineToSection: currentLineToSection });
      // Manual-only: no server template apply. Control applies explicitly.
    });

    socket.on('freeNoteLoaded', (payload) => {
      if (!hasPermission(socket, 'lyrics:write')) {
        socket.emit('permissionError', 'Insufficient permissions to load free note');
        return;
      }
      const title = payload?.title ? String(payload.title) : 'Free Note';
      const rawSlides = Array.isArray(payload?.slides) && payload.slides.length > 0
        ? payload.slides
        : (Array.isArray(payload?.lines) && payload.lines.length > 0 ? payload.lines : [payload?.rawText || '']);
      const nonEmptySlides = rawSlides.map((t) => String(t ?? '')).filter((t) => t.trim().length > 0);
      const slides = nonEmptySlides.length > 0 ? nonEmptySlides : [''];

      currentLyrics = slides;
      currentLyricsTimestamps = [];
      const derived = deriveSectionsFromProcessedLines(currentLyrics);
      currentLyricsSections = derived.sections || [];
      currentLineToSection = derived.lineToSection || {};
      currentSelectedLine = Number.isInteger(payload?.slideIndex)
        ? payload.slideIndex
        : (Number.isInteger(payload?.selectedLine) ? payload.selectedLine : 0);
      currentLyricsFileName = title;
      currentContentFileName = title;
      currentContentMode = 'freenote';
      currentBibleVersion = '';
      currentChordChart = null; // free notes are never chord charts
      currentBibleParallel = null;

      log.info(`Free note loaded by ${clientType} client: ${title} (${slides.length} slides)`);
      emitLyricsLoadToClients(currentLyrics);
      io.emit('lineUpdate', { index: currentSelectedLine });
      io.emit('fileNameUpdate', title);
      io.emit('freeNoteLoaded', payload);
      io.emit('contentModeUpdate', { mode: 'freenote', bibleVersion: '', fileName: title });
      notifySessionStateChanged();
      io.emit('lyricsSectionsUpdate', { sections: currentLyricsSections, lineToSection: currentLineToSection });
    });

    socket.on('contentModeUpdate', (payload) => {
      if (!hasPermission(socket, 'lyrics:write') && !hasPermission(socket, 'settings:write')) {
        socket.emit('permissionError', 'Insufficient permissions to update content mode');
        return;
      }
      const mode = payload?.mode === 'bible' ? 'bible' : payload?.mode === 'freenote' ? 'freenote' : 'song';
      currentContentMode = mode;
      if (typeof payload?.bibleVersion === 'string') currentBibleVersion = payload.bibleVersion;
      else if (mode === 'song' || mode === 'freenote') currentBibleVersion = '';
      if (typeof payload?.fileName === 'string') currentContentFileName = payload.fileName;
      io.emit('contentModeUpdate', { mode, bibleVersion: currentBibleVersion, fileName: currentContentFileName });
      // Manual-only: no server template apply.
    });

    socket.on('setModeTemplates', ({ modeTemplates }) => {
      if (!hasPermission(socket, 'settings:write')) {
        socket.emit('permissionError', 'Insufficient permissions to modify mode templates');
        return;
      }
      currentModeTemplates = sanitizeModeTemplates(modeTemplates, null);
      for (const k of ['output1', 'output2', 'stage']) if (!currentModeTemplates[k]) currentModeTemplates[k] = { enabled: false, song: null, bible: null, freenote: null };
      log.info(`Mode templates updated by ${clientType} client`);
      io.emit('modeTemplatesUpdate', { modeTemplates: currentModeTemplates });
      notifySessionStateChanged();
      // Manual-only: saving prefs never restyles outputs by itself.
    });

    socket.on('setModeTemplate', ({ outputKey, mode, templateId, enabled }) => {
      if (!hasPermission(socket, 'settings:write')) {
        socket.emit('permissionError', 'Insufficient permissions to modify mode templates');
        return;
      }
      const key = String(outputKey || '').trim();
      if (!key) { socket.emit('permissionError', 'outputKey required'); return; }
      if (!currentModeTemplates[key]) currentModeTemplates[key] = { enabled: false, song: null, bible: null, freenote: null };
      if (typeof enabled === 'boolean') currentModeTemplates[key].enabled = enabled;
      if (mode === 'song' || mode === 'bible' || mode === 'freenote') currentModeTemplates[key][mode] = templateId ?? null;
      else if (enabled !== undefined && mode == null) {
        // just enabled toggle
      }
      log.info(`Mode template set ${key} ${mode} -> ${templateId} (enabled=${enabled})`);
      io.emit('modeTemplatesUpdate', { modeTemplates: currentModeTemplates });
      notifySessionStateChanged();
      // Manual-only: saving prefs never restyles outputs by itself.
    });

    socket.on('requestModeTemplates', () => {
      socket.emit('modeTemplatesUpdate', { modeTemplates: currentModeTemplates });
    });

    socket.on('lyricsTimestampsUpdate', (timestamps) => {
      if (!hasPermission(socket, 'lyrics:write')) {
        socket.emit('permissionError', 'Insufficient permissions to update timestamps');
        return;
      }

      currentLyricsTimestamps = timestamps || [];
      log.info(`Lyrics timestamps updated by ${clientType} client:`, timestamps?.length, 'timestamps');
      io.emit('lyricsTimestampsUpdate', timestamps);
      notifySessionStateChanged();
    });

    socket.on('splitNormalGroup', (payload = {}) => {
      if (!hasPermission(socket, 'output:control')) {
        socket.emit('permissionError', 'Insufficient permissions to split groups');
        return;
      }

      const index = typeof payload === 'number' ? payload : payload?.index;
      if (!Number.isInteger(index) || index < 0 || index >= currentLyrics.length) {
        socket.emit('lyricsSplitError', 'Invalid group index');
        return;
      }

      const target = currentLyrics[index];
      if (!target || target.type !== 'normal-group') {
        socket.emit('lyricsSplitError', 'Selected line is not a normal group');
        return;
      }

      const newLyrics = [...currentLyrics];
      newLyrics.splice(index, 1, target.line1, target.line2);
      currentLyrics = newLyrics;
      currentLyricsTimestamps = [];
      const derived = deriveSectionsFromProcessedLines(currentLyrics);
      currentLyricsSections = derived.sections || [];
      currentLineToSection = derived.lineToSection || {};

      if (typeof currentSelectedLine === 'number') {
        if (currentSelectedLine > index) {
          currentSelectedLine += 1;
        }
      }

      log.info(`Normal group split at index ${index} by ${clientType} client (${deviceId})`);
      emitLyricsLoadToClients(currentLyrics);
      io.emit('lyricsTimestampsUpdate', currentLyricsTimestamps);
      io.emit('lyricsSectionsUpdate', { sections: currentLyricsSections, lineToSection: currentLineToSection });

      if (typeof currentSelectedLine === 'number') {
        io.emit('lineUpdate', { index: currentSelectedLine });
      }

      socket.emit('lyricsSplitSuccess', { index });
    });

    socket.on('styleUpdate', ({ output, settings }) => {
      if (!hasPermission(socket, 'settings:write')) {
        socket.emit('permissionError', 'Insufficient permissions to modify settings');
        return;
      }

      if (output === 'output1') {
        currentOutput1Settings = { ...currentOutput1Settings, ...settings };
      }
      if (output === 'output2') {
        currentOutput2Settings = { ...currentOutput2Settings, ...settings };
      }
      if (output === 'stage') {
        currentStageSettings = { ...currentStageSettings, ...settings };
      }
      if (output && output.startsWith('custom_')) {
        currentCustomOutputSettings = {
          ...currentCustomOutputSettings,
          [output]: {
            ...(currentCustomOutputSettings[output] || {}),
            ...settings,
          },
        };
      }
      log.info(`Style updated for ${output} by ${clientType} client`);
      io.emit('styleUpdate', { output, settings });
      notifySessionStateChanged();
    });

    socket.on('outputRegistryUpdate', ({ customOutputs, customOutputSettings, customOutputEnabled } = {}) => {
      if (!hasPermission(socket, 'settings:write')) {
        socket.emit('permissionError', 'Insufficient permissions to update output registry');
        return;
      }
      if (Array.isArray(customOutputs)) {
        const prevIds = new Set(currentCustomOutputs.map((o) => o.id));
        const nextIds = new Set(customOutputs.map((o) => o.id));
        const deletedIds = [...prevIds].filter((id) => !nextIds.has(id));
        if (deletedIds.length > 0 && typeof global.deleteOutputMedia === 'function') {
          deletedIds.forEach((deletedId) => {
            global.deleteOutputMedia(deletedId).catch((err) => {
              log.warn(`Failed to cleanup media for deleted output ${deletedId}:`, err.message);
            });
          });
        }
        currentCustomOutputs = customOutputs;
      }
      if (customOutputSettings && typeof customOutputSettings === 'object') currentCustomOutputSettings = customOutputSettings;
      if (customOutputEnabled && typeof customOutputEnabled === 'object') currentCustomOutputEnabled = customOutputEnabled;
      // ensure modeTemplates has entries for new customs
      for (const o of currentCustomOutputs) {
        if (!currentModeTemplates[o.id]) currentModeTemplates[o.id] = { enabled: false, song: null, bible: null };
      }
      // prune deleted
      for (const k of Object.keys(currentModeTemplates)) {
        if (k.startsWith('custom_') && !currentCustomOutputs.some((o) => o.id === k)) delete currentModeTemplates[k];
      }
      io.emit('outputRegistryUpdate', {
        customOutputs: currentCustomOutputs,
        customOutputSettings: currentCustomOutputSettings,
        customOutputEnabled: currentCustomOutputEnabled,
      });
      io.emit('modeTemplatesUpdate', { modeTemplates: currentModeTemplates });
      notifySessionStateChanged();
    });

    socket.on('stageTimerUpdate', (timerData) => {
      if (!hasPermission(socket, 'output:control')) {
        socket.emit('permissionError', 'Insufficient permissions to control stage timer');
        return;
      }

      currentStageTimerState = { ...timerData };
      log.info(`Stage timer updated by ${clientType} client:`, timerData);
      io.emit('stageTimerUpdate', timerData);
      notifySessionStateChanged();
    });

    socket.on('stageMessagesUpdate', (messages) => {
      if (!hasPermission(socket, 'output:control')) {
        socket.emit('permissionError', 'Insufficient permissions to update stage messages');
        return;
      }

      currentStageMessages = Array.isArray(messages) ? [...messages] : [];
      log.info(`Stage messages updated by ${clientType} client: ${messages?.length || 0} messages`);
      io.emit('stageMessagesUpdate', messages);
      notifySessionStateChanged();
    });

    // Service run-sheet clock (feature #01). Mutations require
    // output:control; reads ride on currentState + scheduleState broadcasts.
    socket.on('scheduleLoad', (doc) => {
      if (!hasPermission(socket, 'output:control')) {
        socket.emit('permissionError', 'Insufficient permissions to load a service schedule');
        return;
      }
      try {
        const snapshot = scheduler.load(doc);
        log.info(`Schedule loaded by ${clientType} client: "${snapshot.schedule?.name}"`);
        io.emit('scheduleState', snapshot);
        notifySessionStateChanged();
      } catch (error) {
        log.warn('scheduleLoad error:', error.message);
        socket.emit('scheduleError', error.message);
      }
    });

    socket.on('scheduleControl', (payload) => {
      if (!hasPermission(socket, 'output:control')) {
        socket.emit('permissionError', 'Insufficient permissions to control the service schedule');
        return;
      }
      const action = payload?.action;
      try {
        let snapshot = null;
        if (action === 'start') snapshot = scheduler.start();
        else if (action === 'pause') snapshot = scheduler.pause();
        else if (action === 'resume') snapshot = scheduler.resume();
        else if (action === 'stop') snapshot = scheduler.stop();
        else if (action === 'next') snapshot = scheduler.next();
        else if (action === 'prev') snapshot = scheduler.prev();
        else if (action === 'replan') snapshot = scheduler.replan(payload?.startEpochMs);
        else if (action === 'reconcile') {
          snapshot = scheduler.reconcile({
            actualStartEpochMs: payload?.actualStartEpochMs,
            strategy: payload?.strategy === 'shift' ? 'shift' : 'compress',
          });
        } else {
          socket.emit('scheduleError', `Unknown schedule action: ${action}`);
          return;
        }
        log.info(`Schedule ${action} by ${clientType} client`);
        io.emit('scheduleState', snapshot);
        notifySessionStateChanged();
      } catch (error) {
        log.warn(`scheduleControl(${action}) error:`, error.message);
        socket.emit('scheduleError', error.message);
      }
    });

    socket.on('requestSchedule', () => {
      if (!hasPermission(socket, 'lyrics:read')) {
        socket.emit('permissionError', 'Insufficient permissions to read the service schedule');
        return;
      }
      socket.emit('scheduleState', scheduler.getSnapshot());
    });

    socket.on('outputMetrics', ({ output, metrics }) => {
      if (!(clientType === 'output1' || clientType === 'output2')) {
        socket.emit('permissionError', 'Insufficient permissions to publish metrics');
        return;
      }
      if (!output || !metrics || (output !== 'output1' && output !== 'output2' && !output.startsWith('custom_'))) {
        return;
      }
      if (!outputInstances[output]) outputInstances[output] = new Map();

      const safe = {};
      if (Number.isFinite(metrics.adjustedFontSize) || metrics.adjustedFontSize === null) safe.adjustedFontSize = metrics.adjustedFontSize;
      if (typeof metrics.autosizerActive === 'boolean') safe.autosizerActive = metrics.autosizerActive;
      if (Number.isFinite(metrics.viewportWidth)) safe.viewportWidth = metrics.viewportWidth;
      if (Number.isFinite(metrics.viewportHeight)) safe.viewportHeight = metrics.viewportHeight;
      if (Number.isFinite(metrics.timestamp)) safe.timestamp = metrics.timestamp;

      outputInstances[output].set(socket.id, {
        ...safe,
        socketId: socket.id,
        lastUpdate: Date.now()
      });

      const allInstances = Array.from(outputInstances[output].values());

      const primaryInstance = allInstances.reduce((largest, current) => {
        if (!largest) return current;
        const largestArea = (largest.viewportWidth || 0) * (largest.viewportHeight || 0);
        const currentArea = (current.viewportWidth || 0) * (current.viewportHeight || 0);
        return currentArea > largestArea ? current : largest;
      }, null);

      io.emit('outputMetrics', {
        output,
        metrics: primaryInstance || safe,
        allInstances: allInstances,
        instanceCount: allInstances.length
      });
    });

    socket.on('fileNameUpdate', (fileName) => {
      if (!hasPermission(socket, 'lyrics:write')) {
        socket.emit('permissionError', 'Insufficient permissions to update filename');
        return;
      }

      currentLyricsFileName = fileName;
      log.info(`Filename updated to "${fileName}" by ${clientType} client`);
      io.emit('fileNameUpdate', fileName);
    });

    socket.on('lyricsDraftSubmit', ({ title, rawText, processedLines }) => {
      if (!hasPermission(socket, 'lyrics:draft')) {
        socket.emit('permissionError', 'Insufficient permissions to submit drafts');
        return;
      }

      log.info(`Lyrics draft submitted by ${clientType} client: "${title}" (${processedLines?.length || 0} lines)`);

      const desktopClients = Array.from(connectedClients.values()).filter(c => c.type === 'desktop');

      if (desktopClients.length === 0) {
        socket.emit('draftError', 'No desktop client available to approve draft');
        return;
      }

      const timestamp = Date.now();
      const draftId = `${sessionId}_${timestamp}`;

      const draftPayload = {
        draftId,
        title: title || 'Untitled',
        rawText: rawText || '',
        processedLines: processedLines || [],
        submittedBy: {
          clientType,
          deviceId,
          sessionId,
          timestamp
        }
      };

      pendingDrafts.set(draftId, {
        submitterSocketId: socket.id,
        submitterSessionId: sessionId,
        title: draftPayload.title,
        timestamp
      });

      setTimeout(() => {
        pendingDrafts.delete(draftId);
      }, 10 * 60 * 1000);

      desktopClients.forEach(client => {
        if (client.socket && client.socket.connected) {
          client.socket.emit('lyricsDraftReceived', draftPayload);
        }
      });

      socket.emit('draftSubmitted', { success: true, title });
    });

    socket.on('lyricsDraftApprove', ({ draftId, title, rawText, processedLines }) => {
      if (!hasPermission(socket, 'lyrics:write')) {
        socket.emit('permissionError', 'Insufficient permissions to approve drafts');
        return;
      }

      const parsedSong = rawText ? parseSongText(rawText) : null;
      currentLyrics = parsedSong?.chart ? parsedSong.processedLines : (processedLines || []);
      currentSelectedLine = null;
      currentLyricsFileName = title || '';
      const derived = deriveSectionsFromProcessedLines(currentLyrics);
      currentLyricsSections = parsedSong?.chart ? parsedSong.sections : (derived.sections || []);
      currentLineToSection = parsedSong?.chart ? parsedSong.lineToSection : (derived.lineToSection || {});
      currentChordChart = parsedSong?.chart || null;

      log.info(`Desktop client approved draft: "${title}" (${currentLyrics.length} lines)`);

      emitLyricsLoadToClients(currentLyrics);
      io.emit('fileNameUpdate', currentLyricsFileName);
      io.emit('lyricsSectionsUpdate', { sections: currentLyricsSections, lineToSection: currentLineToSection });
      if (rawText) {
        io.emit('setlistLoadSuccess', {
          fileId: null,
          fileName: title,
          originalName: null,
          fileType: 'draft',
          linesCount: currentLyrics.length,
          rawContent: rawText,
          loadedBy: 'desktop',
          origin: 'draft'
        });
      }

      if (draftId && pendingDrafts.has(draftId)) {
        const draftInfo = pendingDrafts.get(draftId);
        const submitterClients = Array.from(connectedClients.values())
          .filter(c => c.sessionId === draftInfo.submitterSessionId)
          .sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0));

        const targetClient = submitterClients[0];
        if (targetClient?.socket && targetClient.socket.connected) {
          targetClient.socket.emit('draftApproved', { success: true, title, draftId });
        }

        pendingDrafts.delete(draftId);
      } else {
        socket.emit('draftApproved', { success: true, title, draftId: draftId || null });
      }
    });

    socket.on('lyricsDraftReject', ({ draftId, title, reason }) => {
      if (!hasPermission(socket, 'lyrics:write')) {
        socket.emit('permissionError', 'Insufficient permissions to reject drafts');
        return;
      }

      log.info(`Desktop client rejected draft "${title}": ${reason || 'No reason provided'}`);

      if (draftId && pendingDrafts.has(draftId)) {
        const draftInfo = pendingDrafts.get(draftId);

        const submitterClients = Array.from(connectedClients.values())
          .filter(c => c.sessionId === draftInfo.submitterSessionId)
          .sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0));

        const targetClient = submitterClients[0];
        if (targetClient?.socket && targetClient.socket.connected) {
          targetClient.socket.emit('draftRejected', {
            success: true,
            title: title || draftInfo.title,
            reason: reason || 'No reason provided',
            draftId
          });
        }

        pendingDrafts.delete(draftId);
        log.info(`Rejection notification sent to submitter (session: ${draftInfo.submitterSessionId})`);
      } else {
        log.warn(`Draft ${draftId} not found in pending drafts, cannot notify submitter`);
        socket.emit('draftRejected', { success: true, reason, draftId: draftId || null, title: title || null });
      }
    });

    socket.on('autoplayStateUpdate', ({ isActive, clientType: autoplayClientType }) => {
      if (!hasPermission(socket, 'output:control')) {
        socket.emit('permissionError', 'Insufficient permissions to update autoplay state');
        return;
      }

      log.info(`Autoplay state updated by ${clientType} client: ${isActive ? 'active' : 'inactive'}`);

      socket.broadcast.emit('autoplayStateUpdate', { isActive, clientType: autoplayClientType });
    });

    socket.on('heartbeat', () => {
      outputPresence.touch(socket.id);
      socket.emit('heartbeat_ack', { timestamp: Date.now() });
    });

    socket.on('outputPresenceRegister', (payload) => {
      if (!hasPermission(socket, 'lyrics:read')) {
        socket.emit('permissionError', 'Insufficient permissions to register output presence');
        return;
      }

      const purpose = typeof payload === 'string' ? payload : payload?.purpose;
      const updated = outputPresence.refine(socket.id, purpose)
        || outputPresence.register({ socketId: socket.id, clientType, purpose, deviceId, sessionId });
      if (updated) {
        log.info(`Output presence registered: ${updated.outputKey} (${clientType}/${deviceId})`);
        broadcastOutputPresence();
      }
    });

    socket.on('requestOutputPresence', () => {
      if (!hasPermission(socket, 'lyrics:read')) {
        socket.emit('permissionError', 'Insufficient permissions to read output presence');
        return;
      }

      socket.emit('outputPresenceUpdate', outputPresence.snapshot());
    });

    socket.on('disconnect', (reason) => {
      log.info(`Authenticated user disconnected: ${clientType} (${deviceId}) - Reason: ${reason}`);
      connectedClients.delete(socket.id);
      if (outputPresence.remove(socket.id)) broadcastOutputPresence();

      for (const [outputKey, instances] of Object.entries(outputInstances)) {
        if (instances.has(socket.id)) {
          instances.delete(socket.id);
        }
      }

      if (clientType === 'output1' || clientType === 'output2') {
        outputInstances[clientType]?.delete(socket.id);

        const remainingInstances = Array.from(outputInstances[clientType]?.values() || []);
        if (remainingInstances.length > 0) {
          const primaryInstance = remainingInstances.reduce((largest, current) => {
            if (!largest) return current;
            const largestArea = (largest.viewportWidth || 0) * (largest.viewportHeight || 0);
            const currentArea = (current.viewportWidth || 0) * (current.viewportHeight || 0);
            return currentArea > largestArea ? current : largest;
          }, null);

          io.emit('outputMetrics', {
            output: clientType,
            metrics: primaryInstance,
            allInstances: remainingInstances,
            instanceCount: remainingInstances.length
          });
        }
      }

      socket.broadcast.emit('clientDisconnected', {
        clientType,
        deviceId,
        disconnectedAt: Date.now(),
        reason
      });
    });

    setTimeout(() => {
      if (socket.connected) {
        const clientInfo = connectedClients.get(socket.id);
        if (clientInfo?.type === 'mobile' || clientInfo?.type === 'web') {
          socket.emit('currentState', buildStateSummary(clientInfo));
        } else {
          socket.emit('currentState', buildCurrentState(clientInfo));
        }
      }
    }, 100);

    const stateBroadcastInterval = setInterval(() => {
      if (socket.connected) {
        const fingerprint = computeStateFingerprint();
        const lastFingerprint = lastStateFingerprintBySocket.get(socket.id);

        if (fingerprint !== lastFingerprint) {
          lastStateFingerprintBySocket.set(socket.id, fingerprint);
          const clientInfo = connectedClients.get(socket.id);
          socket.emit('periodicStateSync', buildStateSummary(clientInfo));
        }
      }
    }, 60000);

    socket.on('disconnect', () => {
      clearInterval(stateBroadcastInterval);
      lastStateFingerprintBySocket.delete(socket.id);
    });
  });

  setInterval(() => {
    const stats = {
      totalConnections: connectedClients.size,
      clientTypes: {},
      timestamp: Date.now()
    };

    connectedClients.forEach(client => {
      stats.clientTypes[client.type] = (stats.clientTypes[client.type] || 0) + 1;
    });

    log.info('Connection statistics:', stats);
  }, 5 * 60 * 1000);
}

export function buildCurrentState(clientInfo) {
  const timestamp = Date.now();
  const state = {
    lyrics: currentLyrics,
    lyricsTimestamps: currentLyricsTimestamps,
    selectedLine: currentSelectedLine,
    lyricsSections: currentLyricsSections,
    lineToSection: currentLineToSection,
    output1Settings: currentOutput1Settings,
    output2Settings: currentOutput2Settings,
    stageSettings: currentStageSettings,
    customOutputs: currentCustomOutputs,
    customOutputSettings: currentCustomOutputSettings,
    customOutputEnabled: currentCustomOutputEnabled,
    isOutputOn: currentIsOutputOn,
    showState: currentShowState,
    ticker: getTickerState(),
    output1Enabled: currentOutput1Enabled,
    output2Enabled: currentOutput2Enabled,
    stageEnabled: currentStageEnabled,
    setlistFiles,
    lyricsFileName: currentLyricsFileName || '',
    contentMode: currentContentMode,
    bibleVersion: currentBibleVersion,
    bibleParallel: currentBibleParallel,
    modeTemplates: currentModeTemplates,
    schedule: scheduler.getSnapshot(),
    isDesktopClient: clientInfo?.type === 'desktop',
    clientPermissions: clientInfo?.permissions || [],
    timestamp,
    syncTimestamp: timestamp,
  };

  if (clientInfo?.type === 'desktop' || clientInfo?.type === 'stage') {
    state.chords = currentChordChart;
  }

  if (clientInfo?.type === 'stage') {
    state.stageTimerState = currentStageTimerState;
    state.stageMessages = currentStageMessages;
  }

  return state;
}

export function getStateFingerprint() {
  // Fixed 32-hex digest: the raw material grows with setlist size (full
  // settings JSON + every file id), which would bloat each ~100B
  // no-change sync reply and every `since=` query string on slow links.
  // Consumers only ever compare equality, so a truncated SHA-256 is exact.
  try {
    return createHash('sha256').update(computeStateFingerprint(), 'utf8').digest('hex').slice(0, 32);
  } catch { return String(Date.now()); }
}

/**
 * Tiny mobile-first snapshot: everything the phone needs to render, nothing
 * it doesn't. The full `currentState` ships every setlist file's *content*
 * (50 files x KBs = MBs over socket.io polling) which is why a 1KB lyric
 * felt slow on a phone. Light state sends the setlist as metadata only
 * plus a window into the lyrics; full content arrives on explicit load.
 * Typical size: <4KB vs 100KB+.
 */
export function buildLightState(clientInfo) {
  const summary = setlistFiles.map((file) => ({
    id: file.id,
    displayName: file.displayName,
    originalName: file.originalName,
    fileType: file.fileType,
    lastModified: file.lastModified,
    addedAt: file.addedAt,
  }));
  const schedule = (() => { try { return scheduler.getSnapshot(); } catch { return { loaded: false }; } })();
  return {
    lyrics: currentLyrics,
    lyricsCount: currentLyrics.length,
    selectedLine: currentSelectedLine,
    lyricsFileName: currentLyricsFileName || '',
    isOutputOn: currentIsOutputOn,
    showState: currentShowState,
    ticker: getTickerState(),
    output1Enabled: currentOutput1Enabled,
    output2Enabled: currentOutput2Enabled,
    stageEnabled: currentStageEnabled,
    setlist: summary,
    setlistCount: summary.length,
    contentMode: currentContentMode,
    bibleVersion: currentBibleVersion,
    scheduleLoaded: Boolean(schedule?.loaded),
    scheduleStatus: schedule?.status || 'idle',
    scheduleName: schedule?.schedule?.name || '',
    fingerprint: getStateFingerprint(),
    timestamp: Date.now(),
  };
}

export function getScheduleSnapshot() {
  try { return scheduler.getSnapshot(); } catch (e) { return { loaded: false, error: e?.message || String(e) }; }
}

export function loadScheduleInternal(doc) {
  const snapshot = scheduler.load(doc);
  if (ioInstance) ioInstance.emit('scheduleState', snapshot);
  notifySessionStateChanged();
  return snapshot;
}

export function controlScheduleInternal(action, payload = {}) {
  let snapshot = null;
  if (action === 'start') snapshot = scheduler.start();
  else if (action === 'pause') snapshot = scheduler.pause();
  else if (action === 'resume') snapshot = scheduler.resume();
  else if (action === 'stop') snapshot = scheduler.stop();
  else if (action === 'next') snapshot = scheduler.next();
  else if (action === 'prev') snapshot = scheduler.prev();
  else if (action === 'replan') snapshot = scheduler.replan(payload?.startEpochMs);
  else if (action === 'reconcile') snapshot = scheduler.reconcile({
    actualStartEpochMs: payload?.actualStartEpochMs,
    strategy: payload?.strategy === 'shift' ? 'shift' : 'compress',
  });
  else throw new Error(`Unknown schedule action: ${action}`);
  if (ioInstance) ioInstance.emit('scheduleState', snapshot);
  notifySessionStateChanged();
  return snapshot;
}

export function buildStateSummary(clientInfo) {
  const state = buildCurrentState(clientInfo);
  delete state.setlistFiles;
  state.setlistSummary = setlistFiles.map((file) => ({
    id: file.id,
    displayName: file.displayName,
    originalName: file.originalName,
    fileType: file.fileType,
    lastModified: file.lastModified,
    addedAt: file.addedAt,
  }));
  return state;
}

export function getOutputRegistry() {
  return {
    customOutputs: currentCustomOutputs,
    customOutputSettings: currentCustomOutputSettings,
    customOutputEnabled: currentCustomOutputEnabled,
  };
}

export function getOutputPresenceSnapshot() {
  return outputPresence.snapshot();
}

export function getConnectedClients() {
  const clients = [];

  const sessionMap = new Map();

  connectedClients.forEach((client, socketId) => {
    const key = `${client.type}_${client.sessionId}`;

    if (!sessionMap.has(key)) {
      sessionMap.set(key, {
        id: socketId,
        type: client.type,
        sessionId: client.sessionId,
        deviceId: client.deviceId,
        connectedAt: client.connectedAt,
        permissions: client.permissions,
        socketCount: 1
      });
    } else {
      sessionMap.get(key).socketCount++;
    }
  });

  sessionMap.forEach((client) => {
    clients.push(client);
  });

  return clients;
}

if (typeof global !== 'undefined') {
  global.getConnectedClients = getConnectedClients;
  global.getOutputRegistry = getOutputRegistry;
  global.getOutputPresenceSnapshot = getOutputPresenceSnapshot;
}
