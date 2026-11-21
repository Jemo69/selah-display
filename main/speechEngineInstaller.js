/**
 * main/speechEngineInstaller.js — install the REAL whisper.cpp binary.
 *
 * WHY THIS FILE EXISTS. Until now the app shipped two halves of a feature that
 * never met: a model downloader that fetched GGML weights, and a `whisper-cli`
 * driver that could only work if a human had already copied the binary into
 * `<userData>/speech-engine/bin` by hand. Nothing in the app did that copy. So
 * Production mode on a normal install had no engine to run, and the supervisor
 * quietly started the canned fake engine instead — which is exactly what the
 * "PROD" toggle showing "TEST ENGINE" was.
 *
 * This module closes the gap: it downloads the official whisper.cpp release
 * archive for the running platform, verifies its SHA-256 against the pinned
 * values below, and unpacks the whole payload (binary + shared libraries) into
 * the directory `main/speechIpc.js` already points the supervisor at.
 *
 * WHY THE WHOLE PAYLOAD AND NOT JUST THE EXE: `whisper-cli` is dynamically
 * linked against `libwhisper`/`libggml` (Windows: DLLs next to the exe, Linux:
 * RUNPATH `$ORIGIN`). Extracting only the executable produces a process that
 * starts and immediately dies with "cannot open shared object file". See
 * main/speechArchive.js `flattenPayload`.
 *
 * SECURITY POSTURE:
 *  - The download URL is built from a pinned release tag and a pinned asset
 *    name; no value from the renderer ever reaches it.
 *  - The archive is verified against a pinned SHA-256 before a single byte is
 *    written into `bin/`. A mismatch deletes the download.
 *  - Every entry name is checked with `isSafeEntryName` before writing, so a
 *    malicious archive cannot escape the install directory.
 *  - Downloads go to `downloads/`, never over a running engine's `bin/`; the
 *    final write happens after verification.
 *
 * GPU BUILDS (b5454): upstream publishes three Windows CUDA archives. Their
 * exact bytes are pinned below, measured from the published assets, and they
 * are selected ONLY when main/speechGpuProbe.js reports CUDA. There is no
 * verified whisper.cpp CLI archive for Vulkan, macOS, or Linux in b5454: those
 * paths report a typed unsupported / CPU fallback rather than a fake asset.
 * A present GPU is not a speed measurement — no speedup is claimed here.
 *
 * macOS is deliberately unsupported: upstream publishes an xcframework, not a
 * CLI, for that platform. Reporting "unsupported" is honest; pretending to
 * install and then failing at spawn is not.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readArchiveEntries, flattenPayload, isSafeEntryName } from './speechArchive.js';
import { compareCudaVersions } from './speechGpuProbe.js';

/** The pinned upstream release. Bump deliberately, with new hashes. */
export const ENGINE_RELEASE = Object.freeze({
  version: 'b5454',
  repository: 'ggml-org/whisper.cpp',
});

export const ENGINE_ASSET_BASE_URL = `https://github.com/${ENGINE_RELEASE.repository}/releases/download/${ENGINE_RELEASE.version}`;
const BASE_URL = ENGINE_ASSET_BASE_URL;

/**
 * Pinned assets, keyed `${platform}-${arch}`.
 *
 * `payloadDir` is the single top-level folder upstream wraps the files in;
 * `sha256` was measured from the published bytes at pin time.
 */
export const ENGINE_ASSETS = Object.freeze({
  'win32-x64': Object.freeze({
    file: 'whisper-bin-x64.zip',
    kind: 'zip',
    payloadDir: 'Release',
    bytes: 8928640,
    sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
  }),
  'win32-ia32': Object.freeze({
    file: 'whisper-bin-Win32.zip',
    kind: 'zip',
    payloadDir: 'Release',
    bytes: 5523979,
    sha256: 'b6cb078ee5d4df0f9dcdb4f820210c59bd6534c84fdb13c35bc8a51d1233451f',
  }),
  'win32-arm64': Object.freeze({
    file: 'whisper-bin-win-cpu-arm64.zip',
    kind: 'zip',
    payloadDir: 'Release',
    bytes: 4371193,
    sha256: '28c37e7b598c3d9bbfef94f3bd67f2ee6f12b7c86f3da5edcf5e4308d615ff6d',
  }),
  'linux-x64': Object.freeze({
    file: 'whisper-bin-ubuntu-x64.tar.gz',
    kind: 'tar.gz',
    payloadDir: 'whisper-bin-ubuntu-x64',
    bytes: 10364195,
    sha256: 'a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c',
  }),
  'linux-arm64': Object.freeze({
    file: 'whisper-bin-ubuntu-arm64.tar.gz',
    kind: 'tar.gz',
    payloadDir: 'whisper-bin-ubuntu-arm64',
    bytes: 4608377,
    sha256: '6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149',
  }),
});

