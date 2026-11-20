/**
 * tests/speech/speechHistory.test.js — Live Sermon Assist, Decision D9 /
 * Phase 4: transcript-history persistence.
 *
 * Runs against throwaway temp directories — never the real `userData`,
 * never the repo's `speech-engine/`. What is pinned here:
 *
 *   - round-trip: write -> read, with the boundary fields the plan names
 *     (date, duration, model, provider) and `werEstimate` present and null
 *     until Phase 3 computes one,
 *   - PER-SEGMENT provider attribution survives storage (the boundary a
 *     cloud-trial user must be able to see),
 *   - finals only: a provisional partial is acknowledged, never persisted,
 *   - rotation: the session-count cap and the byte cap evict oldest-out,
 *     and the HARD cap refuses a write and reports `history-cap-reached`
 *     instead of filling the drive,
 *   - hygiene: NO transcript text ever reaches the logger output — captured
 *     both through an injected logger and through the real default logger,
 *   - erase removes every session and export and reports bytes reclaimed,
 *   - search matches the right sessions and never matches nothing,
 *   - export writes a real file in the chosen format,
 *   - the six speech:history:* IPC channels register and their list reply
 *     carries no segment text.
 *
 * Zero new npm dependencies: node:fs / node:os / node:path only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createSpeechHistoryStore,
  resolveHistoryDir,
  planRotation,
  searchSessionRecords,
  summarizeSession,
  normalizeSegment,
  normalizeEvent,
  safeSessionFileName,
  renderTextExport,
  HISTORY_DIR_SEGMENTS,
  HISTORY_BYTE_CAP,
  HISTORY_SESSION_CAP,
  HISTORY_CAP_REACHED,
} from '../../main/speechHistory.js';

// electron is stubbed so main/speechIpc.js can be exercised below without an
// Electron process (the history store itself never imports electron).
const electron = vi.hoisted(() => ({ handlers: new Map() }));
vi.mock('electron', () => ({
  app: { getPath: (name) => `/tmp/electron-mock-history/${name}` },
  ipcMain: {
    handle: (channel, handler) => electron.handlers.set(channel, handler),
    removeHandler: (channel) => electron.handlers.delete(channel),
  },
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const tempDirs = [];

const makeTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-history-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (tempDirs.length) {
    await fsp.rm(tempDirs.pop(), { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

/** A capturing logger — every line, so the hygiene assertions see it all. */
const createCapturingLogger = () => {
  const lines = [];
  const push = (level) => (...args) => lines.push(`[${level}] ${args.join(' ')}`);
  return {
    lines,
    log: { debug: push('DEBUG'), info: push('INFO'), warn: push('WARN'), error: push('ERROR') },
  };
};

const makeStore = (dir, options = {}) =>
  createSpeechHistoryStore({ historyDir: dir, ...options });

const sessionFileNames = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
    : [];

const SECRET_TEXT = 'Blessed are the peacemakers, ZZX-SECRET-TRANSCRIPT-ZZX';

const segment = (overrides = {}) => ({
  tStartMs: 1000,
  tEndMs: 2500,
  text: SECRET_TEXT,
  confidence: 0.93,
  providerId: 'whispercpp',
  kind: 'final',
  ...overrides,
});

