import { useCallback, useRef } from 'react';
import useLyricsStore from '../context/LyricsStore';
import useBibleStore from '../context/BibleStore';
import { createLogger, logDebug, logError, logWarn } from '../utils/logger';

const log = createLogger('SocketEvents');
import { detectArtistFromFilename } from '../utils/artistDetection';
import { deriveSectionsFromProcessedLines } from '../../shared/lyricsParsing.js';
import { mergeCustomOutputRegistry } from '../utils/outputs';

const useSocketEvents = (role) => {
  const {
    setLyrics,
    setLyricsTimestamps,
    selectLine,
    updateOutputSettings,
    setSetlistFiles,
    setIsDesktopApp,
    setLyricsFileName,
    setRawLyricsContent,
    setLyricsSections,
    setLineToSection,
    setChordChart,
  } = useLyricsStore();

  const setlistNameRef = useRef(new Map());

  const setupApplicationEventHandlers = useCallback((socket, clientType, isDesktopApp) => {
    const applySections = (sections, lineToSection, fallbackLyrics) => {
      let targetSections = Array.isArray(sections) ? sections : null;
      let targetLineToSection = (lineToSection && typeof lineToSection === 'object') ? lineToSection : null;

      if (!targetSections && Array.isArray(fallbackLyrics)) {
        const derived = deriveSectionsFromProcessedLines(fallbackLyrics);
        targetSections = derived.sections;
        targetLineToSection = derived.lineToSection;
      }

      setLyricsSections(targetSections || []);
      setLineToSection(targetLineToSection || {});
    };

    const applyCustomOutputRegistry = (incomingCustomOutputs, incomingCustomOutputSettings, incomingCustomOutputEnabled) => {
      const local = useLyricsStore.getState();
      const { merged, state } = mergeCustomOutputRegistry(
        { customOutputs: local.customOutputs, customOutputSettings: local.customOutputSettings, customOutputEnabled: local.customOutputEnabled },
        { customOutputs: incomingCustomOutputs, customOutputSettings: incomingCustomOutputSettings, customOutputEnabled: incomingCustomOutputEnabled }
      );

      if (!merged) {
        logDebug('Ignoring empty output registry from server; preserving local custom outputs');
        return;
      }

      useLyricsStore.setState(state);
    };

    socket.on('currentState', (state) => {
      logDebug('Received enhanced current state:', state);
      if (window.dispatchEvent) {
        window.dispatchEvent(new CustomEvent('sync-completed'));
      }

      if (state.lyrics && state.lyrics.length > 0) {
        setLyrics(state.lyrics);
        // Desktop and Stage state include the chart; absence means lyric-only
        // and clears any stale chart.
        try {
          setChordChart(state.chords && typeof state.chords === 'object' ? state.chords : null);
        } catch { /* ignore */ }

        if (Array.isArray(state.lyricsTimestamps)) {
          setLyricsTimestamps(state.lyricsTimestamps);
        } else {
          setLyricsTimestamps([]);
        }
        if (state.lyricsFileName) {
          // Label-only: never decides mode
          const lab = useLyricsStore.getState().setDisplayLabel || setLyricsFileName;
          try { lab(state.lyricsFileName); } catch { setLyricsFileName(state.lyricsFileName); }
        }
        // Typed content mode sync — only explicit commands change mode
        if (state.contentMode) {
          const m = String(state.contentMode) === 'bible' ? 'bible' : 'song';
          useLyricsStore.getState().selectMode?.(m);
          if (state.bibleVersion !== undefined) {
            useLyricsStore.getState().setBibleVersion?.(state.bibleVersion || '');
            if (m === 'bible' && state.bibleVersion) useLyricsStore.getState().setDisplayLabel?.(state.lyricsFileName || '');
          }
        } else if (state.bibleVersion) {
          useLyricsStore.getState().selectMode?.('bible');
        }
      } else if (state.contentMode) {
        const m = String(state.contentMode) === 'bible' ? 'bible' : 'song';
        useLyricsStore.getState().selectMode?.(m);
      }

      // Mode templates from server — source of truth, but preserve local if server empty (migration)
      const serverHasTemplates = state.modeTemplates && Object.keys(state.modeTemplates).length > 0 && Object.values(state.modeTemplates).some((v) => v?.enabled || v?.song || v?.bible);
      const localBefore = useLyricsStore.getState().modeTemplates;
      const localHasData = localBefore && Object.values(localBefore).some((v) => v?.enabled || v?.song || v?.bible);
      if (!serverHasTemplates && localHasData && socket.connected) {
        try { socket.emit('setModeTemplates', { modeTemplates: localBefore }); logDebug('Migrated local modeTemplates to server', localBefore); } catch {}
        // keep local, do not overwrite with empty server
      } else if (state.modeTemplates && typeof state.modeTemplates === 'object') {
        useLyricsStore.getState().setModeTemplatesFromServer?.(state.modeTemplates);
      }

      if (state.selectedLine === null || (typeof state.selectedLine === 'number' && state.selectedLine >= 0)) {
        selectLine(state.selectedLine);
      }

      if (state.output1Settings) {
        const { autosizerActive, primaryViewportWidth, primaryViewportHeight, allInstances, instanceCount, ...styleSettings } = state.output1Settings;
        updateOutputSettings('output1', styleSettings);
      }
      if (state.output2Settings) {
        const { autosizerActive, primaryViewportWidth, primaryViewportHeight, allInstances, instanceCount, ...styleSettings } = state.output2Settings;
        updateOutputSettings('output2', styleSettings);
      }
      if (state.streamSettings) {
        const { autosizerActive, primaryViewportWidth, primaryViewportHeight, allInstances, instanceCount, ...styleSettings } = state.streamSettings;
        updateOutputSettings('stream', styleSettings);
      }
      if (state.stageSettings && role === 'stage') {
        updateOutputSettings('stage', state.stageSettings);
      }
      if (state.setlistFiles) setSetlistFiles(state.setlistFiles);
      if (typeof state.isDesktopClient === 'boolean') setIsDesktopApp(state.isDesktopClient);
      if (typeof state.showState === 'string') {
        useLyricsStore.getState().setShowState?.(state.showState);
      } else if (typeof state.isOutputOn === 'boolean' && !isDesktopApp) {
        useLyricsStore.getState().setIsOutputOn(state.isOutputOn);
      }
      if (state.ticker && (Array.isArray(state.ticker.queue) || state.ticker.activeId !== undefined)) {
        useLyricsStore.getState().setTickerState?.(state.ticker.queue || [], state.ticker.activeId ?? null);
      }

      if (typeof state.output1Enabled === 'boolean') {
        useLyricsStore.getState().setOutput1Enabled(state.output1Enabled);
      }
      if (typeof state.output2Enabled === 'boolean') {
        useLyricsStore.getState().setOutput2Enabled(state.output2Enabled);
      }
      if (typeof state.streamEnabled === 'boolean') {
        useLyricsStore.getState().setStreamEnabled(state.streamEnabled);
      }
      if (typeof state.stageEnabled === 'boolean') {
        useLyricsStore.getState().setStageEnabled(state.stageEnabled);
      }
      if (Array.isArray(state.customOutputs)) {
        applyCustomOutputRegistry(state.customOutputs, state.customOutputSettings, state.customOutputEnabled);
      }

      applySections(state.lyricsSections || state.sections, state.lineToSection, state.lyrics);

      if (role === 'stage') {
        if (state.stageTimerState) {
          window.dispatchEvent(new CustomEvent('stage-timer-update', {
            detail: state.stageTimerState,
          }));
        }
        if (state.stageMessages) {
          window.dispatchEvent(new CustomEvent('stage-messages-update', {
            detail: state.stageMessages,
          }));
        }
      }

      if (state.schedule && typeof state.schedule === 'object') {
        window.dispatchEvent(new CustomEvent('schedule-state', {
          detail: state.schedule,
        }));
      }
    });

    socket.on('modeTemplatesUpdate', ({ modeTemplates }) => {
      logDebug('Received modeTemplatesUpdate', modeTemplates);
      if (modeTemplates && typeof modeTemplates === 'object') {
        useLyricsStore.getState().setModeTemplatesFromServer?.(modeTemplates);
      }
    });

    socket.on('modeTemplateApplied', ({ mode, outputsApplied }) => {
      logDebug('Received modeTemplateApplied', mode, outputsApplied);
      window.dispatchEvent(new CustomEvent('mode-template-applied', { detail: { mode, outputsApplied } }));
    });

    socket.on('contentModeUpdate', ({ mode, bibleVersion, fileName }) => {
      logDebug('Received contentModeUpdate', mode, bibleVersion);
      const m = mode === 'bible' ? 'bible' : 'song';
      useLyricsStore.getState().selectMode?.(m);
      // Label/mode signal only — never fabricate lyrics here. The verse body
      // arrives via bibleVerseLoaded/lyricsLoad; overwriting lyrics with an
      // empty verse left outputs showing the reference with no verse text.
      if (typeof bibleVersion === 'string') {
        if (m === 'bible') {
          if (bibleVersion) useLyricsStore.getState().setBibleVersion?.(bibleVersion);
        } else useLyricsStore.getState().setBibleVersion?.('');
      }
      if (fileName) {
        const lab = useLyricsStore.getState().setDisplayLabel || setLyricsFileName;
        try { lab(fileName); } catch {}
      }
    });

    socket.on('lineUpdate', ({ index }) => {
      logDebug('Received line update:', index);
      selectLine(index);
    });

    socket.on('lyricsLoad', (payload) => {
      const lyrics = Array.isArray(payload) ? payload : Array.isArray(payload?.lyrics) ? payload.lyrics : [];
      const sections = Array.isArray(payload?.sections) ? payload.sections : null;
      const lineToSection = payload?.lineToSection;
      // Accept legacy chord envelopes while the server now routes chart data
      // through the Stage-only chordChartLoaded event.
      const chords = payload && typeof payload === 'object' && !Array.isArray(payload) && payload.chords && typeof payload.chords === 'object'
        ? payload.chords
        : null;

      logDebug('Received lyrics load:', lyrics.length, 'lines', chords ? 'with legacy chord chart' : 'lyric-only');
      setLyrics(lyrics);
      try {
        setChordChart(chords);
      } catch { /* ignore */ }
      setLyricsTimestamps([]);
      selectLine(lyrics.length > 0 ? 0 : null);
      applySections(sections, lineToSection, lyrics);
    });

    socket.on('lyricsTimestampsUpdate', (timestamps) => {
      logDebug('Received lyrics timestamps update:', timestamps?.length, 'timestamps');
      setLyricsTimestamps(timestamps || []);
    });

    socket.on('lyricsSectionsUpdate', ({ sections, lineToSection }) => {
      logDebug('Received lyrics sections update');
      applySections(sections, lineToSection);
    });

    socket.on('outputToggle', (state) => {
      logDebug('Received output toggle:', state);
      useLyricsStore.getState().setIsOutputOn(state);
    });

    socket.on('showStateUpdate', (payload) => {
      const next = payload && typeof payload === 'object' ? payload.state : payload;
      logDebug('Received show state update:', next);
      useLyricsStore.getState().setShowState?.(next);
    });

    socket.on('tickerUpdate', (payload) => {
      logDebug('Received ticker update:', payload?.queue?.length || 0);
      const queue = Array.isArray(payload?.queue) ? payload.queue : [];
      const activeId = payload?.activeId ?? null;
      useLyricsStore.getState().setTickerState?.(queue, activeId);
    });

    socket.on('tickerError', (error) => {
      logError('Ticker error:', error);
      window.dispatchEvent(new CustomEvent('ticker-error', {
        detail: { message: error },
      }));
    });

    socket.on('outputRegistryUpdate', ({ customOutputs, customOutputSettings, customOutputEnabled } = {}) => {
      logDebug('Received output registry update:', customOutputs?.length || 0);
      applyCustomOutputRegistry(customOutputs, customOutputSettings, customOutputEnabled);
    });

    socket.on('individualOutputToggle', ({ output, enabled }) => {
      logDebug('Received individual output toggle:', output, enabled);
      const store = useLyricsStore.getState();
      if (output === 'output1') {
        store.setOutput1Enabled(enabled);
      } else if (output === 'output2') {
        store.setOutput2Enabled(enabled);
      } else if (output === 'stream') {
        store.setStreamEnabled(enabled);
      } else if (output === 'stage') {
        store.setStageEnabled(enabled);
      } else if (output && output.startsWith('custom_')) {
        store.setCustomOutputEnabled(output, enabled);
      }
    });

    const shouldHandleOutputMetrics = role === 'control' || role === 'output' || role === 'output1' || role === 'output2' || role === 'stream' || role === 'stage';

    if (shouldHandleOutputMetrics) {
      socket.on('styleUpdate', ({ output, settings }) => {
        logDebug('Received style update for', output, ':', settings);

        if (output === 'stage' && role === 'stage') {

          updateOutputSettings(output, settings);
        } else if (output !== 'stage') {

          const { autosizerActive, primaryViewportWidth, primaryViewportHeight, allInstances, instanceCount, ...styleSettings } = settings;
          updateOutputSettings(output, styleSettings);
        }
      });

      socket.on('outputMetrics', ({ output, metrics, allInstances, instanceCount }) => {
        try {
          const updates = {
            autosizerActive: metrics?.autosizerActive ?? false,
            primaryViewportWidth: metrics?.viewportWidth ?? null,
            primaryViewportHeight: metrics?.viewportHeight ?? null,
            allInstances: allInstances || null,
            instanceCount: instanceCount || 1,
          };

          if (output === 'output1' || output === 'output2' || output === 'stream' || output?.startsWith('custom_')) {
            updateOutputSettings(output, updates);

            if (instanceCount > 1) {
              logDebug(`${output}: ${instanceCount} instances detected, using primary (${metrics.viewportWidth}x${metrics.viewportHeight})`);
            }
          }
        } catch (e) {
          logWarn('Failed to apply output metrics:', e?.message || e);
        }
      });
    }

    if (role === 'stage') {
      socket.on('stageTimerUpdate', (timerData) => {
        logDebug('Received stage timer update:', timerData);
        window.dispatchEvent(new CustomEvent('stage-timer-update', {
          detail: timerData,
        }));
      });

      socket.on('stageMessagesUpdate', (messages) => {
        logDebug('Received stage messages update:', messages);
        window.dispatchEvent(new CustomEvent('stage-messages-update', {
          detail: messages,
        }));
      });

      socket.on('stageUpcomingSongUpdate', (data) => {
        logDebug('Received stage upcoming song update:', data);
        window.dispatchEvent(new CustomEvent('stage-upcoming-song-update', {
          detail: data,
        }));
      });
    }

    // Service run-sheet clock (feature #01): authoritative snapshots ride
    // as window events so Time.jsx and SchedulePanel stay in sync without
    // duplicating socket plumbing.
    socket.on('scheduleState', (snapshot) => {
      logDebug('Received schedule state:', snapshot?.status);
      window.dispatchEvent(new CustomEvent('schedule-state', { detail: snapshot }));
    });

    socket.on('scheduleTick', (snapshot) => {
      window.dispatchEvent(new CustomEvent('schedule-tick', { detail: snapshot }));
    });

    socket.on('scheduleError', (message) => {
      logWarn('Schedule error:', message);
      window.dispatchEvent(new CustomEvent('schedule-error', { detail: { message } }));
    });

    socket.on('setlistUpdate', (files) => {
      try {
        const map = new Map();
        (files || []).forEach((f) => {
          if (f && f.id) map.set(f.id, f.displayName || '');
        });
        const prev = setlistNameRef.current || new Map();
        prev.forEach((name, id) => {
          if (!map.has(id)) map.set(id, name);
        });
        setlistNameRef.current = map;
      } catch { }
      setSetlistFiles(files);
    });

    socket.on('setlistLoadSuccess', ({ fileId, fileName, originalName, fileType, linesCount, rawContent, loadedBy, origin, draftId, metadata: savedMetadata }) => {
      logDebug(`Setlist file loaded: ${fileName} (${linesCount} lines) by ${loadedBy}`);
      const st = useLyricsStore.getState();
      if (savedMetadata?.type === 'bible') {
        st.selectMode?.('bible');
        st.setBibleVersion?.(savedMetadata?.bibleId || savedMetadata?.bible || 'Bible');
        st.setDisplayLabel?.(fileName);
      } else {
        // atomic song load via setlist is content, but mode is song
        st.selectMode?.('song');
        st.setBibleVersion?.('');
        // keep label-only
        (st.setDisplayLabel || setLyricsFileName)(fileName);
      }
      selectLine(null);
      if (rawContent) {
        setRawLyricsContent(rawContent);
      }
      if (savedMetadata?.sections) {
        setLyricsSections(savedMetadata.sections);
        setLineToSection(savedMetadata.lineToSection || {});
      } else if (linesCount && useLyricsStore.getState().lyrics?.length) {
        const derived = deriveSectionsFromProcessedLines(useLyricsStore.getState().lyrics);
        setLyricsSections(derived.sections || []);
        setLineToSection(derived.lineToSection || {});
      }

      let computedOrigin = 'Setlist (.txt)';
      if (fileType === 'lrc') {
        computedOrigin = 'Setlist (.lrc)';
      }
      if (fileType === 'draft' || origin === 'draft') {
        computedOrigin = 'Secondary Controller Draft';
      }

      let finalMetadata;
      if (savedMetadata && (savedMetadata.title || savedMetadata.artists?.length > 0)) {

        finalMetadata = {
          ...savedMetadata,
          origin: computedOrigin,
          lyricLines: linesCount,
          draftId: draftId || null
        };
      } else {
        const detected = detectArtistFromFilename(fileName);
        finalMetadata = {
          title: detected.title || fileName,
          artists: detected.artist ? [detected.artist] : [],
          album: null,
          year: null,
          lyricLines: linesCount,
          origin: computedOrigin,
          filePath: savedMetadata?.filePath || null,
          draftId: draftId || null
        };
      }
      useLyricsStore.getState().setSongMetadata(finalMetadata);

      try {
        window.dispatchEvent(new CustomEvent('setlist-load-success', {
          detail: {
            fileId,
            fileName,
            originalName,
            fileType,
            linesCount,
            loadedBy,
            origin: computedOrigin,
            draftId: draftId || null,
            metadata: savedMetadata || null,
          },
        }));
      } catch { }
    });

    socket.on('setlistAddSuccess', ({ addedCount, totalCount }) => {
      logDebug(`Added ${addedCount} files to setlist. Total: ${totalCount}`);
      window.dispatchEvent(new CustomEvent('setlist-add-success', {
        detail: { addedCount, totalCount },
      }));
    });

    socket.on('setlistRemoveSuccess', (fileId) => {
      logDebug(`Removed file ${fileId} from setlist`);
      try {
        const name = setlistNameRef.current.get(fileId) || '';
        window.dispatchEvent(new CustomEvent('setlist-remove-success', {
          detail: { fileId, name },
        }));
      } catch { }
      try {
        setlistNameRef.current.delete(fileId);
      } catch { }
    });

    socket.on('setlistReorderSuccess', ({ totalCount, orderedIds }) => {
      logDebug(`Setlist reordered: ${orderedIds?.length || 0} items`);
      window.dispatchEvent(new CustomEvent('setlist-reorder-success', {
        detail: { totalCount, orderedIds },
      }));
    });

    socket.on('setlistError', (error) => {
      logError('Setlist error:', error);
      window.dispatchEvent(new CustomEvent('setlist-error', {
        detail: { message: error },
      }));
    });

    socket.on('setlistClearSuccess', () => {
      logDebug('Setlist cleared successfully');
      try {
        setlistNameRef.current.clear();
      } catch { }
      window.dispatchEvent(new CustomEvent('setlist-clear-success'));
    });

    socket.on('fileNameUpdate', (fileName) => {
      logDebug('Received filename update (label-only):', fileName);
      const lab = useLyricsStore.getState().setDisplayLabel || setLyricsFileName;
      try { lab(fileName || ''); } catch { setLyricsFileName(fileName || ''); }
    });
    // Typed content commands — only these may change mode
    socket.on('contentLoaded', (payload) => {
      logDebug('Received contentLoaded (typed):', payload);
      if (payload?.kind === 'song') {
        // content already loaded via lyricsLoad; just ensure mode
        useLyricsStore.getState().selectMode?.('song');
      }
    });
    socket.on('bibleVerseLoaded', (payload) => {
      logDebug('Received bibleVerseLoaded (typed):', payload);
      if (payload?.reference) {
        const st = useLyricsStore.getState();
        // Label and mode only — the verse body arrives via lyricsLoad (and
        // output pages apply slides directly). Never fabricate lyrics here.
        st.selectMode?.('bible');
        st.setDisplayLabel?.(payload.reference);
        if (payload?.bible) st.setBibleVersion?.(payload.bible);
      }
    });
    socket.on('freeNoteLoaded', (payload) => {
      logDebug('Received freeNoteLoaded (typed):', payload);
      const st = useLyricsStore.getState();
      st.selectMode?.('freenote');
      if (payload?.title) st.setDisplayLabel?.(payload.title);
    });
    socket.on('displayLabelUpdated', (label) => {
      logDebug('Received displayLabelUpdated:', label);
      const lab = useLyricsStore.getState().setDisplayLabel || setLyricsFileName;
      try { lab(label || ''); } catch {}
    });

    socket.on('draftSubmitted', ({ success, title }) => {
      logDebug(`Draft submitted successfully: ${title}`);
      window.dispatchEvent(new CustomEvent('draft-submitted', {
        detail: { success, title },
      }));
    });

    socket.on('draftError', (error) => {
      logError('Draft submission error:', error);
      window.dispatchEvent(new CustomEvent('draft-error', {
        detail: { message: error },
      }));
    });

    socket.on('lyricsDraftReceived', (payload) => {
      logDebug('Received lyrics draft for approval:', payload.title);
      window.dispatchEvent(new CustomEvent('lyrics-draft-received', {
        detail: payload,
      }));
    });

    socket.on('draftApproved', ({ success, title, draftId }) => {
      logDebug(`Draft approved: ${title}`);
      window.dispatchEvent(new CustomEvent('draft-approved', {
        detail: { success, title, draftId },
      }));
    });

    socket.on('draftRejected', ({ success, reason, draftId, title }) => {
      logDebug('Draft rejected:', reason);
      window.dispatchEvent(new CustomEvent('draft-rejected', {
        detail: { success, reason, draftId, title },
      }));
    });

    socket.on('clientDisconnected', ({ clientType: disconnectedType, deviceId, reason }) => {
      logDebug(`Client disconnected: ${disconnectedType} (${deviceId}) - ${reason}`);
    });

    socket.on('heartbeat_ack', ({ timestamp }) => {
      logDebug('Heartbeat acknowledged, server time:', new Date(timestamp));
    });

    socket.on('autoplayStateUpdate', ({ isActive, clientType }) => {
      logDebug('Received autoplay state update:', { isActive, clientType });
      window.dispatchEvent(new CustomEvent('autoplay-state-update', {
        detail: { isActive, clientType },
      }));
    });

    socket.on('periodicStateSync', (state) => {
      logDebug('Received periodic state sync');
      if (window.dispatchEvent) {
        window.dispatchEvent(new CustomEvent('sync-completed'));
      }

      if (Array.isArray(state.setlistSummary)) {
        const localSetlist = useLyricsStore.getState().setlistFiles || [];
        const remoteIds = new Set(state.setlistSummary.map((f) => f.id));
        const localIds = new Set(localSetlist.map((f) => f.id));
        const drifted = remoteIds.size !== localIds.size
          || [...remoteIds].some((id) => !localIds.has(id))
          || [...localIds].some((id) => !remoteIds.has(id));
        if (drifted) {
          socket.emit('requestSetlist');
        }
      }

      if (state.lyrics && state.lyrics.length > 0) {
        const currentLyrics = useLyricsStore.getState().lyrics;
        if (currentLyrics.length === 0) {
          setLyrics(state.lyrics);
        }

        if (Array.isArray(state.lyricsTimestamps)) {
          setLyricsTimestamps(state.lyricsTimestamps);
        } else {
          setLyricsTimestamps([]);
        }
        // label-only; mode only via typed field
        if (state.bibleVersion || state.contentMode === 'bible') {
          useLyricsStore.getState().selectMode?.('bible');
        }
      }
      if (state.modeTemplates && typeof state.modeTemplates === 'object') {
        useLyricsStore.getState().setModeTemplatesFromServer?.(state.modeTemplates);
      }
      if (state.contentMode) {
        const m = String(state.contentMode) === 'bible' ? 'bible' : String(state.contentMode) === 'freenote' ? 'freenote' : 'song';
        useLyricsStore.getState().selectMode?.(m);
      }
      applySections(state.lyricsSections || state.sections, state.lineToSection, state.lyrics);

      if (state.selectedLine === null) {
        selectLine(null);
      } else if (typeof state.selectedLine === 'number' && state.selectedLine >= 0) {
        const currentLyrics = useLyricsStore.getState().lyrics;
        if (state.selectedLine < currentLyrics.length) {
          selectLine(state.selectedLine);
        }
      }

      if (state.output1Settings) {
        const { autosizerActive, primaryViewportWidth, primaryViewportHeight, allInstances, instanceCount, ...styleSettings } = state.output1Settings;
        updateOutputSettings('output1', styleSettings);
      }
      if (state.output2Settings) {
        const { autosizerActive, primaryViewportWidth, primaryViewportHeight, allInstances, instanceCount, ...styleSettings } = state.output2Settings;
        updateOutputSettings('output2', styleSettings);
      }
      if (state.streamSettings) {
        const { autosizerActive, primaryViewportWidth, primaryViewportHeight, allInstances, instanceCount, ...styleSettings } = state.streamSettings;
        updateOutputSettings('stream', styleSettings);
      }
      if (state.stageSettings && role === 'stage') {
        updateOutputSettings('stage', state.stageSettings);
      }
      if (Array.isArray(state.setlistFiles)) setSetlistFiles(state.setlistFiles);
      if (typeof state.isDesktopClient === 'boolean') setIsDesktopApp(state.isDesktopClient);
      if (typeof state.showState === 'string') {
        useLyricsStore.getState().setShowState?.(state.showState);
      }
      if (state.ticker && (Array.isArray(state.ticker.queue) || state.ticker.activeId !== undefined)) {
        useLyricsStore.getState().setTickerState?.(state.ticker.queue || [], state.ticker.activeId ?? null);
      }

      if (typeof state.output1Enabled === 'boolean') {
        useLyricsStore.getState().setOutput1Enabled(state.output1Enabled);
      }
      if (typeof state.output2Enabled === 'boolean') {
        useLyricsStore.getState().setOutput2Enabled(state.output2Enabled);
      }
      if (typeof state.streamEnabled === 'boolean') {
        useLyricsStore.getState().setStreamEnabled(state.streamEnabled);
      }
      if (typeof state.stageEnabled === 'boolean') {
        useLyricsStore.getState().setStageEnabled(state.stageEnabled);
      }
      if (Array.isArray(state.customOutputs)) {
        applyCustomOutputRegistry(state.customOutputs, state.customOutputSettings, state.customOutputEnabled);
      }
    });
  }, [role, setLyrics, setLyricsSections, setLineToSection, setLyricsTimestamps, selectLine, updateOutputSettings, setSetlistFiles, setIsDesktopApp, setLyricsFileName, setRawLyricsContent]);

  const registerAuthenticatedHandlers = useCallback(({
    socket,
    clientType,
    isDesktopApp,
    reconnectTimeoutRef,
    startHeartbeat,
    stopHeartbeat,
    setConnectionStatus,
    requestReconnect,
    handleAuthError,
    purpose,
  }) => {
    setIsDesktopApp(isDesktopApp);

    socket.on('connect', () => {
      logDebug('Authenticated socket connected:', socket.id);
      setConnectionStatus('connected');

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      startHeartbeat();
      socket.emit('clientConnect', { type: clientType });

      // Feature #03: declare which output surface this socket renders so the
      // server heartbeat registry can track built-in + custom outputs.
      if (purpose) {
        try {
          socket.emit('outputPresenceRegister', { purpose });
        } catch {
          logDebug('Failed to emit outputPresenceRegister');
        }
      }

      setTimeout(() => {
        socket.emit('requestCurrentState');
      }, 500);

      const shouldSyncOutputSettings = role !== 'output' && role !== 'output1' && role !== 'output2' && role !== 'stream' && role !== 'stage';

      if (shouldSyncOutputSettings && clientType === 'desktop') {
        const syncOutputSettingsFromStore = () => {
          try {
            const { output1Settings, output2Settings, streamSettings, stageSettings, customOutputs, customOutputSettings, customOutputEnabled } = useLyricsStore.getState();

            if (output1Settings) {
              socket.emit('styleUpdate', { output: 'output1', settings: output1Settings });
            }

            if (output2Settings) {
              socket.emit('styleUpdate', { output: 'output2', settings: output2Settings });
            }

            if (streamSettings) {
              socket.emit('styleUpdate', { output: 'stream', settings: streamSettings });
            }

            if (stageSettings) {
              socket.emit('styleUpdate', { output: 'stage', settings: stageSettings });
            }

            if (Array.isArray(customOutputs) && customOutputs.length > 0) {
              socket.emit('outputRegistryUpdate', { customOutputs, customOutputSettings, customOutputEnabled });
            }

            logDebug('Synced output settings to server after reconnect');
          } catch (error) {
            logError('Failed to sync output settings after reconnect:', error);
          }
        };

        const persistApi = useLyricsStore.persist;
        if (persistApi?.hasHydrated?.()) {
          syncOutputSettingsFromStore();
        } else if (persistApi?.onFinishHydration) {
          persistApi.onFinishHydration(() => {
            syncOutputSettingsFromStore();
          });
        } else {
          syncOutputSettingsFromStore();
        }
      }

      if (isDesktopApp) {
        setTimeout(() => {
          const currentState = useLyricsStore.getState();
          if (currentState.lyrics.length > 0) {
            const isBible = currentState.contentMode === 'bible' || !!currentState.bibleVersion;
            // Always sync lyrics for displays
            socket.emit('lyricsLoad', currentState.chordChart
              ? { lyrics: currentState.lyrics, chords: currentState.chordChart }
              : currentState.lyrics);
            if (isBible && currentState.lyricsFileName) {
              // Ensure server knows it's bible so it applies bible template.
              // Re-attach the linked-translation companion for late joiners.
              // Hidden parallel display must not resurrect on a desktop reconnect, so the
              // stored companion is only re-attached while the operator has it shown.
              const parallelHidden = useBibleStore.getState().parallelHidden;
              const parallelSecondary = parallelHidden ? null : (currentState.session?.activeContent?.secondaryBible || null);
              socket.emit('bibleVerseLoaded', { reference: currentState.lyricsFileName, bible: currentState.bibleVersion || '', slideIndex: currentState.selectedLine ?? 0, slides: currentState.lyrics.map((l) => String(l).split('\n\n')[0]), ...(parallelSecondary ? { secondary: parallelSecondary } : {}) });
              socket.emit('contentModeUpdate', { mode: 'bible', bibleVersion: currentState.bibleVersion || '', fileName: currentState.lyricsFileName });
            } else if (currentState.lyricsFileName) {
              socket.emit('contentModeUpdate', { mode: 'song', bibleVersion: '', fileName: currentState.lyricsFileName });
            }
            if (Array.isArray(currentState.lyricsTimestamps) && currentState.lyricsTimestamps.length > 0) {
              socket.emit('lyricsTimestampsUpdate', currentState.lyricsTimestamps);
            }
            if (currentState.lyricsFileName) {
              socket.emit('fileNameUpdate', currentState.lyricsFileName);
            }
            socket.emit('lineUpdate', { index: currentState.selectedLine });
            socket.emit('outputToggle', currentState.isOutputOn);
            if (currentState.showState) {
              socket.emit('showStateUpdate', { state: currentState.showState });
            }
            if (Array.isArray(currentState.tickerQueue) && currentState.tickerQueue.length > 0) {
              // Ticker queue itself syncs via currentState on join; announce
              // the active overlay explicitly so outputs converge on reconnect.
              socket.emit('tickerShow', { id: currentState.tickerActiveId ?? null });
            }

            if (typeof currentState.output1Enabled === 'boolean') {
              socket.emit('individualOutputToggle', { output: 'output1', enabled: currentState.output1Enabled });
            }
            if (typeof currentState.output2Enabled === 'boolean') {
              socket.emit('individualOutputToggle', { output: 'output2', enabled: currentState.output2Enabled });
            }
            if (typeof currentState.streamEnabled === 'boolean') {
              socket.emit('individualOutputToggle', { output: 'stream', enabled: currentState.streamEnabled });
            }
            if (typeof currentState.stageEnabled === 'boolean') {
              socket.emit('individualOutputToggle', { output: 'stage', enabled: currentState.stageEnabled });
            }
          }
        }, 1000);
      }
    });

    socket.on('disconnect', (reason) => {
      logDebug('Socket disconnected:', reason);
      setConnectionStatus('disconnected');
      stopHeartbeat();

      // Only skip reconnection for intentional client-side disconnects.
      // 'transport close' (network drops, wifi loss) MUST trigger reconnection.
      if (reason !== 'io client disconnect') {
        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = setTimeout(() => {
          logDebug('Auto-reconnecting...');
          requestReconnect();
        }, 2000);
      }
    });

    socket.on('connect_error', (error) => {
      logError('Socket connection error:', error);
      setConnectionStatus('error');

      if (error.message?.includes('Authentication') || error.message?.includes('token')) {
        logDebug('Authentication error, clearing token and retrying...');
        handleAuthError(error.message, false);
      }

      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = setTimeout(() => {
        requestReconnect();
      }, 3000);
    });

    socket.on('authError', (error) => {
      logError('Authentication error:', error);
      handleAuthError(error, true);
    });

    socket.on('permissionError', (error) => {
      logWarn('Permission error:', error);
      window.dispatchEvent(new CustomEvent('permission-error', {
        detail: { message: error },
      }));
    });

    setupApplicationEventHandlers(socket, clientType, isDesktopApp);
  }, [setIsDesktopApp, setupApplicationEventHandlers]);

  return {
    setupApplicationEventHandlers,
    registerAuthenticatedHandlers,
  };
};

export default useSocketEvents;
