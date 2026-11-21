// Route-level proof for GET /service-log/today: failures are real HTTP
// errors (never 200-with-success), and success payloads carry no internal
// `ok` flag. Runs against throwaway temp directories via SELAH_DATA_DIR.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import router from '../server/api.js';
import {
  initServiceVerseLog,
  logServiceVerse,
  __resetServiceVerseLogForTests,
} from '../server/serviceVerseLog.js';

function callRoute(url) {
  return new Promise((resolve, reject) => {
    const req = { method: 'GET', url, headers: {} };
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        resolve(this);
      },
    };
    router.handle(req, res, (err) => (err ? reject(err) : resolve(res)));
  });
}

let dir = null;

beforeEach(async () => {
  __resetServiceVerseLogForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-verse-log-route-'));
});

afterEach(async () => {
  __resetServiceVerseLogForTests();
  if (dir) await fsp.rm(dir, { recursive: true, force: true });
  dir = null;
});

describe('GET /service-log/today', () => {
  it('returns 503 — not 200-with-success — before initialization', async () => {
    const res = await callRoute('/service-log/today');
    expect(res.statusCode).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('not-initialized');
    expect(typeof res.body.error).toBe('string');
  });

  it('serves today’s file without leaking the internal ok flag', async () => {
    await initServiceVerseLog({ dataRoot: dir });
    await logServiceVerse({ reference: 'John 3:16', bible: 'KJV' });
    const res = await callRoute('/service-log/today');
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.verseCount).toBe(1);
    expect(res.body.lines).toEqual([expect.stringContaining('John 3:16 (KJV)')]);
    expect('ok' in res.body).toBe(false);
    expect(typeof res.body.timestamp).toBe('number');
  });
});
