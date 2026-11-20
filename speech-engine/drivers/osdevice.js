/**
 * speech-engine/drivers/osdevice.js — the OS on-device speech driver.
 *
 * WHAT THIS IS. The executable adapter between the engine's v1 contract and
 * the speech recognizer the platform already ships — no binary to install,
 * no model to download, nothing that leaves the machine. On Windows that is
 * System.Speech (in-box since Vista, offline, driven here through a short
 * PowerShell script); other platforms report honestly unavailable until a
 * backend for them is proven.
 *
 * WHY A CHILD PROCESS AND NOT WinRT DIRECTLY. Node has no stable WinRT
 * projection, and a native addon would need a toolchain on the user's
 * machine — the exact cost the whispercpp driver refused. PowerShell and
 * System.Speech are both in-box on desktop Windows, so the whole backend is
 * one spawned process with a pipe, same shape as the whisper driver.
 *
 * AUDIO AND THE TEMP FILE. Unlike whisper-cli (stdin), System.Speech only
 * reads a WAVE file, so the buffered PCM is written to a private temp
 * directory per transcribe call and removed when the child exits — 'close'
 * always follows a kill, so no path leaves audio behind (on timeout and
 * spawn-error the promise may settle just before the removal lands, but
 * nothing sermon-related outlives the exited child).
 * The transcript JSON the script prints goes to stdout and is parsed there.
 *
 * WHAT IT DOES NOT DO. No word timestamps (one segment spans the whole
 * chunk — System.Speech word offsets exist, but per-word AudioPosition math
 * is a second feature, not this one). No prompt biasing. Both are stated in
 * health() so the lane gates degrade with a sentence instead of silently.
 *
 * NO AUDIO EVER REACHES A LOG. Every failure path emits a CODE. The
 * recognizer's stderr is captured for diagnostics and never printed, because
 * it can carry decoded text.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { framesToWav } from './whispercpp.js';

/** Sentinel returned when no OS speech backend will run here. */
export const OSDEVICE_UNAVAILABLE = 'unavailable';

/**
 * Sample rate the engine contract carries. The WAV header claims 16 kHz mono
 * Int16; System.Speech resamples if handed anything else.
 */
const SAMPLE_RATE = 16000;

/** Model id reported in ready/health: there is no model file to name. */
export const OSDEVICE_MODEL = 'os-device';

/** A runaway recognizer must not hang a service. */
const RECOGNIZE_TIMEOUT_MS = 60_000;

/**
 * Below this recognizer confidence, no transcript is emitted at all.
 *
 * System.Speech's confidence is a real signal, not decoration. On the same
 * real-mic clip that whisper transcribed faithfully, the OS recognizer
 * returned three fragments at 0.02-0.03 confidence, one of which the verse
 * detector then turned into Obadiah 1:5. A wrong reference on the rail is
 * worse than no reference, so the driver drops low-confidence output before
 * it can reach the detector. The synthetic validation clip scores ~0.46.
 * When the script joins several utterances it reports the MINIMUM confidence,
 * so one low-confidence fragment cannot hide behind a confident neighbor.
 */
export const OSDEVICE_MIN_CONFIDENCE = 0.25;

/**
 * Which OS backend (if any) can transcribe on this platform.
 *
 * win32 only, on purpose: System.Speech ships in-box with desktop Windows
 * and is drivable from PowerShell with no install. macOS dictation has no
 * scriptable CLI surface a spawned process can use unattended, and Linux
 * ships no built-in engine at all — both report unavailable with a reason
 * that names the working alternative, never a silent fallback.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {{ supported: boolean, backend: 'winspeech'|null, reason: string }}
 */
export function platformSupport(platform = process.platform) {
  if (platform === 'win32') {
    return { supported: true, backend: 'winspeech', reason: 'System.Speech via PowerShell' };
  }
  if (platform === 'darwin') {
    return {
      supported: false,
      backend: null,
      reason: 'macOS dictation has no unattended CLI surface — use whisper.cpp (Tiny English is 78 MB) instead.',
    };
  }
  return {
    supported: false,
    backend: null,
    reason: 'Linux ships no built-in speech engine — use whisper.cpp (Tiny English is 78 MB) instead.',
  };
}

/**
 * Probe the real backend, not just the platform string.
 *
 * On win32 this runs PowerShell once with the recognition assembly load and
 * a default-recognizer check; a machine with PowerShell removed or with no
 * desktop recognizer installed fails HERE with a sentence, not mid-service
 * with an empty transcript. Everywhere else the platform gate answers.
 *
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform]
 * @param {Function} [options.spawnSyncImpl] injectable (tests script it)
 * @returns {{ ok: boolean, reason: string }}
 */
