import { useMemo } from 'react';
import useLyricsStore from '../context/LyricsStore';
import {
  useLyricsState,
  useOutputState,
  useIndividualOutputState,
  usePreviewMultiviewState,
} from '../hooks/useStoreSelectors';
import {
  PREVIEW_TILES,
  buildPreviewFrameSrc,
  isScriptureLive,
  normalizeColumnCount,
  togglePreviewTile,
} from '../utils/previewMultiview.js';
import { createLogger } from '../utils/logger.js';
import { Button } from '@/components/ui/button';

const logger = createLogger('Preview');

function livePositionText(lyrics, selectedLine) {
  if (!Array.isArray(lyrics) || lyrics.length === 0) return 'no content loaded';
  if (selectedLine == null) return `${lyrics.length} lines loaded`;
  return `line ${selectedLine + 1} of ${lyrics.length}`;
}

function StatusBadge({ live, liveText, offText }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs font-semibold text-neutral-100"
      role="status"
    >
      <span aria-hidden="true">{live ? '●' : '○'}</span>
      <span>{live ? liveText : offText}</span>
    </span>
  );
}

function FrameTile({ tile, live, liveText, offText }) {
  const src = useMemo(() => buildPreviewFrameSrc(tile.route), [tile.route]);
  return (
    <section
      aria-label={tile.label}
      className="flex min-h-64 flex-col overflow-hidden rounded-lg border-2 border-neutral-700 bg-neutral-950"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-neutral-700 bg-neutral-900 px-3 py-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-neutral-100">{tile.label}</h2>
        <StatusBadge live={live} liveText={liveText} offText={offText} />
      </header>
      <iframe
        title={tile.label}
        src={src}
        loading="lazy"
        className="h-64 w-full border-0 bg-black motion-reduce:transition-none"
      />
    </section>
  );
}

function PlaceholderTile({ tile, liveText, offText, live, children }) {
  return (
    <section
      aria-label={tile.label}
      className="flex min-h-64 flex-col overflow-hidden rounded-lg border-2 border-dashed border-neutral-600 bg-neutral-950"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-neutral-700 bg-neutral-900 px-3 py-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-neutral-100">{tile.label}</h2>
        <StatusBadge live={live} liveText={liveText} offText={offText} />
      </header>
      <div className="flex flex-1 items-center justify-center px-4 py-6 text-center">{children}</div>
    </section>
  );
}

