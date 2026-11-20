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

  it('logs every request, including immediate repeats of the same verse', () => {
    useBibleStore.getState().logBibleVerseRequest('Matthew 1:1');
    useBibleStore.getState().logBibleVerseRequest('Matthew 1:1');
    useBibleStore.getState().logBibleVerseRequest('John 3:16');
    expect(useBibleStore.getState().bibleVerseLog).toEqual([
      'John 3:16',
      'Matthew 1:1',
      'Matthew 1:1',
    ]);
  });

  it('caps the log at 100 entries', () => {
    for (let i = 0; i < 105; i += 1) {
      useBibleStore.getState().logBibleVerseRequest(`Genesis 1:${i + 1}`);
    }
    const log = useBibleStore.getState().bibleVerseLog;
    expect(log).toHaveLength(100);
    expect(log[0]).toBe('Genesis 1:105');
  });

  it('clears the log', () => {
    useBibleStore.getState().logBibleVerseRequest('Matthew 1:1');
    useBibleStore.getState().clearBibleVerseLog();
    expect(useBibleStore.getState().bibleVerseLog).toEqual([]);
  });
});
