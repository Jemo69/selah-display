/**
 * speech-engine/test/lanOptIn.test.js — the trusted-LAN opt-in.
 *
 * The default posture is loopback-only. A LAN bind requires BOTH an explicit
 * flag/env AND an explicit token. These tests prove the gate and the POST-
 * OPT-IN contract with local sockets only: no second machine, no real LAN,
 * no model, no download. A LAN Origin is simulated in the headers and the
 * non-loopback peer predicate is tested at its pure chokepoint.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { TOKEN_HEADER } from '../../shared/speech/protocol.js';
import {
  createSpeechEngineServer,
  assertLoopbackBindHost,
  isLanOptIn,
  LAN_OPT_IN_ENV,
  LAN_OPT_IN_FLAG,
  isLanAllowedOrigin,
} from '../server.js';
import {
  attachWebSocketTransport,
  WS_PATH,
  WS_TOKEN_PARAM,
  isPeerAllowed,
  isLoopbackPeer,
} from '../wsTransport.js';
import { createFakeEngine } from '../fakeEngine.js';
import { createMessageBus } from '../bus.js';

const INDEX_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
const TOKEN = 'l'.repeat(32) + 'a'.repeat(32);
const LAN_ORIGIN = 'http://192.168.1.42:4000';
const KNOWN_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';

const openHandles = [];
afterEach(async () => {
  while (openHandles.length > 0) {
    const record = openHandles.pop();
    try {
      record.stream?.close();
    } catch { /* best effort */ }
    try {
      await record.handle?.close();
    } catch { /* best effort */ }
  }
});

/** A non-loopback address to bind, found locally; no other machine needed. */
function localLanAddress() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const entry of addresses || []) {
      if (entry.family === 'IPv4' && !entry.internal && entry.address) return entry.address;
    }
  }
  return '0.0.0.0'; // wildcard is still a non-loopback bind in a container
}

function request({ host, port, path: reqPath = '/v1/health', headers = {}, method = 'GET' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path: reqPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* text only */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Raw upgrade so rejection statuses (403/401) are observable. */
function rawUpgrade(port, { origin, token = TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': KNOWN_KEY,
    };
    if (origin !== undefined) headers.origin = origin;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: `${WS_PATH}?${WS_TOKEN_PARAM}=${encodeURIComponent(token)}`,
      headers,
      agent: false,
    });
    req.on('upgrade', (res, socket) => resolve({ status: res.statusCode, socket }));
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* text */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Run index.js with a controlled env; resolve on exit (never hangs a suite). */
function launchEngine(args, envOverrides) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX_JS, ...args], {
      env: { ...process.env, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('engine did not exit in time'));
    }, 5000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('LAN opt-in is explicit: flag/env values, not a host string', () => {
  assert.equal(isLanOptIn(true), true); // --allow-lan
  assert.equal(isLanOptIn('1'), true); // LD_SPEECH_ALLOW_LAN=1
  assert.equal(isLanOptIn('true'), true);
  assert.equal(isLanOptIn('0'), false);
  assert.equal(isLanOptIn('192.168.1.20'), false);
  assert.equal(isLanOptIn(undefined), false);
  assert.equal(LAN_OPT_IN_FLAG, '--allow-lan');
  assert.equal(LAN_OPT_IN_ENV, 'LD_SPEECH_ALLOW_LAN');

  // Default gate is untouched: no opt-in means non-loopback throws.
  assert.throws(() => createSpeechEngineServer({ token: TOKEN, host: '192.168.1.5' }), /loopback/i);
  assert.throws(() => assertLoopbackBindHost('10.0.0.7'), /loopback/i);
});

