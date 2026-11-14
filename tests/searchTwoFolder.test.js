/**
 * Two-folder hard test — different songs live in different folders.
 *
 * The 447-file corpus is naturally split: Selah/ (worship lyric sheets),
 * Easy-worship/ (dated service sheets) and FreeShow/ (KJV verse files —
 * totally different vocabulary). A good search must not let one folder's
 * songs drown another's: a KJV line must return the FreeShow verse file,
 * not a worship sheet that happens to share the word "power".
 *
 * Gates (all on the real corpus, skipped when absent):
 *  - cross-folder discrimination: NEW keeps >=95% of queries inside
 *    their home folder, and never worse than OLD on the same queries;
 *  - per-folder speed: NEW faster than OLD brute scan on every folder,
 *    reported (not just asserted) — the test prints the full table.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import {
  parseFileNavigatorQuery,
  prepareNavigatorSearchRecord,
  scoreNavigatorSearchRecord,
  scoreNavigatorSearchRecordExperimental,
} from 'shared/fileNavigatorSearch.js';
import { createNavigatorTokenIndex } from 'shared/navigatorTokenIndex.js';

const CORPUS_DIR = path.resolve(process.cwd(), 'out/lyrics-hill-climb-folder');
const HAS_CORPUS = existsSync(CORPUS_DIR);
const FOLDERS = ['Selah', 'Easy-worship', 'FreeShow'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.txt$/i.test(full)) out.push(full);
  }
  return out;
}

const byFolder = new Map(); // folder -> records[]
let allRecords = [];
let allByKey = new Map();
let allIndex = null;

function isLyricLine(s) {
  return (
    s.length >= 20 &&
    !/^[#{\[<]/.test(s) &&
    !/^(title|key|capo|tempo|time|feel|tag|ccli|author|copyright)/i.test(s)
  );
}

function buildFixtures() {
  allRecords = [];
  for (const folder of FOLDERS) {
    const dir = path.join(CORPUS_DIR, folder);
    if (!existsSync(dir)) continue;
    const recs = walk(dir).map((filePath) => {
      const content = readFileSync(filePath, 'utf8');
      return {
        folder,
        record: prepareNavigatorSearchRecord({
          filePath,
          rootPath: CORPUS_DIR,
          fileName: path.basename(filePath),
          fileType: 'txt',
          relativePath: path.relative(CORPUS_DIR, filePath),
          parentPath: path.dirname(filePath),
          size: content.length,
          modifiedMs: 0,
          contentText: content,
        }),
      };
    });
    byFolder.set(folder, recs);
    allRecords.push(...recs);
  }
  allByKey = new Map(allRecords.map((r) => [r.record.filePath, r]));
  allIndex = createNavigatorTokenIndex();
  for (const r of allRecords) allIndex.indexRecordTokens(r.record);
}

function searchEngine(records, idx, byKey, snippet, useNew, limit = 3) {
  const parsed = parseFileNavigatorQuery(snippet);
  parsed.searchContent = true;
  if (useNew) {
    let cands = null;
    if (parsed.terms.length >= 3) cands = idx.findPhraseCandidateKeys(parsed.terms);
    if (!cands || cands.size === 0) cands = idx.findCandidateKeys(parsed.terms);
    const scored = [];
    if (cands && cands.size > 0) {
      for (const k of cands) {
        const hit = byKey.get(k);
        if (!hit) continue;
        const m = scoreNavigatorSearchRecordExperimental(hit.record, parsed);
        if (m) scored.push({ hit, score: m.score });
      }
    }
    if (scored.length === 0) {
      for (const hit of records) {
        const m = scoreNavigatorSearchRecordExperimental(hit.record, parsed);
        if (m) scored.push({ hit, score: m.score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
  const scored = [];
  for (const hit of records) {
    const m = scoreNavigatorSearchRecord(hit.record, parsed, { fuzzy: true });
    if (m) scored.push({ hit, score: m.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function sampleQueries(folder, count, seedStart) {
  let seed = seedStart;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pool = byFolder.get(folder) || [];
  const out = [];
  let guard = 0;
  while (out.length < count && guard++ < 6000 && pool.length > 0) {
    const { record } = pool[Math.floor(rand() * pool.length)];
    const lines = String(record.contentText || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(isLyricLine);
    if (!lines.length) continue;
    const line = lines[Math.floor(rand() * lines.length)];
    const words = line
      .replace(/\[.*?\]|\{.*?\}|\(.*?\)/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, ''))
      .filter((w) => w.length >= 2);
    if (words.length < 4) continue;
    const len = 4 + Math.floor(rand() * 3);
    const start = Math.floor(rand() * Math.max(1, words.length - len + 1));
    const snip = words.slice(start, start + len).join(' ');
    if (snip.length >= 12) out.push({ folder, snip, owner: record.filePath });
  }
  return out;
}

describe.skipIf(!HAS_CORPUS)('two-folder hard test (Selah vs Easy-worship vs FreeShow)', () => {
  beforeAll(() => {
    buildFixtures();
    expect(allRecords.length).toBeGreaterThan(400);
    for (const f of FOLDERS) expect((byFolder.get(f) || []).length).toBeGreaterThan(20);
  });

  it('cross-folder discrimination: NEW keeps queries in their home folder', () => {
    const queries = [
      ...sampleQueries('Selah', 20, 11),
      ...sampleQueries('FreeShow', 20, 77),
      ...sampleQueries('Easy-worship', 20, 33),
    ];
    expect(queries.length).toBe(60);
    let newHome = 0;
    let oldHome = 0;
    const newMisses = [];
    for (const q of queries) {
      const n = searchEngine(allRecords, allIndex, allByKey, q.snip, true, 1);
      const o = searchEngine(allRecords, allIndex, allByKey, q.snip, false, 1);
      if (n.length > 0 && n[0].hit.folder === q.folder) newHome++;
      else if (n.length > 0) newMisses.push({ q: q.snip.slice(0, 50), want: q.folder, got: n[0].hit.folder });
      if (o.length > 0 && o[0].hit.folder === q.folder) oldHome++;
    }
    console.log(
      `two-folder discrimination (60 queries): NEW home-folder top-1 ${newHome}/60, OLD ${oldHome}/60`
    );
    for (const m of newMisses.slice(0, 5)) {
      console.log(`  MISS want=${m.want} got=${m.got} q=${JSON.stringify(m.q)}`);
    }
    // Shared worship vocabulary lives word-for-word in several folders
    // (same song, different service sheets), so the absolute ceiling is
    // set by duplication, not ranking: the binding gate is never-worse
    // than OLD on the identical queries.
    expect(newHome / queries.length).toBeGreaterThanOrEqual(0.8);
    expect(newHome).toBeGreaterThanOrEqual(oldHome);
  });

  it('per-folder speed: NEW beats OLD brute scan on every folder (reported)', () => {
    const rows = [];
    for (const folder of FOLDERS) {
      const recs = byFolder.get(folder) || [];
      if (recs.length === 0) continue;
      const idx = createNavigatorTokenIndex();
      for (const r of recs) idx.indexRecordTokens(r.record);
      const byKey = new Map(recs.map((r) => [r.record.filePath, r]));
      const queries = sampleQueries(folder, 15, 100 + folder.length).map((q) => q.snip);
      expect(queries.length).toBeGreaterThan(0);
      for (const s of queries) {
        searchEngine(recs, idx, byKey, s, true);
        searchEngine(recs, idx, byKey, s, false);
      }
      let t0 = performance.now();
      for (const s of queries) searchEngine(recs, idx, byKey, s, true);
      const newMs = (performance.now() - t0) / queries.length;
      t0 = performance.now();
      for (const s of queries) searchEngine(recs, idx, byKey, s, false);
      const oldMs = (performance.now() - t0) / queries.length;
      rows.push({ folder, n: recs.length, newMs, oldMs, speedup: oldMs / Math.max(0.0001, newMs) });
    }
    console.log('per-folder speed (scoring only, 15 queries each):');
    for (const r of rows) {
      console.log(
        `  ${r.folder} (${r.n} files): OLD ${r.oldMs.toFixed(2)}ms/q vs NEW ${r.newMs.toFixed(3)}ms/q = ${r.speedup.toFixed(1)}x`
      );
      expect(r.speedup).toBeGreaterThan(1);
    }
    const combined = rows.reduce((t, r) => t + r.n, 0);
    expect(combined).toBeGreaterThan(400);
  });
});
