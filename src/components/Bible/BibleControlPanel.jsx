import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { Search, ChevronRight, ChevronDown, Loader2, History, BookOpen, SkipBack, SkipForward, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, GripVertical, LayoutGrid, Rows3, Monitor, Pencil } from 'lucide-react';
import useBibleStore from '../../context/BibleStore';
import useLyricsStore from '../../context/LyricsStore';
import { orderBibleMetadata, searchBible } from 'shared/bible';
import { buildAllVersionsPreview, truncatePreviewText } from '../../utils/biblePreview';
import useToast from '../../hooks/useToast';
import { useControlSocket } from '../../context/ControlSocketProvider';
import { createLogger } from '../../utils/logger.js';
import { splitBibleTextIntoSlides, resolveBibleGeometry } from '../../utils/bibleSplitter';
import { dispatchOpenBibleChapterEditor } from './BibleChapterEditorModal';
import ParallelBibleLinkControl from './ParallelBibleLinkControl';
import BibleImportButton from './BibleImportButton';

const logger = createLogger('BibleControlPanel');

// Display speed: cache splits by text+settings so chapter switches and
// unrelated store updates don't recompute identical verses. LRU 500.
const bibleSplitCache = new Map();
const BIBLE_SPLIT_CACHE_LIMIT = 500;
function getCachedBibleSlides(text, enabled, maxChars, tolerance, method, geometry) {
  const g = geometry ? geometry.charsPerLine + 'x' + geometry.linesCount : 'nogeo';
  const key = (enabled?1:0) + '|' + method + '|' + maxChars + '|' + tolerance + '|' + g + '|' + String(text||'').length + '|' + hashSplitText(text);
  const hit = bibleSplitCache.get(key);
  if (hit) { bibleSplitCache.delete(key); bibleSplitCache.set(key, hit); return hit; }
  const slides = getBibleSlides(text, enabled, maxChars, tolerance, method, geometry);
  bibleSplitCache.set(key, slides);
  if (bibleSplitCache.size > BIBLE_SPLIT_CACHE_LIMIT) {
    const first = bibleSplitCache.keys().next().value;
    bibleSplitCache.delete(first);
  }
  return slides;
}
function hashSplitText(t) {
  const str = String(t||'');
  let h = 5381;
  for (let i=0;i<str.length;i++) h = ((h<<5)+h+str.charCodeAt(i))>>>0;
  return h.toString(36);
}

