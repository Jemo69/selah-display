// @vitest-environment node
/**
 * Large-model guidance: a GPU probe makes large-v3 / turbo ELIGIBLE to be
 * measured; only a measured, non-fallback result may be recommended. CPU
 * selection stays behind the existing benchmark gate. No generic speedup.
 */
import { describe, it, expect } from 'vitest';
import {
  LARGE_MODEL_IDS,
  isLargeModel,
  modelGuidance,
  largeModelRecommendation,
  normalizeBackend,
  probeBackendOf,
} from '../../src/speech/modelGuidance.js';
import { recommendModel, assessResult } from '../../src/speech/benchmark.js';

const cudaProbe = { available: true, backend: 'cuda', cudaVersion: '12.4', reason: 'stub' };
const cpuProbe = { available: false, backend: 'cpu', reason: 'stub' };

const result = (modelId, extra = {}) => ({
  modelId,
  measured: true,
  engineKind: 'whispercpp',
  wer: 0.05,
  rtf: 0.5,
  backend: 'CUDA',
  ...extra,
});

describe('catalog-derived large model set', () => {
  it('comes from the catalog rather than a hand-copied list', () => {
    expect(LARGE_MODEL_IDS).toContain('large-v3');
    expect(LARGE_MODEL_IDS).toContain('large-v3-turbo');
    expect(LARGE_MODEL_IDS).toContain('large-v3-turbo-q8_0');
    expect(isLargeModel('base.en-q8_0')).toBe(false);
    expect(isLargeModel('large-v3')).toBe(true);
  });

  it('treats absent evidence as CPU, never as an accelerator', () => {
    expect(normalizeBackend('CUDA')).toBe('cuda');
    expect(normalizeBackend('unknown')).toBe('cpu');
    expect(probeBackendOf(null)).toBe('cpu');
    expect(probeBackendOf({ available: false, backend: 'cuda' })).toBe('cpu');
  });
});

describe('modelGuidance', () => {
  it('allows large-model benchmarking on GPU without claiming a speedup', () => {
    const guidance = modelGuidance({ gpu: cudaProbe });
    expect(guidance).toMatchObject({
      backend: 'cuda', status: 'gpu-candidate-eligible', largeCandidates: true, speedupClaimed: false,
    });
    expect(guidance.reason).toMatch(/may be benchmarked/);
    expect(guidance.reason).toMatch(/No speedup is claimed/);
  });

  it('states the build gap for Vulkan and Metal instead of pretending an asset exists', () => {
    for (const backend of ['vulkan', 'metal']) {
      const guidance = modelGuidance({ gpu: { available: true, backend } });
      expect(guidance.reason).toMatch(/local build is still needed/);
    }
  });

  it('keeps CPU benchmark-gated', () => {
    const guidance = modelGuidance({ gpu: cpuProbe });
    expect(guidance).toMatchObject({ backend: 'cpu', status: 'cpu-benchmark-gated', largeCandidates: false });
    expect(guidance.reason).toMatch(/benchmark-gated/);
  });
});

describe('largeModelRecommendation', () => {
  it('never recommends an unmeasured large model because a GPU was detected', () => {
    const verdict = largeModelRecommendation({
      result: { ...result('large-v3'), measured: false },
      gpu: cudaProbe,
      rtfPassed: false,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/has not been measured/);
  });

  it('refuses a silent CPU fallback even if the numbers were measured', () => {
    const verdict = largeModelRecommendation({
      result: result('large-v3', { backend: 'cpu' }),
      gpu: cudaProbe,
      rtfPassed: true,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/silent fallback/);
  });

  it('allows a measured CUDA result that keeps up', () => {
    expect(largeModelRecommendation({
      result: result('large-v3'), gpu: cudaProbe, rtfPassed: true,
    }).allowed).toBe(true);
  });

  it('allows a measured CPU large model only when it passed the same RTF gate', () => {
    expect(largeModelRecommendation({
      result: result('large-v3', { backend: 'CPU' }), gpu: cpuProbe, rtfPassed: true,
    }).allowed).toBe(true);
    expect(largeModelRecommendation({
      result: result('large-v3', { backend: 'CPU' }), gpu: cpuProbe, rtfPassed: false,
    }).allowed).toBe(false);
  });

  it('leaves smaller models to the ordinary gate', () => {
    expect(largeModelRecommendation({
      result: result('base.en'), gpu: cudaProbe, rtfPassed: true,
    }).allowed).toBe(true);
  });
});

describe('recommendModel with a probe', () => {
  const rows = [
    result('large-v3', { wer: 0.04, rtf: 0.8, backend: 'CUDA' }),
    result('base.en-q8_0', { wer: 0.31, rtf: 0.2, backend: 'CUDA' }),
  ];

  it('can recommend large-v3 when a GPU was selected and its measured RTF passed', () => {
    expect(recommendModel(rows, { gpu: cudaProbe }).modelId).toBe('large-v3');
  });

  it('keeps an unmeasured large-v3 benchmark-gated on a CPU machine', () => {
    const unmeasuredLarge = rows.map((row) => (row.modelId === 'large-v3'
      ? { ...row, measured: false, rtf: null, wer: null }
      : row));
    const decision = recommendModel(unmeasuredLarge, { gpu: cpuProbe });
    expect(decision.modelId).toBe('base.en-q8_0');
    expect(decision.rejected.map((row) => row.modelId)).toContain('large-v3');
  });

  it('allows a CPU large-v3 only after its own benchmark passed', () => {
    const cpuRows = rows.map((row) => ({ ...row, backend: 'CPU' }));
    expect(recommendModel(cpuRows, { gpu: cpuProbe }).modelId).toBe('large-v3');
  });

  it('rejects a silent CPU fallback in the recommendation itself', () => {
    const fallbackRows = rows.map((row) => (row.modelId === 'large-v3'
      ? { ...row, backend: 'cpu' }
      : row));
    const decision = recommendModel(fallbackRows, { gpu: cudaProbe });
    expect(decision.modelId).toBe('base.en-q8_0');
    expect(decision.rejected.find((row) => row.modelId === 'large-v3').reason).toMatch(/silent fallback/);
  });

  it('does not change the historical default when no probe is supplied', () => {
    expect(recommendModel(rows).modelId).toBe('large-v3');
  });
});

describe('CPU fallback notes', () => {
  it('does not warn about an expected CPU run, but warns about a silent fallback', () => {
    const cpuOnly = assessResult(result('tiny', { backend: 'CPU' }), { expectedAccel: false });
    expect(cpuOnly.some((note) => /GPU was never used/.test(note.reason))).toBe(false);

    const expectedGpu = assessResult(result('tiny', { backend: 'CPU' }), { expectedAccel: true });
    expect(expectedGpu.some((note) => /GPU was never used/.test(note.reason))).toBe(true);
  });
});
