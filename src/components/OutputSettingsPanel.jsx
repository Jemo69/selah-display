import React from 'react';
import { useDarkModeState, useOutputSettingsByKey, useOutputDefinition, usePerformanceSettings, useAutoTurnOnOutput } from '../hooks/useStoreSelectors';
import { useControlSocket } from '../context/ControlSocketProvider';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('OutputSettingsPanel');
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from '@/components/ui/tooltip';
import { ColorPicker } from "@/components/ui/color-picker";
import useToast from '../hooks/useToast';
import useModal from '../hooks/useModal';
import useAuth from '../hooks/useAuth';
import useOutputToggle from '../hooks/OutputSettingsPanel/useOutputToggle';
import useFullscreenBackground from '../hooks/OutputSettingsPanel/useFullscreenBackground';
import useAdvancedSectionPersistence from '../hooks/OutputSettingsPanel/useAdvancedSectionPersistence';
import useTypographyAndBands from '../hooks/OutputSettingsPanel/useTypographyAndBands';
import useFullscreenModeState from '../hooks/OutputSettingsPanel/useFullscreenModeState';
import { Type, PaintBucket, Contrast, TextCursorInput, Square, Frame, Move, AlignVerticalSpaceAround, ScreenShare, ListStart, ArrowUpDown, Rows3, MoveHorizontal, MoveVertical, Sparkles, Languages, Palette, Power, TextAlignJustify, SquareMenu, ArrowRightLeft, Save, Image, Video, X, Check, Zap, Gauge, MousePointer2, Book, PanelBottom } from 'lucide-react';
import FontSelect from './FontSelect';
import StageSettingsPanel from './StageSettingsPanel';
import NdiOutputSection from './NdiOutputSection';
import MotionBackgroundControls from './outputs/MotionBackgroundControls';
import { blurInputOnEnter, AdvancedToggle, LabelWithIcon, EmphasisRow, AlignmentRow } from './OutputSettingsShared';
import { sanitizeIntegerInput, sanitizeNumberInput } from '../utils/numberInput';
import { normalizeStreamBandHeightPercent, normalizeStreamBandBackdrop } from '../utils/streamBand.js';

