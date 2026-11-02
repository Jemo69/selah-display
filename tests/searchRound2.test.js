/**
 * ROUND 2 — harder adversarial battery (independent DeepSeek V4.1 R1 review
 * follow-ups + invented edge cases). Two layers:
 *
 * LAYER A (real-KJV-gated, skips when the file is absent): the reviewer's
 * exact failing queries with the achieved floors locked in. These run on
 * THIS machine (tests/searchRealKjv.local.test.js is gitignored... no —
 * it is committed with a skipIf guard so CI never depends on it).
 * LAYER B (synthetic, always run): edge battery — stopword-only, empty,
 * case/punct, single rare word, leading-book, bare book, famous one-liners.
 *
 * Scoring: every test is a MUST-pass. A single failure = round < 10/10,
 * fix it, and the escape becomes a permanent harder check (R3).
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { parseBible, searchBible, searchBibleExperimental } from 'shared/bible/index.js';

const KJV_PATH = '/home/jemo/projects/video-psalm-reverse-eng-v-2/gpui-app/bibles/KJV.xml';
const HAS_KJV = existsSync(KJV_PATH);

async function loadKjv() {
  const xml = await readFile(KJV_PATH, 'utf8');
  return parseBible(xml, 'kjv');
}

describe.skipIf(!HAS_KJV)('ROUND 2A real-KJV floors (independent review queries)', () => {
  it('water sentence: John 2:9 visible in top 10 (was rank 41/absent)', async () => {
    const kjv = await loadKjv();
    const refs = searchBibleExperimental(kjv, 'water to into wine', {}, 10).map((r) => r.reference);
    expect(refs).toContain('John 2:9');
  });

  it('typo on rare term: Romans 8:31 recalled from "aginst"', async () => {
    const kjv = await loadKjv();
    const refs = searchBibleExperimental(kjv, 'if god be for us who can be aginst us', {}, 10).map((r) => r.reference);
    expect(refs).toContain('Romans 8:31');
  });

  it('split compound: "evrything" puts 1 Thess 5:18 first', async () => {
    const kjv = await loadKjv();
    const results = searchBibleExperimental(kjv, 'in evrything give thanks', {}, 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].reference).toBe('1 Thessalonians 5:18');
  });

  it('policy lock: literal 2:15 first, John 3:16 visible', async () => {
    const kjv = await loadKjv();
    const refs = searchBibleExperimental(kjv, 'so love the world that', {}, 10).map((r) => r.reference);
    expect(refs[0]).toBe('1 John 2:15');
    expect(refs).toContain('John 3:16');
  });

  it('typo word->world: John 3:16 first', async () => {
    const kjv = await loadKjv();
    const results = searchBibleExperimental(kjv, 'for God so loved the word', {}, 10);
    expect(results[0]?.reference).toBe('John 3:16');
  });

  it('exact sentence always #1; reference intact', async () => {
    const kjv = await loadKjv();
    expect(searchBibleExperimental(kjv, 'for God so loved the world', {}, 10)[0]?.reference).toBe('John 3:16');
    const ref = searchBibleExperimental(kjv, 'isa 44 5', {}, 10);
    expect(ref[0]?.reference).toBe('Isaiah 44:5');
    // Old path agrees on references (control, not gated).
    expect(searchBible(kjv, 'isa 44 5', {}, 10)[0]?.reference).toBe('Isaiah 44:5');
  });
});

describe('ROUND 2B edge battery (synthetic, always run)', () => {
  const canon = () => ({
    id: 'edge', name: 'EDGE',
    books: [
      { number: 1, name: 'Genesis', chapters: [{ number: 1, verses: [
        { number: 1, text: 'In the beginning God created the heaven and the earth' },
        { number: 4, text: 'And God saw the light that it was good' },
      ] }] },
      { number: 19, name: 'Psalms', chapters: [{ number: 23, verses: [
        { number: 1, text: 'The LORD is my shepherd I shall not want' },
      ] }] },
      { number: 40, name: 'Matthew', chapters: [{ number: 28, verses: [
        { number: 3, text: 'His countenance was like lightning and his raiment white as snow' },
      ] }] },
      { number: 43, name: 'John', chapters: [{ number: 11, verses: [
        { number: 35, text: 'Jesus wept' },
      ] }, { number: 3, verses: [
        { number: 16, text: 'For God so loved the world that he gave his only begotten Son' },
      ] }] },
      { number: 62, name: '1 John', chapters: [{ number: 1, verses: [
        { number: 5, text: 'God is light and in him is no darkness at all' },
      ] }] },
    ],
  });

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

  const cases = [
    ['god is light', '1 John 1:5'],
    ['white as snow', 'Matthew 28:3'],
    ['the lord is my shepherd', 'Psalms 23:1'],
    ['jesus wept', 'John 11:35'],
    ['FOR GOD SO LOVED THE WORLD!!!', 'John 3:16'],
    ['John love', 'John 3:16'],
  ];

  for (const [q, want] of cases) {
    it(`edge ${JSON.stringify(q)} -> ${want} first`, () => {
      const results = searchBibleExperimental(withIndex(canon()), q, {}, 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].reference).toBe(want);
    });
  }

  it('stopword-only query returns nothing (no crash, no garbage)', () => {
    expect(searchBibleExperimental(withIndex(canon()), 'the and of to', {}, 10)).toEqual([]);
  });

  it('empty / whitespace query returns nothing', () => {
    const b = withIndex(canon());
    expect(searchBibleExperimental(b, '', {}, 10)).toEqual([]);
    expect(searchBibleExperimental(b, '   ', {}, 10)).toEqual([]);
  });

  it('bare book name is not a search', () => {
    expect(searchBibleExperimental(withIndex(canon()), 'John', {}, 10)).toEqual([]);
  });

  it('leading exact book scopes the whole pool ("John love" stays in John)', () => {
    const results = searchBibleExperimental(withIndex(canon()), 'John love', {}, 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.book === 43)).toBe(true);
  });

  it('single rare word still recalls', () => {
    const results = searchBibleExperimental(withIndex(canon()), 'shepherd', {}, 10);
    expect(results.some((r) => r.reference === 'Psalms 23:1')).toBe(true);
  });
});
