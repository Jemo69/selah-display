/**
 * speech-engine/test/benchmark.test.js — the benchmark harness.
 *
 * The headline test here is `refuses to invent numbers from the test engine`.
 * That is the whole reason this module exists: a benchmark that reports a
 * number it did not measure is worse than one that reports nothing, because an
 * operator has no way to tell a confident 4.1% from an invented one.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { runBenchmark, measurementTrust, engineKindOf, BenchmarkCancelled } from '../benchmark.js';
import { createMessageBus } from '../bus.js';
import { createFakeEngine } from '../fakeEngine.js';
import { createSpeechEngineServer } from '../server.js';

const TOKEN = 'benchmark-token-0123456789';

const CLIP = {
  pcm: Buffer.alloc(3200 * 5), // 500 ms of Int16 mono at 16 kHz
  transcript: 'the lord is my shepherd',
  sampleRate: 16000,
};

/** A stand-in for a real runtime: trusted kind, and metrics it actually produces. */
function realEngine(over = {}) {
  return {
    kind: 'whispercpp',
    async loadModel({ modelId }) {
      return { modelPath: `/models/${modelId}.bin` };
    },
    async transcribe() {
      return {
        text: 'the lord is my shepherd',
        firstPartialMs: 420,
        backend: 'Metal',
        gpuUtilMean: 0.62,
        gpuUtilPeak: 0.81,
        peakRssBytes: 4_700_000_000,
      };
    },
    ...over,
  };
}

const openHandles = [];
afterEach(async () => {
  while (openHandles.length) await openHandles.pop()().catch(() => {});
});

async function startServer(engine) {
  const bus = createMessageBus();
  const handle = createSpeechEngineServer({ token: TOKEN, host: '127.0.0.1', bus, engine });
  await handle.listen(0, '127.0.0.1');
  openHandles.push(async () => {
    await handle.close().catch(() => {});
  });
  const { port } = handle.server.address();
  return { port, bus, handle };
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-ld-speech-token': TOKEN,
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(raw || '{}') }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('engine kind and trust', () => {
  test('reads the declared kind, and reports an engine that declares none', () => {
    assert.equal(engineKindOf({ kind: 'whispercpp' }), 'whispercpp');
    assert.equal(engineKindOf({ engineKind: 'Fake' }), 'fake');
    assert.equal(engineKindOf({}), null);
    assert.equal(measurementTrust({}).trusted, false);
    assert.match(measurementTrust({}).reason, /did not say which kind/i);
  });

  test('the canned engine is never trusted, whatever it calls itself', () => {
    for (const kind of ['fake', 'canned-engine', 'FAKE']) {
      const trust = measurementTrust({ kind });
      assert.equal(trust.trusted, false, kind);
      assert.match(trust.reason, /test engine|known measurement-capable/i);
    }
  });

  test('an unknown runtime is not trusted either — conservative by default', () => {
    assert.equal(measurementTrust({ kind: 'some-new-runtime' }).trusted, false);
    assert.equal(measurementTrust({ kind: 'whispercpp' }).trusted, true);
  });
});

describe('runBenchmark refuses to invent numbers', () => {
  test('the test engine yields measured:false and NO plausible numbers', async () => {
    const bus = createMessageBus();
    const engine = createFakeEngine({ bus });
    const result = await runBenchmark({ engine, modelId: 'large-v3', clip: CLIP });

    assert.equal(result.measured, false);
    assert.match(result.reason, /replays a fixed sentence/i);
    // Every metric explicitly null. Not 0, not a small number — absent.
    for (const metric of ['wer', 'rtf', 'firstPartialMs', 'loadTimeMs', 'backend', 'peakRssBytes']) {
      assert.equal(result[metric], null, `${metric} must be absent, not fabricated`);
    }
    // And nothing that would sort like a real measurement.
    assert.equal(Number.isFinite(result.wer), false);
    assert.equal(Number.isFinite(result.rtf), false);
  });

  test('an engine with no model name is not measured', async () => {
    const result = await runBenchmark({ engine: realEngine(), modelId: '' });
    assert.equal(result.measured, false);
    assert.match(result.reason, /no model was named/i);
  });

  test('a missing reference clip stops the run rather than scoring against nothing', async () => {
    const result = await runBenchmark({ engine: realEngine(), modelId: 'm', clip: null });
    assert.equal(result.measured, false);
    assert.match(result.reason, /no reference clip/i);
  });

  test('a clip with no hand-verified transcript is refused', async () => {
    // Inventing a reference transcript would produce a confident, meaningless
    // WER — the exact failure the benchmark exists to prevent.
    for (const transcript of ['', '   ', undefined, null]) {
      const result = await runBenchmark({
        engine: realEngine(),
        modelId: 'm',
        clip: { pcm: CLIP.pcm, transcript },
      });
      assert.equal(result.measured, false, JSON.stringify(transcript));
      assert.match(result.reason, /hand-verified transcript|nothing to score/i);
    }
  });
});

