/**
 * Thin renderer client for the offline verse service
 * (plan: electron-bible-verse-service).
 * Prefers window.bibleAPI (main-process fs + cache), falls back to the
 * in-memory BibleStore so web builds keep working.
 */
import useBibleStore from '../context/BibleStore';

const getApi = () => (typeof window !== 'undefined' ? window.bibleAPI : null);

export async function fetchVerse(ref) {
  const api = getApi();
  if (api?.getVerse) return api.getVerse(ref);
  // Fallback: resolve from the loaded store.
  const store = useBibleStore.getState();
  const activeId = store.activeBibleId || store.defaultBibleId || Object.keys(store.bibles)[0];
  const bible = activeId ? store.bibles[activeId] : null;
  if (!bible) throw new Error('No Bible installed. Import a translation first.');
  const { searchBibleExperimental } = await import('shared/bible');
  const results = searchBibleExperimental(bible, ref, store.bibles, 5, store.defaultBibleId, true);
  if (!results.length) throw new Error(`Verse not found: ${ref}`);
  return {
    book: results[0].bookName || results[0].book,
    reference: results[0].reference,
    text: results[0].text,
    translation: results[0].bibleName,
  };
}

export async function fetchChapter(book, chapter) {
  const api = getApi();
  if (api?.getChapter) return api.getChapter(book, chapter);
  const store = useBibleStore.getState();
  const activeId = store.activeBibleId || store.defaultBibleId || Object.keys(store.bibles)[0];
  const bible = activeId ? store.bibles[activeId] : null;
  if (!bible) throw new Error('No Bible installed. Import a translation first.');
  const found = (bible.books || []).find(
    (b) => String(b.number) === String(book) || b.name?.toLowerCase() === String(book).toLowerCase()
  );
  const ch = found?.chapters?.find((c) => String(c.number) === String(chapter));
  if (!ch) throw new Error(`Chapter not found: ${book} ${chapter}`);
  return (ch.verses || []).map((v) => ({
    book: found.name,
    chapter: Number(chapter),
    verse: v.number,
    text: v.text,
    reference: `${found.name} ${chapter}:${v.number}`,
    translation: bible.name,
  }));
}

export async function fetchRandomVerse() {
  const api = getApi();
  if (api?.random) return api.random();
  const store = useBibleStore.getState();
  const ids = Object.keys(store.bibles || {});
  if (!ids.length) throw new Error('No Bible installed. Import a translation first.');
  const bible = store.bibles[store.activeBibleId] || store.bibles[ids[0]];
  const books = bible.books || [];
  const book = books[Math.floor(Math.random() * books.length)];
  const ch = book.chapters[Math.floor(Math.random() * book.chapters.length)];
  const v = ch.verses[Math.floor(Math.random() * ch.verses.length)];
  return {
    book: book.name,
    chapter: ch.number,
    verse: v.number,
    text: v.text,
    reference: `${book.name} ${ch.number}:${v.number}`,
    translation: bible.name,
  };
}
