/**
 * main/speechHistory.js — Live Sermon Assist, Decision D9 / Phase 4:
 * local transcript history persistence.
 *
 * WHAT THIS IS: one JSON file per transcription session under
 * `<userData>/speech-engine/history/`, browsable, searchable, exportable,
 * and erasable. History is ON BY DEFAULT (D9) — the sermon is published to
 * the church's own channel, so the useful default is to keep the record,
 * not to hide it. The repo's `speech-engine/` checkout is NEVER written to;
 * everything lives under `userData`, exactly like the model drop-in
 * directory (see main/speechDownloader.js resolveModelsDir).
 *
 * PURE-CORE RULE (same as main/permissionPolicy.js, main/speechEngine.js,
 * main/speechDownloader.js): nothing here imports `electron`. The history
 * directory, caps, clock, and logger are all injected, so every decision
 * function — rotation, cap enforcement, search filtering, export rendering —
 * is unit-testable under vitest against a throwaway temp directory.
 *
 * ---------------------------------------------------------------------------
 * HYGIENE (plan, non-negotiable): no transcript text and no audio ever
 * reaches the app log. Every log line below records COUNTS, session ids,
 * byte totals, durations, and status codes only — never `segment.text`, never
 * a record dump. tests/speech/speechHistory.test.js captures this module's
 * logger output while writing a session and asserts the segment text is
 * absent, so a future `log.info(record)` cannot slip through review.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * DISK CAPS (Phase 6 rule, implemented NOW because it is a data-layer
 * concern): two named constants, both exported and unit-tested.
 *
 *   HISTORY_BYTE_CAP   hard ceiling on bytes stored under the history
 *                      directory (sessions + exports). Writes rotate the
 *                      OLDEST stored file out first; if the incoming file
 *                      alone exceeds the cap even on a completely empty
 *                      history, the write is REFUSED and recording stops
 *                      with code `history-cap-reached` — the drive is never
 *                      allowed to fill.
 *   HISTORY_SESSION_CAP  ceiling on stored sessions; writing a new session
 *                      rotates the oldest session out first.
 *
 * One transient nuance: the new file is written BEFORE old files are
 * evicted (so a failed write never destroys history), which means total
 * bytes may exceed the cap by at most ONE incoming file for the duration of
 * the write. The steady state is always <= cap.
 *
 * ---------------------------------------------------------------------------
 * PARTIALS: only FINAL segments are persisted (see appendSegment). A
 * provisional partial is text the engine may rewrite or discard a moment
 * later — storing it would make the history a record of what was almost
 * said. The live partial still reaches the renderer over speech:transcript;
 * history keeps the settled words.
 *
 * WER: `werEstimate` is designed in from the start and starts as `null`
 * (Phase 3 computes it when a reference is available) so the quality record
 * never needs a schema migration — and so this module never fabricates a
 * number. The UI renders null as "not benchmarked".
 *
 * WIRING: main/speechIpc.js owns the `speech:history:*` channels and calls
 * this store. The supervisor (main/speechEngine.js) is NOT yet wired to call
 * `beginSession`/`appendSegment`/`endSession` directly — that file is owned
 * by a parallel change; the write path exists, is registered on
 * `speech:history:append`, and is documented as a follow-up one-line call.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { saveTextFileAtomically } from './atomicFileSave.js';
import createMainLogger from './logger.js';

// ---------------------------------------------------------------------------
// Named constants
// ---------------------------------------------------------------------------

/** `<userData>/speech-engine/history` — mirrors MODELS_DIR_SEGMENTS. */
export const HISTORY_DIR_SEGMENTS = Object.freeze(['speech-engine', 'history']);

/** Export files are transcript-bearing too; they live in one subdirectory. */
export const HISTORY_EXPORT_DIR = 'exports';

/** Schema stamp on every stored session (bump only with a migration). */
export const HISTORY_SCHEMA = 1;

/** Hard byte ceiling for stored history (sessions + exports). See header. */
export const HISTORY_BYTE_CAP = 64 * 1024 * 1024; // 64 MiB

