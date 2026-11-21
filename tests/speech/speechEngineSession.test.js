/**
 * tests/speech/speechEngineSession.test.js — Live Sermon Assist, Decision
 * D9 / Phase 4: the SUPERVISOR side of transcript history.
 *
 * tests/speech/speechHistory.test.js pins the store; this file pins the
 * wiring — the moments main/speechEngine.js actually calls beginSession,
 * appendSegment, and endSession. In the plan's own terms:
 *
 *   A. session lifecycle — a healthy start opens ONE session carrying the
 *      boundary fields (startedAt/date, durationMs, modelId, providerId,
 *      where) with `werEstimate` present and null; a clean stop closes it
 *      with endedAt + durationMs; engine exit / crash-loop close it too.
 *   B. every relayed FINAL segment is appended with a per-segment
 *      providerId; partials still reach the renderer but never the disk
 *      (finals only — the same choice main/speechHistory.js documents).
 *   C. a mid-session provider switch moves attribution for SUBSEQUENT
 *      segments only — still ONE session; the boundary readers see is the
 *      per-segment provider sequence, and a segment's own providerId tag
 *      always wins over the context.
 *   D. fail-soft — a throwing history store never breaks transcription, is
 *      reported ONCE with an error code (never transcript text), and the
 *      speech.enabled === false default opens nothing and writes no file.
 *   E. log hygiene — captured logger output across open/append/close
 *      carries ids, counts, durations, reasons — NEVER the transcript text.
 *   F. keep testable — everything is driven through the exported
 *      createHistorySessionRecorder() factory, the exported
 *      relayEngineMessage()/settleHistoryRecording() seams, and injected
 *      stores (`historyDir` / `historyStore` options); speechEngine.js
 *      still imports nothing from `electron`.
 *
 * Style note: this is a NEW file rather than an extension of
 * speechEngine.test.js — that file is deliberately fork- and socket-free
 * (it only drives paths that return before anything spawns), while these
 * tests exercise real lifecycle paths against a loopback health endpoint.
 *
 * Zero new npm dependencies: node:fs / node:http / node:events only.
 * Every server here binds 127.0.0.1 with an ephemeral port; nothing
 * binds a wildcard or LAN address.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { SPEECH_PROTOCOL_VERSION, TOKEN_HEADER } from '../../shared/speech/protocol.js';
import { createSpeechHistoryStore } from '../../main/speechHistory.js';
import {
  createHistorySessionRecorder,
  startSpeechEngine,
  stopSpeechEngine,
  relayEngineMessage,
  settleHistoryRecording,
} from '../../main/speechEngine.js';

/**
 * Fork is mocked so the exit/crash-loop test can drive the supervisor's REAL
 * child.on('exit') wiring (session close, respawn, crash-loop trip) without a
 * real process ever existing. Nothing else in this module graph spawns.
 *
 * BOTH halves are overridden because vitest's builtin interop resolves this
 * module's named `fork` import through `default` (a factory without a
 * `default` export fails outright, and one whose default still carries the
 * real `fork` silently hands speechEngine the real fork).
 */
const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fork: forkMock,
    default: { ...(actual.default ?? actual), fork: forkMock },
  };
});

const REPO_ROOT = fileURLToPath(new NodeURL('../../', import.meta.url)).replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const tempPaths = [];
const servers = [];
const consoleSpies = [];
const printed = [];

/** A history directory path that does NOT exist yet — proof of "no file". */
const makeTempPath = () => {
  const dir = path.join(os.tmpdir(), `speech-engine-session-${process.pid}-${tempPaths.length}`);
  tempPaths.push(dir);
  return dir;
};

const makeStore = (dir) => createSpeechHistoryStore({ historyDir: dir });

const sessionFiles = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
    : [];

/** A capturing logger — every line, so the hygiene assertions see it all. */
const createCapturingLogger = () => {
  const lines = [];
  const push = (level) => (...args) => lines.push(`[${level}] ${args.join(' ')}`);
  return {
    lines,
    log: { debug: push('DEBUG'), info: push('INFO'), warn: push('WARN'), error: push('ERROR') },
  };
};

