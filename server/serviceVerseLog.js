// Sunday service verse log — server-side file writer.
//
// WHAT THIS IS: the `bibleVerseLoaded` socket handler (server/events.js) is
// the single choke point for every verse sent to display — Electron,
// web, mobile, and API senders all pass through it. This store appends
// each displayed verse to `<dataRoot>/service-logs/service-YYYY-MM-DD.txt`
// (one file per local calendar day, human-readable), so Sunday's verses
// are on record after the service. In the packaged app `dataRoot` is
// `<userData>/backend` (see main/backend.js): the file lands inside the
// app folder with no extra setup.
//
// RULES:
// - Fire-and-forget: a failed append warns and is dropped. Logging must
//   never break or delay the display fan-out.
// - Consecutive duplicates are skipped: stepping through the slides of one
//   verse re-sends the same reference, which is slide navigation, not a new
//   verse. A re-send after other verses IS logged (it was displayed again).
// - Verse references only — no verse text is written here. The file is an
//   index of what was displayed ("John 3:16 (KJV)"), not a Bible copy.
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  SERVICE_LOG_DIR,
  serviceDayStamp,
  serviceLogFileName,
  normalizeServiceVerseReference,
  formatServiceLogLine,
} from '../shared/serviceVerseLog.js';
import createServerLogger from './logger.js';

const log = createServerLogger('ServiceVerseLog');

let serviceLogDir = null;
let initWarned = false;
/** dayStamp -> last logged reference (consecutive-duplicate suppression). */
const lastLoggedByDay = new Map();

/** Absolute directory holding the per-day service files. */
export function getServiceLogDir() {
  return serviceLogDir;
}

/**
 * Point the store at `<dataRoot>/service-logs`, creating it.
 * Safe to call repeatedly; construction performs no I/O before this.
 */
export async function initServiceVerseLog({ dataRoot } = {}) {
  if (!dataRoot || typeof dataRoot !== 'string' || !dataRoot.trim()) {
    throw new Error('initServiceVerseLog: a dataRoot is required');
  }
  serviceLogDir = path.join(path.resolve(dataRoot), SERVICE_LOG_DIR);
  try {
    await fsp.mkdir(serviceLogDir, { recursive: true });
  } catch (error) {
    log.warn(`Service verse log directory unavailable (${serviceLogDir}):`, error?.message || error);
  }
  log.info(`Service verse log ready at ${serviceLogDir}`);
  return serviceLogDir;
}

function notReady() {
  if (!initWarned) {
    initWarned = true;
    log.warn('Service verse log not initialized; verses are not being recorded to disk');
  }
  return { ok: false, code: 'not-initialized' };
}

// Appends run through a promise chain so the duplicate check, the file
// append, and the dedup-memory update are atomic with respect to each
// other: rapid duplicate bibleVerseLoaded events must log one line, not
// one per racing call.
let appendChain = Promise.resolve();

async function appendGuardedVerse({ cleaned, bible, at }) {
  const day = serviceDayStamp(at) || serviceDayStamp(new Date());
  if (lastLoggedByDay.get(day) === cleaned) {
    return { ok: true, stored: false, reason: 'same-as-previous' };
  }
  const fileName = serviceLogFileName(at);
  const file = path.join(serviceLogDir, fileName);
  const line = `${formatServiceLogLine({ at, reference: cleaned, bible })}\n`;
  try {
    await fsp.mkdir(serviceLogDir, { recursive: true });
    await fsp.appendFile(file, line, 'utf8');
  } catch (error) {
    log.warn(`Service verse log append failed (${fileName}):`, error?.message || error);
    return { ok: false, code: 'write-failed', file };
  }
  lastLoggedByDay.set(day, cleaned);
  return { ok: true, stored: true, file, fileName, date: day };
}

/**
 * Append one displayed verse to today's service file.
 * Never throws: failures return `{ ok: false, code }` so the display
 * fan-out in events.js stays untouched.
 */
export async function logServiceVerse({ reference = '', bible = '', at = new Date() } = {}) {
  if (!serviceLogDir) return notReady();
  const cleaned = normalizeServiceVerseReference(reference);
  if (!cleaned) return { ok: false, code: 'empty-reference' };
  const task = appendChain.then(() => appendGuardedVerse({ cleaned, bible, at }));
  // A failed append must not break the chain for later verses.
  appendChain = task.catch(() => {});
  return task;
}

/**
 * Read one service day back: `{ ok, exists, date, file, fileName,
 * verseCount, lines }`. Missing file reads as an empty (not an error).
 */
export async function readServiceDayLog(dayStamp) {
  const day = typeof dayStamp === 'string' ? dayStamp.trim() : '';
  if (!serviceLogDir) return notReady();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { ok: false, code: 'invalid-argument', field: 'date' };
  }
  const fileName = `service-${day}.txt`;
  const file = path.join(serviceLogDir, fileName);
  let content = null;
  try {
    content = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: true, exists: false, date: day, file, fileName, verseCount: 0, lines: [] };
    }
    log.warn(`Service verse log read failed (${fileName}):`, error?.message || error);
    return { ok: false, code: 'read-failed', file };
  }
  const lines = String(content ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return { ok: true, exists: true, date: day, file, fileName, verseCount: lines.length, lines };
}

/** Today's service file, for the `/service-log/today` route. */
export async function todayServiceLog() {
  return readServiceDayLog(serviceDayStamp(new Date()));
}

/** Test seam: forget init state and the dedup memory between tests. */
export function __resetServiceVerseLogForTests() {
  serviceLogDir = null;
  initWarned = false;
  lastLoggedByDay.clear();
}
