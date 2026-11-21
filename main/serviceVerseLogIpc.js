// Sunday service verse log — Electron side (read + reveal).
//
// The server (server/serviceVerseLog.js) is the writer: every displayed
// verse is appended there so all senders (desktop, web, mobile, API) are
// covered. This module is the reader for the desktop app: it resolves the
// same `<userData>/backend/service-logs/service-YYYY-MM-DD.txt` path the
// server writes (main/backend.js sets SELAH_DATA_DIR to
// `<userData>/backend`) and exposes two IPC channels:
//
//   `service-log:today`        today's file (name, count, lines)
//   `service-log:reveal-today` show today's file in the OS file manager
import { app, ipcMain, shell } from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { SERVICE_LOG_DIR, serviceDayStamp, serviceLogFileName } from '../shared/serviceVerseLog.js';
import createMainLogger from './logger.js';

const log = createMainLogger('ServiceVerseLog');

function resolveServiceLogDir() {
  return path.join(app.getPath('userData'), 'backend', SERVICE_LOG_DIR);
}

function resolveTodayServiceFile(date = new Date()) {
  const dir = resolveServiceLogDir();
  const fileName = serviceLogFileName(date);
  return { dir, fileName, file: path.join(dir, fileName), date: serviceDayStamp(date) };
}

async function readTodayServiceFile() {
  const { dir, fileName, file, date } = resolveTodayServiceFile();
  let content = null;
  try {
    content = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { success: true, exists: false, dir, file, fileName, date, verseCount: 0, lines: [] };
    }
    throw error;
  }
  const lines = String(content ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return { success: true, exists: true, dir, file, fileName, date, verseCount: lines.length, lines };
}

export function registerServiceVerseLogIpc() {
  ipcMain.handle('service-log:today', async () => {
    try {
      return await readTodayServiceFile();
    } catch (error) {
      log.warn('Could not read today’s service verse log:', error?.message || error);
      return { success: false, error: 'Could not read today’s service verse log' };
    }
  });

  ipcMain.handle('service-log:reveal-today', async () => {
    try {
      const { dir, file } = resolveTodayServiceFile();
      await fsp.mkdir(dir, { recursive: true });
      let exists = false;
      try {
        await fsp.access(file);
        exists = true;
      } catch {
        exists = false;
      }
      if (exists) {
        shell.showItemInFolder(file);
      } else {
        // Nothing logged yet today — open the folder the file will land in.
        await shell.openPath(dir);
      }
      return { success: true };
    } catch (error) {
      log.warn('Could not reveal the service verse log:', error?.message || error);
      return { success: false, error: 'Could not open the service log folder' };
    }
  });
}