const spyConsole = () => {
  printed.length = 0;
  for (const level of ['log', 'warn', 'error', 'debug']) {
    consoleSpies.push(
      vi.spyOn(console, level).mockImplementation((...args) => printed.push(args.join(' ')))
    );
  }
  return printed;
};

const restoreConsole = () => {
  while (consoleSpies.length) consoleSpies.pop().mockRestore();
};

const SECRET_TEXT = 'Blessed are the peacemakers, ZZX-SECRET-TRANSCRIPT-ZZX';

const finalMessage = (overrides = {}) => ({
  t: 'final',
  sessionId: 'eng-session-1',
  text: SECRET_TEXT,
  tStartMs: 1000,
  tEndMs: 2500,
  confidence: 0.9,
  ...overrides,
});

const partialMessage = (overrides = {}) => ({
  t: 'partial',
  sessionId: 'eng-session-1',
  text: `provisional ${SECRET_TEXT}`,
  tStartMs: 500,
  tEndMs: 900,
  confidence: 0.4,
  ...overrides,
});

/** A loopback health endpoint — what a healthy engine would answer. */
const startLoopbackHealthServer = async ({ model = 'fake-canned' } = {}) => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        apiVersion: SPEECH_PROTOCOL_VERSION,
        model,
        backend: 'fake',
        rtf: 0.08,
        memoryMb: 64,
        uptime: 1.5,
      })
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  return { server, port, endpoint: `http://127.0.0.1:${port}` };
};

/** A fake ChildProcess: enough surface for the supervisor's fork wiring. */
const makeFakeChild = () => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  return child;
};

