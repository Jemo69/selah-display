import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createLogger } from '../utils/logger.js';

const log = createLogger('SpeechStore');

// ---------------------------------------------------------------------------
// Live Sermon Assist — persisted contract (Phase 0)
//
// INVARIANT: OFF BY DEFAULT, COLD BY DEFAULT.
// `enabled` defaults to `false`, and nothing in this module spawns a process,
// opens a socket, requests a permission, touches `navigator.mediaDevices`, or
// makes a network request — on import, on mount, or on rehydrate. Every action
// below is a plain `set`. A corrupt localStorage value must never turn the
// feature on: rehydration sanitizes non-boolean `enabled` back to `false``.
// ---------------------------------------------------------------------------

const VALID_WHERE = ['local', 'network', 'cloud'];
const VALID_ENGINE_MODE = ['prod', 'test'];
const VALID_STATUS = ['idle', 'starting', 'listening', 'transcribing', 'error'];

/**
 * A finite number, or null.
 *
 * Used to sanitise persisted benchmark metrics. NaN and Infinity must both
 * collapse to null: a WER of Infinity means "no reference", and a rehydrated
 * Infinity would render as a number rather than as an absence.
 */
const finiteOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// D10: "local" is two axes — `where` = which MACHINE, `providerId` = which RUNTIME.
// Local leads; cloud is one option, not the default. The default model is the
// best model, not the smallest.
export const speechDefaults = () => ({
  enabled: false,
  where: 'local',
  engineMode: 'prod', // 'prod' (real local transcription) | 'test' (canned simulated engine)
  providerId: 'whispercpp',
  modelId: 'large-v3',
  cloudProviderId: null,
  // Provider-specific cloud model. Null means "use that provider's default";
  // it is deliberately runtime-only so a stale choice cannot survive restart.
  cloudModelId: null,

  // Phase 3 — the language the congregation actually speaks, used for the
  // spoken number words AND the "chapter"/"verse" keywords.
  //
  // WHY THIS IS NOT DERIVED FROM THE UI. The app's interface language and the
  // language preached in are genuinely different facts: a French-speaking
  // congregation running an English UI on a shared machine is ordinary. So
  // `null` means "decide at runtime" (see resolveSpeechLocale below) rather
  // than "assume the UI language".
  speechLocale: null,

  // Phase 7 — the quote lane's consent state.
  //
  // `quoteConsented` is NOT persisted on purpose. Consent is per SERVICE. A
  // remembered tick box from last Sunday is not this Sunday's consent, and a
  // checkbox that restores itself checked is a checkbox nobody reads.
  //
  // `quoteProviderId` IS persisted, because choosing a provider is a
  // preference and a key already exists for it. Consent is not.
  quoteProviderId: null,
  quoteConsented: false,
  quoteKeyReady: false,
  networkEndpoint: null,
  // Session-only remote engine secret. Deliberately NOT in PERSISTED_KEYS or
  // partialize(): a reload must require the operator to type it again rather
  // than leaving a LAN token in localStorage.
  networkToken: null,
  audio: {
    sourceId: null, // stable identity (deviceId), NOT an index
    sourceKind: null, // 'microphone' | 'usb' | 'line' | 'loopback' | 'network'
    lastSourceLabel: null,
    lastSeenAt: null,
  },
  ui: {
    railCollapsed: true,
    railWidth: 340,
    cloudBadgeVisible: true, // section 10: "Show cloud status badge", default ON
    showEngineErrors: true, // engine error banner in the rail, default ON — the operator can hide it
  },
  historyEnabled: true, // D9: transcript history ON BY DEFAULT

  // Phase 3 benchmark results. PERSISTED, because plan 9.4 requires them to
  // "persist in useSpeechStore and be re-readable forever, so a re-benchmark is
  // only ever run deliberately" — results that vanished on restart would make
  // the machine re-benchmark on every launch, which is the opposite of that.
  //
  // Metrics ONLY. No audio, no transcript text, no clip content ever lands
  // here; a result row is numbers and a short reason, and that is also what
  // plan 9.4 says an export may contain.
  benchmarkResults: [],
  // Which engine version produced them. Keyed per machine and per engine
  // version (plan 9.4: "keyed by provider and model, not by model alone"), so a
  // result from an engine that has since been upgraded is not silently mixed
  // with one from the new build.
  benchmarkEngineVersion: null,

  // Phase 6. The user has seen and dismissed the "suspended to protect this
  // computer" notice. PERSISTED, so dismissing it actually dismisses it —
  // a banner that reappears on every launch is a banner the user learns to
  // ignore, which costs the one moment it was meant to communicate.
  guardrailNoticeDismissed: false,
});

