/**
 * shared/speech/protocol.js — Live Sermon Assist: the speech-engine contract (v1).
 *
 * The app talks to an out-of-process speech engine (a whisper.cpp wrapper, or
 * any other provider) through this contract and nothing else. Three surfaces:
 *
 *   1. main -> engine:      REST, see ENGINE_ROUTES / ENGINE_HTTP_METHODS
 *   2. renderer -> engine:  PCM frames, see encodePcmFrame
 *   3. engine -> renderer:  JSON messages, see validateMessage
 *
 * Compatibility rule (plan 7.5): the health response carries apiVersion. The
 * app refuses to talk to a mismatched MAJOR, warns on a mismatched MINOR, and
 * ignores unknown fields (messages are additive-only).
 *
 * This module is dependency-free and pure on purpose: no npm packages, no
 * Electron, no DOM, no node:* imports, no logging. It must be importable from
 * main, server, the renderer, and web workers, at import time, with no
 * environment assumptions.
 */

// ---------------------------------------------------------------------------
// Contract version
// ---------------------------------------------------------------------------

/** The version this build of the app speaks. */
export const SPEECH_PROTOCOL_VERSION = Object.freeze({ api: 1, minor: 0 });

// ---------------------------------------------------------------------------
// API compatibility
// ---------------------------------------------------------------------------

function isVersionNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * Normalize an engine-reported apiVersion into `{ api, minor }`.
 *
 * Accepts a bare number (major only — the minor is assumed to match ours,
 * because the engine reported nothing to mismatch) or an `{ api, minor }`
 * object. Returns `null` when the value is malformed.
 *
 * @param {number|{api:number, minor?:number}|unknown} value
 * @returns {{api:number, minor:number}|null}
 */
export function normalizeApiVersion(value) {
  if (typeof value === 'number') {
    if (!isVersionNumber(value)) return null;
    return { api: value, minor: SPEECH_PROTOCOL_VERSION.minor };
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const api = value.api;
    if (!isVersionNumber(api)) return null;
    const minor = value.minor === undefined ? SPEECH_PROTOCOL_VERSION.minor : value.minor;
    if (!isVersionNumber(minor)) return null;
    return { api, minor };
  }

  return null;
}

/**
 * Compare an engine-reported apiVersion against this build.
 *
 * - exact match ................ { ok: true,  level: 'compatible' }
 * - same major, other minor .... { ok: true,  level: 'minor-mismatch' }  -> warn, still talk
 * - different major ............ { ok: false, level: 'incompatible' }    -> refuse
 * - not a usable value .......... { ok: false, level: 'malformed' }       -> refuse
 *
 * @param {number|{api:number, minor?:number}|unknown} engineApiVersion
 * @returns {{ok:boolean, level:'compatible'|'minor-mismatch'|'incompatible'|'malformed', reason?:string}}
 */
export function checkApiCompatibility(engineApiVersion) {
  const reported = normalizeApiVersion(engineApiVersion);

  if (!reported) {
    return {
      ok: false,
      level: 'malformed',
      reason: `engine reported a malformed apiVersion: ${describeValue(engineApiVersion)}`
    };
  }

  if (reported.api !== SPEECH_PROTOCOL_VERSION.api) {
    return {
      ok: false,
      level: 'incompatible',
      reason: `engine speaks protocol api ${reported.api}, this app requires api ${SPEECH_PROTOCOL_VERSION.api}`
    };
  }

  if (reported.minor !== SPEECH_PROTOCOL_VERSION.minor) {
    return {
      ok: true,
      level: 'minor-mismatch',
      reason: `engine speaks protocol ${reported.api}.${reported.minor}, this app speaks ${SPEECH_PROTOCOL_VERSION.api}.${SPEECH_PROTOCOL_VERSION.minor}`
    };
  }

  return { ok: true, level: 'compatible' };
}

// ---------------------------------------------------------------------------
// Audio frame contract (upstream audio renderer -> engine)
// ---------------------------------------------------------------------------

