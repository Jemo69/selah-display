import React, { useState, useEffect, useCallback } from 'react';
import { Search, X, BookOpen, Loader2 } from 'lucide-react';
import useBibleStore from '../../context/BibleStore';
import useToast from '../../hooks/useToast';
import { parseBibleFromFile } from 'shared/bible';
import { buildAllVersionsPreview, truncatePreviewText } from '../../utils/biblePreview';
import BibleBrowser from './BibleBrowser';
import BibleImportModal from './BibleImportModal';
import { createLogger } from '../../utils/logger.js';
import { diagInfo } from '../../utils/diagnosticsLog.js';
import { logSearchEvent } from '../../utils/searchAnalytics.js';
import useLyricsStore from '../../context/LyricsStore';

const logger = createLogger('BibleSearch');

const TABS = {
  BROWSE: 'browse',
  SEARCH: 'search',
  IMPORT: 'import'
};

export default function BibleSearchModal({ isOpen, onClose, onSelectVerses, darkMode }) {
  logger.info('BibleSearchModal mounted', { isOpen });
  const [activeTab, setActiveTab] = useState(TABS.BROWSE);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchAll, setSearchAll] = useState(false);
  const [allVersionsPreview, setAllVersionsPreview] = useState(null);

  const {
    bibles,
    bibleMetadata,
    activeBibleId,
    defaultBibleId,
    activeReference,
    selectedVerses,
    addBible,
    setActiveBible,
    loadAllBibles,
    ensureBiblesLoaded,
    evictInactiveBibles,
    setSearchAllOwner,
    clearSearchAllOwner,
    setDefaultBible,
    setReference,
    setSelectedVerses,
    getFormattedReference,
    getVerseText,
    getBibleById,
    settings
  } = useBibleStore();

  const { showToast } = useToast();
  const sentenceExperimental = useLyricsStore((s) => s.sentenceSearchExperimental === true);

  useEffect(() => {
    if (!isOpen) {
      setActiveTab(TABS.BROWSE);
      setQuery('');
      setSearchResults([]);
      setAllVersionsPreview(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!activeBibleId && Object.keys(bibleMetadata).length > 0) {
      const firstId = defaultBibleId && bibleMetadata[defaultBibleId]
        ? defaultBibleId
        : Object.keys(bibleMetadata)[0];
      setActiveBible(firstId);
    }
  }, [activeBibleId, bibleMetadata, defaultBibleId, setActiveBible]);

  useEffect(() => {
    if (!isOpen) return undefined;
    setSearchAllOwner('bible-search-modal', searchAll);
    return () => clearSearchAllOwner('bible-search-modal');
  }, [isOpen, searchAll, setSearchAllOwner, clearSearchAllOwner]);

  useEffect(() => {
    if (!isOpen) return undefined;
    if (searchAll) {
      loadAllBibles();
    } else {
      evictInactiveBibles();
      searchWorkerRef.current?.postMessage({ pruneBibles: useBibleStore.getState().bibles });
    }
  }, [isOpen, searchAll, loadAllBibles, evictInactiveBibles]);

  const handleImportBible = useCallback(async (file) => {
    try {
      const bible = await parseBibleFromFile(file);

      if (!bible.books || bible.books.length === 0) {
        throw new Error('No books found in Bible file');
      }

      const id = bible.id || `bible_${Date.now()}`;
      addBible(id, bible);
      setActiveBible(id);

      showToast({
        title: 'Bible imported',
        message: `${bible.name} has been added to your library`,
        variant: 'success'
      });

      setActiveTab(TABS.BROWSE);
    } catch (error) {
      showToast({
        title: 'Import failed',
        message: error.message || 'Could not parse Bible file',
        variant: 'error'
      });
      throw error;
    }
  }, [addBible, setActiveBible, showToast]);

  const handleSearchResultClick = useCallback((result) => {
    if (result.bibleId && result.bibleId !== activeBibleId) {
      setActiveBible(result.bibleId);
    }

    const verses = result.verses || result.verse;
    setReference({
      id: result.bibleId || activeBibleId,
      book: result.book,
      chapters: [String(result.chapter)],
      verses: [Array.isArray(verses) ? verses : [verses]]
    });
    setSelectedVerses([Array.isArray(verses) ? verses : [verses]]);
    setAllVersionsPreview(null);
    setActiveTab(TABS.BROWSE);
  }, [activeBibleId, setActiveBible, setReference, setSelectedVerses]);

  const handleDisplayFromSearch = useCallback((result) => {
    const verses = result.verses || [result.verse];
    const versesArray = Array.isArray(verses) ? verses : [verses];
    const bible = getBibleById(result.bibleId || activeBibleId);
    const reference = result.reference;
    const text = result.text;
    if (onSelectVerses) {
      onSelectVerses({
        reference,
        text,
        bible: bible?.name || result.bibleName || ''
      });
    }
    // also update store for history/preview consistency
    setReference({
      id: result.bibleId || activeBibleId,
      book: result.book,
      chapters: [String(result.chapter)],
      verses: [versesArray]
    });
    setSelectedVerses([versesArray]);
    setAllVersionsPreview(null);
    onClose();
  }, [activeBibleId, getBibleById, onClose, onSelectVerses, setReference, setSelectedVerses]);

  const handlePreviewAllVersions = useCallback(async (result) => {
    const versesArray = result.verses ? [...result.verses] : [result.verse];
    const ref = {
      id: result.bibleId || activeBibleId,
      book: result.book,
      chapters: [String(result.chapter)],
      verses: [versesArray]
    };
    setReference(ref);
    setSelectedVerses([versesArray]);

    // Settings > Bible: same toggle the control-panel tray reads, so both
    // preview surfaces honor "Trim long verses in translation previews".
    const truncate = settings?.truncateVersionPreviews !== false;
    const list = await buildAllVersionsPreview({
      reference: ref,
      verses: versesArray,
      bibleMetadata,
      getBibles: () => useBibleStore.getState().bibles,
      loadAllBibles,
      ensureBiblesLoaded,
      defaultBibleId,
      truncate,
    });

    // Fallback if nothing resolved (e.g. bible not fully loaded)
    const fallbackFull = result.text ? String(result.text).trim() : '';
    const fallbackText = fallbackFull ? (truncate ? truncatePreviewText(fallbackFull) : fallbackFull) : '';
    const finalList = list.length > 0 ? list : (fallbackText ? [{
      bibleId: result.bibleId || activeBibleId,
      bibleName: result.bibleName || getBibleById(activeBibleId)?.name || 'Current',
      text: fallbackText,
      truncated: truncate && fallbackText !== fallbackFull,
    }] : []);

    setAllVersionsPreview(finalList);
    setSearchResults([]);
    setQuery('');
  }, [activeBibleId, bibleMetadata, defaultBibleId, getBibleById, loadAllBibles, setReference, setSelectedVerses, settings]);

  const handleSelect = useCallback(() => {
    if (!activeReference) return;

    const bible = getBibleById(activeBibleId);
    const reference = getFormattedReference();
    const text = getVerseText();

    if (onSelectVerses) {
      onSelectVerses({
        reference,
        text,
        bible: bible?.name || ''
      });
    }
    setAllVersionsPreview(null);
    onClose();
  }, [activeReference, activeBibleId, getBibleById, getFormattedReference, getVerseText, onSelectVerses, onClose]);

  const handleSelectBible = useCallback((id) => {
    setAllVersionsPreview(null);
    setActiveBible(id);
  }, [setActiveBible]);

  const handleSetDefaultBible = useCallback((id) => {
    setDefaultBible(id);
  }, [setDefaultBible]);

  const handleSelectReference = useCallback((ref) => {
    setAllVersionsPreview(null);
    setReference(ref);
  }, [setReference]);

  const handleSelectVerses = useCallback((verses) => {
    setAllVersionsPreview(null);
    setSelectedVerses(verses);
  }, [setSelectedVerses]);

  const handleSearchResults = useCallback((results) => {
    setSearchResults(results);
    setSearching(false);
  }, []);

  const searchWorkerRef = React.useRef(null);
  const lastBiblesRef = React.useRef(null);
  const lastCurrentBibleRef = React.useRef(null);
  const searchQidRef = React.useRef(0);
  const searchStartedAtRef = React.useRef(0);
  const searchQueryRef = React.useRef('');
  const searchAllRef = React.useRef(false);

  useEffect(() => {
    searchWorkerRef.current = new Worker(new URL('../../utils/bibleSearch.worker.js', import.meta.url), { type: 'module' });
    searchWorkerRef.current.onmessage = (e) => {
      const payload = e.data && typeof e.data === 'object' && !Array.isArray(e.data) && 'results' in e.data ? e.data : null;
      if (payload && payload.qid !== searchQidRef.current) return;
      const results = Array.isArray(e.data) ? e.data : Array.isArray(payload?.results) ? payload.results : [];
      setSearchResults(results);
      setSearching(false);
      // Fire-and-forget search telemetry: sanitized + batched on idle, never
      // awaited so the worker round-trip stays the only latency here.
      // Separate User Preferences > Bible setting: skip logging when the
      // operator opts out via "Log Bible searches".
      if (useBibleStore.getState().settings?.logBibleSearches !== false) {
        logSearchEvent({
        surface: 'bible',
        query: searchQueryRef.current,
        resultCount: results.length,
        topResults: results,
        latencyMs: searchStartedAtRef.current ? Date.now() - searchStartedAtRef.current : null,
        meta: { searchAll: searchAllRef.current },
      });
      }
      diagInfo('bible', 'passage search finished', {
        queryChars: searchQueryRef.current.length,
        results: results.length,
        searchAll: searchAllRef.current,
        durationMs: searchStartedAtRef.current ? Date.now() - searchStartedAtRef.current : null,
      });
    };
    return () => {
      searchWorkerRef.current?.terminate();
    };
  }, []);

  useEffect(() => {
    if (!query || query.length < 3 || !getBibleById(activeBibleId)) {
      setSearchResults([]);
      setSearching(false);
      return undefined;
    }

    const handle = setTimeout(() => {
      setSearching(true);
      searchStartedAtRef.current = Date.now();
      searchQueryRef.current = typeof query === 'string' ? query : '';
      searchAllRef.current = Boolean(searchAll);
      const currentBible = getBibleById(activeBibleId);
      const biblesChanged = bibles !== lastBiblesRef.current;
      const currentChanged = currentBible !== lastCurrentBibleRef.current;
      lastBiblesRef.current = bibles;
      lastCurrentBibleRef.current = currentBible;
      searchQidRef.current += 1;
      searchWorkerRef.current?.postMessage({
        qid: searchQidRef.current,
        query,
        maxResults: 50,
        defaultBibleId,
        searchAll,
        experimental: sentenceExperimental,
        ...(biblesChanged ? { refreshBibles: true, allBibles: bibles } : {}),
        ...(currentChanged ? { currentBible } : {})
      });
    }, 300);

    return () => {
      clearTimeout(handle);
    };
  }, [query, activeBibleId, bibles, defaultBibleId, searchAll, getBibleById, sentenceExperimental]);

  const handleQueryChange = useCallback((e) => {
    setAllVersionsPreview(null);
    setQuery(e.target.value);
  }, []);

  if (!isOpen) return null;

  const formattedReference = getFormattedReference();
  const hasSelection = activeReference && selectedVerses[0]?.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      <div className={`
        relative w-[90vw] max-w-4xl h-[700px] flex flex-col
        rounded-2xl border shadow-2xl
        ${darkMode ? 'bg-gray-900 border-gray-800' : 'bg-white border-gray-200'}
      `}>
        <div className={`
          flex items-center justify-between px-6 py-4 border-b
          ${darkMode ? 'border-gray-800' : 'border-gray-200'}
        `}>
          <div>
            <h2 className="text-lg font-semibold">Bible Verses</h2>
            <p className="text-xs text-gray-500">
              Search and select Bible verses to display
            </p>
          </div>
          <button
            onClick={onClose}
            className={`p-1.5 rounded-md transition-colors ${darkMode ? 'hover:bg-gray-800 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex gap-2 px-6 py-3 border-b">
          {[
            { id: TABS.BROWSE, label: 'Browse' },
            { id: TABS.SEARCH, label: 'Search' },
            { id: TABS.IMPORT, label: 'Import Bible' }
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === tab.id
                ? 'bg-blue-600 text-white'
                : darkMode ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-hidden">
          {activeTab === TABS.BROWSE && (
            <BibleBrowser
              activeBibleId={activeBibleId}
              activeReference={activeReference}
              selectedVerses={selectedVerses}
              onSelectBible={handleSelectBible}
              onSelectReference={handleSelectReference}
              onSelectVerses={handleSelectVerses}
              onSetDefaultBible={handleSetDefaultBible}
              searchQuery={query}
              searchAll={searchAll}
              onSearchResults={handleSearchResults}
              darkMode={darkMode}
            />
          )}

          {activeTab === TABS.SEARCH && (
            <div className="p-6 h-full flex flex-col">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  value={query}
                  onChange={handleQueryChange}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && searchResults.length > 0) {
                      e.preventDefault();
                      if (e.shiftKey) {
                        handlePreviewAllVersions(searchResults[0]);
                      } else {
                        handleDisplayFromSearch(searchResults[0]);
                      }
                    }
                  }}
                  placeholder="Search Bible verses (min 3 characters)..."
                  className={`
                    w-full pl-10 pr-4 py-3 rounded-lg border
                    ${darkMode
                      ? 'bg-gray-800 border-gray-700 text-white placeholder-gray-500'
                      : 'bg-white border-gray-200 text-gray-900 placeholder-gray-400'}
                  `}
                />
                {searching && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-blue-500" />
                )}
              </div>

              <div className="mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  id="search-all-bibles-modal"
                  checked={searchAll}
                  onChange={(e) => setSearchAll(e.target.checked)}
                  className="h-4 w-4 accent-blue-600"
                />
                <label htmlFor="search-all-bibles-modal" className={`text-sm font-medium ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  Search all bibles
                </label>
              </div>

              <div className="mt-4 flex-1 overflow-y-auto">
                {allVersionsPreview && allVersionsPreview.length > 0 ? (
                  <div className="space-y-2">
                    <div className={`text-xs font-bold uppercase tracking-wider ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                      Preview — {getFormattedReference() || 'Selected verse'} across all translations
                      <span className="ml-2 normal-case font-normal italic opacity-70">(preview only, not sent to output)</span>
                    </div>
                    {allVersionsPreview.map((item) => (
                      <div
                        key={item.bibleId}
                        className={`rounded-lg border p-3 ${darkMode ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-gray-50'}`}
                      >
                        <div className="text-[10px] font-bold uppercase tracking-wider text-blue-500">{item.bibleName}</div>
                        <div className={`mt-1 text-sm ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                          {item.text}
                          {item.truncated && (
                            <span className={`ml-1 italic ${darkMode ? 'text-gray-500' : 'text-gray-400'}`} title="Oversized verse text trimmed for the preview (Settings > Bible)">
                              (trimmed)
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                    <button
                      onClick={() => setAllVersionsPreview(null)}
                      className={`mt-2 text-xs underline ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}
                    >
                      Clear preview
                    </button>
                  </div>
                ) : (
                  <>
                    {!query && (
                      <p className={`text-center py-8 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                        Enter a search term to find verses
                      </p>
                    )}

                    {query && query.length < 3 && (
                      <p className={`text-center py-8 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                        Enter at least 3 characters to search
                      </p>
                    )}

                    {query.length >= 3 && searchResults.length === 0 && !searching && (
                      <p className={`text-center py-8 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                        No results found for "{query}"
                      </p>
                    )}

                    {searchResults.map((result, index) => (
                      <button
                        key={`${result.reference}-${index}`}
                        onClick={() => handleSearchResultClick(result)}
                        className={`
                          w-full p-3 text-left border-b rounded-lg mb-2 transition-colors
                          ${darkMode ? 'border-gray-700 hover:bg-gray-800' : 'border-gray-100 hover:bg-gray-50'}
                        `}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm font-medium">{result.reference}</div>
                          {result.bibleName && (
                            <div className="text-[10px] px-1.5 py-0.5 rounded bg-blue-600/20 text-blue-400 font-bold uppercase tracking-wider">
                              {result.bibleName}
                            </div>
                          )}
                        </div>
                        <div className={`text-sm mt-1 line-clamp-2 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                          {result.text}
                        </div>
                      </button>
                    ))}
                    {searchResults.length > 0 && (
                      <div className={`mt-3 text-[11px] ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                        <span className="font-semibold">Enter</span> to display • <span className="font-semibold">Shift+Enter</span> to preview all translations
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {activeTab === TABS.IMPORT && (
            <BibleImportModal
              onImport={handleImportBible}
              darkMode={darkMode}
            />
          )}
        </div>

        <div className={`
          flex items-center justify-between px-6 py-4 border-t
          ${darkMode ? 'border-gray-800' : 'border-gray-200'}
        `}>
          <div className="text-sm">
            <span className="text-gray-500">Selected: </span>
            <span className={`font-medium ${hasSelection ? (darkMode ? 'text-white' : 'text-gray-900') : 'text-gray-400'}`}>
              {formattedReference || 'No verses selected'}
            </span>
          </div>
          <button
            onClick={handleSelect}
            disabled={!hasSelection}
            className={`
              px-6 py-2 rounded-lg font-medium transition-colors
              ${!hasSelection
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700 text-white'}
            `}
          >
            Send to Display
          </button>
        </div>
      </div>
    </div>
  );
}
