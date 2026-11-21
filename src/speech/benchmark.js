/**
 * src/speech/benchmark.js — the DECISION half of the benchmark harness.
 *
 * Plan section 9 and decision D8: "a benchmark harness that runs real models
 * against a real reference clip on the user's own machine and reports WER, RTF,
 * compute backend, GPU utilisation and load time" — because "every other answer
 * here is a guess dressed as a recommendation, and two guesses fail badly".
 *
 * This module is pure: synthetic result sets in, a recommendation and a set of
 * warnings out. No engine, no I/O, no store. The measurement comes from the
 * engine; the judgement about what to do with it belongs here, where it can be
 * unit-tested against synthetic results — which is the only practical way to
 * test "picks the fastest model within the margin".
 *
 * TWO FAILURE MODES THIS FILE EXISTS TO PREVENT:
 *
 *  1. Recommending a model that cannot keep up with a live sermon. RTF below
 *     1.0 is the primary gate (plan 9.3) and it is a GATE, not a sort key: a
 *     model with the best WER that needs 3x realtime is useless in a service,
 *     because the transcript arrives after the sentence it describes.
 *
 *  2. Presenting an unstable number as decisive. Plan 14 requires that "if a
 *     metric is unstable it cannot be used to choose anything, and the UI must
 *     say so rather than presenting a noisy number as decisive". Two runs of
 *     the same model that disagree by more than the noise floor produce a
 *     recommendation nobody should act on.
 *
 * GPU SELECTION does not bypass either rule. Passing `{ gpu }` in options lets
 * src/speech/modelGuidance.js restrict large-v3/turbo recommendations to rows
 * that were actually measured on a non-CPU backend and passed the RTF gate.
 * Hardware detection alone never makes a model fast.
 */
import { largeModelRecommendation } from './modelGuidance.js';

/**
 * Thresholds a reviewer would want to argue with, named in one place on
 * purpose — every one of these is a judgement, not a constant of nature.
 */
export const THRESHOLDS = Object.freeze({
  /**
   * RTF below this cannot keep up with a live sermon. 1.0 means inference
   * takes exactly as long as the audio; anything above that falls behind.
   */
  RTF_GATE: 1.0,

  /**
   * How much WORSE than the best measured WER a model may be and still be
   * recommended, provided it is faster. Plan 9.4 wants "the fastest model
   * within a stated WER margin of the best measured".
   *
   * 0.02 absolute (2 percentage points). Chosen because WER differences below
   * roughly 2 points on a 90-second clip are inside the run-to-run noise of the
   * measurement itself — recommending on a smaller gap would be recommending
   * on noise.
   */
  WER_MARGIN: 0.02,

  /**
   * Two runs of one model must agree this closely (absolute WER) or the result
   * is reported as unstable. 0.01 is half the recommendation margin: if the
   * same model varies by more than that, a margin-sized decision is not
   * supportable.
   */
  STABILITY_NOISE: 0.01,

  /**
   * Speed drop from the first third of a run to the last third that counts as
   * thermal decay. Plan 9.3: "a laptop that passes then degrades is worse than
   * one that is uniformly slow, because it fails at minute 25 of a service."
   * 0.15 = the last third runs 15% slower per unit of audio than the first.
   */
  THERMAL_DECAY: 0.15,
});

/** A benchmark result, as the engine reports it. */
function isResult(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.modelId === 'string';
}

/**
 * Does this model keep up with a live sermon?
 *
 * A model with no measured RTF is treated as NOT passing. An unmeasured model
 * has not been shown to work, and defaulting it to "fine" is how a slow model
 * gets adopted on a machine nobody benchmarked properly.
 *
 * @param {{rtf?: number|null}} result
 * @returns {boolean}
 */
export function passesRtfGate(result) {
  if (!isResult(result)) return false;
  const rtf = typeof result.rtf === 'number' ? result.rtf : null;
  if (rtf === null || !Number.isFinite(rtf) || rtf <= 0) return false;
  return rtf < THRESHOLDS.RTF_GATE;
}

/**
 * Results that are safe to compare: measured, RTF-passing, finite WER.
 *
 * @param {Array<object>} results
 * @returns {Array<object>}
 */
export function gatedResults(results) {
  return (Array.isArray(results) ? results : []).filter((result) => {
    if (!isResult(result)) return false;
    if (typeof result.wer !== 'number' || !Number.isFinite(result.wer)) return false;
    return passesRtfGate(result);
  });
}

/**
 * Sort by WER, ties broken by RTF then modelId.
 *
 * The final tiebreak is the model id so the order is total and deterministic:
 * two runs of the same benchmark must produce the same table, or "the same model
 * benchmarked twice" stops being a checkable claim.
 *
 * @param {Array<object>} results
 * @returns {Array<object>} a new array
 */