/**
 * VERIFIED CUDA ASSETS from the same pinned b5454 release.
 *
 * Each row was downloaded in full and its SHA-256 compared BOTH with the
 * computed digest of the downloaded bytes AND with GitHub's published
 * `digest` field. Every archive is deflate-compressed (no ZIP64), passes
 * `unzip -t`, and contains `Release/whisper-cli.exe` plus `Release/ggml-cuda.dll`.
 * `minCudaVersion` is the driver-reported CUDA version required by the
 * bundled runtime; below it we fall back to the CPU build with a typed reason.
 *
 * There is deliberately NO Vulkan or Metal row: b5454 does not publish a
 * Vulkan CLI or a macOS CLI, and inventing one would make the installer fetch
 * a URL that does not exist.
 */
export const ENGINE_GPU_ASSETS = Object.freeze({
  'win32-x64-cuda-11.8': Object.freeze({
    file: 'whisper-bin-win-cuda-11.8.0-x64.zip',
    kind: 'zip',
    payloadDir: 'Release',
    bytes: 284761231,
    sha256: 'e81c86c542be6e3d7b7245392d4e1c52ab6e5c61dbe38721754bc0ab59d4d027',
    backend: 'cuda',
    platform: 'win32',
    arch: 'x64',
    minCudaVersion: '11.8',
  }),
  'win32-x64-cuda-12.4': Object.freeze({
    file: 'whisper-bin-win-cuda-12.4.0-x64.zip',
    kind: 'zip',
    payloadDir: 'Release',
    bytes: 684913404,
    sha256: 'afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a',
    backend: 'cuda',
    platform: 'win32',
    arch: 'x64',
    minCudaVersion: '12.4',
  }),
  'win32-arm64-cuda-13.4': Object.freeze({
    file: 'whisper-bin-win-cuda-13.4-arm64.zip',
    kind: 'zip',
    payloadDir: 'Release',
    bytes: 291157544,
    sha256: '6184ae8887d38ea9add68e883b9c846e7bf562ba1bf619ffc7ee9f8ec7e1699c',
    backend: 'cuda',
    platform: 'win32',
    arch: 'arm64',
    minCudaVersion: '13.4',
  }),
});

/** Every pinned archive, for the checksum-pinning test. */
export const ALL_ENGINE_ASSETS = Object.freeze({
  ...ENGINE_ASSETS,
  ...ENGINE_GPU_ASSETS,
});

/** The exact URL a pinned asset is fetched from. */
export function engineAssetUrl(asset) {
  return `${BASE_URL}/${asset?.file ?? ''}`;
}

/** whisper.cpp's binary name, per platform. */
export function engineBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
}

/** The pinned CPU asset for this platform, or null when upstream has none. */
export function engineAssetFor(platform = process.platform, arch = process.arch) {
  return ENGINE_ASSETS[`${platform}-${arch}`] ?? null;
}

/**
 * Select an engine asset from a GPU probe.
 *
 * A CUDA archive is chosen ONLY when the probe says CUDA is available AND the
 * driver reported a CUDA version that satisfies the archive's minimum.
 * Anything else — Vulkan, Metal, an unknown driver version, or no accelerator
 * — resolves to the pinned CPU archive when one exists. When there is no CPU
 * archive either (macOS), the result is a typed `unsupported-platform` with a
 * null asset, so the installer exits before any network call.
 *
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {string} [options.arch]
 * @param {object|null} [options.gpu] a result from probeGpuCapabilities()
 * @returns {{ok: boolean, asset: object|null, assetKey: string|null,
 *            status: string, code: string|null, backend: string,
 *            reason: string, gpuBackend: string|null}}
 */
