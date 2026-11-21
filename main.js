import { app, BrowserWindow, dialog, Menu, session } from 'electron';
import path from 'node:path';
// First import: pin/migrate the user-data directory before any module reads it.
import './main/userDataPin.js';
import { initModalBridge, requestRendererModal } from './main/modalBridge.js';
import { decidePermission, resolveControlWindowMatch } from './main/permissionPolicy.js';
import { isDev, resolveProductionPath } from './main/paths.js';
import { createWindow } from './main/windows.js';
import { checkForUpdates } from './main/updater.js';
import { registerIpcHandlers } from './main/ipc.js';
import { openInAppBrowser, registerInAppBrowserIpc } from './main/inAppBrowser.js';
import { makeMenuAPI } from './main/menuBridge.js';
import { setupSingleInstanceLock } from './main/singleInstance.js';
import { handleFileOpen, extractFilePathFromArgs, setPendingFile } from './main/fileHandler.js';
import { handleDisplayChange } from './main/displayDetection.js';
import { performStartupSequence } from './main/startup.js';
import { performCleanup } from './main/cleanup.js';
import { createLoadingWindow } from './main/loadingWindow.js';
import createMainLogger from './main/logger.js';
import { registerSpeechIpc } from './main/speechIpc.js';
import { registerDiagnosticsIpc, diagMain } from './main/diagnosticsLog.js';

// Main-process safety net: anything that escapes every handler still lands in
// the diagnostics journal (message + stack head, never payload data) so Copy
// logs can explain a main-process fault. Logging here must never throw, and
// the process keeps its default crash semantics otherwise.
process.on('uncaughtException', (error) => {
  try {
    diagMain('error', 'main', 'uncaught exception', {
      error: error?.message || String(error),
      stack: error?.stack ? String(error.stack).split('\n').slice(0, 8).join('\n') : null,
    });
  } catch {
    // The safety net must never become the crash.
  }
});
process.on('unhandledRejection', (reason) => {
  try {
    diagMain('error', 'main', 'unhandled rejection', {
      error: reason instanceof Error ? reason.message : String(reason ?? '[empty]'),
    });
  } catch {
    // The safety net must never become the crash.
  }
});

import Store from 'electron-store';

const log = createMainLogger('Main');

const preferences = new Store({
  name: 'preferences',
  defaults: {
    disableHardwareAcceleration: false
  }
});

if (preferences.get('disableHardwareAcceleration')) {
  app.disableHardwareAcceleration();
}

if (!isDev && process.env.FORCE_COMPATIBILITY) {
  app.commandLine.appendSwitch('--disable-gpu-sandbox');
  app.commandLine.appendSwitch('--disable-software-rasterizer');
  app.commandLine.appendSwitch('--disable-features', 'VizDisplayCompositor');
}

let mainWindow = null;

// Live Sermon Assist (Phase 2): the speech IPC surface + engine supervisor.
// Registration only discovers the engine (a filesystem look-up); nothing is
// forked or polled until the renderer asks, or LD_SPEECH_ENABLED=1 opts in
// at boot. Off by default either way (plan section 5, invariant 4).
let speechIpc = null;

