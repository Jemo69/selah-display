import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, Mic } from 'lucide-react';
import useSpeechStore from '../../context/SpeechStore';
import { loadBenchmarkClip } from '../../speech/benchmarkClip.js';
import { getModel } from '../../../shared/speech/index.js';
import {
  friendlyError,
  setupCandidates,
  setupPlan,
  starterModelsAreInCatalog,
} from '../../speech/setupPlan.js';

/**
 * QuickSetupCard — one button that gets Sermon Assist ready.
 *
 * A rotating volunteer should not need to know what a binary, a model file, a
 * graphics driver or a checksum is. This card owns the whole sequence: detect
 * the machine, install the engine, prove it starts, get a suitable voice model,
 * select it. The detailed cards remain below for people who want them.
 *
 * Nothing here turns the microphone on. Success means "ready to start", not
 * "listening". Technical codes and raw messages are stored but collapsed into
 * a support-only disclosure, never shown as the primary explanation.
 */
const bridge = () => (typeof window === 'undefined' ? null : window.electronAPI?.speech ?? null);

const PRIMARY =
  'inline-flex items-center justify-center gap-2 rounded-md bg-[#7DDBD3] px-4 py-2 text-sm font-semibold text-[#111231] hover:bg-[#42B7A7] disabled:opacity-60 disabled:cursor-not-allowed';
const readInstallState = (state) => ({
  engineInstalled: state?.installState?.engine?.installed === true,
  engineBackend: state?.installState?.engine?.backend ?? null,
  engineSelectionCode: state?.installState?.engine?.manifest?.selectionCode ?? null,
  engineCudaVersion: state?.installState?.engine?.manifest?.cudaVersion ?? null,
  installedIds: (state?.installState?.installed ?? []).map((entry) => entry.id),
});

