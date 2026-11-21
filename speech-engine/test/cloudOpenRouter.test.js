/**
 * speech-engine/test/cloudOpenRouter.test.js — the OpenRouter/Gemini lane.
 *
 * No key and no network. Fake fetch pins the documented Responses API shape:
 * POST /api/v1/responses, base64 input_audio WAV, output_text parse, and the
 * same stable failure taxonomy as the OpenAI lane.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { fork, spawnSync } from 'node:child_process';
import {
  createCloudOpenRouterEngine,
  resolveCloudConfig,
  CLOUD_ENDPOINT,
  CLOUD_MODELS,
  DEFAULT_CLOUD_MODEL,
} from '../drivers/cloudOpenRouter.js';
import { validateMessage, TOKEN_HEADER, ENGINE_ROUTES } from '../../shared/speech/protocol.js';

const KEY = 'sk-or-test-NEVER-LOG-THIS';
const TRANSCRIPT = 'The OpenRouter transcript must not be logged';
const SAMPLE = 0x4a21;

function frame() {
  const buf = Buffer.alloc(3200);
  for (let i = 0; i + 1 < buf.length; i += 2) buf.writeInt16LE(SAMPLE, i);
  return buf;
}

function responsesPayload(text = TRANSCRIPT) {
  return {
    id: 'gen-test',
    object: 'response',
    status: 'completed',
    model: DEFAULT_CLOUD_MODEL,
    output: [{
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
    }],
  };
}

function okFetch(text = TRANSCRIPT) {
  return async (url, init) => {
    okFetch.calls.push({ url, init });
    return { ok: true, status: 200, json: async () => responsesPayload(text) };
  };
}
okFetch.calls = [];

function engine(fetchImpl = okFetch(), model) {
  return createCloudOpenRouterEngine({ apiKey: KEY, model, fetchImpl });
}

test('only verified OpenRouter GEMINI model ids are accepted', () => {
  assert.deepEqual(CLOUD_MODELS, ['google/gemini-2.5-flash', 'google/gemini-3.8-flash']);
  assert.throws(() => resolveCloudConfig({ provider: 'openai', apiKey: KEY }), (e) => e.code === 'cloud-provider-not-supported');
  assert.throws(() => resolveCloudConfig({ provider: 'openrouter', apiKey: '' }), (e) => e.code === 'cloud-key-missing');
  assert.throws(() => resolveCloudConfig({ provider: 'openrouter', apiKey: KEY, model: 'whisper-1' }), (e) => e.code === 'cloud-model-not-supported');
  assert.equal(resolveCloudConfig({ provider: 'openrouter', apiKey: KEY }).model, DEFAULT_CLOUD_MODEL);
});

test('engine contract matches the local drivers', () => {
  const e = engine();
  assert.equal(e.kind, 'cloud');
  assert.equal(e.backend, 'cloud-openrouter');
  assert.equal(e.health().provider, 'openrouter');
  assert.deepEqual(e.models().map((m) => m.id), [...CLOUD_MODELS]);
  const created = e.createSession({});
  assert.equal(validateMessage(created.messages[0]).ok, true);
  assert.equal(e.hasSession(created.session.sessionId), true);
  assert.equal(e.closeSession(created.session.sessionId), true);
  e.close();
});

test('request uses OpenRouter Responses API with base64 input_audio WAV', async () => {
  okFetch.calls.length = 0;
  const e = engine(okFetch(), 'google/gemini-3.8-flash');
  const result = await e.transcribe({ frames: [frame()] });
  const final = result.messages.find((m) => m.t === 'final');
  assert.equal(final.text, TRANSCRIPT);
  assert.equal(validateMessage(final).ok, true);
  assert.ok(final.tEndMs > final.tStartMs);

  const call = okFetch.calls[0];
  assert.equal(call.url, CLOUD_ENDPOINT);
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(call.init.headers, {
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
  });
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, 'google/gemini-3.8-flash'); // passed through, not rewritten
  assert.equal(body.stream, false);
  const content = body.input[0].content;
  assert.equal(content[0].type, 'input_text');
  assert.equal(content[1].type, 'input_audio');
  assert.equal(content[1].input_audio.format, 'wav');
  const wav = Buffer.from(content[1].input_audio.data, 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readInt16LE(44), SAMPLE);
  assert.ok(call.init.signal);
  e.close();
});

test('output_text parts become the transcript; empty or malformed answers refuse', async () => {
  const e1 = engine(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      output: [{ content: [
        { type: 'output_text', text: 'Grace and truth' },
        { type: 'output_text', text: 'for every season' },
      ] }],
    }),
  }));
  const first = await e1.transcribe({ frames: [frame()] });
  assert.equal(first.messages.find((m) => m.t === 'final').text, 'Grace and truth\nfor every season');
  e1.close();

  for (const payload of [{ output: [] }, { output: [{ content: [{ type: 'output_text', text: '   ' }] }] }]) {
    const e = engine(async () => ({ ok: true, status: 200, json: async () => payload }));
    const result = await e.transcribe({ frames: [frame()] });
    assert.equal(result.messages.find((m) => m.t === 'error')?.code, 'cloud-bad-response');
    e.close();
  }
});

test('auth, rate, server, network and unknown failures map to stable codes', async () => {
  for (const [status, code] of [[401, 'cloud-auth-invalid'], [403, 'cloud-auth-invalid'], [429, 'cloud-rate-limited'], [503, 'cloud-provider-unavailable'], [400, 'cloud-request-failed']]) {
    const e = engine(async () => ({ ok: false, status, json: async () => ({ error: { message: `secret ${KEY}` } }) }));
    const result = await e.transcribe({ frames: [frame()] });
    const err = result.messages.find((m) => m.t === 'error');
    assert.equal(err.code, code);
    assert.equal(validateMessage(err).ok, true);
    assert.ok(!JSON.stringify(result).includes(KEY));
    e.close();
  }

  const net = engine(async () => { throw new Error(`connect ${KEY} failed`); });
  assert.equal((await net.transcribe({ frames: [frame()] })).messages.find((m) => m.t === 'error').code, 'cloud-network-error');
  net.close();

  const empty = engine();
  assert.deepEqual((await empty.transcribe({ frames: [] })).messages, []);
  empty.close();
});

// --- entry point ------------------------------------------------------------

const ENTRY = fileURLToPath(new URL('../index.js', import.meta.url));
const BASE_ENV = {
  ...process.env,
  LD_SPEECH_TOKEN: 'test-token-with-at-least-16-chars',
  LD_SPEECH_HOST: '127.0.0.1',
  LD_SPEECH_PORT: '0',
};

test('engine entry refuses OpenRouter without a key or with a wrong model', () => {
  const missing = spawnSync(process.execPath, [ENTRY, '--engine=cloud', '--cloud-provider=openrouter'], {
    env: BASE_ENV,
    encoding: 'utf8',
  });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /OpenRouter API key is required/);
  assert.ok(!`${missing.stdout}${missing.stderr}`.includes(KEY));

  const wrongModel = spawnSync(process.execPath, [ENTRY, '--engine=cloud', '--cloud-provider=openrouter', '--cloud-model=whisper-1'], {
    env: { ...BASE_ENV, LD_SPEECH_CLOUD_KEY: KEY },
    encoding: 'utf8',
  });
  assert.equal(wrongModel.status, 2);
  assert.match(wrongModel.stderr, /Unknown OpenRouter model/);
});

test('engine entry starts the OpenRouter driver with no local binary', async () => {
  const child = fork(ENTRY, ['--engine=cloud', '--port=0', '--host=127.0.0.1'], {
    env: {
      ...BASE_ENV,
      LD_SPEECH_CLOUD_PROVIDER: 'openrouter',
      LD_SPEECH_CLOUD_KEY: 'sk-or-no-network',
      LD_SPEECH_CLOUD_MODEL: DEFAULT_CLOUD_MODEL,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('engine did not become ready')), 8000);
      child.on('message', (m) => { if (m?.status === 'ready') { clearTimeout(timer); resolve(m); } });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exited ${code}: ${stderr}`)); });
    });
    const response = await fetch(`http://127.0.0.1:${ready.port}${ENGINE_ROUTES.health.path}`, {
      headers: { [TOKEN_HEADER]: BASE_ENV.LD_SPEECH_TOKEN },
    });
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.backend, 'cloud-openrouter');
    assert.equal(health.model, DEFAULT_CLOUD_MODEL);
    assert.ok(!JSON.stringify(health).includes('sk-or-no-network'));
  } finally {
    child.kill('SIGTERM');
  }
});
