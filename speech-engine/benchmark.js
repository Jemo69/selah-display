/**
 * speech-engine/benchmark.js — the engine side of the benchmark harness.
 *
 * Plan section 9 / decision D8 exist because "every other answer here is a
 * guess dressed as a recommendation, and two guesses fail badly". Two of those
 * guesses are silent CPU fallback and thermal decay — neither is visible in a
 * spec. So this runs real models against a real reference clip on the user's
 * own machine and reports what happened.
 *
 * ## THE RULE THIS MODULE EXISTS TO ENFORCE
 *
 * A benchmark that reports a number it did not measure is worse than one that
 * reports nothing. The only engine that runs today is the canned one, and it
 * could emit a perfectly plausible WER of 4.1% and an RTF of 0.5 — and an
 * operator would reasonably believe them, because a table of numbers does not
 * announce that it is fiction.
 *
 * So: `runBenchmark` returns `measured: false` with a stated reason whenever
 * the engine behind it cannot produce a real measurement, and the app layer
 * refuses to rank or recommend from those results. The metrics come back
 * present-but-empty rather than invented. When a real engine lands, this same
 * function fills them in and nothing downstream changes.
 *
 * ## WHAT IS MEASURED (plan 9.3)
 *
 *   loadTimeMs     wall clock to load weights and reach first inference
 *   wer / s,d,i    word error rate and its breakdown (shared/wer.js)
 *   rtf            total inference time / audio duration; below 1.0 keeps up
 *   firstPartialMs latency from end of speech onset to first non-empty partial
 *   backend        Metal / Vulkan / CUDA / CPU — catches silent CPU fallback
 *   gpuUtilMean/Peak  distinguishes "GPU is busy" from "GPU never engaged"
 *   peakRssBytes   decides whether this competes with OBS and a browser
 *   firstThirdRtf/lastThirdRtf  thermal decay across the run
 */
import { werDetail } from '../shared/wer.js';

/**
 * Engine kinds whose numbers may be believed.
 *
 * A kind that is not listed here is treated as unmeasurable. Defaulting an
 * unknown engine to "probably real" is precisely the guess D8 exists to
 * eliminate — and a provider that fails to report its capabilities gets the
 * conservative behaviour for the same reason (D11).
 */
export const TRUSTED_ENGINE_KINDS = Object.freeze(['whispercpp', 'whispercpp-server', 'whisper.cpp', 'sherpaonnx', 'vosk', 'faster-whisper']);

/**
 * Read an engine's declared kind, tolerating the field being absent entirely.
 *
 * Order matters: the explicit kind fields win over the display name, because
 * `createFakeEngine` calls itself "fake-canned" as a *name* — which is how a
 * canned engine gets identified here. Reading name first would work by luck
 * rather than by contract.
 */
export function engineKindOf(engine) {
  const explicit = engine?.kind ?? engine?.engineKind ?? null;
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return explicit.trim().toLowerCase();
  }
  const named = engine?.name ?? engine?.model ?? null;
  return typeof named === 'string' ? named.trim().toLowerCase() : null;
}

/**
 * May this engine's numbers be shown as a measurement?
 *
 * @param {object} engine
 * @returns {{trusted: boolean, kind: string|null, reason: string}}
 */
export function measurementTrust(engine) {
  const kind = engineKindOf(engine);

  if (kind === null) {
    return {
      trusted: false,
      kind,
      reason:
        'The engine did not say which kind it is, so its numbers cannot be trusted as a measurement.',
    };
  }
  if (kind === 'fake' || kind.includes('fake') || kind.includes('canned')) {
    return {
      trusted: false,
      kind,
      reason:
        'The engine running is the test engine, which replays a fixed sentence. It can show that the benchmark pipeline works, but every number it produces would be fiction.',
    };
  }
  if (!TRUSTED_ENGINE_KINDS.includes(kind)) {
    return {
      trusted: false,
      kind,
      reason: `The engine "${kind}" is not a known measurement-capable runtime, so its numbers cannot be trusted.`,
    };
  }
  return { trusted: true, kind, reason: '' };
}

/** A result with every metric explicitly absent — never a plausible stand-in. */
function unmeasured(modelId, trust, extra = {}) {
  return {
    measured: false,
    modelId,
    engineKind: trust.kind,
    reason: trust.reason,
    wer: null,
    werDetail: null,
    rtf: null,
    firstPartialMs: null,
    backend: null,
    loadTimeMs: null,
    gpuUtilMean: null,
    gpuUtilPeak: null,
    peakRssBytes: null,
    firstThirdRtf: null,
    lastThirdRtf: null,
    ...extra,
  };
}

/** Raised when the caller cancels; distinct from failure so it is not reported as one. */
export class BenchmarkCancelled extends Error {
  constructor() {
    super('benchmark cancelled');
    this.name = 'BenchmarkCancelled';
    this.cancelled = true;
  }
}

/**
 * Run one model against the reference clip.
 *
 * CANCEL IS REAL, NOT COSMETIC: `cancel` is checked between phases and while
 * awaiting, and the in-flight transcribe is abandoned. Plan 9.4 is explicit
 * that there is "a cancel that actually stops the work rather than hiding the
 * result" — a benchmark that runs to completion after Cancel was pressed has
 * lied about the only thing the operator wanted.
 *
 * @param {object} input
 * @param {object} input.engine the engine under test
 * @param {string} input.modelId
 * @param {{pcm: Buffer|ArrayBuffer, transcript: string, sampleRate?: number}} [input.clip]
 *   The reference clip AND its hand-verified ground truth. Without a transcript
 *   there is nothing to score against, and inventing one would make the WER
 *   meaningless — so a missing transcript stops the run rather than guessing.
 * @param {(progress: object) => void} [input.onProgress]
 * @param {{cancelled: boolean}} [input.cancel]
 * @returns {Promise<object>} a result row, `measured:false` when untrustworthy
 */
