import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../toast/ToastProvider';
import FileNavigatorModal from '../FileNavigatorModal';
import FileNavigatorSaveModal from '../FileNavigatorSaveModal';
import { OPEN_FILE_NAVIGATOR_EVENT, OPEN_FILE_SAVE_NAVIGATOR_EVENT } from '../../utils/fileNavigatorEvents';
import { logSearchEvent } from '../../utils/searchAnalytics.js';

vi.mock('../../utils/searchAnalytics.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, logSearchEvent: vi.fn() };
});

const FILES = [
  {
    kind: 'file',
    filePath: '/lyrics/Amazing Grace.txt',
    rootPath: '/lyrics',
    fileName: 'Amazing Grace.txt',
    fileType: 'txt',
    relativePath: 'Amazing Grace.txt',
    parentPath: '/lyrics',
    size: 512,
    modifiedMs: 1700000000000,
    previewAvailable: true,
  },
  {
    kind: 'folder',
    filePath: '/lyrics/Sub',
    rootPath: '/lyrics',
    fileName: 'Sub',
    relativePath: 'Sub',
    parentPath: '/lyrics',
  },
];

function mockNavigatorApi(overrides = {}) {
  const calls = { prepareSave: [], writeFile: [] };
  const api = {
    getState: vi.fn().mockResolvedValue({
      success: true,
      roots: [{ path: '/lyrics', name: 'Lyrics', available: true, indexable: true }],
      recents: [],
      status: { scanning: false, indexedFiles: 1 },
      limits: {},
    }),
    getSaveDestinations: vi.fn().mockResolvedValue({
      success: true,
      destinations: [{ path: '/lyrics', name: 'Lyrics', detail: 'Indexed lyrics folder', available: true, preferred: false }],
    }),
    browse: vi.fn().mockResolvedValue({
      success: true,
      directoryPath: '/lyrics',
      parentPath: null,
      rootPath: '/lyrics',
      items: FILES,
    }),
    search: vi.fn().mockResolvedValue({ success: true, results: [FILES[0]] }),
    preview: vi.fn().mockResolvedValue({
      success: true,
      available: true,
      content: 'Amazing grace, how sweet the sound',
      truncated: false,
    }),
    open: vi.fn().mockResolvedValue({
      success: true,
      content: 'Amazing grace, how sweet the sound',
      fileName: 'Amazing Grace.txt',
      fileType: 'txt',
      filePath: '/lyrics/Amazing Grace.txt',
    }),
    prepareSave: vi.fn().mockImplementation(async (payload) => {
      calls.prepareSave.push(payload);
      return {
        success: true,
        directoryPath: '/lyrics',
        filePath: '/lyrics/Amazing Grace.txt',
        fileName: 'Amazing Grace.txt',
        baseName: 'Amazing Grace',
        extension: 'txt',
        exists: false,
        writeGranted: true,
      };
    }),
    addRoot: vi.fn().mockResolvedValue({ success: true, canceled: false, selection: { addedPaths: [], requestedCount: 1, addedCount: 1, skipped: [] } }),
    createLyricsFolder: vi.fn().mockResolvedValue({ success: true, createdFolderPath: '/lyrics' }),
    removeRoot: vi.fn().mockResolvedValue({ success: true, roots: [{ path: '/lyrics', name: 'Lyrics', available: true, indexable: true }], status: {}, recents: [] }),
    reindex: vi.fn().mockResolvedValue({ success: true, roots: [], recents: [], status: { scanning: false, indexedFiles: 1 }, limits: {} }),
    onChange: vi.fn(() => () => {}),
    ...overrides,
  };
  vi.stubGlobal('electronAPI', { fileNavigator: api, writeFile: vi.fn(async (_filePath, content) => { calls.writeFile.push(content); return { success: true }; }) });
  return { api, calls };
}

function renderWithToast(ui) {
  return render(<ToastProvider isDark={false}>{ui}</ToastProvider>);
}