export function probeOsDevice({ platform = process.platform, spawnSyncImpl = spawnSync } = {}) {
  const support = platformSupport(platform);
  if (!support.supported) return { ok: false, reason: support.reason };

  let result;
  try {
    result = spawnSyncImpl('powershell.exe', PROBE_ARGS, { encoding: 'utf8', timeout: 15000 });
  } catch {
    return { ok: false, reason: 'PowerShell could not be started — OS speech needs powershell.exe.' };
  }
  // A missing binary does not throw from spawnSync: it returns { error, status: null }.
  if (result?.error) {
    if (result.error?.code === 'ENOENT') {
      return { ok: false, reason: 'powershell.exe was not found — install PowerShell to use OS speech.' };
    }
    return { ok: false, reason: `OS speech probe failed (${result.error?.message ?? result.error}) — use whisper.cpp instead.` };
  }
  if (result?.status === 0) return { ok: true, reason: support.reason };
  const detail = typeof result?.stderr === 'string' && result.stderr.trim()
    ? result.stderr.trim().split('\n').pop()
    : 'no desktop speech recognizer responded';
  return { ok: false, reason: `OS speech probe failed (${detail}) — install a Windows display language with speech recognition, or use whisper.cpp instead.` };
}

/** Probe argv: load System.Speech and require a default recognizer. Exported for tests. */
export const PROBE_ARGS = Object.freeze([
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-Command',
  "Add-Type -AssemblyName System.Speech; " +
  "$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine; " +
  "if ($null -eq $r) { exit 3 }; " +
  "exit 0",
]);

/**
 * Build the per-segment PowerShell recognition script.
 *
 * Linear on purpose: load assembly, pick recognizer (requested culture or
 * default), dictation grammar, file input, then Recognize in a loop until
 * EOF so a chunk with more than one utterance is not truncated to its first
 * phrase. The loop writes one single-line JSON object with the joined text
 * and minimum confidence. A recognition with no result prints nothing and
 * exits 0 — the driver reports that as a no-transcript error, exactly like
 * the whisper driver's empty-stdout path. Anything the try block throws
 * prints `ERROR:<message>` on stderr and exits 2; a missing recognizer prints
 * `ERROR:no recognizer` and exits 3.
 *
 * NOTE on `New-Object ... -ArgumentList $culture`: the parenthesised form
 * `New-Object Type($arg)` is parsed as a COMMAND invocation, so it throws
 * CommandNotFoundException and a test that only greps the culture string
 * cannot catch it — the -ArgumentList form below is asserted literally.
 *
 * @param {{ wavPath: string, language?: string }} options
 * @returns {string} the .ps1 source
 */
export function recognizeScript({ wavPath, language = 'auto' } = {}) {
  const culture = typeof language === 'string' && language && language !== 'auto'
    ? `$culture = New-Object System.Globalization.CultureInfo('${language.replace(/'/g, "''")}'); ` +
      `try { $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine -ArgumentList $culture } ` +
      `catch { $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine };`
    : `$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine;`;
  return [
    `try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; } catch { };`,
    `$ErrorActionPreference = 'Stop';`,
    `Add-Type -AssemblyName System.Speech;`,
    `try {`,
    culture,
    `if ($null -eq $rec) { [Console]::Error.WriteLine('ERROR:no recognizer'); exit 3 }`,
    `$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar));`,
    `$rec.SetInputToWaveFile('${String(wavPath).replace(/'/g, "''")}');`,
    `$texts = @();`,
    `$confs = @();`,
    `while ($true) {`,
    `try { $res = $rec.Recognize() } catch {`,
    `if ($_.Exception.Message -notmatch 'No audio input') { [Console]::Error.WriteLine(\"ERROR:$($_.Exception.Message)\"); exit 2 }`,
    `break`,
    `}`,
    `if ($null -eq $res) { break }`,
    `if ($res.Text) { $texts += $res.Text; $confs += $res.Confidence }`,
    `}`,
    `$rec.Dispose();`,
    `if ($texts.Count -eq 0) { exit 0 }`,
    `$min = [Math]::Round(($confs | Measure-Object -Minimum).Minimum, 3);`,
    `$out = @{ text = ($texts -join ' '); confidence = $min };`,
    `Write-Output ($out | ConvertTo-Json -Compress);`,
    `} catch {`,
    `[Console]::Error.WriteLine("ERROR:$($_.Exception.Message)");`,
    `exit 2;`,
    `}`,
  ].join('\r\n');
}

/**
 * Parse one PowerShell recognition answer into contract text.
 *
 * @param {string|Buffer} stdout
 * @returns {{ text: string, confidence: number }|null} null when unparseable or empty
 */
