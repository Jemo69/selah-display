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

import { framesToWav } from '../drivers/whispercpp.js';
import {
  serverBinaryName,
  hasServerBinary,
  parseServerAnswer,
  framesAreSilent,
  wavIsSilent,
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
  assert.equal(wavIsSilent(framesToWav([speech])), false);
  assert.equal(wavIsSilent(framesToWav([Buffer.alloc(3200)])), true);
});

test('a spawn error is reported as a segment error, never an uncaught crash', async () => {
  if (process.platform === 'win32') return; // exec-bit model is POSIX-specific
  const base = mkdtempSync(path.join(tmpdir(), 'ld-server-fail-'));
  try {
    const bin = path.join(base, 'bin');
    const models = path.join(base, 'models');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(bin);
    mkdirSync(models);
    // Non-executable file: spawn emits EACCES.
    writeFileSync(path.join(bin, serverBinaryName()), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    writeFileSync(path.join(models, 'ggml-tiny.en.bin'), Buffer.from([1, 2, 3]));
    const engine = createWhisperServerEngine({ binDir: bin, modelsDir: models, modelId: 'tiny.en' });
    const frame = Buffer.alloc(3200);
    for (let i = 0; i + 1 < frame.length; i += 2) frame.writeInt16LE(i % 4 === 0 ? 1200 : -1200, i);
    const result = await engine.transcribe({ frames: [frame] });
    const error = result.messages.find((m) => m.t === 'error');
    assert.equal(error.code, 'server-start-failed');
    engine.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the server engine refuses to construct without its binary', () => {
  assert.throws(
    () => createWhisperServerEngine({ binDir: '/definitely/missing', modelsDir: '/missing' }),
    (error) => error?.code === 'unavailable'
  );
});
