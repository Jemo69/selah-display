// src/speech/__tests__/verseCorpus.test.js — the containment scorer's floor.
//
// A short transcript tail is common: a low-confidence recognizer emits two
// words, or a speaker pauses after a phrase. The old floor used
// Math.min(minMatches, queryTokens.length), which let a one-word query satisfy
// the guard and score 1.0 against any verse containing that word. These tests
// pin the stricter floor while keeping an explicit minMatches: 1 opt-in.

import { describe, it, expect } from 'vitest';
import { rankVerses, textOverlapScore } from '../verseCorpus.js';

const BIBLE = {
  id: 'test',
  name: 'Test',
  books: [
    {
      number: 31,
      name: 'Obadiah',
      chapters: [
        {
          number: 1,
          verses: [
            { number: 5, text: 'If thieves came to thee, would they not leave some grapes?' },
          ],
        },
      ],
    },
  ],
};

describe('textOverlapScore minimum evidence', () => {
  it('rejects a one-word tail even when the word appears in the verse', () => {
    expect(textOverlapScore('But leave', 'would they not leave some grapes?')).toBe(0);
  });

  it('rejects a two-word tail below the default minMatches', () => {
    expect(textOverlapScore('leave grapes', 'would they not leave some grapes?')).toBe(0);
  });

  it('keeps a caller that explicitly asks for one match working', () => {
    expect(textOverlapScore('leave', 'would they not leave some grapes?', 1)).toBe(1);
  });

  it('still scores a phrase with enough content words', () => {
    expect(
      textOverlapScore(
        'thieves leave grapes',
        'If thieves came to thee, would they not leave some grapes?'
      )
    ).toBe(1);
  });
});

describe('rankVerses minimum evidence', () => {
  it('does not return a verse for a two-word tail', () => {
    expect(rankVerses('But leave', BIBLE)).toEqual([]);
  });

  it('still returns the verse for a phrase with enough content words', () => {
    const results = rankVerses('thieves leave grapes', BIBLE);
    expect(results).toHaveLength(1);
    expect(results[0].reference).toBe('Obadiah 1:5');
  });
});
