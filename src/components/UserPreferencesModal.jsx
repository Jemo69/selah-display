import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Globe, Trash2, Monitor, Database, Zap, Keyboard, Settings, ScreenShare, AlertTriangle, X, Trash, Layers, Sparkles, Gauge, BookOpen, ListMusic, LayoutPanelLeft, Send, Crosshair, Palette, FlaskConical, FileText, Radio, GraduationCap } from 'lucide-react';
import { formatForDisplay } from '@tanstack/hotkeys';
import useRccgTphbStore from '../context/RccgTphbStore';
import useToast from '../hooks/useToast';
import useHttpActionRunner from '../hooks/useHttpActionRunner';
import { useOutputAutomationState, useOutputRegistry, usePerformanceSettings, useHttpActionButtonsState, useFHintEnabled, useFreeNotesEnabled, useLyricContentSearchEnabled, useBibleVerseEditorEnabled, useSchedulerEnabled } from '../hooks/useStoreSelectors';
import { buildOutputAutomationTemplate, runOutputAutomationAction } from '../utils/outputAutomation';
import { buildHttpExample, inspectHttpActionConfig } from '../utils/httpAction';
import { normalizeHttpVariables } from '../utils/httpActionVariables';
import HttpActionVariablesEditor from './HttpActionVariablesEditor';
import { Textarea } from '@/components/ui/textarea';
import { createLogger } from '../utils/logger.js';
import useHotkeysStore from '../context/HotkeysStore';
import { SHORTCUT_GROUPS, DEFAULT_BINDINGS } from '../constants/hotkeyBindings';
import { serializeRecordedHotkey } from '../utils/shortcutHelpers';
import { ControlSocketContext } from '../context/ControlSocketProvider';
import useLyricsStore from '../context/LyricsStore';
import useBibleStore from '../context/BibleStore';
import { BIBLE_SPLIT_METHOD_OPTIONS } from '../utils/bibleSplitter';
import { orderBibleMetadata } from 'shared/bible';
import { outputTemplates, bibleTemplates, freeNoteTemplates, stageTemplates } from '../utils/outputTemplates';
import { useOutputTemplateSync } from '../hooks/useOutputTemplateSync';
import { MidiOscSection } from './MidiOscSettings';
import BibleImportButton from './Bible/BibleImportButton';
import DiagnosticsSection from './DiagnosticsSection';
import OnboardSection from './Onboarding/OnboardSection';
import { useOnboardStore, ROLE_HIDDEN } from '../context/OnboardStore';
import SpeechSettingsSection from './Speech/SpeechSettingsSection';
import useSpeechStore from '../context/SpeechStore';

const logger = createLogger('UserPreferences');

const ShortcutRow = ({ id, label, combo, darkMode, onRecord, onReset, isRecording }) => (
  <div className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors ${darkMode ? 'border-gray-800 bg-gray-900/40 hover:bg-gray-800/60' : 'border-gray-200 bg-white hover:bg-gray-50'}`}>
    <span className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>{label}</span>
    <div className="flex items-center gap-2">
      <kbd className={`inline-flex items-center px-2.5 py-1 text-xs font-mono font-semibold rounded-md border shadow-sm whitespace-nowrap ${isRecording ? 'bg-blue-600 text-white border-blue-500 animate-pulse' : darkMode ? 'bg-gray-950 text-blue-300 border-gray-700' : 'bg-gray-50 text-gray-700 border-gray-300'}`}>
        {isRecording ? 'Recording…' : formatForDisplay(combo)}
      </kbd>
      <Button variant="ghost" size="sm" onClick={() => onRecord(id)}
        className="h-7 px-2 text-xs text-blue-500 hover:text-blue-400 hover:bg-blue-500/10">
        {isRecording ? 'Waiting…' : 'Record'}
      </Button>
      {combo !== DEFAULT_BINDINGS[id] && (
        <Button variant="ghost" size="sm" onClick={() => onReset(id)}
          className="h-7 px-2 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-500/10">
          Reset
        </Button>
      )}
    </div>
  </div>
);

const KeyboardShortcutsSection = ({ darkMode }) => {
  const bindings = useHotkeysStore((s) => s.bindings);
  const setBinding = useHotkeysStore((s) => s.setBinding);
  const resetBinding = useHotkeysStore((s) => s.resetBinding);
  const resetBindings = useHotkeysStore((s) => s.resetBindings);
  const [recordingId, setRecordingId] = React.useState(null);

  React.useEffect(() => {
    if (!recordingId) return undefined;
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecordingId(null);
        return;
      }
      const combo = serializeRecordedHotkey(e);
      if (combo) {
        setBinding(recordingId, combo);
        setRecordingId(null);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recordingId, setBinding]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className={`text-base font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>Keyboard Shortcuts</h3>
          <p className={`text-xs mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Click Record then press a key combination to rebind. Esc cancels.</p>
        </div>
        <Button variant="outline" size="sm" onClick={resetBindings}>Reset all</Button>
      </div>
      {recordingId && (
        <div className={`rounded-lg border border-blue-500/50 bg-blue-500/10 px-3 py-2 text-xs text-blue-300`}>
          Press the new shortcut for “{SHORTCUT_GROUPS.flatMap((g) => g.items).find((i) => i.id === recordingId)?.label}”…
        </div>
      )}
      <div className="space-y-5 max-h-[52vh] overflow-y-auto pr-1">
        {SHORTCUT_GROUPS.map((group) => (
          <div key={group.category} className="space-y-2.5">
            <h4 className={`text-[11px] font-bold uppercase tracking-widest ${darkMode ? 'text-blue-400' : 'text-blue-600'}`}>{group.category}</h4>
            <div className="space-y-2">
              {group.items.map((item) => (
                <ShortcutRow key={item.id} id={item.id} label={item.label} combo={bindings[item.id] || DEFAULT_BINDINGS[item.id]} darkMode={darkMode} isRecording={recordingId === item.id} onRecord={setRecordingId} onReset={resetBinding} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const RccgTphbSettings = ({ darkMode }) => {
  const { apiKey, baseUrl, isConnected, setApiKey, setBaseUrl, clearCredentials } = useRccgTphbStore();
  const { showToast } = useToast();
  const [baseUrlInput, setBaseUrlInput] = React.useState(baseUrl);
  const [apiKeyInput, setApiKeyInput] = React.useState(apiKey);
  const [verifying, setVerifying] = React.useState(false);

  React.useEffect(() => {
    setBaseUrlInput(baseUrl);
    setApiKeyInput(apiKey);
  }, [baseUrl, apiKey]);

  const normalizeUrl = (url) => (url || '').replace(/\/+$/, '');

  const handleSave = React.useCallback(() => {
    const url = normalizeUrl(baseUrlInput);
    const key = apiKeyInput.trim();
    if (!url) {
      showToast({ title: 'Missing base URL', message: 'Enter the RCCGTPHB API base URL.', variant: 'warning' });
      return;
    }
    setBaseUrl(url);
    setApiKey(key);
    showToast({ title: 'RCCGTPHB settings saved', message: 'The database connection details were updated.', variant: 'success' });
  }, [apiKeyInput, baseUrlInput, setApiKey, setBaseUrl, showToast]);

  const handleClear = React.useCallback(() => {
    clearCredentials();
    setBaseUrlInput('');
    setApiKeyInput('');
    showToast({ title: 'Credentials cleared', message: 'RCCGTPHB API key and base URL were removed.', variant: 'success' });
  }, [clearCredentials, showToast]);

  const handleTest = React.useCallback(async () => {
    const url = normalizeUrl(baseUrlInput);
    const key = apiKeyInput.trim();
    if (!url || !key) {
      showToast({ title: 'Missing details', message: 'Enter the base URL and API key before testing.', variant: 'warning' });
      return;
    }
    setVerifying(true);
    try {
      const res = await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${key}` } });
      if (res.ok) {
        showToast({ title: 'Connection successful', message: 'RCCGTPHB database responded.', variant: 'success' });
      } else {
        showToast({ title: 'Connection failed', message: `Server responded with ${res.status}.`, variant: 'error' });
      }
    } catch (err) {
      showToast({ title: 'Connection failed', message: err.message || 'Unable to reach the server.', variant: 'error' });
    } finally {
      setVerifying(false);
    }
  }, [apiKeyInput, baseUrlInput, showToast]);

  return (
    <div className="space-y-6">
      <div>
        <h3 className={`text-base font-semibold flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          <Globe className="w-5 h-5" /> RCCGTPHB Database
        </h3>
        <p className={`text-xs mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Connect to your RCCGTPHB song database via API.</p>
      </div>
      <div className={`rounded-xl border p-5 space-y-4 ${darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-gray-50/80'}`}>
        <div className="flex items-center justify-between">
          <span className={`text-xs font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Status</span>
          <span className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full ${isConnected ? (darkMode ? 'bg-[#8FCE72]/15 text-[#8FCE72] border border-[#8FCE72]/30' : 'bg-[#8FCE72]/10 text-[#2d6a24] border border-[#8FCE72]/20') : (darkMode ? 'bg-[#E06C75]/15 text-[#E06C75] border border-[#E06C75]/30' : 'bg-[#E06C75]/10 text-[#8B2230] border border-[#E06C75]/20')}`}>
            <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
            {isConnected ? 'Connected' : 'Not connected'}
          </span>
        </div>
        <div className="space-y-2">
          <label className={`text-xs font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>Base URL</label>
          <Input type="url" value={baseUrlInput} onChange={(e) => setBaseUrlInput(e.target.value)} placeholder="https://your-rccgtphb-api.com" className={darkMode ? 'bg-gray-950 border-gray-800 text-gray-100' : ''} />
        </div>
        <div className="space-y-2">
          <label className={`text-xs font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>API Key</label>
          <Input type="password" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} placeholder="sk_live_..." className={darkMode ? 'bg-gray-950 border-gray-800 text-gray-100' : ''} />
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={handleSave}>Save</Button>
          <Button variant="outline" size="sm" onClick={handleTest} disabled={verifying}>{verifying ? 'Testing...' : 'Test connection'}</Button>
          <Button variant="ghost" size="sm" onClick={handleClear} className="text-red-500 hover:text-red-400 hover:bg-red-500/10"><Trash2 className="w-3.5 h-3.5 mr-1" />Clear</Button>
        </div>
      </div>
    </div>
  );
};

