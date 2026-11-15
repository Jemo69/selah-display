import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { createLogger } from '../utils/logger.js';
import { zustandPersistentStorage } from '../utils/persistentStorage.js';
import { normalizeContentMode, CONTENT_MODE_SONG, CONTENT_MODE_BIBLE, CONTENT_MODE_FREENOTE } from '../utils/contentMode.js';
import { createInitialSession, migratePersistedState, reduceSelectMode, reduceLoadSong, reduceLoadBibleVerse, reduceLoadFreeNote, SESSION_SCHEMA_VERSION } from './sessionModel.js';
import { isChordChart } from '../../shared/chords.js';
import { defaultPreviewMultiview, normalizePreviewMultiview } from '../utils/previewMultiview.js';

const log = createLogger('LyricsStore');

export const defaultOutput1Settings = {
  fontStyle: 'Bebas Neue',
  bold: false,
  italic: false,
  underline: false,
  allCaps: false,
  textAlign: 'center',
  fontSize: 48,
  translationFontSizeMode: 'bound',
  translationFontSize: 48,
  fontColor: '#FFFFFF',
  translationLineColor: '#FBBF24',
  borderColor: '#000000',
  borderSize: 0,
  dropShadowColor: '#000000',
  dropShadowOpacity: 4,
  dropShadowOffsetX: 0,
  dropShadowOffsetY: 8,
  dropShadowBlur: 10,
  backgroundColor: '#000000',
  backgroundOpacity: 0,
  backgroundBandVerticalPadding: 20,
  backgroundBandHeightMode: 'adaptive',
  backgroundBandCustomLines: 3,
  backgroundBandLockedToMaxLines: false,
  lyricsPosition: 'lower',
  fullScreenMode: false,
  fullScreenBackgroundType: 'color',
  fullScreenBackgroundColor: '#000000',
  fullScreenBackgroundMedia: null,
  fullScreenBackgroundMediaName: '',
  fullScreenBackgroundMotionPreset: 'amber-drift',
  fullScreenBackgroundMotionDim: 0.65,
  alwaysShowBackground: false,
  fullScreenRestorePosition: null,
  xMargin: 3.5,
  yMargin: 2,
  maxLinesEnabled: false,
  maxLines: 3,
  minFontSize: 24,
  maxFontSize: 300,
  fitWidthPercent: 90,
  fitHeightPercent: 90,
  bibleReferencePosition: 'bottom-center',
  bibleReferenceSize: 28,
  showBibleVersion: true,
  parallelLayout: 'side-by-side',
  autosizerActive: false,
  primaryViewportWidth: null,
  primaryViewportHeight: null,
  allInstances: null,
  instanceCount: 0,
  transitionAnimation: 'none',
  transitionSpeed: 150,
  ndiEnabled: false,
  ndiSourceName: ''
};

export const defaultOutput2Settings = {
  fontStyle: 'Bebas Neue',
  bold: false,
  italic: false,
  underline: false,
  allCaps: false,
  textAlign: 'center',
  fontSize: 72,
  translationFontSizeMode: 'bound',
  translationFontSize: 72,
  fontColor: '#FFFFFF',
  translationLineColor: '#FBBF24',
  borderColor: '#000000',
  borderSize: 0,
  dropShadowColor: '#000000',
  dropShadowOpacity: 4,
  dropShadowOffsetX: 0,
  dropShadowOffsetY: 8,
  dropShadowBlur: 10,
  backgroundColor: '#000000',
  backgroundOpacity: 0,
  backgroundBandVerticalPadding: 30,
  backgroundBandHeightMode: 'adaptive',
  backgroundBandCustomLines: 3,
  backgroundBandLockedToMaxLines: false,
  lyricsPosition: 'lower',
  fullScreenMode: false,
  fullScreenBackgroundType: 'color',
  fullScreenBackgroundColor: '#000000',
  fullScreenBackgroundMedia: null,
  fullScreenBackgroundMediaName: '',
  fullScreenBackgroundMotionPreset: 'amber-drift',
  fullScreenBackgroundMotionDim: 0.65,
  alwaysShowBackground: false,
  fullScreenRestorePosition: null,
  xMargin: 3.5,
  yMargin: 2,
  maxLinesEnabled: false,
  maxLines: 3,
  minFontSize: 24,
  maxFontSize: 300,
  fitWidthPercent: 90,
  fitHeightPercent: 90,
  bibleReferencePosition: 'bottom-center',
  bibleReferenceSize: 28,
  showBibleVersion: true,
  parallelLayout: 'side-by-side',
  autosizerActive: false,
  primaryViewportWidth: null,
  primaryViewportHeight: null,
  allInstances: null,
  instanceCount: 0,
  transitionAnimation: 'none',
  transitionSpeed: 150,
  ndiEnabled: false,
  ndiSourceName: ''
};

