// @vitest-environment node
/**
 * GPU probe matrix — no GPU, driver, or Vulkan runtime required.
 *
 * Every command and filesystem check is injected. The point of these tests is
 * that a probe result is EVIDENCE with a stated level, not a promise that a
 * model will be fast. Driver-only and loader-only detections are kept distinct
 * from nvidia-smi / vulkaninfo reporting a device.
 */
import { describe, it, expect } from 'vitest';
import {
  probeGpuCapabilities,
  parseCudaVersion,
  compareCudaVersions,
  ACCELERATED_BACKENDS,
} from '../../main/speechGpuProbe.js';

const noFiles = () => false;
const noCommands = async () => ({ ok: false, stdout: '', stderr: '' });

/** Route commands to canned evidence; unknown commands fail closed. */
const commands = (replies) => async (command, args = []) => {
  const key = `${command}${args.length ? ` ${args[0]}` : ''}`;
  return replies[key] ?? { ok: false, stdout: '', stderr: '' };
};

const SMI_QUERY = 'nvidia-smi --query-gpu=name,driver_version';
const SMI_HEADER = 'nvidia-smi';
const VULKANINFO = 'vulkaninfo --summary';

describe('probeGpuCapabilities — detection matrix', () => {
  it('reports CUDA with a driver-reported version when nvidia-smi answers', async () => {
    const gpu = await probeGpuCapabilities({
      platform: 'win32',
      arch: 'x64',
      existsSyncImpl: noFiles,
      execFileImpl: commands({
        [SMI_QUERY]: { ok: true, stdout: 'NVIDIA GeForce RTX 4080, 551.23\n' },
        [SMI_HEADER]: {
          ok: true,
          stdout: '| NVIDIA-SMI 551.23    Driver Version: 551.23    CUDA Version: 12.4 |\n',
        },
      }),
    });

    expect(gpu.backend).toBe('cuda');
    expect(gpu.available).toBe(true);
    expect(gpu.backends.cuda).toMatchObject({
      available: true,
      cudaVersion: '12.4',
      gpuName: 'NVIDIA GeForce RTX 4080',
      driverVersion: '551.23',
    });
    expect(gpu.backends.cuda.evidence).toContain('nvidia-smi');
    expect(gpu.reason).toMatch(/12\.4/);
  });

  it('distinguishes a driver file from a device report, and withholds a version', async () => {
    const gpu = await probeGpuCapabilities({
      platform: 'linux',
      arch: 'x64',
      existsSyncImpl: (filePath) => filePath === '/dev/nvidia0',
      execFileImpl: noCommands,
    });

    expect(gpu.backend).toBe('cuda');
    expect(gpu.backends.cuda.cudaVersion).toBeNull();
    expect(gpu.backends.cuda.evidence).toEqual(['driver-file:/dev/nvidia0']);
    expect(gpu.reason).toMatch(/did not report a GPU or CUDA version/);
  });

  it('reports Vulkan when vulkaninfo enumerates and CUDA is absent', async () => {
    const gpu = await probeGpuCapabilities({
      platform: 'linux',
      arch: 'x64',
      existsSyncImpl: noFiles,
      execFileImpl: commands({
        [VULKANINFO]: { ok: true, stdout: 'Instance Extensions: count = 3\nDevices: 1\n' },
      }),
    });

    expect(gpu.backend).toBe('vulkan');
    expect(gpu.backends.cuda.available).toBe(false);
    expect(gpu.backends.vulkan.evidence).toContain('vulkaninfo');
    expect(gpu.reason).toMatch(/not benchmarked/);
  });

  it('does not mistake a Vulkan loader DLL for a usable device', async () => {
    const loader = 'C:\\Windows\\System32\\vulkan-1.dll';
    const gpu = await probeGpuCapabilities({
      platform: 'win32',
      arch: 'x64',
      existsSyncImpl: (filePath) => filePath === loader,
      execFileImpl: noCommands,
    });

    expect(gpu.backend).toBe('vulkan');
    expect(gpu.backends.vulkan.evidence).toEqual([`vulkan-loader:${loader}`]);
    expect(gpu.reason).toMatch(/loader alone is not a usable GPU/);
  });

  it('detects macOS Metal but says a CLI build is still required', async () => {
    const gpu = await probeGpuCapabilities({
      platform: 'darwin',
      arch: 'arm64',
      existsSyncImpl: (filePath) => filePath === '/System/Library/Frameworks/Metal.framework',
      execFileImpl: noCommands,
    });

    expect(gpu.backend).toBe('metal');
    expect(gpu.reason).toMatch(/xcframework, not a CLI/);
  });

  it('falls back to typed CPU when nothing is found', async () => {
    const gpu = await probeGpuCapabilities({
      platform: 'linux',
      arch: 'x64',
      existsSyncImpl: noFiles,
      execFileImpl: noCommands,
    });

    expect(gpu.backend).toBe('cpu');
    expect(gpu.available).toBe(false);
    expect(gpu.reason).toMatch(/benchmark it before choosing a large model/);
    for (const name of ACCELERATED_BACKENDS) {
      expect(gpu.backends[name].available, name).toBe(false);
    }
  });

  it('does not throw when an injected command rejects', async () => {
    const gpu = await probeGpuCapabilities({
      platform: 'linux',
      arch: 'x64',
      existsSyncImpl: noFiles,
      execFileImpl: async () => { throw new Error('spawn ENOENT'); },
    });
    expect(gpu.backend).toBe('cpu');
  });
});

describe('version parsing', () => {
  it('reads the CUDA version only from a driver report', () => {
    expect(parseCudaVersion('CUDA Version: 12.4')).toBe('12.4');
    expect(parseCudaVersion('CUDA Version: 13')).toBe('13.0');
    expect(parseCudaVersion('Driver Version: 551.23')).toBeNull();
    expect(parseCudaVersion(null)).toBeNull();
  });

  it('compares versions numerically, not as strings', () => {
    expect(compareCudaVersions('12.4', '11.8')).toBeGreaterThan(0);
    expect(compareCudaVersions('9.9', '11.8')).toBeLessThan(0);
    expect(compareCudaVersions('12.4', '12.4')).toBe(0);
    expect(compareCudaVersions('bogus', '12.4')).toBeNull();
  });
});
