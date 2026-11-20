// src/speech/__tests__/detectVerse.test.js
//
// Plan 11: "Three detectors, tried in strict order, because the first is
// far more precise than the second and the second far more precise than
// the third." … "Nothing, when none of them fire."
//
// Plan 14: "Pure-function unit tests — Reference parsing, suggestion
// ranking, confidence thresholds, and confidence-gated suppression."
import { describe, it, expect } from 'vitest';
import { detectVerse, detectVerseFromSegment } from '../detectVerse.js';
import THRESHOLDS from '../thresholds.js';

/** A scored detector-3 candidate, as the verse-search worker posts it. */
const fuzzyHit = (over = {}) => ({
  reference: 'John 3:16',
  bookName: 'John',
  chapter: 3,
  verse: 16,
  text: 'For God so loved the world, that he gave his only begotten Son',
  score: 0.98,
  bibleId: 'b1',
  bibleName: 'KJV',
  ...over,
});

describe('the plan examples, verbatim', () => {
  it('"John chapter three verse sixteen" -> John 3:16 (detector 1)', () => {
    const suggestion = detectVerse('John chapter three verse sixteen');
    expect(suggestion.detector).toBe('spoken');
    expect(suggestion.verse).toMatchObject({ book: 'John', chapter: 3, verse: 16, endVerse: null });
    expect(suggestion.verse.reference).toBe('John 3:16');
    expect(suggestion.confidence).toBeCloseTo(THRESHOLDS.detectors.spoken);
  });

  it('"first Peter five" -> 1 Peter 5 (detector 1)', () => {
    const suggestion = detectVerse('first Peter five');
    expect(suggestion.detector).toBe('spoken');
    expect(suggestion.verse).toMatchObject({ book: '1 Peter', chapter: 5, verse: 1 });
    expect(suggestion.verse.reference).toBe('1 Peter 5:1');
  });

  it('"forty two" -> nothing (digits without a book are not a reference)', () => {
    expect(detectVerse('forty two')).toBeNull();
  });

  it('"Psalms twenty three" -> Psalm 23:1 (detector 2 — the table owns the plural)', () => {
    const suggestion = detectVerse('Psalms twenty three');
    expect(suggestion.detector).toBe('alias');
    expect(suggestion.verse).toMatchObject({ book: 'Psalm', chapter: 23, verse: 1 });
    expect(suggestion.verse.reference).toBe('Psalm 23:1');
  });

  it('spoken ranges: "sixteen through eighteen" inside a reference -> 16–18', () => {
    const suggestion = detectVerse('John chapter three verse sixteen through eighteen');
    expect(suggestion.verse).toMatchObject({ chapter: 3, verse: 16, endVerse: 18 });
    expect(suggestion.verse.reference).toBe('John 3:16-18');
  });
});

describe('ASR punctuation', () => {
  it('a comma after the chapter does not silently fall back to verse 1', () => {
    expect(detectVerse('Isaiah chapter 45, verse 2, NIV').verse.reference).toBe('Isaiah 45:2');
    expect(detectVerse('Matthew chapter 17, verse 21.').verse.reference).toBe('Matthew 17:21');
    expect(detectVerse('Genesis chapter 27, verses 38 to 40.').verse.reference).toBe('Genesis 27:38-40');
  });
});

