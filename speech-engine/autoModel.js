/**
 * speech-engine/autoModel.js — the SEQUENTIAL auto-selection orchestrator.
 *
 * whisper.cpp holds ONE set of weights per process. The HTTP benchmark refuses
 * to label a measurement with a model that is not loaded (`server.js` checks
 * the active model), and for good reason: reporting tiny's numbers as
 * large-v3 would be the exact fabrication the benchmark harness exists to
 * prevent. There is no honest hot-swap here.
 *
 * So a real matrix benchmark means a real boundary:
 *
 *   verify (digest) -> STOP engine -> START engine with model X ->
 *   confirm health says X -> run the committed benchmark clip ->
 *   STOP engine -> next model.
 *
 * Every step is injected as a callback. This module contains no Electron, no
 * spawn, no fetch, no disk access, so the whole sequence can be tested with
 * fake engines and fake models (`test/autoModel.test.js`) without a GPU. Main
 * supplies callbacks that call the existing supervisor (`speechEngine.js`).
 *
 * The client must have stopped any live session BEFORE calling this; main
 * checks the supervisor, and the UI checks the store. Even so, this module
 * stops before every start and in a finally block, so a failed model cannot
 * leave somebody else's engine running under a model they did not choose.
 */

import { chooseAutoModel } from '../shared/speech/modelSelection.js';

/** A row that says nothing was measured — never a plausible stand-in. */
function unmeasured(modelId, reason, engineKind = null) {
  return {
    measured: false,
    modelId,
    engineKind,
    reason,
    wer: null,
    rtf: null,
    firstPartialMs: null,
    backend: null,
    loadTimeMs: null,
    gpuUtilMean: null,
    gpuUtilPeak: null,
    peakRssBytes: null,
    firstThirdRtf: null,
    lastThirdRtf: null,
  };
}

const codeOf = (error) =>
  (typeof error === 'string' ? error : error?.code) || error?.name || 'error';

/**
 * Benchmark every candidate by actually loading it, then pick the best model
 * that passes. Returns results AND the decision; does not touch the renderer
 * store or apply the selection. Main re-verifies before applying.
 *
 * @param {object} input
 * @param {string[]} input.candidateIds installed ids, biggest first
 * @param {object[]} [input.models] catalog rows (published sizes)
 * @param {(modelId:string) => Promise<{ok:boolean, verified?:boolean, code?:string, message?:string}>} input.verifyModel
 * @param {(modelId:string) => Promise<{ok:boolean, health?:{model?:string}, reason?:string}>} input.startModel
 * @param {(modelId:string) => Promise<object>} input.benchmarkModel
 * @param {() => Promise<{ok?:boolean}|void>} input.stopModel
 * @param {(progress:object) => void} [input.onProgress]
 * @param {number} [input.margin]
 * @returns {Promise<object>} { ok, code, reason, results, decision, verified, rejected, stops }
 */
export async function runAutoModelSelection({
  candidateIds = [],
  models = [],
  verifyModel,
  startModel,
  benchmarkModel,
  stopModel,
  onProgress = null,
  margin,
  expectedAccel = false,
} = {}) {
  const ids = Array.isArray(candidateIds)
    ? [...new Set(candidateIds.filter((id) => typeof id === 'string' && id.length > 0))]
    : [];

  if (ids.length === 0) {
    return {
      ok: false,
      code: 'no-installed-candidates',
      reason: 'No installed, digest-verified models are available to benchmark.',
      results: [],
      verified: [],
      rejected: [],
      decision: chooseAutoModel({ results: [], models, installedModelIds: [], margin }),
      stops: 0,
    };
  }

  const results = [];
  const verified = [];
  const rejected = [];
  let stops = 0;
  let stopFailed = false;

  const stop = async (modelId, boundary) => {
    onProgress?.({ stage: 'stopping', modelId, boundary, total: ids.length });
    try {
      await stopModel?.();
      stops += 1;
      return true;
    } catch {
      stopFailed = true;
      return false;
    }
  };

  for (const [index, modelId] of ids.entries()) {
    const total = ids.length;
    onProgress?.({ stage: 'verifying', modelId, index, total });

    let verdict;
    try {
      verdict = await verifyModel?.(modelId);
    } catch (error) {
      verdict = { ok: false, code: codeOf(error) };
    }
    if (verdict?.ok !== true || verdict.verified === false) {
      const reason =
        typeof verdict?.message === 'string' && verdict.message
          ? verdict.message
          : `The installed file failed digest verification (${verdict?.code ?? 'not-verified'}).`;
      results.push(unmeasured(modelId, reason, verdict?.engineKind ?? null));
      rejected.push({ modelId, reason });
      continue;
    }
    verified.push(modelId);

    // Explicit boundary: no engine may survive from the previous candidate.
    if (!(await stop(modelId, 'before'))) break;

    onProgress?.({ stage: 'loading', modelId, index, total });
    let started;
    try {
      started = await startModel(modelId);
    } catch (error) {
      started = { ok: false, reason: `Engine start failed (${codeOf(error)}).` };
    }

    if (started?.ok !== true) {
      const reason = started?.reason || 'The engine could not be started with this model.';
      results.push(unmeasured(modelId, reason, started?.engineKind ?? null));
      rejected.push({ modelId, reason });
      await stop(modelId, 'after-failed-start');
      continue;
    }

    // Confirm what is loaded BEFORE measuring. A row is labelled with the
    // model the engine reports, not the model we asked for.
    const loadedModel = started.health?.model ?? null;
    if (loadedModel !== modelId) {
      const reason =
        `The engine reported ${loadedModel ?? 'no model'} after being asked for ${modelId}. ` +
        'No benchmark was run, because its numbers would be labelled with the wrong model.';
      results.push(unmeasured(modelId, reason, started.health?.backend ?? null));
      rejected.push({ modelId, reason });
      await stop(modelId, 'after-model-mismatch');
      continue;
    }

    onProgress?.({ stage: 'benchmarking', modelId, index, total });
    let row;
    try {
      row = await benchmarkModel(modelId);
    } catch (error) {
      row = unmeasured(modelId, `The benchmark failed (${codeOf(error)}).`, started.health?.backend ?? null);
    }
    // Forward the row as received. `measured:false` stays false with its
    // reason; nothing here may turn absence into a usable number.
    results.push(row && typeof row === 'object' ? { ...row, modelId } : unmeasured(modelId, 'The benchmark returned no row.'));
    onProgress?.({ stage: 'done', modelId, index, total, measured: row?.measured === true });

    if (!(await stop(modelId, 'after'))) break;
  }

  // Last boundary: never leave a benchmark engine running for the next person.
  await stop(null, 'final');

  const decision = chooseAutoModel({ results, models, installedModelIds: verified, margin, expectedAccel });
  return {
    ok: decision.ok === true && stopFailed !== true,
    code: stopFailed ? 'engine-stop-failed' : decision.code,
    reason: stopFailed
      ? 'The engine did not stop cleanly after auto-selection. No model was selected; check the speech engine log before starting a live session.'
      : decision.reason,
    results,
    verified,
    rejected,
    decision,
    stops,
  };
}

export default runAutoModelSelection;
