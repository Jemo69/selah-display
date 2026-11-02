import { ipcMain, dialog, nativeTheme, BrowserWindow, app } from 'electron';
import Store from 'electron-store';
import { addRecent, getRecents, clearRecents, subscribe as subscribeRecents } from './recents.js';
import { readFile, writeFile, readdir, mkdir, unlink, stat } from 'fs/promises';
import { existsSync } from 'node:fs';

// Documents/Setlists default: reuse the pre-rebrand folder when it exists so
// existing setlists stay one click away after the LyricDisplay → Selah rename.
function defaultSetlistsPath(userHome, separator) {
  const documents = `${userHome}${separator}Documents`;
  const legacy = `${documents}${separator}LyricDisplay${separator}Setlists`;
  try {
    if (existsSync(legacy)) return legacy;
  } catch { }
  return `${documents}${separator}Selah${separator}Setlists`;
}
import { getLocalIPAddress, getAllLocalIPAddresses } from './utils.js';
import * as secureTokenStore from './secureTokenStore.js';
import updaterPkg from 'electron-updater';
import { saveTextFileAtomically } from './atomicFileSave.js';
import { createProgressWindow } from './progressWindow.js';
import { getAdminKey, onAdminKeyAvailable } from './adminKey.js';
import { parseTxtContent, parseLrcContent } from '../shared/lyricsParsing.js';
import { fetchLyricsByProvider, getProviderDefinitions, getProviderKeyState, removeProviderKey, saveProviderKey, searchAllProviders } from './lyricsProviders/index.js';
import * as easyWorship from './easyWorship.js';
import * as presentation from './presentation.js';
import * as displayManager from './displayManager.js';
import { loadSystemFonts } from './systemFonts.js';
import { saveDarkModePreference } from './themePreferences.js';
import { handleFileOpen } from './fileHandler.js';
import { exportSetlistToPDF, exportSetlistToTXT } from './setlistExport.js';
import * as userTemplates from './userTemplates.js';
import path from 'path';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { parseBible, buildSearchIndex } from '../shared/bible/index.js';
import createMainLogger from './logger.js';
import { registerLyricWatcherHandlers } from './lyricWatcher.js';
import { isTrustedIpcSender, untrustedIpcResponse } from './ipcSecurity.js';

const log = createMainLogger('IPC');

const { autoUpdater } = updaterPkg;

let cachedJoinCode = null;

