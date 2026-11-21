/**
 * main/speechGpuProbe.js — detect an accelerator WITHOUT claiming a speedup.
 *
 * This module answers one narrow question: "is there evidence of a usable
 * CUDA / Vulkan / Metal backend on this machine?" It does not say that a model
 * will be fast, that a binary will load, or that a GPU was actually used by an
 * inference. Those are measurement questions; `speech-engine/benchmark.js`
 * reports the backend the ENGINE saw, and the benchmark panel refuses to
 * recommend anything whose RTF has not been measured here.
 *
 * PURE / INJECTABLE. Nothing happens at import time. All I/O goes through the
 * two injected functions:
 *
 *   execFileImpl(command, args) -> Promise<{ ok, stdout, stderr }>
 *   existsSyncImpl(path)        -> boolean
 *
 * The defaults wrap `node:child_process.execFile` and `node:fs.existsSync`.
 * Tests inject stubs, so the probe matrix runs with no GPU and no drivers.
 *
 * EVIDENCE LEVELS ARE KEPT DISTINCT:
 *   - `nvidia-smi` output is a device report, not a benchmark.
 *   - a driver/loader file is a presence check only; it does not prove a
 *     device is attached or usable.
 *   - macOS Metal framework presence proves the OS ships Metal, not that a
 *     whisper.cpp CLI exists (b5454 publishes only an xcframework).
 *
 * The caller gets the evidence list and a reason string alongside the typed
 * backend so the UI can say exactly what was — and was not — detected.
 */

/** Ordered by which backend has a verified prebuilt archive today. */
export const GPU_BACKENDS = Object.freeze(['cuda', 'vulkan', 'metal', 'cpu']);

/** Backends that are not the CPU. */
export const ACCELERATED_BACKENDS = Object.freeze(['cuda', 'vulkan', 'metal']);

function defaultExecFile(command, args = []) {
  // Lazy import keeps module evaluation side-effect free; this runs only when
  // probeGpuCapabilities is called without an injected command runner.
  return import('node:child_process').then(({ execFile }) => new Promise((resolve) => {
    execFile(command, args, { timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
        stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
      });
    });
  }));
}

/**
 * Fill in the injected I/O functions. Kept separate from detection so tests
 * never touch the host machine and production never touches the network.
 */
async function resolveIo({ execFileImpl, existsSyncImpl }) {
  let existsSync = existsSyncImpl;
  if (typeof existsSync !== 'function') {
    ({ existsSync } = await import('node:fs'));
  }
  return {
    execFile: typeof execFileImpl === 'function' ? execFileImpl : defaultExecFile,
    existsSync,
  };
}

const DRIVER_PATHS = Object.freeze({
  'win32-x64': ['C:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Windows\\System32\\nvcuda.dll'],
  'win32-arm64': ['C:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Windows\\System32\\nvcuda.dll'],
  'linux-x64': ['/dev/nvidia0', '/usr/lib/x86_64-linux-gnu/libcuda.so.1'],
  'linux-arm64': ['/dev/nvidia0', '/usr/lib/aarch64-linux-gnu/libcuda.so.1'],
});

const VULKAN_LOADER_PATHS = Object.freeze({
  'win32-x64': ['C:\\Windows\\System32\\vulkan-1.dll'],
  'win32-arm64': ['C:\\Windows\\System32\\vulkan-1.dll'],
  'linux-x64': ['/usr/lib/x86_64-linux-gnu/libvulkan.so.1', '/usr/lib/libvulkan.so.1'],
  'linux-arm64': ['/usr/lib/aarch64-linux-gnu/libvulkan.so.1', '/usr/lib/libvulkan.so.1'],
});

const METAL_FRAMEWORK = '/System/Library/Frameworks/Metal.framework';

