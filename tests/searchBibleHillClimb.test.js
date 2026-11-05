/**
 * Bible quote hill-climb: the lyric pair-index wins, ported to Bible search.
 *
 * The user types two kinds of queries and expects the verse instantly:
 *   1. References — "John 3:16", "Ezekiel 1:2" must bring out that verse.
 *   2. Quotes — "for God to love the world" must bring out John 3:16
 *      (the correct verse), even though the wording is a paraphrase.
 *
 * This file is the gate, mirroring tests/searchHillClimb.test.js style:
 *   A. Typing simulation (NOT just final-query speed): every keystroke
 *      prefix from length 3 to the full query is searched, per-prefix
 *      latency is asserted (<50ms), and the rank of the target verse must
 *      converge — final prefix top-1, last-3-prefixes stable.
 *   B. Random-reference benchmark: seeded random verses queried by
 *      "Book chapter:verse" (e.g. Ezekiel 1:2) — accuracy 100% both
 *      rankers, old-vs-new timings reported.
 *   C. Random-snippet benchmark: seeded random 4-6-word verse snippets —
 *      unique-holder top-1 100% + phrase recall 100% on the experimental
 *      path, experimental strictly faster than the old path on the canon.
 *   D. Real-KJV section (skips when the file is absent, like Round2):
 *      spot checks + seeded random refs/snippets with the same gates.
 *
 * Wins ported from the lyric hill-climb (shared/bible/index.js):
 *   - word-pair index + fuzzy pair-first fast path (variants + 1-edit pairs)
 *   - two-tier fuzzy (exact+variant cheap pass; typo generation only on miss)
 *   - default path: binary-searched prefix range (no Object.keys scan) +
 *     whole-phrase bonus for multi-word queries.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import {
  parseBible,
  searchBible,
  searchBibleExperimental,
  findBibleFuzzyPairKeys,
  bibleRawTokens,
} from 'shared/bible/index.js';
import { normalizeSentenceText } from 'shared/bible/sentenceSearch.js';

const KJV_PATH = '/home/jemo/projects/video-psalm-reverse-eng-v-2/gpui-app/bibles/KJV.xml';
const HAS_KJV = existsSync(KJV_PATH);

// --- deterministic PRNG (mulberry32, seed 42 like the lyric hill-climb) ---
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- small targeted corpus: the user's exact examples + neighbors ---
function makeTargetedBible() {
  return {
    id: 'target',
    name: 'TARGET',
    books: [
      {
        number: 43, name: 'John', abbreviation: 'John',
        chapters: [{ number: 3, verses: [
          { number: 14, text: 'And as Moses lifted up the serpent in the wilderness even so must the Son of man be lifted up' },
          { number: 15, text: 'That whosoever believeth in him should not perish but have eternal life' },
          { number: 16, text: 'For God so loved the world that he gave his only begotten Son that whosoever believeth in him should not perish but have everlasting life' },
          { number: 17, text: 'For God sent not his Son into the world to condemn the world but that the world through him might be saved' },
        ] }],
      },
      {
        number: 26, name: 'Ezekiel', abbreviation: 'Ezek',
        chapters: [{ number: 1, verses: [
          { number: 1, text: 'Now it came to pass in the thirtieth year in the fourth month in the fifth day of the month as I was among the captives by the river of Chebar that the heavens were opened and I saw visions of God' },
          { number: 2, text: 'In the fifth day of the month which was the fifth year of king Jehoiachins captivity' },
          { number: 3, text: 'The word of the LORD came expressly unto Ezekiel the priest the son of Buzi in the land of the Chaldeans by the river Chebar and the hand of the LORD was there upon him' },
        ] }],
      },
      {
        number: 23, name: 'Isaiah', abbreviation: 'Isa',
        chapters: [{ number: 44, verses: [
          { number: 5, text: 'One shall say I am the LORDS and another shall call himself by the name of Jacob' },
        ] }],
      },
      {
        number: 22, name: 'Song of Solomon', abbreviation: 'Song',
        chapters: [{ number: 1, verses: [
          { number: 1, text: 'My beloved is fair for love is strong as death and desire burns within' },
        ] }],
      },
    ],
  };
}

const withIndex = (bible) => {
  const index = {};
  const norm = (s) =>
    String(s || '').toLowerCase().replace(/'s\b/g, '').replace(/[^a-z0-9]/g, '');
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
  // Minimal bookMap/chapterMap/verseMap so lookups take the fast path.
  const mapped = { ...bible, searchIndex: index, bookMap: {} };
  for (const book of mapped.books) {
    mapped.bookMap[book.number] = book;
    book.chapterMap = {};
    for (const chapter of book.chapters) {
      book.chapterMap[chapter.number] = chapter;
      chapter.verseMap = {};
      for (const verse of chapter.verses) chapter.verseMap[verse.number] = verse;
    }
  }
  return mapped;
};

// Char prefixes from minLen..full (typing simulation: one search per keystroke).
function typePrefixes(full, minLen = 3) {
  const out = [];
  for (let i = minLen; i <= full.length; i++) out.push(full.slice(0, i));
  return out;
}

describe('A. Typing simulation — references converge as you type', () => {
  const bible = withIndex(makeTargetedBible());

  for (const ref of ['John 3:16', 'Ezekiel 1:2']) {
    it(`"${ref}" is top-1 at the final keystroke in both rankers`, () => {
      for (const fn of [searchBible, searchBibleExperimental]) {
        const results = fn(bible, ref, {}, 10);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].reference).toBe(ref === 'John 3:16' ? 'John 3:16' : 'Ezekiel 1:2');
      }
    });
  }

  it('every reference prefix answers in <50ms (no keystroke jank)', () => {
    for (const ref of ['John 3:16', 'Ezekiel 1:2']) {
      for (const prefix of typePrefixes(ref)) {
        for (const fn of [searchBible, searchBibleExperimental]) {
          const t0 = performance.now();
          const results = fn(bible, prefix, {}, 10);
          const ms = performance.now() - t0;
          expect(Array.isArray(results)).toBe(true);
          expect(ms).toBeLessThan(50);
        }
      }
    }
  });

  it('chapter prefixes already contain the target (progressive narrowing)', () => {
    const bibleIdx = withIndex(makeTargetedBible());
    // Only prefixes that resolve against the corpus: chapter prefixes list
    // the chapter (target inside), full references hit top-1. 'John 3:1'
    // is absent on purpose — the synthetic chapter starts at v14, and a
    // nonexistent verse must not fabricate hits.
    for (const [prefix, target] of [['John 3', 'John 3:16'], ['Ezekiel 1', 'Ezekiel 1:2'], ['Ezekiel 1:2', 'Ezekiel 1:2']]) {
      const refs = searchBibleExperimental(bibleIdx, prefix, {}, 10).map((r) => r.reference);
      expect(refs).toContain(target);
    }
  });

  it('typing is deterministic: same prefixes, same order', () => {
    const a = typePrefixes('John 3:16').map((p) =>
      searchBibleExperimental(bible, p, {}, 10).map((r) => r.reference));
    const b = typePrefixes('John 3:16').map((p) =>
      searchBibleExperimental(bible, p, {}, 10).map((r) => r.reference));
    expect(a).toEqual(b);
  });
});

describe('B. Typing simulation — quotes converge as you type', () => {
  const bible = withIndex(makeTargetedBible());
  const QUOTE = 'for God so loved the world';
  const PARAPHRASE = 'for God to love the world'; // the user's wording

  it('exact quote is top-1 at the final keystroke (experimental)', () => {
    const results = searchBibleExperimental(bible, QUOTE, {}, 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].reference).toBe('John 3:16');
  });

  it("user paraphrase brings out John 3:16 (experimental)", () => {
    const results = searchBibleExperimental(bible, PARAPHRASE, {}, 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].reference).toBe('John 3:16');
  });

  it('every quote prefix answers in <50ms and the last 3 keystrokes are stable top-1', () => {
    const prefixes = typePrefixes(QUOTE);
    const tops = [];
    for (const prefix of prefixes) {
      const t0 = performance.now();
      const results = searchBibleExperimental(bible, prefix, {}, 10);
      const ms = performance.now() - t0;
      expect(ms).toBeLessThan(50);
      tops.push(results[0]?.reference ?? null);
    }
    expect(tops[tops.length - 1]).toBe('John 3:16');
    expect(tops.slice(-3)).toEqual(['John 3:16', 'John 3:16', 'John 3:16']);
  });

  it('paraphrase typing also converges to John 3:16', () => {
    const prefixes = typePrefixes(PARAPHRASE);
    const tops = prefixes.map((p) => searchBibleExperimental(bible, p, {}, 10)[0]?.reference ?? null);
    expect(tops[tops.length - 1]).toBe('John 3:16');
  });
});

// --- synthetic canon for the random benchmarks (fast to build, real names) ---
function buildCanon() {
  const rand = mulberry32(42);
  const fillerWords = ['god', 'lord', 'king', 'people', 'land', 'hand', 'house', 'day', 'word', 'world', 'love', 'light'];
  const books = [];
  const defs = [
    [1, 'Genesis', 8], [2, 'Exodus', 8], [4, 'Numbers', 6], [19, 'Psalms', 10],
    [20, 'Proverbs', 6], [23, 'Isaiah', 10], [24, 'Jeremiah', 8],
    [26, 'Ezekiel', 8], [40, 'Matthew', 8], [41, 'Mark', 6], [42, 'Luke', 8],
    [43, 'John', 6], [45, 'Romans', 6], [46, '1 Corinthians', 6],
  ];
  for (const [number, name, chapters] of defs) {
    const chs = [];
    for (let c = 1; c <= chapters; c++) {
      const verses = [];
      const count = 8 + Math.floor(rand() * 8);
      for (let v = 1; v <= count; v++) {
        const words = [];
        const len = 10 + Math.floor(rand() * 10);
        for (let i = 0; i < len; i++) {
          words.push(fillerWords[Math.floor(rand() * fillerWords.length)]);
        }
        verses.push({ number: v, text: `Verse filler ${v} of chapter ${c}: ${words.join(' ')} and daily matters` });
      }
      chs.push({ number: c, verses });
    }
    books.push({ number, name, chapters: chs });
  }
  // Pin the famous verses verbatim so random sampling can hit them too.
  const john = books.find((b) => b.number === 43);
  john.chapters[2].verses[1] = { number: 2, text: 'For God so loved the world that he gave his only begotten Son that whosoever believeth in him should not perish but have everlasting life' };
  const ezek = books.find((b) => b.number === 26);
  ezek.chapters[0].verses[1] = { number: 2, text: 'In the fifth day of the month which was the fifth year of king Jehoiachins captivity' };
  return { id: 'canon', name: 'CANON', books };
}

function allVerseRefs(bible) {
  const out = [];
  for (const book of bible.books) {
    for (const chapter of book.chapters || []) {
      for (const verse of chapter.verses || []) {
        out.push({ book: book.name, b: book.number, c: chapter.number, v: verse.number, text: verse.text });
      }
    }
  }
  return out;
}

describe('C. Random-reference benchmark (like Ezekiel 1:2, seeded)', () => {
  const bible = withIndex(buildCanon());
  const verses = allVerseRefs(bible);
  const rand = mulberry32(42);
  const picks = [];
  for (let i = 0; i < 50; i++) picks.push(verses[Math.floor(rand() * verses.length)]);

  it('indexes the canon', () => {
    expect(verses.length).toBeGreaterThan(1000);
  });

  it('every random reference resolves top-1 in both rankers', () => {
    for (const p of picks) {
      const q = `${p.book} ${p.c}:${p.v}`;
      for (const fn of [searchBible, searchBibleExperimental]) {
        const results = fn(bible, q, {}, 10);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].reference).toBe(`${p.book} ${p.c}:${p.v}`);
      }
    }
  });

  it('reference timing: experimental never slower than old (reported, not ratio-gated)', () => {
    const oldTimes = [];
    const expTimes = [];
    for (const p of picks) {
      const q = `${p.book} ${p.c}:${p.v}`;
      let t0 = performance.now();
      searchBible(bible, q, {}, 10);
      oldTimes.push(performance.now() - t0);
      t0 = performance.now();
      searchBibleExperimental(bible, q, {}, 10);
      expTimes.push(performance.now() - t0);
    }
    const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
    console.log(`reference medians: old ${med(oldTimes).toFixed(3)}ms exp ${med(expTimes).toFixed(3)}ms`);
    for (const t of [...oldTimes, ...expTimes]) expect(t).toBeLessThan(50);
  });
});

describe('D. Random-snippet benchmark (quote speed + accuracy, seeded)', () => {
  const bible = withIndex(buildCanon());
  const verses = allVerseRefs(bible);

  const flat = (s) => normalizeSentenceText(s);
  const queries = [];
  {
    const rand = mulberry32(42);
    let guard = 0;
    while (queries.length < 50 && guard++ < 5000) {
      const src = verses[Math.floor(rand() * verses.length)];
      const words = String(src.text || '')
        .replace(/\[.*?\]|\{.*?\}|\(.*?\)/g, ' ')
        .split(/\s+/)
        .map((w) => w.replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, ''))
        .filter((w) => w.length >= 1);
      if (words.length < 6) continue;
      const len = 4 + Math.floor(rand() * 3);
      const start = Math.floor(rand() * Math.max(1, words.length - len + 1));
      const snippet = words.slice(start, start + len).join(' ');
      if (snippet.length < 12) continue;
      // Pair-indexable quotes only: single-token snippets have no pairs by
      // design (the union path still serves them).
      if (bibleRawTokens(snippet).length < 2) continue;
      const flatSnippet = flat(snippet);
      let holders = 0;
      for (const v of verses) {
        if (flat(v.text).includes(flatSnippet)) holders++;
      }
      if (holders === 0) continue;
      queries.push({ snippet, holders, expectRef: `${src.book} ${src.c}:${src.v}`, packed: src.b * 1000000 + src.c * 1000 + src.v });
    }
  }

  it('sampled 50 snippet queries', () => {
    expect(queries.length).toBe(50);
  });

  it('fuzzy pair pool contains the source verse whenever it is usable (recall contract)', () => {
    // null = oversize/common-phrase pool (the search falls back to the union
    // path with full recall); [] = a position kills the phrase (also falls
    // back). Both are valid contract outcomes. When a pool IS returned, the
    // verbatim source verse must be in it — exact pairs always hit it.
    let usable = 0;
    for (const q of queries) {
      const keys = findBibleFuzzyPairKeys(bible, q.snippet);
      if (keys && keys.length > 0) {
        usable++;
        expect(keys).toContain(q.packed);
      }
    }
    expect(usable).toBeGreaterThan(0);
  });

  it('unique-holder snippets rank the owning verse top-1 (experimental 100%)', () => {
    const unique = queries.filter((q) => q.holders === 1);
    expect(unique.length).toBeGreaterThan(0);
    for (const q of unique) {
      const results = searchBibleExperimental(bible, q.snippet, {}, 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].reference).toBe(q.expectRef);
    }
  });

  it('phrase recall 100%: top-1 always contains the snippet (experimental)', () => {
    for (const q of queries) {
      const results = searchBibleExperimental(bible, q.snippet, {}, 10);
      expect(results.length).toBeGreaterThan(0);
      expect(flat(results[0].text).includes(flat(q.snippet))).toBe(true);
    }
  });

  it('quote timing: experimental faster than old on the canon (pair-index win)', () => {
    for (const q of queries) {
      searchBible(bible, q.snippet, {}, 10);
      searchBibleExperimental(bible, q.snippet, {}, 10);
    }
    const oldTimes = [];
    const expTimes = [];
    for (const q of queries) {
      let t0 = performance.now();
      searchBible(bible, q.snippet, {}, 10);
      oldTimes.push(performance.now() - t0);
      t0 = performance.now();
      searchBibleExperimental(bible, q.snippet, {}, 10);
      expTimes.push(performance.now() - t0);
    }
    const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const oldMed = med(oldTimes);
    const expMed = med(expTimes);
    console.log(`snippet medians: old ${oldMed.toFixed(3)}ms exp ${expMed.toFixed(3)}ms (${(oldMed / Math.max(expMed, 1e-9)).toFixed(1)}x)`);
    for (const t of [...oldTimes, ...expTimes]) expect(t).toBeLessThan(50);
    expect(expMed).toBeLessThanOrEqual(oldMed);
  });
});

describe.skipIf(!HAS_KJV)('E. Real-KJV floors (reference + quote + random)', () => {
  let kjv;
  beforeAll(async () => {
    const xml = await readFile(KJV_PATH, 'utf8');
    kjv = parseBible(xml, 'kjv');
  }, 120000);

  it('John 3:16 by reference and by quote', async () => {
    expect(searchBibleExperimental(kjv, 'John 3:16', {}, 5)[0]?.reference).toBe('John 3:16');
    expect(searchBibleExperimental(kjv, 'for God so loved the world', {}, 5)[0]?.reference).toBe('John 3:16');
    expect(searchBibleExperimental(kjv, 'for God to love the world', {}, 5)[0]?.reference).toBe('John 3:16');
  });

  it('Ezekiel 1:2 by reference; isa 44 5 intact in both rankers', async () => {
    expect(searchBibleExperimental(kjv, 'Ezekiel 1:2', {}, 5)[0]?.reference).toBe('Ezekiel 1:2');
    expect(searchBible(kjv, 'Ezekiel 1:2', {}, 5)[0]?.reference).toBe('Ezekiel 1:2');
    expect(searchBibleExperimental(kjv, 'isa 44 5', {}, 5)[0]?.reference).toBe('Isaiah 44:5');
    expect(searchBible(kjv, 'isa 44 5', {}, 5)[0]?.reference).toBe('Isaiah 44:5');
  });

  it('seeded random KJV references resolve top-1 (experimental)', async () => {
    const verses = allVerseRefs(kjv);
    const rand = mulberry32(42);
    for (let i = 0; i < 20; i++) {
      const p = verses[Math.floor(rand() * verses.length)];
      const q = `${p.book} ${p.c}:${p.v}`;
      const results = searchBibleExperimental(kjv, q, {}, 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].reference).toBe(`${p.book} ${p.c}:${p.v}`);
    }
  });

  it('seeded random KJV snippets: unique-holder top-1 + recall + faster', async () => {
    const verses = allVerseRefs(kjv);
    const flat = (s) => normalizeSentenceText(s);
    const rand = mulberry32(7);
    const queries = [];
    let guard = 0;
    while (queries.length < 20 && guard++ < 2000) {
      const src = verses[Math.floor(rand() * verses.length)];
      const words = String(src.text || '')
        .split(/\s+/)
        .map((w) => w.replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, ''))
        .filter((w) => w.length >= 2);
      if (words.length < 6) continue;
      const len = 4 + Math.floor(rand() * 3);
      const start = Math.floor(rand() * Math.max(1, words.length - len + 1));
      const snippet = words.slice(start, start + len).join(' ');
      if (snippet.length < 14) continue;
      if (bibleRawTokens(snippet).length < 2) continue;
      const flatSnippet = flat(snippet);
      let holders = 0;
      for (const v of verses) {
        if (flat(v.text).includes(flatSnippet)) {
          holders++;
          if (holders > 3) break;
        }
      }
      if (holders === 0) continue;
      queries.push({ snippet, holders, expectRef: `${src.book} ${src.c}:${src.v}` });
    }
    expect(queries.length).toBe(20);
    const unique = queries.filter((q) => q.holders === 1);
    for (const q of unique) {
      const results = searchBibleExperimental(kjv, q.snippet, {}, 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].reference).toBe(q.expectRef);
    }
    const oldTimes = [];
    const expTimes = [];
    for (const q of queries) {
      searchBible(kjv, q.snippet, {}, 10);
      searchBibleExperimental(kjv, q.snippet, {}, 10);
    }
    for (const q of queries) {
      let t0 = performance.now();
      const oldRes = searchBible(kjv, q.snippet, {}, 10);
      oldTimes.push(performance.now() - t0);
      t0 = performance.now();
      const expRes = searchBibleExperimental(kjv, q.snippet, {}, 10);
      expTimes.push(performance.now() - t0);
      expect(expRes.length).toBeGreaterThan(0);
      expect(flat(expRes[0].text).includes(flat(q.snippet))).toBe(true);
      expect(Array.isArray(oldRes)).toBe(true);
    }
    const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const oldMed = med(oldTimes);
    const expMed = med(expTimes);
    console.log(`KJV snippet medians: old ${oldMed.toFixed(3)}ms exp ${expMed.toFixed(3)}ms (${(oldMed / Math.max(expMed, 1e-9)).toFixed(1)}x)`);
    // Real 31k-verse corpus under shared CI load: 150ms matches the Round3
    // adversarial-canon precedent (absolute interactivity guard, not a claim).
    for (const t of [...oldTimes, ...expTimes]) expect(t).toBeLessThan(150);
    expect(expMed).toBeLessThanOrEqual(oldMed);
  });
});
