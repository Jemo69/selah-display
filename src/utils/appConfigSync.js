import useLyricsStore, { defaultMcpSettings, defaultMetronomeSettings } from '../context/LyricsStore';
import useBibleStore from '../context/BibleStore';
import useSpeechStore from '../context/SpeechStore';
import { useOnboardStore } from '../context/OnboardStore';
import useRccgTphbStore from '../context/RccgTphbStore';
import { createDefaultAppConfig, mergeAppConfig, sanitizeAppConfigPatch } from '../../shared/appConfig.js';

let isApplyingRemoteConfig = false;

export function isApplyingRemoteAppConfig() {
  return isApplyingRemoteConfig;
}

/**
 * Extract the non-secret app configuration snapshot from the renderer Zustand stores.
 */
export function extractAppConfigFromStores() {
  const lyrics = useLyricsStore.getState();
  const bible = useBibleStore.getState();
  const speech = useSpeechStore.getState();
  const onboard = useOnboardStore.getState();
  const rccg = useRccgTphbStore.getState();

  const raw = {
    interface: {
      darkMode: Boolean(lyrics.darkMode),
      defaultLayout: lyrics.defaultLayout || 'bible-sidebar',
      uiScale: Number(lyrics.uiScale) || 100,
      fHintEnabled: lyrics.fHintEnabled !== false,
      sidebarCollapsed: Boolean(lyrics.sidebarCollapsed),
      settingsCollapsed: Boolean(lyrics.settingsCollapsed),
      sidebarWidth: Number(lyrics.sidebarWidth) || 430,
      headerCompact: Boolean(lyrics.headerCompact),
      vimMode: Boolean(lyrics.vimMode),
      showControlDockExpanded: lyrics.showControlDockExpanded !== false,
    },
    lyrics: {
      autoGroupLines: lyrics.autoGroupLines !== false,
      enableLyricSplitting: lyrics.enableLyricSplitting !== false,
      showSelectedLineHighlight: lyrics.showSelectedLineHighlight !== false,
      lyricContentSearchEnabled: lyrics.lyricContentSearchEnabled !== false,
      hotReloadEnabled: lyrics.hotReloadEnabled !== false,
      autoTurnOnOutput: lyrics.autoTurnOnOutput !== false,
    },
    bible: {
      defaultBibleId: bible.defaultBibleId ?? null,
      linkedBibleId: bible.linkedBibleId ?? null,
      parallelHidden: Boolean(bible.parallelHidden),
      settings: {
        referenceDivider: bible.settings?.referenceDivider || ':',
        showVerseNumbers: bible.settings?.showVerseNumbers !== false,
        splitLongVerses: Boolean(bible.settings?.splitLongVerses),
        longVersesChars: Number(bible.settings?.longVersesChars) || 100,
        longVersesTolerance: Number(bible.settings?.longVersesTolerance) || 0,
        splitMethod: bible.settings?.splitMethod || 'nearest-punctuation',
        switchInPlace: Boolean(bible.settings?.switchInPlace),
        truncateVersionPreviews: bible.settings?.truncateVersionPreviews !== false,
        logBibleSearches: bible.settings?.logBibleSearches !== false,
      },
    },
    speech: {
      enabled: speech.enabled === true,
      where: speech.where || 'local',
      engineMode: speech.engineMode || 'prod',
      providerId: speech.providerId || 'whispercpp',
      modelId: speech.modelId || 'large-v3',
      cloudProviderId: speech.cloudProviderId ?? null,
      speechLocale: speech.speechLocale ?? null,
      networkEndpoint: speech.networkEndpoint ?? null,
      historyEnabled: speech.historyEnabled !== false,
      ui: {
        railCollapsed: speech.ui?.railCollapsed !== false,
        railWidth: Number(speech.ui?.railWidth) || 340,
        cloudBadgeVisible: speech.ui?.cloudBadgeVisible !== false,
        showEngineErrors: speech.ui?.showEngineErrors !== false,
      },
    },
    performance: {
      lowPowerMode: Boolean(lyrics.performanceSettings?.lowPowerMode),
      disableVideoPreloading: Boolean(lyrics.performanceSettings?.disableVideoPreloading),
      reducedGraphics: Boolean(lyrics.performanceSettings?.reducedGraphics),
      gpuEffects: lyrics.performanceSettings?.gpuEffects !== false,
      disableHardwareAcceleration: Boolean(lyrics.performanceSettings?.disableHardwareAcceleration),
    },
    experimental: {
      freeNotesEnabled: Boolean(lyrics.freeNotesEnabled),
      schedulerEnabled: Boolean(lyrics.schedulerEnabled),
      bibleVerseEditorEnabled: Boolean(lyrics.bibleVerseEditorEnabled),
      bibleTextScopeEnabled: Boolean(lyrics.bibleTextScopeEnabled),
    },
    autoplay: {
      interval: Number(lyrics.autoplaySettings?.interval) || 5,
      loop: lyrics.autoplaySettings?.loop !== false,
      startFromFirst: lyrics.autoplaySettings?.startFromFirst !== false,
      skipBlankLines: lyrics.autoplaySettings?.skipBlankLines !== false,
    },
    metronome: {
      ...defaultMetronomeSettings(),
      ...(lyrics.metronomeSettings || {}),
    },
    onboard: {
      role: onboard.role || 'all',
      explainMode: Boolean(onboard.explainMode),
    },
    database: {
      baseUrl: rccg.baseUrl || '',
    },
    mcp: {
      ...defaultMcpSettings(),
      ...(lyrics.mcpSettings || {}),
    },
  };

  return mergeAppConfig(createDefaultAppConfig(), sanitizeAppConfigPatch(raw, null, { strict: false }));
}

