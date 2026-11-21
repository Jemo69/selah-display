/**
 * shared/speech/modelSelection.js — the DECISION core of model auto-selection.
 *
 * This is pure on purpose: the engine produces measurements, main orchestrates
 * the restarts, and this module answers exactly one question — "given ONLY
 * measurements that were actually taken on this computer, which installed
 * model should we use?" No I/O, no engine access, no store, no clock.
 *
 * ## WHY "BIGGEST THAT KEEPS UP", NOT "FASTEST"
 *
 * The default model (large-v3) was chosen for accuracy, not because it was
 * measured on the operator's PC. The old `recommendModel()` in
 * src/speech/benchmark.js answers a different question: it picks the FASTEST
 * model inside the WER margin. Auto-selection answers the operator's actual
 * question — start with the biggest/best model this machine can keep up with,
 * and only step down when a smaller model is measurably just as good.
 *
 * The two gates are deliberately different in kind:
 *
 *  - RTF < 1.0 is a GATE, not a score. A model at 1.00x real time is already
 *    falling behind the speaker; it is not a close second.
 *  - WER is the COMPARISON. A bigger model may cost up to WER_MARGIN absolute
 *    (2 percentage points) against the best measured, gate-passing model.
 *    Below that the difference is inside the noise floor and must not decide
 *    anything.
 *
 * A row is only eligible when `measured === true` and both metrics are finite.
 * A missing number never means "probably fine"; it means "not measured", and
 * an unmeasured model can never be selected here.
 *
 * The thresholds below mirror THRESHOLDS in src/speech/benchmark.js. They are
 * duplicated (rather than imported across the app/engine boundary) on purpose,
 * and a test pins them to the same values.
 */

export const AUTO_SELECT = Object.freeze({
  RTF_GATE: 1.0,
  WER_MARGIN: 0.02,
});

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Is this a real measurement of a model that can keep up with live speech?
 *
 * @param {object|null|undefined} result
 * @returns {boolean}
 */
export function isPassingMeasurement(result) {
  if (!result || result.measured !== true) return false;
  if (typeof result.modelId !== 'string' || result.modelId.length === 0) return false;
  if (!finite(result.wer) || result.wer < 0) return false;
  if (!finite(result.rtf) || result.rtf <= 0 || result.rtf >= AUTO_SELECT.RTF_GATE) return false;
  return true;
}

/** Published download size in bytes, or 0 when metadata is unavailable. */
export function sizeBytesOf(model) {
  const bytes = model?.downloadBytes;
  return finite(bytes) && bytes > 0 ? bytes : 0;
}

const refusal = (code, reason, extra = {}) => ({
  ok: false,
  code,
  modelId: null,
  reason,
  result: null,
  best: null,
  margin: AUTO_SELECT.WER_MARGIN,
  ...extra,
});

/**
 * Pick the biggest installed model with a real, gate-passing measurement whose
 * WER is within the margin of the best measured, gate-passing model.
 *
 * @param {object} [input]
 * @param {Array<object>} [input.results] rows returned by the benchmark harness
 * @param {Array<object>} [input.models] catalog rows (for published size)
 * @param {Array<string>} [input.installedModelIds] digest-verified installed ids
 * @param {number} [input.margin] override for tests; absolute WER fraction
 * @param {boolean} [input.expectedAccel] a non-CPU backend was expected; a CPU
 *        row is then a silent fallback, not a usable measurement
 * @returns {{ok:boolean, code:string, modelId:string|null, reason:string,
 *            result:object|null, best:object|null, sizeBytes:number,
 *            margin:number, installedModelIds:string[],
 *            rejected:Array<{modelId:string, reason:string}>}}
 */
