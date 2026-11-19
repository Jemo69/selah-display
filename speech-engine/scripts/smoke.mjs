#!/usr/bin/env node
/**
 * speech-engine/scripts/smoke.mjs — the cheapest proof that real voice reaches
 * real text.
 *
 * WHAT THIS IS. A one-command end-to-end check of the speech engine. It starts
 * the actual `index.js` entry point (the same process Selah's supervisor
 * forks), sends it a committed 3.2-second spoken clip over the real HTTP
 * contract, and compares the returned transcript with the sentence that was
 * spoken using the app's own WER implementation.
 *
 * WHY A COMMITTED CLIP AND NOT A MICROPHONE. A live microphone check needs a
 * human, a quiet room, and a working input device — none of which CI has. The
 * clip is 99 KB, mono 16 kHz PCM, generated once from text, and it costs zero
 * network, zero model download, and about one second of CPU to transcribe.
 * That is enough to prove the full path: audio bytes -> engine HTTP contract ->
 * driver -> recognizer -> final message -> text.
 *
 * WHAT IT DOES NOT PROVE. It does not prove microphone capture, the renderer,
 * or a particular operator's room acoustics. Those paths already have their
 * own tests. This one answers the question that mocked tests cannot: "does the
 * real recognizer turn this voice into the right words on this machine?"
 *
 * PREREQUISITES.
 *   whisper engine: a whisper.cpp binary and one GGML model. If Selah has
 *   installed them, this finds the same `speech-engine/bin` and
 *   `speech-engine/models` folders the app uses. Otherwise pass
 *   `--bin-dir=DIR --models-dir=DIR --model=ID`.
 *
 *   osdevice engine: Windows only, because System.Speech is the backend.
 *   Nothing to install; pass `--engine=osdevice` and the same clip works.
 *
 * COST. No network, no model download, no API key, and no persistent files.
 * The audio is read into memory, framed, and sent; the temp directory is used
 * only by the osdevice driver (Windows requires a WAV path), and it removes
 * its own file when the child exits.
 *
 * USAGE
 *   node speech-engine/scripts/smoke.mjs
 *   node speech-engine/scripts/smoke.mjs --engine=osdevice        # Windows
 *   node speech-engine/scripts/smoke.mjs --model=tiny.en-q5_1 \
 *     --bin-dir=.speech-smoke/bin --models-dir=.speech-smoke/models
 *   npm run speech-smoke
 *
 * EXIT CODES. 0 = the real engine transcribed the clip within the WER budget.
 * 1 = it did not; the printed reason says which half failed.
 */

import { fork } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { SAMPLE_RATE } from '../../shared/speech/protocol.js';
import { werDetail } from '../../shared/wer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(ENGINE_ROOT, '..');
const INDEX_JS = path.join(ENGINE_ROOT, 'index.js');
const DEFAULT_AUDIO = path.join(ENGINE_ROOT, 'test', 'fixtures', 'voice-smoke-16k.wav');

/** The sentence spoken in the committed clip. Keep in step with the fixture. */
const DEFAULT_REFERENCE = 'The Lord is my shepherd, I shall not want.';

/** The lightest English model in Selah's catalog. `prepare-smoke.mjs` fetches it. */
const DEFAULT_MODEL = 'tiny.en-q5_1';

/** 100 ms of 16 kHz mono Int16 — one contract frame. 3200 bytes. */
const FRAME_BYTES = 3200;

/** Startup includes a Windows PowerShell probe; 30 s is generous, not loose. */
const START_TIMEOUT_MS = 30_000;

/** Far beyond a 3-second clip; catches a hung recognizer instead of hanging CI. */
const TRANSCRIBE_TIMEOUT_MS = 90_000;

/** WER budget. Tiny models sometimes drop "the"; more than this is not working. */
const DEFAULT_MAX_WER = 0.25;

/**
 * Parse `--key=value`, `--key value`, and bare `--flag` arguments.
 *
 * Kept deliberately tiny: this is a developer/CI probe, not a CLI framework,
 * and adding one would be the first runtime dependency in this package.
 *
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const match = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    const key = match[1];
    if (match[2] !== undefined) {
      out[key] = match[2];
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      out[key] = argv[i + 1];
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/** Selah's per-user engine folder, matching Electron's userData location. */
function userEngineRoot() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Selah', 'speech-engine');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Selah', 'speech-engine');
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'Selah', 'speech-engine');
}

