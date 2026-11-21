/**
 * src/speech/modelGuidance.js — which large models MAY be recommended, and why.
 *
 * The catalog deliberately ships large-v3 and large-v3-turbo; it does not claim
 * they run fast here. A GPU probe is evidence about hardware, not a measurement
 * of inference. So this module keeps two separate ideas apart:
 *
 *   1. `modelGuidance()` — what a detected backend makes ELIGIBLE to benchmark.
 *      CUDA/Vulkan/Metal unlock large-model candidates. CPU keeps the existing
 *      benchmark gate. No sentence here claims a measured speedup.
 *   2. `largeModelRecommendation()` — whether a particular measured result may
 *      actually be recommended. It requires `measured:true`, an RTF that keeps
 *      up, and — when a GPU was expected — an engine-reported backend that is
 *      not the CPU. A silent CPU fallback is refused with a stated reason.
 *
 * PURE: catalog rows in, plain decisions out. No I/O, no store, no engine.
 */
import catalog from '../../shared/speech/models.catalog.json';

export const ACCELERATED_BACKENDS = Object.freeze(['cuda', 'vulkan', 'metal']);

/** Catalog rows this policy governs. Derived, never hand-copied. */
export const LARGE_MODEL_IDS = Object.freeze(
  (catalog.models ?? [])
    .filter((model) => model.providerId === 'whispercpp' && /^large-v3/.test(model.id))
    .map((model) => model.id)
);

const BACKEND_LABELS = Object.freeze({ cuda: 'CUDA', vulkan: 'Vulkan', metal: 'Metal', cpu: 'CPU' });

/** Normalize a backend word; unknown/absent means CPU (the conservative default). */
export function normalizeBackend(backend) {
  const value = typeof backend === 'string' ? backend.trim().toLowerCase() : '';
  if (ACCELERATED_BACKENDS.includes(value)) return value;
  if (/^cpu$/.test(value)) return 'cpu';
  return 'cpu';
}

/** Probe backend, only when the probe actually reported one as available. */
export function probeBackendOf(gpu) {
  if (!gpu || gpu.available !== true) return 'cpu';
  return normalizeBackend(gpu.backend);
}

export function isLargeModel(modelId) {
  return LARGE_MODEL_IDS.includes(modelId);
}

/**
 * What a detected backend makes eligible to benchmark.
 *
 * @param {{gpu?: object|null, backend?: string|null}} [options]
 * @returns {{backend: string, label: string, status: string,
 *            largeCandidates: boolean, speedupClaimed: false, reason: string}}
 */
export function modelGuidance({ gpu = null, backend = null } = {}) {
  const detected = backend !== null && backend !== undefined
    ? normalizeBackend(backend)
    : probeBackendOf(gpu);
  const label = BACKEND_LABELS[detected] ?? 'CPU';

  if (detected === 'cpu') {
    return {
      backend: 'cpu',
      label: 'CPU',
      status: 'cpu-benchmark-gated',
      largeCandidates: false,
      speedupClaimed: false,
      reason:
        'No verified GPU backend was selected. large-v3 and large-v3-turbo stay benchmark-gated: they are only suggested if this machine measures a real-time factor below 1.0.',
    };
  }

  const buildGap = (detected === 'metal' || detected === 'vulkan')
    ? ' whisper.cpp b5454 has no CLI archive for this backend, so a local build is still needed before it can run.'
    : '';

  return {
    backend: detected,
    label,
    status: 'gpu-candidate-eligible',
    largeCandidates: true,
    speedupClaimed: false,
    reason:
      `${label} was detected, so large-v3 and large-v3-turbo may be benchmarked here. ` +
      `No speedup is claimed until the engine reports its backend and this machine measures it.${buildGap}`,
  };
}

/**
 * May one measured result be recommended when a particular backend was selected?
 *
 * `rtfPassed` is supplied by benchmark.js's existing RTF gate rather than
 * recomputed here, so there is exactly one definition of "keeps up".
 *
 * @param {object} [options]
 * @param {object|null} [options.result] a benchmark result row
 * @param {object|null} [options.gpu] a probe result
 * @param {boolean} [options.rtfPassed] result of the shared RTF gate
 * @returns {{allowed: boolean, reason: string}}
 */
export function largeModelRecommendation({ result = null, gpu = null, rtfPassed = false } = {}) {
  if (!isLargeModel(result?.modelId)) {
    return { allowed: true, reason: 'Smaller models use the ordinary benchmark gate.' };
  }

  if (result.measured !== true) {
    return {
      allowed: false,
      reason: `${result.modelId} has not been measured here, so it cannot be recommended.`,
    };
  }
  if (!rtfPassed) {
    return {
      allowed: false,
      reason: `${result.modelId} did not pass the measured real-time-factor gate, so it cannot be recommended.`,
    };
  }

  const expected = probeBackendOf(gpu);
  const actual = normalizeBackend(result.backend);
  if (ACCELERATED_BACKENDS.includes(expected) && actual === 'cpu') {
    return {
      allowed: false,
      reason: `${result.modelId} ran on the CPU even though ${BACKEND_LABELS[expected]} was selected. That is a silent fallback, not a GPU result.`,
    };
  }

  return {
    allowed: true,
    reason:
      `${result.modelId} is eligible because the engine reported ${BACKEND_LABELS[actual]} and this machine measured its speed. No generic GPU speedup was assumed.`,
  };
}

export default modelGuidance;
