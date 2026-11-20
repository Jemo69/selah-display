// src/speech/__tests__/verseSearchEngine.test.js — the worker's real scorer.
//
// The live-sermon audit found the containment counter (`rankVerses`) producing
// four wrong references at 0.62–0.73. These tests pin the indexed replacement:
// a verbatim reading resolves, a short/common tail does not, and the index is
// reused for the same translation.

import { describe, it, expect } from 'vitest';
import { createVerseSearcher } from '../verseSearchEngine.js';

const BIBLE = {
  id: 'test',
  name: 'Test',
  books: [
    {
      number: 43,
      name: 'John',
      chapters: [
        {
          number: 3,
          verses: [
            { number: 1, text: 'There was a man of the Pharisees, named Nicodemus.' },
            { number: 16, text: 'For God so loved the world, that he gave his only begotten Son.' },
            { number: 17, text: 'For God did not send his Son into the world to condemn the world.' },
            { number: 18, text: 'He that believeth on him is not condemned.' },
          ],
        },
      ],
    },
    {
      number: 19,
      name: 'Psalm',
      chapters: [
        {
          number: 23,
          verses: [{ number: 1, text: 'The LORD is my shepherd; I shall not want.' }],
        },
      ],
    },
    {
      number: 31,
      name: 'Obadiah',
      chapters: [
        {
          number: 1,
          verses: [{ number: 5, text: 'If thieves came to thee, would they not leave some grapes?' }],
        },
      ],
    },
  ],
};

describe('createVerseSearcher', () => {
  it('resolves a verbatim reading with the indexed scorer', () => {
    const searcher = createVerseSearcher();
    const results = searcher.search(
      BIBLE,
      'for God so loved the world that he gave his only begotten Son'
    );
    expect(results).toHaveLength(1);
    expect(results[0].reference).toBe('John 3:16');
    expect(results[0].source).toBe('index');
    expect(results[0].score).toBeGreaterThan(0.5);
    expect(searcher.indexed).toBe(true);
  });

  it('reuses the index for the same translation', () => {
    const searcher = createVerseSearcher();
    searcher.search(BIBLE, 'for God so loved the world that he gave his only begotten Son');
    const second = searcher.search(BIBLE, 'the LORD is my shepherd I shall not want');
    expect(second[0].reference).toBe('Psalm 23:1');
  });

  it('rebuilds when the translation object changes', () => {
    const searcher = createVerseSearcher();
    searcher.search(BIBLE, 'for God so loved the world that he gave his only begotten Son');
    const empty = { id: 'empty', name: 'Empty', books: [] };
    expect(searcher.search(empty, 'for God so loved the world')).toBeNull();
  });

  it('does not turn a short common tail into a verse', () => {
    const searcher = createVerseSearcher();
    expect(searcher.search(BIBLE, 'But leave')).toBeNull();
    expect(searcher.search(BIBLE, 'leave grapes')).toBeNull();
  });

  it('uses the current-reference prior when supplied', () => {
    const searcher = createVerseSearcher();
    const results = searcher.search(
      BIBLE,
      'did not send his Son into the world to condemn the world',
      { currentReference: 'John 3:16' }
    );
    expect(results[0].reference).toBe('John 3:17');
  });

  it('returns one result, not a list of competing cards', () => {
    const searcher = createVerseSearcher();
    const results = searcher.search(
      BIBLE,
      'for God so loved the world that he gave his only begotten Son'
    );
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('index');
  });

  it('reset drops the retained index', () => {
    const searcher = createVerseSearcher();
    searcher.search(BIBLE, 'for God so loved the world that he gave his only begotten Son');
    expect(searcher.indexed).toBe(true);
    searcher.reset();
    expect(searcher.indexed).toBe(false);
  });

  it('returns null for unusable input', () => {
    const searcher = createVerseSearcher();
    expect(searcher.search(null, 'for God so loved the world')).toBeNull();
    expect(searcher.search(BIBLE, '')).toBeNull();
    expect(searcher.search(BIBLE, null)).toBeNull();
  });
});
