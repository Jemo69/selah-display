/**
 * ModelBenchmarkPanel — the honesty rules, tested where they matter.
 *
 * The panel's whole job is to be trusted, so the tests are mostly about what it
 * REFUSES to show: no invented numbers, no fabricated recommendation, no
 * pretending a failed run was a good one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resetBenchmarkClipCache } from '@/speech/benchmarkClip.js';
import ModelBenchmarkPanel from '@/components/Speech/ModelBenchmarkPanel';
import useSpeechStore, { speechDefaults } from '@/context/SpeechStore';

/** A measured result as the engine would return it. */
const MEASURED = (modelId, wer, rtf, extra = {}) => ({
  measured: true,
  modelId,
  engineKind: 'whispercpp',
  reason: '',
  wer,
  rtf,
  firstPartialMs: 700,
  backend: 'Metal',
  loadTimeMs: 4200,
  gpuUtilMean: 0.6,
  gpuUtilPeak: 0.8,
  peakRssBytes: 4_700_000_000,
  firstThirdRtf: null,
  lastThirdRtf: null,
  ...extra,
});

/** What the canned engine answers: a successful run that measured nothing. */
const UNMEASURED = {
  measured: false,
  modelId: 'large-v3',
  engineKind: 'fake',
  reason:
    'The engine running is the test engine, which replays a fixed sentence. It can show that the benchmark pipeline works, but every number it produces would be fiction.',
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

const WAV = readFileSync(path.join(process.cwd(), 'speech-engine/test/fixtures/voice-smoke-16k.wav'));

const resetStore = () => {
  useSpeechStore.setState({
    ...speechDefaults(),
    status: 'idle',
    health: null,
    lastError: null,
    benchmarkRunningId: null,
  });
};

/** Install a stubbed speech bridge. */
function installBridge(benchmark) {
  const fn = vi.fn(benchmark ?? (async () => ({ ok: true, ...UNMEASURED })));
  window.electronAPI = { speech: { benchmark: fn } };
  return fn;
}

describe('ModelBenchmarkPanel', () => {
  beforeEach(() => {
    localStorage.clear();
    resetBenchmarkClipCache();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => WAV.buffer.slice(WAV.byteOffset, WAV.byteOffset + WAV.byteLength),
    })));
    resetStore();
    window.electronAPI = undefined;
  });

  afterEach(() => {
    delete window.electronAPI;
    resetBenchmarkClipCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('says nothing has been benchmarked yet, and does not pretend otherwise', () => {
    render(<ModelBenchmarkPanel />);
    expect(screen.getByTestId('benchmark-nothing-run')).toBeInTheDocument();
    expect(screen.getByTestId('benchmark-no-recommendation')).toBeInTheDocument();
    // No numbers anywhere before a run.
    expect(screen.queryByTestId('benchmark-recommendation')).toBeNull();
  });

  it('offers Run on every catalog model', () => {
    render(<ModelBenchmarkPanel />);
    expect(screen.getByTestId('benchmark-run-large-v3')).toBeInTheDocument();
    expect(screen.getByTestId('benchmark-run-tiny.en-q5_1')).toBeInTheDocument();
    expect(screen.getByTestId('benchmark-pending-large-v3')).toHaveTextContent('Not measured yet');
  });

  // THE test. A canned engine's answer must reach the operator intact.
  it('shows NOT MEASURED with the engine’s reason — never a plausible number', async () => {
    const benchmark = installBridge(async () => ({ ok: true, ...UNMEASURED }));
    render(<ModelBenchmarkPanel />);

    fireEvent.click(screen.getByTestId('benchmark-run-large-v3'));

    await waitFor(() => {
      expect(screen.getByTestId('benchmark-unmeasured-large-v3')).toBeInTheDocument();
    });
    expect(benchmark).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'large-v3', clip: expect.any(Object) }));

    // The reason is shown verbatim, so the operator knows WHAT is wrong.
    expect(screen.getByTestId('benchmark-unmeasured-large-v3')).toHaveTextContent(
      /replays a fixed sentence/
    );

    // And no metric is rendered as a number.
    expect(screen.queryByTestId('benchmark-metrics-large-v3')).toBeNull();
    expect(screen.queryByTestId('benchmark-recommendation')).toBeNull();
    expect(screen.getByTestId('benchmark-no-recommendation')).toBeInTheDocument();
  });

  it('explains that nothing is measurable once an unmeasured row exists', async () => {
    installBridge(async () => ({ ok: true, ...UNMEASURED }));
    render(<ModelBenchmarkPanel />);
    fireEvent.click(screen.getByTestId('benchmark-run-large-v3'));

    await waitFor(() => {
      expect(screen.getByTestId('benchmark-nothing-measured')).toBeInTheDocument();
    });
    expect(screen.getByTestId('benchmark-nothing-measured')).toHaveTextContent(
      /replays a fixed sentence/
    );
  });

  it('renders measured metrics and a recommendation from real results', async () => {
    useSpeechStore.getState().recordBenchmarkResult(MEASURED('large-v3-turbo-q8_0', 0.046, 0.5));
    useSpeechStore.getState().recordBenchmarkResult(MEASURED('large-v3', 0.041, 1.8));
    render(<ModelBenchmarkPanel />);

    // The recommendation exists and explains itself. Because large-v3 is
    // GATED OUT (1.8x realtime), turbo-q8_0 is the best of what is eligible —
    // so the honest copy is "nothing to trade for speed", not a speed claim.
    const recommendation = screen.getByTestId('benchmark-recommendation');
    expect(recommendation).toHaveTextContent('large-v3-turbo-q8_0');
    expect(recommendation).toHaveTextContent(/best measured error rate/i);

    // Real numbers appear, for BOTH models — being gated out of the
    // comparison must not hide the measurement itself. (An earlier draft
    // checked 4.6% on large-v3, which is turbo-q8_0's number.)
    expect(screen.getByTestId('benchmark-metrics-large-v3-turbo-q8_0')).toHaveTextContent('4.6%');
    expect(screen.getByTestId('benchmark-metrics-large-v3-turbo-q8_0')).toHaveTextContent('0.50x');
    expect(screen.getByTestId('benchmark-metrics-large-v3')).toHaveTextContent('4.1%');
    expect(screen.getByTestId('benchmark-metrics-large-v3')).toHaveTextContent('1.80x');
    expect(screen.getByTestId('benchmark-metrics-large-v3')).toHaveTextContent('Metal');

    // The too-slow model is measured but EXCLUDED from the comparison, and
    // says so — and the exclusion names the number that caused it.
    const gated = screen.getByTestId('benchmark-gated-large-v3');
    expect(gated).toHaveTextContent(/cannot keep up/i);
    expect(gated).toHaveTextContent('1.80x');
  });

  it('surfaces silent CPU fallback, which is the most valuable diagnostic', () => {
    useSpeechStore.getState().recordBenchmarkResult(
      MEASURED('base.en-q8_0', 0.31, 0.12, { backend: 'cpu', expectedAccel: true })
    );
    render(<ModelBenchmarkPanel />);
    expect(screen.getByTestId('benchmark-metrics-base.en-q8_0')).toHaveTextContent(/GPU may never have been used/i);
  });

  it('surfaces thermal decay when the run slowed down', () => {
    useSpeechStore.getState().recordBenchmarkResult(
      MEASURED('medium.en-q8_0', 0.09, 0.3, { firstThirdRtf: 0.3, lastThirdRtf: 0.9 })
    );
    render(<ModelBenchmarkPanel />);
    expect(screen.getByTestId('benchmark-warnings-medium.en-q8_0')).toHaveTextContent(/slower/i);
  });

  it('replaces a model’s row on re-run instead of stacking two disagreeing results', async () => {
    const replies = [
      { ok: true, ...MEASURED('large-v3', 0.041, 0.9) },
      { ok: true, ...MEASURED('large-v3', 0.052, 0.4) },
    ];
    let call = 0;
    const benchmark = installBridge(async () => replies[call++] ?? replies[replies.length - 1]);
    render(<ModelBenchmarkPanel />);

    fireEvent.click(screen.getByTestId('benchmark-run-large-v3'));
    await waitFor(() => expect(screen.getByTestId('benchmark-metrics-large-v3')).toHaveTextContent('4.1%'));

    // Now the button offers a re-run rather than adding a second row.
    fireEvent.click(screen.getByTestId('benchmark-run-large-v3'));
    await waitFor(() => expect(screen.getByTestId('benchmark-metrics-large-v3')).toHaveTextContent('5.2%'));
    expect(benchmark).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId('benchmark-metrics-large-v3')).toHaveLength(1);
  });

  it('reports a run failure as an error, and never as a good result', async () => {
    installBridge(async () => ({ ok: false, message: 'The model could not be loaded: model-unreadable.' }));
    render(<ModelBenchmarkPanel />);

    fireEvent.click(screen.getByTestId('benchmark-run-large-v3'));
    await waitFor(() => {
      expect(screen.getByTestId('benchmark-error-large-v3')).toHaveTextContent(/model-unreadable/);
    });
    // No metrics, and no recommendation manufactured from a failure.
    expect(screen.queryByTestId('benchmark-metrics-large-v3')).toBeNull();
    expect(screen.queryByTestId('benchmark-recommendation')).toBeNull();
  });

  it('clears the running state even when the bridge rejects', async () => {
    installBridge(async () => {
      throw new Error('bridge exploded');
    });
    render(<ModelBenchmarkPanel />);

    fireEvent.click(screen.getByTestId('benchmark-run-large-v3'));
    await waitFor(() => {
      expect(screen.getByTestId('benchmark-error-large-v3')).toBeInTheDocument();
    });
    // Cancel must not still be offered for a run that ended.
    expect(useSpeechStore.getState().benchmarkRunningId).toBeNull();
    expect(screen.getByTestId('benchmark-run-large-v3')).toBeInTheDocument();
  });

  it('offers Cancel while a run is in flight, and says what cancelling did', async () => {
    let resolveRun;
    installBridge(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        })
    );
    render(<ModelBenchmarkPanel />);

    fireEvent.click(screen.getByTestId('benchmark-run-large-v3'));
    await waitFor(() =>
      expect(screen.getByTestId('benchmark-cancel-large-v3')).toBeInTheDocument()
    );

    // Swap the bridge for one that answers a cancel, then cancel.
    window.electronAPI.speech.benchmark = vi.fn(async () => ({ ok: true, cancelled: true, stopped: true }));
    fireEvent.click(screen.getByTestId('benchmark-cancel-large-v3'));
    // The notice says what cancelling DOES — the engine stops the work rather
    // than hiding the result. Matching on the strong claim, not just the word
    // "cancel", so the copy cannot quietly become a lie.
    await waitFor(() => {
      expect(screen.getByTestId('benchmark-notice')).toHaveTextContent(/stops the work/i);
    });

    resolveRun?.({ ok: true, ...MEASURED('large-v3', 0.04, 0.5) });
  });

  it('says honestly when a cancel had nothing to cancel', async () => {
    installBridge(async () => ({ ok: true, cancelled: true, stopped: false }));
    render(<ModelBenchmarkPanel />);

    let resolveRun;
    window.electronAPI.speech.benchmark = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        })
    );
    fireEvent.click(screen.getByTestId('benchmark-run-large-v3'));
    await waitFor(() => expect(screen.getByTestId('benchmark-cancel-large-v3')).toBeInTheDocument());

    window.electronAPI.speech.benchmark = vi.fn(async () => ({ ok: true, cancelled: true, stopped: false }));
    fireEvent.click(screen.getByTestId('benchmark-cancel-large-v3'));
    await waitFor(() => {
      expect(screen.getByTestId('benchmark-notice')).toHaveTextContent(/no benchmark running/i);
    });
    resolveRun?.({ ok: true, ...MEASURED('large-v3', 0.04, 0.5) });
  });

  it('is cold: rendering opens nothing and calls nothing', () => {
    const benchmark = installBridge();
    render(<ModelBenchmarkPanel />);
    // A benchmark is explicit user action (plan 9.4: "never on install, never
    // on a schedule, never on launch").
    expect(benchmark).not.toHaveBeenCalled();
  });

  it('persists results but never runtime state', () => {
    useSpeechStore.getState().recordBenchmarkResult(MEASURED('large-v3', 0.041, 0.9));
    const blob = JSON.parse(localStorage.getItem('speech-store') ?? '{}');

    expect(Array.isArray(blob.state?.benchmarkResults)).toBe(true);
    expect(blob.state.benchmarkResults).toHaveLength(1);
    // In-flight state is NOT persisted — a crash mid-benchmark must not
    // resurrect a "running" claim, same as `status`.
    expect(blob.state).not.toHaveProperty('benchmarkRunningId');
  });
});
