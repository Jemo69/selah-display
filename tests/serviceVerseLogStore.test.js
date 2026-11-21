// Server store tests: run against throwaway temp directories — never the
// real userData, never the repo checkout.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  initServiceVerseLog,
  getServiceLogDir,
  logServiceVerse,
  readServiceDayLog,
  todayServiceLog,
  __resetServiceVerseLogForTests,
} from '../server/serviceVerseLog.js';
import { serviceDayStamp } from '../shared/serviceVerseLog.js';

let dir = null;

beforeEach(async () => {
  __resetServiceVerseLogForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-verse-log-'));
  await initServiceVerseLog({ dataRoot: dir });
});

afterEach(async () => {
  __resetServiceVerseLogForTests();
  if (dir) await fsp.rm(dir, { recursive: true, force: true });
  dir = null;
});

describe('service verse log store', () => {
  it('initializes under <dataRoot>/service-logs', () => {
    expect(getServiceLogDir()).toBe(path.join(dir, 'service-logs'));
  });

  it('appends each displayed verse to that Sunday’s file', async () => {
    const at = new Date(2026, 10, 22, 9, 42, 15);
    const result = await logServiceVerse({ reference: 'John 3:16', bible: 'KJV', at });
    expect(result.ok).toBe(true);
    expect(result.fileName).toBe('service-2026-11-22.txt');
    const content = await fsp.readFile(result.file, 'utf8');
    expect(content).toBe('[09:42:15] John 3:16 (KJV)\n');
  });

  it('skips consecutive re-sends of the same reference (slide navigation)', async () => {
    const at = new Date(2026, 10, 22, 9, 42, 15);
    await logServiceVerse({ reference: 'John 3:16', bible: 'KJV', at });
    const second = await logServiceVerse({ reference: '  John 3:16 ', bible: 'KJV', at });
    expect(second).toMatchObject({ ok: true, stored: false });
    const content = await fsp.readFile(path.join(getServiceLogDir(), 'service-2026-11-22.txt'), 'utf8');
    expect(content.split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('logs a re-send after other verses (displayed again)', async () => {
    const at = new Date(2026, 10, 22, 9, 42, 15);
    await logServiceVerse({ reference: 'John 3:16', bible: 'KJV', at });
    await logServiceVerse({ reference: 'Psalm 23:1', bible: 'KJV', at });
    await logServiceVerse({ reference: 'John 3:16', bible: 'KJV', at });
    const content = await fsp.readFile(path.join(getServiceLogDir(), 'service-2026-11-22.txt'), 'utf8');
    expect(content.split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('ignores empty references', async () => {
    expect(await logServiceVerse({ reference: '   ' })).toMatchObject({ ok: false });
    expect(await logServiceVerse({})).toMatchObject({ ok: false });
  });

  it('refuses to write before init instead of throwing', async () => {
    __resetServiceVerseLogForTests();
    expect(await logServiceVerse({ reference: 'John 3:16' })).toMatchObject({ ok: false, code: 'not-initialized' });
  });

  it('reads a service day back with lines and a count', async () => {
    const at = new Date(2026, 10, 22, 9, 42, 15);
    await logServiceVerse({ reference: 'John 3:16', bible: 'KJV', at });
    await logServiceVerse({ reference: 'Psalm 23:1', bible: '', at });
    const snapshot = await readServiceDayLog('2026-11-22');
    expect(snapshot.ok).toBe(true);
    expect(snapshot.exists).toBe(true);
    expect(snapshot.verseCount).toBe(2);
    expect(snapshot.lines).toEqual(['[09:42:15] John 3:16 (KJV)', '[09:42:15] Psalm 23:1']);
  });

  it('reads a missing day as empty, not an error', async () => {
    const snapshot = await readServiceDayLog('2026-11-29');
    expect(snapshot.ok).toBe(true);
    expect(snapshot.exists).toBe(false);
    expect(snapshot.lines).toEqual([]);
  });

  it('rejects malformed day stamps', async () => {
    expect(await readServiceDayLog('../../etc')).toMatchObject({ ok: false });
  });

  it('serves today’s file', async () => {
    await logServiceVerse({ reference: 'Genesis 1:1', bible: 'KJV' });
    const today = await todayServiceLog();
    expect(today.ok).toBe(true);
    expect(today.date).toBe(serviceDayStamp(new Date()));
    expect(today.verseCount).toBe(1);
  });
});