export default function Preview() {
  logger.info('Preview mounted');

  const { lyrics, selectedLine, bibleVersion, lyricsFileName, songMetadata } = useLyricsState();
  const { isOutputOn } = useOutputState();
  const { output1Enabled, output2Enabled, streamEnabled, stageEnabled } = useIndividualOutputState();
  const { previewMultiview, setPreviewMultiviewTiles, setPreviewMultiviewColumns } =
    usePreviewMultiviewState();

  const storeState = useLyricsStore((state) => ({
    contentMode: state.contentMode,
    lyrics: state.lyrics,
  }));
  const scriptureLive = isScriptureLive(storeState);

  const visibleTiles = previewMultiview.visibleTiles;
  const columnCount = normalizeColumnCount(previewMultiview.columnCount);

  const currentLine = Array.isArray(lyrics) && selectedLine != null ? lyrics[selectedLine] : '';
  const positionText = livePositionText(lyrics, selectedLine);
  const scriptureTitle =
    songMetadata?.title || lyricsFileName || (bibleVersion ? `Bible — ${bibleVersion}` : 'Scripture');

  const tileProps = {
    output1: {
      live: Boolean(isOutputOn && output1Enabled),
      liveText: `LIVE — ${positionText}`,
      offText: 'Off — output disabled',
    },
    output2: {
      live: Boolean(isOutputOn && output2Enabled),
      liveText: `LIVE — ${positionText}`,
      offText: 'Off — output disabled',
    },
    lowerthird: {
      live: Boolean(isOutputOn && streamEnabled && currentLine),
      liveText: `LIVE — ${positionText}`,
      offText: 'Off — stream band disabled',
    },
    stage: {
      live: Boolean(isOutputOn && stageEnabled),
      liveText: `LIVE — ${positionText}`,
      offText: 'Off — stage disabled',
    },
  };

  return (
    <div className="min-h-screen bg-neutral-950 px-4 py-6 text-neutral-100">
      <div className="mx-auto max-w-7xl">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-neutral-400">
              Selah
            </p>
            <h1 className="text-2xl font-black uppercase">Preview Multiview</h1>
            <p className="mt-1 text-sm text-neutral-400">
              One monitor showing every live surface. Tiles embed the same live output routes.
            </p>
          </div>
          <a
            href="/"
            className="rounded-md border border-neutral-600 px-3 py-2 text-sm font-semibold text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            ← Back to control panel
          </a>
        </header>

        <div
          className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border-2 border-neutral-700 bg-neutral-900 px-4 py-3"
          role="group"
          aria-label="Multiview layout preferences"
        >
          <div className="flex items-center gap-2">
            <span id="mv-columns-label" className="text-xs font-bold uppercase tracking-wide text-neutral-300">
              Columns
            </span>
            <div className="flex gap-1" role="group" aria-labelledby="mv-columns-label">
              {[1, 2, 3].map((count) => (
                <Button
                  key={count}
                  variant={columnCount === count ? 'default' : 'outline'}
                  size="sm"
                  aria-pressed={columnCount === count}
                  onClick={() => setPreviewMultiviewColumns(count)}
                  className="focus-visible:ring-2 focus-visible:ring-white"
                >
                  {count}
                </Button>
              ))}
            </div>
          </div>
          <fieldset>
            <legend className="text-xs font-bold uppercase tracking-wide text-neutral-300">
              Visible tiles
            </legend>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {PREVIEW_TILES.map((tile) => (
                <label
                  key={tile.id}
                  className="inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-200"
                >
                  <input
                    type="checkbox"
                    checked={visibleTiles.includes(tile.id)}
                    onChange={() => setPreviewMultiviewTiles(togglePreviewTile(visibleTiles, tile.id))}
                    className="h-4 w-4 accent-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                  />
                  {tile.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <main
          className="grid gap-4"
          style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
        >
          {visibleTiles.map((tileId) => {
            const tile = PREVIEW_TILES.find((t) => t.id === tileId);
            if (!tile) return null;

            if (tile.kind === 'frame') {
              const props = tileProps[tile.id] || { live: false, liveText: 'LIVE', offText: 'Off' };
              return <FrameTile key={tile.id} tile={tile} {...props} />;
            }

            if (tile.kind === 'optional-frame') {
              // No /time route exists yet (service scheduler, feature #01).
              // Degrade to a live clock card instead of an empty frame.
              return (
                <PlaceholderTile
                  key={tile.id}
                  tile={tile}
                  live={false}
                  liveText="LIVE"
                  offText="○ Standby — no /time route"
                >
                  <div>
                    <p className="text-3xl font-black tabular-nums" aria-label="Current time">
                      {new Date().toLocaleTimeString()}
                    </p>
                    <p className="mt-2 text-sm text-neutral-400">
                      Countdown scheduling arrives with the /time route. This tile will embed it
                      automatically when present.
                    </p>
                  </div>
                </PlaceholderTile>
              );
            }

            if (tile.kind === 'scripture') {
              if (!scriptureLive) return null;
              return (
                <PlaceholderTile
                  key={tile.id}
                  tile={tile}
                  live
                  liveText={`LIVE — ${positionText}`}
                  offText="Off"
                >
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.18em] text-neutral-400">
                      {scriptureTitle}
                    </p>
                    <p className="mt-2 text-xl font-semibold leading-snug">
                      {currentLine || 'Scripture content is live.'}
                    </p>
                  </div>
                </PlaceholderTile>
              );
            }

            return null;
          })}
        </main>
      </div>
    </div>
  );
}
