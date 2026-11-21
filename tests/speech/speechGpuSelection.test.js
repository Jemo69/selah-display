// @vitest-environment node
/**
 * Asset selection + checksum pinning for the b5454 engine release.
 *
 * The expected table below was transcribed from the actual published bytes:
 * each archive was downloaded in full, hashed locally, and compared with
 * GitHub's `digest` field on the release. A change to any pinned file, size,
 * digest or URL fails here rather than silently fetching something unverified.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALL_ENGINE_ASSETS,
  ENGINE_ASSET_BASE_URL,
  ENGINE_GPU_ASSETS,
  engineAssetUrl,
  installEngineBinary,
  selectEngineAsset,
} from '../../main/speechEngineInstaller.js';

const BASE = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454';

/** The complete pinned set: CPU (existing behaviour) + verified CUDA assets. */
const EXPECTED = {
  'win32-x64': ['whisper-bin-x64.zip', 8928640, '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb'],
  'win32-ia32': ['whisper-bin-Win32.zip', 5523979, 'b6cb078ee5d4df0f9dcdb4f820210c59bd6534c84fdb13c35bc8a51d1233451f'],
  'win32-arm64': ['whisper-bin-win-cpu-arm64.zip', 4371193, '28c37e7b598c3d9bbfef94f3bd67f2ee6f12b7c86f3da5edcf5e4308d615ff6d'],
  'linux-x64': ['whisper-bin-ubuntu-x64.tar.gz', 10364195, 'a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c'],
  'linux-arm64': ['whisper-bin-ubuntu-arm64.tar.gz', 4608377, '6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149'],
  'win32-x64-cuda-11.8': ['whisper-bin-win-cuda-11.8.0-x64.zip', 284761231, 'e81c86c542be6e3d7b7245392d4e1c52ab6e5c61dbe38721754bc0ab59d4d027'],
  'win32-x64-cuda-12.4': ['whisper-bin-win-cuda-12.4.0-x64.zip', 684913404, 'afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a'],
  'win32-arm64-cuda-13.4': ['whisper-bin-win-cuda-13.4-arm64.zip', 291157544, '6184ae8887d38ea9add68e883b9c846e7bf562ba1bf619ffc7ee9f8ec7e1699c'],
};

const probe = (backend, extra = {}, available = true) => ({
  platform: 'win32',
  arch: 'x64',
  backend,
  available,
  ...extra,
});

describe('pinned asset table', () => {
  it('matches the exact observed file, size, digest and URL for every asset', () => {
    expect(ENGINE_ASSET_BASE_URL).toBe(BASE);
    expect(Object.keys(ALL_ENGINE_ASSETS).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [key, [file, bytes, sha256]] of Object.entries(EXPECTED)) {
      const asset = ALL_ENGINE_ASSETS[key];
      expect(asset.file, key).toBe(file);
      expect(asset.bytes, key).toBe(bytes);
      expect(asset.sha256, key).toBe(sha256);
      expect(asset.sha256, key).toMatch(/^[0-9a-f]{64}$/);
      expect(engineAssetUrl(asset), key).toBe(`${BASE}/${file}`);
    }
  });

  it('only pins CUDA assets; no invented Vulkan or macOS CLI row', () => {
    expect(Object.keys(ENGINE_GPU_ASSETS).sort()).toEqual([
      'win32-arm64-cuda-13.4',
      'win32-x64-cuda-11.8',
      'win32-x64-cuda-12.4',
    ]);
    for (const asset of Object.values(ENGINE_GPU_ASSETS)) {
      expect(asset.backend).toBe('cuda');
      expect(asset.kind).toBe('zip');
      expect(asset.payloadDir).toBe('Release');
    }
  });
});