/** Run a command as evidence only. A failure is a result, never a throw. */
async function runEvidence(execFile, command, args) {
  try {
    const reply = await execFile(command, args);
    return {
      ok: reply?.ok === true,
      stdout: typeof reply?.stdout === 'string' ? reply.stdout : '',
    };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/** The driver's reported maximum CUDA toolkit version, e.g. "12.4". */
export function parseCudaVersion(text) {
  const match = String(text ?? '').match(/CUDA\s+Version:\s*(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const parts = match[1].split('.').map(Number);
  return parts.length === 2 ? `${parts[0]}.${parts[1]}` : `${parts[0]}.0`;
}

/** Compare two "major.minor" version strings numerically, not lexically. */
export function compareCudaVersions(left, right) {
  const parse = (value) => {
    const match = String(value ?? '').match(/^(\d+)\.(\d+)$/);
    return match ? [Number(match[1]), Number(match[2])] : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

async function inspectCuda({ platform, arch, execFile, existsSync, checked }) {
  const key = `${platform}-${arch}`;
  const driverPaths = DRIVER_PATHS[key] ?? [];
  const found = driverPaths.filter((filePath) => {
    checked.push(`driver-file:${filePath}`);
    return existsSync(filePath) === true;
  });

  checked.push('nvidia-smi --query-gpu');
  const query = await runEvidence(execFile, 'nvidia-smi', [
    '--query-gpu=name,driver_version',
    '--format=csv,noheader',
  ]);
  const firstRow = query.ok ? query.stdout.split('\n').map((line) => line.trim()).find(Boolean) : null;

  let cudaVersion = null;
  if (firstRow) {
    checked.push('nvidia-smi --version-header');
    const raw = await runEvidence(execFile, 'nvidia-smi', []);
    cudaVersion = parseCudaVersion(raw.stdout);
  }

  const evidence = [];
  if (firstRow) evidence.push('nvidia-smi');
  for (const filePath of found) evidence.push(`driver-file:${filePath}`);
  const available = Boolean(firstRow || found.length > 0);

  let reason = 'No NVIDIA driver evidence was found.';
  if (firstRow && cudaVersion) {
    reason = `nvidia-smi reports an NVIDIA GPU and CUDA ${cudaVersion} driver support.`;
  } else if (firstRow) {
    reason = 'nvidia-smi reports an NVIDIA GPU but did not state a CUDA version.';
  } else if (found.length > 0) {
    reason = 'An NVIDIA driver file is present, but nvidia-smi did not report a GPU or CUDA version.';
  }

  const [gpuName = null, driverVersion = null] = firstRow
    ? firstRow.split(',').map((part) => part.trim() || null)
    : [];

  return {
    available,
    evidence,
    reason,
    gpuName,
    driverVersion,
    cudaVersion,
  };
}

async function inspectVulkan({ platform, arch, execFile, existsSync, checked }) {
  const key = `${platform}-${arch}`;
  const loaderPaths = VULKAN_LOADER_PATHS[key] ?? [];
  const found = loaderPaths.filter((filePath) => {
    checked.push(`vulkan-loader:${filePath}`);
    return existsSync(filePath) === true;
  });

  checked.push('vulkaninfo --summary');
  const info = await runEvidence(execFile, 'vulkaninfo', ['--summary']);
  const enumerated = info.ok && info.stdout.trim().length > 0;

  const evidence = [];
  if (enumerated) evidence.push('vulkaninfo');
  for (const filePath of found) evidence.push(`vulkan-loader:${filePath}`);
  const available = enumerated || found.length > 0;

  let reason = 'No Vulkan runtime evidence was found.';
  if (enumerated) {
    reason = 'vulkaninfo enumerated a Vulkan instance. Device suitability was not benchmarked.';
  } else if (found.length > 0) {
    reason = 'A Vulkan loader is present, but no device was enumerated; a loader alone is not a usable GPU.';
  }

  return { available, evidence, reason };
}

function inspectMetal({ platform, existsSync, checked }) {
  if (platform !== 'darwin') {
    return { available: false, evidence: [], reason: 'Metal is a macOS-only backend.' };
  }
  checked.push(`framework:${METAL_FRAMEWORK}`);
  const available = existsSync(METAL_FRAMEWORK) === true;
  return {
    available,
    evidence: available ? [`framework:${METAL_FRAMEWORK}`] : [],
    reason: available
      ? 'macOS ships Metal, but whisper.cpp b5454 publishes an xcframework, not a CLI — a local build is still required.'
      : 'The Metal framework was not found on this macOS system.',
  };
}

/**
 * Probe this machine's accelerator backends.
 *
 * @param {object} [options]
 * @param {string} [options.platform] defaults to process.platform
 * @param {string} [options.arch] defaults to process.arch
 * @param {Function} [options.execFileImpl] injected command runner
 * @param {Function} [options.existsSyncImpl] injected file/device check
 * @returns {Promise<{platform: string, arch: string, backend: string,
 *                    available: boolean, reason: string, checked: string[],
 *                    backends: object}>}
 */
export async function probeGpuCapabilities({
  platform = process.platform,
  arch = process.arch,
  execFileImpl,
  existsSyncImpl,
} = {}) {
  const io = await resolveIo({ execFileImpl, existsSyncImpl });
  const checked = [];
  const backends = {
    cuda: await inspectCuda({ platform, arch, ...io, checked }),
    vulkan: await inspectVulkan({ platform, arch, ...io, checked }),
    metal: inspectMetal({ platform, ...io, checked }),
  };

  const backend = ACCELERATED_BACKENDS.find((name) => backends[name].available) ?? 'cpu';
  const reason = backend === 'cpu'
    ? 'No CUDA, Vulkan or Metal evidence was found; use the CPU build and benchmark it before choosing a large model.'
    : backends[backend].reason;

  return {
    platform,
    arch,
    backend,
    available: backend !== 'cpu',
    reason,
    checked,
    backends,
  };
}

export default probeGpuCapabilities;