/** Capture/render sample rate in Hz. 16 kHz is what the models consume. */
export const SAMPLE_RATE = 16000;
/** Mono. Sermon podium mics are mono; stereo buys nothing and costs bandwidth. */
export const CHANNELS = 1;
/** Wire format of one sample: 16-bit signed PCM, little-endian. */
export const SAMPLE_FORMAT = 'int16-le';
/** One frame is this many milliseconds of audio. */
export const FRAME_MS = 100;
/** Samples in one frame: 16000 Hz * 100 ms = 1600. */
export const SAMPLES_PER_FRAME = 1600;
/** Bytes per sample: 16-bit => 2. */
export const BYTES_PER_SAMPLE = 2;
/** Bytes per frame: 1600 samples * 2 bytes = 3200. */
export const BYTES_PER_FRAME = 3200;

/**
 * Convert a Float32 chunk (-1..1) into exactly SAMPLES_PER_FRAME Int16 samples.
 *
 * Scaling is symmetric around zero: magnitude is 32767, rounding is half away
 * from zero (plain Math.round is not, and would bias negative samples):
 *
 *   1.0  ->  32767      -1.0  -> -32767   (documented: NOT -32768, so the
 *   0.5  ->  16384      -0.5  -> -16384    mapping stays symmetric and 0.0
 *   0.0  ->      0      NaN   ->      0    maps to exactly 0)
 *
 * Values outside [-1, 1] are clamped. Non-finite samples are treated as 0.
 * Short input is zero-padded; long input is truncated to the first
 * SAMPLES_PER_FRAME samples. Pure: the input is never mutated and a fresh
 * Int16Array is returned every call.
 *
 * Note on endianness: Int16Array is host-endian. Every target this app ships
 * on (Win/mac/Linux/iOS/Android) is little-endian, so the buffer is written to
 * the wire as-is, matching SAMPLE_FORMAT = 'int16-le'.
 *
 * @param {Float32Array|ArrayLike<number>} float32Chunk
 * @returns {Int16Array} exactly SAMPLES_PER_FRAME samples
 */
export function encodePcmFrame(float32Chunk) {
  const frame = new Int16Array(SAMPLES_PER_FRAME);
  if (float32Chunk === null || float32Chunk === undefined) return frame;

  const length = typeof float32Chunk.length === 'number'
    ? Math.min(float32Chunk.length, SAMPLES_PER_FRAME)
    : 0;

  for (let i = 0; i < length; i += 1) {
    const sample = Number(float32Chunk[i]);
    if (!Number.isFinite(sample)) continue; // leave the zero already in the frame
    const clamped = sample < -1 ? -1 : (sample > 1 ? 1 : sample);
    const scaled = clamped * 32767;
    // Round half away from zero so the mapping stays symmetric: Math.round
    // rounds .5 toward +Infinity, which would turn -0.5 into -16383.
    frame[i] = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  }

  return frame;
}

/**
 * How many frames are needed to carry `ms` of audio (round up; a partial
 * frame still costs a frame on the wire). Non-finite or non-positive input
 * yields 0.
 *
 * @param {number} ms
 * @returns {number}
 */
export function frameCountForDurationMs(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / FRAME_MS);
}

// ---------------------------------------------------------------------------
// Downstream message schemas (engine -> renderer JSON, discriminated on `t`)
// ---------------------------------------------------------------------------

/** Every recognized message type, in contract order. */
export const MESSAGE_TYPES = Object.freeze([
  'ready',
  'partial',
  'final',
  'vad',
  'progress',
  'stats',
  'error'
]);

const SPEECH_STATES = Object.freeze(['speech', 'silence']);

/** `tStartMs <= tEndMs` whenever both are usable numbers. */
const TIME_RANGE_RELATION = Object.freeze({
  fields: Object.freeze(['tStartMs', 'tEndMs']),
  check: (msg) => msg.tStartMs <= msg.tEndMs,
  error: 'tStartMs must be <= tEndMs'
});

/**
 * Declarative schema table: one entry per message type.
 *
 * Field spec: { type, required?, min?, max?, values?, itemFields? }
 *   type      'string' | 'number' | 'boolean' | 'array'
 *   required  missing/null fails validation when true
 *   min/max   numeric bounds, inclusive
 *   values    allowed values (enum)
 *   itemFields  field table for each object inside an array
 *
 * Fields NOT listed here are unknown/extra and are ignored — messages are
 * additive-only, so a newer engine may send more than this build knows about.
 * Cross-field rules live in `relations` and only run when their fields are
 * present and numeric.
 */