/** First directory that exists, else the local package folder (for its error). */
function firstExisting(candidates, fallback) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return fallback;
}

function hasWhisperBinary(dir) {
  if (!dir) return false;
  try {
    return statSync(path.join(dir, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli')).size > 0;
  } catch {
    return false;
  }
}

function resolveBinDir(arg) {
  if (arg) return path.resolve(String(arg));
  return firstExisting(
    [
      path.join(REPO_ROOT, '.speech-smoke', 'bin'),
      path.join(ENGINE_ROOT, 'bin'),
      path.join(userEngineRoot(), 'bin'),
    ].filter(hasWhisperBinary),
    path.join(REPO_ROOT, '.speech-smoke', 'bin')
  );
}

function hasModelFile(dir, modelId) {
  if (!dir || !modelId) return false;
  return [`${modelId}.bin`, `ggml-${modelId}.bin`].some((name) => {
    try {
      return statSync(path.join(dir, name)).size > 0;
    } catch {
      return false;
    }
  });
}

function resolveModelsDir(arg, modelId) {
  if (arg) return path.resolve(String(arg));
  return firstExisting(
    [
      path.join(REPO_ROOT, '.speech-smoke', 'models'),
      path.join(ENGINE_ROOT, 'models'),
      path.join(userEngineRoot(), 'models'),
    ].filter((dir) => hasModelFile(dir, modelId)),
    path.join(REPO_ROOT, '.speech-smoke', 'models')
  );
}

/**
 * Read a RIFF/WAVE file and return only the PCM payload and its format.
 *
 * The engine contract is fixed at 16 kHz mono Int16. Checking the header here
 * turns "the fixture was resampled by an editor" into a sentence, instead of a
 * worse transcript that looks like a model problem.
 *
 * @param {Buffer} buffer
 * @returns {{format:number, channels:number, sampleRate:number, bitsPerSample:number, pcm:Buffer}}
 */
function parseWav(buffer) {
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('The audio file is not a RIFF/WAVE file.');
  }

  let fmt = null;
  let pcm = null;
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, buffer.length);

    if (id === 'fmt ') {
      fmt = {
        format: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      pcm = buffer.subarray(start, end);
    }

    // RIFF chunks are word-aligned; an odd chunk is followed by one pad byte.
    offset = start + size + (size % 2);
  }

  if (!fmt || !pcm) throw new Error('The WAV file has no fmt or data chunk.');
  if (fmt.format !== 1) throw new Error(`Unsupported WAV encoding ${fmt.format}; PCM (1) is required.`);
  if (fmt.channels !== 1) throw new Error(`The clip has ${fmt.channels} channels; mono is required.`);
  if (fmt.sampleRate !== SAMPLE_RATE) {
    throw new Error(`The clip is ${fmt.sampleRate} Hz; ${SAMPLE_RATE} Hz is required.`);
  }
  if (fmt.bitsPerSample !== 16) {
    throw new Error(`The clip is ${fmt.bitsPerSample}-bit; 16-bit PCM is required.`);
  }
  if (pcm.length < SAMPLE_RATE) {
    throw new Error('The clip is under half a second long — too short to prove anything.');
  }
  if (pcm.length % 2 !== 0) throw new Error('The PCM payload has an odd byte count.');

  return { ...fmt, pcm };
}

/** Reject a silent file early: a silent "pass" would blame the engine falsely. */
function assertAudible(pcm) {
  let energy = 0;
  let samples = 0;
  for (let i = 0; i + 1 < pcm.length; i += 200) {
    const value = pcm.readInt16LE(i) / 32768;
    energy += value * value;
    samples += 1;
  }
  const rms = samples > 0 ? Math.sqrt(energy / samples) : 0;
  if (rms < 0.002) throw new Error('The clip is effectively silent; the engine cannot transcribe silence.');
  return rms;
}

/** Split PCM into contract-sized frames. The final short frame is zero-padded. */
function toFrames(pcm) {
  const frames = [];
  for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
    const slice = pcm.subarray(offset, offset + FRAME_BYTES);
    const frame = slice.length === FRAME_BYTES
      ? slice
      : Buffer.concat([slice, Buffer.alloc(FRAME_BYTES - slice.length)]);
    frames.push(frame.toString('base64'));
  }
  return frames;
}

/**
 * Fork the real engine entry point and wait for its `ready` IPC message.
 *
 * The token is generated per run and never printed. stdout/stderr are kept
 * only for a startup failure; the driver itself never logs audio or text.
 *
 * @param {{engine:string, binDir:string, modelsDir:string, model:string, language:string}} options
 * @returns {Promise<{child: import('node:child_process').ChildProcess, port: number}>}
 */
