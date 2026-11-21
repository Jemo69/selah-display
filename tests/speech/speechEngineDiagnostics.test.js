/**
 * tests/speech/speechEngineDiagnostics.test.js — "installed" is not "runnable".
 *
 * THE BUG THIS PINS: the official whisper.cpp Windows archive links against
 * MSVCP140/VCRUNTIME140, which the archive does not contain. `hasWhisperBinary`
 * only checked that a file of non-zero size existed, so Production started an
 * engine whose every `whisper-cli` spawn died at the loader. The engine emitted
 * `transcribe-failed`, no component listened to `speech:error`, and the
 * operator saw an empty transcript under a green LISTENING badge.
 *
 * These tests pin the classification (pure) and the probe (real spawns of
 * tiny scripts) without needing a Windows machine: the exit code and the DLL
 * text are the inputs, not the platform.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyBinaryFailure,
  probeEngineBinary,
  binaryIdentity,
  vcRuntimeUrl,
} from '../../main/speechEngineDiagnostics.js';

const isWindows = process.platform === 'win32';
const binaryName = isWindows ? 'whisper-cli.exe' : 'whisper-cli';

describe('classifyBinaryFailure', () => {
  it('recognises the Windows loader exit code for a missing import', () => {
    const result = classifyBinaryFailure({ exitCode: 3221225785 });
    expect(result.code).toBe('missing-vc-runtime');
    expect(result.message).toMatch(/Visual C\+\+ Redistributable/);
    expect(result.message).toMatch(/vc_redist/);
  });

  it('recognises the signed form of the same code', () => {
    expect(classifyBinaryFailure({ exitCode: -1073741515 }).code).toBe('missing-vc-runtime');
  });

  it('recognises the missing DLL name when the platform reports it as text', () => {
    expect(classifyBinaryFailure({ exitCode: 1, stderr: 'VCRUNTIME140.dll was not found' }).code)
      .toBe('missing-vc-runtime');
    expect(classifyBinaryFailure({ exitCode: 1, stderr: 'MSVCP140.dll is missing' }).code)
      .toBe('missing-vc-runtime');
  });

  it('falls back to a reinstall sentence with the exit code for anything else', () => {
    const result = classifyBinaryFailure({ exitCode: 7, stderr: 'could not load anything' });
    expect(result.code).toBe('binary-failed');
    expect(result.message).toMatch(/exit code 7/);
    expect(result.message).toMatch(/Set up Sermon Assist again/);
  });

  it('picks the redistributable for the running architecture', () => {
    expect(vcRuntimeUrl('x64')).toMatch(/vc_redist\.x64\.exe/);
    expect(vcRuntimeUrl('ia32')).toMatch(/vc_redist\.x86\.exe/);
    expect(vcRuntimeUrl('arm64')).toMatch(/vc_redist\.x64\.exe/);
  });
});

describe.runIf(!isWindows)('probeEngineBinary (POSIX scripts)', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyric-engine-probe-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeBinary = (body) => {
    const full = path.join(dir, binaryName);
    fs.writeFileSync(full, body, { mode: 0o755 });
    fs.chmodSync(full, 0o755);
    return full;
  };

  it('reports a missing binary without spawning anything', async () => {
    const result = await probeEngineBinary({ binDir: dir });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('binary-missing');
    expect(result.message).toMatch(/Set up Sermon Assist/);
  });

  it('passes when the binary runs and exits 0', async () => {
    writeBinary('#!/bin/sh\necho "usage: whisper-cli" >&2\nexit 0\n');
    const result = await probeEngineBinary({ binDir: dir });
    expect(result).toMatchObject({ ok: true, code: 'ok' });
    expect(binaryIdentity(dir)).toMatch(/^\d+:\d+(\.\d+)?$/);
  });

  it('turns a missing compiler runtime into the redistributable remedy', async () => {
    writeBinary('#!/bin/sh\necho "VCRUNTIME140.dll was not found" >&2\nexit 1\n');
    const result = await probeEngineBinary({ binDir: dir });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('missing-vc-runtime');
    expect(result.message).toMatch(/vc_redist/);
  });

  it('bounds a binary that never answers', async () => {
    writeBinary('#!/bin/sh\nsleep 5\n');
    const result = await probeEngineBinary({ binDir: dir, timeoutMs: 100 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('binary-hung');
  });
});
