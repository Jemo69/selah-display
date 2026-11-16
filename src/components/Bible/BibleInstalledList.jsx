import React from 'react';
import { BookOpen, CheckCircle2, Circle, Loader2, RefreshCw } from 'lucide-react';
import useBibleStore from '../../context/BibleStore';
import { orderBibleMetadata } from 'shared/bible';

/**
 * Installed-translations list shared by User Preferences > Bible and the
 * Bible panel. Shows every translation the app has installed, with
 * Default / Active badges, so operators can see at a glance what auto-import
 * provided vs what they added manually.
 */
export default function BibleInstalledList({
  darkMode = false,
  autoImportStatus = 'idle',
  autoImportDetail = null,
  onRescan = null,
  rescanLabel = 'Rescan bundled',
  // Compact mode is for the narrow Bible-panel column: tighter rows,
  // counts kept in tooltips so the translation name keeps priority, and
  // a shorter list so the book browser keeps its space.
  compact = false,
}) {
  const bibleMetadata = useBibleStore((s) => s.bibleMetadata);
  const bibles = useBibleStore((s) => s.bibles);
  const defaultBibleId = useBibleStore((s) => s.defaultBibleId);
  const activeBibleId = useBibleStore((s) => s.activeBibleId);

  const ordered = React.useMemo(
    () => orderBibleMetadata(bibleMetadata, defaultBibleId),
    [bibleMetadata, defaultBibleId]
  );

  const countBooks = React.useCallback(
    (id) => {
      const loaded = bibles[id];
      if (Array.isArray(loaded?.books)) return loaded.books.length;
      return null;
    },
    [bibles]
  );

  return (
    <div
      className={`rounded-xl border p-4 ${darkMode ? 'bg-[#282946]/40 border-[#282946]' : 'bg-white border-gray-200'}`}
      data-testid="bible-installed-list"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={`text-sm font-medium flex min-w-0 items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          <BookOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="whitespace-nowrap">Installed translations</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${darkMode ? 'bg-gray-800 text-gray-300' : 'bg-gray-100 text-gray-600'}`}
            data-testid="bible-installed-count"
          >
            {ordered.length}
          </span>
        </div>
        {onRescan && (
          <button
            type="button"
            onClick={onRescan}
            disabled={autoImportStatus === 'importing'}
            title="Re-check the bundled offline translation and auto-import it if missing"
            className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2 py-1 text-[11px] font-semibold transition-colors disabled:cursor-wait disabled:opacity-60 ${
              darkMode
                ? 'border-gray-700 bg-gray-950 text-gray-300 hover:bg-gray-800'
                : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100'
            }`}
            data-testid="bible-rescan-bundled"
          >
            {autoImportStatus === 'importing' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {compact && rescanLabel === 'Rescan bundled' ? 'Rescan' : rescanLabel}
          </button>
        )}
      </div>

      <p className={`mt-1 text-[11px] leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`} data-testid="bible-auto-import-status">
        {autoImportStatus === 'importing' && 'Auto-importing bundled translation…'}
        {autoImportStatus !== 'importing' && (autoImportDetail || 'Bundled KJV sample auto-imports on first launch.')}
      </p>

      {ordered.length > 0 ? (
        <ul className={`mt-3 space-y-2 overflow-y-auto pr-1 ${compact ? 'max-h-28' : 'max-h-64'}`}>
          {ordered.map((meta) => {
            const books = countBooks(meta.id);
            const isDefault = meta.id === defaultBibleId;
            const isActive = meta.id === activeBibleId;
            // Stored metadata sometimes carries a literal "Unknown" name
            // (older imports); fall back to the id so no row is unlabeled.
            const rawName = String(meta.name || '').trim();
            const displayName = rawName && rawName.toLowerCase() !== 'unknown' ? rawName : meta.id;
            return (
              <li
                key={meta.id}
                className={`flex items-center gap-2 rounded-lg border ${compact ? 'px-2 py-1.5 text-xs' : 'px-3 py-2 text-sm'} ${
                  darkMode ? 'border-gray-800 bg-gray-950/60 text-gray-200' : 'border-gray-100 bg-gray-50 text-gray-800'
                }`}
                data-testid={`bible-installed-${meta.id}`}
                title={compact ? `${displayName}${books != null ? ` — ${books} ${books === 1 ? 'book' : 'books'}` : ' — metadata installed; full text loads on first use'}` : displayName}
              >
                {isActive ? (
                  <CheckCircle2 className={`h-4 w-4 shrink-0 ${darkMode ? 'text-emerald-300' : 'text-emerald-600'}`} aria-hidden="true" />
                ) : (
                  <Circle className={`h-4 w-4 shrink-0 ${darkMode ? 'text-gray-600' : 'text-gray-300'}`} aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">{displayName}</span>
                {!compact && (books != null ? (
                  <span className={`shrink-0 text-[11px] ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                    {books} {books === 1 ? 'book' : 'books'}
                  </span>
                ) : (
                  <span className={`shrink-0 text-[11px] italic ${darkMode ? 'text-gray-600' : 'text-gray-400'}`} title="Translation metadata is installed; full text loads on first use">
                    metadata only
                  </span>
                ))}
                {isDefault && (
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${darkMode ? 'bg-blue-500/20 text-blue-200' : 'bg-blue-100 text-blue-700'}`}>
                    Default
                  </span>
                )}
                {isActive && (
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${darkMode ? 'bg-emerald-500/20 text-emerald-200' : 'bg-emerald-100 text-emerald-700'}`}>
                    Active
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div
          className={`mt-3 rounded-lg border border-dashed px-3 py-3 text-xs ${darkMode ? 'border-gray-700 text-gray-500 bg-gray-950/50' : 'border-gray-200 text-gray-500 bg-gray-50'}`}
          data-testid="bible-installed-empty"
        >
          No translations installed yet. The bundled KJV sample installs automatically — or import a file below.
        </div>
      )}
    </div>
  );
}
