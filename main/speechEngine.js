/**
 * main/speechEngine.js — Live Sermon Assist, Phase 2: the engine sidecar
 * supervisor. Modelled directly on main/backend.js (same logger, same
 * fork/health-poll/SIGTERM shape) with the speech plan's extra rules.
 *
 * INVARIANT 4 — OFF BY DEFAULT, COLD BY DEFAULT: importing this module has
 * NO side effects (no fork, no timer, no network). The only way anything
 * starts is an explicit startSpeechEngine() call whose options pass
 * shouldStartEngine() — `enabled !== true` means nothing happens, ever.
 *
 * INVARIANT 5 — AUDIO STAYS LOCAL: the only bind host ever accepted is a
 * loopback address (resolveBindHost throws otherwise), and the engine token
 * is generated per launch and passed by environment, never logged.
 *
 * PURE-CORE RULE (same as main/permissionPolicy.js): this module imports
 * NOTHING from `electron`, so its logic is unit-testable under vitest
 * without booting or mocking Electron. main.js / speechIpc.js supply
 * Electron-owned data (window, paths) as plain options.
 *
 * Security/hygiene: never log tokens, audio, sample values, or transcript
 * text. Engine messages are logged by TYPE only.
 *
 * TRANSCRIPT HISTORY (Decision D9 / Phase 4): this supervisor is the writer
 * of main/speechHistory.js. The mapping is one line per event —
 *   healthy start / post-respawn health .... beginSession (boundary fields)
 *   relayed `final` segment ............... appendSegment (per-segment providerId)
 *   teardown, stop, engine exit, crash-loop  endSession (endedAt/durationMs)
 * — all mediated by createHistorySessionRecorder() below, which is fail-soft
 * by construction: a history failure is reported ONCE (error code only,
 * never transcript text) and transcription continues untouched. Nothing is
 * configured or opened unless shouldStartEngine() passed first, so the
 * speech.enabled === false default opens no session and writes no file.
 */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import createMainLogger from './logger.js';
import { diagMain } from './diagnosticsLog.js';
import { createSpeechHistoryStore } from './speechHistory.js';
import { createGuardrail, resolveLimits } from './speechGuardrails.js';
import {
  TOKEN_HEADER,
  ENGINE_ROUTES,
  ENGINE_HTTP_METHODS,
  checkApiCompatibility,
  generateEngineToken,
  isLoopbackHost,
  validateMessage,
} from '../shared/speech/protocol.js';

const log = createMainLogger('SpeechEngine');

// ---------------------------------------------------------------------------
// Phase 3 — the benchmark harness, driven from the app side
// ---------------------------------------------------------------------------

/**
 * How long a benchmark may take before it is abandoned.
 *
 * Generous on purpose: loading a multi-GB model from a slow disk is genuinely
 * slow, and a benchmark that gives up early produces no measurement at all.
 * The timeout exists to stop the UI hanging forever, not to rush a cold start.
 */
export const BENCHMARK_TIMEOUT_MS = 15 * 60 * 1000;

/** How long a cancel request waits before giving up. It must not hang the UI. */
const BENCHMARK_CANCEL_TIMEOUT_MS = 5000;

/**
 * The endpoint a request can use right now, or null when nothing is running.
 *
 * Refuses to hand back a stale endpoint: after the engine stops, `phase` leaves
 * 'running', so a benchmark cannot be fired at a dead port and reported as an
 * engine failure when the real problem is that nothing is installed.
 */
export function engineEndpointForRequest() {
  if (phase !== 'running' || !runtime.endpoint) return null;
  return runtime.endpoint;
}

/**
 * The launch token of the CURRENT engine, or null.
 *
 * Kept at module scope (rather than threaded through every call) because a
 * benchmark has to reach an engine the caller never started, and because a
 * stale token against a restarted engine is exactly the "dead engine" case
 * the plan wants reported as such rather than as a mystery failure.
 */
let launchToken = null;

/**
 * Run one model against the reference clip on the engine.
 *
 * Forwards to the engine's own POST /v1/benchmark, which owns the measurement
 * and — importantly — owns the REFUSAL to fabricate one. The engine answers
 * `{ measured: false, reason }` rather than a plausible-looking row, and that
 * answer is passed back to the renderer untouched. No fallback number is
 * invented here: a default invented at this layer would defeat the entire
 * reason the engine reports absence instead of invention.
 *
 * @param {{modelId: string, clip?: object|null}} options
 * @returns {Promise<object>} the engine's result row, verbatim
 */
export async function runEngineBenchmark({ modelId, clip = null } = {}) {
  if (typeof modelId !== 'string' || modelId.length === 0) {
    return { measured: false, modelId: null, reason: 'No model was named, so nothing was measured.' };
  }

  const target = engineEndpointForRequest();
  if (!target) {
    return {
      measured: false,
      modelId,
      engineKind: null,
      reason:
        'No speech engine is running, so there is nothing to measure. Start the engine first, then run the benchmark.',
    };
  }

  const response = await fetch(`${target}${ENGINE_ROUTES.benchmark.path}`, {
    method: ENGINE_HTTP_METHODS.benchmark,
    headers: {
      'content-type': 'application/json',
      [TOKEN_HEADER]: launchToken ?? '',
    },
    // Electron's structured clone carries a Buffer/ArrayBuffer across IPC, so
    // the reference clip arrives intact without being re-encoded here.
    body: JSON.stringify({ modelId, clip: clip ?? null }),
    signal: AbortSignal.timeout(BENCHMARK_TIMEOUT_MS),
  });

  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error('engine rejected the launch token'), { code: 'engine-token-rejected' });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`benchmark HTTP ${response.status}`), { code: 'benchmark-http-error' });
  }
  return response.json();
}

/**
 * Stop a running benchmark.
 *
 * Plan 9.4 asks for "a cancel that actually stops the work rather than hiding
 * the result". Reports `stopped: false` when nothing was in flight, so the UI
 * can say so rather than implying it killed something.
 *
 * @param {string} modelId
 * @returns {Promise<{cancelled: boolean, stopped: boolean, modelId: string|null}>}
 */
export async function cancelEngineBenchmark(modelId) {
  const target = engineEndpointForRequest();
  if (!target) return { cancelled: true, stopped: false, modelId: modelId ?? null };

  try {
    const response = await fetch(`${target}/v1/benchmark/${encodeURIComponent(modelId)}/cancel`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: launchToken ?? '' },
      signal: AbortSignal.timeout(BENCHMARK_CANCEL_TIMEOUT_MS),
    });
    if (!response.ok) return { cancelled: true, stopped: false, modelId: modelId ?? null };
    const body = await response.json();
    return { cancelled: true, stopped: body?.cancelled === true, modelId };
  } catch {
    // Fail soft: a cancel that could not be delivered is not a crash.
    return { cancelled: true, stopped: false, modelId: modelId ?? null };
  }
}

// ---------------------------------------------------------------------------
// Named constants (unit-tested — see tests/speech/speechEngine.test.js)
// ---------------------------------------------------------------------------

/** Plan number: SIGTERM first, escalate to SIGKILL after this long. */
export const SPEECH_ENGINE_KILL_ESCALATION_MS = 2000;