describe('FileNavigatorModal', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockNavigatorApi();
    // Toggle test flips the persisted content-search flag — reset so each
    // search test starts from the default (content search ON).
    try {
      const { default: useLyricsStore } = await import('../../context/LyricsStore.js');
      useLyricsStore.getState().setLyricContentSearchEnabled?.(true);
    } catch {
      // Store unavailable in this env — tests still run with defaults.
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('browses the indexed folders and resolves a selection on open', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    renderWithToast(<FileNavigatorModal darkMode={false} />);

    window.dispatchEvent(new CustomEvent(OPEN_FILE_NAVIGATOR_EVENT, { detail: { onComplete } }));

    const fileItem = await screen.findByRole('option', { name: /Amazing Grace/ });
    expect(fileItem).toBeTruthy();
    await user.click(fileItem);

    await user.click(screen.getByTestId('file-navigator-open'));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith({
        canceled: false,
        filePath: '/lyrics/Amazing Grace.txt',
        payload: expect.objectContaining({ content: 'Amazing grace, how sweet the sound', fileName: 'Amazing Grace.txt' }),
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('file-navigator-modal')).toBeNull();
    });
  });

  it('resolves with canceled when closed without a selection', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    renderWithToast(<FileNavigatorModal darkMode={false} />);

    window.dispatchEvent(new CustomEvent(OPEN_FILE_NAVIGATOR_EVENT, { detail: { onComplete } }));
    await screen.findByRole('option', { name: /Amazing Grace/ });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith({ canceled: true });
    });
  });

  it('searches the index and shows the match', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    renderWithToast(<FileNavigatorModal darkMode={false} />);

    window.dispatchEvent(new CustomEvent(OPEN_FILE_NAVIGATOR_EVENT, { detail: { onComplete } }));
    await screen.findByRole('option', { name: /Amazing Grace/ });

    await user.type(screen.getByTestId('file-navigator-search'), 'grace');
    const searchItem = await screen.findByRole('option', { name: /Amazing Grace/ });
    expect(searchItem).toBeTruthy();
    expect(window.electronAPI.fileNavigator.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'grace', limit: 80 }));
  });

  it('toggles lyric content search via button and passes searchContent: false when disabled', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    renderWithToast(<FileNavigatorModal darkMode={false} />);

    window.dispatchEvent(new CustomEvent(OPEN_FILE_NAVIGATOR_EVENT, { detail: { onComplete } }));
    await screen.findByRole('option', { name: /Amazing Grace/ });

    const toggleBtn = screen.getByTestId('file-navigator-content-search-toggle');
    expect(toggleBtn).toBeTruthy();

    await user.click(toggleBtn);

    await user.type(screen.getByTestId('file-navigator-search'), 'grace');
    await waitFor(() => {
      expect(window.electronAPI.fileNavigator.search).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'grace',
          limit: 80,
          searchContent: false,
        })
      );
    });
  });

  it('logs the lyrics search result to local search telemetry', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    vi.mocked(logSearchEvent).mockClear();
    renderWithToast(<FileNavigatorModal darkMode={false} />);

    window.dispatchEvent(new CustomEvent(OPEN_FILE_NAVIGATOR_EVENT, { detail: { onComplete } }));
    await screen.findByRole('option', { name: /Amazing Grace/ });

    await user.type(screen.getByTestId('file-navigator-search'), 'grace');
    await waitFor(() => {
      expect(window.electronAPI.fileNavigator.search).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'grace' })
      );
    });
    await waitFor(() => {
      expect(vi.mocked(logSearchEvent)).toHaveBeenCalledWith(
        expect.objectContaining({
          surface: 'file-navigator',
          query: 'grace',
          resultCount: 1,
        })
      );
    });
    const logged = vi.mocked(logSearchEvent).mock.calls[0][0];
    expect(logged.topResults[0]).toMatchObject({ fileName: 'Amazing Grace.txt' });
    expect(typeof logged.latencyMs).toBe('number');
  });
});