export function selectEngineAsset({
  platform = process.platform,
  arch = process.arch,
  gpu = null,
} = {}) {
  const cpuAsset = engineAssetFor(platform, arch);
  const gpuBackend = gpu?.available === true && typeof gpu.backend === 'string'
    ? gpu.backend
    : 'cpu';

  const fallback = (code, reason) => ({
    ok: Boolean(cpuAsset),
    asset: cpuAsset,
    assetKey: cpuAsset ? `${platform}-${arch}` : null,
    status: cpuAsset ? 'cpu-fallback' : 'unsupported',
    code: cpuAsset ? code : 'unsupported-platform',
    backend: 'cpu',
    reason: cpuAsset ? `${reason} ${cpuAsset.file} will be installed instead.` : reason,
    gpuBackend,
  });

  if (gpuBackend === 'cuda') {
    const keys = Object.keys(ENGINE_GPU_ASSETS)
      .filter((key) => {
        const row = ENGINE_GPU_ASSETS[key];
        return row.platform === platform && row.arch === arch;
      })
      .sort();
    if (keys.length === 0) {
      return fallback(
        'unsupported-backend-asset',
        `No verified CUDA whisper.cpp archive is published for ${platform}/${arch}.`
      );
    }
    // The real probe nests CUDA evidence under `backends.cuda`; the
    // installer historically read a flat `gpu.cudaVersion`, so a real NVIDIA
    // machine silently got the CPU asset. Accept both, but prefer the
    // documented nested shape.
    const version = detectedCudaVersion(gpu);
    if (!version) {
      return fallback(
        'cuda-version-unknown',
        'CUDA was detected, but nvidia-smi did not report a CUDA version, so no bundled runtime can be claimed compatible.'
      );
    }
    const compatible = keys
      .map((key) => ({ key, asset: ENGINE_GPU_ASSETS[key] }))
      .filter(({ asset }) => (compareCudaVersions(version, asset.minCudaVersion) ?? -1) >= 0)
      .sort((a, b) => compareCudaVersions(a.asset.minCudaVersion, b.asset.minCudaVersion) ?? 0);
    if (compatible.length === 0) {
      return fallback(
        'cuda-driver-too-old',
        `The detected CUDA ${version} driver is older than every pinned ${platform}/${arch} CUDA build.`
      );
    }
    const { key, asset } = compatible[compatible.length - 1];
    return {
      ok: true,
      asset,
      assetKey: key,
      status: 'cuda',
      code: null,
      backend: 'cuda',
      reason: `CUDA ${version} was reported by nvidia-smi; the matching pinned ${asset.minCudaVersion} build was selected.`,
      gpuBackend,
    };
  }

  if (gpuBackend === 'vulkan') {
    return fallback(
      'unsupported-backend-asset',
      'Vulkan was detected, but whisper.cpp b5454 publishes no verified Vulkan CLI archive.'
    );
  }
  if (gpuBackend === 'metal') {
    return fallback(
      'unsupported-backend-asset',
      'Metal was detected, but whisper.cpp b5454 publishes an xcframework, not a CLI; a local Metal build is required.'
    );
  }
  return {
    ok: Boolean(cpuAsset),
    asset: cpuAsset,
    assetKey: cpuAsset ? `${platform}-${arch}` : null,
    status: cpuAsset ? 'cpu' : 'unsupported',
    code: cpuAsset ? null : 'unsupported-platform',
    backend: 'cpu',
    reason: cpuAsset
      ? 'No GPU backend was detected; the pinned CPU build was selected.'
      : `No prebuilt whisper.cpp engine is published for ${platform}/${arch}.`,
    gpuBackend,
  };
}


/** Is a usable whisper.cpp binary already installed in `binDir`? */
export function hasEngineBinary(binDir, platform = process.platform) {
  if (typeof binDir !== 'string' || !binDir) return false;
  try {
    const full = path.join(binDir, engineBinaryName(platform));
    return fs.existsSync(full) && fs.statSync(full).size > 0;
  } catch {
    return false;
  }
}

