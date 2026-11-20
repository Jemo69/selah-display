/**
 * speech-engine/test/whisperServer.test.js — the persistent driver's pure edge.
 *
 * The real `/inference` path is exercised by the live smoke test with the
 * downloaded server. This suite pins the parts that must fail safely without a
 * binary: name resolution, presence checks, and answer parsing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  serverBinaryName,
  hasServerBinary,
  parseServerAnswer,
  framesAreSilent,
  createWhisperServerEngine,
} from '../drivers/whisperServer.js';

test('serverBinaryName is per-platform', () => {
  assert.equal(serverBinaryName('linux'), 'whisper-server');
  assert.equal(serverBinaryName('darwin'), 'whisper-server');
  assert.equal(serverBinaryName('win32'), 'whisper-server.exe');
});

test('hasServerBinary rejects missing, empty, and unreadable paths', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ld-server-'));
  try {
    assert.equal(hasServerBinary(dir), false, 'missing');
    const full = path.join(dir, serverBinaryName());
    writeFileSync(full, '');
    assert.equal(hasServerBinary(dir), false, 'zero bytes is a failed install');
    writeFileSync(full, '#!/bin/sh\nexit 0\n');
    chmodSync(full, 0o755);
    assert.equal(hasServerBinary(dir), true, 'non-empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseServerAnswer accepts the server JSON and strips non-speech markers', () => {
  assert.equal(parseServerAnswer('{"text":"  amen  "}'), 'amen');
  assert.equal(parseServerAnswer('{"text":"[BLANK_AUDIO]"}'), null);
  assert.equal(parseServerAnswer('{"text":"[BLANK_AUDIO] amen"}'), 'amen');
  assert.equal(parseServerAnswer('{"text":"one\\ntwo"}'), 'one two');
  assert.equal(parseServerAnswer('not json'), null);
  assert.equal(parseServerAnswer('{"text":""}'), null);
});

test('framesAreSilent rejects silence and accepts quiet speech', () => {
  assert.equal(framesAreSilent([Buffer.alloc(3200)]), true);
  const speech = Buffer.alloc(3200);
  for (let i = 0; i + 1 < speech.length; i += 2) speech.writeInt16LE(i % 4 === 0 ? 1200 : -1200, i);
  assert.equal(framesAreSilent([speech]), false);
});

test('the server engine refuses to construct without its binary', () => {
  assert.throws(
    () => createWhisperServerEngine({ binDir: '/definitely/missing', modelsDir: '/missing' }),
    (error) => error?.code === 'unavailable'
  );
});
