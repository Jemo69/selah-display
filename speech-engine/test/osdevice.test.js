/**
 * speech-engine/test/osdevice.test.js — the OS on-device driver.
 *
 * No Windows machine is needed for these tests and none should be: the point
 * is to verify the driver's CONTRACT — what it probes, what it spawns, what
 * it parses, and what it reports — against a scripted fake PowerShell, so the
 * suite runs on a machine that has never seen System.Speech.
 *
 * The one thing this suite cannot prove is the PowerShell script itself
 * against a real recognizer. That runs on Windows (see the PR runbook), and
 * the script is deliberately linear so there is little to hide: load
 * assembly, default recognizer, dictation grammar, file in, one JSON line
 * out. Everything around that line IS proven here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  OSDEVICE_UNAVAILABLE,
  OSDEVICE_MODEL,
  platformSupport,
  probeOsDevice,
  PROBE_ARGS,
  recognizeScript,
  parseRecognition,
  createOsDeviceEngine,
} from '../drivers/osdevice.js';
import { validateMessage } from '../../shared/speech/protocol.js';

/** One 100 ms frame of 16 kHz mono Int16 silence. */
function frame(samples = 1600) {
  return Buffer.alloc(samples * 2);
}

/**
 * A fake powershell.exe: captures argv, then emits canned stdout and exits
 * with the chosen code. Exercises the real spawn/stdout/exit path including
 * the temp WAV + script staging.
 */
function installFakePowershell(captured, { stdout = '', stderr = '', exitCode = 0, hang = false } = {}) {
  return (bin, argv) => {
    captured.push({ bin, argv });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // A real SIGKILL is always followed by 'close' — the fake honors that
    // so the timeout path (kill first, remove on close) is exercised, not
    // just asserted.
    child.kill = () => {
      process.nextTick(() => child.emit('close', null));
    };
    if (!hang) {
      process.nextTick(() => {
        // stderr BEFORE close: the exact shape that crashed the driver with a
        // ReferenceError before `stderr` was declared (B1).
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        if (stdout) child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', exitCode);
      });
    }
    return child;
  };
}

const windowsProbeOk = () => ({ status: 0, stdout: '', stderr: '' });

test('platformSupport: only win32 is supported, with reasons that name the alternative', () => {
  const win = platformSupport('win32');
  assert.equal(win.supported, true);
  assert.equal(win.backend, 'winspeech');

  for (const platform of ['darwin', 'linux', 'freebsd']) {
    const support = platformSupport(platform);
    assert.equal(support.supported, false);
    assert.equal(support.backend, null);
    assert.match(support.reason, /whisper\.cpp/, `${platform} names the working alternative`);
  }
});

test('probeOsDevice short-circuits off Windows without spawning anything', () => {
  let spawned = 0;
  const verdict = probeOsDevice({
    platform: 'linux',
    spawnSyncImpl: () => { spawned += 1; return { status: 0 }; },
  });
  assert.equal(verdict.ok, false);
  assert.equal(spawned, 0);
});

test('probeOsDevice passes on a healthy Windows probe, fails otherwise', () => {
  assert.equal(
    probeOsDevice({ platform: 'win32', spawnSyncImpl: () => windowsProbeOk() }).ok,
    true
  );

  const failing = probeOsDevice({
    platform: 'win32',
    spawnSyncImpl: () => ({ status: 3, stdout: '', stderr: 'nope' }),
  });
  assert.equal(failing.ok, false);
  assert.match(failing.reason, /probe failed/);

  const thrown = probeOsDevice({
    platform: 'win32',
    spawnSyncImpl: () => { throw new Error('nope'); },
  });
  assert.equal(thrown.ok, false);
  assert.match(thrown.reason, /PowerShell/);
});