const ENGINE_MANIFEST_NAME = 'engine-manifest.json';
const VALID_ENGINE_BACKENDS = new Set(['cpu', 'cuda']);

/** Where the tiny install manifest lives; it records what was actually installed. */
export function engineManifestPath(binDir) {
  return typeof binDir === 'string' && binDir ? path.join(binDir, ENGINE_MANIFEST_NAME) : null;
}

/**
 * Read the backend this bin directory was installed for.
 *
 * A pre-existing engine from before manifests existed returns null — that is
 * deliberately *not* guessed as GPU. The setup card treats null as CPU and can
 * replace it in-app when the probe finds CUDA.
 */
export function readEngineManifest(binDir) {
  const full = engineManifestPath(binDir);
  if (!full) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const backend = VALID_ENGINE_BACKENDS.has(parsed.backend) ? parsed.backend : 'cpu';
    return {
      backend,
      assetKey: typeof parsed.assetKey === 'string' ? parsed.assetKey : null,
      version: typeof parsed.version === 'string' ? parsed.version : null,
      installedAt: typeof parsed.installedAt === 'string' ? parsed.installedAt : null,
      selectionCode: typeof parsed.selectionCode === 'string' ? parsed.selectionCode : null,
      gpuBackend: typeof parsed.gpuBackend === 'string' ? parsed.gpuBackend : null,
      cudaVersion: typeof parsed.cudaVersion === 'string' ? parsed.cudaVersion : null,
    };
  } catch {
    return null;
  }
}

/** Persist the installed backend after the files are in place. */
export async function writeEngineManifest(binDir, manifest = {}) {
  const full = engineManifestPath(binDir);
  if (!full) return false;
  const backend = VALID_ENGINE_BACKENDS.has(manifest.backend) ? manifest.backend : 'cpu';
  const body = JSON.stringify({
    backend,
    assetKey: typeof manifest.assetKey === 'string' ? manifest.assetKey : null,
    version: typeof manifest.version === 'string' ? manifest.version : null,
    installedAt: typeof manifest.installedAt === 'string' ? manifest.installedAt : new Date().toISOString(),
    selectionCode: typeof manifest.selectionCode === 'string' ? manifest.selectionCode : null,
    gpuBackend: typeof manifest.gpuBackend === 'string' ? manifest.gpuBackend : null,
    cudaVersion: typeof manifest.cudaVersion === 'string' ? manifest.cudaVersion : null,
  }, null, 2);
  const tmp = `${full}.tmp`;
  await fsp.writeFile(tmp, body, { mode: 0o644 });
  await fsp.rename(tmp, full);
  return true;
}

/**
 * Swap a fully-unpacked staging directory into place.
 *
 * The old engine is moved aside first, so a write failure cannot leave
 * whisper-cli.exe from one build next to DLLs from another. If the swap fails,
 * the previous directory is restored. This is the retry/repair primitive.
 */
export async function replaceEngineDirectory({ stagingDir, binDir } = {}) {
  if (typeof stagingDir !== 'string' || !stagingDir || typeof binDir !== 'string' || !binDir) {
    return failure('invalid-argument', 'The staged engine directory is missing.');
  }
  const backupDir = `${binDir}.backup-${randomUUID()}`;
  const hadExisting = fs.existsSync(binDir);
  try {
    if (hadExisting) await fsp.rename(binDir, backupDir);
    await fsp.rename(stagingDir, binDir);
  } catch (error) {
    try {
      if (fs.existsSync(binDir)) await fsp.rm(binDir, { recursive: true, force: true });
      if (hadExisting && fs.existsSync(backupDir)) await fsp.rename(backupDir, binDir);
    } catch {
      // The original error is the useful one; recovery failure is logged by
      // the caller's result, never hidden behind a second exception.
    }
    return failure('install-failed', `The speech engine could not be replaced: ${error?.message ?? 'unknown error'}.`);
  }
  if (hadExisting) {
    await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {});
  }
  return { ok: true };
}

const sha256Of = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** The CUDA version as reported by either probe shape. */
export function detectedCudaVersion(gpu) {
  if (typeof gpu?.cudaVersion === 'string') return gpu.cudaVersion;
  if (typeof gpu?.backends?.cuda?.cudaVersion === 'string') return gpu.backends.cuda.cudaVersion;
  return null;
}

