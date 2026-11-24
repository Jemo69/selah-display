import { createLogger } from './logger.js';
import { normalizeContentMode, CONTENT_MODE_BIBLE } from './contentMode.js';

const log = createLogger('PreviewMultiview');

// Tiles shown on the /preview multiview grid. `route` is the live output route
// embedded in an iframe; tiles without a route render a graceful placeholder.
export const PREVIEW_TILE_IDS = ['output1', 'output2', 'stage', 'clock', 'lowerthird', 'bible'];

export const PREVIEW_TILES = [
  { id: 'output1', label: 'Main Lyric — Output 1', route: 'output1', kind: 'frame' },
  { id: 'output2', label: 'Main Lyric — Output 2', route: 'output2', kind: 'frame' },
  { id: 'stage', label: 'Stage Confidence', route: 'stage', kind: 'frame' },
  { id: 'clock', label: 'Countdown / Time', route: 'time', kind: 'optional-frame' },
  { id: 'lowerthird', label: 'Stream Lower-Third', route: 'stream', kind: 'frame' },
  { id: 'bible', label: 'Bible Scripture Card', route: null, kind: 'scripture' },
];

export const PREVIEW_MIN_COLUMNS = 1;
export const PREVIEW_MAX_COLUMNS = 3;
export const DEFAULT_PREVIEW_COLUMNS = 2;

export function defaultPreviewMultiview() {
  return {
    visibleTiles: [...PREVIEW_TILE_IDS],
    columnCount: DEFAULT_PREVIEW_COLUMNS,
  };
}

export function normalizeColumnCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PREVIEW_COLUMNS;
  return Math.min(PREVIEW_MAX_COLUMNS, Math.max(PREVIEW_MIN_COLUMNS, parsed));
}

export function normalizeVisibleTiles(visibleTiles) {
  if (!Array.isArray(visibleTiles)) return [...PREVIEW_TILE_IDS];
  const kept = visibleTiles.filter((id) => PREVIEW_TILE_IDS.includes(id));
  return kept.length > 0 ? kept : [...PREVIEW_TILE_IDS];
}

export function normalizePreviewMultiview(value) {
  if (!value || typeof value !== 'object') return defaultPreviewMultiview();
  return {
    visibleTiles: normalizeVisibleTiles(value.visibleTiles),
    columnCount: normalizeColumnCount(value.columnCount),
  };
}

export function togglePreviewTile(visibleTiles, tileId) {
  if (!PREVIEW_TILE_IDS.includes(tileId)) {
    log.warn('togglePreviewTile ignored unknown tile', { tileId });
    return normalizeVisibleTiles(visibleTiles);
  }
  const current = normalizeVisibleTiles(visibleTiles);
  if (current.includes(tileId)) {
    const next = current.filter((id) => id !== tileId);
    // Never allow an empty grid — fall back to defaults instead.
    return next.length > 0 ? next : [...PREVIEW_TILE_IDS];
  }
  return PREVIEW_TILE_IDS.filter((id) => current.includes(id) || id === tileId);
}

// Scripture is "live" when the active content mode is Bible and there is
// lyric content loaded. Reads the same store shape the outputs read.
export function isScriptureLive(state = {}) {
  const mode = normalizeContentMode(state.contentMode);
  const hasContent = Array.isArray(state.lyrics) && state.lyrics.length > 0;
  return mode === CONTENT_MODE_BIBLE && hasContent;
}

export function getTileById(tileId) {
  return PREVIEW_TILES.find((tile) => tile.id === tileId) || null;
}

// Build an iframe src for a live output route that works under both the dev
// BrowserRouter and the production HashRouter.
export function buildPreviewFrameSrc(route) {
  if (typeof window === 'undefined') return `/${route}`;
  const hash = window.location.hash || '';
  if (hash.startsWith('#/')) return `#/${route}`;
  return `/${route}`;
}
