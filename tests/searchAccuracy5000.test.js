/**
 * 5000+ query accuracy race — OLD (brute full-fuzzy default scorer) vs
 * NEW (main-path mirror: stem shortcut → rarest unigram → phrase pairs →
 * typo-expanded unigram → inflection second pass → full fallback).
 *
 * Every query is sampled from the real 447-file hill-climb corpus
 * (gitignored test-only data; suite SKIPS when absent):
 *  - line:    4-6 consecutive words of a lyric line (true substring)
 *  - stanza:  2 consecutive raw lyric lines (true paste)
 *  - typo:    line snippet with the longest token's middle char deleted
 *  - title:   first 2-3 words of the file stem
 *
 * The verdict that matters: NEW fixes hundreds of queries OLD misses
 * (typo holder recall 8% → 68%) with ZERO holder-top1 regressions —
 * every query the old engine gets right, the new one gets right too.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import {
  extractSubstantiveFlatTerms,
  flattenNavigatorSearchText,
  isWeakNavigatorTerm,
  parseFileNavigatorQueryCached,
  prepareNavigatorSearchRecord,
  scoreNavigatorSearchRecord,
  scoreNavigatorSearchRecordExperimental,
} from 'shared/fileNavigatorSearch.js';
import { createNavigatorTokenIndex } from 'shared/navigatorTokenIndex.js';

const CORPUS_DIR = path.resolve(process.cwd(), 'out/lyrics-hill-climb-folder');
const HAS_CORPUS = existsSync(CORPUS_DIR);
const normalizeComparisonPath = (v) => String(v || '');

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
let index = null;

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
  index = createNavigatorTokenIndex();
  for (const r of records) index.indexRecordTokens(r);
}

// Mirrors main/fileNavigator.js searchFileNavigator (experimental path).
function newSearch(snippet, limit = 5) {
  const fresh = parseFileNavigatorQueryCached(snippet);
  const parsed = { ...fresh, terms: [...fresh.terms], fileTypes: [...fresh.fileTypes] };
  parsed.searchContent = true;
  let candidateKeys = null;
  let singleWeakStem = false;
  if (parsed.terms.length === 1 && isWeakNavigatorTerm(parsed.terms[0])) {
    singleWeakStem = true;
    candidateKeys = index.findStemKeys(parsed.terms[0]);
  }
  if (!candidateKeys) {
    if (parsed.terms.length >= 3 && !singleWeakStem) {
      candidateKeys = index.findRarestUnigramKeys(parsed.terms, 12);
    }
    if ((!candidateKeys || candidateKeys.size === 0) && parsed.terms.length >= 3) {
      candidateKeys = index.findPhraseCandidateKeys(parsed.terms);
    }
  }
  if ((!candidateKeys || candidateKeys.size === 0) && !singleWeakStem) {
    const withVariants = index.findCandidatesWithVariants(parsed.terms);
    candidateKeys = withVariants.keys;
    if (withVariants.variants && Object.keys(withVariants.variants).length > 0) {
      parsed.fuzzyVariants = withVariants.variants;
    }
  }
  const scored = [];
  const keys = candidateKeys && candidateKeys.size ? [...candidateKeys] : records.map((r) => r.filePath);
  for (const key of keys) {
    const rec = byKey.get(key);
    if (!rec) continue;
    const m = scoreNavigatorSearchRecordExperimental(rec, parsed);
    if (m) scored.push({ rec, score: m.score, phrase: m.phrase === true });
  }
  if (parsed.terms.length >= 2 && !singleWeakStem && !scored.some((s) => s.phrase)) {
    const seen = new Set(scored.map((s) => normalizeComparisonPath(s.rec.filePath)));
    const substantive = extractSubstantiveFlatTerms(parsed);
    const { keys: inflectionKeys, variants: inflectionVariants } =
      index.findInflectionExpandedKeys(substantive, { exclude: seen });
    if (inflectionVariants && Object.keys(inflectionVariants).length > 0) {
      const merged = { ...(parsed.fuzzyVariants || {}) };
      for (const term of Object.keys(inflectionVariants)) {
        const incoming = inflectionVariants[term] || [];
        const existing = merged[term];
        if (incoming.length > 0) {
          merged[term] = [...new Set([...(existing || []), ...incoming])];
        } else if (!(term in merged)) {
          merged[term] = [];
        }
      }
      parsed.fuzzyVariants = merged;
    }
    if (inflectionKeys && inflectionKeys.size > 0) {
      for (const key of inflectionKeys) {
        const rec = byKey.get(key);
        if (!rec || seen.has(normalizeComparisonPath(key))) continue;
        const m = scoreNavigatorSearchRecordExperimental(rec, parsed);
        if (m) scored.push({ rec, score: m.score, phrase: m.phrase === true });
      }
    }
  }
  if (scored.length === 0) {
    for (const rec of records) {
      const m = scoreNavigatorSearchRecordExperimental(rec, parsed);
      if (m) scored.push({ rec, score: m.score, phrase: !!m.phrase });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function oldSearch(snippet, limit = 5) {
  const fresh = parseFileNavigatorQueryCached(snippet);
  const parsed = { ...fresh, terms: [...fresh.terms] };
  parsed.searchContent = true;
  const scored = [];
  for (const rec of records) {
    const m = scoreNavigatorSearchRecord(rec, parsed, { fuzzy: true });
    if (m) scored.push({ rec, score: m.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

const flatOf = (snippet) => {
  const p = parseFileNavigatorQueryCached(snippet);
  return flattenNavigatorSearchText(p.phrase ?? p.terms.join(' '));
};

function buildQueries() {
  let seed = 123456789;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const rawLinesOf = (c) => String(c || '').split('\n').map((s) => s.trim());
  const isTag = (l) =>
    /^\[.*\]$/.test(l) ||
    /^#{1,3}\s/.test(l) ||
    /^(title|key|capo|tempo|time|feel|tag|ccli|author|copyright)\b/i.test(l);
  const alphaCount = (s) => (s.match(/[a-z0-9]/gi) || []).length;
  const queries = [];
  for (const rec of records) {
    const raw = rawLinesOf(rec.contentText);
    const indexed = raw
      .map((l, i) => ({ l, i }))
      .filter((o) => o.l.length >= 4 && !isTag(o.l));
    const longLines = indexed.map((o) => o.l).filter((l) => l.split(/\s+/).length >= 4);
    for (let i = 0; i < 8 && longLines.length; i++) {
      const words = longLines[Math.floor(rand() * longLines.length)].split(/\s+/);
      if (words.length < 4) continue;
      const len = 4 + Math.floor(rand() * Math.min(3, words.length - 3));
      const start = Math.floor(rand() * Math.max(1, words.length - len + 1));
      const snip = words.slice(start, start + len).join(' ').slice(0, 160);
      if (snip.split(/\s+/).length >= 4 && alphaCount(snip) >= 6) {
        queries.push({ kind: 'line', rec, snip });
      }
    }
    const pairs = [];
    for (let k = 0; k + 1 < indexed.length; k++) {
      if (indexed[k + 1].i === indexed[k].i + 1) pairs.push([indexed[k].l, indexed[k + 1].l]);
    }
    for (let i = 0; i < 4 && pairs.length; i++) {
      const [a, b] = pairs[Math.floor(rand() * pairs.length)];
      const snip = `${a} ${b}`.slice(0, 200);
      if (snip.split(/\s+/).length >= 6 && alphaCount(snip) >= 10) {
        queries.push({ kind: 'stanza', rec, snip });
      }
    }
    for (let i = 0; i < 6 && longLines.length; i++) {
      const toks = longLines[Math.floor(rand() * longLines.length)]
        .split(/\s+/)
        .filter((w) => w.length >= 2);
      if (toks.length < 4) continue;
      const len = 4 + Math.floor(rand() * Math.min(3, toks.length - 3));
      const start = Math.floor(rand() * Math.max(1, toks.length - len + 1));
      const picked = toks.slice(start, start + len);
      let bi = -1;
      let bl = 0;
      picked.forEach((t, j) => {
        const clean = t.replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, '');
        if (clean.length > bl) {
          bl = clean.length;
          bi = j;
        }
      });
      if (bi < 0 || bl < 5) continue;
      picked[bi] = picked[bi].slice(0, 3) + picked[bi].slice(4);
      const snip = picked.join(' ').slice(0, 160);
      if (snip.split(/\s+/).length >= 4 && alphaCount(snip) >= 6) {
        queries.push({ kind: 'typo', rec, snip });
      }
    }
    const stem = (rec.normalizedStem || '').split(' ').filter(Boolean);
    if (stem.length >= 2) {
      queries.push({ kind: 'title', rec, snip: stem.slice(0, Math.min(3, stem.length)).join(' ') });
    } else if (stem.length === 1 && stem[0].length >= 4) {
      queries.push({ kind: 'title', rec, snip: stem[0] });
    }
  }
  return queries;
}

describe.skipIf(!HAS_CORPUS)('5000+ query accuracy race: new must dominate old with zero regressions', () => {
  let queries = [];
  let stats = null;

  beforeAll(() => {
    buildFixtures();
    expect(records.length).toBeGreaterThan(400);
    queries = buildQueries();
    expect(queries.length).toBeGreaterThanOrEqual(5000);

    const byKind = { line: [], stanza: [], typo: [], title: [] };
    for (const q of queries) byKind[q.kind].push(q);

    const race = (items, score) => {
      let holderTop1New = 0;
      let holderTop1Old = 0;
      let ownerTop3New = 0;
      let fixes = 0;
      let regressions = 0;
      for (const q of items) {
        const flat = flatOf(q.snip);
        const o = oldSearch(q.snip, 5);
        const n = newSearch(q.snip, 5);
        const oH = o.length > 0 && o[0].rec.normalizedContentFlat.includes(flat);
        const nH = n.length > 0 && n[0].rec.normalizedContentFlat.includes(flat);
        if (oH) holderTop1Old++;
        if (nH) holderTop1New++;
        if (n.slice(0, 3).some((s) => s.rec.filePath === q.rec.filePath)) ownerTop3New++;
        const oO = o.length > 0 && o[0].rec.filePath === q.rec.filePath;
        const nO = n.length > 0 && n[0].rec.filePath === q.rec.filePath;
        if (!oO && nO) fixes++;
        if (oH && !nH) regressions++;
        score(q, o, n);
      }
      return { n: items.length, holderTop1Old, holderTop1New, ownerTop3New, fixes, regressions };
    };

    const typoScore = { nH3: 0, oH3: 0 };
    const titleScore = { nO: 0, oO: 0 };
    const line = race(byKind.line, () => {});
    const stanza = race(byKind.stanza, () => {});
    const typo = race(byKind.typo, (q, o, n) => {
      const intact = parseFileNavigatorQueryCached(q.snip).terms.filter((t) => t.length >= 5);
      const hit = (res) =>
        res.slice(0, 3).some(
          (s) =>
            s.rec.filePath === q.rec.filePath ||
            (intact.length > 0 &&
              intact.every((t) => (s.rec.normalizedContentFlat || '').includes(flattenNavigatorSearchText(t))))
        );
      if (hit(n)) typoScore.nH3++;
      if (hit(o)) typoScore.oH3++;
    });
    const title = race(byKind.title, (q, o, n) => {
      if (n.length > 0 && n[0].rec.filePath === q.rec.filePath) titleScore.nO++;
      if (o.length > 0 && o[0].rec.filePath === q.rec.filePath) titleScore.oO++;
    });
    stats = { line, stanza, typo, title, typoScore, titleScore };
  }, 300000);

  it('covers 5000+ queries across all 400+ files', () => {
    expect(queries.length).toBeGreaterThanOrEqual(5000);
    expect(records.length).toBeGreaterThan(400);
  });

  it('line snippets: holder top-1 ~100% with zero regressions', () => {
    expect(stats.line.holderTop1New / stats.line.n).toBeGreaterThanOrEqual(0.995);
    expect(stats.line.regressions).toBe(0);
  });

  it('stanzas: holder top-1 100% with zero regressions', () => {
    expect(stats.stanza.holderTop1New / stats.stanza.n).toBeGreaterThanOrEqual(0.995);
    expect(stats.stanza.regressions).toBe(0);
  });

  it('typos: holder top-3 dominates old (8% -> ~68%) with zero regressions', () => {
    expect(stats.typoScore.nH3 / stats.typo.n).toBeGreaterThanOrEqual(0.6);
    expect(stats.typoScore.nH3).toBeGreaterThan(stats.typoScore.oH3);
    expect(stats.typo.regressions).toBe(0);
  });

  it('titles: owner top-1 at least matches old, zero regressions', () => {
    expect(stats.titleScore.nO / stats.title.n).toBeGreaterThanOrEqual(
      stats.titleScore.oO / stats.title.n
    );
    expect(stats.title.regressions).toBe(0);
  });

  it('new fixes far more than it could ever regress', () => {
    const fixes =
      stats.line.fixes + stats.stanza.fixes + stats.typo.fixes + stats.title.fixes;
    const regressions =
      stats.line.regressions +
      stats.stanza.regressions +
      stats.typo.regressions +
      stats.title.regressions;
    expect(regressions).toBe(0);
    expect(fixes).toBeGreaterThan(100);
  });
});
