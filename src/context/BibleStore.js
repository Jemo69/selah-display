import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createLogger } from '../utils/logger.js';
import { diagInfo, diagTime } from '../utils/diagnosticsLog.js';
import { bibleDb } from '../utils/db.js';
import { getBibleVerseText } from 'shared/bible';
import {
  resolveVersificationOffset,
  getPairedReference as buildPairedReference,
  normalizePairInput,
  getParallelVerseText as readParallelVerseText,
} from '../utils/bibleParallel.js';

const log = createLogger('BibleStore');

/** Count verses without touching verse text (counts only, for diagnostics). */
const countVerses = (bible) => {
  try {
    if (!Array.isArray(bible?.books)) return 0;
    let total = 0;
    for (const book of bible.books) {
      const chapters = book?.chapters;
      if (Array.isArray(chapters)) {
        for (const chapter of chapters) {
          if (Array.isArray(chapter?.verses)) total += chapter.verses.length;
          else if (Array.isArray(chapter)) total += chapter.length;
        }
      }
    }
    return total;
  } catch {
    return 0;
  }
};

/** Summarise a reference (ids only) for diagnostics. */
const describeReference = (reference) => {
  try {
    if (!reference || typeof reference !== 'object') return String(reference ?? 'none');
    return {
      id: reference.id ?? null,
      book: reference.book ?? null,
      chapters: Array.isArray(reference.chapters) ? reference.chapters.map(String) : reference.chapters ?? null,
      verses: Array.isArray(reference.verses)
        ? reference.verses.map((group) => (Array.isArray(group) ? group.map(String) : String(group)))
        : null,
    };
  } catch {
    return '[unreadable reference]';
  }
};

const searchAllOwners = new Set();