describe('selectEngineAsset — probe/selection matrix', () => {
  it('chooses the newest compatible CUDA build for Windows x64', () => {
    expect(selectEngineAsset({
      platform: 'win32', arch: 'x64', gpu: probe('cuda', { cudaVersion: '12.4' }),
    })).toMatchObject({ ok: true, status: 'cuda', backend: 'cuda', assetKey: 'win32-x64-cuda-12.4' });

    expect(selectEngineAsset({
      platform: 'win32', arch: 'x64', gpu: probe('cuda', { cudaVersion: '12.0' }),
    })).toMatchObject({ ok: true, status: 'cuda', assetKey: 'win32-x64-cuda-11.8' });
  });

  it('reads CUDA version from the real nested probe shape', () => {
    const realShape = {
      platform: 'win32',
      arch: 'x64',
      backend: 'cuda',
      available: true,
      backends: { cuda: { available: true, cudaVersion: '12.4' } },
    };
    expect(selectEngineAsset({ platform: 'win32', arch: 'x64', gpu: realShape }))
      .toMatchObject({ ok: true, status: 'cuda', backend: 'cuda', assetKey: 'win32-x64-cuda-12.4' });
  });

  it('chooses the Windows ARM64 CUDA build only with a compatible driver', () => {
    expect(selectEngineAsset({
      platform: 'win32', arch: 'arm64', gpu: probe('cuda', { cudaVersion: '13.4' }),
    })).toMatchObject({ ok: true, assetKey: 'win32-arm64-cuda-13.4' });

    const old = selectEngineAsset({
      platform: 'win32', arch: 'arm64', gpu: probe('cuda', { cudaVersion: '12.4' }),
    });
    expect(old).toMatchObject({
      ok: true, status: 'cpu-fallback', code: 'cuda-driver-too-old',
      backend: 'cpu', assetKey: 'win32-arm64',
    });
  });

  it('refuses to guess a CUDA runtime when the driver version is unknown or too old', () => {
    expect(selectEngineAsset({
      platform: 'win32', arch: 'x64', gpu: probe('cuda'),
    })).toMatchObject({ status: 'cpu-fallback', code: 'cuda-version-unknown', assetKey: 'win32-x64' });
    expect(selectEngineAsset({
      platform: 'win32', arch: 'x64', gpu: probe('cuda', { cudaVersion: '10.2' }),
    })).toMatchObject({ status: 'cpu-fallback', code: 'cuda-driver-too-old', assetKey: 'win32-x64' });
  });

  it('never selects a GPU archive from a failed probe', () => {
    const failed = selectEngineAsset({
      platform: 'win32', arch: 'x64', gpu: probe('cuda', { cudaVersion: '12.4' }, false),
    });
    expect(failed).toMatchObject({ status: 'cpu', backend: 'cpu', assetKey: 'win32-x64' });
    expect(failed.reason).toMatch(/No GPU backend was detected/);
  });

  it('falls back to CPU with a typed reason for Vulkan (no verified CLI archive)', () => {
    const selected = selectEngineAsset({ platform: 'win32', arch: 'x64', gpu: probe('vulkan') });
    expect(selected).toMatchObject({
      ok: true, status: 'cpu-fallback', code: 'unsupported-backend-asset',
      backend: 'cpu', assetKey: 'win32-x64',
    });
    expect(selected.reason).toMatch(/no verified Vulkan CLI archive/);
  });

  it('falls back to CPU for CUDA on Linux, where b5454 has no CUDA CLI', () => {
    const selected = selectEngineAsset({
      platform: 'linux', arch: 'x64', gpu: probe('cuda', { cudaVersion: '12.4' }),
    });
    expect(selected).toMatchObject({
      status: 'cpu-fallback', code: 'unsupported-backend-asset', assetKey: 'linux-x64',
    });
  });

  it('reports Metal as unsupported on macOS — there is no CLI to download', () => {
    const selected = selectEngineAsset({
      platform: 'darwin', arch: 'arm64', gpu: probe('metal'),
    });
    expect(selected).toMatchObject({
      ok: false, asset: null, status: 'unsupported', code: 'unsupported-platform',
    });
    expect(selected.reason).toMatch(/xcframework, not a CLI/);
  });

  it('keeps the CPU path when no accelerator is reported', () => {
    expect(selectEngineAsset({ platform: 'linux', arch: 'arm64', gpu: probe('cpu') }))
      .toMatchObject({ status: 'cpu', backend: 'cpu', assetKey: 'linux-arm64' });
    expect(selectEngineAsset({ platform: 'darwin', arch: 'x64' }))
      .toMatchObject({ ok: false, code: 'unsupported-platform' });
  });
});

describe('installEngineBinary with a GPU probe', () => {
  it('fetches the pinned CUDA URL and still verifies before unpacking', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-install-'));
    try {
      const urls = [];
      const result = await installEngineBinary({
        binDir: path.join(tmp, 'bin'),
        downloadsDir: path.join(tmp, 'downloads'),
        platform: 'win32',
        arch: 'x64',
        gpu: probe('cuda', { cudaVersion: '12.4' }),
        fetchImpl: async (url) => {
          urls.push(url);
          return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('not the real archive') };
        },
      });

      expect(result).toMatchObject({ ok: false, code: 'digest-mismatch' });
      expect(urls).toEqual([`${BASE}/whisper-bin-win-cuda-12.4.0-x64.zip`]);
      expect(fs.existsSync(path.join(tmp, 'bin'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
