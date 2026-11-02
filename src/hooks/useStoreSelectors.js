import { useStoreWithEqualityFn } from 'zustand/traditional';
import { shallow } from 'zustand/shallow';
import useLyricsStore from '../context/LyricsStore';
import useSpeechStore from '../context/SpeechStore';
import { getAllOutputs, getOutputEnabled, getOutputSettings, findOutputByKey } from '../utils/outputs';

export const useLyricsState = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            lyrics: state.lyrics,
            rawLyricsContent: state.rawLyricsContent,
            chordChart: state.chordChart,
            selectedLine: state.selectedLine,
            lyricsFileName: state.lyricsFileName,
            bibleVersion: state.bibleVersion,
            songMetadata: state.songMetadata,
            lyricsTimestamps: state.lyricsTimestamps,
            lyricsSections: state.lyricsSections,
            lineToSection: state.lineToSection,
            pendingSavedVersion: state.pendingSavedVersion,
            setLyrics: state.setLyrics,
            setLyricsSections: state.setLyricsSections,
            setLineToSection: state.setLineToSection,
            setRawLyricsContent: state.setRawLyricsContent,
            setChordChart: state.setChordChart,
            setLyricsFileName: state.setLyricsFileName,
            setBibleVersion: state.setBibleVersion,
            setSongMetadata: state.setSongMetadata,
            setLyricsTimestamps: state.setLyricsTimestamps,
            selectLine: state.selectLine,
            setPendingSavedVersion: state.setPendingSavedVersion,
            clearPendingSavedVersion: state.clearPendingSavedVersion,
            addToLyricsHistory: state.addToLyricsHistory,
        }),
        shallow
    );

export const useOutputState = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            isOutputOn: state.isOutputOn,
            setIsOutputOn: state.setIsOutputOn,
            autoTurnOnOutput: state.autoTurnOnOutput,
        }),
        shallow
    );

export const useShowControlState = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            showState: state.showState || 'LIVE',
            setShowState: state.setShowState,
            isOutputOn: state.isOutputOn,
            setIsOutputOn: state.setIsOutputOn,
        }),
        shallow
    );

export const useTickerState = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            tickerQueue: state.tickerQueue || [],
            tickerActiveId: state.tickerActiveId ?? null,
            setTickerQueue: state.setTickerQueue,
            setTickerActiveId: state.setTickerActiveId,
            setTickerState: state.setTickerState,
        }),
        shallow
    );

export const useIndividualOutputState = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            output1Enabled: state.output1Enabled,
            output2Enabled: state.output2Enabled,
            stageEnabled: state.stageEnabled,
            customOutputEnabled: state.customOutputEnabled,
            setOutput1Enabled: state.setOutput1Enabled,
            setOutput2Enabled: state.setOutput2Enabled,
            setStageEnabled: state.setStageEnabled,
            setCustomOutputEnabled: state.setCustomOutputEnabled,
        }),
        shallow
    );

export const useOutput1Settings = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            settings: state.output1Settings,
            updateSettings: (newSettings) =>
                state.updateOutputSettings('output1', newSettings),
        }),
        shallow
    );

export const useOutput2Settings = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            settings: state.output2Settings,
            updateSettings: (newSettings) =>
                state.updateOutputSettings('output2', newSettings),
        }),
        shallow
    );

export const useStageSettings = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            settings: state.stageSettings,
            updateSettings: (newSettings) =>
                state.updateOutputSettings('stage', newSettings),
        }),
        shallow
    );

export const useOutputRegistry = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            outputs: getAllOutputs(state),
            customOutputs: state.customOutputs,
            createCustomOutput: state.createCustomOutput,
            renameCustomOutput: state.renameCustomOutput,
            deleteCustomOutput: state.deleteCustomOutput,
        }),
        shallow
    );

export const useOutputDefinition = (outputKey) =>
    useLyricsStore((state) => findOutputByKey(state, outputKey));

export const useOutputSettingsByKey = (outputKey) =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            settings: getOutputSettings(state, outputKey),
            enabled: getOutputEnabled(state, outputKey),
            updateSettings: (newSettings) => state.updateOutputSettings(outputKey, newSettings),
            setEnabled: (enabled) => {
                if (outputKey === 'output1') return state.setOutput1Enabled(enabled);
                if (outputKey === 'output2') return state.setOutput2Enabled(enabled);
                if (outputKey === 'stage') return state.setStageEnabled(enabled);
                return state.setCustomOutputEnabled(outputKey, enabled);
            },
        }),
        shallow
    );

export const useDarkModeState = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            darkMode: state.darkMode,
            setDarkMode: state.setDarkMode,
        }),
        shallow
    );

export const useVimModeState = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            vimMode: state.vimMode,
            setVimMode: state.setVimMode,
        }),
        shallow
    );

export const useSetlistState = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            setlistFiles: state.setlistFiles,
            setlistModalOpen: state.setlistModalOpen,
            isDesktopApp: state.isDesktopApp,
            setSetlistFiles: state.setSetlistFiles,
            setSetlistModalOpen: state.setSetlistModalOpen,
            addSetlistFiles: state.addSetlistFiles,
            removeSetlistFile: state.removeSetlistFile,
            clearSetlist: state.clearSetlist,
            getSetlistFile: state.getSetlistFile,
            isSetlistFull: state.isSetlistFull,
            getAvailableSetlistSlots: state.getAvailableSetlistSlots,
        }),
        shallow
    );

export const useLyricsFileName = () =>
    useLyricsStore((state) => state.lyricsFileName);
