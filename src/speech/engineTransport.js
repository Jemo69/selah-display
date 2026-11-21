/**
 * engineTransport.js — the renderer's bridge to the speech
 * engine (plan section 3): one native WebSocket carrying the
 * raw PCM stream up and the validated messages down.
 *
 * WHY A RAW WEBSOCKET (plan section 3, verbatim): "a raw
 * ws://127.0.0.1 WebSocket to the engine ... both are
 * zero-dependency in the renderer — Chromium ships native
 * WebSocket ... Inventing a third transport would be pure
 * cost." Mode C (a booth machine running the engine) needs
 * the renderer to reach the engine directly, and "a remote
 * engine is a transport change, not a second contract" — so
 * this client speaks the SAME contract the supervisor speaks.
 * A LAN endpoint is dialed ONLY when speech:start came back with
 * `engine.remote === true` AND the caller asked for where:'network';
 * local mode keeps its loopback-only gate. LAN is trusted, plain
 * http/ws:// with no TLS: raw audio crosses the network.
 *
 * THE START PATH. start(payload) is the whole bridge: it
 * invokes `speech:start` with the payload (the renderer's
 * { enabled, modelId, providerId, where } — main forks the
 * engine and opens the transcript-history session with it)
 * and dials the WebSocket from the reply's `engine` block
 * ({ endpoint, token, path }, see main/speechIpc.js). The
 * token travels as the `token` query parameter on the
 * upgrade — plan 7.1: "requires it as an `x-ld-speech-token`
 * header on REST and a query parameter on the WebSocket
 * upgrade" — mirroring speech-engine/wsTransport.js's
 * WS_TOKEN_PARAM (re-declared here because the engine
 * package is Node-only and is not shipped in the installer;
 * the parameter name is part of the stable dial contract).
 * The token is NEVER logged and never appears in any
 * diagnostic.
 *
 * UPSTREAM (this client -> engine): the exact PCM frames the
 * capture worklet produces — little-endian Int16, 16 kHz
 * mono, 100 ms / 1600 samples / 3200 bytes, back to back,
 * no header, no envelope (shared/speech/protocol.js).
 * send() accepts the worklet's Int16Array as-is: a browser
 * WebSocket sends an ArrayBufferView as one binary frame,
 * and the engine unmasks and ingests it.
 *
 * THE QUEUE BOUND. While the socket opens, frames buffer in a
 * drop-OLDEST ring of MAX_QUEUED_FRAMES (30 s at the
 * contract's 10 frames per second). A service runs 40
 * minutes; an unbounded queue would be a leak — and the
 * freshest audio is what live transcription wants, so
 * overflow ages out the oldest frame and counts it. The
 * dropped count is exposed in the diagnostics, never the
 * audio.
 *
 * DOWNSTREAM (engine -> this client): JSON messages of the
 * contract's seven types. Every message is parsed and run
 * through validateMessage(); an unparseable or schema-invalid
 * message is DROPPED and counted — garbage is never
 * forwarded to the rail. (The rail's transcript path is the
 * supervisor's `speech:transcript` IPC relay, which survives
 * a renderer WebSocket drop; this client's downstream is the
 * same bus fan-out, delivered over the socket — the path a
 * remote engine will use.)
 *
 * THE FEATURE GATE. This module reads SpeechStore itself: it
 * NEVER dials while `speech.enabled === false`, whatever the
 * caller does. Nothing runs at import time — the WebSocket
 * constructor is referenced only inside start(). There is NO
 * auto-reconnect: the engine is restarted only through
 * speech:start.
 *
 * TEARDOWN. stop() closes the socket, clears the queue, and
 * detaches every listener synchronously, then invokes
 * `speech:stop` — exactly once per start (the startedEngine
 * guard), so pagehide/unmount/feature-off, which all tear
 * down, never double-stop the engine.
 *
 * REMOTE RELAY. A remote engine has no forked supervisor to mirror its bus
 * onto speech:transcript/speech:vad. Contract-valid messages received on a
 * remote socket are fanned out to listeners registered with
 * onRemoteEngineMessage(); useSpeechRuntime subscribes there in addition to
 * the IPC channels. No message is accepted from a local socket this way.
 *
 * DIAGNOSTICS. getDiagnostics() reports state, the last close
 * code, and the dropped / invalid / queued counts — codes and
 * counts only. Never audio, never the token.
 */
import { validateMessage, isLoopbackHost } from 'shared/speech';
import useSpeechStore from '../context/SpeechStore';
import { diagInfo, diagWarn } from '../utils/diagnosticsLog';