export function sortByWer(results) {
  return [...(Array.isArray(results) ? results : [])].sort((a, b) => {
    if (a.wer !== b.wer) return a.wer - b.wer;
    if (a.rtf !== b.rtf) return a.rtf - b.rtf;
    return String(a.modelId).localeCompare(String(b.modelId));
  });
}

/**
 * Recommend the fastest model within the WER margin of the best measured.
 *
 * Returns a DECISION OBJECT rather than a model, because "which model" is only
 * half the answer an operator needs — they need to see why, and to see when
 * there is no answer.
 *
 * @param {Array<object>} results benchmark results for the same provider
 * @param {{margin?: number, gpu?: object|null, backend?: string|null}} [options]
 * @returns {{modelId: string, wer: number, rtf: number, best: object,
 *            margin: number, reason: string} | {modelId: null, reason: string,
 *            rejected: Array<{modelId: string, reason: string}>}}
 */
export function recommendModel(results, options = {}) {
  const margin = typeof options.margin === 'number' ? options.margin : THRESHOLDS.WER_MARGIN;
  const all = Array.isArray(results) ? results.filter(isResult) : [];
  // Without an explicit probe/backend, behaviour is exactly the historical one.
  const gpuPolicy = options.gpu ?? (options.backend
    ? { available: true, backend: options.backend }
    : null);
  const largeVerdicts = new Map();

  if (all.length === 0) {
    return { modelId: null, reason: 'Nothing has been benchmarked yet.', rejected: [] };
  }

  // Rejections are reported even when a recommendation exists. An operator whose
  // preferred model was gated out should be told which rule excluded it, not
  // left to wonder.
  const rejected = [];
  for (const result of all) {
    if (typeof result.wer !== 'number' || !Number.isFinite(result.wer)) {
      rejected.push({
        modelId: result.modelId,
        reason: 'No usable word error rate was measured for this model.',
      });
    } else if (!passesRtfGate(result)) {
      rejected.push({
        modelId: result.modelId,
        reason:
          typeof result.rtf === 'number' && Number.isFinite(result.rtf)
            ? `Too slow for a live service — it needs ${result.rtf.toFixed(2)}x real time, and anything above ${THRESHOLDS.RTF_GATE}x falls behind the speaker.`
            : 'Speed was never measured, so it cannot be shown to keep up with a live service.',
      });
    } else if (gpuPolicy) {
      const verdict = largeModelRecommendation({
        result,
        gpu: gpuPolicy,
        rtfPassed: true,
      });
      largeVerdicts.set(result.modelId, verdict.allowed);
      if (!verdict.allowed) rejected.push({ modelId: result.modelId, reason: verdict.reason });
    }
  }

  const eligible = gatedResults(all).filter((result) => largeVerdicts.get(result.modelId) !== false);
  if (eligible.length === 0) {
    return {
      modelId: null,
      reason:
        'No benchmarked model is fast enough to keep up with a live service, so none is recommended. A smaller model is the way forward, not a faster guess.',
      rejected,
    };
  }

  const ranked = sortByWer(eligible);
  const best = ranked[0];
  const cutoff = best.wer + margin;

  // Fastest among those within the margin of the best WER. RTF ascending, with
  // WER as the tiebreak so an equal-speed pair resolves to the more accurate.
  const withinMargin = eligible.filter((result) => result.wer <= cutoff);
  const fastest = withinMargin.sort((a, b) => {
    if (a.rtf !== b.rtf) return a.rtf - b.rtf;
    if (a.wer !== b.wer) return a.wer - b.wer;
    return String(a.modelId).localeCompare(String(b.modelId));
  })[0];

  const isBest = fastest.modelId === best.modelId;
  const werCost = fastest.wer - best.wer;
  const speedGain = best.rtf > 0 ? best.rtf / fastest.rtf : Infinity;

  return {
    modelId: fastest.modelId,
    wer: fastest.wer,
    rtf: fastest.rtf,
    best,
    margin,
    rejected,
    reason: isBest
      ? `${fastest.modelId} has the best measured error rate (${(fastest.wer * 100).toFixed(1)}%) and already keeps up, so there is nothing to trade for speed.`
      : `${fastest.modelId} is ${speedGain.toFixed(1)}x faster than ${best.modelId} and costs ${(werCost * 100).toFixed(1)} percentage points of error rate, inside the ${(margin * 100).toFixed(1)} point margin. Pick the other one if that trade is wrong for this room.`,
  };
}

/**
 * Is this model's WER trustworthy, given two runs of it?
 *
 * Plan 14 requires exactly this, and requires the UI to say so rather than
 * presenting a noisy number as decisive.
 *
 * @param {object} first
 * @param {object} second
 * @param {{noise?: number}} [options]
 * @returns {{stable: boolean, delta: number|null, noise: number, reason: string}}
 */