const useBibleStore = create(
  persist(
    (set, get) => ({
      bibles: {},
      bibleMetadata: {},
      activeBibleId: null,
      defaultBibleId: null,
      // Optional linked secondary translation for dual-translation parallel
      // display. Null = today's single-translation behavior, unchanged.
      linkedBibleId: null,
      // Operator kill-switch: keeps the link but stops the second
      // translation reaching outputs. Reversible without re-picking the
      // translation, and independent of the link itself.
      parallelHidden: false,
      activeReference: null,
      selectedVerses: [[1]],
      searchResults: [],
      bibleHistory: [],
      searchIndex: null,
      settings: {
        referenceDivider: ':',
        showVerseNumbers: true,
        splitLongVerses: false,
        longVersesChars: 100,
        longVersesTolerance: 0,
        splitMethod: 'nearest-punctuation',
        switchInPlace: false,
        // Cut oversized verse text in the preview-all-translations tray.
        // On by default so copy-paste blobs in imported XML never render in
        // full; persisted settings without the key also read as enabled.
        truncateVersionPreviews: true,
        // Separate opt-out for local Bible search analytics (searchAnalytics
        // logSearchEvent). On by default; persisted settings without the key
        // also read as enabled.
        logBibleSearches: true,
        versificationOffsets: {}
      },
      ui: {
        libraryCollapsed: false,
        sidePanelCollapsed: false,
        historyCollapsed: true,
        selectionCollapsed: false,
        // The parallel-display block folds down to a one-line status header so
        // it stops eating verse-tray space when it is not in use. Collapsing it
        // is a UI concern only — it never touches the link itself.
        parallelControlCollapsed: false,
        sidePanelWidth: 380,
        verseLayout: 'grid',
      },

      addBible: async (id, bible) => {
        log.info('Bible added', { id, name: bible.name });
        const startedAt = Date.now();
        await bibleDb.set(id, bible);
        const books = Array.isArray(bible?.books) ? bible.books.length : 0;
        diagInfo('bible', 'translation stored', {
          id,
          durationMs: Date.now() - startedAt,
          books,
          verses: countVerses(bible),
        });
        set((state) => ({
          bibles: { ...state.bibles, [id]: bible },
          bibleMetadata: {
            ...state.bibleMetadata,
            [id]: { name: bible.name, id }
          }
        }));
      },

      removeBible: async (id) => {
        log.info('Bible removed', { id });
        diagInfo('bible', 'translation removed', { id });
        await bibleDb.delete(id);
        set((state) => {
          const { [id]: _, ...bibles } = state.bibles;
          const { [id]: __, ...metadata } = state.bibleMetadata;
          return {
            bibles,
            bibleMetadata: metadata,
            activeBibleId: state.activeBibleId === id ? null : state.activeBibleId,
            defaultBibleId: state.defaultBibleId === id ? null : state.defaultBibleId,
            linkedBibleId: state.linkedBibleId === id ? null : state.linkedBibleId,
            parallelHidden: state.linkedBibleId === id ? false : state.parallelHidden
          };
        });
      },

      linkParallelBible: async (id) => {
        const state = get();
        if (!id || id === state.activeBibleId) {
          log.warn('Parallel link rejected (missing id or same as primary)', { id });
          return false;
        }
        if (!state.bibleMetadata[id] && !state.bibles[id]) {
          log.warn('Parallel link rejected (unknown bible)', { id });
          return false;
        }
        if (!state.bibles[id]) {
          const bible = await bibleDb.get(id);
          if (bible) {
            set((prev) => ({ bibles: { ...prev.bibles, [id]: bible } }));
          } else {
            log.warn('Parallel link rejected (bible content unavailable)', { id });
            return false;
          }
        }
        log.info('Parallel bible linked', { primary: state.activeBibleId, secondary: id });
        // Linking always shows the pair again — an explicit "link this
        // translation" is an explicit "show it".
        set({ linkedBibleId: id, parallelHidden: false });
        return true;
      },

      unlinkParallelBible: () => {
        log.info('Parallel bible unlinked', { secondary: get().linkedBibleId });
        set({ linkedBibleId: null, parallelHidden: false });
      },

      // Hide/show the second translation without touching the link. Callers
      // gate the outbound payload on this; the link survives so showing it
      // again is one click, not a re-pick.
      setParallelHidden: (hidden) => {
        const next = Boolean(hidden);
        const state = get();
        if (state.parallelHidden === next) return;
        log.info('Parallel display visibility changed', { hidden: next, secondary: state.linkedBibleId });
        set({ parallelHidden: next });
      },

      isParallelVisible: () => {
        const state = get();
        return Boolean(state.linkedBibleId) && !state.parallelHidden;
      },

      setActiveBible: async (id) => {
        log.info('Active Bible changed', { id });
        const startedAt = Date.now();
        const state = get();
        // Group: batch IDB reads (was 2 serial gets + up to 3 sets).
        const needActive = id && !state.bibles[id] ? [id] : [];
        const stateLinked = id && id === state.linkedBibleId ? null : state.linkedBibleId;
        const needLinked = stateLinked && !state.bibles[stateLinked] && !needActive.includes(stateLinked) ? [stateLinked] : [];
        const need = [...needActive, ...needLinked];
        if (need.length > 0) {
          const pairs = await Promise.all(need.map(async (bid) => [bid, await bibleDb.get(bid)]));
          const loaded = {};
          for (const [bid, bible] of pairs) if (bible) loaded[bid] = bible;
          if (Object.keys(loaded).length > 0) set((prev) => ({ bibles: { ...prev.bibles, ...loaded } }));
          diagInfo('bible', 'translations loaded from disk', { ids: need, loaded: Object.keys(loaded).length, durationMs: Date.now() - startedAt });
        } else if (needActive.length > 0) {
          diagInfo('bible', 'translation load missed disk cache', { id });
        }
        // Switching the primary onto the linked secondary would self-pair —
        // drop the link instead (logged, reversible via re-link).
        const nextLinked = id && id === state.linkedBibleId ? null : state.linkedBibleId;
        if (state.linkedBibleId && nextLinked !== state.linkedBibleId) {
          log.info('Parallel link cleared (primary switched onto linked bible)', { id });
        }
        // Linked pair already warmed above in the batched preload.
        const keepReference = Boolean(state.settings?.switchInPlace) && Boolean(state.activeReference);
        set({
          activeBibleId: id,
          linkedBibleId: nextLinked,
          // A dropped link has nothing left to hide.
          parallelHidden: nextLinked ? state.parallelHidden : false,
          activeReference: keepReference ? state.activeReference : null,
          selectedVerses: keepReference ? state.selectedVerses : [[1]]
        });
        diagInfo('bible', 'active translation selected', {
          id,
          durationMs: Date.now() - startedAt,
          linkedBibleId: nextLinked,
          keptReference: keepReference,
        });
        if (!searchAllOwners.size && id) {
          get().evictInactiveBibles();
        }
      },

      setSearchAllOwner: (ownerId, active) => {
        if (!ownerId) return;
        if (active) {
          searchAllOwners.add(ownerId);
        } else {
          searchAllOwners.delete(ownerId);
        }
        log.debug('Search-all owner changed', { ownerId, active: Boolean(active), activeOwners: searchAllOwners.size });
      },

      clearSearchAllOwner: (ownerId) => {
        if (!ownerId) return;
        searchAllOwners.delete(ownerId);
        log.debug('Search-all owner cleared', { ownerId, activeOwners: searchAllOwners.size });
      },

      evictInactiveBibles: () => {
        const state = get();
        if (!state.activeBibleId || searchAllOwners.size > 0) return;
        const active = state.bibles[state.activeBibleId];
        if (!active) return;
        // Linked parallel pair is kept; everything else evicts as before.
        const linked = state.linkedBibleId ? state.bibles[state.linkedBibleId] : null;
        const kept = { [state.activeBibleId]: active };
        if (state.linkedBibleId && linked) {
          kept[state.linkedBibleId] = linked;
        }
        set({ bibles: kept });
        log.info('Evicted inactive bibles from memory, keeping:', Object.keys(kept));
      },

      ensureBiblesLoaded: async (ids) => {
        const state = get();
        const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
        const missing = wanted.filter((id) => !state.bibles[id]);
        if (missing.length === 0) return {};
        const startedAt = Date.now();
        const pairs = await Promise.all(missing.map(async (id) => [id, await bibleDb.get(id)]));
        const loaded = {};
        for (const [id, bible] of pairs) if (bible) loaded[id] = bible;
        if (Object.keys(loaded).length > 0) set((prev) => ({ bibles: { ...prev.bibles, ...loaded } }));
        diagInfo('bible', 'translations ensured', { requested: missing.length, loaded: Object.keys(loaded).length, durationMs: Date.now() - startedAt });
        return loaded;
      },

      loadAllBibles: async () => {
        const state = get();
        const metadataIds = Object.keys(state.bibleMetadata);
        const loadedIds = Object.keys(state.bibles);
        const toLoad = metadataIds.filter(id => !loadedIds.includes(id));

        if (toLoad.length === 0) return;

        const startedAt = Date.now();
        // Group: parallel IDB reads so Search-all + preview-all don't stall serially.
        const pairs = await Promise.all(toLoad.map(async (id) => [id, await bibleDb.get(id)]));
        const loadedBibles = {};
        for (const [id, bible] of pairs) {
          if (bible) loadedBibles[id] = bible;
        }

        if (Object.keys(loadedBibles).length > 0) {
          set(state => ({
            bibles: { ...state.bibles, ...loadedBibles }
          }));
          diagInfo('bible', 'translations bulk-loaded', {
            requested: toLoad.length,
            loaded: Object.keys(loadedBibles).length,
            durationMs: Date.now() - startedAt,
          });
        }
      },

      setDefaultBible: (id) => {
        log.info('Default Bible set', { id });
        set({ defaultBibleId: id });
      },

      setReference: (reference) => {
        // Accepts today's single reference or a { primary, secondary } pair.
        // Pairs store the primary as activeReference and derive the link.
        const state = get();
        const { reference: normalized, linkedBibleId } = normalizePairInput(reference, state.linkedBibleId);
        log.debug('Reference changed', { reference: normalized, linkedBibleId });
        diagInfo('bible', 'passage navigated', {
          reference: describeReference(normalized),
          linkedBibleId,
        });
        set({ activeReference: normalized, ...(linkedBibleId !== state.linkedBibleId ? { linkedBibleId } : {}) });
      },

      updateVersificationOffsets: (patch) => {
        if (!patch || typeof patch !== 'object') return;
        log.info('Versification offsets updated', { keys: Object.keys(patch) });
        set((state) => ({
          settings: {
            ...state.settings,
            versificationOffsets: { ...(state.settings?.versificationOffsets || {}), ...patch }
          }
        }));
      },

      setSelectedVerses: (verses) => set({ selectedVerses: verses }),

      clearSearchResults: () => set({ searchResults: [] }),

      setSearchIndex: (index) => {
        log.info('Search index updated', { hasIndex: !!index });
        set({ searchIndex: index });
      },

      updateSettings: (newSettings) => {
        log.info('Bible settings updated', { keys: Object.keys(newSettings) });
        set((state) => ({
          settings: { ...state.settings, ...newSettings }
        }));
      },
      setUIState: (newUI) => set((state) => ({
        ui: { ...state.ui, ...newUI }
      })),

      getBibleById: (id) => {
        const state = get();
        return state.bibles[id] || null;
      },

      getActiveBible: () => {
        const state = get();
        if (!state.activeBibleId) return null;
        return state.bibles[state.activeBibleId] || null;
      },

      getVerseText: () => {
        const state = get();
        return getBibleVerseText(state.bibles[state.activeBibleId], state.activeReference, state.selectedVerses);
      },

      getLinkedBible: () => {
        const state = get();
        if (!state.linkedBibleId) return null;
        return state.bibles[state.linkedBibleId] || null;
      },

      getPairedReference: () => {
        const state = get();
        return buildPairedReference(state.activeReference, state.linkedBibleId);
      },

      getParallelVerseText: () => {
        const state = get();
        if (!state.linkedBibleId) return '';
        return readParallelVerseText(
          state.bibles[state.linkedBibleId],
          state.linkedBibleId,
          state.activeReference,
          state.selectedVerses,
          state.settings?.versificationOffsets
        );
      },

      getVersificationOffset: (bibleId, book, chapter) => {
        const state = get();
        return resolveVersificationOffset(state.settings?.versificationOffsets, bibleId, book, chapter);
      },

      getFormattedReference: () => {
        const state = get();
        const bible = state.bibles[state.activeBibleId];
        if (!bible || !state.activeReference) return '';

        const book = (bible.bookMap && bible.bookMap[state.activeReference.book]) || bible.books.find(b => b.number === state.activeReference.book);
        if (!book) return '';

        const chapters = state.activeReference.chapters?.join(',') || '';
        const verses = formatVerseSelection(state.selectedVerses[0] || []);

        if (!verses) {
          return `${book.name} ${chapters}`;
        }

        return `${book.name} ${chapters}:${verses}`;
      },

      addToBibleHistory: (reference, text, structuredReference = null) => set((state) => {
        if (!reference || !text) return state;
        const entry = {
          id: `verse_${Date.now()}`,
          reference,
          text,
          timestamp: Date.now(),
          bibleId: state.activeBibleId,
          bibleName: state.bibleMetadata[state.activeBibleId]?.name,
          structuredReference: structuredReference || (state.activeReference ? { ...state.activeReference, verses: state.selectedVerses } : null)
        };
        // Keep unique by reference
        const filteredHistory = state.bibleHistory.filter(h => h.reference !== reference);
        return {
          bibleHistory: [entry, ...filteredHistory].slice(0, 50)
        };
      }),

      clearBibleHistory: () => set({ bibleHistory: [] }),

      reset: () => set({
        activeReference: null,
        selectedVerses: [[1]],
        searchResults: []
      })
    }),
    {
      name: 'bible-store',
      partialize: (state) => ({
        bibleMetadata: state.bibleMetadata,
        defaultBibleId: state.defaultBibleId,
        linkedBibleId: state.linkedBibleId,
        parallelHidden: state.parallelHidden,
        bibleHistory: state.bibleHistory,
        settings: state.settings,
        ui: state.ui
      }),
      onRehydrateStorage: () => async (state, error) => {
        if (error || !state) return;

        // Migration from localStorage to IndexedDB
        const bibles = state.bibles || {};
        const bibleIds = Object.keys(bibles);

        if (bibleIds.length > 0) {
          log.info('Migrating bibles from localStorage to IndexedDB', { count: bibleIds.length });
          for (const id of bibleIds) {
            await bibleDb.set(id, bibles[id]);
          }
          // Clear bibles from state to ensure they are not persisted to localStorage again
          // However, we need to keep active bible in memory if possible
          // For now, let's just let it be. The partialize will handle not saving them.
        }
      }
    }
  )
);

log.info('BibleStore initialized');

export default useBibleStore;

function formatVerseSelection(verses) {
  const values = [...new Set((verses || []).filter((verse) => Number.isInteger(verse)))].sort((a, b) => a - b);
  if (values.length === 0) return '';

  const ranges = [];
  let start = values[0];
  let previous = values[0];

  for (let i = 1; i < values.length; i++) {
    const current = values[i];
    if (current === previous + 1) {
      previous = current;
      continue;
    }

    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = current;
    previous = current;
  }

  ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return ranges.join(',');
}
