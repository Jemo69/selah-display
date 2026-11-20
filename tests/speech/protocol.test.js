/**
 * tests/speech/protocol.test.js — Live Sermon Assist Phase 0.
 *
 * Locks the shared contract: frame arithmetic, PCM encoding, the message
 * schema + validator (including the additive-only rule), API compatibility,
 * engine REST routes, security helpers, and endpointing constants.
 */
import { describe, it, expect } from 'vitest';
import {
  SPEECH_PROTOCOL_VERSION,
  checkApiCompatibility,
  normalizeApiVersion,
  isRecognizedMessageType,
  SAMPLE_RATE,
  CHANNELS,
  SAMPLE_FORMAT,
  FRAME_MS,
  SAMPLES_PER_FRAME,
  BYTES_PER_SAMPLE,
  BYTES_PER_FRAME,
  encodePcmFrame,
  frameCountForDurationMs,
  MESSAGE_TYPES,
  MESSAGE_SCHEMAS,
  validateMessage,
  ENGINE_ROUTES,
  ENGINE_HTTP_METHODS,
  modelDownloadPath,
  modelDeletePath,
  sessionClosePath,
  TOKEN_HEADER,
  ALLOWED_ORIGINS,
  isAllowedOrigin,
  generateEngineToken,
  isLoopbackHost,
  PARTIAL_INTERVAL_MS,
  SILENCE_FINALIZE_MS,
  HARD_SEGMENT_CAP_MS,
  TARGET_FIRST_PARTIAL_LOCAL_MS,
  TARGET_FIRST_PARTIAL_CLOUD_MS,
} from '../../shared/speech/protocol.js';

/** One known-good message per type — the fixture for the "every type passes" loop. */
const validMessageFor = (type) => {
  switch (type) {
    case 'ready':
      return { t: 'ready', sessionId: 'sess-1', model: 'large-v3', sampleRate: 16000 };
    case 'partial':
      return { t: 'partial', sessionId: 'sess-1', text: 'and the lord said', tStartMs: 0, tEndMs: 600, confidence: 0.82 };
    case 'final':
      return {
        t: 'final',
        sessionId: 'sess-1',
        text: 'and the lord said',
        tStartMs: 0,
        tEndMs: 600,
        words: [
          { word: 'and', startMs: 0, endMs: 90, confidence: 0.9 },
          { word: 'the', startMs: 90, endMs: 160, confidence: 0.88 },
        ],
      };
    case 'vad':
      return { t: 'vad', sessionId: 'sess-1', state: 'speech' };
    case 'progress':
      return { t: 'progress', taskId: 'dl-1', receivedBytes: 10, totalBytes: 100, mbps: 4.5 };
    case 'stats':
      return { t: 'stats', rtf: 0.25, encodeMs: 3, decodeMs: 4, loadMs: 120, memoryMb: 512, backend: 'whispercpp' };
    case 'error':
      return { t: 'error', code: 'E_MODEL_MISSING', message: 'model not found', fatal: false };
    default:
      throw new Error(`no fixture for type ${type}`);
  }
};

describe('speech protocol: version + compatibility', () => {
  it('exposes the v1 contract version', () => {
    expect(SPEECH_PROTOCOL_VERSION).toEqual({ api: 1, minor: 0 });
  });

  it('accepts an exact match', () => {
    const result = checkApiCompatibility({ api: 1, minor: 0 });
    expect(result.level).toBe('compatible');
    expect(result.ok).toBe(true);
  });

  it('refuses a mismatched major', () => {
    const result = checkApiCompatibility({ api: 2 });
    expect(result.level).toBe('incompatible');
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe('string');
  });

  it('warns but still talks on a mismatched minor', () => {
    const result = checkApiCompatibility({ api: 1, minor: 9 });
    expect(result.level).toBe('minor-mismatch');
    expect(result.ok).toBe(true);
  });

  it('marks non-numeric input malformed', () => {
    const result = checkApiCompatibility('nope');
    expect(result.level).toBe('malformed');
    expect(result.ok).toBe(false);
  });

  it('marks null/undefined/NaN/float input malformed', () => {
    expect(checkApiCompatibility(null).level).toBe('malformed');
    expect(checkApiCompatibility(undefined).level).toBe('malformed');
    expect(checkApiCompatibility(Number.NaN).level).toBe('malformed');
    expect(checkApiCompatibility(1.5).level).toBe('malformed');
    expect(checkApiCompatibility({ minor: 0 }).level).toBe('malformed');
    expect(checkApiCompatibility([]).level).toBe('malformed');
  });

  it('accepts a bare major number, assuming the minor matches', () => {
    expect(normalizeApiVersion(1)).toEqual({ api: 1, minor: 0 });
    expect(checkApiCompatibility(1).level).toBe('compatible');
    expect(checkApiCompatibility(3).level).toBe('incompatible');
  });
});

