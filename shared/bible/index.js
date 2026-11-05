import { detectBibleFormat } from './xmlUtils.js';
import { normalizeSentenceText, sentenceContentTokens, scoreSentenceVerse, matchLeadingBook } from './sentenceSearch.js';
import { parseZefaniaBible } from './zefaniaBible.js';
import { parseOsisBible } from './osisBible.js';
import { parseBebliaBible } from './bebliaBible.js';
import { parseOpenSongBible } from './openSongBible.js';
import createSharedLogger from '../logger.js';

const log = createSharedLogger('Bible');

const bibleParsers = {
  zefania: { name: 'Zefania', parse: parseZefaniaBible },
  osis: { name: 'OSIS', parse: parseOsisBible },
  beblia: { name: 'Beblia', parse: parseBebliaBible },
  opensong: { name: 'OpenSong', parse: parseOpenSongBible }
};

export function parseBible(content, fileName = 'bible') {
  log.info(`parseBible: parsing file "${fileName}", content length=${content.length}`);
  const format = detectBibleFormat(content);
  log.debug(`parseBible: detected format="${format}"`);

  if (format === 'unknown') {
    log.warn('Unknown Bible format, attempting Zefania as fallback');
    const result = parseZefaniaBible(content);
    if (result.books.length > 0) {
      return { id: `bible_${Date.now()}`, ...result };
    }
    log.warn(`parseBible: fallback parse returned 0 books for "${fileName}"`);
    return { name: fileName, books: [] };
  }

  const parser = bibleParsers[format];
  if (!parser) {
    log.error(`No parser found for format: ${format}`);
    return { name: fileName, books: [] };
  }

  const result = parser.parse(content);
  log.info(`parseBible: successfully parsed "${fileName}" as ${parser.name}, ${result.books.length} books`);

  // Add O(1) lookup maps
  result.bookMap = {};
  for (const book of result.books) {
    result.bookMap[book.number] = book;
    book.chapterMap = {};
    for (const chapter of book.chapters) {
      book.chapterMap[chapter.number] = chapter;
      chapter.verseMap = {};
      for (const verse of chapter.verses) {
        chapter.verseMap[verse.number] = verse;
      }
    }
  }

  // Build search index
  result.searchIndex = buildSearchIndex(result);

  return { id: `bible_${Date.now()}`, ...result };
}

export function parseBibleFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const content = e.target.result;
        const fileName = file.name.replace(/\.[^.]+$/i, '');
        const bible = parseBible(content, fileName);
        resolve(bible);
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

export { detectBibleFormat };

export function orderBibleMetadata(bibleMetadata, defaultBibleId = null) {
  const items = Object.values(bibleMetadata || {});
  if (!defaultBibleId) return items;

  return items.sort((a, b) => {
    if (a.id === defaultBibleId && b.id !== defaultBibleId) return -1;
    if (b.id === defaultBibleId && a.id !== defaultBibleId) return 1;
    return 0;
  });
}

export const BIBLE_SEARCH_INDEX_VERSION = 2;

/**
 * Single normalization for index + query (Group: God fast+accurate).
 * lower → NFD strip diacritics → possessive 's drop → a-z0-9 only.
 * "God's" → "god", "GOD," → "god", "gods" stays "gods".
 * Old indexes (pre-v2) stored "gods" for "God's"; tiered lookup
 * checks both exact + plural so old + new indexes both hit.
 */