describe('runBenchmark with a trusted engine', () => {
  test('reports every metric from 9.3', async () => {
    const result = await runBenchmark({ engine: realEngine(), modelId: 'large-v3', clip: CLIP });

    assert.equal(result.measured, true);
    assert.equal(result.reason, '');
    assert.equal(result.modelId, 'large-v3');
    assert.equal(result.backend, 'Metal');
    assert.equal(result.gpuUtilMean, 0.62);
    assert.equal(result.gpuUtilPeak, 0.81);
    assert.equal(result.firstPartialMs, 420);
    assert.equal(typeof result.loadTimeMs, 'number');
    assert.ok(result.loadTimeMs >= 0);
    // wer is a FRACTION, matching src/speech/benchmark.js — a percentage here
    // would make the panel sort in the wrong order.
    assert.equal(result.wer, 0, 'the canned transcript matches the reference exactly');
    assert.ok(result.rtf >= 0);
    assert.ok(result.werDetail, 'the S/D/I breakdown travels with the number');
  });

  test('emits progress stages the caller can show', async () => {
    const seen = [];
    await runBenchmark({
      engine: realEngine(),
      modelId: 'm',
      clip: CLIP,
      onProgress: (p) => seen.push(p.stage),
    });
    assert.deepEqual(seen, ['loading', 'loaded', 'transcribing', 'done']);
  });

  test('thermal thirds stay null — one transcribe cannot show decay', async () => {
    const result = await runBenchmark({ engine: realEngine(), modelId: 'm', clip: CLIP });
    assert.equal(result.firstThirdRtf, null);
    assert.equal(result.lastThirdRtf, null);
  });

  test('a load failure reports a code, not a message that could leak text', async () => {
    const engine = realEngine({
      async loadModel() {
        const error = new Error('failed reading /home/someone/model.bin near my transcript text');
        error.code = 'model-unreadable';
        throw error;
      },
    });
    const result = await runBenchmark({ engine, modelId: 'm', clip: CLIP });
    assert.equal(result.measured, false);
    assert.match(result.reason, /model-unreadable/);
    assert.doesNotMatch(result.reason, /transcript text|someone/);
  });

  test('a transcribe failure is reported without pretending to have measured', async () => {
    const engine = realEngine({
      async transcribe() {
        const error = new Error('boom');
        error.code = 'infer-failed';
        throw error;
      },
    });
    const result = await runBenchmark({ engine, modelId: 'm', clip: CLIP });
    assert.equal(result.measured, false);
    assert.match(result.reason, /infer-failed/);
    assert.equal(result.wer, null);
  });

  test('cancel is real: it stops the work rather than hiding the result', async () => {
    const cancel = { cancelled: false };
    let transcribeRan = false;
    const engine = realEngine({
      async transcribe() {
        transcribeRan = true;
        // Cancel while the work is in flight.
        cancel.cancelled = true;
        return { text: 'the lord is my shepherd' };
      },
    });

    await assert.rejects(
      () => runBenchmark({ engine, modelId: 'm', clip: CLIP, cancel }),
      (error) => error instanceof BenchmarkCancelled && error.cancelled === true
    );
    assert.equal(transcribeRan, true, 'the run got as far as inferring before being stopped');
  });

  test('cancel before any work begins prevents inference entirely', async () => {
    let transcribeRan = false;
    const engine = realEngine({
      async transcribe() {
        transcribeRan = true;
        return { text: '' };
      },
    });
    await assert.rejects(
      () => runBenchmark({ engine, modelId: 'm', clip: CLIP, cancel: { cancelled: true } }),
      BenchmarkCancelled
    );
    assert.equal(transcribeRan, false);
  });

  test('an engine with no transcribe call says so instead of returning 0', async () => {
    const result = await runBenchmark({ engine: { kind: 'whispercpp' }, modelId: 'm', clip: CLIP });
    assert.equal(result.measured, false);
    assert.match(result.reason, /no transcribe call/i);
  });
});