/** Crash-loop guard: this many crashes... */
export const CRASH_LOOP_MAX_CRASHES = 3;
/** ...inside this window disables the feature (no endless respawning). */
export const CRASH_LOOP_WINDOW_MS = 60000;

/** The only bind host this supervisor will ever pass to the engine. */
export const DEFAULT_ENGINE_HOST = '127.0.0.1';
/** Default loopback port for a forked engine (override with LD_SPEECH_PORT). */
export const DEFAULT_ENGINE_PORT = 4731;

/** Health poll cadence once the engine is healthy (mirrors backend.js). */
export const HEALTH_POLL_INTERVAL_MS = 1000;
/** Give up if the engine does not answer within this window at startup. */
export const HEALTH_STARTUP_TIMEOUT_MS = 30000;
/** Consecutive failed health polls before the engine is declared lost. */
export const HEALTH_FAILURE_LIMIT = 5;
/** Delay between a crash and its single respawn (crash-loop bounded). */
export const RESPAWN_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// Pure decision helpers (the unit-testable core)
// ---------------------------------------------------------------------------

/** Strip scheme/port/brackets from a host-ish value; null when impossible. */
function normalizeHost(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      return new URL(raw).hostname;
    } catch {
      return null;
    }
  }
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end === -1 ? null : raw.slice(1, end);
  }
  const match = /^([^:]+)(?::\d+)?$/.exec(raw);
  return match ? match[1] : raw;
}

/**
 * Is `endpoint` (URL or host:port) a loopback destination?
 *
 * @param {unknown} endpoint
 * @returns {boolean}
 */
export function isLoopbackEndpoint(endpoint) {
  const host = normalizeHost(endpoint);
  return host ? isLoopbackHost(host) : false;
}

/**
 * The start/stop decision, with its reason — the single gate through which
 * the engine may ever come to life.
 *
 *   enabled !== true ............... { start: false, reason: 'disabled' }
 *   non-loopback endpoint .......... { start: false, reason: 'non-loopback-endpoint' }
 *   loopback endpoint configured ... { start: true,  reason: 'explicit-endpoint' }
 *   co-located engine package ...... { start: true,  reason: 'engine-available' }
 *   nothing installed (THE DEFAULT)  { start: false, reason: 'no-engine-installed' }
 *
 * @param {Object} state
 * @param {boolean} [state.enabled] the user's speech.enabled switch
 * @param {string|null} [state.endpoint] explicitly configured engine endpoint
 * @param {boolean} [state.engineAvailable] a co-located engine package exists
 * @returns {{ start: boolean, reason: string }}
 */
export function describeStartDecision({ enabled, endpoint, engineAvailable } = {}) {
  if (enabled !== true) return { start: false, reason: 'disabled' };

  if (typeof endpoint === 'string' && endpoint.trim()) {
    if (!isLoopbackEndpoint(endpoint)) return { start: false, reason: 'non-loopback-endpoint' };
    return { start: true, reason: 'explicit-endpoint' };
  }

  if (engineAvailable === true) return { start: true, reason: 'engine-available' };
  return { start: false, reason: 'no-engine-installed' };
}

/** Boolean form of describeStartDecision — the invariant-4 predicate. */
export function shouldStartEngine(state) {
  return describeStartDecision(state).start === true;
}

/**
 * Resolve the bind host: MUST be loopback, or it throws. This is the
 * invariant-5 chokepoint — no code path binds anything else.
 *
 * @param {string} [host=DEFAULT_ENGINE_HOST]
 * @returns {string} normalized hostname
 * @throws {Error} when the host is missing or non-loopback.
 */
export function resolveBindHost(host = DEFAULT_ENGINE_HOST) {
  const normalized = normalizeHost(host);
  if (!normalized || !isLoopbackHost(normalized)) {
    throw new Error(
      `refusing to bind non-loopback speech-engine host ${JSON.stringify(String(host ?? ''))} — ` +
        'the engine may only listen on loopback'
    );
  }
  return normalized;
}

/**
 * Discover which of the plan's three outcomes we are in:
 *   (a) endpoint — an explicitly configured engine URL wins outright,
 *   (b) package  — a co-located speech-engine package (repo checkout or a
 *                  Phase 3 install directory) with an index.js entry,
 *   (c) none     — nothing installed. THE DEFAULT, and the app works fine.
 *
 * @param {Object} [options]
 * @param {string|null} [options.configuredEndpoint]
 * @param {string[]} [options.engineRoots] candidate engine directories
 * @returns {{ mode: 'endpoint'|'package'|'none', endpoint: string|null,
 *             entry: string|null, root?: string, reason: string }}
 */
export function resolveEngineDiscovery({ configuredEndpoint = null, engineRoots = [] } = {}) {
  const endpoint =
    typeof configuredEndpoint === 'string' && configuredEndpoint.trim()
      ? configuredEndpoint.trim()
      : null;
  if (endpoint) {
    return { mode: 'endpoint', endpoint, entry: null, reason: 'explicit-endpoint' };
  }

  for (const root of engineRoots) {
    if (typeof root !== 'string' || !root) continue;
    const entry = path.join(root, 'index.js');
    try {
      if (fs.existsSync(entry) && fs.statSync(entry).isFile()) {
        return { mode: 'package', endpoint: null, entry, root, reason: 'co-located-package' };
      }
    } catch {
      // Unreadable candidate — treat like "not installed" and keep looking.
    }
  }

  return { mode: 'none', endpoint: null, entry: null, reason: 'no-engine-installed' };
}

/**
 * Check whether a usable whisper-cli binary is present at the target directory.
 * Pure core - uses node:fs and node:path only.
 */
export function hasWhisperBinary(dir) {
  if (typeof dir !== 'string' || !dir) return false;
  const binary = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const full = path.join(dir, binary);
  try {
    return fs.existsSync(full) && fs.statSync(full).size > 0;
  } catch {
    return false;
  }
}

/**
 * Crash-loop guard: N crashes inside a window trip it; outside the window
 * old crashes age out. `now` is injectable so tests run in microseconds.
 *
 * @param {Object} [options]
 * @param {number} [options.maxCrashes=CRASH_LOOP_MAX_CRASHES]
 * @param {number} [options.windowMs=CRASH_LOOP_WINDOW_MS]
 * @param {() => number} [options.now]
 * @returns {{ recordCrash: () => { crashes: number, tripped: boolean },
 *             reset: () => void, readonly crashes: number }}
 */
export function createCrashGuard({
  maxCrashes = CRASH_LOOP_MAX_CRASHES,
  windowMs = CRASH_LOOP_WINDOW_MS,
  now = Date.now,
} = {}) {
  const stamps = [];
  const prune = (at) => {
    while (stamps.length > 0 && at - stamps[0] > windowMs) stamps.shift();
  };

  return {
    recordCrash() {
      const at = now();
      stamps.push(at);
      prune(at);
      return { crashes: stamps.length, tripped: stamps.length >= maxCrashes };
    },
    reset() {
      stamps.length = 0;
    },
    get crashes() {
      const at = now();
      prune(at);
      return stamps.length;
    },
  };
}

/** Is this child process still alive (not exited, not signalled out)? */
export function isProcessAlive(procRef) {
  return Boolean(procRef) && procRef.exitCode === null && procRef.signalCode === null;
}

