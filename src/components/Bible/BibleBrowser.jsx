import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronRight, BookOpen, Star } from 'lucide-react';
import useBibleStore from '../../context/BibleStore';
import useLyricsStore from '../../context/LyricsStore';
import { searchBible, orderBibleMetadata } from 'shared/bible';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('BibleBrowser');

export default function BibleBrowser({
  activeBibleId,
  activeReference,
  selectedVerses,
  onSelectBible,
  onSelectReference,
  onSelectVerses,
  onSetDefaultBible,
  searchQuery,
  searchAll = false,
  onSearchResults,
  darkMode
}) {
  logger.info('BibleBrowser mounted');
  const { bibles, bibleMetadata, defaultBibleId, loadAllBibles, evictInactiveBibles, setSearchAllOwner, clearSearchAllOwner } = useBibleStore();
  const [books, setBooks] = useState([]);
  const [chapters, setChapters] = useState([]);
  const [verses, setVerses] = useState([]);

  const currentBible = bibles[activeBibleId];
  const orderedBibleMetadata = useMemo(
    () => orderBibleMetadata(bibleMetadata, defaultBibleId),
    [bibleMetadata, defaultBibleId]
  );

  const sentenceExperimental = useLyricsStore((s) => s.sentenceSearchExperimental === true);

  useEffect(() => {
    if (!activeBibleId || !currentBible) {
      setBooks([]);
      return;
    }
    setBooks(currentBible.books || []);
  }, [activeBibleId, currentBible]);

  useEffect(() => {
    if (!activeReference?.book || !currentBible) {
      setChapters([]);
      return;
    }
    const book = currentBible.books.find(b => b.number === activeReference.book);
    setChapters(book?.chapters || []);
  }, [activeReference?.book, activeBibleId, currentBible]);

  useEffect(() => {
    if (!activeReference?.book || !activeReference?.chapters?.length || !currentBible) {
      setVerses([]);
      return;
    }
    const book = currentBible.books.find(b => b.number === activeReference.book);
    const chapter = book?.chapters.find(c => c.number === parseInt(activeReference.chapters[0]));
    setVerses(chapter?.verses || []);
  }, [activeReference?.book, activeReference?.chapters, activeBibleId, currentBible]);

  const searchWorkerRef = React.useRef(null);
  const lastBiblesRef = React.useRef(null);
  const lastCurrentBibleRef = React.useRef(null);
  const searchQidRef = React.useRef(0);

  useEffect(() => {
    searchWorkerRef.current = new Worker(new URL('../../utils/bibleSearch.worker.js', import.meta.url), { type: 'module' });
    searchWorkerRef.current.onmessage = (e) => {
      const payload = e.data && typeof e.data === 'object' && !Array.isArray(e.data) && 'results' in e.data ? e.data : null;
      if (payload && payload.qid !== searchQidRef.current) return;
      const next = Array.isArray(e.data) ? e.data : Array.isArray(payload?.results) ? payload.results : [];
      if (onSearchResults) onSearchResults(next);
    };
    return () => {
      searchWorkerRef.current?.terminate();
    };
  }, [onSearchResults]);

  useEffect(() => {
    setSearchAllOwner('bible-browser', searchAll);
    return () => clearSearchAllOwner('bible-browser');
  }, [searchAll, setSearchAllOwner, clearSearchAllOwner]);

  useEffect(() => {
    if (searchAll) {
      loadAllBibles();
    } else {
      evictInactiveBibles();
      searchWorkerRef.current?.postMessage({ pruneBibles: useBibleStore.getState().bibles });
    }
  }, [searchAll, loadAllBibles, evictInactiveBibles]);

  useEffect(() => {
    if (!searchQuery || searchQuery.length < 3 || !currentBible) {
      if (onSearchResults) onSearchResults([]);
      return undefined;
    }

    const handle = setTimeout(() => {
      const biblesChanged = bibles !== lastBiblesRef.current;
      const currentChanged = currentBible !== lastCurrentBibleRef.current;
      lastBiblesRef.current = bibles;
      lastCurrentBibleRef.current = currentBible;
      searchQidRef.current += 1;
      searchWorkerRef.current?.postMessage({
        qid: searchQidRef.current,
        query: searchQuery,
        maxResults: 30,
        defaultBibleId,
        searchAll,
        experimental: sentenceExperimental,
        ...(biblesChanged ? { refreshBibles: true, allBibles: bibles } : {}),
        ...(currentChanged ? { currentBible } : {})
      });
    }, 300);

    return () => clearTimeout(handle);
  }, [searchQuery, currentBible, bibles, defaultBibleId, searchAll, onSearchResults, sentenceExperimental]);

  const handleBookSelect = useCallback((bookNumber) => {
    onSelectReference({
      id: activeBibleId,
      book: bookNumber,
      chapters: [],
      verses: []
    });
    onSelectVerses([[1]]);
  }, [activeBibleId, onSelectReference, onSelectVerses]);

  const handleChapterSelect = useCallback((chapterNumber) => {
    onSelectReference({
      ...activeReference,
      id: activeBibleId,
      chapters: [String(chapterNumber)]
    });
    onSelectVerses([[1]]);
  }, [activeReference, activeBibleId, onSelectReference, onSelectVerses]);

  const handleVerseSelect = useCallback((verseNumber) => {
    const current = selectedVerses[0] || [];
    const isSelected = current.includes(verseNumber);

    if (isSelected) {
      onSelectVerses([current.filter(v => v !== verseNumber)]);
    } else {
      onSelectVerses([[...current, verseNumber]]);
    }
  }, [selectedVerses, onSelectVerses]);

  return (
    <div className={`flex h-full ${darkMode ? 'text-gray-100' : 'text-gray-900'}`}>
      <div className={`
        w-48 border-r overflow-y-auto p-2
        ${darkMode ? 'border-gray-700 bg-gray-900' : 'border-gray-200 bg-gray-50'}
      `}>
        <div className={`
          text-xs font-medium uppercase tracking-wide px-2 py-1 mb-2
          ${darkMode ? 'text-gray-400' : 'text-gray-500'}
        `}>
          Bible Version
        </div>
        {orderedBibleMetadata.map((meta) => {
          const isDefault = meta.id === defaultBibleId;
          return (
            <div key={meta.id} className="mb-1 flex items-center gap-1">
              <button
                onClick={() => onSelectBible(meta.id)}
                className={`
                  flex-1 px-3 py-2 text-left rounded-lg text-sm transition-colors
                  ${activeBibleId === meta.id
                    ? 'bg-blue-600 text-white'
                    : darkMode
                      ? 'hover:bg-gray-800 text-gray-300'
                      : 'hover:bg-gray-200 text-gray-700'}
                `}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{meta.name}</span>
                  {isDefault && <span className="text-[10px] font-bold uppercase tracking-wider opacity-80">Default</span>}
                </div>
              </button>
              <button
                type="button"
                onClick={() => onSetDefaultBible?.(meta.id)}
                disabled={isDefault}
                className={`rounded-lg p-2 transition-colors ${darkMode
                  ? 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-yellow-300 disabled:bg-gray-900 disabled:text-yellow-400'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-yellow-600 disabled:bg-yellow-50 disabled:text-yellow-600'
                  } disabled:cursor-default`}
                title={isDefault ? 'Default Bible' : `Set ${meta.name} as default`}
              >
                <Star className={`h-4 w-4 ${isDefault ? 'fill-current' : ''}`} />
              </button>
            </div>
          );
        })}
        {Object.keys(bibleMetadata).length === 0 && (
          <p className={`text-xs px-3 py-2 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
            Import a Bible to get started
          </p>
        )}
      </div>

      <div className={`
        w-56 border-r overflow-y-auto p-2
        ${darkMode ? 'border-gray-700' : 'border-gray-200'}
      `}>
        <div className={`
          text-xs font-medium uppercase tracking-wide px-2 py-1 mb-2
          ${darkMode ? 'text-gray-400' : 'text-gray-500'}
        `}>
          Books
        </div>
        {books.map((book) => (
          <button
            key={book.number}
            onClick={() => handleBookSelect(book.number)}
            className={`
              w-full px-3 py-2 text-left rounded-lg text-sm mb-1 transition-colors truncate
              ${activeReference?.book === book.number
                ? 'bg-blue-600 text-white'
                : darkMode
                  ? 'hover:bg-gray-800 text-gray-300'
                  : 'hover:bg-gray-200 text-gray-700'}
            `}
            title={book.name}
          >
            {book.name}
          </button>
        ))}
      </div>

      <div className={`
        w-20 border-r overflow-y-auto p-2
        ${darkMode ? 'border-gray-700' : 'border-gray-200'}
      `}>
        <div className={`
          text-xs font-medium uppercase tracking-wide px-2 py-1 mb-2
          ${darkMode ? 'text-gray-400' : 'text-gray-500'}
        `}>
          Ch
        </div>
        {chapters.map((chapter) => (
          <button
            key={chapter.number}
            onClick={() => handleChapterSelect(chapter.number)}
            className={`
              w-full px-2 py-2 text-center rounded-lg text-sm mb-1 transition-colors
              ${activeReference?.chapters?.includes(String(chapter.number))
                ? 'bg-blue-600 text-white'
                : darkMode
                  ? 'hover:bg-gray-800 text-gray-300'
                  : 'hover:bg-gray-200 text-gray-700'}
            `}
          >
            {chapter.number}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col">
        <div className={`
          text-xs font-medium uppercase tracking-wide px-2 py-1 mb-2
          ${darkMode ? 'text-gray-400' : 'text-gray-500'}
        `}>
          Verses
        </div>
        <div className="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto pr-1">
          {verses.map((verse) => (
            <button
              key={verse.number}
              onClick={() => handleVerseSelect(verse.number)}
              className={`
                w-full rounded-xl border p-3 text-left transition-colors
                ${selectedVerses[0]?.includes(verse.number)
                  ? 'bg-blue-600 text-white border-blue-500'
                  : darkMode
                    ? 'bg-gray-800 hover:bg-gray-700 text-gray-200 border-gray-700'
                    : 'bg-gray-50 hover:bg-gray-100 text-gray-800 border-gray-200'}
              `}
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className={`
                  text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full
                  ${selectedVerses[0]?.includes(verse.number)
                    ? 'bg-white/20 text-white'
                    : darkMode
                      ? 'bg-gray-700 text-gray-200'
                      : 'bg-gray-200 text-gray-700'}
                `}>
                  {verse.number}.
                </span>
              </div>
              <div
                className="text-xs leading-relaxed"
                style={{
                  display: '-webkit-box',
                  WebkitLineClamp: 4,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {verse.text}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
