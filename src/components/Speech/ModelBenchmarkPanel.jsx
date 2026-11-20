/**
 * ModelBenchmarkPanel.jsx — the measured comparison table (plan section 9.4).
 *
 * "This is what turns the model catalog from a list into a decision the user
 * can actually make." Every other answer about which model to use is a guess
 * dressed as a recommendation; this runs the real candidates on the real
 * machine and shows what happened.
 *
 * ## WHY THE TABLE CAN BE MOSTLY EMPTY, ON PURPOSE
 *
 * The only engine that runs today is the canned one, which cannot measure
 * anything. So the honest default state is: full table structure, every number
 * column showing an em-dash, and one clear line saying why. NOT a spinner, and
 * certainly not a table of plausible invented numbers — a confident fabricated
 * WER is the single most damaging thing this panel could render, because the
 * whole point of the benchmark is to replace guesses with measurements.
 *
 * The structure is shown rather than collapsed to a sentence so an operator
 * can see what they will get; the panel is ready the moment a real engine
 * exists and needs no further change.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSpeechStore from '../../context/SpeechStore';
import { loadBenchmarkClip } from '../../speech/benchmarkClip.js';
import { modelsForProvider } from '../../../shared/speech/index.js';
import {
  recommendModel,
  gatedResults,
  sortByWer,
  passesRtfGate,
  assessResult,
  THRESHOLDS,
} from '../../speech/benchmark.js';

/** The bridge, or null in a browser/test with no preload. Cold on purpose. */
const bridge = () => (typeof window === 'undefined' ? null : window.electronAPI?.speech ?? null);

/** Shown for a metric that was not measured — never a 0, never a blank cell. */
const DASH = '—';

const percent = (fraction) =>
  typeof fraction === 'number' && Number.isFinite(fraction) ? `${(fraction * 100).toFixed(1)}%` : DASH;

const seconds = (ms) =>
  typeof ms === 'number' && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : DASH;

const speed = (rtf) =>
  typeof rtf === 'number' && Number.isFinite(rtf) ? `${rtf.toFixed(2)}x` : DASH;

/** A stable-ish id for a result row, used as a React key and test handle. */
const rowId = (result) => result.modelId;

