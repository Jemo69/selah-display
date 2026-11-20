// src/speech/verseCorpus.js — full-text verse matching (plan 11, detector 3)
//
// "Full-text fuzzy match of the transcript tail against verses in the
//  active translation, using the existing src/utils/bibleSearch.worker.js
//  off-thread pattern so a 30,000-verse search never touches the UI
//  thread during a service."
//
// The scoring itself is pure so the worker is a thin shell around it and
// the tests never need a worker at all: rankVerses(query, bible) runs
// anywhere, and src/workers/verseSearch.worker.js is the off-thread
// wrapper.
//
// Score = the share of the query's CONTENT words that appear in the verse
// (containment, not similarity): a sermon paraphrases, so the tail will
// not equal the verse — but every content word it does use should be
// there. Function words are dropped from BOTH sides before comparison, so
// "the and of" cannot inflate a match and "so" in "God so loved" does not
// sink one either.

import THRESHOLDS from './thresholds.js';

/**
 * Function words removed from both query and verse before comparison.
 * Deliberately small: only words that appear everywhere carry no signal.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'of', 'to', 'in', 'on',
  'at', 'by', 'for', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'am', 'it', 'its', 'this', 'that', 'these', 'those',
  'he', 'she', 'they', 'we', 'you', 'i', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'our', 'their', 'mine', 'yours', 'what', 'which',
  'who', 'whom', 'when', 'where', 'why', 'how', 'not', 'no', 'do', 'does',
  'did', 'done', 'have', 'has', 'had', 'will', 'would', 'shall', 'should',
  'can', 'could', 'may', 'might', 'must', 'there', 'here', 'into', 'out',
  'up', 'down', 'off', 'over', 'under', 'again', 'more', 'most', 'than',
  'too', 'very', 'just', 'about', 'all', 'any', 'each', 'some', 'such',
  'only', 'own', 'same', 'both', 'because', 'while', 'during', 'before',
  'after', 'above', 'below', 'between', 'also', 'unto', 'upon', 'ye',
  'yea', 'oh',
]);

/** Lower-case alphanumeric tokens. */
function rawTokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Content-word tokens (stopwords removed), falling back to raw when empty. */
function contentTokens(text) {
  const raw = rawTokens(text);
  const content = raw.filter((token) => !STOPWORDS.has(token));
  return content.length > 0 ? content : raw;
}

/**
 * Containment score of `query` inside `text`, in [0, 1].
 * Returns 0 when the query has no tokens or the guard on matched-word
 * count fails (one shared word like "Lord" must not match 30,000 verses).
 */
export function textOverlapScore(query, text, minMatches = THRESHOLDS.verseSearch.minMatches) {
  const queryTokens = contentTokens(query);
  if (queryTokens.length === 0) return 0;
  // A tail shorter than the evidence floor is not a verse reading. Without
  // this guard a one-word tail ("But leave") satisfies the old
  // Math.min(minMatches, queryTokens.length) check and can score 1.0 against
  // a verse that happens to contain that word — the exact false positive a
  // low-confidence OS transcript produced in the smoke test.
  if (queryTokens.length < minMatches) return 0;

  const verseTokens = new Set(contentTokens(text));
  let matched = 0;
  for (const token of queryTokens) {
    if (verseTokens.has(token)) matched += 1;
  }

  if (matched < minMatches) return 0;
  return Math.round((matched / queryTokens.length) * 1000) / 1000;
}

/**
 * Score every verse of `bible` against `query`, off the UI thread when
 * called through the worker. Returns the best hits, best first.
 *
 * Shape matches what searchBible() already posts, plus `score`:
 *   { book, bookName, chapter, verse, text, reference, score,
 *     bibleId, bibleName }
 *
 * @param {string} query  transcript tail
 * @param {{ id?: string, name?: string, books?: Array }} bible  active translation
 * @param {{ maxResults?: number, minScore?: number, minMatches?: number }} [options]
 * @returns {Array} [] when nothing clears the floor (never throws)
 */
export function rankVerses(query, bible, options = {}) {
  const maxResults = options.maxResults ?? THRESHOLDS.verseSearch.maxResults;
  const minScore = options.minScore ?? THRESHOLDS.verseSearch.minScore;
  const minMatches = options.minMatches ?? THRESHOLDS.verseSearch.minMatches;

  if (typeof query !== 'string' || query.trim().length === 0) return [];
  if (!bible || !Array.isArray(bible.books)) return [];

  const results = [];
  for (const book of bible.books) {
    if (!book || !Array.isArray(book.chapters)) continue;
    for (const chapter of book.chapters) {
      if (!chapter || !Array.isArray(chapter.verses)) continue;
      for (const verse of chapter.verses) {
        if (!verse || typeof verse.text !== 'string') continue;
        const score = textOverlapScore(query, verse.text, minMatches);
        if (score < minScore) continue;
        results.push({
          book: book.number,
          bookName: book.name,
          chapter: chapter.number,
          verse: verse.number,
          text: verse.text,
          reference: `${book.name} ${chapter.number}:${verse.number}`,
          score,
          bibleId: bible.id ?? null,
          bibleName: bible.name ?? null,
        });
      }
    }
  }

  results.sort((a, b) => b.score - a.score || a.chapter - b.chapter || a.verse - b.verse);
  return results.slice(0, Math.max(0, maxResults));
}

export default rankVerses;
