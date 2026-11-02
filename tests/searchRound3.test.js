/**
 * ROUND 3 — structural guarantees + file-side typo battery (harder).
 *
 * R1 proved recall, R2 locked floors and edges. R3 locks INVARIANTS that
 * must hold structurally, not just empirically:
 *
 *  1. Phrase dominance: on a canon saturated with same-word-family
 *     distractors (every verse shares the query's rare words, none
 *     contiguously), the ONE verse containing the exact phrase ranks #1 —
 *     even buried at book 59 of 60.
 *  2. Ambiguity at scale: with a literal competitor present late in the
 *     canon, the literal still tops and the fuzzy sentence stays visible.
 *  3. File typo battery: one garbage term is tolerated (coverage gate);
 *     two garbage terms filter to null; content-search OFF still hides
 *     lyric bodies even for typo queries; title matching unaffected.
 *  4. Absolute budgets hold on the R3 canon too.
 *
 * A single failure = round < 10/10: fix, and the escape hardens R4.
 */
import { describe, it, expect } from 'vitest';
import { searchBibleExperimental } from 'shared/bible/index.js';
import {
  parseFileNavigatorQuery,
  prepareNavigatorSearchRecord,
  scoreNavigatorSearchRecordExperimental,
} from 'shared/fileNavigatorSearch.js';

function withIndex(bible) {
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
}

// Canon saturated with the query's own word family: 58 books of verses that
// each contain god+loved+world SCATTERED (never the phrase), then ONE exact
// phrase verse at book 59, then a literal-competitor book at 60.
function buildFamilyCanon() {
  const books = [];
  for (let b = 1; b <= 58; b++) {
    const verses = [];
    for (let i = 1; i <= 40; i++) {
      verses.push({
        number: i,
        text: `scattered note ${i}: the world knew god yet loved darkness more than light and truth`,
      });
    }
    books.push({ number: b, name: `Book${b}`, chapters: [{ number: 1, verses }] });
  }
  books.push({
    number: 59, name: 'John',
    chapters: [{ number: 3, verses: [
      { number: 16, text: 'For God so loved the world that he gave his only begotten Son' },
    ] }],
  });
  books.push({
    number: 60, name: 'Epilogue',
    chapters: [{ number: 1, verses: [
      // Literal competitor for the typo query: exact "love"+"word".
      { number: 1, text: 'And we write this that for god so love the word and keep it' },
    ] }],
  });
  return { id: 'fam', name: 'FAM', books };
}

describe('ROUND 3 phrase dominance at scale', () => {
  it('exact phrase buried at book 59 of 60 still ranks #1', () => {
    const bible = withIndex(buildFamilyCanon());
    const t0 = performance.now();
    const results = searchBibleExperimental(bible, 'for God so loved the world', {}, 10);
    const ms = performance.now() - t0;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].reference).toBe('John 3:16');
    // Regression guardrail, not a performance claim: adversarial-canon
    // worst case must stay interactive under parallel CI load. Real queries
    // on a 31k-verse KJV measure <10ms (see plan report for the table).
    expect(ms).toBeLessThan(150);
  });

  it('ambiguity at scale: literal tops, fuzzy sentence stays visible', () => {
    const bible = withIndex(buildFamilyCanon());
    const results = searchBibleExperimental(bible, 'for God so love the word', {}, 10);
    const refs = results.map((r) => r.reference);
    expect(refs[0]).toBe('Epilogue 1:1');
    expect(refs).toContain('John 3:16');
  });
});

describe('ROUND 3 file-side typo battery', () => {
  const sentenceRec = () => prepareNavigatorSearchRecord({
    filePath: '/songs/water-into-wine.txt',
    fileName: 'water-into-wine.txt',
    relativePath: 'songs/water-into-wine.txt',
    contentText: 'Jesus turned water into wine at the wedding in Cana of Galilee',
  });
  const noiseRec = () => prepareNavigatorSearchRecord({
    filePath: '/songs/other.txt',
    fileName: 'sunday-setlist.txt',
    relativePath: 'songs/sunday-setlist.txt',
    contentText: 'Opening prayer and welcome announcements for the service',
  });

  it('one garbage term tolerated: sentence file still tops', () => {
    const parsed = parseFileNavigatorQuery('turned water into wyn');
    const s = scoreNavigatorSearchRecordExperimental(sentenceRec(), parsed);
    const n = scoreNavigatorSearchRecordExperimental(noiseRec(), parsed);
    expect(s).not.toBeNull();
    expect(n === null || s.score > n.score).toBe(true);
  });

  it('two garbage terms filter to null (no OR sludge)', () => {
    const parsed = parseFileNavigatorQuery('watre into wyn');
    expect(scoreNavigatorSearchRecordExperimental(sentenceRec(), parsed)).toBeNull();
    expect(scoreNavigatorSearchRecordExperimental(noiseRec(), parsed)).toBeNull();
  });

  it('content-search OFF hides lyric bodies even for typo queries', () => {
    const lyricOnly = prepareNavigatorSearchRecord({
      filePath: '/songs/hidden.txt',
      fileName: 'zzz-unrelated-name.txt',
      relativePath: 'songs/zzz-unrelated-name.txt',
      contentText: 'turned water into wine at the wedding',
    });
    const parsed = parseFileNavigatorQuery('turned water into wyn');
    parsed.searchContent = false;
    expect(scoreNavigatorSearchRecordExperimental(lyricOnly, parsed)).toBeNull();
    const titleParsed = parseFileNavigatorQuery('water into wine');
    titleParsed.searchContent = false;
    expect(scoreNavigatorSearchRecordExperimental(sentenceRec(), titleParsed)).not.toBeNull();
  });

  it('exact file phrase still wins outright', () => {
    const parsed = parseFileNavigatorQuery('turned water into wine');
    const s = scoreNavigatorSearchRecordExperimental(sentenceRec(), parsed);
    expect(s).not.toBeNull();
    expect(s.matchedField).toMatch(/content|both/);
  });
});