const ModelBenchmarkPanel = ({ darkMode = true, cardClass, titleClass }) => {
  const providerId = useSpeechStore((state) => state.providerId);
  const currentModelId = useSpeechStore((state) => state.modelId);
  const results = useSpeechStore((state) => state.benchmarkResults) ?? [];
  const runningId = useSpeechStore((state) => state.benchmarkRunningId) ?? null;

  /** Per-model failure text, kept local: transient UI, never persisted. */
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState(null);
  const [selecting, setSelecting] = useState(false);
  // A cancel is a REQUEST. Resolving it does not mean the run stopped, and the
  // engine says so explicitly — so we show what it reported rather than
  // pretending the work was killed.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const models = useMemo(() => modelsForProvider(providerId), [providerId]);

  /**
   * Which rows can be compared. An unmeasured row is excluded here rather than
   * downstream, so no sort, gate, or recommendation can treat a missing number
   * as a good one.
   */
  const comparable = useMemo(() => gatedResults(results), [results]);
  const sorted = useMemo(() => sortByWer(comparable), [comparable]);
  const recommendation = useMemo(() => recommendModel(results), [results]);

  /** Every reason any measured-but-excluded row was excluded. */
  const warningsFor = useCallback(
    (result) => assessResult(result),
    []
  );

  const run = useCallback(
    async (modelId) => {
      const speech = bridge();
      if (!speech || typeof speech.benchmark !== 'function') {
        setErrors((prev) => ({
          ...prev,
          [modelId]: 'The benchmark is only available in the desktop app.',
        }));
        return;
      }
      setErrors((prev) => ({ ...prev, [modelId]: null }));
      setNotice(null);

      let clip;
      try {
        clip = await loadBenchmarkClip();
      } catch {
        setErrors((prev) => ({
          ...prev,
          [modelId]: 'The benchmark reference clip could not be loaded.',
        }));
        return;
      }

      useSpeechStore.getState().setBenchmarkRunning(modelId);
      let reply;
      try {
        reply = await speech.benchmark({ modelId, clip });
      } catch (error) {
        if (mountedRef.current) {
          setErrors((prev) => ({
            ...prev,
            [modelId]: 'The benchmark could not be run.',
          }));
        }
        return;
      } finally {
        // Always clear "running", including on a thrown rejection — a button
        // stuck on "Cancel run" for a run that already ended is its own bug.
        if (mountedRef.current) useSpeechStore.getState().setBenchmarkRunning(null);
      }
      if (!mountedRef.current) return;

      if (!reply || reply.ok === false) {
        setErrors((prev) => ({
          ...prev,
          [modelId]: reply?.message ?? 'The benchmark could not be run.',
        }));
        return;
      }
      if (reply.cancelled) {
        setNotice(
          reply.stopped === false
            ? 'There was no benchmark running to cancel.'
            : 'The benchmark was cancelled.'
        );
        return;
      }

      // `measured: false` is a successful run that correctly declined to invent
      // numbers. Store the row AS IS so the reason survives to the table — this
      // is the case that must never be smoothed over.
      useSpeechStore.getState().recordBenchmarkResult(reply);
    },
    []
  );

  const useSuggested = useCallback(async () => {
    const speech = bridge();
    if (!speech || typeof speech.selectModel !== 'function' || !recommendation.modelId) return;
    setSelecting(true);
    try {
      const reply = await speech.selectModel({ modelId: recommendation.modelId });
      if (reply && reply.ok === false) {
        setNotice(reply.message ?? 'The suggested model could not be selected.');
      } else {
        setNotice(`Using ${recommendation.modelId}.`);
      }
    } finally {
      if (mountedRef.current) setSelecting(false);
    }
  }, [recommendation.modelId]);

  const cancel = useCallback(async (modelId) => {
    const speech = bridge();
    if (!speech || typeof speech.benchmark !== 'function') return;
    const reply = await speech.benchmark({ modelId, cancel: true });
    if (!mountedRef.current || !reply || reply.ok === false) return;
    setNotice(
      reply.stopped === false
        ? 'There was no benchmark running to cancel.'
        : 'Cancelling — the engine stops the work, it does not just hide the result.'
    );
  }, []);

  // --- states ------------------------------------------------------------
  const nothingRun = results.length === 0;
  const nothingMeasured = !nothingRun && comparable.length === 0;
  const unmeasuredReason = results.find((r) => r.measured === false)?.reason ?? '';

  const card = cardClass ?? 'rounded-xl border p-5 space-y-4';
  const title = titleClass ?? 'text-[11px] font-bold uppercase tracking-wider';
  const muted = darkMode ? 'text-gray-400' : 'text-gray-500';
  const border = darkMode ? 'border-gray-800' : 'border-gray-200';

  return (
    <section aria-label="Model benchmark" className={card} data-testid="model-benchmark-panel">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className={title}>Benchmark</h3>
        <p className={`text-xs ${muted}`}>
          Measured on this computer, against a reference clip. Run it on the model you are
          considering — a model that cannot keep up with a live service is not a fast model, it is
          the wrong model.
        </p>
      </div>

      {/* The recommendation leads, and states its own reasoning so it can be
          disagreed with (plan 9.4). */}
      {recommendation.modelId ? (
        <div
          data-testid="benchmark-recommendation"
          className={`rounded-lg border p-3 text-xs leading-relaxed ${border}`}
        >
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="font-semibold">Suggested: {recommendation.modelId}</span>
            {recommendation.modelId !== currentModelId ? (
              <button
                type="button"
                data-testid="benchmark-use-suggested"
                disabled={selecting}
                onClick={useSuggested}
                className={`rounded-md border px-2 py-1 font-semibold disabled:opacity-50 ${
                  darkMode
                    ? 'border-gray-700 bg-gray-900 text-gray-200 hover:bg-gray-800'
                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                {selecting ? 'Selecting…' : 'Use suggested model'}
              </button>
            ) : null}
          </div>
          <p className={`mt-1 ${muted}`}>{recommendation.reason}</p>
        </div>
      ) : (
        <div
          data-testid="benchmark-no-recommendation"
          className={`rounded-lg border p-3 text-xs leading-relaxed ${border}`}
        >
          <span className="font-semibold">Nothing recommended yet.</span>
          <p className={`mt-1 ${muted}`}>
            {recommendation.reason ||
              (unmeasuredReason
                ? unmeasuredReason
                : 'Run the benchmark on at least one model and a suggestion will appear here.')}
          </p>
        </div>
      )}

      {/* Per-model actions and results. Structure always renders, so an operator
          can see the shape of the answer even with nothing measured. */}
      <div className="space-y-2" data-testid="benchmark-model-list">
        {models.length === 0 ? (
          <p className={`text-sm ${muted}`}>No models are available for this provider.</p>
        ) : null}

        {models.map((model) => {
          const result = results.find((r) => r.modelId === model.id) ?? null;
          const isRunning = runningId === model.id;
          const canRun = model.id === currentModelId;
          const notes = result?.measured ? warningsFor(result) : [];
          const gatedOut = result?.measured === true && !passesRtfGate(result);

          return (
            <div
              key={model.id}
              data-testid={`benchmark-row-${model.id}`}
              className={`rounded-lg border p-3 text-xs space-y-2 ${border}`}
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="font-semibold">{model.displayName ?? model.id}</span>
                {isRunning ? (
                  <button
                    type="button"
                    data-testid={`benchmark-cancel-${model.id}`}
                    onClick={() => cancel(model.id)}
                    className={`rounded-md border px-2 py-1 font-semibold ${
                      darkMode
                        ? 'border-gray-700 bg-gray-900 text-gray-200 hover:bg-gray-800'
                        : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    Cancel run
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid={`benchmark-run-${model.id}`}
                    disabled={!canRun}
                    title={canRun ? undefined : 'Select this model first'}
                    onClick={() => run(model.id)}
                    className={`rounded-md border px-2 py-1 font-semibold ${
                      darkMode
                        ? 'border-gray-700 bg-gray-900 text-gray-200 hover:bg-gray-800'
                        : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    {isRunning ? 'Cancel run' : result ? 'Re-run' : canRun ? 'Run benchmark' : 'Select first'}
                  </button>
                )}
              </div>

              {/* The honest empty state for a single model. */}
              {!result ? (
                <p className={muted} data-testid={`benchmark-pending-${model.id}`}>
                  Not measured yet.
                </p>
              ) : null}

              {result && result.measured === false ? (
                <p className={muted} data-testid={`benchmark-unmeasured-${model.id}`}>
                  <span className="font-semibold">Not measured.</span> {result.reason}
                </p>
              ) : null}

              {errors[model.id] ? (
                <p className="text-red-400" data-testid={`benchmark-error-${model.id}`}>
                  {errors[model.id]}
                </p>
              ) : null}

              {result && result.measured === true ? (
                <>
                  <dl
                    className="grid grid-cols-2 sm:grid-cols-4 gap-2"
                    data-testid={`benchmark-metrics-${model.id}`}
                  >
                    <Metric label="Error rate" value={percent(result.wer)} />
                    <Metric
                      label="Speed"
                      value={speed(result.rtf)}
                      hint={
                        typeof result.rtf === 'number' && !passesRtfGate(result)
                          ? `Too slow — needs ${result.rtf.toFixed(2)}x real time`
                          : null
                      }
                    />
                    <Metric label="First partial" value={seconds(result.firstPartialMs)} />
                    <Metric
                      label="Backend"
                      value={result.backend ?? DASH}
                      hint={
                        typeof result.backend === 'string' && /^cpu$/i.test(result.backend)
                          ? 'Ran on the CPU — the GPU may never have been used'
                          : null
                      }
                    />
                  </dl>
                  {gatedOut ? (
                    <p className="text-amber-400" data-testid={`benchmark-gated-${model.id}`}>
                      Excluded from the comparison: it cannot keep up with a live service (needs{' '}
                      {result.rtf.toFixed(2)}x real time, and anything above {THRESHOLDS.RTF_GATE}x falls
                      behind the speaker).
                    </p>
                  ) : null}
                  {notes.length > 0 ? (
                    <ul className="space-y-1" data-testid={`benchmark-warnings-${model.id}`}>
                      {notes.map((note, index) => (
                        <li key={index} className="text-amber-400">
                          {note.reason}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : null}
            </div>
          );
        })}
      </div>

      {nothingRun ? (
        <p className={`text-sm ${muted}`} data-testid="benchmark-nothing-run">
          Nothing has been benchmarked yet. Run one above — it takes a few minutes and it is the
          only way to find out which model this computer can actually keep up with.
        </p>
      ) : null}

      {nothingMeasured ? (
        <p className={`text-sm ${muted}`} data-testid="benchmark-nothing-measured">
          Nothing has been measured yet.{' '}
          {unmeasuredReason || 'The engine running cannot produce real measurements.'}
        </p>
      ) : null}

      {notice ? (
        <p className={`text-xs ${muted}`} role="status" data-testid="benchmark-notice">
          {notice}
        </p>
      ) : null}
    </section>
  );
};

/** One metric cell. A dash is explained rather than left blank. */
function Metric({ label, value, hint }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider opacity-70">{label}</dt>
      <dd className="font-mono text-xs">{value}</dd>
      {hint ? <p className="text-[10px] text-amber-400">{hint}</p> : null}
    </div>
  );
}

export default ModelBenchmarkPanel;
export { DASH, rowId };
