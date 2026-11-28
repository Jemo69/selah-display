import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import BibleSearchModal from '../BibleSearchModal';

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  // Stable store instance held behind the hoisted holder: vi.mock factories
  // run before module-level code, so the store must be reachable lazily.
  // The modal's effects carry action refs (getBibleById etc.) in their dep
  // arrays; a factory returning fresh objects per call would re-run those
  // effects on every render and loop forever. Real zustand state is stable,
  // so the mock must be too.
  storeState: null,
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

mocks.storeState = {
  bibles,
  bibleMetadata: { kjv: { id: 'kjv', name: 'KJV' } },
  activeBibleId: 'kjv',
  defaultBibleId: 'kjv',
  activeReference: { id: 'kjv', book: 1, chapters: ['1'], verses: [[2]] },
  selectedVerses: [[2]],
  addBible: vi.fn(),
  setActiveBible: vi.fn(),
  loadAllBibles: vi.fn(),
  evictInactiveBibles: vi.fn(),
  setSearchAllOwner: vi.fn(),
  clearSearchAllOwner: vi.fn(),
  setDefaultBible: vi.fn(),
  setReference: vi.fn(),
  setSelectedVerses: vi.fn(),
  getFormattedReference: () => 'Genesis 1:2',
  getVerseText: () => 'The earth was without form and void',
  getBibleById: (id) => bibles[id],
};
// Tests swap mocks.settings per case; the store reads it through this getter.
Object.defineProperty(mocks.storeState, 'settings', { get: () => mocks.settings, configurable: true });

vi.mock('shared/bible', () => ({
  parseBibleFromFile: vi.fn(),
  parsePassageScope: () => null,
  formatPassageScope: () => '',
}));

vi.mock('../../../utils/biblePreview', () => ({
  buildAllVersionsPreview: mocks.buildAllVersionsPreview,
  truncatePreviewText: (text) => String(text ?? '').slice(0, 280),
}));

vi.mock('../BibleBrowser', () => ({ default: () => null }));
vi.mock('../BibleImportModal', () => ({ default: () => null }));

vi.mock('../../../hooks/useToast', () => ({
  default: () => ({ showToast: mocks.showToast }),
}));

vi.mock('../../../context/BibleStore', () => {
  const useStore = (selector) => (typeof selector === 'function'
    ? selector(mocks.storeState)
    : mocks.storeState);
  useStore.getState = () => mocks.storeState;
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

const SEARCH_PLACEHOLDER = 'Search Bible verses (min 3 characters)...';

let searchWorker = null;

// jsdom has no Worker; the modal captures one on mount to receive results.
async function previewFirstSearchResult() {
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'without form' } });
  await act(async () => {
    searchWorker.onmessage({ data: [searchResult] });
  });
  fireEvent.keyDown(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { key: 'Enter', shiftKey: true });
}

describe('BibleSearchModal translation preview trimming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings = {};
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

  it('asks the previewer to trim by default (missing Settings key reads ON)', async () => {
    mocks.buildAllVersionsPreview.mockResolvedValue([
      { bibleId: 'kjv', bibleName: 'KJV', text: 'The earth was without form and void…', truncated: true },
    ]);

    render(<BibleSearchModal isOpen onClose={vi.fn()} onSelectVerses={vi.fn()} darkMode={false} />);
    await previewFirstSearchResult();

    await vi.waitFor(() => expect(mocks.buildAllVersionsPreview).toHaveBeenCalled());
    expect(mocks.buildAllVersionsPreview.mock.calls[0][0].truncate).toBe(true);
    expect(await screen.findByText('(trimmed)')).toBeTruthy();
  });

  it('passes truncate: false and shows the full text with no marker when the toggle is off', async () => {
    mocks.settings = { truncateVersionPreviews: false };
    const fullText = `${'copy-pasted block '.repeat(100)}PASTE-DUPLICATE-TAIL`;
    mocks.buildAllVersionsPreview.mockResolvedValue([
      { bibleId: 'kjv', bibleName: 'KJV', text: fullText, truncated: false },
    ]);

    render(<BibleSearchModal isOpen onClose={vi.fn()} onSelectVerses={vi.fn()} darkMode={false} />);
    await previewFirstSearchResult();

    await vi.waitFor(() => expect(mocks.buildAllVersionsPreview).toHaveBeenCalled());
    expect(mocks.buildAllVersionsPreview.mock.calls[0][0].truncate).toBe(false);
    expect(await screen.findByText(/PASTE-DUPLICATE-TAIL/)).toBeTruthy();
    expect(screen.queryByText('(trimmed)')).toBeNull();
  });

  it('renders no marker when the entry came back untrimmed', async () => {
    mocks.buildAllVersionsPreview.mockResolvedValue([
      { bibleId: 'kjv', bibleName: 'KJV', text: 'The earth was without form and void', truncated: false },
    ]);

    render(<BibleSearchModal isOpen onClose={vi.fn()} onSelectVerses={vi.fn()} darkMode={false} />);
    await previewFirstSearchResult();

    expect(await screen.findByText(/The earth was without form and void/)).toBeTruthy();
    expect(screen.queryByText('(trimmed)')).toBeNull();
  });
});