export function normalizeSearchToken(raw) {
  const lower = String(raw || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const depossessed = lower.replace(/'s\b/g, '');
  return depossessed.replace(/[^a-z0-9]/g, '');
}

export function buildSearchIndex(bible) {
  log.info(`buildSearchIndex: indexing ${bible.books?.length || 0} books`);
  const index = {};

  for (const book of bible.books) {
    for (const chapter of book.chapters) {
      for (const verse of chapter.verses) {
        const words = (verse.text || '').toLowerCase().split(/\s+/);

        const seenInVerse = new Set();
        for (const word of words) {
          const normalized = normalizeSearchToken(word);
          if (!normalized || normalized.length < 3 || seenInVerse.has(normalized)) continue;

          const result = {
            b: book.number,
            c: chapter.number,
            v: verse.number
          };

          if (!index[normalized]) {
            index[normalized] = [];
          }
          index[normalized].push(result);
          seenInVerse.add(normalized);
        }
      }
    }
  }

  return index;
}

// --- Word-pair index (lyric hill-climb port) ---
// Adjacent-token postings power the quote phrase-first path: a 4-word quote
// meets 3 pair lists (each near the true holder count) instead of 4 unigram
// lists (stopwords: thousands of verses). Same tokenization as
// buildSearchIndex (normalizeSearchToken, min length 3, order preserved,
// stopwords kept so query pairs align with verse pairs).
// Lazy + WeakMap-cached: never persisted (no IndexedDB bloat, no migration),
// built per bible object on first quote query. Old persisted bibles without
// any pair data simply build it on demand.
const biblePairIndexCache = new WeakMap();

export function bibleRawTokens(text) {
  const out = [];
  for (const word of String(text || '').toLowerCase().split(/\s+/)) {
    const token = normalizeSearchToken(word);
    if (token && token.length >= 3) out.push(token);
  }
  return out;
}

function buildBiblePairIndex(bible) {
  const pairs = new Map(); // "tok1 tok2" -> Set<packed b*1e6+c*1e3+v>
  for (const book of bible.books || []) {
    for (const chapter of book.chapters || []) {
      for (const verse of chapter.verses || []) {
        const toks = bibleRawTokens(verse.text);
        const seen = new Set();
        for (let i = 0; i + 1 < toks.length; i++) {
          const key = `${toks[i]} ${toks[i + 1]}`;
          if (seen.has(key)) continue;
          seen.add(key);
          let set = pairs.get(key);
          if (!set) {
            set = new Set();
            pairs.set(key, set);
          }
          set.add(book.number * 1000000 + chapter.number * 1000 + verse.number);
        }
      }
    }
  }
  return pairs;
}

export function getBiblePairIndex(bible) {
  if (!bible) return null;
  let pairs = biblePairIndexCache.get(bible);
  if (!pairs) {
    pairs = buildBiblePairIndex(bible);
    biblePairIndexCache.set(bible, pairs);
  }
  return pairs;
}

// Fuzzy pair lookup: exact + morphological-variant + 1-edit-neighbor pairs
// per position, intersected rarest-first. Preserves the ambiguity policy
// (literal tops, fuzzy stays visible) that exact-only pair pruning would
// break: love/loved inflections resolve via variants, word/world typos via
// 1-edit pairs. Returns null on <2 tokens, oversize positions, or an
// oversize intersect (the caller falls back to the union path), an empty
// array when a position kills the phrase (also fall back), else packed keys.
const BIBLE_PAIR_FAST_MAX = 1000;
const BIBLE_PAIR_POS_MAX = 3000;

function bibleEditNeighbors(term) {
  const out = [];
  if (!term || term.length < 4) return out;
  for (let i = 0; i < term.length; i++) out.push(term.slice(0, i) + term.slice(i + 1));
  for (let i = 0; i < term.length; i++) {
    for (let c = 97; c <= 122; c++) {
      const ch = String.fromCharCode(c);
      if (ch === term[i]) continue;
      out.push(term.slice(0, i) + ch + term.slice(i + 1));
    }
  }
  for (let i = 0; i <= term.length; i++) {
    for (let c = 97; c <= 122; c++) {
      out.push(term.slice(0, i) + String.fromCharCode(c) + term.slice(i));
    }
  }
  return out;
}

export function findBibleFuzzyPairKeys(bible, queryText) {
  const toks = bibleRawTokens(queryText);
  if (toks.length < 2) return null;
  const pairs = getBiblePairIndex(bible);
  if (!pairs) return null;
  const positionSets = [];
  for (let i = 0; i + 1 < toks.length; i++) {
    const a = toks[i];
    const b = toks[i + 1];
    const union = new Set();
    const seen = new Set();
    const addPair = (key) => {
      if (seen.has(key)) return true;
      seen.add(key);
      const postings = pairs.get(key);
      if (!postings) return true;
      for (const packed of postings) {
        if (union.size >= BIBLE_PAIR_POS_MAX) return false;
        union.add(packed);
      }
      return true;
    };
    const variantsA = [a, ...experimentalTermVariants(a)];
    const variantsB = [b, ...experimentalTermVariants(b)];
    let ok = true;
    for (const va of variantsA) {
      for (const vb of variantsB) {
        if (!addPair(`${va} ${vb}`)) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (ok) {
      for (const na of bibleEditNeighbors(a)) {
        if (!addPair(`${na} ${b}`)) { ok = false; break; }
      }
    }
    if (ok) {
      for (const nb of bibleEditNeighbors(b)) {
        if (!addPair(`${a} ${nb}`)) { ok = false; break; }
      }
    }
    if (!ok) return null; // position too common — fall back to union path
    if (union.size === 0) return []; // position kills the phrase — fall back
    positionSets.push(union);
  }
  positionSets.sort((x, y) => x.size - y.size);
  let candidate = positionSets[0];
  for (let i = 1; i < positionSets.length; i++) {
    const s = positionSets[i];
    if (s.size < candidate.size) {
      const next = new Set();
      for (const k of s) {
        if (candidate.has(k)) next.add(k);
      }
      candidate = next;
    } else {
      for (const k of candidate) {
        if (!s.has(k)) candidate.delete(k);
      }
    }
    if (candidate.size === 0) return [];
  }
  if (candidate.size > BIBLE_PAIR_FAST_MAX) return null;
  return [...candidate];
}

// Sorted vocabulary keys, cached per index object: the default path's
// prefix lookup binary-searches this instead of scanning Object.keys per
// term per keystroke (same recall, no per-query vocabulary scan).
const bibleSortedKeysCache = new WeakMap();

function bibleSortedIndexKeys(index) {
  let keys = bibleSortedKeysCache.get(index);
  if (!keys) {
    keys = Object.keys(index).sort();
    bibleSortedKeysCache.set(index, keys);
  }
  return keys;
}

export function getBibleVerseText(bible, reference, selectedVerses) {
  if (!bible || !reference) return '';

  const bookObj = (bible.bookMap && bible.bookMap[reference.book]) || bible.books?.find(b => b.number === reference.book);
  if (!bookObj) return '';

  const chapterNum = parseInt(reference.chapters?.[0], 10);
  if (Number.isNaN(chapterNum)) return '';

  const chapter = (bookObj.chapterMap && bookObj.chapterMap[chapterNum]) || bookObj.chapters?.find(c => c.number === chapterNum);
  if (!chapter) return '';

  const verses = selectedVerses?.[0] || [];
  const texts = verses.map(v => {
    const verse = (chapter.verseMap && chapter.verseMap[v]) || chapter.verses?.find(vx => vx.number === v);
    return verse?.text || '';
  }).filter(Boolean);

  return texts.join(' ');
}

export const REFERENCE_REGEX = /^(.+?)\s+(\d+)(?:[:.,]\s*(\d+)|\s+(\d+))?(?:-(\d+))?/i;

// --- Cross-chapter + multi-part reference support (MF-14, additive) ---
// CROSS_CHAPTER_REGEX matches "Book 1:26-2:3" / "Rom 8:38-9:2" (any dash
// variant, spaces tolerated). CHAPTER_SPAN_REGEX matches whole-chapter spans
// like "Gen 1-2" / "Ps 23-24". Both are fully anchored so plain fuzzy queries
// and legacy prefix matches (e.g. "John 3:16 notes") never take this path.
const CROSS_CHAPTER_DASH = '[-\\u2012\\u2013\\u2014\\u2212]';
export const CROSS_CHAPTER_REGEX = new RegExp(
  `^(.+?)\\s+(\\d+)\\s*[:.,]\\s*(\\d+)\\s*${CROSS_CHAPTER_DASH}\\s*(\\d+)\\s*[:.,]\\s*(\\d+)\\s*$`,
  'i'
);
export const CHAPTER_SPAN_REGEX = new RegExp(
  `^(.+?)\\s+(\\d+)\\s*${CROSS_CHAPTER_DASH}\\s*(\\d+)\\s*$`,
  'i'
);

// A continuation part with no book/chapter of its own, e.g. "17" in
// "John 3:16; 17" (inherits the previous book + chapter).
const BARE_VERSE_PART_REGEX = /^\d+\s*(?:-\s*\d+)?$/;

export function normalizeReferenceDashes(value) {
  return String(value || '').replace(/[\u2012\u2013\u2014\u2212]/g, '-');
}

export function splitMultiPartReferences(query) {
  return String(query || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Expand a cross-chapter (or whole-chapter-span) segment into per-chapter
 * verse groups. Pure function: no Node/browser APIs, safe in Node, workers,
 * and browsers.
 *
 * @param {object} bible - parsed bible (books array)
 * @param {object} bookMatch - book object the segment resolved to
 * @param {{chapter:number, verse:number|null}} start - span start
 * @param {{chapter:number, verse:number|null}} end - span end
 * @returns {Array<{book,bookName,chapter,verses:number[],text,reference}>}
 *   one entry per chapter that actually contains verses in the span.
 */
export function expandCrossChapterSegment(bible, bookMatch, start, end) {
  const groups = [];
  if (!bible || !bookMatch) return groups;

  const startChapter = parseInt(start?.chapter, 10);
  const endChapter = parseInt(end?.chapter, 10);
  if (!Number.isInteger(startChapter) || !Number.isInteger(endChapter)) return groups;
  if (startChapter < 1 || endChapter < startChapter) return groups;

  const startVerse = start?.verse == null ? null : parseInt(start.verse, 10);
  const endVerse = end?.verse == null ? null : parseInt(end.verse, 10);
  if (startVerse != null && (!Number.isInteger(startVerse) || startVerse < 1)) return groups;
  if (endVerse != null && (!Number.isInteger(endVerse) || endVerse < 1)) return groups;
  if (startChapter === endChapter && startVerse != null && endVerse != null && endVerse < startVerse) {
    return groups;
  }

  const findChapterInBook = (number) => {
    if (bookMatch.chapterMap) return bookMatch.chapterMap[number] || null;
    return bookMatch.chapters?.find((chapter) => chapter.number === number) || null;
  };

  for (let number = startChapter; number <= endChapter; number++) {
    const chapter = findChapterInBook(number);
    if (!chapter || !Array.isArray(chapter.verses)) continue;
    const sorted = [...chapter.verses]
      .filter((verse) => verse && Number.isInteger(verse.number))
      .sort((a, b) => a.number - b.number);
    if (sorted.length === 0) continue;

    let wanted = sorted;
    if (number === startChapter && startVerse != null) {
      wanted = wanted.filter((verse) => verse.number >= startVerse);
    }
    if (number === endChapter && endVerse != null) {
      wanted = wanted.filter((verse) => verse.number <= endVerse);
    }
    if (wanted.length === 0) continue;

    const first = wanted[0].number;
    const last = wanted[wanted.length - 1].number;
    const isFullChapter = first === sorted[0].number && last === sorted[sorted.length - 1].number;
    const reference = isFullChapter
      ? `${bookMatch.name} ${number}`
      : (last > first
        ? `${bookMatch.name} ${number}:${first}-${last}`
        : `${bookMatch.name} ${number}:${first}`);

    groups.push({
      book: bookMatch.number,
      bookName: bookMatch.name,
      chapter: number,
      verses: wanted.map((verse) => verse.number),
      text: wanted.map((verse) => verse.text || '').join(' ').trim(),
      reference
    });
  }

  return groups;
}

function matchCrossChapterSegment(segment) {
  const normalized = normalizeReferenceDashes(segment).trim();
  const cross = normalized.match(CROSS_CHAPTER_REGEX);
  if (cross) {
    return {
      bookPart: (cross[1] || '').trim(),
      startChapter: parseInt(cross[2], 10),
      startVerse: parseInt(cross[3], 10),
      endChapter: parseInt(cross[4], 10),
      endVerse: parseInt(cross[5], 10),
      isChapterSpan: false
    };
  }
  const span = normalized.match(CHAPTER_SPAN_REGEX);
  if (span) {
    return {
      bookPart: (span[1] || '').trim(),
      startChapter: parseInt(span[2], 10),
      startVerse: null,
      endChapter: parseInt(span[3], 10),
      endVerse: null,
      isChapterSpan: true
    };
  }
  return null;
}

function matchSingleSegment(segment) {
  const normalized = normalizeReferenceDashes(segment).trim();
  const match = normalized.match(REFERENCE_REGEX);
  if (!match) return null;
  const [, bookPart, chapterPart, versePart1, versePart2, rangeEndPart] = match;
  return {
    bookPart: (bookPart || '').trim(),
    chapterPart,
    versePart: versePart1 || versePart2 || null,
    rangeEndPart: rangeEndPart || null
  };
}

// Legacy-equivalent single-segment resolver (same result shapes as the
// searchBible reference path). Returns { context, results } or null.
function resolveSingleSegmentForBible(bible, segment, chapterOnlyAllowed, maxResults) {
  const parsed = matchSingleSegment(segment);
  if (!parsed || !parsed.bookPart) return null;

  const bookMatch = findBookInArray(bible.books, parsed.bookPart);
  if (!bookMatch) return null;

  const chapter = findChapter(bookMatch, parsed.chapterPart);
  if (!chapter) return null;

  if (parsed.versePart) {
    const startVerse = parseInt(parsed.versePart, 10);
    const endVerse = parseInt(parsed.rangeEndPart || parsed.versePart, 10);
    const versesInRange = (chapter.verses || []).filter(
      (verse) => verse.number >= startVerse && verse.number <= endVerse
    );
    if (versesInRange.length === 0) return null;

    const normalizedEnd = Number.isNaN(endVerse) ? startVerse : endVerse;
    return {
      context: { bookName: bookMatch.name, chapter: chapter.number },
      results: [{
        book: bookMatch.number,
        bookName: bookMatch.name,
        chapter: chapter.number,
        verse: startVerse,
        endVerse: normalizedEnd,
        verses: versesInRange.map((verse) => verse.number),
        text: versesInRange.map((verse) => verse.text || '').join(' ').trim(),
        reference: normalizedEnd > startVerse
          ? `${bookMatch.name} ${chapter.number}:${startVerse}-${normalizedEnd}`
          : `${bookMatch.name} ${chapter.number}:${startVerse}`,
        bibleId: bible.id,
        bibleName: bible.name
      }]
    };
  }

  if (!chapterOnlyAllowed || !chapter.verses?.length) return null;
  return {
    context: { bookName: bookMatch.name, chapter: chapter.number },
    results: chapter.verses.slice(0, maxResults).map((verse) => ({
      book: bookMatch.number,
      bookName: bookMatch.name,
      chapter: chapter.number,
      verse: verse.number,
      text: verse.text || '',
      reference: `${bookMatch.name} ${chapter.number}:${verse.number}`,
      bibleId: bible.id,
      bibleName: bible.name
    }))
  };
}

function resolveCrossSegmentForBible(bible, parsed) {
  if (!parsed.bookPart) return null;
  const bookMatch = findBookInArray(bible.books, parsed.bookPart);
  if (!bookMatch) return null;

  const groups = expandCrossChapterSegment(
    bible,
    bookMatch,
    { chapter: parsed.startChapter, verse: parsed.startVerse },
    { chapter: parsed.endChapter, verse: parsed.endVerse }
  );
  if (groups.length === 0) return null;

  const groupReference = parsed.isChapterSpan
    ? `${bookMatch.name} ${parsed.startChapter}-${parsed.endChapter}`
    : `${bookMatch.name} ${parsed.startChapter}:${parsed.startVerse}-${parsed.endChapter}:${parsed.endVerse}`;

  const results = groups.map((group, index) => ({
    book: group.book,
    bookName: group.bookName,
    chapter: group.chapter,
    verse: group.verses[0],
    endVerse: group.verses[group.verses.length - 1],
    verses: group.verses,
    text: group.text,
    reference: group.reference,
    bibleId: bible.id,
    bibleName: bible.name,
    isCrossChapter: true,
    groupReference,
    groupIndex: index,
    groupSize: groups.length
  }));

  return {
    context: { bookName: bookMatch.name, chapter: groups[groups.length - 1].chapter },
    results
  };
}

// Resolve one ';'-separated part, carrying the previous book/chapter forward
// for continuation parts like "4:5" or "17" in "John 3:16; 17".
function resolveSegmentWithCarryover(bible, segment, carry, chapterOnlyAllowed, maxResults) {
  const trimmed = normalizeReferenceDashes(segment).trim();
  if (!trimmed) return null;

  const cross = matchCrossChapterSegment(trimmed);
  if (cross?.bookPart) {
    const resolved = resolveCrossSegmentForBible(bible, cross);
    if (resolved) return resolved;
  }

  const single = resolveSingleSegmentForBible(bible, trimmed, chapterOnlyAllowed, maxResults);
  if (single) return single;

  if (carry?.bookName) {
    const withBook = `${carry.bookName} ${trimmed}`;
    const crossCarry = matchCrossChapterSegment(withBook);
    if (crossCarry) {
      const resolved = resolveCrossSegmentForBible(bible, crossCarry);
      if (resolved) return resolved;
    }
    if (carry.chapter != null && BARE_VERSE_PART_REGEX.test(trimmed)) {
      const asVerse = resolveSingleSegmentForBible(
        bible,
        `${carry.bookName} ${carry.chapter}:${trimmed}`,
        chapterOnlyAllowed,
        maxResults
      );
      if (asVerse) return asVerse;
    }
    const asReference = resolveSingleSegmentForBible(bible, withBook, chapterOnlyAllowed, maxResults);
    if (asReference) return asReference;
  }

  return null;
}

// Attempt cross-chapter / multi-part resolution. Returns an array of grouped
// results, or null when the query is not such a reference (caller falls back
// to the legacy single-reference + fuzzy paths unchanged).
function searchGroupedReferences(biblesToSearch, rawQuery, maxResults, currentBibleId) {
  const normalized = normalizeReferenceDashes(rawQuery);
  const isMulti = normalized.includes(';');
  if (!isMulti && !matchCrossChapterSegment(normalized)) return null;

  const parts = isMulti ? splitMultiPartReferences(normalized) : [normalized.trim()];
  if (parts.length === 0) return null;

  const results = [];
  for (const bible of biblesToSearch) {
    const chapterOnlyAllowed = bible.id === currentBibleId || (!currentBibleId && biblesToSearch.length === 1);
    let carry = null;
    parts.forEach((part, partIndex) => {
      const resolved = resolveSegmentWithCarryover(bible, part, carry, chapterOnlyAllowed, maxResults);
      if (!resolved) return;
      carry = resolved.context;
      for (const item of resolved.results) {
        results.push(isMulti
          ? { ...item, partIndex, partTotal: parts.length, partReference: part }
          : item);
      }
    });
  }

  return results.length > 0 ? results.slice(0, maxResults) : null;
}
const bookIndexCache = new WeakMap();

function normalizeBookName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s/g, '')
    .replace(/\./g, '');
}

function getBookIndex(books) {
  if (!books) return null;
  let entries = bookIndexCache.get(books);
  if (entries) return entries;

  entries = books.map((book) => {
    const name = normalizeBookName(book.name);
    const abbr = book.abbreviation ? normalizeBookName(book.abbreviation) : '';
    return { book, name, abbr };
  });
  bookIndexCache.set(books, entries);
  return entries;
}

function findBookInArray(books, value) {
  if (!books || books.length === 0) return null;
  const normalized = normalizeBookName(value);
  if (!normalized) return null;

  const index = getBookIndex(books);

  for (let i = 0; i < index.length; i++) {
    const entry = index[i];
    if (entry.name === normalized || entry.abbr === normalized) return entry.book;
  }

  for (let i = 0; i < index.length; i++) {
    const entry = index[i];
    if (entry.name.startsWith(normalized) || entry.abbr.startsWith(normalized)) return entry.book;
  }

  for (let i = 0; i < index.length; i++) {
    const entry = index[i];
    if (entry.name.includes(normalized) || entry.abbr.includes(normalized)) return entry.book;
  }

  return null;
}

function findChapter(book, value) {
  const chapterNumber = parseInt(value, 10);
  if (Number.isNaN(chapterNumber) || chapterNumber < 1) return null;
  if (book.chapterMap) return book.chapterMap[chapterNumber] || null;
  return book.chapters?.find((chapter) => chapter.number === chapterNumber) || null;
}

function findVerse(chapter, value) {
  const verseNumber = parseInt(value, 10);
  if (Number.isNaN(verseNumber) || verseNumber < 1) return null;
  if (chapter.verseMap) return chapter.verseMap[verseNumber] || null;
  return chapter.verses?.find((verse) => verse.number === verseNumber) || null;
}

function parseCombinedQuery(query, books) {
  const trimmed = query.trim();
  const words = trimmed.split(/\s+/);

  if (words.length < 2) {
    return { textTerm: trimmed, book: null };
  }

  for (let i = 0; i < words.length; i++) {
    const singleWord = words[i];
    const book = findBookInArray(books, singleWord);
    if (book) {
      const textTerm = words.filter((_, idx) => idx !== i).join(' ').trim();
      if (textTerm.length >= 2) return { textTerm, book };
    }

    if (i < words.length - 1) {
      const twoWords = `${words[i]} ${words[i + 1]}`;
      const book2 = findBookInArray(books, twoWords);
      if (book2) {
        const textTerm = words.filter((_, idx) => idx !== i && idx !== i + 1).join(' ').trim();
        if (textTerm.length >= 2) return { textTerm, book: book2 };
      }
    }

    if (i < words.length - 2) {
      const threeWords = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      const book3 = findBookInArray(books, threeWords);
      if (book3) {
        const textTerm = words.filter((_, idx) => idx !== i && idx !== i + 1 && idx !== i + 2).join(' ').trim();
        if (textTerm.length >= 2) return { textTerm, book: book3 };
      }
    }
  }

  return { textTerm: trimmed, book: null };
}

function searchInBible(books, searchTerm, filterBook = null) {
  const results = [];
  const searchLower = searchTerm.toLowerCase();
  const booksToSearch = filterBook ? [filterBook] : books;

  booksToSearch.forEach((book) => {
    book.chapters?.forEach((chapter) => {
      chapter.verses?.forEach((verse) => {
        const verseContent = String(verse.text || '');
        if (verseContent.toLowerCase().includes(searchLower)) {
          results.push({
            book: book.number,
            bookName: book.name,
            chapter: chapter.number,
            verse: verse.number,
            text: verseContent,
            reference: `${book.name} ${chapter.number}:${verse.number}`,
            bibleId: book.bibleId,
            bibleName: book.bibleName
          });
        }
      });
    });
  });

  return results.slice(0, 50);
}

export function searchBible(currentBible, query, allBibles = {}, maxResults = 50, defaultBibleId = null, searchAll = false) {
  if (!currentBible || !currentBible.books) return [];

  const rawQuery = query.trim();
  if (!rawQuery) return [];
  log.debug(`searchBible: query="${rawQuery}", maxResults=${maxResults}`);
  const lowerQuery = rawQuery.toLowerCase();
  const biblesToSearch = (searchAll && Object.keys(allBibles).length > 0)
    ? Object.values(allBibles).sort((a, b) => {
      if (a.id === defaultBibleId && b.id !== defaultBibleId) return -1;
      if (b.id === defaultBibleId && a.id !== defaultBibleId) return 1;
      if (a.id === currentBible.id && b.id !== currentBible.id) return -1;
      if (b.id === currentBible.id && a.id !== currentBible.id) return 1;
      return 0;
    })
    : [currentBible];

  // MF-14 (additive): cross-chapter spans ("Gen 1:26-2:3") and
  // semicolon-separated multi-part references ("Ps 23:1-3; John 3:16")
  // resolve to grouped slide sets. Returns null for anything else, leaving
  // the legacy single-reference and fuzzy paths below untouched.
  const groupedReferences = searchGroupedReferences(biblesToSearch, rawQuery, maxResults, currentBible?.id);
  if (groupedReferences) {
    return groupedReferences;
  }

  const referenceMatch = rawQuery.match(REFERENCE_REGEX);
  if (referenceMatch) {
    const results = [];
    const [, bookPart, chapterPart, versePart1, versePart2, rangeEndPart] = referenceMatch;
    const versePart = versePart1 || versePart2;

    for (const bible of biblesToSearch) {
      const bookMatch = findBookInArray(bible.books, bookPart);
      if (!bookMatch) continue;

      const chapter = findChapter(bookMatch, chapterPart);
      if (!chapter) continue;

      if (versePart) {
        const startVerse = parseInt(versePart, 10);
        const endVerse = parseInt(rangeEndPart || versePart, 10);
        const versesInRange = (chapter.verses || []).filter((verse) => verse.number >= startVerse && verse.number <= endVerse);

        if (versesInRange.length > 0) {
          const normalizedEnd = Number.isNaN(endVerse) ? startVerse : endVerse;
          results.push({
            book: bookMatch.number,
            bookName: bookMatch.name,
            chapter: chapter.number,
            verse: startVerse,
            endVerse: normalizedEnd,
            verses: versesInRange.map((verse) => verse.number),
            text: versesInRange.map((verse) => verse.text || '').join(' ').trim(),
            reference: normalizedEnd > startVerse
              ? `${bookMatch.name} ${chapter.number}:${startVerse}-${normalizedEnd}`
              : `${bookMatch.name} ${chapter.number}:${startVerse}`,
            bibleId: bible.id,
            bibleName: bible.name
          });
        }
      } else if (chapter.verses?.length > 0) {
        if (bible.id === currentBible.id || (!currentBible.id && biblesToSearch.length === 1)) {
          return chapter.verses.slice(0, maxResults).map((verse) => ({
            book: bookMatch.number,
            bookName: bookMatch.name,
            chapter: chapter.number,
            verse: verse.number,
            text: verse.text || '',
            reference: `${bookMatch.name} ${chapter.number}:${verse.number}`,
            bibleId: bible.id,
            bibleName: bible.name
          }));
        }
      }
    }

    if (results.length > 0) {
      return results.slice(0, maxResults);
    }
  }

  const combinedQuery = parseCombinedQuery(rawQuery, currentBible.books);
  const searchTerm = combinedQuery.book ? combinedQuery.textTerm : rawQuery;
  if (searchTerm.length < 2) return [];

  // Normalize query for reference detection
  // 1st -> 1, 2nd -> 2, i -> 1, ii -> 2, etc.
  const normalizeReference = (str) => {
    return String(str || '')
      .replace(/\bfirst\b/g, '1')
      .replace(/\bsecond\b/g, '2')
      .replace(/\bthird\b/g, '3')
      .replace(/\b1st\b/g, '1')
      .replace(/\b2nd\b/g, '2')
      .replace(/\b3rd\b/g, '3')
      .replace(/\bi\b/g, '1')
      .replace(/\bii\b/g, '2')
      .replace(/\biii\b/g, '3')
      .replace(/verse\s+/g, '')
      .replace(/\bv\.\s*/g, '')
      .replace(/[^a-z0-9\s:-]/g, ' ') // Keep hyphen for ranges
      .replace(/\s+/g, ' ')
      .trim();
  };

  const normalizedQuery = normalizeReference(searchTerm.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  const queryTerms = normalizedQuery.split(/\s+/).map(normalizeSearchToken).filter((w) => w.length > 2);
  if (queryTerms.length === 0) return [];
  // Phrase probe for the lyric-style phrase-first bonus below: a verse that
  // contains the whole query phrase outranks verses that merely hold the
  // same words scattered (the "for God so love the world" case).
  const searchTermLower = searchTerm.toLowerCase();

  // Group: God fast+accurate — indexed lookup helpers (no per-verse
  // toLowerCase over the full corpus; only scored hits touch verse text).
  const lookupVerseRecord = (bible, b, c, v) => {
    const book = bible.bookMap?.[b] || bible.books.find((bk) => bk.number === b);
    if (!book) return null;
    const chapter = book.chapterMap?.[c] || book.chapters.find((ch) => ch.number === c);
    if (!chapter) return null;
    const verse = chapter.verseMap?.[v] || chapter.verses.find((vx) => vx.number === v);
    if (!verse) return null;
    return { book, chapter, verse };
  };

  const relevanceBonus = (verseText, term) => {
    const text = String(verseText || '');
    const lenPenalty = Math.log(1 + text.length) * 20;
    const pos = text.toLowerCase().indexOf(term);
    const posBonus = pos === -1 ? 0 : pos < 20 ? 80 : pos < 60 ? 40 : 0;
    return posBonus - lenPenalty;
  };

  // Tiered postings for one term: exact (god) → plural/singular (gods/god)
  // → prefix (godly, godliness). Covers old indexes (God's→gods) and new
  // indexes (God's→god) without a migration.
  const tieredPostings = (index, term, cap = 2000) => {
    const exact = index[term] || [];
    let variant = [];
    if (term.endsWith('s') && term.length > 4) {
      variant = index[term.slice(0, -1)] || [];
    } else {
      variant = index[`${term}s`] || [];
    }
    const seen = new Set(exact.map((r) => `${r.b}-${r.c}-${r.v}`));
    const tiered = [
      ...exact.map((r) => ({ rec: r, tier: 500 })),
      ...variant.filter((r) => {
        const k = `${r.b}-${r.c}-${r.v}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).map((r) => ({ rec: r, tier: 200 })),
    ];
    if (tiered.length < cap) {
      // Prefix range via binary search over cached sorted keys: same recall
      // as the old Object.keys scan, but O(log vocab + matches) instead of
      // O(vocab) per term per keystroke.
      const keys = bibleSortedIndexKeys(index);
      let lo = 0;
      let hi = keys.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (keys[mid] < term) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < keys.length && tiered.length < cap; i++) {
        const key = keys[i];
        if (!key.startsWith(term)) break;
        if (key.length <= term.length) continue;
        if (key === term || key === `${term}s` || key === term.slice(0, -1)) continue;
        for (const r of index[key]) {
          const k = `${r.b}-${r.c}-${r.v}`;
          if (seen.has(k)) continue;
          seen.add(k);
          tiered.push({ rec: r, tier: 50 });
          if (tiered.length >= cap) break;
        }
      }
    }
    return tiered;
  };

  const bookFilterNumber = combinedQuery.book
    ? findBookInArray(currentBible.books, combinedQuery.book.name)?.number ?? null
    : null;

  let results = [];


  for (const bible of biblesToSearch) {
    const isCurrent = bible.id === currentBible.id;
    const isDefault = bible.id === defaultBibleId;
    const priorityBoost = (isDefault ? 100 : 0) + (isCurrent ? 50 : 0);
    const perBibleFilter = combinedQuery.book
      ? findBookInArray(bible.books, combinedQuery.book.name)?.number ?? null
      : null;

    // Indexed path covers book-scoped queries too (filter postings by book).
    if (bible.searchIndex) {

      const perBibleCap = searchAll && biblesToSearch.length > 1
        ? Math.max(1, Math.ceil(maxResults / biblesToSearch.length)) * 3
        : maxResults * 2;
      const scored = [];
      const pushRecord = (rec, tier) => {
        if (perBibleFilter != null && rec.b !== perBibleFilter) return;
        if (bookFilterNumber != null && perBibleFilter == null && rec.b !== bookFilterNumber) return;
        const found = lookupVerseRecord(bible, rec.b, rec.c, rec.v);
        if (!found) return;
        // Lyric phrase-first port: the whole-phrase holder dominates any
        // scattered-word tie. Single-term queries skip it (the probe equals
        // the term, so it would shift every hit equally).
        const phraseBonus = queryTerms.length > 1
          && String(found.verse.text || '').toLowerCase().includes(searchTermLower)
          ? 1500
          : 0;
        scored.push({
          book: found.book.number,
          bookName: found.book.name,
          chapter: found.chapter.number,
          verse: found.verse.number,
          text: found.verse.text,
          reference: `${found.book.name} ${found.chapter.number}:${found.verse.number}`,
          bibleId: bible.id,
          bibleName: bible.name,
          score: 200 + tier + phraseBonus + relevanceBonus(found.verse.text, queryTerms[0]) + priorityBoost
        });
      };

      if (queryTerms.length === 1) {
        for (const { rec, tier } of tieredPostings(bible.searchIndex, queryTerms[0], perBibleCap)) {
          pushRecord(rec, tier);
        }
      } else {
        // Multi-term: union per term (exact+plural+prefix capped), then intersect.
        const unions = queryTerms.map((term) => {
          const set = new Set();
          for (const { rec } of tieredPostings(bible.searchIndex, term, 800)) {
            if (perBibleFilter != null && rec.b !== perBibleFilter) continue;
            set.add(`${rec.b}-${rec.c}-${rec.v}`);
          }
          return set;
        });
        let intersectKeys = [...(unions[0] || [])];
        for (let i = 1; i < unions.length; i++) {
          const s = unions[i];
          intersectKeys = intersectKeys.filter((k) => s.has(k));
          if (intersectKeys.length === 0) break;
        }
        for (const key of intersectKeys.slice(0, perBibleCap)) {
          const [b, c, v] = key.split('-').map(Number);
          pushRecord({ b, c, v }, 300);
        }
      }

      scored.sort((a, b) => b.score - a.score);
      results.push(...scored.slice(0, perBibleCap));
      continue;
    }

    const searchBooks = combinedQuery.book
      ? [findBookInArray(bible.books, combinedQuery.book.name)].filter(Boolean)
      : bible.books;
    const legacyCap = maxResults * 5;
    let legacyCount = 0;
    let legacyFull = false;

    for (const book of searchBooks) {
      if (legacyFull) break;
      for (const chapter of book.chapters) {
        if (legacyFull) break;
        for (const verse of chapter.verses) {
          if (legacyCount >= legacyCap) { legacyFull = true; break; }
          const verseText = (verse.text || '').toLowerCase();

          // Exact phrase match gets highest priority
          if (verseText.includes(searchTerm.toLowerCase())) {
            results.push({
              book: book.number,
              bookName: book.name,
              chapter: chapter.number,
              verse: verse.number,
              text: verse.text,
              reference: `${book.name} ${chapter.number}:${verse.number}`,
              bibleId: bible.id,
              bibleName: bible.name,
              score: 100 + searchTerm.length + priorityBoost
            });
            legacyCount++;
            continue;
          }

          // Individual word matches
          let matchCount = 0;
          for (const term of queryTerms) {
            if (verseText.includes(term)) {
              matchCount++;
            }
          }

          if (matchCount > 0) {
            results.push({
              book: book.number,
              bookName: book.name,
              chapter: chapter.number,
              verse: verse.number,
              text: verse.text,
              reference: `${book.name} ${chapter.number}:${verse.number}`,
              bibleId: bible.id,
              bibleName: bible.name,
              score: (matchCount * 10) + priorityBoost
            });
            legacyCount++;
          }
        }
      }
    }
  }

  // When searching across all bibles, give each bible a fair share of the
  // results so that non-default/non-active bibles aren't pushed out of the
  // top N by the per-bible score boost.
  if (searchAll && biblesToSearch.length > 1) {
    const perBibleCap = Math.max(1, Math.ceil(maxResults / biblesToSearch.length));
    const byBible = new Map();
    for (const result of results) {
      if (!byBible.has(result.bibleId)) byBible.set(result.bibleId, []);
      byBible.get(result.bibleId).push(result);
    }
    const balanced = [];
    for (const group of byBible.values()) {
      group.sort((a, b) => b.score - a.score);
      balanced.push(...group.slice(0, perBibleCap));
    }
    results = balanced;
  }

  return results
    .sort((a, b) => {
      const aIsDefault = a.bibleId === defaultBibleId;
      const bIsDefault = b.bibleId === defaultBibleId;
      if (aIsDefault && !bIsDefault) return -1;
      if (bIsDefault && !aIsDefault) return 1;
      return b.score - a.score;
    })
    .slice(0, maxResults)
    .map(({ score, ...rest }) => rest);
}

// --- Experimental sentence-first search (behind Experimental flag) ---
// Same reference handling as searchBible (isa 44 5 must keep working), but
// text ranking is sentence-first: exact phrase wins, then ordered coverage.
// Single-word OR hits are filtered when the query is a sentence.
// Faster than the default path: no vocabulary-wide prefix scan — only
// exact + plural-variant postings are intersected, then reranked.

// Bounded morphological variants for candidate lookup. The old path's
// vocabulary-wide prefix scan found love/loved/loving for free; dropping
// that scan (for speed) must not drop inflection recall. These are O(1)
// direct index lookups — never a scan — so the speed design holds.
function experimentalTermVariants(term) {
  const out = [term];
  if (term.endsWith('s') && term.length > 4) out.push(term.slice(0, -1));
  else out.push(`${term}s`);
  // love<->loved, cry<->cried, study<->studied, pray<->prayed
  out.push(`${term}d`, `${term}ed`);
  if (term.endsWith('ed') && term.length > 5) out.push(term.slice(0, -2), term.slice(0, -1));
  else if (term.endsWith('d') && term.length > 4) out.push(term.slice(0, -1));
  if (term.endsWith('ies') && term.length > 5) out.push(`${term.slice(0, -3)}y`);
  return [...new Set(out)];
}

export function searchBibleExperimental(currentBible, query, allBibles = {}, maxResults = 50, defaultBibleId = null, searchAll = false) {
  if (!currentBible || !currentBible.books) return [];
  const rawQuery = String(query || '').trim();
  if (!rawQuery) return [];

  const biblesToSearch = (searchAll && Object.keys(allBibles).length > 0)
    ? Object.values(allBibles).sort((a, b) => {
      if (a.id === defaultBibleId && b.id !== defaultBibleId) return -1;
      if (b.id === defaultBibleId && a.id !== defaultBibleId) return 1;
      if (a.id === currentBible.id && b.id !== currentBible.id) return -1;
      if (b.id === currentBible.id && a.id !== currentBible.id) return 1;
      return 0;
    })
    : [currentBible];

  // 1. Reference path identical to searchBible — grouped + single.
  const groupedReferences = searchGroupedReferences(biblesToSearch, rawQuery, maxResults, currentBible?.id);
  if (groupedReferences) return groupedReferences;

  const referenceMatch = rawQuery.match(REFERENCE_REGEX);
  if (referenceMatch) {
    const results = [];
    const [, bookPart, chapterPart, versePart1, versePart2, rangeEndPart] = referenceMatch;
    const versePart = versePart1 || versePart2;
    for (const bible of biblesToSearch) {
      const bookMatch = findBookInArray(bible.books, bookPart);
      if (!bookMatch) continue;
      const chapter = findChapter(bookMatch, chapterPart);
      if (!chapter) continue;
      if (versePart) {
        const startVerse = parseInt(versePart, 10);
        const endVerse = parseInt(rangeEndPart || versePart, 10);
        const versesInRange = (chapter.verses || []).filter((v) => v.number >= startVerse && v.number <= endVerse);
        if (versesInRange.length > 0) {
          const normalizedEnd = Number.isNaN(endVerse) ? startVerse : endVerse;
          results.push({
            book: bookMatch.number,
            bookName: bookMatch.name,
            chapter: chapter.number,
            verse: startVerse,
            endVerse: normalizedEnd,
            verses: versesInRange.map((v) => v.number),
            text: versesInRange.map((v) => v.text || '').join(' ').trim(),
            reference: normalizedEnd > startVerse
              ? `${bookMatch.name} ${chapter.number}:${startVerse}-${normalizedEnd}`
              : `${bookMatch.name} ${chapter.number}:${startVerse}`,
            bibleId: bible.id,
            bibleName: bible.name,
          });
        }
      } else if (chapter.verses?.length > 0) {
        if (bible.id === currentBible.id || (!currentBible.id && biblesToSearch.length === 1)) {
          return chapter.verses.slice(0, maxResults).map((verse) => ({
            book: bookMatch.number,
            bookName: bookMatch.name,
            chapter: chapter.number,
            verse: verse.number,
            text: verse.text || '',
            reference: `${bookMatch.name} ${chapter.number}:${verse.number}`,
            bibleId: bible.id,
            bibleName: bible.name,
          }));
        }
      }
    }
    if (results.length > 0) return results.slice(0, maxResults);
  }

  // 2. Sentence path. Book scope is leading-position + EXACT-only
  // (matchLeadingBook): the shared parseCombinedQuery() matches books
  // anywhere via prefix/substring, so "so"->Song, "in"->Corinthians,
  // "a"->Amos hijacked every sentence containing a function word and
  // scoped the search to one wrong book. References never reach here.
  const leading = matchLeadingBook(currentBible.books, rawQuery);
  if (leading && !leading.rest) return [];
  const searchTerm = leading && leading.rest ? leading.rest : rawQuery;
  if (!searchTerm || searchTerm.trim().length < 2) return [];

  const queryNorm = normalizeSentenceText(searchTerm);
  const queryContent = sentenceContentTokens(searchTerm);
  if (queryContent.length === 0) return [];

  const bookFilterNumber = leading?.book?.number ?? null;

  let results = [];
  for (const bible of biblesToSearch) {
    const isCurrent = bible.id === currentBible.id;
    const isDefault = bible.id === defaultBibleId;
    const priorityBoost = (isDefault ? 100 : 0) + (isCurrent ? 50 : 0);
    const perBibleFilter = leading?.book
      ? findBookInArray(bible.books, leading.book.name)?.number ?? null
      : null;

    const perBibleCap = searchAll && biblesToSearch.length > 1
      ? Math.max(1, Math.ceil(maxResults / biblesToSearch.length)) * 3
      : maxResults * 2;

    if (bible.searchIndex) {
      // Fast candidate retrieval with FULL recall. Posting keys are packed
      // integers (b*1e6+c*1e3+v — book/chapter/verse are all < 1000), so
      // set/map work is allocation-free. No Object.keys prefix scan anywhere.
      // Single-term sets are capped at 2000 like the old path (ranking is
      // provably identical: one shared weight shifts every score equally).
      const totalVerses = bible.books.reduce((t, bk) => t + (bk.chapters?.reduce((c, ch) => c + (ch.verses?.length || 0), 0) || 0), 0);
      const singleTerm = queryContent.length === 1;
      // PAIR-FIRST fast path (lyric hill-climb port): adjacent word-pair
      // postings collapse quote candidates to just the phrase holders before
      // any union/typo work runs. The fuzzy pair lookup (variants + 1-edit
      // neighbors per position) keeps the ambiguity policy intact — literal
      // tops, fuzzy stays visible — while exact quotes resolve here with no
      // union scoring at all. Misses and oversize sets fall through to the
      // fuzzy union path below with full recall. Bounded: huge/common pair
      // sets fall through too.
      let pairKeys = findBibleFuzzyPairKeys(bible, searchTerm);
      if (pairKeys && pairKeys.length > 0 && pairKeys.length <= BIBLE_PAIR_FAST_MAX) {
        // Book-scoped queries: an all-out-of-scope pair pool must fall
        // through to the union path (which finds scattered in-scope words)
        // instead of early-returning empty.
        if (perBibleFilter != null || (bookFilterNumber != null && perBibleFilter == null)) {
          pairKeys = pairKeys.filter((packed) => {
            const pb = Math.floor(packed / 1000000);
            if (perBibleFilter != null && pb !== perBibleFilter) return false;
            if (bookFilterNumber != null && perBibleFilter == null && pb !== bookFilterNumber) return false;
            return true;
          });
        }
      }
      if (pairKeys && pairKeys.length > 0) {
        const pairWeights = queryContent.map((t) => Math.log(1 + totalVerses / (1 + (bible.searchIndex[t]?.length || 0))));
        const pairScored = [];
        for (const packed of pairKeys) {
          const pb = Math.floor(packed / 1000000);
          if (perBibleFilter != null && pb !== perBibleFilter) continue;
          if (bookFilterNumber != null && perBibleFilter == null && pb !== bookFilterNumber) continue;
          const pc = Math.floor((packed % 1000000) / 1000);
          const pv = packed % 1000;
          const pbook = bible.bookMap?.[pb] || bible.books.find((bk) => bk.number === pb);
          if (!pbook) continue;
          const pchapter = pbook.chapterMap?.[pc] || pbook.chapters.find((ch) => ch.number === pc);
          if (!pchapter) continue;
          const pverse = pchapter.verseMap?.[pv] || pchapter.verses.find((vx) => vx.number === pv);
          if (!pverse) continue;
          const ps = scoreSentenceVerse(queryNorm, queryContent, pverse.text || '', pairWeights);
          if (!ps) continue;
          pairScored.push({
            book: pbook.number,
            bookName: pbook.name,
            chapter: pchapter.number,
            verse: pverse.number,
            text: pverse.text,
            reference: `${pbook.name} ${pchapter.number}:${pverse.number}`,
            bibleId: bible.id,
            bibleName: bible.name,
            score: ps.score + priorityBoost + (ps.phrase ? 500 : 0),
            phrase: ps.phrase === true,
          });
        }
        pairScored.sort((x, y) => y.score - x.score);
        // Early-return ONLY on a literal win: some pooled verse must contain
        // the whole query contiguously (phrase=true). Otherwise the pair pool
        // may be holding a fuzzy lookalike while the true literal sits
        // outside it (e.g. "so love the world that": pool={John 3:16},
        // literal=1 John 2:15 "Love not the world" — love/world never
        // adjacent there). Falling through preserves the ambiguity policy.
        let pairHasPhrase = false;
        for (const hit of pairScored) {
          if (hit.phrase) { pairHasPhrase = true; break; }
        }
        if (pairHasPhrase) {
          results.push(...pairScored.slice(0, perBibleCap).map(({ phrase, ...rest }) => rest));
          continue;
        }
        // No literal in the pool — fall through to the union path.
      }
      // Phase 1 — cheap pass: exact + morphological variants only (O(1)
      // lookups each). Mirrors the lyric two-tier flow: quote queries whose
      // words are all literally present never pay for the ~250-hash
      // typo-neighbor expansion per term below.
      const makePush = (set) => {
        const push = (rec) => {
          if (perBibleFilter != null && rec.b !== perBibleFilter) return true;
          const k = rec.b * 1000000 + rec.c * 1000 + rec.v;
          if (set.has(k)) return true;
          if (singleTerm && set.size >= 2000) return false;
          set.add(k);
          return true;
        };
        const pushAll = (postings) => {
          for (const rec of postings) {
            if (!push(rec)) return false;
          }
          return true;
        };
        return { push, pushAll };
      };
      const termSets = queryContent.map((term) => {
        const set = new Set();
        const { pushAll } = makePush(set);
        for (const variant of experimentalTermVariants(term)) {
          if (!pushAll(bible.searchIndex[variant] || [])) break;
        }
        return { term, set };
      });
      // Cheap intersect size decides the tier: any verse holding every
      // content word literally means typo expansion can only add cost,
      // never recall the pool can use.
      let cheapHits = 0;
      if (singleTerm) {
        cheapHits = termSets[0]?.set.size || 0;
      } else if (termSets.length > 0) {
        const ordered = [...termSets].sort((a, b) => a.set.size - b.set.size);
        const probe = new Set(ordered[0].set);
        for (let i = 1; i < ordered.length && probe.size > 0; i++) {
          for (const k of probe) {
            if (!ordered[i].set.has(k)) probe.delete(k);
          }
        }
        cheapHits = probe.size;
      }
      // Phase 2 — fuzzy tier, only on cheap miss (typo/paraphrase queries).
      if (cheapHits === 0) {
        for (const entry of termSets) {
          const { term, set } = entry;
          const { push, pushAll } = makePush(set);
          // Typo neighbors via GENERATION, not vocabulary scan: all 1-edit
          // insertions/deletions/substitutions are hashed directly (~250
          // lookups vs a 12k-key scan). Empty and rare terms always expand
          // (typo recall).
          if (term.length >= 4 && set.size < 500) {
            const seen = new Set();
            const tryKey = (key) => {
              if (key.length < 4 || seen.has(key)) return true;
              seen.add(key);
              const postings = bible.searchIndex[key];
              if (postings) return pushAll(postings);
              return true;
            };
            let stop = false;
            // Deletions (extra char typed: "worrld" -> "world").
            for (let i = 0; i < term.length && !stop; i++) {
              if (!tryKey(term.slice(0, i) + term.slice(i + 1))) stop = true;
            }
            // Substitutions (wrong char: "aginst" needs insert, "wird" -> "word").
            for (let i = 0; i < term.length && !stop; i++) {
              for (let c = 97; c <= 122 && !stop; c++) {
                const v = term.slice(0, i) + String.fromCharCode(c) + term.slice(i + 1);
                if (v === term) continue;
                if (!tryKey(v)) stop = true;
              }
            }
            // Insertions (missing char: "evrything" -> "everything",
            // "word" -> "world", "aginst" -> "against").
            for (let i = 0; i <= term.length && !stop; i++) {
              for (let c = 97; c <= 122 && !stop; c++) {
                if (!tryKey(term.slice(0, i) + String.fromCharCode(c) + term.slice(i))) stop = true;
              }
            }
          }
          // Compound splits for still-empty typo terms ("evrything" has no
          // 1-edit neighbor that is a real word): all substrings len>=4 are
          // hashed directly instead of scanning the vocabulary.
          if (set.size === 0 && term.length >= 6) {
            const seen = new Set();
            for (let i = 0; i <= term.length - 4 && set.size < 2000; i++) {
              for (let j = i + 4; j <= term.length && set.size < 2000; j++) {
                const sub = term.slice(i, j);
                if (sub === term || seen.has(sub)) continue;
                seen.add(sub);
                const postings = bible.searchIndex[sub];
                if (postings) for (const rec of postings) push(rec);
              }
            }
          }
        }
      }
      const weightOf = new Map(termSets.map(({ term, set }) => [term, Math.log(1 + totalVerses / (1 + set.size))]));
      const termWeights = queryContent.map((t) => weightOf.get(t));
      termSets.sort((a, b) => a.set.size - b.set.size);
      const unions = termSets.map((t) => t.set);
      // Pool budget: bounded for keystroke latency; ORDERING (not size)
      // protects recall. Hit-count buckets order linearly (no comparator
      // sort); an explicit phrase hunt rescues deep exact-phrase hits that
      // any positional slice would truncate; the single-term path keeps the
      // old 2000-cap for parity.
      const HARD = 2500;
      const TOPUP = Math.min(250, Math.max(20, maxResults * 5));
      const scored = [];
      const lookup = (b, c, v) => {
        const book = bible.bookMap?.[b] || bible.books.find((bk) => bk.number === b);
        if (!book) return null;
        const chapter = book.chapterMap?.[c] || book.chapters.find((ch) => ch.number === c);
        if (!chapter) return null;
        const verse = chapter.verseMap?.[v] || chapter.verses.find((vx) => vx.number === v);
        if (!verse) return null;
        return { book, chapter, verse };
      };
      // Linear-time hit ordering: bucket keys by count (insertion-stable
      // within a bucket, so ties keep bible order exactly like before).
      const bucketOrder = (hits, exclude, limit) => {
        let top = 0;
        for (const c of hits.values()) if (c > top) top = c;
        const buckets = new Array(top + 1);
        for (const k of hits.keys()) {
          if (exclude && exclude.has(k)) continue;
          const c = hits.get(k);
          (buckets[c] || (buckets[c] = [])).push(k);
        }
        const out = [];
        for (let c = top; c >= 0 && out.length < limit; c--) {
          const bkt = buckets[c];
          if (!bkt) continue;
          for (const k of bkt) {
            out.push(k);
            if (out.length >= limit) break;
          }
        }
        return out;
      };
      // Exact-phrase hunt over an oversized intersect: a deep exact-phrase
      // verse would never be scored otherwise. Cheap raw-lowercase
      // substring on intersect keys only, bounded scan, stops at maxResults.
      const huntPhrase = (keys) => {
        const found = [];
        const seenH = new Set();
        const lim = Math.min(keys.length, 6000);
        for (let i = 0; i < lim && found.length < maxResults; i++) {
          const k = keys[i];
          const b = Math.floor(k / 1000000);
          const c = Math.floor((k % 1000000) / 1000);
          const v = k % 1000;
          const rec = lookup(b, c, v);
          if (!rec || !rec.verse.text || seenH.has(k)) continue;
          if (String(rec.verse.text).toLowerCase().includes(queryNorm)) {
            seenH.add(k);
            found.push(k);
          }
        }
        return found;
      };
      let candidateKeys = null;
      if (singleTerm) {
        // Unchanged parity with the old 2000-cap path: score the head only.
        candidateKeys = [...(unions[0] || [])].slice(0, perBibleCap * 4);
      } else {
        const intersect = [...(unions[0] || [])];
        for (let i = 1; i < unions.length; i++) {
          const s = unions[i];
          for (let j = intersect.length - 1; j >= 0; j--) {
            if (!s.has(intersect[j])) intersect.splice(j, 1);
          }
          if (intersect.length === 0) break;
        }
        if (intersect.length === 0) {
          // Typo path: no verse matches everything; order the whole union
          // by hit count and score the head. Fuzzy near-misses live at
          // the front, single-word noise never passes the gate below.
          const hits = new Map();
          for (const s of unions) {
            for (const k of s) hits.set(k, (hits.get(k) || 0) + 1);
          }
          candidateKeys = bucketOrder(hits, null, HARD);
        } else if (intersect.length >= HARD) {
          // Mega-intersect: the pool slice alone would truncate deep hits,
          // so hunt exact-phrase verses explicitly and prepend them — the
          // scoring gate still filters everything else normally.
          const phraseHits = huntPhrase(intersect);
          const inPool = new Set(phraseHits);
          const head = [];
          for (const k of intersect) {
            if (head.length + phraseHits.length >= HARD) break;
            if (inPool.has(k)) continue;
            inPool.add(k);
            head.push(k);
          }
          candidateKeys = [...phraseHits, ...head];
        } else {
          // Ambiguity policy: strict matches lead, but fuzzy near-misses stay
          // visible below. Top-up is ordered by (hit count, rarity weight) so
          // a near-miss on RARE terms (water+wine) outranks one on glue
          // (water+into) regardless of canon position — bible-order ties
          // buried John 2:9 past the pool cap. The sentence gate below still
          // removes single-word OR hits from the pool.
          const hits = new Map();
          const wsum = new Map();
          termSets.forEach((t, ti) => {
            const w = termWeights[queryContent.indexOf(t.term)] || 0;
            for (const k of t.set) {
              hits.set(k, (hits.get(k) || 0) + 1);
              wsum.set(k, (wsum.get(k) || 0) + w);
            }
          });
          const inStrict = new Set(intersect);
          const top = [];
          const consider = (k) => {
            if (inStrict.has(k)) return;
            const h = hits.get(k);
            const w = wsum.get(k) || 0;
            let i = 0;
            while (i < top.length && (top[i].h > h || (top[i].h === h && top[i].w >= w))) i++;
            if (i >= TOPUP) return;
            top.splice(i, 0, { k, h, w });
            if (top.length > TOPUP) top.pop();
          };
          for (const k of hits.keys()) consider(k);
          candidateKeys = [...intersect, ...top.map((x) => x.k)];
        }
      }

      for (const key of candidateKeys) {
        const b = Math.floor(key / 1000000);
        const c = Math.floor((key % 1000000) / 1000);
        const v = key % 1000;
        if (perBibleFilter != null && b !== perBibleFilter) continue;
        if (bookFilterNumber != null && perBibleFilter == null && b !== bookFilterNumber) continue;
        const found = lookup(b, c, v);
        if (!found) continue;
        const s = scoreSentenceVerse(queryNorm, queryContent, found.verse.text || '', termWeights);
        if (!s) continue;
        scored.push({
          book: found.book.number,
          bookName: found.book.name,
          chapter: found.chapter.number,
          verse: found.verse.number,
          text: found.verse.text,
          reference: `${found.book.name} ${found.chapter.number}:${found.verse.number}`,
          bibleId: bible.id,
          bibleName: bible.name,
          score: s.score + priorityBoost + (s.phrase ? 500 : 0),
        });
      }
      scored.sort((a, b) => b.score - a.score);
      results.push(...scored.slice(0, perBibleCap));
      continue;
    }

    // No index: full scan with sentence scoring (same gate).
    for (const book of bible.books) {
      if (perBibleFilter != null && book.number !== perBibleFilter) continue;
      for (const chapter of book.chapters || []) {
        for (const verse of chapter.verses || []) {
          const s = scoreSentenceVerse(queryNorm, queryContent, verse.text || '');
          if (!s) continue;
          results.push({
            book: book.number,
            bookName: book.name,
            chapter: chapter.number,
            verse: verse.number,
            text: verse.text,
            reference: `${book.name} ${chapter.number}:${verse.number}`,
            bibleId: bible.id,
            bibleName: bible.name,
            score: s.score + priorityBoost,
          });
          if (results.length >= perBibleCap * 2) break;
        }
        if (results.length >= perBibleCap * 2) break;
      }
      if (results.length >= perBibleCap * 2) break;
    }
  }

  if (searchAll && biblesToSearch.length > 1) {
    const perBibleCap = Math.max(1, Math.ceil(maxResults / biblesToSearch.length));
    const byBible = new Map();
    for (const r of results) {
      if (!byBible.has(r.bibleId)) byBible.set(r.bibleId, []);
      byBible.get(r.bibleId).push(r);
    }
    const balanced = [];
    for (const group of byBible.values()) {
      group.sort((a, b) => b.score - a.score);
      balanced.push(...group.slice(0, perBibleCap));
    }
    results = balanced;
  }

  return results
    .sort((a, b) => {
      const aIsDefault = a.bibleId === defaultBibleId;
      const bIsDefault = b.bibleId === defaultBibleId;
      if (aIsDefault && !bIsDefault) return -1;
      if (bIsDefault && !aIsDefault) return 1;
      return b.score - a.score;
    })
    .slice(0, maxResults)
    .map(({ score, ...rest }) => rest);
}
