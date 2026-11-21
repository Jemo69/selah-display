/**
 * speech-engine/test/autoModel.test.js — the START/STOP SEQUENCE, with fake
 * engines and fake models. No fork, no GPU, no weights, no CPU benchmark.
 *
 * The claim under test is narrow and load-bearing: a result is labelled with
 * a model only after that model was verified, loaded, confirmed by health, and
 * benchmarked. Anything else becomes an explicitly unmeasured row, and the
 * engine is stopped at every boundary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAutoModelSelection } from '../autoModel.js';
import { AUTO_SELECT } from '../../shared/speech/modelSelection.js';

const MODELS = [
  { id: 'big', displayName: 'big', downloadBytes: 2_000_000_000 },
  { id: 'small', displayName: 'small', downloadBytes: 100_000_000 },
];

const row = (modelId, wer, rtf) => ({ measured: true, modelId, wer, rtf, backend: 'Metal' });

/** A fake engine rig that records every boundary and can be bent per test. */
function rig({ verify = () => ({ ok: true, verified: true }), start, benchmark, stop } = {}) {
  const events = [];
  return {
    events,
    verifyModel: async (id) => {
      events.push(`verify:${id}`);
      return verify(id);
    },
    startModel: async (id) => {
      events.push(`start:${id}`);
      return start ? start(id) : { ok: true, health: { model: id } };
    },
    benchmarkModel: async (id) => {
      events.push(`benchmark:${id}`);
      return benchmark ? benchmark(id) : row(id, 0.06, 0.8);
    },
    stopModel: async () => {
      events.push('stop');
      if (stop) return stop();
    },
  };
}

test('benchmarks each installed model by actually loading it, then stops the engine', async () => {
  const fakes = rig({ benchmark: (id) => row(id, id === 'big' ? 0.05 : 0.07, id === 'big' ? 0.9 : 0.4) });
  const outcome = await runAutoModelSelection({
    candidateIds: ['big', 'small'],
    models: MODELS,
    ...fakes,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.decision.modelId, 'big');
  assert.deepEqual(outcome.verified, ['big', 'small']);
  assert.deepEqual(fakes.events, [
    'verify:big',
    'stop',
    'start:big',
    'benchmark:big',
    'stop',
    'verify:small',
    'stop',
    'start:small',
    'benchmark:small',
    'stop',
    'stop',
  ]);
  assert.equal(outcome.results.every((result) => result.measured === true), true);
  // The chosen row is the one that was actually measured for that model.
  assert.equal(outcome.decision.result.rtf, 0.9);
});

test('an unverified model is never loaded or benchmarked', async () => {
  const fakes = rig({
    verify: (id) => (id === 'big'
      ? { ok: false, code: 'digest-mismatch', message: 'digest mismatch for big' }
      : { ok: true, verified: true }),
  });
  const outcome = await runAutoModelSelection({
    candidateIds: ['big', 'small'],
    models: MODELS,
    ...fakes,
  });

  assert.equal(fakes.events.includes('start:big'), false);
  assert.equal(fakes.events.includes('benchmark:big'), false);
  assert.deepEqual(outcome.verified, ['small']);
  assert.equal(outcome.decision.modelId, 'small');
  const rejected = outcome.results.find((result) => result.modelId === 'big');
  assert.equal(rejected.measured, false);
  assert.equal(rejected.wer, null);
  assert.equal(rejected.reason, 'digest mismatch for big');
});

test('a health/model mismatch is refused rather than labelling another model\'s numbers', async () => {
  const fakes = rig({ start: (id) => (id === 'big'
    ? { ok: true, health: { model: 'small' } }
    : { ok: true, health: { model: 'small' } }) });
  const outcome = await runAutoModelSelection({
    candidateIds: ['big', 'small'],
    models: MODELS,
    ...fakes,
  });

  assert.equal(fakes.events.includes('benchmark:big'), false);
  const big = outcome.results.find((result) => result.modelId === 'big');
  assert.equal(big.measured, false);
  assert.match(big.reason, /wrong model/i);
  assert.equal(outcome.decision.modelId, 'small');
});

test('the RTF gate rejects the biggest model however good its WER', async () => {
  const fakes = rig({
    benchmark: (id) => row(id, id === 'big' ? 0.001 : 0.08, id === 'big' ? 1.8 : 0.5),
  });
  const outcome = await runAutoModelSelection({
    candidateIds: ['big', 'small'],
    models: MODELS,
    ...fakes,
  });
  assert.equal(outcome.decision.modelId, 'small');
  assert.equal(outcome.decision.code, 'selected');
  assert.equal(AUTO_SELECT.RTF_GATE, 1);
  assert.match(
    outcome.decision.rejected.find((r) => r.modelId === 'big').reason,
    /too slow/i
  );
});

test('a failed start produces an unmeasured row and the engine is stopped again', async () => {
  const fakes = rig({
    start: (id) => (id === 'big' ? { ok: false, reason: 'model-not-installed' } : { ok: true, health: { model: id } }),
  });
  const outcome = await runAutoModelSelection({
    candidateIds: ['big', 'small'],
    models: MODELS,
    ...fakes,
  });
  assert.equal(fakes.events.includes('benchmark:big'), false);
  assert.equal(outcome.results.find((r) => r.modelId === 'big').measured, false);
  assert.equal(outcome.decision.modelId, 'small');
  assert.equal(fakes.events.filter((event) => event === 'stop').length >= 4, true);
});

test('no installed candidates: nothing is started, nothing is selected', async () => {
  const fakes = rig();
  const outcome = await runAutoModelSelection({ candidateIds: [], models: MODELS, ...fakes });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'no-installed-candidates');
  assert.deepEqual(fakes.events, []);
});

test('no measured results: an honest refusal, not the catalog default', async () => {
  const fakes = rig({ benchmark: (id) => ({ measured: false, modelId: id, reason: 'engine cannot measure' }) });
  const outcome = await runAutoModelSelection({
    candidateIds: ['big', 'small'],
    models: MODELS,
    ...fakes,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.decision.modelId, null);
  assert.equal(outcome.decision.code, 'no-passing-results');
  assert.equal(outcome.results.every((result) => result.measured === false), true);
});

test('a stop failure refuses the selection instead of leaving an engine running', async () => {
  let stopCalls = 0;
  const fakes = rig({
    // Let the benchmark finish first; the POST-run boundary is the one that
    // must refuse a selection when the engine will not stop.
    stop: () => {
      stopCalls += 1;
      if (stopCalls === 2) {
        throw Object.assign(new Error('process would not die'), { code: 'stop-failed' });
      }
    },
  });
  const outcome = await runAutoModelSelection({
    candidateIds: ['big'],
    models: MODELS,
    ...fakes,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'engine-stop-failed');
  assert.equal(outcome.decision.modelId, 'big'); // math still reports what was measured
});

test('progress is emitted at each real boundary, not as a progress bar for fiction', async () => {
  const stages = [];
  const fakes = rig();
  await runAutoModelSelection({
    candidateIds: ['small'],
    models: MODELS,
    ...fakes,
    onProgress: (progress) => stages.push(progress.stage),
  });
  assert.deepEqual(stages, [
    'verifying',
    'stopping',
    'loading',
    'benchmarking',
    'done',
    'stopping',
    'stopping',
  ]);
});