function startEngine({ engine, binDir, modelsDir, model, language }) {
  const token = randomBytes(32).toString('hex');
  const env = {
    ...process.env,
    LD_SPEECH_ENGINE: engine,
    LD_SPEECH_HOST: '127.0.0.1',
    LD_SPEECH_PORT: '0',
    LD_SPEECH_TOKEN: token,
    LD_SPEECH_BIN_DIR: binDir,
    LD_SPEECH_MODELS_DIR: modelsDir,
    LD_SPEECH_MODEL: model,
    LD_SPEECH_LANG: language,
  };

  const child = fork(INDEX_JS, [], {
    cwd: REPO_ROOT,
    env,
    silent: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout = (stdout + chunk).slice(-4000); });
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        const detail = (stderr.trim() || stdout.trim()).split('\n').slice(-4).join(' | ');
        reject(new Error(`${error}${detail ? ` — ${detail}` : ''}`));
      } else {
        resolve({ child, port, token });
      }
    };

    const onMessage = (message) => {
      if (message?.status === 'ready' && Number.isInteger(message.port)) {
        finish(null, message.port);
      } else if (message?.status === 'error') {
        finish(new Error(`The engine failed to start (${message.error || 'unknown'}).`));
      }
    };
    const onExit = (code, signal) => {
      finish(new Error(`The engine exited before it was ready (code ${code ?? 'null'}, signal ${signal ?? 'none'}).`));
    };
    const onError = (error) => finish(new Error(`The engine process could not start: ${error.message}`));

    const timer = setTimeout(() => {
      finish(new Error(`The engine did not report ready within ${START_TIMEOUT_MS / 1000}s.`));
    }, START_TIMEOUT_MS);

    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

function httpRequest(base, token, method, route, body) {
  return fetch(`${base}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-ld-speech-token': token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  }).then(async (response) => {
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* reported below */ }
    if (!response.ok) {
      const detail = json?.error || json?.message || text.slice(0, 300);
      throw new Error(`${method} ${route} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    if (json === null) throw new Error(`${method} ${route} returned a non-JSON body.`);
    return json;
  });
}