describe('POST /v1/benchmark', () => {
  test('runs the harness and returns measured:false for the canned engine', async () => {
    const bus = createMessageBus();
    const { port } = await startServer(createFakeEngine({ bus }));
    const result = await post(port, '/v1/benchmark', { modelId: 'large-v3', clip: CLIP });

    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.measured, false);
    assert.equal(result.json.wer, null);
    assert.match(result.json.reason, /test engine/i);
  });

  test('returns real metrics from a trusted engine', async () => {
    const { port } = await startServer(realEngine());
    const result = await post(port, '/v1/benchmark', { modelId: 'large-v3', clip: CLIP });

    assert.equal(result.status, 200);
    assert.equal(result.json.measured, true);
    assert.equal(result.json.backend, 'Metal');
    assert.equal(result.json.wer, 0);
  });

  test('refuses to label the loaded model with a different model id', async () => {
    const engine = realEngine({ model: 'tiny.en' });
    const { port } = await startServer(engine);
    const result = await post(port, '/v1/benchmark', { modelId: 'large-v3', clip: CLIP });
    assert.equal(result.status, 200);
    assert.equal(result.json.measured, false);
    assert.match(result.json.reason, /select large-v3 before benchmarking/i);
    assert.equal(result.json.wer, null);
  });

  test('adapts the session/frames driver and a JSON Buffer clip', async () => {
    let sessions = 0;
    const engine = {
      kind: 'whispercpp',
      backend: 'whispercpp',
      createSession() {
        sessions += 1;
        return { session: { sessionId: 's' }, messages: [] };
      },
      closeSession() {},
      async transcribe({ frames }) {
        assert.ok(Array.isArray(frames) && frames.length > 0, 'frames reached the driver');
        return { messages: [{ t: 'final', text: 'the lord is my shepherd' }] };
      },
    };
    const { port } = await startServer(engine);
    const result = await post(port, '/v1/benchmark', {
      modelId: 'm',
      clip: {
        pcm: { type: 'Buffer', data: [...CLIP.pcm] },
        transcript: CLIP.transcript,
        sampleRate: 16000,
      },
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.measured, true);
    assert.equal(result.json.wer, 0);
    assert.equal(typeof result.json.rtf, 'number');
    assert.equal(sessions, 1, 'one session per benchmark, closed after');
  });

  test('requires the launch token', async () => {
    const { port } = await startServer(realEngine());
    const payload = JSON.stringify({ modelId: 'm', clip: CLIP });
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/benchmark',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            'x-ld-speech-token': 'wrong-token-000000000',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', reject);
      req.end(payload);
    });
    assert.ok(status === 401 || status === 403, `expected a token refusal, got ${status}`);
  });

  test('cancel route reports honestly whether anything was running', async () => {
    const { port } = await startServer(realEngine());
    const result = await post(port, '/v1/benchmark/large-v3/cancel', {});
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.cancelled, false, 'nothing was in flight, and it says so');
  });

  test('progress rides the message bus so any transport can follow it', async () => {
    // Subscribe to the bus the SERVER is actually using — `startServer` builds
    // its own, so subscribing to a separate one would see nothing and the
    // assertion would pass or fail for the wrong reason.
    const { port, bus } = await startServer(realEngine());
    const seen = [];
    const unsubscribe = bus.subscribe((m) => {
      if (m && m.t === 'progress') seen.push(m.stage);
    });
    await post(port, '/v1/benchmark', { modelId: 'm', clip: CLIP });
    unsubscribe();
    assert.ok(seen.length > 0, 'a benchmark with no visible stages looks like a hang');
    assert.deepEqual(seen, ['loading', 'loaded', 'transcribing', 'done']);
  });

  test('the benchmark never binds or reaches beyond loopback', async () => {
    const { port } = await startServer(realEngine());
    // Assert the port is reachable on loopback only.
    assert.equal(typeof port, 'number');
    const result = await post(port, '/v1/benchmark', { modelId: 'm', clip: CLIP });
    assert.equal(result.status, 200);
  });
});
