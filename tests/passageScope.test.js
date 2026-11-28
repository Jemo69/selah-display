/**
 * Limited text scope.
 *
 * The operator names a passage ("Acts 6", "Acts 6:1-10", "Acts 6-7") and then
 * searches for a word or sentence. Two things must stay true:
 *
 *   1. The scope only narrows candidates. Ranking, typo tolerance and modern
 *      English bridging behave exactly as they do canon-wide.
 *   2. The query never becomes a verse lookup while scoped, and a translation
 *      that does not contain the scoped book is skipped rather than searched
 *      unscoped. Silently widening the scope is the failure mode that makes
 *      an operator distrust the results.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildSearchIndex,
  formatPassageScope,
  parsePassageScope,
  passageScopeContains,
  resolvePassageScope,
  searchBibleExperimental,
} from 'shared/bible/index.js';

function makeBible(id = 'kjv', name = 'KJV') {
  return {
    id,
    name,
    books: [
      {
        number: 1,
        name: 'Genesis',
        chapters: [
          { number: 6, verses: [{ number: 8, text: 'But Noah found grace in the eyes of the LORD.' }] },
        ],
      },
      {
        number: 44,
        name: 'Acts',
        chapters: [
          {
            number: 6,
            verses: [
              { number: 1, text: 'And in those days, when the number of the disciples was multiplied, there arose a murmuring.' },
              { number: 2, text: 'Then the twelve called the multitude of the disciples unto them, and said, It is not reason that we should leave the word of God, and serve tables.' },
              { number: 3, text: 'Wherefore, brethren, look ye out among you seven men of honest report, full of the Holy Ghost and wisdom.' },
              { number: 5, text: 'And they chose Stephen, a man full of faith and of the Holy Ghost.' },
              { number: 8, text: 'And Stephen, full of faith and power, did great wonders and miracles among the people.' },
            ],
          },
          {
            number: 7,
            verses: [
              { number: 1, text: 'Then said the high priest, Are these things so?' },
              { number: 59, text: 'And they stoned Stephen, calling upon God, and saying, Lord Jesus, receive my spirit.' },
            ],
          },
        ],
      },
    ],
  };
}

const refs = (results) => results.map((r) => r.reference);
const search = (bible, query, scopeText, extra = {}) => searchBibleExperimental(
  bible,
  query,
  extra.allBibles || {},
  extra.maxResults || 10,
  extra.defaultBibleId || null,
  extra.searchAll || false,
  scopeText == null ? null : parsePassageScope(scopeText)
);

let plain;
let indexed;

beforeAll(() => {
  plain = makeBible();
  indexed = makeBible();
  indexed.searchIndex = buildSearchIndex(indexed);
});

describe('parsePassageScope', () => {
  it('reads a whole chapter', () => {
    expect(parsePassageScope('Acts 6')).toEqual({
      bookName: 'Acts',
      ranges: [{ startChapter: 6, startVerse: null, endChapter: 6, endVerse: null }],
    });
  });

  it('reads a verse range with : , or plain space', () => {
    const expected = { startChapter: 6, startVerse: 1, endChapter: 6, endVerse: 10 };
    for (const text of ['Acts 6:1-10', 'Acts 6,1-10', 'Acts 6 1-10', 'acts 6:1 - 10']) {
      expect(parsePassageScope(text).ranges[0]).toEqual(expected);
    }
    // "Acts 6, 10" — the chapter-then-verse shape operators type by hand.
    expect(parsePassageScope('Acts 6, 10').ranges[0]).toEqual({
      startChapter: 6, startVerse: 10, endChapter: 6, endVerse: 10,
    });
  });

  it('reads a single verse and a chapter span', () => {
    expect(parsePassageScope('Acts 6:8').ranges[0]).toEqual({
      startChapter: 6, startVerse: 8, endChapter: 6, endVerse: 8,
    });
    expect(parsePassageScope('Acts 6-7').ranges[0]).toEqual({
      startChapter: 6, startVerse: null, endChapter: 7, endVerse: null,
    });
  });

  it('reads a cross-chapter range and normalizes dashes', () => {
    expect(parsePassageScope('Rom 8:38\u20139:2').ranges[0]).toEqual({
      startChapter: 8, startVerse: 38, endChapter: 9, endVerse: 2,
    });
  });

  it('rejects anything that is not a passage, instead of guessing', () => {
    for (const text of ['', '   ', 'Acts', 'Acts six', 'Acts 6 hello', '6:1', 'grace', 'Acts 6:10-2']) {
      expect(parsePassageScope(text)).toBeNull();
    }
  });
});

describe('resolvePassageScope / passageScopeContains', () => {
  it('resolves the book number for the translation it is given', () => {
    const resolved = resolvePassageScope(plain, parsePassageScope('Acts 6'));
    expect(resolved.bookNumber).toBe(44);
    expect(passageScopeContains(resolved, 44, 6, 1)).toBe(true);
    expect(passageScopeContains(resolved, 44, 7, 1)).toBe(false);
    expect(passageScopeContains(resolved, 1, 6, 8)).toBe(false);
  });

  it('honors verse bounds only on the chapters that carry them', () => {
    const resolved = resolvePassageScope(plain, parsePassageScope('Acts 6:2-7:1'));
    expect(passageScopeContains(resolved, 44, 6, 1)).toBe(false);
    expect(passageScopeContains(resolved, 44, 6, 2)).toBe(true);
    expect(passageScopeContains(resolved, 44, 7, 1)).toBe(true);
    expect(passageScopeContains(resolved, 44, 7, 2)).toBe(false);
  });

  it('refuses a book the translation does not have', () => {
    expect(resolvePassageScope(plain, parsePassageScope('Jude 1'))).toBeNull();
  });
});

describe('formatPassageScope', () => {
  it('labels the scope the way the operator typed it', () => {
    expect(formatPassageScope(parsePassageScope('Acts 6'))).toBe('Acts 6');
    expect(formatPassageScope(parsePassageScope('Acts 6:1-10'))).toBe('Acts 6:1-10');
    expect(formatPassageScope(parsePassageScope('Acts 6-7'))).toBe('Acts 6-7');
    // A cross-chapter range keeps its second chapter: "Rom 8:38-9:2" is a
    // verse range that happens to cross a chapter, not a chapter span.
    expect(formatPassageScope(parsePassageScope('Rom 8:38-9:2'))).toBe('Rom 8:38-9:2');
    expect(formatPassageScope(null)).toBe('');
  });
});

describe.each([
  ['unindexed scan', () => plain],
  ['search index', () => indexed],
])('searchBibleExperimental with scope (%s)', (_label, getBible) => {
  it('returns only verses inside the scoped chapter', () => {
    const results = search(getBible(), 'stephen', 'Acts 6');
    expect(refs(results).sort()).toEqual(['Acts 6:5', 'Acts 6:8']);
  });

  it('leaves canon-wide search unchanged', () => {
    const results = search(getBible(), 'stephen', null);
    expect(refs(results)).toContain('Acts 7:59');
  });

  it('honors a verse range inside the chapter', () => {
    const results = search(getBible(), 'stephen', 'Acts 6:8-8');
    expect(refs(results)).toEqual(['Acts 6:8']);
  });

  it('searches across a chapter span', () => {
    const results = search(getBible(), 'stephen', 'Acts 6-7');
    expect(refs(results).sort()).toEqual(['Acts 6:5', 'Acts 6:8', 'Acts 7:59']);
  });

  it('does not treat the query as a reference while scoped', () => {
    expect(search(getBible(), 'Acts 6:1', 'Acts 6')).toEqual([]);
  });

  it('returns nothing when the scoped book is not in that translation', () => {
    expect(search(getBible(), 'stephen', 'Jude 1')).toEqual([]);
  });

  it('returns nothing when the word does not occur inside the scope', () => {
    expect(search(getBible(), 'noah', 'Acts 6')).toEqual([]);
    expect(refs(search(getBible(), 'noah', 'Genesis 6'))).toEqual(['Genesis 6:8']);
  });
});

describe('scope with several translations', () => {
  it('skips a translation that lacks the scoped book instead of searching it unscoped', () => {
    const kjv = makeBible('kjv', 'KJV');
    const spanish = {
      id: 'es',
      name: 'RVR1960',
      books: [{
        number: 1,
        name: 'Génesis',
        chapters: [{ number: 6, verses: [{ number: 8, text: 'Pero Noé halló gracia ante los ojos de Jehová.' }] }],
      }],
    };
    const results = searchBibleExperimental(
      kjv,
      'stephen',
      { kjv, es: spanish },
      10,
      'kjv',
      true,
      parsePassageScope('Acts 6')
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.bibleId === 'kjv')).toBe(true);
    expect(refs(results)).toEqual(expect.arrayContaining(['Acts 6:5']));
    expect(refs(results)).not.toContain('Acts 7:59');
  });
});
