import { BrowserWindow, shell } from 'electron';
import path from 'path';
import { isDev, resolveProductionPath, appRoot } from './paths.js';
import createMainLogger from './logger.js';

const log = createMainLogger('Windows');

function attachWindowStateEvents(win) {
  const sendState = () => {
    try {
      if (win && !win.isDestroyed()) {
        win.webContents.send('window-state', {
          isMaximized: win.isMaximized(),
          isFullScreen: win.isFullScreen(),
          isFocused: win.isFocused()
        });
      }
    } catch { }
  };

  ['ready-to-show', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur', 'resized'].forEach(evt => {
    win.on(evt, sendState);
  });

  sendState();
}

export function createWindow(route = '/', options = {}) {
  const isObsDockWindow = route.startsWith('/obs-dock');
  const isControlWindow = route === '/' || route.startsWith('/new-song') || isObsDockWindow;
  const isOutputWindow = route.startsWith('/output') || route === '/stage';
  
  // For output/stage windows, use transparent background by default
  // This allows the frontend to control transparency via CSS
  const shouldTransparent = options.transparent !== undefined ? options.transparent : isOutputWindow;
  const defaultBackground = shouldTransparent ? '#00000000' : (isDev ? '#ffffff' : '#f9fafb');
  
  // When transparent, we need frameless window to avoid artifacts
  const shouldFrame = isControlWindow ? false : (shouldTransparent ? false : true);

  const win = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 1000,
    minHeight: 650,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: resolveProductionPath('preload.js')
    },
    show: false,
    icon: path.join(appRoot, 'public', 'favicon.ico'),
    frame: shouldFrame,
    transparent: shouldTransparent,
    backgroundColor: defaultBackground,
    titleBarStyle: isControlWindow && process.platform === 'darwin' ? 'hiddenInset' : 'default',
    thickFrame: shouldFrame, // Only use thickFrame when frame is true
    autoHideMenuBar: true,
  });
  win.isOutputWindow = isOutputWindow;

  if (isControlWindow) {
    attachWindowStateEvents(win);
  }

  win.once('ready-to-show', () => {
    setTimeout(() => {
      try { win.show(); } catch { }
    }, 100);
  });

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levels = ['verbose', 'info', 'warning', 'error'];
    const label = levels[level] || String(level);
    console.log(`[Renderer:${label}] ${message}${sourceId ? ` (${sourceId}:${line})` : ''}`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Renderer] render process gone:', details);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    try { shell.openExternal(url); } catch (e) { log.error('Failed to open external URL:', url, e); }
    return { action: 'deny' };
  });

  // Honor PORT so custom-port boots (dogfood, side-by-side instances) load
  // their own backend instead of whatever holds 4000.
  const backendPort = process.env.PORT || 4000;
  const backendBase = `http://127.0.0.1:${backendPort}`;
  if (isDev) {
    const devUrl = `http://localhost:5174${route}`;
    // When launched as a built app (`npm run build` + `npm run electron`) the
    // Vite dev server on 5174 is not running. The backend process already
    // serves the built bundle from dist/, so fall back to it instead of
    // leaving a blank window.
    win.webContents.once('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      if (!validatedURL.startsWith('http://localhost:5174')) {
        return;
      }
      log.warn(`Dev server unreachable (${errorDescription}); falling back to backend UI on ${backendBase}`);
      const hashRoute = route === '/' ? '/' : `#${route}`;
      try { win.loadURL(`${backendBase}${hashRoute}`); } catch (err) {
        log.error('Fallback load failed:', err);
      }
    });
    win.loadURL(devUrl);
  } else {
    const hashRoute = route === '/' ? '/' : `#${route}`;
    const baseUrl = backendBase;
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      log.error('Failed to load:', errorCode, errorDescription, validatedURL);
      setTimeout(() => {
        log.info('Retrying load...');
        try { win.loadURL(`${baseUrl}${hashRoute}`); } catch { }
      }, 1000);
    });
    win.loadURL(`${baseUrl}${hashRoute}`);
  }

  return win;
}