export const useIsDesktopApp = () =>
    useLyricsStore((state) => state.isDesktopApp);
export const useSelectedLine = () =>
    useLyricsStore((state) => state.selectedLine);
export const useIsOutputOn = () =>
    useLyricsStore((state) => state.isOutputOn);
export const useDarkMode = () =>
    useLyricsStore((state) => state.darkMode);

export const useHasLyrics = () =>
    useLyricsStore((state) => Boolean(state.lyrics && state.lyrics.length > 0));

export const useSidebarState = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            sidebarCollapsed: state.sidebarCollapsed,
            setSidebarCollapsed: state.setSidebarCollapsed,
            sidebarWidth: state.sidebarWidth,
            setSidebarWidth: state.setSidebarWidth,
        }),
        shallow
    );

export const useSettingsState = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            settingsCollapsed: state.settingsCollapsed,
            setSettingsCollapsed: state.setSettingsCollapsed,
        }),
        shallow
    );

export const useHeaderState = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            headerCompact: state.headerCompact,
            setHeaderCompact: state.setHeaderCompact,
        }),
        shallow
    );

export const useAutoTurnOnOutput = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            autoTurnOnOutput: state.autoTurnOnOutput,
            setAutoTurnOnOutput: state.setAutoTurnOnOutput,
        }),
        shallow
    );

export const useOutputAutomationState = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            outputActions: state.outputActions,
            setOutputActions: state.setOutputActions,
            addOutputAction: state.addOutputAction,
            removeOutputAction: state.removeOutputAction,
            updateOutputAction: state.updateOutputAction,
        }),
        shallow
    );

export const useHttpActionButtonsState = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            buttons: state.httpActionButtons || [],
            setButtons: state.setHttpActionButtons,
            addButton: state.addHttpActionButton,
            removeButton: state.removeHttpActionButton,
            updateButton: state.updateHttpActionButton,
        }),
        shallow
    );

export const useCanAddToSetlist = () =>
    useLyricsStore(
        (state) =>
            state.isDesktopApp &&
            state.setlistFiles.length < 50 &&
            state.lyricsFileName != null &&
            state.lyrics != null &&
            state.lyrics.length > 0
    );

export const useAutoplaySettings = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            settings: state.autoplaySettings,
            setSettings: state.setAutoplaySettings,
        }),
        shallow
    );

export const useIntelligentAutoplayState = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            lyricsTimestamps: state.lyricsTimestamps,
            hasSeenIntelligentAutoplayInfo: state.hasSeenIntelligentAutoplayInfo,
            setHasSeenIntelligentAutoplayInfo: state.setHasSeenIntelligentAutoplayInfo,
        }),
        shallow
    );

export const usePerformanceSettings = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            settings: state.performanceSettings,
            setSettings: state.setPerformanceSettings,
        }),
        shallow
    );

export const useFHintEnabled = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            enabled: state.fHintEnabled ?? true,
            setEnabled: state.setFHintEnabled,
        }),
        shallow
    );

export const useFreeNotesEnabled = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            enabled: state.freeNotesEnabled ?? false,
            setEnabled: state.setFreeNotesEnabled,
        }),
        shallow
    );

export const useLyricContentSearchEnabled = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            enabled: state.lyricContentSearchEnabled ?? true,
            setEnabled: state.setLyricContentSearchEnabled,
        }),
        shallow
    );

export const useSchedulerEnabled = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            enabled: state.schedulerEnabled ?? false,
            setEnabled: state.setSchedulerEnabled,
        }),
        shallow
    );

export const useBibleVerseEditorEnabled = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            enabled: state.bibleVerseEditorEnabled ?? false,
            setEnabled: state.setBibleVerseEditorEnabled,
        }),
        shallow
    );

export const useSentenceSearchExperimental = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            enabled: state.sentenceSearchExperimental ?? false,
            setEnabled: state.setSentenceSearchExperimental,
        }),
        shallow
    );

export const usePreviewMultiviewState = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            previewMultiview: state.previewMultiview,
            setPreviewMultiview: state.setPreviewMultiview,
            setPreviewMultiviewTiles: state.setPreviewMultiviewTiles,
            setPreviewMultiviewColumns: state.setPreviewMultiviewColumns,
        }),
        shallow
    );

export const usePreviewSafetyState = () =>
    useStoreWithEqualityFn(
        useLyricsStore,
        (state) => ({
            previewMode: state.previewMode ?? false,
            previewSelectedLine: state.previewSelectedLine ?? null,
            setPreviewMode: state.setPreviewMode,
            setPreviewSelectedLine: state.setPreviewSelectedLine,
        }),
        shallow
    );

// --- Live Sermon Assist (Phase 0: contract only — nothing here starts anything) ---

export const useSpeechEnabled = () =>
    useStoreWithEqualityFn(
        useSpeechStore,
        (state) => ({
            enabled: state.enabled,
            setEnabled: state.setEnabled,
        }),
        shallow
    );

export const useSpeechMode = () =>
    useStoreWithEqualityFn(
        useSpeechStore,
        (state) => ({
            where: state.where,
            providerId: state.providerId,
            modelId: state.modelId,
            cloudProviderId: state.cloudProviderId,
        }),
        shallow
    );

export const useSpeechAudioSource = () =>
    useStoreWithEqualityFn(
        useSpeechStore,
        (state) => ({
            sourceId: state.audio.sourceId,
            sourceKind: state.audio.sourceKind,
            lastSourceLabel: state.audio.lastSourceLabel,
            setAudioSource: state.setAudioSource,
            clearAudioSource: state.clearAudioSource,
        }),
        shallow
    );
