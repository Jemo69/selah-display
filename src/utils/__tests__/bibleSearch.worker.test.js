import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const bible = {
  id: 'b1',
  name: 'KJV',
  books: [
    {
      number: 1,
      name: 'Genesis',
      chapters: [
        {
          number: 1,
          verses: [{ number: 1, text: 'In the beginning God created the heaven' }]
        }
      ]
    }
  ]
};

describe('bibleSearch.worker currentBible retention', () => {
  let postMessage;

  beforeEach(() => {
    postMessage = vi.fn();
    vi.stubGlobal('self', { postMessage, onmessage: null });
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const loadWorkerAndGetHandler = async () => {
    await import('../../utils/bibleSearch.worker.js');
    return self.onmessage;
  };

  it('keeps searching on subsequent keystrokes that omit currentBible', async () => {
    const handler = await loadWorkerAndGetHandler();

    handler({ data: { query: 'beginning', currentBible: bible, allBibles: {}, maxResults: 30, defaultBibleId: null, searchAll: false } });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].length).toBeGreaterThan(0);

    handler({ data: { query: 'heaven', allBibles: {}, maxResults: 30, defaultBibleId: null, searchAll: false } });
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1][0].length).toBeGreaterThan(0);
  });

  it('searches across all bibles using the retained currentBible as tiebreaker', async () => {
    const handler = await loadWorkerAndGetHandler();
    const secondBible = {
      id: 'b2',
      name: 'NIV',
      books: [
        {
          number: 1,
          name: 'Genesis',
          chapters: [{ number: 1, verses: [{ number: 1, text: 'In the beginning NIV text' }] }]
        }
      ]
    };

    handler({ data: { query: 'beginning', currentBible: bible, allBibles: { b1: bible, b2: secondBible }, maxResults: 30, defaultBibleId: null, searchAll: true, refreshBibles: true } });

    expect(postMessage).toHaveBeenCalledTimes(1);
    const results = postMessage.mock.calls[0][0];
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.bibleId === 'b2')).toBe(true);
  });

  it('drops evicted bibles from its cached corpus when pruneBibles is sent', async () => {
    const handler = await loadWorkerAndGetHandler();
    const secondBible = {
      id: 'b2',
      name: 'NIV',
      books: [
        {
          number: 1,
          name: 'Genesis',
          chapters: [{ number: 1, verses: [{ number: 1, text: 'In the beginning NIV text' }] }]
        }
      ]
    };

    handler({ data: { query: 'beginning', currentBible: bible, allBibles: { b1: bible, b2: secondBible }, maxResults: 30, defaultBibleId: null, searchAll: true, refreshBibles: true } });
    expect(postMessage.mock.calls[0][0].some((r) => r.bibleId === 'b2')).toBe(true);

    handler({ data: { pruneBibles: { b1: bible } } });

    handler({ data: { query: 'beginning', allBibles: {}, maxResults: 30, defaultBibleId: null, searchAll: true } });
    const results = postMessage.mock.calls.at(-1)[0];
    expect(results.some((r) => r.bibleId === 'b2')).toBe(false);
  });
});

describe('bibleSearch.worker experimental flag', () => {
  let postMessage;

  const sentenceBible = () => {
    const verses = [
      { number: 16, text: 'For God so loved the world that he gave his only begotten Son that whosoever believeth in him should not perish but have everlasting life' },
      { number: 17, text: 'For the elders sat in the gate speaking of love' },
    ];
    const bible = {
      id: 'kjv',
      name: 'KJV',
      books: [{ number: 43, name: 'John', chapters: [{ number: 3, verses }] }],
    };
    // Minimal compatible searchIndex (same shape parseBible builds).
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

  beforeEach(() => {
    postMessage = vi.fn();
    vi.stubGlobal('self', { postMessage, onmessage: null });
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const loadHandler = async () => {
    await import('../../utils/bibleSearch.worker.js');
    return self.onmessage;
  };

  it('routes experimental:true to sentence-first ranking (typo query finds John 3:16)', async () => {
    const handler = await loadHandler();
    const bible = sentenceBible();
    handler({ data: { query: 'for God so love the word', currentBible: bible, allBibles: {}, maxResults: 10, qid: 1, experimental: true } });
    const results = postMessage.mock.calls[0][0];
    const list = Array.isArray(results) ? results : results.results;
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].reference).toBe('John 3:16');
  });

  it('omitted flag keeps the default per-word ranking path', async () => {
    const handler = await loadHandler();
    const bible = sentenceBible();
    handler({ data: { query: 'for God so love the word', currentBible: bible, allBibles: {}, maxResults: 10, qid: 1 } });
    const results = postMessage.mock.calls[0][0];
    const list = Array.isArray(results) ? results : results.results;
    // Default indexed path misses the typo query entirely (capped-posting
    // intersection) — proving the flag actually switches rankers.
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((r) => r.reference === 'John 3:16')).toBe(false);
  });
});