/**
 * The token query parameter on the WebSocket upgrade (plan 7.1).
 * Mirrors speech-engine/wsTransport.js's WS_TOKEN_PARAM —
 * declared here because the engine package is Node-only and is
 * NOT shipped in the installer (invariant 1), so the renderer
 * cannot import it; the parameter name is part of the stable
 * dial contract, and main relays the stream path.
 */
export const WS_TOKEN_PARAM = 'token';

/**
 * The bounded upstream queue: 300 frames = 30 seconds of contract
 * audio (one 100 ms frame per tick). A loopback WebSocket opens in
 * milliseconds, so this is four orders of magnitude of headroom;
 * past it, the oldest frame ages out (see the header). Exported so
 * tests can pin the bound.
 */
export const MAX_QUEUED_FRAMES = 300;

/** The close code for a socket that died without a close frame. */
const ABNORMAL_CLOSE_CODE = 1006;

/**
 * How long a Production stop waits, after closing the PCM socket, before
 * telling the supervisor to kill the engine.
 *
 * WHY: the real engine only produces a `final` at an endpoint — 500 ms of
 * silence, the 15 s cap, or socket close. Closing the socket triggers that
 * final, but the supervisor kills the process (SIGKILL on Windows) the moment
 * `speech:stop` arrives, so the transcription never finishes. The result was
 * that a short phrase followed by Stop produced nothing at all. The wait is
 * bounded and best-effort; TEST mode skips it because the canned engine has
 * nothing to flush.
 */
export const FLUSH_GRACE_MS = 2500;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Remote transcript listeners. Module-scoped because the transport is a
 * singleton shared by useAudioCapture; useSpeechRuntime registers here so a
 * remote engine's WS messages reach the SAME rail code as IPC relays.
 */
const remoteMessageListeners = new Set();

/**
 * Subscribe to contract-valid messages from a remote (network-mode) engine.
 * Returns an unsubscribe function. Never called for a local socket.
 */
export function onRemoteEngineMessage(listener) {
  if (typeof listener !== 'function') return () => {};
  remoteMessageListeners.add(listener);
  return () => remoteMessageListeners.delete(listener);
}

function dispatchRemoteMessage(message) {
  for (const listener of remoteMessageListeners) {
    try {
      listener(message);
    } catch {
      // One bad subscriber must not break the audio path or other listeners.
    }
  }
}

/** A dropped remote socket must not leave the rail claiming a live engine. */
function clearRemoteHealth() {
  try {
    const store = useSpeechStore.getState();
    if (store.health?.remote === true) store.setHealth(null);
  } catch {
    /* no store available: nothing to clear */
  }
}

/**
 * The hostname of an `http://host:port` engine endpoint — scheme,
 * port, and path stripped — or null when it cannot be parsed. A tiny
 * local parser on purpose: the renderer needs none of URL's other
 * features here, and jsdom's URL ignores a base argument (harness
 * note), so tests exercise this code exactly as the renderer runs it.
 *
 * @param {unknown} endpoint
 * @returns {string|null}
 */
function hostnameOfEndpoint(endpoint) {
  const raw = String(endpoint ?? '').trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(raw);
  const rest = scheme ? raw.slice(scheme[0].length) : raw;
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    return end === -1 ? null : rest.slice(1, end);
  }
  const colon = rest.indexOf(':');
  const slash = rest.indexOf('/');
  const stop = Math.min(
    colon === -1 ? Infinity : colon,
    slash === -1 ? Infinity : slash
  );
  if (stop === Infinity) return rest || null;
  return rest.slice(0, stop) || null;
}

/** The renderer's preload bridge, read at call time (never at import). */
function speechBridge() {
  if (typeof window === 'undefined') return null;
  const speech = window.electronAPI?.speech;
  return speech && typeof speech === 'object' ? speech : null;
}

/**
 * Create one engine transport.
 *
 * @param {Object} [options]
 * @param {(message: object) => void} [options.onMessage] typed
 *   downstream callback — receives ONLY contract-valid messages.
 * @param {typeof WebSocket} [options.WebSocketImpl] the socket
 *   constructor (tests inject a fake; production uses the browser's
 *   native WebSocket, read at dial time).
 * @returns {{ start: Function, stop: Function, send: Function,
 *             getDiagnostics: Function, isOpen: Function }}
 */