// --- Separate thread for HTTP â main never blocks while Automation/HTTP is in flight ---
let httpWorker = null;
let httpSeq = 1;
function getHttpWorker() {
  if (httpWorker) return httpWorker;
  try {
    const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workers', 'httpFetchWorker.js');
    httpWorker = new Worker(workerPath, { type: 'module' });
    httpWorker.on('error', (e) => log.error('HTTP worker error:', e));
    httpWorker.on('exit', () => { httpWorker = null; });
    return httpWorker;
  } catch (e) {
    log.error('Failed to start HTTP worker, falling back to main fetch:', e);
    return null;
  }
}
function fetchInWorker({ url, method, headers, body, timeoutMs = 8000 }) {
  const worker = getHttpWorker();
  if (!worker) return null; // caller will fallback to direct fetch
  return new Promise((resolve) => {
    const id = httpSeq++;
    const timer = setTimeout(() => {
      resolve({ success: false, error: `HTTP timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    const onMsg = (msg) => {
      if (msg?.id !== id) return;
      clearTimeout(timer);
      worker.off('message', onMsg);
      resolve(msg);
    };
    worker.on('message', onMsg);
    worker.postMessage({ id, url, method, headers, body });
  });
}

export function registerIpcHandlers({ getMainWindow, openInAppBrowser, updateDarkModeMenu, updateUndoRedoState, checkForUpdates, requestRendererModal }) {

  const MAX_BIBLE_CACHE_ENTRIES = 4;
  const bibleParsedCache = new Map();

function cacheBibleParsed(filePath, entry) {
  bibleParsedCache.delete(filePath);
  bibleParsedCache.set(filePath, entry);
  // Retaining full parsed bibles plus their search indexes in the main
  // process is expensive (a translation can be tens of MB); bound the cache
  // to the most recently seen files so repeated psalm training sessions do
  // not grow into an unbounded memory sink.
  while (bibleParsedCache.size > MAX_BIBLE_CACHE_ENTRIES) {
    const oldestKey = bibleParsedCache.keys().next().value;
    if (!oldestKey) break;
    bibleParsedCache.delete(oldestKey);
  }
}

  ipcMain.on('undo-redo-state', (_event, { canUndo, canRedo }) => {
    if (typeof updateUndoRedoState === 'function') {
      updateUndoRedoState({ canUndo, canRedo });
    }
  });

  try {
    subscribeRecents((recentsList) => {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win || win.isDestroyed()) continue;
        try {
          win.webContents.send('recents:update', recentsList || []);
        } catch { }
      }
    });
  } catch { }

  const broadcastAdminKeyAvailable = (adminKey) => {
    const payload = { hasKey: Boolean(adminKey) };
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win || win.isDestroyed()) continue;
      try {
        win.webContents.send('admin-key:available', payload);
      } catch (error) {
        log.warn('Failed to notify renderer about admin key availability:', error);
      }
    }
  };

  onAdminKeyAvailable(broadcastAdminKeyAvailable);

  // Dark mode query and update hooks
  ipcMain.handle('get-dark-mode', () => {
    return false;
  });

  ipcMain.handle('set-dark-mode', (_event, _isDark) => {
    try { updateDarkModeMenu(); } catch { }
    return true;
  });

  ipcMain.handle('app:get-version', () => {
    try {
      return { success: true, version: app.getVersion() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('window:minimize', () => {
    const win = getMainWindow?.();
    if (win && !win.isDestroyed()) {
      try { win.minimize(); return { success: true }; } catch (error) { return { success: false, error: error.message }; }
    }
    return { success: false, error: 'No window' };
  });

  ipcMain.handle('window:toggle-maximize', () => {
    const win = getMainWindow?.();
    if (!win || win.isDestroyed()) return { success: false, error: 'No window' };
    try {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
      const payload = {
        isMaximized: win.isMaximized(),
        isFullScreen: win.isFullScreen(),
        isFocused: win.isFocused()
      };
      try { win.webContents.send('window-state', payload); } catch { }
      return { success: true, ...payload };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('window:close', () => {
    const win = getMainWindow?.();
    if (!win || win.isDestroyed()) return { success: false, error: 'No window' };
    try { win.close(); return { success: true }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('window:toggle-fullscreen', () => {
    const win = getMainWindow?.();
    if (!win || win.isDestroyed()) return { success: false, error: 'No window' };
    try {
      const next = !win.isFullScreen();
      win.setFullScreen(next);
      return { success: true, isFullScreen: next };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('window:reload', () => {
    const win = getMainWindow?.();
    if (!win || win.isDestroyed()) return { success: false, error: 'No window' };
    try { win.reload(); return { success: true }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('window:devtools', (_event) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('window:devtools');
    const win = getMainWindow?.();
    if (!win || win.isDestroyed()) return { success: false, error: 'No window' };
    try {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools({ mode: 'detach' });
      }
      return { success: true, isOpen: win.webContents.isDevToolsOpened() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('window:zoom', (_event, direction) => {
    const win = getMainWindow?.();
    if (!win || win.isDestroyed()) return { success: false, error: 'No window' };
    try {
      const wc = win.webContents;
      const current = wc.getZoomFactor();
      let next = current;
      if (direction === 'in') next = Math.min(current + 0.1, 3);
      else if (direction === 'out') next = Math.max(current - 0.1, 0.3);
      else if (direction === 'reset') next = 1;
      wc.setZoomFactor(next);
      return { success: true, zoomFactor: next };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('window:get-state', () => {
    const win = getMainWindow?.();
    if (!win || win.isDestroyed()) return { success: false, error: 'No window' };
    try {
      return {
        success: true,
        state: {
          isMaximized: win.isMaximized(),
          isFullScreen: win.isFullScreen(),
          isFocused: win.isFocused()
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // File operations
  ipcMain.handle('show-save-dialog', async (_event, options) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('show-save-dialog');
    const win = getMainWindow?.();
    const result = await dialog.showSaveDialog(win || undefined, options);
    return result;
  });

  ipcMain.handle('write-file', async (_event, filePath, content) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('write-file');
    try {
      await saveTextFileAtomically(filePath, content, { mode: 'replace' });
    } catch (error) {
      log.error('write-file failed:', error);
      throw error;
    }
    return { success: true };
  });

  ipcMain.handle('performance:update-hda', (_event, disabled) => {
    try {
      const preferences = new Store({ name: 'preferences' });
      preferences.set('disableHardwareAcceleration', !!disabled);
      return { success: true };
    } catch (error) {
      log.error('Failed to update hardware acceleration preference:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('load-lyrics-file', async () => {
    try {
      const win = getMainWindow?.();
      const result = await dialog.showOpenDialog(win || undefined, { properties: ['openFile'], filters: [{ name: 'Text Files', extensions: ['txt', 'lrc'] }] });
      if (!result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0];
        const content = await readFile(filePath, 'utf8');
        const fileName = filePath.split(/[\\/]/).pop();
        try { await addRecent(filePath); } catch { }
        return { success: true, content, fileName, filePath };
      }
      return { success: false, canceled: true };
    } catch (error) {
      log.error('Error loading lyrics file:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('parse-lyrics-file', async (_event, payload = {}) => {
    try {
      const { fileType = 'txt', path: filePath, rawText, enableSplitting, splitConfig, enableNormalGrouping } = payload || {};
      let content = typeof rawText === 'string' ? rawText : null;

      if (content === null && filePath) {
        content = await readFile(filePath, 'utf8');
      }

      if (typeof content !== 'string') {
        return { success: false, error: 'No lyric content available for parsing' };
      }
      
      const parser = fileType === 'lrc' ? parseLrcContent : parseTxtContent;
      const result = parser(content, { enableSplitting, splitConfig, enableNormalGrouping });

      return { success: true, payload: result };
    } catch (error) {
      log.error('Error parsing lyrics file via IPC:', error);
      return { success: false, error: error.message || 'Failed to parse lyrics' };
    }
  });

  ipcMain.handle('new-lyrics-file', () => {
    const win = getMainWindow?.();
    if (win && !win.isDestroyed()) {
      win.webContents.send('navigate-to-new-song');
    }
  });

  ipcMain.handle('sync-native-dark-mode', (_event, isDark) => {
    try {
      nativeTheme.themeSource = isDark ? 'dark' : 'light';
      saveDarkModePreference(isDark);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('fonts:list', async () => {
    try {
      const fonts = await loadSystemFonts();
      return { success: true, fonts: fonts || [] };
    } catch (error) {
      log.error('Error listing system fonts:', error);
      return { success: false, error: error.message, fonts: [] };
    }
  });

  ipcMain.handle('get-local-ip', () => getLocalIPAddress());
  ipcMain.handle('get-local-ips', () => {
    try { return { success: true, ...getAllLocalIPAddresses() }; }
    catch (e) { return { success: false, error: e?.message || String(e), lan: [], tailnet: [], all: [] }; }
  });

  ipcMain.handle('open-in-app-browser', (_event, url) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('open-in-app-browser');
    openInAppBrowser?.(url || 'https://www.google.com');
  });

  // Recent files management
  ipcMain.handle('add-recent-file', async (_event, filePath) => {
    try { await addRecent(filePath); return { success: true }; }
    catch (e) { return { success: false, error: e?.message || String(e) }; }
  });

  ipcMain.handle('recents:list', async () => {
    try {
      const recents = await getRecents();
      return { success: true, recents };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('recents:clear', async () => {
    try {
      await clearRecents();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('recents:open', async (_event, filePath) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('recents:open');
    try {
      const win = getMainWindow?.();
      if (!win || win.isDestroyed()) {
        return { success: false, error: 'No window available' };
      }
      await handleFileOpen(filePath, win);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-admin-key', async (_event) => {
    if (!isTrustedIpcSender(_event)) { log.warn('Blocked untrusted IPC sender for get-admin-key'); return null; }
    try {
      const adminKey = await getAdminKey();
      if (!adminKey) {
        log.warn('Admin key not available for renderer process');
      }
      return adminKey;
    } catch (error) {
      log.error('Error getting admin key for renderer:', error);
      return null;
    }
  });

  ipcMain.handle('get-connection-diagnostics', async () => {
    try {
      const win = getMainWindow?.();
      if (!win || win.isDestroyed()) {
        return null;
      }

      const statsResult = await win.webContents.executeJavaScript(`
      (function () {
        try {
          const data = window.connectionManager?.getStats?.();
          return data ? JSON.parse(JSON.stringify(data)) : null;
        } catch (error) {
          return { __error: error?.message || String(error) };
        }
      })();
    `, true);

      if (statsResult?.__error) {
        log.error('Connection diagnostics error:', statsResult.__error);
        return null;
      }

      return statsResult;
    } catch (error) {
      log.error('Failed to get connection diagnostics:', error);
      return null;
    }
  });

  ipcMain.handle('get-desktop-jwt', async (_event, { deviceId, sessionId }) => {
    if (!isTrustedIpcSender(_event)) { log.warn('Blocked untrusted IPC sender for get-desktop-jwt'); return null; }
    try {
      const adminKey = await getAdminKey();
      const resp = await fetch('http://127.0.0.1:4000/api/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientType: 'desktop',
          deviceId,
          sessionId,
          adminKey
        })
      });
      if (!resp.ok) throw new Error('Failed to mint desktop JWT');
      const { token } = await resp.json();
      return token;
    } catch (err) {
      log.error('Error minting desktop JWT:', err);
      return null;
    }
  });

  ipcMain.handle('token-store:get', async (_event, payload) => {
    if (!isTrustedIpcSender(_event)) { log.warn('Blocked untrusted IPC sender for token-store:get'); return null; }
    try {
      return await secureTokenStore.readToken(payload || {});
    } catch (error) {
      log.error('Error retrieving token from secure store:', error);
      return null;
    }
  });

  ipcMain.handle('token-store:set', async (_event, payload) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('token-store:set');
    try {
      await secureTokenStore.writeToken(payload || {});
      return { success: true };
    } catch (error) {
      log.error('Error writing token to secure store:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('token-store:clear', async (_event, payload) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('token-store:clear');
    try {
      await secureTokenStore.clearToken(payload || {});
      return { success: true };
    } catch (error) {
      log.error('Error clearing token from secure store:', error);
      return { success: false, error: error.message };
    }
  });
  ipcMain.handle('output-automation:fire', async (_event, payload = {}) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('output-automation:fire');
    try {
      // Copied generic settings from http-action:fire so HTTP Actions can reuse the proven bypass.
      const rawUrl = String(payload.url || payload.endpointUrl || '').trim();
      if (!rawUrl) return { success: false, error: 'Missing endpoint URL' };

      const sanitizeEndpointUrl = (url) => {
        let cleaned = String(url || '').trim();
        if (!cleaned) return '';
        if (!/^https?:\/\//i.test(cleaned)) {
          cleaned = 'http://' + cleaned;
        }
        return cleaned.replace(/^(https?:\/\/)([^/]+)/i, (match, protocol, hostAndPort) => {
          return protocol + hostAndPort.replace(/[Ã¸Ã]/g, '0');
        });
      };

      const sanitizedUrl = sanitizeEndpointUrl(rawUrl);
      const method = String(payload.method || 'POST').toUpperCase();
      const headers = payload.headers && typeof payload.headers === 'object' ? payload.headers : { 'Content-Type': 'application/json' };
      // Preserve the proven automation contract: missing or empty body falls back to the default payload.
      const body = payload.body != null && String(payload.body) !== ''
        ? String(payload.body)
        : JSON.stringify({ data: { value: false } });
      const hasBody = method !== 'GET' && method !== 'HEAD';

      log.info(`${method} ${sanitizedUrl}`);
      // Offload to dedicated worker thread â main stays responsive during slow endpoints / optimization
      const workerRes = await fetchInWorker({ url: sanitizedUrl, method, headers, body: hasBody ? body : undefined });
      if (workerRes) return workerRes;
      const response = await fetch(sanitizedUrl, {
        method,
        headers,
        body: hasBody ? body : undefined,
      });

      const responseText = await response.text().catch(() => '');
      let result = null;
      try {
        result = responseText ? JSON.parse(responseText) : null;
      } catch {
        result = responseText;
      }

      log.info(`Response ${response.status} ${response.statusText}`);
      return { success: response.ok, status: response.status, statusText: response.statusText, result };
    } catch (error) {
      log.error('Output automation fire failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('http-action:fire', async (_event, payload = {}) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('http-action:fire');
    try {
      const rawUrl = String(payload.url || payload.endpointUrl || '').trim();
      if (!rawUrl) return { success: false, error: 'Missing URL' };
      const sanitize = (url) => {
        let c = String(url || '').trim();
        if (!c) return '';
        if (!/^https?:\/\//i.test(c)) c = 'http://' + c;
        return c.replace(/^(https?:\/\/)([^/]+)/i, (m, p, h) => p + h.replace(/[Ã¸Ã]/g, '0'));
      };
      const url = sanitize(rawUrl);
      const method = String(payload.method || 'GET').toUpperCase();
      const headers = payload.headers && typeof payload.headers === 'object' ? payload.headers : {};
      const body = payload.body != null ? String(payload.body) : undefined;
      const hasBody = body != null && body !== '' && method !== 'GET' && method !== 'HEAD';

      log.info(`HTTP ${method} ${url}`);
      const workerRes2 = await fetchInWorker({ url, method, headers, body: hasBody ? body : undefined });
      if (workerRes2) return workerRes2;
      const response = await fetch(url, {
        method,
        headers,
        body: hasBody ? body : undefined,
      });
      const text = await response.text().catch(() => '');
      let result = null;
      try { result = text ? JSON.parse(text) : null; } catch { result = text; }
      log.info(`Response ${response.status} ${response.statusText}`);
      return { success: response.ok, status: response.status, statusText: response.statusText, result };
    } catch (error) {
      log.error('HTTP action fire failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-join-code', async () => {
    try {
      const response = await fetch('http://127.0.0.1:4000/api/auth/join-code');
      if (!response.ok) {
        throw new Error(`Join code request failed: ${response.status}`);
      }
      const payload = await response.json();
      const code = payload?.joinCode || null;
      if (code) {
        cachedJoinCode = code;
      }
      return code ?? cachedJoinCode ?? null;
    } catch (error) {
      log.error('Error retrieving join code:', error);
      return cachedJoinCode || null;
    }
  });

  ipcMain.handle('lyrics:providers:list', async () => {
    try {
      const providersList = await getProviderDefinitions();
      return { success: true, providers: providersList };
    } catch (error) {
      log.error('Failed to list lyrics providers:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('lyrics:providers:key:get', async (_event, { providerId } = {}) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('lyrics:providers:key:get');
    try {
      const key = await getProviderKeyState(providerId);
      return { success: true, key };
    } catch (error) {
      log.error('Failed to read provider key:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('lyrics:providers:key:set', async (_event, { providerId, key } = {}) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('lyrics:providers:key:set');
    try {
      if (!providerId) throw new Error('providerId is required');
      await saveProviderKey(providerId, key);
      return { success: true };
    } catch (error) {
      log.error('Failed to store provider key:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('lyrics:providers:key:delete', async (_event, { providerId } = {}) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('lyrics:providers:key:delete');
    try {
      await removeProviderKey(providerId);
      return { success: true };
    } catch (error) {
      log.error('Failed to delete provider key:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('lyrics:search', async (event, { query, limit, skipCache } = {}) => {
    try {
      const result = await searchAllProviders(query, {
        limit,
        skipCache,
        onPartialResults: (partialPayload) => {
          try {
            event.sender.send('lyrics:search:partial', partialPayload);
          } catch (error) {
            log.warn('Failed to send partial lyrics results:', error);
          }
        }
      });
      return { success: true, ...result };
    } catch (error) {
      log.error('Lyrics search failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('lyrics:fetch', async (_event, { providerId, payload } = {}) => {
    try {
      if (!providerId) throw new Error('providerId is required');
      const lyric = await fetchLyricsByProvider(providerId, payload);
      return { success: true, lyric };
    } catch (error) {
      log.error('Lyrics fetch failed:', error);
      return { success: false, error: error.message };
    }
  });

  // EasyWorship Import handlers
  ipcMain.handle('easyworship:validate-path', async (_event, { path: dbPath }) => {
    try {
      return await easyWorship.validateDatabasePath(dbPath);
    } catch (error) {
      log.error('Error validating EasyWorship path:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('easyworship:browse-path', async () => {
    try {
      const win = getMainWindow?.();
      return await easyWorship.browseForDatabasePath(win);
    } catch (error) {
      log.error('Error browsing for database path:', error);
      return { canceled: true, error: error.message };
    }
  });

  ipcMain.handle('easyworship:browse-destination', async () => {
    try {
      const win = getMainWindow?.();
      return await easyWorship.browseForDestinationPath(win);
    } catch (error) {
      log.error('Error browsing for destination:', error);
      return { canceled: true, error: error.message };
    }
  });

  ipcMain.handle('easyworship:import-song', async (_event, params) => {
    try {
      return await easyWorship.importSong(params);
    } catch (error) {
      log.error('Error importing song:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('easyworship:open-folder', async (_event, { path: folderPath }) => {
    try {
      await easyWorship.openFolder(folderPath);
      return { success: true };
    } catch (error) {
      log.error('Error opening folder:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('easyworship:get-user-home', async () => {
    try {
      const os = await import('os');
      return { success: true, homedir: os.homedir() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Document + legacy presentation importers (feature #06, additive)
  ipcMain.handle('presentation:browse-files', async () => {
    try {
      const win = getMainWindow?.();
      const result = await dialog.showOpenDialog(win || undefined, {
        title: 'Choose document files to import',
        filters: [
          { name: 'Supported documents', extensions: ['docx', 'rtf', 'md', 'markdown', 'txt'] },
          { name: 'Word documents', extensions: ['docx'] },
          { name: 'Rich Text', extensions: ['rtf'] },
          { name: 'Markdown', extensions: ['md', 'markdown'] },
          { name: 'Text Files', extensions: ['txt'] }
        ],
        properties: ['openFile', 'multiSelections']
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }
      return { success: true, files: result.filePaths };
    } catch (error) {
      log.error('Error browsing presentation files:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('presentation:import-file', async (_event, { filePath } = {}) => {
    try {
      return await presentation.importPresentationFile(filePath);
    } catch (error) {
      log.error('Error importing presentation file:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('presentation:browse-ew', async (_event, { version } = {}) => {
    try {
      const win = getMainWindow?.();
      if (String(version) === '2009') {
        const result = await dialog.showOpenDialog(win || undefined, {
          title: 'Select EasyWorship 2009 Songs.DB file',
          filters: [{ name: 'Paradox database', extensions: ['DB', 'db'] }],
          properties: ['openFile']
        });
        if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
          return { success: false, canceled: true };
        }
        return { success: true, path: result.filePaths[0] };
      }
      const result = await dialog.showOpenDialog(win || undefined, {
        title: 'Select EasyWorship 6/7 database folder',
        properties: ['openDirectory']
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }
      return { success: true, path: result.filePaths[0] };
    } catch (error) {
      log.error('Error browsing EasyWorship path:', error);
      return { success: false, canceled: true, error: error.message };
    }
  });

  ipcMain.handle('presentation:import-ew', async (_event, { path: sourcePath, version } = {}) => {
    try {
      if (String(version) === '2009') {
        return await presentation.readEw2009File(sourcePath);
      }
      return await presentation.readEw67Folder(sourcePath);
    } catch (error) {
      log.error('Error importing EasyWorship library:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('presentation:to-text', async (_event, { song } = {}) => {
    try {
      const text = presentation.songToLyricDisplayText(song || {});
      return { success: true, text };
    } catch (error) {
      log.error('Error serializing presentation song:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('setlist:save', async (_event, { setlistData, defaultName }) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('setlist:save');
    try {
      const win = getMainWindow?.();
      const os = await import('os');
      const fs = await import('fs/promises');
      const path = await import('path');

      const userHome = os.homedir();
      const platform = process.platform;
      const separator = platform === 'win32' ? '\\' : '/';
      const defaultPath = defaultSetlistsPath(userHome, separator);

      try {
        await fs.mkdir(defaultPath, { recursive: true });
      } catch (err) {
        log.warn('Could not create setlist directory:', err);
      }

      const result = await dialog.showSaveDialog(win || undefined, {
        title: 'Save Setlist',
        defaultPath: path.join(defaultPath, defaultName || 'Setlist.ldset'),
        filters: [
          { name: 'Selah Setlist', extensions: ['ldset'] }
        ],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      const jsonContent = JSON.stringify(setlistData, null, 2);
      await fs.writeFile(result.filePath, jsonContent, 'utf8');

      log.info('Saved setlist to:', result.filePath);
      return { success: true, filePath: result.filePath };
    } catch (error) {
      log.error('Error saving setlist:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('setlist:load', async () => {
    try {
      const win = getMainWindow?.();
      const os = await import('os');
      const path = await import('path');

      const userHome = os.homedir();
      const platform = process.platform;
      const separator = platform === 'win32' ? '\\' : '/';
      const defaultPath = defaultSetlistsPath(userHome, separator);

      const result = await dialog.showOpenDialog(win || undefined, {
        title: 'Load Setlist',
        defaultPath: defaultPath,
        filters: [
          { name: 'Selah Setlist', extensions: ['ldset'] }
        ],
        properties: ['openFile']
      });

      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const filePath = result.filePaths[0];
      const fs = await import('fs/promises');
      const content = await fs.readFile(filePath, 'utf8');
      const setlistData = JSON.parse(content);

      log.info('Loaded setlist from:', filePath);
      return { success: true, setlistData, filePath };
    } catch (error) {
      log.error('Error loading setlist:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('setlist:load-from-path', async (_event, { filePath }) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('setlist:load-from-path');
    try {
      const fs = await import('fs/promises');
      const content = await fs.readFile(filePath, 'utf8');
      const setlistData = JSON.parse(content);

      log.info('Loaded setlist from path:', filePath);
      return { success: true, setlistData, filePath };
    } catch (error) {
      log.error('Error loading setlist from path:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('setlist:get-user-home', async () => {
    try {
      const os = await import('os');
      return { success: true, homedir: os.homedir() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('setlist:browse-files', async () => {
    try {
      const win = getMainWindow?.();
      const result = await dialog.showOpenDialog(win || undefined, {
        title: 'Add Files to Setlist',
        filters: [
          { name: 'Lyric Files', extensions: ['txt', 'lrc'] }
        ],
        properties: ['openFile', 'multiSelections']
      });

      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const fs = await import('fs/promises');
      const files = await Promise.all(
        result.filePaths.map(async (filePath) => {
          const content = await fs.readFile(filePath, 'utf8');
          const fileName = filePath.split(/[\\/]/).pop();
          const stats = await fs.stat(filePath);
          return {
            name: fileName,
            content,
            lastModified: stats.mtimeMs,
            filePath
          };
        })
      );

      log.info('Browsed and loaded', files.length, 'files');
      return { success: true, files };
    } catch (error) {
      log.error('Error browsing files:', error);
      return { success: false, error: error.message };
    }
  });

  // Output preview window opener
  ipcMain.handle('open-output-window', async (_event, outputNumber) => {
    try {
      const route = outputNumber === 1 ? '/output1' : '/output2';
      const { createWindow } = await import('./windows.js');
      createWindow(route);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Updater controls
  ipcMain.handle('updater:check', async (_event, showNoUpdateDialog = false) => {
    try {
      if (typeof checkForUpdates === 'function') {
        checkForUpdates(showNoUpdateDialog);
        return { success: true };
      }
      return { success: false, error: 'checkForUpdates function not available' };
    } catch (e) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('updater:download', async (_event) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('updater:download');
    try {
      const parent = getMainWindow?.();
      const progress = createProgressWindow({ parent });
      if (progress && !progress.isDestroyed()) {
        if (parent && typeof parent.isMinimized === 'function' && parent.isMinimized()) {
          try { progress.minimize(); } catch { }
        } else {
          try { progress.show(); } catch { }
        }
      }
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (e) { return { success: false, error: e?.message || String(e) }; }
  });
  ipcMain.handle('updater:install', async (_event) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('updater:install');
    try { autoUpdater.quitAndInstall(); return { success: true }; }
    catch (e) { return { success: false, error: e?.message || String(e) }; }
  });

  ipcMain.handle('display:open-settings-modal', async () => {
    try {
      if (typeof requestRendererModal !== 'function') {
        return { success: false, error: 'Modal bridge unavailable' };
      }
      const { showDisplayDetectionModal } = await import('./displayDetection.js');
      const displays = displayManager.getAllDisplays();
      const externalDisplays = displays.filter(d => !d.primary);

      if (!externalDisplays || externalDisplays.length === 0) {
        return { success: false, error: 'No external displays connected' };
      }

      await showDisplayDetectionModal(externalDisplays, false, requestRendererModal, true);
      return { success: true };
    } catch (error) {
      log.error('Error opening display settings modal:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('display:get-all', async () => {
    try {
      const displays = displayManager.getAllDisplays();
      return { success: true, displays };
    } catch (error) {
      log.error('Error getting displays:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('display:get-primary', async () => {
    try {
      const display = displayManager.getPrimaryDisplay();
      return { success: true, display };
    } catch (error) {
      log.error('Error getting primary display:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('display:get-by-id', async (_event, { displayId }) => {
    try {
      const display = displayManager.getDisplayById(displayId);
      if (!display) {
        return { success: false, error: 'Display not found' };
      }
      return { success: true, display };
    } catch (error) {
      log.error('Error getting display by ID:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('display:save-assignment', async (_event, { displayId, outputKey }) => {
    try {
      if (!outputKey) {
        displayManager.removeDisplayAssignment(displayId);
        return { success: true };
      }

      displayManager.saveDisplayAssignment(displayId, outputKey);

      const windows = BrowserWindow.getAllWindows();
      const outputRoute = outputKey === 'stage' ? '/stage' : outputKey === 'output1' ? '/output1' : '/output2';

      for (const win of windows) {
        if (!win || win.isDestroyed()) continue;
        try {
          const url = win.webContents.getURL();
          if (url.includes(outputRoute)) {
            displayManager.moveWindowToDisplay(win, displayId, true);
            break;
          }
        } catch (err) {
          log.warn('Error checking window URL:', err);
        }
      }

      return { success: true };
    } catch (error) {
      log.error('Error saving display assignment:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('display:get-assignment', async (_event, { displayId }) => {
    try {
      const assignment = displayManager.getDisplayAssignment(displayId);
      return { success: true, assignment };
    } catch (error) {
      log.error('Error getting display assignment:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('display:get-all-assignments', async () => {
    try {
      const assignments = displayManager.getAllDisplayAssignments();
      return { success: true, assignments };
    } catch (error) {
      log.error('Error getting all display assignments:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('display:remove-assignment', async (_event, { displayId }) => {
    try {
      displayManager.removeDisplayAssignment(displayId);
      return { success: true };
    } catch (error) {
      log.error('Error removing display assignment:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('display:open-output-on-display', async (_event, { outputKey, displayId }) => {
    try {
      const { createWindow } = await import('./windows.js');
      const route = outputKey === 'stage' ? '/stage' : outputKey === 'output1' ? '/output1' : '/output2';

      const windows = BrowserWindow.getAllWindows();
      let existingWindow = null;

      for (const win of windows) {
        if (!win || win.isDestroyed()) continue;
        try {
          const url = win.webContents.getURL();
          if (url.includes(route)) {
            existingWindow = win;
            break;
          }
        } catch (err) {
          log.warn('Error checking window URL:', err);
        }
      }

      let win;
      if (existingWindow) {

        win = existingWindow;
        log.info('Using existing window for', route);
      } else {

        win = createWindow(route);
        log.info('Created new window for', route);

        await new Promise(resolve => {
          win.webContents.once('did-finish-load', () => {
            setTimeout(resolve, 300);
          });
        });
      }

      if (displayId) {
        displayManager.moveWindowToDisplay(win, displayId, true);
      }

      return { success: true };
    } catch (error) {
      log.error('Error opening output on display:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('display:close-output-window', async (_event, { outputKey }) => {
    try {
      const route = outputKey === 'stage' ? '/stage' : outputKey === 'output1' ? '/output1' : '/output2';
      const windows = BrowserWindow.getAllWindows();

      for (const win of windows) {
        if (!win || win.isDestroyed()) continue;
        try {
          const url = win.webContents.getURL();
          if (url.includes(route)) {
            log.info('Closing output window for', route);
            win.close();
            return { success: true };
          }
        } catch (err) {
          log.warn('Error checking window URL:', err);
        }
      }

      return { success: false, error: 'Window not found' };
    } catch (error) {
      log.error('Error closing output window:', error);
      return { success: false, error: error.message };
    }
  });

  // Setlist export handlers
  ipcMain.handle('setlist:export', async (_event, { setlistData, options }) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('setlist:export');
    try {
      const win = getMainWindow?.();
      const os = await import('os');
      const path = await import('path');

      const { title = 'Setlist', includeLyrics = false, format = 'pdf' } = options || {};

      const userHome = os.homedir();
      const platform = process.platform;
      const separator = platform === 'win32' ? '\\' : '/';
      const defaultPath = defaultSetlistsPath(userHome, separator);

      try {
        const fs = await import('fs/promises');
        await fs.mkdir(defaultPath, { recursive: true });
      } catch (err) {
        log.warn('Could not create setlist directory:', err);
      }

      const extension = format === 'pdf' ? 'pdf' : 'txt';
      const filterName = format === 'pdf' ? 'PDF Document' : 'Text File';
      const defaultFileName = `${title}.${extension}`;

      const result = await dialog.showSaveDialog(win || undefined, {
        title: `Export Setlist as ${format.toUpperCase()}`,
        defaultPath: path.join(defaultPath, defaultFileName),
        filters: [
          { name: filterName, extensions: [extension] }
        ],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      let exportResult;
      if (format === 'pdf') {
        exportResult = await exportSetlistToPDF(result.filePath, setlistData, { title, includeLyrics });
      } else {
        exportResult = await exportSetlistToTXT(result.filePath, setlistData, { title, includeLyrics });
      }

      log.info('Exported setlist to:', result.filePath);
      return exportResult;
    } catch (error) {
      log.error('Error exporting setlist:', error);
      return { success: false, error: error.message };
    }
  });

  // User Templates handlers
  ipcMain.handle('templates:load', async (_event, { type }) => {
    try {
      const templates = await userTemplates.loadUserTemplates(type);
      return { success: true, templates };
    } catch (error) {
      log.error('Error loading templates:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('templates:save', async (_event, { type, template }) => {
    try {
      const result = await userTemplates.saveUserTemplate(type, template);
      return result;
    } catch (error) {
      log.error('Error saving template:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('templates:delete', async (_event, { type, templateId }) => {
    try {
      const result = await userTemplates.deleteUserTemplate(type, templateId);
      return result;
    } catch (error) {
      log.error('Error deleting template:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('templates:update', async (_event, { type, templateId, updates }) => {
    try {
      const result = await userTemplates.updateUserTemplate(type, templateId, updates);
      return result;
    } catch (error) {
      log.error('Error updating template:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('templates:name-exists', async (_event, { type, name, excludeId }) => {
    try {
      const exists = await userTemplates.templateNameExists(type, name, excludeId);
      return { success: true, exists };
    } catch (error) {
      log.error('Error checking template name:', error);
      return { success: false, error: error.message };
    }
  });

  // Bible handlers
  ipcMain.handle('bible:load-file', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: 'Bible Files', extensions: ['xml', 'json'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (result.canceled || !result.filePaths[0]) {
        return { success: false, canceled: true };
      }

      const content = await readFile(result.filePaths[0], 'utf-8');
      const fileName = path.basename(result.filePaths[0]).replace(/\.(xml|json)$/i, '');
      const bible = parseBible(content, fileName);

      return { success: true, bible, fileName: path.basename(result.filePaths[0]) };
    } catch (error) {
      log.error('Error loading Bible file:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('bible:parse-string', async (_event, { content, fileName }) => {
    try {
      const bible = parseBible(content, fileName || 'bible');
      return { success: true, bible };
    } catch (error) {
      log.error('Error parsing Bible string:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('bible:save', async (_event, { id, data }) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('bible:save');
    try {
      const biblesDir = path.join(app.getPath('userData'), 'bibles');
      await mkdir(biblesDir, { recursive: true });

      const filePath = path.join(biblesDir, `${id}.json`);
      await writeFile(filePath, JSON.stringify(data, null, 2));

      return { success: true, path: filePath };
    } catch (error) {
      log.error('Error saving Bible:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('bible:load-all', async () => {
    try {
      const biblesDir = path.join(app.getPath('userData'), 'bibles');
      const files = await readdir(biblesDir).catch(() => []);

      const bibles = {};
      const seenFiles = new Set();
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(biblesDir, file);
          const id = file.replace('.json', '');
          seenFiles.add(filePath);
          try {
            const fileStat = await stat(filePath);
            const cached = bibleParsedCache.get(filePath);
            if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
              bibles[id] = cached.parsed;
              continue;
            }
            const content = await readFile(filePath, 'utf-8');
            const parsed = JSON.parse(content);
            if (!parsed.searchIndex && Array.isArray(parsed.books)) {
              try {
                parsed.searchIndex = buildSearchIndex(parsed);
              } catch (indexError) {
                log.warn('Failed to build search index for Bible file:', file, indexError.message);
              }
            }
            cacheBibleParsed(filePath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, parsed });
            bibles[id] = parsed;
          } catch (e) {
            log.warn('Failed to parse Bible file:', file);
          }
        }
      }

      for (const cachedPath of bibleParsedCache.keys()) {
        if (!seenFiles.has(cachedPath)) {
          bibleParsedCache.delete(cachedPath);
        }
      }

      return { success: true, bibles };
    } catch (error) {
      log.error('Error loading Bibles:', error);
      return { success: false, error: error.message, bibles: {} };
    }
  });

  ipcMain.handle('bible:delete', async (_event, { id }) => {
    if (!isTrustedIpcSender(_event)) return untrustedIpcResponse('bible:delete');
    try {
      const biblesDir = path.join(app.getPath('userData'), 'bibles');
      const filePath = path.join(biblesDir, `${id}.json`);
      await unlink(filePath);
      return { success: true };
    } catch (error) {
      log.error('Error deleting Bible:', error);
      return { success: false, error: error.message };
    }
  });

  // Hot reload â watch the loaded lyrics file and push disk changes to renderers.
  try {
    registerLyricWatcherHandlers(ipcMain);
  } catch (error) {
    log.warn('Lyric file watcher unavailable:', error?.message || error);
  }

}
