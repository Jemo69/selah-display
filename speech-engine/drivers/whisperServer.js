/**
 * speech-engine/drivers/whisperServer.js — the persistent whisper.cpp driver.
 *
 * WHY THIS EXISTS. The CLI driver spawns `whisper-cli` once per segment. That
 * is the right trade for a 31 MiB tiny model, but a production model is
 * hundreds of megabytes and model load dominates a 15-second chunk. Measured
 * on the 24-minute sermon: large-v3-turbo Q8 was ~0.98x real time on a 3-minute
 * clip and ~1.15x on a 35-second chunk from a fresh process — it cannot keep
 * up. `whisper-server` loads the model once and serves `/inference`; this
 * driver keeps that process alive for the engine session.
 *
 * THE CONTRACT IS THE SAME as whispercpp.js — kind/backend/health/models/
 * createSession/closeSession/hasSession/transcribe/close — so server.js,
 * index.js, the supervisor, and the renderer do not know which driver ran.
 *
 * AUDIO AND LOGS. The server gets one WAV per segment over loopback multipart;
 * no audio reaches a log. The server's stdout/stderr are captured only for
 * startup diagnostics and never printed: whisper can echo decoded text there.
 *
 * WHAT IT DOES NOT DO. No word timestamps, no prompt bias. Those are stated
 * false in health/models, same as the CLI driver, so the lane gates stay honest.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import catalog from '../../shared/speech/models.catalog.json' with { type: 'json' };
import {
  ENGINE_UNAVAILABLE,
  WHISPER_ROWS,
  framesToWav,
  resolveWeights,
} from './whispercpp.js';

const SAMPLE_RATE = 16000;
const START_TIMEOUT_MS = 60_000;
const TRANSCRIBE_TIMEOUT_MS = 120_000;

/** Server binary name per platform. */
export function serverBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
}

/** Is a usable whisper-server binary present at `dir`? */
export function hasServerBinary(dir) {
  if (typeof dir !== 'string' || !dir) return false;
  const full = path.join(dir, serverBinaryName());
  if (!existsSync(full)) return false;
  try {
    return statSync(full).size > 0;
  } catch {
    return false;
  }
}

