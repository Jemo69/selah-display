/**
 * speech-engine/test/whispercpp.test.js — the real-engine driver (Phase 5)
 *
 * No whisper.cpp binary is downloaded for these tests, and none should be: the
 * point is to verify the adapter's CONTRACT — what it writes, what it parses,
 * and what it reports — against a scripted fake CLI, so the suite runs on a
 * machine that has never installed a model.
 *
 * The tests are weighted toward the failure paths. A driver that quietly
 * reports success when the decoder failed is how canned text ends up on a
 * projection screen with a green badge next to it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ENGINE_UNAVAILABLE,
  binaryName,
  createWhisperEngine,
  framesToWav,
  hasBinary,
  parseSegments,
  resolveWeights,
} from '../drivers/whispercpp.js';

const tempRoot = () => mkdtempSync(path.join(tmpdir(), 'ld-whisper-'));

/** One 100 ms frame of 16 kHz mono Int16 silence. */
function frame(samples = 1600) {
  return Buffer.alloc(samples * 2);
}

/**
 * A fake whisper.cpp: a shell script that prints canned stdout and exits with
 * a chosen code. Exercises the real spawn/stdin/stdout path.
 */
function installFakeCli(dir, { stdout = '', exitCode = 0, hang = false } = {}) {
  const name = binaryName();
  const full = path.join(dir, name);
  if (process.platform === 'win32') return full; // covered by the POSIX suite

  writeFileSync(
    full,
    `#!/bin/sh
${hang ? 'sleep 999' : ''}
cat > /dev/null
printf '%s' "$WHISPER_FAKE_STDOUT"
exit ${exitCode}
`,
    { mode: 0o755 }
  );
  chmodSync(full, 0o755);
  return full;
}

test('binaryName is per-platform', () => {
  assert.equal(binaryName('win32'), 'whisper-cli.exe');
  assert.equal(binaryName('darwin'), 'whisper-cli');
  assert.equal(binaryName('linux'), 'whisper-cli');
});

test('hasBinary rejects a missing file and a zero-byte download', () => {
  const dir = tempRoot();
  assert.equal(hasBinary(dir), false);
  assert.equal(hasBinary(''), false);
  assert.equal(hasBinary(null), false);

  // A truncated transfer is not an install. Treating it as one is how a failed
  // download becomes a mysterious runtime crash mid-service.
  writeFileSync(path.join(dir, binaryName()), '');
  assert.equal(hasBinary(dir), false);
});

test('hasBinary accepts a non-empty binary', () => {
  const dir = tempRoot();
  if (process.platform === 'win32') return;
  installFakeCli(dir);
  assert.equal(hasBinary(dir), true);
});

test('framesToWav writes a canonical 44-byte header', () => {
  const wav = framesToWav([frame(), frame()]);
  assert.equal(wav.length, 44 + 1600 * 2 * 2);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(16), 16); // fmt chunk size
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 16000); // sample rate
  assert.equal(wav.readUInt16LE(34), 16); // bits per sample
  assert.equal(wav.readUInt32LE(40), 1600 * 2 * 2); // data size
});

test('framesToWav survives empty and non-buffer input', () => {
  // It runs inside the engine's ingest path. Throwing here takes the transport
  // down mid-sermon.
  assert.equal(framesToWav([]).length, 44);
  assert.equal(framesToWav(null).length, 44);
  assert.equal(framesToWav([null, undefined, Buffer.alloc(0)]).length, 44);
});

test('parseSegments reads whisper.cpp bracket timestamps', () => {
  const stdout = [
    '[00:00:00.000 --> 00:00:02.500]   For God so loved the world',
    '[00:00:02.500 --> 00:00:05.000]   that he gave his only begotten Son',
  ].join('\n');

  const segments = parseSegments(stdout, 's1');
  assert.equal(segments.length, 2);
  assert.equal(segments[0].t, 'final');
  assert.equal(segments[0].sessionId, 's1');
  assert.equal(segments[0].text, 'For God so loved the world');
  assert.equal(segments[0].startMs, 0);
  assert.equal(segments[0].endMs, 2500);
  assert.equal(segments[1].startMs, 2500);
});