export const defaultStageSettings = {
  transparentBackground: false,
  fullScreenBackgroundType: 'color',
  fullScreenBackgroundColor: '#000000',
  fullScreenBackgroundMedia: null,
  fullScreenBackgroundMediaName: '',
  fullScreenBackgroundMotionPreset: 'amber-drift',
  fullScreenBackgroundMotionDim: 0.65,
  alwaysShowBackground: false,
  showOffScreenImage: false,
  offScreenMedia: null,
  offScreenMediaName: '',
  fontStyle: 'Bebas Neue',
  backgroundColor: '#000000',
  liveFontSize: 120,
  liveColor: '#FFFFFF',
  liveBold: true,
  liveItalic: false,
  liveUnderline: false,
  liveAllCaps: false,
  liveAlign: 'left',
  nextFontSize: 72,
  nextColor: '#808080',
  nextBold: false,
  nextItalic: false,
  nextUnderline: false,
  nextAllCaps: false,
  nextAlign: 'left',
  showNextArrow: true,
  nextArrowColor: '#FFA500',
  prevFontSize: 28,
  prevColor: '#404040',
  prevBold: false,
  prevItalic: false,
  prevUnderline: false,
  prevAllCaps: false,
  prevAlign: 'left',
  currentSongColor: '#FFFFFF',
  currentSongSize: 24,
  topBarAlignment: 'left',
  showTopBar: true,
  showUpcomingSong: false,
  upcomingSongColor: '#808080',
  upcomingSongSize: 18,
  upcomingSongMode: 'automatic',
  upcomingSongFullScreen: false,
  timerFullScreen: false,
  customMessagesFullScreen: false,
  showTime: true,
  showNextLine: true,
  showPrevLine: true,
  showWaitingForLyrics: false,
  showChordChart: true,
  chordTranspose: 0,
  chordNotation: 'letters',
  messageScrollSpeed: 3000,
  bottomBarColor: '#FFFFFF',
  bottomBarSize: 20,
  translationLineColor: '#FBBF24',
  maxLinesEnabled: false,
  maxLines: 3,
  minFontSize: 24,
  maxFontSize: 300,
  fitWidthPercent: 90,
  fitHeightPercent: 90,
  bibleReferencePosition: 'bottom-center',
  bibleReferenceSize: 28,
  showBibleVersion: true,
  parallelLayout: 'side-by-side',
  transitionAnimation: 'slide',
  transitionSpeed: 300,
  ndiEnabled: false,
  ndiSourceName: ''
};

/**
 * Metronome defaults, matching FreeShow's `defaultMetronomeValues`
 * (tempo 120, 4 beats, full volume) with this app's naming for the click sound
 * and audio routing. Written as a factory so each caller gets a fresh object
 * and a corrupt persisted blob cannot leak a shared reference.
 */
export const defaultMetronomeSettings = () => ({
  tempo: 120,
  beats: 4,
  volume: 1,
  clickSound: 'metal',
  clickSoundHi: '',
  clickSoundLo: '',
  audioOutput: '',
  audioChannel: '',
});