async function writeSession(store, { sessionId, startedAt, segments = [], ...meta }) {
  const begun = await store.beginSession({ sessionId, startedAt, ...meta });
  expect(begun.ok, `beginSession(${sessionId}) should succeed`).toBe(true);
  for (const entry of segments) {
    await store.appendSegment(sessionId, entry);
  }
  return store.endSession(sessionId, { endedAt: startedAt + 60_000 });
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe('history lives under userData, never in the repo', () => {
  it('resolveHistoryDir joins the documented segments', () => {
    expect(HISTORY_DIR_SEGMENTS).toEqual(['speech-engine', 'history']);
    expect(resolveHistoryDir('/home/user/.config/Selah')).toBe(
      path.join('/home/user/.config/Selah', 'speech-engine', 'history')
    );
  });

  it('rejects an empty userData directory', () => {
    expect(() => resolveHistoryDir('')).toThrow();
    expect(() => resolveHistoryDir(undefined)).toThrow();
  });

  it('safeSessionFileName accepts plain ids and rejects traversal', () => {
    expect(safeSessionFileName('svc-1')).toBe('svc-1.json');
    expect(() => safeSessionFileName('../escape')).toThrow();
    expect(() => safeSessionFileName('a/b')).toThrow();
    expect(() => safeSessionFileName('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

describe('pure decision functions', () => {
  it('planRotation evicts oldest sessions beyond the session-count cap', () => {
    const entries = [
      { id: 'a.json', kind: 'session', bytes: 10, ageMs: 1 },
      { id: 'b.json', kind: 'session', bytes: 10, ageMs: 2 },
      { id: 'export.json', kind: 'export', bytes: 10, ageMs: 3 },
    ];
    const plan = planRotation(entries, { id: 'c.json', kind: 'session', bytes: 10 }, {
      byteCap: 10_000,
      sessionCap: 2,
    });
    expect(plan.fits).toBe(true);
    // Two existing sessions + the incoming one = 3 > cap 2 -> evict 'a'
    // (oldest session). The export is not a session and never counts.
    expect(plan.evict.map((entry) => entry.id)).toEqual(['a.json']);
  });

  it('planRotation evicts oldest file of any kind beyond the byte cap', () => {
    const entries = [
      { id: 'a.json', kind: 'session', bytes: 100, ageMs: 1 },
      { id: 'b.json', kind: 'session', bytes: 100, ageMs: 2 },
      { id: 'exports/x.txt', kind: 'export', bytes: 100, ageMs: 3 },
    ];
    const plan = planRotation(entries, { id: 'c.json', kind: 'session', bytes: 100 }, {
      byteCap: 250,
      sessionCap: 100,
    });
    expect(plan.fits).toBe(true);
    // 400 -> evict oldest 'a' (300, still over) -> evict 'b' (200, fits).
    expect(plan.evict.map((entry) => entry.id)).toEqual(['a.json', 'b.json']);
  });

  it('planRotation reports fits:false when the incoming file alone exceeds the byte cap', () => {
    const plan = planRotation([], { id: 'big.json', kind: 'session', bytes: 999 }, {
      byteCap: 100,
      sessionCap: 5,
    });
    expect(plan.fits).toBe(false);
    expect(plan.evict).toEqual([]);
  });

  it('planRotation never evicts the file it is about to replace', () => {
    const entries = [{ id: 'a.json', kind: 'session', bytes: 500, ageMs: 1 }];
    const plan = planRotation(entries, { id: 'a.json', kind: 'session', bytes: 100 }, {
      byteCap: 200,
      sessionCap: 5,
    });
    expect(plan.fits).toBe(true);
    expect(plan.evict).toEqual([]);
  });

  it('searchSessionRecords matches text and metadata, and empty queries match nothing', () => {
    const records = [
      {
        sessionId: 'one',
        startedAt: 1,
        modelId: 'large-v3',
        providerId: 'whispercpp',
        where: 'local',
        segments: [{ segmentId: 's1', text: 'The Lord is my shepherd', providerId: 'whispercpp' }],
      },
      {
        sessionId: 'two',
        startedAt: 2,
        modelId: 'base.en-q8_0',
        providerId: 'cloud-openai',
        where: 'cloud',
        segments: [{ segmentId: 's2', text: 'Deep grace flows onward', providerId: 'cloud-openai' }],
      },
    ];

    const byText = searchSessionRecords(records, 'SHEPHERD');
    expect(byText).toHaveLength(1);
    expect(byText[0].sessionId).toBe('one');
    expect(byText[0].matchedOn).toBe('text');
    expect(byText[0].segments[0].excerpt).toContain('shepherd');

    const byMeta = searchSessionRecords(records, 'cloud-openai');
    expect(byMeta).toHaveLength(1);
    expect(byMeta[0].sessionId).toBe('two');
    expect(byMeta[0].matchedOn).toBe('meta');

    expect(searchSessionRecords(records, '   ')).toEqual([]);
    expect(searchSessionRecords(records, 'no-such-phrase-anywhere')).toEqual([]);
    expect(searchSessionRecords(records, '')).toEqual([]);
    expect(searchSessionRecords([], 'anything')).toEqual([]);
  });

  it('normalizeSegment keeps attribution, clamps confidence, and tags kind', () => {
    const normalized = normalizeSegment(
      { text: 'hello', tStartMs: -5, tEndMs: 'not-a-number', confidence: 3, kind: 'partial' },
      'whispercpp'
    );
    expect(normalized.tStartMs).toBe(0);
    expect(normalized.tEndMs).toBe(0);
    expect(normalized.confidence).toBe(1);
    expect(normalized.kind).toBe('partial');
    expect(normalized.providerId).toBe('whispercpp');
    expect(normalizeSegment({ text: '   ' })).toBeNull();
    expect(normalizeSegment(null)).toBeNull();
  });

  it('summarizeSession carries every boundary field and NO segment text', () => {
    const summary = summarizeSession(
      {
        sessionId: 's',
        startedAt: 10,
        endedAt: 70,
        durationMs: 60,
        modelId: 'large-v3',
        providerId: 'whispercpp',
        where: 'local',
        werEstimate: null,
        segments: [{ text: SECRET_TEXT, providerId: 'whispercpp' }],
      },
      123
    );
    expect(summary).toMatchObject({
      sessionId: 's',
      startedAt: 10,
      endedAt: 70,
      durationMs: 60,
      modelId: 'large-v3',
      providerId: 'whispercpp',
      where: 'local',
      werEstimate: null,
      segmentCount: 1,
      bytes: 123,
    });
    expect(JSON.stringify(summary)).not.toContain(SECRET_TEXT);
  });

  it('renderTextExport stamps headers and per-segment clock + provider tags', () => {
    const text = renderTextExport([
      {
        sessionId: 'svc-1',
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_060_000,
        durationMs: 60_000,
        modelId: 'large-v3',
        providerId: 'whispercpp',
        where: 'local',
        werEstimate: null,
        segments: [{ segmentId: 'seg', tStartMs: 65_000, text: SECRET_TEXT, providerId: 'cloud-openai' }],
      },
    ]);
    expect(text).toContain('Sermon Assist transcript export');
    expect(text).toContain('Session: svc-1');
    expect(text).toContain('WER: not benchmarked');
    expect(text).toContain('[1:05] (cloud-openai) ');
    expect(text).toContain(SECRET_TEXT);
  });
});

// ---------------------------------------------------------------------------
// Round trip: boundaries, attribution, WER
// ---------------------------------------------------------------------------

describe('session round trip', () => {
  let dir = null;
  let store = null;

  beforeEach(() => {
    dir = makeTempDir();
    store = makeStore(dir);
  });

  it('persists boundary fields, per-segment providers, and werEstimate: null', async () => {
    const startedAt = 1_700_000_000_000;
    await writeSession(store, {
      sessionId: 'svc-1',
      startedAt,
      modelId: 'large-v3',
      providerId: 'whispercpp',
      where: 'local',
      segments: [segment()],
    });

    const [summary] = await store.listSessions();
    expect(summary).toMatchObject({
      sessionId: 'svc-1',
      startedAt,
      endedAt: startedAt + 60_000,
      durationMs: 60_000,
      modelId: 'large-v3',
      providerId: 'whispercpp',
      where: 'local',
      segmentCount: 1,
      providers: ['whispercpp'],
    });
    expect(summary.bytes).toBeGreaterThan(0);
    // The WER field exists from day one and is null until Phase 3 fills it —
    // never a fabricated number.
    expect(summary).toHaveProperty('werEstimate', null);

    const reply = await store.getSession('svc-1');
    expect(reply.ok).toBe(true);
    const stored = reply.session.segments[0];
    expect(stored.segmentId).toBeTruthy();
    expect(stored).toMatchObject({
      tStartMs: 1000,
      tEndMs: 2500,
      text: SECRET_TEXT,
      confidence: 0.93,
      providerId: 'whispercpp',
      kind: 'final',
    });

    // A fresh store reads the same bytes back — history survives restarts.
    const reopened = makeStore(dir);
    const again = await reopened.getSession('svc-1');
    expect(again.ok).toBe(true);
    expect(again.session.segments).toHaveLength(1);
    expect(again.session.startedAt).toBe(startedAt);
  });

  it('keeps per-segment provider attribution in order (the cloud-trial boundary)', async () => {
    await writeSession(store, {
      sessionId: 'svc-mixed',
      startedAt: 100,
      modelId: 'large-v3',
      providerId: 'whispercpp',
      where: 'local',
      segments: [
        segment({ providerId: 'whispercpp', text: 'first local words' }),
        segment({ providerId: 'cloud-openai', text: 'trialled cloud words' }),
        segment({ providerId: 'whispercpp', text: 'back to local words' }),
      ],
    });

    const reply = await store.getSession('svc-mixed');
    expect(reply.session.segments.map((s) => s.providerId)).toEqual([
      'whispercpp',
      'cloud-openai',
      'whispercpp',
    ]);
    const [summary] = await store.listSessions();
    expect(summary.providers).toEqual(['whispercpp', 'cloud-openai']);
  });

  it('stores finals only — a partial is acknowledged and dropped', async () => {
    await store.beginSession({ sessionId: 'svc-partials', startedAt: 100 });
    const partialReply = await store.appendSegment(
      'svc-partials',
      segment({ kind: 'partial', text: 'provisional text that would be rewritten' })
    );
    expect(partialReply).toMatchObject({ ok: true, stored: false });
    expect(partialReply.reason).toBe('partials-are-not-persisted');

    await store.appendSegment('svc-partials', segment({ text: 'settled final words' }));
    const reply = await store.getSession('svc-partials');
    expect(reply.session.segments).toHaveLength(1);
    expect(JSON.stringify(reply.session)).not.toContain('provisional text');
    expect(reply.session.segments[0].kind).toBe('final');
  });

  it('stores bounded tuning events and exports them beside the transcript', async () => {
    expect(normalizeEvent({
      type: 'suggestion', lane: 'verse', reference: 'John 10:10', detector: 'fuzzy',
      confidence: 0.81, text: 'free transcript text must be dropped',
    })).toEqual({
      type: 'suggestion', lane: 'verse', reference: 'John 10:10', detector: 'fuzzy', confidence: 0.81,
    });
    expect(normalizeEvent({ type: '' })).toBeNull();
    expect(normalizeEvent({ text: 'no type' })).toBeNull();

    await store.beginSession({ sessionId: 'svc-events', startedAt: 100 });
    await store.appendSegment('svc-events', segment({ text: 'the lord is my shepherd' }));
    const appended = await store.appendEvent('svc-events', {
      type: 'action', lane: 'verse', action: 'send', reference: 'Psalm 23:1', confidence: 0.9,
    });
    expect(appended).toMatchObject({ ok: true, stored: true, eventCount: 1 });
    await store.endSession('svc-events', { endedAt: 2000 });

    const reply = await store.getSession('svc-events');
    expect(reply.session.events).toHaveLength(1);
    expect(reply.session.events[0]).toMatchObject({
      type: 'action', lane: 'verse', action: 'send', reference: 'Psalm 23:1',
    });
    const [summary] = await store.listSessions();
    expect(summary.eventCount).toBe(1);

    const exported = await store.exportHistory({ format: 'json', sessionId: 'svc-events' });
    expect(exported.ok).toBe(true);
    const content = JSON.parse(fs.readFileSync(exported.path, 'utf8'));
    expect(content.sessions[0].events[0].action).toBe('send');
  });

  it('accepts a WER estimate on endSession (the Phase 3 fill-in path)', async () => {
    await store.beginSession({ sessionId: 'svc-wer', startedAt: 0 });
    const ended = await store.endSession('svc-wer', { endedAt: 1000, werEstimate: 0.086 });
    expect(ended.ok).toBe(true);
    expect(ended.session.werEstimate).toBeCloseTo(0.086);

    const [summary] = await store.listSessions();
    expect(summary.werEstimate).toBeCloseTo(0.086);
    // Sessions ended without a reference keep the honest null.
    await writeSession(store, { sessionId: 'svc-no-wer', startedAt: 5, segments: [] });
    const summaries = await store.listSessions();
    expect(summaries.find((s) => s.sessionId === 'svc-no-wer').werEstimate).toBeNull();
  });

  it('lists newest first and returns not-found for unknown sessions', async () => {
    await writeSession(store, { sessionId: 'older', startedAt: 1000, segments: [] });
    await writeSession(store, { sessionId: 'newer', startedAt: 2000, segments: [] });
    const list = await store.listSessions();
    expect(list.map((s) => s.sessionId)).toEqual(['newer', 'older']);

    expect(await store.getSession('missing')).toMatchObject({
      ok: false,
      code: 'session-not-found',
    });
    expect(await store.appendSegment('missing', segment())).toMatchObject({
      ok: false,
      code: 'session-not-found',
    });
    expect(await store.endSession('missing')).toMatchObject({
      ok: false,
      code: 'session-not-found',
    });
  });
});

// ---------------------------------------------------------------------------
// Rotation + the hard cap
// ---------------------------------------------------------------------------

describe('disk caps: rotation and the hard stop', () => {
  it('exceeding the session-count cap evicts the oldest session', async () => {
    const dir = makeTempDir();
    const store = makeStore(dir, { sessionCap: 2, byteCap: HISTORY_BYTE_CAP });
    await writeSession(store, { sessionId: 's1', startedAt: 1000, segments: [] });
    await writeSession(store, { sessionId: 's2', startedAt: 2000, segments: [] });
    await writeSession(store, { sessionId: 's3', startedAt: 3000, segments: [] });

    const list = await store.listSessions();
    expect(list.map((s) => s.sessionId)).toEqual(['s3', 's2']);
    expect(sessionFileNames(dir)).toHaveLength(2);
    expect(await store.getSession('s1')).toMatchObject({ ok: false, code: 'session-not-found' });
  });

  it('exceeding the byte cap evicts oldest files until the newcomer fits', async () => {
    const dir = makeTempDir();
    const store = makeStore(dir, { sessionCap: HISTORY_SESSION_CAP, byteCap: 1000 });
    const bigText = 'x'.repeat(400);
    await writeSession(store, {
      sessionId: 'b1',
      startedAt: 1000,
      segments: [segment({ text: bigText })],
    });
    await writeSession(store, {
      sessionId: 'b2',
      startedAt: 2000,
      segments: [segment({ text: bigText })],
    });

    const list = await store.listSessions();
    expect(list.map((s) => s.sessionId)).toEqual(['b2']);
    const status = await store.getStatus();
    expect(status.storedBytes).toBeLessThanOrEqual(1000);
    expect(sessionFileNames(dir)).toHaveLength(1);
  });

  it('the HARD cap refuses the write and reports it instead of filling the drive', async () => {
    const dir = makeTempDir();
    // Even a completely empty history cannot hold one such session (an empty
    // record serializes to ~150 bytes; the cap below is under that).
    const store = makeStore(dir, { byteCap: 100, sessionCap: HISTORY_SESSION_CAP });
    const begun = await store.beginSession({ sessionId: 'huge', startedAt: 1 });
    expect(begun).toMatchObject({ ok: false, code: HISTORY_CAP_REACHED });

    const status = await store.getStatus();
    expect(status.recording).toBe(false);
    expect(status.code).toBe(HISTORY_CAP_REACHED);
    // Nothing was written: the disk never grows past the cap.
    expect(sessionFileNames(dir)).toHaveLength(0);
    expect(status.storedBytes).toBe(0);
  });

  it('an append that would blow the cap is refused and rolled back', async () => {
    const dir = makeTempDir();
    const store = makeStore(dir, { byteCap: 900, sessionCap: HISTORY_SESSION_CAP });
    await store.beginSession({ sessionId: 'svc-growth', startedAt: 1 });
    await store.appendSegment('svc-growth', segment({ text: 'small first words' }));

    const refused = await store.appendSegment(
      'svc-growth',
      segment({ text: 'y'.repeat(5000) })
    );
    expect(refused).toMatchObject({ ok: false, code: HISTORY_CAP_REACHED });

    // The record on disk is untouched by the refused write.
    const reply = await store.getSession('svc-growth');
    expect(reply.session.segments).toHaveLength(1);
    expect(JSON.stringify(reply.session)).not.toContain('yyyyy');
    const status = await store.getStatus();
    expect(status.recording).toBe(false);
    expect(status.storedBytes).toBeLessThanOrEqual(900);
  });

  it('erase clears the cap stop: recording is available again', async () => {
    const dir = makeTempDir();
    const store = makeStore(dir, { byteCap: 100, sessionCap: 5 });
    expect(await store.beginSession({ sessionId: 'huge', startedAt: 1 })).toMatchObject({
      ok: false,
      code: HISTORY_CAP_REACHED,
    });
    expect((await store.getStatus()).recording).toBe(false);
    await store.eraseAll();
    const status = await store.getStatus();
    expect(status.recording).toBe(true);
    expect(status.code).toBeNull();
  });

  it('the exported cap constants are the documented ones', () => {
    expect(HISTORY_BYTE_CAP).toBe(64 * 1024 * 1024);
    expect(HISTORY_SESSION_CAP).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Hygiene: no transcript text in any log line
// ---------------------------------------------------------------------------

describe('hygiene: no transcript text reaches the log', () => {
  it('captured logger output while writing, exporting, and erasing never contains the text', async () => {
    const dir = makeTempDir();
    const capture = createCapturingLogger();
    const store = makeStore(dir, { log: capture.log });

    await writeSession(store, {
      sessionId: 'svc-hygiene',
      startedAt: 1000,
      segments: [segment(), segment({ kind: 'partial', text: `partial ${SECRET_TEXT}` })],
    });
    await store.exportHistory({ format: 'json' });
    await store.searchHistory('peacemakers');
    await store.eraseAll();

    // Something WAS logged — otherwise the assertions below would be vacuous.
    expect(capture.lines.length).toBeGreaterThan(0);
    for (const line of capture.lines) {
      expect(line).not.toContain(SECRET_TEXT);
      expect(line).not.toContain('peacemakers');
    }
    // What IS logged: counts, ids, bytes (spot-check the shape).
    expect(capture.lines.join('\n')).toContain('svc-hygiene');
    expect(capture.lines.join('\n')).toMatch(/segments/);
  });

  it('the default logger (console) never sees the text either', async () => {
    const dir = makeTempDir();
    const store = makeStore(dir); // default createMainLogger('SpeechHistory')
    const printed = [];
    const spies = [
      vi.spyOn(console, 'log').mockImplementation((...args) => printed.push(args.join(' '))),
      vi.spyOn(console, 'warn').mockImplementation((...args) => printed.push(args.join(' '))),
      vi.spyOn(console, 'error').mockImplementation((...args) => printed.push(args.join(' '))),
      vi.spyOn(console, 'debug').mockImplementation((...args) => printed.push(args.join(' '))),
    ];

    await writeSession(store, {
      sessionId: 'svc-default-logger',
      startedAt: 1000,
      segments: [segment()],
    });

    for (const spy of spies) spy.mockRestore();
    expect(printed.length).toBeGreaterThan(0);
    expect(printed.join('\n')).not.toContain(SECRET_TEXT);
  });
});

// ---------------------------------------------------------------------------
// Search, export, erase
// ---------------------------------------------------------------------------

describe('search', () => {
  it('returns the matching session with an excerpt, and nothing for a miss', async () => {
    const dir = makeTempDir();
    const store = makeStore(dir);
    await writeSession(store, {
      sessionId: 'svc-alpha',
      startedAt: 1000,
      segments: [segment({ text: 'The Lord is my shepherd' })],
    });
    await writeSession(store, {
      sessionId: 'svc-beta',
      startedAt: 2000,
      modelId: 'base.en-q8_0',
      providerId: 'cloud-openai',
      where: 'cloud',
      segments: [segment({ text: 'Deep grace flows onward', providerId: 'cloud-openai' })],
    });

    const hit = await store.searchHistory('shepherd');
    expect(hit.ok).toBe(true);
    expect(hit.matches).toHaveLength(1);
    expect(hit.matches[0].sessionId).toBe('svc-alpha');
    expect(hit.matches[0].segments[0].excerpt).toContain('shepherd');
    // The excerpt carries attribution so the UI can show context.
    expect(hit.matches[0].segments[0].providerId).toBe('whispercpp');

    const metaHit = await store.searchHistory('base.en-q8_0');
    expect(metaHit.matches.map((m) => m.sessionId)).toEqual(['svc-beta']);

    expect((await store.searchHistory('nothing-matches-this')).matches).toEqual([]);
    expect((await store.searchHistory('')).matches).toEqual([]);
    expect(await store.searchHistory(42)).toMatchObject({
      ok: false,
      code: 'invalid-argument',
      field: 'query',
    });
  });
});

describe('export', () => {
  it('writes a JSON file containing the sessions and their attribution', async () => {
    const dir = makeTempDir();
    const store = makeStore(dir);
    await writeSession(store, {
      sessionId: 'svc-export',
      startedAt: 1000,
      segments: [segment({ providerId: 'cloud-openai' })],
    });

    const result = await store.exportHistory({ format: 'json' });
    expect(result.ok).toBe(true);
    expect(result.path.endsWith('.json')).toBe(true);
    expect(result.path.startsWith(path.join(dir, 'exports'))).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);

    const written = JSON.parse(fs.readFileSync(result.path, 'utf8'));
    expect(written.sessions).toHaveLength(1);
    expect(written.sessions[0].sessionId).toBe('svc-export');
    expect(written.sessions[0].segments[0].text).toBe(SECRET_TEXT);
    expect(written.sessions[0].segments[0].providerId).toBe('cloud-openai');
    expect(written.sessions[0].werEstimate).toBeNull();
  });

  it('writes a plain-text file with clock, provider, and transcript lines', async () => {
    const dir = makeTempDir();
    const store = makeStore(dir);
    await writeSession(store, {
      sessionId: 'svc-text',
      startedAt: 1000,
      segments: [segment()],
    });

    const result = await store.exportHistory({ format: 'text' });
    expect(result.ok).toBe(true);
    expect(result.path.endsWith('.txt')).toBe(true);
    const written = fs.readFileSync(result.path, 'utf8');
    expect(written).toContain('Sermon Assist transcript export');
    expect(written).toContain('Session: svc-text');
    expect(written).toContain('(whispercpp) ');
    expect(written).toContain(SECRET_TEXT);
  });

  it('exports one session when sessionId is given, and rejects a bad format', async () => {
    const dir = makeTempDir();
    const store = makeStore(dir);
    await writeSession(store, { sessionId: 'one', startedAt: 1000, segments: [] });
    await writeSession(store, { sessionId: 'two', startedAt: 2000, segments: [] });

    const single = await store.exportHistory({ format: 'json', sessionId: 'one' });
    expect(single.ok).toBe(true);
    expect(single.sessionCount).toBe(1);
    const written = JSON.parse(fs.readFileSync(single.path, 'utf8'));
    expect(written.sessions.map((s) => s.sessionId)).toEqual(['one']);
    expect(single.path).toContain('one');

    expect(await store.exportHistory({ format: 'csv' })).toMatchObject({
      ok: false,
      code: 'invalid-argument',
      field: 'format',
    });
    expect(await store.exportHistory({ sessionId: 'missing' })).toMatchObject({
      ok: false,
      code: 'session-not-found',
    });
  });
});

describe('erase', () => {
  it('removes every session and export and reports bytes reclaimed > 0', async () => {
    const dir = makeTempDir();
    const store = makeStore(dir);
    await writeSession(store, {
      sessionId: 'e1',
      startedAt: 1000,
      segments: [segment()],
    });
    await writeSession(store, { sessionId: 'e2', startedAt: 2000, segments: [] });
    const exported = await store.exportHistory({ format: 'json' });
    expect(exported.ok).toBe(true);

    const result = await store.eraseAll();
    expect(result).toMatchObject({
      ok: true,
      sessionsRemoved: 2,
      exportsRemoved: 1,
    });
    expect(result.bytesReclaimed).toBeGreaterThan(0);

    expect(await store.listSessions()).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
    expect((await store.getStatus()).storedBytes).toBe(0);
    expect(await store.getSession('e1')).toMatchObject({ ok: false, code: 'session-not-found' });
  });

  it('erasing an empty history is a safe no-op', async () => {
    const dir = makeTempDir();
    const store = makeStore(dir);
    expect(await store.eraseAll()).toMatchObject({
      ok: true,
      bytesReclaimed: 0,
      sessionsRemoved: 0,
      exportsRemoved: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// IPC: the six channels, electron mocked
// ---------------------------------------------------------------------------

describe('speech:history:* IPC (electron mocked)', () => {
  const invoke = (channel, payload) => {
    const handler = electron.handlers.get(channel);
    if (!handler) throw new Error(`no handler registered for ${channel}`);
    return handler(null, payload);
  };

  it('registers the six history channels and their list reply carries no text', async () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
    const { registerSpeechIpc } = await import('../../main/speechIpc.js');
    registerSpeechIpc({
      getMainWindow: () => null,
      engineRoots: [],
      endpoint: null,
      engineToken: null,
      modelsDir: path.join(dir, 'models'),
      historyDir: path.join(dir, 'history'),
    });

    for (const channel of [
      'speech:history:list',
      'speech:history:get',
      'speech:history:search',
      'speech:history:export',
      'speech:history:erase',
      'speech:history:append',
    ]) {
      expect(electron.handlers.has(channel), `${channel} must be registered`).toBe(true);
    }

    // Write a session through the write-path channel.
    const begun = await invoke('speech:history:append', {
      op: 'begin',
      session: { sessionId: 'ipc-1', startedAt: 1000, modelId: 'large-v3', providerId: 'whispercpp', where: 'local' },
    });
    expect(begun).toMatchObject({ ok: true });

    const appended = await invoke('speech:history:append', {
      op: 'segment',
      sessionId: 'ipc-1',
      segment: segment(),
    });
    expect(appended).toMatchObject({ ok: true, stored: true });

    // The list reply is summaries ONLY — no segment text leaks into it.
    const list = await invoke('speech:history:list');
    expect(list.ok).toBe(true);
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0]).toMatchObject({ sessionId: 'ipc-1', segmentCount: 1 });
    expect(JSON.stringify(list)).not.toContain(SECRET_TEXT);

    // get is the reply that carries text (it was asked for).
    const one = await invoke('speech:history:get', { sessionId: 'ipc-1' });
    expect(one.ok).toBe(true);
    expect(one.session.segments[0].text).toBe(SECRET_TEXT);

    // Search + export + erase round-trip through IPC.
    const found = await invoke('speech:history:search', { query: 'peacemakers' });
    expect(found.ok).toBe(true);
    expect(found.matches).toHaveLength(1);

    const exported = await invoke('speech:history:export', { format: 'text' });
    expect(exported.ok).toBe(true);
    expect(fs.existsSync(exported.path)).toBe(true);

    const erased = await invoke('speech:history:erase');
    expect(erased.ok).toBe(true);
    expect(erased.bytesReclaimed).toBeGreaterThan(0);

    // Argument guards.
    expect(await invoke('speech:history:get', {})).toMatchObject({ code: 'invalid-argument' });
    expect(await invoke('speech:history:search', { query: 7 })).toMatchObject({
      code: 'invalid-argument',
    });
    expect(await invoke('speech:history:export', { format: 'xml' })).toMatchObject({
      code: 'invalid-argument',
      field: 'format',
    });
    expect(await invoke('speech:history:append', { op: 'delete-everything' })).toMatchObject({
      code: 'invalid-argument',
      field: 'op',
    });
  });
});
