// src/speech/verseSearchEngine.js — the worker's index lifecycle, made pure.
//
// WHY THIS EXISTS. The worker used to call `rankVerses`, a containment counter
// that gives a verse a perfect score when a few common words happen to appear
// in it. On the 24-minute live-sermon transcript that produced four wrong
// references (1 Kings 1:47, 1 Chronicles 16:35, Psalms 106:47, Luke 10:21) at
// 0.62–0.73 confidence. The indexed scorer was already built in
// verseIndex.js/verseScore.js but nothing wired it to the worker.
//
// This module owns the "build once per translation, query many times" cache so
// the worker stays a thin shell and the behavior is testable without a Worker.

import { buildVerseIndex } from './verseIndex.js';
import { scoreVerses } from './verseScore.js';

/**
 * One searcher per worker. The index is keyed by the bible object identity:
 * a re-import produces a new object and rebuilds; repeated transcript tails
 * against the same translation reuse the index.
 *
 * @returns {{search: Function, indexed: boolean, reset: Function}}
 */
export function createVerseSearcher() {
  let cachedBible = null;
  let cachedIndex = null;

  return {
    /**
     * @param {object|null} currentBible Selah bible shape
     * @param {string} query transcript tail
     * @param {{currentReference?: string|null}} [options]
     * @returns {Array|null} one scored result, or null when nothing clears the floor
     */
    search(currentBible, query, { currentReference = null } = {}) {
      if (!currentBible || !Array.isArray(currentBible.books)) return null;
      if (currentBible !== cachedBible) {
        cachedBible = currentBible;
        cachedIndex = buildVerseIndex(currentBible);
      }
      if (!cachedIndex) return null;

      const result = scoreVerses(cachedIndex, query, { currentReference });
      if (!result) return null;
      // `detectVerse` only discloses a runner-up for an index-backed result;
      // without this tag the ambiguity warning is silently dropped.
      return [{ ...result, source: 'index' }];
    },

    get indexed() {
      return Boolean(cachedIndex);
    },

    reset() {
      cachedBible = null;
      cachedIndex = null;
    },
  };
}

export default createVerseSearcher;
