import { useCallback, useEffect, useReducer, useState } from 'react';
import useBibleStore from '../context/BibleStore';
import { createLogger } from '../utils/logger.js';

const log = createLogger('BibleAutoImport');

const BUNDLED_IDS = ['bundled-kjv', 'kjv-bundled'];

// App-wide guard: the hook mounts in the Bible panel, User Preferences >
// Bible, and at app launch, but the side effect must run once. All
// instances share one in-flight promise, one cached outcome, and one
// listener set so every surface re-renders when the outcome lands.
let autoImportFlight = null;
let autoImportOutcome = null; // { status, detail } shared source of truth
const autoImportListeners = new Set();
function publishAutoImport() {
  autoImportListeners.forEach((fn) => {
    try { fn(); } catch { /* a dead surface must not break the others */ }
  });
}

/**
 * Auto-import the bundled offline translation (KJV sample) on first run.
 *
 * Sources, in order:
 *  1. Electron: window.bibleAPI.getBundled('KJV') — main-process verse
 *     service (plan: electron-bible-verse-service) reads assets/bibles/KJV/*.json
 *  2. Web/dev: fetch('/bibles/manifest.json') + per-book fetch from public/bibles
 *
 * Idempotent: skips translations already in BibleStore metadata. First
 * successful import becomes default/active when the library is empty.
 */
