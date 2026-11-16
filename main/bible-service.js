/**
 * Electron Bible Verse Service (offline).
 * Plan: slop-plans electron-bible-verse-service
 *   renderer (UI) —invoke→ preload (window.bibleAPI) —ipc→ main/bible-service.js —fs→ public/bibles/KJV/*.json
 * (packaged: extraResources/bibles; dev: public/bibles. A legacy
 * assets/bibles dir is still probed first if present, but the packaged
 * single source of truth is public/bibles.)
 *
 * Per-book files shaped like:
 *   KJV/Genesis.json → { "Genesis": { "1": { "1": "text" } }, "Info": {...} }
 *
 * FS work stays in main. Renderer never touches fs (asar + contextIsolation).
 * Per-book cache: split Genesis.json / John.json files load in ~1ms after first read.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOOKS_ORDER = [
  'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges', 'Ruth',
  '1 Samuel', '2 Samuel', '1 Kings', '2 Kings', '1 Chronicles', '2 Chronicles', 'Ezra', 'Nehemiah',
  'Esther', 'Job', 'Psalm', 'Proverbs', 'Ecclesiastes', 'Song Of Solomon', 'Isaiah', 'Jeremiah',
  'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos', 'Obadiah', 'Jonah', 'Micah',
  'Nahum', 'Habakkuk', 'Zephaniah', 'Haggai', 'Zechariah', 'Malachi', 'Matthew', 'Mark', 'Luke',
  'John', 'Acts', 'Romans', '1 Corinthians', '2 Corinthians', 'Galatians', 'Ephesians',
  'Philippians', 'Colossians', '1 Thessalonians', '2 Thessalonians', '1 Timothy', '2 Timothy',
  'Titus', 'Philemon', 'Hebrews', 'James', '1 Peter', '2 Peter', '1 John', '2 John', '3 John',
  'Jude', 'Revelation',
];

const here = path.dirname(fileURLToPath(import.meta.url));
// main/bible-service.js → project root is one level up.
const PROJECT_ROOT = path.resolve(here, '..');

function candidateBaseDirs(app, translation) {
  const dirs = [];
  try {
    if (app && typeof app.isPackaged === 'boolean' && app.isPackaged) {
      try {
        if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'bibles', translation));
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  // Dev / unpacked fallbacks — renderer must never do this fs walk itself.
  dirs.push(path.join(PROJECT_ROOT, 'assets', 'bibles', translation));
  dirs.push(path.join(PROJECT_ROOT, 'public', 'bibles', translation));
  return dirs;
}

function candidateLibraryDirs(app) {
  const dirs = [];
  try {
    if (app && typeof app.isPackaged === 'boolean' && app.isPackaged) {
      try {
        if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'bibles'));
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  dirs.push(path.join(PROJECT_ROOT, 'assets', 'bibles'));
  dirs.push(path.join(PROJECT_ROOT, 'public', 'bibles'));
  return dirs;
}

class BibleService {
  constructor(translation = 'KJV', app = null) {
    this.translation = translation;
    this.cache = new Map(); // bookName → { "1": { "1": "text" } }
    this.booksOrder = BOOKS_ORDER;
    this._app = app;
  }

  attachApp(app) {
    this._app = app;
  }

  get baseDir() {
    const dirs = candidateBaseDirs(this._app, this.translation);
    for (const dir of dirs) {
      try {
        if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
      } catch { /* try next */ }
    }
    return dirs[0];
  }

  get libraryDirs() {
    return candidateLibraryDirs(this._app).filter((dir) => {
      try {
        return existsSync(dir) && statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
  }

  /** Translations found on disk (bundled samples + packaged extraResources). */
  listTranslations() {
    const seen = new Map();
    for (const libDir of this.libraryDirs) {
      let entries = [];
      try {
        entries = readdirSync(libDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = entry.name;
        if (seen.has(dir)) continue;
        const full = path.join(libDir, dir);
        let files = [];
        try {
          files = readdirSync(full).filter((f) => f.toLowerCase().endsWith('.json'));
        } catch {
          continue;
        }
        if (files.length === 0) continue;
        const books = files
          .map((f) => path.basename(f, '.json'))
          .filter((b) => b.toLowerCase() !== 'manifest');
        seen.set(dir, {
          id: `bundled-${dir.toLowerCase()}`,
          dir,
          name: dir === 'KJV' ? 'KJV (Bundled Sample)' : `${dir} (Bundled)`,
          files,
          books,
          bookCount: books.length,
          baseDir: full,
        });
      }
    }
    return [...seen.values()];
  }

  normalizeBook(book) {
    const b = String(book || '').toLowerCase().trim();
    if (b === 'psalms' || b === 'psalm') return 'Psalm';
    const found = this.booksOrder.find((x) => x.toLowerCase() === b);
    if (found) return found;
    throw new Error(`Unknown book: ${book}`);
  }

  loadBook(book) {
    const name = this.normalizeBook(book);
    if (this.cache.has(name)) return this.cache.get(name);
    const file = path.join(this.baseDir, `${name}.json`);
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // Operator-facing copy: never leak fs paths (ENOENT) to the UI.
      const have = this.availableBooks();
      const hint = have.length > 0 ? ` (bundled sample covers: ${have.join(', ')})` : '';
      throw new Error(`${name} is not in the bundled offline sample${hint}. Import a full translation to look it up.`);
    }
    const data = raw[name] || raw; // files: { "Genesis": {...}, "Info": {...} }
    this.cache.set(name, data);
    return data;
  }

  // "John 3:16" or "Genesis 1:1-3" → { book, chapter, verseStart, verseEnd }
  parseReference(ref) {
    const m = String(ref || '')
      .trim()
      .match(/^([1-3]?\s?[A-Za-z ]+?)\s+(\d+):(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`Bad reference: ${ref}. Use like "John 3:16"`);
    return {
      book: this.normalizeBook(m[1]),
      chapter: String(Number(m[2])),
      verseStart: Number(m[3]),
      verseEnd: m[4] ? Number(m[4]) : Number(m[3]),
    };
  }

  getVerse(ref) {
    const { book, chapter, verseStart, verseEnd } = this.parseReference(ref);
    const bookData = this.loadBook(book);
    const verses = [];
    for (let v = verseStart; v <= verseEnd; v++) {
      const text = bookData?.[chapter]?.[String(v)];
      if (!text) throw new Error(`Verse not found: ${book} ${chapter}:${v}`);
      verses.push({
        book,
        chapter: Number(chapter),
        verse: v,
        text,
        reference: `${book} ${chapter}:${v}`,
        translation: this.translation,
      });
    }
    return verseEnd > verseStart ? verses : verses[0];
  }

  getChapter(book, chapter) {
    const name = this.normalizeBook(book);
    const bookData = this.loadBook(name);
    const ch = bookData[String(chapter)];
    if (!ch) throw new Error(`Chapter not found: ${name} ${chapter}`);
    return Object.entries(ch).map(([v, text]) => ({
      book: name,
      chapter: Number(chapter),
      verse: Number(v),
      text,
      reference: `${name} ${chapter}:${v}`,
      translation: this.translation,
    }));
  }

  getRandomVerse() {
    // Only pick from books actually present on disk (bundled sample ships a subset).
    const available = this.availableBooks();
    const pool = available.length > 0 ? available : this.booksOrder;
    const book = pool[Math.floor(Math.random() * pool.length)];
    const data = this.loadBook(book);
    const chapters = Object.keys(data).filter((k) => k !== 'Info');
    const ch = chapters[Math.floor(Math.random() * chapters.length)];
    const verses = Object.keys(data[ch]);
    const v = verses[Math.floor(Math.random() * verses.length)];
    return {
      book,
      chapter: Number(ch),
      verse: Number(v),
      text: data[ch][v],
      reference: `${book} ${ch}:${v}`,
      translation: this.translation,
    };
  }

  availableBooks() {
    try {
      const files = readdirSync(this.baseDir).filter((f) => f.toLowerCase().endsWith('.json'));
      return files
        .map((f) => path.basename(f, '.json'))
        .filter((b) => {
          try {
            this.normalizeBook(b);
            return true;
          } catch {
            return false;
          }
        });
    } catch {
      return [];
    }
  }

  /** Full translation in the renderer's BibleStore shape ({ name, books[] }). */
  exportTranslation() {
    const books = [];
    let order = 1;
    for (const bookName of this.availableBooks()) {
      let data;
      try {
        data = this.loadBook(bookName);
      } catch {
        continue;
      }
      const chapters = Object.entries(data)
        .filter(([k]) => k !== 'Info' && /^\d+$/.test(String(k)))
        .map(([chNum, verses]) => ({
          number: Number(chNum),
          verses: Object.entries(verses || {})
            .filter(([v]) => /^\d+$/.test(String(v)))
            .map(([vNum, text]) => ({ number: Number(vNum), text: String(text) }))
            .sort((a, b) => a.number - b.number),
        }))
        .sort((a, b) => a.number - b.number);
      if (chapters.length === 0) continue;
      books.push({ number: order++, name: bookName, chapters });
    }
    return {
      id: `bundled-${this.translation.toLowerCase()}`,
      name: this.translation === 'KJV' ? 'KJV (Bundled Sample)' : `${this.translation} (Bundled)`,
      books,
    };
  }

  setTranslation(t) {
    this.translation = t;
    this.cache.clear();
  }
}

const bibleService = new BibleService();

export default bibleService;
export { BibleService, BOOKS_ORDER };
