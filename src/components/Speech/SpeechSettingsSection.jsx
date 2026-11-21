import React, { useState, useEffect } from 'react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Mic,
  Cpu,
  Network,
  Cloud,
  RotateCcw,
  CircleSlash,
  CheckCircle2,
  KeyRound,
  FlaskConical,
} from 'lucide-react';
import useSpeechStore from '../../context/SpeechStore';
import useToast from '../../hooks/useToast';
import { useSpeechEnabled, useSpeechMode } from '../../hooks/useStoreSelectors';
import { engineModeLabel, isCannedEngine } from '../../speech';
import ProviderPicker from './ProviderPicker';
import QuickSetupCard from './QuickSetupCard';
import InstallEngineWizard from './InstallEngineWizard';
import ModelCatalogList from './ModelCatalogList';
import ModelBenchmarkPanel from './ModelBenchmarkPanel';
import SpeechTuningDataCard from './SpeechTuningDataCard';
import SermonAssistSafetyPanel from './SermonAssistSafetyPanel';
import AudioSourcePicker from './AudioSourcePicker';

// ---------------------------------------------------------------------------
// Live Sermon Assist — the settings surface.
//
// WHERE IT LIVES: inside User Preferences → Experimental, behind a master
// switch, badged Experimental. The plan (section 6.2) originally argued for a
// first-class "Speech & AI" sidebar section on the grounds that "users must be
// able to find and trust this"; that has been deliberately reversed while the
// engine cannot yet transcribe. When the native engine ships and this graduates,
// it gets its own section back — this file moves with it.
//
// Local is the default posture: the three-way `where` control is the FIRST
// configuration control on the page, above the provider picker and above the
// model catalog, so a user who wants everything on their own hardware reaches
// a working provider without scrolling past a cloud form or entering a key.
//
// INVARIANTS held here:
//  - `enabled` only ever changes on an explicit user click of the master
//    Switch. Nothing in this file auto-enables the feature.
//  - No microphone code, no getUserMedia, no network requests, no spawn.
//  - `cloudProviderId` is cleared the moment the user leaves `cloud`, so a
//    stale cloud selection can never leak into a local run.
// ---------------------------------------------------------------------------

// Section 10 privacy requirement: an accurate, always-visible mode indicator.
// `engineModeLabel` (src/speech/engineTruth.js) owns this wording for both
// surfaces — the rail and this panel — so the two can never drift, and so
// neither of them can show a model id while a canned engine is behind it.

const WHERE_OPTIONS = [
  {
    id: 'local',
    label: 'This Device',
    Icon: Cpu,
    copy: 'Audio stays on this computer.',
  },
  {
    id: 'network',
    label: 'Network Device',
    Icon: Network,
    copy: 'Runs on another machine on your trusted LAN. Raw PCM microphone audio crosses the network; the transport is plain HTTP/ws:// with no TLS.',
  },
  {
    id: 'cloud',
    label: 'Cloud',
    Icon: Cloud,
    copy: 'Audio is sent to a cloud provider. The live feed may contain audio that is not in the published recording.',
  },
];