async function stopEngine(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  // Do not leave a 3-second timer holding the smoke command open after the
  // child has already exited — that turns one wasted second into four.
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    once(child, 'exit').then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

function help() {
  console.log(`Selah speech smoke test — real audio through the real engine.

Usage:
  node speech-engine/scripts/smoke.mjs [options]

Options:
  --engine=whisper|osdevice  engine to run (default: whisper)
  --audio=PATH               WAV to transcribe (default: the committed 3.2 s clip)
  --expect="TEXT"            what the clip says (default follows the committed clip)
  --max-wer=0.25             highest acceptable word error rate
  --model=ID                 whisper model id (default: tiny.en-q5_1, 31 MiB)
  --bin-dir=DIR              whisper.cpp binary directory
  --models-dir=DIR           GGML weights directory
  --language=en              recognizer language (default: en)
  --help                     this text

The default whisper model is the lightest English model in the catalog. Fetch
it plus the pinned whisper.cpp binary into the gitignored .speech-smoke/ folder
with \`npm run speech-smoke:setup\` (41 MiB, one time). Nothing is downloaded by
this script.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return;
  }

  const engine = String(args.engine || process.env.LD_SPEECH_ENGINE || 'whisper').toLowerCase();
  if (engine !== 'whisper' && engine !== 'osdevice') {
    throw new Error(`Unknown engine "${engine}". Use whisper (default) or osdevice (Windows).`);
  }

  const audioPath = path.resolve(String(args.audio || DEFAULT_AUDIO));
  if (!existsSync(audioPath)) throw new Error(`Audio file not found: ${audioPath}`);

  const reference = typeof args.expect === 'string' ? args.expect : DEFAULT_REFERENCE;
  if (typeof args.expect !== 'string' && audioPath !== DEFAULT_AUDIO) {
    throw new Error('A custom --audio needs --expect="the words actually spoken" so the result can be checked.');
  }

  const maxWer = args['max-wer'] === undefined ? DEFAULT_MAX_WER : Number(args['max-wer']);
  if (!Number.isFinite(maxWer) || maxWer < 0) throw new Error('--max-wer must be a non-negative number.');

  const binDir = resolveBinDir(args['bin-dir']);
  const model = String(args.model || process.env.LD_SPEECH_MODEL || DEFAULT_MODEL);
  const modelsDir = resolveModelsDir(args['models-dir'], model);
  const language = String(args.language || 'en');

  const wav = parseWav(readFileSync(audioPath));
  const rms = assertAudible(wav.pcm);
  const frames = toFrames(wav.pcm);
  const audioSeconds = wav.pcm.length / (SAMPLE_RATE * 2);

  console.log('Selah speech smoke test');
  console.log(`  engine        ${engine} (light mode)`);
  console.log(`  audio         ${path.relative(process.cwd(), audioPath)} (${audioSeconds.toFixed(2)}s)`);
  console.log(`  frames        ${frames.length} × ${FRAME_BYTES} bytes (RMS ${rms.toFixed(3)})`);
  if (engine === 'whisper') {
    console.log(`  model         ${model}`);
    console.log(`  binary dir    ${binDir}`);
    console.log(`  models dir    ${modelsDir}`);
    if (!hasWhisperBinary(binDir)) {
      throw new Error(
        `No whisper.cpp binary in ${binDir}. Run \`npm run speech-smoke:setup\` to fetch the light engine, ` +
        'install it from Settings > Speech, or pass --bin-dir=DIR.'
      );
    }
  }

  let child = null;
  try {
    const startedAt = Date.now();
    const { child: engineChild, port, token } = await startEngine({
      engine, binDir, modelsDir, model, language,
    });
    child = engineChild;
    const base = `http://127.0.0.1:${port}`;
    const startupMs = Date.now() - startedAt;

    const health = await httpRequest(base, token, 'GET', '/v1/health');
    if (health.status !== 'ok') throw new Error(`Engine health is ${health.status ?? 'missing'}, not ok.`);
    if (engine === 'whisper' && (health.binaryReady !== true || health.weightsReady !== true)) {
      throw new Error(
        `The engine is not ready (binaryReady=${health.binaryReady}, weightsReady=${health.weightsReady}). ` +
        `Model "${model}" is not installed in ${modelsDir}. ` +
        'Run `npm run speech-smoke:setup` to fetch the 31 MiB light model, or pass --model=ID.'
      );
    }

    const session = await httpRequest(base, token, 'POST', '/v1/session', { language });
    if (!session.sessionId) throw new Error('The engine created no session id.');

    const inferenceStart = Date.now();
    const result = await httpRequest(base, token, 'POST', '/v1/transcribe', {
      sessionId: session.sessionId,
      frames,
    });
    const inferenceMs = Date.now() - inferenceStart;

    await httpRequest(base, token, 'POST', `/v1/session/${encodeURIComponent(session.sessionId)}/close`, {})
      .catch(() => { /* the verdict below is what matters; teardown is best effort */ });

    const messages = Array.isArray(result.messages) ? result.messages : [];
    const errors = messages.filter((message) => message.t === 'error');
    if (errors.length > 0) {
      throw new Error(`The engine returned ${errors.map((error) => error.code || 'error').join(', ')}.`);
    }

    const transcript = messages
      .filter((message) => message.t === 'final')
      .map((message) => message.text)
      .join(' ')
      .trim();
    if (!transcript) throw new Error('The engine returned no final transcript for real speech.');

    const detail = werDetail(transcript, reference);
    const rtf = inferenceMs / (audioSeconds * 1000);

    console.log(`  health        backend=${health.backend} binaryReady=${health.binaryReady} weightsReady=${health.weightsReady}`);
    console.log(`  startup       ${startupMs} ms`);
    console.log(`  transcript    ${JSON.stringify(transcript)}`);
    console.log(`  reference     ${JSON.stringify(reference)}`);
    console.log(`  WER           ${(detail.wer * 100).toFixed(1)}% (${detail.substitutions} sub, ${detail.deletions} del, ${detail.insertions} ins)`);
    console.log(`  inference     ${inferenceMs} ms (${rtf.toFixed(2)}× real time)`);

    if (detail.wer > maxWer) {
      throw new Error(
        `WER ${(detail.wer * 100).toFixed(1)}% is above the ${(maxWer * 100).toFixed(0)}% budget. ` +
        'The engine returned text, but not the words that were spoken.'
      );
    }

    console.log('PASS: real voice became the expected text through the real engine.');
  } finally {
    await stopEngine(child);
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error?.message ?? error}`);
  process.exitCode = 1;
});