/** A plain error object the IPC layer can relay without a stack trace. */
function failure(code, message) {
  return { ok: false, code, message };
}

/**
 * Read a fetch Response body into one Buffer, reporting progress.
 *
 * A stub fetch in tests may expose only `arrayBuffer()`; the production path
 * streams so a 10 MB download reports bytes instead of appearing frozen.
 */
async function readBody(response, { totalBytes, onProgress }) {
  const startedAt = Date.now();
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    let lastReport = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      received += value.byteLength;
      const now = Date.now();
      if (onProgress && (now - lastReport >= 250 || received === totalBytes)) {
        lastReport = now;
        const seconds = Math.max((now - startedAt) / 1000, 0.001);
        onProgress({
          receivedBytes: received,
          totalBytes,
          mbps: Number((received / seconds / 1e6).toFixed(1)),
        });
      }
    }
    return Buffer.concat(chunks);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  onProgress?.({ receivedBytes: buffer.byteLength, totalBytes, mbps: null });
  return buffer;
}

/**
 * Verify an archive's bytes against its pinned digest.
 *
 * @param {Buffer} buffer
 * @param {{sha256: string}} asset
 * @returns {boolean}
 */
export function verifyEngineArchive(buffer, asset) {
  return sha256Of(buffer) === asset?.sha256;
}

/**
 * Unpack a verified engine archive into `binDir`.
 *
 * Split out of `installEngineBinary` so the filesystem half is testable with a
 * small in-memory archive instead of a 10 MB download.
 *
 * @param {object} options
 * @param {Buffer} options.buffer
 * @param {object} options.asset   a pinned asset row
 * @param {string} options.binDir
 * @param {string} [options.platform]
 * @returns {Promise<{ok: boolean, code?: string, message?: string,
 *                    files?: string[], binaryName?: string}>}
 */
export async function unpackEngineArchive({
  buffer,
  asset,
  binDir,
  platform = process.platform,
} = {}) {
  if (!Buffer.isBuffer(buffer) || !asset || typeof binDir !== 'string' || !binDir) {
    return failure('invalid-argument', 'The engine archive could not be unpacked.');
  }

  let files;
  try {
    const entries = readArchiveEntries(buffer, asset.kind);
    files = flattenPayload(entries, asset.payloadDir);
  } catch (error) {
    return failure('corrupt-archive', `The engine archive could not be read: ${error?.message ?? 'unknown error'}.`);
  }

  const binaryName = engineBinaryName(platform);
  if (!files.has(binaryName)) {
    return failure('corrupt-archive', `The engine archive did not contain ${binaryName}, so nothing was installed.`);
  }

  try {
    await fsp.mkdir(binDir, { recursive: true });
    for (const [name, bytes] of files) {
      if (!isSafeEntryName(name)) {
        return failure('corrupt-archive', `The engine archive contained an unsafe path ("${name}").`);
      }
      const target = path.join(binDir, name);
      await fsp.writeFile(`${target}.tmp`, bytes);
      // Windows refuses rename() onto an existing file; clear it first so a
      // retry after a partial install can finish.
      await fsp.rm(target, { force: true });
      await fsp.rename(`${target}.tmp`, target);
      // Linux/macOS need the executable bit; the shared libraries do not.
      if (platform !== 'win32' && !/\.(so|dylib)(\.|$)/.test(name)) {
        await fsp.chmod(target, 0o755);
      }
    }
  } catch (error) {
    return failure('install-failed', `The engine files could not be written: ${error?.message ?? 'unknown error'}.`);
  }

  if (!hasEngineBinary(binDir, platform)) {
    return failure('install-failed', `The engine was unpacked but ${binaryName} is not usable.`);
  }

  return { ok: true, files: [...files.keys()].sort(), binaryName };
}