export async function runBenchmark({
  engine,
  modelId,
  clip = null,
  onProgress = null,
  cancel = null,
} = {}) {
  const trust = measurementTrust(engine);
  const base = { modelId, engineKind: trust.kind };

  if (typeof modelId !== 'string' || modelId.length === 0) {
    return { ...unmeasured(String(modelId ?? ''), trust), reason: 'No model was named, so nothing was measured.' };
  }

  if (!trust.trusted) {
    // Report the pipeline ran, and report that it measured nothing.
    onProgress?.({ stage: 'skipped', modelId, measured: false });
    return unmeasured(modelId, trust);
  }

  if (!clip || !clip.pcm) {
    return {
      ...unmeasured(modelId, trust),
      reason:
        'No reference clip is available. The benchmark needs real audio and its hand-verified transcript to measure against.',
    };
  }
  if (typeof clip.transcript !== 'string' || clip.transcript.trim().length === 0) {
    return {
      ...unmeasured(modelId, trust),
      reason:
        'The reference clip has no hand-verified transcript, so there is nothing to score against. Inventing one would make the number meaningless.',
    };
  }

  const throwIfCancelled = () => {
    if (cancel?.cancelled) throw new BenchmarkCancelled();
  };

  throwIfCancelled();

  // --- load ---------------------------------------------------------------
  // Paid on every cold start, so it is reported rather than assumed: "a 3 GB
  // model that takes 40 s to load is a real cost" (plan 9.3).
  onProgress?.({ stage: 'loading', modelId });
  const loadStart = now();
  let loaded = null;
  try {
    if (typeof engine.loadModel === 'function') {
      loaded = await engine.loadModel({ modelId });
    }
  } catch (error) {
    return {
      ...unmeasured(modelId, trust),
      reason: `The model could not be loaded: ${errorCode(error)}.`,
    };
  }
  throwIfCancelled();
  const loadTimeMs = now() - loadStart;
  onProgress?.({ stage: 'loaded', modelId, loadTimeMs });

  // --- transcribe ---------------------------------------------------------
  const audioDurationMs = audioDurationMsOf(clip, trust);
  onProgress?.({ stage: 'transcribing', modelId });

  const startedAt = now();
  let output = null;
  try {
    if (typeof engine.transcribe !== 'function') {
      return { ...unmeasured(modelId, trust), reason: 'This engine exposes no transcribe call to measure.' };
    }
    output = await engine.transcribe({ pcm: clip.pcm, sampleRate: clip.sampleRate ?? 16000 });
  } catch (error) {
    if (error instanceof BenchmarkCancelled || error?.cancelled) throw new BenchmarkCancelled();
    return { ...unmeasured(modelId, trust), reason: `Transcription failed: ${errorCode(error)}.` };
  }
  throwIfCancelled();

  const transcribeMs = now() - startedAt;
  const hypothesis = typeof output?.text === 'string' ? output.text : '';

  // --- score --------------------------------------------------------------
  const detail = werDetail(hypothesis, clip.transcript);
  const rtf = audioDurationMs > 0 ? transcribeMs / audioDurationMs : null;

  onProgress?.({ stage: 'done', modelId, rtf });

  return {
    measured: true,
    modelId,
    engineKind: trust.kind,
    reason: '',
    // wer as a FRACTION (0..1), matching src/speech/benchmark.js. Converting a
    // percentage here would be the easiest way to make the panel sort wrongly.
    wer: detail.wer,
    werDetail: detail,
    rtf,
    loadTimeMs,
    firstPartialMs: typeof output?.firstPartialMs === 'number' ? output.firstPartialMs : null,
    backend: typeof output?.backend === 'string' ? output.backend : null,
    gpuUtilMean: typeof output?.gpuUtilMean === 'number' ? output.gpuUtilMean : null,
    gpuUtilPeak: typeof output?.gpuUtilPeak === 'number' ? output.gpuUtilPeak : null,
    peakRssBytes: typeof output?.peakRssBytes === 'number' ? output.peakRssBytes : null,
    // A single transcribe cannot show thermal decay; it needs a sustained run.
    // Left null rather than inferred from one number.
    firstThirdRtf: null,
    lastThirdRtf: null,
    ...(loaded && typeof loaded.modelPath === 'string' ? {} : {}),
  };
}

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function audioDurationMsOf(clip, trust) {
  const bytes = clip?.pcm?.byteLength ?? clip?.pcm?.length ?? null;
  const sampleRate = clip?.sampleRate ?? 16000;
  if (typeof bytes !== 'number' || bytes <= 0) return 0;
  // Int16 mono: 2 bytes per sample.
  return Math.round((bytes / 2 / sampleRate) * 1000);
}

/** An error CODE at most — a message could carry transcript text or a path. */
function errorCode(error) {
  if (typeof error === 'string') return 'error';
  return error?.code ?? error?.name ?? 'error';
}

export default runBenchmark;
