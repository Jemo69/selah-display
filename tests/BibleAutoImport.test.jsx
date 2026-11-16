import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import UserPreferencesModal from '@/components/UserPreferencesModal';
import useBibleStore from '@/context/BibleStore';
import { bibleDb } from '@/utils/db';
import { resetBibleAutoImportForTests } from '@/hooks/useBibleAutoImport';

vi.mock('@/utils/db', () => ({
  bibleDb: {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    keys: vi.fn(async () => []),
  },
}));

describe('UserPreferencesModal - Bible auto-import surface', () => {
  const origFetch = global.fetch;
  const origBibleAPI = typeof window !== 'undefined' ? window.bibleAPI : undefined;

  beforeEach(() => {
    resetBibleAutoImportForTests();
    useBibleStore.setState({
      bibles: {},
      bibleMetadata: {},
      activeBibleId: null,
      defaultBibleId: null,
    });
    global.fetch = vi.fn(async () => ({ ok: false }));
    if (typeof window !== 'undefined') delete window.bibleAPI;
  });

  afterEach(() => {
    global.fetch = origFetch;
    if (typeof window !== 'undefined') {
      if (origBibleAPI) window.bibleAPI = origBibleAPI;
      else delete window.bibleAPI;
    }
    vi.clearAllMocks();
  });

  it('keeps the import action and shows which translations are installed', async () => {
    useBibleStore.setState({
      bibles: { one: { name: 'KJV (Bundled Sample)', books: [] } },
      bibleMetadata: { one: { id: 'one', name: 'KJV (Bundled Sample)' } },
      defaultBibleId: 'one',
      activeBibleId: 'one',
    });
    render(<UserPreferencesModal darkMode={false} onClose={() => {}} initialSection="bible" />);
    expect(screen.getByRole('button', { name: 'Import Bible Translation' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('bible-installed-list')).toBeTruthy();
      expect(screen.getByTestId('bible-installed-count').textContent).toBe('1');
    });
  });

  it('auto-imports the bundled KJV via window.bibleAPI when nothing is installed', async () => {
    const bundled = {
      id: 'bundled-kjv',
      name: 'KJV (Bundled Sample)',
      books: [
        {
          number: 1,
          name: 'John',
          chapters: [{ number: 3, verses: [{ number: 16, text: 'For God so loved the world…' }] }],
        },
      ],
    };
    if (typeof window !== 'undefined') {
      window.bibleAPI = {
        getBundled: vi.fn(async () => ({ success: true, bible: bundled })),
        listTranslations: vi.fn(async () => ({ success: true, translations: [] })),
      };
    }
    render(<UserPreferencesModal darkMode={false} onClose={() => {}} initialSection="bible" />);
    await waitFor(() => {
      expect(useBibleStore.getState().bibleMetadata['bundled-kjv']).toBeTruthy();
    });
    expect(screen.getByTestId('bible-installed-count').textContent).toBe('1');
  });
});
