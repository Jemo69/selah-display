/**
 * Online Bible search + import (no browser needed).
 *
 * Keyless public APIs:
 *  - bolls.life: book/chapter text for public-domain translations
 *    (get-books / get-text). No translation catalog endpoint, so the app
 *    ships a curated list of public-domain English translations below.
 *  - Lookup resolves references locally, then fetches the chapter.
 *
 * bolls.life verse text carries Strong's tags (<S>1234</S>); cleanBollsText
 * strips markup + entities so imported verses match the file-imported shape.
 */
import { buildSearchIndex } from 'shared/bible';
import { CANONICAL_BOOK_NAMES } from 'shared/bible/bookAliases.js';
import { createLogger } from './logger.js';

const log = createLogger('OnlineBible');

const BOLLS_BASE = 'https://bolls.life';
const REQUEST_TIMEOUT_MS = 30000;
// Gentle on the free API: small pool + pacing keeps us under bolls.life's
// rate limit (HTTP 429) even for a ~1,200-chapter full-Bible download.
const DOWNLOAD_CONCURRENCY = 3;
const REQUEST_SPACING_MS = 150;
const MAX_ATTEMPTS = 5;

/** Curated public-domain English translations available on bolls.life. */
export const ONLINE_BIBLE_TRANSLATIONS = [
  { abbr: 'KJV', name: 'King James Version', edition: '1769', language: 'English', note: 'Public domain' },
  { abbr: 'ASV', name: 'American Standard Version', edition: '1901', language: 'English', note: 'Public domain' },
  { abbr: 'WEB', name: 'World English Bible', edition: '2000', language: 'English', note: 'Public domain' },
  { abbr: 'YLT', name: "Young's Literal Translation", edition: '1862', language: 'English', note: 'Public domain' },
];

const translationByAbbr = (abbr) => {
  const found = ONLINE_BIBLE_TRANSLATIONS.find(
    (t) => t.abbr.toLowerCase() === String(abbr || '').toLowerCase()
  );
  if (!found) throw new Error(`Unknown online translation: ${abbr}`);
  return found;
};

async function bollsFetchJson(path, { signal } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Request timed out')), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(`${BOLLS_BASE}${path}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`Bible service responded with ${res.status}`);
    return await res.json();
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted) {
      throw signal?.aborted ? error : new Error('Request timed out — check your connection and retry.');
    }
    throw error instanceof Error ? error : new Error('Network request failed');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/** Strip Strong's numbers + markup + entities from bolls.life verse text. */
