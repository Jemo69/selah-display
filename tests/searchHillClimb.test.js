/**
 * Lyric-snippet hill-climb benchmark (seeded, deterministic).
 *
 * Corpus: out/lyrics-hill-climb-folder (447 txt, Easy-worship/FreeShow/Selah).
 * It is test-only data and gitignored — this suite SKIPS when the folder is
 * absent (CI), mirroring tests/searchRound2.test.js's KJV skip pattern.
 *
 * Method: 100 random 4-6-word lyric snippets (seed 42) as queries against
 * shared/fileNavigatorSearch.js scoring + shared/navigatorTokenIndex.js
 * pruning, mirroring main/fileNavigator.js searchFileNavigator (two-tier:
 * cheap pass → fuzzy pass on miss → full-scan fallback).
 *
 * Gates:
 *  - unique-phrase queries (flat phrase held by exactly 1 file) rank the
 *    owning content group first, 100%;
 *  - top-1 always contains the query phrase (phrase recall 100%);
 *  - indexed two-tier search is >=4x faster than same-run brute-force full
 *    fuzzy scan (target ~5x vs the 4.6ms/query parent baseline, <1ms avg).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  flattenNavigatorSearchText,
  parseFileNavigatorQuery,
  prepareNavigatorSearchRecord,
  scoreNavigatorSearchRecord,
} from 'shared/fileNavigatorSearch.js';
import { createNavigatorTokenIndex, extractNavigatorSearchTokens } from 'shared/navigatorTokenIndex.js';

const CORPUS_DIR = path.resolve(process.cwd(), 'out/lyrics-hill-climb-folder');
const HAS_CORPUS = existsSync(CORPUS_DIR);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.txt$/i.test(full)) out.push(full);
  }
  return out;
}

let records = [];
let byKey = new Map();
let contentHash = new Map();
let index = null;
let queries = [];

function buildFixtures() {
  const files = walk(CORPUS_DIR);
  records = files.map((filePath) => {
    const content = readFileSync(filePath, 'utf8');
    return prepareNavigatorSearchRecord({
      filePath,
      rootPath: CORPUS_DIR,
      fileName: path.basename(filePath),
      fileType: 'txt',
      relativePath: path.relative(CORPUS_DIR, filePath),
      parentPath: path.dirname(filePath),
      size: content.length,
      modifiedMs: 0,
      contentText: content,
    });
  });
  byKey = new Map(records.map((r) => [r.filePath, r]));
  contentHash = new Map();
  for (const r of records) {
    const h = crypto
      .createHash('md5')
      .update(String(r.normalizedContentFlat || '').replace(/\s+/g, ' ').trim())
      .digest('hex')
      .slice(0, 12);
    contentHash.set(r.filePath, h);
  }
  index = createNavigatorTokenIndex();
  for (const r of records) index.indexRecordTokens(r);

  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let guard = 0;
  while (queries.length < 100 && guard++ < 5000) {
    const idx = Math.floor(rand() * records.length);
    const rec = records[idx];
    const lines = String(rec.contentText || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(
        (s) =>
          s.length >= 20 &&
          !/^[#{\[<]/.test(s) &&
          !/^(title|key|capo|tempo|time|feel|tag|ccli|author|copyright)/i.test(s)
      );
    if (!lines.length) continue;
    const line = lines[Math.floor(rand() * lines.length)];
    const words = line
      .replace(/\[.*?\]|\{.*?\}|\(.*?\)/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, ''))
      .filter((w) => w.length >= 1);
    if (words.length < 4) continue;
    const len = 4 + Math.floor(rand() * 3);
    const start = Math.floor(rand() * Math.max(1, words.length - len + 1));
    const snippet = words.slice(start, start + len).join(' ');
    if (snippet.length < 12) continue;
    const flat = flattenNavigatorSearchText(parseFileNavigatorQuery(snippet).phrase);
    let holders = 0;
    for (const r of records) {
      if (r.normalizedContentFlat && r.normalizedContentFlat.includes(flat)) holders++;
    }
    queries.push({ idx, snippet, holders, expectHash: contentHash.get(rec.filePath) });
  }
}

// Mirrors main/fileNavigator.js searchFileNavigator: phrase-pair candidates
// first (>=3 terms), unigram fallback, cheap pass first, fuzzy pass only on
// cheap miss, full-scan fallback.
function indexedSearch(snippet, limit = 80) {
  const parsed = parseFileNavigatorQuery(snippet);
  parsed.searchContent = true;
  const scored = [];
  let candidateKeys = null;
  if (parsed.terms.length >= 3) {
    candidateKeys = index.findPhraseCandidateKeys(parsed.terms);
  }
  if (!candidateKeys || candidateKeys.size === 0) {
    candidateKeys = index.findCandidateKeys(parsed.terms);
  }
  const scoreWith = (rec, fuzzy) => scoreNavigatorSearchRecord(rec, parsed, { fuzzy });
  if (candidateKeys && candidateKeys.size > 0) {
    for (const key of candidateKeys) {
      const rec = byKey.get(key);
      if (!rec) continue;
      const m = scoreWith(rec, false);
      if (m) scored.push({ rec, score: m.score });
    }
    if (scored.length === 0) {
      for (const key of candidateKeys) {
        const rec = byKey.get(key);
        if (!rec) continue;
        const m = scoreWith(rec, true);
        if (m) scored.push({ rec, score: m.score });
      }
    }
  }
  if (scored.length === 0) {
    for (const rec of records) {
      const m = scoreWith(rec, true);
      if (m) scored.push({ rec, score: m.score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

describe.skipIf(!HAS_CORPUS)('lyric snippet hill-climb (seed 42, 100 queries)', () => {
  beforeAll(() => {
    buildFixtures();
    expect(records.length).toBeGreaterThan(400);
    expect(queries.length).toBe(100);
    // Warmup: V8 optimize the hot scorer (production main process is
    // long-lived; first-call compile cost is not per-keystroke cost).
    for (const q of queries) indexedSearch(q.snippet);
  });

  it('unique lyric phrases rank the owning content group first (100%)', () => {
    const unique = queries.filter((q) => q.holders === 1);
    expect(unique.length).toBeGreaterThan(15);
    for (const q of unique) {
      const scored = indexedSearch(q.snippet);
      const groupRank = scored.findIndex((s) => contentHash.get(s.rec.filePath) === q.expectHash);
      expect(
        groupRank,
        `unique snippet ${JSON.stringify(q.snippet)} expected group rank 0, got ${groupRank}`
      ).toBe(0);
    }
  });

  it('top-1 always contains the query phrase (phrase recall 100%)', () => {
    for (const q of queries) {
      const scored = indexedSearch(q.snippet);
      expect(scored.length).toBeGreaterThan(0);
      const flatQ = flattenNavigatorSearchText(parseFileNavigatorQuery(q.snippet).phrase);
      expect(
        scored[0].rec.normalizedContentFlat.includes(flatQ),
        `top-1 for ${JSON.stringify(q.snippet)} should contain the phrase`
      ).toBe(true);
    }
  });

  it('indexed two-tier search is >=4x faster than brute-force full scan', () => {
    const brute = (snippet) => {
      const parsed = parseFileNavigatorQuery(snippet);
      parsed.searchContent = true;
      const scored = [];
      for (const rec of records) {
        const m = scoreNavigatorSearchRecord(rec, parsed, { fuzzy: true });
        if (m) scored.push({ rec, score: m.score });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored;
    };
    for (const q of queries) brute(q.snippet); // warmup both paths
    const tIndexedStart = performance.now();
    for (const q of queries) indexedSearch(q.snippet);
    const indexedMs = performance.now() - tIndexedStart;
    const tBruteStart = performance.now();
    for (const q of queries) brute(q.snippet);
    const bruteMs = performance.now() - tBruteStart;
    const speedup = bruteMs / Math.max(0.01, indexedMs);
    console.log(
      `hill-climb timing: indexed ${(indexedMs / queries.length).toFixed(2)}ms/query, ` +
        `brute ${(bruteMs / queries.length).toFixed(2)}ms/query, speedup ${speedup.toFixed(2)}x`
    );
    expect(speedup).toBeGreaterThanOrEqual(4);
    expect(indexedMs / queries.length).toBeLessThan(1.5);
  });

  it('typo queries still recall via the fuzzy fallback tier', () => {
    // Find a long token unique to one file, then typo it (delete a middle char).
    let holder = null;
    let typo = null;
    for (const [token, keys] of index.tokenIndex) {
      if (token.length >= 7 && keys.size === 1) {
        typo = token.slice(0, 3) + token.slice(4);
        holder = [...keys][0];
        break;
      }
    }
    expect(holder).not.toBeNull();
    const scored = indexedSearch(typo);
    expect(scored.length).toBeGreaterThan(0);
    expect(scored.slice(0, 10).some((s) => s.rec.filePath === holder)).toBe(true);
  });

  it('repeated snippet searches are deterministic', () => {
    const q = queries[0].snippet;
    const first = indexedSearch(q).map((s) => s.rec.filePath);
    const second = indexedSearch(q).map((s) => s.rec.filePath);
    expect(first).toEqual(second);
  });

  it('phrase-pair candidates are a tight superset of the token-stream holders', () => {
    // Recall contract: every file whose extracted token stream contains the
    // query tokens adjacently (in stem or content) must be in the pair set,
    // and the pair set must be much smaller than the unigram set.
    // NOTE: raw flat-substring "holders" are NOT the contract — flat
    // includes() also matches mid-word fragments ("eyes you are the"
    // contains "yes you are the"), which the word-based pair index
    // correctly excludes.
    const streamOf = (text) => extractNavigatorSearchTokens(text);
    const containsContiguous = (hay, needle) => {
      if (needle.length === 0) return false;
      outer: for (let i = 0; i + needle.length <= hay.length; i++) {
        for (let j = 0; j < needle.length; j++) {
          if (hay[i + j] !== needle[j]) continue outer;
        }
        return true;
      }
      return false;
    };
    let pairTotal = 0;
    let uniTotal = 0;
    let checked = 0;
    for (const q of queries) {
      const parsed = parseFileNavigatorQuery(q.snippet);
      const pairKeys = index.findPhraseCandidateKeys(parsed.terms);
      const uniKeys = index.findCandidateKeys(parsed.terms);
      if (!pairKeys || pairKeys.size === 0) continue; // falls back to unigram
      pairTotal += pairKeys.size;
      uniTotal += uniKeys ? uniKeys.size : records.length;
      checked++;
      const needle = parsed.terms.flatMap((t) => extractNavigatorSearchTokens(t));
      for (const r of records) {
        const inContent = containsContiguous(streamOf(r.normalizedContent), needle);
        const inStem = containsContiguous(streamOf(r.normalizedStem), needle);
        if (inContent || inStem) {
          expect(
            pairKeys.has(r.filePath),
            `holder ${path.basename(r.filePath)} missing from pair candidates for ${JSON.stringify(q.snippet)}`
          ).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
    console.log(
      `pair pruning: avg pair candidates ${(pairTotal / queries.length).toFixed(1)}, ` +
        `avg unigram candidates ${(uniTotal / queries.length).toFixed(1)}`
    );
    expect(pairTotal).toBeLessThan(uniTotal / 2);
  });
});