/**
 * Resolve once the child has exited, or after `timeoutMs` — whichever first.
 *
 * Used when a mode change replaces a running engine: the replacement forks on
 * the same loopback port, so it must not start until the old process has let
 * go of it. Bounded on purpose; a stuck child cannot hang the click.
 *
 * @param {import('node:child_process').ChildProcess|null} child
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function waitForEngineExit(child, timeoutMs = 3000) {
  if (!isProcessAlive(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    child.once('exit', done);
  });
}

/**
 * SIGTERM has been sent; schedule the SIGKILL escalation the plan pins at
 * SPEECH_ENGINE_KILL_ESCALATION_MS (2000 ms). Returns a cancel function.
 *
 * The scheduler is injectable so the test can assert the delay and the
 * escalation without waiting two real seconds.
 *
 * @param {object} procRef ChildProcess-like ({ exitCode, signalCode, kill })
 * @param {Object} [options]
 * @param {number} [options.escalationMs=SPEECH_ENGINE_KILL_ESCALATION_MS]
 * @param {(fn: Function, ms: number) => any} [options.schedule]
 * @param {(handle: any) => void} [options.cancel]
 * @returns {() => void} cancel the escalation
 */
export function scheduleKillEscalation(
  procRef,
  {
    escalationMs = SPEECH_ENGINE_KILL_ESCALATION_MS,
    schedule = setTimeout,
    cancel = clearTimeout,
  } = {}
) {
  const timer = schedule(() => {
    try {
      if (isProcessAlive(procRef)) procRef.kill('SIGKILL');
    } catch {
      // Process already gone — escalation is best-effort by design.
    }
  }, escalationMs);

  return () => cancel(timer);
}

/**
 * The health gate on the plan's terms: refuse a mismatched MAJOR apiVersion,
 * warn on a mismatched minor.
 *
 * @param {unknown} apiVersion engine-reported version
 * @returns {{ ok: boolean, level: string, reason?: string, shouldWarn: boolean }}
 */
export function evaluateEngineApiVersion(apiVersion) {
  const verdict = checkApiCompatibility(apiVersion);
  return { ...verdict, shouldWarn: verdict.ok && verdict.level === 'minor-mismatch' };
}

/**
 * Shape an engine health response into the payload the renderer store keeps
 * (`useSpeechStore` health): apiVersion, model, backend, rtf, memoryMb,
 * pid, uptime (seconds).
 *
 * `backend` falls back to 'unknown' when the engine does not say, and that is
 * load-bearing: 'unknown' is what makes the Phase 3 silent-CPU-fallback check
 * report "could not confirm acceleration" instead of "it used the CPU".
 * Defaulting it to 'cpu' would accuse every engine that forgets to answer.
 *
 * @param {unknown} raw GET /v1/health body
 * @param {Object} [context]
 * @param {number|null} [context.pid] supervisor-known pid fallback
 * @param {number|null} [context.startedAt] epoch ms of launch, for uptime
 * @param {number} [context.now]
 * @returns {object} health payload (never contains the token)
 */
export function buildHealthPayload(raw, { pid = null, startedAt = null, now = Date.now() } = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

  const uptimeSec =
    numberOrNull(source.uptime) ??
    (numberOrNull(source.uptimeMs) !== null ? source.uptimeMs / 1000 : null) ??
    (startedAt ? (now - startedAt) / 1000 : null) ??
    0;

  return {
    apiVersion: source.apiVersion ?? null,
    model: typeof source.model === 'string' ? source.model : null,
    backend: typeof source.backend === 'string' ? source.backend : 'unknown',
    rtf: numberOrNull(source.rtf),
    memoryMb: numberOrNull(source.memoryMb),
    pid: numberOrNull(source.pid) ?? numberOrNull(pid),
    uptime: Math.max(0, Math.round(uptimeSec * 1000) / 1000),
  };
}

// ---------------------------------------------------------------------------
// Transcript history (Decision D9) — the supervisor's write path
// ---------------------------------------------------------------------------

/**
 * Create the supervisor's transcript-history session recorder: the ONE place
 * main/speechEngine.js talks to main/speechHistory.js. The store is injected
 * (exactly the way main/speechIpc.js takes a `historyDir` option), so every
 * decision below is unit-testable without electron, without a fork, and
 * against a throwaway temp directory.
 *
 * SUPERVISOR EVENT -> HISTORY API:
 *   engine healthy (startSpeechEngine success, or the first healthy poll
 *   after a crash respawn) ... store.beginSession({ startedAt, modelId,
 *                                                  providerId, where })
 *   relayed `final` segment .. store.appendSegment(sessionId, segment) with
 *                              providerId captured PER SEGMENT at relay time
 *   teardown / stop / exit ... store.endSession(sessionId, { endedAt,
 *                              durationMs }) — closes are idempotent
 *
 * FINALS ONLY — following main/speechHistory.js, not diverging from it: a
 * provisional `partial` is acknowledged and NOT persisted, because the
 * engine may rewrite it a moment later and storing it would make the
 * history a record of what was almost said (its header documents the same
 * choice inside appendSegment). The live partial still reaches the renderer
 * over speech:transcript; history keeps the settled words. Filtering here
 * (instead of relying on appendSegment's drop) also spares one disk read per
 * provisional update during rapid partials.
 *
 * PROVIDER SWITCH — the cloud-trial boundary: attribution is a PER-SEGMENT
 * property, never a session boundary. setContext({ providerId, where,
 * modelId }) moves the attribution used by subsequent segments WITHOUT
 * ending or re-keying the session, and a segment that carries its own
 * providerId (a cloud engine tagging its output) always wins over the
 * context. The stored session keeps the context current at open() as its
 * top-level modelId/providerId/where; the boundary the user reads back is
 * the per-segment providerId sequence on the stored segments (with
 * summary.providers listing the first-seen unique providers) — e.g.
 * ['whispercpp', 'cloud-openai', 'whispercpp'].
 *
 * FAIL SOFT: every operation runs on one promise chain (so an append can
 * never interleave with the close that follows it), catches everything, and
 * resolves with an honest { ok:false, code } — history may never take down
 * transcription. The FIRST failure is reported once: one log line carrying
 * the error CODE only, plus one non-fatal onError callback; later failures
 * stay silent rather than spamming the log.
 *
 * HYGIENE (plan, non-negotiable): this recorder logs session ids, segment
 * counts, durations, and reasons ONLY — never `message.text`, never a record
 * or payload dump. tests/speech/speechEngineSession.test.js captures logger
 * output across open/append/close and asserts the segment text is absent.
 *
 * @param {Object} options
 * @param {object} options.store a createSpeechHistoryStore()-shaped store
 * @param {{debug,info,warn,error}} [options.log] injected logger (tests capture it)
 * @param {() => number} [options.now] injected clock (tests control time)
 * @param {(error: object) => void} [options.onError] one-shot failure report
 * @returns {{ open: Function, recordSegment: Function, close: Function,
 *             setContext: Function, settled: Function,
 *             readonly isOpen: boolean, readonly sessionId: string|null,
 *             readonly segmentCount: number, readonly context: object }}
 */
