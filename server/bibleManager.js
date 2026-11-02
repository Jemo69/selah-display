import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseBible, searchBible, searchBibleExperimental, buildSearchIndex } from '../shared/bible/index.js';
import createServerLogger from './logger.js';

const log = createServerLogger('BibleManager');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// SELAH_DATA_DIR is the current name; LYRICDISPLAY_DATA_DIR is still accepted
// so standalone-server setups documented under the old name keep working.
const dataRootEnv = process.env.SELAH_DATA_DIR || process.env.LYRICDISPLAY_DATA_DIR;
const dataRoot = dataRootEnv
  ? path.resolve(dataRootEnv)
  : path.join(__dirname, '..');
const uploadsRoot = path.join(dataRoot, 'uploads');
const biblesDir = path.join(uploadsRoot, 'bibles');

try {
  fs.mkdirSync(biblesDir, { recursive: true });
} catch (e) {}

let bibles = {};
let activeBibleId = null;
let defaultBibleId = null;
const searchIndexCache = new Map();

function detachSearchIndex(bible) {
  if (!bible || !bible.id) return;
  if (bible.searchIndex) {
    searchIndexCache.set(bible.id, bible.searchIndex);
    delete bible.searchIndex;
  }
}

function dropEagerSearchIndex(bible) {
  if (!bible || !bible.id) return;
  if (bible.searchIndex) {
    delete bible.searchIndex;
  }
}

function attachSearchIndex(bible) {
  if (!bible || !bible.id) return;
  if (bible.searchIndex) return;
  let index = searchIndexCache.get(bible.id);
  if (!index) {
    index = buildSearchIndex(bible);
    searchIndexCache.set(bible.id, index);
  }
  bible.searchIndex = index;
}

function ensureMaps(bible) {
  if (!bible) return bible;
  if (!bible.bookMap) {
    bible.bookMap = {};
    for (const book of bible.books || []) {
      bible.bookMap[book.number] = book;
      if (!book.chapterMap) {
        book.chapterMap = {};
        for (const chapter of book.chapters || []) {
          book.chapterMap[chapter.number] = chapter;
          if (!chapter.verseMap) {
            chapter.verseMap = {};
            for (const verse of chapter.verses || []) {
              chapter.verseMap[verse.number] = verse;
            }
          }
        }
      }
    }
  }
  return bible;
}

export function getAllBibles() {
  return Object.values(bibles).map(b => ({
    id: b.id,
    name: b.name,
    bookCount: b.books?.length || 0,
  }));
}

export function getBibleMetaMap() {
  const map = {};
  for (const [id, bible] of Object.entries(bibles)) {
    map[id] = { id, name: bible.name };
  }
  return map;
}

export function getActiveBible() {
  if (!activeBibleId) return null;
  return bibles[activeBibleId] || null;
}

export function getActiveBibleId() {
  return activeBibleId;
}

export function setActiveBible(id) {
  if (id && !bibles[id]) throw new Error('Bible not found');
  if (activeBibleId && bibles[activeBibleId]) {
    detachSearchIndex(bibles[activeBibleId]);
  }
  activeBibleId = id;
  if (!defaultBibleId && id) defaultBibleId = id;
  if (id && bibles[id]) {
    attachSearchIndex(bibles[id]);
  }
  log.info(`Active bible set to ${id}`);
  return bibles[id] || null;
}

export function addBible(bible) {
  if (!bible || !bible.id) throw new Error('Invalid bible');
  ensureMaps(bible);
  dropEagerSearchIndex(bible);
  bibles[bible.id] = bible;
  if (!activeBibleId) activeBibleId = bible.id;
  if (!defaultBibleId) defaultBibleId = bible.id;
  attachSearchIndex(bible);
  log.info(`Bible added: ${bible.name} (${bible.id}) with ${bible.books?.length || 0} books`);
  return bible;
}

export function removeBible(id) {
  if (!bibles[id]) throw new Error('Bible not found');
  delete bibles[id];
  if (activeBibleId === id) activeBibleId = Object.keys(bibles)[0] || null;
  if (defaultBibleId === id) defaultBibleId = activeBibleId;
  log.info(`Bible removed: ${id}`);
}

export function search(query, limit = 50, searchAll = false, experimental = false) {
  const current = getActiveBible();
  if (!current) return [];
  try {
    attachSearchIndex(current);
    if (searchAll) {
      for (const bible of Object.values(bibles)) {
        attachSearchIndex(bible);
      }
    }
    const results = experimental === true
      ? searchBibleExperimental(current, query, bibles, limit, defaultBibleId, searchAll)
      : searchBible(current, query, bibles, limit, defaultBibleId, searchAll);
    return results || [];
  } catch (e) {
    log.error('Search error:', e.message);
    return [];
  }
}

export function resolveReference(reference, limit = 20) {
  const current = getActiveBible();
  if (!current) return [];
  try {
    attachSearchIndex(current);
    const results = searchBible(current, reference, bibles, limit, defaultBibleId, false);
    return results || [];
  } catch (e) {
    log.error('Resolve reference error:', e.message);
    return [];
  }
}

export async function loadBiblesFromDisk() {
  try {
    const files = await fs.promises.readdir(biblesDir);
    for (const file of files) {
      const fullPath = path.join(biblesDir, file);
      try {
        const stat = await fs.promises.stat(fullPath);
        if (!stat.isFile()) continue;
        if (stat.size > 100 * 1024 * 1024) continue;
        const content = await fs.promises.readFile(fullPath, 'utf8');
        if (!content) continue;
        const parsed = parseBible(content, file.replace(/\.[^.]+$/i, ''));
        if (parsed && parsed.books && parsed.books.length > 0) {
          parsed.id = parsed.id || `bible_${file.replace(/[^a-z0-9]/gi, '_')}`;
          addBible(parsed);
        }
      } catch (err) {
        log.warn(`Failed to load bible file ${file}: ${err.message}`);
      }
    }
    log.info(`Loaded ${Object.keys(bibles).length} bibles from disk`);
  } catch (e) {
    log.warn('Could not read bibles dir:', e.message);
  }
}

loadBiblesFromDisk().catch(()=>{});

export function getBibleById(id) {
  return bibles[id] || null;
}

export function listBibleDetails() {
  return bibles;
}