const hasLock = setupSingleInstanceLock((commandLine) => {

  if (commandLine.length >= 2) {
    const filePath = extractFilePathFromArgs(commandLine);
    if (filePath) {
      log.info('Second instance opened with file:', filePath);
      if (mainWindow && !mainWindow.isDestroyed()) {
        handleFileOpen(filePath, mainWindow);
      }
    }
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

if (!hasLock) {
  process.exit(0);
}

if (process.platform === 'win32' && process.argv.length >= 2) {
  const filePath = extractFilePathFromArgs(process.argv);
  if (filePath) {
    setPendingFile(filePath);
    log.info('App launched with file (Windows):', filePath);
  }
}

const getMainWindow = () => mainWindow;
initModalBridge(getMainWindow);

// --- Session permission handlers (Live Sermon Assist, Phase 1 blocker #1) ---
// Under contextIsolation a renderer's getUserMedia() is refused until a
// permission handler exists, so these must be installed before ANY window is
// created. Pure decision logic lives in main/permissionPolicy.js so it can be
// unit-tested without booting Electron.
//
// Control-window predicate: a requester is the control window only when its
// webContents id matches the current main window's live webContents id.
// getMainWindow() tracks the control window across startup assignment,
// 'activate' recreation and 'closed' null-ing, so this stays correct for a
// window created later, a destroyed control window, and any output/stage/
// loading/dock window that is not the main window.
const isControlWindowWebContents = (webContents) => {
  try {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return false;
    const controlContents = win.webContents;
    if (!controlContents || controlContents.isDestroyed()) return false;
    return resolveControlWindowMatch({
      requestWebContentsId: webContents && !webContents.isDestroyed() ? webContents.id : null,
      controlWebContentsId: controlContents.id,
      controlWindowAvailable: true
    });
  } catch (error) {
    log.warn('Failed to resolve control window for permission check:', error?.message || error);
    return false;
  }
};

const describePermissionDecision = (kind, permission, decision, origin) => {
  if (decision.allowed) {
    log.debug(`Permission ${kind} allowed (${permission}): ${decision.reason}`);
    return;
  }
  // Denials are always logged at info: silent denial is indistinguishable
  // from a broken feature when someone later wires up a new permission.
  log.info(`Permission ${kind} denied (${permission}): ${decision.reason}${origin ? ` origin=${origin}` : ''}`);
};

const installPermissionHandlers = () => {
  try {
    const defaultSession = session.defaultSession;

    defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      let allowed = false;
      try {
        const decision = decidePermission({
          permissionName: permission,
          isControlWindow: isControlWindowWebContents(webContents),
          isQuitting: !!app.isQuitting
        });
        allowed = decision.allowed;
        describePermissionDecision('request', permission, decision, details?.requestingUrl);
      } catch (error) {
        log.error('Permission request handler failed; denying:', permission, error);
        allowed = false;
      }
      callback(allowed);
    });

    defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
      try {
        const decision = decidePermission({
          permissionName: permission,
          isControlWindow: isControlWindowWebContents(webContents),
          isQuitting: !!app.isQuitting
        });
        describePermissionDecision('check', permission, decision, requestingOrigin);
        return decision.allowed;
      } catch (error) {
        log.error('Permission check handler failed; denying:', permission, error);
        return false;
      }
    });

    log.info('Session permission handlers installed (media scoped to control window only)');
  } catch (error) {
    log.error('Failed to install session permission handlers:', error);
  }
};

const menuAPI = makeMenuAPI({
  getMainWindow,
  createWindow: (route) => {
    const win = createWindow(route);
    if (route === '/') mainWindow = win;
    return win;
  },
  checkForUpdates,
  showInAppModal: requestRendererModal,
});

registerIpcHandlers({
  getMainWindow,
  openInAppBrowser,
  updateDarkModeMenu: menuAPI.updateDarkModeMenu,
  updateUndoRedoState: menuAPI.updateUndoRedoState,
  checkForUpdates,
  requestRendererModal
});
registerInAppBrowserIpc();

import('./main/ipcFileNavigator.js')
  .then(({ registerFileNavigatorIpc }) => {
    registerFileNavigatorIpc({ getMainWindow });
  })
  .catch((error) => {
    log.warn('File navigator unavailable:', error?.message || error);
  });

// Sunday service verse log: read + reveal for the desktop app. The server
// is the writer; this only opens what the server already recorded.
import('./main/serviceVerseLogIpc.js')
  .then(({ registerServiceVerseLogIpc }) => {
    registerServiceVerseLogIpc();
  })
  .catch((error) => {
    log.warn('Service verse log unavailable:', error?.message || error);
  });

// Hardware MIDI + OSC automation. Optional drivers only: a missing native
// module, busy ports, or absent hardware must never prevent boot — the
// controllers report a clean disabled state with a settings note instead.
import('./main/hardwareControl.js')
  .then(({ initHardwareControl }) => {
    initHardwareControl({ getMainWindow });
  })
  .catch((error) => {
    log.warn('Hardware control unavailable:', error?.message || error);
  });

// NDI video-over-IP output (feature #11). Disabled-safe by construction: a
// missing NDI runtime only ever surfaces as an honest per-output `error`
// snapshot — boot and build are identical with or without NDI installed.
import('./main/ndi/index.js')
  .then(({ initNdiOutput }) => {
    initNdiOutput({ getMainWindow });
  })
  .catch((error) => {
    log.warn('NDI output unavailable:', error?.message || error);
  });

