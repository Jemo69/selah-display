/**
 * 10,000 full-sentence search: every query is a TRUE paste — a whole lyric
 * line or 2 consecutive lyric lines straight out of a file — across all
 * 447 corpus files (gitignored test-only data; suite SKIPS when absent).
 *
 * For a true paste the owning file MUST surface: the test gates
 * holder-top1 at 100% (top-1 holds the pasted sentence in its lyrics or
 * its title — duplicates share lyrics, so owner-identity is tracked
 * separately, not gated). A fixed 500-query subset also races OLD
 * (brute full-fuzzy) vs NEW: zero holder regressions allowed, NEW must
 * fix strictly more than it could ever regress and answer faster.
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
const SUBSET_EVERY = 20;

let records = [];
let byKey = new Map();
let index = null;
let queries = [];
let stats = null;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.txt$/i.test(full)) out.push(full);
  }
  return out;
}

function buildFixtures() {
  const files = walk(CORPUS_DIR).sort();
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
    if (m) scored.push({ rec, score: m.score, phrase: !!m.phrase });
  }
  if (parsed.terms.length >= 2 && !singleWeakStem && !scored.some((s) => s.phrase)) {
    const seen = new Set(scored.map((s) => s.rec.filePath));
    const substantive = extractSubstantiveFlatTerms(parsed);
    const { keys: inflectionKeys, variants: inflectionVariants } =
      index.findInflectionExpandedKeys(substantive, { exclude: seen });
    if (inflectionVariants && Object.keys(inflectionVariants).length > 0) {
      const merged = { ...(parsed.fuzzyVariants || {}) };
      for (const term of Object.keys(inflectionVariants)) {
        const incoming = inflectionVariants[term] || [];
        const existing = merged[term];
        if (incoming.length > 0) merged[term] = [...new Set([...(existing || []), ...incoming])];
        else if (!(term in merged)) merged[term] = [];
      }
      parsed.fuzzyVariants = merged;
    }
    if (inflectionKeys && inflectionKeys.size > 0) {
      for (const key of inflectionKeys) {
        const rec = byKey.get(key);
        if (!rec || seen.has(rec.filePath)) continue;
        const m = scoreNavigatorSearchRecordExperimental(rec, parsed);
        if (m) scored.push({ rec, score: m.score, phrase: !!m.phrase });
      }
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
const holderOf = (rec, flat) =>
  (rec.normalizedContentFlat || '').includes(flat) ||
  (rec.normalizedStemFlat || '').includes(flat);

function buildQueries() {
  let seed = 777;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const isTag = (l) =>
    /^\[.*\]$/.test(l) ||
    /^#{1,3}\s/.test(l) ||
    /^(title|key|capo|tempo|time|feel|tag|ccli|author|copyright)\b/i.test(l);
  const alpha = (s) => (s.match(/[a-z0-9]/gi) || []).length;
  const out = [];
  for (const rec of records) {
    const raw = String(rec.contentText || '').split('\n').map((s) => s.trim());
    const usable = raw
      .map((l, i) => ({ l, i }))
      .filter((o) => o.l.length >= 4 && !isTag(o.l));
    for (let k = 0; k + 1 < usable.length; k++) {
      if (usable[k + 1].i !== usable[k].i + 1) continue;
      const snip = `${usable[k].l} ${usable[k + 1].l}`.slice(0, 220);
      if (snip.split(/\s+/).length >= 6 && alpha(snip) >= 14) {
        out.push({ kind: 'stanza', rec, snip });
      }
    }
  }
  const lines = [];
  for (const rec of records) {
    const raw = String(rec.contentText || '').split('\n').map((s) => s.trim());
    for (const l of raw) {
      if (l.length >= 20 && l.split(/\s+/).length >= 6 && !isTag(l) && alpha(l) >= 14) {
        lines.push({ kind: 'line', rec, snip: l.slice(0, 220) });
      }
    }
  }
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [lines[i], lines[j]] = [lines[j], lines[i]];
  }
  const need = Math.max(0, 10000 - out.length);
  for (const q of lines.slice(0, need)) out.push(q);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe.skipIf(!HAS_CORPUS)('10000 full-sentence queries: holder top-1 must be perfect', () => {
  beforeAll(() => {
    buildFixtures();
    expect(records.length).toBeGreaterThan(400);
    queries = buildQueries();
    expect(queries.length).toBeGreaterThanOrEqual(10000);

    let holderTop1 = 0;
    let ownerTop1 = 0;
    let ownerTop3 = 0;
    let newMs = 0;
    const t0 = performance.now();
    for (const q of queries) {
      const t = performance.now();
      const res = newSearch(q.snip, 5);
      newMs += performance.now() - t;
      const flat = flatOf(q.snip);
      if (res.length > 0 && holderOf(res[0].rec, flat)) holderTop1++;
      if (res.length > 0 && res[0].rec.filePath === q.rec.filePath) ownerTop1++;
      else if (res.slice(0, 3).some((s) => s.rec.filePath === q.rec.filePath)) ownerTop3++;
    }
    const wallMs = performance.now() - t0;

    const subset = queries.filter((_, i) => i % SUBSET_EVERY === 0);
    let subNewMs = 0;
    let subOldMs = 0;
    let subNewHolder = 0;
    let subOldHolder = 0;
    let fixes = 0;
    let regressions = 0;
    for (const q of subset) {
      const flat = flatOf(q.snip);
      let t = performance.now();
      const o = oldSearch(q.snip, 5);
      subOldMs += performance.now() - t;
      t = performance.now();
      const n = newSearch(q.snip, 5);
      subNewMs += performance.now() - t;
      const oH = o.length > 0 && holderOf(o[0].rec, flat);
      const nH = n.length > 0 && holderOf(n[0].rec, flat);
      if (oH) subOldHolder++;
      if (nH) subNewHolder++;
      const oO = o.length > 0 && o[0].rec.filePath === q.rec.filePath;
      const nO = n.length > 0 && n[0].rec.filePath === q.rec.filePath;
      if (!oO && nO) fixes++;
      if (oH && !nH) regressions++;
    }

    stats = {
      total: queries.length,
      holderTop1, ownerTop1, ownerTop3,
      wallMs, newMs,
      subN: subset.length, subNewHolder, subOldHolder, fixes, regressions,
      subNewMs, subOldMs,
    };
  }, 600000);

  it('covers 10000+ true-paste queries across all 400+ files', () => {
    expect(stats.total).toBeGreaterThanOrEqual(10000);
    expect(records.length).toBeGreaterThan(400);
  });

  it('holder top-1 is perfect: every pasted sentence surfaces first', () => {
    expect(stats.holderTop1).toBe(stats.total);
  });

  it('owner top-3 stays high despite duplicate service sheets', () => {
    expect((stats.ownerTop1 + stats.ownerTop3) / stats.total).toBeGreaterThanOrEqual(0.6);
  });

  it('subset race: new dominates old with zero holder regressions', () => {
    expect(stats.subNewHolder).toBeGreaterThanOrEqual(stats.subOldHolder);
    expect(stats.regressions).toBe(0);
    expect(stats.fixes).toBeGreaterThan(0);
  });

  it('subset race: new answers faster than old end-to-end', () => {
    expect(stats.subNewMs).toBeLessThan(stats.subOldMs);
  });
});