/** Stored-session ceiling; the oldest session rotates out beyond it. */
export const HISTORY_SESSION_CAP = 500;

/** At most this many excerpts per session in a search result. */
export const SEARCH_EXCERPT_LIMIT = 5;

/** Detection/action events kept per session for offline tuning (bounded). */
export const EVENTS_PER_SESSION_CAP = 2000;

/** Longest string field kept in one event (references/codes only, never text). */
export const EVENT_STRING_LIMIT = 500;

/** Characters of context on each side of a search hit inside an excerpt. */
export const EXCERPT_RADIUS = 48;

/** Status code reported when the hard cap refuses a write. */
export const HISTORY_CAP_REACHED = 'history-cap-reached';

/** `<userData>/speech-engine/history` — never the repo's speech-engine/. */
export function resolveHistoryDir(userDataDir) {
  if (typeof userDataDir !== 'string' || !userDataDir.trim()) {
    throw new Error('resolveHistoryDir: a userData directory is required');
  }
  return path.join(userDataDir, ...HISTORY_DIR_SEGMENTS);
}

// ---------------------------------------------------------------------------
// Pure decision helpers — no fs, no electron, unit-testable anywhere
// ---------------------------------------------------------------------------

/**
 * The on-disk file name for one session. A session id may never climb out
 * of the history directory: anything outside [A-Za-z0-9._-] is rejected.
 */
export function safeSessionFileName(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id || id === '.' || id === '..' || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error('safeSessionFileName: sessionId must be a plain identifier');
  }
  return `${id}.json`;
}

/** Clamp a number into [min, max], or return null when it is not finite. */
function clampNumber(value, min, max) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/** First-seen unique provider ids, in order — the per-segment attribution. */
export function providerIdsOf(record) {
  const out = [];
  for (const segment of record?.segments ?? []) {
    const id = segment?.providerId ?? null;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The list/detail payload: every boundary field the plan names (date,
 * duration, model, provider, WER) and NO segment text — the list stays
 * cheap, and summary responses never carry content they do not need to.
 */
export function summarizeSession(record, bytes = null) {
  if (!record || typeof record !== 'object') return null;
  return {
    sessionId: record.sessionId ?? null,
    startedAt: Number.isFinite(record.startedAt) ? record.startedAt : null,
    endedAt: Number.isFinite(record.endedAt) ? record.endedAt : null,
    durationMs: Number.isFinite(record.durationMs) ? record.durationMs : null,
    modelId: typeof record.modelId === 'string' ? record.modelId : null,
    providerId: typeof record.providerId === 'string' ? record.providerId : null,
    where: typeof record.where === 'string' ? record.where : null,
    werEstimate: Number.isFinite(record.werEstimate) ? record.werEstimate : null,
    segmentCount: Array.isArray(record.segments) ? record.segments.length : 0,
    eventCount: Array.isArray(record.events) ? record.events.length : 0,
    providers: providerIdsOf(record),
    bytes: Number.isFinite(bytes) ? bytes : null,
  };
}

/**
 * Coerce one incoming segment into the stored shape.
 * Returns null when there is nothing recordable (no object, no text).
 */
export function normalizeSegment(raw, fallbackProviderId = null) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (!text.trim()) return null;
  const startMs = clampNumber(raw.tStartMs, 0, Number.MAX_SAFE_INTEGER);
  const endMs = clampNumber(raw.tEndMs, 0, Number.MAX_SAFE_INTEGER);
  const providerId =
    typeof raw.providerId === 'string' && raw.providerId
      ? raw.providerId
      : typeof fallbackProviderId === 'string' && fallbackProviderId
        ? fallbackProviderId
        : null;
  const segment = {
    segmentId: typeof raw.segmentId === 'string' && raw.segmentId ? raw.segmentId : randomUUID(),
    tStartMs: startMs ?? 0,
    tEndMs: endMs ?? startMs ?? 0,
    text,
    confidence: clampNumber(raw.confidence, 0, 1),
    providerId,
    // 'partial' survives normalization so appendSegment can drop it;
    // an untagged segment is treated as final — only finalized supervisor
    // messages are meant to reach this write path.
    kind: raw.kind === 'partial' ? 'partial' : 'final',
  };
  const noSpeechProb = clampNumber(raw.noSpeechProb, 0, 1);
  if (noSpeechProb !== null) segment.noSpeechProb = noSpeechProb;
  return segment;
}

/**
 * Coerce ONE detection/action event into the stored shape.
 *
 * This is a deliberately small whitelist. Transcript text already lives in
 * `segments`; an event carries only the facts needed to tune the detector:
 * what fired, on which lane, how confident, what the operator did. Unknown
 * fields and free text are dropped, not persisted.
 */
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = typeof raw.type === 'string' ? raw.type.trim().slice(0, 64) : '';
  if (!type) return null;
  const event = { type };
  const atMs = clampNumber(raw.atMs, 0, Number.MAX_SAFE_INTEGER);
  if (atMs !== null) event.atMs = Math.floor(atMs);
  const startMs = clampNumber(raw.tStartMs, 0, Number.MAX_SAFE_INTEGER);
  const endMs = clampNumber(raw.tEndMs, 0, Number.MAX_SAFE_INTEGER);
  if (startMs !== null) event.tStartMs = Math.floor(startMs);
  if (endMs !== null) event.tEndMs = Math.floor(endMs);
  const confidence = clampNumber(raw.confidence, 0, 1);
  if (confidence !== null) event.confidence = confidence;
  for (const key of ['lane', 'action', 'reference', 'detector', 'code', 'modelId', 'providerId']) {
    if (typeof raw[key] === 'string' && raw[key].trim()) {
      event[key] = raw[key].trim().slice(0, EVENT_STRING_LIMIT);
    }
  }
  return event;
}

