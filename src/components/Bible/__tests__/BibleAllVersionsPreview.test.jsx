import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import BibleControlPanel from '../BibleControlPanel';

const mocks = vi.hoisted(() => ({
  linkedBibleId: null,
  parallelHidden: false,
  linkParallelBible: vi.fn(),
  unlinkParallelBible: vi.fn(),
  setParallelHidden: vi.fn(),
  showToast: vi.fn(),
  // Both stores are built inside vi.hoisted: the vi.mock factories run before
  // module-level declarations, so these cannot live at the top level.
  bibleStoreState: null,
  lyricsStoreState: null,
  settings: {},
  buildAllVersionsPreview: vi.fn(),
}));

const bibles = {
  kjv: {
    id: 'kjv',
    name: 'KJV',
    books: [
      {
        number: 1,
        name: 'Genesis',
        chapters: [{ number: 1, verses: [{ number: 1, text: 'In the beginning' }, { number: 2, text: 'The earth was without form and void' }] }],
      },
    ],
  },
};

mocks.bibleStoreState = () => ({
  bibles,
  bibleMetadata: { kjv: { id: 'kjv', name: 'KJV' } },
  activeBibleId: 'kjv',
  defaultBibleId: 'kjv',
  linkedBibleId: mocks.linkedBibleId,
  parallelHidden: mocks.parallelHidden,
  activeReference: { id: 'kjv', book: 1, chapters: ['1'], verses: [[2]] },
  selectedVerses: [[2]],
  bibleHistory: [],
  settings: mocks.settings,
  ui: {},
  setActiveBible: vi.fn(),
  loadAllBibles: vi.fn(),
  evictInactiveBibles: vi.fn(),
  setSearchAllOwner: vi.fn(),
  clearSearchAllOwner: vi.fn(),
  setReference: vi.fn(),
  setSelectedVerses: vi.fn(),
  getBibleById: (id) => bibles[id],
  getFormattedReference: () => 'Genesis 1:2',
  getVerseText: () => 'The earth was without form and void',
  linkParallelBible: mocks.linkParallelBible,
  unlinkParallelBible: mocks.unlinkParallelBible,
  setParallelHidden: mocks.setParallelHidden,
  setUIState: vi.fn(),
});

mocks.lyricsStoreState = () => ({
  output1Settings: {},
  bibleVerseEditorEnabled: false,
  isOutputOn: true,
  setIsOutputOn: vi.fn(),
});

vi.mock('shared/bible', () => ({
  orderBibleMetadata: (metadata = {}) => Object.values(metadata),
  searchBible: () => [],
  searchBibleExperimental: () => [],
  parsePassageScope: () => null,
  formatPassageScope: () => '',
}));

vi.mock('../../../utils/biblePreview', () => ({
  buildAllVersionsPreview: mocks.buildAllVersionsPreview,
  truncatePreviewText: (text) => String(text ?? '').slice(0, 280),
}));
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

const searchResult = {
  book: 1,
  chapter: 1,
  verse: 2,
  verses: [2],
  text: 'The earth was without form and void',
  reference: 'Genesis 1:2',
  bibleId: 'kjv',
  bibleName: 'KJV',
};

let searchWorker = null;

async function previewFirstSearchResult() {
  fireEvent.change(screen.getByPlaceholderText('Search verses...'), { target: { value: 'without form' } });
  // Debounced search fires after 300ms, then hands results back via the worker.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  await act(async () => {
    searchWorker.onmessage({ data: [searchResult] });
  });
  fireEvent.keyDown(screen.getByPlaceholderText('Search verses...'), { key: 'Enter', shiftKey: true });
}

describe('BibleControlPanel translation preview trimming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.linkedBibleId = null;
    mocks.parallelHidden = false;
    mocks.settings = {};
    // jsdom has no Worker; capture the instance so tests can push results.
    globalThis.Worker = class {
      constructor() {
        searchWorker = this;
      }

      postMessage() {}

      terminate() {}
    };
  });

  afterEach(() => {
    delete globalThis.Worker;
    searchWorker = null;
  });

  it('marks a trimmed entry from the previewer with the (trimmed) note', async () => {
    mocks.buildAllVersionsPreview.mockResolvedValue([
      { bibleId: 'kjv', bibleName: 'KJV', text: 'The earth was without form and void…', truncated: true },
    ]);

    render(<BibleControlPanel darkMode={false} />);
    await previewFirstSearchResult();

    expect(await screen.findByText('(trimmed)')).toBeTruthy();
    expect(screen.getByText(/The earth was without form and void…/)).toBeTruthy();
  });

  it('asks the previewer to trim by default (Settings > Bible toggle on)', async () => {
    mocks.buildAllVersionsPreview.mockResolvedValue([]);

    render(<BibleControlPanel darkMode={false} />);
    await previewFirstSearchResult();

    await vi.waitFor(() => expect(mocks.buildAllVersionsPreview).toHaveBeenCalled());
    expect(mocks.buildAllVersionsPreview.mock.calls[0][0].truncate).toBe(true);
  });

  it('passes truncate: false and shows no trim marker when the user turns it off', async () => {
    mocks.settings = { truncateVersionPreviews: false };
    const fullText = `${'copy-pasted block '.repeat(100)}PASTE-DUPLICATE-TAIL`;
    mocks.buildAllVersionsPreview.mockResolvedValue([
      { bibleId: 'kjv', bibleName: 'KJV', text: fullText, truncated: false },
    ]);

    render(<BibleControlPanel darkMode={false} />);
    await previewFirstSearchResult();

    await vi.waitFor(() => expect(mocks.buildAllVersionsPreview).toHaveBeenCalled());
    expect(mocks.buildAllVersionsPreview.mock.calls[0][0].truncate).toBe(false);
    expect(await screen.findByText(/PASTE-DUPLICATE-TAIL/)).toBeTruthy();
    expect(screen.queryByText('(trimmed)')).toBeNull();
  });
});
