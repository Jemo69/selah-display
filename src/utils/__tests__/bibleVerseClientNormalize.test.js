import { describe, expect, it } from 'vitest';
import { normalizeVerseResult } from '../bibleVerseClient';

describe('normalizeVerseResult (offline verse service range form)', () => {
  it('passes a single verse through untouched', () => {
    const single = {
      book: 'John',
      chapter: 3,
      verse: 16,
      text: 'For God so loved the world…',
      reference: 'John 3:16',
      translation: 'KJV',
    };
    expect(normalizeVerseResult(single, 'John 3:16')).toBe(single);
  });

  it('joins a range array under the range reference', () => {
    const range = [
      { book: 'Genesis', chapter: 1, verse: 1, text: 'In the beginning…', reference: 'Genesis 1:1', translation: 'KJV' },
      { book: 'Genesis', chapter: 1, verse: 2, text: 'And the earth…', reference: 'Genesis 1:2', translation: 'KJV' },
      { book: 'Genesis', chapter: 1, verse: 3, text: 'And God said…', reference: 'Genesis 1:3', translation: 'KJV' },
    ];
    const out = normalizeVerseResult(range, 'Genesis 1:1-3');
    expect(out.reference).toBe('Genesis 1:1-3');
    expect(out.text).toBe('In the beginning… And the earth… And God said…');
    expect(out.translation).toBe('KJV');
    expect(out.verses).toHaveLength(3);
  });

  it('throws on an empty range instead of rendering an empty card', () => {
    expect(() => normalizeVerseResult([], 'Psalms 99:9')).toThrow('Verse not found');
  });
});