export function createEngineTransport({ onMessage, WebSocketImpl } = {}) {
  /** The live socket, or null while idle. */
  let socket = null;
  /** Was the last successful dial a trusted-LAN remote engine? */
  let dialedRemote = false;
  /** 'idle' | 'connecting' | 'open'. */
  let state = 'idle';
  /** Last numeric close code seen (null until a socket has closed). */
  let lastErrorCode = null;
  /** Frames dropped: queue overflow, send-while-not-dialing, send failures. */
  let dropped = 0;
  /** Downstream messages dropped: unparseable or schema-invalid. */
  let invalid = 0;
  /** Frames waiting for the socket to open (the bounded drop-oldest ring). */
  let queue = [];
  /** Did THIS transport's speech:start bring the engine up? Guards speech:stop. */
  let startedEngine = false;
  /**
   * Bumped by every stop(). A start() whose speech:start invoke
   * straddles a stop() must NOT dial afterwards — teardown won
   * the race, and the engine it started is stopped again below.
   */
  let generation = 0;
  /**
   * Bumped by every start(). A stop() that is waiting out FLUSH_GRACE_MS must
   * not kill the engine a newer start() is already bringing up.
   */
  let session = 0;

  /**
   * The bridge's start: invoke `speech:start`, then dial the
   * reply's `engine` block. Requires the feature to be ON (this
   * module enforces the gate itself). Returns `{ ok, reason }`;
   * never throws.
   *
   * `no-speech-bridge` is a DISTINCT, non-fatal reason: a browser
   * build or a unit test has no preload bridge, and capture still
   * works standalone — nothing was started and nothing dials.
   * Every other `{ ok:false }` means the engine refused to start
   * (or could not be reached), and the caller must fail the arm.
   *
   * @param {{ enabled?: boolean, modelId?: string,
   *            providerId?: string, where?: string }} payload
   */
  async function start(payload = {}) {
    const startStartedAt = Date.now();
    const finishStart = (outcome) => {
      diagInfo('engine', 'transport start settled', {
        ok: outcome?.ok === true,
        reason: outcome?.reason ?? null,
        errorCode: outcome?.error?.code ?? null,
        durationMs: Date.now() - startStartedAt,
      });
      return outcome;
    };
    // The feature gate, enforced HERE as well as at every call
    // site: nothing invokes, spawns, or dials while the master
    // switch is off.
    if (useSpeechStore.getState().enabled !== true) {
      return finishStart({ ok: false, reason: 'disabled' });
    }

    const speech = speechBridge();
    if (!speech || typeof speech.start !== 'function') {
      return finishStart({ ok: false, reason: 'no-speech-bridge' });
    }

    // Enter 'connecting' BEFORE the invoke: the first start
    // forks the engine and waits for its health, and every PCM
    // frame the capture produces in that window buffers in the
    // bounded queue instead of being dropped.
    session += 1;
    const alreadyDialing = state === 'connecting' || state === 'open';
    const myGeneration = generation;
    if (!alreadyDialing) state = 'connecting';

    let reply;
    try {
      reply = await speech.start(payload);
    } catch {
      state = 'idle';
      dropped += queue.length;
      queue = [];
      return finishStart({ ok: false, reason: 'speech-start-failed' });
    }
    if (!reply || reply.ok !== true) {
      state = 'idle';
      dropped += queue.length;
      queue = [];
      // Forward main's error detail (e.g. the probe's VC++ remedy): the
      // caller surfaces it, so a refused start keeps its actionable message
      // instead of collapsing to a bare reason string.
      return finishStart({ ok: false, reason: reply?.reason ?? 'engine-not-started', error: reply?.error });
    }

    // The engine is up (or was already running) and THIS bridge
    // started it — stop() will own the matching speech:stop.
    startedEngine = true;

    if (myGeneration !== generation) {
      // Teardown raced the invoke: the engine came up AFTER the
      // stop that was meant to end it. Stop it again — best
      // effort, never throws — and report the stop.
      state = 'idle';
      dropped += queue.length;
      queue = [];
      try {
        await speech.stop();
      } catch {
        // Fail soft: the supervisor also stops the engine on
        // app quit and on its own crash paths.
      }
      return finishStart({ ok: false, reason: 'stopped' });
    }

    if (alreadyDialing) {
      // Already dialed: one engine, one socket. The invoke above
      // still ran, so main's install state and history session are
      // refreshed for the re-arm.
      return finishStart({ ok: true, reason: 'already-running' });
    }

    const verdict = dial(reply.engine, { allowRemote: payload.where === 'network' });
    if (!verdict.ok) {
      state = 'idle';
      dropped += queue.length;
      queue = [];
      return finishStart(verdict);
    }
    return finishStart({ ok: true, reason: verdict.reason });
  }

  /**
   * Open the PCM stream to the engine's own dial-in block.
   * Everything is validated BEFORE any socket exists: an http(s) origin, a
   * launch token of real length, an absolute path. Loopback is required for
   * local engines; a LAN host is allowed ONLY when main confirmed a network
   * engine AND the caller asked for where:'network'. The queue is left alone
   * — frames buffered while the invoke was in flight flush when it opens.
   *
   * @param {{endpoint: string, token: string, path?: string, remote?: boolean}|null} config
   * @param {{allowRemote?: boolean}} [options]
   * @returns {{ ok: boolean, reason?: string }}
   */
  function dial(config, { allowRemote = false } = {}) {
    if (!config || typeof config !== 'object') {
      return { ok: false, reason: 'no-dial-config' };
    }
    const { endpoint, token, path } = config;
    if (typeof endpoint !== 'string' || !endpoint.trim()) {
      return { ok: false, reason: 'missing-endpoint' };
    }
    if (typeof token !== 'string' || token.length < 16) {
      return { ok: false, reason: 'missing-token' };
    }
    if (typeof path !== 'string' || !path.startsWith('/')) {
      return { ok: false, reason: 'missing-path' };
    }
    // http(s) origin only, no embedded credentials/query (the token has its
    // own parameter below). A LAN URL is never accepted from a local start.
    if (!/^https?:\/\//i.test(endpoint.trim()) || /[@?#]/.test(endpoint.trim())) {
      return { ok: false, reason: 'invalid-endpoint' };
    }
    const host = hostnameOfEndpoint(endpoint);
    if (!host) return { ok: false, reason: 'invalid-endpoint' };

    const remote = allowRemote === true && config.remote === true;
    if (!remote && !isLoopbackHost(host)) {
      // Local mode keeps the old defense-in-depth gate untouched.
      return { ok: false, reason: 'non-loopback-endpoint' };
    }

    const SocketCtor = WebSocketImpl || globalThis.WebSocket;
    if (typeof SocketCtor !== 'function') {
      return { ok: false, reason: 'websocket-unavailable' };
    }

    // ws://<host:port><path>?token=<token> — the scheme swap is the
    // whole URL rewrite; the token is a query parameter (plan 7.1).
    const wsUrl =
      `${endpoint.trim().replace(/\/+$/, '')
        .replace(/^http:/i, 'ws:')
        .replace(/^https:/i, 'wss:')}` +
      `${path}?${WS_TOKEN_PARAM}=${encodeURIComponent(token)}`;

    try {
      socket = new SocketCtor(wsUrl);
      dialedRemote = remote;
    } catch {
      socket = null;
      state = 'idle';
      return { ok: false, reason: 'dial-failed' };
    }

    socket.onopen = () => {
      state = 'open';
      // Flush the bounded queue, oldest first, then forget it.
      const pending = queue;
      queue = [];
      for (const frame of pending) {
        try {
          socket.send(frame);
        } catch {
          dropped += 1;
        }
      }
    };

    socket.onmessage = (event) => {
      const raw = event?.data;
      if (typeof raw !== 'string') {
        // Downstream is JSON text only; binary is not in the contract.
        invalid += 1;
        return;
      }
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        invalid += 1;
        return;
      }
      const verdict = validateMessage(message);
      if (!verdict.ok) {
        // Drop: a contract violation never reaches the rail.
        invalid += 1;
        return;
      }
      if (typeof onMessage === 'function') onMessage(message);
      // A remote engine has no IPC relay. Feed validated messages to the
      // rail's runtime subscriber instead of inventing a second path.
      if (dialedRemote) dispatchRemoteMessage(message);
    };

    socket.onerror = () => {
      // Error events carry no code; the close that follows records one.
    };

    socket.onclose = (event) => {
      lastErrorCode = typeof event?.code === 'number' ? event.code : ABNORMAL_CLOSE_CODE;
      // A closing socket's backlog is stale audio — counted, resent never.
      dropped += queue.length;
      queue = [];
      state = 'idle';
      socket = null;
      if (dialedRemote) clearRemoteHealth();
    };

    return { ok: true, reason: 'dialed' };
  }

  /**
   * Teardown: close the socket, clear the queue, detach every
   * listener — synchronously, so pagehide does not depend on a
   * promise — then invoke `speech:stop` exactly once per start
   * (the startedEngine guard: a second stop, from whichever
   * teardown path lands last, invokes nothing). Idempotent;
   * never throws. After stop(), the transport is 'idle' and
   * dials nothing until start() is called again (there is no
   * auto-reconnect — only speech:start restarts the engine).
   *
   * @returns {Promise<{ ok: boolean, stopped?: boolean, reason?: string }>}
   */
  async function stop() {
    // Any start() whose invoke is still in flight must not dial
    // afterwards (see `generation`).
    generation += 1;
    const stopStartedAt = Date.now();
    const finishStop = (outcome) => {
      diagInfo('engine', 'transport stop settled', {
        ok: outcome?.ok === true,
        stopped: outcome?.stopped ?? null,
        reason: outcome?.reason ?? null,
        durationMs: Date.now() - stopStartedAt,
      });
      return outcome;
    };
    const mySession = session;
    const active = socket;
    const wasRemote = dialedRemote;
    socket = null;
    dialedRemote = false;
    if (wasRemote) clearRemoteHealth();
    state = 'idle';
    dropped += queue.length;
    queue = [];
    if (active) {
      // Detach first: no handler may run during or after close(),
      // and nothing dangles on a socket nobody references.
      active.onopen = null;
      active.onmessage = null;
      active.onerror = null;
      active.onclose = null;
      try {
        active.close();
      } catch {
        /* already gone */
      }
    }

    if (!startedEngine) return finishStop({ ok: true, stopped: false });
    startedEngine = false;

    // Production only: closing the socket is what asks the real engine to
    // finalize its last segment. Give it a bounded window to emit that
    // `final` (relayed over the supervisor's IPC channel) before the engine
    // process is killed. Without this, a short phrase followed by Stop
    // produced no transcript at all.
    if (useSpeechStore.getState().engineMode !== 'test') {
      await delay(FLUSH_GRACE_MS);
      if (session !== mySession) {
        // A newer start() is bringing the engine up; it owns the process now.
        return finishStop({ ok: true, stopped: false, reason: 'superseded' });
      }
    }

    const speech = speechBridge();
    if (!speech || typeof speech.stop !== 'function') {
      return finishStop({ ok: true, stopped: true });
    }
    try {
      await speech.stop();
      return finishStop({ ok: true, stopped: true });
    } catch {
      // Fail soft: the engine supervisor also tears down on
      // app quit and on its own crash paths.
      return finishStop({ ok: false, reason: 'speech-stop-failed' });
    }
  }

  /**
   * Hand one PCM frame to the engine. Accepts the worklet's Int16Array
   * as-is (one binary frame, no envelope). While the socket opens the
   * frame buffers in the bounded drop-oldest ring; past the bound the
   * OLDEST frame ages out and the drop is counted. Returns true when
   * the frame was accepted (sent or queued), false when it was
   * dropped. Never throws.
   *
   * @param {Int16Array} pcm exactly SAMPLES_PER_FRAME samples
   * @returns {boolean}
   */
  function send(pcm) {
    if (state === 'open' && socket) {
      try {
        socket.send(pcm);
        return true;
      } catch {
        dropped += 1;
        return false;
      }
    }
    if (state !== 'connecting') {
      // Not dialing: nothing to buffer. Counted, never sent.
      dropped += 1;
      return false;
    }
    if (queue.length >= MAX_QUEUED_FRAMES) {
      queue.shift(); // drop-oldest: keep the freshest audio
      dropped += 1;
    }
    queue.push(pcm);
    return true;
  }

  /**
   * Counts and codes only — never audio, never the token.
   *
   * @returns {{state: string, lastErrorCode: number|null,
   *             dropped: number, invalid: number, queued: number}}
   */
  function getDiagnostics() {
    return { state, lastErrorCode, dropped, invalid, queued: queue.length };
  }

  /** Is the socket open right now? */
  const isOpen = () => state === 'open';

  return { start, stop, send, getDiagnostics, isOpen };
}

// One engine transport per app: every useAudioCapture instance shares
// it, so one engine session means one WebSocket, however many
// components mounted the hook. Created on first use — the module
// performs no I/O at import time.
let sharedTransport = null;

/** The app-wide engine transport (created lazily, never at import). */
export function getEngineTransport() {
  if (!sharedTransport) {
    sharedTransport = createEngineTransport();
  }
  return sharedTransport;
}

export default getEngineTransport;