describe('speech protocol: audio frame contract', () => {
  it('pins the frame constants to their exact values', () => {
    expect(SAMPLE_RATE).toBe(16000);
    expect(CHANNELS).toBe(1);
    expect(SAMPLE_FORMAT).toBe('int16-le');
    expect(FRAME_MS).toBe(100);
    expect(SAMPLES_PER_FRAME).toBe(1600);
    expect(BYTES_PER_SAMPLE).toBe(2);
    expect(BYTES_PER_FRAME).toBe(3200);
  });

  it('keeps the constants mutually consistent', () => {
    expect(SAMPLES_PER_FRAME).toBe((SAMPLE_RATE * FRAME_MS) / 1000);
    expect(BYTES_PER_FRAME).toBe(SAMPLES_PER_FRAME * BYTES_PER_SAMPLE);
    expect(BYTES_PER_FRAME).toBe((SAMPLE_RATE * FRAME_MS * BYTES_PER_SAMPLE * CHANNELS) / 1000);
  });

  describe('encodePcmFrame', () => {
    it('maps the documented anchors', () => {
      const encoded = encodePcmFrame(new Float32Array([0.0, 1.0, -1.0, 0.5, -0.5]));
      expect(encoded[0]).toBe(0);
      expect(encoded[1]).toBe(32767);
      // Documented: -1.0 is -32767, not -32768 — the mapping stays symmetric.
      expect(encoded[2]).toBe(-32767);
      expect(encoded[3]).toBe(16384);
      expect(encoded[4]).toBe(-16384);
    });

    it('clamps out-of-range samples', () => {
      const encoded = encodePcmFrame(new Float32Array([2.0, -2.0, 1000, -1000]));
      expect(encoded[0]).toBe(32767);
      expect(encoded[1]).toBe(-32767);
      expect(encoded[2]).toBe(32767);
      expect(encoded[3]).toBe(-32767);
    });

    it('always returns exactly one frame of samples and bytes', () => {
      const encoded = encodePcmFrame(new Float32Array(SAMPLES_PER_FRAME).fill(0.25));
      expect(encoded).toBeInstanceOf(Int16Array);
      expect(encoded.length).toBe(SAMPLES_PER_FRAME);
      expect(encoded.BYTES_PER_ELEMENT).toBe(BYTES_PER_SAMPLE);
      expect(encoded.byteLength).toBe(BYTES_PER_FRAME);
      expect(encoded[0]).toBe(Math.round(0.25 * 32767));
      expect(encoded[SAMPLES_PER_FRAME - 1]).toBe(Math.round(0.25 * 32767));
    });

    it('zero-pads a short input', () => {
      const encoded = encodePcmFrame(new Float32Array([1.0, -1.0, 0.5]));
      expect(encoded.length).toBe(SAMPLES_PER_FRAME);
      expect(encoded[0]).toBe(32767);
      expect(encoded[1]).toBe(-32767);
      expect(encoded[2]).toBe(16384);
      expect(encoded[3]).toBe(0);
      expect(encoded[SAMPLES_PER_FRAME - 1]).toBe(0);
      // everything past the third sample is padding
      expect(encoded.slice(3).every((sample) => sample === 0)).toBe(true);
    });

    it('truncates a long input to the first SAMPLES_PER_FRAME samples', () => {
      const long = new Float32Array(SAMPLES_PER_FRAME + 500).fill(1.0);
      long[SAMPLES_PER_FRAME + 499] = -1.0;
      const encoded = encodePcmFrame(long);
      expect(encoded.length).toBe(SAMPLES_PER_FRAME);
      expect(encoded[SAMPLES_PER_FRAME - 1]).toBe(32767);
    });

    it('is pure: never mutates the input and returns a fresh buffer', () => {
      const input = new Float32Array([0.1, 0.2, 0.3]);
      const snapshot = Float32Array.from(input);
      const first = encodePcmFrame(input);
      const second = encodePcmFrame(input);
      expect(input).toEqual(snapshot);
      expect(first).not.toBe(second);
      expect(Array.from(first)).toEqual(Array.from(second));
    });

    it('treats non-finite samples as silence', () => {
      const encoded = encodePcmFrame(new Float32Array([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]));
      expect(encoded[0]).toBe(0);
      expect(encoded[1]).toBe(0);
      expect(encoded[2]).toBe(0);
    });

    it('returns an all-zero frame when given nothing', () => {
      const encoded = encodePcmFrame(undefined);
      expect(encoded.length).toBe(SAMPLES_PER_FRAME);
      expect(encoded.every((sample) => sample === 0)).toBe(true);
    });
  });

  describe('frameCountForDurationMs', () => {
    it('rounds partial frames up and clamps nonsense to zero', () => {
      expect(frameCountForDurationMs(0)).toBe(0);
      expect(frameCountForDurationMs(-500)).toBe(0);
      expect(frameCountForDurationMs(Number.NaN)).toBe(0);
      expect(frameCountForDurationMs(1)).toBe(1);
      expect(frameCountForDurationMs(100)).toBe(1);
      expect(frameCountForDurationMs(101)).toBe(2);
      expect(frameCountForDurationMs(1000)).toBe(10);
      expect(frameCountForDurationMs(HARD_SEGMENT_CAP_MS)).toBe(150);
    });
  });
});

