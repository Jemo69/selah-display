import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import OnlineBibleSearchModal from '../OnlineBibleSearchModal';
import useBibleStore from '@/context/BibleStore';

const mocks = vi.hoisted(() => ({
  downloadOnlineTranslation: vi.fn(),
  fetchOnlineBooks: vi.fn(),
}));

vi.mock('@/utils/onlineBible', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    downloadOnlineTranslation: mocks.downloadOnlineTranslation,
    fetchOnlineBooks: mocks.fetchOnlineBooks,
  };
});

vi.mock('@/utils/db', () => ({
  bibleDb: {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    keys: vi.fn(async () => []),
  },
}));

describe('OnlineBibleSearchModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBibleStore.setState({
      bibles: {},
      bibleMetadata: {},
      activeBibleId: null,
      defaultBibleId: null,
    });
    mocks.fetchOnlineBooks.mockResolvedValue(
      Array.from({ length: 66 }, (_, i) => ({ number: i + 1, name: `Book${i + 1}`, chapters: 1 }))
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const renderOpen = (props = {}) => render(
    <OnlineBibleSearchModal
      darkMode={false}
      isOpen
      onClose={() => {}}
      {...props}
    />
  );

  it('renders the translation catalog with no browser needed', async () => {
    renderOpen();
    expect(await screen.findByTestId('online-bible-search-modal')).toBeTruthy();
    expect(screen.getByText('Bible Search & Import')).toBeTruthy();
    for (const abbr of ['KJV', 'ASV', 'WEB', 'YLT']) {
      expect(await screen.findByTestId(`online-bible-translation-${abbr}`)).toBeTruthy();
    }
    expect(screen.queryByTestId('online-bible-tab-lookup')).toBeNull();
  });

  it('imports a translation into the library', async () => {
    const bible = {
      id: 'bolls-kjv',
      name: 'King James Version',
      books: [{ number: 1, name: 'Genesis', chapters: [{ number: 1, verses: [{ number: 1, text: 'In the beginning' }] }] }],
    };
    mocks.downloadOnlineTranslation.mockImplementation(async (_abbr, { onProgress } = {}) => {
      onProgress?.({ done: 1, total: 2, book: 'Genesis', chapter: 1 });
      return bible;
    });
    renderOpen();
    expect(await screen.findByTestId('online-bible-translation-KJV')).toBeTruthy();

    fireEvent.click(screen.getAllByText('Import')[0]);

    await waitFor(() => {
      expect(mocks.downloadOnlineTranslation).toHaveBeenCalledWith('KJV', expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(useBibleStore.getState().bibleMetadata['bolls-kjv']).toBeTruthy();
    });
    expect(useBibleStore.getState().defaultBibleId).toBe('bolls-kjv');
  });

  it('shows a friendly error when an import fails', async () => {
    mocks.downloadOnlineTranslation.mockRejectedValue(new Error('Bible service responded with 500'));
    renderOpen();
    expect(await screen.findByTestId('online-bible-translation-ASV')).toBeTruthy();

    const asvRow = screen.getByTestId('online-bible-translation-ASV');
    fireEvent.click(asvRow.querySelector('button'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });
    expect(screen.getByRole('alert').textContent).toMatch('responded with 500');
  });
});
