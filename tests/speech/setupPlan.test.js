// @vitest-environment node
/**
 * The volunteer's setup plan. No hardware, no bridge: a probe and a disk
 * snapshot decide which model we fetch and which steps are still needed.
 */
import { describe, it, expect } from 'vitest';
import {
  STARTER_MODELS,
  SETUP_STEPS,
  friendlyError,
  setupPlan,
  starterModelsAreInCatalog,
} from '../../src/speech/setupPlan.js';

const cuda = { available: true, backend: 'cuda', cudaVersion: '12.4' };
const cpu = { available: false, backend: 'cpu' };

describe('setupPlan', () => {
  it('starts from catalog model ids that really exist', () => {
    expect(starterModelsAreInCatalog()).toBe(true);
    expect(STARTER_MODELS.gpu).toBe('large-v3-turbo');
    expect(STARTER_MODELS.cpu).toBe('tiny.en-q5_1');
  });

  it('picks the serious model for a verified GPU engine, never for a probe alone', () => {
    expect(setupPlan({ gpu: cuda })).toMatchObject({
      backend: 'cuda',
      graphicsCard: false,
      modelId: 'large-v3-turbo',
      needsEngine: true,
      needsModel: true,
    });
    expect(setupPlan({ gpu: cuda, engineInstalled: true, engineBackend: 'cuda' })).toMatchObject({
      backend: 'cuda',
      graphicsCard: true,
      modelId: 'large-v3-turbo',
      needsEngine: false,
    });
    expect(setupPlan({ gpu: cpu })).toMatchObject({
      backend: 'cpu',
      graphicsCard: false,
      modelId: 'tiny.en-q5_1',
    });
    expect(setupPlan({ gpu: null }).modelId).toBe('tiny.en-q5_1');
  });

  it('keeps a CPU engine on the small model even when CUDA was detected', () => {
    const plan = setupPlan({
      gpu: cuda,
      engineInstalled: true,
      engineBackend: 'cpu',
      engineSelectionCode: 'unsupported-backend-asset',
      engineCudaVersion: '12.4',
    });
    expect(plan).toMatchObject({
      backend: 'cpu',
      modelId: 'tiny.en-q5_1',
      needsEngine: false,
    });
  });

  it('offers an in-app CUDA repair for an old CPU engine, then uses the result', () => {
    expect(setupPlan({ gpu: cuda, engineInstalled: true, engineBackend: 'cpu' })).toMatchObject({
      backend: 'cuda',
      needsEngine: true,
      modelId: 'large-v3-turbo',
    });
  });

  it('allows a later driver upgrade to repair a previously failed CUDA attempt', () => {
    const plan = setupPlan({
      gpu: { ...cuda, cudaVersion: '13.4' },
      engineInstalled: true,
      engineBackend: 'cpu',
      engineSelectionCode: 'cuda-driver-too-old',
      engineCudaVersion: '12.0',
    });
    expect(plan).toMatchObject({ needsEngine: true, modelId: 'large-v3-turbo' });
  });

  it('skips downloads that are already done but still checks the engine starts', () => {
    const plan = setupPlan({
      gpu: cuda,
      engineInstalled: true,
      engineBackend: 'cuda',
      installedIds: ['large-v3-turbo', 'tiny.en-q5_1'],
    });
    expect(plan).toMatchObject({ ready: true, needsEngine: false, needsModel: false });
    expect(plan.steps.map((step) => step.id)).toEqual(
      SETUP_STEPS.filter((step) => step.id !== 'engine' && step.id !== 'model').map((step) => step.id)
    );
    expect(plan.steps.some((step) => step.id === 'test')).toBe(true);
  });

  it('never calls a failed probe a graphics card', () => {
    expect(setupPlan({ gpu: { available: false, backend: 'cuda' } }).graphicsCard).toBe(false);
    expect(setupPlan({ gpu: { available: true, backend: 'unknown' } }).graphicsCard).toBe(false);
  });

  it('gives plain-language size and device notes, not file mechanics', () => {
    const gpuNote = setupPlan({ gpu: cuda }).sizeNote;
    const cpuNote = setupPlan({ gpu: cpu }).sizeNote;
    expect(gpuNote).toMatch(/graphics-card engine/);
    expect(cpuNote).toMatch(/31 MiB/);
    expect(setupPlan({ gpu: cpu, engineInstalled: true, engineBackend: 'cpu' }).deviceNote).toMatch(/processor/);
  });

  it('does not advertise downloads that are already installed', () => {
    const plan = setupPlan({
      gpu: cuda,
      engineInstalled: true,
      engineBackend: 'cuda',
      installedIds: ['large-v3-turbo'],
    });
    expect(plan.sizeNote).toMatch(/already installed/i);
    expect(plan.sizeNote).not.toMatch(/1\.51 GiB|650 MB/);
  });
});

describe('friendlyError', () => {
  it('shows a sentence, never a code, for known failures', () => {
    const message = friendlyError('digest-mismatch');
    expect(message).toMatch(/safety check/);
    expect(message).not.toMatch(/digest|sha|error/i);
    for (const code of ['unsupported-platform', 'download-failed', 'install-failed', 'engine-not-runnable']) {
      expect(friendlyError(code)).toMatch(/[.]$/);
    }
  });

  it('falls back to one honest sentence for an unknown code', () => {
    expect(friendlyError('some-new-code')).toMatch(/setup could not finish/i);
  });
});