export function chooseAutoModel({
  results = [],
  models = [],
  installedModelIds = [],
  margin = AUTO_SELECT.WER_MARGIN,
  expectedAccel = false,
} = {}) {
  const effectiveMargin = finite(margin) && margin >= 0 ? margin : AUTO_SELECT.WER_MARGIN;
  const installed = [...new Set((Array.isArray(installedModelIds) ? installedModelIds : [])
    .filter((id) => typeof id === 'string' && id.length > 0))];
  const modelById = new Map((Array.isArray(models) ? models : [])
    .filter((model) => typeof model?.id === 'string')
    .map((model) => [model.id, model]));
  const resultById = new Map((Array.isArray(results) ? results : [])
    .filter((row) => typeof row?.modelId === 'string')
    .map((row) => [row.modelId, row]));

  if (installed.length === 0) {
    return refusal(
      'no-installed-candidates',
      'No installed, digest-verified models are available to choose from. Install a model first — an uninstalled model has no measurement on this computer.',
      { rejected: [], installedModelIds: [] }
    );
  }

  const rejected = [];
  const eligible = [];

  for (const modelId of installed) {
    const row = resultById.get(modelId);
    if (!row) {
      rejected.push({ modelId, reason: 'No benchmark result was produced for this model in this run.' });
      continue;
    }
    if (row.measured !== true) {
      rejected.push({ modelId, reason: row.reason || 'The benchmark did not produce a measurement.' });
      continue;
    }
    if (!finite(row.wer) || row.wer < 0) {
      rejected.push({ modelId, reason: 'No usable word error rate was measured.' });
      continue;
    }
    if (!finite(row.rtf) || row.rtf <= 0) {
      rejected.push({ modelId, reason: 'No usable speed measurement was produced.' });
      continue;
    }
    if (row.rtf >= AUTO_SELECT.RTF_GATE) {
      rejected.push({
        modelId,
        reason: `Too slow for a live service: ${row.rtf.toFixed(2)}x real time at or above the ${AUTO_SELECT.RTF_GATE.toFixed(1)}x gate.`,
      });
      continue;
    }
    if (expectedAccel) {
      const backend = typeof row.backend === 'string' ? row.backend.trim().toLowerCase() : '';
      if (!backend) {
        rejected.push({
          modelId,
          reason: 'The engine did not report which compute backend it used, so a GPU run cannot be proven.',
        });
        continue;
      }
      if (!['cuda', 'metal', 'vulkan'].includes(backend)) {
        rejected.push({
          modelId,
          reason: backend === 'cpu'
            ? 'The engine ran on the CPU even though an accelerated backend was detected. That is a silent fallback, not a GPU measurement.'
            : 'The engine did not report a known accelerated compute backend, so a GPU run cannot be proven.',
        });
        continue;
      }
    }
    eligible.push(row);
  }

  // A result for a model that is NOT in the verified, installed set can never
  // be chosen, even if it happens to be the best number in the table.
  for (const row of Array.isArray(results) ? results : []) {
    if (typeof row?.modelId !== 'string' || installed.includes(row.modelId)) continue;
    rejected.push({ modelId: row.modelId, reason: 'Not installed and digest-verified on this computer.' });
  }

  if (eligible.length === 0) {
    return refusal(
      'no-passing-results',
      'No installed model produced a measured result that both keeps up (RTF below 1.0) and has a usable word error rate. Nothing was selected — a smaller model is the honest next step, not a guess.',
      { rejected, installedModelIds: installed }
    );
  }

  // Best = lowest measured WER among models that can actually keep up. Slow
  // models do not set the accuracy benchmark: they are already excluded.
  const ranked = [...eligible].sort((a, b) =>
    a.wer - b.wer || a.rtf - b.rtf || a.modelId.localeCompare(b.modelId)
  );
  const best = ranked[0];
  const cutoff = best.wer + effectiveMargin;
  const withinMargin = eligible.filter((row) => row.wer <= cutoff + Number.EPSILON);

  // BIGGEST first. Ties resolve by accuracy, then speed, then id, so the same
  // measurements always produce the same choice — no coin flips in a sanctuary.
  const chosen = [...withinMargin].sort((a, b) => {
    const sizeDelta = sizeBytesOf(modelById.get(b.modelId)) - sizeBytesOf(modelById.get(a.modelId));
    if (sizeDelta !== 0) return sizeDelta;
    if (a.wer !== b.wer) return a.wer - b.wer;
    if (a.rtf !== b.rtf) return a.rtf - b.rtf;
    return a.modelId.localeCompare(b.modelId);
  })[0];

  for (const row of eligible) {
    if (row.wer > cutoff + Number.EPSILON) {
      rejected.push({
        modelId: row.modelId,
        reason: `Its measured error rate is more than ${(effectiveMargin * 100).toFixed(1)} points worse than the best measured model.`,
      });
    }
  }

  const sizeBytes = sizeBytesOf(modelById.get(chosen.modelId));
  const model = modelById.get(chosen.modelId);
  const label = model?.displayName || chosen.modelId;
  const costPoints = (chosen.wer - best.wer) * 100;
  const trade =
    chosen.modelId === best.modelId
      ? 'it also has the best measured error rate'
      : `it costs ${costPoints.toFixed(1)} percentage points of error rate against ${best.modelId}, inside the ${(effectiveMargin * 100).toFixed(1)} point margin`;
  const sizeText = sizeBytes > 0 ? ` (${(sizeBytes / (1024 * 1024)).toFixed(0)} MiB published size)` : '';
  const reason =
    `${label}${sizeText} is the largest installed model that keeps up: ` +
    `${chosen.rtf.toFixed(2)}x real time (gate ${AUTO_SELECT.RTF_GATE.toFixed(1)}x) and ` +
    `${(chosen.wer * 100).toFixed(1)}% WER, and ${trade}. ` +
    'Measured on this computer with the benchmark clip; not inferred from the model name.';

  return {
    ok: true,
    code: 'selected',
    modelId: chosen.modelId,
    reason,
    result: chosen,
    best,
    sizeBytes,
    margin: effectiveMargin,
    installedModelIds: installed,
    rejected,
  };
}

export default chooseAutoModel;
