import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, FolderOpen, FileText, FilePlusCorner, Edit, ListMusic, Globe, Plus, Info, FileMusic, Play, ChevronDown, ChevronUp, Square, Sparkles, Volume2, VolumeX, Moon, Sun, Settings, BookText, BookOpen, Database, MoreHorizontal, PanelLeftClose, PanelLeftOpen, GripVertical, Maximize2, Minimize2, Trash2, AlertTriangle, X, Monitor, HeartPulse, GraduationCap } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useLyricsState, useOutputState, useOutputAutomationState, useOutput1Settings, useOutput2Settings, useStageSettings, useDarkModeState, useSetlistState, useIsDesktopApp, useAutoplaySettings, useIntelligentAutoplayState, useOutputRegistry, useSidebarState, useSettingsState, useHeaderState, useFreeNotesEnabled, useBibleVerseEditorEnabled, useShowControlState, useTickerState } from '../hooks/useStoreSelectors';
import { useControlSocket } from '../context/ControlSocketProvider';
import { createLogger } from '../utils/logger.js';
import { openLyricsFileThroughNavigator } from '../utils/fileNavigatorEvents';

const logger = createLogger('LyricDisplayApp');
import useFileUpload from '../hooks/useFileUpload';
import useMultipleFileUpload from '../hooks/useMultipleFileUpload';
import useSetlistLoader from '../hooks/SetlistModal/useSetlistLoader';
import AuthStatusIndicator from './AuthStatusIndicator';
import ConnectionBackoffBanner from './ConnectionBackoffBanner';
import ConnectedOutputsStrip from './ConnectedOutputsStrip';
import LyricsList from './LyricsList';
import MobileLayout from './MobileLayout';
import PreviewSafetyBar from './PreviewSafetyBar';

import OutputSettingsPanel from './OutputSettingsPanel';
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import useDarkModeSync from '../hooks/useDarkModeSync';
import useMenuShortcuts from '../hooks/LyricDisplayApp/useMenuShortcuts';
import useSearch from '../hooks/useSearch';
import useOutputSettings from '../hooks/LyricDisplayApp/useOutputSettings';
import useSetlistActions from '../hooks/LyricDisplayApp/useSetlistActions';
import SearchBar from './SearchBar';
import useToast from '../hooks/useToast';
import useModal from '../hooks/useModal';
import { Tooltip } from '@/components/ui/tooltip';
import { hasValidTimestamps } from '../utils/timestampHelpers';
import { splitBibleTextIntoSlides, resolveBibleGeometry } from '../utils/bibleSplitter';
import { shouldLogBibleVerseRequest } from '../utils/bibleVerseLog.js';
import { sanitizeParallelPayload } from '../utils/bibleParallel.js';
import { slugifyOutputName, isReservedOutputSlug } from '../utils/outputs';
import { runAllOutputActions } from '../utils/outputAutomation';
import { parseLrcContent } from '../../shared/lyricsParsing.js';
import { parseScheduleDocument } from '../../shared/scheduleMath.js';
import { orderBibleMetadata, searchBibleExperimental } from 'shared/bible';
import { useAutoplayManager } from '../hooks/useAutoplayManager';
import { useSyncOutputs } from '../hooks/useSyncOutputs';
import { useLyricsLoader } from '../hooks/LyricDisplayApp/useLyricsLoader';
import { useKeyboardShortcuts } from '../hooks/LyricDisplayApp/useKeyboardShortcuts';
import { useHardwareCommands } from '../hooks/useHardwareCommands';
import { useElectronListeners } from '../hooks/LyricDisplayApp/useElectronListeners';
import { useLyricsHotReload } from '../hooks/useLyricsHotReload';
import { useResponsiveWidth } from '../hooks/LyricDisplayApp/useResponsiveWidth';
import { useDragAndDrop } from '../hooks/LyricDisplayApp/useDragAndDrop';
import useBibleStore from '../context/BibleStore';
import OnboardingModal from './Onboarding/OnboardingModal';
import SpotlightTour from './Onboarding/SpotlightTour';
import ShortcutsOverlay from './Onboarding/ShortcutsOverlay';
import { hasSeenOnboarding } from './Onboarding/onboardingContent';
import { useOnboardStore } from '../context/OnboardStore';
import useLyricsStore from '../context/LyricsStore';
import { usePerformanceSettings } from '../hooks/useStoreSelectors';
import BibleControlPanel from './Bible/BibleControlPanel';
import ShowControlDock from './ShowControlDock';
import MetronomeBar from './MetronomeBar';
import SermonAssistPanel from './Speech/SermonAssistPanel';
import BibleChapterEditorModal, { BIBLE_CHAPTER_EDITOR_EVENT } from './Bible/BibleChapterEditorModal';
import FreeNoteControlPanel from './FreeNote/FreeNoteControlPanel';
import { HttpActionButtons } from './HttpActionButton';
import { useOutputTemplateSync } from '../hooks/useOutputTemplateSync';
import { CONTENT_MODE_BIBLE, CONTENT_MODE_SONG, CONTENT_MODE_FREENOTE } from '../utils/contentMode.js';
import useSessionHydration from '../hooks/useSessionHydration';

const SetlistModal = React.lazy(() => import('./SetlistModal'));
const OnlineLyricsSearchModal = React.lazy(() => import('./OnlineLyricsSearchModal'));
const OnlineBibleSearchModal = React.lazy(() => import('./OnlineBibleSearchModal'));
const RccgTphbSongModal = React.lazy(() => import('./RccgTphbSongModal'));
const EasyWorshipImportModal = React.lazy(() => import('./EasyWorshipImportModal'));
const PresentationImportModal = React.lazy(() => import('./PresentationImportModal'));
const DraftApprovalModal = React.lazy(() => import('./DraftApprovalModal'));
const SchedulePanel = React.lazy(() => import('./SchedulePanel'));

const LazyBoundary = ({ children }) => (
    <React.Suspense fallback={null}>{children}</React.Suspense>
);