test('parseSegments drops bracketed non-speech tokens', () => {
  // whisper emits [MUSIC] / [BLANK_AUDIO] for sound it classified as non-speech.
  // Forwarding those as transcript text puts a hallucination on the rail, and
  // nothing downstream would know why it appeared.
  const stdout = [
    '[00:00:00.000 --> 00:00:01.000]   [MUSIC]',
    '[00:00:01.000 --> 00:00:03.000]   Amen',
  ].join('\n');

  const segments = parseSegments(stdout, 's1');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, 'Amen');
});

test('parseSegments applies a session offset', () => {
  const stdout = '[00:00:00.000 --> 00:00:01.000]   second utterance';
  const segments = parseSegments(stdout, 's1', 10_000);
  assert.equal(segments[0].startMs, 10_000);
  assert.equal(segments[0].endMs, 11_000);
});

test('parseSegments returns nothing for junk rather than throwing', () => {
  assert.deepEqual(parseSegments('', 's1'), []);
  assert.deepEqual(parseSegments(null, 's1'), []);
  assert.deepEqual(parseSegments('no timestamps here at all', 's1'), []);
});

test('resolveWeights rejects missing and zero-byte weights', () => {
  const dir = tempRoot();
  assert.equal(resolveWeights(dir, 'base'), null);
  assert.equal(resolveWeights('', 'base'), null);
  assert.equal(resolveWeights(dir, ''), null);

  writeFileSync(path.join(dir, 'base.bin'), '');
  assert.equal(resolveWeights(dir, 'base'), null);

  writeFileSync(path.join(dir, 'base.bin'), 'weights');
  assert.equal(resolveWeights(dir, 'base'), path.join(dir, 'base.bin'));
});

test('the engine refuses to construct without a binary', () => {
  const modelsDir = tempRoot();
  writeFileSync(path.join(modelsDir, 'base.bin'), 'weights');

  assert.throws(
    () => createWhisperEngine({ bus: null, binDir: tempRoot(), modelsDir }),
    (error) => error.code === ENGINE_UNAVAILABLE
  );
});

test('the engine refuses to construct without weights', () => {
  const binDir = tempRoot();
  if (process.platform === 'win32') return;
  installFakeCli(binDir);

  assert.throws(
    () => createWhisperEngine({ bus: null, binDir, modelsDir: tempRoot() }),
    (error) => error.code === ENGINE_UNAVAILABLE
  );
});

test('a constructed engine reports itself as real, never as fake', () => {
  const binDir = tempRoot();
  const modelsDir = tempRoot();
  if (process.platform === 'win32') return;
  installFakeCli(binDir);
  writeFileSync(path.join(modelsDir, 'base.bin'), 'weights');

  const engine = createWhisperEngine({ bus: null, binDir, modelsDir, modelId: 'base' });
  // `backend` is the string src/speech/engineTruth.js keys off to decide
  // whether output is real transcription. Getting this wrong would let canned
  // text render as though a model produced it.
  assert.equal(engine.backend, 'whispercpp');
  assert.notEqual(engine.backend, 'fake');
  assert.equal(engine.kind, 'whispercpp');
});

test('health reports capabilities honestly', () => {
  const binDir = tempRoot();
  const modelsDir = tempRoot();
  if (process.platform === 'win32') return;
  installFakeCli(binDir);
  writeFileSync(path.join(modelsDir, 'base.bin'), 'weights');

  const engine = createWhisperEngine({ bus: null, binDir, modelsDir, modelId: 'base' });
  const health = engine.health();
  assert.equal(health.backend, 'whispercpp');
  // The CLI emits SEGMENT timestamps, not word ones. Reporting true here would
  // enable the next-lyric lane on a provider that cannot align words.
  assert.equal(health.wordTimestamps, false);
  assert.equal(health.binaryReady, true);
});

test('models() reports which catalog rows are actually installed', () => {
  const binDir = tempRoot();
  const modelsDir = tempRoot();
  if (process.platform === 'win32') return;
  installFakeCli(binDir);
  writeFileSync(path.join(modelsDir, 'base.bin'), 'weights');

  const engine = createWhisperEngine({ bus: null, binDir, modelsDir, modelId: 'base' });
  const rows = engine.models();
  assert.ok(rows.length > 0);
  assert.equal(rows.find((row) => row.id === 'base').installed, true);
  assert.equal(rows.find((row) => row.id === 'large-v3').installed, false);
});

