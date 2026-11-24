import { describe, expect, it } from 'vitest';
import {
  PREVIEW_TILE_IDS,
  defaultPreviewMultiview,
  normalizeColumnCount,
  normalizeVisibleTiles,
  normalizePreviewMultiview,
  togglePreviewTile,
  isScriptureLive,
  getTileById,
} from '../previewMultiview.js';

describe('previewMultiview layout prefs', () => {
  it('defaults to all tiles visible with 2 columns', () => {
    expect(defaultPreviewMultiview()).toEqual({
      visibleTiles: [...PREVIEW_TILE_IDS],
      columnCount: 2,
    });
  });

  it('clamps column count to 1..3 and falls back on garbage', () => {
    expect(normalizeColumnCount(1)).toBe(1);
    expect(normalizeColumnCount(3)).toBe(3);
    expect(normalizeColumnCount(0)).toBe(1);
    expect(normalizeColumnCount(9)).toBe(3);
    expect(normalizeColumnCount('abc')).toBe(2);
    expect(normalizeColumnCount(undefined)).toBe(2);
  });

  it('drops unknown tile ids and never returns an empty set', () => {
    expect(normalizeVisibleTiles(['output1', 'nope'])).toEqual(['output1']);
    expect(normalizeVisibleTiles([])).toEqual([...PREVIEW_TILE_IDS]);
    expect(normalizeVisibleTiles(undefined)).toEqual([...PREVIEW_TILE_IDS]);
  });

  it('normalizes a whole prefs object', () => {
    expect(normalizePreviewMultiview(null)).toEqual(defaultPreviewMultiview());
    expect(normalizePreviewMultiview({ visibleTiles: ['stage'], columnCount: 5 }))
      .toEqual({ visibleTiles: ['stage'], columnCount: 3 });
  });

  it('toggles tiles and refuses to hide the last one', () => {
    const all = [...PREVIEW_TILE_IDS];
    const withoutStage = togglePreviewTile(all, 'stage');
    expect(withoutStage).not.toContain('stage');
    expect(togglePreviewTile(withoutStage, 'stage')).toEqual(all);
    expect(togglePreviewTile(['stage'], 'stage')).toEqual([...PREVIEW_TILE_IDS]);
    expect(togglePreviewTile(all, 'unknown')).toEqual(all);
  });
});

describe('isScriptureLive', () => {
  it('is true only in bible mode with loaded content', () => {
    expect(isScriptureLive({ contentMode: 'bible', lyrics: ['Gen 1:1'] })).toBe(true);
    expect(isScriptureLive({ contentMode: 'bible', lyrics: [] })).toBe(false);
    expect(isScriptureLive({ contentMode: 'song', lyrics: ['Amazing grace'] })).toBe(false);
    expect(isScriptureLive({})).toBe(false);
  });
});

describe('getTileById', () => {
  it('resolves known tiles and null for unknown', () => {
    expect(getTileById('output1')?.route).toBe('output1');
    expect(getTileById('lowerthird')?.route).toBe('stream');
    expect(getTileById('nope')).toBeNull();
  });
});