export function createHistorySessionRecorder({
  store,
  log: historyLog = null,
  now = Date.now,
  onError = null,
} = {}) {
  if (
    !store ||
    typeof store.beginSession !== 'function' ||
    typeof store.appendSegment !== 'function' ||
    typeof store.endSession !== 'function'
  ) {
    throw new TypeError('createHistorySessionRecorder: a speech history store is required');
  }
  const logger = historyLog || log;

  /** Boundary context for the NEXT open and for provider-less segments. */
  const context = { modelId: null, providerId: null, where: null };
  /** The open session, or null. Read at call time; mutated only in-queue. */
  let session = null;
  /** One report per recorder: fail-soft must never become log spam. */
  let failureReported = false;
  /** Serializes every store operation (an append must never race a close). */
  let queue = Promise.resolve();

  const reportFailure = (op, failure) => {
    if (failureReported) return;
    failureReported = true;
    const code =
      typeof failure === 'string' ? failure : failure?.code ?? failure?.name ?? 'Error';
    // Hygiene: the CODE only — never a payload, never segment text.
    logger.warn(
      `Transcript history ${op} failed (${code}); transcription continues unaffected`
    );
    try {
      onError?.({
        code: 'history-recording-failed',
        op,
        fatal: false,
        message: `transcript history ${op} failed (${code}) — transcription continues unaffected`,
      });
    } catch {
      // The error listener must never break recording either.
    }
  };

  const enqueue = (op) => {
    const run = queue.then(op).catch((error) => {
      // Belt and braces: impls already catch; the chain must never break.
      reportFailure('history', error);
      return { ok: false, code: 'history-error' };
    });
    queue = run;
    return run;
  };

  async function openImpl(meta) {
    if (session) return { ok: true, alreadyOpen: true, sessionId: session.sessionId };
    try {
      const result = await store.beginSession({
        startedAt: meta.startedAt,
        modelId: meta.modelId,
        providerId: meta.providerId,
        where: meta.where,
      });
      if (!result?.ok) {
        reportFailure('open', result?.code ?? 'open-failed');
        return result ?? { ok: false, code: 'history-error' };
      }
      const sessionId =
        typeof result.session?.sessionId === 'string' ? result.session.sessionId : '(unknown)';
      session = { sessionId, openedAt: meta.startedAt, segmentCount: 0 };
      // Ids only — the hygiene rule (never text).
      logger.info(`Transcript history session opened (${sessionId})`);
      return result;
    } catch (error) {
      reportFailure('open', error);
      return { ok: false, code: 'history-error' };
    }
  }

  async function appendImpl(active, message, providerId) {
    if (session !== active) return { ok: false, stored: false, reason: 'session-ended' };
    try {
      const result = await store.appendSegment(active.sessionId, {
        ...message,
        kind: 'final',
        providerId,
      });
      if (!result?.ok) {
        reportFailure('append', result?.code ?? 'append-failed');
        return result ?? { ok: false, code: 'history-error' };
      }
      if (result.stored) active.segmentCount += 1;
      return result;
    } catch (error) {
      reportFailure('append', error);
      return { ok: false, code: 'history-error' };
    }
  }

  async function closeImpl(active, reason, endedAt) {
    if (session !== active) return { ok: true, closed: false };
    session = null; // sealed first: segments queued after the close are dropped
    try {
      const durationMs = Math.max(0, endedAt - active.openedAt);
      const result = await store.endSession(active.sessionId, { endedAt, durationMs });
      if (!result?.ok) {
        reportFailure('close', result?.code ?? 'close-failed');
        return result ?? { ok: false, code: 'history-error' };
      }
      // Counts, ids, durations, reasons — NEVER text (hygiene rule).
      logger.info(
        `Transcript history session closed (${active.sessionId}, ` +
          `${active.segmentCount} segments, ${durationMs}ms, ${reason})`
      );
      return { ...result, closed: true };
    } catch (error) {
      reportFailure('close', error);
      return { ok: false, code: 'history-error', closed: true };
    }
  }

  return {
    /** Open a session; a no-op while one is already open. */
    open(meta = {}) {
      if (session) {
        return Promise.resolve({ ok: true, alreadyOpen: true, sessionId: session.sessionId });
      }
      // Boundary values are captured AT CALL TIME so a mid-queue context
      // switch cannot re-tag an operation that was issued before it.
      const startedAt = Number.isFinite(meta.startedAt) ? meta.startedAt : now();
      const boundary = {
        startedAt,
        modelId: context.modelId ?? (typeof meta.modelId === 'string' ? meta.modelId : null),
        providerId: context.providerId,
        where: context.where,
      };
      return enqueue(() => openImpl(boundary));
    },

    /**
     * Append ONE relayed segment. Finals only (see header); attribution is
     * captured synchronously so relay order always equals stored order.
     */
    recordSegment(message) {
      if (!message || message.t !== 'final') {
        return Promise.resolve({ ok: false, stored: false, reason: 'partials-are-not-persisted' });
      }
      if (!session) {
        // Not a failure: a segment before/after a session is simply unrecorded.
        return Promise.resolve({ ok: false, stored: false, reason: 'no-open-session' });
      }
      const providerId =
        typeof message.providerId === 'string' && message.providerId
          ? message.providerId
          : context.providerId;
      const active = session;
      return enqueue(() => appendImpl(active, message, providerId));
    },

    /** Close the open session; a no-op when nothing is open. */
    close(reason = 'stopped') {
      const active = session;
      if (!active) return Promise.resolve({ ok: true, closed: false });
      const endedAt = now();
      return enqueue(() => closeImpl(active, reason, endedAt));
    },

    /**
     * Move the attribution context (provider / where / model) for SUBSEQUENT
     * operations. Undefined fields are left alone. Never opens or closes a
     * session — the boundary stays per-segment (see header).
     */
    setContext(next = {}) {
      for (const key of ['modelId', 'providerId', 'where']) {
        if (next[key] !== undefined) {
          context[key] = typeof next[key] === 'string' && next[key] ? next[key] : null;
        }
      }
      return { ...context };
    },

    /** Resolves once every operation queued so far has settled. */
    settled: () => queue,

    get isOpen() {
      return session !== null;
    },
    get sessionId() {
      return session?.sessionId ?? null;
    },
    get segmentCount() {
      return session?.segmentCount ?? 0;
    },
    get context() {
      return { ...context };
    },
  };
}

// ---------------------------------------------------------------------------
// Supervisor state (mutated only by start/stop below — cold at import time)
// ---------------------------------------------------------------------------

let engineProcess = null;
let healthTimer = null;
let respawnTimer = null;
let cancelEscalation = null;
let phase = 'idle'; // 'idle' | 'starting' | 'running' | 'stopping'
let stopRequested = false;
let stopIntent = null; // 'user' | 'internal'
let startupAborted = null;
let healthFailures = 0;
let healthPollInFlight = false;
let crashGuard = createCrashGuard();
/** Transcript-history recorder (Decision D9); null until configured by a start. */
let historyRecorder = null;

/**
 * Phase 6 resource guardrail, created once per process. One instance, not one
 * per engine start: the strike count must survive a crash-and-respawn, or a
 * machine that trips the limit twice in a row would treat the second trip as
 * the first.
 */
let guardrail = createGuardrail({ limits: resolveLimits() });