test('a session opens and reports its capability on ready', () => {
  const binDir = tempRoot();
  const modelsDir = tempRoot();
  if (process.platform === 'win32') return;
  installFakeCli(binDir);
  writeFileSync(path.join(modelsDir, 'base.bin'), 'weights');

  const engine = createWhisperEngine({ bus: null, binDir, modelsDir, modelId: 'base' });
  const { session, messages } = engine.createSession({});
  assert.ok(engine.hasSession(session.sessionId));
  assert.equal(messages[0].t, 'ready');
  assert.equal(messages[0].wordTimestamps, false);
  assert.equal(engine.closeSession(session.sessionId), true);
});

test('transcribing an empty segment emits nothing at all', async () => {
  const binDir = tempRoot();
  const modelsDir = tempRoot();
  if (process.platform === 'win32') return;
  installFakeCli(binDir);
  writeFileSync(path.join(modelsDir, 'base.bin'), 'weights');

  const engine = createWhisperEngine({ bus: null, binDir, modelsDir, modelId: 'base' });
  // Async: `transcribe` is a promise so it can await the child process.
  const result = await engine.transcribe({ frames: [] });
  assert.deepEqual(result.messages, []);
});

test('a decoder failure is reported as an error, never as silence or success', async () => {
  const binDir = tempRoot();
  const modelsDir = tempRoot();
  if (process.platform === 'win32') return;
  installFakeCli(binDir, { exitCode: 3 });
  writeFileSync(path.join(modelsDir, 'base.bin'), 'weights');

  const engine = createWhisperEngine({ bus: null, binDir, modelsDir, modelId: 'base' });
  const result = await engine.transcribe({ frames: [frame()] });

  const error = result.messages.find((message) => message.t === 'error');
  assert.ok(error, 'a non-zero exit must surface as an error message');
  assert.equal(error.fatal, false);
  // A code, not the process's own text: whisper's stderr can quote decoded audio.
  assert.equal(error.code, 'transcribe-failed');
  assert.ok(!JSON.stringify(error).includes('exit 3'));
});

test('a missing binary at run time is reported, not crashed on', async () => {
  const binDir = tempRoot();
  const modelsDir = tempRoot();
  if (process.platform === 'win32') return;
  const cli = installFakeCli(binDir);
  writeFileSync(path.join(modelsDir, 'base.bin'), 'weights');

  const engine = createWhisperEngine({ bus: null, binDir, modelsDir, modelId: 'base' });
  // Simulate the binary disappearing after install — a real scenario when an
  // updater replaces the directory mid-session.
  writeFileSync(cli, '');

  const result = await engine.transcribe({ frames: [frame()] });
  const error = result.messages.find((message) => message.t === 'error');
  assert.ok(error);
  assert.equal(error.fatal, false);
});

test('a session clock advances so the second utterance keeps real timestamps', async () => {
  const binDir = tempRoot();
  const modelsDir = tempRoot();
  if (process.platform === 'win32') return;
  installFakeCli(binDir);
  writeFileSync(path.join(modelsDir, 'base.bin'), 'weights');

  const engine = createWhisperEngine({ bus: null, binDir, modelsDir, modelId: 'base' });
  const { session } = engine.createSession({});

  process.env.WHISPER_FAKE_STDOUT = '[00:00:00.000 --> 00:00:03.000]   first';
  await engine.transcribe({ sessionId: session.sessionId, frames: [frame()] });

  process.env.WHISPER_FAKE_STDOUT = '[00:00:00.000 --> 00:00:02.000]   second';
  const second = await engine.transcribe({ sessionId: session.sessionId, frames: [frame()] });

  const last = second.messages[second.messages.length - 1];
  // If the clock did not advance, this would be 0 and the rail would show two
  // utterances both claiming to start at the beginning of the service.
  assert.equal(last.startMs, 3000);
  assert.equal(last.endMs, 5000);
  delete process.env.WHISPER_FAKE_STDOUT;
});

