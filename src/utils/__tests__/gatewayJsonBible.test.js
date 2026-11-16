import { describe, it, expect } from 'vitest';
import { parseBible, detectBibleFormat } from 'shared/bible/index.js';

const GENESIS_JSON = JSON.stringify({
  Genesis: {
    1: { 1: 'In the beginning God created the heaven and the earth.', 2: 'And the earth was without form, and void.' },
    2: { 1: 'Thus the heavens and the earth were finished.' }
  }
});

describe('Bible Gateway JSON (bible-translations) import', () => {
  it('detects gatewayJson format', () => {
    expect(detectBibleFormat(GENESIS_JSON)).toBe('gatewayJson');
  });

  it('parses single-book files into searchable books', () => {
    const bible = parseBible(GENESIS_JSON, 'KJV-Genesis');
    expect(bible.books).toHaveLength(1);
    expect(bible.books[0].name).toBe('Genesis');
    expect(bible.books[0].chapters).toHaveLength(2);
    expect(bible.books[0].chapters[0].verses[0]).toMatchObject({ number: 1 });
    expect(bible.bookMap[bible.books[0].number]).toBeDefined();
    expect(Object.keys(bible.searchIndex || {}).length).toBeGreaterThan(0);
  });
});
