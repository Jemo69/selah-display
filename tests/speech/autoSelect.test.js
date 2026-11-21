/**
 * tests/speech/autoSelect.test.js — the DECISION half of auto-selection.
 *
 * No engine, no GPU, no files: synthetic measured rows in, a defensible model
 * choice (or an honest refusal) out. The whole point is that the math can be
 * reviewed and tested without a multi-gigabyte model on the machine.
 */
import { describe, it, expect } from 'vitest';
import {
  AUTO_SELECT,
  chooseAutoModel,
  isPassingMeasurement,
  sizeBytesOf,
} from '../../shared/speech/modelSelection.js';
import { THRESHOLDS } from '../../src/speech/benchmark.js';

/** A real measured row, as speech-engine/benchmark.js returns it. */
const measured = (modelId, wer, rtf, extra = {}) => ({
  measured: true,
  modelId,
  engineKind: 'whispercpp',
  wer,
  rtf,
  backend: 'Metal',
  ...extra,
});

const model = (id, mib) => ({ id, displayName: id, downloadBytes: mib * 1024 * 1024 });

const MODELS = [
  model('large-v3', 3000),
  model('large-v3-turbo-q8_0', 1600),
  model('medium.en-q8_0', 800),
  model('tiny.en-q5_1', 50),
];
const ALL = MODELS.map((m) => m.id);

describe('the auto-selection thresholds', () => {
  it('mirror the benchmark decision thresholds instead of drifting from them', () => {
    expect(AUTO_SELECT.RTF_GATE).toBe(THRESHOLDS.RTF_GATE);
    expect(AUTO_SELECT.WER_MARGIN).toBe(THRESHOLDS.WER_MARGIN);
  });
});

describe('isPassingMeasurement', () => {
  it('requires measured:true and a finite, sub-real-time RTF', () => {
    expect(isPassingMeasurement(measured('a', 0.04, 0.99))).toBe(true);
    expect(isPassingMeasurement(measured('a', 0.04, 1.0))).toBe(false);
    expect(isPassingMeasurement(measured('a', 0.04, 1.01))).toBe(false);
    expect(isPassingMeasurement(measured('a', 0.04, null))).toBe(false);
    expect(isPassingMeasurement({ ...measured('a', 0.04, 0.5), measured: false })).toBe(false);
  });

  it('never believes numbers on an unmeasured row', () => {
    // A hand-edited store row with plausible metrics must still be refused.
    expect(isPassingMeasurement({ modelId: 'a', measured: false, wer: 0.01, rtf: 0.1 })).toBe(false);
  });
});