export function useBibleAutoImport({ enabled = true } = {}) {
  const [status, setStatus] = useState(autoImportOutcome?.status || 'idle'); // idle | importing | done | error
  const [detail, setDetail] = useState(autoImportOutcome?.detail || null);
  const [, bump] = useReducer((x) => x + 1, 0);

  // Every mounted surface follows the shared outcome (covers late
  // mounters and rescan-from-another-surface staleness).
  useEffect(() => {
    const sync = () => {
      if (autoImportOutcome) {
        setStatus(autoImportOutcome.status);
        setDetail(autoImportOutcome.detail);
      } else {
        bump();
      }
    };
    autoImportListeners.add(sync);
    sync();
    return () => { autoImportListeners.delete(sync); };
  }, []);

  const run = useCallback(async () => {
    if (autoImportFlight) return autoImportFlight;
    setStatus('importing');
    setDetail('Looking for bundled translations…');
    autoImportOutcome = { status: 'importing', detail: 'Looking for bundled translations…' };
    publishAutoImport();
    autoImportFlight = (async () => {
    try {
      const store = useBibleStore.getState();
      const existingIds = new Set(Object.keys(store.bibleMetadata || {}));
      const existingNames = new Set(
        Object.values(store.bibleMetadata || {}).map((m) => String(m?.name || '').toLowerCase())
      );

      const candidates = [];

      // 1) Electron main-process verse service.
      try {
        const api = typeof window !== 'undefined' ? window.bibleAPI : null;
        if (api?.getBundled) {
          const res = await api.getBundled('KJV');
          if (res?.success && res?.bible?.books?.length) {
            candidates.push(res.bible);
          } else if (res?.success === false) {
            log.warn('Bundled Bible via bibleAPI failed', { error: res?.error });
          }
          try {
            const listed = await api.listTranslations?.();
            const translations = listed?.translations || [];
            for (const t of translations) {
              if (BUNDLED_IDS.includes(t?.id) || /kjv/i.test(t?.name || '')) continue; // already have KJV above
              try {
                const one = await api.getBundled(t?.dir);
                if (one?.success && one?.bible?.books?.length) candidates.push(one.bible);
              } catch { /* next */ }
            }
          } catch { /* list is best-effort */ }
        }
      } catch (error) {
        log.warn('bibleAPI bundled import failed, falling back to fetch', { error: error?.message });
      }

      // 2) Fetch fallback (dev + web): public/bibles/manifest.json
      if (candidates.length === 0) {
        try {
          const manifestRes = await fetch('bibles/manifest.json');
          if (manifestRes.ok) {
            const manifest = await manifestRes.json();
            for (const t of manifest?.translations || []) {
              const files = Array.isArray(t?.files) ? t.files : [];
              const merged = {};
              for (const file of files) {
                try {
                  const r = await fetch(`bibles/${t.dir}/${file}`);
                  if (!r.ok) continue;
                  const json = await r.json();
                  const bookName = String(file).replace(/\.json$/i, '');
                  const data = json[bookName] || json;
                  if (data && typeof data === 'object') merged[bookName] = { ...(merged[bookName] || {}), ...data };
                } catch { /* next file */ }
              }
              const bookNames = Object.keys(merged).filter((k) => k.toLowerCase() !== 'info');
              if (bookNames.length === 0) continue;
              // Convert plan shape { Book: { ch: { v: text } } } → store shape.
              let n = 1;
              candidates.push({
                id: t.id || `bundled-${String(t.dir || 'kjv').toLowerCase()}`,
                name: t.name || 'KJV (Bundled Sample)',
                books: bookNames.map((bookName) => ({
                  number: n++,
                  name: bookName,
                  chapters: Object.entries(merged[bookName] || {})
                    .filter(([k]) => /^\d+$/.test(String(k)))
                    .map(([ch, verses]) => ({
                      number: Number(ch),
                      verses: Object.entries(verses || {})
                        .filter(([v]) => /^\d+$/.test(String(v)))
                        .map(([v, text]) => ({ number: Number(v), text: String(text) }))
                        .sort((a, b) => a.number - b.number),
                    }))
                    .sort((a, b) => a.number - b.number),
                })),
              });
            }
          }
        } catch { /* no manifest in packaged file:// — Electron path already tried */ }
      }

      if (candidates.length === 0) {
        setStatus('done');
        setDetail(existingIds.size > 0 ? 'No bundled translations to add.' : 'No bundled translation found.');
        return { ok: true, imported: [] };
      }

      const imported = [];
      for (const bible of candidates) {
        const id = bible.id || 'bundled-kjv';
        if (existingIds.has(id) || existingNames.has(String(bible.name || '').toLowerCase())) continue;
        // Normalise through the shared parser path when possible so search
        // indexes + book maps are built the same way as manual imports.
        let normalised = bible;
        try {
          if (!bible.searchIndex && Array.isArray(bible.books)) {
            const { buildSearchIndex } = await import('shared/bible');
            normalised = { ...bible };
            if (typeof buildSearchIndex === 'function' && !normalised.searchIndex) {
              try {
                normalised.searchIndex = buildSearchIndex(normalised);
              } catch { /* search still works without index */ }
            }
            normalised.bookMap = {};
            for (const book of normalised.books) {
              normalised.bookMap[book.number] = book;
              book.chapterMap = {};
              for (const chapter of book.chapters || []) {
                book.chapterMap[chapter.number] = chapter;
                chapter.verseMap = {};
                for (const verse of chapter.verses || []) chapter.verseMap[verse.number] = verse;
              }
            }
          }
        } catch { /* keep raw */ }
        await useBibleStore.getState().addBible(id, normalised);
        imported.push({ id, name: normalised.name });
        existingIds.add(id);
      }

      if (imported.length > 0) {
        const state = useBibleStore.getState();
        if (!state.defaultBibleId) state.setDefaultBible(imported[0].id);
        if (!state.activeBibleId) await state.setActiveBible(imported[0].id);
        // Also persist a copy via Electron file API when available (best-effort).
        try {
          await window.electronAPI?.bible?.save?.(imported[0].id, useBibleStore.getState().bibles[imported[0].id]);
        } catch { /* IndexedDB is source of truth */ }
        autoImportOutcome = { status: 'done', detail: `Auto-imported ${imported.map((b) => b.name).join(', ')}.` };
        log.info('Bundled Bible auto-imported', { imported });
      } else {
        autoImportOutcome = { status: 'done', detail: 'Bundled translation already installed.' };
      }
      setStatus(autoImportOutcome.status);
      setDetail(autoImportOutcome.detail);
      publishAutoImport();
      return { ok: true, imported };
    } catch (error) {
      autoImportOutcome = { status: 'error', detail: error?.message || 'Auto-import failed.' };
      setStatus('error');
      setDetail(autoImportOutcome.detail);
      publishAutoImport();
      log.warn('Bible auto-import failed', { error: error?.message });
      return { ok: false, error };
    }
    })();
    try {
      return await autoImportFlight;
    } finally {
      // Keep the outcome cached for late mounters; clear only the flight
      // on failure so a rescan can retry.
      if (autoImportOutcome?.status === 'error') autoImportFlight = null;
    }
  }, []);

  useEffect(() => {
    if (enabled) run();
  }, [enabled, run]);

  const rescan = useCallback(() => {
    autoImportFlight = null;
    autoImportOutcome = null;
    return run();
  }, [run]);

  return { status, detail, run: rescan };
}

export default useBibleAutoImport;

/** Test-only: clear the shared guard so each test imports fresh. */
export function resetBibleAutoImportForTests() {
  autoImportFlight = null;
  autoImportOutcome = null;
}