app.whenReady().then(async () => {
  try { Menu.setApplicationMenu(null); } catch { }
  // Before the loading window (and every later window) exists: without
  // these handlers renderer getUserMedia() is refused outright.
  installPermissionHandlers();

  // Live Sermon Assist (Phase 2): register the speech:* IPC surface before
  // any window loads, so the renderer can ask for engine state at mount.
  // Registration performs filesystem discovery ONLY — no fork, no socket,
  // no poll. Nothing starts until speech:start arrives (or the explicit
  // LD_SPEECH_ENABLED=1 boot opt-in below).
  try {
    registerDiagnosticsIpc();
  } catch (error) {
    log.warn('Diagnostics IPC unavailable:', error?.message || error);
  }
  try {
    speechIpc = registerSpeechIpc({
      getMainWindow,
      engineRoots: [
        // In development this is <repo>/speech-engine. In a packaged build the
        // engine MUST be resolved through resolveProductionPath(), because the
        // supervisor FORKS this entry: `fork()` launches a plain Node process
        // that has no asar support, so a path inside app.asar exists to
        // Electron's patched fs but is unreadable to the child. The engine is
        // asar-unpacked for exactly this reason, and this is the path that
        // points at the real files.
        resolveProductionPath('speech-engine'),
        path.join(app.getPath('userData'), 'speech-engine'),
      ],
      endpoint: process.env.LD_SPEECH_ENGINE_ENDPOINT || null,
      engineToken: process.env.LD_SPEECH_ENGINE_TOKEN || null,
    });
  } catch (error) {
    log.warn('Speech IPC unavailable:', error?.message || error);
  }

  createLoadingWindow();

  mainWindow = await performStartupSequence({
    menuAPI,
    requestRendererModal,
    handleDisplayChange: (changeType, display) =>
      handleDisplayChange(changeType, display, requestRendererModal)
  });

  // Boot-time engine start: opt-in via LD_SPEECH_ENABLED=1, nothing otherwise.
  // The renderer's own speech:start is the normal path; this exists so a
  // kiosk/service install can come up already listening.
  if (speechIpc && process.env.LD_SPEECH_ENABLED === '1') {
    speechIpc.start({ enabled: true, where: 'local' }).catch((error) => {
      log.warn('Boot speech engine start failed:', error?.message || error);
    });
  }

  if (mainWindow) {
    let isShowingCloseConfirmation = false;

    mainWindow.on('close', async (event) => {

      if (app.isQuitting) {
        return;
      }

      if (isShowingCloseConfirmation) {
        event.preventDefault();
        return;
      }

      event.preventDefault();
      isShowingCloseConfirmation = true;

      try {
        const choice = await requestRendererModal(
          {
            variant: 'warning',
            title: 'Confirm Close',
            size: 'sm',
            actions: [
              { label: 'Cancel', value: 0, variant: 'outline', autoFocus: true },
              { label: 'Close', value: 1, variant: 'destructive' }
            ],
            body: 'Are you sure you want to close Selah? This will discard any ongoing lyric operations or unsaved changes.',
            dismissible: true,
            allowBackdropClose: false
          },
          {
            fallback: async () => {
              const fallbackChoice = await dialog.showMessageBox(mainWindow, {
                type: 'question',
                buttons: ['Cancel', 'Close'],
                defaultId: 0,
                cancelId: 0,
                title: 'Confirm Close',
                message: 'Are you sure you want to close Selah?',
                detail: 'We just want to be sure you mean this, as closing the app will discard any ongoing lyric operations or unsaved changes.'
              });
              return fallbackChoice;
            }
          }
        );

        if (choice.response === 1) {
          app.isQuitting = true;

          try {
            const windows = BrowserWindow.getAllWindows();

            windows.forEach(win => {
              if (!win || win.isDestroyed() || win.id === mainWindow.id) return;

              try {
                log.info('Closing window:', win.getTitle());
                win.destroy();
              } catch (err) {
                log.warn('Error closing window:', err);
              }
            });
          } catch (error) {
            log.error('Error closing windows:', error);
          }

          mainWindow.destroy();
        } else {
          isShowingCloseConfirmation = false;
        }
      } catch (error) {
        log.error('Error showing close confirmation:', error);
        isShowingCloseConfirmation = false;
      }
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow('/');
    }
  });
});

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  log.info('macOS open-file event:', filePath);

  if (mainWindow && !mainWindow.isDestroyed()) {
    handleFileOpen(filePath, mainWindow);
  } else {
    setPendingFile(filePath);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    performCleanup();
    app.quit();
  }
});

app.on('before-quit', (event) => {
  app.isQuitting = true;
  performCleanup();
  // Live Sermon Assist: SIGTERM the engine (SIGKILL escalated by the
  // supervisor) before the process goes away. No-op when nothing is running.
  try {
    speechIpc?.stop('quit');
  } catch (error) {
    log.warn('Failed to stop speech engine on quit:', error?.message || error);
  }
});

app.on('will-quit', () => {
  performCleanup();
});