describe('chooseAutoModel — selection math', () => {
  it('picks the biggest model that keeps up, inside the measured WER margin', () => {
    const decision = chooseAutoModel({
      results: [
        measured('large-v3', 0.035, 1.8), // best accuracy, but cannot keep up
        measured('large-v3-turbo-q8_0', 0.041, 0.9), // biggest that passes
        measured('medium.en-q8_0', 0.048, 0.4), // inside margin, smaller
        measured('tiny.en-q5_1', 0.22, 0.1), // outside margin
      ],
      models: MODELS,
      installedModelIds: ALL,
    });
    expect(decision.ok).toBe(true);
    expect(decision.modelId).toBe('large-v3-turbo-q8_0');
    expect(decision.best.modelId).toBe('large-v3-turbo-q8_0');
    expect(decision.reason).toMatch(/0\.90x real time/);
    expect(decision.reason).toMatch(/4\.1% WER/);
    expect(decision.reason).toMatch(/largest installed model that keeps up/);
    expect(decision.rejected.map((r) => r.modelId)).toEqual(
      expect.arrayContaining(['large-v3', 'tiny.en-q5_1'])
    );
  });

  it('steps down when the biggest passing model is outside the WER margin', () => {
    const decision = chooseAutoModel({
      results: [
        measured('large-v3-turbo-q8_0', 0.075, 0.9), // 3.5 points worse
        measured('medium.en-q8_0', 0.04, 0.7),
      ],
      models: MODELS,
      installedModelIds: ALL,
    });
    expect(decision.modelId).toBe('medium.en-q8_0');
    expect(decision.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelId: 'large-v3-turbo-q8_0',
          reason: expect.stringMatching(/2\.0 points worse/),
        }),
      ])
    );
  });

  it('honours an explicit larger margin instead of inventing one', () => {
    const input = {
      results: [
        measured('large-v3-turbo-q8_0', 0.075, 0.9),
        measured('medium.en-q8_0', 0.04, 0.7),
      ],
      models: MODELS,
      installedModelIds: ALL,
    };
    expect(chooseAutoModel({ ...input, margin: 0.01 }).modelId).toBe('medium.en-q8_0');
    expect(chooseAutoModel({ ...input, margin: 0.05 }).modelId).toBe('large-v3-turbo-q8_0');
  });

  it('breaks equal size/WER ties by RTF, then by model id, deterministically', () => {
    const results = [
      measured('zeta', 0.05, 0.5),
      measured('alpha', 0.05, 0.5),
      measured('mid', 0.05, 0.3),
    ];
    const models = [model('zeta', 100), model('alpha', 100), model('mid', 100)];
    const input = { results, models, installedModelIds: ['zeta', 'alpha', 'mid'] };
    expect(chooseAutoModel(input).modelId).toBe('mid');
    expect(chooseAutoModel({ ...input, results: results.slice(0, 2) }).modelId).toBe('alpha');
  });

  it('rejects a CPU fallback when an accelerated backend was expected', () => {
    const results = [
      measured('large-v3', 0.03, 0.5, { backend: 'CPU' }),
      measured('medium.en-q8_0', 0.04, 0.6, { backend: 'CUDA' }),
    ];
    const decision = chooseAutoModel({
      results,
      models: MODELS,
      installedModelIds: ['large-v3', 'medium.en-q8_0'],
      expectedAccel: true,
    });
    expect(decision.modelId).toBe('medium.en-q8_0');
    expect(decision.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelId: 'large-v3', reason: expect.stringMatching(/CPU|cpu/) }),
      ])
    );
  });

  it('refuses a GPU claim when the engine did not report a backend', () => {
    const decision = chooseAutoModel({
      results: [measured('large-v3', 0.03, 0.5, { backend: null })],
      models: MODELS,
      installedModelIds: ['large-v3'],
      expectedAccel: true,
    });
    expect(decision.ok).toBe(false);
    expect(decision.code).toBe('no-passing-results');
  });

  it('prefers accuracy over speed when two models have the same published size', () => {
    const decision = chooseAutoModel({
      results: [measured('a', 0.02, 0.9), measured('b', 0.05, 0.1)],
      models: [model('a', 100), model('b', 100)],
      installedModelIds: ['a', 'b'],
    });
    expect(decision.modelId).toBe('a');
  });

  it('treats size metadata as informational, not as a reason to fabricate a ranking', () => {
    expect(sizeBytesOf(null)).toBe(0);
    expect(sizeBytesOf({ downloadBytes: 'huge' })).toBe(0);
    const decision = chooseAutoModel({
      results: [measured('a', 0.02, 0.5)],
      models: [],
      installedModelIds: ['a'],
    });
    expect(decision.ok).toBe(true);
    expect(decision.sizeBytes).toBe(0);
  });
});

describe('chooseAutoModel — refusals', () => {
  it('refuses with no results', () => {
    const decision = chooseAutoModel({ results: [], models: MODELS, installedModelIds: ALL });
    expect(decision).toMatchObject({ ok: false, modelId: null, code: 'no-passing-results' });
    expect(decision.reason).toMatch(/no installed model produced a measured result/i);
  });

  it('refuses with no installed candidates', () => {
    const decision = chooseAutoModel({
      results: [measured('a', 0.01, 0.1)],
      installedModelIds: [],
    });
    expect(decision).toMatchObject({ ok: false, code: 'no-installed-candidates' });
    expect(decision.reason).toMatch(/install/i);
  });

  it('never selects an uninstalled model, however good its number', () => {
    const decision = chooseAutoModel({
      results: [measured('large-v3', 0.001, 0.2), measured('tiny.en-q5_1', 0.2, 0.1)],
      models: MODELS,
      installedModelIds: ['tiny.en-q5_1'],
    });
    expect(decision.modelId).toBe('tiny.en-q5_1');
    expect(decision.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelId: 'large-v3',
          reason: expect.stringMatching(/not installed/i),
        }),
      ])
    );
  });

  it('refuses when nobody passes the RTF gate', () => {
    const decision = chooseAutoModel({
      results: [measured('a', 0.01, 1.8), measured('b', 0.02, 4)],
      models: MODELS,
      installedModelIds: ['a', 'b'],
    });
    expect(decision).toMatchObject({ ok: false, modelId: null, code: 'no-passing-results' });
    expect(decision.rejected).toHaveLength(2);
    expect(decision.reason).toMatch(/RTF below 1\.0/i);
  });

  it('refuses when the only row is an honest non-measurement', () => {
    const decision = chooseAutoModel({
      results: [
        {
          modelId: 'large-v3',
          measured: false,
          reason: 'The engine running is the test engine; no numbers were measured.',
          wer: null,
          rtf: null,
        },
      ],
      models: MODELS,
      installedModelIds: ['large-v3'],
    });
    expect(decision.ok).toBe(false);
    expect(decision.modelId).toBeNull();
    expect(decision.rejected[0].reason).toMatch(/test engine/i);
  });
});