/** Parse `/inference` JSON into contract text; null for empty/bracketed noise. */
export function parseServerAnswer(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw ?? '').trim());
  } catch {
    return null;
  }
  const text = typeof parsed?.text === 'string'
    ? parsed.text.replace(/\[[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  return text || null;
}

/** Reserve one loopback port, then release it for the child. */
function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.unref();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Is this buffered segment effectively silence?
 *
 * The WS transport finalizes on 500 ms of silence even when nobody spoke. A
 * whisper model can answer that silence with a hallucinated word (tiny says
 * "you"). Transcribing it is waste; showing it is worse. The floor is half the
 * transport's speech threshold so quiet speech still goes to the model.
 */
/** Is an already-built WAV silent? */
export function wavIsSilent(wav, floor = 0.005) {
  const pcm = wav.subarray(44);
  if (pcm.length < 2) return true;
  let energy = 0;
  let samples = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const value = pcm.readInt16LE(i) / 32768;
    energy += value * value;
    samples += 1;
  }
  return Math.sqrt(energy / samples) < floor;
}

/** Is a list of PCM frames silent? */
export function framesAreSilent(frames, floor = 0.005) {
  return wavIsSilent(framesToWav(frames), floor);
}

/**
 * Create the persistent whisper.cpp engine.
 *
 * @param {object} options
 * @param {object} options.bus
 * @param {string} options.binDir
 * @param {string} options.modelsDir
 * @param {string} [options.modelId]
 * @param {string} [options.language]
 * @param {number} [options.threads]
 * @returns {object}
 */
export function createWhisperServerEngine({
  bus,
  binDir,
  modelsDir,
  modelId,
  language = 'auto',
  threads = Math.max(1, Math.min(8, Math.floor((os.cpus()?.length || 4) / 2))),
} = {}) {
  if (!hasServerBinary(binDir)) {
    throw Object.assign(new Error('whisper-server binary not installed'), { code: ENGINE_UNAVAILABLE });
  }

  const model = modelId || catalog.defaultModelId;
  const weights = resolveWeights(modelsDir, model);
  if (!weights) {
    throw Object.assign(new Error(`whisper.cpp weights not installed: ${model}`), {
      code: ENGINE_UNAVAILABLE,
    });
  }

  const sessions = new Map();
  const elapsed = new Map();
  let queue = Promise.resolve();
  let isClosed = false;
  let server = null;
  let starting = null;
  let pendingChild = null;

  function alive(child) {
    return Boolean(child) && child.exitCode === null && child.signalCode === null;
  }

  function stopServer() {
    for (const child of new Set([server?.child, pendingChild])) {
      if (child) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }
    server = null;
    pendingChild = null;
    starting = null;
  }

  function closedResult(sessionId, created = []) {
    return {
      sessionId: sessionId || '',
      messages: [
        ...created,
        {
          t: 'error',
          sessionId: sessionId || '',
          code: 'engine-closed',
          message: 'Speech engine has closed.',
          fatal: false,
        },
      ],
    };
  }

  async function startServer(sessionLanguage) {
    if (isClosed) throw Object.assign(new Error('Speech engine has closed.'), { code: 'engine-closed' });
    if (starting) {
      await starting;
    }
    const requested = typeof sessionLanguage === 'string' && sessionLanguage && sessionLanguage !== 'auto'
      ? sessionLanguage
      : (language || 'auto');

    if (server) {
      if (alive(server.child) && (
        requested === 'auto' ||
        server.language === requested ||
        server.language === 'auto'
      )) return server;
      stopServer();
    }

    const attempt = (async () => {
      const port = await freePort();
      const args = [
        '-m', weights,
        '-t', String(threads),
        '--host', '127.0.0.1',
        '--port', String(port),
        '-nt',
        '-l', requested,
      ];
      const child = spawn(path.join(binDir, serverBinaryName()), args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      pendingChild = child;
      let stderr = '';
      let stdout = '';
      let spawnError = null;
      child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
      child.stdout?.on('data', (chunk) => { stdout = (stdout + chunk).slice(-4000); });
      child.on('error', (error) => { spawnError = error; });
      child.on('exit', () => {
        if (server?.child === child) server = null;
        if (pendingChild === child) pendingChild = null;
      });

      const deadline = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (isClosed) {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          throw Object.assign(new Error('Speech engine has closed.'), { code: 'engine-closed' });
        }
        if (spawnError) {
          throw Object.assign(new Error(`whisper-server could not start: ${spawnError.code || 'error'}`), {
            code: 'server-start-failed',
          });
        }
        if (!alive(child)) {
          throw Object.assign(
            new Error(`whisper-server exited ${child.exitCode ?? child.signalCode ?? 'unknown'} before ready`),
            { code: 'server-start-failed' }
          );
        }
        try {
          const res = await fetch(`http://127.0.0.1:${port}/`, {
            signal: AbortSignal.timeout(1000),
          });
          const body = await res.text();
          if (res.ok && /Whisper\.cpp/i.test(body)) {
            pendingChild = null;
            server = { child, port, language: requested };
            return server;
          }
        } catch {
          // still loading the model
        }
        await delay(150);
      }

      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      throw Object.assign(new Error('whisper-server did not become ready'), { code: 'server-start-failed' });
    })().catch((error) => {
      // Do not leave a permanently rejected promise in `starting`: the next
      // segment must be allowed to retry (e.g. a transient port collision).
      if (pendingChild) {
        try { pendingChild.kill('SIGKILL'); } catch { /* already gone */ }
        pendingChild = null;
      }
      throw error;
    });

    starting = attempt;
    try {
      return await attempt;
    } finally {
      if (starting === attempt) starting = null;
    }
  }

  function createSessionInternal(options = {}) {
    const sessionId = randomUUID();
    const session = {
      sessionId,
      model,
      sampleRate: SAMPLE_RATE,
      language: options.language || language,
    };
    sessions.set(sessionId, session);
    elapsed.set(sessionId, 0);
    return {
      session,
      messages: [{
        t: 'ready',
        sessionId,
        model,
        sampleRate: SAMPLE_RATE,
        wordTimestamps: false,
      }],
    };
  }

  async function transcribeOne(body = {}) {
    if (isClosed) return closedResult(body.sessionId);
    const frames = Array.isArray(body.frames) ? body.frames : [];
    if (frames.length === 0) return { sessionId: body.sessionId || '', messages: [] };

    let sessionId = body.sessionId;
    const created = [];
    if (!sessionId || !sessions.has(sessionId)) {
      const opened = createSessionInternal({});
      sessionId = opened.session.sessionId;
      created.push(...opened.messages);
    }
    if (isClosed) return closedResult(sessionId, created);
    const session = sessions.get(sessionId);
    const offsetMs = elapsed.get(sessionId) || 0;
    const wav = framesToWav(frames);
    const audioDurationMs = Math.round(((wav.length - 44) / (SAMPLE_RATE * 2)) * 1000);

    // Silence is not a segment. Do not load/query the model for it, and do not
    // emit a final that a hallucinated word could turn into a suggestion.
    if (wavIsSilent(wav)) {
      if (sessions.has(sessionId)) elapsed.set(sessionId, offsetMs + audioDurationMs);
      return { sessionId, messages: created };
    }

    try {
      const { port } = await startServer(session?.language);
      if (isClosed) return closedResult(sessionId, created);
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'segment.wav');
      form.append('response_format', 'json');
      const response = await fetch(`http://127.0.0.1:${port}/inference`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw Object.assign(new Error(`whisper-server HTTP ${response.status}`), {
          code: 'transcribe-failed',
        });
      }
      const text = parseServerAnswer(await response.text());
      if (isClosed) return closedResult(sessionId, created);
      if (sessions.has(sessionId)) {
        elapsed.set(sessionId, offsetMs + audioDurationMs);
      }
      if (!text) {
        return {
          sessionId,
          messages: [
            ...created,
            {
              t: 'error',
              sessionId,
              code: 'no-transcript',
              message: 'The speech engine decoded this segment but produced no transcript.',
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
            t: 'final',
            sessionId,
            text,
            tStartMs: offsetMs,
            tEndMs: offsetMs + audioDurationMs,
            startMs: offsetMs,
            endMs: offsetMs + audioDurationMs,
          },
        ],
      };
    } catch (error) {
      if (isClosed) return closedResult(sessionId, created);
      if (sessions.has(sessionId)) {
        elapsed.set(sessionId, offsetMs + audioDurationMs);
      }
      const code = error?.code || (error?.name === 'TimeoutError' ? 'timeout' : 'transcribe-failed');
      return {
        sessionId,
        messages: [
          ...created,
          {
            t: 'error',
            sessionId,
            code,
            message: 'The speech engine could not transcribe this segment.',
            fatal: false,
          },
        ],
      };
    }
  }

  return {
    kind: 'whispercpp-server',
    backend: process.env.LD_SPEECH_COMPUTE_BACKEND || 'whispercpp',
    model,

    health() {
      return {
        model,
        backend: process.env.LD_SPEECH_COMPUTE_BACKEND || 'whispercpp',
        wordTimestamps: false,
        biasSupport: false,
        binaryReady: hasServerBinary(binDir),
        weightsReady: Boolean(resolveWeights(modelsDir, model)),
      };
    },

    models() {
      return WHISPER_ROWS.map((row) => ({
        ...row,
        installed: Boolean(resolveWeights(modelsDir, row.id)),
      }));
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
      stopServer();
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
      const task = () => (isClosed ? Promise.resolve(closedResult(body?.sessionId)) : transcribeOne(body));
      const chained = queue.then(task, task);
      queue = chained.catch(() => {});
      return chained;
    },
  };
}

export default createWhisperServerEngine;