// Non-persisted runtime status — inert in Phase 0, and never written to disk
// so a crash cannot resurrect a stale "listening" state.
const runtimeDefaults = () => ({
  status: 'idle',
  health: null,
  lastError: null,
  // The engine's voice-activity state ('speech' | 'silence'), relayed so the
  // rail can show "hearing speech" before the first final. It is a state
  // word, never audio, and it is not persisted.
  vad: null,
  // Which benchmark is in flight, so the panel can offer Cancel instead of Run.
  // Deliberately NOT persisted: a crash mid-benchmark must not resurrect a
  // "running" claim on next launch, exactly like `status` itself.
  benchmarkRunningId: null,
  // A one-click setup completion asks the mounted rail to arm the microphone
  // once. It is consumed immediately and never persisted; a crash or reload
  // must not open the microphone later.
  autoStartRequested: false,
});

const PERSISTED_KEYS = [
  'enabled',
  'where',
  'engineMode',
  'providerId',
  'modelId',
  'cloudProviderId',
  'networkEndpoint',
  // Phase 3. Null means "decide at runtime from the browser locale".
  'speechLocale',
  'audio',
  'ui',
  'historyEnabled',
  // Phase 3. Sanitised below rather than trusted: a blob is untrusted input,
  // and a hand-edited result row must not be able to put arbitrary strings
  // into the panel.
  'benchmarkResults',
  'benchmarkEngineVersion',
  'guardrailNoticeDismissed',
];

/**
 * Fill missing keys from defaults (shallow top level, deep for `audio`/`ui`)
 * and harden every safety-relevant field against corrupt data. Runs on every
 * rehydrate path (migrate, merge, and onRehydrateStorage) so a future schema
 * change never loses a user's model choice and a corrupt blob never flips the
 * feature on.
 */
const sanitizeStoredState = (input) => {
  const stored = isPlainObject(input) ? input : {};
  const defaults = speechDefaults();

  const out = { ...defaults };
  for (const key of PERSISTED_KEYS) {
    if (stored[key] !== undefined) out[key] = stored[key];
  }

  // The master switch only accepts a literal boolean; "yes"/1/truthy garbage
  // all collapse to `false`.
  out.enabled = out.enabled === true;

  out.where = VALID_WHERE.includes(out.where) ? out.where : defaults.where;
  out.engineMode = VALID_ENGINE_MODE.includes(out.engineMode) ? out.engineMode : defaults.engineMode;

  if (typeof out.providerId !== 'string' || out.providerId.length === 0) {
    out.providerId = defaults.providerId;
  }
  if (typeof out.modelId !== 'string' || out.modelId.length === 0) {
    out.modelId = defaults.modelId;
  }

  out.cloudProviderId =
    typeof out.cloudProviderId === 'string' || out.cloudProviderId === null
      ? out.cloudProviderId
      : defaults.cloudProviderId;
  // Same contract as cloudProviderId: a string or explicitly null. A non-string
  // means the persisted value is junk, so it falls back to "decide at runtime"
  // rather than being trusted as a locale tag.
  out.speechLocale =
    typeof out.speechLocale === 'string' || out.speechLocale === null
      ? out.speechLocale
      : defaults.speechLocale;
  out.networkEndpoint =
    typeof out.networkEndpoint === 'string' || out.networkEndpoint === null
      ? out.networkEndpoint
      : defaults.networkEndpoint;

  out.audio = isPlainObject(stored.audio)
    ? { ...defaults.audio, ...stored.audio }
    : { ...defaults.audio };
  out.ui = isPlainObject(stored.ui)
    ? { ...defaults.ui, ...stored.ui }
    : { ...defaults.ui };
  // A corrupt or legacy ui blob must never hide errors by accident: only an
  // explicit boolean false turns the banner off, everything else is ON.
  if (typeof out.ui.showEngineErrors !== 'boolean') {
    out.ui.showEngineErrors = defaults.ui.showEngineErrors;
  }

  // Benchmark results are persisted, so a blob is untrusted input: keep only
  // rows that are shaped like a row, coerce every metric to a finite number or
  // null, and clamp `reason`. A hand-edited blob must not be able to inject
  // arbitrary text into the panel, and must not be able to smuggle a plausible
  // number past the panel's own gates.
  out.benchmarkResults = Array.isArray(stored.benchmarkResults)
    ? stored.benchmarkResults
        .filter((row) => isPlainObject(row) && typeof row.modelId === 'string' && row.modelId.length > 0)
        .map((row) => ({
          ...row,
          modelId: row.modelId.slice(0, 64),
          // `measured` is a claim. Only an explicit boolean true counts; a
          // truthy string cannot make a fabricated row look measured.
          measured: row.measured === true,
          reason: typeof row.reason === 'string' ? row.reason.slice(0, 400) : '',
          engineKind: typeof row.engineKind === 'string' ? row.engineKind.slice(0, 64) : null,
          wer: finiteOrNull(row.wer),
          rtf: finiteOrNull(row.rtf),
          cpuPercent: finiteOrNull(row.cpuPercent),
          rssMb: finiteOrNull(row.rssMb),
          at: typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : null,
        }))
    : defaults.benchmarkResults;

  out.benchmarkEngineVersion =
    typeof stored.benchmarkEngineVersion === 'string'
      ? stored.benchmarkEngineVersion.slice(0, 64)
      : defaults.benchmarkEngineVersion;

  // Only a literal true dismisses the notice. A truthy string in a blob must
  // not be able to hide a resource warning from the operator.
  out.guardrailNoticeDismissed =
    typeof stored.guardrailNoticeDismissed === 'boolean'
      ? stored.guardrailNoticeDismissed
      : defaults.guardrailNoticeDismissed;

  out.historyEnabled =
    typeof out.historyEnabled === 'boolean'
      ? out.historyEnabled
      : defaults.historyEnabled;

  return out;
};