describe('detector ordering: strict, first that fires wins', () => {
  it('detector 1 wins even when the table AND a fuzzy hit also match', () => {
    // "Psalm" is BOTH canonical (detector 1) and an alias-table row
    // (detector 2). If 2 ran first the detector would read "alias".
    const suggestion = detectVerse('Psalm twenty three', {
      searchResults: [fuzzyHit({ reference: 'Psalm 23:1', score: 0.99 })],
    });
    expect(suggestion.detector).toBe('spoken');
    expect(suggestion.verse.reference).toBe('Psalm 23:1');
  });

  it('a transcript matching only detector 2 wins via 2, never reaching 3', () => {
    // "Revelations" is not canonical, so detector 1 cannot fire; the fuzzy
    // results are present and would match — detector 2 must still win.
    const suggestion = detectVerse('revelations chapter twenty two', {
      searchResults: [fuzzyHit()],
    });
    expect(suggestion.detector).toBe('alias');
    expect(suggestion.verse).toMatchObject({ book: 'Revelation', chapter: 22, verse: 1 });
    expect(suggestion.ambiguous).toBe(false);
  });

  it('an ambiguous table hit returns its candidates, still ahead of detector 3', () => {
    const suggestion = detectVerse('corinthian five sixteen', {
      searchResults: [fuzzyHit()],
    });
    expect(suggestion.detector).toBe('alias');
    expect(suggestion.ambiguous).toBe(true);
    expect(suggestion.candidates).toEqual(['1 Corinthians', '2 Corinthians']);
    expect(suggestion.verse.reference).toBe('1 or 2 Corinthians 5:16');
    expect(suggestion.confidence).toBeCloseTo(THRESHOLDS.detectors.aliasAmbiguous);
  });

  it('a transcript matching only detector 3 wins via 3', () => {
    const suggestion = detectVerse(
      'for God so loved the world that he gave his only begotten Son',
      { searchResults: [fuzzyHit()] }
    );
    expect(suggestion.detector).toBe('fuzzy');
    expect(suggestion.verse.reference).toBe('John 3:16');
    expect(suggestion.matchConfidence).toBe(0.98);
    expect(suggestion.confidence).toBeCloseTo(0.98);
  });

  it('nothing fires -> null, never a best guess', () => {
    expect(detectVerse('the coffee is warm this morning')).toBeNull();
    expect(detectVerse('the coffee is warm this morning', { searchResults: [] })).toBeNull();
    expect(detectVerse('')).toBeNull();
    expect(detectVerse(null)).toBeNull();
    expect(detectVerse('I have three children and two dogs')).toBeNull();
  });

  it('detector 3 with no search results is null (the rail spins up the worker only then)', () => {
    expect(detectVerse('for God so loved the world that he gave his only begotten Son')).toBeNull();
  });
});

describe('confidence-gated suppression: the shared threshold applies to the segment', () => {
  it('a spoken reference on a bad segment is suppressed (0.95 × 0.5 = 0.475 < 0.6)', () => {
    expect(detectVerse('John chapter three verse sixteen', { segmentConfidence: 0.5 })).toBeNull();
  });

  it('a perfect fuzzy match on a noisy segment is NOT a 98% match', () => {
    const down = detectVerse('for God so loved the world that he gave his only begotten Son', {
      searchResults: [fuzzyHit()],
      segmentConfidence: 0.7,
    });
    expect(down.confidence).toBeCloseTo(0.98 * 0.7); // 0.686
    expect(down.confidence).toBeLessThan(0.98);

    const suppressed = detectVerse('for God so loved the world that he gave his only begotten Son', {
      searchResults: [fuzzyHit()],
      segmentConfidence: 0.5,
    });
    expect(suppressed).toBeNull(); // 0.49 — never reaches the card
  });

  it('a good segment keeps the suggestion', () => {
    const suggestion = detectVerse('John chapter three verse sixteen', { segmentConfidence: 0.9 });
    expect(suggestion).not.toBeNull();
    expect(suggestion.confidence).toBeCloseTo(0.95 * 0.9);
  });

  it('weak fuzzy candidates never fire even before weighting', () => {
    expect(
      detectVerse('some vaguely familiar set of words', {
        searchResults: [fuzzyHit({ score: 0.4 })],
      })
    ).toBeNull();
  });
});

describe('detectVerseFromSegment: gates run before detection', () => {
  it('a clean segment suggests John 3:16', () => {
    const suggestion = detectVerseFromSegment({
      text: 'John 3:16',
      peak: 0.4,
      rms: 0.12,
      noSpeechProb: 0.08,
    });
    expect(suggestion.detector).toBe('spoken');
    expect(suggestion.verse.reference).toBe('John 3:16');
    // The segment weight (1 − 0.08) multiplied into the confidence.
    expect(suggestion.confidence).toBeCloseTo(0.95 * 0.92);
  });

  it('reweighted by the segment: a low-confidence segment lowers the card', () => {
    const suggestion = detectVerseFromSegment({
      text: 'John chapter three verse sixteen',
      peak: 0.4,
      rms: 0.12,
      noSpeechProb: 0.35,
    });
    expect(suggestion.confidence).toBeCloseTo(0.95 * 0.65);
  });
});
