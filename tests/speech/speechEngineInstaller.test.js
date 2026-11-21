// @vitest-environment node
/**
 * tests/speech/speechEngineInstaller.test.js — the real engine binary
 * installer: verify, unpack, and refuse to install anything that does not
 * match.
 *
 * The download is stubbed (no network in tests) and the archive is built in
 * memory, so these assertions pin the two things that matter at a user's
 * desk: the payload lands FLAT in `bin/` with an executable bit, and a
 * mismatched or corrupt archive leaves nothing behind.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ENGINE_ASSETS,
  engineAssetFor,
  engineBinaryName,
  engineManifestPath,
  hasEngineBinary,
  installEngineBinary,
  readEngineManifest,
  replaceEngineDirectory,
  unpackEngineArchive,
  verifyEngineArchive,
  writeEngineManifest,
} from '../../main/speechEngineInstaller.js';

/** Minimal structurally-real zip (stored entries, no compression). */
function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.data, 'utf8');

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    locals.push(local, raw);
    centrals.push(central);
    offset += local.length + raw.length;
  }

  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, ...centrals, end]);
}

const fixtureZip = () =>
  buildZip([
    { name: 'Release/whisper-cli', data: '#!/bin/sh\necho hi\n' },
    { name: 'Release/libwhisper.so.1', data: 'shared object' },
    { name: 'Release/README.md', data: 'read me' },
  ]);

const ZIP_ASSET = {
  file: 'whisper-bin-x64.zip',
  kind: 'zip',
  payloadDir: 'Release',
  bytes: 0,
  sha256: 'unused',
};

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyric-engine-install-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('engineAssetFor — pinned platform table', () => {
  it('has a Windows and Linux build for both architectures, with real digests', () => {
    expect(engineAssetFor('win32', 'x64').file).toBe('whisper-bin-x64.zip');
    expect(engineAssetFor('win32', 'ia32').file).toBe('whisper-bin-Win32.zip');
    expect(engineAssetFor('linux', 'x64').file).toBe('whisper-bin-ubuntu-x64.tar.gz');
    expect(engineAssetFor('linux', 'arm64').file).toBe('whisper-bin-ubuntu-arm64.tar.gz');
    for (const asset of Object.values(ENGINE_ASSETS)) {
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.bytes).toBeGreaterThan(0);
    }
  });

  it('reports unsupported platforms instead of guessing', () => {
    expect(engineAssetFor('darwin', 'arm64')).toBeNull();
  });

  it('names the binary per platform', () => {
    expect(engineBinaryName('win32')).toBe('whisper-cli.exe');
    expect(engineBinaryName('linux')).toBe('whisper-cli');
  });
});

describe('unpackEngineArchive', () => {
  it('writes the whole payload flat into bin/ and marks the binary executable', async () => {
    const binDir = path.join(tmp, 'bin');
    const result = await unpackEngineArchive({
      buffer: fixtureZip(),
      asset: ZIP_ASSET,
      binDir,
      platform: 'linux',
    });

    expect(result.ok).toBe(true);
    expect(result.files).toEqual(['README.md', 'libwhisper.so.1', 'whisper-cli']);
    expect(hasEngineBinary(binDir, 'linux')).toBe(true);
    // Libraries live next to the binary: the driver's RUNPATH is $ORIGIN.
    expect(fs.existsSync(path.join(binDir, 'libwhisper.so.1'))).toBe(true);
    expect(fs.statSync(path.join(binDir, 'whisper-cli')).mode & 0o111).not.toBe(0);
    expect(fs.statSync(path.join(binDir, 'libwhisper.so.1')).mode & 0o111).toBe(0);
  });

  it('refuses an archive without the binary', async () => {
    const result = await unpackEngineArchive({
      buffer: buildZip([{ name: 'Release/libwhisper.so.1', data: 'x' }]),
      asset: ZIP_ASSET,
      binDir: path.join(tmp, 'bin'),
      platform: 'linux',
    });
    expect(result).toMatchObject({ ok: false, code: 'corrupt-archive' });
  });

  it('contains a traversal entry inside bin/ instead of escaping the install directory', async () => {
    const binDir = path.join(tmp, 'bin');
    const result = await unpackEngineArchive({
      buffer: buildZip([
        { name: 'Release/whisper-cli', data: 'bin' },
        { name: 'Release/../evil.sh', data: 'nope' },
      ]),
      asset: ZIP_ASSET,
      binDir,
      platform: 'linux',
    });
    // The reader flattens to the basename, so a `..` segment cannot climb out.
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'evil.sh'))).toBe(false);
    expect(fs.existsSync(path.join(binDir, 'evil.sh'))).toBe(true);
  });
});