describe('speech protocol: message types + validator', () => {
  it('exposes the seven contract message types', () => {
    expect(MESSAGE_TYPES).toEqual(['ready', 'partial', 'final', 'vad', 'progress', 'stats', 'error']);
    expect(Object.keys(MESSAGE_SCHEMAS)).toEqual([...MESSAGE_TYPES]);
  });

  it.each(MESSAGE_TYPES)('accepts a valid "%s" message', (type) => {
    const result = validateMessage(validMessageFor(type));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('rejects a partial message missing text, naming the field', () => {
    const message = validMessageFor('partial');
    delete message.text;
    const result = validateMessage(message);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('text'))).toBe(true);
  });

  it('rejects a bogus message type', () => {
    const result = validateMessage({ t: 'banana', sessionId: 's' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('banana'))).toBe(true);
  });

  it('rejects a non-string t and a non-object message', () => {
    expect(validateMessage({ t: 7 }).ok).toBe(false);
    expect(validateMessage({}).ok).toBe(false);
    expect(validateMessage(null).ok).toBe(false);
    expect(validateMessage('partial').ok).toBe(false);
  });

  it('ignores unknown extra fields (additive-only rule)', () => {
    const message = {
      ...validMessageFor('partial'),
      futureField: 'whatever',
      anotherOne: { nested: true },
      aThirdExtra: [1, 2, 3],
    };
    expect(validateMessage(message)).toEqual({ ok: true, errors: [] });
  });

  it('rejects an out-of-range confidence', () => {
    const result = validateMessage({ ...validMessageFor('partial'), confidence: 1.5 });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('confidence'))).toBe(true);

    expect(validateMessage({ ...validMessageFor('partial'), confidence: -0.2 }).ok).toBe(false);
  });

  it('rejects tEndMs < tStartMs', () => {
    const result = validateMessage({ ...validMessageFor('partial'), tStartMs: 1000, tEndMs: 500 });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('tEndMs') || error.includes('tStartMs'))).toBe(true);
  });

  it('rejects receivedBytes > totalBytes', () => {
    const result = validateMessage({
      t: 'progress',
      taskId: 'dl-1',
      receivedBytes: 900,
      totalBytes: 100,
      mbps: 3,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('receivedBytes'))).toBe(true);
  });

  it('rejects a bad enum, wrong types, and negatives', () => {
    expect(validateMessage({ t: 'vad', sessionId: 's', state: 'hovering' }).ok).toBe(false);
    expect(validateMessage({ ...validMessageFor('partial'), text: 42 }).ok).toBe(false);
    expect(validateMessage({ ...validMessageFor('partial'), confidence: 'high' }).ok).toBe(false);
    expect(validateMessage({ ...validMessageFor('stats'), rtf: -1 }).ok).toBe(false);
    expect(validateMessage({ ...validMessageFor('error'), fatal: 'yes' }).ok).toBe(false);
    expect(validateMessage({ ...validMessageFor('ready'), sampleRate: 0 }).ok).toBe(false);
  });

  it('validates words[] items on a final message', () => {
    const badWord = {
      t: 'final',
      sessionId: 's',
      text: 'hello',
      tStartMs: 0,
      tEndMs: 500,
      words: [{ word: 'hello', startMs: 0, endMs: 500, confidence: 2 }],
    };
    expect(validateMessage(badWord).ok).toBe(false);

    const missingWord = { ...badWord, words: [{ startMs: 0, endMs: 500 }] };
    expect(validateMessage(missingWord).ok).toBe(false);

    // words is optional at all
    const noWords = { t: 'final', sessionId: 's', text: 'hello', tStartMs: 0, tEndMs: 500 };
    expect(validateMessage(noWords).ok).toBe(true);
  });

  it('keeps isRecognizedMessageType conservative', () => {
    expect(isRecognizedMessageType('partial')).toBe(true);
    expect(isRecognizedMessageType('banana')).toBe(false);
    expect(isRecognizedMessageType('')).toBe(false);
    expect(isRecognizedMessageType(undefined)).toBe(false);
    expect(isRecognizedMessageType(42)).toBe(false);
    // prototype keys must not count as message types
    expect(isRecognizedMessageType('toString')).toBe(false);
    expect(isRecognizedMessageType('constructor')).toBe(false);
  });
});