test('a missing powershell.exe names PowerShell, not the recognizer', () => {
  // spawnSync does NOT throw for a missing binary: it returns
  // { error: ENOENT, status: null }. Without this branch the probe blamed
  // the recognizer and told the operator to install a display language.
  const missing = Object.assign(new Error('spawnSync powershell.exe ENOENT'), { code: 'ENOENT' });
  const verdict = probeOsDevice({
    platform: 'win32',
    spawnSyncImpl: () => ({ error: missing, status: null, stdout: '', stderr: '' }),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /powershell\.exe was not found/i);
});

test('the probe asks for exactly the recognition assembly plus a default recognizer', () => {
  const joined = PROBE_ARGS.join(' ');
  assert.ok(joined.includes('System.Speech'), 'loads the recognition assembly');
  assert.ok(joined.includes('SpeechRecognitionEngine'), 'requires a recognizer');
  assert.ok(PROBE_ARGS.includes('-NonInteractive'), 'never prompts');
});

test('recognizeScript wires file input, dictation grammar, and single-line JSON output', () => {
  const script = recognizeScript({ wavPath: 'C:\\tmp\\segment.wav', language: 'auto' });
  assert.ok(script.includes('SetInputToWaveFile'), 'file input (System.Speech cannot read stdin)');
  assert.ok(script.includes('DictationGrammar'), 'free dictation, not a command grammar');
  assert.ok(script.includes('ConvertTo-Json -Compress'), 'one JSON line on stdout');
  assert.ok(
    script.includes('try { [Console]::OutputEncoding'),
    'console re-encoding degrades instead of aborting the script'
  );
  assert.ok(
    !/catch \{ \},/.test(script),
    'the encoding guard ends with a statement terminator, not an array comma'
  );
  assert.ok(script.includes('exit 2;'), 'script errors exit 2 with ERROR: on stderr');
  assert.ok(script.includes('C:\\tmp\\segment.wav'), 'the staged WAV path');
  assert.ok(!script.includes('$culture'), 'auto uses the default recognizer');
  assert.ok(script.includes('while ($true)'), 'loops until the WAV reaches EOF');
  assert.ok(script.includes('$texts += $res.Text'), 'keeps every utterance in the chunk');
  assert.ok(script.includes("join ' '"), 'joins utterances into one transcript');
});

test('recognizeScript quotes paths and cultures, and honors a requested language', () => {
  const script = recognizeScript({ wavPath: "C:\\o'hara\\s.wav", language: 'de-DE' });
  assert.ok(script.includes("o''hara"), 'single quotes are doubled');
  assert.ok(script.includes('de-DE'), 'requested culture is tried first');
  assert.ok(
    script.includes('SpeechRecognitionEngine -ArgumentList $culture'),
    'constructor args ride -ArgumentList (the parenthesised form parses as a command invocation)'
  );
  assert.ok(script.includes('catch'), 'a missing culture falls back to default');
});

test('parseRecognition accepts one JSON line, clamps confidence, rejects the rest', () => {
  assert.deepEqual(parseRecognition('{"text":"hello","confidence":0.9}'), {
    text: 'hello',
    confidence: 0.9,
  });
  assert.deepEqual(parseRecognition('{"text":"hi","confidence":9}').confidence, 1);
  assert.deepEqual(parseRecognition('{"text":"hi"}').confidence, 0.5);
  assert.equal(parseRecognition('not json'), null);
  assert.equal(parseRecognition('{"text":"   "}'), null);
  assert.equal(parseRecognition(''), null);
});

test('the engine refuses to construct off Windows with the probe reason', () => {
  assert.throws(
    () => createOsDeviceEngine({ bus: null, platform: 'linux' }),
    (error) => error?.code === OSDEVICE_UNAVAILABLE && /Linux/.test(error.message)
  );
});

test('a recognition becomes a contract-valid final spanning the chunk', async () => {
  const captured = [];
  const engine = createOsDeviceEngine({
    bus: null,
    platform: 'win32',
    spawnImpl: installFakePowershell(captured, {
      stdout: '{"text":"amen","confidence":0.81}',
    }),
    spawnSyncImpl: () => windowsProbeOk(),
  });

  const result = await engine.transcribe({ frames: [frame()] });
  assert.equal(result.messages.length, 2);
  const [ready, final] = result.messages;
  assert.equal(ready.t, 'ready');
  assert.equal(ready.model, OSDEVICE_MODEL);
  assert.ok(validateMessage(ready).ok, 'ready passes the wire schema');

  assert.equal(final.t, 'final');
  assert.equal(final.text, 'amen');
  assert.equal(final.tStartMs, 0);
  assert.equal(final.tEndMs, 100, 'one 100 ms frame spans 100 ms');
  assert.ok(validateMessage(final).ok, 'final passes the wire schema');

  // The spawn is PowerShell with -File (never -Command with audio inline),
  // and the script it ran names the staged WAV.
  assert.equal(captured.length, 1);
  assert.match(captured[0].bin, /powershell/i);
  const fileIndex = captured[0].argv.indexOf('-File');
  assert.ok(fileIndex !== -1, 'script runs from -File');
  assert.match(captured[0].argv[fileIndex + 1], /\.ps1$/);
});

test('low-confidence recognition is refused, never forwarded as text', async () => {
  const engine = createOsDeviceEngine({
    bus: null,
    platform: 'win32',
    spawnImpl: installFakePowershell([], {
      stdout: '{"text":"But leave","confidence":0.02}',
    }),
    spawnSyncImpl: () => windowsProbeOk(),
  });

  const result = await engine.transcribe({ frames: [frame()] });
  assert.equal(result.messages.some((m) => m.t === 'final'), false, 'no final reaches the rail');
  const error = result.messages.find((m) => m.t === 'error');
  assert.equal(error.code, 'low-confidence');
  assert.equal(error.fatal, false);
  assert.ok(validateMessage(error).ok, 'low-confidence error passes the wire schema');
});

test('timestamps advance across utterances on one session', async () => {
  const captured = [];
  const engine = createOsDeviceEngine({
    bus: null,
    platform: 'win32',
    spawnImpl: installFakePowershell(captured, { stdout: '{"text":"amen"}' }),
    spawnSyncImpl: () => windowsProbeOk(),
  });

  const first = await engine.transcribe({ frames: [frame()] });
  const session = first.sessionId;
  const second = await engine.transcribe({ sessionId: session, frames: [frame(), frame()] });

  const last = second.messages[second.messages.length - 1];
  assert.equal(last.tStartMs, 100);
  assert.equal(last.tEndMs, 300);
});

test('stderr output never crashes the driver and never reaches the transcript', async () => {
  const captured = [];
  const engine = createOsDeviceEngine({
    bus: null,
    platform: 'win32',
    spawnImpl: installFakePowershell(captured, {
      stdout: '{"text":"amen"}',
      stderr: 'Read-Host: verbose noise from the shell',
    }),
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  const result = await engine.transcribe({ frames: [frame()] });
  const final = result.messages.find((m) => m.t === 'final');
  assert.ok(final, 'transcript survives shell noise on stderr');
  assert.equal(final.text, 'amen');
  assert.ok(validateMessage(final).ok);
});

test('error messages are contract-valid', async () => {
  const failing = createOsDeviceEngine({
    bus: null,
    platform: 'win32',
    spawnImpl: installFakePowershell([], { exitCode: 2, stderr: 'ERROR:boom' }),
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  const failed = await failing.transcribe({ frames: [frame()] });
  const errors = failed.messages.filter((m) => m.t === 'error');
  assert.ok(errors.length > 0);
  for (const message of errors) {
    assert.ok(validateMessage(message).ok, 'every error passes the wire schema');
    assert.equal(typeof message.fatal, 'boolean');
  }
});

test('no scratch directory survives failure or timeout', async () => {
  const { readdirSync } = await import('node:fs');
  const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith('ld-osspeech-'));
  const before = new Set(leftovers());

  const failing = createOsDeviceEngine({
    bus: null,
    platform: 'win32',
    spawnImpl: installFakePowershell([], { exitCode: 2 }),
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  await failing.transcribe({ frames: [frame()] });
  assert.deepEqual(leftovers().filter((n) => !before.has(n)), [], 'failure cleans up');

  const hanging = createOsDeviceEngine({
    bus: null,
    platform: 'win32',
    spawnImpl: installFakePowershell([], { hang: true }),
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
    timeoutMs: 50,
  });
  const timedOut = await hanging.transcribe({ frames: [frame()] });
  assert.ok(timedOut.messages.some((m) => m.t === 'error' && m.code === 'timeout'));
  assert.deepEqual(leftovers().filter((n) => !before.has(n)), [], 'timeout cleans up');
});

test('empty recognition and decoder failure are errors, never silence', async () => {
  const empty = createOsDeviceEngine({
    bus: null,
    platform: 'win32',
    spawnImpl: installFakePowershell([], { stdout: '' }),
    spawnSyncImpl: () => windowsProbeOk(),
  });
  const noTranscript = await empty.transcribe({ frames: [frame()] });
  assert.ok(noTranscript.messages.some((m) => m.t === 'error' && m.code === 'no-transcript'));

  const failing = createOsDeviceEngine({
    bus: null,
    platform: 'win32',
    spawnImpl: installFakePowershell([], { exitCode: 2 }),
    spawnSyncImpl: () => windowsProbeOk(),
  });
  const failed = await failing.transcribe({ frames: [frame()] });
  assert.ok(failed.messages.some((m) => m.t === 'error' && m.code === 'transcribe-failed'));
});

test('health reports no timestamps and no bias, with nothing to install', async () => {
  const engine = createOsDeviceEngine({
    bus: null,
    platform: 'win32',
    spawnImpl: installFakePowershell([]),
    spawnSyncImpl: () => windowsProbeOk(),
  });
  const health = engine.health();
  assert.equal(health.backend, 'osdevice');
  assert.equal(health.wordTimestamps, false);
  assert.equal(health.biasSupport, false);
  assert.equal(health.binaryReady, true);
  assert.equal(health.weightsReady, true);
  assert.deepEqual(engine.models(), []);
});

test('no scratch directory survives a transcription', async () => {
  const before = new Set(
    (await import('node:fs').then((fs) => fs.readdirSync(tmpdir()))).filter((n) => n.startsWith('ld-osspeech-'))
  );
  const engine = createOsDeviceEngine({
    bus: null,
    platform: 'win32',
    spawnImpl: installFakePowershell([], { stdout: '{"text":"amen"}' }),
    spawnSyncImpl: () => windowsProbeOk(),
  });
  await engine.transcribe({ frames: [frame()] });
  const { readdirSync } = await import('node:fs');
  const leftovers = readdirSync(tmpdir()).filter((n) => n.startsWith('ld-osspeech-') && !before.has(n));
  assert.deepEqual(leftovers, []);
});
