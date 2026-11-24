/**
 * NDI output manager (main process).
 *
 * Owns one sender per output, persists the per-output NDI toggle with
 * electron-store (`preferences.ndi`, default OFF everywhere), and
 * broadcasts a real-transport heartbeat to every renderer window every 2s:
 *
 *   channel `ndi:status` -> { at, outputs: { [outputKey]: snapshot } }
 *
 * Renderer IPC:
 *   invoke `ndi:get-status`                              -> { success, at, runtime, loopback, outputs }
 *   invoke `ndi:set-enabled` { outputKey, enabled, sourceName? }
 *                                                        -> { success, snapshot } | { success:false, error }
 *
 * Disabled-safe by construction: this module is loaded via dynamic import
 * from main.js, every public path is wrapped so it can never throw across
 * the IPC boundary, and a missing NDI runtime only ever surfaces as an
 * honest `error` snapshot on the toggled output — boot and build are
 * identical with or without any NDI software installed.
 */

import { BrowserWindow, ipcMain, app } from 'electron';
import Store from 'electron-store';
import createMainLogger from '../logger.js';
import { createNdiSender } from './sender.js';
import { detectNdiRuntime, isLoopbackAllowed, sanitizeSourceName, runtimeSummary } from './runtime.js';

const log = createMainLogger('NDI');

export const NDI_STATUS_CHANNEL = 'ndi:status';
export const HEARTBEAT_MS = 2000;

// Mirrors the output-key guard in src/context/LyricsStore.js
// updateOutputSettings: built-ins plus custom_* ids.
const OUTPUT_KEY_PATTERN = /^(output1|output2|stream|stage|custom_[A-Za-z0-9_-]+)$/;

const preferences = new Store({
  name: 'preferences',
  defaults: {
    ndi: {
      enabledByOutput: {},
      sourceNameByOutput: {},
    },
  },
});

export function isValidNdiOutputKey(outputKey) {
  return OUTPUT_KEY_PATTERN.test(String(outputKey || ''));
}

function readPrefs() {
  try {
    const raw = preferences.get('ndi');
    return {
      enabledByOutput: raw?.enabledByOutput && typeof raw.enabledByOutput === 'object' ? raw.enabledByOutput : {},
      sourceNameByOutput: raw?.sourceNameByOutput && typeof raw.sourceNameByOutput === 'object' ? raw.sourceNameByOutput : {},
    };
  } catch (error) {
    log.warn('NDI prefs unreadable, using defaults (non-fatal):', error?.message || error);
    return { enabledByOutput: {}, sourceNameByOutput: {} };
  }
}

function writePrefs(prefs) {
  try {
    preferences.set('ndi', prefs);
  } catch (error) {
    log.warn('NDI prefs write failed (non-fatal):', error?.message || error);
  }
}

function broadcast(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.webContents.send(NDI_STATUS_CHANNEL, payload);
    } catch (error) {
      log.warn('NDI heartbeat send failed (non-fatal):', error?.message || error);
    }
  }
}