describe('speech protocol: engine REST surface', () => {
  it('exposes the plan 7.2 route table', () => {
    expect(ENGINE_ROUTES.health).toEqual({ method: 'GET', path: '/v1/health' });
    expect(ENGINE_ROUTES.models).toEqual({ method: 'GET', path: '/v1/models' });
    expect(ENGINE_ROUTES.modelDownload).toEqual({ method: 'POST', path: '/v1/models/:id/download' });
    expect(ENGINE_ROUTES.modelDelete).toEqual({ method: 'DELETE', path: '/v1/models/:id' });
    expect(ENGINE_ROUTES.session).toEqual({ method: 'POST', path: '/v1/session' });
    expect(ENGINE_ROUTES.sessionClose).toEqual({ method: 'POST', path: '/v1/session/:id/close' });
    expect(ENGINE_ROUTES.transcribe).toEqual({ method: 'POST', path: '/v1/transcribe' });
    expect(ENGINE_ROUTES.benchmark).toEqual({ method: 'POST', path: '/v1/benchmark' });
  });

  it('keeps ENGINE_HTTP_METHODS aligned with ENGINE_ROUTES', () => {
    expect(Object.keys(ENGINE_HTTP_METHODS).sort()).toEqual(Object.keys(ENGINE_ROUTES).sort());
    for (const key of Object.keys(ENGINE_ROUTES)) {
      expect(ENGINE_HTTP_METHODS[key]).toBe(ENGINE_ROUTES[key].method);
    }
  });

  it('builds id-bearing paths and percent-encodes the id', () => {
    expect(modelDownloadPath('large-v3')).toBe('/v1/models/large-v3/download');
    expect(modelDeletePath('large-v3')).toBe('/v1/models/large-v3');
    expect(sessionClosePath('sess-1')).toBe('/v1/session/sess-1/close');
    expect(modelDownloadPath('a/b c')).toBe('/v1/models/a%2Fb%20c/download');
    expect(modelDeletePath('../../etc')).toBe('/v1/models/..%2F..%2Fetc');
  });
});

describe('speech protocol: security', () => {
  it('pins the token header and allowed origins', () => {
    expect(TOKEN_HEADER).toBe('x-ld-speech-token');
    expect(ALLOWED_ORIGINS).toEqual([
      'http://127.0.0.1:4000',
      'http://localhost:4000',
      'http://127.0.0.1:5174',
      'http://localhost:5174',
    ]);
  });

  it('accepts the packaged backend origin and any loopback port, but never a foreign origin', () => {
    // The packaged renderer is served from localhost:4000; /dogfood uses PORT.
    expect(isAllowedOrigin('http://localhost:4000')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4000')).toBe(true);
    expect(isAllowedOrigin('http://localhost:4321')).toBe(true);
    expect(isAllowedOrigin('http://evil.example.com')).toBe(false);
    expect(isAllowedOrigin('http://192.168.1.10:4000')).toBe(false);
    expect(isAllowedOrigin('file:///tmp/index.html')).toBe(false);
    expect(isAllowedOrigin(undefined)).toBe(true);
  });

  it('generates a 64-hex-char token that differs per call', () => {
    const first = generateEngineToken();
    const second = generateEngineToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });

  it('classifies loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.5')).toBe(false);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('127.0.0.1:4000')).toBe(true);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost(42)).toBe(false);
  });
});

describe('speech protocol: endpointing constants (plan 7.4)', () => {
  it('pins the documented values', () => {
    expect(PARTIAL_INTERVAL_MS).toBe(600);
    expect(SILENCE_FINALIZE_MS).toBe(500);
    expect(HARD_SEGMENT_CAP_MS).toBe(15000);
    expect(TARGET_FIRST_PARTIAL_LOCAL_MS).toBe(1200);
    expect(TARGET_FIRST_PARTIAL_CLOUD_MS).toBe(800);
  });
});
