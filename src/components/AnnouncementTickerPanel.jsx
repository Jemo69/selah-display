import React from 'react';
import { Megaphone, Monitor, Plus, X, Eye, EyeOff, Trash2, Bold, Italic, AlignLeft, AlignCenter, AlignRight, ChevronDown, ChevronRight } from 'lucide-react';
import { safeGet, safeSet } from '../utils/persistentStorage';
import { TICKER_DEFAULT_STYLE } from 'shared/showControl';
import useLyricsStore from '../context/LyricsStore';
import { getOutputSettings } from '../utils/outputs';

/** Persisted collapse state for the text-style controls (operator preference). */
const STYLING_OPEN_KEY = 'selah-announcement-styling-open';
/** Persisted collapse state for the whole announcements panel. */
const PANEL_OPEN_KEY = 'selah-announcement-panel-open';

/**
 * Announcement ticker queue manager (feature #18).
 * Queued announcements overlay a lower-third on the selected output without
 * disturbing the current lyric line. Label + icon on every action,
 * visible focus rings, dark-mode-first.
 */
const AnnouncementTickerPanel = ({
  outputs = [],
  queue = [],
  activeId = null,
  targetOutput = 'all',
  onTargetOutputChange,
  onAdd,
  onRemove,
  onClear,
  onShow,
  darkMode = false,
  disabled = false,
}) => {
  const [draft, setDraft] = React.useState('');
  const [draftStyle, setDraftStyle] = React.useState(() => ({ ...TICKER_DEFAULT_STYLE }));
  const [error, setError] = React.useState('');
  const inputRef = React.useRef(null);

  const items = Array.isArray(queue) ? queue : [];
  // Band outputs paint scripture only; announcements have no surface there,
  // so never offer a target that cannot show them.
  const settingsState = useLyricsStore.getState();
  const outputOptions = Array.isArray(outputs)
    ? outputs.filter((output) => {
        const key = output.key || output.id;
        if (output.type === 'stream') return false;
        return getOutputSettings(settingsState, key)?.streamBandEnabled !== true;
      })
    : [];
  const selectedTarget = targetOutput === 'all' || outputOptions.some((output) => (output.key || output.id) === targetOutput)
    ? targetOutput
    : 'all';
  const getOutputName = (key) => {
    if (!key || key === 'all') return 'All outputs';
    const match = outputOptions.find((output) => (output.key || output.id) === key);
    return match?.name || key;
  };

  const setStyle = (patch) => setDraftStyle((prev) => ({ ...prev, ...patch }));

  const [stylingOpen, setStylingOpen] = React.useState(() => safeGet(STYLING_OPEN_KEY, true) !== false);
  const toggleStyling = React.useCallback(() => {
    setStylingOpen((prev) => {
      const next = !prev;
      safeSet(STYLING_OPEN_KEY, next);
      return next;
    });
  }, []);

  const [panelOpen, setPanelOpen] = React.useState(() => safeGet(PANEL_OPEN_KEY, true) !== false);
  const togglePanel = React.useCallback(() => {
    setPanelOpen((prev) => {
      const next = !prev;
      safeSet(PANEL_OPEN_KEY, next);
      return next;
    });
  }, []);

  const handleAdd = () => {
    const text = draft.trim();
    if (!text) {
      setError('Type an announcement first.');
      inputRef.current?.focus();
      return;
    }
    if (text.length > 280) {
      setError('Keep announcements under 280 characters.');
      return;
    }
    setError('');
    onAdd?.(text, selectedTarget, { ...draftStyle });
    setDraft('');
    inputRef.current?.focus();
  };

  const focusRing = darkMode
    ? 'focus-visible:ring-sky-300'
    : 'focus-visible:ring-sky-600';

  return (
    <div
      className={`rounded-xl border px-3 py-2.5 ${darkMode ? 'border-gray-700 bg-gray-950/40' : 'border-gray-200 bg-gray-50'}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <Megaphone className={`h-4 w-4 shrink-0 ${darkMode ? 'text-amber-300' : 'text-amber-600'}`} aria-hidden="true" />
        <span className={`flex-1 text-xs font-bold uppercase tracking-[0.14em] ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
          Announcements
        </span>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold ${darkMode ? 'border-gray-700 text-gray-400' : 'border-gray-200 text-gray-500'}`}
          title={items.length === 0 ? 'No announcements queued' : `${items.length} announcement${items.length === 1 ? '' : 's'} queued`}
        >
          {items.length === 0 ? 'Empty' : `${items.length} queued`}
        </span>
        <button
          type="button"
          onClick={togglePanel}
          aria-expanded={panelOpen}
          aria-label={panelOpen ? 'Collapse announcements panel' : 'Expand announcements panel'}
          data-testid="announcement-panel-toggle"
          title={panelOpen ? 'Collapse announcements' : 'Expand announcements'}
          className={`shrink-0 rounded-md p-1 transition-colors focus-visible:outline-none focus-visible:ring-2 ${focusRing} ${darkMode ? 'text-gray-400 hover:bg-gray-800 hover:text-gray-200' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'}`}
        >
          {panelOpen ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>

      {panelOpen && (
      <>
      <div className="mb-2 flex items-center gap-2">
        <Monitor className={`h-3.5 w-3.5 shrink-0 ${darkMode ? 'text-amber-300' : 'text-amber-600'}`} aria-hidden="true" />
        <label
          htmlFor="announcement-target-output"
          className={`text-[11px] font-semibold ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}
        >
          Send to:
        </label>
        <select
          id="announcement-target-output"
          data-testid="announcement-target-output"
          aria-label="Announcement output"
          value={selectedTarget}
          disabled={disabled}
          onChange={(event) => onTargetOutputChange?.(event.target.value)}
          className={`min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 ${focusRing} ${darkMode ? 'border-gray-700 bg-gray-900 text-gray-100' : 'border-gray-200 bg-white text-gray-900'}`}
        >
          <option value="all">All outputs</option>
          {outputOptions.map((output) => {
            const key = output.key || output.id;
            return <option key={key} value={key}>{output.name}</option>;
          })}
        </select>
      </div>

      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          maxLength={280}
          disabled={disabled}
          onChange={(e) => { setDraft(e.target.value); if (error) setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
          placeholder="e.g. Welcome — kids check-in closes at 10:30"
          aria-label="Announcement text"
          className={`min-w-0 flex-1 rounded-lg border px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 ${focusRing} ${darkMode ? 'border-gray-700 bg-gray-900 text-gray-100 placeholder:text-gray-500' : 'border-gray-200 bg-white text-gray-900 placeholder:text-gray-400'} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
        />
        <button
          type="button"
          onClick={handleAdd}
          disabled={disabled}
          title="Queue announcement"
          aria-label="Queue announcement"
          className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 ${focusRing} ${disabled ? 'cursor-not-allowed opacity-50' : ''} ${darkMode ? 'bg-amber-500 text-black hover:bg-amber-400' : 'bg-amber-500 text-black hover:bg-amber-400'}`}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add
        </button>
      </div>
      {error && (
        <p role="alert" className={`mt-1.5 text-[11px] font-semibold ${darkMode ? 'text-red-300' : 'text-red-600'}`}>
          {error}
        </p>
      )}

      {/* Text controls: size, weight, italic, alignment, color. Collapsible
          so the panel stays a quick-queue tool, with a live preview of the
          draft exactly as the overlay will render it. */}
      <div className="mt-2">
        <button
          type="button"
          onClick={toggleStyling}
          disabled={disabled}
          aria-expanded={stylingOpen}
          aria-label={stylingOpen ? 'Hide text style controls' : 'Show text style controls'}
          data-testid="announcement-styling-toggle"
          className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 ${focusRing} ${disabled ? 'cursor-not-allowed opacity-50' : ''} ${darkMode ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-800' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}`}
        >
          {stylingOpen ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
          Text style
        </button>
      </div>
      {stylingOpen && (
      <div className="mt-1.5 space-y-1.5" data-testid="announcement-text-controls">
        <div className="flex items-center gap-1.5 flex-wrap">
          <div className={`flex overflow-hidden rounded-lg border ${darkMode ? 'border-gray-700' : 'border-gray-200'}`} role="group" aria-label="Text size">
            {['sm', 'md', 'lg'].map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => setStyle({ fontSize: size })}
                disabled={disabled}
                aria-pressed={draftStyle.fontSize === size}
                aria-label={`Text size ${size === 'sm' ? 'small' : size === 'md' ? 'medium' : 'large'}`}
                title={`Text size: ${size.toUpperCase()}`}
                className={`px-2 py-1 text-[11px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 ${focusRing} ${disabled ? 'cursor-not-allowed opacity-50' : ''} ${draftStyle.fontSize === size ? (darkMode ? 'bg-amber-500 text-black' : 'bg-amber-400 text-black') : (darkMode ? 'bg-gray-900 text-gray-300 hover:bg-gray-800' : 'bg-white text-gray-600 hover:bg-gray-100')}`}
              >
                {size.toUpperCase()}
              </button>
            ))}
          </div>
          <div className={`flex overflow-hidden rounded-lg border ${darkMode ? 'border-gray-700' : 'border-gray-200'}`} role="group" aria-label="Text weight and slant">
            <button
              type="button"
              onClick={() => setStyle({ bold: !draftStyle.bold })}
              disabled={disabled}
              aria-pressed={draftStyle.bold}
              aria-label="Bold"
              title="Bold"
              className={`px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 ${focusRing} ${disabled ? 'cursor-not-allowed opacity-50' : ''} ${draftStyle.bold ? (darkMode ? 'bg-amber-500 text-black' : 'bg-amber-400 text-black') : (darkMode ? 'bg-gray-900 text-gray-300 hover:bg-gray-800' : 'bg-white text-gray-600 hover:bg-gray-100')}`}
            >
              <Bold className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setStyle({ italic: !draftStyle.italic })}
              disabled={disabled}
              aria-pressed={draftStyle.italic}
              aria-label="Italic"
              title="Italic"
              className={`px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 ${focusRing} ${disabled ? 'cursor-not-allowed opacity-50' : ''} ${draftStyle.italic ? (darkMode ? 'bg-amber-500 text-black' : 'bg-amber-400 text-black') : (darkMode ? 'bg-gray-900 text-gray-300 hover:bg-gray-800' : 'bg-white text-gray-600 hover:bg-gray-100')}`}
            >
              <Italic className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          <div className={`flex overflow-hidden rounded-lg border ${darkMode ? 'border-gray-700' : 'border-gray-200'}`} role="group" aria-label="Text alignment">
            {[
              { value: 'left', Icon: AlignLeft, label: 'Align left' },
              { value: 'center', Icon: AlignCenter, label: 'Align center' },
              { value: 'right', Icon: AlignRight, label: 'Align right' },
            ].map(({ value, Icon, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => setStyle({ align: value })}
                disabled={disabled}
                aria-pressed={draftStyle.align === value}
                aria-label={label}
                title={label}
                className={`px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 ${focusRing} ${disabled ? 'cursor-not-allowed opacity-50' : ''} ${draftStyle.align === value ? (darkMode ? 'bg-amber-500 text-black' : 'bg-amber-400 text-black') : (darkMode ? 'bg-gray-900 text-gray-300 hover:bg-gray-800' : 'bg-white text-gray-600 hover:bg-gray-100')}`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1" role="group" aria-label="Text color">
            {[
              { value: 'white', label: 'White', swatch: 'bg-white border-gray-300' },
              { value: 'amber', label: 'Amber', swatch: 'bg-amber-400 border-amber-500' },
              { value: 'sky', label: 'Sky', swatch: 'bg-sky-400 border-sky-500' },
              { value: 'lime', label: 'Lime', swatch: 'bg-lime-400 border-lime-500' },
            ].map(({ value, label, swatch }) => (
              <button
                key={value}
                type="button"
                onClick={() => setStyle({ color: value })}
                disabled={disabled}
                aria-pressed={draftStyle.color === value}
                aria-label={`Text color ${label.toLowerCase()}`}
                title={`Text color: ${label}`}
                className={`h-5 w-5 rounded-full border-2 transition-transform focus-visible:outline-none focus-visible:ring-2 ${focusRing} ${disabled ? 'cursor-not-allowed opacity-50' : ''} ${swatch} ${draftStyle.color === value ? 'scale-110 ring-2 ring-amber-400 ring-offset-1' : 'hover:scale-105'}`}
              />
            ))}
          </div>
        </div>
        <p
          data-testid="announcement-style-preview"
          aria-label="Style preview"
          className={`truncate rounded-lg border px-3 py-1.5 ${darkMode ? 'border-gray-800 bg-black/60' : 'border-gray-200 bg-black/80'} ${draftStyle.fontSize === 'sm' ? 'text-xs' : draftStyle.fontSize === 'lg' ? 'text-base' : 'text-sm'} ${draftStyle.bold ? 'font-bold' : 'font-medium'} ${draftStyle.italic ? 'italic' : ''} ${draftStyle.align === 'left' ? 'text-left' : draftStyle.align === 'right' ? 'text-right' : 'text-center'} ${draftStyle.color === 'amber' ? 'text-amber-300' : draftStyle.color === 'sky' ? 'text-sky-300' : draftStyle.color === 'lime' ? 'text-lime-300' : 'text-white'}`}
        >
          {draft.trim() || 'Preview — style the words above'} → {getOutputName(selectedTarget)}
        </p>
      </div>
      )}

      {items.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {items.map((item) => {
            const isActive = item?.id === activeId;
            return (
              <li
                key={item.id}
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${isActive
                  ? darkMode ? 'border-amber-500/60 bg-amber-500/10 text-amber-100' : 'border-amber-300 bg-amber-50 text-amber-900'
                  : darkMode ? 'border-gray-800 bg-gray-900/60 text-gray-200' : 'border-gray-200 bg-white text-gray-700'}`}
              >
                <span className="min-w-0 flex-1 truncate" title={`${item.text} — ${getOutputName(item.targetOutput)}`}>
                  {isActive && (
                    <span className={`mr-1.5 inline-block rounded px-1 py-px text-[9px] font-black uppercase tracking-wider ${darkMode ? 'bg-amber-500 text-black' : 'bg-amber-400 text-black'}`}>
                      On air
                    </span>
                  )}
                  {item.text}
                  <span className={`ml-1.5 text-[10px] font-semibold ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                    → {getOutputName(item.targetOutput)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => onShow?.(isActive ? null : item.id)}
                  disabled={disabled}
                  title={isActive ? 'Hide announcement overlay' : 'Show announcement overlay'}
                  aria-label={isActive ? `Hide announcement: ${item.text}` : `Show announcement: ${item.text}`}
                  aria-pressed={isActive}
                  className={`rounded-md p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 ${focusRing} ${disabled ? 'cursor-not-allowed opacity-50' : ''} ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                >
                  {isActive ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
                </button>
                <button
                  type="button"
                  onClick={() => onRemove?.(item.id)}
                  disabled={disabled}
                  title="Remove announcement"
                  aria-label={`Remove announcement: ${item.text}`}
                  className={`rounded-md p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 ${focusRing} ${disabled ? 'cursor-not-allowed opacity-50' : ''} ${darkMode ? 'hover:bg-red-900/60 hover:text-red-300' : 'hover:bg-red-50 hover:text-red-600'}`}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {items.length > 0 && (
        <button
          type="button"
          onClick={() => onClear?.()}
          disabled={disabled}
          className={`mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 ${focusRing} ${disabled ? 'cursor-not-allowed opacity-50' : ''} ${darkMode ? 'border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-gray-200' : 'border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-700'}`}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          Clear all announcements
        </button>
      )}
      </>
      )}
    </div>
  );
};

export default AnnouncementTickerPanel;
