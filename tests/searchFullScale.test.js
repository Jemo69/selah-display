/**
 * ROUND 1 — harsh full-scale dogfood (user's exact failing queries).
 *
 * The user's screenshots show the sidebar search returning Song-of-Solomon
 * verses for sentence queries on a FULL Bible. Toy corpora (10–1500 verses)
 * cannot reproduce full-corpus recall cliffs, so this file builds a ~31k
 * verse canon in canonical order with realistic distractor distributions:
 * god-heavy early books, a love/beloved Song-like cluster at book 22
 * (mirroring the user's screenshots), word/world-heavy middle books, and
 * John 3:16 at book 43.
 *
 * Gate: searchBibleExperimental must rank John 3:16 FIRST for all three
 * user queries (typo, exact-phrase, stopword-led). searchBible (old) is the
 * control — recorded, not gated.
 */
import { describe, it, expect } from 'vitest';
import { searchBible, searchBibleExperimental } from 'shared/bible/index.js';

function buildFullCanon() {
  const books = [];
  let n = 0;
  const fillerBook = (number, name, verses) => {
    books.push({ number, name, chapters: [{ number: 1, verses }] });
  };
  const filler = (word, count, extra = '') => {
    const verses = [];
    for (let i = 1; i <= count; i++) {
      n += 1;
      verses.push({ number: n, text: `filler verse ${n} about ${word} and daily matters ${extra}`.trim() });
    }
    return verses;
  };

  // Books 1-21: god-heavy early canon (~400 each).
  for (let b = 1; b <= 21; b++) fillerBook(b, `Book${b}`, filler('god', 400));
  // Book 22: Song-like love/beloved cluster (the user's screenshot distractors).
  const song = [];
  for (let i = 1; i <= 300; i++) {
    n += 1;
    song.push({ number: n, text: `my beloved is fair for love is strong as death session ${n} of love and desire` });
  }
  fillerBook(22, 'Song', song);
  // Books 23-42: alternating word/world-heavy (~700 each).
  for (let b = 23; b <= 42; b++) fillerBook(b, `Book${b}`, filler(b % 2 ? 'word' : 'world', 700));
  // Book 43: John with 3:16 + neighbors (chapter 3, so references read John 3:16).
  books.push({ number: 43, name: 'John', chapters: [{ number: 3, verses: [
    { number: 14, text: 'And as Moses lifted up the serpent in the wilderness even so must the Son of man be lifted up' },
    { number: 15, text: 'That whosoever believeth in him should not perish but have eternal life' },
    { number: 16, text: 'For God so loved the world that he gave his only begotten Son that whosoever believeth in him should not perish but have everlasting life' },
    { number: 17, text: 'For God sent not his Son into the world to condemn the world but that the world through him might be saved' },
  ] }] });
  // Books 44-60: trailing god/world mix (~500 each) so John is NOT at the end.
  for (let b = 44; b <= 60; b++) fillerBook(b, `Book${b}`, filler(b % 2 ? 'god' : 'world', 500));

  const total = books.reduce((t, bk) => t + bk.chapters[0].verses.length, 0);
  return { bible: { id: 'canon', name: 'CANON', books }, total };
}

function indexBible(bible) {
  const index = {};
  const norm = (s) => String(s || '').toLowerCase().replace(/'s\b/g, '').replace(/[^a-z0-9]/g, '');
  for (const book of bible.books) {
    for (const chapter of book.chapters) {
      for (const verse of chapter.verses) {
        const seen = new Set();
        for (const word of String(verse.text || '').toLowerCase().split(/\s+/)) {
          const key = norm(word);
          if (!key || key.length < 3 || seen.has(key)) continue;
          seen.add(key);
          (index[key] = index[key] || []).push({ b: book.number, c: chapter.number, v: verse.number });
        }
      }
    }
  }
  return { ...bible, searchIndex: index };
}

const QUERIES = [
  'so love the world that',      // user's screenshot query (stopword-led, exact words)
  'for God so loved the word',    // user's typo query (word != world)
  'for God so loved the world',   // exact sentence
];

describe('ROUND 1 full-scale: experimental tops John 3:16 on user queries', () => {
  it('indexes a ~31k verse canon', () => {
    const { total } = buildFullCanon();
    expect(total).toBeGreaterThan(30000);
  });

  for (const q of QUERIES) {
    it(`experimental ranks John 3:16 first for ${JSON.stringify(q)}`, () => {
      const { bible } = buildFullCanon();
      const indexed = indexBible(bible);
      const results = searchBibleExperimental(indexed, q, {}, 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].reference).toBe('John 3:16');
    });
  }

  it('control: records what the old ranker does (not gated)', () => {
    const { bible } = buildFullCanon();
    const indexed = indexBible(bible);
    for (const q of QUERIES) {
      const results = searchBible(indexed, q, {}, 10);
      console.log(`OLD ranker top for ${JSON.stringify(q)}:`, results[0]?.reference ?? '(none)', `(${results.length} hits)`);
      expect(Array.isArray(results)).toBe(true);
    }
  });

  it('speed: experimental stays within budget on the full canon', () => {
    const { bible } = buildFullCanon();
    const indexed = indexBible(bible);
    const q = 'for God so loved the world';
    searchBible(indexed, q, {}, 20);
    searchBibleExperimental(indexed, q, {}, 20);
    let oldT = 0;
    let expT = 0;
    for (let i = 0; i < 3; i++) {
      let t = performance.now();
      searchBible(indexed, q, {}, 20);
      oldT += performance.now() - t;
      t = performance.now();
      searchBibleExperimental(indexed, q, {}, 20);
      expT += performance.now() - t;
    }
    console.log(`full-canon avg ms — old: ${(oldT / 3).toFixed(2)} exp: ${(expT / 3).toFixed(2)}`);
    expect(expT / 3).toBeLessThanOrEqual((oldT / 3) * 1.5 + 5);
  });
});