/**
 * Apply a validated config patch received from the backend/MCP to the desktop stores.
 */
export function applyAppConfigPatchToStores(rawPatch) {
  if (!rawPatch || typeof rawPatch !== 'object') return false;
  const current = extractAppConfigFromStores();
  const patch = sanitizeAppConfigPatch(rawPatch, current, { strict: false });
  if (Object.keys(patch).length === 0) return false;

  isApplyingRemoteConfig = true;
  try {
    const lyrics = useLyricsStore.getState();
    const bible = useBibleStore.getState();
    const speech = useSpeechStore.getState();
    const onboard = useOnboardStore.getState();
    const rccg = useRccgTphbStore.getState();

    if (patch.interface) {
      const i = patch.interface;
      if ('darkMode' in i) lyrics.setDarkMode?.(i.darkMode);
      if ('defaultLayout' in i) lyrics.setDefaultLayout?.(i.defaultLayout);
      if ('uiScale' in i) lyrics.setUiScale?.(i.uiScale);
      if ('fHintEnabled' in i) lyrics.setFHintEnabled?.(i.fHintEnabled);
      if ('sidebarCollapsed' in i) lyrics.setSidebarCollapsed?.(i.sidebarCollapsed);
      if ('settingsCollapsed' in i) lyrics.setSettingsCollapsed?.(i.settingsCollapsed);
      if ('sidebarWidth' in i) lyrics.setSidebarWidth?.(i.sidebarWidth);
      if ('headerCompact' in i) lyrics.setHeaderCompact?.(i.headerCompact);
      if ('vimMode' in i) lyrics.setVimMode?.(i.vimMode);
      if ('showControlDockExpanded' in i) lyrics.setShowControlDockExpanded?.(i.showControlDockExpanded);
    }

    if (patch.lyrics) {
      const l = patch.lyrics;
      if ('autoGroupLines' in l) lyrics.setAutoGroupLines?.(l.autoGroupLines);
      if ('enableLyricSplitting' in l) lyrics.setEnableLyricSplitting?.(l.enableLyricSplitting);
      if ('showSelectedLineHighlight' in l) lyrics.setShowSelectedLineHighlight?.(l.showSelectedLineHighlight);
      if ('lyricContentSearchEnabled' in l) lyrics.setLyricContentSearchEnabled?.(l.lyricContentSearchEnabled);
      if ('hotReloadEnabled' in l) lyrics.setHotReloadEnabled?.(l.hotReloadEnabled);
      if ('autoTurnOnOutput' in l) lyrics.setAutoTurnOnOutput?.(l.autoTurnOnOutput);
    }

    if (patch.bible) {
      const b = patch.bible;
      if ('defaultBibleId' in b) bible.setDefaultBible?.(b.defaultBibleId);
      if ('linkedBibleId' in b) bible.setLinkedBible?.(b.linkedBibleId);
      if ('parallelHidden' in b) bible.setParallelHidden?.(b.parallelHidden);
      if (b.settings) bible.updateSettings?.(b.settings);
    }

    if (patch.speech) {
      const s = patch.speech;
      if ('enabled' in s) speech.setEnabled?.(s.enabled);
      if ('where' in s) speech.setWhere?.(s.where);
      if ('engineMode' in s) speech.setEngineMode?.(s.engineMode);
      if ('providerId' in s) speech.setProviderId?.(s.providerId);
      if ('modelId' in s) speech.setModelId?.(s.modelId);
      if ('cloudProviderId' in s) speech.setCloudProviderId?.(s.cloudProviderId);
      if ('speechLocale' in s) speech.setSpeechLocale?.(s.speechLocale);
      if ('networkEndpoint' in s) speech.setNetworkEndpoint?.(s.networkEndpoint);
      if ('historyEnabled' in s) speech.setHistoryEnabled?.(s.historyEnabled);
      if (s.ui) speech.setUI?.(s.ui);
    }

    if (patch.performance) {
      lyrics.setPerformanceSettings?.(patch.performance);
      if ('disableHardwareAcceleration' in patch.performance && typeof window !== 'undefined') {
        try {
          window.electronAPI?.updateHardwareAcceleration?.(patch.performance.disableHardwareAcceleration);
        } catch {
          // non-fatal outside Electron
        }
      }
    }

    if (patch.experimental) {
      const e = patch.experimental;
      if ('freeNotesEnabled' in e) lyrics.setFreeNotesEnabled?.(e.freeNotesEnabled);
      if ('schedulerEnabled' in e) lyrics.setSchedulerEnabled?.(e.schedulerEnabled);
      if ('bibleVerseEditorEnabled' in e) lyrics.setBibleVerseEditorEnabled?.(e.bibleVerseEditorEnabled);
      if ('bibleTextScopeEnabled' in e) lyrics.setBibleTextScopeEnabled?.(e.bibleTextScopeEnabled);
    }

    if (patch.autoplay) {
      lyrics.setAutoplaySettings?.({
        ...(lyrics.autoplaySettings || {}),
        ...patch.autoplay,
      });
    }

    if (patch.metronome) {
      lyrics.setMetronomeSettings?.({
        ...(lyrics.metronomeSettings || {}),
        ...patch.metronome,
      });
    }

    if (patch.onboard) {
      const o = patch.onboard;
      if ('role' in o) onboard.setRole?.(o.role);
      if ('explainMode' in o) onboard.setExplainMode?.(o.explainMode);
    }

    if (patch.database && 'baseUrl' in patch.database) {
      rccg.setBaseUrl?.(patch.database.baseUrl || '');
    }

    if (patch.mcp) {
      lyrics.setMcpSettings?.(patch.mcp);
    }

    return true;
  } finally {
    isApplyingRemoteConfig = false;
  }
}

/**
 * Subscribe to local store preference changes and emit debounced snapshots.
 */
export function subscribeAppConfigChanges(onChange, { debounceMs = 150 } = {}) {
  let lastSerialized = JSON.stringify(extractAppConfigFromStores());
  let timer = null;

  const scheduleEmit = () => {
    if (isApplyingRemoteConfig) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (isApplyingRemoteConfig) return;
      const snapshot = extractAppConfigFromStores();
      const serialized = JSON.stringify(snapshot);
      if (serialized === lastSerialized) return;
      lastSerialized = serialized;
      onChange?.(snapshot);
    }, debounceMs);
  };

  const unsubs = [
    useLyricsStore.subscribe(scheduleEmit),
    useBibleStore.subscribe(scheduleEmit),
    useSpeechStore.subscribe(scheduleEmit),
    useOnboardStore.subscribe(scheduleEmit),
    useRccgTphbStore.subscribe(scheduleEmit),
  ];

  return () => {
    if (timer) clearTimeout(timer);
    unsubs.forEach((unsub) => {
      try { unsub?.(); } catch {}
    });
  };
}
