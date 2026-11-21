import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Gauge, X } from 'lucide-react';
import { getDefaultModel, getModel, getProvider } from 'shared/speech';
import useSpeechStore from '../../context/SpeechStore';

// ---------------------------------------------------------------------------
// InstallEngineWizard — the Phase 2 install surface for the local engine's
// transcription model.
//
// State machine (per selected model):
//   not-installed -> downloading -> installed -> first-benchmark-pending
//
// INVARIANTS held here:
//  - Cold on render: mounting this component performs no download, no spawn,
//    no microphone call, and no network request. The only bridge traffic is a
//    read-only `getState()` to learn what is already on disk, plus the
//    subscriptions the user's own clicks set in motion.
//  - Nothing is gated on hardware: a benchmark pre-filter (Phase 3) may later
//    RECOMMEND a smaller model, but this component never blocks an install.
//  - The disabled benchmark affordance is present and honest, never silent.
//  - Errors name the offline drop-in directory, because that is the path that
//    works when the download does not.
//
// `useModelInstallState` is the shared bridge hook: the wizard and the model
// catalog each hold their own instance (two subscriptions, one main-process
// download task — speech:install deduplicates per model).
// ---------------------------------------------------------------------------

export const BENCHMARK_TITLE = 'Benchmarking arrives in Phase 3';

/**
 * After a model finishes installing, which model should the app run?
 *
 * The store defaults to the best model, not the smallest, and not the one
 * anyone downloads first. Installing `tiny` and walking away left the store
 * naming a model that is not on disk: the supervisor repairs that at start
 * (main/speechIpc.js substitutes an installed model), but every surface
 * between installs still showed the wrong name. A finished install becomes
 * the active model, but ONLY when the current choice cannot run: a working
 * selection is never displaced mid-service.
 *
 * @param {{currentModelId?: string|null, installedIds?: string[], justInstalledId?: string|null}} options
 * @returns {string|null} the model to select, or null to leave the store alone
 */