// Two real cloud lanes. The remaining catalogue rows stay visible so the
// refusal is explicit — a provider that was silently selectable but never ran
// is exactly the lie this surface is meant to end.
const CLOUD_PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    available: true,
    copy: 'Audio Transcriptions with whisper-1 (or gpt-4o-transcribe). Accurate on accented English; chunked uploads add latency.',
    models: [
      { id: 'whisper-1', label: 'whisper-1' },
      { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter · Google Gemini',
    available: true,
    copy: 'Documented Responses API with base64 WAV input_audio. Gemini Flash models are audio-capable; live quality is not yet verified here.',
    models: [
      { id: 'google/gemini-2.5-flash', label: 'google/gemini-2.5-flash' },
      { id: 'google/gemini-3.8-flash', label: 'google/gemini-3.8-flash' },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    available: false,
    copy: 'Not available in this build. Selecting it refuses the start — no audio is sent.',
  },
  {
    id: 'deepgram',
    name: 'Deepgram',
    available: false,
    copy: 'Not available in this build. Selecting it refuses the start — no audio is sent.',
  },
  {
    id: 'assemblyai',
    name: 'AssemblyAI',
    available: false,
    copy: 'Not available in this build. Selecting it refuses the start — no audio is sent.',
  },
  {
    id: 'google',
    name: 'Google Cloud STT',
    available: false,
    copy: 'Not available in this build. Selecting it refuses the start — no audio is sent.',
  },
];

const SpeechSettingsSection = ({ darkMode = false }) => {
  const { enabled, setEnabled } = useSpeechEnabled();
  const { where, modelId, cloudProviderId, cloudModelId } = useSpeechMode();
  const engineMode = useSpeechStore((state) => state.engineMode);
  const setEngineMode = useSpeechStore((state) => state.setEngineMode);
  const showEngineErrors = useSpeechStore((state) => state.ui.showEngineErrors) !== false;
  const setUI = useSpeechStore((state) => state.setUI);
  const setWhere = useSpeechStore((state) => state.setWhere);
  const networkEndpoint = useSpeechStore((state) => state.networkEndpoint);
  const networkToken = useSpeechStore((state) => state.networkToken);
  const setNetworkEndpoint = useSpeechStore((state) => state.setNetworkEndpoint);
  const setNetworkToken = useSpeechStore((state) => state.setNetworkToken);
  const setCloudProviderId = useSpeechStore((state) => state.setCloudProviderId);
  const setCloudModelId = useSpeechStore((state) => state.setCloudModelId);
  const resetToDefaults = useSpeechStore((state) => state.resetToDefaults);
  // `speech:health`'s `backend` field. The engine that ships today is the
  // contract-conformant fake, and the operator must be able to tell that from
  // the settings screen — not only from a badge hidden inside the rail.
  const engineHealth = useSpeechStore((state) => state.health);
  const status = useSpeechStore((state) => state.status);
  const isLive = status === 'starting' || status === 'listening' || status === 'transcribing' || Boolean(engineHealth);
  const isCanned = isCannedEngine(engineHealth);
  const { showToast } = useToast();

  // Only the DRAFT key lives in component memory. Saving hands it to main,
  // which stores it in the OS keychain; the renderer only ever sees a boolean
  // status and never writes key text to the store or localStorage.
  const [draftKeys, setDraftKeys] = useState({});
  // The network token lives in session memory only (SpeechStore runtime
  // state). Test feedback is local to this component and never carries the
  // token or transcript text.
  const [networkStatus, setNetworkStatus] = useState(null);
  const [testingNetwork, setTestingNetwork] = useState(false);
  const [keyStatus, setKeyStatus] = useState('checking'); // checking | saved | missing | error
  const [cloudConsent, setCloudConsentState] = useState(false);

  const cloudBridge = () => (typeof window === 'undefined' ? null : window.electronAPI?.speech ?? null);
  const activeCloudProvider = CLOUD_PROVIDERS.find((p) => p.id === cloudProviderId && p.available) ?? null;
  const activeModels = activeCloudProvider?.models ?? [];
  const activeModel = cloudModelId ?? activeModels[0]?.id ?? null;

  // Status is a boolean check on mount / on entering Cloud / on switching
  // provider. Nothing is read back into an input and nothing is logged.
  useEffect(() => {
    if (where !== 'cloud' || !activeCloudProvider) return undefined;
    let cancelled = false;
    const bridge = cloudBridge();
    if (!bridge?.cloudKeyStatus) {
      setKeyStatus('missing');
      return undefined;
    }
    bridge.cloudKeyStatus(activeCloudProvider.id)
      .then((reply) => {
        if (cancelled) return;
        setKeyStatus(reply?.configured === true ? 'saved' : 'missing');
      })
      .catch(() => { if (!cancelled) setKeyStatus('error'); });
    return () => { cancelled = true; };
  }, [where, cloudProviderId]);

  const handleSaveCloudKey = async () => {
    const providerId = activeCloudProvider?.id;
    const key = (draftKeys[providerId] ?? '').trim();
    const bridge = cloudBridge();
    if (!providerId) {
      setKeyStatus('error');
      showToast({ title: 'Choose a provider first', message: 'Select OpenAI or OpenRouter before saving a key.', variant: 'error' });
      return;
    }
    if (!key) {
      setKeyStatus('error');
      showToast({ title: 'No key entered', message: `Paste your ${activeCloudProvider.name} API key before clicking Save.`, variant: 'error' });
      return;
    }
    if (!bridge?.saveCloudKey) {
      setKeyStatus('error');
      showToast({ title: 'Secure storage unavailable', message: 'The app bridge could not save the key.', variant: 'error' });
      return;
    }
    try {
      const reply = await bridge.saveCloudKey({ provider: providerId, key });
      if (reply?.ok !== true) throw new Error(reply?.code || 'save-failed');
      setKeyStatus('saved');
      setDraftKeys((previous) => ({ ...previous, [providerId]: '' }));
      showToast({ title: 'Cloud key saved', message: `Stored in your computer’s secure keychain for ${activeCloudProvider.name}. The key is never shown again.`, variant: 'success' });
    } catch {
      setKeyStatus('error');
      showToast({ title: 'Could not save key', message: 'Secure storage refused the key. Check the app logs for the storage error.', variant: 'error' });
    }
  };

  const handleClearCloudKey = async () => {
    const providerId = activeCloudProvider?.id;
    const bridge = cloudBridge();
    try {
      if (!providerId || !bridge?.clearCloudKey) throw new Error('no-bridge');
      const reply = await bridge.clearCloudKey({ provider: providerId });
      if (reply?.ok !== true) throw new Error(reply?.code || 'clear-failed');
      setKeyStatus('missing');
      setDraftKeys((previous) => ({ ...previous, [providerId]: '' }));
      showToast({ title: 'Cloud key cleared', message: `${activeCloudProvider.name} will refuse to start until a key is saved again.`, variant: 'info' });
    } catch {
      setKeyStatus('error');
      showToast({ title: 'Could not clear key', message: 'Secure storage could not delete the saved key.', variant: 'error' });
    }
  };

  const handleCloudConsent = async (checked) => {
    // The checkbox is an explicit session action. Main enforces the same
    // gate; a stale UI state can never silently start a cloud session.
    setCloudConsentState(checked);
    try {
      await cloudBridge()?.setCloudConsent?.(activeCloudProvider?.id, checked);
    } catch {
      showToast({ title: 'Acknowledgement not saved', message: 'Cloud start will refuse until the acknowledgement can be recorded.', variant: 'error' });
    }
  };

  // Phase 6 guardrail report (limits + current trip state). One read on mount:
  // these change when the machine trips, and the engine announces that over
  // speech:error rather than by polling. Polling here would be a second timer
  // disagreeing with the supervisor's own.
  const [guardrail, setGuardrail] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const speech = typeof window === 'undefined' ? null : window.electronAPI?.speech ?? null;
    if (!speech?.getState) return undefined;

    speech
      .getState()
      .then((state) => {
        if (!cancelled && state?.guardrail) setGuardrail(state.guardrail);
      })
      .catch(() => {
        /* no report available; the panel shows its loading copy, not a guess */
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = (checked) => {
    // Explicit user click only — never called from an effect.
    setEnabled(checked);
    showToast({
      title: checked ? 'Sermon Assist enabled' : 'Sermon Assist disabled',
      message: checked
        ? 'Sermon Assist enabled — the rail is on the right of the control panel. The microphone stays closed until Set up Sermon Assist or Start; it uses your remembered input or the system default.'
        : 'Sermon Assist disabled — the rail is hidden and nothing is captured or sent.',
      variant: checked ? 'success' : 'info',
    });
  };

  const handleCloudProvider = (providerId) => {
    if (providerId === cloudProviderId) return;
    if (isLive) {
      showToast({
        title: 'Stop the microphone first',
        message: 'Changing the cloud provider while listening would leave audio going to the old provider under a new label.',
        variant: 'warning',
      });
      return;
    }
    setCloudProviderId(providerId);
    // Consent is per egress destination. Switching lanes requires a fresh
    // explicit acknowledgement even within the same session.
    setCloudConsentState(false);
    setKeyStatus('checking');
    void cloudBridge()?.setCloudConsent?.(activeCloudProvider?.id, false);
  };

  const handleWhere = (value) => {
    if (isLive && value !== where) {
      showToast({
        title: 'Stop the microphone first',
        message: 'Changing where Sermon Assist runs while it is live would mislabel the audio destination. Stop it, then switch.',
        variant: 'warning',
      });
      return;
    }
    setWhere(value);
    // Leaving cloud makes it unreachable: no stale cloud provider survives,
    // and the egress acknowledgement must be given again on return.
    if (value !== 'cloud') {
      setCloudProviderId(null);
      setCloudConsentState(false);
      void cloudBridge()?.setCloudConsent?.(activeCloudProvider?.id, false);
    }
  };

  const handleTestNetwork = async () => {
    const speech = typeof window === 'undefined' ? null : window.electronAPI?.speech;
    if (typeof speech?.testNetwork !== 'function') {
      setNetworkStatus({ ok: false, message: 'This build cannot test a remote engine.' });
      return;
    }
    setTestingNetwork(true);
    setNetworkStatus(null);
    try {
      const result = await speech.testNetwork({ networkEndpoint, networkToken });
      setNetworkStatus({
        ok: result?.ok === true,
        message:
          typeof result?.message === 'string' && result.message
            ? result.message
            : 'No answer from the remote engine.',
      });
    } catch {
      setNetworkStatus({ ok: false, message: 'The connection test could not complete.' });
    } finally {
      setTestingNetwork(false);
    }
  };

  const handleReset = () => {
    resetToDefaults();
    setDraftKeys({});
    setNetworkStatus(null);
    setCloudConsentState(false);
    void cloudBridge()?.setCloudConsent?.(activeCloudProvider?.id, false);
    showToast({
      title: 'Sermon Assist reset',
      message: 'All Sermon Assist settings restored to defaults. The feature stays off until you turn it on.',
      variant: 'info',
    });
  };

  const activeWhere = WHERE_OPTIONS.find((option) => option.id === where) ?? WHERE_OPTIONS[0];

  const cardClass = `rounded-xl border p-5 space-y-4 transition-all ${
    darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white'
  }`;
  const labelClass = `text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`;
  const mutedClass = `text-xs leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-600'}`;
  const badgeBase =
    'text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded';

  return (
    <div className="space-y-6">
      <div>
        <h3
          className={`text-base font-semibold flex items-center gap-2 ${
            darkMode ? 'text-white' : 'text-gray-900'
          }`}
        >
          <Mic className="w-5 h-5 text-[#7DDBD3]" /> Speech &amp; AI
        </h3>
        <p className={`text-xs mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
          Live Sermon Assist transcribes the sermon while you run the service. Pick where it runs,
          which engine it uses, and which model it loads. Local is the default — cloud is one
          option, not the fallback.
        </p>
      </div>

      {/* -------------------------------------------------------------- (a)
          Master enable — off by default, only a user click flips it. */}
      <div className={cardClass}>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5 flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={labelClass}>Sermon Assist</span>
              <span
                title="Sermon Assist never turns itself on — only you flip this switch."
                className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                  darkMode
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                    : 'bg-amber-100 text-amber-800 border border-amber-300'
                }`}
              >
                Off by default
              </span>
              <span
                className={`${badgeBase} ${
                  enabled
                    ? darkMode
                      ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'
                      : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                    : darkMode
                      ? 'bg-gray-800 text-gray-400 border border-gray-700'
                      : 'bg-gray-100 text-gray-500 border border-gray-200'
                }`}
              >
                {enabled ? 'ON' : 'OFF'}
              </span>
            </div>
            <p className={mutedClass}>
              Transcribes the live sermon into the assist rail: next-lyric suggestions, Bible
              references, and sermon notes. Turning it on does not open a microphone — you choose
              the audio source separately below.
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={handleToggle}
            aria-label="Enable Sermon Assist"
            data-testid="speech-enable-toggle"
          />
        </div>

        {enabled ? (
          <div
            className={`rounded-lg border p-3 text-xs leading-relaxed flex items-start gap-2.5 ${
              darkMode
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                : 'bg-emerald-50 border-emerald-200 text-emerald-800'
            }`}
          >
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-500" />
            <div>
              <span className="font-semibold">Sermon Assist is ON</span> — the assist rail is on
              the right of the control panel. The microphone stays closed until Set up Sermon
              Assist or Start; it uses your remembered input or the system default. The mode shown
              at the bottom of this page is what actually runs.
            </div>
          </div>
        ) : (
          <div
            className={`rounded-lg border p-3 text-xs leading-relaxed flex items-start gap-2.5 ${
              darkMode
                ? 'bg-gray-950/60 border-gray-800 text-gray-400'
                : 'bg-gray-50 border-gray-200 text-gray-600'
            }`}
          >
            <CircleSlash className="w-4 h-4 shrink-0 mt-0.5 text-gray-400" />
            <div>
              <span className="font-semibold">Sermon Assist is OFF</span> — no microphone access,
              no network requests, no engine installed. You can still choose where it runs and
              which model to load below; they take effect when you turn it on.
            </div>
          </div>
        )}
      </div>

      {/* The volunteer path is deliberately outside the inert configuration
          wrapper: the default state is OFF, and the one button that installs
          everything must be the brightest, reachable action on the page. */}
      <div className="mt-6">
        <QuickSetupCard darkMode={darkMode} />
      </div>

      {/* --------------------------------------------------------------
          Configuration. Visible while disabled so the user can choose a
          model before enabling — just visibly inert (reduced opacity +
          aria-disabled), never hidden. */}
      <div aria-disabled={!enabled} className="space-y-6">
        {!enabled && (
          <p
            data-testid="speech-config-inert-note"
            className={`text-[11px] leading-relaxed ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}
          >
            Not active yet — you can still choose where Sermon Assist runs, which engine it uses,
            and which model it loads. Nothing starts until the switch above is ON.
          </p>
        )}

        <div className={enabled ? '' : 'opacity-60'}>
          {/* ---------------------------------------------------------- (b)
              The three-way question: which machine? First configuration
              control on the page, deliberately above every other choice. */}
          <div className={cardClass}>
            <div className="space-y-1.5">
              <span className={labelClass}>Where it runs</span>
              <p className={mutedClass}>
                The one question that matters first: does the sermon audio ever leave this
                computer?
              </p>
            </div>
            <div
              role="radiogroup"
              aria-label="Where Sermon Assist runs"
              className="grid grid-cols-3 gap-2"
            >
              {WHERE_OPTIONS.map((option) => {
                const selected = where === option.id;
                const Icon = option.Icon;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-testid={`speech-where-${option.id}`}
                    onClick={() => handleWhere(option.id)}
                    className={`flex flex-col items-center gap-1.5 rounded-lg border px-3 py-3 text-center text-xs font-semibold transition-colors ${
                      selected
                        ? darkMode
                          ? 'border-[#7DDBD3] bg-[#7DDBD3]/10 text-[#7DDBD3]'
                          : 'border-[#1a5c54] bg-[#7DDBD3]/15 text-[#1a5c54]'
                        : darkMode
                          ? 'border-gray-700 bg-gray-900/40 text-gray-300 hover:border-gray-500'
                          : 'border-gray-200 bg-white text-gray-700 hover:border-gray-400'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {option.label}
                  </button>
                );
              })}
            </div>
            <p className={mutedClass}>{activeWhere.copy}</p>
            {where === 'cloud' ? (
              <p
                data-testid="speech-cloud-egress-notice"
                className={`rounded-lg border p-2.5 text-xs leading-relaxed ${
                  darkMode
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                    : 'border-amber-200 bg-amber-50 text-amber-800'
                }`}
              >
                Cloud is real: WAV audio is sent over HTTPS to the selected provider. It refuses
                to start without a saved key and your explicit acknowledgement below. No local
                model or binary is used.
              </p>
            ) : null}
          </div>

          {/* ---------------------------------------------------------- (b1)
              Trusted-LAN remote engine. The endpoint is persisted; the token
              is session-only and never written to localStorage. The start
              path refuses when either is missing — no local fallback. */}
          {where === 'network' && (
            <div className={`${cardClass} mt-6`} data-testid="speech-network-block">
              <div className="space-y-1.5">
                <span className={labelClass}>Remote speech engine</span>
                <p className={mutedClass}>
                  Runs on another machine on a <strong>trusted LAN</strong>. This is plain HTTP and
                  ws:// with <strong>no TLS</strong>: raw microphone audio crosses the network,
                  along with the shared token. Do not use an untrusted or public network.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className={`text-xs font-semibold ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                    Engine URL
                  </span>
                  <Input
                    type="url"
                    inputMode="url"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="http://192.168.1.20:4731"
                    value={networkEndpoint ?? ''}
                    onChange={(event) => setNetworkEndpoint(event.target.value)}
                    aria-label="Remote engine URL"
                    data-testid="speech-network-endpoint"
                    className={`h-9 text-xs ${darkMode ? 'bg-gray-950 border-gray-800' : 'bg-white'}`}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={`text-xs font-semibold ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                    Launch token (this session only)
                  </span>
                  <Input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Engine launch token"
                    value={networkToken ?? ''}
                    onChange={(event) => setNetworkToken(event.target.value)}
                    aria-label="Remote engine token"
                    data-testid="speech-network-token"
                    className={`h-9 text-xs ${darkMode ? 'bg-gray-950 border-gray-800' : 'bg-white'}`}
                  />
                </label>
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                <Button
                  type="button"
                  variant="outline"
                  disabled={testingNetwork}
                  onClick={handleTestNetwork}
                  data-testid="speech-network-test"
                  className={`inline-flex items-center gap-2 ${
                    darkMode ? 'border-gray-700 bg-transparent text-gray-200 hover:bg-gray-800' : ''
                  }`}
                >
                  <Network className="w-4 h-4" /> {testingNetwork ? 'Testing…' : 'Test connection'}
                </Button>
                <span className={`text-[11px] ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                  The token is kept only in memory; a reload asks for it again.
                </span>
              </div>

              {networkStatus ? (
                <p
                  role="status"
                  data-testid="speech-network-status"
                  className={`text-xs leading-relaxed rounded-lg border p-2.5 ${
                    networkStatus.ok
                      ? darkMode
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                        : 'border-emerald-200 bg-emerald-50 text-emerald-800'
                      : darkMode
                        ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                        : 'border-amber-200 bg-amber-50 text-amber-800'
                  }`}
                >
                  {networkStatus.ok ? 'Connected. ' : 'Not connected. '}
                  {networkStatus.message}
                </p>
              ) : null}
            </div>
          )}

          {/* ---------------------------------------------------------- (b2)
              Engine Mode — Production vs Test Mode */}
          <div className={`${cardClass} mt-6`}>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className={labelClass}>Engine Mode</span>
                <span
                  className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                    engineMode === 'prod'
                      ? darkMode
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                      : darkMode
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                        : 'bg-amber-100 text-amber-800 border border-amber-300'
                  }`}
                >
                  {engineMode === 'prod' ? 'Production Mode' : 'Test Mode'}
                </span>
              </div>
              <p className={mutedClass}>
                Choose between live microphone transcription with the real local engine and simulated test transcription for rehearsal.
              </p>
            </div>
            <div
              role="radiogroup"
              aria-label="Engine Mode"
              className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3"
            >
              <button
                type="button"
                role="radio"
                aria-checked={engineMode === 'prod'}
                data-testid="speech-mode-prod"
                onClick={() => setEngineMode('prod')}
                className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                  engineMode === 'prod'
                    ? darkMode
                      ? 'border-[#7DDBD3] bg-[#7DDBD3]/10 text-white'
                      : 'border-[#1a5c54] bg-[#7DDBD3]/15 text-gray-900'
                    : darkMode
                      ? 'border-gray-700 bg-gray-900/40 text-gray-300 hover:border-gray-500'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-gray-400'
                }`}
              >
                <div className="flex items-center gap-2 font-semibold text-xs">
                  <CheckCircle2
                    className={`w-4 h-4 ${engineMode === 'prod' ? 'text-[#7DDBD3]' : 'text-gray-500'}`}
                  />
                  <span>Production (Live Mic)</span>
                </div>
                <p className={`text-[11px] ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  Uses whisper.cpp and your installed model to transcribe live speech from your microphone.
                </p>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={engineMode === 'test'}
                data-testid="speech-mode-test"
                onClick={() => setEngineMode('test')}
                className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                  engineMode === 'test'
                    ? darkMode
                      ? 'border-amber-500 bg-amber-500/10 text-white'
                      : 'border-amber-600 bg-amber-50 text-gray-900'
                    : darkMode
                      ? 'border-gray-700 bg-gray-900/40 text-gray-300 hover:border-gray-500'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-gray-400'
                }`}
              >
                <div className="flex items-center gap-2 font-semibold text-xs">
                  <FlaskConical
                    className={`w-4 h-4 ${engineMode === 'test' ? 'text-amber-400' : 'text-gray-500'}`}
                  />
                  <span>Test Mode (Simulated)</span>
                </div>
                <p className={`text-[11px] ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  Generates canned sermon segments for rehearsals and testing display layouts without microphone or CPU load.
                </p>
              </button>
            </div>
          </div>

          {/* ---------------------------------------------------------- (b3)
              Rail display — the operator decides whether engine errors appear
              in the rail. Off hides the banner but keeps the error, so turning
              it back on shows it again; the rail shows a one-line "hidden"
              placeholder while off so the error is never silently swallowed. */}
          <div className={`${cardClass} mt-6`}>
            <div className="space-y-1.5">
              <span className={labelClass}>Rail display</span>
              <p className={mutedClass}>
                Choose what the assist rail shows while you run the service.
              </p>
            </div>
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                data-testid="speech-show-engine-errors-setting"
                checked={showEngineErrors}
                onChange={(event) => setUI({ showEngineErrors: event.target.checked })}
              />
              <span>
                <span className="font-semibold">Show engine errors in the rail</span>
                <p className={`${mutedClass} mt-0.5`}>
                  On by default, so a failed engine says why instead of leaving an empty
                  transcript. Turn it off and the banner stays hidden until you turn it back on.
                </p>
              </span>
            </label>
          </div>

          {/* ---------------------------------------------------------- (c)
              Provider picker — the local "who" axis. */}
          <div className="mt-6">
            <ProviderPicker darkMode={darkMode} />
          </div>

          {/* ---------------------------------------------------------- (d)
              Engine model install (Phase 2) above the catalog: the wizard
              owns the download lifecycle for the selected model, the catalog
              below owns per-model install/select states. */}
          <div className="mt-6">
            <InstallEngineWizard darkMode={darkMode} />
          </div>

          {/* ---------------------------------------------------------- (d2)
              Model catalog, filtered to the selected provider. */}
          <div className="mt-6">
            <ModelCatalogList darkMode={darkMode} />

            {/* Phase 3: the measured comparison, below the catalog it measures.
                Deliberately AFTER the list — the catalog says what exists, this
                says which one this computer can actually keep up with. */}
            <ModelBenchmarkPanel darkMode={darkMode} />
            <SpeechTuningDataCard darkMode={darkMode} cardClass="rounded-xl border p-5 space-y-4 mt-4" titleClass="text-[11px] font-bold uppercase tracking-wider" />
          </div>

          {/* ---------------------------------------------------------- (d2)
              Safety and erase. LAST, and its own block: these are the
              consequential controls — what the machine is allowed to use,
              what is kept on disk, and the one button that destroys it. Burying
              a delete among model checkboxes is how someone loses a service's
              transcripts. */}
          <div className={`mt-6 ${cardClass}`}>
            <SermonAssistSafetyPanel
              darkMode={darkMode}
              limits={guardrail?.limits ?? null}
              guardrail={guardrail ?? null}
            />
          </div>

          {/* ---------------------------------------------------------- (e)
              Cloud block — only when `where === 'cloud'`. OpenAI is the only
              enabled provider; the others are shown as unavailable so the
              refusal is visible before anyone starts a service. */}
          {where === 'cloud' && (
            <div className={`mt-6 ${cardClass}`} data-testid="speech-cloud-block">
              <div className="space-y-1.5">
                <span className={labelClass}>Cloud provider</span>
                <p className={mutedClass}>
                  Audio leaves this computer and is sent to the provider over HTTPS. The live feed
                  may contain audio that is not in the published recording.
                </p>
              </div>

              <div role="radiogroup" aria-label="Cloud provider" className="space-y-2">
                {CLOUD_PROVIDERS.map((provider) => {
                  const selected = cloudProviderId === provider.id;
                  return (
                    <div
                      key={provider.id}
                      className={`rounded-lg border p-3 space-y-2 transition-colors ${
                        selected
                          ? darkMode
                            ? 'border-[#7DDBD3] bg-[#7DDBD3]/10'
                            : 'border-[#1a5c54] bg-[#7DDBD3]/10'
                          : darkMode
                            ? 'border-gray-800 bg-gray-900/40'
                            : 'border-gray-200 bg-white'
                      }`}
                    >
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={!provider.available}
                        data-testid={`speech-cloud-provider-${provider.id}`}
                        onClick={() => { if (provider.available) handleCloudProvider(provider.id); }}
                        className="w-full text-left flex items-start justify-between gap-3 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        <span className="space-y-1 min-w-0">
                          <span className={`block text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                            {provider.name}
                          </span>
                          <span className={`block text-xs leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                            {provider.copy}
                          </span>
                        </span>
                        <span
                          className={`${badgeBase} shrink-0 ${
                            !provider.available
                              ? 'bg-gray-100 text-gray-500 border border-gray-200'
                              : selected
                                ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                                : darkMode
                                  ? 'bg-gray-800 text-gray-400 border border-gray-700'
                                  : 'bg-gray-100 text-gray-500 border border-gray-200'
                          }`}
                        >
                          {provider.available ? (selected ? 'Selected' : 'Select') : 'Unavailable'}
                        </span>
                      </button>

                      {provider.available ? (
                        <div className="space-y-2">
                          <label className="block">
                            <span className={`block text-[11px] font-semibold mb-1 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                              Model
                            </span>
                            <select
                              data-testid={`speech-cloud-model-${provider.id}`}
                              aria-label={`${provider.name} model`}
                              value={activeModel ?? ''}
                              onChange={(event) => setCloudModelId(event.target.value)}
                              className={`w-full h-8 rounded-md border px-2 text-xs ${
                                darkMode ? 'bg-gray-950 border-gray-800 text-white' : 'bg-white border-gray-300 text-gray-900'
                              }`}
                            >
                              {provider.models.map((model) => (
                                <option key={model.id} value={model.id}>{model.label}</option>
                              ))}
                            </select>
                          </label>
                          <label className="flex items-center gap-2">
                            <KeyRound className={`w-3.5 h-3.5 shrink-0 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`} />
                            <Input
                              type="password"
                              autoComplete="off"
                              spellCheck={false}
                              value={draftKeys[provider.id] ?? ''}
                              onChange={(event) =>
                                setDraftKeys((previous) => ({
                                  ...previous,
                                  [provider.id]: event.target.value,
                                }))
                              }
                              placeholder={`${provider.name} API key`}
                              aria-label={`${provider.name} API key`}
                              data-testid={`speech-cloud-key-input-${provider.id}`}
                              className={`h-8 text-xs ${darkMode ? 'bg-gray-950 border-gray-800' : 'bg-white'}`}
                            />
                          </label>
                          <div className="flex items-center gap-2 flex-wrap">
                            <Button type="button" size="sm" data-testid={`speech-cloud-key-save-${provider.id}`} onClick={handleSaveCloudKey}>
                              Save key
                            </Button>
                            <Button type="button" size="sm" variant="outline" data-testid={`speech-cloud-key-clear-${provider.id}`} onClick={handleClearCloudKey}>
                              Clear key
                            </Button>
                            <span
                              data-testid={`speech-cloud-key-status-${provider.id}`}
                              className={`text-[11px] ${
                                keyStatus === 'saved'
                                  ? 'text-emerald-500'
                                  : keyStatus === 'error'
                                    ? 'text-amber-500'
                                    : darkMode ? 'text-gray-400' : 'text-gray-600'
                              }`}
                            >
                              {keyStatus === 'checking'
                                ? 'Checking secure storage…'
                                : keyStatus === 'saved'
                                  ? 'Key saved in secure storage'
                                  : keyStatus === 'error'
                                    ? 'Secure storage error'
                                    : 'No key saved'}
                            </span>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <label className={`flex items-start gap-2 rounded-lg border p-3 text-xs ${
                darkMode ? 'border-gray-800 bg-gray-950/60' : 'border-gray-200 bg-gray-50'
              }`}>
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={cloudConsent}
                  data-testid="speech-cloud-consent"
                  onChange={(event) => void handleCloudConsent(event.target.checked)}
                />
                <span>
                  <span className={labelClass}>I understand audio leaves this computer</span>
                  <p className={`${mutedClass} mt-0.5`}>
                    Required before the first cloud start. With Production Mode, a saved key and
                    this acknowledgement, Selah sends 16 kHz WAV segments of the live feed to the
                    selected provider (OpenAI or OpenRouter/Gemini) for transcription. Clear this
                    tick to stop allowing cloud starts.
                  </p>
                </span>
              </label>

              <p
                data-testid="speech-cloud-cost-note"
                className={`text-[11px] leading-relaxed rounded-lg border p-3 ${
                  darkMode
                    ? 'border-gray-800 bg-gray-950/60 text-gray-400'
                    : 'border-gray-200 bg-gray-50 text-gray-500'
                }`}
              >
                Key storage uses your computer’s secure keychain (encrypted fallback when a
                keychain is unavailable). The key is never shown again, written to localStorage,
                or sent to this app’s servers. OpenAI and OpenRouter are the only enabled lanes;
                each keeps its own separate key. Other providers refuse the start without sending
                audio. Cloud speech is billed per audio uploaded, so a long service can cost more
                than a short one.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* -------------------------------------------------------------- (f)
          Audio source. AudioSourcePicker is cold on render: no permission
          request, no enumeration, no AudioContext until the user asks. */}
      <section className={cardClass}>
        <span className={labelClass}>Audio Source</span>
        <AudioSourcePicker darkMode={darkMode} />
      </section>

      {/* -------------------------------------------------------------- (g)
          Section 10 privacy requirement: accurate, always visible, no modal,
          no acknowledgement gate. Same wording as the rail. */}
      <div
        data-testid="speech-settings-mode"
        className={`rounded-lg border px-3 py-2 text-xs font-medium ${
          isCanned
            ? 'border-amber-500/50 bg-amber-500/10 text-amber-600'
            : darkMode
              ? 'border-gray-700 bg-gray-900 text-gray-300'
              : 'border-gray-200 bg-gray-50 text-gray-600'
        }`}
      >
        {engineModeLabel({ where, modelId, cloudProviderId, health: engineHealth })}
      </div>

      {isCanned ? (
        <p
          role="status"
          data-testid="speech-canned-engine-notice"
          className={`text-xs leading-snug ${mutedClass}`}
        >
          The only engine available today is a test scaffold. It ignores the audio
          completely and replays a fixed sentence. Nothing you see below came from
          this room, and no suggestion will be offered from it.
        </p>
      ) : null}

      {/* -------------------------------------------------------------- (h)
          Invariant 6 slice: one-click erase of everything this feature has
          stored. */}
      <div className={cardClass}>
        <div className="space-y-1.5">
          <span className={labelClass}>Reset</span>
          <p className={mutedClass}>
            Clears the master switch, where-it-runs, provider, model, cloud choice, and audio
            source back to their defaults. Sermon Assist stays off afterwards.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={handleReset}
          className={`inline-flex items-center gap-2 ${
            darkMode ? 'border-gray-700 bg-transparent text-gray-200 hover:bg-gray-800' : ''
          }`}
        >
          <RotateCcw className="w-4 h-4" /> Reset all Sermon Assist settings
        </Button>
      </div>
    </div>
  );
};

export default SpeechSettingsSection;
