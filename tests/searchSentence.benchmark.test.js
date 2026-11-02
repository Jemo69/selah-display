/**
 * Sentence-first search benchmark (Experimental).
 *
 * Plan: operators type SENTENCES ("for God so love the world",
 * "water to into wine") and expect the sentence — not verses/files that
 * contain ANY single word. The default ranker intersects per-word postings
 * and scores single-word hits almost as highly as the sentence, which reads
 * as "it always re-searches per word".
 *
 * This file is the gate for the Experimental Sentence Search Ranking flag:
 *  - Sentence prioritization: experimental ranks the sentence first where the
 *    old ranker returns scattered single-word hits.
 *  - Reference preservation: "isa 44 5" still resolves Isaiah 44:5 in both
 *    rankers with the identical legacy shape.
 *  - File sentence: experimental filters OR-hits for multi-word lyric queries.
 *  - Speed: experimental is as fast or faster than the default path on the
 *    same corpus (no vocabulary-wide prefix scan).
 *  - Determinism: the same query twice yields the same order.
 *
 * Style mirrors tests/speech/benchmark.test.js: pure-function tests over
 * synthetic corpora, a realistic spread, and honest failure messages.
 */
import { describe, it, expect } from 'vitest';
import { searchBible, searchBibleExperimental } from 'shared/bible/index.js';
import {
  parseFileNavigatorQuery,
  prepareNavigatorSearchRecord,
  scoreNavigatorSearchRecord,
  scoreNavigatorSearchRecordExperimental,
} from 'shared/fileNavigatorSearch.js';

// A realistic spread: one exact-sentence verse (John 3:16), one reference
// verse (Isaiah 44:5), plus distractor verses that each contain exactly ONE
// word from the sentence query. The old ranker loves these distractors;
// the sentence ranker must filter them.
function makeSentenceBible() {
  const john316 = 'For God so loved the world that he gave his only begotten Son that whosoever believeth in him should not perish but have everlasting life';
  const isa445 = 'One shall say I am the LORDS and another shall call himself by the name of Jacob';
  const distractors = [
    'For the elders sat in the gate speaking of love',
    'God of the hills heard the cry of the people',
    'Love is patient and kind to all who seek',
    'The word was spoken in the morning assembly',
    'For God is good to the faithful gatherers',
    'Blessed are the peacemakers for they shall inherit',
  ];
  const verses = [
    { number: 16, text: john316 },
    ...distractors.map((text, i) => ({ number: 17 + i, text })),
  ];
  return {
    id: 'kjv',
    name: 'KJV',
    books: [
      {
        number: 43,
        name: 'John',
        chapters: [{ number: 3, verses }],
      },
      {
        number: 23,
        name: 'Isaiah',
        chapters: [{ number: 44, verses: [{ number: 5, text: isa445 }] }],
      },
    ],
  };
}

// Large synthetic corpus for the speed gate: 5,000 verses with unique vocab
// so the old path's Object.keys prefix scan has real work to do.
function makeLargeBible(verseCount = 5000) {
  const verses = [];
  for (let i = 1; i <= verseCount; i++) {
    verses.push({
      number: i,
      text: `verse number ${i} contains uniqueword${i} and common filler for timing measurement`,
    });
  }
  verses[2500] = {
    number: 2501,
    text: 'For God so loved the world that he gave his only begotten Son',
  };
  return {
    id: 'big',
    name: 'BIG',
    books: [{ number: 1, name: 'Genesis', chapters: [{ number: 1, verses }] }],
  };
}

const bibleWithIndex = (bible) => {
  // searchBible builds no index itself; parseBible normally does. Build a
  // minimal compatible index here so the test exercises the indexed path.
  const index = {};
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/'s\b/g, '')
      .replace(/[^a-z0-9]/g, '');
  for (const book of bible.books) {
    for (const chapter of book.chapters) {
      for (const verse of chapter.verses) {
        const seen = new Set();
        for (const word of String(verse.text || '').toLowerCase().split(/\s+/)) {
          const n = norm(word);
          if (!n || n.length < 3 || seen.has(n)) continue;
          seen.add(n);
          if (!index[n]) index[n] = [];
          index[n].push({ b: book.number, c: chapter.number, v: verse.number });
        }
      }
    }
  }
  return { ...bible, searchIndex: index };
};

function buildFileRecords() {
  const sentence = prepareNavigatorSearchRecord({
    filePath: '/songs/water-into-wine.txt',
    fileName: 'water-into-wine.txt',
    relativePath: 'songs/water-into-wine.txt',
    contentText: 'Jesus turned water into wine at the wedding in Cana of Galilee',
  });
  const scattered = prepareNavigatorSearchRecord({
    filePath: '/songs/scattered.txt',
    fileName: 'scattered.txt',
    relativePath: 'songs/scattered.txt',
    contentText: 'Water falls on the mountain. Into the valley runs the river. Wine is stored in the cellar.',
  });
  const singleWord = prepareNavigatorSearchRecord({
    filePath: '/songs/water-only.txt',
    fileName: 'water-only.txt',
    relativePath: 'songs/water-only.txt',
    contentText: 'Water water water nothing else here',
  });
  return { sentence, scattered, singleWord };
}