const QuickSetupCard = ({ darkMode = true }) => {
  const [phase, setPhase] = useState('idle');
  const [plan, setPlan] = useState(null);
  const [step, setStep] = useState(null);
  const stepRef = useRef(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [showWhat, setShowWhat] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Read only. This never starts a download, a process or the microphone.
  useEffect(() => {
    let alive = true;
    const speech = bridge();
    if (!speech || typeof speech.getState !== 'function') return undefined;
    Promise.all([
      speech.getState(),
      typeof speech.gpuCapabilities === 'function'
        ? speech.gpuCapabilities().catch(() => null)
        : Promise.resolve(null),
    ]).then(([state, gpu]) => {
      if (!alive) return;
      const install = readInstallState(state);
      setPlan(setupPlan({ gpu, ...install }));
    }).catch(() => {
      // Unknown install state is fine. The button still works and rechecks.
    });
    return () => { alive = false; };
  }, []);

  // Progress is one bar with a plain label. Bytes are shown only when the
  // bridge actually measured them, never invented to look busy.
  useEffect(() => {
    const speech = bridge();
    if (typeof speech?.onProgress !== 'function') return undefined;
    return speech.onProgress((payload) => {
      if (!mountedRef.current || !payload) return;
      // Do not let a model download paint the engine step (or vice versa).
      if (payload.kind === 'engine' && stepRef.current !== 'engine') return;
      if (payload.modelId && stepRef.current !== 'model') return;
      if (!payload.kind && !payload.modelId) return;
      const total = Number(payload.totalBytes);
      const received = Number(payload.receivedBytes);
      if (Number.isFinite(total) && total > 0 && Number.isFinite(received) && received >= 0) {
        setProgress({ percent: Math.min(100, Math.max(0, Math.round((received / total) * 100))) });
      }
    });
  }, []);

  const fail = useCallback((result) => {
    if (!mountedRef.current) return;
    // Keep the user-facing sentence on the mapped code, while preserving the
    // raw diagnostic code only inside the support disclosure. Spreading a
    // bridge result over the friendly code previously erased the useful
    // sentence (e.g. "engine did not start" became the generic fallback).
    const friendlyCode = result?.friendlyCode ?? result?.code;
    const detailCode = result?.detailCode ?? result?.code;
    setPhase('error');
    setError({
      message: friendlyError(friendlyCode),
      detail: [detailCode, result?.message].filter(Boolean).join(': '),
    });
    setProgress(null);
  }, []);

  const run = useCallback(async () => {
    if (phase === 'running') return;
    const speech = bridge();
    const required = ['getState', 'installEngine', 'testEngine', 'install', 'selectModel', 'autoSelectModel', 'setSetupLock'];
    if (!speech || required.some((name) => typeof speech[name] !== 'function')) {
      fail({ code: 'network-unavailable' });
      return;
    }

    setPhase('running');
    setError(null);
    setProgress(null);
    setShowDetails(false);

    const done = (next) => {
      if (!mountedRef.current) return false;
      stepRef.current = next;
      setStep(next);
      setProgress(null);
      return true;
    };

    let lockHeld = false;
    let lockHeartbeat = null;
    try {
      const lock = await speech.setSetupLock(true);
      if (lock?.ok !== true) { fail(lock); return; }
      lockHeld = true;
      // The main lock expires after two minutes without a heartbeat. An
      // active setup refreshes it; a crashed renderer cannot leave the engine
      // locked forever.
      lockHeartbeat = setInterval(() => {
        speech.setSetupLock(true).catch(() => {});
      }, 30_000);
      if (!done('check')) return;
      const gpu = typeof speech.gpuCapabilities === 'function'
        ? await speech.gpuCapabilities().catch(() => null)
        : null;
      if (!mountedRef.current) return;

      const state = await speech.getState();
      if (!mountedRef.current) return;
      let current = setupPlan({ gpu, ...readInstallState(state) });
      setPlan(current);

      if (current.needsEngine && done('engine')) {
        const installed = await speech.installEngine({ replace: current.engineInstalled === true });
        if (!mountedRef.current) return;
        if (installed?.ok === false) { fail(installed); return; }

        // Re-plan from the backend the installer actually produced. This is
        // the fix for the dangerous case: CUDA was detected but the installer
        // fell back to CPU, so the large model must not be downloaded.
        const afterState = await speech.getState().catch(() => null);
        if (!mountedRef.current) return;
        const afterInstall = readInstallState(afterState);
        current = setupPlan({
          gpu,
          engineInstalled: true,
          engineBackend: installed?.backend ?? afterInstall.engineBackend,
          engineSelectionCode: installed?.selection?.code ?? afterInstall.engineSelectionCode,
          engineCudaVersion: installed?.cudaVersion ?? afterInstall.engineCudaVersion,
          installedIds: afterInstall.installedIds,
        });
        setPlan(current);
      }

      if (!done('test')) return;
      const tested = await speech.testEngine();
      if (!mountedRef.current) return;
      if (tested?.ok === false) {
        fail({ code: 'engine-not-runnable', detailCode: tested?.code, message: tested?.message });
        return;
      }

      const candidates = setupCandidates(current.backend);
      const installedModels = new Set(current.installedIds ?? []);
      const missingModels = candidates.filter((id) => !installedModels.has(id));
      if (missingModels.length) {
        // The preview plan only knew about the one starter model. Add the
        // download step the measured ladder is about to perform, so the
        // progress bar is never labelled "Working" with no step.
        setPlan((previous) => {
          if (!previous || previous.steps.some((item) => item.id === 'model')) return previous;
          const steps = [...previous.steps];
          const measureAt = steps.findIndex((item) => item.id === 'measure');
          steps.splice(measureAt < 0 ? steps.length : measureAt, 0, {
            id: 'model',
            label: 'Downloading voice models',
          });
          return { ...previous, steps };
        });
      }
      if (missingModels.length && done('model')) {
        for (const modelId of missingModels) {
          const downloaded = await speech.install({ modelId });
          if (!mountedRef.current) return;
          if (downloaded?.ok === false) { fail(downloaded); return; }
          installedModels.add(modelId);
        }
      }

      if (!done('measure')) return;
      let clip;
      try {
        clip = await loadBenchmarkClip();
      } catch {
        fail({ code: 'benchmark-clip-failed' });
        return;
      }
      if (!mountedRef.current) return;
      const measured = await speech.autoSelectModel({
        clip,
        providerId: 'whispercpp',
        where: 'local',
        engineMode: 'prod',
        fromSetup: true,
      });
      if (!mountedRef.current) return;
      if (measured?.ok === false) {
        fail({
          code: 'auto-select-failed',
          detailCode: measured?.code,
          message: measured?.reason ?? measured?.message,
        });
        return;
      }
      const chosen = measured?.decision?.modelId;
      if (!chosen) {
        fail({ code: 'auto-select-failed', message: 'No measured model passed the speed and accuracy gates.' });
        return;
      }
      for (const row of Array.isArray(measured.results) ? measured.results : []) {
        useSpeechStore.getState().recordBenchmarkResult(row);
      }

      if (!done('select')) return;
      const selected = await speech.selectModel({ modelId: chosen });
      if (!mountedRef.current) return;
      if (selected?.ok === false) {
        fail({ code: 'select-model', detailCode: selected?.code, message: selected?.message });
        return;
      }

      // One press ends in a real local, production session. The store request
      // is consumed by the rail, which is the only code allowed to open the
      // microphone; this component never calls getUserMedia itself.
      const store = useSpeechStore.getState();
      store.setWhere('local');
      store.setProviderId('whispercpp');
      store.setEngineMode('prod');
      store.setModelId(chosen);
      store.setEnabled(true);
      store.setLastError(null);
      store.setStatus('idle');
      store.requestAutoStart();
      const row = getModel(chosen);
      setPlan({ ...current, modelId: chosen, modelName: row?.displayName ?? chosen });
      setPhase('done');
      stepRef.current = null;
      setStep(null);
    } catch {
      fail({ code: 'download-failed' });
    } finally {
      if (lockHeartbeat) clearInterval(lockHeartbeat);
      if (lockHeld) {
        await speech.setSetupLock(false).catch(() => {});
      }
    }
  }, [fail, phase]);

  const steps = useMemo(() => {
    if (!plan) return [];
    const index = plan.steps.findIndex((item) => item.id === step);
    return plan.steps.map((item, position) => ({
      ...item,
      state: phase === 'done' || (index >= 0 && position < index) ? 'done'
        : index === position ? 'current' : 'pending',
    }));
  }, [plan, phase, step]);

  const card = darkMode
    ? 'rounded-xl border border-[#282946] bg-[#1A1C40] p-5'
    : 'rounded-xl border border-gray-200 bg-white p-5';
  const heading = darkMode ? 'text-[#D8DEE0]' : 'text-[#111231]';
  const body = darkMode ? 'text-gray-300' : 'text-gray-700';
  const subtle = darkMode ? 'text-gray-400' : 'text-gray-600';
  const link = darkMode ? 'text-[#82AAFF] hover:text-[#D8DEE0]' : 'text-[#1a5c54] hover:text-[#134a43]';

  return (
    <section aria-label="Sermon Assist setup" className={card} data-testid="speech-quick-setup">
      {phase === 'done' ? (
        <>
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[#8FCE72]" aria-hidden="true" />
            <div className="space-y-1">
              <h3 className={`text-base font-semibold ${heading}`} data-testid="speech-quick-setup-ready">
                Sermon Assist is set up
              </h3>
              <p className={`text-sm leading-relaxed ${body}`}>
                Using {plan?.modelName ?? 'the voice model'}. Starting now.
                If your computer asks for microphone access, choose Allow. If it cannot start,
                Sermon Assist shows the reason in the rail.
              </p>
            </div>
          </div>
          <p className={`text-xs ${subtle}`}>{plan?.deviceNote}</p>
        </>
      ) : (
        <>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded-md bg-[#282946] p-2">
              <Mic className="h-4 w-4 text-[#7DDBD3]" aria-hidden="true" />
            </span>
            <div className="min-w-0 space-y-1">
              <h3 className={`text-base font-semibold ${heading}`}>
                {phase === 'running' ? 'Setting up Sermon Assist' : 'Set up Sermon Assist'}
              </h3>
              <p className={`text-sm leading-relaxed ${body}`}>
                One button installs what this computer needs, measures which voice model
                keeps up, and starts listening. You do not need to unzip files or know
                which file is the program.
              </p>
            </div>
          </div>

          {phase === 'error' ? (
            <div className="rounded-md border border-[#E06C75] bg-[#E06C75]/10 p-3" data-testid="speech-quick-setup-error" role="alert">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#E06C75]" aria-hidden="true" />
                <div className="min-w-0 space-y-1">
                  <p className={`text-sm font-semibold ${heading}`}>Setup could not finish</p>
                  <p className={`text-sm ${body}`}>{error?.message}</p>
                </div>
              </div>
              <button
                type="button"
                className="mt-2 text-xs font-semibold text-[#7DDBD3] hover:text-[#42B7A7]"
                onClick={() => setShowDetails((previous) => !previous)}
                data-testid="speech-quick-setup-details-toggle"
                aria-expanded={showDetails}
              >
                Details for tech support
              </button>
              {showDetails ? (
                <pre className={`mt-2 whitespace-pre-wrap break-words text-xs ${subtle}`} data-testid="speech-quick-setup-details">
                  {error?.detail ?? 'No technical detail was reported.'}
                </pre>
              ) : null}
            </div>
          ) : null}

          {phase === 'running' ? (
            <div className="space-y-2">
              <div className={`flex items-center justify-between gap-2 text-xs ${body}`}>
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  {steps.find((item) => item.state === 'current')?.label ?? 'Working'}
                </span>
                {progress ? <span className="font-mono">{progress.percent}%</span> : null}
              </div>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-[#282946]"
                role="progressbar"
                aria-label="Sermon Assist setup"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress?.percent ?? undefined}
                data-testid="speech-quick-setup-progress"
              >
                <div
                  className="h-full bg-[#7DDBD3] transition-[width] duration-200 motion-reduce:transition-none"
                  style={{ width: progress ? `${progress.percent}%` : '0%' }}
                />
              </div>
              <ol className={`space-y-1 text-xs ${subtle}`} data-testid="speech-quick-setup-steps">
                {steps.map((item) => (
                  <li key={item.id} className="flex items-center gap-2">
                    {item.state === 'done' ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-[#8FCE72]" aria-hidden="true" />
                    ) : (
                      <span className={`h-1.5 w-1.5 rounded-full ${item.state === 'current' ? 'bg-[#7DDBD3]' : 'bg-[#55464B]'}`} />
                    )}
                    <span className={item.state === 'current' ? heading : undefined}>{item.label}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={PRIMARY}
              onClick={run}
              disabled={phase === 'running' || !starterModelsAreInCatalog()}
              data-testid="speech-quick-setup-start"
            >
              {phase === 'error' ? 'Try setup again' : 'Set up Sermon Assist'}
            </button>
            <button
              type="button"
              className={`text-xs font-semibold ${link}`}
              onClick={() => setShowWhat((previous) => !previous)}
              data-testid="speech-quick-setup-what-toggle"
              aria-expanded={showWhat}
            >
              What will it install? <ChevronDown className="inline h-3 w-3" aria-hidden="true" />
            </button>
          </div>

          {showWhat ? (
            <div className={`space-y-1 text-xs leading-relaxed ${body}`} data-testid="speech-quick-setup-what">
              <p>{plan?.deviceNote ?? 'Selah checks this computer before choosing anything.'}</p>
              <p>{plan?.sizeNote ?? 'The downloads are verified before anything is installed.'}</p>
              <p>Voice model: {plan?.modelName ?? 'chosen for this computer'}.</p>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
};

export default QuickSetupCard;
