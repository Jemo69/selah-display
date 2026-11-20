import { describe, it, expect, beforeEach } from 'vitest';
import useBibleStore from '../BibleStore';

describe('BibleStore bibleVerseLog (reference-only request log)', () => {
  beforeEach(() => {
    localStorage.removeItem('bible-store');
    useBibleStore.setState({ bibleVerseLog: [] });
  });

  it('logs just the requested reference string — nothing more', () => {
    useBibleStore.getState().logBibleVerseRequest('Matthew 1:1');
    const state = useBibleStore.getState();
    expect(state.bibleVerseLog).toEqual(['Matthew 1:1']);
    // Plain string entry: no text, no translation, no metadata object.
    expect(typeof state.bibleVerseLog[0]).toBe('string');
  });

  it('trims whitespace and ignores empty requests', () => {
    useBibleStore.getState().logBibleVerseRequest('  John 3:16  ');
    useBibleStore.getState().logBibleVerseRequest('   ');
    useBibleStore.getState().logBibleVerseRequest(null);
    expect(useBibleStore.getState().bibleVerseLog).toEqual(['John 3:16']);
  });

  it('skips consecutive duplicates but keeps re-requests after another verse', () => {
    const { logBibleVerseRequest } = useBibleStore.getState();
    logBibleVerseRequest('Matthew 1:1');
    useBibleStore.getState().logBibleVerseRequest('Matthew 1:1');
    expect(useBibleStore.getState().bibleVerseLog).toEqual(['Matthew 1:1']);
    useBibleStore.getState().logBibleVerseRequest('John 3:16');
    useBibleStore.getState().logBibleVerseRequest('Matthew 1:1');
    expect(useBibleStore.getState().bibleVerseLog).toEqual([
      'Matthew 1:1',
      'John 3:16',
      'Matthew 1:1',
    ]);
  });

  it('clears the log', () => {
    useBibleStore.getState().logBibleVerseRequest('Matthew 1:1');
    useBibleStore.getState().clearBibleVerseLog();
    expect(useBibleStore.getState().bibleVerseLog).toEqual([]);
  });
});
