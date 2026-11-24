import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLyricsState, useOutputState, useOutputSettingsByKey, usePerformanceSettings, useFreeNotesEnabled, useShowControlState, useTickerState } from '../hooks/useStoreSelectors';
import useLyricsStore from '../context/LyricsStore';
import TickerOverlay from '../components/outputs/TickerOverlay';
import { resolveTickerForOutput } from '../../shared/showControl.js';
import useSocket from '../hooks/useSocket';
import { getLineOutputText } from '../utils/parseLyrics';
import { sanitizeOutputText } from '../utils/sanitizeOutput.js';
import { formatBibleReference } from '../utils/bibleReference';
import { logDebug, logError } from '../utils/logger';
import { createLogger } from '../utils/logger.js';
import { resolveBackendUrl } from '../utils/network';

const logger = createLogger('RegularOutput');
import { calculateOptimalFontSize } from '../utils/maxLinesCalculator';
import { ensureFontLoaded } from '../utils/fontLoader';
import MarkdownNoteRenderer from '../components/FreeNote/MarkdownNoteRenderer';
import CanvasMotionBackground from '../components/outputs/CanvasMotionBackground';
import { isMarkdownContent, calculateNoteBaseFontSize } from '../utils/freeNote';
import ParallelBibleDisplay from '../components/Bible/ParallelBibleDisplay';
import { sanitizeParallelPayload, normalizeParallelLayout } from '../utils/bibleParallel.js';
import {
  normalizeStreamBandHeightPercent,
  normalizeStreamBandBackdrop,
  getStreamBandBackdropStyle,
  getStreamBandReferenceReserve,
  getStreamBandReferenceFontSize,
} from '../utils/streamBand.js';