afterEach(async () => {
  restoreConsole();
  // Flush queued history writes, then close the session (teardown), then
  // flush the close itself — every test leaves no session open.
  await settleHistoryRecording();
  stopSpeechEngine({ reason: 'test-teardown' });
  await settleHistoryRecording();
  while (servers.length) {
    const server = servers.pop();
    const closed = new Promise((resolve) => server.close(resolve));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await closed;
  }
  while (tempPaths.length) {
    await fsp.rm(tempPaths.pop(), { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

// ===========================================================================
// The recorder factory — the ONE place speechEngine talks to speechHistory.
// ===========================================================================

describe('createHistorySessionRecorder (the supervisor write path)', () => {
  it('A: opens ONE session with every boundary field and werEstimate present and null', async () => {
    const dir = makeTempPath();
    const store = makeStore(dir);
    const capture = createCapturingLogger();
    const recorder = createHistorySessionRecorder({
      store,
      log: capture.log,
      now: () => 1_700_000_000_000,
    });
    recorder.setContext({ modelId: 'large-v3', providerId: 'whispercpp', where: 'local' });

    const opened = await recorder.open();
    expect(opened.ok).toBe(true);
    expect(recorder.isOpen).toBe(true);
    expect(recorder.sessionId).toBeTruthy();
    // Opening while open is a no-op — never two sessions at once.
    expect(await recorder.open()).toMatchObject({ ok: true, alreadyOpen: true });

    const summaries = await store.listSessions();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      startedAt: 1_700_000_000_000,
      endedAt: null,
      durationMs: null,
      modelId: 'large-v3',
      providerId: 'whispercpp',
      where: 'local',
      segmentCount: 0,
    });
    // Designed in from day one: the WER field exists and stays null until
    // Phase 3 computes a real one — never a fabricated number.
    expect(summaries[0]).toHaveProperty('werEstimate', null);
    // The write-through is on disk before the first word (crash keeps the
    // boundary metadata).
    expect(sessionFiles(dir)).toHaveLength(1);
  });

  it('B: appends finals in order with per-segment providerId; partials never hit the disk', async () => {
    const dir = makeTempPath();
    const store = makeStore(dir);
    const capture = createCapturingLogger();
    const recorder = createHistorySessionRecorder({ store, log: capture.log });
    recorder.setContext({ modelId: 'large-v3', providerId: 'whispercpp', where: 'local' });
    await recorder.open();

    const first = await recorder.recordSegment(finalMessage({ text: 'first settled words' }));
    expect(first).toMatchObject({ ok: true, stored: true });
    const partialReply = await recorder.recordSegment(partialMessage());
    expect(partialReply).toMatchObject({ ok: false, stored: false });
    expect(partialReply.reason).toBe('partials-are-not-persisted');
    const second = await recorder.recordSegment(
      finalMessage({ text: 'second settled words', providerId: 'cloud-openai' })
    );
    expect(second).toMatchObject({ ok: true, stored: true });
    expect(recorder.segmentCount).toBe(2);

    const { session } = await store.getSession(recorder.sessionId);
    expect(session.segments.map((s) => s.text)).toEqual(['first settled words', 'second settled words']);
    expect(session.segments.map((s) => s.providerId)).toEqual(['whispercpp', 'cloud-openai']);
    expect(session.segments.every((s) => s.kind === 'final')).toBe(true);
    const stored = JSON.stringify(session);
    expect(stored).not.toContain('provisional');
    expect(stored).not.toContain(SECRET_TEXT); // this test's own texts only
  });

  it('C: a provider switch is a per-segment boundary — context moves, session does not', async () => {
    const dir = makeTempPath();
    const store = makeStore(dir);
    const recorder = createHistorySessionRecorder({ store, log: createCapturingLogger().log });
    recorder.setContext({ modelId: 'large-v3', providerId: 'whispercpp', where: 'local' });
    await recorder.open();
    const sessionId = recorder.sessionId;

    await recorder.recordSegment(finalMessage({ text: 'local words' }));
    // The user trialled cloud mid-run: the recorder only moves attribution.
    recorder.setContext({ providerId: 'cloud-openai', where: 'cloud' });
    await recorder.recordSegment(finalMessage({ text: 'cloud words' }));
    // A segment that carries its own tag wins over the context.
    await recorder.recordSegment(finalMessage({ text: 'tagged words', providerId: 'whispercpp' }));
    await recorder.close('teardown:user');

    expect(recorder.sessionId).toBeNull();
    const summaries = await store.listSessions();
    expect(summaries).toHaveLength(1); // STILL ONE session — never re-keyed
    expect(summaries[0].sessionId).toBe(sessionId);
    // Top-level boundary = the context AT OPEN; the reader-facing boundary
    // is the per-segment sequence.
    expect(summaries[0]).toMatchObject({ providerId: 'whispercpp', where: 'local' });
    expect(summaries[0].providers).toEqual(['whispercpp', 'cloud-openai']);
    const { session } = await store.getSession(sessionId);
    expect(session.segments.map((s) => s.providerId)).toEqual([
      'whispercpp',
      'cloud-openai',
      'whispercpp',
    ]);
  });

  it('D: close stamps endedAt/durationMs, is idempotent, and drops segments queued after it', async () => {
    const dir = makeTempPath();
    const store = makeStore(dir);
    let now = 1_700_000_000_000;
    const recorder = createHistorySessionRecorder({
      store,
      log: createCapturingLogger().log,
      now: () => now,
    });
    recorder.setContext({ modelId: 'large-v3', providerId: 'whispercpp', where: 'local' });
    await recorder.open();
    await recorder.recordSegment(finalMessage({ text: 'spoken words' }));

    now += 4500;
    const closed = await recorder.close('teardown:user');
    expect(closed).toMatchObject({ ok: true, closed: true });
    expect(recorder.isOpen).toBe(false);
    // Second close (engine exit after a teardown) is a harmless no-op.
    expect(await recorder.close('engine-exited')).toMatchObject({ ok: true, closed: false });

    expect(await recorder.recordSegment(finalMessage({ text: 'late words' }))).toMatchObject({
      ok: false,
      stored: false,
      reason: 'no-open-session',
    });

    const [summary] = await store.listSessions();
    expect(summary).toMatchObject({
      endedAt: 1_700_000_000_000 + 4500,
      durationMs: 4500,
      segmentCount: 1,
    });
    const { session } = await store.getSession(summary.sessionId);
    expect(session.segments.map((s) => s.text)).toEqual(['spoken words']);
    expect(JSON.stringify(session)).not.toContain('late words');
  });

  it('D: an append issued before the close still lands (one serialized queue)', async () => {
    const dir = makeTempPath();
    const store = makeStore(dir);
    const recorder = createHistorySessionRecorder({
      store,
      log: createCapturingLogger().log,
      now: () => 1_700_000_000_000,
    });
    recorder.setContext({ providerId: 'whispercpp', where: 'local' });
    await recorder.open();

    const append = recorder.recordSegment(finalMessage({ text: 'queued words' }));
    const close = recorder.close('stopped');
    const [appendResult, closeResult] = await Promise.all([append, close]);

    expect(appendResult).toMatchObject({ ok: true, stored: true });
    expect(closeResult).toMatchObject({ ok: true, closed: true });
    const [summary] = await store.listSessions();
    expect(summary.segmentCount).toBe(1);
    expect(summary.endedAt).not.toBeNull();
  });

  it('D: a throwing store never throws at the caller and is reported ONCE, code only', async () => {
    const boom = () => {
      throw new Error(`history exploded: ${SECRET_TEXT}`);
    };
    const throwingStore = { beginSession: boom, appendSegment: boom, endSession: boom };
    const capture = createCapturingLogger();
    const failures = [];
    const recorder = createHistorySessionRecorder({
      store: throwingStore,
      log: capture.log,
      onError: (error) => failures.push(error),
    });

    await expect(recorder.open()).resolves.toMatchObject({ ok: false });
    expect(recorder.isOpen).toBe(false);
    await expect(recorder.recordSegment(finalMessage())).resolves.toMatchObject({ ok: false });
    await expect(recorder.close('engine-exited')).resolves.toMatchObject({ ok: true, closed: false });

    // Reported exactly once — the first failure only, never a spam loop.
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: 'history-recording-failed', fatal: false, op: 'open' });
    const everything = [...capture.lines, ...failures.map((f) => `${f.code} ${f.message}`)].join('\n');
    expect(everything).not.toContain(SECRET_TEXT);
    expect(everything).not.toContain('history exploded');
    expect(capture.lines.join('\n')).toMatch(/failed \(/);
  });

  it('D: later failures stay silent, and the close still lands (fail-soft lifecycle)', async () => {
    const flaky = {
      beginSession: async () => ({ ok: true, session: { sessionId: 'flaky-1' } }),
      appendSegment: async () => {
        throw new Error('ENOSPC: disk full');
      },
      endSession: async () => ({ ok: true, session: {} }),
    };
    const capture = createCapturingLogger();
    const failures = [];
    const recorder = createHistorySessionRecorder({
      store: flaky,
      log: capture.log,
      onError: (error) => failures.push(error),
    });

    await recorder.open();
    await expect(recorder.recordSegment(finalMessage({ text: 'one' }))).resolves.toMatchObject({ ok: false });
    await expect(recorder.recordSegment(finalMessage({ text: 'two' }))).resolves.toMatchObject({ ok: false });
    await expect(recorder.close('teardown:user')).resolves.toMatchObject({ ok: true, closed: true });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ op: 'append', code: 'history-recording-failed' });
    const joined = capture.lines.join('\n');
    expect(joined.split('Transcript history append failed').length - 1).toBe(1); // logged once
    expect(joined).not.toContain('ENOSPC'); // the code, never the message
  });

  it('E: captured logger output across open/append/close never carries the transcript text', async () => {
    const dir = makeTempPath();
    const store = makeStore(dir);
    const capture = createCapturingLogger();
    let now = 1_700_000_000_000;
    const recorder = createHistorySessionRecorder({
      store,
      log: capture.log,
      now: () => now,
    });
    recorder.setContext({ modelId: 'large-v3', providerId: 'whispercpp', where: 'local' });

    await recorder.open();
    await recorder.recordSegment(finalMessage());
    await recorder.recordSegment(partialMessage());
    now += 12_345;
    await recorder.close('teardown:user');

    // Something WAS logged — otherwise the assertions would be vacuous.
    expect(capture.lines.length).toBeGreaterThan(0);
    const joined = capture.lines.join('\n');
    expect(joined).toMatch(/Transcript history session opened \([0-9a-f-]{36}\)/);
    expect(joined).toMatch(
      /Transcript history session closed \([0-9a-f-]{36}, 1 segments, 12345ms, teardown:user\)/
    );
    expect(joined).not.toContain(SECRET_TEXT);
    expect(joined).not.toContain('peacemakers');
    expect(joined).not.toContain('provisional');
  });
});