const useSpeechStore = create(
  persist(
    (set) => ({
      ...speechDefaults(),
      ...runtimeDefaults(),

      // --- master off switch (invariant 4: cold by default) -----------------
      setEnabled: (enabled) => set({ enabled: Boolean(enabled) }),

      // --- engine configuration (pure state, no side effects) ---------------
      setWhere: (where) =>
        set({ where: VALID_WHERE.includes(where) ? where : 'local' }),
      setEngineMode: (engineMode) =>
        set({ engineMode: VALID_ENGINE_MODE.includes(engineMode) ? engineMode : 'prod' }),
      setProviderId: (providerId) => set({ providerId }),
      setModelId: (modelId) => set({ modelId }),
      setCloudProviderId: (cloudProviderId) =>
        set({
          cloudProviderId,
          // A Gemini id is meaningless to OpenAI and vice versa. Changing
          // provider always falls back to that provider's documented default.
          cloudModelId: null,
        }),
      setCloudModelId: (cloudModelId) =>
        set({ cloudModelId: typeof cloudModelId === 'string' && cloudModelId.trim() ? cloudModelId : null }),
      setNetworkEndpoint: (networkEndpoint) => set({ networkEndpoint }),
      setNetworkToken: (networkToken) =>
        set({ networkToken: typeof networkToken === 'string' && networkToken ? networkToken : null }),

      // --- audio source identity (fields exist from day one) ----------------
      setAudioSource: (partial) =>
        set((state) => ({
          audio: { ...state.audio, ...partial, lastSeenAt: Date.now() },
        })),
      clearAudioSource: () => set({ audio: { ...speechDefaults().audio } }),

      // --- Phase 3 benchmark results ----------------------------------------
      // Replaces the row for a model rather than appending, so a re-run never
      // leaves two results for the same model to disagree with each other.
      // The row is stored AS RECEIVED, including `measured: false` and its
      // reason — smoothing that away here would destroy the only honest thing
      // the panel has to say when no real engine is running.
      recordBenchmarkResult: (result) =>
        set((state) => {
          if (!result || typeof result.modelId !== 'string') return state;
          const rest = state.benchmarkResults.filter((row) => row.modelId !== result.modelId);
          return {
            benchmarkResults: [...rest, { ...result }],
            // Remember which engine produced these, so results from a since-
            // upgraded engine can be told apart instead of silently mixed.
            benchmarkEngineVersion:
              typeof result.engineKind === 'string' ? result.engineKind : state.benchmarkEngineVersion,
          };
        }),
      clearBenchmarkResults: () => set({ benchmarkResults: [], benchmarkEngineVersion: null }),

      // --- Phase 6 guardrail notice ------------------------------------------
      // Dismissal is a USER decision about a NOTICE. It deliberately does not
      // reset the guardrail itself: the machine's limits stay in force whether
      // or not anyone is looking at the banner, and a "clear this warning"
      // button that also raised the limit would be a trap.
      dismissGuardrailNotice: () => set({ guardrailNoticeDismissed: true }),
      // Called on a fresh trip, so a NEW suspension is shown again rather than
      // inheriting the dismissal of an earlier one.
      noteGuardrailTrip: () => set({ guardrailNoticeDismissed: false }),
      setBenchmarkRunning: (benchmarkRunningId) =>
        set({ benchmarkRunningId: benchmarkRunningId ?? null }),

      // --- UI (rail) --------------------------------------------------------
      setUI: (partial) => set((state) => ({ ui: { ...state.ui, ...partial } })),
      setHistoryEnabled: (historyEnabled) =>
        set({ historyEnabled: Boolean(historyEnabled) }),

      // --- spoken locale (Phase 3) -----------------------------------------
      // `null` is a meaningful value, not a reset: it hands the decision back
      // to runtime locale detection. Only a string narrows it.
      // --- quote lane (Phase 7) --------------------------------------------
      setQuoteProviderId: (quoteProviderId) =>
        set({
          quoteProviderId: typeof quoteProviderId === 'string' ? quoteProviderId : null,
          // A new provider invalidates the previous consent. Consent to send
          // text to one provider is not consent to send it to another.
          quoteConsented: false,
        }),
      setQuoteConsented: (quoteConsented) => set({ quoteConsented: Boolean(quoteConsented) }),
      setQuoteKeyReady: (quoteKeyReady) => set({ quoteKeyReady: Boolean(quoteKeyReady) }),

      setSpeechLocale: (speechLocale) =>
        set({ speechLocale: typeof speechLocale === 'string' && speechLocale.trim()
          ? speechLocale.trim()
          : null }),

      // --- runtime status (never persisted) ---------------------------------
      requestAutoStart: () => set({ autoStartRequested: true }),
      consumeAutoStart: () => set({ autoStartRequested: false }),
      setStatus: (status) =>
        set({ status: VALID_STATUS.includes(status) ? status : 'idle' }),
      setHealth: (health) => set({ health }),
      setVad: (vad) =>
        set({
          vad:
            vad && typeof vad.state === 'string'
              ? { state: vad.state === 'speech' ? 'speech' : 'silence' }
              : null,
        }),
      setLastError: (lastError) => set({ lastError }),

      resetToDefaults: () => set({ ...speechDefaults(), ...runtimeDefaults() }),
    }),
    {
      name: 'speech-store',
      version: 0,
      // A crash must not resurrect a stale "listening" state.
      partialize: (state) => ({
        enabled: state.enabled,
        where: state.where,
        engineMode: state.engineMode,
        providerId: state.providerId,
        modelId: state.modelId,
        cloudProviderId: state.cloudProviderId,
        networkEndpoint: state.networkEndpoint,
        audio: state.audio,
        ui: state.ui,
        historyEnabled: state.historyEnabled,
        // Phase 3: results persist so a re-benchmark is always deliberate
        // (plan 9.4), and survive a restart so the machine does not re-measure
        // the whole catalog on every launch. `benchmarkRunningId` is
        // deliberately absent — see runtimeDefaults().
        benchmarkResults: state.benchmarkResults,
        benchmarkEngineVersion: state.benchmarkEngineVersion,
        guardrailNoticeDismissed: state.guardrailNoticeDismissed,
      }),
      // Older/partial blobs: fill missing keys from defaults (shallow top
      // level, deep `audio`/`ui`) without losing the user's choices.
      migrate: (persisted) => sanitizeStoredState(persisted),
      // `merge`'s return value replaces the store state, so this is the
      // load-bearing guard: it drops persisted runtime fields, fills missing
      // keys, and forces a non-boolean `enabled` to `false`.
      merge: (persistedState, currentState) => {
        const current = isPlainObject(currentState) ? currentState : {};
        return {
          ...current,
          ...sanitizeStoredState(persistedState),
          // Runtime fields come from the live store, never from storage.
          status: current.status ?? 'idle',
          health: current.health ?? null,
          lastError: current.lastError ?? null,
        };
      },
      // Belt and suspenders: sanitize the rehydrated object in place too.
      onRehydrateStorage: () => (state, error) => {
        if (error || !state) return;
        Object.assign(state, sanitizeStoredState(state));
        if (!VALID_STATUS.includes(state.status)) state.status = 'idle';
      },
    }
  )
);

log.info('SpeechStore initialized');

export default useSpeechStore;