/**
 * CPU accounting per engine pid, for the rate the guardrail needs.
 *
 * A raw `/proc/<pid>/stat` reading is CUMULATIVE ticks since boot, so a rate
 * needs the previous reading. Keyed by pid and cleared on teardown so a
 * recycled pid cannot inherit a bogus baseline — which would show as 9000% CPU
 * and suspend the engine for no reason.
 */
const cpuSamples = new Map();

let activeCallbacks = {
  onStatus: null,
  onHealth: null,
  onError: null,
  onEngineMessage: null,
};

const runtime = {
  mode: null,
  engineKind: null,
  endpoint: null,
  host: null,
  port: null,
  startedAt: null,
};

const state = {
  status: 'idle',
  health: null,
  lastError: null,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const notifyStatus = (status, reason) => {
  state.status = status;
  try {
    activeCallbacks.onStatus?.(status, reason);
  } catch {
    // A renderer-side listener must never break the supervisor.
  }
};

const notifyError = (error) => {
  state.lastError = error;
  try {
    activeCallbacks.onError?.(error);
  } catch {
    // Same rule.
  }
};

const notifyHealth = (health) => {
  state.health = health;
  try {
    activeCallbacks.onHealth?.(health);
  } catch {
    // Same rule.
  }
};

// ---------------------------------------------------------------------------
// Transcript history glue (Decision D9) — supervisor events -> recorder
// ---------------------------------------------------------------------------

/**
 * Configure the transcript-history write path from start options. Called
 * ONLY after shouldStartEngine() passed (invariant 4: the disabled default
 * configures nothing, opens nothing, writes nothing). Constructing the
 * store performs no I/O — the first file appears when a session opens on a
 * healthy engine, never before.
 *
 * Mid-session re-starts (the user switched provider/model while running)
 * only move the attribution context when a session is open: one run is one
 * session, and the boundary is per-segment (see createHistorySessionRecorder).
 *
 * @param {Object} options startSpeechEngine options (raw bag)
 * @param {object|null} [options.historyStore] injected store (tests / direct wiring)
 * @param {string} [options.historyDir] history directory — the speechIpc-style option
 * @param {string|null} [options.modelId] session boundary: selected model id
 * @param {string|null} [options.providerId] session boundary: current provider
 * @param {string|null} [options.where] session boundary: 'local' | 'cloud'
 */
function configureHistory(options = {}) {
  const { historyStore = null, historyDir = null, modelId, providerId, where } = options;

  if (historyRecorder?.isOpen) {
    // A start that arrives MID-SESSION re-keys nothing — attribution only.
    historyRecorder.setContext({ modelId, providerId, where });
    return;
  }

  if (!historyStore && !historyDir) {
    // "No option -> no session, no file": drop any write path a previous
    // start configured so this start runs from the documented default.
    historyRecorder = null;
    return;
  }

  try {
    const store = historyStore ?? createSpeechHistoryStore({ historyDir });
    historyRecorder = createHistorySessionRecorder({
      store,
      onError: (error) => notifyError(error),
    });
  } catch (error) {
    // History may never take down transcription: drop the write path,
    // report once (code only — never payload, never text), carry on.
    historyRecorder = null;
    const code = error?.code ?? error?.name ?? 'Error';
    log.warn(`Transcript history unavailable (${code}); transcription continues unaffected`);
    notifyError({
      code: 'history-recording-failed',
      message: `transcript history unavailable (${code}) — transcription continues unaffected`,
      fatal: false,
    });
  }

  // Undefined fields leave the existing context untouched, so a start that
  // carries no history metadata (today's speechIpc call) changes nothing.
  historyRecorder?.setContext({ modelId, providerId, where });
}

/** Open a history session if none is open (healthy-start / post-respawn health). */
function openHistorySession(health = null) {
  if (!historyRecorder) return Promise.resolve(null);
  return historyRecorder.open({ modelId: health?.model ?? null });
}

/** Close the open history session (teardown, stop, engine exit). Idempotent. */
function closeHistorySession(reason) {
  if (!historyRecorder) return Promise.resolve(null);
  return historyRecorder.close(reason);
}

/**
 * Resolve once every queued transcript-history operation has settled — the
 * app-quit flush hook and the deterministic seam tests await this.
 * @returns {Promise<unknown>}
 */
export function settleHistoryRecording() {
  return historyRecorder ? historyRecorder.settled() : Promise.resolve(null);
}

function stopHealthLoop() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  healthPollInFlight = false;
}

function startHealthLoop({ fetchHealth, token, startedAt }) {
  stopHealthLoop();
  healthFailures = 0;

  healthTimer = setInterval(async () => {
    if (stopRequested || healthPollInFlight) return;
    healthPollInFlight = true;
    try {
      const raw = await fetchHealth(token);
      const verdict = evaluateEngineApiVersion(raw?.apiVersion);
      if (!verdict.ok) {
        // The engine changed majors under us mid-run — stop talking to it.
        log.error(`Speech engine API changed incompatibly: ${verdict.reason}`);
        notifyError({ code: 'engine-api-incompatible', message: verdict.reason, fatal: true });
        teardown('internal');
        notifyStatus('error', 'incompatible-api');
        return;
      }
      healthFailures = 0;
      const health = buildHealthPayload(raw, {
        pid: engineProcess?.pid ?? null,
        startedAt,
        now: Date.now(),
      });
      notifyHealth(health);
      // Post-respawn continuity: a crash closed the session (engine exit),
      // and the first healthy poll after the respawn opens the next one.
      // No-op while a session is open — never two sessions at once.
      void openHistorySession(health);
      // Phase 6: the same poll feeds the resource guardrail. One loop, two
      // readers — a second timer sampling the same process would double the
      // overhead and could disagree with this one about whether it was safe.
      observeGuardrail(health);
    } catch (error) {
      healthFailures += 1;
      if (healthFailures >= HEALTH_FAILURE_LIMIT) {
        log.error(`Speech engine failed ${healthFailures} health checks in a row; stopping it`);
        notifyError({
          code: 'engine-health-lost',
          message: `speech engine stopped answering health checks (${error.message})`,
          fatal: true,
        });
        teardown('internal');
        notifyStatus('error', 'health-lost');
      }
    } finally {
      healthPollInFlight = false;
    }
  }, HEALTH_POLL_INTERVAL_MS);
}

/**
 * Phase 6 — the shared-laptop guardrail, driven from the health poll.
 *
 * Memory comes from the engine's own health response. CPU comes from the OS for
 * the engine's pid, because the engine cannot report its own CPU use without
 * measuring it.
 *
 * Failures are swallowed on purpose: a guardrail bug must not be able to take
 * down transcription on a machine that is comfortably under its limits.
 */
function observeGuardrail(health) {
  if (!guardrail) return;

  const sample = {
    rssMb: typeof health?.memoryMb === 'number' ? health.memoryMb : null,
    cpuPercent: sampleEngineCpuPercent(engineProcess?.pid ?? null),
  };

  let outcome;
  try {
    outcome = guardrail.observe(sample);
  } catch (error) {
    log.warn(`Guardrail failed to evaluate: ${error?.code ?? error?.name ?? 'Error'}`);
    return;
  }

  if (outcome.action === 'suspend') {
    log.warn(`Engine suspended by guardrail: ${outcome.message}`);
    guardrail.markSuspended();
    notifyError({ code: 'engine-resource-limit', message: outcome.message, fatal: false });
    // SUSPEND, not stop: stop() reports 'idle' and reads as "the user turned
    // it off". This reports a constraint the machine imposed, which is a
    // different thing to fix and a different thing to explain.
    teardown('guardrail');
    notifyStatus('error', 'resource-limit');
    return;
  }

  // A warning is surfaced, not acted on. One hot sample during the hardest
  // part of a sermon is not a reason to stop working.
  if (outcome.action === 'warn') {
    notifyError({ code: 'engine-resource-pressure', message: outcome.message, fatal: false });
  }
}

