import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  ONLINE_BIBLE_TRANSLATIONS,
  cleanBollsText,
  fetchOnlineBooks,
  fetchOnlineChapter,
  downloadOnlineTranslation,
  clearOnlineCache,
} from '../onlineBible';

const realFetch = global.fetch;

const mockFetch = (handler) => {
  global.fetch = vi.fn(async (url, options) => handler(url, options));
};

afterEach(() => {
  global.fetch = realFetch;
  clearOnlineCache();
  vi.restoreAllMocks();
});

describe('onlineBible client', () => {
  it('ships a curated public-domain translation list', () => {
    const abbrs = ONLINE_BIBLE_TRANSLATIONS.map((t) => t.abbr);
    expect(abbrs).toEqual(['KJV', 'ASV', 'WEB', 'YLT']);
  });

  it('cleans Strong numbers, tags, and entities from verse text', () => {
    expect(cleanBollsText('In the beginning<S>7225</S> God<S>430</S> created')).toBe('In the beginning God created');
    expect(cleanBollsText('bread&nbsp;&amp; fish &#39;loaves&#39;')).toBe("bread & fish 'loaves'");
    expect(cleanBollsText('  many   spaces\nnew line  ')).toBe('many spaces new line');
    expect(cleanBollsText(null)).toBe('');
  });

  it('keeps the Protestant 66 with canonical names', async () => {
    const raw = Array.from({ length: 67 }, (_, i) => ({
      bookid: i + 1,
      name: i === 18 ? 'Psalms' : `Book${i + 1}`,
      chapters: 1,
    }));
    mockFetch(async () => ({ ok: true, json: async () => raw }));
    const books = await fetchOnlineBooks('KJV');
    expect(books).toHaveLength(66);
    expect(books[18]).toEqual({ number: 19, name: 'Psalm', chapters: 1 });
  });

  it('cleans and sorts chapter verses', async () => {
    mockFetch(async () => ({
      ok: true,
      json: async () => [
        { pk: 2, verse: 2, text: 'Second<S>1</S>' },
        { pk: 1, verse: 1, text: 'First&nbsp;verse' },
      ],
    }));
    const verses = await fetchOnlineChapter('KJV', 43, 3);
    expect(verses).toEqual([
      { number: 1, text: 'First verse' },
      { number: 2, text: 'Second' },
    ]);
  });

  it('downloads a translation into the store shape with progress', async () => {
    mockFetch(async (url) => {
      if (url.includes('/get-books/')) {
        return {
          ok: true,
          json: async () => [
            { bookid: 1, name: 'Genesis', chapters: 1 },
            ...Array.from({ length: 65 }, (_, i) => ({ bookid: i + 2, name: `Book${i + 2}`, chapters: 1 })),
          ],
        };
      }
      const m = url.match(/get-text\/\w+\/(\d+)\/(\d+)/);
      return {
        ok: true,
        json: async () => [{ pk: 1, verse: 1, text: `B${m[1]} C${m[2]}<S>1</S>` }],
      };
    });
    const seen = [];
    const bible = await downloadOnlineTranslation('WEB', {
      onProgress: (p) => seen.push(p.done),
    });
    expect(bible.id).toBe('bolls-web');
    expect(bible.name).toBe('World English Bible');
    expect(bible.books).toHaveLength(66);
    expect(bible.books[0].chapters[0].verses).toEqual([{ number: 1, text: 'B1 C1' }]);
    expect(bible.bookMap[43].name).toBe('John');
    expect(bible.searchIndex).toBeTruthy();
    expect(seen[seen.length - 1]).toBe(66);
  });

  it('retries a rate-limited chapter with backoff', async () => {
    let calls = 0;
    mockFetch(async (url) => {
      if (url.includes('/get-books/')) {
        return {
          ok: true,
          json: async () => [
            { bookid: 1, name: 'Genesis', chapters: 1 },
            ...Array.from({ length: 65 }, (_, i) => ({ bookid: i + 2, name: `Book${i + 2}`, chapters: 1 })),
          ],
        };
      }
      calls += 1;
      if (calls <= 2) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, json: async () => [{ pk: 1, verse: 1, text: 'x' }] };
    });
    const bible = await downloadOnlineTranslation('YLT', { onProgress: () => {} });
    expect(bible.books).toHaveLength(66);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('gives up on persistent rate limiting with a friendly message', async () => {
    mockFetch(async (url) => {
      if (url.includes('/get-books/')) {
        return {
          ok: true,
          json: async () => [
            { bookid: 1, name: 'Genesis', chapters: 1 },
            ...Array.from({ length: 65 }, (_, i) => ({ bookid: i + 2, name: `Book${i + 2}`, chapters: 1 })),
          ],
        };
      }
      return { ok: false, status: 429, json: async () => ({}) };
    });
    await expect(downloadOnlineTranslation('YLT', { onProgress: () => {} })).rejects.toThrow('busy right now');
  });

  it('aborts a download cleanly', async () => {
    clearOnlineCache();
    mockFetch(async (url) => {
      if (url.includes('/get-books/')) {
        return {
          ok: true,
          json: async () => [
            { bookid: 1, name: 'Genesis', chapters: 3 },
            ...Array.from({ length: 65 }, (_, i) => ({ bookid: i + 2, name: `Book${i + 2}`, chapters: 1 })),
          ],
        };
      }
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, json: async () => [{ pk: 1, verse: 1, text: 'x' }] };
    });
    const controller = new AbortController();
    const promise = downloadOnlineTranslation('KJV', {
      signal: controller.signal,
      onProgress: ({ done }) => { if (done >= 1) controller.abort(new Error('Import cancelled.')); },
    });
    await expect(promise).rejects.toThrow();
  });
});
