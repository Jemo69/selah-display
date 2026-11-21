/**
 * speech-engine/test/cloudOpenAI.test.js — the real cloud path, with no real
 * key and no network. Fake fetch is the only OpenAI the unit suite knows.
 *
 * Pins: request shape (URL, auth header, multipart WAV + model), JSON text
 * extraction, error-code mapping, engine contract, and the entry point's
 * fail-loud behaviour for a missing key / unknown provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, spawnSync } from 'node:child_process';
import {
  createCloudOpenAiEngine,
  resolveCloudConfig,
  CLOUD_ENDPOINT,
  DEFAULT_CLOUD_MODEL,
} from '../drivers/cloudOpenAI.js';
import { validateMessage, TOKEN_HEADER, ENGINE_ROUTES } from '../../shared/speech/protocol.js';

const KEY = 'sk-test-NEVER-LOG-THIS-1234';
const TRANSCRIPT = 'The secret transcript text must not be logged';
const AUDIO_MARKER = 0x4a21; // distinctive PCM sample, asserted in the WAV body

function pcmFrame() {
  const frame = Buffer.alloc(3200); // 100 ms at 16 kHz mono Int16
  for (let i = 0; i + 1 < frame.length; i += 2) frame.writeInt16LE(AUDIO_MARKER, i);
  return frame;
}

function okFetch(text = TRANSCRIPT) {
  return async (url, init) => {
    okFetch.calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ text }) };
  };
}
okFetch.calls = [];

function statusFetch(status) {
  return async () => ({
    ok: false,
    status,
    json: async () => ({ error: { message: `provider body ${KEY}` } }),
  });
}

function transcribeOnce(overrides = {}) {
  const engine = createCloudOpenAiEngine({
    apiKey: KEY,
    fetchImpl: okFetch(),
    ...overrides,
  });
  return { engine, run: () => engine.transcribe({ frames: [pcmFrame()] }) };
}

test('resolveCloudConfig refuses a missing/unknown provider and a missing key', () => {
  assert.throws(() => resolveCloudConfig({ provider: 'groq', apiKey: KEY }), (e) => e.code === 'cloud-provider-not-supported');
  assert.throws(() => resolveCloudConfig({ provider: undefined, apiKey: KEY }), (e) => e.code === 'cloud-provider-not-supported');
  assert.throws(() => resolveCloudConfig({ provider: 'openai', apiKey: '' }), (e) => e.code === 'cloud-key-missing');
  assert.throws(() => resolveCloudConfig({ provider: 'openai', apiKey: KEY, model: 'made-up' }), (e) => e.code === 'cloud-model-not-supported');
  assert.deepEqual(resolveCloudConfig({ provider: 'openai', apiKey: KEY }), {
    provider: 'openai',
    apiKey: KEY,
    model: DEFAULT_CLOUD_MODEL,
  });
});

test('engine contract is identical to the local drivers', () => {
  const { engine } = transcribeOnce();
  assert.equal(engine.kind, 'cloud');
  assert.equal(engine.backend, 'cloud-openai');
  assert.deepEqual(Object.keys(engine).sort(), [
    'backend', 'close', 'closeSession', 'createSession', 'hasSession', 'health', 'kind', 'model', 'models', 'transcribe',
  ].sort());
  assert.equal(engine.health().provider, 'openai');
  assert.equal(engine.health().keyReady, true);
  assert.equal(engine.models()[0].id, DEFAULT_CLOUD_MODEL);

  const session = engine.createSession({});
  assert.equal(engine.hasSession(session.session.sessionId), true);
  assert.equal(validateMessage(session.messages[0]).ok, true);
  assert.equal(engine.closeSession(session.session.sessionId), true);
  assert.equal(engine.hasSession(session.session.sessionId), false);
  engine.close();
});

test('success posts a WAV to OpenAI and returns a contract final segment', async () => {
  okFetch.calls.length = 0;
  const { engine, run } = transcribeOnce();
  const session = engine.createSession({});
  const result = await engine.transcribe({ sessionId: session.session.sessionId, frames: [pcmFrame()] });
  const final = result.messages.find((m) => m.t === 'final');

  assert.equal(result.sessionId, session.session.sessionId);
  assert.equal(final.text, TRANSCRIPT);
  assert.equal(validateMessage(final).ok, true, JSON.stringify(validateMessage(final)));
  assert.ok(final.tEndMs > final.tStartMs);

  const call = okFetch.calls[0];
  assert.equal(call.url, CLOUD_ENDPOINT);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, `Bearer ${KEY}`);
  assert.ok(call.init.body instanceof FormData);
  assert.equal(call.init.body.get('model'), 'whisper-1');
  const file = call.init.body.get('file');
  assert.equal(file.type, 'audio/wav');
  assert.equal(file.name, 'segment.wav');
  const wav = Buffer.from(await file.arrayBuffer());
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readInt16LE(44), AUDIO_MARKER);
  assert.ok(call.init.signal, 'a timeout signal is attached');
  engine.close();
});

test('provider errors map to stable codes without leaking the response body', async () => {
  const cases = [
    [401, 'cloud-auth-invalid'],
    [403, 'cloud-auth-invalid'],
    [429, 'cloud-rate-limited'],
    [500, 'cloud-provider-unavailable'],
    [400, 'cloud-request-failed'],
  ];
  for (const [status, code] of cases) {
    const engine = createCloudOpenAiEngine({ apiKey: KEY, fetchImpl: statusFetch(status) });
    const result = await engine.transcribe({ frames: [pcmFrame()] });
    const error = result.messages.find((m) => m.t === 'error');
    assert.equal(error.code, code);
    assert.equal(validateMessage(error).ok, true);
    assert.ok(!JSON.stringify(result).includes(KEY), 'no key in the error payload');
    assert.ok(!JSON.stringify(result).includes('provider body'), 'no provider body in the error payload');
    engine.close();
  }
});

test('a malformed or empty JSON answer is a cloud-bad-response, not a fake transcript', async () => {
  const badResponses = [
    { ok: true, status: 200, json: async () => { throw new Error('bad json'); } },
    { ok: true, status: 200, json: async () => ({}) },
    { ok: true, status: 200, json: async () => ({ text: '   ' }) },
  ];
  for (const response of badResponses) {
    const engine = createCloudOpenAiEngine({ apiKey: KEY, fetchImpl: async () => response });
    const result = await engine.transcribe({ frames: [pcmFrame()] });
    assert.equal(result.messages.find((m) => m.t === 'error')?.code, 'cloud-bad-response');
    engine.close();
  }
});

test('a transport failure becomes a generic network error', async () => {
  const engine = createCloudOpenAiEngine({
    apiKey: KEY,
    fetchImpl: async () => { throw new Error(`connect to ${KEY} failed`); },
  });
  const result = await engine.transcribe({ frames: [pcmFrame()] });
  const error = result.messages.find((m) => m.t === 'error');
  assert.equal(error.code, 'cloud-network-error');
  assert.ok(!JSON.stringify(error).includes(KEY));
  engine.close();
});

test('no frame means no request and no transcript', async () => {
  const fetchImpl = async () => { throw new Error('should not be called'); };
  const { engine } = transcribeOnce({ fetchImpl });
  assert.deepEqual((await engine.transcribe({ frames: [] })).messages, []);
  engine.close();
});

// --- entry point: loud refusals and a real cloud handshake ------------------

const ENTRY = fileURLToPath(new URL('../index.js', import.meta.url));
const BASE_ENV = {
  ...process.env,
  LD_SPEECH_TOKEN: 'test-token-with-at-least-16-chars',
  LD_SPEECH_HOST: '127.0.0.1',
  LD_SPEECH_PORT: '0',
};

test('engine entry exits 2 when the cloud key or provider is missing', () => {
  const missingKey = spawnSync(process.execPath, [ENTRY, '--engine=cloud'], {
    env: { ...BASE_ENV, LD_SPEECH_CLOUD_PROVIDER: 'openai' },
    encoding: 'utf8',
  });
  assert.equal(missingKey.status, 2);
  assert.match(missingKey.stderr, /API key is required/);
  assert.ok(!missingKey.stdout.includes(KEY));

  const badProvider = spawnSync(process.execPath, [ENTRY, '--engine=cloud'], {
    env: { ...BASE_ENV, LD_SPEECH_CLOUD_PROVIDER: 'groq', LD_SPEECH_CLOUD_KEY: KEY },
    encoding: 'utf8',
  });
  assert.equal(badProvider.status, 2);
  assert.match(badProvider.stderr, /openai and openrouter/i);
  assert.ok(!`${badProvider.stdout}${badProvider.stderr}`.includes(KEY), 'key is never printed');
});

test('engine entry starts a cloud engine with no local binary or weights', async () => {
  const child = fork(ENTRY, ['--engine=cloud', '--port=0', '--host=127.0.0.1'], {
    env: {
      ...BASE_ENV,
      LD_SPEECH_CLOUD_PROVIDER: 'openai',
      // A deliberately invalid key: this test only checks startup + health,
      // never a transcription request. No external network is touched.
      LD_SPEECH_CLOUD_KEY: 'sk-test-no-network',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('engine did not become ready')), 8000);
      child.on('message', (message) => {
        if (message?.status === 'ready') {
          clearTimeout(timer);
          resolve(message);
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`engine exited ${code}: ${stderr}`));
      });
    });
    assert.equal(ready.apiVersion !== undefined, true);
    const response = await fetch(`http://127.0.0.1:${ready.port}${ENGINE_ROUTES.health.path}`, {
      headers: { [TOKEN_HEADER]: BASE_ENV.LD_SPEECH_TOKEN },
    });
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.backend, 'cloud-openai');
    assert.equal(health.model, 'whisper-1');
    assert.equal(health.provider, 'openai');
    assert.ok(!JSON.stringify(health).includes('sk-test-no-network'), 'health never carries the key');
  } finally {
    child.kill('SIGTERM');
  }
});