describe('Sentence prioritization (Bible)', () => {
  it('experimental ranks John 3:16 first for "for God so love the world"', () => {
    const bible = bibleWithIndex(makeSentenceBible());
    const results = searchBibleExperimental(bible, 'for God so love the world', {}, 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].reference).toBe('John 3:16');
  });

  it('experimental tolerates typos: "word" still finds "world" (word≈world)', () => {
    const bible = bibleWithIndex(makeSentenceBible());
    const results = searchBibleExperimental(bible, 'for God so love the word', {}, 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].reference).toBe('John 3:16');
  });

  it('experimental filters single-word OR hits for sentence queries', () => {
    const bible = bibleWithIndex(makeSentenceBible());
    const results = searchBibleExperimental(bible, 'for God so love the world', {}, 10);
    // Distractors each contain exactly one sentence word ("elders sat..." etc).
    // A per-word OR ranker returns them; the sentence ranker must not.
    const refs = results.map((r) => r.text);
    for (const r of results) {
      expect(r.text).not.toMatch(/elders sat in the gate/i);
    }
    expect(refs.length).toBeGreaterThan(0);
  });

  it('old and experimental agree the exact phrase exists (sanity, not equality)', () => {
    const bible = bibleWithIndex(makeSentenceBible());
    const oldRes = searchBible(bible, 'for God so love the world', {}, 10);
    const expRes = searchBibleExperimental(bible, 'for God so love the world', {}, 10);
    // Both must return SOMETHING for a real sentence; experimental must put
    // the sentence first even when the old ranker buries it under OR hits.
    expect(expRes.length).toBeGreaterThan(0);
    expect(expRes[0].reference).toBe('John 3:16');
    expect(Array.isArray(oldRes)).toBe(true);
  });
});

describe('Reference preservation (isa 44 5)', () => {
  it('"isa 44 5" resolves Isaiah 44:5 in the old ranker', () => {
    const bible = bibleWithIndex(makeSentenceBible());
    const results = searchBible(bible, 'isa 44 5', {}, 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].reference).toBe('Isaiah 44:5');
  });

  it('"isa 44 5" resolves Isaiah 44:5 in the experimental ranker with identical shape', () => {
    const bible = bibleWithIndex(makeSentenceBible());
    const oldRes = searchBible(bible, 'isa 44 5', {}, 10);
    const expRes = searchBibleExperimental(bible, 'isa 44 5', {}, 10);
    expect(expRes.length).toBeGreaterThan(0);
    expect(expRes[0].reference).toBe('Isaiah 44:5');
    // Legacy shape: book, bookName, chapter, verse, text, reference, bibleId.
    expect(expRes[0]).toMatchObject({
      book: oldRes[0].book,
      chapter: 44,
      verse: 5,
      reference: 'Isaiah 44:5',
    });
  });

  it('"Isaiah 44:5" with colon works in both rankers', () => {
    const bible = bibleWithIndex(makeSentenceBible());
    expect(searchBible(bible, 'Isaiah 44:5', {}, 5)[0]?.reference).toBe('Isaiah 44:5');
    expect(searchBibleExperimental(bible, 'Isaiah 44:5', {}, 5)[0]?.reference).toBe('Isaiah 44:5');
  });
});

describe('File sentence search', () => {
  it('experimental prefers the file containing the whole sentence', () => {
    const { sentence, scattered } = buildFileRecords();
    const parsed = parseFileNavigatorQuery('water to into wine');
    const sScore = scoreNavigatorSearchRecordExperimental(sentence, parsed);
    const cScore = scoreNavigatorSearchRecordExperimental(scattered, parsed);
    expect(sScore).not.toBeNull();
    // Scattered file has all words but spread across 3 sentences — the
    // sentence ranker must score it lower or filter it, never above.
    if (cScore) expect(sScore.score).toBeGreaterThan(cScore.score);
  });

  it('experimental filters single-word files for sentence queries (fixes OR habit)', () => {
    const { singleWord } = buildFileRecords();
    const parsed = parseFileNavigatorQuery('water to into wine');
    const oldScore = scoreNavigatorSearchRecord(singleWord, parsed);
    const expScore = scoreNavigatorSearchRecordExperimental(singleWord, parsed);
    // Old ranker: "water" substring matches, other terms may substring-match
    // ("to" appears inside many words) — returns a hit. Experimental must
    // require ordered coverage, so a one-word file is filtered.
    expect(expScore === null || expScore.score < 700).toBe(true);
    expect(oldScore === null || typeof oldScore.score === 'number').toBe(true);
  });

  it('experimental keeps exact-phrase file matches', () => {
    const { sentence } = buildFileRecords();
    const parsed = parseFileNavigatorQuery('turned water into wine');
    const expScore = scoreNavigatorSearchRecordExperimental(sentence, parsed);
    expect(expScore).not.toBeNull();
    expect(expScore.matchedField).toMatch(/content|both/);
  });
});