describe('installEngineBinary', () => {
  const stubFetch = (buffer, { ok = true, status = 200 } = {}) =>
    async () => ({ ok, status, arrayBuffer: async () => buffer });

  it('refuses a download that does not match the pinned checksum, and leaves no bytes behind', async () => {
    const result = await installEngineBinary({
      binDir: path.join(tmp, 'bin'),
      downloadsDir: path.join(tmp, 'downloads'),
      platform: 'win32',
      arch: 'x64',
      fetchImpl: stubFetch(Buffer.from('not the real archive')),
    });

    expect(result).toMatchObject({ ok: false, code: 'digest-mismatch' });
    expect(fs.existsSync(path.join(tmp, 'bin'))).toBe(false);
    expect(fs.readdirSync(path.join(tmp, 'downloads'))).toEqual([]);
  });

  it('reports a failed HTTP response without touching the bin directory', async () => {
    const result = await installEngineBinary({
      binDir: path.join(tmp, 'bin'),
      downloadsDir: path.join(tmp, 'downloads'),
      platform: 'linux',
      arch: 'x64',
      fetchImpl: stubFetch(Buffer.alloc(0), { ok: false, status: 503 }),
    });
    expect(result).toMatchObject({ ok: false, code: 'download-failed' });
    expect(fs.existsSync(path.join(tmp, 'bin'))).toBe(false);
  });

  it('reports unsupported platforms before any network call', async () => {
    let called = false;
    const result = await installEngineBinary({
      binDir: path.join(tmp, 'bin'),
      downloadsDir: path.join(tmp, 'downloads'),
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: async () => {
        called = true;
        return { ok: true, arrayBuffer: async () => Buffer.alloc(0) };
      },
    });
    expect(result).toMatchObject({ ok: false, code: 'unsupported-platform' });
    expect(called).toBe(false);
  });

  it('verifies a digest against the pinned value', () => {
    const buffer = Buffer.from('abc');
    const digest = createHash('sha256').update(buffer).digest('hex');
    expect(verifyEngineArchive(buffer, { sha256: digest })).toBe(true);
    expect(verifyEngineArchive(buffer, { sha256: 'deadbeef' })).toBe(false);
  });
});

describe('engine manifest and atomic replacement', () => {
  it('records the backend that was actually installed', async () => {
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    await writeEngineManifest(binDir, {
      backend: 'cuda',
      assetKey: 'win32-x64-cuda-12.4',
      version: 'b5454',
      selectionCode: null,
      gpuBackend: 'cuda',
    });
    expect(readEngineManifest(binDir)).toMatchObject({
      backend: 'cuda',
      assetKey: 'win32-x64-cuda-12.4',
      version: 'b5454',
      gpuBackend: 'cuda',
    });
    expect(engineManifestPath(binDir)).toBe(path.join(binDir, 'engine-manifest.json'));
  });

  it('treats an old engine with no manifest as unknown, not as GPU', () => {
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    expect(readEngineManifest(binDir)).toBeNull();
  });

  it('swaps a complete staging directory into place and removes the old one', async () => {
    const binDir = path.join(tmp, 'bin');
    const stagingDir = path.join(tmp, 'staging');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'old.dll'), 'old');
    fs.writeFileSync(path.join(stagingDir, 'whisper-cli'), 'new', { mode: 0o755 });

    const result = await replaceEngineDirectory({ stagingDir, binDir });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(binDir, 'old.dll'))).toBe(false);
    expect(fs.readFileSync(path.join(binDir, 'whisper-cli'), 'utf8')).toBe('new');
    expect(fs.existsSync(stagingDir)).toBe(false);
  });

  it('restores the old engine when a replacement cannot be swapped in', async () => {
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'whisper-cli'), 'old');
    const result = await replaceEngineDirectory({
      stagingDir: path.join(tmp, 'missing-staging'),
      binDir,
    });
    expect(result).toMatchObject({ ok: false, code: 'install-failed' });
    expect(fs.readFileSync(path.join(binDir, 'whisper-cli'), 'utf8')).toBe('old');
  });
});