/**
 * CPU used by one process, as a percentage of TOTAL system CPU.
 *
 * 100 means every core is saturated; a 4-core machine at 400 is pinned.
 *
 * @param {number|null} pid
 * @returns {number|null} null when the OS will not say — which the guardrail
 *   treats as unmeasurable rather than as zero, since "no data" and "idle" are
 *   not the same and only one of them is safe to assume.
 */
function sampleEngineCpuPercent(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // Only Linux's /proc is read here. Everywhere else this returns null, so on
  // macOS and Windows the CPU half of the guardrail is INACTIVE and the memory
  // half carries the load. Reporting this platform's own CPU as if it were the
  // engine's would be a real number about the wrong process.
  if (process.platform !== 'linux') return null;

  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Fields 14 (utime) and 15 (stime), in clock ticks. The comm field (2) can
    // contain spaces and parentheses, so parse AFTER the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const ticks = Number(fields[11]) + Number(fields[12]);
    if (!Number.isFinite(ticks) || ticks < 0) return null;

    const previous = cpuSamples.get(pid);
    const at = Date.now();
    cpuSamples.set(pid, { cpuSeconds: ticks / 100, at }); // USER_HZ is fixed at 100
    if (!previous) return null; // the first read is a baseline, not a rate

    const deltaCpu = ticks / 100 - previous.cpuSeconds;
    const deltaWall = (at - previous.at) / 1000;
    if (deltaWall <= 0) return null;
    return (deltaCpu / deltaWall) * 100;
  } catch {
    return null;
  }
}

/**
 * Stop whatever is running. `intent`:
 *   'user'     — renderer asked (speech:stop / quit): status goes idle.
 *   'internal' — supervisor gave up (incompatible, unhealthy, timeout):
 *                the error status already reported stays put.
 */
