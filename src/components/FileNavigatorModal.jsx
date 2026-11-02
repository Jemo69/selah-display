import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  X, Search, Folder, FileText, ArrowUp, FolderPlus, RefreshCw, Trash2,
  Loader2, FileUp, AlertTriangle, HardDrive, Sparkles,
} from 'lucide-react';
import { OPEN_FILE_NAVIGATOR_EVENT, canUseFileNavigator, mergeFileNavigatorStatus, getFolderSelectionNotice } from '../utils/fileNavigatorEvents';
import useToast from '../hooks/useToast';
import { useLyricContentSearchEnabled, useSentenceSearchExperimental } from '../hooks/useStoreSelectors';
import { logSearchEvent } from '../utils/searchAnalytics.js';
import { createLogger } from '../utils/logger';

const log = createLogger('FileNavigator');

function formatModified(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FileNavigatorModal({ darkMode = false }) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(null);
  const [roots, setRoots] = useState([]);
  const [mode, setMode] = useState('browse');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState([]);
  const [browse, setBrowse] = useState(null);
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [opening, setOpening] = useState(false);
  const [actionError, setActionError] = useState('');

  const pendingRef = useRef(null);
  const searchTimerRef = useRef(null);
  const searchCounterRef = useRef(0);
  const previewTimerRef = useRef(null);
  const statusRef = useRef(null);
  const listRef = useRef(null);

  const { enabled: lyricSearchEnabled, setEnabled: setLyricSearchEnabled } = useLyricContentSearchEnabled();
  const { enabled: sentenceExperimental } = useSentenceSearchExperimental();

  const setStatusBoth = useCallback((next) => {
    statusRef.current = mergeFileNavigatorStatus(statusRef.current, next);
    setStatus(statusRef.current);
  }, []);

  const closePanel = useCallback(() => {
    if (pendingRef.current) {
      pendingRef.current.onComplete?.({ canceled: true });
      pendingRef.current = null;
    }
    setOpen(false);
    setResults([]);
    setBrowse(null);
    setSelected(null);
    setPreview(null);
    setQuery('');
    setMode('browse');
    setActionError('');
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const state = await window.electronAPI.fileNavigator.getState();
      if (state?.success) {
        setRoots(state.roots || []);
        setStatusBoth(state.status || {});
        return state;
      }
    } catch { }
    return null;
  }, [setStatusBoth]);

  const runBrowse = useCallback(async (directoryPath) => {
    if (!directoryPath) return;
    setActionError('');
    setSelected(null);
    setPreview(null);
    try {
      const result = await window.electronAPI.fileNavigator.browse(directoryPath);
      if (result?.success) {
        setBrowse(result);
        setMode('browse');
      } else {
        setActionError(result?.error || 'Could not browse that folder');
      }
    } catch (error) {
      setActionError(error?.message || 'Could not browse that folder');
    }
  }, []);

  const runSearch = useCallback(async (value) => {
    const queryText = String(value || '').trim();
    if (!queryText) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const searchId = ++searchCounterRef.current;
    const searchStartedAt = Date.now();
    try {
      const payload = { query: queryText, limit: 80 };
      if (!lyricSearchEnabled) {
        payload.searchContent = false;
      }
      if (sentenceExperimental) {
        payload.experimental = true;
      }
      const result = await window.electronAPI.fileNavigator.search(payload);
      if (searchId !== searchCounterRef.current) return;
      const nextResults = result?.success ? result.results : [];
      setResults(nextResults);
      setSearching(false);
      // Fire-and-forget: sanitized + batched on idle, never awaited so the
      // Electron IPC round-trip stays the only latency here.
      logSearchEvent({
        surface: 'file-navigator',
        query: queryText,
        resultCount: nextResults.length,
        topResults: nextResults,
        latencyMs: Date.now() - searchStartedAt,
        meta: { contentSearch: lyricSearchEnabled },
      });
    } catch {
      if (searchId !== searchCounterRef.current) return;
      setResults([]);
      setSearching(false);
      // Zero-result / error case is the most valuable telemetry (missed queries).
      logSearchEvent({
        surface: 'file-navigator',
        query: queryText,
        resultCount: 0,
        topResults: [],
        latencyMs: Date.now() - searchStartedAt,
        meta: { contentSearch: lyricSearchEnabled, error: true },
      });
    }
  }, [lyricSearchEnabled, sentenceExperimental]);

  useEffect(() => {
    if (open && mode === 'search' && query.trim()) {
      runSearch(query);
    }
  }, [lyricSearchEnabled, sentenceExperimental, open, mode, query, runSearch]);

  const handleQueryChange = (value) => {
    setQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (String(value || '').trim()) {
      searchTimerRef.current = setTimeout(() => runSearch(value), 120);
      setMode('search');
    } else {
      setResults([]);
      setMode('browse');
    }
  };

  const handleSelectItem = useCallback(async (item) => {
    if (item.kind === 'folder') {
      setSelected(null);
      setPreview(null);
      runBrowse(item.filePath);
      return;
    }
    setSelected(item);
    setPreview(null);
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(async () => {
      try {
        const result = await window.electronAPI.fileNavigator.preview(item.filePath);
        if (result?.success || result?.available !== false) {
          setPreview(result || { available: false, content: '' });
        } else {
          setPreview(null);
        }
      } catch {
        setPreview(null);
      }
    }, 200);
  }, [runBrowse]);

  const handleAddRoot = async () => {
    setActionError('');
    try {
      const result = await window.electronAPI.fileNavigator.addRoot();
      if (result?.canceled) return;
      const notice = getFolderSelectionNotice(result?.selection);
      if (notice) showToast({ title: notice.title, message: notice.message, variant: notice.variant });
      await refreshState();
      if (result?.selection?.addedPaths?.[0]) {
        runBrowse(result.selection.addedPaths[0]);
      }
    } catch (error) {
      setActionError(error?.message || 'Could not add the selected folders');
    }
  };

  const handleCreateLyricsFolder = async () => {
    setActionError('');
    try {
      const result = await window.electronAPI.fileNavigator.createLyricsFolder();
      if (result?.success) {
        showToast({
          title: 'Lyrics folder ready',
          message: result.createdFolderPath || 'The Lyrics folder is now indexed.',
          variant: 'success',
        });
        await refreshState();
        runBrowse(result.createdFolderPath || (result.state?.roots?.[0]?.path));
      } else {
        setActionError(result?.error || 'Could not create the Lyrics folder');
      }
    } catch (error) {
      setActionError(error?.message || 'Could not create the Lyrics folder');
    }
  };

  const handleRemoveRoot = async (rootPath) => {
    setActionError('');
    try {
      const result = await window.electronAPI.fileNavigator.removeRoot(rootPath);
      if (result?.success) {
        await refreshState();
        if (browse && browse.rootPath === rootPath) {
          const nextRoot = (result.roots || roots.filter((root) => root.path !== rootPath))[0];
          runBrowse(nextRoot?.path);
        }
      } else {
        setActionError(result?.error || 'Could not remove the folder');
      }
    } catch (error) {
      setActionError(error?.message || 'Could not remove the folder');
    }
  };

  const handleReindex = async () => {
    setActionError('');
    try {
      const result = await window.electronAPI.fileNavigator.reindex();
      if (result?.success) {
        setStatusBoth(result.status || {});
        showToast({ title: 'Index refresh started', message: 'Lyric folders are being re-scanned.', variant: 'success' });
      } else {
        setActionError(result?.error || 'Could not refresh the file index');
      }
    } catch (error) {
      setActionError(error?.message || 'Could not refresh the file index');
    }
  };

  const handleOpenSelected = async () => {
    if (!selected || selected.kind !== 'file' || opening) return;
    setOpening(true);
    try {
      const result = await window.electronAPI.fileNavigator.open(selected.filePath);
      if (result?.success) {
        const complete = pendingRef.current?.onComplete;
        pendingRef.current = null;
        complete?.({ canceled: false, filePath: selected.filePath, payload: result });
        setOpen(false);
      } else {
        setActionError(result?.error || 'Could not load the selected lyrics file');
      }
    } catch (error) {
      setActionError(error?.message || 'Could not load the selected lyrics file');
    } finally {
      setOpening(false);
    }
  };

  useEffect(() => {
    if (!canUseFileNavigator()) return undefined;

    const handleOpenRequest = async (event) => {
      const detail = event.detail || {};
      pendingRef.current = {
        onComplete: typeof detail.onComplete === 'function' ? detail.onComplete : null,
      };
      setActionError('');
      const state = await refreshState();
      const rootsList = state?.success ? state.roots || [] : [];
      setRoots(rootsList);
      const target = detail.destination || rootsList.find((root) => root.indexable)?.path || rootsList[0]?.path;
      setOpen(true);
      if (target) runBrowse(target);
    };

    const handleStatusUpdate = (payload) => setStatusBoth(payload);

    window.addEventListener(OPEN_FILE_NAVIGATOR_EVENT, handleOpenRequest);
    const unsubscribe = window.electronAPI.fileNavigator.onChange(handleStatusUpdate);
    return () => {
      window.removeEventListener(OPEN_FILE_NAVIGATOR_EVENT, handleOpenRequest);
      unsubscribe?.();
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    };
  }, [refreshState, runBrowse, setStatusBoth]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePanel();
      }
      if (event.key === 'Enter' && selected) {
        event.preventDefault();
        handleOpenSelected();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open, selected, closePanel, handleOpenSelected]);

  const dark = !!darkMode;
  const panelBg = dark ? 'bg-gray-900 border-gray-700' : 'bg-white border-gray-200';
  const textPrimary = dark ? 'text-gray-100' : 'text-gray-800';
  const textMuted = dark ? 'text-gray-400' : 'text-gray-500';
  const inputBg = dark ? 'bg-gray-800 border-gray-600' : 'bg-gray-50 border-gray-300';
  const rowHover = dark ? 'hover:bg-gray-800' : 'hover:bg-gray-50';
  const chipBg = dark ? 'bg-gray-800 border-gray-600' : 'bg-gray-100 border-gray-300';
  const previewBg = dark ? 'bg-gray-950 border-gray-700' : 'bg-gray-50 border-gray-200';

  const visibleItems = useMemo(() => {
    if (mode === 'search') return results;
    return browse?.items || [];
  }, [mode, results, browse]);

  const scanning = Boolean(status?.scanning);
  const indexedFiles = Number(status?.indexedFiles) || 0;

  if (!open || !canUseFileNavigator()) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePanel();
      }}
      data-testid="file-navigator-modal"
    >
      <div className={`flex h-[78vh] w-[920px] max-w-[94vw] flex-col overflow-hidden rounded-xl border shadow-2xl ${panelBg}`}>
        <div className={`flex items-center justify-between gap-3 border-b px-4 py-3 ${dark ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="flex items-center gap-2">
            <HardDrive className={`w-4 h-4 ${dark ? 'text-gray-300' : 'text-gray-600'}`} />
            <h2 className={`text-sm font-semibold ${textPrimary}`}>Lyric Files</h2>
            {scanning && (
              <span className={`inline-flex items-center gap-1 text-xs ${textMuted}`}>
                <Loader2 className="w-3 h-3 animate-spin" />
                Scanning…
              </span>
            )}
            {!scanning && (
              <span className={`text-xs ${textMuted}`}>{indexedFiles.toLocaleString()} indexed</span>
            )}
          </div>
          <button
            className={`rounded-md p-1.5 ${dark ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-100 text-gray-500'}`}
            onClick={closePanel}
            aria-label="Close file navigator"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col gap-2 px-4 pt-3">
          <div className="flex items-center gap-2">
            <div className={`relative flex-1 ${inputBg} rounded-lg border focus-within:ring-2 focus-within:ring-blue-500`}>
              <Search className={`absolute left-3 top-1/2 w-4 h-4 -translate-y-1/2 ${textMuted}`} />
              <input
                className={`w-full rounded-lg bg-transparent py-2 pl-9 pr-8 text-sm outline-none ${textPrimary}`}
                placeholder="Search indexed lyrics — try a title, word, or “ext:lrc” (Ctrl+Shift+F)"
                value={query}
                onChange={(event) => handleQueryChange(event.target.value)}
                data-testid="file-navigator-search"
              />
              {query && (
                <button
                  className={`absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 ${dark ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-200 text-gray-500'}`}
                  onClick={() => handleQueryChange('')}
                  aria-label="Clear search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <button
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors ${
                lyricSearchEnabled
                  ? (dark ? 'border-amber-700/60 bg-amber-950/40 text-amber-300 hover:bg-amber-900/40' : 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100')
                  : (dark ? 'border-gray-700 bg-transparent text-gray-400 hover:bg-gray-800' : 'border-gray-200 bg-transparent text-gray-500 hover:bg-gray-50')
              }`}
              onClick={() => {
                const next = !lyricSearchEnabled;
                setLyricSearchEnabled(next);
                showToast({
                  title: next ? 'Lyric Content Search enabled' : 'Lyric Content Search disabled',
                  message: next ? 'Searching titles and lyric contents.' : 'Searching file titles only.',
                  variant: next ? 'success' : 'info',
                });
              }}
              title={lyricSearchEnabled ? 'Full-Text Lyric Search is ON (Experimental) — Click to search titles only' : 'Full-Text Lyric Search is OFF — Click to search inside lyrics'}
              aria-label="Toggle lyric content search"
              data-testid="file-navigator-content-search-toggle"
            >
              <Sparkles className={`w-3.5 h-3.5 ${lyricSearchEnabled ? 'text-amber-500' : 'text-gray-400'}`} />
              <span className="hidden sm:inline">{lyricSearchEnabled ? 'Lyrics: ON' : 'Lyrics: OFF'}</span>
            </button>
            <button
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium ${dark ? 'border-gray-600 hover:bg-gray-800 text-gray-200' : 'border-gray-300 hover:bg-gray-50 text-gray-700'}`}
              onClick={handleAddRoot}
              data-testid="file-navigator-add-root"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              Add folder
            </button>
            <button
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium ${dark ? 'border-gray-600 hover:bg-gray-800 text-gray-200' : 'border-gray-300 hover:bg-gray-50 text-gray-700'}`}
              onClick={handleCreateLyricsFolder}
            >
              <FolderPlus className="w-3.5 h-3.5" />
              Lyrics folder
            </button>
            <button
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium ${dark ? 'border-gray-600 hover:bg-gray-800 text-gray-200' : 'border-gray-300 hover:bg-gray-50 text-gray-700'}`}
              onClick={handleReindex}
              disabled={scanning}
              aria-label="Refresh index"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {roots.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {roots.map((root) => (
                <span
                  key={root.path}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${chipBg} ${dark ? 'text-gray-200' : 'text-gray-700'} ${!root.available || !root.indexable ? 'opacity-70' : ''}`}
                  title={root.issue || root.path}
                >
                  <Folder className="w-3 h-3" />
                  <button
                    className="max-w-[180px] truncate hover:underline"
                    onClick={() => runBrowse(root.path)}
                    aria-label={`Browse ${root.path}`}
                  >
                    {root.name}
                  </button>
                  {(!root.available || !root.indexable) && <AlertTriangle className="w-3 h-3 text-amber-500" />}
                  <button
                    className={`rounded p-0.5 ${dark ? 'hover:bg-gray-600' : 'hover:bg-gray-200'}`}
                    onClick={() => handleRemoveRoot(root.path)}
                    aria-label={`Remove ${root.name} from index`}
                    data-testid="file-navigator-remove-root"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {roots.length === 0 && (
            <p className={`text-xs ${textMuted}`}>
              No lyric folders indexed yet — add a folder or create the default Lyrics folder.
            </p>
          )}
        </div>

        <div className="flex min-h-0 flex-1 gap-3 p-4">
          <div className="flex min-h-0 w-1/2 flex-col">
            <div className={`mb-2 flex items-center justify-between text-xs ${textMuted}`}>
              {mode === 'browse' && browse ? (
                <div className="flex min-w-0 items-center gap-1">
                  {browse.parentPath && (
                    <button
                      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 hover:underline"
                      onClick={() => runBrowse(browse.parentPath)}
                    >
                      <ArrowUp className="w-3 h-3" />
                      Up
                    </button>
                  )}
                  <span className="truncate font-mono text-[11px]" title={browse.directoryPath}>
                    {browse.parentPath ? browse.directoryPath : browse.directoryPath}
                  </span>
                </div>
              ) : (
                <span>{query ? `Search results: ${results.length}` : 'Browse results'}</span>
              )}
              {searching && <Loader2 className="w-3 h-3 animate-spin" />}
            </div>
            <div
              ref={listRef}
              className={`min-h-0 flex-1 overflow-y-auto rounded-lg border ${dark ? 'border-gray-700' : 'border-gray-200'}`}
              role="listbox"
              aria-label="Lyric files"
              data-testid="file-navigator-list"
            >
              {visibleItems.length === 0 && (
                <p className={`px-3 py-6 text-center text-xs ${textMuted}`}>
                  {searching ? 'Searching…' : (query ? 'No matches found.' : 'No files in this folder.')}
                </p>
              )}
              {visibleItems.map((item) => {
                const isFolder = item.kind === 'folder';
                const isSelected = selected?.filePath === item.filePath;
                return (
                  <button
                    key={`${item.kind}-${item.filePath}`}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${rowHover} ${isSelected ? (dark ? 'bg-gray-700/60' : 'bg-blue-50') : ''}`}
                    onClick={() => handleSelectItem(item)}
                    role="option"
                    aria-selected={isSelected}
                    data-testid="file-navigator-item"
                  >
                    {isFolder
                      ? <Folder className={`w-4 h-4 shrink-0 ${dark ? 'text-amber-400' : 'text-amber-500'}`} />
                      : <FileText className={`w-4 h-4 shrink-0 ${dark ? 'text-gray-400' : 'text-gray-500'}`} />}
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-sm ${textPrimary}`}>{item.fileName}</span>
                      {isFolder ? null : item.matchSnippetHtml ? (
                        <span
                          className={`block truncate text-[11px] ${textMuted}`}
                          dangerouslySetInnerHTML={{ __html: item.matchSnippetHtml }}
                        />
                      ) : (
                        <span className={`block truncate text-[11px] ${textMuted}`}>
                          {item.matchSnippet || (item.relativePath || '') || `${item.fileType || ''} · ${formatSize(item.size)} · ${formatModified(item.modifiedMs)}`}
                        </span>
                      )}
                    </span>
                    {!isFolder && item.matchedField && (
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                        item.matchedField === 'content'
                          ? (dark ? 'bg-amber-950/70 text-amber-300 border border-amber-800/60' : 'bg-amber-100 text-amber-800 border border-amber-200')
                          : item.matchedField === 'both'
                          ? (dark ? 'bg-purple-950/70 text-purple-300 border border-purple-800/60' : 'bg-purple-100 text-purple-800 border border-purple-200')
                          : (dark ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600')
                      }`}>
                        {item.matchedField === 'content' ? 'LYRIC MATCH' : item.matchedField === 'both' ? 'TITLE + LYRIC' : item.matchedField === 'name' ? 'TITLE MATCH' : item.matchedField}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className={`flex min-h-0 w-1/2 flex-col rounded-lg border ${previewBg}`}>
            <div className={`border-b px-3 py-2 text-xs font-medium ${dark ? 'border-gray-700 text-gray-300' : 'border-gray-200 text-gray-600'}`}>
              {selected ? (
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate">{selected.fileName}</span>
                  <span className="shrink-0 normal-case">{selected.fileType ? selected.fileType.toUpperCase() : selected.kind}</span>
                </span>
              ) : (
                'Preview'
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed">
              {preview?.content || (selected ? (
                <span className={`italic ${textMuted}`}>{preview?.reason || 'Loading preview…'}</span>
              ) : (
                <span className={`italic ${textMuted}`}>Select a file to preview it.</span>
              ))}
            </div>
            {preview?.truncated && (
              <div className={`border-t px-3 py-1 text-[10px] ${dark ? 'border-gray-700 text-gray-400' : 'border-gray-200 text-gray-500'}`}>
                Preview truncated at 20,000 characters.
              </div>
            )}
          </div>
        </div>

        <div className={`flex items-center justify-between gap-3 border-t px-4 py-3 ${dark ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="min-w-0 text-xs text-amber-600">
            {actionError && <span className="inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{actionError}</span>}
          </div>
          <div className="flex items-center gap-2">
            {status?.limitedRoots?.length > 0 && (
              <span className={`text-[11px] ${textMuted}`}>
                {status.limitedRoots.length} folder{status.limitedRoots.length > 1 ? 's' : ''} over limits
              </span>
            )}
            <button
              className={`rounded-lg border px-4 py-2 text-sm font-medium ${dark ? 'border-gray-600 hover:bg-gray-800 text-gray-200' : 'border-gray-300 hover:bg-gray-50 text-gray-700'}`}
              onClick={closePanel}
            >
              Cancel
            </button>
            <button
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              disabled={!selected || selected.kind !== 'file' || opening}
              onClick={handleOpenSelected}
              data-testid="file-navigator-open"
            >
              {opening ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileUp className="w-4 h-4" />}
              Open lyrics file
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}