export default function BibleControlPanel({ darkMode, onSelectVerse }) {
  logger.info('BibleControlPanel mounted');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchAll, setSearchAll] = useState(false);
  const [expandedBooks, setExpandedBooks] = useState({});
  const [selectedSlideIndex, setSelectedSlideIndex] = useState(0);
  const [allVersionsPreview, setAllVersionsPreview] = useState(null);
  const verseListRef = useRef(null);
  const verseRefs = useRef(new Map());
  const { showToast } = useToast();

  const {
    bibles,
    bibleMetadata,
    activeBibleId,
    defaultBibleId,
    activeReference,
    selectedVerses,
    setActiveBible,
    loadAllBibles,
    ensureBiblesLoaded,
    evictInactiveBibles,
    setSearchAllOwner,
    clearSearchAllOwner,
    setReference,
    setSelectedVerses,
    getBibleById,
    getFormattedReference,
    getVerseText,
    bibleHistory = [],
    settings,
    ui = { libraryCollapsed: false, sidePanelCollapsed: false, historyCollapsed: true, selectionCollapsed: false, sidePanelWidth: 380 },
    setUIState
  } = useBibleStore();
  const selectionCollapsed = ui.selectionCollapsed ?? false;
  const sidePanelWidth = ui.sidePanelWidth ?? 380;
  const verseLayout = ui.verseLayout ?? 'grid';
  const isRowMode = verseLayout === 'list';
  // Concept 5 Grid Board: stretchable panel drives column count (1 / 2 / 3).
  // Row mode forces a single-column list regardless of panel width.
  const verseGridColumns = isRowMode ? 1 : (sidePanelWidth >= 640 ? 3 : sidePanelWidth >= 440 ? 2 : 1);
  const splitLongVersesEnabled = Boolean(settings?.splitLongVerses);
  const splitLongVersesChars = Number(settings?.longVersesChars || 100);
  const splitLongVersesTolerance = Number(settings?.longVersesTolerance || 0);
  const splitMethod = settings?.splitMethod || 'nearest-punctuation';

  const output1Settings = useLyricsStore((s) => s.output1Settings) || {};
  const bibleVerseEditorEnabled = useLyricsStore((s) => s.bibleVerseEditorEnabled ?? false);
  const sentenceExperimental = useLyricsStore((s) => s.sentenceSearchExperimental === true);
  const isOutputOn = useLyricsStore((s) => s.isOutputOn);
  const setIsOutputOn = useLyricsStore((s) => s.setIsOutputOn);
  const controlSocket = useControlSocket?.() || null;

  const handleToggleScreenOutput = useCallback(() => {
    const next = !isOutputOn;
    setIsOutputOn(next);
    controlSocket?.emitOutputToggle?.(next);
  }, [isOutputOn, setIsOutputOn, controlSocket]);
  const bibleGeometry = useMemo(
    () => resolveBibleGeometry(output1Settings),
    [output1Settings]
  );

  const currentBible = bibles[activeBibleId];
  const books = currentBible?.books || [];
  const currentBook = activeReference?.book ? books.find(b => b.number === activeReference.book) : null;
  const currentChapter = currentBook && activeReference?.chapters?.[0]
    ? currentBook.chapters.find(c => c.number === parseInt(activeReference.chapters[0]))
    : null;
  const orderedBibleMetadata = useMemo(
    () => orderBibleMetadata(bibleMetadata, defaultBibleId),
    [bibleMetadata, defaultBibleId]
  );

  useEffect(() => {
    if (!activeBibleId && Object.keys(bibleMetadata).length > 0) {
      const firstId = defaultBibleId && bibleMetadata[defaultBibleId]
        ? defaultBibleId
        : orderedBibleMetadata[0]?.id;
      if (firstId) setActiveBible(firstId);
    }
  }, [activeBibleId, bibleMetadata, defaultBibleId, orderedBibleMetadata, setActiveBible]);

  // Load active bible if metadata exists but content doesn't
  useEffect(() => {
    if (activeBibleId && !bibles[activeBibleId] && bibleMetadata[activeBibleId]) {
      setActiveBible(activeBibleId);
    }
  }, [activeBibleId, bibles, bibleMetadata, setActiveBible]);

  useEffect(() => {
    setSearchAllOwner('bible-control-panel', searchAll);
    return () => clearSearchAllOwner('bible-control-panel');
  }, [searchAll, setSearchAllOwner, clearSearchAllOwner]);

  useEffect(() => {
    if (searchAll) {
      loadAllBibles();
    } else {
      evictInactiveBibles();
      searchWorkerRef.current?.postMessage({ pruneBibles: useBibleStore.getState().bibles });
    }
  }, [searchAll, loadAllBibles, evictInactiveBibles]);

  const searchWorkerRef = useRef(null);
  const lastBiblesRef = useRef(null);
  const lastCurrentBibleRef = useRef(null);
  const searchQidRef = useRef(0);

  useEffect(() => {
    searchWorkerRef.current = new Worker(new URL('../../utils/bibleSearch.worker.js', import.meta.url), { type: 'module' });
    searchWorkerRef.current.onmessage = (e) => {
      const payload = e.data && typeof e.data === 'object' && !Array.isArray(e.data) && 'results' in e.data ? e.data : null;
      if (payload && payload.qid !== searchQidRef.current) return;
      const next = Array.isArray(e.data) ? e.data : Array.isArray(payload?.results) ? payload.results : [];
      setSearchResults(next);
      setSearching(false);
    };
    return () => {
      searchWorkerRef.current?.terminate();
    };
  }, []);

  useEffect(() => {
    if (!query || query.length < 3 || !currentBible) {
      setSearchResults([]);
      setSearching(false);
      return undefined;
    }

    const handle = setTimeout(() => {
      setSearching(true);
      const biblesChanged = bibles !== lastBiblesRef.current;
      const currentChanged = currentBible !== lastCurrentBibleRef.current;
      lastBiblesRef.current = bibles;
      lastCurrentBibleRef.current = currentBible;
      searchQidRef.current += 1;
      searchWorkerRef.current?.postMessage({
        qid: searchQidRef.current,
        query,
        maxResults: 20,
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
  }, [query, currentBible, bibles, defaultBibleId, searchAll, sentenceExperimental]);

  const handleBookToggle = useCallback((bookNumber) => {
    setExpandedBooks(prev => ({
      ...prev,
      [bookNumber]: !prev[bookNumber]
    }));
  }, []);

  const handleBibleChange = useCallback(async (newId) => {
    if (!newId || newId === activeBibleId) return;
    setAllVersionsPreview(null);
    setSelectedSlideIndex(0);
    const prevId = activeBibleId;
    const switchInPlace = Boolean(settings?.switchInPlace);
    const hasSelection = Boolean(activeReference) && (selectedVerses[0]?.length > 0);
    const referenceLabel = getFormattedReference();

    await setActiveBible(newId);

    if (switchInPlace && hasSelection) {
      const newBible = getBibleById(newId);
      const newText = getVerseText();
      if (!newText || !newBible) {
        if (prevId) await setActiveBible(prevId);
        showToast({
          title: 'Reference not found',
          message: `${referenceLabel || 'Current reference'} not found in ${newBible?.name || 'the selected translation'}. Kept the previous translation.`,
          variant: 'warning'
        });
        return;
      }

      const slides = getBibleSlides(newText, splitLongVersesEnabled, splitLongVersesChars, splitLongVersesTolerance, splitMethod, bibleGeometry);
      if (onSelectVerse) {
        onSelectVerse({
          reference: getFormattedReference(),
          text: slides[0] || newText,
          fullText: newText,
          slides,
          slideIndex: 0,
          bible: newBible.name,
        });
      }
    }
  }, [activeBibleId, activeReference, getBibleById, getFormattedReference, getVerseText, onSelectVerse, selectedVerses, setActiveBible, setSelectedSlideIndex, settings, showToast, splitLongVersesEnabled, splitLongVersesChars, splitLongVersesTolerance, splitMethod, bibleGeometry]);

  const stageVerseSelection = useCallback((book, chapter, verses, slideIndex = 0) => {
    // Stage a verse in the panel WITHOUT sending to output.
    // Updates the selection highlight + preview text; live display is untouched.
    // The operator fires it live later via Enter/click/Send to Display.
    const verseArray = Array.isArray(verses) ? verses : [verses];
    setAllVersionsPreview(null);
    setReference({
      id: activeBibleId,
      book,
      chapters: [String(chapter)],
      verses: [verseArray]
    });
    setSelectedVerses([verseArray]);
    setSelectedSlideIndex(slideIndex);
  }, [activeBibleId, setReference, setSelectedVerses, setSelectedSlideIndex]);

  const handleVerseSelect = useCallback((book, chapter, verses, text, eventOrOptions) => {
    const previewOnly = Boolean(
      eventOrOptions?.altKey || eventOrOptions?.previewOnly
    );
    if (previewOnly) {
      stageVerseSelection(book, chapter, verses, 0);
      return;
    }
    const verseArray = Array.isArray(verses) ? verses : [verses];

    setReference({
      id: activeBibleId,
      book,
      chapters: [String(chapter)],
      verses: [verseArray]
    });
    setSelectedVerses([verseArray]);
    setSelectedSlideIndex(0);
    setAllVersionsPreview(null);

    if (onSelectVerse) {
      const bookData = currentBible?.books.find(b => b.number === book);
      const reference = verseArray.length > 1
        ? `${bookData?.name || 'Unknown'} ${chapter}:${verseArray[0]}-${verseArray[verseArray.length - 1]}`
        : `${bookData?.name || 'Unknown'} ${chapter}:${verseArray[0]}`;

      const slides = getBibleSlides(text, splitLongVersesEnabled, splitLongVersesChars, splitLongVersesTolerance, splitMethod, bibleGeometry);
      onSelectVerse({
        reference,
        text: slides[0] || text,
        fullText: text,
        slides,
        slideIndex: 0,
        bible: currentBible?.name,
      });
    }
  }, [activeBibleId, currentBible, setReference, setSelectedSlideIndex, setSelectedVerses, onSelectVerse, splitLongVersesEnabled, splitLongVersesChars, splitLongVersesTolerance, splitMethod, bibleGeometry, stageVerseSelection]);

  const handleVerseSlideSelect = useCallback((verseNumber, slideIndex, event) => {
    if (!currentBook || !currentChapter) return;
    if (event?.altKey) {
      stageVerseSelection(currentBook.number, currentChapter.number, verseNumber, slideIndex);
      return;
    }
    const verse = currentChapter.verses.find(v => v.number === verseNumber);
    if (!verse) return;

    setReference({
      id: activeBibleId,
      book: currentBook.number,
      chapters: [String(currentChapter.number)],
      verses: [[verseNumber]]
    });
    setSelectedVerses([[verseNumber]]);
    setAllVersionsPreview(null);

    const slides = getBibleSlides(verse.text, splitLongVersesEnabled, splitLongVersesChars, splitLongVersesTolerance, splitMethod, bibleGeometry);
    const safeIndex = Math.min(Math.max(slideIndex, 0), Math.max(slides.length - 1, 0));

    if (onSelectVerse) {
      const reference = `${currentBook.name || 'Unknown'} ${currentChapter.number}:${verseNumber}`;
      onSelectVerse({
        reference,
        text: slides[safeIndex] || verse.text,
        fullText: verse.text,
        slides,
        slideIndex: safeIndex,
        bible: currentBible?.name,
      });
    }

    setSelectedSlideIndex(safeIndex);
  }, [currentBook, currentChapter, activeBibleId, onSelectVerse, setSelectedSlideIndex, splitLongVersesEnabled, splitLongVersesChars, splitLongVersesTolerance, splitMethod, bibleGeometry, stageVerseSelection]);

  const handleSearchResultClick = useCallback(async (result, event) => {
    const previewOnly = Boolean(event?.altKey || event?.previewOnly);
    if (result.bibleId && result.bibleId !== activeBibleId) {
      await setActiveBible(result.bibleId);
    }
    if (previewOnly) {
      // Stage underneath: update panel selection, keep current output live.
      stageVerseSelection(result.book, result.chapter, result.verses || result.verse, 0);
      setQuery('');
      setSearchResults([]);
      return;
    }
    setAllVersionsPreview(null);
    handleVerseSelect(result.book, result.chapter, result.verses || result.verse, result.text);
    setQuery('');
    setSearchResults([]);
  }, [handleVerseSelect, activeBibleId, setActiveBible, stageVerseSelection]);

  const handlePreviewAllVersions = useCallback(async (result) => {
    const verseArray = result.verses ? [...result.verses] : [result.verse];
    const ref = {
      id: result.bibleId || activeBibleId,
      book: result.book,
      chapters: [String(result.chapter)],
      verses: [verseArray]
    };
    setReference(ref);
    setSelectedVerses([verseArray]);

    // Settings > Bible: cut copy-paste blobs by default; operator can opt out.
    const truncate = settings?.truncateVersionPreviews !== false;
    const list = await buildAllVersionsPreview({
      reference: ref,
      verses: verseArray,
      bibleMetadata,
      getBibles: () => useBibleStore.getState().bibles,
      loadAllBibles,
      ensureBiblesLoaded,
      defaultBibleId,
      truncate,
    });

    // Fallback if nothing resolved (e.g. bible not fully loaded) — trim here
    // too, or the copy-paste blob renders in full on exactly this degraded path.
    const fallbackFull = result.text ? String(result.text).trim() : '';
    const fallbackText = fallbackFull ? (truncate ? truncatePreviewText(fallbackFull) : fallbackFull) : '';
    const finalList = list.length > 0 ? list : (fallbackText ? [{
      bibleId: result.bibleId || activeBibleId,
      bibleName: result.bibleName || currentBible?.name || 'Current',
      text: fallbackText,
      truncated: truncate && fallbackText !== fallbackFull,
    }] : []);

    setAllVersionsPreview(finalList);
    setQuery('');
    setSearchResults([]);
  }, [activeBibleId, bibleMetadata, currentBible, defaultBibleId, loadAllBibles, setReference, setSelectedVerses, settings]);

  const selectedReference = activeReference && selectedVerses[0]?.length > 0 ? getFormattedReference() : '';
  const selectedVerseText = activeReference && selectedVerses[0]?.length > 0 ? getVerseText() : '';
  const selectedVerseSlides = useMemo(
    () => getBibleSlides(selectedVerseText, splitLongVersesEnabled, splitLongVersesChars, splitLongVersesTolerance, splitMethod, bibleGeometry),
    [selectedVerseText, splitLongVersesEnabled, splitLongVersesChars, splitLongVersesTolerance, splitMethod, bibleGeometry]
  );
  const hasMultipleSlides = selectedVerseSlides.length > 1;
  const hasSelection = Boolean(activeReference && selectedVerses[0]?.length > 0);
  const verseSlidesMap = useMemo(() => {
    const map = new Map();
    if (!currentChapter) return map;
    currentChapter.verses.forEach((verse) => {
      map.set(verse.number, getCachedBibleSlides(verse.text, splitLongVersesEnabled, splitLongVersesChars, splitLongVersesTolerance, splitMethod, bibleGeometry));
    });
    return map;
  }, [currentChapter, splitLongVersesEnabled, splitLongVersesChars, splitLongVersesTolerance, splitMethod, bibleGeometry]);
  const selectedPreviewText = selectedVerseSlides[selectedSlideIndex] || selectedVerseText;
  const selectedVerseNumbers = selectedVerses[0] || [];
  const lastSelectedVerseNumber = selectedVerseNumbers[selectedVerseNumbers.length - 1];
  const firstSelectedVerseNumber = selectedVerseNumbers[0];
  const nextVerse = currentChapter?.verses?.find((verse) => verse.number > lastSelectedVerseNumber);
  const previousVerse = currentChapter?.verses ? [...currentChapter.verses].reverse().find((verse) => verse.number < firstSelectedVerseNumber) : null;
  const canAdvanceBible = (hasMultipleSlides && selectedSlideIndex < selectedVerseSlides.length - 1) || Boolean(nextVerse);
  const canGoBackBible = selectedSlideIndex > 0 || Boolean(previousVerse);

  useLayoutEffect(() => {
    const verseNumber = selectedVerseNumbers[0];
    const container = verseListRef.current;
    const verseElement = verseRefs.current.get(verseNumber);
    if (!container || !verseElement) return;

    const containerRect = container.getBoundingClientRect();
    const verseRect = verseElement.getBoundingClientRect();
    const targetTop = container.scrollTop + verseRect.top - containerRect.top - 12;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.min(Math.max(0, targetTop), maxScrollTop);
  }, [activeReference?.book, activeReference?.chapters?.[0], currentChapter, selectedVerseNumbers.join(',')]);

  useEffect(() => {
    setSelectedSlideIndex(0);
  }, [splitLongVersesEnabled, splitLongVersesChars, splitLongVersesTolerance, splitMethod, bibleGeometry]);

  const sendBibleSlideToDisplay = useCallback((slideIndex = selectedSlideIndex) => {
    if (!onSelectVerse || !selectedReference || !selectedVerseText) return;

    setAllVersionsPreview(null);
    const safeIndex = Math.min(Math.max(slideIndex, 0), Math.max(selectedVerseSlides.length - 1, 0));
    setSelectedSlideIndex(safeIndex);
    onSelectVerse({
      reference: selectedReference,
      text: selectedVerseSlides[safeIndex] || selectedVerseText,
      fullText: selectedVerseText,
      slides: selectedVerseSlides,
      slideIndex: safeIndex,
      bible: currentBible?.name,
    });
  }, [currentBible?.name, onSelectVerse, selectedReference, selectedSlideIndex, selectedVerseSlides, selectedVerseText]);

  const sendNextBibleSlideToDisplay = useCallback(() => {
    if (hasMultipleSlides && selectedSlideIndex < selectedVerseSlides.length - 1) {
      const nextIndex = selectedSlideIndex + 1;
      sendBibleSlideToDisplay(nextIndex);
      return;
    }

    if (nextVerse && currentBook && currentChapter) {
      handleVerseSelect(currentBook.number, currentChapter.number, nextVerse.number, nextVerse.text);
    }
  }, [currentBook, currentChapter, handleVerseSelect, hasMultipleSlides, nextVerse, selectedSlideIndex, selectedVerseSlides.length, sendBibleSlideToDisplay]);

  const sendPreviousBibleSlideToDisplay = useCallback(() => {
    if (selectedSlideIndex > 0) {
      sendBibleSlideToDisplay(selectedSlideIndex - 1);
      return;
    }

    if (previousVerse && currentBook && currentChapter) {
      const previousSlides = getBibleSlides(previousVerse.text, splitLongVersesEnabled, splitLongVersesChars, splitLongVersesTolerance, splitMethod, bibleGeometry);
      const previousSlideIndex = Math.max(previousSlides.length - 1, 0);
      setAllVersionsPreview(null);
      setReference({
        id: activeBibleId,
        book: currentBook.number,
        chapters: [String(currentChapter.number)],
        verses: [[previousVerse.number]]
      });
      setSelectedVerses([[previousVerse.number]]);
      setSelectedSlideIndex(previousSlideIndex);

      if (onSelectVerse) {
        const reference = `${currentBook.name || 'Unknown'} ${currentChapter.number}:${previousVerse.number}`;
        onSelectVerse({
          reference,
          text: previousSlides[previousSlideIndex] || previousVerse.text,
          fullText: previousVerse.text,
          slides: previousSlides,
          slideIndex: previousSlideIndex,
          bible: currentBible?.name,
        });
      }
    }
  }, [activeBibleId, currentBible?.name, currentBook, currentChapter, onSelectVerse, previousVerse, selectedSlideIndex, sendBibleSlideToDisplay, setReference, setSelectedVerses, splitLongVersesEnabled, splitLongVersesChars, splitLongVersesTolerance, splitMethod, bibleGeometry]);

  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef(null);

  const startResizing = useCallback((e) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const stopResizing = useCallback(() => {
    setIsResizing(false);
  }, []);

  const resize = useCallback((e) => {
    if (isResizing && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const newWidth = rect.right - e.clientX;
      const min = 280;
      const max = Math.max(min + 40, rect.width - 280);
      const clamped = Math.min(Math.max(newWidth, min), max);
      // only update if within bounds — avoids jitter at edges
      if (newWidth >= min && newWidth <= max) {
        setUIState({ sidePanelWidth: clamped });
      } else if (newWidth < min) {
        setUIState({ sidePanelWidth: min });
      } else if (newWidth > max) {
        setUIState({ sidePanelWidth: max });
      }
    }
  }, [isResizing, setUIState]);

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

  return (
    <div className={`flex h-full min-h-0 flex-col ${darkMode ? 'bg-gray-800 text-gray-100' : 'bg-white text-gray-900'}`}>
      {/* Main area */}
      <div className="flex-1 min-h-0 p-3 relative" ref={containerRef}>
        <div 
          className={`grid h-full min-h-0 gap-3 ${isResizing ? '' : 'transition-[grid-template-columns] duration-300'} ${
            ui.libraryCollapsed || ui.sidePanelCollapsed 
              ? 'grid-cols-1' 
              : 'xl:grid-cols-[1fr_auto]'
          }`}
          style={{ 
            gridTemplateColumns: (!ui.libraryCollapsed && !ui.sidePanelCollapsed) 
              ? `1fr ${ui.sidePanelWidth}px` 
              : undefined 
          }}
        >
          {/* Main Bible module (Library & History) */}
          {!ui.libraryCollapsed && (
          <div className={`flex min-h-0 flex-col gap-3 transition-all duration-300 animate-in fade-in slide-in-from-left-4`}>
            <section className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border shadow-sm ${darkMode ? 'border-gray-700 bg-gray-900/60' : 'border-gray-200 bg-gray-50'}`}>
              <div className={`flex-shrink-0 border-b px-4 py-3 ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <BookOpen className={`h-4 w-4 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`} />
                    <div>
                      <div className="text-xs font-bold uppercase tracking-wider">Bible Library</div>
                      <div className={`text-[11px] ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                        Choose a book and chapter
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <BibleImportButton darkMode={darkMode} compact />
                    <button
                      onClick={() => setUIState({ libraryCollapsed: true })}
                      className={`p-1 rounded-md transition-colors ${darkMode ? 'hover:bg-gray-800 text-gray-500' : 'hover:bg-gray-100 text-gray-400'}`}
                      title="Collapse Library"
                    >
                      <PanelLeftClose className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto">
                {books.length > 0 ? (
                  books.map((book) => (
                    <div key={book.number} className="border-b last:border-b-0 border-transparent">
                      <button
                        onClick={() => handleBookToggle(book.number)}
                        className={`flex w-full items-center gap-2 px-4 py-3 text-left text-sm transition-colors ${darkMode
                          ? 'hover:bg-gray-800 text-gray-200'
                          : 'hover:bg-white text-gray-800'
                          } ${activeReference?.book === book.number
                            ? darkMode ? 'bg-blue-900/30' : 'bg-blue-50'
                            : ''}`}
                      >
                        {expandedBooks[book.number]
                          ? <ChevronDown className="h-4 w-4 flex-shrink-0" />
                          : <ChevronRight className="h-4 w-4 flex-shrink-0" />
                        }
                        <span className="truncate">{book.name}</span>
                      </button>

                      {expandedBooks[book.number] && (
                        <div className={`grid grid-cols-8 gap-1 px-4 pb-3 ${darkMode ? 'bg-gray-900/20' : 'bg-white/40'}`}>
                          {book.chapters.map((chapter) => (
                            <button
                              key={chapter.number}
                             onClick={() => {
                                setAllVersionsPreview(null);
                                setSelectedSlideIndex(0);
                                setReference({
                                  id: activeBibleId,
                                  book: book.number,
                                  chapters: [String(chapter.number)],
                                  verses: [[1]]
                                });
                                setSelectedVerses([[1]]);
                              }}
                              className={`rounded-lg px-2 py-1 text-xs transition-colors ${activeReference?.book === book.number && activeReference?.chapters?.[0] === String(chapter.number)
                                ? darkMode ? 'bg-blue-600 text-white' : 'bg-blue-600 text-white'
                                : darkMode
                                  ? 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                                }`}
                            >
                              {chapter.number}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                ) : (
                  <div className={`flex h-full min-h-[240px] items-center justify-center p-6 text-center ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                    <div>
                      <BookOpen className="mx-auto mb-3 h-8 w-8 opacity-60" />
                      <p className="text-sm font-medium">Import a Bible to get started</p>
                      <BibleImportButton darkMode={darkMode} className="mt-3" />
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Bible History Section */}
            {bibleHistory.length > 0 && (
              <section className={`flex-shrink-0 overflow-hidden rounded-2xl border shadow-sm ${darkMode ? 'border-gray-700 bg-gray-900/60' : 'border-gray-200 bg-white'}`}>
                <button
                  onClick={() => setUIState({ historyCollapsed: !ui.historyCollapsed })}
                  className={`w-full flex items-center justify-between px-4 py-3 text-xs font-bold uppercase tracking-wider transition-colors ${darkMode ? 'text-gray-400 hover:text-gray-200 bg-gray-800/50' : 'text-gray-500 hover:text-gray-700 bg-gray-50'
                    }`}
                >
                  <div className="flex items-center gap-2">
                    <History className="h-4 w-4" />
                    Recent Verses
                  </div>
                  {ui.historyCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>

                {!ui.historyCollapsed && (
                  <div className={`max-h-56 overflow-y-auto p-2 grid grid-cols-1 gap-1.5 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
                    {bibleHistory.map((entry) => (
                      <button
                        key={entry.id}
                         onClick={() => {
                           // Recent entries store reference as string (e.g. "John 3:16") - resolve via search so behaviour matches searching
                           const ref = entry.reference;
                            if (typeof ref === 'string') {
                              const baseBible = currentBible || (activeBibleId ? bibles[activeBibleId] : null) || Object.values(bibles)[0];
                              if (baseBible) {
                                const results = searchBible(baseBible, ref, bibles, 5, defaultBibleId, true);
                                if (results.length > 0) {
                                  handleSearchResultClick(results[0]);
                                  setExpandedBooks(prev => ({ ...prev, [results[0].book]: true }));
                                  setUIState({ historyCollapsed: true });
                                  return;
                                }
                               // Fallback: put reference into search box so user sees it on right
                               setQuery(ref);
                               const immediate = searchBible(baseBible, ref, bibles, 20, defaultBibleId, Boolean(searchAll));
                               setSearchResults(immediate);
                               setUIState({ historyCollapsed: true });
                               return;
                             }
                             // No bible loaded - still display text via onSelectVerse
                             if (onSelectVerse) {
                               const slides = getBibleSlides(entry.text, splitLongVersesEnabled, splitLongVersesChars, splitLongVersesTolerance, splitMethod, bibleGeometry);
                               onSelectVerse({ reference: ref, text: slides[0] || entry.text, fullText: entry.text, slides, slideIndex: 0, bible: entry.bibleName });
                             }
                             setUIState({ historyCollapsed: true });
                             return;
                           }
                            // Structured reference (new format with bibleId/book/chapters/verses)
                            if (entry.structuredReference) {
                              const sr = entry.structuredReference;
                              if (sr.bibleId && sr.bibleId !== activeBibleId) setActiveBible(sr.bibleId);
                              handleVerseSelect(sr.book, parseInt(String(sr.chapters?.[0]), 10), sr.verses?.[0] ?? sr.verse, entry.text);
                              setExpandedBooks(prev => ({ ...prev, [sr.book]: true }));
                              setUIState({ historyCollapsed: true });
                              return;
                            }
                            // Legacy object reference (book/chapters/verses directly on entry.reference)
                            if (ref && typeof ref === 'object' && ref.book) {
                              if (ref.id && ref.id !== activeBibleId) setActiveBible(ref.id);
                              else if (entry.bibleId && entry.bibleId !== activeBibleId) setActiveBible(entry.bibleId);
                              handleVerseSelect(ref.book, parseInt(String(ref.chapters?.[0]), 10), ref.verses?.[0], entry.text);
                              setExpandedBooks(prev => ({ ...prev, [ref.book]: true }));
                              setUIState({ historyCollapsed: true });
                              return;
                            }
                            // Last resort - treat as search string
                            const fallbackBase = currentBible || Object.values(bibles)[0];
                            if (fallbackBase) {
                              const results = searchBible(fallbackBase, String(ref), bibles, 5, defaultBibleId, true);
                              if (results.length) {
                                handleSearchResultClick(results[0]);
                                setExpandedBooks(prev => ({ ...prev, [results[0].book]: true }));
                              }
                            }
                           setUIState({ historyCollapsed: true });
                         }}
                        className={`flex flex-col items-start rounded-xl border p-3 text-left transition-all ${darkMode
                          ? 'border-gray-700 text-gray-200 hover:bg-gray-700'
                          : 'border-gray-100 text-gray-800 hover:bg-gray-50 hover:border-gray-200'
                          }`}
                      >
                        <div className="flex w-full items-center justify-between gap-2">
                          <div className="truncate text-sm font-semibold">{entry.reference}</div>
                          <div className="text-[10px] font-bold uppercase opacity-60">{entry.bibleName}</div>
                        </div>
                        <div className="mt-1.5 w-full text-xs leading-relaxed opacity-70 line-clamp-2">{entry.text}</div>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
          )}

          {/* Verse side panel */}
          {!ui.sidePanelCollapsed && (
          <aside className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border shadow-xl relative transition-all duration-300 animate-in fade-in slide-in-from-right-4 ${darkMode ? 'border-gray-700 bg-gray-950/60' : 'border-gray-200 bg-white'}`}>
            {/* Resize Handle */}
            {!ui.libraryCollapsed && (
              <div
                  onMouseDown={startResizing}
                  className={`absolute -left-1 top-0 bottom-0 w-2 cursor-col-resize z-30 group flex items-center justify-center hover:bg-blue-500/20 transition-colors`}
              >
                  <div className={`w-1 h-full bg-transparent group-hover:bg-blue-500/30 transition-colors`}></div>
                  <GripVertical className="absolute w-4 h-4 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            )}
            
            {/* Search bar & Toggle */}
            <div className={`flex-shrink-0 border-b p-3 ${darkMode ? 'border-gray-700' : 'border-gray-200'}`} data-testid="bible-search-section">
              <div className="flex items-center gap-2 mb-2">
                <button
                    onClick={() => setUIState({ sidePanelCollapsed: true })}
                    className={`p-1 rounded-md transition-colors ${darkMode ? 'hover:bg-gray-800 text-gray-500' : 'hover:bg-gray-100 text-gray-400'}`}
                    title="Collapse Side Panel"
                >
                    <PanelRightClose className="w-4 h-4" />
                </button>
                <div className="text-[10px] font-bold uppercase tracking-wider opacity-60">Verse Search & Selection</div>
                <button
                  type="button"
                  onClick={handleToggleScreenOutput}
                  className={`ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                    isOutputOn
                      ? darkMode
                        ? 'border-green-500/40 bg-green-500/20 text-green-300 hover:bg-green-500/30'
                        : 'border-green-300 bg-green-50 text-green-700 hover:bg-green-100'
                      : darkMode
                        ? 'border-red-500/40 bg-red-500/20 text-red-300 hover:bg-red-500/30'
                        : 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100'
                  }`}
                  title={isOutputOn ? 'Screen output is LIVE. Click to blackout.' : 'Screen output is OFF (blackout). Click to turn on.'}
                >
                  <Monitor className="h-3 w-3" />
                  {isOutputOn ? 'Live' : 'Off'}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className={`absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`} />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => { setAllVersionsPreview(null); setQuery(e.target.value); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.altKey && e.shiftKey) {
                        if (bibleVerseEditorEnabled) {
                          e.preventDefault();
                          e.stopPropagation();
                          dispatchOpenBibleChapterEditor();
                        }
                        return;
                      }
                      if (e.key === 'Enter' && searchResults.length > 0) {
                        e.preventDefault();
                        if (e.shiftKey) {
                          handlePreviewAllVersions(searchResults[0]);
                        } else if (e.altKey) {
                          handleSearchResultClick(searchResults[0], e);
                        } else {
                          handleSearchResultClick(searchResults[0]);
                        }
                      }
                    }}
                    title="Enter: display • Shift+Enter: preview all translations • Alt+Enter: stage without changing output • Alt+Shift+Enter: edit verse"
                    placeholder="Search verses..."
                    data-bible-search-input
                    className={`w-full rounded-lg border py-2 pl-9 pr-3 text-sm ${darkMode
                      ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-400'
                      : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'
                      }`}
                  />
                  {searching && (
                    <Loader2 className={`absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin ${darkMode ? 'text-gray-400' : 'text-gray-500'}`} />
                  )}
                </div>
                <select
                  value={activeBibleId || ''}
                  onChange={(e) => handleBibleChange(e.target.value)}
                  className={`w-32 shrink-0 rounded-lg border px-2 py-2 text-xs ${darkMode
                    ? 'bg-gray-700 border-gray-600 text-white'
                    : 'bg-white border-gray-300 text-gray-900'
                    }`}
                  title="Translation"
                >
                  <option value="">Select Bible</option>
                  {orderedBibleMetadata.map(meta => (
                    <option key={meta.id} value={meta.id}>{meta.name}</option>
                  ))}
                </select>
              </div>

              <div className="mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  id="search-all-bibles"
                  checked={searchAll}
                  onChange={(e) => setSearchAll(e.target.checked)}
                  className="h-3 w-3 accent-blue-600"
                />
                <label htmlFor="search-all-bibles" className={`text-[10px] font-medium uppercase tracking-wider ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  Search all bibles
                </label>
              </div>

              {/* Search Results — allow growing past half the panel when needed */}
              {searchResults.length > 0 ? (
                <div className={`mt-2 max-h-[min(52vh,420px)] overflow-y-auto rounded-lg border ${darkMode ? 'border-gray-600 bg-gray-700' : 'border-gray-200 bg-white'
                  }`}>
                  {searchResults.map((result, idx) => (
                    <button
                      key={`${result.reference}-${idx}`}
                      onClick={(e) => handleSearchResultClick(result, e)}
                      title="Click: display • Alt+Click: stage without changing output"
                      className={`w-full border-b p-2 text-left text-sm last:border-b-0 ${darkMode ? 'border-gray-600 hover:bg-gray-600' : 'border-gray-100 hover:bg-gray-50'
                        }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-medium">{result.reference}</div>
                        {result.bibleName && (
                          <div className="rounded bg-blue-600/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-blue-400">
                            {result.bibleName}
                          </div>
                        )}
                      </div>
                      <div className={`truncate text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                        {result.text}
                      </div>
                    </button>
                  ))}
                </div>
              ) : query.length >= 3 ? (
                <div className={`mt-2 rounded-lg border px-3 py-2 text-xs ${darkMode ? 'border-gray-700 bg-gray-800 text-gray-400' : 'border-gray-200 bg-gray-50 text-gray-500'
                  }`}>
                  No matching verses found.
                </div>
              ) : (
                <div className={`mt-2 rounded-lg border px-3 py-2 text-xs ${darkMode ? 'border-gray-700 bg-gray-800 text-gray-400' : 'border-gray-200 bg-gray-50 text-gray-500'
                  }`}>
                  Search for a verse or passage to bring results up beside the Bible module.
                </div>
              )}
              {searchResults.length > 0 && (
                <div className={`mt-1.5 text-[10px] ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                  <span className="font-semibold">Enter</span> to display • <span className="font-semibold">Shift+Enter</span> to preview in all translations • <span className="font-semibold">Alt+Enter</span> to stage without changing output {bibleVerseEditorEnabled && <> • <span className="font-semibold">Alt+Shift+Enter</span> to edit verse</>}
                </div>
              )}
              {bibleVerseEditorEnabled && (
                <button
                  type="button"
                  onClick={() => dispatchOpenBibleChapterEditor()}
                  disabled={!currentChapter}
                  title={currentChapter ? 'Edit selected verse text, then send to display (Alt+Shift+Enter)' : 'Select a verse first'}
                  className={`mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-colors ${!currentChapter ? 'cursor-not-allowed opacity-40' : ''} ${darkMode ? 'border-gray-600 bg-gray-800 text-gray-200 hover:bg-gray-700' : 'border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100'}`}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Edit verse (Alt+Shift+Enter)
                </button>
              )}
            </div>

            {/* Live tray — "Psalm 1:1" header carrying the verse-step arrows and Send to
                Display. The parallel translation control sits immediately under that
                header so hiding/showing the second translation is one click from the
                verse being worked. The shell renders with no selection too, so the
                control stays reachable before a verse is picked. */}
            <div
              className={`flex-shrink-0 border-b ${hasSelection
                ? (darkMode ? 'border-gray-700 bg-blue-900/30' : 'border-gray-200 bg-blue-50')
                : (darkMode ? 'border-gray-700 bg-gray-900/40' : 'border-gray-200 bg-white')
              }`}
              data-testid="bible-live-tray"
            >
              {hasSelection && (
                <div className="flex items-center justify-between gap-2 p-3 pb-2">
                  <button
                    type="button"
                    onClick={() => setUIState({ selectionCollapsed: !selectionCollapsed })}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    aria-expanded={!selectionCollapsed}
                    title={selectionCollapsed ? 'Expand live selection' : 'Collapse live selection'}
                  >
                    {selectionCollapsed
                      ? <ChevronRight className="h-4 w-4 flex-shrink-0" />
                      : <ChevronDown className="h-4 w-4 flex-shrink-0" />
                    }
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{selectedReference}</span>
                      {hasMultipleSlides && (
                        <span className={`mt-0.5 block text-[10px] font-semibold uppercase tracking-wider ${darkMode ? 'text-blue-200' : 'text-blue-700'}`}>
                          Slide {selectedSlideIndex + 1} of {selectedVerseSlides.length}
                        </span>
                      )}
                      {selectionCollapsed && (
                        <span className={`block truncate text-[11px] ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                          {selectedPreviewText}
                        </span>
                      )}
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={sendPreviousBibleSlideToDisplay}
                      disabled={!canGoBackBible}
                      className={`rounded border p-1 transition-colors ${darkMode
                        ? 'border-blue-400/40 bg-blue-500/20 text-blue-100 hover:bg-blue-500/30 disabled:border-gray-700 disabled:bg-gray-800 disabled:text-gray-500'
                        : 'border-blue-200 bg-white text-blue-700 hover:bg-blue-50 disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400'
                        } disabled:cursor-not-allowed`}
                      title={canGoBackBible ? 'Send previous Bible slide or verse' : 'No previous Bible slide or verse'}
                    >
                      <SkipBack className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => sendBibleSlideToDisplay(selectedSlideIndex)}
                      className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-700"
                    >
                      Send to Display
                    </button>
                    <button
                      type="button"
                      onClick={sendNextBibleSlideToDisplay}
                      disabled={!canAdvanceBible}
                      className={`rounded border p-1 transition-colors ${darkMode
                        ? 'border-blue-400/40 bg-blue-500/20 text-blue-100 hover:bg-blue-500/30 disabled:border-gray-700 disabled:bg-gray-800 disabled:text-gray-500'
                        : 'border-blue-200 bg-white text-blue-700 hover:bg-blue-50 disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400'
                        } disabled:cursor-not-allowed`}
                      title={canAdvanceBible ? 'Send next Bible slide or verse' : 'No next Bible slide or verse'}
                    >
                      <SkipForward className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}
              {/* Parallel display — directly under the reference + verse-step row, ahead of
                  the slide list, so it holds one predictable spot however long the
                  passage splits. */}
              <div className="px-3 pb-2">
                <ParallelBibleLinkControl darkMode={darkMode} />
              </div>
              {hasSelection && !selectionCollapsed && (
                <div className="px-3 pb-3">
                {allVersionsPreview && allVersionsPreview.length > 0 ? (
                  <div className="mt-2 space-y-2 max-h-48 overflow-y-auto pr-1">
                    {allVersionsPreview.map((item) => (
                      <div
                        key={item.bibleId}
                        className={`rounded-lg border p-2 text-left ${darkMode ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'}`}
                      >
                        <div className={`text-[10px] font-bold uppercase tracking-wider ${darkMode ? 'text-blue-300' : 'text-blue-600'}`}>
                          {item.bibleName}
                        </div>
                        <div className={`mt-1 text-xs leading-relaxed ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                          {item.text}
                          {item.truncated && (
                            <span className={`ml-1 italic ${darkMode ? 'text-gray-500' : 'text-gray-400'}`} title="Oversized verse text trimmed for the preview (Settings > Bible)">
                              (trimmed)
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                    <div className={`text-[10px] italic ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                      Preview only — not sent to output. Press Enter on the same result to display.
                    </div>
                  </div>
                ) : hasMultipleSlides ? (
                  <div className="mt-2 space-y-1">
                    {selectedVerseSlides.map((slide, idx) => {
                      const letter = String.fromCharCode(97 + idx);
                      const isActive = idx === selectedSlideIndex;
                      return (
                        <div
                          key={idx}
                         onClick={() => sendBibleSlideToDisplay(idx)}
                          className={`flex items-start gap-2 p-2 rounded-lg cursor-pointer transition-colors ${
                            isActive
                              ? darkMode ? 'bg-blue-600/30 border border-blue-500/50' : 'bg-blue-100 border border-blue-300'
                              : darkMode ? 'bg-gray-800/50 border border-gray-700' : 'bg-gray-100 border border-gray-200'
                          }`}
                        >
                          <span className={`shrink-0 mt-0.5 w-5 h-5 flex items-center justify-center rounded-full text-[10px] font-bold ${
                            isActive
                              ? darkMode ? 'bg-blue-500 text-white' : 'bg-blue-600 text-white'
                              : darkMode ? 'bg-gray-600 text-gray-400' : 'bg-gray-300 text-gray-600'
                          }`}>
                            {letter}
                          </span>
                          <div className={`text-xs leading-relaxed flex-1 ${isActive ? '' : 'opacity-60'}`}>
                            {slide}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                    {selectedPreviewText}
                  </div>
                )}
                </div>
                )}
            </div>

            {/* Current Chapter Verses — Grid / Row board */}
            <div className="flex min-h-0 flex-1 flex-col p-3">
              <div className={`mb-2 flex flex-wrap items-center justify-between gap-2 text-xs font-medium uppercase tracking-wider ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                <span>
                  {currentBook?.name && currentReferenceLabel(currentBook?.name, activeReference)}
                  {!currentBook?.name && 'Verses'}
                </span>
                <span className="flex items-center gap-2">
                  {currentChapter && (
                    <span className="text-[10px] font-bold normal-case tracking-normal opacity-60">
                      {isRowMode
                        ? `Rows · ${currentChapter.verses.length} verses`
                        : `${verseGridColumns} ${verseGridColumns === 1 ? 'column' : 'columns'} · ${currentChapter.verses.length} verses`}
                    </span>
                  )}
                  <span className={`hidden items-center rounded-lg border p-0.5 sm:inline-flex ${darkMode ? 'border-gray-700 bg-gray-900/60' : 'border-gray-200 bg-gray-50'}`}>
                    <button
                      type="button"
                      onClick={() => setUIState({ verseLayout: 'grid' })}
                      title="Grid view (columns)"
                      aria-pressed={!isRowMode}
                      className={`rounded-md p-1 transition-colors ${!isRowMode ? 'bg-blue-600 text-white' : darkMode ? 'text-gray-500 hover:text-gray-200' : 'text-gray-400 hover:text-gray-700'}`}
                    >
                      <LayoutGrid className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setUIState({ verseLayout: 'list' })}
                      title="Row view (list)"
                      aria-pressed={isRowMode}
                      className={`rounded-md p-1 transition-colors ${isRowMode ? 'bg-blue-600 text-white' : darkMode ? 'text-gray-500 hover:text-gray-200' : 'text-gray-400 hover:text-gray-700'}`}
                    >
                      <Rows3 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </span>
              </div>

              {currentChapter ? (
                <div
                  ref={verseListRef}
                  data-testid="verse-grid"
                  data-columns={verseGridColumns}
                  data-layout={verseLayout}
                  className={isRowMode
                    ? "flex h-full min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1"
                    : "grid h-full min-h-0 flex-1 content-start gap-1.5 overflow-y-auto pr-1"}
                  style={isRowMode ? undefined : { gridTemplateColumns: `repeat(${verseGridColumns}, minmax(0, 1fr))` }}
                >
                   {currentChapter.verses.map((verse) => {
                    const slides = verseSlidesMap.get(verse.number) || [verse.text];
                    const isVerseSelected = selectedVerses[0]?.includes(verse.number);

                    return (
                       <div
                         key={verse.number}
                         ref={(element) => {
                           if (element) {
                             verseRefs.current.set(verse.number, element);
                           } else {
                             verseRefs.current.delete(verse.number);
                           }
                         }}
                         data-testid={isRowMode ? "verse-row" : "verse-card"}
                         style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 120px' }}
                          className={isRowMode
                            ? `flex min-w-0 items-start gap-3 rounded-lg border p-2 ${darkMode ? 'border-gray-700/60 bg-gray-900/40' : 'border-gray-200/80 bg-gray-50/60'}`
                            : `flex min-w-0 flex-col gap-1 rounded-lg border p-1.5 ${darkMode ? 'border-gray-700/60 bg-gray-900/40' : 'border-gray-200/80 bg-gray-50/60'}`}
                       >
                        <div className={isRowMode
                          ? "flex w-16 shrink-0 items-center justify-center rounded-md px-1 py-1.5 text-[10px] font-bold uppercase tracking-wider opacity-70"
                          : "px-1 pt-0.5 text-[9px] font-bold uppercase tracking-wider opacity-40"}>
                          {isRowMode ? `${verse.number}` : `Verse ${verse.number}`}
                        </div>
                        <div className={isRowMode ? "flex min-w-0 flex-1 flex-col gap-1" : "contents"}>
                        {slides.map((slide, slideIdx) => {
                          const letter = String.fromCharCode(97 + slideIdx);
                          const isSlideSelected = isVerseSelected && selectedSlideIndex === slideIdx;
                          return (
                            <button
                              key={slideIdx}
                              onClick={(e) => handleVerseSlideSelect(verse.number, slideIdx, e)}
                              title="Click: display • Alt+Click: stage without changing output"
                              className={`flex w-full gap-2 rounded-lg border p-2 text-left transition-colors ${isSlideSelected
                                ? 'border-blue-500 bg-blue-600 text-white'
                                : darkMode
                                  ? 'border-gray-700 bg-gray-800 text-gray-200 hover:bg-gray-700'
                                  : 'border-gray-200 bg-white text-gray-800 hover:bg-gray-100'
                                }`}
                            >
                              <span className={`h-4 w-4 flex-shrink-0 self-start rounded-full text-center text-[9px] font-bold leading-4 ${isSlideSelected
                                ? 'bg-white/20 text-white'
                                : darkMode
                                  ? 'bg-gray-600 text-gray-200'
                                  : 'bg-gray-200 text-gray-700'
                                }`}>
                                {letter}
                              </span>
                              <div
                                className="min-w-0 flex-1 text-[11px] leading-[1.45]"
                                style={isRowMode ? undefined : {
                                  display: '-webkit-box',
                                  WebkitLineClamp: 4,
                                  WebkitBoxOrient: 'vertical',
                                  overflow: 'hidden',
                                }}
                              >
                                {slide}
                              </div>
                            </button>
                          );
                        })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className={`flex h-full min-h-[220px] items-center justify-center rounded-xl border border-dashed px-4 text-center text-sm ${darkMode ? 'border-gray-700 text-gray-400' : 'border-gray-200 text-gray-500'
                  }`}>
                  {activeReference?.book
                    ? 'Select a chapter to browse verses.'
                    : 'Select a book to begin browsing verses.'}
                </div>
              )}
            </div>
          </aside>
          )}

          {/* Restore Buttons (When collapsed) */}
          {ui.libraryCollapsed && (
            <button
                onClick={() => setUIState({ libraryCollapsed: false })}
                className={`absolute left-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-xl border shadow-lg transition-all ${darkMode ? 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white' : 'bg-white border-gray-200 text-gray-500 hover:text-blue-600'}`}
                title="Expand Bible Library"
            >
                <PanelLeftOpen className="w-5 h-5" />
            </button>
          )}

          {ui.sidePanelCollapsed && (
            <button
                onClick={() => setUIState({ sidePanelCollapsed: false })}
                className={`absolute right-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-xl border shadow-lg transition-all ${darkMode ? 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white' : 'bg-white border-gray-200 text-gray-500 hover:text-blue-600'}`}
                title="Expand Side Panel"
            >
                <PanelRightOpen className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function currentReferenceLabel(bookName, activeReference) {
  if (!activeReference?.chapters?.[0]) return bookName;
  return `${bookName} ${activeReference.chapters[0]}`;
}

function getBibleSlides(text, splitLongVersesEnabled, maxChars = 100, tolerance = 0, method = 'nearest-punctuation', geometry = null) {
  return splitBibleTextIntoSlides(text, {
    splitLongVerses: splitLongVersesEnabled,
    method,
    maxChars,
    tolerance,
    geometry,
  });
}