export function initNdiOutput({ getMainWindow } = {}) {
  void getMainWindow;
  const senders = new Map();
  let heartbeatTimer = null;
  let disposed = false;

  const runtimeNow = () => {
    try {
      return detectNdiRuntime();
    } catch (error) {
      log.warn('NDI runtime probe failed (non-fatal):', error?.message || error);
      return { available: false, kind: 'none' };
    }
  };

  function getSender(outputKey, sourceName) {
    let sender = senders.get(outputKey);
    if (!sender) {
      sender = createNdiSender({
        outputKey,
        sourceName: sourceName || `Selah ${outputKey}`,
        deps: {
          detectRuntime: runtimeNow,
          isLoopback: () => isLoopbackAllowed(),
        },
      });
      senders.set(outputKey, sender);
    }
    if (sourceName) {
      try {
        sender.setSourceName(sourceName);
      } catch {
        // best-effort.
      }
    }
    return sender;
  }

  function collectOutputs() {
    const outputs = {};
    for (const [key, sender] of senders) {
      try {
        outputs[key] = sender.tick();
      } catch (error) {
        log.warn(`NDI ${key}: heartbeat tick failed (non-fatal):`, error?.message || error);
        try {
          outputs[key] = sender.getSnapshot();
        } catch {
          // Never let one sender break the heartbeat.
        }
      }
    }
    return outputs;
  }

  function heartbeat() {
    if (disposed) return;
    broadcast({ at: Date.now(), outputs: collectOutputs() });
  }

  async function setEnabled({ outputKey, enabled, sourceName }) {
    if (!isValidNdiOutputKey(outputKey)) {
      return { success: false, error: 'Unknown output. NDI output was not changed.' };
    }
    const cleanName = sourceName ? sanitizeSourceName(sourceName, `Selah ${outputKey}`) : undefined;
    const prefs = readPrefs();
    prefs.enabledByOutput[outputKey] = Boolean(enabled);
    if (cleanName) prefs.sourceNameByOutput[outputKey] = cleanName;
    writePrefs(prefs);

    try {
      const sender = getSender(outputKey, cleanName || prefs.sourceNameByOutput[outputKey]);
      const snapshot = enabled ? await sender.enable({ sourceName: cleanName }) : sender.disable();
      // Push an immediate update so the settings UI never waits a full
      // heartbeat interval to reflect the toggle.
      broadcast({ at: Date.now(), outputs: collectOutputs() });
      return { success: true, snapshot };
    } catch (error) {
      log.error(`NDI ${outputKey}: set-enabled failed:`, error);
      return { success: false, error: error?.message || 'NDI output could not be changed.' };
    }
  }

  function getStatus() {
    try {
      const detected = runtimeNow();
      return {
        success: true,
        at: Date.now(),
        runtime: runtimeSummary(detected),
        runtimeHint: detected.hint || null,
        loopback: isLoopbackAllowed(),
        outputs: collectOutputs(),
      };
    } catch (error) {
      log.warn('NDI get-status failed (non-fatal):', error?.message || error);
      return { success: false, error: error?.message || 'NDI status unavailable.' };
    }
  }

  try {
    ipcMain.handle('ndi:get-status', () => getStatus());
  } catch (error) {
    log.warn('NDI IPC registration failed (non-fatal):', error?.message || error);
  }
  try {
    ipcMain.handle('ndi:set-enabled', (_event, payload) => setEnabled(payload || {}));
  } catch (error) {
    log.warn('NDI IPC registration failed (non-fatal):', error?.message || error);
  }

  // Restore previously enabled outputs (default: everything off). Outputs
  // whose runtime is gone land in an honest `error` snapshot — never a boot
  // failure.
  try {
    const prefs = readPrefs();
    for (const [outputKey, wasEnabled] of Object.entries(prefs.enabledByOutput || {})) {
      if (!wasEnabled || !isValidNdiOutputKey(outputKey)) continue;
      const sender = getSender(outputKey, prefs.sourceNameByOutput?.[outputKey]);
      sender.enable().catch((error) => {
        log.warn(`NDI ${outputKey}: restore-enable failed (non-fatal):`, error?.message || error);
      });
    }
  } catch (error) {
    log.warn('NDI restore failed (non-fatal):', error?.message || error);
  }

  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
  try {
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  } catch {
    // unref is best-effort; quitting is handled below regardless.
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    } catch {
      // ignore
    }
    heartbeatTimer = null;
    for (const sender of senders.values()) {
      try {
        sender.dispose();
      } catch {
        // ignore
      }
    }
    senders.clear();
  }

  try {
    app.once('before-quit', dispose);
  } catch {
    // Non-electron test hosts have no app lifecycle; dispose() stays manual.
  }

  log.info(`NDI manager up (heartbeat ${HEARTBEAT_MS}ms, runtime available: ${runtimeNow().available}, loopback: ${isLoopbackAllowed()})`);
  return { setEnabled, getStatus, dispose };
}