export function chooseModelAfterInstall({ currentModelId, installedIds, justInstalledId } = {}) {
  const ids = new Set(installedIds ?? []);
  if (!justInstalledId || !ids.has(justInstalledId)) return null;
  if (currentModelId === justInstalledId) return null;
  if (currentModelId && ids.has(currentModelId)) return null;
  return justInstalledId;
}

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const rounded = index === 0 || value >= 100 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${units[index]}`;
};

const percentOf = (received, total) => {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((received / total) * 100)));
};

const bridge = () => (typeof window === 'undefined' ? null : window.electronAPI?.speech ?? null);

/**
 * The shared install-state hook. Read-only until the user acts:
 *
 *  - `getState()` once on mount, then `onInstallState` / `onProgress` /
 *    `onError` subscriptions (all unsubscribe on unmount).
 *  - `install(modelId)` starts OR joins a download (main dedupes), and
 *    `cancel(modelId)` cancels it. Both return the raw result.
 *  - `isDownloading(modelId)` merges the local "just clicked" flag with the
 *    main process's `activeDownloads`, so the button flips instantly.
 */
export function useModelInstallState() {
  const [installState, setInstallState] = useState(null);
  const [progress, setProgress] = useState({});
  const [engineProgress, setEngineProgress] = useState(null);
  const [engineInstalling, setEngineInstalling] = useState(false);
  // The main process's actual asset-selection decision, not a guess from UI
  // state: which backend was selected, and why a GPU/case fell back.
  const [engineInstallResult, setEngineInstallResult] = useState(null);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState({});

  const refresh = useCallback(async () => {
    const speech = bridge();
    if (!speech || typeof speech.getState !== 'function') return;
    try {
      const state = await speech.getState();
      if (state?.installState) setInstallState(state.installState);
    } catch {
      // A missing bridge reads as "unknown", never as an error banner.
    }
  }, []);

  useEffect(() => {
    const speech = bridge();
    if (!speech) return undefined;

    let alive = true;
    const offs = [];
    const keep = (off) => {
      if (typeof off === 'function') offs.push(off);
    };

    refresh();

    keep(speech.onInstallState?.((state) => {
      if (alive && state) setInstallState(state);
    }));
    keep(speech.onProgress?.((payload) => {
      if (!alive || !payload) return;
      if (payload.kind === 'engine') {
        setEngineProgress(payload);
        return;
      }
      if (!payload.modelId) return;
      setProgress((previous) => ({ ...previous, [payload.modelId]: payload }));
    }));
    keep(speech.onError?.((payload) => {
      if (alive && payload && typeof payload.message === 'string') setError(payload);
    }));

    return () => {
      alive = false;
      offs.forEach((off) => {
        try {
          off();
        } catch {
          // Bridge already torn down — nothing to release.
        }
      });
    };
  }, [refresh]);

  // Stale progress is cleared the moment it stops being true: the model is
  // installed, or it is neither active nor resumable (cancelled / failed with
  // the partial reclaimed).
  useEffect(() => {
    if (!installState) return;
    const installed = new Set((installState.installed ?? []).map((entry) => entry.id));
    const active = new Set((installState.activeDownloads ?? []).map((entry) => entry.modelId));
    const partial = new Set((installState.partials ?? []).map((entry) => entry.id));
    setProgress((previous) => {
      let changed = false;
      const next = { ...previous };
      Object.keys(next).forEach((modelId) => {
        const settled = installed.has(modelId) || (!active.has(modelId) && !partial.has(modelId));
        if (settled) {
          delete next[modelId];
          changed = true;
        }
      });
      return changed ? next : previous;
    });
  }, [installState]);

  const install = useCallback(async (modelId) => {
    const speech = bridge();
    if (!speech || typeof speech.install !== 'function' || !modelId) return null;
    setError(null);
    setStarting((previous) => ({ ...previous, [modelId]: true }));
    let result = null;
    try {
      result = await speech.install({ modelId });
    } catch (err) {
      result = {
        ok: false,
        code: 'bridge-error',
        message: err?.message ?? 'The download could not start. Try again.',
      };
    } finally {
      setStarting((previous) => {
        const next = { ...previous };
        delete next[modelId];
        return next;
      });
      await refresh();
    }
    if (result && result.ok === false && result.code !== 'cancelled') {
      setError({ code: result.code, message: result.message });
    }

    // Make the model that was just installed the one the engine will run — but
    // only when the current choice cannot run, and only while nothing is
    // running. A JOINED download is not a finished one: `speech:install`
    // answers { ok:true, state:'downloading', alreadyRunning:true } for a second
    // caller, and adopting then would point the app at a file still being written.
    // A RUNNING engine is left alone because main fixes the model at fork time
    // and the driver captures it at construction. Goes through
    // speech:select-model so a digest mismatch is refused here as on a card click.
    const finished =
      result?.ok === true && result.alreadyRunning !== true && result.state !== 'downloading';
    if (finished) {
      const speech = bridge();
      if (speech && typeof speech.selectModel === 'function') {
        let installedIds = [];
        let engineRunning = false;
        try {
          const state = await speech.getState?.();
          installedIds = (state?.installState?.installed ?? []).map((entry) => entry.id);
          engineRunning = state?.running === true;
        } catch {
          installedIds = [];
        }
        const chosen = engineRunning
          ? null
          : chooseModelAfterInstall({
              currentModelId: useSpeechStore.getState().modelId ?? null,
              installedIds,
              justInstalledId: modelId,
            });
        if (chosen) {
          try {
            const verdict = await speech.selectModel({ modelId: chosen });
            if (verdict?.ok) useSpeechStore.getState().setModelId(chosen);
          } catch {
            // The catalog still offers the card, so the user can select it by
            // hand; a failed auto-selection is not an error worth a banner.
          }
        }
      }
    }

    return result;
  }, [refresh]);

  const cancel = useCallback(async (modelId) => {
    const speech = bridge();
    if (!speech || typeof speech.install !== 'function' || !modelId) return null;
    try {
      return await speech.install({ modelId, cancel: true });
    } catch {
      return null;
    } finally {
      await refresh();
    }
  }, [refresh]);

  /**
   * Install the REAL engine binary. Without it, Production mode cannot run:
   * the main process refuses the start instead of silently using the canned
   * engine, and this is the control that makes that refusal recoverable.
   */
  const installEngine = useCallback(async () => {
    const speech = bridge();
    if (!speech || typeof speech.installEngine !== 'function') return null;
    setError(null);
    setEngineInstalling(true);
    setEngineProgress(null);
    let result = null;
    try {
      result = await speech.installEngine();
    } catch (err) {
      result = {
        ok: false,
        code: 'bridge-error',
        message: err?.message ?? 'The engine install could not start. Try again.',
      };
    } finally {
      setEngineInstalling(false);
      await refresh();
    }
    setEngineInstallResult(result);
    if (result && result.ok === false) {
      setError({ code: result.code, message: result.message });
    }
    return result;
  }, [refresh]);

  const isDownloading = useCallback(
    (modelId) =>
      starting[modelId] === true ||
      (installState?.activeDownloads ?? []).some((entry) => entry.modelId === modelId),
    [installState, starting]
  );

  return {
    installState,
    progress,
    engineProgress,
    engineInstalling,
    engineInstallResult,
    error,
    starting,
    install,
    installEngine,
    cancel,
    isDownloading,
    clearError: () => setError(null),
    refresh,
  };
}

const InstallEngineWizard = ({ darkMode = false }) => {
  const modelId = useSpeechStore((state) => state.modelId);
  const providerId = useSpeechStore((state) => state.providerId);
  // Providers with nothing to install (OS on-device) have no model file, no
  // download, and no digest — the model section below would invite installing
  // a file the engine will never read, so it renders a note instead.
  const noModelNeeded = getProvider(providerId)?.needsNoInstall === true;
  const {
    installState,
    progress,
    engineProgress,
    engineInstalling,
    engineInstallResult,
    error,
    install,
    installEngine,
    cancel,
    isDownloading,
    clearError,
  } = useModelInstallState();

  // "Continue" moves installed -> first-benchmark-pending. Keyed by model so
  // switching models never inherits another model's acknowledgement.
  const [continuedFor, setContinuedFor] = useState(null);
  // Explicit engine self-test result. A present binary is not a runnable
  // binary — the Windows build needs the VC++ runtime — so this is the control
  // that turns that into a sentence instead of an empty transcript.
  const [engineTest, setEngineTest] = useState(null);
  const [engineTesting, setEngineTesting] = useState(false);

  const runEngineTest = async () => {
    const speech = bridge();
    if (!speech || typeof speech.testEngine !== 'function') return;
    setEngineTesting(true);
    setEngineTest(null);
    try {
      setEngineTest(await speech.testEngine());
    } catch (err) {
      setEngineTest({ ok: false, message: err?.message ?? 'The engine test failed.' });
    } finally {
      setEngineTesting(false);
    }
  };
  // Bytes already on disk when THIS component started the download: the only
  // honest basis for the "Resuming" label.
  const [resumedFrom, setResumedFrom] = useState({});

  // Without the Electron bridge there is nothing to install from (plain
  // browser / tests): render nothing rather than a dead control.
  if (!bridge()) return null;

  const model = getModel(modelId) ?? getDefaultModel();
  if (!model) return null;

  const installed = (installState?.installed ?? []).find((entry) => entry.id === model.id) ?? null;
  const partial = (installState?.partials ?? []).find((entry) => entry.id === model.id) ?? null;
  const downloading = isDownloading(model.id);
  const current = progress[model.id] ?? null;
  const modelsDir = installState?.modelsDir ?? null;
  const isDefault = model.default === true;
  const quantised = model.quantization !== 'f16';

  const engine = installState?.engine ?? null;
  const engineReady = engine?.installed === true;
  const engineSupported = engine?.supported !== false;
  const enginePercent = engineProgress
    ? percentOf(engineProgress.receivedBytes, engineProgress.totalBytes ?? 0)
    : 0;

  const cardClass = `rounded-xl border p-5 space-y-4 transition-all ${
    darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white'
  }`;
  const labelClass = `text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`;
  const mutedClass = `text-xs leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-600'}`;
  const primaryButton =
    'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors bg-[#1a5c54] text-white hover:bg-[#134a43]';
  const quietButton = `inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold ${
    darkMode
      ? 'border-gray-700 bg-gray-900 text-gray-300 hover:bg-gray-800'
      : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
  }`;

  const handleInstall = () => {
    setResumedFrom((previous) =>
      partial && partial.receivedBytes > 0
        ? { ...previous, [model.id]: partial.receivedBytes }
        : previous
    );
    install(model.id);
  };

  const handleCancel = () => {
    cancel(model.id);
    setResumedFrom((previous) => {
      const next = { ...previous };
      delete next[model.id];
      return next;
    });
  };

  const percent = current
    ? percentOf(current.receivedBytes, current.totalBytes)
    : partial
      ? percentOf(partial.receivedBytes, partial.totalBytes)
      : 0;
  const resumeBytes = resumedFrom[model.id];

  let body = null;

  if (!installState) {
    body = (
      <p data-testid="speech-install-loading" className={mutedClass}>
        Checking which models are installed…
      </p>
    );
  } else if (downloading) {
    body = (
      <div className="space-y-3" data-testid="speech-install-downloading">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <span className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            Downloading {model.displayName}
          </span>
          <button type="button" onClick={handleCancel} data-testid="speech-install-cancel" className={quietButton}>
            <X className="w-3.5 h-3.5" aria-hidden="true" /> Cancel
          </button>
        </div>

        <div
          role="progressbar"
          aria-label={`Downloading ${model.displayName}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          data-testid="speech-install-progress"
          className={`h-2 rounded-full overflow-hidden ${darkMode ? 'bg-gray-800' : 'bg-gray-100'}`}
        >
          <div
            className="h-full bg-[#7DDBD3] transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>

        <p className={mutedClass}>
          {percent}% · {formatBytes(current?.receivedBytes ?? partial?.receivedBytes ?? 0) ?? '0 B'} of{' '}
          {formatBytes(current?.totalBytes ?? partial?.totalBytes ?? model.downloadBytes)}
          {current?.mbps ? ` · ${current.mbps} MB/s` : ''}
        </p>

        {resumeBytes ? (
          <p
            data-testid="speech-install-resume-note"
            className={`text-[11px] leading-relaxed ${darkMode ? 'text-[#7DDBD3]' : 'text-[#1a5c54]'}`}
          >
            Resuming from {formatBytes(resumeBytes)} — the partial download was kept, so nothing
            already transferred is fetched twice.
          </p>
        ) : null}
      </div>
    );
  } else if (installed) {
    body =
      continuedFor === model.id ? (
        <div className="space-y-3" data-testid="speech-install-benchmark-pending">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" aria-hidden="true" />
            <span className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              {model.displayName} is downloaded and verified
            </span>
          </div>
          <p className={mutedClass}>
            The model file is stored on this machine and its digest matches what the
            catalog pinned. Whether Sermon Assist can use it depends on the engine this
            build ships for this platform: Windows and Linux offer a whisper.cpp
            download, macOS does not yet — install it from the engine section above,
            or Production mode cannot start. The Speech panel on this page names the engine that is actually
            running. What has <strong>not</strong> been measured on this machine is how
            fast or how accurate the model is — that is what the benchmark adds, and it
            only ever recommends.
          </p>
          <button type="button" disabled title={BENCHMARK_TITLE} data-testid="speech-install-benchmark"
            className={`${quietButton} cursor-not-allowed opacity-60`}>
            <Gauge className="w-3.5 h-3.5" aria-hidden="true" /> Run benchmark
          </button>
        </div>
      ) : (
        <div className="space-y-3" data-testid="speech-install-installed">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" aria-hidden="true" />
            <span className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              {model.displayName} is installed
            </span>
          </div>
          <p className={mutedClass}>
            {formatBytes(installed.bytes)} on disk ·{' '}
            {installed.digestRecorded
              ? 'digest verified against the recorded checksum'
              : 'digest pinned on first use'}{' '}
            · source: {installed.source}
          </p>
          <button
            type="button"
            onClick={() => setContinuedFor(model.id)}
            data-testid="speech-install-continue"
            className={primaryButton}
          >
            Continue
          </button>
        </div>
      );
  } else {
    body = (
      <div className="space-y-3" data-testid="speech-install-not-installed">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <span className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            Install {model.displayName}
          </span>
          <button type="button" onClick={handleInstall} data-testid="speech-install-start" className={primaryButton}>
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            {partial ? 'Resume download' : 'Install'}
          </button>
        </div>

        <p className={mutedClass}>
          {isDefault
            ? 'The default model — best accuracy in the catalog, recommended for capable hardware.'
            : `Not the default — ${model.displayName} trades accuracy for a smaller download.`}{' '}
          {formatBytes(model.downloadBytes)} download · ~{model.ramGb} GB RAM while transcribing.
        </p>

        {/* First run on a fresh machine: the catalog default is the 3.1 GB
            large-v3, which is a long wait just to find out whether the engine
            runs at all. Tiny English proves the whole chain in 78 MB, and the
            engine picks it up automatically. */}
        {model.id !== 'tiny.en' && (installState?.installed ?? []).length === 0 ? (
          <button
            type="button"
            onClick={() => install('tiny.en')}
            data-testid="speech-install-tiny"
            className={quietButton}
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            Install Tiny English instead (78 MB)
          </button>
        ) : null}

        {quantised ? (
          <p className={mutedClass}>
            Quantised build ({model.quantization}): a deliberate downgrade, not the expected path —
            pick it when the machine cannot hold the full-precision default.
          </p>
        ) : null}

        {partial ? (
          <p
            data-testid="speech-install-resume-note"
            className={`text-[11px] leading-relaxed ${darkMode ? 'text-[#7DDBD3]' : 'text-[#1a5c54]'}`}
          >
            {percent}% already downloaded — resuming continues from there with a Range request
            instead of starting over.
          </p>
        ) : null}

        <p data-testid="speech-install-dropin" className={`text-[11px] leading-relaxed ${mutedClass}`}>
          Offline install: place <span className="font-semibold">{model.fileName}</span>
          {modelsDir ? (
            <>
              {' '}into <span className="font-semibold">{modelsDir}</span>
            </>
          ) : null}{' '}
          and the app detects it on the next launch — no download required.
        </p>

        <p className={mutedClass}>
          Your hardware only decides which model benchmarks best (Phase 3). It never blocks this
          install.
        </p>
      </div>
    );
  }

  return (
    <section className={cardClass} data-testid="speech-install-wizard">
      <div className="space-y-1.5">
        <span className={labelClass}>Engine binary</span>
        <p className={mutedClass}>
          Production mode runs a real whisper.cpp process on this machine. It needs the
          engine binary once; after that nothing about it changes unless you reinstall.
        </p>
      </div>

      <div
        data-testid="speech-engine-binary"
        className={`space-y-3 rounded-lg border p-4 ${
          engineReady
            ? darkMode
              ? 'border-emerald-500/30 bg-emerald-500/5'
              : 'border-emerald-200 bg-emerald-50'
            : darkMode
              ? 'border-gray-800 bg-gray-950/40'
              : 'border-gray-200 bg-gray-50'
        }`}
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <span className={labelClass}>whisper.cpp engine</span>
          <span
            data-testid="speech-engine-binary-status"
            className={`text-xs font-semibold ${engineReady ? 'text-emerald-500' : 'text-amber-500'}`}
          >
            {engineReady ? 'Installed' : 'Not installed'}
          </span>
        </div>

        {engineReady ? (
          <div className="space-y-2">
            <p className={mutedClass}>
              whisper.cpp {engine.release} is installed. Production mode transcribes with it.
            </p>
            <button
              type="button"
              onClick={runEngineTest}
              disabled={engineTesting}
              data-testid="speech-engine-test"
              className={`${quietButton} disabled:opacity-60 disabled:cursor-not-allowed`}
            >
              {engineTesting ? 'Testing…' : 'Test engine'}
            </button>
            {engineTest ? (
              <p
                data-testid="speech-engine-test-result"
                data-tone={engineTest.ok ? 'ok' : 'error'}
                className={`text-xs leading-snug ${engineTest.ok ? 'text-emerald-500' : 'text-red-500'}`}
              >
                {engineTest.message}
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <p className={mutedClass}>
              {engineSupported
                ? 'One-time download of the official whisper.cpp build for this platform, verified against its published checksum before anything is unpacked. CPU builds are about 9 MB; a detected CUDA build can be much larger.'
                : 'Selah cannot install a ready-made speech engine for this platform yet. No manual file copying is required or supported.'}
            </p>
            {engineSupported ? (
              <button
                type="button"
                onClick={() => installEngine()}
                disabled={engineInstalling}
                data-testid="speech-engine-install"
                className={`${primaryButton} disabled:opacity-60 disabled:cursor-not-allowed`}
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                {engineInstalling ? 'Installing…' : 'Install speech engine'}
              </button>
            ) : null}
            {engineInstalling ? (
              <div
                role="progressbar"
                aria-label="Downloading the speech engine"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={enginePercent}
                data-testid="speech-engine-progress"
                className={`h-2 rounded-full overflow-hidden ${darkMode ? 'bg-gray-800' : 'bg-gray-100'}`}
              >
                <div className="h-full bg-[#7DDBD3] transition-all" style={{ width: `${enginePercent}%` }} />
              </div>
            ) : null}
            {engine?.binDir ? (
              <p className={mutedClass} data-testid="speech-engine-dropin">
                Offline install: place <span className="font-semibold">whisper-cli</span> (or{' '}
                <span className="font-semibold">whisper-cli.exe</span>) and its libraries into{' '}
                <span className="font-semibold">{engine.binDir}</span>.
              </p>
            ) : null}
          </>
        )}

        {engineInstallResult?.selection?.reason ? (
          <p className={mutedClass} data-testid="speech-engine-install-backend">
            <span className="font-semibold">Engine selection:</span>{' '}
            {engineInstallResult.selection.reason}
          </p>
        ) : null}
      </div>

      {noModelNeeded ? (
        <div className="space-y-1.5">
          <span className={labelClass}>Engine model install</span>
          <p className={mutedClass} data-testid="speech-install-no-model-needed">
            The selected provider uses the platform's built-in speech service — there is no
            model file to download and nothing to verify. Skip this section, and the
            engine binary above: both are whisper.cpp only, and this provider uses neither.
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <span className={labelClass}>Engine model install</span>
            <p className={mutedClass}>
              Local transcription needs the model file on disk. Downloads are resumable, verified
              against the catalog checksum, and never start on their own — only when you click.
            </p>
          </div>

          {body}
        </>
      )}

      {error?.message ? (
        <div
          role="alert"
          data-testid="speech-install-error"
          className={`rounded-lg border p-3 text-xs leading-relaxed flex items-start gap-2 ${
            darkMode
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
              : 'border-amber-200 bg-amber-50 text-amber-800'
          }`}
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span className="flex-1 min-w-0">{error.message}</span>
          <button
            type="button"
            onClick={clearError}
            aria-label="Dismiss install error"
            className={`shrink-0 font-bold ${darkMode ? 'text-amber-300' : 'text-amber-700'}`}
          >
            ×
          </button>
        </div>
      ) : null}
    </section>
  );
};

export default InstallEngineWizard;