export const MESSAGE_SCHEMAS = Object.freeze({
  ready: Object.freeze({
    fields: Object.freeze({
      sessionId: Object.freeze({ type: 'string', required: true }),
      model: Object.freeze({ type: 'string', required: true }),
      sampleRate: Object.freeze({ type: 'number', required: true, min: 1 })
    })
  }),

  partial: Object.freeze({
    fields: Object.freeze({
      sessionId: Object.freeze({ type: 'string', required: true }),
      text: Object.freeze({ type: 'string', required: true }),
      tStartMs: Object.freeze({ type: 'number', required: true, min: 0 }),
      tEndMs: Object.freeze({ type: 'number', required: true, min: 0 }),
      confidence: Object.freeze({ type: 'number', required: true, min: 0, max: 1 })
    }),
    relations: Object.freeze([TIME_RANGE_RELATION])
  }),

  final: Object.freeze({
    fields: Object.freeze({
      sessionId: Object.freeze({ type: 'string', required: true }),
      text: Object.freeze({ type: 'string', required: true }),
      tStartMs: Object.freeze({ type: 'number', required: true, min: 0 }),
      tEndMs: Object.freeze({ type: 'number', required: true, min: 0 }),
      words: Object.freeze({
        type: 'array',
        required: false,
        itemFields: Object.freeze({
          word: Object.freeze({ type: 'string', required: true }),
          startMs: Object.freeze({ type: 'number', required: true, min: 0 }),
          endMs: Object.freeze({ type: 'number', required: true, min: 0 }),
          confidence: Object.freeze({ type: 'number', required: false, min: 0, max: 1 })
        })
      })
    }),
    relations: Object.freeze([TIME_RANGE_RELATION])
  }),

  vad: Object.freeze({
    fields: Object.freeze({
      sessionId: Object.freeze({ type: 'string', required: true }),
      state: Object.freeze({ type: 'string', required: true, values: SPEECH_STATES })
    })
  }),

  progress: Object.freeze({
    fields: Object.freeze({
      taskId: Object.freeze({ type: 'string', required: true }),
      receivedBytes: Object.freeze({ type: 'number', required: true, min: 0 }),
      totalBytes: Object.freeze({ type: 'number', required: true, min: 0 }),
      mbps: Object.freeze({ type: 'number', required: true, min: 0 })
    }),
    relations: Object.freeze([
      Object.freeze({
        fields: Object.freeze(['receivedBytes', 'totalBytes']),
        check: (msg) => msg.receivedBytes <= msg.totalBytes,
        error: 'receivedBytes must be <= totalBytes'
      })
    ])
  }),

  stats: Object.freeze({
    fields: Object.freeze({
      rtf: Object.freeze({ type: 'number', required: true, min: 0 }),
      encodeMs: Object.freeze({ type: 'number', required: true, min: 0 }),
      decodeMs: Object.freeze({ type: 'number', required: true, min: 0 }),
      loadMs: Object.freeze({ type: 'number', required: true, min: 0 }),
      memoryMb: Object.freeze({ type: 'number', required: true, min: 0 }),
      backend: Object.freeze({ type: 'string', required: true })
    })
  }),

  error: Object.freeze({
    fields: Object.freeze({
      code: Object.freeze({ type: 'string', required: true }),
      message: Object.freeze({ type: 'string', required: true }),
      fatal: Object.freeze({ type: 'boolean', required: true })
    })
  })
});

/**
 * Is `type` a message type this build understands? Unknown types must be
 * ignored, never crash the consumer.
 *
 * @param {unknown} type
 * @returns {boolean}
 */
export function isRecognizedMessageType(type) {
  if (typeof type !== 'string') return false;
  return Object.prototype.hasOwnProperty.call(MESSAGE_SCHEMAS, type);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkType(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    default:
      return false;
  }
}

function describeValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function validateFields(source, fields, prefix, errors) {
  for (const name of Object.keys(fields)) {
    const spec = fields[name];
    const path = prefix ? `${prefix}.${name}` : name;
    const value = source[name];
    const present = value !== undefined && value !== null;

    if (!present) {
      if (spec.required) errors.push(`${path}: required field missing`);
      continue;
    }

    if (!checkType(value, spec.type)) {
      errors.push(`${path}: expected ${spec.type}, received ${describeValue(value)}`);
      continue;
    }

    if (spec.values && spec.values.indexOf(value) === -1) {
      errors.push(`${path}: expected one of [${spec.values.join(', ')}], received ${describeValue(value)}`);
      continue;
    }

    if (typeof value === 'number') {
      if (spec.min !== undefined && value < spec.min) {
        errors.push(`${path}: must be >= ${spec.min}, received ${value}`);
      }
      if (spec.max !== undefined && value > spec.max) {
        errors.push(`${path}: must be <= ${spec.max}, received ${value}`);
      }
    }

    if (spec.type === 'array' && spec.itemFields) {
      for (let i = 0; i < value.length; i += 1) {
        const item = value[i];
        if (!isPlainObject(item)) {
          errors.push(`${path}[${i}]: expected an object, received ${describeValue(item)}`);
          continue;
        }
        validateFields(item, spec.itemFields, `${path}[${i}]`, errors);
      }
    }
  }
}

function validateRelations(message, schema, errors) {
  const relations = schema.relations || [];
  for (const relation of relations) {
    const usable = relation.fields.every((field) => typeof message[field] === 'number');
    if (!usable) continue;
    if (!relation.check(message)) errors.push(relation.error);
  }
}

/**
 * Validate one engine -> renderer message against the v1 schema.
 *
 * Unknown extra fields are IGNORED (additive-only rule from plan 7.5), so a
 * newer engine never breaks an older app. Missing required fields, wrong
 * types, out-of-range numbers, bad enums, and broken cross-field relations
 * all produce an error string naming the offending field.
 *
 * @param {unknown} message
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateMessage(message) {
  if (!isPlainObject(message)) {
    return { ok: false, errors: [`message: expected an object, received ${describeValue(message)}`] };
  }

  const errors = [];
  const type = message.t;

  if (typeof type !== 'string') {
    errors.push(`t: expected a string message type, received ${describeValue(type)}`);
    return { ok: false, errors };
  }

  if (!isRecognizedMessageType(type)) {
    errors.push(`t: unrecognized message type ${describeValue(type)}`);
    return { ok: false, errors };
  }

  const schema = MESSAGE_SCHEMAS[type];
  validateFields(message, schema.fields, '', errors);
  validateRelations(message, schema, errors);

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// REST surface (main -> engine)
// ---------------------------------------------------------------------------

/** Route table: `{ method, path }` per endpoint. `:id` is substituted by the builders. */
export const ENGINE_ROUTES = Object.freeze({
  health: Object.freeze({ method: 'GET', path: '/v1/health' }),
  models: Object.freeze({ method: 'GET', path: '/v1/models' }),
  modelDownload: Object.freeze({ method: 'POST', path: '/v1/models/:id/download' }),
  modelDelete: Object.freeze({ method: 'DELETE', path: '/v1/models/:id' }),
  session: Object.freeze({ method: 'POST', path: '/v1/session' }),
  sessionClose: Object.freeze({ method: 'POST', path: '/v1/session/:id/close' }),
  transcribe: Object.freeze({ method: 'POST', path: '/v1/transcribe' }),
  benchmark: Object.freeze({ method: 'POST', path: '/v1/benchmark' })
});

/** HTTP method per route key (same keys as ENGINE_ROUTES). */
export const ENGINE_HTTP_METHODS = Object.freeze({
  health: 'GET',
  models: 'GET',
  modelDownload: 'POST',
  modelDelete: 'DELETE',
  session: 'POST',
  sessionClose: 'POST',
  transcribe: 'POST',
  benchmark: 'POST'
});

function encodeSegment(id) {
  return encodeURIComponent(String(id === undefined || id === null ? '' : id));
}

/** `/v1/models/<id>/download` with `<id>` percent-encoded. */
export function modelDownloadPath(id) {
  return `/v1/models/${encodeSegment(id)}/download`;
}

