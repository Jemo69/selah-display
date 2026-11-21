import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import BibleControlPanel from '../BibleControlPanel';

const mocks = vi.hoisted(() => ({
  linkedBibleId: null,
  parallelHidden: false,
  ui: { parallelControlCollapsed: false },
  linkParallelBible: vi.fn(),
  unlinkParallelBible: vi.fn(),
  setParallelHidden: vi.fn(),
  setUIState: vi.fn(),
  showToast: vi.fn(),
  // Both stores are built inside vi.hoisted: the vi.mock factories run before
  // module-level declarations, so these cannot live at the top level.
  bibleStoreState: null,
  lyricsStoreState: null,
}));

const bibles = {
  kjv: {
    id: 'kjv',
    name: 'KJV',
    books: [
      {
        number: 19,
        name: 'Psalms',
        chapters: [{ number: 1, verses: [{ number: 1, text: 'Blessed is the man' }, { number: 2, text: 'For the LORD is my shepherd' }] }],
      },
    ],
  },
  es: {
    id: 'es',
    name: 'RVR1960',
    books: [
      {
        number: 19,
        name: 'Salmos',
        chapters: [{ number: 1, verses: [{ number: 1, text: 'Bienaventurado el hombre' }, { number: 2, text: 'Porque el SENOR es mi pastor' }] }],
      },
    ],
  },
};

mocks.bibleStoreState = () => ({
  bibles,
  bibleMetadata: {
    kjv: { id: 'kjv', name: 'KJV' },
    es: { id: 'es', name: 'RVR1960' },
  },
  activeBibleId: 'kjv',
  defaultBibleId: 'kjv',
  linkedBibleId: mocks.linkedBibleId,
  parallelHidden: mocks.parallelHidden,
  activeReference: null,
  selectedVerses: [[1]],
  bibleHistory: [],
  settings: {},
  ui: mocks.ui,
  setActiveBible: vi.fn(),
  loadAllBibles: vi.fn(),
  evictInactiveBibles: vi.fn(),
  setSearchAllOwner: vi.fn(),
  clearSearchAllOwner: vi.fn(),
  setReference: vi.fn(),
  setSelectedVerses: vi.fn(),
  getBibleById: (id) => bibles[id],
  getFormattedReference: () => '',
  getVerseText: () => '',
  linkParallelBible: mocks.linkParallelBible,
  unlinkParallelBible: mocks.unlinkParallelBible,
  setParallelHidden: mocks.setParallelHidden,
  setUIState: mocks.setUIState,
});

mocks.lyricsStoreState = () => ({
  output1Settings: {},
  bibleVerseEditorEnabled: false,
  isOutputOn: true,
  setIsOutputOn: vi.fn(),
});

vi.mock('shared/bible', () => ({
  orderBibleMetadata: (metadata = {}) => Object.values(metadata).sort((a, b) => a.name.localeCompare(b.name)),
  searchBible: () => [],
}));

vi.mock('../../../utils/biblePreview', () => ({ buildAllVersionsPreview: vi.fn() }));
vi.mock('../../../utils/bibleSplitter', () => ({
  splitBibleTextIntoSlides: (text) => [text],
  resolveBibleGeometry: () => ({ fontSize: 40 }),
}));
vi.mock('../BibleChapterEditorModal', () => ({ dispatchOpenBibleChapterEditor: vi.fn() }));

vi.mock('../../../hooks/useToast', () => ({
  default: () => ({ showToast: mocks.showToast }),
}));

vi.mock('../../../context/ControlSocketProvider', () => ({
  useControlSocket: () => ({}),
}));

// BibleControlPanel subscribes both ways (bare destructure + selectors), so
// each mock store is callable and carries getState() for the worker-prune path.
vi.mock('../../../context/BibleStore', () => {
  const useStore = (selector) => (typeof selector === 'function'
    ? selector(mocks.bibleStoreState())
    : mocks.bibleStoreState());
  // Deferred lookup: this factory runs at import time, before the hoisted
  // mock object is populated below.
  useStore.getState = () => mocks.bibleStoreState();
  return { default: useStore };
});

vi.mock('../../../context/LyricsStore', () => {
  const useStore = (selector) => (typeof selector === 'function'
    ? selector(mocks.lyricsStoreState())
    : mocks.lyricsStoreState());
  useStore.getState = () => mocks.lyricsStoreState();
  return { default: useStore };
});

describe('BibleControlPanel parallel display placement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.linkedBibleId = null;
    mocks.parallelHidden = false;
    mocks.ui = { parallelControlCollapsed: false };
    // jsdom has no Worker; the search worker is irrelevant to placement.
    globalThis.Worker = class {
      postMessage() {}
      terminate() {}
    };
  });

  afterEach(() => {
    delete globalThis.Worker;
  });

  it('parks the parallel control inside the live tray, under the verse-step row', () => {
    render(<BibleControlPanel darkMode={false} />);

    const tray = screen.getByTestId('bible-live-tray');
    const control = screen.getByTestId('parallel-bible-link');

    // Regression guard: the control belongs to the verse tray, not the
    // search section above it.
    expect(tray.contains(control)).toBe(true);
    expect(screen.getByTestId('bible-search-section').contains(control)).toBe(false);
  });

  it('keeps the control reachable with no verse selected yet', () => {
    render(<BibleControlPanel darkMode={false} />);

    // Shell renders with no selection so linking stays possible before a
    // verse is picked.
    expect(screen.getByTestId('bible-live-tray')).toBeTruthy();
    expect(screen.getByTestId('parallel-bible-link')).toBeTruthy();
    expect(screen.getByLabelText('Link a second translation for parallel display')).toBeTruthy();
  });

  it('hides a linked translation from the tray', () => {
    mocks.linkedBibleId = 'es';
    render(<BibleControlPanel darkMode={false} />);

    fireEvent.click(screen.getByLabelText('Hide parallel translation'));
    expect(mocks.setParallelHidden).toHaveBeenCalledWith(true);
  });

  it('folds the parallel control away from inside the tray', () => {
    render(<BibleControlPanel darkMode={false} />);

    fireEvent.click(screen.getByTestId('parallel-bible-link-toggle'));
    expect(mocks.setUIState).toHaveBeenCalledWith({ parallelControlCollapsed: true });
  });

  it('gives the folded block no body, so the tray keeps the space', () => {
    mocks.ui = { parallelControlCollapsed: true };
    render(<BibleControlPanel darkMode={false} />);

    // Tray stays mounted when folded, so the control is never stranded.
    expect(screen.getByTestId('bible-live-tray')).toBeTruthy();
    expect(screen.getByTestId('parallel-bible-link')).toBeTruthy();
    expect(screen.queryByTestId('parallel-bible-link-body')).toBeNull();
  });
});