export function assessStability(first, second, options = {}) {
  const noise = typeof options.noise === 'number' ? options.noise : THRESHOLDS.STABILITY_NOISE;

  if (!isResult(first) || !isResult(second) || first.modelId !== second.modelId) {
    return {
      stable: false,
      delta: null,
      noise,
      reason: 'These two results are not two runs of the same model, so stability cannot be judged.',
    };
  }
  if (typeof first.wer !== 'number' || typeof second.wer !== 'number') {
    return {
      stable: false,
      delta: null,
      noise,
      reason: 'One of the runs has no usable error rate.',
    };
  }

  const delta = Math.abs(first.wer - second.wer);
  const stable = delta <= noise;
  return {
    stable,
    delta,
    noise,
    reason: stable
      ? `Two runs differ by ${(delta * 100).toFixed(1)} points, inside the ${(noise * 100).toFixed(1)} point noise floor.`
      : `Two runs differ by ${(delta * 100).toFixed(1)} points, outside the ${(noise * 100).toFixed(1)} point noise floor. This number cannot choose between models — run it again.`,
  };
}

/**
 * Did this model slow down as the run went on?
 *
 * Plan 9.3: comparing the first third against the last third is what catches
 * "passes the benchmark, fails at minute 25 of a service".
 *
 * @param {{firstThirdRtf?: number, lastThirdRtf?: number}} result
 * @param {{threshold?: number}} [options]
 * @returns {{decayed: boolean, ratio: number|null, reason: string}}
 */
export function detectThermalDecay(result, options = {}) {
  const threshold = typeof options.threshold === 'number' ? options.threshold : THRESHOLDS.THERMAL_DECAY;

  const first = result?.firstThirdRtf;
  const last = result?.lastThirdRtf;
  if (typeof first !== 'number' || typeof last !== 'number' || first <= 0) {
    return { decayed: false, ratio: null, reason: 'Not enough of a run to tell whether it slowed down.' };
  }

  const ratio = last / first;
  if (ratio <= 1 + threshold) {
    return {
      decayed: false,
      ratio,
      reason: 'Speed held steady across the run.',
    };
  }
  return {
    decayed: true,
    ratio,
    reason: `The last third of the run was ${ratio.toFixed(2)}x slower than the first. A model that passes a short test and then decays will fail partway through a service — expect it to fall behind around minute ${Math.round(25 * threshold)} of a long one.`,
  };
}

/**
 * Is the engine silently running on the CPU?
 *
 * Plan 9.1 calls this out as the single most valuable diagnostic in the whole
 * set: whisper.cpp binaries "fall back to CPU without telling anyone, and a
 * user then believes the model is slow when their GPU sat idle". A benchmark
 * that reports the backend turns folklore into a fact.
 *
 * @param {{backend?: string|null, expectedAccel?: boolean}} result
 * @returns {{fallback: boolean, backend: string|null, reason: string}}
 */
export function detectCpuFallback(result) {
  const backend = typeof result?.backend === 'string' ? result.backend : null;
  const expectedAccel = result?.expectedAccel !== false;

  if (!backend) {
    return {
      fallback: false,
      backend: null,
      reason: 'The engine did not report which compute backend it used.',
    };
  }
  if (/^cpu$/i.test(backend)) {
    return expectedAccel
      ? {
          fallback: true,
          backend,
          reason:
            'This ran on the CPU even though an accelerated backend was available. The model is not slow — the GPU was never used. Check the backend in your whisper.cpp build (Metal on macOS, CUDA or Vulkan on Windows and Linux).',
        }
      : {
          fallback: false,
          backend,
          reason: 'This ran on the CPU, which is expected on a machine without an accelerator.',
        };
  }
  return {
    fallback: false,
    backend,
    reason: `This ran on ${backend}.`,
  };
}

/**
 * Everything worth telling the operator about one result, in one place.
 *
 * @param {object} result
 * @param {{expectedAccel?: boolean}} [options]
 * @returns {Array<{level: 'ok'|'warn'|'error', reason: string}>}
 */
export function assessResult(result, options = {}) {
  const notes = [];
  const thermal = detectThermalDecay(result);
  if (thermal.decayed) notes.push({ level: 'warn', reason: thermal.reason });

  const cpu = detectCpuFallback({
    backend: result?.backend,
    expectedAccel: typeof options.expectedAccel === 'boolean'
      ? options.expectedAccel
      : result?.expectedAccel,
  });
  if (cpu.fallback) notes.push({ level: 'warn', reason: cpu.reason });

  if (!passesRtfGate(result)) {
    notes.push({
      level: 'error',
      reason:
        typeof result?.rtf === 'number' && Number.isFinite(result.rtf)
          ? `Too slow for a live service: ${result.rtf.toFixed(2)}x real time. It will fall behind the speaker.`
          : 'Speed was never measured, so this cannot be recommended.',
    });
  }

  return notes;
}

export default recommendModel;