/**
 * Download, verify, and unpack the real engine into `binDir`.
 *
 * Never throws for expected failures: every failure is `{ ok:false, code,
 * message }` so the IPC handler can relay it to the operator as one sentence.
 *
 * @param {object} options
 * @param {string} options.binDir        destination (…/speech-engine/bin)
 * @param {string} options.downloadsDir  scratch dir for the archive
 * @param {string} [options.platform]    defaults to process.platform
 * @param {string} [options.arch]        defaults to process.arch
 * @param {object|null} [options.gpu]    probe result from probeGpuCapabilities();
 *                                      omitted means the honest CPU path
 * @param {Function} [options.fetchImpl] injected for tests
 * @param {(progress: object) => void} [options.onProgress]
 * @returns {Promise<{ok: boolean, code?: string, message?: string,
 *                    version?: string, binDir?: string, bytes?: number,
 *                    sha256?: string, files?: string[], backend?: string,
 *                    selection?: object}>}
 */
export async function installEngineBinary({
  binDir,
  downloadsDir,
  platform = process.platform,
  arch = process.arch,
  gpu = null,
  fetchImpl = globalThis.fetch,
  onProgress = null,
} = {}) {
  if (typeof binDir !== 'string' || !binDir) return failure('invalid-argument', 'No engine directory was given.');
  if (typeof downloadsDir !== 'string' || !downloadsDir) {
    return failure('invalid-argument', 'No download directory was given.');
  }

  const selection = selectEngineAsset({ platform, arch, gpu });
  const asset = selection.asset;
  if (!asset) {
    return failure(
      selection.code ?? 'unsupported-platform',
      `${selection.reason} Selah cannot install a ready-made engine on this computer; no manual file copying is required or supported.`
    );
  }
  if (typeof fetchImpl !== 'function') {
    return failure('network-unavailable', 'This build cannot download the speech engine.');
  }

  const url = engineAssetUrl(asset);
  const archivePath = path.join(downloadsDir, `${asset.file}.part`);
  let buffer;

  try {
    await fsp.mkdir(downloadsDir, { recursive: true });
    const response = await fetchImpl(url, { redirect: 'follow' });
    if (!response || response.ok === false) {
      return failure(
        'download-failed',
        `The engine download failed (HTTP ${response?.status ?? 'no response'}). Check the connection and try again.`
      );
    }
    buffer = await readBody(response, { totalBytes: asset.bytes, onProgress });
    await fsp.writeFile(archivePath, buffer);
  } catch (error) {
    await fsp.rm(archivePath, { force: true }).catch(() => {});
    return failure('download-failed', `The engine download failed: ${error?.message ?? 'unknown error'}.`);
  }

  if (!verifyEngineArchive(buffer, asset)) {
    await fsp.rm(archivePath, { force: true }).catch(() => {});
    return failure(
      'digest-mismatch',
      'The downloaded engine archive did not match its published checksum, so nothing was installed. Try again.'
    );
  }

  const stagingDir = path.join(path.dirname(binDir), `.engine-staging-${randomUUID()}`);
  let unpacked;
  try {
    unpacked = await unpackEngineArchive({ buffer, asset, binDir: stagingDir, platform });
    if (!unpacked.ok) return unpacked;

    const replaced = await replaceEngineDirectory({ stagingDir, binDir });
    if (!replaced.ok) return replaced;

    // The manifest is what lets a later setup run distinguish a verified CUDA
    // install from an old CPU binary. A failed manifest write does not undo a
    // working engine; it only means the next run treats the backend as
    // unknown and stays on the CPU model.
    let manifestWritten = false;
    try {
      await writeEngineManifest(binDir, {
        backend: selection.backend,
        assetKey: selection.assetKey,
        version: ENGINE_RELEASE.version,
        selectionCode: selection.code,
        gpuBackend: selection.gpuBackend,
        cudaVersion: detectedCudaVersion(gpu),
      });
      manifestWritten = true;
    } catch {
      manifestWritten = false;
    }

    return {
      ok: true,
      version: ENGINE_RELEASE.version,
      binDir,
      bytes: buffer.byteLength,
      sha256: asset.sha256,
      files: unpacked.files,
      backend: selection.backend,
      assetKey: selection.assetKey,
      assetFile: asset.file,
      cudaVersion: detectedCudaVersion(gpu),
      manifestWritten,
      selection: {
        status: selection.status,
        code: selection.code,
        reason: selection.reason,
        gpuBackend: selection.gpuBackend,
      },
    };
  } finally {
    await fsp.rm(archivePath, { force: true }).catch(() => {});
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}