/** An excerpt around the first `query` hit, with ellipses when clipped. */
export function excerptAround(text, matchIndex, matchLength) {
  const source = String(text ?? '');
  const start = Math.max(0, matchIndex - EXCERPT_RADIUS);
  const end = Math.min(source.length, matchIndex + matchLength + EXCERPT_RADIUS);
  return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
}

/**
 * Search across session records. Matches on segment text AND on session
 * metadata (id, model, provider, where) so "did I trial cloud last week?"
 * is answerable without remembering a single quoted line. An empty or
 * whitespace query matches NOTHING — never everything.
 *
 * @returns array of { ...summary, matchedOn: 'text'|'meta', segments: excerpts }
 */
export function searchSessionRecords(records, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const matches = [];
  for (const record of records ?? []) {
    if (!record || typeof record !== 'object') continue;
    const meta = [
      record.sessionId,
      record.modelId,
      record.providerId,
      record.where,
    ]
      .filter((value) => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    const metaHit = meta.includes(q);
    const segments = [];
    for (const segment of record.segments ?? []) {
      if (segments.length >= SEARCH_EXCERPT_LIMIT) break;
      const text = String(segment?.text ?? '');
      const index = text.toLowerCase().indexOf(q);
      if (index < 0) continue;
      segments.push({
        segmentId: segment.segmentId ?? null,
        tStartMs: Number.isFinite(segment.tStartMs) ? segment.tStartMs : null,
        tEndMs: Number.isFinite(segment.tEndMs) ? segment.tEndMs : null,
        providerId: segment.providerId ?? null,
        excerpt: excerptAround(text, index, q.length),
      });
    }
    if (segments.length === 0 && !metaHit) continue;
    matches.push({
      ...summarizeSession(record),
      matchedOn: segments.length > 0 ? 'text' : 'meta',
      segments,
    });
  }
  return matches;
}

/**
 * Rotation / hard-cap decision — the heart of the Phase 6 disk rule.
 *
 * @param entries    stored files: [{ id, kind:'session'|'export', bytes, ageMs }]
 *                   (the caller already excludes the file being replaced)
 * @param incoming   { id, kind, bytes } about to be written
 * @param caps       { byteCap, sessionCap }
 * @returns { evict, fits } — evict oldest-first; `fits:false` means even an
 *   EMPTY history cannot hold `incoming`: refuse the write, stop recording.
 *
 * Order: the session-count cap evicts oldest SESSIONS (an export is not a
 * session and never counts), then the byte cap evicts oldest file of any
 * kind — an export carries transcript content, so it rotates with the rest.
 */
export function planRotation(
  entries,
  incoming,
  { byteCap = HISTORY_BYTE_CAP, sessionCap = HISTORY_SESSION_CAP } = {}
) {
  const oldestFirst = entries
    .filter((entry) => entry && entry.id !== incoming.id)
    .sort((a, b) => (a.ageMs - b.ageMs) || String(a.id).localeCompare(String(b.id)));
  const evicted = new Set();
  const evict = [];
  const kept = () => oldestFirst.filter((entry) => !evicted.has(entry.id));

  if (incoming.kind === 'session') {
    let sessionCount = kept().filter((entry) => entry.kind === 'session').length + 1;
    for (const entry of oldestFirst) {
      if (sessionCount <= sessionCap) break;
      if (entry.kind !== 'session' || evicted.has(entry.id)) continue;
      evicted.add(entry.id);
      evict.push(entry);
      sessionCount -= 1;
    }
  }

  let total = kept().reduce((sum, entry) => sum + entry.bytes, 0) + incoming.bytes;
  for (const entry of oldestFirst) {
    if (total <= byteCap) break;
    if (evicted.has(entry.id)) continue;
    evicted.add(entry.id);
    evict.push(entry);
    total -= entry.bytes;
  }

  return { evict, fits: incoming.bytes <= byteCap };
}

/** `12:34` / `1:02:34` clock label for a millisecond offset. */
export function formatClock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Plain-text export rendering (the other supported format — see export). */
export function renderTextExport(records, exportedAt = new Date().toISOString()) {
  const lines = [
    'Sermon Assist transcript export',
    `Exported: ${exportedAt}`,
    `Sessions: ${records.length}`,
  ];
  for (const record of records) {
    const summary = summarizeSession(record);
    lines.push('');
    lines.push('==================================================');
    lines.push(`Session: ${summary.sessionId}`);
    lines.push(`Date: ${summary.startedAt ? new Date(summary.startedAt).toISOString() : 'unknown'}`);
    lines.push(`Duration: ${summary.durationMs != null ? formatClock(summary.durationMs) : 'unknown'}`);
    lines.push(`Model: ${summary.modelId ?? 'unknown'}`);
    lines.push(`Provider: ${summary.providerId ?? 'unknown'} (where: ${summary.where ?? 'unknown'})`);
    lines.push('WER: not benchmarked');
    lines.push(`Segments: ${summary.segmentCount}`);
    lines.push(`Events: ${summary.eventCount}`);
    lines.push('');
    for (const event of record.events ?? []) {
      lines.push(
        `[event${event.atMs != null ? ` ${formatClock(event.atMs)}` : ''}] ${event.type}` +
        `${event.lane ? ` lane=${event.lane}` : ''}` +
        `${event.reference ? ` ref=${event.reference}` : ''}` +
        `${event.action ? ` action=${event.action}` : ''}` +
        `${event.confidence != null ? ` conf=${event.confidence}` : ''}`
      );
    }
    for (const segment of record.segments ?? []) {
      lines.push(
        `[${formatClock(segment.tStartMs)}] (${segment.providerId ?? 'unknown'}) ${segment.text}`
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// The store — fs through the injected directory, everything else pure
// ---------------------------------------------------------------------------

/**
 * Create a history store.
 *
 * @param {Object} options
 * @param {string} options.historyDir  absolute directory (resolveHistoryDir)
 * @param {number} [options.sessionCap] override for tests
 * @param {number} [options.byteCap]    override for tests
 * @param {{debug,info,warn,error}} [options.log] injected logger (tests capture it)
 * @param {() => number} [options.now]  injected clock (tests control age)
 *
 * Construction performs NO I/O: the first operation scans the directory
 * lazily, so wiring this up at app boot stays cold.
 */
export function createSpeechHistoryStore({
  historyDir,
  sessionCap = HISTORY_SESSION_CAP,
  byteCap = HISTORY_BYTE_CAP,
  log = createMainLogger('SpeechHistory'),
  now = Date.now,
} = {}) {
  if (typeof historyDir !== 'string' || !historyDir.trim()) {
    throw new Error('createSpeechHistoryStore: a historyDir is required');
  }
  const caps = {
    sessionCap: Math.max(1, Math.floor(sessionCap)),
    byteCap: Math.max(1, Math.floor(byteCap)),
  };

  /** id -> { id, kind, bytes, ageMs, summary|null } (summary null = unparsable). */
  let inventory = null;
  let dirReady = false;
  let status = { recording: true, code: null };

  const exportsDir = path.join(historyDir, HISTORY_EXPORT_DIR);

  async function ensureDir(dir) {
    if (dir === historyDir && dirReady) return;
    await fsp.mkdir(dir, { recursive: true });
    if (dir === historyDir) dirReady = true;
  }

  /** Lazy scan: sessions parsed to SUMMARIES (small), exports stat-only. */
  async function scan() {
    if (inventory) return inventory;
    const next = new Map();
    let names = [];
    try {
      names = await fsp.readdir(historyDir);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    for (const name of names) {
      if (name === HISTORY_EXPORT_DIR || !name.endsWith('.json')) continue;
      const id = name;
      let content = null;
      try {
        content = await fsp.readFile(path.join(historyDir, name), 'utf8');
      } catch {
        continue;
      }
      let summary = null;
      let ageMs = 0; // a file that does not parse is garbage; garbage rotates out first
      try {
        const record = JSON.parse(content);
        summary = summarizeSession(record, Buffer.byteLength(content, 'utf8'));
        if (Number.isFinite(record?.startedAt)) ageMs = record.startedAt;
      } catch {
        summary = null;
      }
      next.set(id, {
        id,
        kind: 'session',
        bytes: Buffer.byteLength(content ?? '', 'utf8'),
        ageMs,
        summary,
      });
    }
    let exportNames = [];
    try {
      exportNames = await fsp.readdir(exportsDir);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    for (const name of exportNames) {
      const id = `${HISTORY_EXPORT_DIR}/${name}`;
      try {
        const stat = await fsp.stat(path.join(historyDir, id));
        if (!stat.isFile()) continue;
        next.set(id, { id, kind: 'export', bytes: stat.size, ageMs: stat.mtimeMs, summary: null });
      } catch {
        // Removed between readdir and stat — ignore.
      }
    }
    inventory = next;
    return inventory;
  }

  const storedBytes = () => [...inventory.values()].reduce((sum, entry) => sum + entry.bytes, 0);

  async function readRecord(sessionId) {
    await scan();
    const fileName = safeSessionFileName(sessionId);
    if (!inventory.has(fileName)) return null;
    try {
      const content = await fsp.readFile(path.join(historyDir, fileName), 'utf8');
      const record = JSON.parse(content);
      return record && typeof record === 'object' ? record : null;
    } catch {
      return null;
    }
  }

  /** Every stored session record (search/export need the text; list does not). */
  async function readAllRecords() {
    await scan();
    const ids = [...inventory.values()]
      .filter((entry) => entry.kind === 'session')
      .map((entry) => entry.id);
    const records = [];
    for (const id of ids) {
      try {
        const content = await fsp.readFile(path.join(historyDir, id), 'utf8');
        const record = JSON.parse(content);
        if (record && typeof record === 'object') records.push(record);
      } catch {
        // Unreadable file: skip rather than fail the whole query.
      }
    }
    return records.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  }

  async function removeEntry(entry) {
    try {
      await fsp.rm(path.join(historyDir, entry.id), { force: true });
      inventory.delete(entry.id);
    } catch {
      // Best-effort: a failed eviction only leaves the cap temporarily tight.
    }
  }

  /**
   * The ONE write path for a session file: rotate first (decision), refuse
   * on the hard cap, write atomically, THEN evict — so a failed write can
   * never destroy existing history. Logs ids, counts, and bytes only.
   */
  async function writeSessionRecord(record) {
    await scan();
    const fileName = safeSessionFileName(record.sessionId);
    const content = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(content, 'utf8');
    const plan = planRotation([...inventory.values()], { id: fileName, kind: 'session', bytes }, caps);

    if (!plan.fits) {
      status = { recording: false, code: HISTORY_CAP_REACHED };
      log.warn(
        `Transcript history hard cap reached; recording stopped (incoming ${bytes} bytes, cap ${caps.byteCap} bytes)`
      );
      return { ok: false, code: HISTORY_CAP_REACHED, byteCap: caps.byteCap };
    }

    await ensureDir(historyDir);
    await saveTextFileAtomically(path.join(historyDir, fileName), content);

    let evictedCount = 0;
    for (const entry of plan.evict) {
      await removeEntry(entry);
      evictedCount += 1;
    }

    inventory.set(fileName, {
      id: fileName,
      kind: 'session',
      bytes,
      ageMs: Number.isFinite(record.startedAt) ? record.startedAt : now(),
      summary: summarizeSession(record, bytes),
    });
    status = { recording: true, code: null };

    // Counts and ids only — NEVER record.segments or any text (hygiene rule).
    log.info(
      `Transcript history stored session ${record.sessionId} ` +
        `(${record.segments.length} segments, ${bytes} bytes, evicted ${evictedCount} old file(s))`
    );
    return { ok: true, bytes, evicted: evictedCount };
  }

  // --- record lifecycle -----------------------------------------------------

  /**
   * Start a session record (write-through: an empty session is on disk
   * before the first word, so a crash keeps the boundary metadata).
   * Payload: { sessionId?, startedAt?, modelId?, providerId?, where? }.
   */
  async function beginSession(meta = {}) {
    await scan();
    const sessionId =
      typeof meta.sessionId === 'string' && meta.sessionId.trim()
        ? meta.sessionId.trim()
        : randomUUID();
    let fileName = null;
    try {
      fileName = safeSessionFileName(sessionId);
    } catch {
      return { ok: false, code: 'invalid-argument', field: 'sessionId' };
    }
    if (inventory.has(fileName)) {
      const existing = inventory.get(fileName);
      return { ok: true, existing: true, session: existing.summary };
    }
    const record = {
      schema: HISTORY_SCHEMA,
      sessionId,
      startedAt: Number.isFinite(meta.startedAt) ? meta.startedAt : now(),
      endedAt: null,
      durationMs: null,
      modelId: typeof meta.modelId === 'string' ? meta.modelId : null,
      providerId: typeof meta.providerId === 'string' ? meta.providerId : null,
      where: typeof meta.where === 'string' ? meta.where : null,
      // Designed in from day one so Phase 3 fills it instead of migrating.
      werEstimate: null,
      segments: [],
      // Detection/action events for offline tuning; bounded, local only.
      events: [],
    };
    const write = await writeSessionRecord(record);
    if (!write.ok) return write;
    return { ok: true, session: summarizeSession(record, write.bytes) };
  }

  /**
   * Append ONE segment. Finals only: a `partial` is acknowledged and NOT
   * persisted (see header — provisional text would make the history
   * misleading). Per-segment `providerId` is preserved verbatim: that is
   * the attribution that shows where a cloud trial began and ended.
   */
  async function appendSegment(sessionId, rawSegment) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return { ok: false, code: 'invalid-argument', field: 'sessionId' };
    }
    const record = await readRecord(sessionId).catch(() => null);
    if (!record) return { ok: false, code: 'session-not-found', sessionId };
    const segment = normalizeSegment(rawSegment, record.providerId);
    if (!segment) return { ok: false, code: 'invalid-segment', field: 'segment' };
    if (segment.kind === 'partial') {
      return {
        ok: true,
        stored: false,
        reason: 'partials-are-not-persisted',
        segmentCount: (record.segments ?? []).length,
      };
    }

    record.segments = Array.isArray(record.segments) ? record.segments : [];
    record.segments.push(segment);
    const write = await writeSessionRecord(record);
    if (!write.ok) {
      // Roll back so memory matches disk and the cap failure is not retried
      // into an ever-growing record: recording has stopped, by design.
      record.segments.pop();
      return write;
    }
    return { ok: true, stored: true, segmentCount: record.segments.length, bytes: write.bytes };
  }

  /**
   * Append ONE detection/action event for offline tuning. Bounded per
   * session; once the cap is reached the oldest event rotates out. This is a
   * metadata path only — no transcript or audio is accepted here.
   */
  async function appendEvent(sessionId, rawEvent) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return { ok: false, code: 'invalid-argument', field: 'sessionId' };
    }
    const record = await readRecord(sessionId).catch(() => null);
    if (!record) return { ok: false, code: 'session-not-found', sessionId };
    const event = normalizeEvent(rawEvent);
    if (!event) return { ok: false, code: 'invalid-event', field: 'event' };
    record.events = Array.isArray(record.events) ? record.events : [];
    record.events.push(event);
    while (record.events.length > EVENTS_PER_SESSION_CAP) record.events.shift();
    const write = await writeSessionRecord(record);
    if (!write.ok) {
      record.events.pop();
      return write;
    }
    return { ok: true, stored: true, eventCount: record.events.length, bytes: write.bytes };
  }

  /**
   * Close a session: endedAt, durationMs, and (Phase 3) the WER estimate
   * when a reference exists. `werEstimate` stays null unless supplied.
   */
  async function endSession(sessionId, patch = {}) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return { ok: false, code: 'invalid-argument', field: 'sessionId' };
    }
    const record = await readRecord(sessionId).catch(() => null);
    if (!record) return { ok: false, code: 'session-not-found', sessionId };
    const endedAt = Number.isFinite(patch.endedAt) ? patch.endedAt : now();
    record.endedAt = endedAt;
    record.durationMs = Number.isFinite(patch.durationMs)
      ? patch.durationMs
      : Math.max(0, endedAt - (Number.isFinite(record.startedAt) ? record.startedAt : endedAt));
    if ('werEstimate' in patch) {
      const wer = typeof patch.werEstimate === 'number' ? patch.werEstimate : Number(patch.werEstimate);
      record.werEstimate = Number.isFinite(wer) ? wer : null;
    }
    const write = await writeSessionRecord(record);
    if (!write.ok) return write;
    return { ok: true, session: summarizeSession(record, write.bytes) };
  }

  // --- reads ----------------------------------------------------------------

  /** Summaries, newest first. NO segment text crosses this boundary. */
  async function listSessions() {
    await scan();
    return [...inventory.values()]
      .filter((entry) => entry.kind === 'session' && entry.summary)
      .map((entry) => entry.summary)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  /** One session WITH its segments (the only read that returns text). */
  async function getSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return { ok: false, code: 'invalid-argument', field: 'sessionId' };
    }
    const record = await readRecord(sessionId).catch(() => null);
    if (!record) return { ok: false, code: 'session-not-found', sessionId };
    await scan();
    const bytes = inventory.get(safeSessionFileName(sessionId))?.bytes ?? null;
    return { ok: true, session: { ...record, bytes } };
  }

  /** Query over stored sessions: matching summaries + segment excerpts. */
  async function searchHistory(query) {
    if (typeof query !== 'string') {
      return { ok: false, code: 'invalid-argument', field: 'query' };
    }
    const records = await readAllRecords();
    return { ok: true, query: query.trim(), matches: searchSessionRecords(records, query) };
  }

  // --- export ---------------------------------------------------------------

  /**
   * Write an export file and return its path. Two formats:
   *   `json`  (default) — full records, every field, round-trippable,
   *                       per-segment provider attribution intact;
   *   `text`            — readable transcript with per-segment clock and
   *                       provider tags.
   * Exports land in `<historyDir>/exports/` (inside the cap, erased with
   * everything else — an export IS transcript content).
   */
  async function exportHistory({ format = 'json', sessionId = null } = {}) {
    if (format !== 'json' && format !== 'text') {
      return { ok: false, code: 'invalid-argument', field: 'format' };
    }
    await scan();
    let records;
    if (sessionId !== null && sessionId !== undefined) {
      if (typeof sessionId !== 'string' || !sessionId.trim()) {
        return { ok: false, code: 'invalid-argument', field: 'sessionId' };
      }
      const record = await readRecord(sessionId).catch(() => null);
      if (!record) return { ok: false, code: 'session-not-found', sessionId };
      records = [record];
    } else {
      records = await readAllRecords();
    }

    const exportedAt = new Date(now()).toISOString();
    const content =
      format === 'json'
        ? `${JSON.stringify({ schema: HISTORY_SCHEMA, exportedAt, sessions: records }, null, 2)}\n`
        : renderTextExport(records, exportedAt);

    const stamp = exportedAt.replace(/[:.]/g, '-');
    const suffix = sessionId ? `-${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '-')}` : '';
    const extension = format === 'json' ? 'json' : 'txt';
    const id = `${HISTORY_EXPORT_DIR}/sermon-transcript-${stamp}${suffix}-${randomUUID().slice(0, 6)}.${extension}`;
    const bytes = Buffer.byteLength(content, 'utf8');

    const plan = planRotation([...inventory.values()], { id, kind: 'export', bytes }, caps);
    if (!plan.fits) {
      status = { recording: false, code: HISTORY_CAP_REACHED };
      log.warn(
        `Transcript history hard cap reached; export refused (incoming ${bytes} bytes, cap ${caps.byteCap} bytes)`
      );
      return { ok: false, code: HISTORY_CAP_REACHED, byteCap: caps.byteCap };
    }

    await ensureDir(historyDir);
    await ensureDir(exportsDir);
    const filePath = path.join(historyDir, id);
    await saveTextFileAtomically(filePath, content);
    for (const entry of plan.evict) await removeEntry(entry);
    inventory.set(id, { id, kind: 'export', bytes, ageMs: now(), summary: null });

    // File name and counts only — never the exported content (hygiene rule).
    log.info(
      `Transcript history export written (${path.basename(filePath)}, ${bytes} bytes, ${records.length} session(s))`
    );
    return { ok: true, path: filePath, bytes, format, sessionCount: records.length };
  }

  // --- erase (Phase 0 invariant 6's transcript slice) -----------------------

  /**
   * Erase EVERY stored transcript: sessions and exports alike, reporting the
   * bytes reclaimed. This is the whole-history erase the plan's uninstall
   * invariant names; Phase 6 wraps it into the one-click uninstall.
   */
  async function eraseAll() {
    await scan();
    let bytesReclaimed = 0;
    let sessionsRemoved = 0;
    let exportsRemoved = 0;
    for (const entry of inventory.values()) {
      bytesReclaimed += entry.bytes;
      if (entry.kind === 'session') sessionsRemoved += 1;
      else exportsRemoved += 1;
    }
    try {
      await fsp.rm(historyDir, { recursive: true, force: true });
    } catch {
      // Best-effort; the inventory below is cleared either way.
    }
    inventory = new Map();
    dirReady = false;
    status = { recording: true, code: null };
    // Counts and bytes only (hygiene rule).
    log.info(
      `Transcript history erased (${sessionsRemoved} sessions, ${exportsRemoved} exports, ${bytesReclaimed} bytes reclaimed)`
    );
    return { ok: true, bytesReclaimed, sessionsRemoved, exportsRemoved };
  }

  /** Recording status + cap/usage snapshot (what the UI shows as a notice). */
  async function getStatus() {
    await scan();
    return {
      ok: true,
      recording: status.recording !== false,
      code: status.code,
      byteCap: caps.byteCap,
      sessionCap: caps.sessionCap,
      storedBytes: storedBytes(),
      sessionCount: [...inventory.values()].filter((entry) => entry.kind === 'session').length,
      exportCount: [...inventory.values()].filter((entry) => entry.kind === 'export').length,
      historyDir,
    };
  }

  return {
    historyDir,
    beginSession,
    appendSegment,
    appendEvent,
    endSession,
    listSessions,
    getSession,
    searchHistory,
    exportHistory,
    eraseAll,
    getStatus,
  };
}
