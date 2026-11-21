// Pure helpers for the Sunday service verse log.
//
// WHAT THIS IS: every verse the operator sends to display during a service
// is appended to one human-readable file per calendar day, so Sunday's
// verses are on record after the service. The file lives inside the app
// folder (`<dataRoot>/service-logs/service-YYYY-MM-DD.txt`) — `dataRoot`
// is `<userData>/backend` in the packaged app (see main/backend.js), so no
// extra setup is needed and nothing is written into the repo checkout.
//
// This module is pure (no fs, no electron): the server store
// (server/serviceVerseLog.js) and the Electron reveal IPC
// (main/serviceVerseLogIpc.js) share these names so the writer and the
// reader can never disagree about directory or file names.

/** Directory under the server data root holding one file per service day. */
export const SERVICE_LOG_DIR = 'service-logs';

/** Padded two-digit number. */
function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * Local calendar-day stamp for a service file: `YYYY-MM-DD`.
 * Local time on purpose — the file is "that Sunday" on the church's wall
 * clock, not UTC. Returns '' for an unparseable date.
 */
export function serviceDayStamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** File name for one service day: `service-YYYY-MM-DD.txt`. */
export function serviceLogFileName(date = new Date()) {
  return `service-${serviceDayStamp(date) || 'unknown-day'}.txt`;
}

/** Trim a verse reference to its log form; non-strings become ''. */
export function normalizeServiceVerseReference(reference) {
  return typeof reference === 'string' ? reference.trim() : '';
}

/** Local `HH:MM:SS` clock label for one log line. */
export function serviceClockLabel(at = new Date()) {
  const d = at instanceof Date ? at : new Date(at);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '--:--:--';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * One human-readable log line:
 *   `[09:42:15] John 3:16 (KJV)`
 * The translation is omitted when unknown:
 *   `[09:42:15] John 3:16`
 */
export function formatServiceLogLine({ at = new Date(), reference = '', bible = '' } = {}) {
  const cleaned = normalizeServiceVerseReference(reference);
  const translation = typeof bible === 'string' ? bible.trim() : '';
  const suffix = translation ? ` (${translation})` : '';
  return `[${serviceClockLabel(at)}] ${cleaned}${suffix}`;
}
