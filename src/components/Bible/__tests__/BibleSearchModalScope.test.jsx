/**
 * Limited text scope in the Bible search modal.
 *
 * The scope field must say what it is doing in plain words: either "searching
 * only Acts 6:1-10" or "not a passage yet — searching the whole Bible". An
 * operator who cannot tell which of those is true will not trust the results.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import BibleSearchModal from '../BibleSearchModal';

const mocks = vi.hoisted(() => ({
  storeState: null,
  settings: {},
  // Experimental gate: the passage field does not exist while this is off.
  textScopeEnabled: true,
}));

const bibles = {
  kjv: {
    id: 'kjv',
    name: 'KJV',
    books: [
      {
        number: 44,
        name: 'Acts',
        chapters: [{ number: 6, verses: [{ number: 5, text: 'And they chose Stephen, a man full of faith' }] }],
      },
    ],
  },
};

mocks.storeState = {
  bibles,
  bibleMetadata: { kjv: { id: 'kjv', name: 'KJV' } },
  activeBibleId: 'kjv',
  defaultBibleId: 'kjv',
  activeReference: { id: 'kjv', book: 44, chapters: ['6'], verses: [[5]] },
  selectedVerses: [[5]],
  addBible: vi.fn(),
  setActiveBible: vi.fn(),
  loadAllBibles: vi.fn(),
  evictInactiveBibles: vi.fn(),
  setSearchAllOwner: vi.fn(),
  clearSearchAllOwner: vi.fn(),
  setDefaultBible: vi.fn(),
  setReference: vi.fn(),
  setSelectedVerses: vi.fn(),
  getFormattedReference: () => 'Acts 6:5',
  getVerseText: () => 'And they chose Stephen, a man full of faith',
  getBibleById: (id) => bibles[id],
  settings: mocks.settings,
};

// Keep the real scope parsing — the subject of this test is the modal's
// reading of what the operator typed — and stub only the file importer.
vi.mock('shared/bible', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, parseBibleFromFile: vi.fn() };
});

vi.mock('../BibleBrowser', () => ({ default: () => null }));
vi.mock('../BibleImportModal', () => ({ default: () => null }));

vi.mock('../../../utils/biblePreview', () => ({
  buildAllVersionsPreview: vi.fn().mockResolvedValue([]),
  truncatePreviewText: (text) => String(text ?? '').slice(0, 280),
}));

vi.mock('../../../hooks/useToast', () => ({
  default: () => ({ showToast: vi.fn() }),
}));

vi.mock('../../../context/LyricsStore', () => {
  const useStore = (selector) => (typeof selector === 'function'
    ? selector({ bibleTextScopeEnabled: mocks.textScopeEnabled })
    : { bibleTextScopeEnabled: mocks.textScopeEnabled });
  useStore.getState = () => ({ bibleTextScopeEnabled: mocks.textScopeEnabled });
  return { default: useStore };
});

vi.mock('../../../context/BibleStore', () => {
  const useStore = (selector) => (typeof selector === 'function'
    ? selector(mocks.storeState)
    : mocks.storeState);
  useStore.getState = () => mocks.storeState;
  return { default: useStore };
});

const SEARCH_PLACEHOLDER = 'Search Bible verses (min 3 characters)...';
const SCOPE_PLACEHOLDER = 'Acts 6 or Acts 6:1-10';

let worker = null;

describe('BibleSearchModal limited text scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.textScopeEnabled = true;
    globalThis.Worker = class {
      constructor() {
        worker = this;
        this.messages = [];
      }

      postMessage(message) {
        this.messages.push(message);
      }

      terminate() {}
    };
  });

  afterEach(() => {
    delete globalThis.Worker;
    worker = null;
  });

  function openSearchTab() {
    render(<BibleSearchModal isOpen onClose={vi.fn()} onSelectVerses={vi.fn()} darkMode={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    return screen.getByPlaceholderText(SCOPE_PLACEHOLDER);
  }

  it('shows no passage field while the experimental switch is off', () => {
    mocks.textScopeEnabled = false;
    render(<BibleSearchModal isOpen onClose={vi.fn()} onSelectVerses={vi.fn()} darkMode={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.queryByPlaceholderText(SCOPE_PLACEHOLDER)).toBeNull();
  });

  it('confirms a valid passage in plain words', () => {
    const scopeInput = openSearchTab();
    fireEvent.change(scopeInput, { target: { value: 'Acts 6:1-10' } });
    expect(screen.getByText('Searching only Acts 6:1-10')).toBeTruthy();
  });

  it('tells the operator when the text is not a passage, rather than silently searching everything', () => {
    const scopeInput = openSearchTab();
    fireEvent.change(scopeInput, { target: { value: 'Acts' } });
    expect(screen.getByText('Not a passage yet — searching the whole Bible')).toBeTruthy();
  });

  it('sends the parsed scope to the search worker', async () => {
    const scopeInput = openSearchTab();
    fireEvent.change(scopeInput, { target: { value: 'Acts 6' } });
    fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'stephen' } });

    await vi.waitFor(() => {
      const request = worker.messages.find((m) => m.query === 'stephen');
      expect(request?.scope).toEqual({
        bookName: 'Acts',
        ranges: [{ startChapter: 6, startVerse: null, endChapter: 6, endVerse: null }],
      });
    });
  });

  it('sends no scope once the operator clears the field', async () => {
    const scopeInput = openSearchTab();
    fireEvent.change(scopeInput, { target: { value: 'Acts 6' } });
    fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'stephen' } });
    await vi.waitFor(() => expect(worker.messages.some((m) => m.query === 'stephen')).toBe(true));

    fireEvent.change(scopeInput, { target: { value: '' } });
    await vi.waitFor(() => {
      const cleared = worker.messages.filter((m) => m.query === 'stephen' && m.scope === null);
      expect(cleared.length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/Searching only/)).toBeNull();
  });
});