const useLyricsStore = create(
  persist(
    (set, get) => ({
      lyrics: [],
      rawLyricsContent: '',
      chordChart: null,
      selectedLine: null,
      showSelectedLineHighlight: true,
      previewMode: false,
      previewSelectedLine: null,
      lyricsFileName: '',
      bibleVersion: '',
      lyricsSections: [],
      lineToSection: {},
      isOutputOn: true,
      // Explicit show-control machine (feature #18). isOutputOn stays the
      // legacy master flag: only LIVE reads as master ON.
      showState: 'LIVE',
      // Dock starts open: the show controls are the point of the sidebar, and
      // hiding them by default would be a surprise on a fresh install.
      showControlDockExpanded: true,
      tickerQueue: [],
      tickerActiveId: null,
      announcementTargetOutputKey: 'all',
      autoTurnOnOutput: true,
      outputActions: [{ id: crypto.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`, endpoint: 'http://localhost:5505/', onAction: '', offAction: '', payloadFormat: 'boolean' }],
      output1Enabled: true,
      output2Enabled: true,
      stageEnabled: true,
      customOutputs: [],
      customOutputSettings: {},
      customOutputEnabled: {},
      darkMode: false,
      hasSeenWelcome: false,
      setlistFiles: [],
      lyricsHistory: [],
      isDesktopApp: false,
      setlistModalOpen: false,
      songMetadata: {
        title: '',
        artists: [],
        album: '',
        year: null,
        origin: '',
        filePath: '',
      },
      autoplaySettings: {
        interval: 5,
        loop: true,
        startFromFirst: true,
        skipBlankLines: true,
      },
      performanceSettings: {
        lowPowerMode: false,
        disableVideoPreloading: false,
        reducedGraphics: false,
        disableHardwareAcceleration: false,
        gpuEffects: true,
      },
      lyricsTimestamps: [],
      hasSeenIntelligentAutoplayInfo: false,
      pendingSavedVersion: null,
      sidebarCollapsed: false,
      settingsCollapsed: false,
      sidebarWidth: 430,
      headerCompact: false,
      vimMode: false,
      autoGroupLines: true,
      enableLyricSplitting: true,
      hotReloadEnabled: true,
      defaultLayout: 'bible-sidebar',
      uiScale: 100,
      fHintEnabled: true,
      contentMode: 'song',
      modeTemplates: {
        output1: { enabled: false, song: null, bible: null, freenote: null },
        output2: { enabled: false, song: null, bible: null, freenote: null },
        stage: { enabled: false, song: null, bible: null, freenote: null },
      },
      freeNotesDrafts: [],
      freeNotesEnabled: false,
      lyricContentSearchEnabled: true,
      // Service run-sheet clock (feature #01) — default OFF, beta.
      schedulerEnabled: false,
      previewMultiview: defaultPreviewMultiview(),
      bibleVerseEditorEnabled: false,
      // Metronome (ported from FreeShow). Config only — the live beat clock
      // lives in the engine module so it survives remounts without persisting.
      metronomeSettings: defaultMetronomeSettings(),
      _lastAppliedModeTemplate: {},
      session: createInitialSession(),
      _persistVersion: SESSION_SCHEMA_VERSION,
      displayLabel: '',

      setLyrics: (lines) => {
        log.info('Lyrics loaded', { lineCount: lines?.length ?? 0 });
        set({ lyrics: Array.isArray(lines) ? lines : [], previewSelectedLine: null });
      },
      setLyricsSections: (sections) => set({ lyricsSections: Array.isArray(sections) ? sections : [] }),
      setLineToSection: (mapping) => set({ lineToSection: mapping && typeof mapping === 'object' ? mapping : {} }),
      setRawLyricsContent: (content) => set({ rawLyricsContent: content }),
      setChordChart: (chart) => set({ chordChart: isChordChart(chart) ? chart : null }),
      setLyricsFileName: (name) => {
        log.info('Lyrics file changed (label-only)', { name });
        // Label-only: never decides contentMode or bibleVersion. Socket echo is display label.
        set({ lyricsFileName: name || '', displayLabel: name || '' });
      },
      setDisplayLabel: (name) => set({ displayLabel: name || '', lyricsFileName: name || '' }),
      setBibleVersion: (version) => {
        log.info('Bible version changed', { version });
        const mode = version ? CONTENT_MODE_BIBLE : CONTENT_MODE_SONG;
        set((state) => ({
          bibleVersion: version || '',
          contentMode: mode,
          session: {
            ...(state.session || createInitialSession()),
            contentMode: mode,
            revision: (state.session?.revision || 0) + 1,
          },
        }));
      },
      setBibleContent: (fileName, version) => {
        log.info('Bible content changed (atomic)', { fileName, version });
        set((state) => ({
          ...reduceLoadBibleVerse(state, { reference: fileName || '', bible: version || '', bibleId: version || '', text: '', slides: [] }),
          lyricsFileName: fileName || '',
          bibleVersion: version || '',
          displayLabel: fileName || '',
        }));
      },
      // Authoritative session commands — only valid mode writers
      selectMode: (mode) => {
        let normalized = normalizeContentMode(mode);
        const isEnabled = useLyricsStore.getState().freeNotesEnabled;
        if (!isEnabled && normalized === 'freenote') {
          normalized = 'song';
        }
        log.info('selectMode', { mode: normalized });
        set((state) => reduceSelectMode(state, normalized));
      },
      loadSong: (payload) => {
        log.info('loadSong atomic', { fileName: payload?.fileName, title: payload?.title });
        set((state) => reduceLoadSong(state, payload));
      },
      loadBibleVerse: (payload) => {
        log.info('loadBibleVerse atomic', { reference: payload?.reference });
        set((state) => ({
          ...reduceLoadBibleVerse(state, payload),
          bibleVersion: payload?.bible || payload?.bibleId || state.bibleVersion || '',
          displayLabel: payload?.reference || '',
        }));
      },
      loadFreeNote: (payload) => {
        log.info('loadFreeNote atomic', { title: payload?.title || 'Free Note' });
        set((state) => ({
          ...reduceLoadFreeNote(state, payload),
          displayLabel: payload?.title || 'Free Note',
        }));
      },
      saveFreeNoteDraft: (draft) => {
        if (!draft || !draft.id) return;
        set((state) => {
          const list = state.freeNotesDrafts || [];
          const idx = list.findIndex((d) => d.id === draft.id);
          const updated = idx >= 0
            ? list.map((d, i) => i === idx ? { ...d, ...draft, updatedAt: Date.now() } : d)
            : [{ ...draft, createdAt: Date.now(), updatedAt: Date.now() }, ...list];
          return { freeNotesDrafts: updated };
        });
      },
      deleteFreeNoteDraft: (id) => {
        set((state) => ({
          freeNotesDrafts: (state.freeNotesDrafts || []).filter((d) => d.id !== id),
        }));
      },
      selectLine: (index) => {
        log.debug('Line selected', { index });
        set({ selectedLine: index });
      },
      setShowSelectedLineHighlight: (show) => set({ showSelectedLineHighlight: !!show }),
      setPreviewMode: (enabled) => {
        log.info('Preview mode toggled', { enabled: !!enabled });
        set((state) => ({
          previewMode: !!enabled,
          // Leaving preview mode clears any staged preview; entering keeps live line untouched.
          previewSelectedLine: enabled ? state.previewSelectedLine ?? null : null,
        }));
      },
      setPreviewSelectedLine: (index) => set({ previewSelectedLine: index ?? null }),
      setIsOutputOn: (state) => {
        // Legacy master toggle mapped onto the show-state machine so every
        // existing caller keeps working: ON restores LIVE; OFF blacks out
        // from LIVE but preserves an explicit CLEAR / LOGO / BLACKOUT choice.
        const on = !!state;
        log.info('Output toggled', { isOutputOn: on });
        set((prev) => {
          const current = prev.showState || 'LIVE';
          const nextShow = on ? 'LIVE' : (current === 'LIVE' ? 'BLACKOUT' : current);
          return { isOutputOn: on, showState: nextShow };
        });
      },
      setShowState: (state) => {
        const valid = ['LIVE', 'CLEAR', 'BLACKOUT', 'LOGO'];
        const next = valid.includes(String(state || '').toUpperCase())
          ? String(state).toUpperCase()
          : 'LIVE';
        log.info('Show state changed', { showState: next });
        set({ showState: next, isOutputOn: next === 'LIVE' });
      },
      setTickerQueue: (queue) => set({
        tickerQueue: Array.isArray(queue) ? queue : [],
      }),
      setTickerActiveId: (id) => set({ tickerActiveId: id ?? null }),
      setTickerState: (queue, activeId) => set({
        tickerQueue: Array.isArray(queue) ? queue : [],
        tickerActiveId: activeId ?? null,
      }),
      setAnnouncementTargetOutput: (outputKey) => {
        const normalized = String(outputKey || '').trim().toLowerCase();
        set({ announcementTargetOutputKey: normalized || 'all' });
      },
      setAutoTurnOnOutput: (auto) => set({ autoTurnOnOutput: auto }),
      setOutputActions: (actions) => set({ outputActions: actions }),
      addOutputAction: () => set((state) => ({
        outputActions: [...state.outputActions, { id: crypto.randomUUID?.() || String(Date.now()), endpoint: 'http://localhost:5505/', onAction: '', offAction: '', payloadFormat: 'boolean', enabled: true }],
      })),
      removeOutputAction: (id) => set((state) => ({
        outputActions: state.outputActions.filter((a) => a.id !== id),
      })),
      updateOutputAction: (id, updates) => set((state) => ({
        outputActions: state.outputActions.map((a) => a.id === id ? { ...a, ...updates } : a),
      })),
      httpActionButtons: [],
      setHttpActionButtons: (buttons) => set({ httpActionButtons: Array.isArray(buttons) ? buttons : [] }),
      addHttpActionButton: () => set((state) => ({
        httpActionButtons: [
          ...(Array.isArray(state.httpActionButtons) ? state.httpActionButtons : []),
          {
            id: crypto.randomUUID?.() || String(Date.now() + Math.random()),
            label: 'HTTP',
            url: 'http://localhost:8080/trigger',
            method: 'POST',
            headers: '{"Content-Type":"application/json"}',
            body: '',
            // No variables by default: the action fires immediately. Adding a
            // variable makes the button prompt for input before each request.
            variables: [],
          },
        ],
      })),
      removeHttpActionButton: (id) => set((state) => ({
        httpActionButtons: (state.httpActionButtons || []).filter((b) => b.id !== id),
      })),
      updateHttpActionButton: (id, updates) => set((state) => ({
        httpActionButtons: (state.httpActionButtons || []).map((b) => b.id === id ? { ...b, ...updates } : b),
      })),
      setOutput1Enabled: (enabled) => set({ output1Enabled: enabled }),
      setOutput2Enabled: (enabled) => set({ output2Enabled: enabled }),
      setStageEnabled: (enabled) => set({ stageEnabled: enabled }),
      setCustomOutputEnabled: (outputKey, enabled) => {
        log.info('Custom output toggled', { outputKey, enabled });
        set((state) => ({
          customOutputEnabled: {
            ...state.customOutputEnabled,
            [outputKey]: enabled,
          },
        }));
      },
      setDarkMode: (mode) => set({ darkMode: mode }),
      setHasSeenWelcome: (seen) => set({ hasSeenWelcome: seen }),
      setSetlistFiles: (files) => {
        log.info('Setlist files updated', { count: files.length });
        set({ setlistFiles: files });
      },
      setIsDesktopApp: (isDesktop) => set({ isDesktopApp: isDesktop }),
      setSetlistModalOpen: (open) => set({ setlistModalOpen: open }),
      setSongMetadata: (metadata) => set({ songMetadata: metadata }),
      setAutoplaySettings: (settings) => set({ autoplaySettings: settings }),
      setPerformanceSettings: (settings) => set((state) => ({
        performanceSettings: { ...state.performanceSettings, ...settings }
      })),
      setLyricsTimestamps: (timestamps) => set({ lyricsTimestamps: timestamps }),
      setHasSeenIntelligentAutoplayInfo: (seen) => set({ hasSeenIntelligentAutoplayInfo: seen }),
      setPendingSavedVersion: (payload) => set({ pendingSavedVersion: payload || null }),
      clearPendingSavedVersion: () => set({ pendingSavedVersion: null }),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setShowControlDockExpanded: (expanded) => set({ showControlDockExpanded: !!expanded }),
      setMetronomeSettings: (settings) => set({ metronomeSettings: { ...defaultMetronomeSettings(), ...(settings || {}) } }),

      setDefaultLayout: (layout) => set({ defaultLayout: layout }),
      setUiScale: (scale) => set({ uiScale: Math.min(150, Math.max(75, Math.round(scale) || 100)) }),
      setSettingsCollapsed: (collapsed) => set({ settingsCollapsed: collapsed }),
      setSidebarWidth: (width) => set({ sidebarWidth: width }),
      setHeaderCompact: (compact) => set({ headerCompact: compact }),
      setVimMode: (enabled) => set({ vimMode: enabled }),
      setAutoGroupLines: (enabled) => set({ autoGroupLines: !!enabled }),
      setEnableLyricSplitting: (enabled) => set({ enableLyricSplitting: !!enabled }),
      setHotReloadEnabled: (enabled) => set({ hotReloadEnabled: !!enabled }),
      setFHintEnabled: (enabled) => set({ fHintEnabled: !!enabled }),
      setFreeNotesEnabled: (enabled) => {
        const isEnabled = !!enabled;
        log.info('setFreeNotesEnabled', { enabled: isEnabled });
        set((state) => {
          const next = { freeNotesEnabled: isEnabled };
          if (!isEnabled && state.contentMode === 'freenote') {
            return { ...next, ...reduceSelectMode(state, 'song') };
          }
          return next;
        });
      },
      setLyricContentSearchEnabled: (enabled) => {
        const isEnabled = !!enabled;
        log.info('setLyricContentSearchEnabled', { enabled: isEnabled });
        set({ lyricContentSearchEnabled: isEnabled });
      },
      setSchedulerEnabled: (enabled) => {
        const isEnabled = !!enabled;
        log.info('setSchedulerEnabled', { enabled: isEnabled });
        set({ schedulerEnabled: isEnabled });
      },
      setPreviewMultiview: (prefs) => {
        const next = normalizePreviewMultiview(prefs);
        log.info('setPreviewMultiview', next);
        set({ previewMultiview: next });
      },
      setPreviewMultiviewTiles: (visibleTiles) => {
        log.info('setPreviewMultiviewTiles', { visibleTiles });
        set((state) => ({
          previewMultiview: normalizePreviewMultiview({
            ...state.previewMultiview,
            visibleTiles,
          }),
        }));
      },
      setPreviewMultiviewColumns: (columnCount) => {
        log.info('setPreviewMultiviewColumns', { columnCount });
        set((state) => ({
          previewMultiview: normalizePreviewMultiview({
            ...state.previewMultiview,
            columnCount,
          }),
        }));
      },
      setBibleVerseEditorEnabled: (enabled) => {
        const isEnabled = !!enabled;
        log.info('setBibleVerseEditorEnabled', { enabled: isEnabled });
        set({ bibleVerseEditorEnabled: isEnabled });
      },
      setContentMode: (mode) => {
        let normalized = normalizeContentMode(mode);
        const isEnabled = useLyricsStore.getState().freeNotesEnabled;
        if (!isEnabled && normalized === 'freenote') {
          normalized = 'song';
        }
        set((state) => reduceSelectMode(state, normalized));
      },
      setModeTemplateEnabled: (outputKey, enabled) => set((state) => {
        const nextTemplates = {
          ...(state.modeTemplates || {}),
          [outputKey]: {
            ...(state.modeTemplates?.[outputKey] || { enabled: false, song: null, bible: null, freenote: null }),
            enabled: !!enabled,
          },
        };
        // clear _lastApplied when toggling to avoid stuck skip on re-enable
        const { [outputKey]: _rm, ...restLast } = state._lastAppliedModeTemplate || {};
        return { modeTemplates: nextTemplates, _lastAppliedModeTemplate: restLast };
      }),
      setModeTemplate: (outputKey, mode, templateId) => set((state) => {
        const { [outputKey]: _rm, ...restLast } = state._lastAppliedModeTemplate || {};
        return {
          modeTemplates: {
            ...(state.modeTemplates || {}),
            [outputKey]: {
              ...(state.modeTemplates?.[outputKey] || { enabled: false, song: null, bible: null, freenote: null }),
              [mode]: templateId ?? null,
            },
          },
          _lastAppliedModeTemplate: restLast,
        };
      }),
      getModeTemplate: (outputKey, mode) => {
        const state = get();
        return state.modeTemplates?.[outputKey]?.[mode] ?? null;
      },
      isModeTemplateEnabled: (outputKey) => {
        const state = get();
        return !!state.modeTemplates?.[outputKey]?.enabled;
      },
      copyModeTemplates: (fromKey, toKeys, opts = {}) => set((state) => {
        const src = state.modeTemplates?.[fromKey];
        if (!src) return state;
        const next = { ...(state.modeTemplates || {}) };
        for (const toKey of toKeys || []) {
          if (!toKey || toKey === fromKey) continue;
          const target = next[toKey] || { enabled: false, song: null, bible: null, freenote: null };
          next[toKey] = {
            enabled: opts.includeEnabled ? !!src.enabled : target.enabled,
            song: src.song ?? null,
            bible: src.bible ?? null,
            freenote: src.freenote ?? null,
          };
        }
        return { modeTemplates: next };
      }),
      setLastAppliedModeTemplate: (outputKey, entry) => set((state) => ({
        _lastAppliedModeTemplate: {
          ...(state._lastAppliedModeTemplate || {}),
          [outputKey]: entry,
        },
      })),
      clearLastAppliedModeTemplate: (outputKey) => set((state) => {
        if (!outputKey) return { _lastAppliedModeTemplate: {} };
        const { [outputKey]: _removed, ...rest } = state._lastAppliedModeTemplate || {};
        return { _lastAppliedModeTemplate: rest };
      }),
      setModeTemplatesFromServer: (templates) => set((state) => {
        if (!templates || typeof templates !== 'object') return state;
        const next = {};
        for (const [k, v] of Object.entries(templates)) {
          if (!v || typeof v !== 'object') continue;
          next[k] = { enabled: !!v.enabled, song: v.song ?? null, bible: v.bible ?? null, freenote: v.freenote ?? null };
        }
        // ensure built-ins present
        for (const k of ['output1', 'output2', 'stage']) if (!next[k]) next[k] = state.modeTemplates?.[k] || { enabled: false, song: null, bible: null, freenote: null };
        // keep custom entries that server may not yet know (offline fallback) — merge
        for (const k of Object.keys(state.modeTemplates || {})) {
          if (k.startsWith('custom_') && !next[k]) next[k] = state.modeTemplates[k];
        }
        return { modeTemplates: next };
      }),
      addSetlistFiles: (newFiles) => set((state) => ({
        setlistFiles: [...state.setlistFiles, ...newFiles]
      })),
      removeSetlistFile: (fileId) => set((state) => ({
        setlistFiles: state.setlistFiles.filter(file => file.id !== fileId)
      })),
      clearSetlist: () => set({ setlistFiles: [] }),

      addToLyricsHistory: (metadata, lines) => set((state) => {
        if (!metadata?.title) return state;
        const entry = {
          id: metadata.filePath || `manual_${Date.now()}`,
          title: metadata.title,
          artists: metadata.artists || [],
          timestamp: Date.now(),
          lines: lines || state.lyrics
        };
        const filteredHistory = state.lyricsHistory.filter(h => h.title !== entry.title);
        return {
          lyricsHistory: [entry, ...filteredHistory].slice(0, 50)
        };
      }),

      clearLyricsHistory: () => set({ lyricsHistory: [] }),

      getSetlistFile: (fileId) => {
        const state = get();
        return state.setlistFiles.find(file => file.id === fileId);
      },

      isSetlistFull: () => {
        const state = get();
        return state.setlistFiles.length >= 50;
      },

      getAvailableSetlistSlots: () => {
        const state = get();
        return Math.max(0, 50 - state.setlistFiles.length);
      },

      output1Settings: defaultOutput1Settings,
      output2Settings: defaultOutput2Settings,
      stageSettings: defaultStageSettings,
      createCustomOutput: ({ name, slug, type, sourceOutputKey }) => {
        log.info('Creating custom output', { name, slug, type, sourceOutputKey });
        const now = Date.now();
        const id = `custom_${slug}`;
        let sourceSettings;
        const state = get();
        if (sourceOutputKey === 'output1') sourceSettings = state.output1Settings;
        else if (sourceOutputKey === 'output2') sourceSettings = state.output2Settings;
        else if (sourceOutputKey === 'stage') sourceSettings = state.stageSettings;
        else sourceSettings = state.customOutputSettings?.[sourceOutputKey];
        const fallbackSettings = type === 'stage' ? defaultStageSettings : defaultOutput1Settings;
        const clonedSettings = JSON.parse(JSON.stringify(sourceSettings || fallbackSettings));

        set((current) => ({
          customOutputs: [
            ...current.customOutputs.filter((output) => output.id !== id),
            { id, name, slug, type: type === 'stage' ? 'stage' : 'regular', sourceOutputKey, createdAt: now, updatedAt: now },
          ],
          customOutputSettings: {
            ...current.customOutputSettings,
            [id]: clonedSettings,
          },
          customOutputEnabled: {
            ...current.customOutputEnabled,
            [id]: true,
          },
          modeTemplates: {
            ...(current.modeTemplates || {}),
            [id]: { enabled: false, song: null, bible: null },
          },
        }));
        return id;
      },
      renameCustomOutput: (outputKey, name, slug) => set((state) => {
        const newId = `custom_${slug}`;
        const idChanged = newId !== outputKey;
        const next = {
          customOutputs: state.customOutputs.map((output) => (
            output.id === outputKey ? { ...output, id: newId, name, slug, updatedAt: Date.now() } : output
          )),
        };
        if (idChanged) {
          // migrate customOutputSettings / enabled / modeTemplates / _lastApplied
          if (state.customOutputSettings?.[outputKey] !== undefined) {
            next.customOutputSettings = { ...state.customOutputSettings, [newId]: state.customOutputSettings[outputKey] };
            delete next.customOutputSettings[outputKey];
          }
          if (state.customOutputEnabled?.[outputKey] !== undefined) {
            next.customOutputEnabled = { ...state.customOutputEnabled, [newId]: state.customOutputEnabled[outputKey] };
            delete next.customOutputEnabled[outputKey];
          }
          if (state.modeTemplates?.[outputKey] !== undefined) {
            next.modeTemplates = { ...(state.modeTemplates || {}), [newId]: state.modeTemplates[outputKey] };
            delete next.modeTemplates[outputKey];
          } else {
            next.modeTemplates = state.modeTemplates;
          }
          if (state._lastAppliedModeTemplate?.[outputKey] !== undefined) {
            const { [outputKey]: _rm, ...rest } = state._lastAppliedModeTemplate;
            next._lastAppliedModeTemplate = rest;
          }
        }
        return next;
      }),
      deleteCustomOutput: (outputKey) => set((state) => {
        const { [outputKey]: removedSettings, ...customOutputSettings } = state.customOutputSettings;
        const { [outputKey]: removedEnabled, ...customOutputEnabled } = state.customOutputEnabled;
        const { [outputKey]: _removedMode, ...modeTemplates } = state.modeTemplates || {};
        const { [outputKey]: _removedLast, ..._lastAppliedModeTemplate } = state._lastAppliedModeTemplate || {};
        return {
          customOutputs: state.customOutputs.filter((output) => output.id !== outputKey),
          customOutputSettings,
          customOutputEnabled,
          modeTemplates,
          _lastAppliedModeTemplate,
        };
      }),
      updateOutputSettings: (output, newSettings) => {
        log.debug('Output settings updated', { output, settingKeys: Object.keys(newSettings) });
        if (!output || (output !== 'output1' && output !== 'output2' && output !== 'stage' && !output.startsWith('custom_'))) {
          log.warn('updateOutputSettings ignored invalid output key', { output });
          return;
        }
        return set((state) => {
          if (output && output.startsWith('custom_')) {
            return {
              customOutputSettings: {
                ...state.customOutputSettings,
                [output]: {
                  ...(state.customOutputSettings?.[output] || {}),
                  ...newSettings,
                },
              },
            };
          }
          return {
            [`${output}Settings`]: {
              ...state[`${output}Settings`],
              ...newSettings
            }
          };
        });
      },
    }),
    {
      name: 'lyrics-store',
      version: SESSION_SCHEMA_VERSION,
      // Safe bridge (missing-feature #05): same key + same JSON payload shape
      // as the default localStorage engine, with quota/corruption handling
      // that warns instead of throwing into rehydrate.
      storage: createJSONStorage(() => zustandPersistentStorage),
      migrate: (persistedState, version) => {
        if (!persistedState) return persistedState;
        return migratePersistedState(persistedState);
      },
      partialize: (state) => ({
        lyrics: state.lyrics,
        rawLyricsContent: state.rawLyricsContent,
        chordChart: state.chordChart || null,
        selectedLine: state.selectedLine,
        showSelectedLineHighlight: state.showSelectedLineHighlight,
        previewMode: state.previewMode ?? false,
        lyricsFileName: state.lyricsFileName,
        displayLabel: state.displayLabel || state.lyricsFileName || '',
        bibleVersion: state.bibleVersion || '',
        songMetadata: state.songMetadata,
        isOutputOn: state.isOutputOn,
        showState: state.showState || 'LIVE',
        showControlDockExpanded: state.showControlDockExpanded ?? true,
        metronomeSettings: { ...defaultMetronomeSettings(), ...(state.metronomeSettings || {}) },
        tickerQueue: Array.isArray(state.tickerQueue) ? state.tickerQueue : [],
        tickerActiveId: state.tickerActiveId ?? null,
        announcementTargetOutputKey: state.announcementTargetOutputKey || 'all',
        lyricsSections: state.lyricsSections,
        lineToSection: state.lineToSection,
        output1Enabled: state.output1Enabled,
        output2Enabled: state.output2Enabled,
        stageEnabled: state.stageEnabled,
        customOutputs: state.customOutputs,
        customOutputSettings: state.customOutputSettings,
        customOutputEnabled: state.customOutputEnabled,
        darkMode: state.darkMode,
        hasSeenWelcome: state.hasSeenWelcome,
        output1Settings: state.output1Settings,
        output2Settings: state.output2Settings,
        stageSettings: state.stageSettings,
        autoplaySettings: state.autoplaySettings,
        performanceSettings: state.performanceSettings,
        lyricsTimestamps: state.lyricsTimestamps,
        lyricsHistory: Array.isArray(state.lyricsHistory) ? state.lyricsHistory.slice(0, 10) : [],
        hasSeenIntelligentAutoplayInfo: state.hasSeenIntelligentAutoplayInfo,
        sidebarCollapsed: state.sidebarCollapsed,
        settingsCollapsed: state.settingsCollapsed,
        sidebarWidth: state.sidebarWidth,
        headerCompact: state.headerCompact,
        vimMode: state.vimMode,
        autoGroupLines: state.autoGroupLines,
        enableLyricSplitting: state.enableLyricSplitting ?? true,
        hotReloadEnabled: state.hotReloadEnabled ?? true,
        autoTurnOnOutput: state.autoTurnOnOutput,
        outputActions: state.outputActions,
        httpActionButtons: Array.isArray(state.httpActionButtons) ? state.httpActionButtons : [],
        defaultLayout: state.defaultLayout,
        uiScale: state.uiScale,
        fHintEnabled: state.fHintEnabled ?? true,
        contentMode: normalizeContentMode(state.contentMode),
        freeNotesDrafts: Array.isArray(state.freeNotesDrafts) ? state.freeNotesDrafts : [],
        freeNotesEnabled: state.freeNotesEnabled ?? false,
        lyricContentSearchEnabled: state.lyricContentSearchEnabled ?? true,
        schedulerEnabled: state.schedulerEnabled ?? false,
        previewMultiview: normalizePreviewMultiview(state.previewMultiview),
        bibleVerseEditorEnabled: state.bibleVerseEditorEnabled ?? false,
        modeTemplates: state.modeTemplates || {
          output1: { enabled: false, song: null, bible: null, freenote: null },
          output2: { enabled: false, song: null, bible: null, freenote: null },
          stage: { enabled: false, song: null, bible: null, freenote: null },
        },
        _lastAppliedModeTemplate: state._lastAppliedModeTemplate || {},
        session: state.session || createInitialSession({ contentMode: normalizeContentMode(state.contentMode) }),
        _persistVersion: SESSION_SCHEMA_VERSION,
      }),
      onRehydrateStorage: () => (state) => {
        log.info('LyricsStore rehydrated from persistence', { hasState: !!state, version: state?._persistVersion });
        if (state) {
          // versioned migration via sessionModel
          migratePersistedState(state);
          if (state.outputActionEndpoint !== undefined || state.outputOnActionName !== undefined) {
            const oldEndpoint = state.outputActionEndpoint || 'http://localhost:5505/';
            const oldOnAction = state.outputOnActionName || '';
            const oldOffAction = state.outputOffActionName || '';
            state.outputActions = [{ id: crypto.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`, endpoint: oldEndpoint, onAction: oldOnAction, offAction: oldOffAction, payloadFormat: 'action' }];
            delete state.outputActionEndpoint;
            delete state.outputOnActionName;
            delete state.outputOffActionName;
          }
          if (!state.outputActions || !Array.isArray(state.outputActions) || state.outputActions.length === 0) {
            state.outputActions = [{ id: crypto.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`, endpoint: 'http://localhost:5505/', onAction: '', offAction: '', payloadFormat: 'boolean' }];
          }
          state.outputActions = state.outputActions.map((a) => ({
            ...a,
            payloadFormat: a.payloadFormat || 'action',
            enabled: a.enabled !== false,
          }));
          state.output1Settings = {
            ...state.output1Settings,
            autosizerActive: false,
            primaryViewportWidth: null,
            primaryViewportHeight: null,
            allInstances: null,
            instanceCount: 0,
          };
          state.output2Settings = {
            ...state.output2Settings,
            autosizerActive: false,
            primaryViewportWidth: null,
            primaryViewportHeight: null,
            allInstances: null,
            instanceCount: 0,
          };
          state.contentMode = normalizeContentMode(state.contentMode);
          state.freeNotesDrafts = Array.isArray(state.freeNotesDrafts) ? state.freeNotesDrafts : [];
          if (state.freeNotesEnabled === undefined) {
            state.freeNotesEnabled = (Array.isArray(state.freeNotesDrafts) && state.freeNotesDrafts.length > 0);
          }
          state.previewMultiview = normalizePreviewMultiview(state.previewMultiview);
          if (!state.freeNotesEnabled && state.contentMode === 'freenote') {
            state.contentMode = 'song';
            if (state.session) {
              state.session.contentMode = 'song';
              if (state.session.leftPanel?.view === 'freenote') {
                state.session.leftPanel.view = 'songs';
              }
            }
          }
          if (state.fHintEnabled === undefined) state.fHintEnabled = true;
          if (state.schedulerEnabled === undefined) state.schedulerEnabled = false;
          if (state.showSelectedLineHighlight === undefined) state.showSelectedLineHighlight = true;
          if (state.showState === undefined || !['LIVE', 'CLEAR', 'BLACKOUT', 'LOGO'].includes(state.showState)) {
            state.showState = state.isOutputOn === false ? 'BLACKOUT' : 'LIVE';
          }
          if (state.showControlDockExpanded === undefined) state.showControlDockExpanded = true;
          if (!state.metronomeSettings) state.metronomeSettings = defaultMetronomeSettings();
          if (!Array.isArray(state.tickerQueue)) state.tickerQueue = [];
          if (state.tickerActiveId === undefined) state.tickerActiveId = null;
          if (!state.announcementTargetOutputKey) state.announcementTargetOutputKey = 'all';
          if (state.previewMode === undefined) state.previewMode = false;
          state.previewSelectedLine = null;
          if (state.enableLyricSplitting === undefined) state.enableLyricSplitting = true;
          if (state.hotReloadEnabled === undefined) state.hotReloadEnabled = true;
          if (state.autoGroupLines === undefined) state.autoGroupLines = true;
          if (state.bibleVerseEditorEnabled === undefined) state.bibleVerseEditorEnabled = false;
          if (!Array.isArray(state.httpActionButtons)) state.httpActionButtons = [];
          // Buttons saved before dynamic input existed have no `variables` key.
          state.httpActionButtons = state.httpActionButtons.map((b) => (
            b && typeof b === 'object' && !Array.isArray(b.variables) ? { ...b, variables: [] } : b
          ));
          if (!Array.isArray(state.customOutputs)) state.customOutputs = [];
          if (!state.customOutputSettings || typeof state.customOutputSettings !== 'object') state.customOutputSettings = {};
          if (!state.customOutputEnabled || typeof state.customOutputEnabled !== 'object') state.customOutputEnabled = {};
          Object.keys(state.customOutputSettings).forEach((key) => {
            state.customOutputSettings[key] = {
              ...state.customOutputSettings[key],
              autosizerActive: false,
              primaryViewportWidth: null,
              primaryViewportHeight: null,
              allInstances: null,
              instanceCount: 0,
            };
          });
          // modeTemplates migration + legacy global flag
          if (state.modeTemplatesEnabled !== undefined && !state.modeTemplates) {
            const legacyEnabled = !!state.modeTemplatesEnabled;
            state.modeTemplates = {
              output1: { enabled: legacyEnabled, song: null, bible: null, freenote: null },
              output2: { enabled: legacyEnabled, song: null, bible: null, freenote: null },
              stage: { enabled: legacyEnabled, song: null, bible: null, freenote: null },
            };
            delete state.modeTemplatesEnabled;
          }
          if (!state.modeTemplates || typeof state.modeTemplates !== 'object') {
            state.modeTemplates = {
              output1: { enabled: false, song: null, bible: null, freenote: null },
              output2: { enabled: false, song: null, bible: null, freenote: null },
              stage: { enabled: false, song: null, bible: null, freenote: null },
            };
          }
          for (const key of ['output1', 'output2', 'stage']) {
            if (!state.modeTemplates[key] || typeof state.modeTemplates[key] !== 'object') {
              state.modeTemplates[key] = { enabled: false, song: null, bible: null, freenote: null };
            } else {
              state.modeTemplates[key] = {
                enabled: !!state.modeTemplates[key].enabled,
                song: state.modeTemplates[key].song ?? null,
                bible: state.modeTemplates[key].bible ?? null,
                freenote: state.modeTemplates[key].freenote ?? null,
              };
            }
          }
          if (Array.isArray(state.customOutputs)) {
            for (const o of state.customOutputs) {
              const k = o.id || o.key;
              if (k && !state.modeTemplates[k]) {
                state.modeTemplates[k] = { enabled: false, song: null, bible: null, freenote: null };
              }
            }
          }
          // prune orphaned modeTemplates entries
          {
            const validKeys = new Set(['output1', 'output2', 'stage', ...(Array.isArray(state.customOutputs) ? state.customOutputs.map((o) => o.id) : [])]);
            for (const k of Object.keys(state.modeTemplates)) {
              if (!validKeys.has(k)) delete state.modeTemplates[k];
            }
          }
          if (!state._lastAppliedModeTemplate || typeof state._lastAppliedModeTemplate !== 'object') state._lastAppliedModeTemplate = {};
          if (!state.session || typeof state.session !== 'object') state.session = createInitialSession({ contentMode: state.contentMode });
          if (!state.session.contentMode || state.session.contentMode !== state.contentMode) state.session.contentMode = state.contentMode;
          if (!state.session.leftPanel) state.session.leftPanel = { open: true, view: state.contentMode === 'bible' ? 'bible' : 'songs' };
          else if (state.session.leftPanel.view !== (state.contentMode === 'bible' ? 'bible' : 'songs')) {
            state.session.leftPanel = { ...state.session.leftPanel, view: state.contentMode === 'bible' ? 'bible' : 'songs' };
          }
          if (state.displayLabel === undefined) state.displayLabel = state.lyricsFileName || '';
          state._persistVersion = SESSION_SCHEMA_VERSION;
        }
      },
    }
  )
);

log.info('LyricsStore initialized');

export default useLyricsStore;