/** `/v1/models/<id>` with `<id>` percent-encoded. */
export function modelDeletePath(id) {
  return `/v1/models/${encodeSegment(id)}`;
}

/** `/v1/session/<id>/close` with `<id>` percent-encoded. */
export function sessionClosePath(id) {
  return `/v1/session/${encodeSegment(id)}/close`;
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

/** Header carrying the per-launch shared secret from main to the engine. */
export const TOKEN_HEADER = 'x-ld-speech-token';

/** Origins the engine accepts browser requests from (dev servers). */
export const ALLOWED_ORIGINS = Object.freeze([
  'http://127.0.0.1:4000',
  'http://localhost:4000',
  'http://127.0.0.1:5174',
  'http://localhost:5174'
]);

/**
 * Is this browser Origin allowed to speak to the engine?
 *
 * The exact list above is the fast path. The packaged app serves its renderer
 * from the loopback backend on a configurable PORT (default 4000), and a
 * side-by-side/dogfood boot uses another port. Pinning only 4000 made the WS
 * upgrade 403 in the packaged app, so the rail could listen forever with no
 * transcript. Any http(s) origin on a loopback hostname is therefore allowed:
 * the launch token is still required on every request, and a LAN origin never
 * reaches the token check.
 *
 * @param {string|undefined} origin
 * @param {readonly string[]} [allowedOrigins]
 * @returns {boolean}
 */
export function isAllowedOrigin(origin, allowedOrigins = ALLOWED_ORIGINS) {
  if (origin === undefined) return true; // non-browser client: token still gates
  if (allowedOrigins.includes(origin)) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * 32 random bytes as 64 lowercase hex characters.
 *
 * Deliberately sync and browser-safe: uses globalThis.crypto.getRandomValues
 * only — no node:crypto, so this works in the renderer, in a web worker, and
 * in Node (18+ exposes crypto on globalThis). Throws a clear Error when no
 * secure RNG is available rather than silently downgrading entropy.
 *
 * @returns {string} 64 hex chars
 * @throws {Error} when globalThis.crypto.getRandomValues is unavailable
 */
export function generateEngineToken() {
  const webCrypto = globalThis.crypto;
  if (!webCrypto || typeof webCrypto.getRandomValues !== 'function') {
    throw new Error(
      'generateEngineToken: globalThis.crypto.getRandomValues is unavailable; ' +
      'cannot generate a secure speech-engine token in this environment.'
    );
  }

  const bytes = new Uint8Array(32);
  webCrypto.getRandomValues(bytes);

  let token = '';
  for (let i = 0; i < bytes.length; i += 1) {
    token += bytes[i].toString(16).padStart(2, '0');
  }
  return token;
}

/**
 * Is `host` a loopback address? Used to decide whether an inbound engine
 * request is local (never accept engine traffic from a LAN address).
 *
 * True for `localhost`, `127.0.0.1`, any `127.x.x.x`, and `::1` — with an
 * optional `:port` and optional IPv6 brackets stripped first.
 *
 * @param {unknown} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;

  let value = host.trim().toLowerCase();
  if (!value) return false;

  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end !== -1) value = value.slice(1, end);
  } else {
    const firstColon = value.indexOf(':');
    const lastColon = value.lastIndexOf(':');
    if (firstColon !== -1 && firstColon === lastColon && /^\d+$/.test(value.slice(lastColon + 1))) {
      value = value.slice(0, firstColon);
    }
  }

  if (value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

// ---------------------------------------------------------------------------
// Endpointing (plan 7.4)
// ---------------------------------------------------------------------------

/** Minimum gap between partial transcripts pushed to the renderer. */
export const PARTIAL_INTERVAL_MS = 600;
/** Continuous silence this long finalizes the current segment. */
export const SILENCE_FINALIZE_MS = 500;
/** Hard cap: a segment is force-finalized at this length regardless of silence. */
export const HARD_SEGMENT_CAP_MS = 15000;
/** Latency target: first partial, local engine (ms from audio in). */
export const TARGET_FIRST_PARTIAL_LOCAL_MS = 1200;
/** Latency target: first partial, cloud engine (ms from audio in). */
export const TARGET_FIRST_PARTIAL_CLOUD_MS = 800;