const SettingRow = ({ icon, label, tooltip, children, rightClassName = 'flex items-center gap-2 justify-end', justifyEnd = true, darkMode }) => (
  <div className={`flex items-center justify-between gap-4 rounded-xl border px-3 py-3 ${darkMode ? 'border-gray-800 bg-gray-950/20' : 'border-gray-200 bg-gray-50/70'}`}>
    <Tooltip content={tooltip} side="right">
      <div className="flex items-center gap-2 min-w-[140px]">
        {icon ? React.createElement(icon, { className: `w-4 h-4 ${darkMode ? 'text-gray-400' : 'text-gray-500'}` }) : null}
        <label className={`text-sm ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>{label}</label>
      </div>
    </Tooltip>
    <div className={`${rightClassName} ${justifyEnd ? '' : ''}`}>
      {children}
    </div>
  </div>
);

export function getStreamBrowserSourceUrl() {
  if (typeof window === 'undefined') return '/stream';
  const origin = window.location.origin;
  const isDev = import.meta.env.MODE === 'development';
  return isDev ? `${origin}/stream` : `${origin}/#/stream`;
}

const StreamBandSection = ({ darkMode, settings, update, showToast }) => {
  const enabled = settings.streamBandEnabled === true;
  const percent = normalizeStreamBandHeightPercent(settings.streamBandHeightPercent);
  const backdrop = normalizeStreamBandBackdrop(settings.streamBandBackdrop);
  const streamUrl = getStreamBrowserSourceUrl();

  const copyStreamUrl = async () => {
    try {
      await navigator.clipboard.writeText(streamUrl);
      showToast({ title: 'Copied', message: 'Paste this URL into an OBS browser source.', variant: 'success' });
    } catch {
      showToast({ title: 'Could not copy', message: streamUrl, variant: 'info' });
    }
  };

  return (
    <div className={`rounded-xl border p-3 ${darkMode ? 'border-gray-800 bg-gray-950/30' : 'border-gray-200 bg-white'}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-2 min-w-0">
          <PanelBottom className={`w-4 h-4 mt-0.5 shrink-0 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`} />
          <div className="min-w-0">
            <p className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>Live Stream Band</p>
            <p className={`mt-0.5 text-xs leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              Paint only the bottom of the frame. The camera above stays untouched, and every verse auto-fits inside the band.
            </p>
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => update('streamBandEnabled', checked)}
          aria-label="Toggle live stream band"
        />
      </div>

      {enabled && (
        <div className="mt-3 space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className={`text-xs font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                Band height
              </label>
              <div className="mt-1 flex items-center gap-2">
                <Input
                  type="number"
                  min="15"
                  max="80"
                  value={percent}
                  onChange={(event) => update(
                    'streamBandHeightPercent',
                    sanitizeIntegerInput(event.target.value, percent, { min: 15, max: 80 })
                  )}
                  className={`w-20 ${darkMode ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-300'}`}
                />
                <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>% of frame height</span>
              </div>
            </div>
            <div>
              <label className={`text-xs font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                Backdrop
              </label>
              <Select value={backdrop} onValueChange={(value) => update('streamBandBackdrop', value)}>
                <SelectTrigger className={`mt-1 ${darkMode ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-300'}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={darkMode ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-300'}>
                  <SelectItem value="gradient">Soft gradient</SelectItem>
                  <SelectItem value="solid">Solid band</SelectItem>
                  <SelectItem value="none">No background</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className={`text-sm ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>Auto-fit verse to band</p>
              <p className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>Long verses shrink; short verses grow to fill the band.</p>
            </div>
            <Switch
              checked={settings.streamBandAutoFit !== false}
              onCheckedChange={(checked) => update('streamBandAutoFit', checked)}
              aria-label="Toggle auto-fit verse to band"
            />
          </div>

          <div className={`rounded-lg border px-2.5 py-2 ${darkMode ? 'border-gray-800 bg-gray-900/60' : 'border-gray-200 bg-gray-50'}`}>
            <p className={`text-[11px] ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              OBS / vMix browser source — 1920×1080, then sit it above the camera layer:
            </p>
            <div className="mt-1 flex items-center gap-2">
              <code className={`min-w-0 flex-1 truncate rounded px-1.5 py-1 text-[11px] ${darkMode ? 'bg-gray-950 text-blue-200' : 'bg-white text-blue-700'}`}>
                {streamUrl}
              </code>
              <Button size="sm" variant="outline" onClick={copyStreamUrl} className="h-7 shrink-0 px-2 text-xs">Copy</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const LyricsPositionSection = ({
  darkMode,
  lyricsPositionValue,
  handleLyricsPositionChange,
  fullScreenModeChecked
}) => (
  <SettingRow
    icon={AlignVerticalSpaceAround}
    label="Lyrics Position"
    tooltip="Choose where lyrics appear vertically on screen"
    rightClassName="w-full"
    darkMode={darkMode}
  >
    <Select
      value={lyricsPositionValue}
      onValueChange={handleLyricsPositionChange}
    >
      <SelectTrigger
        className={`w-full ${darkMode
          ? 'bg-gray-700 border-gray-600 text-gray-200'
          : 'bg-white border-gray-300'
          }`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className={darkMode ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-300'}>
        <SelectItem value="upper">Upper Third</SelectItem>
        <SelectItem value="center">Centre</SelectItem>
        <SelectItem value="lower">Lower Third</SelectItem>
      </SelectContent>
    </Select>
  </SettingRow>
);

const FontStyleSection = ({ darkMode, fontStyle, onChange }) => (
  <SettingRow
    icon={Type}
    label="Font Style"
    tooltip="Select font family for lyric display"
    rightClassName="w-full"
    darkMode={darkMode}
  >
    <FontSelect
      value={fontStyle}
      onChange={onChange}
      darkMode={darkMode}
      triggerClassName="w-full"
      containerClassName="relative w-full"
    />
  </SettingRow>
);

const FontColorSection = ({
  darkMode,
  fontColor,
  onChange,
  fontColorAdvancedExpanded,
  setFontColorAdvancedExpanded
}) => (
  <SettingRow
    icon={PaintBucket}
    label="Font Colour"
    tooltip="Choose the color of your lyrics text"
    rightClassName="flex items-center gap-2 justify-end w-full"
    darkMode={darkMode}
  >
    <Tooltip content={fontColorAdvancedExpanded ? "Hide advanced settings" : "Show advanced settings"} side="top">
      <AdvancedToggle
        expanded={fontColorAdvancedExpanded}
        onToggle={() => setFontColorAdvancedExpanded(!fontColorAdvancedExpanded)}
        darkMode={darkMode}
        ariaLabel="Toggle font color advanced settings"
      />
    </Tooltip>
    <ColorPicker
      value={fontColor}
      onChange={onChange}
      darkMode={darkMode}
      className={darkMode ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-300'}
    />
  </SettingRow>
);

const DropShadowSection = ({
  darkMode,
  settings,
  update,
  dropShadowAdvancedExpanded,
  setDropShadowAdvancedExpanded
}) => (
  <SettingRow
    icon={Contrast}
    label="Drop Shadow"
    tooltip="Add shadow behind text for depth (0-10 opacity)"
    rightClassName="flex items-center gap-2 justify-end w-full"
    darkMode={darkMode}
  >
    <Tooltip content={dropShadowAdvancedExpanded ? "Hide advanced settings" : "Show advanced settings"} side="top">
      <AdvancedToggle
        expanded={dropShadowAdvancedExpanded}
        onToggle={() => setDropShadowAdvancedExpanded(!dropShadowAdvancedExpanded)}
        darkMode={darkMode}
        ariaLabel="Toggle drop shadow advanced settings"
      />
    </Tooltip>
    <ColorPicker
      value={settings.dropShadowColor}
      onChange={(val) => update('dropShadowColor', val)}
      darkMode={darkMode}
      className={darkMode ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-300'}
    />
    <Input
      type="number"
      value={settings.dropShadowOpacity}
      onChange={(e) => update(
        'dropShadowOpacity',
        sanitizeIntegerInput(e.target.value, settings.dropShadowOpacity ?? 0, { min: 0, max: 10 })
      )}
      min="0"
      max="10"
      className={`w-20 ${darkMode
        ? 'bg-gray-700 border-gray-600 text-gray-200'
        : 'bg-white border-gray-300'
        }`}
    />
  </SettingRow>
);

const BackgroundSection = ({
  darkMode,
  settings,
  update,
  backgroundAdvancedExpanded,
  setBackgroundAdvancedExpanded,
  fullScreenModeChecked,
  backgroundDisabledTooltip
}) => {
  const [opacityInput, setOpacityInput] = React.useState(() => String(settings.backgroundOpacity ?? 0));

  React.useEffect(() => {
    const normalized = settings.backgroundOpacity ?? 0;
    const currentNumeric = parseFloat(opacityInput);
    if (!Number.isNaN(currentNumeric) && currentNumeric === normalized) {
      return;
    }
    setOpacityInput(String(normalized));
  }, [opacityInput, settings.backgroundOpacity]);

  const handleOpacityChange = (value) => {
    setOpacityInput(value);
    const parsed = sanitizeNumberInput(
      value,
      settings.backgroundOpacity ?? 0,
      { min: 0, max: 10, clampMin: false }
    );
    if (Number.isFinite(parsed) && parsed !== settings.backgroundOpacity) {
      update('backgroundOpacity', parsed);
    }
  };

  const handleOpacityBlur = () => {
    const parsed = sanitizeNumberInput(opacityInput, settings.backgroundOpacity ?? 0, { min: 0, max: 10 });
    setOpacityInput(String(parsed));
    update('backgroundOpacity', parsed);
  };

  return (
    <SettingRow
      icon={Square}
      label="Background"
      tooltip="Set background band with custom color and opacity behind lyrics"
      rightClassName="flex items-center gap-2 justify-end w-full"
      darkMode={darkMode}
    >
      <Tooltip content={backgroundAdvancedExpanded ? "Hide advanced settings" : "Show advanced settings"} side="top">
        <AdvancedToggle
          expanded={backgroundAdvancedExpanded}
          onToggle={() => setBackgroundAdvancedExpanded(!backgroundAdvancedExpanded)}
          disabled={fullScreenModeChecked}
          darkMode={darkMode}
          ariaLabel="Toggle background advanced settings"
        />
      </Tooltip>
      <ColorPicker
        value={settings.backgroundColor}
        onChange={(val) => update('backgroundColor', val)}
        disabled={fullScreenModeChecked}
        darkMode={darkMode}
        className={`${darkMode ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-300'} ${fullScreenModeChecked ? 'opacity-60 cursor-not-allowed' : ''}`}
      />
      <Input
        type="number"
        value={opacityInput}
        onChange={(e) => handleOpacityChange(e.target.value)}
        onBlur={handleOpacityBlur}
        min="0"
        max="10"
        step="0.1"
        inputMode="decimal"
        disabled={fullScreenModeChecked}
        className={`w-20 ${darkMode
          ? 'bg-gray-700 border-gray-600 text-gray-200'
          : 'bg-white border-gray-300'
          } ${fullScreenModeChecked ? 'opacity-60 cursor-not-allowed' : ''}`}
        title={fullScreenModeChecked ? backgroundDisabledTooltip : undefined}
      />
    </SettingRow>
  );
};

const MarginsSection = ({ darkMode, settings, update }) => (
  <SettingRow
    icon={Move}
    label="X & Y Margins"
    tooltip="Adjust horizontal and vertical positioning offset"
    rightClassName="flex gap-2 items-center"
    darkMode={darkMode}
  >
    <Input
      type="number"
      value={settings.xMargin}
      onChange={(e) => update(
        'xMargin',
        sanitizeNumberInput(e.target.value, settings.xMargin ?? 0)
      )}
      className={`w-20 ${darkMode
        ? 'bg-gray-700 border-gray-600 text-gray-200'
        : 'bg-white border-gray-300'
        }`}
    />
    <Input
      type="number"
      value={settings.yMargin}
      onChange={(e) => update(
        'yMargin',
        sanitizeNumberInput(e.target.value, settings.yMargin ?? 0)
      )}
      className={`w-20 ${darkMode
        ? 'bg-gray-700 border-gray-600 text-gray-200'
        : 'bg-white border-gray-300'
        }`}
    />
  </SettingRow>
);

const TransitionSection = ({
  darkMode,
  settings,
  update,
  transitionAdvancedExpanded,
  setTransitionAdvancedExpanded
}) => (
  <SettingRow
    icon={ArrowRightLeft}
    label="Transition Style"
    tooltip="Choose animation style when lyrics change on display"
    rightClassName="flex items-center gap-2 justify-end w-full"
    darkMode={darkMode}
  >
    <Tooltip content={transitionAdvancedExpanded ? "Hide advanced settings" : "Show advanced settings"} side="top">
      <AdvancedToggle
        expanded={transitionAdvancedExpanded}
        onToggle={() => setTransitionAdvancedExpanded(!transitionAdvancedExpanded)}
        darkMode={darkMode}
        ariaLabel="Toggle transition advanced settings"
      />
    </Tooltip>
    <Select
      value={settings.transitionAnimation ?? 'none'}
      onValueChange={(val) => update('transitionAnimation', val)}
    >
      <SelectTrigger
        className={`w-[140px] ${darkMode
          ? 'bg-gray-700 border-gray-600 text-gray-200'
          : 'bg-white border-gray-300'
          }`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className={darkMode ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-300'}>
        <SelectItem value="none">None</SelectItem>
        <SelectItem value="fade">Fade</SelectItem>
        <SelectItem value="scale">Scale</SelectItem>
        <SelectItem value="slide">Slide</SelectItem>
        <SelectItem value="blur">Blur</SelectItem>
      </SelectContent>
    </Select>
  </SettingRow>
);

const PerformanceSection = ({ darkMode, settings, setSettings }) => (
  <div className={`mt-6 space-y-3 rounded-xl border p-4 ${darkMode ? 'border-gray-800 bg-gray-950/40' : 'border-gray-200 bg-gray-50/50'}`}>
    <div className="flex items-center gap-2 mb-2">
      <Gauge className={`w-4 h-4 ${darkMode ? 'text-blue-400' : 'text-blue-600'}`} />
      <h4 className={`text-xs font-bold uppercase tracking-wider ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
        Performance Optimization
      </h4>
    </div>
    
    <div className="grid grid-cols-1 gap-2">
      <div className={`flex items-center justify-between p-2 rounded-lg border ${darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white'}`}>
        <div className="flex flex-col">
          <label className={`text-sm font-medium ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>Low Power Mode</label>
          <span className={`text-[10px] ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>Disables animations and transitions</span>
        </div>
        <Switch 
          checked={settings.lowPowerMode} 
          onCheckedChange={(val) => setSettings({ lowPowerMode: val })} 
        />
      </div>

      <div className={`flex items-center justify-between p-2 rounded-lg border ${darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white'}`}>
        <div className="flex flex-col">
          <label className={`text-sm font-medium ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>Reduced Graphics</label>
          <span className={`text-[10px] ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>Simplifies shadows and borders</span>
        </div>
        <Switch 
          checked={settings.reducedGraphics} 
          onCheckedChange={(val) => setSettings({ reducedGraphics: val })} 
        />
      </div>

      <div className={`flex items-center justify-between p-2 rounded-lg border ${darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white'}`}>
        <div className="flex flex-col">
          <label className={`text-sm font-medium ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>Disable Video Preloading</label>
          <span className={`text-[10px] ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>Streams videos to save RAM</span>
        </div>
        <Switch 
          checked={settings.disableVideoPreloading} 
          onCheckedChange={(val) => setSettings({ disableVideoPreloading: val })} 
        />
      </div>

      <div className={`flex items-center justify-between p-2 rounded-lg border ${darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white'}`}>
        <div className="flex flex-col">
          <label className={`text-sm font-medium ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>GPU Effects</label>
          <span className={`text-[10px] ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>Blur transitions, springs, backdrop blur. Off = smooth fades</span>
        </div>
        <Switch
          checked={settings.gpuEffects !== false}
          onCheckedChange={(val) => setSettings({ gpuEffects: val })}
        />
      </div>

      <div className={`flex items-center justify-between p-2 rounded-lg border ${darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white'}`}>
        <div className="flex flex-col">
          <label className={`text-sm font-medium ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>Disable GPU Acceleration</label>
          <span className={`text-[10px] ${darkMode ? 'text-red-400' : 'text-red-600'}`}>Requires app restart</span>
        </div>
        <Switch 
          checked={settings.disableHardwareAcceleration} 
          onCheckedChange={(val) => {
            setSettings({ disableHardwareAcceleration: val });
            if (window.electronAPI) {
              window.electronAPI.updateHardwareAcceleration(val);
            }
          }} 
        />
      </div>
    </div>
  </div>
);

const GeneralBehaviorSection = ({ darkMode, autoTurnOnOutput, setAutoTurnOnOutput }) => (
  <div className={`mt-4 space-y-3 rounded-xl border p-4 ${darkMode ? 'border-gray-800 bg-gray-950/40' : 'border-gray-200 bg-gray-50/50'}`}>
    <div className="flex items-center gap-2 mb-2">
      <MousePointer2 className={`w-4 h-4 ${darkMode ? 'text-blue-400' : 'text-blue-600'}`} />
      <h4 className={`text-xs font-bold uppercase tracking-wider ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
        General Behavior
      </h4>
    </div>
    
    <div className="grid grid-cols-1 gap-2">
      <div className={`flex items-center justify-between p-2 rounded-lg border ${darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white'}`}>
        <div className="flex flex-col pr-4">
          <label className={`text-sm font-medium ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>Auto-Display on Select</label>
          <span className={`text-[10px] ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>Automatically turn on display when a slide or verse is clicked</span>
        </div>
        <Switch 
          checked={autoTurnOnOutput} 
          onCheckedChange={setAutoTurnOnOutput} 
        />
      </div>
    </div>
  </div>
);

const OutputSettingsPanel = ({ outputKey }) => {
  logger.info('OutputSettingsPanel mounted', { outputKey });
  const { darkMode } = useDarkModeState();
  const { emitStyleUpdate, emitIndividualOutputToggle } = useControlSocket();
  const { showToast } = useToast();
  const { showModal } = useModal();
  const { ensureValidToken } = useAuth();

  const outputDefinition = useOutputDefinition(outputKey);
  const { settings, updateSettings, enabled: isOutputEnabled, setEnabled: setOutputEnabled } = useOutputSettingsByKey(outputKey);
  const { settings: performanceSettings, setSettings: setPerformanceSettings } = usePerformanceSettings();

  const { handleToggleOutput } = useOutputToggle({
    outputKey,
    isOutputEnabled,
    setOutputEnabled,
    emitIndividualOutputToggle,
    showToast
  });

  if ((outputDefinition?.type || (outputKey === 'stage' ? 'stage' : 'regular')) === 'stage') {
    const applyStageSettings = React.useCallback((partial) => {
      const newSettings = { ...settings, ...partial };
      updateSettings(partial);
      emitStyleUpdate(outputKey, newSettings);
    }, [settings, updateSettings, emitStyleUpdate]);

    const updateStage = React.useCallback((key, value) => {
      applyStageSettings({ [key]: value });
    }, [applyStageSettings]);

    return (
      <StageSettingsPanel
        settings={settings}
        applySettings={applyStageSettings}
        update={updateStage}
        darkMode={darkMode}
        showModal={showModal}
        isOutputEnabled={isOutputEnabled}
        handleToggleOutput={handleToggleOutput}
        ensureValidToken={ensureValidToken}
      />
    );
  }

  const applySettings = React.useCallback((partial) => {
    const newSettings = { ...settings, ...partial };
    updateSettings(partial);
    emitStyleUpdate(outputKey, newSettings);
  }, [settings, updateSettings, emitStyleUpdate, outputKey]);

  const update = React.useCallback((key, value) => {
    applySettings({ [key]: value });
  }, [applySettings]);

  const {
    fileInputRef,
    handleMediaSelection,
    triggerFileDialog,
    hasBackgroundMedia,
    uploadedMediaName,
    validateExistingMedia
  } = useFullscreenBackground({
    outputKey,
    settings,
    applySettings,
    ensureValidToken,
    showToast
  });

  React.useEffect(() => {
    if (settings.fullScreenMode) {
      validateExistingMedia();
    }
  }, [settings.fullScreenMode, settings.fullScreenBackgroundMedia?.url, validateExistingMedia]);

  const {
    fontSizeAdvancedExpanded,
    setFontSizeAdvancedExpanded,
    fontColorAdvancedExpanded,
    setFontColorAdvancedExpanded,
    dropShadowAdvancedExpanded,
    setDropShadowAdvancedExpanded,
    backgroundAdvancedExpanded,
    setBackgroundAdvancedExpanded,
    transitionAdvancedExpanded,
    setTransitionAdvancedExpanded,
    fullScreenAdvancedExpanded,
    setFullScreenAdvancedExpanded
  } = useAdvancedSectionPersistence(outputKey, {
    autoOpenTriggers: {
      fontSizeAdvancedExpanded: settings.maxLinesEnabled,
      fullScreenAdvancedExpanded: settings.fullScreenMode,
    }
  });

  const { autoTurnOnOutput, setAutoTurnOnOutput } = useAutoTurnOnOutput();

  const {
    fullScreenModeChecked,
    lyricsPositionValue,
    fullScreenBackgroundTypeValue,
    fullScreenBackgroundColorValue,
    backgroundDisabledTooltip,
    fullScreenOptionsWrapperClass,
    handleLyricsPositionChange,
    handleFullScreenToggle,
    handleFullScreenBackgroundTypeChange,
    handleFullScreenColorChange
  } = useFullscreenModeState({ settings, applySettings, expand: fullScreenAdvancedExpanded });

  const {
    translationFontSizeMode,
    translationFontSize,
    currentFontSize,
    translationLineColor,
    dropShadowOffsetX,
    dropShadowOffsetY,
    dropShadowBlur,
    backgroundBandVerticalPadding,
    backgroundBandHeightMode,
    backgroundBandLockedToMaxLines,
    maxLinesValue,
    maxLinesEnabled,
    backgroundBandCustomLines,
    handleBackgroundHeightModeChange,
    handleCustomLinesChange,
    handleTranslationFontSizeModeChange,
    handleTranslationFontSizeChange
  } = useTypographyAndBands({ settings, applySettings });

  const prevFullScreenRef = React.useRef(fullScreenModeChecked);
  const fullScreenAdvancedRef = React.useRef(null);
  const prevFullScreenAdvancedExpandedRef = React.useRef(fullScreenAdvancedExpanded);

  React.useEffect(() => {
    const wasFullScreen = prevFullScreenRef.current;
    if (!wasFullScreen && fullScreenModeChecked) {
      setFullScreenAdvancedExpanded(true);
    }
    prevFullScreenRef.current = fullScreenModeChecked;
  }, [fullScreenModeChecked, setFullScreenAdvancedExpanded]);

  const fullScreenAdvancedVisible = fullScreenAdvancedExpanded;
  const fullScreenControlsDisabled = !fullScreenModeChecked && fullScreenAdvancedExpanded;

  React.useEffect(() => {
    const wasExpanded = prevFullScreenAdvancedExpandedRef.current;
    const isNowExpanded = fullScreenAdvancedVisible;

    if (!wasExpanded && isNowExpanded) {
      const scrollTarget = fullScreenAdvancedRef.current;
      if (!scrollTarget) {
        prevFullScreenAdvancedExpandedRef.current = isNowExpanded;
        return;
      }

      const findScrollableParent = (node) => {
        let current = node?.parentElement;
        while (current) {
          const style = window.getComputedStyle(current);
          const canScroll = current.scrollHeight > current.clientHeight &&
            /(auto|scroll|overlay)/i.test(style.overflowY || '');
          if (canScroll) return current;
          current = current.parentElement;
        }
        return null;
      };

      const scrollToReveal = () => {
        const container = findScrollableParent(scrollTarget);
        const padding = 24;
        if (container) {
          const containerRect = container.getBoundingClientRect();
          const targetRect = scrollTarget.getBoundingClientRect();
          const overflowBottom = targetRect.bottom - containerRect.bottom + padding;
          if (overflowBottom > 0) {
            container.scrollTo({
              top: container.scrollTop + overflowBottom,
              behavior: 'smooth'
            });
          }
          return;
        }

        const targetRect = scrollTarget.getBoundingClientRect();
        const overflowWindow = targetRect.bottom - window.innerHeight + padding;
        if (overflowWindow > 0) {
          window.scrollBy({ top: overflowWindow, behavior: 'smooth' });
        }
      };

      const timeout = window.setTimeout(scrollToReveal, 120);
      prevFullScreenAdvancedExpandedRef.current = isNowExpanded;
      return () => window.clearTimeout(timeout);
    }

    prevFullScreenAdvancedExpandedRef.current = isNowExpanded;
  }, [fullScreenAdvancedVisible]);

  const handleFullScreenToggleWithExpand = React.useCallback((checked) => {
    handleFullScreenToggle(checked);
    if (checked) {
      setFullScreenAdvancedExpanded(true);
    }
  }, [handleFullScreenToggle, setFullScreenAdvancedExpanded]);

  return (
    <div className="space-y-3 pb-4" onKeyDown={blurInputOnEnter}>
      {/* Header */}
      <div className={`flex items-center justify-between mb-4 rounded-xl border px-3 py-3 ${darkMode ? 'border-gray-800 bg-gray-950/30' : 'border-gray-200 bg-white'}`}>
        <div>
          <h3 className={`text-[11px] font-bold uppercase tracking-[0.16em] ${darkMode ? 'text-blue-200' : 'text-blue-800'}`}>
            {(outputDefinition?.name || outputKey).toUpperCase()} SETTINGS
          </h3>
          <p className={`mt-1 text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>Tune what the room sees.</p>
        </div>

        <div className="flex items-center gap-2">
          {/* Toggle Output Button */}
          <Tooltip content={isOutputEnabled
            ? `Turn off ${outputDefinition?.name || outputKey}`
            : `Turn on ${outputDefinition?.name || outputKey}`}
            side="bottom">
            <button
              onClick={handleToggleOutput}
              className={`p-1.5 rounded-lg transition-colors ${!isOutputEnabled
                ? darkMode
                  ? 'bg-red-600/80 text-white hover:bg-red-600'
                  : 'bg-red-500 text-white hover:bg-red-600'
                : darkMode
                  ? 'hover:bg-gray-700 text-gray-400 hover:text-gray-200'
                  : 'hover:bg-gray-100 text-gray-500 hover:text-gray-700'
                }`}
            >
              <Power className="w-4 h-4" />
            </button>
          </Tooltip>

          {/* Save as Template button */}
          <Tooltip content="Save current settings as a reusable template" side="bottom">
            <button
              onClick={() => {
                showModal({
                  title: 'Save as Template',
                  headerDescription: 'Save your current output settings as a reusable template',
                  component: 'SaveTemplate',
                  variant: 'info',
                  size: 'sm',
                  actions: [],
                  templateType: 'output',
                  settings: settings,
                  onSave: (template) => {
                    showToast({
                      title: 'Template Saved',
                      message: `"${template.name}" has been saved successfully`,
                      variant: 'success',
                    });
                  }
                });
              }}
              className={`p-1.5 rounded-lg transition-colors ${darkMode
                ? 'hover:bg-gray-700 text-gray-400 hover:text-gray-200'
                : 'hover:bg-gray-100 text-gray-500 hover:text-gray-700'
                }`}
            >
              <Save className="w-4 h-4" />
            </button>
          </Tooltip>

          {/* Templates trigger button */}
          <Tooltip content="Choose from professionally designed output templates" side="bottom">
            <button
              onClick={() => {
                showModal({
                  title: 'Output Templates',
                  headerDescription: 'Choose from professionally designed output presets',
                  component: 'OutputTemplates',
                  variant: 'info',
                  size: 'large',
                  scrollBehavior: 'scroll',
                  dismissLabel: 'Close',
                  outputKey: outputKey,
                  onApplyTemplate: (template) => {
                    const templateSettings = template.getSettings
                      ? template.getSettings(outputKey)
                      : template.settings;
                    applySettings(templateSettings);
                    showToast({
                      title: 'Template Applied',
                      message: `${template.title} template has been applied successfully`,
                      variant: 'success',
                    });
                  }
                });
              }}
              className={`p-1.5 rounded-lg transition-colors ${darkMode
                ? 'hover:bg-gray-700 text-gray-400 hover:text-gray-200'
                : 'hover:bg-gray-100 text-gray-500 hover:text-gray-700'
                }`}
            >
              <Palette className="w-4 h-4" />
            </button>
          </Tooltip>

          {/* Help trigger button */}
          <Tooltip content="Settings Panel Help" side="bottom">
            <button
              onClick={() => {
                showModal({
                  title: 'Output Settings Help',
                  headerDescription: 'Customize every aspect of your lyric display appearance',
                  component: 'OutputSettingsHelp',
                  variant: 'info',
                  size: 'large',
                  dismissLabel: 'Got it'
                });
              }}
              className={`p-1.5 rounded-lg transition-colors ${darkMode
                ? 'hover:bg-gray-700 text-gray-400 hover:text-gray-200'
                : 'hover:bg-gray-100 text-gray-500 hover:text-gray-700'
                }`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Live stream lower-third geometry */}
      <StreamBandSection
        darkMode={darkMode}
        settings={settings}
        update={update}
        showToast={showToast}
      />

      {/* Lyrics Position */}
      <LyricsPositionSection
        darkMode={darkMode}
        lyricsPositionValue={lyricsPositionValue}
        handleLyricsPositionChange={handleLyricsPositionChange}
        fullScreenModeChecked={fullScreenModeChecked}
      />

      {/* Font Picker */}
      <FontStyleSection
        darkMode={darkMode}
        fontStyle={settings.fontStyle}
        onChange={(val) => update('fontStyle', val)}
      />

      {/* Bold / Italic / Underline / All Caps */}
      <EmphasisRow
        darkMode={darkMode}
        icon={SquareMenu}
        boldValue={settings.bold}
        italicValue={settings.italic}
        underlineValue={settings.underline}
        allCapsValue={settings.allCaps}
        onBoldChange={(val) => update('bold', val)}
        onItalicChange={(val) => update('italic', val)}
        onUnderlineChange={(val) => update('underline', val)}
        onAllCapsChange={(val) => update('allCaps', val)}
      />

      {/* Text Alignment */}
      <AlignmentRow
        darkMode={darkMode}
        icon={TextAlignJustify}
        value={settings.textAlign}
        onChange={(val) => update('textAlign', val)}
        tooltip="Text alignment for lyrics display"
      />

      {/* Font Size */}
      <div className="flex items-center justify-between gap-4">
        <Tooltip content="Adjust text size in pixels (24-100)" side="right">
          <LabelWithIcon icon={TextCursorInput} text="Font Size" darkMode={darkMode} />
        </Tooltip>
        <div className="flex items-center gap-2 justify-end w-full">
          <Tooltip content={fontSizeAdvancedExpanded ? "Hide advanced settings" : "Show advanced settings"} side="top">
            <AdvancedToggle
              expanded={fontSizeAdvancedExpanded}
              onToggle={() => setFontSizeAdvancedExpanded(!fontSizeAdvancedExpanded)}
              darkMode={darkMode}
              ariaLabel="Toggle font size advanced settings"
            />
          </Tooltip>
          {(() => {
            const baseFont = Number.isFinite(settings.fontSize) ? settings.fontSize : 24;
            const instanceCount = settings.instanceCount || 0;
            const hasMultipleInstances = instanceCount > 1;
            const allInstances = settings.allInstances || [];

            let anyInstanceResizing = false;
            let primaryAdjustedSize = null;

            if (settings.maxLinesEnabled && instanceCount > 0) {
              if (hasMultipleInstances && allInstances.length > 0) {
                anyInstanceResizing = allInstances.some(inst => inst.autosizerActive === true);
                const primaryInstance = allInstances.reduce((largest, current) => {
                  if (!largest) return current;
                  const largestArea = (largest.viewportWidth || 0) * (largest.viewportHeight || 0);
                  const currentArea = (current.viewportWidth || 0) * (current.viewportHeight || 0);
                  return currentArea > largestArea ? current : largest;
                }, null);
                primaryAdjustedSize = primaryInstance?.adjustedFontSize ?? null;
              } else if (allInstances.length > 0) {
                const singleInstance = allInstances[0];
                anyInstanceResizing = Boolean(singleInstance?.autosizerActive);
                primaryAdjustedSize = singleInstance?.adjustedFontSize ?? null;
              } else if (settings.autosizerActive) {
                anyInstanceResizing = true;
                primaryAdjustedSize = null;
              }
            }

            const primaryInstanceResizing = anyInstanceResizing && primaryAdjustedSize !== null && primaryAdjustedSize !== baseFont;
            const displayFontSize = primaryInstanceResizing ? primaryAdjustedSize : baseFont;

            const primaryViewport = settings.primaryViewportWidth && settings.primaryViewportHeight
              ? `${settings.primaryViewportWidth}×${settings.primaryViewportHeight}`
              : null;

            let inputDisplayValue = displayFontSize;
            if (hasMultipleInstances && anyInstanceResizing && allInstances.length > 0) {
              const primaryValue = displayFontSize;
              const otherResizingInstance = allInstances.find(inst =>
                inst.autosizerActive === true &&
                inst.adjustedFontSize !== primaryValue
              );

              if (otherResizingInstance) {
                const otherValue = otherResizingInstance.adjustedFontSize ?? baseFont;
                inputDisplayValue = allInstances.length > 2
                  ? `${primaryValue}, ${otherValue}…`
                  : `${primaryValue}, ${otherValue}`;
              } else if (allInstances.length > 1) {
                inputDisplayValue = `${primaryValue}…`;
              }
            }

            let tooltipText = '';
            if (anyInstanceResizing) {
              if (hasMultipleInstances) {
                tooltipText = `Auto-resizing active on ${instanceCount} displays\n\nPrimary (${primaryViewport}): ${displayFontSize}px`;
                if (allInstances.length > 0) {
                  allInstances.forEach((inst, idx) => {
                    const viewport = `${inst.viewportWidth}×${inst.viewportHeight}`;
                    const size = inst.adjustedFontSize ?? baseFont;
                    tooltipText += `\nDisplay ${idx + 1} (${viewport}): ${size}px`;
                  });
                }
                tooltipText += `\n\nPreferred size: ${settings.fontSize}px`;
              } else {
                tooltipText = `Auto-resizing active: ${displayFontSize}px (preferred: ${settings.fontSize}px)`;
              }
            } else {
              tooltipText = 'Set the preferred font size in pixels';
            }

            const innerClassBase = `${darkMode ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-300'}`;

            return (
              <div className={`flex items-center ${anyInstanceResizing ? 'gap-2' : ''}`} aria-live={anyInstanceResizing ? 'polite' : undefined}>
                {anyInstanceResizing && (
                  <span
                    className="inline-flex items-center justify-center"
                    title={tooltipText}
                    aria-hidden="true"
                  >
                    {/* Sparkles icon */}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0">
                      <defs>
                        <linearGradient id="spark-grad" x1="0" y1="0" x2="1" y2="1">
                          <stop offset="0%" stopColor="#60A5FA" />
                          <stop offset="100%" stopColor="#8B5CF6" />
                        </linearGradient>
                      </defs>
                      <path d="M12 2l2.2 4.8L19 9l-4.8 2.2L12 16l-2.2-4.8L5 9l4.8-2.2L12 2zm7 11l1.1 2.4L23 16l-2.4 1.1L19 19l-1.1-2.4L15 16l2.4-1.1L19 13zM3 13l1.1 2.4L6 16l-2.4 1.1L3 19l-1.1-2.4L0 16l2.4-1.1L3 13z" fill="url(#spark-grad)" />
                    </svg>
                  </span>
                )}
                <div className="relative flex-1">
                  {hasMultipleInstances && anyInstanceResizing && primaryInstanceResizing ? (
                    <div
                      className={`w-24 h-9 px-3 flex items-center justify-start text-sm rounded-md border cursor-not-allowed ${darkMode
                        ? 'bg-gray-700 border-gray-600 text-gray-500'
                        : 'bg-gray-50 border-gray-300 text-gray-500'
                        }`}
                      style={{ fontWeight: 400 }}
                      title={tooltipText}
                    >
                      {inputDisplayValue}
                    </div>
                  ) : (
                    <Input
                      type="number"
                      value={Number.isFinite(displayFontSize) ? displayFontSize : 24}
                      onChange={(e) => {
                        const next = sanitizeIntegerInput(
                          e.target.value,
                          settings.fontSize ?? 24,
                          { min: 24, max: 100, clampMin: false }
                        );
                        update('fontSize', next);
                      }}
                      min="24"
                      max="100"
                      disabled={primaryInstanceResizing}
                      className={`w-24 ${innerClassBase} ${primaryInstanceResizing ? 'opacity-80 cursor-not-allowed' : ''}`}
                      title={tooltipText}
                    />
                  )}
                </div>
              </div>
            );
          })()}
          <Tooltip content="Enable adaptive text fitting with width/height coverage and max font size" side="top">
            <Button
              size="icon"
              variant="outline"
              onClick={() => update('maxLinesEnabled', !settings.maxLinesEnabled)}
              className={
                settings.maxLinesEnabled
                  ? darkMode
                    ? '!bg-white !text-gray-900 hover:!bg-white !border-gray-300'
                    : '!bg-black !text-white hover:!bg-black !border-gray-300'
                  : darkMode
                    ? '!bg-transparent !border-gray-600 !text-gray-200 hover:!bg-gray-700'
                    : '!bg-transparent !border-gray-300 !text-gray-700 hover:!bg-gray-100'
              }
            >
              <ListStart className="w-4 h-4" />
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* Font Size Advanced Settings Row */}
      <div
        className={`overflow-hidden transition-[max-height,opacity,transform] duration-300 ease-out ${fontSizeAdvancedExpanded
          ? 'max-h-48 opacity-100 translate-y-0 pointer-events-auto mt-1'
          : 'max-h-0 opacity-0 -translate-y-2 pointer-events-none m-0 p-0'
          }`}
        aria-hidden={!fontSizeAdvancedExpanded}
        style={{ marginTop: fontSizeAdvancedExpanded ? undefined : 0 }}
      >
        {/* Width Coverage Settings Row */}
        <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
          <div className="flex items-center gap-2">
            <label className={`text-sm ${darkMode ? 'text-gray-200' : 'text-gray-700'} ${!maxLinesEnabled ? 'opacity-50' : ''}`}>
              Width Coverage (%)
            </label>
            <Input
              type="number"
              value={settings.fitWidthPercent ?? 90}
              onChange={(e) => update(
                'fitWidthPercent',
                sanitizeIntegerInput(e.target.value, settings.fitWidthPercent ?? 90, { min: 10, max: 100 })
              )}
              min="10"
              max="100"
              disabled={!maxLinesEnabled}
              className={`w-16 ${darkMode
                ? 'bg-gray-700 border-gray-600 text-gray-200'
                : 'bg-white border-gray-300'
                } ${!maxLinesEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            />
          </div>
          <div className="flex items-center gap-2">
            <label className={`text-sm ${darkMode ? 'text-gray-200' : 'text-gray-700'} ${!maxLinesEnabled ? 'opacity-50' : ''}`}>
              Height Coverage (%)
            </label>
            <Input
              type="number"
              value={settings.fitHeightPercent ?? 90}
              onChange={(e) => update(
                'fitHeightPercent',
                sanitizeIntegerInput(e.target.value, settings.fitHeightPercent ?? 90, { min: 10, max: 100 })
              )}
              min="10"
              max="100"
              disabled={!maxLinesEnabled}
              className={`w-16 ${darkMode
                ? 'bg-gray-700 border-gray-600 text-gray-200'
                : 'bg-white border-gray-300'
                } ${!maxLinesEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            />
          </div>
          <div className="flex items-center gap-2">
            <label className={`text-sm ${darkMode ? 'text-gray-200' : 'text-gray-700'} ${!maxLinesEnabled ? 'opacity-50' : ''}`}>
              Min Font Size
            </label>
            <Input
              type="number"
              value={settings.minFontSize ?? 24}
              onChange={(e) => update(
                'minFontSize',
                sanitizeIntegerInput(
                  e.target.value,
                  settings.minFontSize ?? 24,
                  { min: 1, max: Math.max(settings.maxFontSize ?? 300, 1) }
                )
              )}
              min="1"
              max={settings.maxFontSize ?? 300}
              disabled={!maxLinesEnabled}
              className={`w-16 ${darkMode
                ? 'bg-gray-700 border-gray-600 text-gray-200'
                : 'bg-white border-gray-300'
                } ${!maxLinesEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            />
          </div>
          <div className="flex items-center gap-2">
            <label className={`text-sm ${darkMode ? 'text-gray-200' : 'text-gray-700'} ${!maxLinesEnabled ? 'opacity-50' : ''}`}>
              Max Font Size
            </label>
            <Input
              type="number"
              value={settings.maxFontSize ?? 300}
              onChange={(e) => update(
                'maxFontSize',
                sanitizeIntegerInput(
                  e.target.value,
                  settings.maxFontSize ?? 300,
                  { min: Math.max(settings.minFontSize ?? 24, 1), max: 400 }
                )
              )}
              min={settings.minFontSize ?? 24}
              max="400"
              disabled={!maxLinesEnabled}
              className={`w-16 ${darkMode
                ? 'bg-gray-700 border-gray-600 text-gray-200'
                : 'bg-white border-gray-300'
                } ${!maxLinesEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            />
          </div>
        </div>

        {/* Translation Font Size Row */}
        <div className="flex items-center justify-between w-full">
          {/* Translation Label */}
          <label className={`text-sm whitespace-nowrap ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>
            Translation Size
          </label>

          {/* Translation Mode and Custom Size */}
          <div className="flex items-center gap-2">
            <Select
              value={translationFontSizeMode}
              onValueChange={handleTranslationFontSizeModeChange}
            >
              <SelectTrigger
                className={`w-[120px] ${darkMode
                  ? 'bg-gray-700 border-gray-600 text-gray-200'
                  : 'bg-white border-gray-300'
                  }`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={darkMode ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-300'}>
                <SelectItem value="bound">Bound</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>

            {/* Translation Custom Size */}
            {translationFontSizeMode === 'custom' && (
              <Tooltip content={`Translation font size (max: ${currentFontSize}px)`} side="top">
                <div className="flex items-center gap-2">
                  <Languages className={`w-4 h-4 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`} />
                  <Input
                    type="number"
                    value={translationFontSize}
                    onChange={(e) => handleTranslationFontSizeChange(e.target.value)}
                    min="12"
                    max={currentFontSize}
                    className={`w-16 ${darkMode
                      ? 'bg-gray-700 border-gray-600 text-gray-200'
                      : 'bg-white border-gray-300'
                      }`}
                  />
                </div>
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      <SettingRow
        icon={Move}
        label="Bible Reference"
        tooltip="Choose where the Bible reference appears on screen when displaying Bible verses"
        rightClassName="w-full"
        darkMode={darkMode}
      >
        <Select
          value={settings.bibleReferencePosition || 'bottom-center'}
          onValueChange={(value) => update('bibleReferencePosition', value)}
        >
          <SelectTrigger
            className={`w-full ${darkMode
              ? 'bg-gray-700 border-gray-600 text-gray-200'
              : 'bg-white border-gray-300'
              }`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className={darkMode ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-300'}>
            <SelectItem value="top-left">Top Left</SelectItem>
            <SelectItem value="top-right">Top Right</SelectItem>
            <SelectItem value="top-center">Top Center</SelectItem>
            <SelectItem value="left">Left</SelectItem>
            <SelectItem value="bottom-right">Bottom Right</SelectItem>
            <SelectItem value="bottom-center">Bottom Center</SelectItem>
            <SelectItem value="bottom-left">Bottom Left</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      <div className="flex items-center justify-between gap-4 mt-4">
        <Tooltip content="Show the Bible translation/version (e.g. KJV) next to the verse reference" side="right">
          <LabelWithIcon icon={Book} text="Show Bible Version" darkMode={darkMode} />
        </Tooltip>
        <div className="flex items-center gap-3 justify-end w-full">
          <span className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
            {settings.showBibleVersion !== false ? 'Enabled' : 'Disabled'}
          </span>
          <Switch
            checked={settings.showBibleVersion !== false}
            onCheckedChange={(checked) => update('showBibleVersion', checked)}
            aria-label="Toggle show Bible version"
            className={`!h-8 !w-16 !border-0 shadow-sm transition-colors ${darkMode
              ? 'data-[state=checked]:bg-green-400 data-[state=unchecked]:bg-gray-600'
              : 'data-[state=checked]:bg-black data-[state=unchecked]:bg-gray-300'
              }`}
            thumbClassName="!h-6 !w-7 data-[state=checked]:!translate-x-8 data-[state=unchecked]:!translate-x-1"
          />
        </div>
      </div>

      <SettingRow
        icon={Languages}
        label="Parallel Layout"
        tooltip="Dual-translation layout when a second translation is linked: side-by-side on wide screens (stacks when narrow), or always stacked"
        rightClassName="w-full"
        darkMode={darkMode}
      >
        <Select
          value={settings.parallelLayout || 'side-by-side'}
          onValueChange={(value) => update('parallelLayout', value === 'stacked' ? 'stacked' : 'side-by-side')}
        >
          <SelectTrigger
            aria-label="Parallel translation layout"
            className={`w-full ${darkMode
              ? 'bg-gray-700 border-gray-600 text-gray-200'
              : 'bg-white border-gray-300'
              }`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className={darkMode ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-300'}>
            <SelectItem value="side-by-side">Side by side</SelectItem>
            <SelectItem value="stacked">Stacked</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      {/* Font Color */}
      <FontColorSection
        darkMode={darkMode}
        fontColor={settings.fontColor}
        onChange={(val) => update('fontColor', val)}
        fontColorAdvancedExpanded={fontColorAdvancedExpanded}
        setFontColorAdvancedExpanded={setFontColorAdvancedExpanded}
      />

      {/* Font Color Advanced Settings Row */}
      <div
        className={`overflow-hidden transition-[max-height,opacity,transform] duration-300 ease-out ${fontColorAdvancedExpanded
          ? 'max-h-20 opacity-100 translate-y-0 pointer-events-auto mt-1'
          : 'max-h-0 opacity-0 -translate-y-2 pointer-events-none m-0 p-0'
          }`}
        aria-hidden={!fontColorAdvancedExpanded}
        style={{ marginTop: fontColorAdvancedExpanded ? undefined : 0 }}
      >
        <div className="flex items-center justify-between w-full">
          <label className={`text-sm whitespace-nowrap ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>
            Translation Colour
          </label>
          <ColorPicker
            value={translationLineColor}
            onChange={(val) => update('translationLineColor', val)}
            darkMode={darkMode}
            className={darkMode ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-300'}
          />
        </div>
      </div>

      {/* Text Border */}
      <div className="flex items-center justify-between gap-4">
        <Tooltip content="Add an outline around text for better visibility (0-10px)" side="right">
          <LabelWithIcon icon={Frame} text="Text Border" darkMode={darkMode} />
        </Tooltip>
        <div className="flex gap-2 items-center">
          <ColorPicker
            value={settings.borderColor ?? '#000000'}
            onChange={(val) => update('borderColor', val)}
            darkMode={darkMode}
            className={darkMode ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-300'}
          />
          <Input
            type="number"
            value={settings.borderSize ?? 0}
            onChange={(e) => update(
              'borderSize',
              sanitizeIntegerInput(e.target.value, settings.borderSize ?? 0, { min: 0, max: 10 })
            )}
            min="0"
            max="10"
            className={`w-20 ${darkMode
              ? 'bg-gray-700 border-gray-600 text-gray-200'
              : 'bg-white border-gray-300'
              }`}
          />
        </div>
      </div>

      {/* Drop Shadow */}
      <DropShadowSection
        darkMode={darkMode}
        settings={settings}
        update={update}
        dropShadowAdvancedExpanded={dropShadowAdvancedExpanded}
        setDropShadowAdvancedExpanded={setDropShadowAdvancedExpanded}
      />

      {/* Drop Shadow Advanced Settings Row */}
      <div
        className={`overflow-hidden transition-[max-height,opacity,transform] duration-300 ease-out ${dropShadowAdvancedExpanded
          ? 'max-h-32 opacity-100 translate-y-0 pointer-events-auto mt-1'
          : 'max-h-0 opacity-0 -translate-y-2 pointer-events-none m-0 p-0'
          }`}
        aria-hidden={!dropShadowAdvancedExpanded}
        style={{ marginTop: dropShadowAdvancedExpanded ? undefined : 0 }}
      >
        <div className="flex items-center justify-between w-full">
          {/* Horizontal Offset (X) */}
          <Tooltip content="Horizontal shadow offset in pixels (negative = left, positive = right)" side="top">
            <div className="flex items-center gap-2">
              <MoveHorizontal className={`w-4 h-4 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`} />
              <Input
                type="number"
                value={dropShadowOffsetX}
                onChange={(e) => update(
                  'dropShadowOffsetX',
                  sanitizeIntegerInput(e.target.value, settings.dropShadowOffsetX ?? 0, { min: -50, max: 50 })
                )}
                min="-50"
                max="50"
                className={`w-16 ${darkMode
                  ? 'bg-gray-700 border-gray-600 text-gray-200'
                  : 'bg-white border-gray-300'
                  }`}
              />
            </div>
          </Tooltip>

          {/* Vertical Offset (Y) */}
          <Tooltip content="Vertical shadow offset in pixels (negative = up, positive = down)" side="top">
            <div className="flex items-center gap-2">
              <MoveVertical className={`w-4 h-4 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`} />
              <Input
                type="number"
                value={dropShadowOffsetY}
                onChange={(e) => update(
                  'dropShadowOffsetY',
                  sanitizeIntegerInput(e.target.value, settings.dropShadowOffsetY ?? 8, { min: -50, max: 50 })
                )}
                min="-50"
                max="50"
                className={`w-16 ${darkMode
                  ? 'bg-gray-700 border-gray-600 text-gray-200'
                  : 'bg-white border-gray-300'
                  }`}
              />
            </div>
          </Tooltip>

          {/* Blur Radius */}
          <Tooltip content="Shadow blur radius in pixels (0 = sharp, higher = softer)" side="top">
            <div className="flex items-center gap-2">
              <Sparkles className={`w-4 h-4 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`} />
              <Input
                type="number"
                value={dropShadowBlur}
                onChange={(e) => update(
                  'dropShadowBlur',
                  sanitizeIntegerInput(e.target.value, settings.dropShadowBlur ?? 10, { min: 0, max: 50 })
                )}
                min="0"
                max="50"
                className={`w-16 ${darkMode
                  ? 'bg-gray-700 border-gray-600 text-gray-200'
                  : 'bg-white border-gray-300'
                  }`}
              />
            </div>
          </Tooltip>
        </div>
      </div>

      {/* Background */}
      <BackgroundSection
        darkMode={darkMode}
        settings={settings}
        update={update}
        backgroundAdvancedExpanded={backgroundAdvancedExpanded}
        setBackgroundAdvancedExpanded={setBackgroundAdvancedExpanded}
        fullScreenModeChecked={fullScreenModeChecked}
        backgroundDisabledTooltip={backgroundDisabledTooltip}
      />

      {/* Background Advanced Settings Row */}
      <div
        className={`overflow-hidden transition-[max-height,opacity,transform] duration-300 ease-out ${backgroundAdvancedExpanded && !fullScreenModeChecked
          ? 'max-h-32 opacity-100 translate-y-0 pointer-events-auto mt-1'
          : 'max-h-0 opacity-0 -translate-y-2 pointer-events-none m-0 p-0'
          }`}
        aria-hidden={!backgroundAdvancedExpanded || fullScreenModeChecked}
        style={{ marginTop: (backgroundAdvancedExpanded && !fullScreenModeChecked) ? undefined : 0 }}
      >
        <div className="flex items-center justify-between w-full">
          {/* Height Mode */}
          <div className="flex items-center gap-2">
            <label className={`text-sm whitespace-nowrap ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>
              Mode
            </label>
            <Select
              value={backgroundBandHeightMode}
              onValueChange={handleBackgroundHeightModeChange}
            >
              <SelectTrigger
                className={`w-[110px] ${darkMode
                  ? 'bg-gray-700 border-gray-600 text-gray-200'
                  : 'bg-white border-gray-300'
                  }`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={darkMode ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-300'}>
                <SelectItem value="adaptive">Adaptive</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Custom Lines */}
          {backgroundBandHeightMode === 'custom' && (
            <Tooltip content={
              !maxLinesEnabled
                ? "Number of lines for band height"
                : backgroundBandLockedToMaxLines
                  ? `Locked to Max Lines (${maxLinesValue}). Click to unlock`
                  : `Click to lock to Max Lines (${maxLinesValue})`
            } side="top">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    if (maxLinesEnabled) {
                      applySettings({
                        backgroundBandLockedToMaxLines: !backgroundBandLockedToMaxLines,
                        backgroundBandCustomLines: !backgroundBandLockedToMaxLines ? maxLinesValue : backgroundBandCustomLines
                      });
                    }
                  }}
                  disabled={!maxLinesEnabled}
                  className={`p-1 rounded transition-all ${maxLinesEnabled
                    ? `cursor-pointer ${backgroundBandLockedToMaxLines
                      ? darkMode
                        ? 'bg-blue-600 hover:bg-blue-700'
                        : 'bg-blue-500 hover:bg-blue-600'
                      : darkMode
                        ? 'hover:bg-gray-700'
                        : 'hover:bg-gray-200'
                    }`
                    : 'cursor-default opacity-50'
                    }`}
                  aria-label={maxLinesEnabled ? (backgroundBandLockedToMaxLines ? "Unlock from max lines" : "Lock to max lines") : undefined}
                >
                  <Rows3 className={`w-4 h-4 ${backgroundBandLockedToMaxLines && maxLinesEnabled
                    ? 'text-white'
                    : darkMode ? 'text-gray-400' : 'text-gray-500'
                    }`} />
                </button>
                <Input
                  type="number"
                  value={backgroundBandCustomLines}
                  onChange={(e) => handleCustomLinesChange(e.target.value)}
                  min="1"
                  max={maxLinesEnabled ? maxLinesValue : 10}
                  disabled={backgroundBandLockedToMaxLines && maxLinesEnabled}
                  className={`w-16 ${darkMode
                    ? 'bg-gray-700 border-gray-600 text-gray-200'
                    : 'bg-white border-gray-300'
                    } ${backgroundBandLockedToMaxLines && maxLinesEnabled ? 'opacity-60 cursor-not-allowed' : ''}`}
                />
              </div>
            </Tooltip>
          )}

          {/* Vertical Padding */}
          <Tooltip content="Vertical padding for background band (in pixels)" side="top">
            <div className="flex items-center gap-2">
              <ArrowUpDown className={`w-4 h-4 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`} />
              <Input
                type="number"
                value={backgroundBandVerticalPadding}
                onChange={(e) => update(
                  'backgroundBandVerticalPadding',
                  sanitizeIntegerInput(
                    e.target.value,
                    settings.backgroundBandVerticalPadding ?? 20,
                    { min: 0, max: 100 }
                  )
                )}
                min="0"
                max="100"
                className={`w-16 ${darkMode
                  ? 'bg-gray-700 border-gray-600 text-gray-200'
                  : 'bg-white border-gray-300'
                  }`}
              />
            </div>
          </Tooltip>
        </div>
      </div>

      {/* X and Y Margins */}
      <MarginsSection
        darkMode={darkMode}
        settings={settings}
        update={update}
      />

      {/* Transition Style */}
      <TransitionSection
        darkMode={darkMode}
        settings={settings}
        update={update}
        transitionAdvancedExpanded={transitionAdvancedExpanded}
        setTransitionAdvancedExpanded={setTransitionAdvancedExpanded}
      />

      {/* Transition Style Advanced Settings Row */}
      <div
        className={`overflow-hidden transition-[max-height,opacity,transform] duration-300 ease-out ${transitionAdvancedExpanded
          ? 'max-h-20 opacity-100 translate-y-0 pointer-events-auto mt-1'
          : 'max-h-0 opacity-0 -translate-y-2 pointer-events-none m-0 p-0'
          }`}
        aria-hidden={!transitionAdvancedExpanded}
        style={{ marginTop: transitionAdvancedExpanded ? undefined : 0 }}
      >
        <div className="flex items-center justify-between w-full">
          <label className={`text-sm whitespace-nowrap ${darkMode ? 'text-gray-200' : 'text-gray-700'} ${(settings.transitionAnimation ?? 'none') === 'none' ? 'opacity-50' : ''}`}>
            Transition Speed (ms)
          </label>
          <Input
            type="number"
            value={settings.transitionSpeed ?? 150}
            onChange={(e) => update(
              'transitionSpeed',
              sanitizeIntegerInput(
                e.target.value,
                settings.transitionSpeed ?? 150,
                { min: 100, max: 2000, clampMin: false }
              )
            )}
            min="100"
            max="2000"
            step="50"
            disabled={(settings.transitionAnimation ?? 'none') === 'none'}
            className={`w-24 ${darkMode
              ? 'bg-gray-700 border-gray-600 text-gray-200'
              : 'bg-white border-gray-300'
              } ${(settings.transitionAnimation ?? 'none') === 'none' ? 'opacity-50 cursor-not-allowed' : ''}`}
          />
        </div>
      </div>

      {/* Full Screen Mode */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Tooltip content="Enable full screen display with custom background settings" side="right">
            <LabelWithIcon icon={ScreenShare} text="Full Screen Mode" darkMode={darkMode} />
          </Tooltip>
          <Tooltip content={fullScreenAdvancedExpanded ? "Hide advanced settings" : "Show advanced settings"} side="top">
            <AdvancedToggle
              expanded={fullScreenAdvancedExpanded}
              onToggle={() => setFullScreenAdvancedExpanded(!fullScreenAdvancedExpanded)}
              darkMode={darkMode}
              ariaLabel="Toggle full screen advanced settings"
            />
          </Tooltip>
        </div>
        <div className="flex items-center gap-3 justify-end w-full">
          <span className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
            {fullScreenModeChecked ? 'Enabled' : 'Disabled'}
          </span>
          <Switch
            checked={fullScreenModeChecked}
            onCheckedChange={handleFullScreenToggleWithExpand}
            aria-label="Toggle full screen mode"
            className={`!h-8 !w-16 !border-0 shadow-sm transition-colors ${darkMode
              ? 'data-[state=checked]:bg-green-400 data-[state=unchecked]:bg-gray-600'
              : 'data-[state=checked]:bg-black data-[state=unchecked]:bg-gray-300'
              }`}
            thumbClassName="!h-6 !w-7 data-[state=checked]:!translate-x-8 data-[state=unchecked]:!translate-x-1"
          />
        </div>
      </div>

      {/* Fullscreen Mode Settings Row */}
      <div
        ref={fullScreenAdvancedRef}
        className={`overflow-hidden transition-[max-height,opacity,transform] duration-300 ease-out ${fullScreenOptionsWrapperClass}`}
        aria-hidden={!fullScreenAdvancedVisible}
        style={{ marginTop: fullScreenAdvancedVisible ? undefined : 0 }}
      >
        <div className={`flex items-center gap-3 justify-between w-full pt-2 ${fullScreenControlsDisabled ? 'opacity-60 pointer-events-none' : ''}`}>
          <Select
            value={fullScreenBackgroundTypeValue}
            onValueChange={handleFullScreenBackgroundTypeChange}
            disabled={fullScreenControlsDisabled}
          >
            <SelectTrigger
              disabled={fullScreenControlsDisabled}
              className={`w-[200px] ${darkMode
                ? 'bg-gray-700 border-gray-600 text-gray-200'
                : 'bg-white border-gray-300'
                } ${fullScreenControlsDisabled ? 'opacity-70 cursor-not-allowed' : ''}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={darkMode ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-300'}>
              <SelectItem value="color">Colour</SelectItem>
              <SelectItem value="media">Image / Video</SelectItem>
              <SelectItem value="motion">Motion</SelectItem>
            </SelectContent>
          </Select>

          {fullScreenBackgroundTypeValue === 'color' ? (
            <ColorPicker
              value={fullScreenBackgroundColorValue}
              onChange={handleFullScreenColorChange}
              darkMode={darkMode}
              disabled={fullScreenControlsDisabled}
              className={`ml-auto ${darkMode ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-300'} ${fullScreenControlsDisabled ? 'opacity-70 cursor-not-allowed' : ''}`}
            />
          ) : fullScreenBackgroundTypeValue === 'media' ? (
            <div className="flex items-center gap-2 ml-auto min-w-0 max-w-full">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                className="hidden"
                onChange={handleMediaSelection}
                disabled={fullScreenControlsDisabled}
              />
              {hasBackgroundMedia && (
                <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md ${darkMode ? 'bg-green-900/40 text-green-400' : 'bg-green-100 text-green-700'}`}>
                  {settings.fullScreenBackgroundMedia?.mimeType?.startsWith('video/') ||
                    (typeof settings.fullScreenBackgroundMedia?.url === 'string' && /\.(mp4|webm|ogg|m4v|mov)$/i.test(settings.fullScreenBackgroundMedia.url))
                    ? <Video className="w-4 h-4" />
                    : <Image className="w-4 h-4" />
                  }
                  <span className="text-xs font-medium">Active</span>
                </div>
              )}
              <Button
                variant="outline"
                onClick={triggerFileDialog}
                disabled={fullScreenControlsDisabled}
                className={`h-9 px-4 flex-shrink-0 ${hasBackgroundMedia
                  ? (darkMode ? 'border-blue-600 text-blue-400 hover:bg-blue-900/30' : 'border-blue-500 text-blue-600 hover:bg-blue-50')
                  : (darkMode ? 'border-gray-600 text-gray-200 hover:bg-gray-700' : '')
                  } ${fullScreenControlsDisabled ? 'opacity-70 cursor-not-allowed' : ''}`}
              >
                {hasBackgroundMedia ? 'Change' : 'Add File'}
              </Button>
              {hasBackgroundMedia && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    update('fullScreenBackgroundMedia', null);
                    update('fullScreenBackgroundMediaName', '');
                  }}
                  disabled={fullScreenControlsDisabled}
                  className={`h-9 w-9 flex-shrink-0 ${darkMode ? 'text-gray-400 hover:text-red-400 hover:bg-red-900/20' : 'text-gray-500 hover:text-red-600 hover:bg-red-50'}`}
                  title="Remove background"
                >
                  <X className="w-4 h-4" />
                </Button>
              )}
              {hasBackgroundMedia && (
                <span
                  className={`text-sm max-w-[180px] min-w-0 truncate ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}
                  title={uploadedMediaName}
                >
                  {uploadedMediaName}
                </span>
              )}
            </div>
          ) : (
            <MotionBackgroundControls
              darkMode={darkMode}
              presetId={settings.fullScreenBackgroundMotionPreset || 'amber-drift'}
              dim={settings.fullScreenBackgroundMotionDim ?? 0.65}
              onPresetChange={(val) => update('fullScreenBackgroundMotionPreset', val)}
              onDimChange={(val) => update('fullScreenBackgroundMotionDim', val)}
              disabled={fullScreenControlsDisabled}
            />
          )}
        </div>

        <div className="flex items-center justify-between w-full pt-3">
          <Tooltip content="Show fullscreen background even when the output is toggled off" side="right">
            <label className={`text-sm ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>Always Show Background</label>
          </Tooltip>
          <Switch
            checked={Boolean(settings.alwaysShowBackground)}
            onCheckedChange={(checked) => update('alwaysShowBackground', checked)}
            aria-label="Toggle always show background"
            className={`!h-7 !w-14 !border-0 shadow-sm transition-colors ${darkMode
              ? 'data-[state=checked]:bg-green-400 data-[state=unchecked]:bg-gray-600'
              : 'data-[state=checked]:bg-black data-[state=unchecked]:bg-gray-300'
              }`}
            thumbClassName="!h-5 !w-6 data-[state=checked]:!translate-x-7 data-[state=unchecked]:!translate-x-1"
          />
        </div>
      </div>

      <PerformanceSection 
        darkMode={darkMode} 
        settings={performanceSettings} 
        setSettings={setPerformanceSettings} 
      />

      <NdiOutputSection outputKey={outputKey} settings={settings} update={update} />

      <GeneralBehaviorSection
        darkMode={darkMode}
        autoTurnOnOutput={autoTurnOnOutput}
        setAutoTurnOnOutput={setAutoTurnOnOutput}
      />
    </div>
  );
};

export default OutputSettingsPanel;