// ===========================================================================
// The supervisor lifecycle — endpoint mode against a loopback health server.
// ===========================================================================

describe('supervisor lifecycle: healthy start opens, relay appends, stop closes', () => {
  it('A: a healthy start opens the session with every boundary field; werEstimate null', async () => {
    const dir = makeTempPath();
    const { endpoint } = await startLoopbackHealthServer({ model: 'model-from-health' });
    const errors = [];

    const result = await startSpeechEngine({
      enabled: true,
      endpoint,
      historyDir: dir,
      providerId: 'whispercpp',
      where: 'local',
      onError: (error) => errors.push(error),
    });
    expect(result).toMatchObject({ ok: true, reason: 'healthy' });
    await settleHistoryRecording();

    const store = makeStore(dir);
    const summaries = await store.listSessions();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      // No modelId option was given — the boundary model comes from health.
      modelId: 'model-from-health',
      providerId: 'whispercpp',
      where: 'local',
      endedAt: null,
      durationMs: null,
      werEstimate: null,
    });
    expect(Number.isFinite(summaries[0].startedAt)).toBe(true);
    expect(errors).toEqual([]);
    expect(sessionFiles(dir)).toHaveLength(1);
  });

  it('B: finals append with per-segment providerId; partials reach the renderer, not the disk', async () => {
    const dir = makeTempPath();
    const { endpoint } = await startLoopbackHealthServer();
    const relayed = [];

    await startSpeechEngine({
      enabled: true,
      endpoint,
      historyDir: dir,
      modelId: 'large-v3',
      providerId: 'whispercpp',
      where: 'local',
      onEngineMessage: (message) => relayed.push(message),
    });

    expect(relayEngineMessage(finalMessage({ text: 'first settled words' }))).toEqual({
      ok: true,
      relayed: true,
    });
    expect(relayEngineMessage(partialMessage())).toEqual({ ok: true, relayed: true });
    // Schema-invalid messages are dropped: type logged, payload never stored.
    expect(relayEngineMessage({ t: 'final', text: 'missing required fields' })).toMatchObject({
      ok: false,
      reason: 'invalid-message',
    });
    expect(relayEngineMessage(null)).toMatchObject({ ok: false, reason: 'not-an-engine-message' });
    await settleHistoryRecording();

    const store = makeStore(dir);
    const [summary] = await store.listSessions();
    expect(summary.segmentCount).toBe(1); // partial + invalid never persisted
    const { session } = await store.getSession(summary.sessionId);
    expect(session.segments[0]).toMatchObject({
      text: 'first settled words',
      providerId: 'whispercpp',
      kind: 'final',
    });
    // The renderer still saw BOTH live messages — history filtering only
    // touches the write path, never the relay.
    expect(relayed.map((m) => m.t)).toEqual(['final', 'partial']);
  });

  it('C: a mid-session provider switch keeps ONE session and moves the boundary', async () => {
    const dir = makeTempPath();
    const { endpoint } = await startLoopbackHealthServer();

    await startSpeechEngine({
      enabled: true,
      endpoint,
      historyDir: dir,
      modelId: 'large-v3',
      providerId: 'whispercpp',
      where: 'local',
    });
    relayEngineMessage(finalMessage({ text: 'local words' }));

    // The user switches to cloud while the engine keeps running. Endpoint
    // mode has no child process, so the supervisor re-runs its startup
    // handshake — but the OPEN session must not be re-keyed by it.
    const again = await startSpeechEngine({
      enabled: true,
      endpoint,
      historyDir: dir,
      modelId: 'large-v3',
      providerId: 'cloud-openai',
      where: 'cloud',
    });
    expect(again).toMatchObject({ ok: true, reason: 'healthy' });

    relayEngineMessage(finalMessage({ text: 'cloud words' }));
    relayEngineMessage(finalMessage({ text: 'tagged words', providerId: 'whispercpp' }));
    await settleHistoryRecording();

    const store = makeStore(dir);
    const summaries = await store.listSessions();
    expect(summaries).toHaveLength(1); // still ONE session — attribution only
    expect(summaries[0].providers).toEqual(['whispercpp', 'cloud-openai']);
    // Top-level fields are the context captured AT OPEN, not re-keyed.
    expect(summaries[0]).toMatchObject({ providerId: 'whispercpp', where: 'local', modelId: 'large-v3' });
    const { session } = await store.getSession(summaries[0].sessionId);
    expect(session.segments.map((s) => s.text)).toEqual([
      'local words',
      'cloud words',
      'tagged words',
    ]);
    expect(session.segments.map((s) => s.providerId)).toEqual([
      'whispercpp',
      'cloud-openai',
      'whispercpp',
    ]);
  });

  it('D: a clean stop closes the session with endedAt/durationMs — and later segments are dropped', async () => {
    const dir = makeTempPath();
    const { endpoint } = await startLoopbackHealthServer();
    await startSpeechEngine({
      enabled: true,
      endpoint,
      historyDir: dir,
      modelId: 'large-v3',
      providerId: 'whispercpp',
      where: 'local',
    });
    relayEngineMessage(finalMessage({ text: 'spoken words' }));
    await settleHistoryRecording();

    expect(stopSpeechEngine({ reason: 'test-stop' }).stopped).toBe(false); // endpoint mode: no child
    await settleHistoryRecording();

    // No session -> no file growth: a late segment is simply unrecorded.
    relayEngineMessage(finalMessage({ text: 'late words' }));
    await settleHistoryRecording();

    const store = makeStore(dir);
    const summaries = await store.listSessions();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].endedAt).toBeGreaterThanOrEqual(summaries[0].startedAt);
    expect(summaries[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(summaries[0].segmentCount).toBe(1);
    expect(sessionFiles(dir)).toHaveLength(1);
    const { session } = await store.getSession(summaries[0].sessionId);
    expect(session.segments.map((s) => s.text)).toEqual(['spoken words']);
    expect(JSON.stringify(session)).not.toContain('late words');
  });

  it('D: the disabled default opens nothing and writes no file — even when a segment relays', async () => {
    const dir = makeTempPath();
    const result = await startSpeechEngine({
      enabled: false,
      historyDir: dir,
      providerId: 'whispercpp',
      where: 'local',
    });
    expect(result).toMatchObject({ ok: false, reason: 'disabled' });
    expect(relayEngineMessage(finalMessage())).toMatchObject({ ok: true, relayed: true });
    await settleHistoryRecording();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('D: a healthy start with NO history option records nothing (no option -> no session, no file)', async () => {
    const { endpoint } = await startLoopbackHealthServer();
    const result = await startSpeechEngine({ enabled: true, endpoint });
    expect(result).toMatchObject({ ok: true, reason: 'healthy' });
    // configureHistory() with no historyStore/historyDir dropped the write
    // path, so there is no recorder to open — settle resolves null.
    expect(await settleHistoryRecording()).toBeNull();
    expect(relayEngineMessage(finalMessage())).toMatchObject({ ok: true, relayed: true });
    expect(await settleHistoryRecording()).toBeNull();
  });

  it('D: a benchmark-only restart with historyless:true opens no sermon session', async () => {
    // Auto-selection starts/stops the engine once per installed model. Those
    // restarts are measurements, not services; they must not leave empty
    // transcript-history sessions behind.
    const dir = makeTempPath();
    const { endpoint } = await startLoopbackHealthServer({ model: 'large-v3' });
    const result = await startSpeechEngine({
      enabled: true,
      endpoint,
      historyDir: dir,
      historyStore: makeStore(dir),
      modelId: 'large-v3',
      providerId: 'whispercpp',
      where: 'local',
      historyless: true,
    });
    expect(result).toMatchObject({ ok: true, reason: 'healthy' });
    expect(await settleHistoryRecording()).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('D: a throwing history store never breaks transcription and is reported once, code only', async () => {
    const { endpoint } = await startLoopbackHealthServer();
    const errors = [];
    const relayed = [];
    const throwingStore = {
      beginSession: async () => {
        throw new Error(`history disk exploded: ${SECRET_TEXT}`);
      },
      appendSegment: async () => {
        throw new Error(`history disk exploded: ${SECRET_TEXT}`);
      },
      endSession: async () => {
        throw new Error(`history disk exploded: ${SECRET_TEXT}`);
      },
    };
    const captured = spyConsole();

    const result = await startSpeechEngine({
      enabled: true,
      endpoint,
      historyStore: throwingStore,
      providerId: 'whispercpp',
      where: 'local',
      onError: (error) => errors.push(error),
      onEngineMessage: (message) => relayed.push(message),
    });
    // The start itself is unaffected: history failing is never fatal.
    expect(result).toMatchObject({ ok: true, reason: 'healthy' });

    expect(relayEngineMessage(finalMessage())).toMatchObject({ ok: true, relayed: true });
    stopSpeechEngine({ reason: 'test-stop' });
    await settleHistoryRecording();
    restoreConsole();

    // Transcription carried on: the segment still reached the renderer.
    expect(relayed).toHaveLength(1);
    // Reported ONCE — first failure only, fatal:false, code only.
    const historyErrors = errors.filter((e) => e.code === 'history-recording-failed');
    expect(historyErrors).toHaveLength(1);
    expect(historyErrors[0].fatal).toBe(false);

    const joined = captured.join('\n');
    const failureLines = joined.split('\n').filter((line) => line.includes('continues unaffected'));
    expect(failureLines).toHaveLength(1);
    expect(joined).not.toContain(SECRET_TEXT);
    expect(joined).not.toContain('history disk exploded');
    expect(errors.map((e) => e.message).join('\n')).not.toContain(SECRET_TEXT);
  });

  it('E: logger output across open/append/close carries ids and counts, never the transcript', async () => {
    const dir = makeTempPath();
    const { endpoint } = await startLoopbackHealthServer();
    const captured = spyConsole();

    await startSpeechEngine({
      enabled: true,
      endpoint,
      historyDir: dir,
      modelId: 'large-v3',
      providerId: 'whispercpp',
      where: 'local',
    });
    relayEngineMessage(finalMessage());
    relayEngineMessage(partialMessage());
    await settleHistoryRecording();
    stopSpeechEngine({ reason: 'test-stop' });
    await settleHistoryRecording();
    restoreConsole();

    // Something WAS logged — otherwise the assertions would be vacuous.
    expect(captured.length).toBeGreaterThan(0);
    const joined = captured.join('\n');
    expect(joined).toMatch(/Transcript history session opened \([0-9a-f-]{36}\)/);
    expect(joined).toMatch(/Transcript history session closed \([0-9a-f-]{36}, 1 segments, \d+ms,/);
    expect(joined).not.toContain(SECRET_TEXT);
    expect(joined).not.toContain('peacemakers');
    expect(joined).not.toContain('provisional');
  });
});

// ===========================================================================
// Engine exit and the crash loop — fork mocked, health from loopback.
// ===========================================================================

describe('engine exit / crash loop close the history session (fork mocked)', () => {
  it('A: engine exit closes the session; the crash loop then trips once — no endless respawn', async () => {
    const dir = makeTempPath();
    const engineRoot = makeTempPath();
    fs.mkdirSync(engineRoot, { recursive: true });
    fs.writeFileSync(path.join(engineRoot, 'index.js'), '// never executed: fork() is mocked\n');
    const { port } = await startLoopbackHealthServer();
    const errors = [];
    const children = [];
    forkMock.mockReset();
    forkMock.mockImplementation(() => {
      const child = makeFakeChild();
      children.push(child);
      return child;
    });

    const result = await startSpeechEngine({
      enabled: true,
      engineRoots: [engineRoot],
      port,
      historyDir: dir,
      modelId: 'large-v3',
      providerId: 'whispercpp',
      where: 'local',
      onError: (error) => errors.push(error),
    });
    expect(result).toMatchObject({ ok: true, reason: 'healthy' });
    expect(forkMock).toHaveBeenCalledTimes(1);

    // The engine's IPC message flows through the supervisor's real relay.
    children[0].emit('message', finalMessage({ text: 'words before the crash' }));
    children[0].emit('message', partialMessage());
    await settleHistoryRecording();

    // Crash 1: the session ends WITH the engine.
    children[0].exitCode = 1;
    children[0].emit('exit', 1, null);
    await settleHistoryRecording();

    let store = makeStore(dir);
    let [summary] = await store.listSessions();
    expect(summary.segmentCount).toBe(1);
    expect(summary.endedAt).not.toBeNull();
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);

    // Crash 2 (after the single bounded respawn) ...
    await vi.waitFor(() => expect(forkMock).toHaveBeenCalledTimes(2), { timeout: 3000 });
    children[1].exitCode = 1;
    children[1].emit('exit', 1, null);

    // ... and crash 3 trips the guard: ONE clear error, no 4th respawn.
    await vi.waitFor(() => expect(forkMock).toHaveBeenCalledTimes(3), { timeout: 3000 });
    children[2].exitCode = 1;
    children[2].emit('exit', 1, null);

    await vi.waitFor(
      () => expect(errors.some((error) => error.code === 'engine-crash-loop')).toBe(true),
      { timeout: 3000 }
    );
    await new Promise((resolve) => setTimeout(resolve, 700)); // > RESPAWN_DELAY_MS
    expect(forkMock).toHaveBeenCalledTimes(3);
    await settleHistoryRecording();

    store = makeStore(dir);
    const summaries = await store.listSessions();
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    // Whichever sessions were opened (a post-respawn health poll may have
    // reopened one), EVERY one of them is closed — nobody left the door open.
    expect(summaries.every((s) => s.endedAt !== null)).toBe(true);
    expect(summaries.every((s) => Number.isFinite(s.durationMs))).toBe(true);
    // History itself never failed on this run.
    expect(errors.filter((e) => e.code === 'history-recording-failed')).toHaveLength(0);
    expect(sessionFiles(dir)).toHaveLength(summaries.length);
  }, 15000);
});

// ===========================================================================
// Keep testable — the pure-core rule stays intact.
// ===========================================================================

describe('keep testable (pure-core rule)', () => {
  it('F: speechEngine.js still imports nothing from electron', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'main', 'speechEngine.js'), 'utf8');
    expect(source).not.toMatch(/from ['"]electron['"]/);
    expect(source).not.toMatch(/require\(\s*['"]electron['"]\s*\)/);
    expect(source).not.toMatch(/import\(\s*['"]electron['"]\s*\)/);
    // The history write path is injectable, not baked in.
    expect(source).toMatch(/createSpeechHistoryStore/);
    expect(source).toMatch(/historyDir/);
  });
});