const RegularOutput = ({ outputKey = 'output1', displayName = 'Output' }) => {
  logger.info('RegularOutput mounted', { outputKey, displayName });
  const { socket, isConnected, connectionStatus, isAuthenticated, emitStyleUpdate, emitOutputMetrics } = useSocket(outputKey, 'output1');
  const { lyrics, selectedLine, lyricsFileName, bibleVersion, setLyrics, setLyricsFileName, selectLine } = useLyricsState();
  const { isOutputOn, setIsOutputOn } = useOutputState();
  const { showState } = useShowControlState();
  const { tickerQueue, tickerActiveId } = useTickerState();
  const { settings: outputSettings, updateSettings: updateOutputSettings, enabled: outputEnabled } = useOutputSettingsByKey(outputKey);
  const { settings: performanceSettings } = usePerformanceSettings();

  useEffect(() => {
    ensureFontLoaded(outputSettings.fontStyle).catch(() => { });
  }, [outputSettings.fontStyle]);

  const isPreviewMode = new URLSearchParams(window.location.search).get('preview') === 'true';

  const stateRequestTimeoutRef = useRef(null);
  const pendingStateRequestRef = useRef(false);

  const [contentMode, setContentMode] = useState('song');
  // Linked-translation companion for dual-translation parallel display.
  // Null = single-translation; every other path ignores it.
  const [parallelBible, setParallelBible] = useState(null);
  const [adjustedFontSize, setAdjustedFontSize] = useState(null);
  const [bandFitReady, setBandFitReady] = useState(false);
  const [, setIsTruncated] = useState(false);
  const textContainerRef = useRef(null);
  const bandContentRef = useRef(null);
  const autosizerActiveRef = useRef(false);

  const [preloadedVideoUrl, setPreloadedVideoUrl] = useState(null);
  const [isPreloading, setIsPreloading] = useState(false);
  const preloadAbortControllerRef = useRef(null);

  const currentLine = Array.isArray(lyrics) && selectedLine != null ? lyrics[selectedLine] : undefined;
  const line = getLineOutputText(currentLine) || '';
  const { enabled: freeNotesEnabled } = useFreeNotesEnabled();

  const isNoteMode = freeNotesEnabled && (contentMode === 'freenote' || isMarkdownContent(line));

  const extractBibleVerseParts = (fullText, referenceText) => {
    if (!fullText || !referenceText) {
      return { body: fullText || '', reference: '' };
    }

    const normalized = String(fullText).trimEnd();
    const referenceSuffix = `\n\n${referenceText}`;

    if (normalized.endsWith(referenceSuffix)) {
      return {
        body: normalized.slice(0, -referenceSuffix.length),
        reference: referenceText,
      };
    }

    return { body: fullText, reference: '' };
  };

  const parsedBodyMemo = useMemo(() => isNoteMode
    ? { body: line, reference: '' }
    : extractBibleVerseParts(line, lyricsFileName), [isNoteMode, line, lyricsFileName]);
  const { body: parsedBody, reference: parsedReference } = parsedBodyMemo;
  // #12 output-sanitization boundary: plain-text lyric/Bible content passes
  // through the central sanitizer (identity for legitimate content — brackets,
  // verse punctuation, line breaks, Unicode — control chars stripped).
  const displayLine = useMemo(() => sanitizeOutputText(isNoteMode ? line : parsedBody), [isNoteMode, line, parsedBody]);
  const bibleReferenceText = useMemo(() => sanitizeOutputText(isNoteMode ? '' : parsedReference), [isNoteMode, parsedReference]);
  const showBibleVersion = outputSettings?.showBibleVersion !== false;
  const bibleReferenceDisplay = useMemo(() => (showBibleVersion ? formatBibleReference(bibleReferenceText, bibleVersion) : bibleReferenceText), [showBibleVersion, bibleReferenceText, bibleVersion]);
  // The band auto-sizer must account for the linked translation too, or a
  // two-translation verse fits the primary text and overflows the band.
  const parallelSecondaryText = useMemo(() => {
    if (contentMode !== 'bible' || !parallelBible) return '';
    const slides = parallelBible.slides?.length
      ? parallelBible.slides
      : (parallelBible.text ? [parallelBible.text] : []);
    const index = Number.isInteger(selectedLine) ? Math.min(Math.max(selectedLine, 0), Math.max(slides.length - 1, 0)) : 0;
    return slides[index] || '';
  }, [contentMode, parallelBible, selectedLine]);

  const requestCurrentStateWithRetry = useCallback((retryCount = 0) => {
    const maxRetries = 3;

    if (retryCount === 0 && pendingStateRequestRef.current) {
      logDebug('RegularOutput: Skipping state request - pending request in progress');
      return;
    }

    if (!socket || !socket.connected || !isAuthenticated) {
      if (retryCount === 0) {
        pendingStateRequestRef.current = false;
      }
      logDebug('RegularOutput: Cannot request state - socket not connected or authenticated');
      return;
    }

    if (retryCount >= maxRetries) {
      pendingStateRequestRef.current = false;
      logError('RegularOutput: Max retries reached for state request');
      return;
    }

    pendingStateRequestRef.current = true;
    logDebug(`RegularOutput: Requesting current state (attempt ${retryCount + 1})`);
    socket.emit('requestCurrentState');

    if (stateRequestTimeoutRef.current) {
      clearTimeout(stateRequestTimeoutRef.current);
    }

    stateRequestTimeoutRef.current = setTimeout(() => {
      pendingStateRequestRef.current = false;
      logDebug(`RegularOutput: State request timeout (attempt ${retryCount + 1}), retrying...`);
      requestCurrentStateWithRetry(retryCount + 1);
    }, 3000);
  }, [socket, isAuthenticated]);

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById('root');

    html.classList.add('transparent-background');
    body.classList.add('transparent-background');
    root?.classList.add('transparent-background');

    return () => {
      html.classList.remove('transparent-background');
      body.classList.remove('transparent-background');
      root?.classList.remove('transparent-background');
    };
  }, []);

  useEffect(() => {
    if (!socket) return;

    const handleCurrentState = (state) => {
      logDebug('RegularOutput: Received current state:', state);

      if (stateRequestTimeoutRef.current) {
        clearTimeout(stateRequestTimeoutRef.current);
        stateRequestTimeoutRef.current = null;
      }
      pendingStateRequestRef.current = false;

      if (state.contentMode) setContentMode(state.contentMode);
      // Late-join parallel companion (server currentState.bibleParallel).
      if (Object.prototype.hasOwnProperty.call(state, 'bibleParallel')) {
        setParallelBible(sanitizeParallelPayload(state.bibleParallel));
      } else if (state.contentMode && state.contentMode !== 'bible') {
        setParallelBible(null);
      }
      if (state.lyrics) setLyrics(state.lyrics);
      if (state.selectedLine !== undefined) selectLine(state.selectedLine);
      if (state[`${outputKey}Settings`] || state.customOutputSettings?.[outputKey]) updateOutputSettings(state[`${outputKey}Settings`] || state.customOutputSettings?.[outputKey]);
      if (typeof state.showState === 'string') useLyricsStore.getState().setShowState?.(state.showState);
      else if (typeof state.isOutputOn === 'boolean') setIsOutputOn(state.isOutputOn);
      if (state.ticker && (Array.isArray(state.ticker.queue) || state.ticker.activeId !== undefined)) {
        useLyricsStore.getState().setTickerState?.(state.ticker.queue || [], state.ticker.activeId ?? null);
      }
      if (typeof state.lyricsFileName === 'string') setLyricsFileName(state.lyricsFileName);
    };

    const handleLineUpdate = ({ index }) => {
      logDebug('RegularOutput: Received line update:', index);
      selectLine(index);
    };

    const handleLyricsLoad = (newLyrics) => {
      logDebug('RegularOutput: Received lyrics load:', newLyrics?.length, 'lines');
      setContentMode('song');
      setParallelBible(null);
      const lyrics = Array.isArray(newLyrics) ? newLyrics : Array.isArray(newLyrics?.lyrics) ? newLyrics.lyrics : [];
      setLyrics(lyrics);
      selectLine(0); // Default to first line when new lyrics are loaded
    };

    const handleBibleVerse = (payload) => {
      logDebug('RegularOutput: Received bibleVerseLoaded:', payload?.reference);
      setContentMode('bible');
      setParallelBible(sanitizeParallelPayload(payload?.secondary));
      try {
        if (Array.isArray(payload?.slides) && payload.slides.length > 0 && payload.reference) {
          const lines = payload.slides.map((t) => `${t}\n\n${payload.reference}`.trim());
          setLyrics(lines);
          selectLine(Number.isInteger(payload.slideIndex) ? payload.slideIndex : 0);
          setLyricsFileName(payload.reference);
        } else if (payload?.reference) {
          setLyricsFileName(payload.reference);
          if (Number.isInteger(payload?.slideIndex)) selectLine(payload.slideIndex);
        }
      } catch {}
    };

    const handleFreeNote = (payload) => {
      logDebug('RegularOutput: Received freeNoteLoaded:', payload?.title);
      setContentMode('freenote');
      setParallelBible(null);
      try {
        const rawSlides = Array.isArray(payload?.slides) && payload.slides.length > 0
          ? payload.slides
          : (Array.isArray(payload?.lines) && payload.lines.length > 0 ? payload.lines : [payload?.rawText || '']);
        const slides = rawSlides.map((s) => String(s ?? '')).filter((s) => s.trim().length > 0);
        if (slides.length > 0) {
          setLyrics(slides);
          const idx = Number.isInteger(payload?.slideIndex)
            ? payload.slideIndex
            : (Number.isInteger(payload?.selectedLine) ? payload.selectedLine : 0);
          selectLine(Math.max(0, Math.min(idx, slides.length - 1)));
          setLyricsFileName(payload?.title || 'Free Note');
        }
      } catch {}
    };

    const handleContentModeUpdate = (payload) => {
      const mode = typeof payload === 'string' ? payload : payload?.mode;
      if (mode) setContentMode(mode);
    };

    const handleStyleUpdate = ({ output, settings }) => {
      if (output === outputKey) {
        logDebug('RegularOutput: Received style update');
        updateOutputSettings(settings);
      }
    };

    const handleFileNameUpdate = (fileName) => {
      logDebug('RegularOutput: Received filename update:', fileName);
      setLyricsFileName(fileName || '');
    };

    const handleOutputToggle = (state) => {
      logDebug('RegularOutput: Received output toggle:', state);
      setIsOutputOn(state);
    };

    const handleShowStateUpdate = (payload) => {
      const next = payload && typeof payload === 'object' ? payload.state : payload;
      logDebug('RegularOutput: Received show state update:', next);
      useLyricsStore.getState().setShowState?.(next);
    };

    const handleTickerUpdate = (payload) => {
      logDebug('RegularOutput: Received ticker update:', payload?.queue?.length || 0);
      useLyricsStore.getState().setTickerState?.(
        Array.isArray(payload?.queue) ? payload.queue : [],
        payload?.activeId ?? null
      );
    };

    socket.on('currentState', handleCurrentState);
    socket.on('periodicStateSync', handleCurrentState);
    socket.on('lineUpdate', handleLineUpdate);
    socket.on('lyricsLoad', handleLyricsLoad);
    socket.on('bibleVerseLoaded', handleBibleVerse);
    socket.on('freeNoteLoaded', handleFreeNote);
    socket.on('contentModeUpdate', handleContentModeUpdate);
    socket.on('styleUpdate', handleStyleUpdate);
    socket.on('fileNameUpdate', handleFileNameUpdate);
    socket.on('outputToggle', handleOutputToggle);
    socket.on('showStateUpdate', handleShowStateUpdate);
    socket.on('tickerUpdate', handleTickerUpdate);

    if (socket.connected) {
      setTimeout(() => requestCurrentStateWithRetry(0), 100);
    }

    return () => {
      if (stateRequestTimeoutRef.current) {
        clearTimeout(stateRequestTimeoutRef.current);
      }
      pendingStateRequestRef.current = false;
      socket.off('currentState', handleCurrentState);
      socket.off('periodicStateSync', handleCurrentState);
      socket.off('lineUpdate', handleLineUpdate);
      socket.off('lyricsLoad', handleLyricsLoad);
      socket.off('bibleVerseLoaded', handleBibleVerse);
      socket.off('freeNoteLoaded', handleFreeNote);
      socket.off('contentModeUpdate', handleContentModeUpdate);
      socket.off('styleUpdate', handleStyleUpdate);
      socket.off('fileNameUpdate', handleFileNameUpdate);
      socket.off('outputToggle', handleOutputToggle);
      socket.off('showStateUpdate', handleShowStateUpdate);
      socket.off('tickerUpdate', handleTickerUpdate);
    };

  }, [socket, requestCurrentStateWithRetry]);

  useEffect(() => {
    logDebug(`RegularOutput connection status: ${connectionStatus}`);

    if (connectionStatus === 'connected' && socket) {
      setTimeout(() => requestCurrentStateWithRetry(0), 200);
    }
  }, [connectionStatus, socket, requestCurrentStateWithRetry]);

  useEffect(() => {
    if (!isConnected) return;

    // Low-frequency fallback for missed periodicStateSync broadcasts (the
    // server only emits those when the state fingerprint changed). A dropped
    // event would otherwise leave this output undetected until the next
    // change; the full-state recovery poll guarantees convergence.
    const recoveryInterval = setInterval(() => {
      if (socket?.connected) {
        requestCurrentStateWithRetry(0);
      }
    }, performanceSettings.lowPowerMode ? 10 * 60 * 1000 : 5 * 60 * 1000);

    return () => clearInterval(recoveryInterval);
  }, [isConnected, socket, requestCurrentStateWithRetry, performanceSettings.lowPowerMode]);

  useEffect(() => {
    return () => {
      if (stateRequestTimeoutRef.current) {
        clearTimeout(stateRequestTimeoutRef.current);
      }
    };
  }, []);

  const {
    fontStyle,
    bold,
    italic,
    underline,
    allCaps,
    textAlign = 'center',
    fontSize,
    translationFontSizeMode = 'bound',
    translationFontSize = 48,
    fontColor,
    translationLineColor = '#FBBF24',
    borderColor = '#000000',
    borderSize = 0,
    dropShadowColor = '#000000',
    dropShadowOpacity = 0,
    dropShadowOffsetX = 0,
    dropShadowOffsetY = 8,
    dropShadowBlur = 10,
    backgroundColor = '#000000',
    backgroundOpacity = 0,
    backgroundBandVerticalPadding = 20,
    backgroundBandHeightMode = 'adaptive',
    backgroundBandCustomLines = 3,
    lyricsPosition = 'lower',
    fullScreenMode = false,
    fullScreenBackgroundType = 'color',
    fullScreenBackgroundColor = '#000000',
    fullScreenBackgroundMedia,
    fullScreenBackgroundMotionPreset = 'amber-drift',
    fullScreenBackgroundMotionDim = 0.65,
    alwaysShowBackground = false,
    xMargin = 0,
    yMargin = 0,
    maxLinesEnabled = false,
    fitWidthPercent = 90,
    fitHeightPercent = 90,
    minFontSize = 24,
    maxFontSize = 300,
    bibleReferencePosition = 'bottom-center',
    bibleReferenceSize = 28,
    streamBandEnabled = false,
    streamBandHeightPercent = 33,
    streamBandBackdrop = 'gradient',
    streamBandAutoFit = true,
    transitionAnimation = 'none',
    transitionSpeed = 150,
  } = outputSettings;

  const noteBaseFontSize = useMemo(() => {
    if (!isNoteMode) return fontSize;
    return calculateNoteBaseFontSize(displayLine, {
      containerHeight: textContainerRef.current?.clientHeight,
      targetFontSize: fontSize,
      minFontSize,
      maxFontSize,
    });
  }, [isNoteMode, displayLine, fontSize, minFontSize, maxFontSize]);

  const getAnimationVariants = () => {
    const gpuEffectsOff = performanceSettings.gpuEffects === false;
    switch (transitionAnimation) {
      case 'fade':
        return {
          hidden: { opacity: 0 },
          visible: { opacity: 1 },
          exit: { opacity: 0 }
        };
      case 'scale':
        return {
          hidden: { opacity: 0, scale: 0.9 },
          visible: { opacity: 1, scale: 1 },
          exit: { opacity: 0, scale: 0.9 }
        };
      case 'slide':
        return {
          hidden: { opacity: 0, y: 30 },
          visible: { opacity: 1, y: 0 },
          exit: { opacity: 0, y: -30 }
        };
      case 'blur':
        if (gpuEffectsOff) {
          return {
            hidden: { opacity: 0 },
            visible: { opacity: 1 },
            exit: { opacity: 0 }
          };
        }
        return {
          hidden: { opacity: 0, filter: 'blur(8px)' },
          visible: { opacity: 1, filter: 'blur(0px)' },
          exit: { opacity: 0, filter: 'blur(8px)' }
        };
      default:
        return null;
    }
  };

  const animationVariants = getAnimationVariants();
  const shouldAnimate = !performanceSettings.lowPowerMode && transitionAnimation !== 'none' && animationVariants !== null;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const toHexOpacity = (value) => clamp(Math.round((value / 10) * 255), 0, 255)
    .toString(16)
    .padStart(2, '0');

  const dropShadowStrength = clamp(Number(dropShadowOpacity) || 0, 0, 10);
  const backgroundStrength = clamp(Number(backgroundOpacity) || 0, 0, 10);
  const verticalMarginRem = clamp(Number(yMargin) || 0, 0, 20);
  const horizontalMarginRem = clamp(Number(xMargin) || 0, 0, 20);
  const horizontalPaddingStyle = {
    paddingLeft: `${horizontalMarginRem}rem`,
    paddingRight: `${horizontalMarginRem}rem`,
    boxSizing: 'border-box',
  };

  const streamBandActive = Boolean(streamBandEnabled);
  const streamBandHeightValue = normalizeStreamBandHeightPercent(streamBandHeightPercent);
  const streamBandBackdropValue = normalizeStreamBandBackdrop(streamBandBackdrop);
  const streamBandPaddingPx = clamp(Number(backgroundBandVerticalPadding) || 0, 0, 100);
  const streamBandFitActive = streamBandActive && streamBandAutoFit;
  const autoFitActive = Boolean(maxLinesEnabled || streamBandFitActive);

  const getTextShadow = () => {
    if (!dropShadowColor || dropShadowStrength === 0 || performanceSettings.reducedGraphics) return 'none';
    const opacityHex = toHexOpacity(dropShadowStrength);
    return `${dropShadowOffsetX}px ${dropShadowOffsetY}px ${dropShadowBlur}px ${dropShadowColor}${opacityHex}`;
  };
  const dropShadowPadding = (maxLinesEnabled && dropShadowStrength > 0)
    ? Math.max(dropShadowBlur, Math.abs(dropShadowOffsetY))
    : 0;

  const getBandBackground = () => {
    const opacityHex = toHexOpacity(backgroundStrength);
    return `${backgroundColor}${opacityHex}`;
  };

  const BACKGROUND_VERTICAL_PADDING_REM = backgroundBandVerticalPadding / 16;

  const getBackgroundBandHeight = () => {
    if (backgroundBandHeightMode !== 'custom' || fullScreenMode) {
      return undefined;
    }

    const lineHeight = 1.05;
    const effectiveFontSize = adjustedFontSize ?? fontSize;
    const textHeight = backgroundBandCustomLines * effectiveFontSize * lineHeight;
    const totalPadding = 2 * backgroundBandVerticalPadding;
    return `${textHeight + totalPadding}px`;
  };

  const positionJustifyMap = {
    upper: 'flex-start',
    center: 'center',
    lower: 'flex-end',
  };
  const effectiveLyricsPosition = positionJustifyMap[lyricsPosition] ? lyricsPosition : 'lower';
  const justifyContent = positionJustifyMap[effectiveLyricsPosition] || 'flex-end';

  const isOutputActive = isPreviewMode || Boolean(isOutputOn && outputEnabled);
  // Explicit show-control machine (feature #18). Lyrics render only in LIVE;
  // CLEAR keeps the background, BLACKOUT is full black, LOGO is the house slide.
  const activeShowState = String(showState || 'LIVE').toUpperCase();
  const isBlackout = !isPreviewMode && activeShowState === 'BLACKOUT';
  const isLogoSlide = !isPreviewMode && activeShowState === 'LOGO';
  const isCleared = !isPreviewMode && activeShowState === 'CLEAR';
  const isVisible = Boolean(isOutputActive && line && !isBlackout && !isLogoSlide && !isCleared);
  const shouldShowFullScreenBackground = !isBlackout && !isLogoSlide && fullScreenMode && (alwaysShowBackground || isOutputActive || isCleared);
  const activeTicker = !isBlackout ? resolveTickerForOutput(tickerQueue, tickerActiveId, outputKey) : null;

  const fullScreenBackgroundColorValue =
    shouldShowFullScreenBackground && (fullScreenBackgroundType === 'color' || fullScreenBackgroundType === 'motion')
      ? fullScreenBackgroundColor || '#000000'
      : 'transparent';

  useEffect(() => {
    const preloadVideo = async () => {
      if (!shouldShowFullScreenBackground || fullScreenBackgroundType !== 'media' || !fullScreenBackgroundMedia || performanceSettings.disableVideoPreloading) {
        return;
      }

      const media = fullScreenBackgroundMedia;
      const isVideo = media.mimeType?.startsWith('video/') ||
        (!media.mimeType && typeof media.url === 'string' && /\.(mp4|webm|ogg|m4v|mov)$/i.test(media.url));

      if (!isVideo) {
        return;
      }

      if (media.bundled) {
        return;
      }

      const sourceUrl = media.url ? resolveBackendUrl(media.url) : null;
      if (!sourceUrl || isPreloading) {
        return;
      }

      const currentVideoId = `${media.url}-${media.uploadedAt}`;
      const preloadedVideoId = preloadedVideoUrl ? preloadedVideoUrl.split('#')[1] : null;
      if (preloadedVideoId === currentVideoId) {
        return;
      }

      if (preloadedVideoUrl) {
        URL.revokeObjectURL(preloadedVideoUrl);
        setPreloadedVideoUrl(null);
      }

      if (preloadAbortControllerRef.current) {
        preloadAbortControllerRef.current.abort();
      }

      setIsPreloading(true);
      const abortController = new AbortController();
      preloadAbortControllerRef.current = abortController;

      try {
        logDebug('RegularOutput: Preloading video into memory:', sourceUrl);

        const response = await fetch(sourceUrl, {
          signal: abortController.signal,
          cache: 'force-cache',
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);

        const blobUrlWithId = `${blobUrl}#${currentVideoId}`;
        setPreloadedVideoUrl(blobUrlWithId);

        logDebug('RegularOutput: Video preloaded successfully, size:', (blob.size / 1024 / 1024).toFixed(2), 'MB');
      } catch (error) {
        if (error.name === 'AbortError') {
          logDebug('RegularOutput: Video preload aborted');
        } else {
          logError('RegularOutput: Failed to preload video:', error.message);
        }
      } finally {
        setIsPreloading(false);
        if (preloadAbortControllerRef.current === abortController) {
          preloadAbortControllerRef.current = null;
        }
      }
    };

    preloadVideo();

    return () => {
      if (preloadAbortControllerRef.current) {
        preloadAbortControllerRef.current.abort();
        preloadAbortControllerRef.current = null;
      }
    };
  }, [fullScreenMode, fullScreenBackgroundType, fullScreenBackgroundMedia?.url, fullScreenBackgroundMedia?.uploadedAt, shouldShowFullScreenBackground]);

  useEffect(() => {
    return () => {
      if (preloadedVideoUrl) {
        const cleanUrl = preloadedVideoUrl.split('#')[0];
        URL.revokeObjectURL(cleanUrl);
      }
    };
  }, [preloadedVideoUrl]);

  const resolveBackgroundMediaSource = () => {
    if (!shouldShowFullScreenBackground || !fullScreenBackgroundMedia) return null;
    if (fullScreenBackgroundMedia.dataUrl) return fullScreenBackgroundMedia.dataUrl;
    if (fullScreenBackgroundMedia.url) {
      if (fullScreenBackgroundMedia.bundled) {
        return fullScreenBackgroundMedia.url;
      }

      const isVideo = fullScreenBackgroundMedia.mimeType?.startsWith('video/') ||
        (!fullScreenBackgroundMedia.mimeType && typeof fullScreenBackgroundMedia.url === 'string' &&
          /\.(mp4|webm|ogg|m4v|mov)$/i.test(fullScreenBackgroundMedia.url));

      if (isVideo && preloadedVideoUrl) {
        return preloadedVideoUrl.split('#')[0];
      }

      return resolveBackendUrl(fullScreenBackgroundMedia.url);
    }
    return null;
  };

  const renderMotionBackground = () => {
    if (!shouldShowFullScreenBackground || fullScreenBackgroundType !== 'motion') {
      return null;
    }
    // Lyrics render in a z-10 sibling layer above this canvas; the canvas
    // paints its own dim guard and goes static when GPU effects / Low Power
    // (or the OS reduced-motion setting) forbid animation.
    return (
      <CanvasMotionBackground
        presetId={fullScreenBackgroundMotionPreset}
        dim={fullScreenBackgroundMotionDim}
        paused={performanceSettings.lowPowerMode === true}
        performanceSettings={performanceSettings}
      />
    );
  };

  const renderFullScreenMedia = () => {
    if (!shouldShowFullScreenBackground || fullScreenBackgroundType !== 'media') {
      return null;
    }

    const media = fullScreenBackgroundMedia;
    const mediaSource = resolveBackgroundMediaSource();
    if (!media || !mediaSource) {
      return null;
    }

    const isVideo = media.mimeType?.startsWith('video/') ||
      (!media.mimeType && typeof media.url === 'string' && /\.(mp4|webm|ogg|m4v|mov)$/i.test(media.url));

    const cacheKey = media.uploadedAt || Date.now();

    if (isVideo) {
      return (
        <video
          key={`video-${cacheKey}`}
          aria-hidden="true"
          className="absolute inset-0 w-full h-full object-cover"
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
          src={mediaSource}
          onError={(e) => {
            logError('RegularOutput: Failed to load background video:', mediaSource);
          }}
        />
      );
    }

    return (
      <img
        key={`image-${cacheKey}`}
        aria-hidden="true"
        className="absolute inset-0 w-full h-full object-cover"
        src={mediaSource}
        alt="Full screen lyric background"
        onError={(e) => {
          logError('RegularOutput: Failed to load background image:', mediaSource);
        }}
      />
    );
  };

  const effectiveBorderSize = Math.min(10, Math.max(0, Number(borderSize) || 0));
  const textStrokeValue = (effectiveBorderSize > 0 && !performanceSettings.reducedGraphics)
    ? `${effectiveBorderSize}px ${borderColor}`
    : '0px transparent';
  const textStrokeStyles = {
    WebkitTextStroke: textStrokeValue,
    textStroke: textStrokeValue,
    paintOrder: 'stroke fill',
    WebkitPaintOrder: 'stroke fill',
  };

  const processDisplayText = (text) => {
    return allCaps ? text.toUpperCase() : text;
  };

  // The band must never paint an oversized frame while the first fit is being
  // measured. Hide the text until the auto-sizer has produced a size.
  useEffect(() => {
    if (!streamBandActive) {
      setBandFitReady(true);
      return;
    }
    setBandFitReady(!streamBandAutoFit);
  }, [streamBandActive, streamBandAutoFit, displayLine, streamBandHeightValue, streamBandPaddingPx, bibleReferenceDisplay, parallelSecondaryText]);

  useEffect(() => {
    if (!autoFitActive || isNoteMode) {
      setAdjustedFontSize((prev) => (prev === null ? prev : null));
      setIsTruncated((prev) => (prev === false ? prev : false));
      setBandFitReady(true);
      if (autosizerActiveRef.current) {
        autosizerActiveRef.current = false;
        updateOutputSettings({ autosizerActive: false });
      }

      if (emitOutputMetrics && isConnected && isAuthenticated) {
        try {
          emitOutputMetrics(outputKey, {
            adjustedFontSize: null,
            autosizerActive: false,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            timestamp: Date.now(),
          });
        } catch { }
      }
      return;
    }

    if (!displayLine || !isVisible) {
      return;
    }

    const rafId = requestAnimationFrame(() => {
      const inBand = streamBandActive;
      const bandContentHeight = bandContentRef.current?.clientHeight;
      const referenceReserve = inBand
        ? getStreamBandReferenceReserve(bandContentHeight, Boolean(bibleReferenceDisplay))
        : 0;
      const containerWidth = inBand
        ? bandContentRef.current?.clientWidth ?? null
        : (textContainerRef.current ? textContainerRef.current.clientWidth : null);
      const containerHeight = inBand
        ? Math.max(0, (bandContentHeight || 0) - referenceReserve)
        : (textContainerRef.current?.parentElement?.clientHeight ?? null);
      const measureText = inBand && parallelSecondaryText
        ? `${displayLine}\n${parallelSecondaryText}`
        : displayLine;

      const result = calculateOptimalFontSize({
        text: measureText,
        fontSize,
        fitWidthPercent,
        fitHeightPercent,
        minFontSize,
        maxFontSize,
        fontStyle,
        bold,
        italic,
        horizontalMarginRem: inBand ? 0 : horizontalMarginRem,
        verticalMarginRem: inBand ? 0 : yMargin,
        processDisplayText,
        maxLinesEnabled: true,
        containerWidth,
        containerHeight,
      });

      const safeAdjusted = (result.adjustedSize === null)
        ? null
        : (Number.isFinite(result.adjustedSize) && result.adjustedSize > 0 ? result.adjustedSize : null);

      setAdjustedFontSize((prev) => (prev === safeAdjusted ? prev : safeAdjusted));
      setIsTruncated((prev) => (prev === Boolean(result.isTruncated) ? prev : Boolean(result.isTruncated)));
      if (inBand) setBandFitReady(true);

      const autosizerActive = Boolean(maxLinesEnabled && safeAdjusted !== null && safeAdjusted !== fontSize);

      if (autosizerActiveRef.current !== autosizerActive) {
        autosizerActiveRef.current = autosizerActive;
        updateOutputSettings({ autosizerActive });
      }

      if (maxLinesEnabled && emitOutputMetrics && isConnected && isAuthenticated) {
        try {
          emitOutputMetrics(outputKey, {
            adjustedFontSize: safeAdjusted,
            autosizerActive,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            timestamp: Date.now(),
          });
        } catch { }
      }
    });

    return () => cancelAnimationFrame(rafId);
  }, [
    autoFitActive,
    streamBandActive,
    streamBandAutoFit,
    streamBandHeightValue,
    streamBandPaddingPx,
    parallelSecondaryText,
    bibleReferenceDisplay,
    maxLinesEnabled,
    displayLine,
    fontSize,
    fitWidthPercent,
    fitHeightPercent,
    minFontSize,
    maxFontSize,
    fontStyle,
    bold,
    italic,
    horizontalMarginRem,
    allCaps,
    yMargin,
    isVisible,
    isNoteMode,
  ]);

  const getBibleReferenceOverlayStyle = () => {
    switch (bibleReferencePosition) {
      case 'top-left':
        return { top: '2rem', left: '2rem', textAlign: 'left' };
      case 'top-right':
        return { top: '2rem', right: '2rem', textAlign: 'right' };
      case 'top-center':
        return { top: '2rem', left: '50%', transform: 'translateX(-50%)', textAlign: 'center' };
      case 'left':
        return { top: '50%', left: '2rem', transform: 'translateY(-50%)', textAlign: 'left' };
      case 'bottom-right':
        return { bottom: '2rem', right: '2rem', textAlign: 'right' };
      case 'bottom-left':
        return { bottom: '2rem', left: '2rem', textAlign: 'left' };
      case 'bottom-center':
      default:
        return { bottom: '2rem', left: '50%', transform: 'translateX(-50%)', textAlign: 'center' };
    }
  };

  const renderContent = () => {
    if (isNoteMode) {
      return (
        <MarkdownNoteRenderer
          content={displayLine}
          baseFontSize={noteBaseFontSize}
          fontColor={fontColor}
          textAlign={textAlign}
          fontStyle={fontStyle}
          bold={bold}
          italic={italic}
          underline={underline}
          allCaps={allCaps}
          textStrokeStyles={textStrokeStyles}
          textShadow={getTextShadow()}
        />
      );
    }

    const processedText = processDisplayText(displayLine);

    // Dual-translation parallel display: side-by-side on wide surfaces,
    // stacked on narrow ones. Mounted only with a linked secondary.
    if (!isNoteMode && contentMode === 'bible' && parallelBible) {
      const secondarySlides = parallelBible.slides?.length
        ? parallelBible.slides
        : (parallelBible.text ? [parallelBible.text] : []);
      const secondaryIndex = Number.isInteger(selectedLine)
        ? Math.min(Math.max(selectedLine, 0), Math.max(secondarySlides.length - 1, 0))
        : 0;
      return (
        <ParallelBibleDisplay
          primaryText={processedText}
          primaryLabel={bibleVersion || ''}
          secondaryText={processDisplayText(secondarySlides[secondaryIndex] ?? '')}
          secondaryLabel={parallelBible.bible || ''}
          layout={normalizeParallelLayout(outputSettings?.parallelLayout)}
          fontFamily={fontStyle}
          fontWeight={bold ? 'bold' : 'normal'}
          fontStyle={italic ? 'italic' : 'normal'}
          textDecoration={underline ? 'underline' : 'none'}
          primaryColor={fontColor}
          secondaryColor={translationLineColor}
          textAlign={textAlign}
          lineHeight={1.25}
          textShadow={getTextShadow()}
          textStrokeStyles={textStrokeStyles}
        />
      );
    }

    if (processedText.includes('\n')) {
      const lines = processedText.split('\n');

      const isTranslationGroup = currentLine?.type === 'group' && lines.length === 2;

      const effectiveTranslationSize = translationFontSizeMode === 'custom'
        ? translationFontSize
        : (adjustedFontSize ?? fontSize);

      return (
        <div className="space-y-1">
          {lines.map((lineText, index) => {
            const lineDisplayText = (isTranslationGroup && index > 0)
              ? lineText.replace(/^[\[({<]|[\])}>\s]*$/g, '').trim()
              : lineText;

            return (
              <div
                key={index}
                style={{
                  ...textStrokeStyles,
                  color: (isTranslationGroup && index > 0) ? translationLineColor : 'inherit',
                  fontSize: (isTranslationGroup && index > 0) ? `${effectiveTranslationSize}px` : 'inherit',
                  fontWeight: bold ? 'bold' : 'normal',
                }}
              >
                {lineDisplayText}
              </div>
            );
          })}
        </div>
      );
    }

    return processedText;
  };

  const renderStreamBand = () => {
    const fallbackContentHeight = typeof window !== 'undefined'
      ? Math.max(0, (window.innerHeight * streamBandHeightValue) / 100 - 2 * streamBandPaddingPx)
      : 0;
    const contentHeight = bandContentRef.current?.clientHeight || fallbackContentHeight;
    const referenceFontSize = getStreamBandReferenceFontSize({
      bodyFontSize: adjustedFontSize ?? fontSize,
      contentHeight,
      preferredSize: bibleReferenceSize,
      hasReference: Boolean(bibleReferenceDisplay),
    });
    const fitPending = streamBandAutoFit && !bandFitReady;
    const backdropStyle = getStreamBandBackdropStyle({
      backdrop: streamBandBackdropValue,
      backgroundColor,
      backgroundOpacity,
    });
    const bandTextStyle = {
      fontFamily: fontStyle,
      fontSize: isNoteMode ? `${noteBaseFontSize}px` : `${adjustedFontSize ?? fontSize}px`,
      fontWeight: bold ? 'bold' : 'normal',
      fontStyle: italic ? 'italic' : 'normal',
      textDecoration: underline ? 'underline' : 'none',
      color: fontColor,
      textShadow: getTextShadow(),
      ...textStrokeStyles,
      textAlign,
      width: '100%',
      maxWidth: '100%',
      lineHeight: isNoteMode ? 1.45 : 1.15,
      display: 'block',
      whiteSpace: isNoteMode ? 'normal' : 'pre-wrap',
      wordWrap: 'break-word',
      wordBreak: 'break-word',
      overflowWrap: 'anywhere',
      paddingBottom: dropShadowPadding ? `${dropShadowPadding}px` : undefined,
      opacity: isVisible && !fitPending ? 1 : 0,
      transition: 'opacity 180ms ease-out, font-size 180ms ease-out',
    };

    return (
      <div
        data-testid="stream-band"
        data-band-percent={streamBandHeightValue}
        data-show-state={activeShowState}
        className="fixed inset-x-0 bottom-0 overflow-hidden"
        style={{
          height: `${streamBandHeightValue}vh`,
          backgroundColor: 'transparent',
          pointerEvents: 'none',
        }}
      >
        {isVisible && (
          <>
            <div aria-hidden="true" style={{ position: 'absolute', inset: 0, ...backdropStyle }} />
            <div
              style={{
                position: 'relative',
                zIndex: 10,
                height: '100%',
                boxSizing: 'border-box',
                padding: `${streamBandPaddingPx}px ${horizontalMarginRem}rem`,
              }}
            >
              <div
                ref={bandContentRef}
                style={{
                  height: '100%',
                  width: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                  overflow: 'hidden',
                }}
              >
                <div ref={textContainerRef} style={bandTextStyle}>
                  {renderContent()}
                </div>
                {bibleReferenceDisplay && (
                  <div
                    style={{
                      fontFamily: fontStyle,
                      fontSize: `${referenceFontSize}px`,
                      fontWeight: bold ? 'bold' : 'normal',
                      color: fontColor,
                      textShadow: getTextShadow(),
                      ...textStrokeStyles,
                      textAlign,
                      lineHeight: 1.15,
                      maxWidth: '100%',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      opacity: isVisible && !fitPending ? 1 : 0,
                      transition: 'opacity 180ms ease-out',
                    }}
                  >
                    {bibleReferenceDisplay}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    );
  };

  if (streamBandActive) {
    return renderStreamBand();
  }

  return (
    <div
      className="relative w-screen h-screen overflow-hidden"
      data-show-state={activeShowState}
      style={{
        backgroundColor: fullScreenBackgroundColorValue,
      }}
    >
      {renderMotionBackground()}
      {isBlackout && (
        <div data-testid="show-blackout" className="absolute inset-0 z-40 bg-black" aria-label="Blackout" />
      )}
      {isLogoSlide && (
        <div data-testid="show-logo" className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-6 bg-black" aria-label="House slide">
          <img src="/Selah-icon.png" alt="Selah logo" className="h-32 w-32 object-contain" />
          <p className="text-4xl font-bold tracking-wide text-white">Selah</p>
          <p className="text-lg uppercase tracking-[0.3em] text-gray-400">{displayName}</p>
        </div>
      )}
      {renderFullScreenMedia()}
      <div
        className="relative z-10 flex w-full h-full"
        style={{
          justifyContent,
          flexDirection: 'column',
          alignItems: 'stretch',
          paddingTop: `${verticalMarginRem}rem`,
          paddingBottom: `${verticalMarginRem}rem`,
        }}
      >
        <div className="flex w-full justify-center">
          {(!fullScreenMode && backgroundStrength > 0) ? (
            <div
              style={{
                backgroundColor: getBandBackground(),
                paddingTop: `${BACKGROUND_VERTICAL_PADDING_REM}rem`,
                paddingBottom: `${BACKGROUND_VERTICAL_PADDING_REM}rem`,
                ...horizontalPaddingStyle,
                height: getBackgroundBandHeight(),
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                width: '100%',
                transition: 'opacity 300ms ease-in-out, background-color 200ms ease-in-out',
                opacity: isVisible ? 1 : 0,
                pointerEvents: isVisible ? 'auto' : 'none',
              }}
              className="leading-none"
            >
              {shouldAnimate ? (
                <AnimatePresence mode="wait">
                  {isVisible && (
                    <motion.div
                      key={`text-band-${selectedLine}-${line}`}
                      ref={textContainerRef}
                      variants={animationVariants}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                      transition={{
                        duration: transitionSpeed / 1000,
                        ease: [0.25, 0.46, 0.45, 0.94]
                      }}
                      style={{
                        fontFamily: fontStyle,
                        fontSize: isNoteMode ? `${noteBaseFontSize}px` : `${(adjustedFontSize ?? fontSize)}px`,
                        fontWeight: bold ? 'bold' : 'normal',
                        fontStyle: italic ? 'italic' : 'normal',
                        textDecoration: underline ? 'underline' : 'none',
                        color: fontColor,
                        textShadow: getTextShadow(),
                        ...textStrokeStyles,
                        textAlign: textAlign,
                        width: '100%',
                        maxWidth: '100%',
                        lineHeight: isNoteMode ? 1.45 : 1.05,
                        display: 'block',
                        WebkitBoxOrient: undefined,
                        WebkitLineClamp: undefined,
                        overflow: 'visible',
                        textOverflow: 'clip',
                        whiteSpace: isNoteMode ? 'normal' : 'pre-wrap',
                        wordWrap: 'break-word',
                        wordBreak: 'break-word',
                        overflowWrap: 'anywhere',
                        paddingBottom: dropShadowPadding ? `${dropShadowPadding}px` : undefined,
                      }}
                    >
                      {renderContent()}
                    </motion.div>
                  )}
                </AnimatePresence>
              ) : (
                <div
                  ref={textContainerRef}
                  style={{
                    fontFamily: fontStyle,
                    fontSize: isNoteMode ? `${noteBaseFontSize}px` : `${(adjustedFontSize ?? fontSize)}px`,
                    fontWeight: bold ? 'bold' : 'normal',
                    fontStyle: italic ? 'italic' : 'normal',
                    textDecoration: underline ? 'underline' : 'none',
                    color: fontColor,
                    textShadow: getTextShadow(),
                    ...textStrokeStyles,
                    textAlign: textAlign,
                    width: '100%',
                    maxWidth: '100%',
                    lineHeight: isNoteMode ? 1.45 : 1.05,
                    transition: 'font-size 200ms ease-out, opacity 500ms ease-in-out',
                    display: 'block',
                    WebkitBoxOrient: undefined,
                    WebkitLineClamp: undefined,
                    overflow: 'visible',
                    textOverflow: 'clip',
                    whiteSpace: isNoteMode ? 'normal' : 'pre-wrap',
                    wordWrap: 'break-word',
                    wordBreak: 'break-word',
                    overflowWrap: 'anywhere',
                    paddingBottom: dropShadowPadding ? `${dropShadowPadding}px` : undefined,
                  }}
                >
                  {renderContent()}
                </div>
              )}
            </div>
          ) : (
            <div
              className="leading-none"
              style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                width: '100%',
                ...horizontalPaddingStyle,
                opacity: isVisible ? 1 : 0,
                transition: 'opacity 300ms ease-in-out',
                pointerEvents: isVisible ? 'auto' : 'none',
              }}
            >
              {shouldAnimate ? (
                <AnimatePresence mode="wait">
                  {isVisible && (
                    <motion.div
                      key={`text-full-${selectedLine}-${line}`}
                      ref={textContainerRef}
                      variants={animationVariants}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                      transition={{
                        duration: transitionSpeed / 1000,
                        ease: [0.25, 0.46, 0.45, 0.94]
                      }}
                      style={{
                        fontFamily: fontStyle,
                        fontSize: isNoteMode ? `${noteBaseFontSize}px` : `${(adjustedFontSize ?? fontSize)}px`,
                        fontWeight: bold ? 'bold' : 'normal',
                        fontStyle: italic ? 'italic' : 'normal',
                        textDecoration: underline ? 'underline' : 'none',
                        color: fontColor,
                        textShadow: getTextShadow(),
                        ...textStrokeStyles,
                        textAlign: textAlign,
                        width: '100%',
                        maxWidth: '100%',
                        lineHeight: isNoteMode ? 1.45 : 1.05,
                        display: 'block',
                        WebkitBoxOrient: undefined,
                        WebkitLineClamp: undefined,
                        overflow: 'visible',
                        textOverflow: 'clip',
                        whiteSpace: isNoteMode ? 'normal' : 'pre-wrap',
                        wordWrap: 'break-word',
                        wordBreak: 'break-word',
                        overflowWrap: 'anywhere',
                        paddingBottom: dropShadowPadding ? `${dropShadowPadding}px` : undefined,
                      }}
                    >
                      {renderContent()}
                    </motion.div>
                  )}
                </AnimatePresence>
              ) : (
                <div
                  ref={textContainerRef}
                  style={{
                    fontFamily: fontStyle,
                    fontSize: isNoteMode ? `${noteBaseFontSize}px` : `${(adjustedFontSize ?? fontSize)}px`,
                    fontWeight: bold ? 'bold' : 'normal',
                    fontStyle: italic ? 'italic' : 'normal',
                    textDecoration: underline ? 'underline' : 'none',
                    color: fontColor,
                    textShadow: getTextShadow(),
                    ...textStrokeStyles,
                    textAlign: textAlign,
                    width: '100%',
                    maxWidth: '100%',
                    lineHeight: isNoteMode ? 1.45 : 1.05,
                    transition: 'font-size 200ms ease-out, opacity 500ms ease-in-out',
                    display: 'block',
                    WebkitBoxOrient: undefined,
                    WebkitLineClamp: undefined,
                    overflow: 'visible',
                    textOverflow: 'clip',
                    whiteSpace: isNoteMode ? 'normal' : 'pre-wrap',
                    wordWrap: 'break-word',
                    wordBreak: 'break-word',
                    overflowWrap: 'anywhere',
                    paddingBottom: dropShadowPadding ? `${dropShadowPadding}px` : undefined,
                  }}
                >
                  {renderContent()}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {isVisible && bibleReferenceDisplay && (
        <div
          style={{
            position: 'absolute',
            zIndex: 20,
            color: fontColor,
            fontFamily: fontStyle,
            fontSize: `${Math.max(18, Math.round((adjustedFontSize ?? fontSize) * 0.32))}px`,
            fontWeight: bold ? 'bold' : 'normal',
            textShadow: getTextShadow(),
            pointerEvents: 'none',
            maxWidth: '75vw',
            ...getBibleReferenceOverlayStyle(),
          }}
        >
          {bibleReferenceDisplay}
        </div>
      )}
      {activeTicker && (
        <TickerOverlay item={activeTicker} reduceMotion={!!performanceSettings.reducedGraphics} />
      )}
    </div>
  );
};

export default RegularOutput;