export function parseRecognition(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? '').trim());
  } catch {
    return null;
  }
  const text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
  if (!text) return null;
  let confidence = Number(parsed?.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  return { text, confidence: Math.min(1, Math.max(0, confidence)) };
}

/**
 * Create the OS on-device engine.
 *
 * @param {object} options
 * @param {import('../bus.js').MessageBus} options.bus
 * @param {NodeJS.Platform} [options.platform]
 * @param {Function} [options.spawnImpl] injectable child-process spawner (tests script it)
 * @param {Function} [options.spawnSyncImpl] injectable probe spawner (tests script it)
 * @param {string} [options.language] BCP-47 tag or 'auto'
 * @returns {object} an engine implementing the v1 contract
 */
export function createOsDeviceEngine({
  bus,
  platform = process.platform,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  language = 'auto',
  timeoutMs = RECOGNIZE_TIMEOUT_MS,
} = {}) {
  const probe = probeOsDevice({ platform, spawnSyncImpl });
  if (!probe.ok) {
    throw Object.assign(new Error(`OS speech unavailable: ${probe.reason}`), {
      code: OSDEVICE_UNAVAILABLE,
    });
  }

  const sessions = new Map();
  /** Per-session clock, so segment timestamps advance across utterances. */
  const elapsed = new Map();
  const activeChildren = new Set();
  let queue = Promise.resolve();
  let isClosed = false;

  function recognizeWav(wav, sessionLanguage) {
    return new Promise((resolve, reject) => {
      let scratch;
      try {
        scratch = mkdtempSync(path.join(tmpdir(), 'ld-osspeech-'));
      } catch {
        reject(Object.assign(new Error('could not create a scratch directory for OS speech'), {
          code: 'transcribe-failed',
        }));
        return;
      }

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        try {
          rmSync(scratch, { recursive: true, force: true });
        } catch {
          // Best effort: the OS reclaims temp; a leftover must never fail transcription.
        }
      };

      const wavPath = path.join(scratch, 'segment.wav');
      const scriptPath = path.join(scratch, 'recognize.ps1');
      try {
        writeFileSync(wavPath, wav);
        writeFileSync(scriptPath, recognizeScript({ wavPath, language: sessionLanguage }));
      } catch {
        cleanup();
        reject(Object.assign(new Error('could not stage audio for OS speech'), {
          code: 'transcribe-failed',
        }));
        return;
      }

      let child;
      try {
        child = spawnImpl('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath,
        ], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
        activeChildren.add(child);
      } catch {
        cleanup();
        reject(Object.assign(new Error('could not start OS speech'), { code: 'spawn-failed' }));
        return;
      }

      const stdout = [];
      const stderr = [];
      let stderrBytes = 0;
      let settled = false;
      const cleanupChild = () => activeChildren.delete(child);

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupChild();
        // Kill first, remove on 'close': on Windows the recognizer still
        // holds segment.wav open, so removing here would hit a sharing
        // violation (swallowed by the catch) and leave sermon audio in temp.
        // 'close' always follows a kill and owns the single cleanup above.
        try { child.kill('SIGKILL'); } catch { /* already gone — its close cleans up */ }
        clearTimeout(timer);
        reject(Object.assign(new Error('OS speech timed out'), { code: 'timeout' }));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => stdout.push(chunk));
      // Captured, never printed: the recognizer's stderr can carry decoded text.
      child.stderr.on('data', (chunk) => {
        if (stderrBytes < 65536) stderr.push(chunk);
        stderrBytes += chunk?.length ?? 0;
      });

      child.on('error', () => {
        if (settled) return;
        settled = true;
        cleanupChild();
        clearTimeout(timer);
        reject(Object.assign(new Error('OS speech could not run'), { code: 'spawn-failed' }));
        // No cleanup here: the 'close' that follows a dead child always runs
        // it (single choke point below).
      });

      child.on('close', (code) => {
        // ALWAYS runs, even after a timeout or error already settled the
        // promise: this is the single choke point for temp removal, so no
        // path can leave segment audio behind. Idempotent via `cleaned`.
        const out = Buffer.concat(stdout).toString('utf8');
        cleanup();
        if (settled) return;
        settled = true;
        cleanupChild();
        clearTimeout(timer);
        if (code !== 0) {
          reject(Object.assign(new Error(`OS speech exited ${code}`), { code: 'transcribe-failed' }));
          return;
        }
        resolve(out);
      });
    });
  }

  function createSessionInternal(options = {}) {
    const sessionId = randomUUID();
    const session = { sessionId, model: OSDEVICE_MODEL, sampleRate: SAMPLE_RATE, language: options.language || language };
    sessions.set(sessionId, session);
    elapsed.set(sessionId, 0);
    return {
      session,
      messages: [{
        t: 'ready',
        sessionId,
        model: OSDEVICE_MODEL,
        sampleRate: SAMPLE_RATE,
        wordTimestamps: false,
      }],
    };
  }

  return {
    kind: 'osdevice',
    backend: 'osdevice',
    model: OSDEVICE_MODEL,

    health() {
      return {
        model: OSDEVICE_MODEL,
        backend: 'osdevice',
        wordTimestamps: false,
        biasSupport: false,
        binaryReady: true,
        weightsReady: true,
      };
    },

    models() {
      return [];
    },

    createSession: createSessionInternal,

    closeSession(sessionId) {
      elapsed.delete(sessionId);
      return sessions.delete(sessionId);
    },

    hasSession(sessionId) {
      return sessions.has(sessionId);
    },

    close() {
      isClosed = true;
      for (const child of activeChildren) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      activeChildren.clear();
      sessions.clear();
      elapsed.clear();
    },

    transcribe(body = {}) {
      if (isClosed) {
        return Promise.resolve({
          sessionId: body?.sessionId || '',
          messages: [{
            t: 'error',
            sessionId: body?.sessionId || '',
            code: 'engine-closed',
            message: 'Speech engine has closed.',
            fatal: false,
          }],
        });
      }

      const task = async () => {
        if (isClosed) {
          return {
            sessionId: body?.sessionId || '',
            messages: [{
              t: 'error',
              sessionId: body?.sessionId || '',
              code: 'engine-closed',
              message: 'Speech engine has closed.',
              fatal: false,
            }],
          };
        }

        const frames = Array.isArray(body.frames) ? body.frames : [];
        if (frames.length === 0) {
          return { sessionId: body.sessionId || '', messages: [] };
        }

        let sessionId = body.sessionId;
        const created = [];
        if (!sessionId || !sessions.has(sessionId)) {
          const opened = createSessionInternal({});
          sessionId = opened.session.sessionId;
          created.push(...opened.messages);
        }
        const session = sessions.get(sessionId);
        const offsetMs = elapsed.get(sessionId) || 0;

        const wav = framesToWav(frames);
        const audioDurationMs = Math.round(((wav.length - 44) / (SAMPLE_RATE * 2)) * 1000);

        try {
          const stdout = await recognizeWav(wav, session?.language);
          const recognition = parseRecognition(stdout);

          if (!recognition) {
            if (sessions.has(sessionId)) {
              elapsed.set(sessionId, offsetMs + audioDurationMs);
            }
            return {
              sessionId,
              messages: [
                ...created,
                {
                  t: 'error',
                  sessionId,
                  code: 'no-transcript',
                  message: 'The OS speech engine decoded this segment but produced no transcript.',
                  fatal: false,
                },
              ],
            };
          }

          if (recognition.confidence < OSDEVICE_MIN_CONFIDENCE) {
            if (sessions.has(sessionId)) {
              elapsed.set(sessionId, offsetMs + audioDurationMs);
            }
            return {
              sessionId,
              messages: [
                ...created,
                {
                  t: 'error',
                  sessionId,
                  code: 'low-confidence',
                  message:
                    'The OS recognizer was not confident enough to offer a transcript. ' +
                    'Use whisper.cpp for this audio, or speak closer to the microphone.',
                  fatal: false,
                },
              ],
            };
          }

          if (sessions.has(sessionId)) {
            elapsed.set(sessionId, offsetMs + audioDurationMs);
          }

          return {
            sessionId,
            messages: [
              ...created,
              {
                t: 'final',
                sessionId,
                text: recognition.text,
                tStartMs: offsetMs,
                tEndMs: offsetMs + audioDurationMs,
                // Same additive shape as the whisper driver (the schema requires
                // only the t* names; the two drivers emit one shape).
                startMs: offsetMs,
                endMs: offsetMs + audioDurationMs,
              },
            ],
          };
        } catch (error) {
          if (sessions.has(sessionId)) {
            elapsed.set(sessionId, offsetMs + audioDurationMs);
          }
          if (error?.code === OSDEVICE_UNAVAILABLE) {
            return {
              sessionId,
              messages: [
                ...created,
                {
                  t: 'error',
                  sessionId,
                  code: error.code,
                  message: 'The OS speech engine is unavailable.',
                  fatal: false,
                },
              ],
            };
          }
          return {
            sessionId,
            messages: [
              ...created,
              {
                t: 'error',
                sessionId,
                code: error?.code || 'transcribe-failed',
                message: 'The OS speech engine could not transcribe this segment.',
                fatal: false,
              },
            ],
          };
        }
      };

      const chained = queue.then(task, task);
      queue = chained.catch(() => {});
      return chained;
    },
  };
}

export default createOsDeviceEngine;