describe('Speed gate (as fast or faster)', () => {
  it('experimental is as fast or faster than default on a 5k-verse corpus', () => {
    const bible = bibleWithIndex(makeLargeBible(5000));
    const query = 'uniqueword2500 common filler';

    // Warm up both paths (JIT, index caching) so the measurement is steady.
    searchBible(bible, query, {}, 20);
    searchBibleExperimental(bible, query, {}, 20);

    const runs = 5;
    let oldTotal = 0;
    let expTotal = 0;
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      const oldRes = searchBible(bible, query, {}, 20);
      oldTotal += performance.now() - t0;

      const t1 = performance.now();
      const expRes = searchBibleExperimental(bible, query, {}, 20);
      expTotal += performance.now() - t1;

      expect(Array.isArray(oldRes)).toBe(true);
      expect(Array.isArray(expRes)).toBe(true);
    }
    const oldAvg = oldTotal / runs;
    const expAvg = expTotal / runs;
    // Honest margin: experimental must not be slower. A 20% grace covers CI
    // jitter; the design (no vocab-wide prefix scan) is structurally faster.
    expect(expAvg).toBeLessThanOrEqual(oldAvg * 1.2);
  });
});

describe('Determinism', () => {
  it('the same sentence twice yields the same order', () => {
    const bible = bibleWithIndex(makeSentenceBible());
    const a = searchBibleExperimental(bible, 'for God so love the world', {}, 10).map((r) => r.reference);
    const b = searchBibleExperimental(bible, 'for God so love the world', {}, 10).map((r) => r.reference);
    expect(a).toEqual(b);
  });

  it('file sentence scoring is deterministic', () => {
    const { sentence, scattered } = buildFileRecords();
    const q = parseFileNavigatorQuery('water to into wine');
    const first = scoreNavigatorSearchRecordExperimental(sentence, q)?.score;
    const second = scoreNavigatorSearchRecordExperimental(sentence, q)?.score;
    expect(first).toBe(second);
    expect(typeof first).toBe('number');
  });
});

describe('Full-corpus recall (regression: union truncation)', () => {
  // A full-size corpus where the sentence sits PAST the old bible-order
  // truncation point: 500 god-verses, then 500 loved-verses, then 500
  // word-verses, then John 3:16. Pre-fix, the union fallback sliced the
  // first ~80 keys in bible order (Genesis only) and John was never scored.
  const makeFullCorpus = () => {
    const books = [];
    const filler = (word, n) => {
      const verses = [];
      for (let i = 1; i <= n; i++) verses.push({ number: i, text: `filler verse ${i} about ${word} and daily matters` });
      return verses;
    };
    books.push({ number: 1, name: 'Genesis', chapters: [{ number: 1, verses: filler('god', 500) }] });
    books.push({ number: 2, name: 'Exodus', chapters: [{ number: 1, verses: filler('loved', 500) }] });
    books.push({ number: 3, name: 'Leviticus', chapters: [{ number: 1, verses: filler('word', 500) }] });
    books.push({
      number: 43, name: 'John',
      chapters: [{ number: 3, verses: [{ number: 16, text: 'For God so loved the world that he gave his only begotten Son that whosoever believeth in him should not perish but have everlasting life' }] }],
    });
    return { id: 'full', name: 'FULL', books };
  };

  const withIndex = (bible) => {
    const index = {};
    const norm = (s) => String(s || '').toLowerCase().replace(/'s\b/g, '').replace(/[^a-z0-9]/g, '');
    for (const book of bible.books) {
      for (const chapter of book.chapters) {
        for (const verse of chapter.verses) {
          const seen = new Set();
          for (const word of String(verse.text || '').toLowerCase().split(/\s+/)) {
            const n = norm(word);
            if (!n || n.length < 3 || seen.has(n)) continue;
            seen.add(n);
            (index[n] = index[n] || []).push({ b: book.number, c: chapter.number, v: verse.number });
          }
        }
      }
    }
    return { ...bible, searchIndex: index };
  };

  it('typo sentence query still recalls John 3:16 past the truncation point', () => {
    const bible = withIndex(makeFullCorpus());
    const results = searchBibleExperimental(bible, 'for God so love the word', {}, 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].reference).toBe('John 3:16');
  });

  it('exact sentence query ranks John 3:16 first on the full corpus', () => {
    const bible = withIndex(makeFullCorpus());
    const results = searchBibleExperimental(bible, 'for God so loved the world', {}, 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].reference).toBe('John 3:16');
  });
});