test('opt-in without a token is refused, at both the server and the entry point', async () => {
  assert.throws(
    () => createSpeechEngineServer({ token: undefined, host: '0.0.0.0', allowLan: true }),
    /token/i
  );

  const flag = await launchEngine(['--host=0.0.0.0', LAN_OPT_IN_FLAG], {
    LD_SPEECH_TOKEN: '',
    LD_SPEECH_ALLOW_LAN: '',
  });
  assert.equal(flag.code, 2, `expected exit 2, got ${flag.code}: ${flag.stderr}`);
  assert.match(flag.stderr, /allow-lan requires LD_SPEECH_TOKEN/i);
  assert.doesNotMatch(flag.stderr, new RegExp(TOKEN), 'a token must never be printed');

  const env = await launchEngine(['--host=0.0.0.0'], {
    [LAN_OPT_IN_ENV]: '1',
    LD_SPEECH_TOKEN: '',
  });
  assert.equal(env.code, 2, `expected exit 2, got ${env.code}: ${env.stderr}`);
  assert.match(env.stderr, /allow-lan requires LD_SPEECH_TOKEN/i);
});

test('explicit allow-lan + token binds a non-loopback address and accepts tokened traffic', async () => {
  const host = localLanAddress();
  const bus = createMessageBus();
  const engine = createFakeEngine({ bus });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  let handle;
  try {
    handle = createSpeechEngineServer({ token: TOKEN, host, allowLan: true, bus, engine });
    const address = await handle.listen(0, host);
    openHandles.push({ handle });
    assert.equal(address.host, host);
    assert.notEqual(address.host, '127.0.0.1');
    assert.ok(
      warnings.some((line) => /LAN OPT-IN/.test(line) && line.includes(host)),
      'the LAN bind must produce an auditable warning naming the host'
    );
    assert.ok(
      warnings.every((line) => !line.includes(TOKEN)),
      'the audit line must never carry the token'
    );

    const ok = await request({
      host,
      port: address.port,
      headers: { [TOKEN_HEADER]: TOKEN, origin: LAN_ORIGIN },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.status, 'ok');

    // Token gates are unchanged by the LAN opt-in.
    const missing = await request({ host, port: address.port, headers: { origin: LAN_ORIGIN } });
    assert.equal(missing.status, 401);
    const wrong = await request({ host, port: address.port, headers: { [TOKEN_HEADER]: 'wrong' } });
    assert.equal(wrong.status, 403);
  } finally {
    console.warn = originalWarn;
  }
});

test('the LAN opt-in widens WS Origin/peer gates; default still refuses both', async () => {
  const bus = createMessageBus();
  const engine = createFakeEngine({ bus });
  const handle = createSpeechEngineServer({ token: TOKEN, host: '127.0.0.1' });
  const address = await handle.listen(0, '127.0.0.1');
  openHandles.push({ handle });

  const defaultStream = attachWebSocketTransport(handle.server, {
    token: TOKEN, bus, engine, host: '127.0.0.1',
  });
  openHandles.push({ stream: defaultStream });
  const refused = await rawUpgrade(address.port, { origin: LAN_ORIGIN });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error, 'origin-not-allowed');

  // The opt-in is per engine process (one transport per server in practice):
  // attach the LAN-mode transport to a second server for the accept case.
  const lanBus = createMessageBus();
  const lanEngine = createFakeEngine({ bus: lanBus });
  const lanHandle = createSpeechEngineServer({ token: TOKEN, host: '127.0.0.1', allowLan: true });
  const lanAddress = await lanHandle.listen(0, '127.0.0.1');
  openHandles.push({ handle: lanHandle });
  const lanStream = attachWebSocketTransport(lanHandle.server, {
    token: TOKEN,
    bus: lanBus,
    engine: lanEngine,
    host: '127.0.0.1',
    allowLan: true,
  });
  openHandles.push({ stream: lanStream });
  const accepted = await rawUpgrade(lanAddress.port, { origin: LAN_ORIGIN });
  assert.equal(accepted.status, 101);
  accepted.socket.destroy();

  // Pure peer gate: a LAN peer is refused by default, accepted with opt-in.
  assert.equal(isLoopbackPeer('192.168.1.42'), false);
  assert.equal(isLoopbackPeer('::ffff:127.0.0.1'), true);
  assert.equal(isPeerAllowed('192.168.1.42', false), false);
  assert.equal(isPeerAllowed('192.168.1.42', true), true);
  assert.equal(isLanAllowedOrigin(LAN_ORIGIN), true);
  assert.equal(isLanAllowedOrigin('file:///etc/passwd'), false);
});
