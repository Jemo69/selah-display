import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OPEN_FILE_NAVIGATOR_EVENT,
  openLyricsFileThroughNavigator,
  pickLyricFileWithNavigator,
} from '../fileNavigatorEvents.js';

function stubNavigator({ onOpen } = {}) {
  window.electronAPI = {
    fileNavigator: {
      getState: vi.fn().mockResolvedValue({ success: true, roots: [], status: {} }),
      open: onOpen || vi.fn().mockResolvedValue({
        success: true,
        content: 'Amazing grace',
        fileName: 'Amazing Grace.txt',
        filePath: '/lyrics/Amazing Grace.txt',
      }),
    },
  };
}

describe('fileNavigatorEvents — cancel must not fall through to the OS picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete window.electronAPI;
  });

  it('returns null when the navigator is unavailable (callers may use the OS picker)', async () => {
    delete window.electronAPI;
    await expect(openLyricsFileThroughNavigator()).resolves.toBeNull();
  });

  it('returns an explicit canceled signal when the user cancels the navigator', async () => {
    stubNavigator();
    window.addEventListener(OPEN_FILE_NAVIGATOR_EVENT, function cancelOnce(event) {
      window.removeEventListener(OPEN_FILE_NAVIGATOR_EVENT, cancelOnce);
      event.detail.onComplete({ canceled: true });
    });
    await expect(openLyricsFileThroughNavigator()).resolves.toEqual({ canceled: true });
  });

  it('pickLyricFileWithNavigator surfaces unavailable without opening anything', async () => {
    delete window.electronAPI;
    const spy = vi.fn();
    window.addEventListener(OPEN_FILE_NAVIGATOR_EVENT, spy);
    await expect(pickLyricFileWithNavigator({})).resolves.toEqual({ unavailable: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it('resolveLyricSelectionContent prefers payload, falls back to the index, and lets failures propagate', async () => {
    const open = vi.fn().mockResolvedValue({
      success: true, content: 'Indexed content', fileName: 'Indexed.txt', filePath: '/lyrics/Indexed.txt',
    });
    stubNavigator({ onOpen: open });
    const { resolveLyricSelectionContent } = await import('../fileNavigatorEvents.js');

    // Payload present (Browse files / indexed open): no index touch.
    const payload = { success: true, content: 'Already loaded', fileName: 'Outside.txt', filePath: '/desktop/Outside.txt' };
    await expect(resolveLyricSelectionContent({ canceled: false, filePath: '/desktop/Outside.txt', payload }))
      .resolves.toBe(payload);
    expect(open).not.toHaveBeenCalled();

    // Payload absent (older producers): index fallback.
    await expect(resolveLyricSelectionContent({ canceled: false, filePath: '/lyrics/Indexed.txt' }))
      .resolves.toMatchObject({ content: 'Indexed content' });
    expect(open).toHaveBeenCalledWith('/lyrics/Indexed.txt');

    // Index failure propagates so callers choose silent-null vs toast.
    open.mockRejectedValueOnce(new Error('File is outside indexed sources'));
    await expect(resolveLyricSelectionContent({ canceled: false, filePath: '/gone.txt' }))
      .rejects.toThrow('File is outside indexed sources');
  });

  it('pins the caller contract: cancel never falls through, unavailable does', async () => {
    // Both Open-Lyrics entry points (useMenuShortcuts, LyricDisplayApp) run
    // exactly this pattern: `if (navigatorResult) return;` then the OS picker.
    // A cancel must be truthy (handled); only null (unavailable) may fall back.
    async function callerFallback(resolveSelection) {
      stubNavigator();
      if (resolveSelection) {
        window.addEventListener(OPEN_FILE_NAVIGATOR_EVENT, function once(event) {
          window.removeEventListener(OPEN_FILE_NAVIGATOR_EVENT, once);
          event.detail.onComplete(resolveSelection);
        });
      } else {
        delete window.electronAPI;
      }
      const navigatorResult = await openLyricsFileThroughNavigator();
      if (navigatorResult) return 'handled';
      return 'fallback-to-os-picker';
    }

    await expect(callerFallback({ canceled: true })).resolves.toBe('handled');
    await expect(callerFallback(null)).resolves.toBe('fallback-to-os-picker');
  });

  it('prefers the selection payload over re-reading through the index', async () => {
    stubNavigator();
    const lyricsOpened = vi.fn();
    window.addEventListener('lyrics-opened', lyricsOpened);
    window.addEventListener(OPEN_FILE_NAVIGATOR_EVENT, function pickOnce(event) {
      window.removeEventListener(OPEN_FILE_NAVIGATOR_EVENT, pickOnce);
      event.detail.onComplete({
        canceled: false,
        filePath: '/desktop/Outside Index.txt',
        payload: {
          success: true,
          content: 'Payload content (already loaded, outside the index)',
          fileName: 'Outside Index.txt',
          filePath: '/desktop/Outside Index.txt',
        },
      });
    });
    const result = await openLyricsFileThroughNavigator();
    expect(result?.content).toBe('Payload content (already loaded, outside the index)');
    // Must not touch the index: the file may live outside indexed roots.
    expect(window.electronAPI.fileNavigator.open).not.toHaveBeenCalled();
    expect(lyricsOpened).toHaveBeenCalledOnce();
    window.removeEventListener('lyrics-opened', lyricsOpened);
  });
});