describe('FileNavigatorSaveModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigatorApi();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openSaveModal(onComplete, overrides = {}) {
    renderWithToast(<FileNavigatorSaveModal darkMode={false} />);
    window.dispatchEvent(new CustomEvent(OPEN_FILE_SAVE_NAVIGATOR_EVENT, {
      detail: {
        suggestedName: 'Amazing Grace',
        extension: 'txt',
        availableExtensions: ['txt', 'lrc'],
        initialDirectory: '/lyrics',
        contentByExtension: 'Amazing grace, how sweet the sound',
        onComplete,
        ...overrides,
      },
    }));
    await screen.findByTestId('file-navigator-save-modal');
  }

  it('picks a destination and writes the file through the atomic save path', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    await openSaveModal(onComplete);

    await screen.findByText('Lyrics');
    await user.click(screen.getByTestId('file-navigator-save-confirm'));

    await waitFor(() => {
      expect(window.electronAPI.fileNavigator.prepareSave).toHaveBeenCalledWith({
        directoryPath: '/lyrics',
        fileName: 'Amazing Grace.txt',
        extension: 'txt',
        overwrite: false,
      });
    });
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith({ canceled: false, filePath: '/lyrics/Amazing Grace.txt', fileName: 'Amazing Grace.txt' });
    });
    expect(window.electronAPI.writeFile).toHaveBeenCalledWith('/lyrics/Amazing Grace.txt', 'Amazing grace, how sweet the sound');
  });

  it('rejects invalid file names before calling prepareSave', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    await openSaveModal(onComplete);

    const nameInput = screen.getByTestId('file-navigator-save-name');
    await user.clear(nameInput);
    await user.type(nameInput, 'bad<name');
    await user.click(screen.getByTestId('file-navigator-save-confirm'));

    expect(window.electronAPI.fileNavigator.prepareSave).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByText(/File names cannot contain/)).toBeTruthy();
  });

  it('asks before overwriting an existing file', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();

    let conflict = false;
    mockNavigatorApi({
      prepareSave: vi.fn(async (payload) => {
        if (conflict) {
          return { success: true, filePath: '/lyrics/Amazing Grace.txt', fileName: 'Amazing Grace.txt', baseName: 'Amazing Grace', extension: 'txt', exists: true, writeGranted: true };
        }
        conflict = true;
        return { success: true, filePath: '/lyrics/Amazing Grace.txt', fileName: 'Amazing Grace.txt', baseName: 'Amazing Grace', extension: 'txt', exists: true, writeGranted: false };
      }),
    });
    await openSaveModal(onComplete);

    await screen.findByText('Lyrics');
    await user.click(screen.getByTestId('file-navigator-save-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('file-navigator-save-overwrite')).toBeTruthy();
    });
    await waitFor(() => {
      expect(onComplete).not.toHaveBeenCalled();
    });

    await user.click(screen.getByTestId('file-navigator-save-overwrite'));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith({ canceled: false, filePath: '/lyrics/Amazing Grace.txt', fileName: 'Amazing Grace.txt' });
    });
  });

  it('resolves unavailable when no indexed destination exists', async () => {
    mockNavigatorApi({
      getSaveDestinations: vi.fn().mockResolvedValue({ success: true, destinations: [] }),
    });
    const onComplete = vi.fn();
    renderWithToast(<FileNavigatorSaveModal darkMode={false} />);

    window.dispatchEvent(new CustomEvent(OPEN_FILE_SAVE_NAVIGATOR_EVENT, {
      detail: { suggestedName: 'x', extension: 'txt', availableExtensions: ['txt'], contentByExtension: 'x', onComplete },
    }));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith({ unavailable: true });
    });
    expect(screen.queryByTestId('file-navigator-save-modal')).toBeNull();
  });
});