const ActionCard = ({ action, index, darkMode, onUpdate, onRemove, onFire }) => {
  const isBoolean = action.payloadFormat === 'boolean';
  const isEnabled = action.enabled !== false;
  const template = React.useMemo(() => buildOutputAutomationTemplate(action.onAction || 'YOUR_ACTION_NAME', action.endpoint || 'http://localhost:5505/', action.payloadFormat || 'action', action.onDataValue || 'true'), [action.endpoint, action.onAction, action.payloadFormat, action.onDataValue, isBoolean]);

  return (
    <div className={`rounded-xl border p-4 transition-all ${isEnabled ? (darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white') : (darkMode ? 'border-gray-800 bg-gray-950/30 opacity-60' : 'border-gray-200 bg-gray-50 opacity-60')}`}>
      <div className="flex items-center justify-between mb-3">
        <span className={`text-xs font-semibold uppercase tracking-wide flex items-center gap-2 ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
          <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${darkMode ? 'bg-gray-800 text-gray-300' : 'bg-gray-100 text-gray-600'}`}>{index + 1}</span>
          Action {index + 1}
        </span>
        <div className="flex items-center gap-2">
          <button type="button" role="switch" aria-checked={isEnabled} aria-label={`Toggle action ${index + 1}`} onClick={() => onUpdate(action.id, { enabled: !isEnabled })} className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${isEnabled ? 'bg-blue-600' : (darkMode ? 'bg-gray-700' : 'bg-gray-300')}`}>
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
          <Button variant="ghost" size="sm" onClick={() => onRemove(action.id)} className="h-6 px-2 text-red-500 hover:text-red-400 hover:bg-red-500/10">Remove</Button>
        </div>
      </div>
      <div className="space-y-3">
        <div className="space-y-2">
          <label className={`text-xs font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>Endpoint URL</label>
          <Input value={action.endpoint} onChange={(e) => onUpdate(action.id, { endpoint: e.target.value })} placeholder="http://localhost:5505/" className={darkMode ? 'bg-gray-950 border-gray-800 text-gray-100' : ''} />
        </div>
        <div className="space-y-2">
          <label className={`text-xs font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>Payload format</label>
          <div className={`flex rounded-lg border overflow-hidden ${darkMode ? 'border-gray-800' : 'border-gray-200'}`}>
            <button type="button" onClick={() => onUpdate(action.id, { payloadFormat: 'boolean' })} className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${isBoolean ? 'bg-blue-600 text-white' : darkMode ? 'bg-gray-950 text-gray-400 hover:text-gray-200' : 'bg-white text-gray-500 hover:text-gray-700'}`}>Boolean</button>
            <button type="button" onClick={() => onUpdate(action.id, { payloadFormat: 'action' })} className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${!isBoolean ? 'bg-blue-600 text-white' : darkMode ? 'bg-gray-950 text-gray-400 hover:text-gray-200' : 'bg-white text-gray-500 hover:text-gray-700'}`}>Action name</button>
          </div>
          {isBoolean ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2"><label className={`text-xs font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>ON action</label><Input value={action.onAction} onChange={(e) => onUpdate(action.id, { onAction: e.target.value })} placeholder="e.g. black_screen" className={darkMode ? 'bg-gray-950 border-gray-800 text-gray-100' : ''} /></div>
                <div className="space-y-2"><label className={`text-xs font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>OFF action</label><Input value={action.offAction} onChange={(e) => onUpdate(action.id, { offAction: e.target.value })} placeholder="e.g. black_screen" className={darkMode ? 'bg-gray-950 border-gray-800 text-gray-100' : ''} /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2"><label className={`text-xs font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>ON value</label><Input value={action.offDataValue ?? ''} onChange={(e) => onUpdate(action.id, { onDataValue: e.target.value })} placeholder="e.g. true" className={darkMode ? 'bg-gray-950 border-gray-800 text-gray-100' : ''} /></div>
                <div className="space-y-2"><label className={`text-xs font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>OFF value</label><Input value={action.offDataValue ?? ''} onChange={(e) => onUpdate(action.id, { offDataValue: e.target.value })} placeholder="e.g. false" className={darkMode ? 'bg-gray-950 border-gray-800 text-gray-100' : ''} /></div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2"><label className={`text-xs font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>ON action</label><Input value={action.onAction} onChange={(e) => onUpdate(action.id, { onAction: e.target.value })} placeholder="e.g. output_on" className={darkMode ? 'bg-gray-950 border-gray-800 text-gray-100' : ''} /></div>
              <div className="space-y-2"><label className={`text-xs font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>OFF action</label><Input value={action.offAction} onChange={(e) => onUpdate(action.id, { offAction: e.target.value })} placeholder="e.g. output_off" className={darkMode ? 'bg-gray-950 border-gray-800 text-gray-100' : ''} /></div>
            </div>
          )}
        </div>
        <details className="group"><summary className={`cursor-pointer text-xs font-medium ${darkMode ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700'}`}>Example request</summary><pre className={`mt-2 overflow-x-auto rounded-lg border p-3 text-[11px] ${darkMode ? 'border-gray-800 bg-gray-950 text-gray-200' : 'border-gray-200 bg-white text-gray-700'}`}>{template}</pre></details>
        <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => onFire(action, 'on')}>Test ON</Button><Button variant="outline" size="sm" onClick={() => onFire(action, 'off')}>Test OFF</Button></div>
      </div>
    </div>
  );
};

const AutomationSection = ({ darkMode }) => {
  const { outputActions, addOutputAction, removeOutputAction, updateOutputAction } = useOutputAutomationState();
  const { showToast } = useToast();
  const handleFire = React.useCallback(async (action, state) => {
    const isOn = state === 'on';
    const actionValue = isOn ? action.onAction : action.offAction;
    const dataValue = isOn ? action.onDataValue : action.offDataValue;
    let result;
    if (action.payloadFormat === 'boolean') {
      result = await runOutputAutomationAction(actionValue, action.endpoint, isOn, dataValue);
    } else {
      result = await runOutputAutomationAction(actionValue, action.endpoint);
      if (result.skipped) {
        showToast({ title: 'Missing action name', message: `Set the ${state.toUpperCase()} action name first.`, variant: 'warning' });
        return;
      }
    }
    const message = result.success ? `Fired ${state.toUpperCase()} action successfully.` : (result.error || `HTTP ${result.status || 'error'}${result.statusText ? ` ${result.statusText}` : ''}`);
    showToast({ title: result.success ? 'Request sent' : 'Request failed', message, variant: result.success ? 'success' : 'error' });
  }, [showToast]);

  return (
    <div className="space-y-5">
      <div>
        <h3 className={`text-base font-semibold flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}><Zap className="w-5 h-5" /> Output Automation</h3>
        <p className={`text-xs mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Run HTTP actions when output turns on or off. Chain multiple endpoints.</p>
      </div>
      <div className="space-y-4 max-h-[56vh] overflow-y-auto pr-1">
        {outputActions.map((action, index) => (
          <ActionCard key={action.id} action={action} index={index} darkMode={darkMode} onUpdate={updateOutputAction} onRemove={removeOutputAction} onFire={handleFire} />
        ))}
        {outputActions.length === 0 && (
          <div className={`text-center py-10 rounded-xl border border-dashed ${darkMode ? 'border-gray-800 bg-gray-900/30 text-gray-500' : 'border-gray-200 bg-gray-50 text-gray-400'}`}>
            <Zap className="w-8 h-8 mx-auto mb-3 opacity-40" />
            <p className="text-sm">No automation actions yet</p>
            <p className="text-xs mt-1">Add one to trigger external devices, lighting, or ATEM</p>
          </div>
        )}
      </div>
      <Button variant="secondary" onClick={addOutputAction} className="w-full"><span className="mr-2">+</span> Add Action</Button>
    </div>
  );
};

const METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const HttpActionCard = ({ button, index, darkMode, onUpdate, onRemove, onTest }) => {
  const example = React.useMemo(() => buildHttpExample(button), [button]);
  const check = React.useMemo(() => inspectHttpActionConfig(button), [button]);
  const { headerCheck, bodyCheck, urlError: urlErr } = check;
  const variableCount = normalizeHttpVariables(button.variables).length;
  return (
    <div className={`rounded-xl border p-4 ${darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white'}`}>
      <div className="flex items-center justify-between mb-3">
        <span className={`text-xs font-semibold uppercase tracking-wide flex items-center gap-2 ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
          <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${darkMode ? 'bg-gray-800 text-gray-300' : 'bg-gray-100 text-gray-600'}`}>{index + 1}</span>
          HTTP Button {index + 1}
        </span>
        <Button variant="ghost" size="sm" onClick={() => onRemove(button.id)} className="h-6 px-2 text-red-500 hover:text-red-400 hover:bg-red-500/10">Remove</Button>
      </div>
      <div className="space-y-3">
        <div className="space-y-2">
          <label className={`text-xs font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>Button label</label>
          <Input value={button.label || ''} onChange={(e) => onUpdate(button.id, { label: e.target.value })} placeholder="e.g. Trigger ATEM" className={darkMode ? 'bg-gray-950 border-gray-800 text-gray-100' : ''} />
        </div>
        <div className="space-y-2">
          <label className={`text-xs font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>URL</label>
          <Input value={button.url || ''} onChange={(e) => onUpdate(button.id, { url: e.target.value })} placeholder="http://192.168.1.50:8080/trigger" className={darkMode ? `bg-gray-950 text-gray-100 ${urlErr ? 'border-red-500 focus-visible:ring-red-500' : 'border-gray-800'}` : urlErr ? 'border-red-500 focus-visible:ring-red-500' : ''} />
          {urlErr && <p className="text-[11px] text-red-500">✕ {urlErr}</p>}
        </div>
        <div className="space-y-2">
          <label className={`text-xs font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>Method</label>
          <select value={button.method || 'POST'} onChange={(e) => onUpdate(button.id, { method: e.target.value })} className={`w-full h-9 rounded-md border px-3 text-sm ${darkMode ? 'border-gray-700 bg-gray-950 text-gray-100' : 'border-gray-200 bg-white text-gray-900'}`}>
            {METHOD_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div className="space-y-2">
          <label className={`text-xs font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>Headers <span className="normal-case font-normal opacity-60">(JSON or Key: Value lines)</span></label>
          <Textarea value={button.headers || ''} onChange={(e) => onUpdate(button.id, { headers: e.target.value })} placeholder={'{\n  "Content-Type": "application/json"\n}'} rows={3} className={`${darkMode ? 'bg-gray-950 text-gray-100 font-mono text-xs' : 'font-mono text-xs'} ${!headerCheck.valid ? 'border-red-500 focus-visible:ring-red-500' : darkMode ? 'border-gray-800' : ''}`} />
          {!headerCheck.valid ? <p className="text-[11px] text-red-500">✕ {headerCheck.error}</p> : String(button.headers || '').trim() ? <p className="text-[11px] text-emerald-500">✓ Valid JSON</p> : null}
        </div>
        <div className="space-y-2">
          <label className={`text-xs font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>Body {String(button.body || '').trim() && (String(button.headers || '').toLowerCase().includes('application/json') || String(button.body || '').trim().startsWith('{') || String(button.body || '').trim().startsWith('[')) ? <span className="normal-case font-normal opacity-60">(JSON validated)</span> : null}</label>
          <Textarea value={button.body || ''} onChange={(e) => onUpdate(button.id, { body: e.target.value })} placeholder='{"action":"next"}' rows={3} className={`${darkMode ? 'bg-gray-950 text-gray-100 font-mono text-xs' : 'font-mono text-xs'} ${!bodyCheck.valid ? 'border-red-500 focus-visible:ring-red-500' : darkMode ? 'border-gray-800' : ''}`} />
          {!bodyCheck.valid ? <p className="text-[11px] text-red-500">✕ {bodyCheck.error}</p> : String(button.body || '').trim() ? <p className="text-[11px] text-emerald-500">✓ Valid JSON</p> : <p className={`text-[11px] ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>Invalid JSON will block firing.</p>}
        </div>
        <details className="group"><summary className={`cursor-pointer text-xs font-medium ${darkMode ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700'}`}>Example request</summary><pre className={`mt-2 overflow-x-auto rounded-lg border p-3 text-[11px] ${darkMode ? 'border-gray-800 bg-gray-950 text-gray-200' : 'border-gray-200 bg-white text-gray-700'}`}>{example}</pre></details>
        <div className="border-t pt-3">
          <HttpActionVariablesEditor button={button} darkMode={darkMode} onChange={(patch) => onUpdate(button.id, patch)} />
        </div>
        <div className="flex gap-2 items-center">
          <Button variant="outline" size="sm" onClick={() => onTest(button)} disabled={!headerCheck.valid || !bodyCheck.valid || !!urlErr} title={(!headerCheck.valid || !bodyCheck.valid || !!urlErr) ? 'Fix JSON/URL errors first' : undefined}>Test</Button>
          <span className={`text-[11px] ${!headerCheck.valid || !bodyCheck.valid || !!urlErr ? 'text-red-500' : darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
            {!headerCheck.valid || !bodyCheck.valid || !!urlErr
              ? 'Fix errors before firing'
              : variableCount
                ? `Asks for ${variableCount} value${variableCount === 1 ? '' : 's'} before sending`
                : 'Valid JSON — ready to fire'}
          </span>
        </div>
      </div>
    </div>
  );
};

const HttpActionsSection = ({ darkMode }) => {
  const { buttons, addButton, removeButton, updateButton } = useHttpActionButtonsState();
  const runHttpAction = useHttpActionRunner();

  return (
    <div className="space-y-5">
      <div>
        <h3 className={`text-base font-semibold flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}><Send className="w-5 h-5" /> HTTP Actions</h3>
        <p className={`text-xs mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Manual buttons that appear next to <span className="font-semibold">Bible sidebar</span> in the header. One click = one HTTP request (not on/off). Add variables to an action and it will ask for your input before each request.</p>
      </div>
      <div className="space-y-4 max-h-[56vh] overflow-y-auto pr-1">
        {buttons.map((b, idx) => (
          <HttpActionCard key={b.id} button={b} index={idx} darkMode={darkMode} onUpdate={updateButton} onRemove={removeButton} onTest={(button) => runHttpAction(button, { darkMode })} />
        ))}
        {buttons.length === 0 && (
          <div className={`text-center py-10 rounded-xl border border-dashed ${darkMode ? 'border-gray-800 bg-gray-900/30 text-gray-500' : 'border-gray-200 bg-gray-50 text-gray-400'}`}>
            <Send className="w-8 h-8 mx-auto mb-3 opacity-40" />
            <p className="text-sm">No HTTP buttons yet</p>
            <p className="text-xs mt-1">Add one — it will appear as a pill next to Bible sidebar. Click the body to fire.</p>
          </div>
        )}
      </div>
      <Button variant="secondary" onClick={addButton} className="w-full"><span className="mr-2">+</span> Add HTTP Button</Button>
      {buttons.length > 0 && (
        <p className={`text-[11px] leading-relaxed ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>Tip: each button is a single configurable HTTP request (label / URL / method / headers / body / variables). Use <span className="font-mono">Test</span> to verify, then use the pill in the main header — press its body to fire. A button with no variables sends straight away.</p>
      )}
    </div>
  );
};

const ScreensSection = ({ darkMode }) => {
  const { outputs, deleteCustomOutput } = useOutputRegistry();
  const { showToast } = useToast();
  const socketCtx = React.useContext(ControlSocketContext);
  const emitOutputRegistryUpdate = socketCtx?.emitOutputRegistryUpdate;
  const [confirmId, setConfirmId] = React.useState(null);

  const builtInOutputs = outputs.filter((o) => o.builtIn);
  const customOutputs = outputs.filter((o) => !o.builtIn);

  const handleDelete = React.useCallback((output) => {
    const outputKey = output.key;
    deleteCustomOutput(outputKey);
    const registryState = useLyricsStore.getState();
    emitOutputRegistryUpdate?.({
      customOutputs: registryState.customOutputs,
      customOutputSettings: registryState.customOutputSettings,
      customOutputEnabled: registryState.customOutputEnabled,
    });
    showToast({ title: 'Screen deleted', message: `${output.name} has been removed.`, variant: 'success' });
    setConfirmId(null);
  }, [deleteCustomOutput, emitOutputRegistryUpdate, showToast]);

  return (
    <div className="space-y-6">
      <div>
        <h3 className={`text-base font-semibold flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}><Monitor className="w-5 h-5" /> Screens & Outputs</h3>
        <p className={`text-xs mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Manage your display outputs. Built-in screens cannot be deleted. Custom screens can be created from the control panel.</p>
      </div>

      <div className="space-y-5">
        <div>
          <h4 className={`text-[11px] font-bold uppercase tracking-widest mb-3 flex items-center gap-2 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            <Layers className="w-3.5 h-3.5" /> Built-in ({builtInOutputs.length})
          </h4>
          <div className="grid gap-2.5">
            {builtInOutputs.map((output) => (
              <div key={output.key} className={`group flex items-center justify-between p-3.5 rounded-xl border transition-all ${darkMode ? 'bg-gray-900/60 border-gray-800 hover:border-gray-700' : 'bg-white border-gray-200 hover:border-gray-300 hover:shadow-sm'}`}>
                <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${darkMode ? 'bg-[#282946] text-[#82AAFF]' : 'bg-blue-50 text-blue-600'}`}>
                    {output.key === 'stage' ? <ScreenShare className="w-4.5 h-4.5" /> : <Monitor className="w-4.5 h-4.5" />}
                  </div>
                  <div className="min-w-0">
                    <div className={`text-sm font-medium truncate ${darkMode ? 'text-white' : 'text-gray-900'}`}>{output.name}</div>
                    <div className={`text-xs font-mono truncate flex items-center gap-2 ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                      <span>/{output.slug}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${output.type === 'stage' ? (darkMode ? 'bg-purple-500/20 text-purple-300' : 'bg-purple-50 text-purple-700') : (darkMode ? 'bg-blue-500/20 text-blue-300' : 'bg-blue-50 text-blue-700')}`}>{output.type}</span>
                    </div>
                  </div>
                </div>
                <div className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full ${darkMode ? 'bg-gray-800 text-gray-400 border border-gray-700' : 'bg-gray-100 text-gray-500'}`}>Built-in</div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-3">
            <h4 className={`text-[11px] font-bold uppercase tracking-widest flex items-center gap-2 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              <Sparkles className="w-3.5 h-3.5" /> Custom Screens ({customOutputs.length})
            </h4>
            {customOutputs.length > 0 && (
              <span className={`text-[11px] ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>{customOutputs.length} custom</span>
            )}
          </div>
          {customOutputs.length === 0 ? (
            <div className={`text-center py-10 rounded-xl border border-dashed ${darkMode ? 'border-gray-800 bg-gray-900/20 text-gray-500' : 'border-gray-300 bg-gray-50/50 text-gray-500'}`}>
              <div className={`w-14 h-14 mx-auto mb-3 rounded-full flex items-center justify-center ${darkMode ? 'bg-gray-800/50' : 'bg-gray-100'}`}>
                <Monitor className="w-7 h-7 opacity-40" />
              </div>
              <p className="text-sm font-medium">No custom screens yet</p>
              <p className="text-xs mt-1 max-w-[280px] mx-auto">Create new outputs from the control panel using the “New Output” button. Each gets its own URL like /my-screen.</p>
            </div>
          ) : (
            <div className="grid gap-2.5">
              {customOutputs.map((output) => (
                <div key={output.key} className={`group flex items-center justify-between p-3.5 rounded-xl border transition-all ${darkMode ? 'bg-gray-900/60 border-gray-800 hover:border-gray-700 hover:bg-gray-900' : 'bg-white border-gray-200 hover:border-gray-300 hover:shadow-sm'}`}>
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${darkMode ? 'bg-[#282946] text-[#8FCE72]' : 'bg-emerald-50 text-emerald-600'}`}>
                      {output.type === 'stage' ? <ScreenShare className="w-4.5 h-4.5" /> : <Monitor className="w-4.5 h-4.5" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm font-medium truncate ${darkMode ? 'text-white' : 'text-gray-900'}`}>{output.name}</div>
                      <div className={`text-xs font-mono truncate flex items-center gap-2 ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                        <span>/{output.slug}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${output.type === 'stage' ? (darkMode ? 'bg-purple-500/20 text-purple-300' : 'bg-purple-50 text-purple-700') : (darkMode ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-50 text-emerald-700')}`}>{output.type}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-3">
                    {confirmId === output.key ? (
                      <div className="flex items-center gap-1.5">
                        <Button variant="ghost" size="sm" onClick={() => setConfirmId(null)} className="h-7 px-2.5 text-xs">Cancel</Button>
                        <Button size="sm" onClick={() => handleDelete(output)} className="h-7 px-3 text-xs bg-red-600 hover:bg-red-700 text-white">Delete</Button>
                      </div>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => setConfirmId(output.key)} className={`h-8 w-8 p-0 rounded-lg ${darkMode ? 'hover:bg-red-900/30 text-gray-400 hover:text-red-400' : 'hover:bg-red-50 text-gray-400 hover:text-red-600'}`} title={`Delete ${output.name}`}>
                        <Trash className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={`rounded-xl p-3.5 border flex gap-3 ${darkMode ? 'bg-amber-900/10 border-amber-800/30 text-amber-200/80' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="text-xs leading-relaxed">
            <span className="font-semibold">Heads up:</span> Deleting a screen removes its custom styling, background media, and disables its browser source. Any OBS/browser source pointed to <span className="font-mono">/{'{slug}'}</span> will show 404 until you recreate it.
          </div>
        </div>
      </div>
    </div>
  );
};

const PerformanceSection = ({ darkMode }) => {
  const { settings, setSettings } = usePerformanceSettings();

  const toggle = (key) => setSettings({ [key]: !settings[key] });

  const options = [
    {
      key: 'lowPowerMode',
      label: 'Low Power Mode',
      desc: 'Disables all animations and transitions in output windows. Reduces CPU usage on older hardware.',
    },
    {
      key: 'disableVideoPreloading',
      label: 'Disable Video Preloading',
      desc: 'Reduces RAM usage by streaming videos directly from disk instead of preloading.',
    },
    {
      key: 'reducedGraphics',
      label: 'Reduced Graphics',
      desc: 'Simplifies text shadows, borders, and visual effects. Improves rendering speed.',
    },
    {
      key: 'gpuEffects',
      label: 'GPU Effects',
      desc: 'Enables blur transitions, spring animations, and backdrop blur. Turn off for weaker hardware — effects fall back to smooth fades.',
    },
    {
      key: 'disableHardwareAcceleration',
      label: 'Hardware Acceleration',
      desc: 'When disabled, uses CPU-only rendering. Only disable if GPU causes visual artifacts. Requires app restart.',
    },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h3 className={`text-base font-semibold flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}><Gauge className="w-5 h-5" /> Performance</h3>
        <p className={`text-xs mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Tune rendering and resource usage for your hardware.</p>
      </div>
      <div className="space-y-3">
        {options.map((opt) => {
          const isOn = settings[opt.key];
          const isHardwareAccel = opt.key === 'disableHardwareAcceleration';
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => toggle(opt.key)}
              className={`w-full text-left flex items-center justify-between gap-4 rounded-xl border p-4 transition-all ${darkMode ? 'bg-[#282946]/40 border-[#282946] text-gray-100' : 'bg-white border-gray-200 text-gray-900'}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>{opt.label}</span>
                  {isHardwareAccel && isOn && (
                    <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${darkMode ? 'bg-[#E8B45C]/15 text-[#E8B45C]' : 'bg-[#E8B45C]/15 text-[#8B6914]'}`}>Restart required</span>
                  )}
                </div>
                <p className={`text-xs mt-1 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>{opt.desc}</p>
              </div>
              <Switch checked={isOn} onCheckedChange={() => toggle(opt.key)} />
            </button>
          );
        })}
      </div>
    </div>
  );
};

const BibleSection = ({ darkMode }) => {
  const settings = useBibleStore((s) => s.settings);
  const updateSettings = useBibleStore((s) => s.updateSettings);
  const bibleMetadata = useBibleStore((s) => s.bibleMetadata);
  const defaultBibleId = useBibleStore((s) => s.defaultBibleId);
  const setDefaultBible = useBibleStore((s) => s.setDefaultBible);
  const switchInPlace = Boolean(settings?.switchInPlace);
  const splitLongVerses = Boolean(settings?.splitLongVerses);
  const splitMethod = settings?.splitMethod || 'nearest-punctuation';
  // Default-on: persisted settings from older versions lack the key and must
  // keep trimming copy-paste blobs until the operator opts out.
  const truncateVersionPreviews = settings?.truncateVersionPreviews !== false;
  // Separate setting: Bible search logging (local-only search analytics).
  // Default-on so older persisted settings keep logging until opted out.
  const logBibleSearches = settings?.logBibleSearches !== false;

  const toggleSwitchInPlace = () => updateSettings({ switchInPlace: !switchInPlace });

  const orderedBibleMetadata = React.useMemo(
    () => orderBibleMetadata(bibleMetadata, defaultBibleId),
    [bibleMetadata, defaultBibleId]
  );
  const hasBibles = orderedBibleMetadata.length > 0;

  const handleBibleImported = React.useCallback(({ id }) => {
    // First import becomes the default, while later imports never overwrite
    // a user's deliberate default translation.
    if (!useBibleStore.getState().defaultBibleId) {
      setDefaultBible(id);
    }
  }, [setDefaultBible]);

  return (
    <div className="space-y-5">
      <div>
        <h3 className={`text-base font-semibold flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}><BookOpen className="w-5 h-5" /> Bible</h3>
        <p className={`text-xs mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Configure verse selection and translations.</p>
      </div>
      <div className={`rounded-xl border p-4 ${darkMode ? 'bg-[#282946]/40 border-[#282946]' : 'bg-white border-gray-200'}`}>
        <div className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>Bible library</div>
        <p className={`text-xs mt-1 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
          Import a translation file to make it available in the Bible panel. Zefania, OSIS, Beblia, and OpenSong files are supported.
        </p>
        <BibleImportButton darkMode={darkMode} onImported={handleBibleImported} />
      </div>
      <div className={`rounded-xl border p-4 ${darkMode ? 'bg-[#282946]/40 border-[#282946]' : 'bg-white border-gray-200'}`}>
        <div className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>Default translation</div>
        <p className={`text-xs mt-1 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Choose which Bible translation is selected by default when the app starts.</p>
        <div className="mt-3">
          {hasBibles ? (
            <select
              value={defaultBibleId || ''}
              onChange={(e) => setDefaultBible(e.target.value || null)}
              className={`w-full rounded-lg border px-3 py-2.5 text-sm ${darkMode
                ? 'bg-gray-950 border-gray-800 text-white'
                : 'bg-white border-gray-300 text-gray-900'
                }`}
            >
              <option value="">System default (first imported)</option>
              {orderedBibleMetadata.map((meta) => (
                <option key={meta.id} value={meta.id}>{meta.name}</option>
              ))}
            </select>
          ) : (
            <div className={`rounded-lg border border-dashed px-3 py-3 text-xs ${darkMode ? 'border-gray-700 text-gray-500 bg-gray-950/50' : 'border-gray-200 text-gray-500 bg-gray-50'}`}>
              No translations imported yet. Import a Bible to set a default.
            </div>
          )}
        </div>
        {hasBibles && defaultBibleId && (
          <p className={`text-[11px] mt-2 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
            Current default: <span className="font-medium">{bibleMetadata[defaultBibleId]?.name || defaultBibleId}</span>
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={toggleSwitchInPlace}
        className={`w-full text-left flex items-center justify-between gap-4 rounded-xl border p-4 transition-all ${darkMode ? 'bg-[#282946]/40 border-[#282946] text-gray-100' : 'bg-white border-gray-200 text-gray-900'}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>Switch in place</span>
          </div>
          <p className={`text-xs mt-1 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Re-fetch the current verse from the newly selected translation.</p>
        </div>
        <Switch checked={switchInPlace} onCheckedChange={toggleSwitchInPlace} />
      </button>
      <button
        type="button"
        onClick={() => updateSettings({ splitLongVerses: !splitLongVerses })}
        className={`w-full text-left flex items-center justify-between gap-4 rounded-xl border p-4 transition-all ${darkMode ? 'bg-[#282946]/40 border-[#282946] text-gray-100' : 'bg-white border-gray-200 text-gray-900'}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>Divide long verses into slides</span>
          </div>
          <p className={`text-xs mt-1 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Split verses that exceed the character budget across multiple slides.</p>
        </div>
        <Switch checked={splitLongVerses} onCheckedChange={() => updateSettings({ splitLongVerses: !splitLongVerses })} />
      </button>
      <button
        type="button"
        onClick={() => updateSettings({ truncateVersionPreviews: !truncateVersionPreviews })}
        data-testid="truncate-version-previews-toggle"
        className={`w-full text-left flex items-center justify-between gap-4 rounded-xl border p-4 transition-all ${darkMode ? 'bg-[#282946]/40 border-[#282946] text-gray-100' : 'bg-white border-gray-200 text-gray-900'}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>Trim long verses in translation previews</span>
          </div>
          <p className={`text-xs mt-1 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Cut oversized verse text (for example a copy-pasted duplicate block inside an imported XML verse) down to a short snippet in the preview-all-translations tray, so the panel stays fast. Turn off to show the full text.</p>
        </div>
        <Switch checked={truncateVersionPreviews} onCheckedChange={() => updateSettings({ truncateVersionPreviews: !truncateVersionPreviews })} aria-label="Trim long verses in translation previews" />
      </button>
      <button
        type="button"
        onClick={() => updateSettings({ logBibleSearches: !logBibleSearches })}
        data-testid="log-bible-searches-toggle"
        className={`w-full text-left flex items-center justify-between gap-4 rounded-xl border p-4 transition-all ${darkMode ? 'bg-[#282946]/40 border-[#282946] text-gray-100' : 'bg-white border-gray-200 text-gray-900'}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>Log Bible searches</span>
          </div>
          <p className={`text-xs mt-1 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Keep local-only analytics for Bible passage searches (query text, result counts, timing). Turn off to stop recording Bible searches. Nothing is uploaded.</p>
        </div>
        <Switch checked={logBibleSearches} onCheckedChange={() => updateSettings({ logBibleSearches: !logBibleSearches })} aria-label="Log Bible searches" />
      </button>
      <div className={`rounded-xl border p-4 ${darkMode ? 'bg-[#282946]/40 border-[#282946]' : 'bg-white border-gray-200'}`}>
        <div className={`text-sm font-medium mb-1.5 ${darkMode ? 'text-white' : 'text-gray-900'}`}>Bible split method</div>
        <p className={`text-xs mb-3 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Choose how long verses are divided across slides.</p>
        <div className="grid gap-2">
          {BIBLE_SPLIT_METHOD_OPTIONS.map((option) => {
            const isSelected = splitMethod === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => updateSettings({ splitMethod: option.id })}
                className={`w-full text-left flex items-start gap-3 rounded-xl border p-3.5 transition-all ${isSelected
                  ? (darkMode ? 'border-[#7DDBD3]/60 bg-[#7DDBD3]/10' : 'border-[#7DDBD3] bg-[#7DDBD3]/10')
                  : (darkMode ? 'border-[#282946] hover:border-gray-700' : 'border-gray-200 hover:border-gray-300')}`}
              >
                <span className={`mt-1.5 h-4 w-4 shrink-0 rounded-full border-[5px] transition-colors ${isSelected ? 'border-[#7DDBD3] bg-[#7DDBD3]/30' : (darkMode ? 'border-gray-700 bg-transparent' : 'border-gray-300 bg-transparent')}`} />
                <span className="min-w-0 flex-1">
                  <span className={`block text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>{option.label}</span>
                  <span className={`block text-xs mt-0.5 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>{option.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const LyricsSection = ({ darkMode }) => {
  const autoGroupLines = useLyricsStore((s) => s.autoGroupLines);
  const setAutoGroupLines = useLyricsStore((s) => s.setAutoGroupLines);
  const enableLyricSplitting = useLyricsStore((s) => s.enableLyricSplitting ?? true);
  const setEnableLyricSplitting = useLyricsStore((s) => s.setEnableLyricSplitting);
  const showSelectedLineHighlight = useLyricsStore((s) => s.showSelectedLineHighlight ?? true);
  const setShowSelectedLineHighlight = useLyricsStore((s) => s.setShowSelectedLineHighlight);

  const toggleAutoGroupLines = () => setAutoGroupLines(!autoGroupLines);
  const toggleLyricSplitting = () => setEnableLyricSplitting(!enableLyricSplitting);

  return (
    <div className="space-y-5">
      <div>
        <h3 className={`text-base font-semibold flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}><ListMusic className="w-5 h-5" /> Lyrics</h3>
        <p className={`text-xs mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Control how lyrics are parsed and grouped when loaded.</p>
      </div>
      <button
        type="button"
        onClick={toggleLyricSplitting}
        className={`w-full text-left flex items-center justify-between gap-4 rounded-xl border p-4 transition-all ${darkMode ? 'bg-[#282946]/40 border-[#282946] text-gray-100' : 'bg-white border-gray-200 text-gray-900'}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>Auto-break long lines</span>
          </div>
          <p className={`text-xs mt-1 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Intelligently split lines longer than ~80 characters into shorter segments for display. Disable to keep every line exactly as written or imported.</p>
        </div>
        <Switch checked={enableLyricSplitting} onCheckedChange={toggleLyricSplitting} />
      </button>
      <button
        type="button"
        onClick={toggleAutoGroupLines}
        className={`w-full text-left flex items-center justify-between gap-4 rounded-xl border p-4 transition-all ${darkMode ? 'bg-[#282946]/40 border-[#282946] text-gray-100' : 'bg-white border-gray-200 text-gray-900'}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>Auto-group short lines</span>
          </div>
          <p className={`text-xs mt-1 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Combine two consecutive short lines into a single 2-line slide. Disable to display every line as-written (including 1-line or 3-line verses).</p>
        </div>
        <Switch checked={autoGroupLines} onCheckedChange={toggleAutoGroupLines} />
      </button>
      <button
        type="button"
        onClick={() => setShowSelectedLineHighlight(!showSelectedLineHighlight)}
        className={`w-full text-left flex items-center justify-between gap-4 rounded-xl border p-4 transition-all ${darkMode ? 'bg-[#282946]/40 border-[#282946] text-gray-100' : 'bg-white border-gray-200 text-gray-900'}`}
      >
        <div className="min-w-0 flex-1">
          <span className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>Show selected lyric highlight</span>
          <p className={`text-xs mt-1 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Keep the selected line visible in the control panel without changing what is sent to displays.</p>
        </div>
        <Switch checked={showSelectedLineHighlight} onCheckedChange={setShowSelectedLineHighlight} />
      </button>
    </div>
  );
};

const DEFAULT_LAYOUT_OPTIONS = [
  { id: 'songs', label: 'Songs', desc: 'Open on the lyrics control panel.' },
  { id: 'bible', label: 'Bible (full width)', desc: 'Open in Bible mode with the sidebar hidden.' },
  { id: 'bible-sidebar', label: 'Bible + sidebar', desc: 'Open in Bible mode with the control sidebar shown.' },
];

const InterfaceSection = ({ darkMode }) => {
  const defaultLayout = useLyricsStore((s) => s.defaultLayout);
  const setDefaultLayout = useLyricsStore((s) => s.setDefaultLayout);
  const uiScale = useLyricsStore((s) => s.uiScale);
  const setUiScale = useLyricsStore((s) => s.setUiScale);

  return (
    <div className="space-y-5">
      <div>
        <h3 className={`text-base font-semibold flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}><LayoutPanelLeft className="w-5 h-5" /> Interface</h3>
        <p className={`text-xs mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Choose the startup layout and control panel size.</p>
      </div>

      <div className={`rounded-xl border p-4 ${darkMode ? 'bg-[#282946]/40 border-[#282946]' : 'bg-white border-gray-200'}`}>
        <div className={`text-sm font-medium mb-1.5 ${darkMode ? 'text-white' : 'text-gray-900'}`}>Default layout</div>
        <p className={`text-xs mb-3 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>The layout the app opens with at launch.</p>
        <div className="grid gap-2">
          {DEFAULT_LAYOUT_OPTIONS.map((option) => {
            const isSelected = defaultLayout === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setDefaultLayout(option.id)}
                className={`w-full text-left flex items-start gap-3 rounded-xl border p-3.5 transition-all ${isSelected
                  ? (darkMode ? 'border-[#7DDBD3]/60 bg-[#7DDBD3]/10' : 'border-[#7DDBD3] bg-[#7DDBD3]/10')
                  : (darkMode ? 'border-[#282946] hover:border-gray-700' : 'border-gray-200 hover:border-gray-300')}`}
              >
                <span className={`mt-1.5 h-4 w-4 shrink-0 rounded-full border-[5px] transition-colors ${isSelected ? 'border-[#7DDBD3] bg-[#7DDBD3]/30' : (darkMode ? 'border-gray-700 bg-transparent' : 'border-gray-300 bg-transparent')}`} />
                <span className="min-w-0 flex-1">
                  <span className={`block text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>{option.label}</span>
                  <span className={`block text-xs mt-0.5 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>{option.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={`rounded-xl border p-4 ${darkMode ? 'bg-[#282946]/40 border-[#282946]' : 'bg-white border-gray-200'}`}>
        <div className="flex items-center justify-between gap-4 mb-1.5">
          <div className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>UI scale</div>
          <span className={`text-xs font-mono font-semibold px-2 py-0.5 rounded ${darkMode ? 'bg-gray-800 text-gray-200' : 'bg-gray-100 text-gray-700'}`}>{uiScale}%</span>
        </div>
        <p className={`text-xs mb-3 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Zoom the control interface in or out. Does not affect the projector output.</p>
        <input
          type="range"
          min="75"
          max="150"
          step="5"
          value={uiScale}
          onChange={(e) => setUiScale(Number(e.target.value))}
          className="w-full accent-[#7DDBD3]"
          aria-label="UI scale"
        />
        <div className={`flex justify-between text-[10px] mt-1 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
          <span>75%</span><span>100%</span><span>150%</span>
        </div>
      </div>
    </div>
  );
};

const FHintSection = ({ darkMode }) => {
  const { enabled, setEnabled } = useFHintEnabled();
  // Close hint mode if disabling while active — overlay listens to store but we also hint
  const toggle = () => setEnabled(!enabled);
  return (
    <div className="space-y-5">
      <div>
        <h3 className={`text-base font-semibold flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}><Crosshair className="w-5 h-5" /> F Highlight Mode</h3>
        <p className={`text-xs mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Vimium-style hints — press <span className={`font-mono font-bold px-1.5 py-0.5 rounded text-xs ${darkMode ? 'bg-gray-800 text-[#FFE66D] border border-gray-700' : 'bg-gray-900 text-[#FFE66D] border border-gray-800'}`}>F</span> to show clickable hints, then press the hint letters to click without using the mouse.</p>
      </div>

      <button
        type="button"
        onClick={toggle}
        className={`w-full text-left flex items-center justify-between gap-4 rounded-xl border p-4 transition-all ${darkMode ? 'bg-[#282946]/40 border-[#282946] text-gray-100' : 'bg-white border-gray-200 text-gray-900'}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>Enable F Highlight Mode</span>
            <span className={`text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded ${enabled ? (darkMode ? 'bg-[#FFE66D]/15 text-[#FFE66D] border border-[#FFE66D]/20' : 'bg-[#FFE66D]/20 text-[#8B6914] border border-[#FFE66D]/30') : (darkMode ? 'bg-gray-800 text-gray-500 border border-gray-700' : 'bg-gray-100 text-gray-500 border border-gray-200')}`}>{enabled ? 'ON' : 'OFF'}</span>
          </div>
          <p className={`text-xs mt-1 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>When enabled, pressing <span className="font-mono font-semibold">F</span> (while not typing in an input) overlays yellow hints on every button and link. Press the hint to click. Press <span className="font-mono font-semibold">ESC</span> or <span className="font-mono font-semibold">F</span> again to dismiss.</p>
        </div>
        <Switch checked={enabled} onCheckedChange={toggle} />
      </button>

      <div className={`rounded-xl border p-4 ${darkMode ? 'bg-[#111231]/60 border-[#282946]' : 'bg-gray-50 border-gray-200'}`}>
        <div className={`text-xs font-semibold uppercase tracking-wide mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>How to use</div>
        <ol className={`text-xs leading-relaxed list-decimal list-inside space-y-1.5 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          <li>Focus the control panel so no input is active.</li>
          <li>Press <span className={`font-mono font-bold px-1 py-0.5 rounded ${darkMode ? 'bg-gray-800 text-white border border-gray-700' : 'bg-white text-gray-900 border border-gray-200'}`}>F</span> — yellow badges appear on clickable elements.</li>
          <li>Press the letters shown on a badge (e.g. <span className="font-mono font-bold text-[#FFE66D] bg-black px-1 py-0.5 rounded">A</span> or <span className="font-mono font-bold text-[#FFE66D] bg-black px-1 py-0.5 rounded">AD</span> when many buttons exist) to click it.</li>
          <li>Press <span className="font-mono font-semibold">ESC</span> to exit without clicking, or click the dim backdrop.</li>
        </ol>
        <p className={`text-[11px] mt-3 leading-relaxed ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>Tip: Works on toolbar buttons, tabs, switches, and links — in both the control panel and song canvas. It is disabled automatically while typing in any text field.</p>
      </div>

      <div className={`rounded-xl p-3.5 border flex gap-3 ${darkMode ? 'bg-blue-900/10 border-blue-800/30 text-blue-200/80' : 'bg-blue-50 border-blue-200 text-blue-800'}`}>
        <Keyboard className="w-4 h-4 shrink-0 mt-0.5" />
        <div className="text-xs leading-relaxed">
          <span className="font-semibold">Like Vimium:</span> This is the same idea as the Vimium extension — <span className="font-mono">F</span> = hint mode, no mouse needed.
        </div>
      </div>
    </div>
  );
};

const ModeTemplatesSection = ({ darkMode }) => {
  const { outputs } = useOutputRegistry();
  const { enabled: freeNotesEnabled } = useFreeNotesEnabled();
  const modeTemplates = useLyricsStore((s) => s.modeTemplates);
  const setModeTemplate = useLyricsStore((s) => s.setModeTemplate);
  const copyModeTemplates = useLyricsStore((s) => s.copyModeTemplates);
  const { reapply } = useOutputTemplateSync();
  const { showToast } = useToast();
  const socketCtx = React.useContext(ControlSocketContext);
  const emitToServer = React.useCallback(() => {
    try {
      const mt = useLyricsStore.getState().modeTemplates;
      if (socketCtx?.emitSetModeTemplates) socketCtx.emitSetModeTemplates(mt);
      else if (socketCtx?.socket?.connected) socketCtx.socket.emit('setModeTemplates', { modeTemplates: mt });
      else if (window.__controlSocketContext?.socket?.connected) window.__controlSocketContext.socket.emit('setModeTemplates', { modeTemplates: mt });
    } catch {}
  }, [socketCtx]);
  const [userOutputTemplates, setUserOutputTemplates] = React.useState([]);
  const [userStageTemplates, setUserStageTemplates] = React.useState([]);
  const [copyState, setCopyState] = React.useState({ fromKey: null, targets: [] });

  const loadUserTemplates = React.useCallback(async () => {
    if (!window.electronAPI?.templates?.load) return;
    try {
      const [outRes, stageRes] = await Promise.all([
        window.electronAPI.templates.load('output').catch(() => ({ success: false, templates: [] })),
        window.electronAPI.templates.load('stage').catch(() => ({ success: false, templates: [] })),
      ]);
      const out = outRes?.success ? (outRes.templates || []) : [];
      const stg = stageRes?.success ? (stageRes.templates || []) : [];
      setUserOutputTemplates(out);
      setUserStageTemplates(stg);
    } catch {}
  }, []);

  React.useEffect(() => {
    loadUserTemplates();
    // refresh when window regains focus (user just saved a template) or on custom event
    const onFocus = () => loadUserTemplates();
    const onTemplateSaved = () => loadUserTemplates();
    window.addEventListener('focus', onFocus);
    window.addEventListener('template-saved', onTemplateSaved);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('template-saved', onTemplateSaved);
    };
  }, [loadUserTemplates]);

  const getOptionsForOutput = (output) => {
    const isStage = output.type === 'stage';
    const builtIns = isStage ? stageTemplates : outputTemplates;
    const bibleForStage = bibleTemplates.filter((t) => isStage ? t.id.includes('stage') || t.audience === 'bible' : true);
    const bibleOpts = isStage ? bibleForStage : bibleTemplates;
    return { builtIns, bibleOpts };
  };

  const resolveName = (id) => {
    if (!id) return '— None —';
    if (id === 'default') return 'Default';
    const all = [...outputTemplates, ...bibleTemplates, ...freeNoteTemplates, ...stageTemplates, ...userOutputTemplates, ...userStageTemplates];
    const found = all.find((t) => t.id === id);
    return found ? (found.title || found.name || id) : `${id} (deleted)`;
  };

  const handlePick = (key, mode, val) => {
    const v = val === '__none__' ? null : val;
    setModeTemplate(key, mode, v);
    // Manual-only: saving a pick never touches outputs. Tell the server so
    // the pref syncs, then apply explicitly via the Apply buttons / Showing switch.
    setTimeout(emitToServer, 0);
    const out = outputs.find((o) => o.key === key);
    const modeLabel = mode === 'song' ? 'Song' : mode === 'bible' ? 'Bible' : 'Free Notes';
    showToast({ title: `${out?.name || key} — ${modeLabel}: ${resolveName(v)}`, message: 'Saved — press Apply style or the Showing switch to show it.', variant: 'info' });
  };

  const handleCopySave = () => {
    if (!copyState.fromKey || copyState.targets.length === 0) return;
    copyModeTemplates(copyState.fromKey, copyState.targets);
    setTimeout(emitToServer, 0);
    const fromOut = outputs.find((o) => o.key === copyState.fromKey);
    const targetNames = copyState.targets.map((k) => outputs.find((o) => o.key === k)?.name || k).join(', ');
    showToast({ title: 'Copied', message: `Copied ${fromOut?.name || copyState.fromKey} Song/Bible${freeNotesEnabled ? '/Free Notes' : ''} picks to: ${targetNames}`, variant: 'success' });
    setCopyState({ fromKey: null, targets: [] });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className={`text-base font-semibold flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}><Palette className="w-5 h-5" /> Mode Templates</h3>
        <p className={`text-xs mt-1 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Per-output control. Each output decides for itself — pick a Song and Bible{freeNotesEnabled ? ', and Free Notes' : ''} template, then apply with the buttons below or the <span className="font-semibold">Showing</span> switch in the control panel. Nothing changes on its own. <span className="font-semibold">— None —</span> keeps current style.</p>
      </div>

      <div className="space-y-4">
        {outputs.map((output) => {
          const cfg = modeTemplates?.[output.key] || { enabled: false, song: null, bible: null, freenote: null };
          const isStage = output.type === 'stage';
          const dedup = (arr) => {
            const seen = new Set();
            return arr.filter((t) => { if (!t?.id || seen.has(t.id)) return false; seen.add(t.id); return true; });
          };
          const allUser = dedup([...userOutputTemplates, ...userStageTemplates]);
          const stageUser = dedup(userStageTemplates);
          const regularUser = dedup(userOutputTemplates);
          // Stage must only get stage-shaped templates — regular output templates have fontSize etc
          // and do nothing visible on stage (which uses liveFontSize). Keep regular picks stage-compatible.
          const songOpts = isStage
            ? dedup([...stageTemplates, ...stageUser])
            : dedup([...outputTemplates, ...bibleTemplates, ...freeNoteTemplates, ...allUser]);
          const bibleOpts = isStage
            ? dedup([...stageTemplates.filter((t) => t.id !== 'default'), ...bibleTemplates.filter((t) => t.id === 'bible-stage-verse-focus'), ...stageUser])
            : dedup([...bibleTemplates, ...outputTemplates, ...allUser]);
          const freenoteOpts = isStage
            ? dedup([...stageTemplates.filter((t) => t.id !== 'default'), ...freeNoteTemplates.filter((t) => t.id.includes('stage')), ...stageUser])
            : dedup([...freeNoteTemplates, ...outputTemplates, ...allUser]);
          // Ensure the currently selected id is still shown even if its source bucket differs or template was deleted
          const ensureSelectedVisible = (opts, selectedId) => {
            if (!selectedId || selectedId === '__none__') return opts;
            if (opts.some((t) => t.id === selectedId)) return opts;
            const allCustom = [...userOutputTemplates, ...userStageTemplates];
            const found = allCustom.find((t) => t.id === selectedId) || [...outputTemplates, ...bibleTemplates, ...freeNoteTemplates, ...stageTemplates].find((t) => t.id === selectedId);
            if (found) return [...opts, found];
            // deleted custom template — show placeholder so select doesn't go blank
            return [...opts, { id: selectedId, name: `${selectedId} (deleted)`, title: `${selectedId} (deleted)`, isDeleted: true }];
          };
          const songOptions = ensureSelectedVisible(songOpts, cfg.song);
          const bibleOptions = ensureSelectedVisible(bibleOpts, cfg.bible);
          const freenoteOptions = ensureSelectedVisible(freenoteOpts, cfg.freenote);
          const isCopyOpen = copyState.fromKey === output.key;
          const otherOutputs = outputs.filter((o) => o.key !== output.key);

          return (
            <div key={output.key} className={`rounded-xl border p-4 space-y-3 ${darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white'}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className={`text-sm font-semibold flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                    {isStage ? <ScreenShare className="w-4 h-4 opacity-60" /> : <Monitor className="w-4 h-4 opacity-60" />}
                    {output.name}
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${darkMode ? 'bg-gray-800 text-gray-400' : 'bg-gray-100 text-gray-500'}`}>/{output.slug}</span>
                    {!output.builtIn && <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${darkMode ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-50 text-emerald-700'}`}>custom</span>}
                  </div>
                  <div className={`text-[11px] mt-1 ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>Song / Bible{freeNotesEnabled ? ' / Free Notes' : ''} picks are independent. Custom{isStage ? ' stage' : ''} templates appear automatically.</div>
                </div>
              </div>

              <div className={`grid grid-cols-1 ${freeNotesEnabled ? 'md:grid-cols-3' : 'md:grid-cols-2'} gap-3`}>
                <div className="space-y-1.5">
                  <label className={`text-[11px] font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Song template</label>
                  <select value={cfg.song ?? '__none__'} onChange={(e) => handlePick(output.key, 'song', e.target.value)} className={`w-full rounded-lg border px-3 py-2 text-sm ${darkMode ? 'bg-gray-950 border-gray-800 text-white' : 'bg-white border-gray-300 text-gray-900'}`}>
                    <option value="__none__">— None — · keeps current style</option>
                    {songOptions.map((t) => (
                      <option key={t.id} value={t.id}>{t.title || t.name}{t.isUserTemplate ? ' · My Template' : ''}{t.audience === 'bible' ? ' (Bible)' : ''}{t.audience === 'freenote' ? ' (Notes)' : ''}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className={`text-[11px] font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Bible template</label>
                  <select value={cfg.bible ?? '__none__'} onChange={(e) => handlePick(output.key, 'bible', e.target.value)} className={`w-full rounded-lg border px-3 py-2 text-sm ${darkMode ? 'bg-gray-950 border-gray-800 text-white' : 'bg-white border-gray-300 text-gray-900'}`}>
                    <option value="__none__">— None — · keeps current style</option>
                    {bibleOptions.map((t) => (
                      <option key={t.id} value={t.id}>{t.title || t.name}{t.isUserTemplate ? ' · My Template' : ''}</option>
                    ))}
                  </select>
                </div>
                {freeNotesEnabled && (
                  <div className="space-y-1.5">
                    <label className={`text-[11px] font-semibold uppercase tracking-wide ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Free Notes template</label>
                    <select value={cfg.freenote ?? '__none__'} onChange={(e) => handlePick(output.key, 'freenote', e.target.value)} className={`w-full rounded-lg border px-3 py-2 text-sm ${darkMode ? 'bg-gray-950 border-gray-800 text-white' : 'bg-white border-gray-300 text-gray-900'}`}>
                      <option value="__none__">— None — · keeps current style</option>
                      {freenoteOptions.map((t) => (
                        <option key={t.id} value={t.id}>{t.title || t.name}{t.isUserTemplate ? ' · My Template' : ''}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={() => reapply(output.key, 'song', { manual: true })} className="h-7 text-xs" title={`Apply ${output.name} Song template now`}>
                  Apply Song style
                </Button>
                <Button variant="outline" size="sm" onClick={() => reapply(output.key, 'bible', { manual: true })} className="h-7 text-xs" title={`Apply ${output.name} Bible template now`}>
                  Apply Bible style
                </Button>
                {freeNotesEnabled && (
                  <Button variant="outline" size="sm" onClick={() => reapply(output.key, 'freenote', { manual: true })} className="h-7 text-xs" title={`Apply ${output.name} Free Notes template now`}>
                    Apply Free Notes style
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => setCopyState((s) => s.fromKey === output.key ? { fromKey: null, targets: [] } : { fromKey: output.key, targets: [] })} className="h-7 text-xs">
                  {isCopyOpen ? 'Cancel copy' : 'Copy settings to…'}
                </Button>
                {isCopyOpen && (
                  <span className={`text-[11px] ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Select targets → Save</span>
                )}
              </div>

              {isCopyOpen && (
                <div className={`rounded-lg border p-3 space-y-3 ${darkMode ? 'border-gray-800 bg-gray-950/50' : 'border-gray-200 bg-gray-50'}`}>
                  <div className="flex flex-wrap gap-2">
                    {otherOutputs.map((o) => {
                      const checked = copyState.targets.includes(o.key);
                      return (
                        <label key={o.key} className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-xs cursor-pointer ${checked ? (darkMode ? 'bg-blue-600 text-white border-blue-500' : 'bg-black text-white border-black') : (darkMode ? 'bg-gray-900 border-gray-700 text-gray-300' : 'bg-white border-gray-200 text-gray-700')}`}>
                          <input type="checkbox" checked={checked} onChange={(e) => setCopyState((s) => ({ ...s, targets: e.target.checked ? [...s.targets, o.key] : s.targets.filter((k) => k !== o.key) }))} className="sr-only" />
                          {o.name}
                        </label>
                      );
                    })}
                  </div>
                  {copyState.targets.length > 0 && (
                    <div className={`text-xs ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>Will copy to: <span className="font-semibold">{copyState.targets.map((k) => outputs.find((o) => o.key === k)?.name || k).join(', ')}</span></div>
                  )}
                  <div className="flex gap-2">
                    <Button size="sm" disabled={copyState.targets.length === 0} onClick={handleCopySave} className={darkMode ? 'bg-white text-black hover:bg-gray-100' : ''}>Save</Button>
                    <Button variant="ghost" size="sm" onClick={() => setCopyState({ fromKey: null, targets: [] })}>Cancel</Button>
                  </div>
                </div>
              )}

              <p className={`text-[11px] leading-relaxed ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>“— None —” = that output keeps its current style. Manual tweaks afterwards are preserved until you apply again.</p>
            </div>
          );
        })}
      </div>

      <div className={`rounded-xl p-3.5 border flex gap-3 ${darkMode ? 'bg-blue-900/10 border-blue-800/30 text-blue-200/80' : 'bg-blue-50 border-blue-200 text-blue-800'}`}>
        <Palette className="w-4 h-4 shrink-0 mt-0.5" />
        <div className="text-xs leading-relaxed"><span className="font-semibold">Tip:</span> Styles only change when you press <span className="font-semibold">Apply Song/Bible{freeNotesEnabled ? '/Free Notes' : ''} style</span> or the <span className="font-semibold">Showing</span> switch in the control panel. Undo appears in the toast after applying.</div>
      </div>
    </div>
  );
};

const ExperimentalSection = ({ darkMode }) => {
  const { enabled: freeNotesEnabled, setEnabled: setFreeNotesEnabled } = useFreeNotesEnabled();
  const { enabled: lyricSearchEnabled, setEnabled: setLyricSearchEnabled } = useLyricContentSearchEnabled();
  const { enabled: schedulerEnabled, setEnabled: setSchedulerEnabled } = useSchedulerEnabled();
  const { enabled: bibleVerseEditorEnabled, setEnabled: setBibleVerseEditorEnabled } = useBibleVerseEditorEnabled();
  // The master switch itself. Read here so the Experimental card can show the
  // real on/off state and gate the surface — the store stays the single source
  // of truth, and nothing here writes it except the toggle below.
  const sermonAssistEnabled = useSpeechStore((state) => state.enabled);
  const setSermonAssistEnabled = useSpeechStore((state) => state.setEnabled);
  const { showToast } = useToast();

  const handleToggleFreeNotes = (checked) => {
    setFreeNotesEnabled(checked);
    showToast({
      title: checked ? 'Free Notes enabled' : 'Free Notes disabled',
      message: checked
        ? 'Free Notes mode, Markdown editor, and templates are now active in the app.'
        : 'Free Notes mode is now hidden from the interface.',
      variant: checked ? 'success' : 'info'
    });
  };

  const handleToggleLyricSearch = (checked) => {
    setLyricSearchEnabled(checked);
    showToast({
      title: checked ? 'Lyric Content Search enabled' : 'Lyric Content Search disabled',
      message: checked
        ? 'File Navigator will now search inside lyric contents with highlighted snippets.'
        : 'File Navigator will only search file titles and paths.',
      variant: checked ? 'success' : 'info'
    });
  };

  const handleToggleScheduler = (checked) => {
    setSchedulerEnabled(checked);
    showToast({
      title: checked ? 'Service Scheduler enabled' : 'Service Scheduler disabled',
      message: checked
        ? 'The run-sheet panel is now available. Open /time on stage monitors for the countdown.'
        : 'The run-sheet panel is now hidden from the control panel.',
      variant: checked ? 'success' : 'info'
    });
  };

  const handleToggleBibleVerseEditor = (checked) => {
    setBibleVerseEditorEnabled(checked);
    showToast({
      title: checked ? 'Bible Verse Editor enabled' : 'Bible Verse Editor disabled',
      message: checked
        ? 'Alt+Shift+Enter and the Edit Verse button are now active in the Bible panel.'
        : 'Bible Verse Editor is now disabled and hidden from the interface.',
      variant: checked ? 'success' : 'info'
    });
  };

  // Turning the feature on here does NOT open a microphone. It makes the
  // surface reachable; arming capture is a separate press in the rail, which
  // is exactly invariant 4 — "off by default, cold by default" — and the test
  // asserts the app boots with zero device calls even with this switch on.
  const handleToggleSermonAssist = (checked) => {
    setSermonAssistEnabled(checked);
    showToast({
      title: checked ? 'Live Sermon Assist enabled' : 'Live Sermon Assist disabled',
      message: checked
        ? 'The assist rail is available. The microphone stays closed until you press Resume sermon transcription.'
        : 'The assist rail is hidden and the microphone is released.',
      variant: checked ? 'success' : 'info'
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className={`text-base font-semibold flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          <FlaskConical className="w-5 h-5 text-amber-500" /> Experimental Features
        </h3>
        <p className={`text-xs mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
          Preview and test new capabilities before they become permanent. These features can be turned on or off at any time.
        </p>
      </div>

      {/* Full-Text Lyric Content Search */}
      <div className={`rounded-xl border p-5 space-y-4 transition-all ${darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white'}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5 flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Full-Text Lyric Content Search
              </span>
              <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                darkMode
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'bg-amber-100 text-amber-800 border border-amber-300'
              }`}>
                Experimental
              </span>
              <span className={`text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded ${
                lyricSearchEnabled
                  ? (darkMode ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' : 'bg-emerald-100 text-emerald-800 border border-emerald-200')
                  : (darkMode ? 'bg-gray-800 text-gray-400 border border-gray-700' : 'bg-gray-100 text-gray-500 border border-gray-200')
              }`}>
                {lyricSearchEnabled ? 'ON' : 'OFF'}
              </span>
            </div>
            <p className={`text-xs leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Search inside song lyrics files (.txt, .lrc) in addition to file titles. Powered by an in-memory inverted token index with sub-millisecond candidate pruning, highlighted snippet previews, and badge indicators.
            </p>
          </div>
          <Switch checked={lyricSearchEnabled} onCheckedChange={handleToggleLyricSearch} aria-label="Toggle Full-Text Lyric Content Search" />
        </div>

        {lyricSearchEnabled ? (
          <div className={`rounded-lg border p-3 text-xs leading-relaxed flex items-start gap-2.5 ${
            darkMode ? 'bg-amber-500/10 border-amber-500/30 text-amber-200' : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}>
            <Sparkles className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
            <div>
              <span className="font-semibold">Feature Active:</span> File Navigator searches both song titles and lyric contents. Matching lyrics are highlighted with snippets and marked with <span className="font-semibold">LYRIC MATCH</span> or <span className="font-semibold">TITLE + LYRIC</span> badges.
            </div>
          </div>
        ) : (
          <div className={`rounded-lg border p-3 text-xs leading-relaxed flex items-start gap-2.5 ${
            darkMode ? 'bg-gray-950/60 border-gray-800 text-gray-400' : 'bg-gray-50 border-gray-200 text-gray-600'
          }`}>
            <FileText className="w-4 h-4 shrink-0 mt-0.5 text-gray-400" />
            <div>
              <span className="font-semibold">Feature Inactive:</span> File Navigator only searches file titles and directory paths. Content search and snippet generation are disabled.
            </div>
          </div>
        )}
      </div>

      {/* Bible Verse & Passage Editor */}
      <div className={`rounded-xl border p-5 space-y-4 transition-all ${darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white'}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5 flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Bible Verse & Passage Editor
              </span>
              <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                darkMode
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'bg-amber-100 text-amber-800 border border-amber-300'
              }`}>
                Experimental
              </span>
              <span className={`text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded ${
                bibleVerseEditorEnabled
                  ? (darkMode ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' : 'bg-emerald-100 text-emerald-800 border border-emerald-200')
                  : (darkMode ? 'bg-gray-800 text-gray-400 border border-gray-700' : 'bg-gray-100 text-gray-500 border border-gray-200')
              }`}>
                {bibleVerseEditorEnabled ? 'ON' : 'OFF'}
              </span>
            </div>
            <p className={`text-xs leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Opens an interactive popup editor (<span className="font-mono text-amber-500 font-semibold">Alt+Shift+Enter</span>) from the Bible panel to trim, combine, or split selected scriptures and full chapters into custom slides before broadcasting live to output and stage displays.
            </p>
          </div>
          <Switch checked={bibleVerseEditorEnabled} onCheckedChange={handleToggleBibleVerseEditor} aria-label="Toggle Bible Verse Editor" />
        </div>

        {bibleVerseEditorEnabled ? (
          <div className={`rounded-lg border p-3 text-xs leading-relaxed flex items-start gap-2.5 ${
            darkMode ? 'bg-amber-500/10 border-amber-500/30 text-amber-200' : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}>
            <Sparkles className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
            <div>
              <span className="font-semibold">Feature Active:</span> The <span className="font-semibold">Edit verse</span> button is visible in the Bible panel, and <span className="font-semibold">Alt+Shift+Enter</span> launches the editor with real-time slide formatting and multi-output broadcast.
            </div>
          </div>
        ) : (
          <div className={`rounded-lg border p-3 text-xs leading-relaxed flex items-start gap-2.5 ${
            darkMode ? 'bg-gray-950/60 border-gray-800 text-gray-400' : 'bg-gray-50 border-gray-200 text-gray-600'
          }`}>
            <BookOpen className="w-4 h-4 shrink-0 mt-0.5 text-gray-400" />
            <div>
              <span className="font-semibold">Feature Inactive:</span> The Bible Verse Editor modal, shortcut, and edit button are disabled, keeping scripture selection in direct-send mode.
            </div>
          </div>
        )}
      </div>

      {/* Free Notes Mode */}
      <div className={`rounded-xl border p-5 space-y-4 transition-all ${darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white'}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5 flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Free Notes Mode
              </span>
              <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                darkMode
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'bg-amber-100 text-amber-800 border border-amber-300'
              }`}>
                Experimental
              </span>
              <span className={`text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded ${
                freeNotesEnabled
                  ? (darkMode ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' : 'bg-emerald-100 text-emerald-800 border border-emerald-200')
                  : (darkMode ? 'bg-gray-800 text-gray-400 border border-gray-700' : 'bg-gray-100 text-gray-500 border border-gray-200')
              }`}>
                {freeNotesEnabled ? 'ON' : 'OFF'}
              </span>
            </div>
            <p className={`text-xs leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Obsidian-style Free Notes presentation mode with multi-slide Markdown formatting, dynamic proportional base font scaling, luminous <span className="font-mono text-amber-500 font-semibold">==highlights==</span>, Obsidian callouts (<span className="font-mono text-blue-400">&gt; [!NOTE]</span>), bullet lists, slide dividers (<span className="font-mono text-gray-400">---</span>), live split-screen preview, and independent output templates.
            </p>
          </div>
          <Switch checked={freeNotesEnabled} onCheckedChange={handleToggleFreeNotes} aria-label="Toggle Free Notes Mode" />
        </div>

        {freeNotesEnabled ? (
          <div className={`rounded-lg border p-3 text-xs leading-relaxed flex items-start gap-2.5 ${
            darkMode ? 'bg-amber-500/10 border-amber-500/30 text-amber-200' : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}>
            <Sparkles className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
            <div>
              <span className="font-semibold">Feature Active:</span> The <span className="font-semibold">Notes</span> tab appears in the sidebar next to Songs and Bible, <span className="font-semibold">Free Notes templates</span> are available in Mode Templates, and you can broadcast live notes to your audience displays and stage monitors.
            </div>
          </div>
        ) : (
          <div className={`rounded-lg border p-3 text-xs leading-relaxed flex items-start gap-2.5 ${
            darkMode ? 'bg-gray-950/60 border-gray-800 text-gray-400' : 'bg-gray-50 border-gray-200 text-gray-600'
          }`}>
            <FileText className="w-4 h-4 shrink-0 mt-0.5 text-gray-400" />
            <div>
              <span className="font-semibold">Feature Inactive:</span> All Free Notes tabs, broadcast controls, and template options are completely hidden, keeping the interface minimal with only Songs and Bible.
            </div>
          </div>
        )}
      </div>

      {/* Service Scheduler (run-sheet clock) */}
      <div className={`rounded-xl border p-5 space-y-4 transition-all ${darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white'}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5 flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Service Scheduler
              </span>
              <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                darkMode
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'bg-amber-100 text-amber-800 border border-amber-300'
              }`}>
                Experimental
              </span>
              <span className={`text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded ${
                schedulerEnabled
                  ? (darkMode ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' : 'bg-emerald-100 text-emerald-800 border border-emerald-200')
                  : (darkMode ? 'bg-gray-800 text-gray-400 border border-gray-700' : 'bg-gray-100 text-gray-500 border border-gray-200')
              }`}>
                {schedulerEnabled ? '● ON' : '○ OFF'}
              </span>
            </div>
            <p className={`text-xs leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Timed service run-sheet (Prelude → Praise → Sermon → Benediction) with a stage countdown at <span className="font-mono font-semibold">/time</span>, auto-advance, and a late-start fix that squeezes segments or shifts the end.
            </p>
          </div>
          <Switch checked={schedulerEnabled} onCheckedChange={handleToggleScheduler} aria-label="Toggle Service Scheduler (beta)" />
        </div>

        {schedulerEnabled ? (
          <div className={`rounded-lg border p-3 text-xs leading-relaxed flex items-start gap-2.5 ${
            darkMode ? 'bg-amber-500/10 border-amber-500/30 text-amber-200' : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}>
            <Sparkles className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
            <div>
              <span className="font-semibold">Feature Active:</span> A <span className="font-semibold">Schedule</span> button appears in the control panel for building the run-sheet, and stage monitors can open the <span className="font-semibold">/time</span> countdown.
            </div>
          </div>
        ) : (
          <div className={`rounded-lg border p-3 text-xs leading-relaxed flex items-start gap-2.5 ${
            darkMode ? 'bg-gray-950/60 border-gray-800 text-gray-400' : 'bg-gray-50 border-gray-200 text-gray-600'
          }`}>
            <FileText className="w-4 h-4 shrink-0 mt-0.5 text-gray-400" />
            <div>
              <span className="font-semibold">Feature Inactive:</span> The run-sheet panel stays hidden. The <span className="font-semibold">/time</span> route still shows “No run-sheet” if opened.
            </div>
          </div>
        )}
      </div>

      {/* Live Sermon Assist — EXPERIMENTAL, and experimental for now.

          The plan (section 6.2) argued for a first-class "Speech & AI" sidebar
          section instead, on the grounds that "users must be able to find and
          trust this". That has been reversed deliberately: the feature cannot
          yet transcribe anything, so presenting it as a settled, permanent
          part of the app overstates it. It lives here, behind the same toggle
          pattern as every other preview feature, and graduates to a real
          section when the engine actually works.

          The gate is unchanged and still mechanical: enabling the master switch
          inside SpeechSettingsSection is the only thing that opens a
          microphone, and invariant 4 asserts the app boots with zero DOM nodes
          and no device calls. Putting the entry under Experimental changes
          where an operator FINDS it, never whether it can fire by itself. */}
      <div
        data-testid="sermon-assist-experimental-card"
        className={`rounded-xl border p-5 space-y-4 transition-all ${darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white'}`}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5 flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Live Sermon Assist
              </span>
              <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                darkMode
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'bg-amber-100 text-amber-800 border border-amber-300'
              }`}>
                Experimental
              </span>
              <span className={`text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded ${
                sermonAssistEnabled
                  ? (darkMode ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' : 'bg-emerald-100 text-emerald-800 border border-emerald-200')
                  : (darkMode ? 'bg-gray-800 text-gray-400 border border-gray-700' : 'bg-gray-100 text-gray-500 border border-gray-200')
              }`}>
                {sermonAssistEnabled ? '● ON' : '○ OFF'}
              </span>
            </div>
            <p className={`text-xs leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Transcribe the sermon live and offer the next lyric line, the Bible verse just quoted, and a running sermon note. Nothing reaches a display without an explicit press. The recognition engine is installed separately — see the note below before expecting a transcript.
            </p>
          </div>
          <Switch
            checked={sermonAssistEnabled}
            onCheckedChange={handleToggleSermonAssist}
            aria-label="Toggle Live Sermon Assist (experimental)"
            data-testid="sermon-assist-experimental-toggle"
          />
        </div>

        {!sermonAssistEnabled ? (
          <div className={`rounded-lg border p-3 text-xs leading-relaxed flex items-start gap-2.5 ${
            darkMode ? 'bg-gray-950/60 border-gray-800 text-gray-400' : 'bg-gray-50 border-gray-200 text-gray-600'
          }`}>
            <FileText className="w-4 h-4 shrink-0 mt-0.5 text-gray-400" />
            <div>
              <span className="font-semibold">Feature Inactive:</span> No microphone is opened, nothing is captured, and the assist rail stays hidden. Turning this on is the only thing that can change that.
            </div>
          </div>
        ) : null}

        {/* The full surface always renders here, and carries its own master
            switch that reads and writes the same store flag as the card above.
            Hiding it behind the card's switch would mean two controls for one
            setting and a section that vanishes the moment you turn it on —
            which reads as a broken panel, not a safe default. The important
            guarantee is unchanged either way: while the flag is false the
            microphone is never opened, the rail renders zero DOM nodes, and
            the model list is present but inert. */}
        <SpeechSettingsSection darkMode={darkMode} />
      </div>
    </div>
  );
};

const SIDEBAR_SECTIONS = [
  { id: 'screens', label: 'Screens', icon: Monitor, desc: 'Manage displays' },
  { id: 'modeTemplates', label: 'Mode Templates', icon: Palette, desc: 'Song ↔ Bible ↔ Notes' },
  { id: 'database', label: 'Song Database', icon: Database, desc: 'RCCGTPHB API' },
  { id: 'bible', label: 'Bible', icon: BookOpen, desc: 'Verses & translations' },
  { id: 'httpActions', label: 'HTTP Actions', icon: Send, desc: 'Quick HTTP buttons' },
  { id: 'lyrics', label: 'Lyrics', icon: ListMusic, desc: 'Parsing & grouping' },
  { id: 'interface', label: 'Interface', icon: LayoutPanelLeft, desc: 'Layout & UI scale' },
  { id: 'fHint', label: 'F Highlight Mode', icon: Crosshair, desc: 'Vimium-style hints' },
  { id: 'automation', label: 'Automation', icon: Zap, desc: 'On/Off hooks' },
  { id: 'hardware', label: 'MIDI + OSC', icon: Radio, desc: 'Pedals & Stream Deck' },
  { id: 'performance', label: 'Performance', icon: Gauge, desc: 'Low power mode' },
  { id: 'onboard', label: 'Onboard', icon: GraduationCap, desc: 'Tours, demo & teaching' },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard, desc: 'Key bindings' },
  { id: 'diagnostics', label: 'Diagnostics', icon: FileText, desc: 'Logs & support' },
  { id: 'experimental', label: 'Experimental', icon: FlaskConical, desc: 'Beta & preview features' },
];

const UserPreferencesModal = ({ darkMode, onClose, initialSection = 'screens' }) => {
  logger.info('UserPreferencesModal mounted');
  const [activeSection, setActiveSection] = React.useState(initialSection);
  // Role presets (Preferences → Onboard) hide advanced sections for trainees.
  const onboardRole = useOnboardStore((s) => s.role);
  const hiddenSections = ROLE_HIDDEN[onboardRole] || [];
  const visibleSections = SIDEBAR_SECTIONS.filter((s) => !hiddenSections.includes(s.id));
  const effectiveSection = hiddenSections.includes(activeSection) ? 'onboard' : activeSection;

  const renderSection = () => {
    switch (effectiveSection) {
      case 'screens':
        return <ScreensSection darkMode={darkMode} />;
      case 'modeTemplates':
        return <ModeTemplatesSection darkMode={darkMode} />;
      case 'database':
        return <RccgTphbSettings darkMode={darkMode} />;
      case 'bible':
        return <BibleSection darkMode={darkMode} />;
      case 'lyrics':
        return <LyricsSection darkMode={darkMode} />;
      case 'interface':
        return <InterfaceSection darkMode={darkMode} />;
      case 'fHint':
        return <FHintSection darkMode={darkMode} />;
      case 'automation':
        return <AutomationSection darkMode={darkMode} />;
      case 'hardware':
        return <MidiOscSection darkMode={darkMode} />;
      case 'httpActions':
        return <HttpActionsSection darkMode={darkMode} />;
      case 'performance':
        return <PerformanceSection darkMode={darkMode} />;
      case 'onboard':
        return <OnboardSection darkMode={darkMode} onOpenTour={() => window.dispatchEvent(new CustomEvent('selah-open-onboarding', { detail: { mode: 'tour' } }))} onOpenSpotlight={() => window.dispatchEvent(new CustomEvent('selah-open-spotlight'))} onOpenAI={() => window.dispatchEvent(new CustomEvent('selah-open-onboarding', { detail: { mode: 'ai' } }))} onOpenShortcuts={() => window.dispatchEvent(new CustomEvent('selah-open-shortcuts'))} />;
      case 'shortcuts':
        return <KeyboardShortcutsSection darkMode={darkMode} />;
      case 'diagnostics':
        return <DiagnosticsSection darkMode={darkMode} />;
      case 'experimental':
        return <ExperimentalSection darkMode={darkMode} />;
      default:
        return <ScreensSection darkMode={darkMode} />;
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="User Preferences" className="flex h-[68vh] min-h-[520px] -mx-6 -my-5 rounded-b-2xl overflow-hidden">

      <div className={`w-[240px] shrink-0 flex flex-col border-r ${darkMode ? 'bg-[#111231]/90 border-[#282946]' : 'bg-gray-50 border-gray-200'}`}>
        <div className={`p-4 border-b ${darkMode ? 'border-gray-800' : 'border-gray-200'}`}>
          <div className={`flex items-center gap-2.5 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${darkMode ? 'bg-white text-black' : 'bg-black text-white'}`}>
              <Settings className="w-4 h-4" />
            </div>
            <div>
              <div className="text-[13px] font-bold tracking-tight leading-none">Preferences</div>
              <div className={`text-[11px] mt-1 ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>Configure app</div>
            </div>
          </div>
        </div>
        <nav className="flex-1 p-2.5 space-y-1 overflow-y-auto">
          {visibleSections.map((section) => {
            const isActive = effectiveSection === section.id;
            const Icon = section.icon;
            return (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={`w-full text-left flex items-start gap-3 px-3 py-3 rounded-xl text-sm transition-all group ${
                  isActive
                    ? darkMode
                      ? 'bg-[#7DDBD3]/15 text-[#7DDBD3] shadow-sm'
                      : 'bg-[#7DDBD3]/10 text-[#1a5c54] shadow-sm'
                    : darkMode
                      ? 'text-[#55464B] hover:text-gray-100 hover:bg-gray-900'
                      : 'text-[#55464B] hover:text-gray-900 hover:bg-white hover:shadow-sm border border-transparent hover:border-gray-200'
                }`}
              >
                <Icon className={`w-4.5 h-4.5 mt-0.5 shrink-0 ${isActive ? '' : 'opacity-70 group-hover:opacity-100'}`} />
                <div className="min-w-0 flex-1">
                  <div className={`font-medium leading-none ${isActive ? '' : ''}`}>{section.label}</div>
                  <div className={`text-[11px] mt-1.5 leading-none truncate ${isActive ? (darkMode ? 'text-[#7DDBD3]/60' : 'text-[#1a5c54]/80') : darkMode ? 'text-[#55464B]' : 'text-[#55464B]'}`}>{section.desc}</div>
                </div>
              </button>
            );
          })}
        </nav>
        <div className={`p-3 border-t mt-auto ${darkMode ? 'border-gray-800' : 'border-gray-200'}`}>
          <div className={`text-[11px] leading-relaxed ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
            Tip: Custom screens each get a unique URL. Use them as browser sources in OBS.
          </div>
        </div>
      </div>

      <div className={`flex-1 flex flex-col min-w-0 ${darkMode ? 'bg-[#1A1C40]' : 'bg-white'}`}>
        <div className="flex-1 overflow-y-auto p-6">
          {renderSection()}
        </div>
        <div className={`flex justify-end gap-2 p-4 border-t shrink-0 ${darkMode ? 'border-[#282946] bg-[#1A1C40]/50' : 'border-gray-200 bg-gray-50/50'}`}>
          <Button onClick={onClose} variant={darkMode ? 'secondary' : 'secondary'} className={darkMode ? 'bg-white text-black hover:bg-gray-100' : ''}>Close</Button>
        </div>
      </div>
    </div>
  );
};

export default UserPreferencesModal;