export function cleanBollsText(raw) {
  return String(raw ?? '')
    // Strong's numbers and footnote markers carry their digits as tag
    // content (<S>430</S>), so remove the whole element, not just the tags.
    .replace(/<(S|T|f|sup)[^>]*>.*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_m, code) => {
      try {
        return String.fromCharCode(parseInt(code, 10));
      } catch {
        return '';
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code) => {
      try {
        return String.fromCharCode(parseInt(code, 16));
      } catch {
        return '';
      }
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const booksCache = new Map();

/** Book/chapter table for a translation (Protestant 66 only, canonical names). */
export async function fetchOnlineBooks(abbr, { signal } = {}) {
  const key = String(abbr).toUpperCase();
  if (booksCache.has(key)) return booksCache.get(key);
  const raw = await bollsFetchJson(`/get-books/${key}/`, { signal });
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`Translation ${key} returned no books.`);
  }
  const protestant = raw
    .filter((b) => Number(b.bookid) >= 1 && Number(b.bookid) <= 66)
    .sort((a, b) => a.bookid - b.bookid);
  if (protestant.length !== 66) {
    throw new Error(`Translation ${key} didn't return the expected 66 books.`);
  }
  const books = protestant.map((b) => ({
    number: Number(b.bookid),
    name: CANONICAL_BOOK_NAMES[Number(b.bookid) - 1],
    chapters: Number(b.chapters) || 0,
  }));
  booksCache.set(key, books);
  return books;
}

/** Verses of one chapter, cleaned. Throws when the chapter has no verses. */
export async function fetchOnlineChapter(abbr, bookNumber, chapter, { signal } = {}) {
  const key = String(abbr).toUpperCase();
  const raw = await bollsFetchJson(`/get-text/${key}/${bookNumber}/${chapter}/`, { signal });
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${key} has no ${chapterName(bookNumber)} ${chapter} — the chapter may not exist.`);
  }
  return raw
    .map((v) => ({ number: Number(v.verse), text: cleanBollsText(v.text) }))
    .filter((v) => Number.isFinite(v.number) && v.text)
    .sort((a, b) => a.number - b.number);
}

const chapterName = (bookNumber) => CANONICAL_BOOK_NAMES[bookNumber - 1] || `Book ${bookNumber}`;

export const onlineBibleIdFor = (abbr) => `bolls-${String(abbr).toLowerCase()}`;
const buildBollsId = onlineBibleIdFor;

/** Total chapters in a Protestant-66 book table (progress denominator). */
export function countOnlineChapters(books) {
  return (books || []).reduce((sum, b) => sum + (Number(b.chapters) || 0), 0);
}

const sleepCancellable = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason instanceof Error ? signal.reason : new Error('Import cancelled.'));
    return;
  }
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(t);
    reject(signal.reason instanceof Error ? signal.reason : new Error('Import cancelled.'));
  }, { once: true });
});

const isRetryable = (error) => /responded with (429|50\d)|timed out|network|fetch|load/i.test(error?.message || '');

async function fetchWithRetry(abbr, bookNumber, chapter, { signal }) {
  // Pace requests so a full-Bible download stays under the rate limit.
  await sleepCancellable(REQUEST_SPACING_MS, signal);
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchOnlineChapter(abbr, bookNumber, chapter, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      if (!isRetryable(error)) throw error;
      if (attempt === MAX_ATTEMPTS) break;
      // Exponential backoff with jitter: 1s, 2s, 4s, 8s…
      const backoff = Math.min(8000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
      log.warn('Online chapter fetch retrying', { abbr, book: bookNumber, chapter, attempt, backoffMs: backoff });
      await sleepCancellable(backoff, signal);
    }
  }
  if (/responded with 429/.test(lastError?.message || '')) {
    throw new Error('The Bible service is busy right now (rate limited). Please wait a minute and try again.');
  }
  throw lastError;
}

/**
 * Download a whole translation into the app's BibleStore shape
 * ({ id, name, books[], bookMap, searchIndex }).
 * Reports { done, total, book, chapter }; aborts cleanly on signal.
 */
export async function downloadOnlineTranslation(abbr, { onProgress, signal } = {}) {
  const info = translationByAbbr(abbr);
  const booksMeta = await fetchOnlineBooks(info.abbr, { signal });
  const total = countOnlineChapters(booksMeta);
  let done = 0;
  const report = (book, chapter) => {
    try {
      onProgress?.({ done, total, book, chapter });
    } catch { /* progress must never break the download */ }
  };

  const tasks = [];
  for (const book of booksMeta) {
    for (let chapter = 1; chapter <= book.chapters; chapter++) {
      tasks.push({ book: book.number, bookName: book.name, chapter });
    }
  }

  const chaptersByBook = new Map();
  const failAfterAbort = () => {
    if (signal?.aborted) {
      const reason = signal.reason instanceof Error ? signal.reason : new Error('Import cancelled.');
      throw reason;
    }
  };

  // Pre-sliced per-worker queues (no shared mutable cursor to reason about).
  const workerCount = Math.min(DOWNLOAD_CONCURRENCY, tasks.length);
  const slices = Array.from({ length: workerCount }, () => []);
  tasks.forEach((task, i) => { slices[i % workerCount].push(task); });
  const workers = slices.map(
    (slice) => (async () => {
      for (const task of slice) {
        failAfterAbort();
        const verses = await fetchWithRetry(info.abbr, task.book, task.chapter, { signal });
        failAfterAbort();
        if (!chaptersByBook.has(task.book)) chaptersByBook.set(task.book, []);
        chaptersByBook.get(task.book).push({ number: task.chapter, verses });
        done += 1;
        report(task.bookName, task.chapter);
      }
    })()
  );
  await Promise.all(workers);

  const books = booksMeta.map((meta) => {
    const chapters = (chaptersByBook.get(meta.number) || []).sort((a, b) => a.number - b.number);
    if (chapters.length !== meta.chapters) {
      throw new Error(`Downloaded ${chapters.length} of ${meta.chapters} chapters for ${meta.name} — retry the import.`);
    }
    return { number: meta.number, name: meta.name, chapters };
  });

  const bible = {
    id: buildBollsId(info.abbr),
    name: info.name,
    source: 'bolls.life',
    translation: info.abbr,
    books,
  };
  bible.bookMap = {};
  for (const book of bible.books) {
    bible.bookMap[book.number] = book;
    book.chapterMap = {};
    for (const chapter of book.chapters) {
      book.chapterMap[chapter.number] = chapter;
      chapter.verseMap = {};
      for (const verse of chapter.verses) {
        chapter.verseMap[verse.number] = verse;
      }
    }
  }
  try {
    bible.searchIndex = buildSearchIndex(bible);
  } catch (error) {
    log.warn('Search index build failed for online import; continuing without it', { error: error?.message });
  }
  report(null, null);
  return bible;
}

/** Clear cached metadata (tests + rescan flows). */
export function clearOnlineCache() {
  booksCache.clear();
}