const LyricDisplayApp = () => {
    logger.info('LyricDisplayApp mounted');
    const navigate = useNavigate();

    const { isOutputOn, setIsOutputOn, autoTurnOnOutput } = useOutputState();
    const showSelectedLineHighlight = useLyricsStore((state) => state.showSelectedLineHighlight ?? true);
    const setShowSelectedLineHighlight = useLyricsStore((state) => state.setShowSelectedLineHighlight);
    const { lyrics, lyricsFileName, rawLyricsContent, chordChart, selectedLine, lyricsTimestamps, pendingSavedVersion, selectLine, setLyrics, setLyricsSections, setLineToSection, setRawLyricsContent, setChordChart, setLyricsFileName, setBibleVersion, setSongMetadata, setLyricsTimestamps, clearPendingSavedVersion, addToLyricsHistory, songMetadata } = useLyricsState();
    const autoGroupLines = useLyricsStore((s) => s.autoGroupLines);
    const { settings: performanceSettings } = usePerformanceSettings();
    const { settings: output1Settings, updateSettings: updateOutput1Settings } = useOutput1Settings();
    const { settings: output2Settings, updateSettings: updateOutput2Settings } = useOutput2Settings();
    const { settings: stageSettings, updateSettings: updateStageSettings } = useStageSettings();
    const { darkMode, setDarkMode } = useDarkModeState();
    const { setSetlistModalOpen, setlistModalOpen, setlistFiles, setSetlistFiles } = useSetlistState();
    const isDesktopApp = useIsDesktopApp();
    const { settings: autoplaySettings, setSettings: setAutoplaySettings } = useAutoplaySettings();
    const { hasSeenIntelligentAutoplayInfo, setHasSeenIntelligentAutoplayInfo } = useIntelligentAutoplayState();
    const { outputs, createCustomOutput, deleteCustomOutput } = useOutputRegistry();
    const [showNewOutputForm, setShowNewOutputForm] = useState(false);
    const [outputToDelete, setOutputToDelete] = useState(null);
    const [newOutputName, setNewOutputName] = useState('');
    const [newOutputType, setNewOutputType] = useState('regular');
    const [newOutputSource, setNewOutputSource] = useState('output1');
    const { sidebarCollapsed, setSidebarCollapsed, sidebarWidth, setSidebarWidth } = useSidebarState();
    const { settingsCollapsed, setSettingsCollapsed } = useSettingsState();
    const { headerCompact, setHeaderCompact } = useHeaderState();
    const [sidebarOverflowOpen, setSidebarOverflowOpen] = useState(false);
    const [isResizing, setIsResizing] = useState(false);

    const startResizing = useCallback((e) => {
        e.preventDefault();
        setIsResizing(true);
    }, []);

    const stopResizing = useCallback(() => {
        setIsResizing(false);
    }, []);

    const resize = useCallback((e) => {
        if (isResizing) {
            const newWidth = e.clientX;
            if (newWidth > 320 && newWidth < 800) {
                setSidebarWidth(newWidth);
            }
        }
    }, [isResizing, setSidebarWidth]);

    useEffect(() => {
        if (isResizing) {
            window.addEventListener('mousemove', resize);
            window.addEventListener('mouseup', stopResizing);
        } else {
            window.removeEventListener('mousemove', resize);
            window.removeEventListener('mouseup', stopResizing);
        }
        return () => {
            window.removeEventListener('mousemove', resize);
            window.removeEventListener('mouseup', stopResizing);
        };
    }, [isResizing, resize, stopResizing]);

    const defaultLayout = useLyricsStore((s) => s.defaultLayout);
    const uiScale = useLyricsStore((s) => s.uiScale);
    const [contentType, setContentType] = useState(() => defaultLayout === 'bible-sidebar' ? 'bible' : 'lyrics');
    const [showBibleSidebar, setShowBibleSidebar] = useState(() => defaultLayout === 'bible-sidebar');
    const isBibleMode = contentType === 'bible';
    // Live content indicator — what is actually loaded/displayed (song vs bible),
    // independent of which sidebar tab is open.
    const liveContentMode = useLyricsStore((s) => s.contentMode);
    const { addBible, setActiveBible, activeBibleId, activeReference, selectedVerses, setReference, setSelectedVerses, getVerseText, getFormattedReference, bibles, addToBibleHistory, logBibleVerseRequest, bibleMetadata, defaultBibleId } = useBibleStore();

    const bibleIds = useMemo(
        () => orderBibleMetadata(bibleMetadata, defaultBibleId).map((m) => m.id),
        [bibleMetadata, defaultBibleId]
    );


    useDarkModeSync(darkMode, setDarkMode);

    const { showToast, muted, toggleMute } = useToast();
    const { showModal } = useModal();

    const fileInputRef = useRef(null);
    const scrollableSettingsRef = useRef(null);
    useMenuShortcuts(navigate, fileInputRef);

    const { socket, emitOutputToggle, emitShowState, emitTickerAdd, emitTickerRemove, emitTickerClear, emitTickerShow, emitLineUpdate, emitLyricsLoad, emitStyleUpdate, emitSetlistAdd, emitSetlistClear, emitSetlistLoad, emitAutoplayStateUpdate, emitOutputRegistryUpdate, emitBibleVerseLoaded, emitFreeNoteLoaded, emitContentModeUpdate, emitFileNameUpdate, emitContentLoaded, connectionStatus, authStatus, forceReconnect, refreshAuthToken, isConnected, isAuthenticated, ready } = useControlSocket();
    const { hasHydrated } = useSessionHydration();
    const { applyForMode: applyModeTemplates } = useOutputTemplateSync();
    const { outputActions } = useOutputAutomationState();

    const triggerOutputAutomation = useCallback((nextState) => {
        void runAllOutputActions(outputActions, nextState);
    }, [outputActions]);

    const setOutputState = useCallback((nextState) => {
        setIsOutputOn(nextState);
        emitOutputToggle(nextState);
        triggerOutputAutomation(nextState);
    }, [emitOutputToggle, setIsOutputOn, triggerOutputAutomation]);

    const { enabled: freeNotesEnabled } = useFreeNotesEnabled();
    const { showState, setShowState } = useShowControlState();
    const { tickerQueue, tickerActiveId } = useTickerState();
    const announcementTargetOutputKey = useLyricsStore((s) => s.announcementTargetOutputKey || 'all');
    const setAnnouncementTargetOutput = useLyricsStore((s) => s.setAnnouncementTargetOutput);
    const { enabled: bibleVerseEditorEnabled } = useBibleVerseEditorEnabled();

    // Square controls pill: library tab click sets browse tab AND declares
    // live mode + templates. Pill is independent — it sets live mode only
    // and never touches the library.
    const handleDeclareContentMode = useCallback((nextMode) => {
        const targetMode = (!freeNotesEnabled && nextMode === 'freenote') ? 'song' : nextMode;
        const m = targetMode === 'bible' ? 'bible' : (freeNotesEnabled && targetMode === 'freenote') ? 'freenote' : 'song';
        useLyricsStore.getState().selectMode?.(m);
        applyModeTemplates(m, { force: true, manual: true });
    }, [applyModeTemplates, freeNotesEnabled]);

    const handleLibrarySelect = useCallback((nextType) => {
        const t = nextType === 'bible' ? 'bible' : (freeNotesEnabled && nextType === 'freenote') ? 'freenote' : 'lyrics';
        setContentType(t);
        const m = t === 'bible' ? 'bible' : t === 'freenote' ? 'freenote' : 'song';
        useLyricsStore.getState().selectMode?.(m);
        applyModeTemplates(m, { force: true, manual: true });
    }, [applyModeTemplates, freeNotesEnabled]);

    // Fallback when Free Notes is disabled in user preferences while active
    useEffect(() => {
        if (!freeNotesEnabled) {
            if (contentType === 'freenote') {
                setContentType('lyrics');
            }
            if (liveContentMode === 'freenote') {
                handleDeclareContentMode('song');
            }
        }
    }, [freeNotesEnabled, contentType, liveContentMode, handleDeclareContentMode]);

    useEffect(() => {
        if (!ready || !emitOutputRegistryUpdate) return;
        const registryState = useLyricsStore.getState();
        emitOutputRegistryUpdate({
            customOutputs: registryState.customOutputs,
            customOutputSettings: registryState.customOutputSettings,
            customOutputEnabled: registryState.customOutputEnabled,
        });
        // Intentionally NOT depending on `outputs`: the server echoes this
        // event back via the outputRegistryUpdate handler, which updates the
        // store and produces a new `outputs` reference. Depending on it would
        // re-trigger this effect and create an infinite emit <-> receive loop.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ready, emitOutputRegistryUpdate]);

    const handleBibleVerseSelect = useCallback((verseData) => {
        const rawSlides = Array.isArray(verseData.slides) && verseData.slides.length > 0
            ? verseData.slides
            : [verseData.text];
        // Drop empty slides — an empty slide produces a reference-only line
        // ("John 3:23" with no body) on Stage/Output. Fall back to raw text.
        const nonEmpty = (rawSlides || []).map((t) => String(t ?? '')).filter((t) => t.trim().length > 0);
        const fallbackText = String(verseData.text || verseData.fullText || '').trim();
        const slideTexts = nonEmpty.length > 0 ? nonEmpty : (fallbackText ? [fallbackText] : []);
        logger.info('Bible verse select', {
            reference: verseData.reference,
            bible: verseData.bible || '',
            rawSlides: Array.isArray(verseData.slides) ? verseData.slides.length : 0,
            usableSlides: slideTexts.length,
            textLen: fallbackText.length,
        });
        if (slideTexts.length === 0) {
            logger.error('Bible verse has no text — not sending to outputs', { reference: verseData.reference, bible: verseData.bible || '' });
            showToast({
                title: 'Verse text missing',
                message: `${verseData.reference || 'Verse'} has no text in ${verseData.bible || 'this translation'}. Check the Bible import.`,
                variant: 'warning',
            });
            return;
        }
        const requestedSlideIndex = Number.isInteger(verseData.slideIndex) ? verseData.slideIndex : 0;
        const selectedSlideIndex = Math.min(Math.max(requestedSlideIndex, 0), slideTexts.length - 1);
        const lines = slideTexts.map((slideText) => `${slideText}\n\n${verseData.reference}`);
        const formattedVerse = lines.join('\n\n');
        const fullVerseText = verseData.fullText || slideTexts.join(' ');

        // Dual-translation parallel display (#16): when a secondary
        // translation is linked, resolve the same passage from it
        // (versification-offset aware) and attach pre-split slides.
        // Readers without pair support ignore `secondary` — the primary
        // path above is byte-identical to single-translation behavior.
        // `parallelHidden` drops `secondary` entirely, which is the same
        // single-translation shape outputs already handle.
        let parallelSecondary = useBibleStore.getState().parallelHidden ? null : sanitizeParallelPayload(verseData.secondary);
        if (!parallelSecondary) {
            try {
                const bibleState = useBibleStore.getState();
                const linkedId = bibleState.linkedBibleId;
                if (linkedId && linkedId !== bibleState.activeBibleId && bibleState.activeReference) {
                    const secondaryFullText = bibleState.getParallelVerseText?.() || '';
                    if (secondaryFullText.trim()) {
                        const lyricsState = useLyricsStore.getState();
                        const geometry = resolveBibleGeometry(lyricsState.output1Settings || {});
                        const bSettings = bibleState.settings || {};
                        const secondarySlides = splitBibleTextIntoSlides(secondaryFullText, {
                            splitLongVerses: Boolean(bSettings.splitLongVerses),
                            method: bSettings.splitMethod || 'nearest-punctuation',
                            maxChars: Number(bSettings.longVersesChars || 100),
                            tolerance: Number(bSettings.longVersesTolerance || 0),
                            geometry,
                        });
                        const linkedBible = bibleState.getLinkedBible?.();
                        const linkedName = linkedBible?.name || bibleState.bibleMetadata?.[linkedId]?.name || '';
                        parallelSecondary = sanitizeParallelPayload({
                            bible: linkedName,
                            text: secondarySlides[0] || secondaryFullText,
                            fullText: secondaryFullText,
                            slides: secondarySlides,
                        });
                    }
                }
            } catch (err) {
                logger.warn('Parallel secondary resolve failed — sending primary only', { error: err?.message });
                parallelSecondary = null;
            }
        }

        if (autoTurnOnOutput && !isOutputOn) {
            setOutputState(true);
        }

        // Atomic bible switch — one store action, no transient Song. Only valid commands.
        const store = useLyricsStore.getState();
        // Capture what is currently displayed before this send replaces it:
        // a later-slide send of the same verse is slide navigation, while a
        // later-slide send of another verse is a new request worth logging.
        const previousReference = store.lyricsFileName;
        const previousContentMode = store.contentMode;
        if (store.loadBibleVerse) {
          store.loadBibleVerse({
            reference: verseData.reference,
            text: verseData.text,
            fullText: fullVerseText,
            slides: slideTexts,
            slideIndex: selectedSlideIndex,
            bible: verseData.bible || '',
            bibleId: verseData.bible || '',
            lines,
            rawText: formattedVerse,
            ...(parallelSecondary ? { secondary: parallelSecondary } : {}),
          });
        } else {
          setLyrics(lines);
          setRawLyricsContent(formattedVerse);
          selectLine(selectedSlideIndex);
        }
        // keep raw/select in sync for legacy listeners
        setRawLyricsContent(formattedVerse);
        selectLine(selectedSlideIndex);

        // Single source of truth: the server fans bibleVerseLoaded out to
        // lyricsLoad + lineUpdate + fileNameUpdate + contentModeUpdate.
        // Emitting those separately too flipped outputs song -> bible and
        // applied templates twice per click.
        if (emitBibleVerseLoaded) emitBibleVerseLoaded({ reference: verseData.reference, bible: verseData.bible || '', slideIndex: selectedSlideIndex, slides: slideTexts, text: verseData.text, ...(parallelSecondary ? { secondary: parallelSecondary } : {}) });
        else if (socket && socket.connected) socket.emit('bibleVerseLoaded', { reference: verseData.reference, bible: verseData.bible || '', slideIndex: selectedSlideIndex, slides: slideTexts, text: verseData.text, ...(parallelSecondary ? { secondary: parallelSecondary } : {}) });

        const bibleState = useBibleStore.getState();
        const structuredReference = bibleState.activeReference
            ? {
                ...bibleState.activeReference,
                verses: bibleState.selectedVerses,
                bibleId: bibleState.activeBibleId,
            }
            : null;
        try {
            const ob = useOnboardStore.getState();
            ob.completeTask('bible');
            ob.logAction(`Opened Bible: ${verseData.reference || 'verse'}`);
        } catch { /* ignore */ }

        queueMicrotask(() => {
            if (shouldLogBibleVerseRequest({ slideIndex: selectedSlideIndex, reference: verseData.reference, previousReference, previousContentMode })) {
                addToBibleHistory(verseData.reference, fullVerseText, structuredReference);
                logBibleVerseRequest(verseData.reference);
            }

            if (isDesktopApp && !setlistFiles.some(f => f.displayName === verseData.reference)) {
                emitSetlistAdd([{
                    name: `${verseData.reference}.txt`,
                    content: formattedVerse,
                    lastModified: Date.now(),
                    metadata: {
                        type: 'bible',
                        reference: verseData.reference,
                        slideCount: slideTexts.length,
                        bibleId: bibleState.activeBibleId,
                        structuredReference,
                    }
                }]);
            }
        });
    }, [setLyrics, setLyricsFileName, setBibleVersion, setRawLyricsContent, selectLine, emitLineUpdate, emitLyricsLoad, emitBibleVerseLoaded, emitFileNameUpdate, addToBibleHistory, logBibleVerseRequest, isDesktopApp, setlistFiles, emitSetlistAdd, socket, autoTurnOnOutput, isOutputOn, setOutputState]);

    // Hiding the parallel translation mid-service must take effect on the
    // verse already on screen, not just the next one sent. Re-broadcast the
    // live verse without `secondary` — the same single-translation shape
    // receivers already handle, so nothing new to parse.
    const parallelHidden = useBibleStore((s) => Boolean(s.parallelHidden));
    useEffect(() => {
        if (!parallelHidden) return;
        const store = useLyricsStore.getState();
        if (store.contentMode !== 'bible' || !store.lyricsFileName) return;

        const slides = (store.lyrics || [])
            .map((line) => String(line ?? '').split('\n\n')[0])
            .filter((text) => text.trim().length > 0);
        if (slides.length === 0) return;

        const slideIndex = Math.min(Math.max(store.selectedLine ?? 0, 0), slides.length - 1);
        const payload = {
            reference: store.lyricsFileName,
            bible: store.bibleVersion || '',
            slideIndex,
            slides,
            text: slides[slideIndex],
        };
        if (emitBibleVerseLoaded) emitBibleVerseLoaded(payload);
        else if (socket && socket.connected) socket.emit('bibleVerseLoaded', payload);
    }, [parallelHidden, emitBibleVerseLoaded, socket]);

    const handleFreeNoteBroadcast = useCallback((noteData) => {
        const title = noteData?.title || 'Free Note';
        const rawSlides = Array.isArray(noteData?.slides) && noteData.slides.length > 0
            ? noteData.slides
            : (Array.isArray(noteData?.lines) && noteData.lines.length > 0 ? noteData.lines : [noteData?.rawText || '']);
        const slideTexts = (rawSlides || []).map((t) => String(t ?? '')).filter((t) => t.trim().length > 0);
        if (slideTexts.length === 0) {
            showToast({
                title: 'Note text missing',
                message: 'Please enter text for the note before broadcasting.',
                variant: 'warning',
            });
            return;
        }

        const requestedSlideIndex = Number.isInteger(noteData.slideIndex)
            ? noteData.slideIndex
            : (Number.isInteger(noteData.selectedLine) ? noteData.selectedLine : 0);
        const selectedSlideIndex = Math.min(Math.max(requestedSlideIndex, 0), slideTexts.length - 1);
        const rawText = noteData.rawText || slideTexts.join('\n\n---\n\n');

        if (autoTurnOnOutput && !isOutputOn) {
            setOutputState(true);
        }

        const store = useLyricsStore.getState();
        if (store.loadFreeNote) {
            store.loadFreeNote({
                title,
                rawText,
                lines: slideTexts,
                slides: slideTexts,
                selectedLine: selectedSlideIndex,
                targetSlideIndex: selectedSlideIndex,
                id: noteData.id || `freenote_${Date.now()}`,
            });
        } else {
            setLyrics(slideTexts);
            setRawLyricsContent(rawText);
            selectLine(selectedSlideIndex);
            setLyricsFileName(title);
            store.setContentMode('freenote');
        }
        setRawLyricsContent(rawText);
        selectLine(selectedSlideIndex);

        // Apply Free Note mode template to outputs
        applyModeTemplates('freenote', { force: true, manual: true });

        const payload = {
            id: noteData.id || `freenote_${Date.now()}`,
            title,
            rawText,
            slides: slideTexts,
            lines: slideTexts,
            slideIndex: selectedSlideIndex,
            selectedLine: selectedSlideIndex,
        };

        if (emitFreeNoteLoaded) emitFreeNoteLoaded(payload);
        else if (socket && socket.connected) socket.emit('freeNoteLoaded', payload);

        if (emitLyricsLoad) emitLyricsLoad(slideTexts);
        else if (socket && socket.connected) socket.emit('lyricsLoad', slideTexts);

        if (emitLineUpdate) emitLineUpdate({ index: selectedSlideIndex });
        else if (socket && socket.connected) socket.emit('lineUpdate', { index: selectedSlideIndex });

        if (emitFileNameUpdate) emitFileNameUpdate(title);
        else if (socket && socket.connected) socket.emit('fileNameUpdate', title);

        if (emitContentModeUpdate) emitContentModeUpdate('freenote', '', title);
        else if (socket && socket.connected) socket.emit('contentModeUpdate', { mode: 'freenote', bibleVersion: '', fileName: title });
    }, [autoTurnOnOutput, isOutputOn, setOutputState, setLyrics, setLyricsFileName, setRawLyricsContent, selectLine, applyModeTemplates, emitFreeNoteLoaded, socket, emitLyricsLoad, emitLineUpdate, emitFileNameUpdate, emitContentModeUpdate, showToast]);

    const handleFileUpload = useFileUpload();
    const handleMultipleFileUpload = useMultipleFileUpload();
    const loadSetlist = useSetlistLoader({ setlistFiles, setSetlistFiles, emitSetlistAdd, emitSetlistClear });

    const { activeTab, setActiveTab } = useOutputSettings({
        output1Settings,
        output2Settings,
        stageSettings,
        updateOutputSettings: (output, settings) => {
            if (output === 'output1') {
                updateOutput1Settings(settings);
            } else if (output === 'output2') {
                updateOutput2Settings(settings);
            } else if (output === 'stage') {
                updateStageSettings(settings);
            }
            emitStyleUpdate(output, settings);
            trackAction('settings_changed');
        },
        emitStyleUpdate,
    });

    const [onlineLyricsModalOpen, setOnlineLyricsModalOpen] = React.useState(false);
    const [onlineBibleModalOpen, setOnlineBibleModalOpen] = React.useState(false);
    const [rccgTphbModalOpen, setRccgTphbModalOpen] = React.useState(false);
    const [easyWorshipModalOpen, setEasyWorshipModalOpen] = React.useState(false);
    const [presentationModalOpen, setPresentationModalOpen] = React.useState(false);
    const [bibleChapterEditorOpen, setBibleChapterEditorOpen] = React.useState(false);
    const [onboardingOpen, setOnboardingOpen] = React.useState(false);
    const [onboardingMode, setOnboardingMode] = React.useState('tour');
    const [spotlightOpen, setSpotlightOpen] = React.useState(false);
    const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
    // Onboard event bridge: Preferences > Onboard section + `?` shortcut can open these.
    React.useEffect(() => {
        const openOnboarding = (e) => { setOnboardingMode(e?.detail?.mode === 'ai' ? 'ai' : 'tour'); setOnboardingOpen(true); };
        const openSpotlight = () => setSpotlightOpen(true);
        const openShortcuts = () => setShortcutsOpen(true);
        window.addEventListener('selah-open-onboarding', openOnboarding);
        window.addEventListener('selah-open-spotlight', openSpotlight);
        window.addEventListener('selah-open-shortcuts', openShortcuts);
        return () => {
            window.removeEventListener('selah-open-onboarding', openOnboarding);
            window.removeEventListener('selah-open-spotlight', openSpotlight);
            window.removeEventListener('selah-open-shortcuts', openShortcuts);
        };
    }, []);
    // `?` opens the shortcut cheat-sheet (when not typing).
    React.useEffect(() => {
        const onKey = (e) => {
            if (e.key !== '?' || e.shiftKey === false) return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            setShortcutsOpen(true);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
    React.useEffect(() => {
        if (!hasSeenOnboarding()) {
            const t = setTimeout(() => { setOnboardingMode('tour'); setOnboardingOpen(true); }, 800);
            return () => clearTimeout(t);
        }
    }, []);
    // Explain mode legend for teaching: plain-language toolbar guide.
    const explainMode = useOnboardStore((s) => s.explainMode);
    const headerContainerRef = useRef(null);

    const { containerRef: lyricsContainerRef, searchQuery, highlightedLineIndex, currentMatchIndex, totalMatches, handleSearch: baseHandleSearch, clearSearch, navigateToNextMatch, navigateToPreviousMatch } = useSearch(lyrics);

    const trackAction = React.useCallback(() => { }, []);

    React.useEffect(() => {
        const handleResetScroll = () => {
            if (lyricsContainerRef.current) {
                lyricsContainerRef.current.scrollTop = 0;
            }
        };

        window.addEventListener('reset-lyrics-scroll', handleResetScroll);
        return () => window.removeEventListener('reset-lyrics-scroll', handleResetScroll);
    }, [lyricsContainerRef]);

    const handleSearch = React.useCallback((query) => {
        baseHandleSearch(query);
        if (query) {
            trackAction('search_performed');
        }
    }, [baseHandleSearch, trackAction]);

    const hasLyrics = lyrics && lyrics.length > 0;
    const { isDragging, dragFileCount, handleDragEnter, handleDragLeave, handleDragOver, handleDrop } = useDragAndDrop({
        handleFileUpload,
        handleMultipleFileUpload,
        loadSetlist,
        clearSearch,
        trackAction,
        showToast
    });

    const { useIconOnlyButtons } = useResponsiveWidth(headerContainerRef, hasLyrics);

    React.useEffect(() => {
        if (!hasLyrics) return;
        if (hasValidTimestamps(lyricsTimestamps)) return;
        if (!rawLyricsContent) return;

        const looksLikeLrc = /\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/.test(rawLyricsContent);
        if (!looksLikeLrc) return;

        try {
            const _storeState = useLyricsStore.getState();
            const parsed = parseLrcContent(rawLyricsContent, { enableSplitting: _storeState.enableLyricSplitting ?? true, enableNormalGrouping: _storeState.autoGroupLines ?? true });
            const lengthsMatch = Array.isArray(parsed?.processedLines) && parsed.processedLines.length === lyrics.length;

            if (lengthsMatch && Array.isArray(parsed.timestamps) && parsed.timestamps.length > 0) {
                setLyricsTimestamps(parsed.timestamps);
                if (parsed.sections && parsed.lineToSection) {
                    setLyricsSections(parsed.sections);
                    setLineToSection(parsed.lineToSection);
                }
            }
        } catch (err) {
            console.warn('Failed to regenerate timestamps from stored lyrics:', err);
        }
    }, [hasLyrics, lyrics, lyricsTimestamps, rawLyricsContent, setLyricsSections, setLineToSection, setLyricsTimestamps]);

    const {
        autoplayActive,
        intelligentAutoplayActive,
        remoteAutoplayActive,
        handleAutoplayToggle,
        handleIntelligentAutoplayToggle,
        handleOpenAutoplaySettings
    } = useAutoplayManager({
        lyrics,
        lyricsTimestamps,
        selectedLine,
        autoplaySettings,
        setAutoplaySettings,
        selectLine,
        emitLineUpdate,
        showToast,
        showModal,
        hasLyrics,
        lyricsFileName,
        hasSeenIntelligentAutoplayInfo,
        setHasSeenIntelligentAutoplayInfo,
        emitAutoplayStateUpdate,
        isConnected,
        isAuthenticated,
        ready,
        clientType: 'desktop'
    });

    const { handleSyncOutputs } = useSyncOutputs({
        isConnected,
        isAuthenticated,
        ready,
        lyrics,
        chordChart,
        selectedLine,
        isOutputOn,
        showState,
        emitLyricsLoad,
        emitLineUpdate,
        emitOutputToggle,
        emitShowState,
        emitStyleUpdate,
        output1Settings,
        output2Settings,
        showToast
    });

    const { processLoadedLyrics, handleImportFromLibrary: baseHandleImportFromLibrary } = useLyricsLoader({
        setLyrics,
        setLyricsSections,
        setLineToSection,
        setRawLyricsContent,
        setChordChart,
        setLyricsTimestamps,
        selectLine,
        setLyricsFileName,
        setSongMetadata,
        emitLyricsLoad,
        emitFileNameUpdate,
        emitContentLoaded,
        socket,
        showToast
    });

    const handleImportFromLibrary = React.useCallback(async (params) => {
        const result = await baseHandleImportFromLibrary(params, lyrics);
        if (result) {
            trackAction('song_loaded');
        }
        return result;
    }, [baseHandleImportFromLibrary, lyrics, trackAction]);

    useElectronListeners({
        processLoadedLyrics,
        showToast,
        setEasyWorshipModalOpen,
        setPresentationModalOpen,
        setlistFiles,
        setSetlistFiles,
        emitSetlistAdd,
        emitSetlistClear
    });

    const hotReloadEnabled = useLyricsStore((s) => s.hotReloadEnabled ?? true);
    const setHotReloadEnabled = useLyricsStore((s) => s.setHotReloadEnabled);

    useLyricsHotReload({
        processLoadedLyrics,
        emitLineUpdate,
        showToast,
    });

    useEffect(() => {
        const handleBibleSetlistLoad = async (event) => {
            const metadata = event?.detail?.metadata;
            if (metadata?.type !== 'bible') return;

            setContentType('bible');

            const storedReference = metadata.structuredReference;
            const bibleId = metadata.bibleId
                || storedReference?.bibleId
                || storedReference?.id
                || null;

            if (bibleId) {
                await setActiveBible(bibleId);
            }

            const state = useBibleStore.getState();
            const bible = state.bibles[state.activeBibleId];
            let reference = storedReference;
            let verses = storedReference?.verses?.[0] || [];

            // Older setlists only stored the formatted reference string.
            if ((!reference?.book || verses.length === 0) && metadata.reference && bible) {
                const result = searchBibleExperimental(bible, metadata.reference, state.bibles, 1, state.defaultBibleId, false)[0];
                if (result) {
                    reference = {
                        id: result.bibleId || state.activeBibleId,
                        book: result.book,
                        chapters: [String(result.chapter)],
                        verses: [result.verses || [result.verse]],
                    };
                    verses = reference.verses[0];
                }
            }

            if (!reference?.book || !reference?.chapters?.length || verses.length === 0) return;

            setReference({
                ...reference,
                id: bibleId || reference.id || state.activeBibleId,
                verses: [verses],
            });
            setSelectedVerses([verses]);
        };

        window.addEventListener('setlist-load-success', handleBibleSetlistLoad);
        return () => window.removeEventListener('setlist-load-success', handleBibleSetlistLoad);
    }, [setActiveBible, setReference, setSelectedVerses]);

    React.useEffect(() => {
        if (window.__pendingLyricsLoad) {
            const pendingData = window.__pendingLyricsLoad;
            delete window.__pendingLyricsLoad;

            processLoadedLyrics(pendingData);
        }
    }, [processLoadedLyrics]);

    const handledSavedVersionRef = React.useRef(null);

    React.useEffect(() => {
        if (!pendingSavedVersion) return;

        const key = pendingSavedVersion.createdAt || `${pendingSavedVersion.filePath || ''}-${pendingSavedVersion.fileName || ''}`;
        if (handledSavedVersionRef.current === key) {
            clearPendingSavedVersion();
            return;
        }
        handledSavedVersionRef.current = key;

        const { rawText, fileName: savedBaseName, filePath, extension } = pendingSavedVersion;
        const safeBaseName = savedBaseName || lyricsFileName || 'lyrics';
        const savedFileName = `${safeBaseName}.${extension || 'txt'}`;

        const loadSavedVersion = async () => {
            try {
                await processLoadedLyrics(
                    {
                        content: rawText || '',
                        fileName: savedFileName,
                        filePath: filePath || null,
                        fileType: extension || 'txt'
                    },
                    { fallbackFileName: savedFileName }
                );
            } catch (error) {
                console.error('Failed to reload saved lyrics from pending version:', error);
                showToast({
                    title: 'Load failed',
                    message: 'Could not load the last saved lyrics file.',
                    variant: 'error'
                });
            }
        };

        showToast({
            title: 'Load saved lyrics',
            message: 'You recently saved a lyrics file. Do you want to load that into the control panel?',
            variant: 'info',
            duration: 7000,
            actions: [
                { label: 'Load lyrics', onClick: loadSavedVersion }
            ]
        });

        clearPendingSavedVersion();
    }, [pendingSavedVersion, clearPendingSavedVersion, processLoadedLyrics, rawLyricsContent, lyricsFileName, showToast]);

    const openFileDialog = async () => {
        if (!isAuthenticated) {
            showToast({
                title: 'Authentication Required',
                message: 'Please wait for authentication to complete before loading files.',
                variant: 'warning'
            });
            return;
        }

        try {
            if (window?.electronAPI?.loadLyricsFile) {
                const navigatorResult = await openLyricsFileThroughNavigator();
                if (navigatorResult) return;
                const result = await window.electronAPI.loadLyricsFile();
                if (result && result.success && result.content) {
                    const payload = { content: result.content, fileName: result.fileName, filePath: result.filePath };
                    window.dispatchEvent(new CustomEvent('lyrics-opened', { detail: payload }));
                    return;
                }
                if (result && result.canceled) return;
            }
        } catch { }
        fileInputRef.current?.click();
    };

    const handleCreateNewSong = () => {
        navigate('/new-song?mode=new');
    };

    const handleEditLyrics = () => {
        navigate('/new-song?mode=edit');
    };

    const handleOpenSetlist = () => {
        setSetlistModalOpen(true);
        try { const ob = useOnboardStore.getState(); ob.completeTask('setlist'); ob.logAction('Opened setlist'); } catch { /* ignore */ }
    };

    const handleOpenOnlineLyricsSearch = () => {
        setOnlineLyricsModalOpen(true);
    };

    const handleOpenOnlineBibleSearch = () => {
        setOnlineBibleModalOpen(true);
    };

    const handleCloseOnlineBibleSearch = () => {
        setOnlineBibleModalOpen(false);
    };

    const handleCloseOnlineLyricsSearch = () => {
        setOnlineLyricsModalOpen(false);
    };

    const handleOpenRccgTphbDb = useCallback(() => {
        setRccgTphbModalOpen(true);
    }, []);

    // Bible chapter editor (Alt+Shift+Enter) — Bible panel only.
    const contentTypeRef = useRef(contentType);
    contentTypeRef.current = contentType;
    useEffect(() => {
        const openEditor = () => {
            if (contentTypeRef.current !== 'bible') return;
            if (!useLyricsStore.getState().bibleVerseEditorEnabled) return;
            setBibleChapterEditorOpen(true);
        };
        window.addEventListener(BIBLE_CHAPTER_EDITOR_EVENT, openEditor);
        return () => window.removeEventListener(BIBLE_CHAPTER_EDITOR_EVENT, openEditor);
    }, []);

    const handleFileChange = async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const fileName = file.name.toLowerCase();
        if (fileName.endsWith('.ldset')) {
            await loadSetlist(file);
            return;
        }
        // Run-sheet files (.ldsch) go to the scheduler panel, not the lyric loader.
        if (fileName.endsWith('.ldsch')) {
            try {
                const parsed = parseScheduleDocument(await file.text());
                if (parsed.ok) {
                    window.dispatchEvent(new CustomEvent('schedule-file-load', { detail: { parsed } }));
                } else {
                    showToast({ title: 'Run-sheet not loaded', message: parsed.error, variant: 'error' });
                }
            } catch {
                showToast({ title: 'Run-sheet not loaded', message: 'Could not read that .ldsch file.', variant: 'error' });
            }
            return;
        }

        const success = await handleFileUpload(file);
        if (success) {
            clearSearch();
            trackAction('song_loaded');
        }
    };

    const handleLineSelect = (index) => {
        selectLine(index);
        emitLineUpdate(index);
        trackAction('lyrics_edited');
        try {
            const ob = useOnboardStore.getState();
            ob.completeTask('fire');
            ob.logAction(`Fired slide ${typeof index === 'number' ? index + 1 : index} of “${lyricsFileName || 'lyrics'}”`);
        } catch { /* ignore */ }

        // Auto turn on display if enabled
        if (autoTurnOnOutput && !isOutputOn) {
            setOutputState(true);
        }

        // Add current song to history when a line is selected (projected)
        if (songMetadata?.title) {
            addToLyricsHistory(songMetadata, lyrics);
        }

        // Auto-add to setlist if not already there
        if (isDesktopApp && lyricsFileName && !setlistFiles.some(f => f.displayName === lyricsFileName)) {
            const hasLrcTimestamps = lyricsTimestamps && lyricsTimestamps.length > 0;
            const extension = hasLrcTimestamps ? '.lrc' : '.txt';
            emitSetlistAdd([{
                name: `${lyricsFileName}${extension}`,
                content: rawLyricsContent,
                lastModified: Date.now(),
                metadata: songMetadata || { title: lyricsFileName }
            }]);
        }

    };

    const handleToggle = () => {
        if (!isConnected || !isAuthenticated || !ready) {
            showToast({
                title: 'Connection Required',
                message: 'Cannot control output - not connected or authenticated.',
                variant: 'warning'
            });
            return;
        }

        const nextState = !isOutputOn;
        setOutputState(nextState);
        if (nextState) {
            trackAction('output_opened');
        }
    };

    const handleClearOutput = React.useCallback(() => {
        selectLine(null);
        emitLineUpdate(null);
    }, [emitLineUpdate, selectLine]);

    // Explicit show-control (feature #18): LIVE / CLEAR / BLACKOUT / LOGO.
    // The legacy master toggle above keeps working — it maps ON/OFF onto this
    // machine without disturbing an explicit CLEAR / LOGO choice.
    const handleShowState = React.useCallback((next) => {
        if (!isConnected || !isAuthenticated || !ready) {
            showToast({
                title: 'Connection Required',
                message: 'Cannot control outputs - not connected or authenticated.',
                variant: 'warning'
            });
            return;
        }
        setShowState(next);
        emitShowState?.(next);
        triggerOutputAutomation(next === 'LIVE');
        try {
            const ob = useOnboardStore.getState();
            if (next === 'LIVE') ob.completeTask('live');
            if (next === 'CLEAR') ob.completeTask('clear');
            ob.logAction(`Show state → ${next}`);
        } catch { /* ignore */ }
        if (next === 'LIVE') {
            trackAction('output_opened');
        }
    }, [emitShowState, isAuthenticated, isConnected, ready, setShowState, showToast, triggerOutputAutomation]);

    const handleTickerAdd = React.useCallback((text, targetOutput = announcementTargetOutputKey, style) => {
        emitTickerAdd?.({ text, targetOutput: targetOutput === 'all' ? null : targetOutput, style });
    }, [announcementTargetOutputKey, emitTickerAdd]);

    const handleTickerRemove = React.useCallback((id) => {
        emitTickerRemove?.(id);
    }, [emitTickerRemove]);

    const handleTickerClear = React.useCallback(() => {
        emitTickerClear?.();
    }, [emitTickerClear]);

    const handleTickerShow = React.useCallback((id) => {
        emitTickerShow?.(id);
    }, [emitTickerShow]);

    const handleFirePreview = React.useCallback((index) => {
        const target = index ?? useLyricsStore.getState().previewSelectedLine ?? null;
        if (target === null || target === undefined) return;
        handleLineSelect(target);
    }, [handleLineSelect]);

    const handleOutputTabSwitch = React.useCallback((tab) => {
        if (!outputs.some((output) => output.key === tab)) return;
        setActiveTab(tab);
        if (scrollableSettingsRef.current) {
            scrollableSettingsRef.current.scrollTop = 0;
        }
    }, [outputs, setActiveTab]);

    React.useEffect(() => {
        if (!outputs.some((output) => output.key === activeTab)) {
            setActiveTab('output1');
        }
    }, [outputs, activeTab, setActiveTab]);

    const newOutputSlug = slugifyOutputName(newOutputName);
    const duplicateOutput = outputs.some((output) => output.slug === newOutputSlug);
    const reservedOutput = isReservedOutputSlug(newOutputSlug);
    const newOutputSources = outputs.filter((output) => output.type === newOutputType);
    const newOutputError = !newOutputName.trim()
        ? 'Name is required.'
        : !newOutputSlug
            ? 'Use at least one letter or number.'
            : reservedOutput
                ? 'This URL is reserved by the app.'
                : duplicateOutput
                    ? 'That output URL already exists.'
                    : '';

    React.useEffect(() => {
        if (!newOutputSources.some((output) => output.key === newOutputSource)) {
            setNewOutputSource(newOutputSources[0]?.key || (newOutputType === 'stage' ? 'stage' : 'output1'));
        }
    }, [newOutputSource, newOutputSources, newOutputType]);

    const handleCreateCustomOutput = React.useCallback(() => {
        if (newOutputError) return;
        const outputKey = createCustomOutput({
            name: newOutputName.trim(),
            slug: newOutputSlug,
            type: newOutputType,
            sourceOutputKey: newOutputSource,
        });
        const registryState = useLyricsStore.getState();
        emitOutputRegistryUpdate?.({
            customOutputs: registryState.customOutputs,
            customOutputSettings: registryState.customOutputSettings,
            customOutputEnabled: registryState.customOutputEnabled,
        });
        setActiveTab(outputKey);
        setShowNewOutputForm(false);
        setNewOutputName('');
        showToast({
            title: 'Output created',
            message: `Open /${newOutputSlug} to view ${newOutputName.trim()}.`,
            variant: 'success',
        });
    }, [createCustomOutput, emitOutputRegistryUpdate, newOutputError, newOutputName, newOutputSlug, newOutputSource, newOutputType, setActiveTab, showToast]);

    const handleDeleteRequest = React.useCallback((outputKey) => {
        const output = outputs.find((o) => o.key === outputKey);
        if (!output || output.builtIn) return;
        setOutputToDelete(output);
    }, [outputs]);

    const handleConfirmDelete = React.useCallback(() => {
        if (!outputToDelete) return;
        const outputKey = outputToDelete.key;
        if (activeTab === outputKey) {
            setActiveTab('output1');
        }
        deleteCustomOutput(outputKey);
        const registryState = useLyricsStore.getState();
        emitOutputRegistryUpdate?.({
            customOutputs: registryState.customOutputs,
            customOutputSettings: registryState.customOutputSettings,
            customOutputEnabled: registryState.customOutputEnabled,
        });
        showToast({
            title: 'Output deleted',
            message: `${outputToDelete.name} has been removed.`,
            variant: 'success',
        });
        setOutputToDelete(null);
    }, [outputToDelete, activeTab, deleteCustomOutput, setActiveTab, emitOutputRegistryUpdate, showToast]);

    const handleCancelDelete = React.useCallback(() => setOutputToDelete(null), []);

    const { handleAddToSetlist, disabled: addDisabled, title: addTitle } = useSetlistActions(emitSetlistAdd);

    const handleNavigateSetlistPrevious = React.useCallback(() => {
        if (!hasLyrics || setlistFiles.length === 0) {
            showToast({
                title: 'No files in setlist',
                message: 'Add songs to your setlist to use navigation',
                variant: 'info'
            });
            return;
        }

        const currentIndex = setlistFiles.findIndex(file => file.displayName === lyricsFileName);
        if (currentIndex === -1) {
            showToast({
                title: 'Not in setlist',
                message: 'Current song is not in the setlist',
                variant: 'info'
            });
            return;
        }

        const previousIndex = currentIndex > 0 ? currentIndex - 1 : setlistFiles.length - 1;
        const previousFile = setlistFiles[previousIndex];

        if (previousFile) {
            emitSetlistLoad({ fileId: previousFile.id, enableNormalGrouping: autoGroupLines, enableSplitting: useLyricsStore.getState().enableLyricSplitting ?? true });
        }
    }, [hasLyrics, setlistFiles, lyricsFileName, emitSetlistLoad, showToast, autoGroupLines]);

    const handleNavigateSetlistNext = React.useCallback(() => {
        if (!hasLyrics || setlistFiles.length === 0) {
            showToast({
                title: 'No files in setlist',
                message: 'Add songs to your setlist to use navigation',
                variant: 'info'
            });
            return;
        }

        const currentIndex = setlistFiles.findIndex(file => file.displayName === lyricsFileName);
        if (currentIndex === -1) {
            showToast({
                title: 'Not in setlist',
                message: 'Current song is not in the setlist',
                variant: 'info'
            });
            return;
        }

        const nextIndex = currentIndex < setlistFiles.length - 1 ? currentIndex + 1 : 0;
        const nextFile = setlistFiles[nextIndex];

        if (nextFile) {
            emitSetlistLoad({ fileId: nextFile.id, enableNormalGrouping: autoGroupLines, enableSplitting: useLyricsStore.getState().enableLyricSplitting ?? true });
        }
    }, [hasLyrics, setlistFiles, lyricsFileName, emitSetlistLoad, showToast, autoGroupLines]);

    useKeyboardShortcuts({
        hasLyrics,
        lyrics,
        lyricsTimestamps,
        selectedLine,
        handleLineSelect,
        handleToggle,
        handleShowState,
        handleAutoplayToggle,
        handleIntelligentAutoplayToggle,
        handleClearOutput,
        handleOutputTabSwitch,
        searchQuery,
        clearSearch,
        totalMatches,
        highlightedLineIndex,
        handleOpenSetlist,
        handleOpenOnlineLyricsSearch,
        handleOpenRccgTphbDb,
        handleOpenFileDialog: openFileDialog,
        handleCreateNewSong,
        handleEditLyrics,
        handleAddToSetlist,
        handleNavigateSetlistPrevious,
        handleNavigateSetlistNext,
        setContentType,
        contentType,
        activeBibleId,
        bibleIds,
        setActiveBible
    });

    // Hardware MIDI + OSC automation: bridge main-process commands onto the
    // same handlers as manual control (socket permission checks unchanged).
    // A live ref keeps hardware callbacks fresh without re-subscribing.
    const hardwareCommandsRef = React.useRef(null);
    hardwareCommandsRef.current = {
        hasLyrics,
        lyrics,
        selectedLine,
        handleLineSelect,
        handleToggle,
        handleClearOutput,
        handleNavigateSetlistPrevious,
        handleNavigateSetlistNext,
    };
    useHardwareCommands(hardwareCommandsRef);

    const iconButtonClass = (disabled = false) => {
        const base = 'p-2.5 font-medium sanctuary-icon-button';
        return disabled ? `${base} cursor-not-allowed opacity-50` : base;
    };

    const handleToggleDarkMode = useCallback(() => {
        const next = !darkMode;
        setDarkMode(next);
        window.electronAPI?.setDarkMode?.(next);
        window.electronAPI?.syncNativeDarkMode?.(next);
    }, [darkMode, setDarkMode]);

    if (!isDesktopApp) {
        return <MobileLayout />;
    }

    if (!hasHydrated) {
        return (
            <div className="flex h-full min-h-screen items-center justify-center bg-gray-50 text-gray-400 text-sm">
                Restoring session…
            </div>
        );
    }

    return (
        <>
            {!isBibleMode && <ConnectionBackoffBanner darkMode={darkMode} />}
            {onboardingOpen && (
                <OnboardingModal darkMode={darkMode} initialMode={onboardingMode} onClose={() => setOnboardingOpen(false)} />
            )}
            {spotlightOpen && (
                <SpotlightTour darkMode={darkMode} onClose={() => setSpotlightOpen(false)} />
            )}
            {shortcutsOpen && (
                <ShortcutsOverlay darkMode={darkMode} onClose={() => setShortcutsOpen(false)} />
            )}
            {isDesktopApp && !isBibleMode && (
                <LazyBoundary>
                    <DraftApprovalModal darkMode={darkMode} />
                </LazyBoundary>
            )}
            <div style={{ zoom: uiScale / 100 }} className={`flex h-full min-h-0 font-sans sanctuary-shell ${darkMode ? 'dark' : ''} ${performanceSettings.reducedGraphics ? 'reduced-graphics' : ''}`}>
                    {/* Left Sidebar - Control Panel */}
                    {(!isBibleMode || showBibleSidebar) && (
                    <div 
                        className={`flex-shrink-0 flex flex-col h-full min-h-0 overflow-y-auto overflow-x-hidden sanctuary-sidebar transition-[width] duration-300 ease-in-out relative ${sidebarCollapsed ? 'w-0 overflow-hidden border-none shadow-none' : ''}`}
                        style={{ width: sidebarCollapsed ? 0 : sidebarWidth, scrollbarGutter: 'stable' }}
                    >
                        {/* Resize Handle */}
                        {!sidebarCollapsed && (
                            <div
                                onMouseDown={startResizing}
                                className={`absolute -right-1 top-0 bottom-0 w-2 cursor-col-resize z-30 group flex items-center justify-center hover:bg-blue-500/20 transition-colors`}
                            >
                                <div className={`w-1 h-full bg-transparent group-hover:bg-blue-500/30 transition-colors`}></div>
                                <GripVertical className="absolute w-4 h-4 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                            </div>
                        )}

                        {/* Fixed Header Section */}
                        <div className="flex-shrink-0 p-5 pb-0 sanctuary-header-surface relative">
                            {/* Collapse Toggle */}
                            <button
                                onClick={() => setSidebarCollapsed(true)}
                                className={`absolute -right-3 top-10 z-20 h-6 w-6 rounded-full border bg-background flex items-center justify-center shadow-sm hover:bg-accent transition-opacity ${sidebarCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
                                title="Collapse Sidebar"
                            >
                                <PanelLeftClose className="w-3.5 h-3.5" />
                            </button>

                            {/* Header — content toggle + compact live declarer */}
                            <div className="mb-4 flex min-w-0 items-center gap-2">
                                {/* Content Type Toggle */}
                                <div data-onboard="library" className={`flex min-w-0 flex-1 rounded-lg overflow-hidden border p-1 ${darkMode ? 'border-gray-700 bg-gray-950/40' : 'border-gray-200 bg-gray-100'}`}>
                                        <button
                                            onClick={() => handleLibrarySelect('lyrics')}
                                            className={`min-w-0 flex-1 truncate px-2 py-1.5 text-xs font-medium transition-colors ${contentType === 'lyrics'
                                                ? darkMode ? 'bg-blue-600 text-white' : 'bg-black text-white'
                                                : darkMode ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-white text-gray-700 hover:bg-gray-50'
                                                }`}
                                        >
                                            Songs
                                        </button>
                                        <button
                                            onClick={() => handleLibrarySelect('bible')}
                                            className={`min-w-0 flex-1 truncate px-2 py-1.5 text-xs font-medium transition-colors flex items-center justify-center gap-1 ${contentType === 'bible'
                                                ? darkMode ? 'bg-blue-600 text-white' : 'bg-black text-white'
                                                : darkMode ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-white text-gray-700 hover:bg-gray-50'
                                                }`}
                                        >
                                            <BookText className="h-3 w-3 shrink-0" />
                                            <span className="truncate">Bible</span>
                                        </button>
                                        {freeNotesEnabled && (
                                            <button
                                                onClick={() => handleLibrarySelect('freenote')}
                                                className={`min-w-0 flex-1 truncate px-2 py-1.5 text-xs font-medium transition-colors flex items-center justify-center gap-1 ${contentType === 'freenote'
                                                    ? darkMode ? 'bg-amber-600 text-white' : 'bg-amber-500 text-black font-semibold'
                                                    : darkMode ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-white text-gray-700 hover:bg-gray-50'
                                                    }`}
                                            >
                                                <FileText className="h-3 w-3 shrink-0" />
                                                <span className="truncate">Notes</span>
                                            </button>
                                        )}
                                    </div>

                                    {/* Live declarer — compact pill, amber ring + live dot: deliberately
                                        distinct from the neutral content toggle above so live state is unmistakable. */}
                                    <Tooltip content={<span>Declare what is on display. Applies your Song{freeNotesEnabled ? ', Bible, or Free Notes' : ' or Bible'} templates now — the app won't decide for you.</span>} side="bottom">
                                        <div data-onboard="live" role="group" aria-label="Currently showing" className={`flex shrink-0 items-center gap-0.5 rounded-full border p-0.5 ${darkMode ? 'border-amber-500/60 bg-gray-950/40' : 'border-amber-400 bg-amber-50'}`}>
                                            <button
                                                onClick={() => handleDeclareContentMode('song')}
                                                title="Showing a song — apply Song templates"
                                                aria-pressed={liveContentMode === 'song'}
                                                className={`flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold transition-colors ${liveContentMode === 'song'
                                                    ? darkMode ? 'bg-amber-500 text-black' : 'bg-amber-400 text-black'
                                                    : darkMode ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-800'
                                                    }`}
                                            >
                                                {liveContentMode === 'song' && <span className="h-1.5 w-1.5 rounded-full bg-black" aria-hidden="true" />}
                                                Song
                                            </button>
                                            <button
                                                onClick={() => handleDeclareContentMode('bible')}
                                                title="Showing a Bible verse — apply Bible templates"
                                                aria-pressed={liveContentMode === 'bible'}
                                                className={`flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold transition-colors ${liveContentMode === 'bible'
                                                    ? darkMode ? 'bg-amber-500 text-black' : 'bg-amber-400 text-black'
                                                    : darkMode ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-800'
                                                    }`}
                                            >
                                                {liveContentMode === 'bible' && <span className="h-1.5 w-1.5 rounded-full bg-black" aria-hidden="true" />}
                                                Bible
                                            </button>
                                            {freeNotesEnabled && (
                                                <button
                                                    onClick={() => handleDeclareContentMode('freenote')}
                                                    title="Showing Free Notes — apply Free Notes templates"
                                                    aria-pressed={liveContentMode === 'freenote'}
                                                    className={`flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold transition-colors ${liveContentMode === 'freenote'
                                                        ? darkMode ? 'bg-amber-500 text-black' : 'bg-amber-400 text-black'
                                                        : darkMode ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-800'
                                                        }`}
                                                >
                                                    {liveContentMode === 'freenote' && <span className="h-1.5 w-1.5 rounded-full bg-black" aria-hidden="true" />}
                                                    Notes
                                                </button>
                                            )}
                                        </div>
                                    </Tooltip>
                            </div>

                            {/* Load and Create Buttons */}
                            <div className="flex gap-3 mb-4">
                                <Tooltip content={<span>Load a .txt or .lrc lyrics file from your computer - <strong>Ctrl+O</strong></span>} side="right">
                                    <button
                                        className="flex-1 py-3 px-4 sanctuary-primary-action rounded-xl font-semibold transition-all duration-200 flex items-center justify-center gap-2"
                                        onClick={openFileDialog}
                                    >
                                        <FolderOpen className="w-5 h-5" />
                                        Load lyrics file (.txt, .lrc)
                                    </button>
                                </Tooltip>
                                <Tooltip content={<span>Open the song canvas to create new lyrics from scratch - <strong>Ctrl+N</strong></span>} side="left">
                                    <button
                                        className="h-[52px] w-[52px] sanctuary-icon-button rounded-xl font-medium transition-all duration-200 flex items-center justify-center"
                                        onClick={handleCreateNewSong}
                                    >
                                        <FilePlusCorner className="w-5 h-5" />
                                    </button>
                                </Tooltip>
                            </div>

                            {/* Quick tools + connection — relocated below Load so the
                                header row (Songs/Bible + Showing) never overflows. */}
                            <div data-onboard="toolbar" className={`mb-4 flex flex-wrap items-center gap-1 rounded-xl border px-2 py-1.5 ${darkMode ? 'border-gray-700 bg-gray-950/40' : 'border-gray-200 bg-gray-50'}`}>
                                <Tooltip content={<span>Search and import lyrics from online providers - <strong>Ctrl+Shift+O</strong></span>} side="bottom">
                                    <button
                                        className={iconButtonClass(false)}
                                        onClick={handleOpenOnlineLyricsSearch}
                                    >
                                        <Globe className="w-4 h-4" />
                                    </button>
                                </Tooltip>

                                <Tooltip content={<span>View and manage your song setlist (up to 50 songs) - <strong>Ctrl+Shift+S</strong></span>} side="bottom">
                                    <button
                                            className={iconButtonClass(false)}
                                            onClick={handleOpenSetlist}
                                        >
                                            <ListMusic className="w-4 h-4" />
                                        </button>
                                    </Tooltip>

                                    <Tooltip content="Force refresh all output displays with current state" side="bottom">
                                        <button
                                            disabled={!isConnected || !isAuthenticated || !ready}
                                            className={iconButtonClass(!isConnected || !isAuthenticated || !ready)}
                                            onClick={handleSyncOutputs}
                                        >
                                            <RefreshCw className="w-4 h-4" />
                                        </button>
                                </Tooltip>

                                <Tooltip content="Take the guided tour or get an AI setup prompt" side="bottom">
                                    <button
                                        className={iconButtonClass(false)}
                                        aria-label="Open onboarding and setup help"
                                        onClick={() => { setOnboardingMode('tour'); setOnboardingOpen(true); }}
                                    >
                                        <GraduationCap className="w-4 h-4" />
                                    </button>
                                </Tooltip>

                                <Tooltip content="Run the pre-service health check (outputs, server, connection, backgrounds, Bible)" side="bottom">
                                    <button
                                        className={iconButtonClass(false)}
                                        aria-label="Run pre-service health check"
                                        onClick={() => showModal({
                                            title: 'Pre-Service Health Check',
                                            component: 'PreServiceHealth',
                                            variant: 'info',
                                            size: 'large',
                                            dismissLabel: 'Close',
                                        })}
                                    >
                                        <HeartPulse className="w-4 h-4" />
                                    </button>
                                </Tooltip>

                                <Popover open={sidebarOverflowOpen} onOpenChange={setSidebarOverflowOpen}>
                                    <Tooltip content="More actions" side="bottom">
                                        <PopoverTrigger asChild>
                                            <button className={iconButtonClass(false)} aria-label="More actions">
                                                <MoreHorizontal className="w-4 h-4" />
                                            </button>
                                        </PopoverTrigger>
                                    </Tooltip>
                                    <PopoverContent align="end" className="w-64 p-2">
                                        <div className="space-y-1">
                                            <button
                                                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-left transition-colors hover:bg-accent hover:text-accent-foreground"
                                                onClick={() => {
                                                    handleOpenOnlineLyricsSearch();
                                                    setSidebarOverflowOpen(false);
                                                }}
                                            >
                                                <Globe className="w-4 h-4" />
                                                Online lyrics search
                                            </button>
                                            <button
                                                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-left transition-colors hover:bg-accent hover:text-accent-foreground"
                                                onClick={() => {
                                                    handleOpenOnlineBibleSearch();
                                                    setSidebarOverflowOpen(false);
                                                }}
                                            >
                                                <BookOpen className="w-4 h-4" />
                                                Bible search &amp; import
                                            </button>
                                            <button
                                                className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-sm text-left transition-colors hover:bg-accent hover:text-accent-foreground"
                                                onClick={() => {
                                                    setRccgTphbModalOpen(true);
                                                    setSidebarOverflowOpen(false);
                                                }}
                                            >
                                                <span className="flex items-center gap-3"><Database className="w-4 h-4" />RCCGTPHB song DB</span>
                                                <span className="text-[11px] text-gray-400">Ctrl+Shift+D</span>
                                            </button>
                                            <button
                                                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-left transition-colors hover:bg-accent hover:text-accent-foreground"
                                                onClick={() => {
                                                    toggleMute();
                                                    setSidebarOverflowOpen(false);
                                                }}
                                            >
                                                {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                                                {muted ? 'Unmute toast sounds' : 'Mute toast sounds'}
                                            </button>
                                            <button
                                                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-left transition-colors hover:bg-accent hover:text-accent-foreground"
                                                onClick={() => {
                                                    handleToggleDarkMode();
                                                    setSidebarOverflowOpen(false);
                                                }}
                                            >
                                                {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                                                {darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                                            </button>
                                            <button
                                                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-left transition-colors hover:bg-accent hover:text-accent-foreground"
                                                onClick={() => {
                                                    showModal({
                                                        title: 'User Preferences',
                                                        component: 'UserPreferences',
                                                        size: 'xl',
                                                        actions: [],
                                                    });
                                                    setSidebarOverflowOpen(false);
                                                }}
                                            >
                                                <Settings className="w-4 h-4" />
                                                User preferences
                                            </button>
                                        </div>
                                    </PopoverContent>
                                </Popover>

                                <div className="ml-auto">
                                    <AuthStatusIndicator
                                        authStatus={authStatus}
                                        connectionStatus={connectionStatus}
                                        onRetry={forceReconnect}
                                        onRefreshToken={refreshAuthToken}
                                        darkMode={darkMode}
                                    />
                                </div>
                            </div>

                            {/* Display on/off toggle */}
                            {explainMode && (
                                <div data-onboard="explain" className={`mb-4 rounded-xl border p-3 text-xs leading-relaxed ${darkMode ? 'border-blue-500/40 bg-blue-950/30 text-blue-200' : 'border-blue-300 bg-blue-50 text-blue-900'}`}>
                                    <span className="font-bold">💡 Explain mode:</span> Songs/Bible tabs pick <em>what to browse</em>; the amber pill declares <em>what's live</em>. Click a lyric row to show it. The dock below cuts between LIVE, CLEAR, BLACKOUT, LOGO. Turn this off in Preferences → Onboard.
                                </div>
                            )}
                            <div
                                className={`mb-4 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${darkMode ? 'border-gray-700 bg-gray-950/40 text-gray-300' : 'border-gray-200 bg-gray-50 text-gray-600'}`}
                                title={isOutputOn ? 'Display output is ON. Toggle to blackout all screens.' : 'Display output is OFF. Toggle to turn screens back on.'}
                            >
                                <Monitor className="h-4 w-4 flex-shrink-0" />
                                <span className="flex-1 font-semibold">
                                    Display
                                </span>
                                <Switch
                                    checked={isOutputOn}
                                    onCheckedChange={() => handleToggle()}
                                    aria-label="Toggle display output on or off"
                                />
                                <span className={`shrink-0 font-semibold ${isOutputOn ? 'text-green-500' : 'text-gray-400'}`}>
                                    {isOutputOn ? 'On' : 'Off'}
                                </span>
                            </div>
                            {/* Show control: Live / Clear / Blackout / Logo + announcements (feature #18),
                                wrapped in a collapsible dock so the block can be folded away. */}
                            <div data-onboard="show">
                            <ShowControlDock
                                showState={showState}
                                onSelect={handleShowState}
                                outputs={outputs}
                                queue={tickerQueue}
                                activeId={tickerActiveId}
                                targetOutput={announcementTargetOutputKey}
                                onTargetOutputChange={setAnnouncementTargetOutput}
                                onAdd={handleTickerAdd}
                                onRemove={handleTickerRemove}
                                onClear={handleTickerClear}
                                onShow={handleTickerShow}
                                darkMode={darkMode}
                                disabled={!isConnected || !isAuthenticated || !ready}
                            />
                            </div>
                            {/* Metronome — ported from FreeShow. A single horizontal row so it
                                spends width, not height, in the operator sidebar. */}
                            <MetronomeBar darkMode={darkMode} />
                            <input
                                type="file"
                                accept=".txt,.lrc"
                                ref={fileInputRef}
                                style={{ display: 'none' }}
                                onChange={handleFileChange}
                            />

                            {/* Current File Indicator — filename + live content type (song vs bible) */}
                            {hasLyrics && (
                                <div className="mb-3 space-y-2">
                                    <div className={`text-xs font-semibold flex items-center gap-2 rounded-lg px-3 py-2 border ${darkMode ? 'text-gray-300 border-gray-700 bg-gray-950/30' : 'text-gray-600 border-gray-200 bg-gray-50'}`}>
                                        <FileMusic className="w-4 h-4 flex-shrink-0" />
                                        <span className="truncate flex-1">{lyricsFileName}</span>
                                        <span
                                            title={liveContentMode === 'bible' ? 'Currently displaying a Bible verse' : 'Currently displaying a song'}
                                            className={`shrink-0 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full border ${liveContentMode === 'bible'
                                                ? (darkMode ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-amber-50 text-amber-700 border-amber-200')
                                                : (darkMode ? 'bg-sky-500/15 text-sky-300 border-sky-500/30' : 'bg-sky-50 text-sky-700 border-sky-200')}`}
                                        >
                                            {liveContentMode === 'bible' ? 'Bible' : 'Song'}
                                        </span>
                                    </div>
                                    {songMetadata?.filePath && (
                                        <div className={`flex items-center gap-2 rounded-lg px-3 py-1.5 border text-xs ${darkMode ? 'border-gray-700 bg-gray-950/30 text-gray-300' : 'border-gray-200 bg-gray-50 text-gray-600'}`}>
                                            <RefreshCw className="w-3.5 h-3.5 flex-shrink-0" />
                                            <span className="flex-1 truncate" title={songMetadata.filePath}>
                                                Auto-reload on file change
                                            </span>
                                            <Switch
                                                checked={hotReloadEnabled}
                                                onCheckedChange={(checked) => setHotReloadEnabled(checked)}
                                                aria-label="Toggle auto-reload on file change"
                                            />
                                            <span className={`shrink-0 font-semibold ${hotReloadEnabled ? 'text-green-500' : 'text-gray-400'}`}>
                                                {hotReloadEnabled ? 'On' : 'Off'}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Live output heartbeat strip (pre-service health) */}
                            <ConnectedOutputsStrip darkMode={darkMode} />

                            <div className={`border-t my-5 ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}></div>

                            {/* Output Tabs Header - Collapsible */}
                            <div className="flex items-center justify-between mb-4">
                                <h3 className={`text-[10px] font-bold uppercase tracking-[0.2em] ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>Output Settings</h3>
                                <button
                                    onClick={() => setSettingsCollapsed(!settingsCollapsed)}
                                    className={`p-1 rounded-md transition-colors ${darkMode ? 'hover:bg-gray-800 text-gray-500' : 'hover:bg-gray-100 text-gray-400'}`}
                                >
                                    {settingsCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                                </button>
                            </div>

                            <div className={`flex flex-col flex-1 min-h-0 ${settingsCollapsed ? 'hidden' : 'mb-5'}`}>
                                {/* Output Tabs */}
                            <div className="mb-5 space-y-3 flex-shrink-0">
                                <div className="flex items-center gap-2">
                                    <Tabs value={activeTab} onValueChange={handleOutputTabSwitch} className="min-w-0 flex-1">
                                        <TabsList className={`w-full p-1.5 min-h-11 h-auto gap-2 rounded-xl border flex flex-wrap ${darkMode ? 'bg-gray-950/40 text-gray-300 border-gray-700' : 'bg-gray-100 border-gray-200'}`}>
                                            {outputs.map((output) => (
                                                <div key={output.key} className="relative group flex-1 min-w-[84px] flex">
                                                    <TabsTrigger value={output.key} className={`flex-1 h-8 text-sm pr-6 group-[.has-delete]:pr-7 ${darkMode ? 'data-[state=active]:bg-white data-[state=active]:text-gray-900' : 'data-[state=active]:bg-black data-[state=active]:text-white'}`}>
                                                        <span className="truncate">{output.name}</span>
                                                    </TabsTrigger>
                                                    {!output.builtIn && (
                                                        <button
                                                            type="button"
                                                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDeleteRequest(output.key); }}
                                                            className={`absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center transition-all opacity-60 group-hover:opacity-100 hover:!opacity-100 ${darkMode ? 'hover:bg-red-900/60 text-gray-400 hover:text-red-300' : 'hover:bg-red-100 text-gray-400 hover:text-red-600'}`}
                                                            title={`Delete ${output.name}`}
                                                        >
                                                            <X className="w-3 h-3" />
                                                        </button>
                                                    )}
                                                </div>
                                            ))}
                                        </TabsList>
                                    </Tabs>
                                    <button
                                        type="button"
                                        onClick={() => setShowNewOutputForm((value) => !value)}
                                        className={`h-10 shrink-0 rounded-xl border px-3 text-sm font-semibold transition-colors ${darkMode ? 'border-gray-700 bg-gray-900 text-gray-100 hover:bg-gray-800' : 'border-gray-200 bg-white text-gray-900 hover:bg-gray-50'}`}
                                    >
                                        New Output
                                    </button>
                                </div>
                                {showNewOutputForm && (
                                    <div className={`rounded-xl border p-3 space-y-3 ${darkMode ? 'border-gray-800 bg-gray-950/40' : 'border-gray-200 bg-white'}`}>
                                        <div className="grid gap-2">
                                            <label className={`text-xs font-semibold uppercase tracking-[0.14em] ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Output name</label>
                                            <Input value={newOutputName} onChange={(event) => setNewOutputName(event.target.value)} placeholder="Main Screen" />
                                            <p className={`text-xs ${newOutputError ? (darkMode ? 'text-red-300' : 'text-red-600') : (darkMode ? 'text-gray-500' : 'text-gray-500')}`}>
                                                {newOutputError || `URL: /${newOutputSlug}`}
                                            </p>
                                        </div>
                                        <div className="grid grid-cols-2 gap-3">
                                            <div className="grid gap-2">
                                                <label className={`text-xs font-semibold uppercase tracking-[0.14em] ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Display type</label>
                                                <select value={newOutputType} onChange={(event) => setNewOutputType(event.target.value)} className={`h-9 rounded-md border px-3 text-sm ${darkMode ? 'border-gray-700 bg-gray-950 text-gray-100' : 'border-gray-200 bg-white text-gray-900'}`}>
                                                    <option value="regular">Regular</option>
                                                    <option value="stage">Stage</option>
                                                </select>
                                            </div>
                                            <div className="grid gap-2">
                                                <label className={`text-xs font-semibold uppercase tracking-[0.14em] ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Copy settings from</label>
                                                <select value={newOutputSource} onChange={(event) => setNewOutputSource(event.target.value)} className={`h-9 rounded-md border px-3 text-sm ${darkMode ? 'border-gray-700 bg-gray-950 text-gray-100' : 'border-gray-200 bg-white text-gray-900'}`}>
                                                    {newOutputSources.map((output) => <option key={output.key} value={output.key}>{output.name}</option>)}
                                                </select>
                                            </div>
                                        </div>
                                        <div className="flex justify-end gap-2">
                                            <Button variant="outline" size="sm" onClick={() => setShowNewOutputForm(false)}>Cancel</Button>
                                            <Button size="sm" disabled={Boolean(newOutputError)} onClick={handleCreateCustomOutput}>Create</Button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Scrollable Settings Panel */}
                        <div
                            data-onboard="outputs"
                            ref={scrollableSettingsRef}
                            className="flex-1 min-h-0 overflow-visible px-5 relative"
                            onScroll={(e) => {
                                const scrollTop = e.currentTarget.scrollTop;
                                const shadow = e.currentTarget.previousElementSibling;
                                if (shadow) {
                                    if (scrollTop > 10) {
                                        shadow.classList.add('shadow-md');
                                    } else {
                                        shadow.classList.remove('shadow-md');
                                    }
                                }
                            }}
                        >
                            {/* Tab Content */}
                            <div>
                                {outputs.some((output) => output.key === activeTab) && (
                                    <OutputSettingsPanel key={activeTab} outputKey={activeTab} />
                                )}
                            </div>
                            <div className="m-10"></div>
                        </div>
                        </div>
                    </div>
                    )}

                    {/* Right Main Area */}
                    <div className="flex-1 min-w-0 p-5 flex flex-col h-full min-h-0 relative">
                        {/* Expand Sidebar Toggle (Only visible when collapsed) */}
                        {sidebarCollapsed && (!isBibleMode || showBibleSidebar) && (
                            <button
                                onClick={() => setSidebarCollapsed(false)}
                                className={`absolute left-2 top-4 z-20 h-10 w-10 rounded-xl sanctuary-icon-button shadow-md flex items-center justify-center group animate-in fade-in slide-in-from-left-4 duration-300`}
                                title="Expand Sidebar"
                            >
                                <PanelLeftOpen className="w-5 h-5" />
                            </button>
                        )}

                        {/* Expand/Collapse Header Toggle */}
                        {hasLyrics && (
                            <button
                                onClick={() => setHeaderCompact(!headerCompact)}
                                className={`absolute right-4 top-4 z-20 h-8 w-8 rounded-lg sanctuary-icon-button shadow-sm flex items-center justify-center transition-all ${headerCompact ? 'opacity-100' : 'opacity-40 hover:opacity-100'}`}
                                title={headerCompact ? "Show Full Header" : "Compact Header"}
                            >
                                {headerCompact ? <Maximize2 className="w-4 h-4" /> : <Minimize2 className="w-4 h-4" />}
                            </button>
                        )}

                        {/* Fixed Header */}
                        <div className={`flex-shrink-0 min-w-0 transition-all duration-300 ease-in-out ${headerCompact ? 'max-h-0 opacity-0 mb-0 overflow-hidden' : 'max-h-[420px] opacity-100 mb-4 overflow-visible'}`} ref={headerContainerRef}>
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div className="min-w-0 flex-1 min-w-[200px]">
                                    <div className="flex items-center gap-2 flex-wrap min-w-0 max-w-full">
                                        {isBibleMode && (
                                            <div className={`inline-flex items-center gap-3 rounded-full border px-3 py-2 shadow-sm ${darkMode ? 'border-gray-700 bg-gray-800 text-gray-100' : 'border-gray-200 bg-white text-gray-800'}`}>
                                                <span className={`text-[11px] font-semibold uppercase tracking-wider ${showBibleSidebar ? (darkMode ? 'text-green-400' : 'text-green-600') : (darkMode ? 'text-gray-400' : 'text-gray-500')}`}>
                                                    Bible sidebar
                                                </span>
                                                <Switch
                                                    checked={showBibleSidebar}
                                                    onCheckedChange={setShowBibleSidebar}
                                                    className={`${darkMode
                                                        ? 'data-[state=checked]:bg-green-400 data-[state=unchecked]:bg-gray-600'
                                                        : 'data-[state=checked]:bg-black data-[state=unchecked]:bg-gray-300'
                                                        }`}
                                                />
                                                <button
                                                    onClick={() => setContentType('lyrics')}
                                                    className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wider transition-colors ${darkMode ? 'bg-gray-700 hover:bg-gray-600 text-gray-100' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'}`}
                                                >
                                                    Exit Bible
                                                </button>
                                            </div>
                                        )}
                                        {freeNotesEnabled && contentType === 'freenote' && (
                                            <div className={`inline-flex items-center gap-3 rounded-full border px-3 py-2 shadow-sm ${darkMode ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-amber-300 bg-amber-50 text-amber-800'}`}>
                                                <span className="text-[11px] font-semibold uppercase tracking-wider">
                                                    Free Notes Active
                                                </span>
                                                <button
                                                    onClick={() => setContentType('lyrics')}
                                                    className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wider transition-colors ${darkMode ? 'bg-gray-700 hover:bg-gray-600 text-gray-100' : 'bg-white hover:bg-amber-100 text-gray-700 border border-amber-200'}`}
                                                >
                                                    Exit Notes
                                                </button>
                                            </div>
                                        )}
                                        <HttpActionButtons darkMode={darkMode} />
                                    </div>
                                </div>
                                {!isBibleMode && (!freeNotesEnabled || contentType !== 'freenote') && hasLyrics && (
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                        {/* Intelligent Autoplay Button */}
                                        {hasValidTimestamps(lyricsTimestamps) && (
                                            <Tooltip content={
                                                remoteAutoplayActive || autoplayActive
                                                    ? "Autoplay is active"
                                                    : intelligentAutoplayActive
                                                        ? "Stop intelligent autoplay"
                                                        : "Start timestamp-based autoplay"
                                            } side="bottom">
                                                <button
                                                    onClick={handleIntelligentAutoplayToggle}
                                                    disabled={remoteAutoplayActive || autoplayActive}
                                                    className={`p-2 rounded-lg text-xs font-medium transition-all ${remoteAutoplayActive || autoplayActive
                                                        ? 'bg-gray-400 text-gray-600 cursor-not-allowed opacity-60'
                                                        : intelligentAutoplayActive
                                                            ? 'bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 text-white'
                                                            : darkMode
                                                                ? 'bg-gradient-to-r from-purple-600/20 to-blue-600/20 hover:from-purple-600/30 hover:to-blue-600/30 text-purple-300 border border-purple-500/30'
                                                                : 'bg-gradient-to-r from-purple-100 to-blue-100 hover:from-purple-200 hover:to-blue-200 text-purple-700 border border-purple-300'
                                                        }`}
                                                    title={intelligentAutoplayActive ? "Stop intelligent autoplay" : "Start intelligent autoplay"}
                                                >
                                                    <Sparkles className="w-4 h-4" />
                                                </button>
                                            </Tooltip>
                                        )}

                                        {/* Autoplay Button */}
                                        <Tooltip content={
                                            remoteAutoplayActive || intelligentAutoplayActive
                                                ? "Autoplay is active"
                                                : autoplayActive
                                                    ? "Stop autoplay"
                                                    : "Start automatic lyric progression"
                                        } side="bottom">
                                            <div className="relative flex">
                                                <button
                                                    onClick={handleAutoplayToggle}
                                                    disabled={remoteAutoplayActive || intelligentAutoplayActive}
                                                    className={`flex items-center gap-2 text-xs font-medium transition-all ${remoteAutoplayActive || intelligentAutoplayActive
                                                        ? useIconOnlyButtons
                                                            ? 'bg-gray-400 text-gray-600 cursor-not-allowed px-2 py-2 rounded-lg opacity-60'
                                                            : 'bg-gray-400 text-gray-600 cursor-not-allowed px-4 py-2 rounded-lg opacity-60'
                                                        : autoplayActive
                                                            ? useIconOnlyButtons
                                                                ? 'bg-green-600 hover:bg-green-700 text-white px-2 py-2 rounded-lg'
                                                                : 'bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg'
                                                            : useIconOnlyButtons
                                                                ? darkMode
                                                                    ? 'bg-gray-700 hover:bg-gray-600 text-gray-200 px-2 py-2 rounded-l-lg'
                                                                    : 'bg-gray-100 hover:bg-gray-200 text-gray-800 px-2 py-2 rounded-l-lg'
                                                                : darkMode
                                                                    ? 'bg-gray-700 hover:bg-gray-600 text-gray-200 px-4 py-2 rounded-l-lg'
                                                                    : 'bg-gray-100 hover:bg-gray-200 text-gray-800 px-4 py-2 rounded-l-lg'
                                                        }`}
                                                >
                                                    {autoplayActive ? (
                                                        <>
                                                            <Square className="w-4 h-4 flex-shrink-0 fill-current" />
                                                            {!useIconOnlyButtons && <span className="whitespace-nowrap">Autoplay</span>}
                                                        </>
                                                    ) : (
                                                        <>
                                                            <Play className="w-4 h-4 flex-shrink-0" />
                                                            {!useIconOnlyButtons && <span className="whitespace-nowrap">Autoplay</span>}
                                                        </>
                                                    )}
                                                </button>

                                                {/* Settings dropdown trigger */}
                                                {!autoplayActive && !remoteAutoplayActive && !intelligentAutoplayActive && (
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleOpenAutoplaySettings();
                                                        }}
                                                        className={`flex items-center justify-center ${useIconOnlyButtons ? 'px-1.5' : 'px-2'} py-2 rounded-r-lg transition-colors border-l ${autoplayActive
                                                            ? 'bg-green-600 hover:bg-green-700 text-white border-green-500'
                                                            : darkMode
                                                                ? 'bg-gray-700 hover:bg-gray-600 text-gray-200 border-gray-600'
                                                                : 'bg-gray-100 hover:bg-gray-200 text-gray-800 border-gray-300'
                                                            }`}
                                                        title="Autoplay settings"
                                                    >
                                                        <ChevronDown className="w-4 h-4" />
                                                    </button>
                                                )}
                                            </div>
                                        </Tooltip>

                                        {/* Add to Setlist Button */}
                                        <Tooltip content="Add current lyrics to your setlist for quick access during service" side="bottom">
                                            <button
                                                onClick={handleAddToSetlist}
                                                aria-disabled={addDisabled}
                                                className={`flex items-center gap-2 rounded-lg text-xs font-medium transition-colors ${addDisabled
                                                    ? (darkMode ? 'bg-gray-700 text-gray-500' : 'bg-gray-100 text-gray-400')
                                                    : (darkMode ? 'bg-gray-700 hover:bg-gray-600 text-gray-200' : 'bg-gray-100 hover:bg-gray-200 text-gray-800')
                                                    } ${useIconOnlyButtons ? 'px-2 py-2' : 'px-4 py-2'}`}
                                                title={addTitle}
                                                style={{ cursor: addDisabled ? 'not-allowed' : 'pointer', opacity: addDisabled ? 0.9 : 1 }}
                                            >
                                                <Plus className="w-4 h-4 flex-shrink-0" />
                                                {!useIconOnlyButtons && <span className="whitespace-nowrap overflow-hidden text-ellipsis">Add to Setlist</span>}
                                            </button>
                                        </Tooltip>

                                        {/* Edit Button */}
                                        <Tooltip content="Edit current lyrics in the song canvas editor" side="bottom">
                                            <button
                                                onClick={handleEditLyrics}
                                                className={`flex items-center gap-2 rounded-lg text-xs font-medium transition-colors ${darkMode
                                                    ? 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                                                    : 'bg-gray-100 hover:bg-gray-200 text-gray-800'
                                                    } ${useIconOnlyButtons ? 'px-2 py-2' : 'px-4 py-2'}`}
                                            >
                                                <Edit className="w-4 h-4 flex-shrink-0" />
                                                {!useIconOnlyButtons && <span className="whitespace-nowrap overflow-hidden text-ellipsis">Edit Lyrics</span>}
                                            </button>
                                        </Tooltip>

                                        {/* Song Info Button */}
                                        <Tooltip content="View song information" side="bottom">
                                            <button
                                                onClick={() => {
                                                    showModal({
                                                        title: 'Song Information',
                                                        component: 'SongInfoModal',
                                                        variant: 'info',
                                                        size: 'sm',
                                                        dismissLabel: 'Close'
                                                    });
                                                }}
                                                className={`p-2 rounded-lg transition-colors ${darkMode
                                                    ? 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                                                    : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                                                    }`}
                                                title="Song Information"
                                            >
                                                <Info className="w-4 h-4" />
                                            </button>
                                        </Tooltip>
                                    </div>
                                )}
                            </div>

                            {contentType === 'lyrics' && hasLyrics && (
                                <div className="mt-3 w-full">
                                    <SearchBar
                                        darkMode={darkMode}
                                        searchQuery={searchQuery}
                                        onSearch={handleSearch}
                                        totalMatches={totalMatches}
                                        currentMatchIndex={currentMatchIndex}
                                        onPrev={navigateToPreviousMatch}
                                        onNext={navigateToNextMatch}
                                        onClear={clearSearch}
                                        isOutputOn={isOutputOn}
                                        onToggleOutput={handleToggle}
                                        showSelectedLineHighlight={showSelectedLineHighlight}
                                        onToggleSelectedLineHighlight={setShowSelectedLineHighlight}
                                    />
                                </div>
                            )}
                        </div>

                        {/* Scrollable Content Area */}
                        <div className="sanctuary-content-surface flex-1 flex flex-col overflow-hidden relative">
                            {contentType === 'bible' ? (
                                <BibleControlPanel
                                    darkMode={darkMode}
                                    onSelectVerse={handleBibleVerseSelect}
                                />
                            ) : (freeNotesEnabled && contentType === 'freenote') ? (
                                <FreeNoteControlPanel
                                    darkMode={darkMode}
                                    onBroadcastNote={handleFreeNoteBroadcast}
                                    isOutputOn={isOutputOn}
                                    onToggleOutput={handleToggle}
                                />
                            ) : hasLyrics ? (
                                <div className="flex flex-1 flex-col overflow-hidden">
                                    <div className="px-4 pt-3">
                                        <PreviewSafetyBar darkMode={darkMode} onFirePreview={handleFirePreview} />
                                    </div>
                                <div
                                    data-onboard="slides"
                                    ref={lyricsContainerRef}
                                    className="flex-1 overflow-y-auto"
                                    onDrop={handleDrop}
                                    onDragOver={handleDragOver}
                                    onDragEnter={handleDragEnter}
                                    onDragLeave={handleDragLeave}
                                >
                                    <LyricsList
                                        searchQuery={searchQuery}
                                        highlightedLineIndex={highlightedLineIndex}
                                        onSelectLine={handleLineSelect}
                                    />
                                </div>
                                </div>
                            ) : (
                                /* Empty State - Drag and Drop */
                                <div
                                    className="flex-1 flex items-center justify-center p-4"
                                    onDrop={handleDrop}
                                    onDragOver={handleDragOver}
                                    onDragEnter={handleDragEnter}
                                    onDragLeave={handleDragLeave}
                                >
                                    <div className="text-center">
                                        <div className={`w-20 h-20 mx-auto mb-4 rounded-full flex items-center justify-center ${darkMode ? 'bg-gray-700' : 'bg-gray-200'
                                            }`}>
                                            <FolderOpen className={`w-10 h-10 ${darkMode ? 'text-gray-400' : 'text-gray-400'}`} />
                                        </div>
                                        <p className={`text-lg ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                                            Drag and drop lyric files (.txt, .lrc) or setlists (.ldset) here
                                        </p>
                                    </div>
                                </div>
                            )}

                            {/* Drag Overlay */}
                            {isDragging && (
                                <div
                                    className={`absolute inset-0 flex items-center justify-center z-50 pointer-events-none ${darkMode ? 'bg-gray-900/90' : 'bg-gray-900/80'
                                        }`}
                                >
                                    <div className="text-center px-8 py-10 rounded-2xl border-2 border-dashed max-w-md mx-auto"
                                        style={{
                                            borderColor: darkMode ? '#60a5fa' : '#3b82f6',
                                            backgroundColor: darkMode ? 'rgba(31, 41, 55, 0.95)' : 'rgba(255, 255, 255, 0.95)'
                                        }}
                                    >
                                        <div className={`w-20 h-20 mx-auto mb-5 rounded-full flex items-center justify-center ${darkMode ? 'bg-blue-500/20' : 'bg-blue-100'
                                            }`}>
                                            {dragFileCount === 1 ? (
                                                <FileText className={`w-10 h-10 ${darkMode ? 'text-blue-400' : 'text-blue-600'}`} />
                                            ) : (
                                                <ListMusic className={`w-10 h-10 ${darkMode ? 'text-blue-400' : 'text-blue-600'}`} />
                                            )}
                                        </div>
                                        <h3 className={`text-lg font-bold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                                            {dragFileCount === 1 ? 'Drop to load file' : `Drop ${dragFileCount} files`}
                                        </h3>
                                        <p className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                                            {dragFileCount === 1
                                                ? 'This file will be loaded into the app'
                                                : hasLyrics
                                                    ? `These files will be added to your ${setlistFiles.length > 0 ? 'current' : ''} setlist`
                                                : 'These files will be added to your setlist'}
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Sermon Assist rail — right-edge column beside the Right Main Area.
                    Returns null unless Sermon Assist is enabled (off by default),
                    so the default layout is unchanged. */}
                <SermonAssistPanel darkMode={darkMode} />

                {/* Setlist Modal */}
                {setlistModalOpen && (
                    <LazyBoundary>
                        <SetlistModal />
                    </LazyBoundary>
                )}

                {/* Service run-sheet clock (feature #01, beta) — self-gated by preference */}
                <LazyBoundary>
                    <SchedulePanel darkMode={!!darkMode} />
                </LazyBoundary>

                {/* Online Bible Search & Import Modal (conditionally mounted
                    like every other modal; unmounting aborts in-flight work). */}
                {onlineBibleModalOpen && (
                    <LazyBoundary>
                        <OnlineBibleSearchModal
                            isOpen={onlineBibleModalOpen}
                            onClose={handleCloseOnlineBibleSearch}
                            darkMode={darkMode}
                        />
                    </LazyBoundary>
                )}

                {/* Online Lyrics Search Modal */}
                {onlineLyricsModalOpen && (
                    <LazyBoundary>
                        <OnlineLyricsSearchModal
                            isOpen={onlineLyricsModalOpen}
                            onClose={handleCloseOnlineLyricsSearch}
                            darkMode={darkMode}
                            onImportLyrics={handleImportFromLibrary}
                        />
                    </LazyBoundary>
                )}

                {/* RCCGTPHB Song Database Modal */}
                {rccgTphbModalOpen && (
                    <LazyBoundary>
                        <RccgTphbSongModal
                            isOpen={rccgTphbModalOpen}
                            onClose={() => setRccgTphbModalOpen(false)}
                            darkMode={darkMode}
                            onImportLyrics={handleImportFromLibrary}
                            emitSetlistAdd={emitSetlistAdd}
                            selectLine={selectLine}
                            emitLineUpdate={emitLineUpdate}
                            isDesktopApp={isDesktopApp}
                        />
                    </LazyBoundary>
                )}

                {/* EasyWorship Import Modal */}
                {easyWorshipModalOpen && (
                    <LazyBoundary>
                        <EasyWorshipImportModal
                            isOpen={easyWorshipModalOpen}
                            onClose={() => setEasyWorshipModalOpen(false)}
                            darkMode={darkMode}
                        />
                    </LazyBoundary>
                )}

                {/* Document & Presentation Import Modal (feature #06) */}
                {presentationModalOpen && (
                    <LazyBoundary>
                        <PresentationImportModal
                            isOpen={presentationModalOpen}
                            onClose={() => setPresentationModalOpen(false)}
                            darkMode={darkMode}
                            onImportLyrics={handleImportFromLibrary}
                            emitSetlistAdd={emitSetlistAdd}
                            isDesktopApp={isDesktopApp}
                        />
                    </LazyBoundary>
                )}

                {/* Bible Verse Editor — Alt+Shift+Enter from the Bible panel (Experimental) */}
                {bibleVerseEditorEnabled && bibleChapterEditorOpen && (
                    <BibleChapterEditorModal
                        isOpen={bibleChapterEditorOpen}
                        onClose={() => setBibleChapterEditorOpen(false)}
                        onSend={handleBibleVerseSelect}
                        darkMode={darkMode}
                    />
                )}

                {/* Delete Output Confirmation */}
                {outputToDelete && (
                    <div className={`fixed inset-0 z-[2000] flex items-center justify-center p-4 bg-black/50 ${performanceSettings.gpuEffects !== false ? 'backdrop-blur-sm' : ''}`}>
                        <div className={`w-full max-w-md rounded-2xl border shadow-2xl p-6 animate-in fade-in zoom-in-95 ${darkMode ? 'bg-gray-900 border-gray-800 text-white' : 'bg-white border-gray-200 text-gray-900'}`}>
                            <div className="flex items-start gap-4">
                                <div className={`w-12 h-12 rounded-full flex items-center justify-center ${darkMode ? 'bg-red-900/40 text-red-400' : 'bg-red-100 text-red-600'}`}>
                                    <AlertTriangle className="w-6 h-6" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <h3 className="text-lg font-semibold">Delete Screen?</h3>
                                    <p className={`mt-2 text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                                        Are you sure you want to delete <span className="font-semibold">{outputToDelete.name}</span>? This will remove its settings and background media. This action cannot be undone.
                                    </p>
                                    <div className={`mt-3 rounded-lg px-3 py-2 text-xs font-mono ${darkMode ? 'bg-gray-950 text-gray-400 border border-gray-800' : 'bg-gray-50 text-gray-500 border border-gray-200'}`}>
                                        /{outputToDelete.slug} • {outputToDelete.type}
                                    </div>
                                </div>
                            </div>
                            <div className="mt-6 flex justify-end gap-3">
                                <Button variant="outline" onClick={handleCancelDelete}>Cancel</Button>
                                <Button variant="destructive" onClick={handleConfirmDelete} className="bg-red-600 hover:bg-red-700 text-white">
                                    <Trash2 className="w-4 h-4 mr-2" />
                                    Delete
                                </Button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </>
    );
};

export default LyricDisplayApp;
