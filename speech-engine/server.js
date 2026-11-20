/**
 * speech-engine/server.js — the v1 speech-engine REST surface.
 *
 * A zero-dependency `node:http` server that implements the contract in
 * shared/speech/protocol.js (ENGINE_ROUTES) and nothing else:
 *
 *   GET    /v1/health               -> { apiVersion, model, backend, rtf, memoryMb, pid, uptimeMs }
 *   GET    /v1/models               -> { models: [...] }
 *   POST   /v1/models/:id/download  -> 501 (downloader follow-up)
 *   DELETE /v1/models/:id           -> 501 (downloader follow-up)
 *   POST   /v1/session              -> { sessionId, model, sampleRate, messages }
 *   POST   /v1/session/:id/close    -> { ok: true, sessionId }
 *   POST   /v1/transcribe           -> { sessionId, messages: [ready?, partial, final, stats] }
 *   POST   /v1/benchmark            -> 501 (benchmark follow-up)
 *
 * SECURITY — all three rules are enforced here, not by convention:
 *   1. Loopback only. The bind host is validated with isLoopbackHost() at
 *      construction AND at listen(); a non-loopback host throws.
 *   2. Origin. A request carrying an Origin header not in ALLOWED_ORIGINS is
 *      rejected with 403. No Origin (the app's main-process client, curl)
 *      is allowed — the token still gates it.
 *   3. Token. Every request must carry TOKEN_HEADER matching the per-launch
 *      secret (timing-safe compare): 401 when missing, 403 when wrong. The
 *      only exemption is the CORS preflight (OPTIONS), which browsers send
 *      BEFORE the custom header exists — it is still origin-checked.
 *
 * TRANSPORT DECISION (Phase 2): this file serves the REST surface over plain
 * HTTP only, and message-producing logic emits through bus.js — so the
 * WebSocket ingest (wsTransport.js, attached to this same http server by
 * index.js) subscribes to the bus and touches NONE of the routes above.
 * A browser client speaks both: REST for health/session control (main), a
 * raw ws://127.0.0.1 socket for PCM frames (renderer). See README.md.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import {
  SPEECH_PROTOCOL_VERSION,
  ALLOWED_ORIGINS,
  isAllowedOrigin,
  TOKEN_HEADER,
  ENGINE_ROUTES,
  ENGINE_HTTP_METHODS,
  isLoopbackHost,
} from '../shared/speech/protocol.js';
import { createMessageBus } from './bus.js';
import { createFakeEngine } from './fakeEngine.js';
import { runBenchmark, BenchmarkCancelled } from './benchmark.js';

/** The only host this engine ever binds by default. Loopback, always. */
export const DEFAULT_BIND_HOST = '127.0.0.1';

/** Maximum accepted JSON body (PCM clips travel base64-encoded). */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Reduce a host-ish value (bare host, host:port, [v6]:port, full URL) to a
 * hostname, or null when it cannot produce one.
 *
 * @param {unknown} host
 * @returns {string|null}
 */
