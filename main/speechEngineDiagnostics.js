/**
 * main/speechEngineDiagnostics.js — can the installed whisper.cpp binary
 * actually START on this machine?
 *
 * WHY THIS FILE EXISTS. `hasEngineBinary()` answers "is there a file named
 * whisper-cli(.exe) with a non-zero size". That is not the same question as
 * "can the operating system run it", and the gap is not theoretical: the
 * official whisper.cpp Windows archive is dynamically linked against
 * MSVCP140.dll, VCRUNTIME140.dll and VCRUNTIME140_1.dll, none of which ship
 * in the zip. On a machine without the Microsoft Visual C++ Redistributable,
 * the file is present and the process dies before `main()` with
 * STATUS_DLL_NOT_FOUND (0xC0000135). Every segment then fails, the engine
 * emits `transcribe-failed`, and — until this probe — the operator saw an
 * empty transcript and a rail that said "listening".
 *
 * So the check is deliberately a real spawn (`whisper-cli --help`), not a
 * file test. It costs a few milliseconds, it exercises the loader, and it is
 * the only way to tell "installed" from "runnable".
 *
 * WHAT THIS NEVER DOES: it does not read audio, does not load a model, does
 * not print a transcript, and does not touch the network. The only output it
 * inspects is the usage text a CLI prints for `--help`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { engineBinaryName } from './speechEngineInstaller.js';

/** How long a `--help` probe may take before the binary is called hung. */
export const PROBE_TIMEOUT_MS = 5000;

/** Cap on captured output; usage text is ~6 KB, and stderr is untrusted. */
const MAX_CAPTURE = 8192;

/** Windows loader exit codes for a missing import (0xC0000135, signed). */
const DLL_NOT_FOUND_CODES = new Set([3221225785, -1073741515]);

/** Import names that only the Visual C++ Redistributable provides. */
const VC_RUNTIME_PATTERN = /(vcruntime140|msvcp140|msvcr(?:100|120|140)|api-ms-win-crt)/i;

/**
 * The correct redistributable installer for this architecture.
 *
 * Microsoft publishes one stable redirect per architecture; pinning the
 * architecture rather than the version means the link keeps working when
 * they ship a new runtime, which is the point of a redirect.
 *
 * @param {string} [arch]
 * @returns {string}
 */
export function vcRuntimeUrl(arch = process.arch) {
  return arch === 'ia32'
    ? 'https://aka.ms/vs/17/release/vc_redist.x86.exe'
    : 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
}

/**
 * Turn a failed probe into a code + one actionable sentence.
 *
 * Kept pure so the mapping is testable without spawning anything.
 *
 * @param {{stderr?: string, stdout?: string, exitCode?: number, arch?: string}} input
 * @returns {{code: string, message: string}}
 */
export function classifyBinaryFailure({ stderr = '', stdout = '', exitCode = 0, arch = process.arch } = {}) {
  const text = `${stderr}\n${stdout}`;
  if (DLL_NOT_FOUND_CODES.has(exitCode) || VC_RUNTIME_PATTERN.test(text)) {
    return {
      code: 'missing-vc-runtime',
      message:
        'The speech engine is missing a Windows system component (Microsoft Visual C++ runtime). ' +
        `A technician can install it from ${vcRuntimeUrl(arch)}, then press Set up Sermon Assist again. ` +
        'The Selah engine files are installed correctly; this is not a download problem.',
    };
  }

  // First non-empty line, path-trimmed and length-capped. `--help` cannot
  // contain transcript text, so this is safe to show.
  const detail = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const suffix = detail ? ` (${detail.slice(0, 200)})` : '';

  return {
    code: 'binary-failed',
    message:
      'The speech engine file is installed but did not start' +
      `${exitCode ? ` (exit code ${exitCode})` : ''}${suffix}. ` +
      'Press Set up Sermon Assist again to repair it; if it still fails, share this detail with support.',
  };
}

/**
 * Run `whisper-cli --help` and report whether the OS can load and execute it.
 *
 * Never throws: every outcome is `{ ok, code, message }`, because the caller
 * relays it to the operator as one sentence.
 *
 * @param {object} [options]
 * @param {string} options.binDir            folder holding the binary
 * @param {string} [options.platform]        defaults to process.platform
 * @param {string} [options.arch]            defaults to process.arch
 * @param {Function} [options.spawnImpl]     injected for tests
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ok: boolean, code: string, message: string}>}
 */
export function probeEngineBinary({
  binDir,
  platform = process.platform,
  arch = process.arch,
  spawnImpl = spawn,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    const name = engineBinaryName(platform);
    const full = typeof binDir === 'string' && binDir ? path.join(binDir, name) : '';

    if (!full || !fs.existsSync(full)) {
      resolve({
        ok: false,
        code: 'binary-missing',
        message:
          'The speech engine is not installed. Open User Preferences → Experimental → ' +
          'Live Sermon Assist and press Set up Sermon Assist.',
      });
      return;
    }

    let settled = false;
    let child = null;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawnImpl(full, ['--help'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch {
      finish({
        ok: false,
        code: 'spawn-failed',
        message:
          'The speech engine could not be started. Reinstall it from User Preferences → ' +
          'Experimental → Live Sermon Assist.',
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_CAPTURE) stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_CAPTURE) stderr += String(chunk);
    });

    child.on('error', (error) => {
      finish({
        ok: false,
        code: error?.code === 'ENOENT' ? 'binary-missing' : 'spawn-failed',
        message:
          error?.code === 'ENOENT'
            ? 'The speech engine file is missing. Reinstall it from User Preferences → Experimental → Live Sermon Assist.'
            : 'The speech engine could not be started. Reinstall it from User Preferences → Experimental → Live Sermon Assist.',
      });
    });

    child.on('close', (code) => {
      if (code === 0) {
        finish({
          ok: true,
          code: 'ok',
          message: 'The speech engine starts and reports its options.',
        });
        return;
      }
      finish({ ok: false, ...classifyBinaryFailure({ stderr, stdout, exitCode: code, arch }) });
    });

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      finish({
        ok: false,
        code: 'binary-hung',
        message:
          `The speech engine did not answer within ${Math.round(timeoutMs / 1000)} seconds. ` +
          'Reinstall it from User Preferences → Experimental → Live Sermon Assist.',
      });
    }, timeoutMs);
    timer.unref?.();
  });
}

/**
 * Identify one installed binary by content-ish metadata, so a cached SUCCESS
 * is reused but a cached failure is not.
 *
 * Failures are deliberately never cached: the operator's next action after a
 * missing-runtime error is to install the runtime, and reusing the failure
 * would make the retry lie.
 *
 * @param {string} binDir
 * @param {string} [platform]
 * @returns {string|null}
 */
export function binaryIdentity(binDir, platform = process.platform) {
  if (typeof binDir !== 'string' || !binDir) return null;
  try {
    const full = path.join(binDir, engineBinaryName(platform));
    const stat = fs.statSync(full);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

let cachedSuccess = null;

/** Probe with a one-entry cache for successes only. */
export async function probeEngineBinaryCached(options = {}) {
  const platform = options.platform ?? process.platform;
  const identity = binaryIdentity(options.binDir, platform);
  if (identity && cachedSuccess?.identity === identity) return cachedSuccess.result;

  const result = await probeEngineBinary(options);
  if (result.ok && identity) cachedSuccess = { identity, result };
  return result;
}

/** Drop the cached success (used by the explicit self-test). */
export function clearProbeCache() {
  cachedSuccess = null;
}
