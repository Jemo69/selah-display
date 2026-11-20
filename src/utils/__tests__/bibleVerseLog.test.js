import { describe, it, expect } from 'vitest';
import { normalizeVerseLogReference, shouldLogBibleVerseRequest } from '../bibleVerseLog';

describe('shouldLogBibleVerseRequest (verse-log send wiring)', () => {
  it('logs first-slide sends, including intentional re-sends', () => {
    expect(shouldLogBibleVerseRequest({ slideIndex: 0, reference: 'Matthew 1:1', previousReference: 'John 3:16' })).toBe(true);
    expect(shouldLogBibleVerseRequest({ slideIndex: 0, reference: 'Matthew 1:1', previousReference: 'Matthew 1:1' })).toBe(true);
  });

  it('logs later-slide sends when they show a new verse', () => {
    // Previous-verse button lands on the last slide of another verse.
    expect(shouldLogBibleVerseRequest({ slideIndex: 2, reference: 'Matthew 1:1', previousReference: 'Matthew 1:2' })).toBe(true);
  });

  it('skips same-reference slide navigation', () => {
    expect(shouldLogBibleVerseRequest({ slideIndex: 1, reference: 'Matthew 1:1', previousReference: 'Matthew 1:1', previousContentMode: 'bible' })).toBe(false);
    expect(shouldLogBibleVerseRequest({ slideIndex: 3, reference: 'Matthew 1:1', previousReference: '  Matthew 1:1 ', previousContentMode: 'bible' })).toBe(false);
  });

  it('never lets a same-named song suppress logging', () => {
    expect(shouldLogBibleVerseRequest({ slideIndex: 2, reference: 'Matthew 1:1', previousReference: 'Matthew 1:1', previousContentMode: 'lyrics' })).toBe(true);
    expect(shouldLogBibleVerseRequest({ slideIndex: 2, reference: 'Matthew 1:1', previousReference: 'Matthew 1:1', previousContentMode: undefined })).toBe(true);
  });

  it('rejects empty references and logs when the slide is unknown', () => {
    expect(shouldLogBibleVerseRequest({ slideIndex: 0, reference: '   ', previousReference: '' })).toBe(false);
    expect(shouldLogBibleVerseRequest({ slideIndex: 0, reference: null, previousReference: '' })).toBe(false);
    expect(shouldLogBibleVerseRequest({ slideIndex: undefined, reference: 'Matthew 1:1', previousReference: '' })).toBe(true);
  });

  it('normalizes references to trimmed strings', () => {
    expect(normalizeVerseLogReference('  John 3:16 ')).toBe('John 3:16');
    expect(normalizeVerseLogReference(null)).toBe('');
    expect(normalizeVerseLogReference(42)).toBe('');
  });
});
