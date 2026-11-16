import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X, Download, BookOpen, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import useToast from '../hooks/useToast';
import useNetworkStatus from '../hooks/OnlineLyricsSearchModal/useNetworkStatus';
import useBibleStore from '../context/BibleStore';
import { createLogger } from '../utils/logger.js';
import {
  ONLINE_BIBLE_TRANSLATIONS,
  fetchOnlineBooks,
  downloadOnlineTranslation,
  onlineBibleIdFor,
} from '../utils/onlineBible';

const logger = createLogger('OnlineBibleSearch');
const animationDuration = 220;

/**
 * Find and import a Bible translation — no browser needed.
 * Lists free public-domain translations; one tap downloads the whole
 * translation into the Bible library with progress and cancel.
 */
export default function OnlineBibleSearchModal({ isOpen, onClose, darkMode }) {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [entering, setEntering] = useState(false);

  const [bookCounts, setBookCounts] = useState({});
  const [importingAbbr, setImportingAbbr] = useState(null);
  const [importProgress, setImportProgress] = useState(null);
  const [importError, setImportError] = useState(null);
  const abortRef = useRef(null);

  const { showToast } = useToast();
  const isOnline = useNetworkStatus();
  const bibleMetadata = useBibleStore((s) => s.bibleMetadata);

  useLayoutEffect(() => {
    if (isOpen) {
      setVisible(true);
      setExiting(false);
      setEntering(true);
      const raf = requestAnimationFrame(() => setEntering(false));
      return () => cancelAnimationFrame(raf);
    }
    setEntering(false);
    setExiting(true);
    const timeout = setTimeout(() => {
      setExiting(false);
      setVisible(false);
    }, animationDuration);
    return () => clearTimeout(timeout);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen && !visible) {
      abortRef.current?.abort();
      abortRef.current = null;
      setImportingAbbr(null);
      setImportProgress(null);
      setImportError(null);
    }
  }, [isOpen, visible]);

  // Abort in-flight work the moment the modal starts closing (rather than
  // waiting out the 220ms exit animation).
  useEffect(() => {
    if (!isOpen) abortRef.current?.abort();
  }, [isOpen]);

  // Book/chapter counts per translation (cached by the client).
  // All four translate in parallel; the effect owns an AbortController so
  // closing the modal cancels the requests instead of ignoring the results.
  useEffect(() => {
    if (!isOpen || !isOnline) return undefined;
    const controller = new AbortController();
    (async () => {
      const settled = await Promise.allSettled(
        ONLINE_BIBLE_TRANSLATIONS.map(async (t) => ({
          abbr: t.abbr,
          books: await fetchOnlineBooks(t.abbr, { signal: controller.signal }),
        }))
      );
      if (controller.signal.aborted) return;
      setBookCounts((prev) => {
        const next = { ...prev };
        for (const s of settled) {
          if (s.status !== 'fulfilled' || next[s.value.abbr]) continue;
          next[s.value.abbr] = {
            books: s.value.books.length,
            chapters: s.value.books.reduce((n, b) => n + (b.chapters || 0), 0),
          };
        }
        return next;
      });
      for (const s of settled) {
        if (s.status === 'rejected' && !controller.signal.aborted) {
          logger.warn('Online book list failed', { error: s.reason?.message || String(s.reason) });
        }
      }
    })();
    return () => { controller.abort(); };
  }, [isOpen, isOnline]);

  const handleImport = useCallback(async (abbr) => {
    if (importingAbbr || !isOnline) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setImportingAbbr(abbr);
    setImportProgress({ done: 0, total: 1, book: null, chapter: null });
    setImportError(null);
    const startedAt = Date.now();
    try {
      const bible = await downloadOnlineTranslation(abbr, {
        signal: controller.signal,
        onProgress: (p) => setImportProgress({ ...p }),
      });
      const store = useBibleStore.getState();
      await store.addBible(bible.id, bible);
      if (!store.defaultBibleId) store.setDefaultBible(bible.id);
      await store.setActiveBible(bible.id);
      showToast({
        title: 'Bible imported',
        message: `${bible.name} is now in your library — no browser needed.`,
        variant: 'success',
      });
      logger.info('Online translation imported', {
        id: bible.id,
        books: bible.books.length,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const cancelled = controller.signal.aborted || error?.name === 'AbortError' || /cancel/i.test(error?.message || '');
      if (cancelled) {
        showToast({ title: 'Import cancelled', message: 'The translation download was stopped.', variant: 'warning' });
      } else {
        const message = error?.message || 'Import failed. Check your connection and try again.';
        setImportError(message);
        showToast({ title: 'Import failed', message, variant: 'error' });
        logger.warn('Online import failed', { abbr, error: message });
      }
    } finally {
      abortRef.current = null;
      setImportingAbbr(null);
      setImportProgress(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importingAbbr, isOnline, showToast]);

  const handleCancelImport = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  if (!visible) return null;

  const modalClasses = [
    'rounded-2xl border shadow-2xl ring-1 w-[90vw] max-w-[560px] mx-4 max-h-[88vh]',
    'flex flex-col min-h-0',
    darkMode ? 'bg-gray-900 text-gray-50 border-gray-800 ring-blue-500/35' : 'bg-white text-gray-900 border-gray-200 ring-blue-500/20',
    'transition-all duration-200 ease-out',
    (exiting || entering) ? 'opacity-0 translate-y-8 scale-95' : 'opacity-100 translate-y-0 scale-100',
  ].join(' ');

  const installedIdFor = onlineBibleIdFor;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      data-testid="online-bible-search-modal"
    >
      <div
        className={`absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity duration-200 ${(exiting || entering) ? 'opacity-0' : 'opacity-100'}`}
        onClick={() => onClose?.()}
      />
      <div className={modalClasses}>
        <div className={`flex items-center justify-between border-b px-6 py-4 ${darkMode ? 'border-gray-800' : 'border-gray-200'}`}>
          <div>
            <h2 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>Bible Search &amp; Import</h2>
            <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              Download a translation straight into your library — no browser needed.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border transition-colors ${isOnline
                ? (darkMode ? 'bg-green-500/10 border-green-500/30 text-green-400' : 'bg-green-50 border-green-200 text-green-700')
                : (darkMode ? 'bg-red-500/10 border-red-500/30 text-red-400 animate-pulse' : 'bg-red-50 border-red-200 text-red-700 animate-pulse')
                }`}
              title={isOnline ? 'Connected to the internet' : 'No internet connection'}
            >
              <div className={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-[10px] font-semibold uppercase tracking-wide">
                {isOnline ? 'Online' : 'Offline'}
              </span>
            </div>
            <button
              onClick={() => onClose?.()}
              aria-label="Close Bible search"
              className={`p-1.5 rounded-md transition-colors ${darkMode ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}`}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-6">
          <p className={`text-xs leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            These public-domain translations download straight into your Bible library. Pick one and tap Import.
          </p>
          {importError && (
            <div className={`rounded-lg border px-3 py-2.5 text-sm ${darkMode ? 'border-red-500/40 bg-red-500/10 text-red-200' : 'border-red-200 bg-red-50 text-red-700'}`} role="alert">
              {importError}
            </div>
          )}
          <ul className="space-y-2">
            {ONLINE_BIBLE_TRANSLATIONS.map((t) => {
              const installed = Boolean(bibleMetadata?.[installedIdFor(t.abbr)]);
              const busy = importingAbbr === t.abbr;
              const counts = bookCounts[t.abbr];
              return (
                <li
                  key={t.abbr}
                  className={`rounded-xl border p-3 ${darkMode ? 'border-gray-800 bg-gray-900/60' : 'border-gray-200 bg-white'}`}
                  data-testid={`online-bible-translation-${t.abbr}`}
                >
                  <div className="flex items-center gap-2">
                    <BookOpen className={`h-4 w-4 shrink-0 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`} aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{t.name}</div>
                      <div className={`text-[11px] ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                        {t.abbr} · {t.edition} · {counts ? `${counts.books} books, ${counts.chapters} chapters` : '…'}
                      </div>
                    </div>
                    {installed && !busy && (
                      <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${darkMode ? 'bg-emerald-500/20 text-emerald-200' : 'bg-emerald-100 text-emerald-700'}`}>
                        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                        Installed
                      </span>
                    )}
                    {busy ? (
                      <Button size="sm" variant="outline" onClick={handleCancelImport}>
                        Cancel
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => handleImport(t.abbr)}
                        disabled={!isOnline}
                        title={installed ? `Download ${t.name} again` : `Download ${t.name} into your library`}
                      >
                        <Download className="mr-1.5 h-3.5 w-3.5" />
                        {installed ? 'Re-import' : 'Import'}
                      </Button>
                    )}
                  </div>
                  {busy && importProgress && (
                    <div className="mt-2">
                      <div className={`h-2 overflow-hidden rounded-full ${darkMode ? 'bg-gray-800' : 'bg-gray-100'}`}>
                        <div
                          className="h-full rounded-full bg-blue-600 transition-all"
                          style={{ width: `${importProgress.total > 0 ? Math.round((importProgress.done / importProgress.total) * 100) : 0}%` }}
                        />
                      </div>
                      <div className={`mt-1 text-[11px] ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                        {importProgress.book
                          ? `${importProgress.book} ${importProgress.chapter} · ${importProgress.done} of ${importProgress.total} chapters`
                          : `Starting download…`}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <p className={`flex items-start gap-1.5 text-[11px] leading-relaxed ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            A full translation is about a thousand short downloads and can take a minute or two. You can cancel any time; nothing is saved until it finishes.
          </p>
        </div>
      </div>
    </div>
  );
}