function teardown(intent) {
  stopRequested = true;
  stopIntent = intent;
  stopHealthLoop();
  // The history session ends with the engine, whoever ended it: clean stop,
  // SIGTERM escalation path, crash-loop disable, health loss, and API
  // mismatch all funnel through here (engine exit closes again below —
  // closes are serialized and idempotent). No session open -> no-op.
  void closeHistorySession(`teardown:${intent}`);

  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  if (cancelEscalation) {
    cancelEscalation();
    cancelEscalation = null;
  }

  const child = engineProcess;
  engineProcess = null;
  // Drop the CPU baseline with the process. A pid can be recycled, and a stale
  // baseline would make the next engine's first real reading look like a 9000%
  // spike — suspending it instantly for something it never did.
  if (child?.pid) cpuSamples.delete(child.pid);
  if (!child) return false;

  try {
    if (process.platform === 'win32') {
      child.kill('SIGKILL');
    } else {
      child.kill('SIGTERM');
      cancelEscalation = scheduleKillEscalation(child);
    }
  } catch (error) {
    log.warn('Error signalling speech engine:', error?.message || error);
    try {
      if (child.exitCode === null) child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
  return true;
}

/**
 * Validate and relay ONE engine message — the fork IPC handler's tail,
 * extracted so the relay + history write path is testable without Electron
 * and without a child process.
 *
 * Invalid messages are dropped (message TYPE logged, never the payload —
 * transcript text may live inside). Valid ones reach the renderer callback
 * and, finals only, the open history session (see createHistorySessionRecorder
 * for the finals-vs-partials decision, which follows main/speechHistory.js).
 *
 * @param {unknown} message engine message ({ t, ... })
 * @returns {{ ok: boolean, relayed?: boolean, reason?: string }}
 */
export function relayEngineMessage(message) {
  if (!message || typeof message !== 'object' || typeof message.t !== 'string') {
    return { ok: false, reason: 'not-an-engine-message' };
  }

  const verdict = validateMessage(message);
  if (!verdict.ok) {
    // Type only — engine payloads may contain transcript text.
    log.warn(`Dropping invalid engine message of type ${message.t}`);
    diagMain('warn', 'engine', 'invalid engine message dropped', {
      type: message.t,
      errors: verdict.errors,
    });
    return { ok: false, reason: 'invalid-message' };
  }

  if (message.t === 'final') {
    // Fire into the serialized history queue; never awaited, never throws,
    // and the renderer relay below does not wait on disk I/O.
    void historyRecorder?.recordSegment(message);
    diagMain('info', 'engine', 'final relayed', {
      sessionId: message.sessionId ?? null,
      tStartMs: message.tStartMs ?? null,
      tEndMs: message.tEndMs ?? null,
      textChars: typeof message.text === 'string' ? message.text.length : 0,
    });
  }

  try {
    activeCallbacks.onEngineMessage?.(message);
  } catch {
    // Listener errors never take down the engine channel.
  }
  return { ok: true, relayed: true };
}

// ---------------------------------------------------------------------------
// Public lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the speech engine, if — and ONLY if — the plan's gate allows it.
 *
 * Resolves with `{ ok: true, reason, health }` when healthy, or
 * `{ ok: false, reason, mode? }` when nothing may start (disabled, nothing
 * installed, non-loopback, incompatible API, crash-loop, timeout...).
 * It never throws for those cases: "not started" is a normal outcome.
 *
 * @param {Object} [options]
 * @param {boolean} [options.enabled] the user's speech.enabled switch
 * @param {string|null} [options.endpoint] explicit loopback engine endpoint
 * @param {string} [options.host] bind host (loopback enforced)
 * @param {number} [options.port]
 * @param {string[]} [options.engineRoots] candidate engine directories
 * @param {string|null} [options.engineToken] pre-shared token (endpoint mode)
 * @param {string} [options.historyDir] transcript-history directory (Decision
 *   D9) — the speechIpc-style option that turns the supervisor's history
 *   write path on. No option -> no session, no file.
 * @param {object} [options.historyStore] injected store (tests / direct wiring);
 *   wins over historyDir when both are given.
 * @param {string|null} [options.modelId] history boundary: selected model id
 * @param {string|null} [options.providerId] history boundary: current provider
 * @param {string|null} [options.where] history boundary: 'local' | 'cloud'
 * @param {boolean} [options.historyless] true for a benchmark-only restart: no
 *   history session is configured, opened, or closed for this start
 * @param {(status: string, reason?: string) => void} [options.onStatus]
 * @param {(health: object) => void} [options.onHealth]
 * @param {(error: object) => void} [options.onError]
 * @param {(message: object) => void} [options.onEngineMessage]
 * @returns {Promise<object>} start result
 */
export async function startSpeechEngine(options = {}) {
  const {
    enabled = false,
    endpoint: configuredEndpoint = null,
    host = DEFAULT_ENGINE_HOST,
    port = DEFAULT_ENGINE_PORT,
    engineRoots = [],
    engineToken = null,
    engineKind: requestedEngineKind = null,
    historyDir = null,
    historyStore = null,
    historyless = false,
    modelId,
    providerId,
    where,
    computeBackend = null,
    binDir = null,
    modelsDir = null,
    // Cloud fork config. Present ONLY for a cloud start; the key is passed
    // through the child's environment and is never logged or sent to IPC.
    cloud = null,
    onStatus = null,
    onHealth = null,
    onError = null,
    onEngineMessage = null,
  } = options;

  const resolvedBinDir = binDir || process.env.LD_SPEECH_BIN_DIR || null;
  const resolvedModelsDir = modelsDir || process.env.LD_SPEECH_MODELS_DIR || null;

  const engineKind =
    requestedEngineKind ??
    (resolvedBinDir && hasWhisperBinary(resolvedBinDir) ? 'whisper' : null) ??
    (process.env.LD_SPEECH_ENGINE ? process.env.LD_SPEECH_ENGINE : 'fake');

  activeCallbacks = { onStatus, onHealth, onError, onEngineMessage };

  if (engineProcess) {
    // A start that asks for a DIFFERENT engine is a mode change, not a no-op.
    // Returning 'already-running' here is how the fake engine kept serving
    // canned text after the operator switched the rail from TEST to PROD.
    if (requestedEngineKind && runtime.engineKind && requestedEngineKind !== runtime.engineKind) {
      log.info(`Speech engine kind changed (${runtime.engineKind} -> ${requestedEngineKind}); restarting`);
      const previous = engineProcess;
      stopSpeechEngine({ reason: 'engine-kind-changed' });
      // The old process must release the loopback port before the new fork
      // binds it, or the restart fails with EADDRINUSE. Bounded: a process
      // that will not die must not hang the operator's click.
      await waitForEngineExit(previous, 3000);
    } else {
      if (enabled === true) {
        // Mid-session re-start (invariant 4 still gates the disabled case):
        // attribution context moves, an open session is never re-keyed.
        configureHistory(historyless ? {} : { historyDir, historyStore, modelId, providerId, where });
      }
      return {
        ok: true,
        reason: 'already-running',
        mode: runtime.mode,
        health: state.health,
        engineKind: runtime.engineKind,
      };
    }
  }

  const discovery = resolveEngineDiscovery({ configuredEndpoint, engineRoots });
  const decision = describeStartDecision({
    enabled,
    endpoint: discovery.endpoint,
    engineAvailable: discovery.mode === 'package',
  });

  if (!decision.start) {
    // Invariant 4: the default world. No fork, no socket, no poll.
    log.info(`Speech engine not started: ${decision.reason}`);
    return { ok: false, reason: decision.reason, mode: discovery.mode };
  }

  let bindHost;
  try {
    bindHost = resolveBindHost(host);
  } catch (error) {
    log.error(error.message);
    notifyError({ code: 'engine-non-loopback-host', message: error.message, fatal: true });
    return { ok: false, reason: 'non-loopback-host', mode: discovery.mode };
  }

  let token;
  try {
    token = typeof engineToken === 'string' && engineToken.length >= 16
      ? engineToken
      : generateEngineToken();
  } catch (error) {
    notifyError({ code: 'engine-token-failed', message: error.message, fatal: true });
    return { ok: false, reason: 'token-generation-failed', mode: discovery.mode };
  }
  // Publish it for the benchmark harness, which must reach an engine the caller
  // never started. Never logged — the token lives only here and in the fork env.
  launchToken = token;

  crashGuard.reset();
  stopRequested = false;
  stopIntent = null;
  startupAborted = null;
  healthFailures = 0;
  state.lastError = null;
  // Transcript history (Decision D9): configure the write path ONLY after
  // the invariant-4 gate above passed — the disabled default configures
  // nothing. Construction performs no I/O; the session opens on the healthy
  // return below, so a start that never becomes healthy writes no file.
  // A benchmark restart is not a sermon session: historyless drops the write
  // path so a matrix run cannot leave empty sessions in transcript history.
  configureHistory(historyless ? {} : { historyDir, historyStore, modelId, providerId, where });
  phase = 'starting';

  const startedAt = Date.now();
  runtime.mode = discovery.mode;
  runtime.engineKind = engineKind;
  runtime.host = bindHost;
  runtime.port = port;
  runtime.startedAt = startedAt;
  runtime.endpoint =
    discovery.mode === 'endpoint'
      ? (/^[a-z][a-z0-9+.-]*:\/\//i.test(discovery.endpoint) ? discovery.endpoint : `http://${discovery.endpoint}`)
      : `http://${bindHost}:${port}`;

  notifyStatus('starting', decision.reason);

  const fetchHealth = async (activeToken) => {
    const response = await fetch(`${runtime.endpoint}${ENGINE_ROUTES.health.path}`, {
      method: 'GET',
      headers: { [TOKEN_HEADER]: activeToken },
      signal: AbortSignal.timeout(3000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(`engine rejected the launch token (HTTP ${response.status})`);
    }
    if (!response.ok) throw new Error(`health HTTP ${response.status}`);
    return response.json();
  };

  // --- (b) package mode: fork the co-located engine ------------------------
  if (discovery.mode === 'package') {
    const spawnEngine = () => {
      const child = fork(discovery.entry, [], {
        cwd: path.dirname(discovery.entry),
        env: {
          ...process.env,
          LD_SPEECH_TOKEN: token,
          LD_SPEECH_HOST: bindHost,
          LD_SPEECH_PORT: String(port),
          LD_SPEECH_ENGINE: engineKind,
          ...(resolvedBinDir ? { LD_SPEECH_BIN_DIR: resolvedBinDir } : {}),
          ...(resolvedModelsDir ? { LD_SPEECH_MODELS_DIR: resolvedModelsDir } : {}),
          ...(modelId ? { LD_SPEECH_MODEL: modelId } : {}),
          ...(computeBackend ? { LD_SPEECH_COMPUTE_BACKEND: computeBackend } : {}),
          ...(process.env.LD_SPEECH_DRIVER ? { LD_SPEECH_DRIVER: process.env.LD_SPEECH_DRIVER } : {}),
          ...(cloud
            ? {
                LD_SPEECH_CLOUD_PROVIDER: cloud.provider,
                LD_SPEECH_CLOUD_KEY: cloud.apiKey,
                LD_SPEECH_CLOUD_MODEL: cloud.model,
              }
            : {}),
        },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      engineProcess = child;

      child.on('message', (message) => {
        if (!message || typeof message !== 'object') return;
        if (message.status === 'ready' && Number.isFinite(message.port)) {
          runtime.endpoint = `http://${bindHost}:${message.port}`;
          return;
        }
        if (message.status === 'error') {
          if (message.error === 'EADDRINUSE') {
            log.error(`Speech engine port ${message.port} is already in use`);
            startupAborted = 'port-in-use';
          }
          return;
        }
        // Message-bus mirror from the engine: relay after schema validation.
        if (typeof message.t === 'string') {
          relayEngineMessage(message);
        }
      });

      child.on('error', (error) => {
        log.error('Speech engine process error:', error?.message || error);
        if (phase === 'starting') {
          startupAborted = 'spawn-error';
        } else {
          notifyError({ code: 'engine-process-error', message: error?.message || 'process error', fatal: false });
        }
      });

      child.on('exit', (code, signal) => {
        // A child that is no longer the current engine was replaced by a mode
        // change (or torn down). Its exit must not stop the NEW health loop,
        // record a crash against the new engine, or trigger a respawn.
        if (engineProcess !== child) return;
        engineProcess = null;
        stopHealthLoop();
        // Engine exit ends the history session — crash-loop disable and a
        // plain crash both land here; a respawn reopens on its first healthy
        // poll (see startHealthLoop). No session open -> no-op.
        void closeHistorySession('engine-exited');

        if (stopRequested) return;

        const crash = crashGuard.recordCrash();

        if (phase === 'starting') {
          // A specific abort reason (e.g. port-in-use from the fork IPC
          // handshake) outranks the generic exit code.
          if (!startupAborted) {
            startupAborted = code === 0 ? 'engine-exited' : `engine-exited-code-${code}`;
          }
          return;
        }

        if (crash.tripped) {
          // ONE clear error instead of respawning forever (plan wording).
          const message =
            `speech engine crashed ${crash.crashes} times within ${CRASH_LOOP_WINDOW_MS}ms — ` +
            'automatic restarts are disabled until speech is started again';
          log.error(message);
          notifyError({ code: 'engine-crash-loop', message, fatal: true, crashes: crash.crashes });
          notifyStatus('error', 'crash-loop');
          return;
        }

        log.warn(`Speech engine exited (code ${code ?? 'n/a'}, signal ${signal ?? 'n/a'}); respawning`);
        notifyStatus('starting', 'respawning');
        respawnTimer = setTimeout(() => {
          respawnTimer = null;
          if (stopRequested || phase === 'stopping') return;
          // fork() can throw synchronously (EAGAIN, ENOMEM, a missing entry
          // point). Unguarded, that throw escapes a timer callback and becomes
          // an uncaught exception in the Electron MAIN process — which does not
          // merely fail the respawn, it takes the whole app down. The very
          // first spawn below is inside the caller's own try/catch; this one
          // is not, so it needs its own.
          try {
            spawnEngine();
          } catch (error) {
            log.error(`Speech engine respawn failed: ${error?.message ?? 'unknown error'}`);
            notifyError({
              code: 'engine-respawn-failed',
              message: 'The speech engine could not be restarted.',
              fatal: true,
            });
            notifyStatus('error', 'respawn-failed');
            return;
          }
          startHealthLoop({ fetchHealth, token, startedAt });
        }, RESPAWN_DELAY_MS);
      });

      return child;
    };

    spawnEngine();
  }

  // --- startup wait: poll until healthy (or abort/timeout) ------------------
  const deadline = Date.now() + HEALTH_STARTUP_TIMEOUT_MS;
  let lastFailure = 'no attempt yet';

  while (Date.now() < deadline) {
    if (stopRequested) return { ok: false, reason: 'stopped', mode: runtime.mode };
    if (startupAborted) {
      notifyError({
        code: 'engine-startup-failed',
        message: `speech engine exited during startup (${startupAborted})`,
        fatal: true,
      });
      notifyStatus('error', 'startup-failed');
      return { ok: false, reason: startupAborted, mode: runtime.mode };
    }

    try {
      const raw = await fetchHealth(token);
      const verdict = evaluateEngineApiVersion(raw?.apiVersion);

      if (!verdict.ok) {
        // Plan 7.5: refuse a mismatched MAJOR outright.
        log.error(`Speech engine API incompatible: ${verdict.reason}`);
        teardown('internal');
        notifyError({ code: 'engine-api-incompatible', message: verdict.reason, fatal: true });
        notifyStatus('error', 'incompatible-api');
        return { ok: false, reason: 'incompatible-api', mode: runtime.mode };
      }
      if (verdict.shouldWarn) log.warn(verdict.reason);

      phase = 'running';
      const health = buildHealthPayload(raw, { pid: engineProcess?.pid ?? null, startedAt });
      notifyHealth(health);
      // The transcription session opens HERE — engine healthy, feature on.
      // Boundary metadata only (date/model/provider/where + wer: null);
      // fails soft inside the recorder, never blocks the start result.
      await openHistorySession(health);
      startHealthLoop({ fetchHealth, token, startedAt });
      log.info(`Speech engine ready (${runtime.mode}) — api ${verdict.level}`);
      return {
        ok: true,
        reason: verdict.level === 'minor-mismatch' ? 'healthy-minor-mismatch' : 'healthy',
        mode: runtime.mode,
        health,
      };
    } catch (error) {
      lastFailure = error.message;
    }

    await sleep(400);
  }

  log.error(`Speech engine failed to become healthy within ${HEALTH_STARTUP_TIMEOUT_MS}ms (${lastFailure})`);
  teardown('internal');
  notifyError({
    code: 'engine-startup-timeout',
    message: `speech engine did not become healthy within ${HEALTH_STARTUP_TIMEOUT_MS}ms (${lastFailure})`,
    fatal: true,
  });
  notifyStatus('error', 'startup-timeout');
  return { ok: false, reason: 'startup-timeout', mode: runtime.mode };
}

/**
 * Stop the engine: SIGTERM first, SIGKILL escalated at
 * SPEECH_ENGINE_KILL_ESCALATION_MS (2000 ms). Safe to call when nothing is
 * running (a no-op) — quitting the app always calls this.
 *
 * @param {Object} [options]
 * @param {string} [options.reason] reported to onStatus
 * @returns {{ stopped: boolean }}
 */
export function stopSpeechEngine({ reason = 'stopped' } = {}) {
  phase = 'stopping';
  const hadProcess = teardown('user');
  if (!hadProcess) {
    if (state.status !== 'idle') notifyStatus('idle', reason);
    return { stopped: false };
  }
  notifyStatus('idle', reason);
  log.info('Speech engine stopped');
  return { stopped: true };
}

/**
 * Current supervisor state for speech:get-state. NEVER includes the token.
 *
 * @returns {{ status: string, health: object|null, lastError: object|null,
 *             mode: string|null, endpoint: string|null, pid: number|null,
 *             running: boolean }}
 */
/**
 * Phase 6 — the guardrail, as the safety panel needs it.
 *
 * Returns the LIMITS and the current state together, because the panel's job is
 * to show the operator both: "this is what your machine allows" and "this is
 * where it currently is". A report that showed only the state would leave the
 * number un-actionable, and one that showed only the limits would look like a
 * pass while the engine sat suspended.
 *
 * @returns {{limits: object, status: string, strikes: number, trips: number,
 *            lastMessage: string}}
 */
export function guardrailReport() {
  const state = guardrail?.state ?? { status: 'ok', strikes: 0, trips: 0, lastMessage: '' };
  return {
    limits: guardrail?.limits ?? resolveLimits(),
    status: state.status,
    strikes: state.strikes,
    trips: state.trips,
    lastMessage: state.lastMessage,
  };
}

export function getSpeechEngineSnapshot() {
  return {
    status: state.status,
    health: state.health,
    lastError: state.lastError,
    mode: runtime.mode,
    engineKind: runtime.engineKind,
    endpoint: runtime.endpoint,
    pid: engineProcess?.pid ?? null,
    running: Boolean(engineProcess),
  };
}