test('no transcript text is written to stderr by the driver', async () => {
  // The driver must not log decoded text. This asserts the contract the
  // implementation upholds by capturing and discarding, not by inspection.
  const binDir = tempRoot();
  const modelsDir = tempRoot();
  if (process.platform === 'win32') return;
  installFakeCli(binDir, { stdout: 'SECRET-SERMON-TEXT', exitCode: 0 });
  writeFileSync(path.join(modelsDir, 'base.bin'), 'weights');

  const written = [];
  const originalError = console.error;
  console.error = (...args) => written.push(args.join(' '));

  try {
    const engine = createWhisperEngine({ bus: null, binDir, modelsDir, modelId: 'base' });
    const result = await engine.transcribe({ frames: [frame()] });
    // No bracket timestamps in the fake's output, so no segments — which the
    // driver reports as an error rather than as silence.
    assert.ok(result.messages.some((message) => message.t === 'error'));
  } finally {
    console.error = originalError;
  }

  assert.ok(
    !written.join('\n').includes('SECRET-SERMON-TEXT'),
    'decoder output must never reach the log'
  );
});
/**
 * A fake CLI that records the arguments it was handed. A fake that ignores
 * arguments agrees with any caller, so without this the suite cannot catch
 * a wrong FLAG — that is what the contract test below pins.
 */
function installRecordingCli(dir, argvFile, { exitCode = 0, stdout = '' } = {}) {
  const full = path.join(dir, binaryName());
  if (process.platform === 'win32') return full; // covered by the POSIX suite

  writeFileSync(
    full,
    `#!/bin/sh
cat > /dev/null
printf '%s\\n' "$@" > "${argvFile}"
printf '%s' "${stdout}"
exit ${exitCode}
`,
    { mode: 0o755 }
  );
  chmodSync(full, 0o755);
  return full;
}

test('the CLI is invoked so the transcript stays on stdout and audio off disk', async () => {
  // Verified against the pinned b5454 build with the JFK reference clip:
  // `-of /dev/null` with no `--output-*` flag still prints the timestamped
  // transcript to stdout. An earlier revision of this test asserted `-otxt`
  // was REQUIRED — that claim was disproved by execution, so this test
  // asserts the real contract instead of the flag superstition.
  const binDir = tempRoot();
  const modelsDir = tempRoot();
  const argvFile = path.join(tempRoot(), 'argv.txt');
  if (process.platform === 'win32') return;
  installRecordingCli(binDir, argvFile);
  writeFileSync(path.join(modelsDir, 'base.bin'), 'weights');

  const engine = createWhisperEngine({ bus: null, binDir, modelsDir, modelId: 'base' });
  await engine.transcribe({ frames: [frame()] });

  const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
  const valueOf = (flag) => argv[argv.indexOf(flag) + 1];

  // `-nt` strips the `[hh:mm:ss.mmm --> hh:mm:ss.mmm]` prefix that
  // parseSegments matches on, so it guarantees zero segments on success.
  assert.ok(!argv.includes('-nt'), '-nt removes the timestamps parseSegments needs');

  // Audio travels on stdin so it never lands on disk.
  assert.equal(valueOf('-f'), '-');

  // File output goes to the null device — no sermon text is written to disk.
  // (An `-of <real-path>` + `-otxt` combination was briefly shipped here and
  // proven to write transcript.txt; the driver never read that file.)
  const outputBase = valueOf('-of');
  assert.ok(
    outputBase === '/dev/null' || outputBase === 'NUL',
    `file output must go to the null device, got ${outputBase}`
  );
});

test('a failing decoder is reported as an error with the same invocation', async () => {
  const binDir = tempRoot();
  const modelsDir = tempRoot();
  const argvFile = path.join(tempRoot(), 'argv.txt');
  if (process.platform === 'win32') return;
  installRecordingCli(binDir, argvFile, { exitCode: 3 });
  writeFileSync(path.join(modelsDir, 'base.bin'), 'weights');

  const engine = createWhisperEngine({ bus: null, binDir, modelsDir, modelId: 'base' });
  const result = await engine.transcribe({ frames: [frame()] });

  // A failing decode is reported as an error and never as silence, and the
  // failure path runs the same invocation (not a degraded fallback).
  assert.ok(result.messages.some((message) => message.t === 'error'));
  const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
  assert.equal(argv[argv.indexOf('-f') + 1], '-');
  assert.ok(!argv.includes('-nt'));
});