export function hostnameOf(host) {
  const raw = typeof host === 'string' ? host.trim() : '';
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
 * Validate a bind host: loopback only, no exceptions.
 *
 * @param {unknown} host
 * @returns {string} the normalized hostname (port/brackets stripped)
 * @throws {Error} when the host is missing or not loopback.
 */
export function assertLoopbackBindHost(host) {
  const hostname = hostnameOf(host);
  if (!hostname || !isLoopbackHost(hostname)) {
    throw new Error(
      `speech-engine: refusing to bind non-loopback host ${JSON.stringify(String(host ?? ''))} — ` +
        'the engine may only listen on loopback (127.0.0.1 / localhost / ::1)'
    );
  }
  return hostname;
}

/**
 * Timing-safe token comparison (length leak is harmless; value leak is not).
 * Exported for the WebSocket upgrade in wsTransport.js, which gates on the
 * `?token=` query parameter with the SAME compare the REST header uses.
 *
 * @param {unknown} provided
 * @param {unknown} expected
 * @returns {boolean}
 */
export function tokenMatches(provided, expected) {
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function corsHeaders(origin) {
  return origin === undefined
    ? {}
    : {
        'access-control-allow-origin': origin,
        'access-control-allow-headers': `content-type, ${TOKEN_HEADER}`,
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        vary: 'Origin',
      };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error('request body too large');
        error.status = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        const error = new Error('request body is not valid JSON');
        error.status = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/** JSON transports carry Buffers as {type:'Buffer',data:[...]}; accept both. */
function pcmBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
  if (Array.isArray(value)) return Buffer.from(value);
  if (typeof value === 'string' && value.length > 0) {
    try { return Buffer.from(value, 'base64'); } catch { return Buffer.alloc(0); }
  }
  return Buffer.alloc(0);
}

/** Return benchmark-shaped PCM as contract frames (3200 bytes each). */
function pcmFrames(pcm, frameBytes = 3200) {
  const frames = [];
  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    const slice = pcm.subarray(offset, offset + frameBytes);
    frames.push(slice.length === frameBytes ? slice : Buffer.concat([slice, Buffer.alloc(frameBytes - slice.length)]));
  }
  return frames;
}

/**
 * The benchmark harness calls `transcribe({ pcm })` and expects `{ text }`.
 * The real drivers speak the session/frames contract, so adapt here rather
 * than adding a second shape to every driver. Without this, the first real
 * benchmark reported `measured:true, wer:1` because no text was ever read.
 */
function benchmarkEngineAdapter(engine) {
  if (!engine || typeof engine.transcribe !== 'function' || typeof engine.createSession !== 'function') {
    return engine;
  }
  return {
    kind: engine.kind,
    backend: engine.backend,
    ...(typeof engine.loadModel === 'function' ? { loadModel: engine.loadModel.bind(engine) } : {}),
    async transcribe({ pcm } = {}) {
      const frames = pcmFrames(pcmBuffer(pcm));
      if (frames.length === 0) return { text: '' };
      const opened = engine.createSession({});
      try {
        const result = await engine.transcribe({
          sessionId: opened.session.sessionId,
          frames,
        });
        const text = (result?.messages || [])
          .filter((message) => message?.t === 'final')
          .map((message) => message.text)
          .join(' ')
          .trim();
        return { text, backend: engine.backend };
      } finally {
        try { engine.closeSession(opened.session.sessionId); } catch { /* best effort */ }
      }
    },
  };
}

/**
 * Create the engine HTTP server.
 *
 * @param {Object} options
 * @param {string} options.token required per-launch secret checked on every
 *   request (32+ chars; `generateEngineToken()` produces 64 hex).
 * @param {string} [options.host=DEFAULT_BIND_HOST] bind host — must be loopback.
 * @param {object} [options.engine] engine implementation (defaults to fake).
 * @param {{api:number, minor:number}} [options.apiVersion] version reported
 *   by GET /v1/health (overridable so compatibility tests can fake a major).
 * @param {readonly string[]} [options.allowedOrigins]
 * @param {object} [options.bus] message bus (defaults to a fresh one).
 * @returns {{ bus: object, engine: object, server: import('node:http').Server,
 *             listen: (port?: number, host?: string) => Promise<{port:number, host:string}>,
 *             close: () => Promise<void>,
 *             address: () => {host:string, port:number}|null }}
 */
export function createSpeechEngineServer(options = {}) {
  const {
    token,
    host = DEFAULT_BIND_HOST,
    engine = null,
    apiVersion = SPEECH_PROTOCOL_VERSION,
    allowedOrigins = ALLOWED_ORIGINS,
    bus = createMessageBus(),
    server: existingServer = null,
  } = options;

  if (typeof token !== 'string' || token.length < 16) {
    throw new Error('speech-engine: a token of at least 16 characters is required (x-ld-speech-token)');
  }

  // Fails fast (and loudly) on any non-loopback host, at construction time.
  const bindHost = assertLoopbackBindHost(host);
  const activeEngine = engine || createFakeEngine({ bus });

  /**
   * Live benchmark runs, keyed by model. The value is a plain `{ cancelled }`
   * token rather than an AbortSignal so cancelling needs no plumbing through
   * the engine, and so the token is inspectable from a test.
   */
  const benchmarkCancels = new Map();

  /** One benchmark per model at a time — a second request supersedes the first. */
  const benchmarkTaskId = (modelId) => (typeof modelId === 'string' && modelId ? modelId : 'unknown');

  /** Cancel a running benchmark. Exposed so `POST /v1/benchmark/:id/cancel` can reach it. */
  const cancelBenchmark = (modelId) => {
    const token = benchmarkCancels.get(benchmarkTaskId(modelId));
    if (token) token.cancelled = true;
    return Boolean(token);
  };

  /** How many benchmarks are in flight — reported on /v1/health for the UI. */
  const runningBenchmarks = () => benchmarkCancels.size;
  const startedAt = Date.now();

  const emitAll = (messages) => {
    for (const message of messages) bus.emit(message);
    return messages;
  };

  const server = existingServer || http.createServer();

  server.on('request', (req, res) => {
    handle(req, res).catch((error) => {
      const status = typeof error?.status === 'number' ? error.status : 500;
      sendJson(res, status, {
        error: status === 500 ? 'internal-error' : 'bad-request',
        message: status === 500 ? 'speech-engine internal error' : String(error.message || 'bad request'),
      });
    });
  });

  async function handle(req, res) {
    const origin = req.headers.origin;
    const originAllowed = isAllowedOrigin(origin, allowedOrigins);

    // 1. Origin gate — before anything else, and including preflight.
    if (!originAllowed) {
      sendJson(res, 403, { error: 'origin-not-allowed' });
      return;
    }

    const url = new URL(req.url || '/', `http://${DEFAULT_BIND_HOST}`);
    const cors = corsHeaders(origin);

    // 2. CORS preflight: origin-checked, token-less by browser design.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    // 3. Token gate — every real request, no exceptions.
    const provided = req.headers[TOKEN_HEADER];
    if (provided === undefined || provided === '') {
      sendJson(res, 401, { error: 'missing-token' }, cors);
      return;
    }
    if (!tokenMatches(provided, token)) {
      sendJson(res, 403, { error: 'invalid-token' }, cors);
      return;
    }

    // 4. Routes (ENGINE_ROUTES / ENGINE_HTTP_METHODS from the contract).
    const pathname = url.pathname;

    if (pathname === ENGINE_ROUTES.health.path) {
      requireMethod(req, res, ENGINE_HTTP_METHODS.health, cors);
      if (res.writableEnded) return;
      const metrics = activeEngine.health();
      sendJson(res, 200, {
        status: 'ok',
        apiVersion,
        ...metrics,
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
      }, cors);
      return;
    }

    if (pathname === ENGINE_ROUTES.models.path) {
      requireMethod(req, res, ENGINE_HTTP_METHODS.models, cors);
      if (res.writableEnded) return;
      sendJson(res, 200, { backend: activeEngine.backend, models: activeEngine.models() }, cors);
      return;
    }

    if (pathname === ENGINE_ROUTES.session.path) {
      requireMethod(req, res, ENGINE_HTTP_METHODS.session, cors);
      if (res.writableEnded) return;
      const body = await readJsonBody(req);
      const created = activeEngine.createSession(body);
      sendJson(res, 200, {
        sessionId: created.session.sessionId,
        model: created.session.model,
        sampleRate: created.session.sampleRate,
        messages: emitAll(created.messages),
      }, cors);
      return;
    }

    const sessionClose = matchSessionClose(pathname);
    if (sessionClose) {
      requireMethod(req, res, ENGINE_HTTP_METHODS.sessionClose, cors);
      if (res.writableEnded) return;
      const closed = activeEngine.closeSession(sessionClose);
      if (!closed) {
        sendJson(res, 404, { error: 'unknown-session' }, cors);
        return;
      }
      sendJson(res, 200, { ok: true, sessionId: sessionClose, closed: true }, cors);
      return;
    }

    if (pathname === ENGINE_ROUTES.transcribe.path) {
      requireMethod(req, res, ENGINE_HTTP_METHODS.transcribe, cors);
      if (res.writableEnded) return;
      const body = await readJsonBody(req);
      let result;
      try {
        result = await activeEngine.transcribe(body);
      } catch (error) {
        if (error?.code === 'unknown-session') {
          sendJson(res, 404, { error: 'unknown-session' }, cors);
          return;
        }
        throw error;
      }
      sendJson(res, 200, {
        sessionId: result.sessionId,
        messages: emitAll(result.messages),
      }, cors);
      return;
    }

    if (matchModelDownload(pathname)) {
      requireMethod(req, res, ENGINE_HTTP_METHODS.modelDownload, cors);
      if (res.writableEnded) return;
      sendJson(res, 501, { error: 'not-implemented', feature: 'model-download' }, cors);
      return;
    }

    if (matchModelDelete(pathname)) {
      requireMethod(req, res, ENGINE_HTTP_METHODS.modelDelete, cors);
      if (res.writableEnded) return;
      sendJson(res, 501, { error: 'not-implemented', feature: 'model-delete' }, cors);
      return;
    }

    if (pathname === ENGINE_ROUTES.benchmark.path) {
      requireMethod(req, res, ENGINE_HTTP_METHODS.benchmark, cors);
      if (res.writableEnded) return;
      const body = await readJsonBody(req);
      // A JSON Buffer arrives as {type:'Buffer',data:[...]}; normalize once so
      // both audioDurationMsOf() and the adapter see a real Buffer.
      const benchmarkClip = body?.clip && typeof body.clip === 'object'
        ? { ...body.clip, pcm: pcmBuffer(body.clip.pcm) }
        : (body?.clip ?? null);
      // Phase 3: a real harness run, not a stub. `clip` carries the audio AND
      // its hand-verified transcript; a missing transcript is refused rather
      // than guessed, because scoring against an invented reference would
      // produce a confident, meaningless number.
      let outcome;
      try {
        outcome = await runBenchmark({
          engine: benchmarkEngineAdapter(activeEngine),
          modelId: body?.modelId,
          clip: benchmarkClip,
          onProgress: (progress) => {
            // Progress rides the message bus, so a subscriber on any transport
            // (WebSocket, or the parent-process mirror) sees the stages.
            //
            // `stage` is passed as a FIELD rather than spread into the message:
            // MESSAGE_SCHEMAS.progress validates strictly and knows receivedBytes /
            // totalBytes / mbps, so an extra `stage` key would be rejected — and
            // a swallowed rejection here is exactly how a benchmark would end
            // up looking like a silent hang.
            const taskId = `benchmark:${body?.modelId ?? 'unknown'}`;
            try {
              bus.emit({
                t: 'progress',
                taskId,
                receivedBytes: 0,
                totalBytes: 0,
                mbps: 0,
                stage: progress.stage,
              });
            } catch {
              /* an invalid progress message must never fail the run */
            }
          },
          cancel: (() => {
            // Create the token on first use so the cancel path and this path
            // share one object; without it, cancel would never be seen.
            const id = benchmarkTaskId(body?.modelId);
            if (!benchmarkCancels.has(id)) benchmarkCancels.set(id, { cancelled: false });
            return benchmarkCancels.get(id);
          })(),
        });
      } catch (error) {
        if (error instanceof BenchmarkCancelled || error?.cancelled) {
          sendJson(res, 200, { ok: true, cancelled: true, modelId: body?.modelId ?? null }, cors);
          return;
        }
        sendJson(res, 500, { error: 'benchmark-failed', modelId: body?.modelId ?? null }, cors);
        return;
      }
      // Release the token so a later run starts clean, and a stale cancel from
      // a previous run cannot silently kill the next one.
      benchmarkCancels.delete(benchmarkTaskId(body?.modelId));
      sendJson(res, 200, { ok: true, ...outcome }, cors);
      return;
    }

    // Cancel a running benchmark. A real stop, not a hidden result
    // (plan 9.4: "a cancel that actually stops the work").
    const matchBenchmarkCancel = compileIdRoute('/v1/benchmark/:id/cancel');
    const cancelId = matchBenchmarkCancel(pathname);
    if (cancelId) {
      requireMethod(req, res, 'POST', cors);
      if (res.writableEnded) return;
      const stopped = cancelBenchmark(cancelId);
      sendJson(res, 200, { ok: true, cancelled: stopped, modelId: cancelId }, cors);
      return;
    }

    sendJson(res, 404, { error: 'not-found' }, cors);
  }

  function requireMethod(req, res, expected, cors) {
    if (req.method === expected) return;
    res.setHeader?.('allow', expected);
    sendJson(res, 405, { error: 'method-not-allowed', expected }, cors);
  }

  // --- :id route matchers, compiled from the contract's own path templates --
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Compile `/prefix/:id/suffix` -> matcher returning the decoded id or null. */
  const compileIdRoute = (templatePath) => {
    const index = templatePath.indexOf(':id');
    if (index === -1) throw new Error(`speech-engine: route template has no :id segment: ${templatePath}`);
    const prefix = templatePath.slice(0, index);
    const suffix = templatePath.slice(index + ':id'.length);
    const pattern = new RegExp(`^${escapeRegExp(prefix)}([^/]+)${escapeRegExp(suffix)}$`);
    return (pathname) => {
      const match = pattern.exec(pathname);
      return match ? decodeURIComponent(match[1]) : null;
    };
  };

  const matchSessionClose = compileIdRoute(ENGINE_ROUTES.sessionClose.path);
  const matchModelDownload = compileIdRoute(ENGINE_ROUTES.modelDownload.path);
  const matchModelDelete = compileIdRoute(ENGINE_ROUTES.modelDelete.path);

  return {
    bus,
    engine: activeEngine,
    server,
    /**
     * Phase 3 benchmark control. `runBenchmark` is the pure entry point for
     * callers holding a clip; these are the server-side handles for cancel and
     * for reporting whether anything is currently running.
     */
    runBenchmark: (options) =>
      runBenchmark({ engine: activeEngine, ...options }),
    cancelBenchmark,
    runningBenchmarks,

    /**
     * Validate the host AGAIN (listen-time override may differ from
     * construction time) and bind. Resolves with the actual address.
     *
     * @param {number} [port=0]
     * @param {string} [listenHost=bindHost]
     */
    async listen(port = 0, listenHost = bindHost) {
      // async so a synchronous refusal surfaces as a rejected promise.
      const hostname = assertLoopbackBindHost(listenHost);
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          const address = server.address();
          resolve({ port: address.port, host: hostname });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(Number(port), hostname);
      });
    },

    close() {
      return new Promise((resolve) => {
        // Node >= 18.2: drop idle keep-alive sockets so close() finishes.
        server.closeIdleConnections?.();
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },

    address() {
      const address = server.address();
      if (!address || typeof address === 'string') return null;
      return { host: address.address, port: address.port };
    },
  };
}
