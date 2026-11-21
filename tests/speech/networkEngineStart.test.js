// @vitest-environment node
/**
 * tests/speech/networkEngineStart.test.js — the trusted-LAN transport in the
 * main process, against a FAKE remote engine (an in-process HTTP+WS server on
 * loopback). No second machine, no real LAN, no local fork.
 *
 * The engine used here has no binary and no weights in the throwaway
 * userData. A local start would refuse with engine-not-installed — so a
 * successful network start is proof that the local path was never entered.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { ipcHandles, relayed, getMainWindow } = vi.hoisted(() => {
  const handles = {};
  const relayed = [];
  return {
    ipcHandles: handles,
    relayed,
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => relayed.push({ channel, payload }) },
    }),
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => globalThis.__NETWORK_IPC_USER_DATA__ },
  ipcMain: { handle: (channel, handler) => { ipcHandles[channel] = handler; } },
}));

import { registerSpeechIpc } from '../../main/speechIpc.js';
import {
  createSpeechEngineServer,
  DEFAULT_BIND_HOST,
} from '../../speech-engine/server.js';
import { attachWebSocketTransport, WS_PATH, WS_TOKEN_PARAM } from '../../speech-engine/wsTransport.js';
import { createFakeEngine } from '../../speech-engine/fakeEngine.js';
import { createMessageBus } from '../../speech-engine/bus.js';

const TOKEN = 'n'.repeat(64);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lyric-network-ipc-'));
const MODELS_DIR = path.join(USER_DATA, 'models');

let fakeRemote = null;
let endpoint = null;

const relayedOn = (channel) =>
  relayed.filter((entry) => entry.channel === channel).map((entry) => entry.payload);

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Connect to the fake remote's WS stream, exactly as the renderer would. */
function connectRemote(dial) {
  const url =
    `${dial.endpoint.replace(/^http:/i, 'ws:')}${dial.path}` +
    `?${WS_TOKEN_PARAM}=${encodeURIComponent(dial.token)}`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.onopen = socket.onerror = null;
      reject(new Error('remote WebSocket did not open'));
    }, 8000);
    socket.onopen = () => { clearTimeout(timer); resolve(socket); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('remote WebSocket failed')); };
  });
}

describe('speech:start with where=network', () => {
  beforeAll(async () => {
    globalThis.__NETWORK_IPC_USER_DATA__ = USER_DATA;
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    registerSpeechIpc({
      getMainWindow,
      engineRoots: [path.join(REPO_ROOT, 'speech-engine')],
      modelsDir: MODELS_DIR,
      historyDir: path.join(USER_DATA, 'history'),
    });

    // The fake remote engine: real HTTP health + real WS audio, both tokened.
    const bus = createMessageBus();
    const engine = createFakeEngine({ bus });
    const handle = createSpeechEngineServer({
      token: TOKEN,
      host: DEFAULT_BIND_HOST,
      bus,
      engine,
    });
    const address = await handle.listen(0, DEFAULT_BIND_HOST);
    const stream = attachWebSocketTransport(handle.server, {
      token: TOKEN, bus, engine, host: DEFAULT_BIND_HOST,
    });
    endpoint = `http://${address.host}:${address.port}`;
    fakeRemote = { handle, stream };
  });

  afterAll(async () => {
    try { await ipcHandles['speech:stop'](); } catch { /* best effort */ }
    fakeRemote?.stream?.close();
    await fakeRemote?.handle?.close();
    fs.rmSync(USER_DATA, { recursive: true, force: true });
  });

  it('refuses a missing endpoint/token before any transport or local fork exists', async () => {
    const noEndpoint = await ipcHandles['speech:start'](null, {
      enabled: true,
      where: 'network',
      providerId: 'whispercpp',
    });
    expect(noEndpoint).toMatchObject({ ok: false, started: false, reason: 'network-endpoint-missing' });
    expect(noEndpoint.engine).toBeNull();
    expect(relayedOn('speech:error').at(-1).code).toBe('network-endpoint-missing');

    const noToken = await ipcHandles['speech:start'](null, {
      enabled: true,
      where: 'network',
      networkEndpoint: endpoint,
    });
    expect(noToken).toMatchObject({ ok: false, reason: 'network-token-missing' });
    expect(noToken.engine).toBeNull();

    const state = await ipcHandles['speech:get-state']();
    expect(state.running).toBe(false);
    expect(state.installState.engine.installed).toBe(false);
  }, 30000);

  it.each([
    ['ftp://192.168.1.5:4731', 'network-endpoint-invalid'],
    ['http://user:pass@192.168.1.5:4731', 'network-endpoint-credentials'],
    ['192.168.1.5:4731', 'network-endpoint-invalid'],
  ])('refuses the endpoint %s with %s', async (networkEndpoint, code) => {
    const reply = await ipcHandles['speech:start'](null, {
      enabled: true,
      where: 'network',
      networkEndpoint,
      networkToken: TOKEN,
    });
    expect(reply).toMatchObject({ ok: false, reason: code });
    expect(reply.engine).toBeNull();
  }, 30000);

  it('refuses an unauthorized remote with a clear code', async () => {
    const reply = await ipcHandles['speech:start'](null, {
      enabled: true,
      where: 'network',
      networkEndpoint: endpoint,
      networkToken: 'x'.repeat(64),
    });
    expect(reply).toMatchObject({ ok: false, reason: 'network-unauthorized' });
    expect(reply.engine).toBeNull();
    expect(relayedOn('speech:error').at(-1).code).toBe('network-unauthorized');
  }, 30000);

  it('returns the remote dial-in, health-checks once, and forks nothing local', async () => {
    const reply = await ipcHandles['speech:start'](null, {
      enabled: true,
      where: 'network',
      providerId: 'whispercpp',
      networkEndpoint: `${endpoint}/`,
      networkToken: TOKEN,
    });

    expect(reply.ok).toBe(true);
    expect(reply.started).toBe(true);
    expect(reply.reason).toBe('remote-connected');
    expect(reply.mode).toBe('network');
    // Exactly the local dial-in shape, plus an evidence flag for the label.
    expect(reply.engine).toEqual({
      endpoint,
      token: TOKEN,
      path: WS_PATH,
      remote: true,
    });
    expect(reply.health).toMatchObject({ remote: true, status: 'ok' });

    // No local process: no binary is installed in this userData, so the local
    // start path could not have succeeded. The supervisor confirms it.
    const state = await ipcHandles['speech:get-state']();
    expect(state.running).toBe(false);
    expect(state.remote).toBe(true);
    expect(state.installState.engine.installed).toBe(false);
    // Health came from the remote probe, not a forked local engine.
    expect(relayedOn('speech:health').at(-1)).toMatchObject({ remote: true });
  }, 30000);

  it('relays remote transcript messages over the fake remote WebSocket', async () => {
    const state = await ipcHandles['speech:get-state']();
    expect(state.remote).toBe(true);
    const dial = state.engine ?? { endpoint, path: WS_PATH, token: TOKEN };
    const socket = await connectRemote(dial);
    const messages = [];
    socket.onmessage = (event) => {
      const text = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
      messages.push(JSON.parse(text));
    };
    await waitFor(() => messages.some((message) => message.t === 'ready'));
    const frame = new Int16Array(1600); // silence trips the canned endpointing
    for (let i = 0; i < 8; i += 1) socket.send(frame);
    await waitFor(() => messages.some((message) => message.t === 'final'));
    expect(messages.some((message) => message.t === 'final' && typeof message.text === 'string')).toBe(true);
    socket.close();
  }, 30000);

  it('speech:stop tears the session down without killing a local process', async () => {
    const result = await ipcHandles['speech:stop']();
    expect(result).toMatchObject({ ok: true, stopped: false, remote: true });
    const state = await ipcHandles['speech:get-state']();
    expect(state.running).toBe(false);
    expect(state.remote).toBe(false);
    expect(relayedOn('speech:health').at(-1)).toBeNull();
  }, 30000);

  it('speech:test-network is read-only and reports clear status', async () => {
    const good = await ipcHandles['speech:test-network'](null, {
      networkEndpoint: endpoint,
      networkToken: TOKEN,
    });
    expect(good).toMatchObject({ ok: true, code: 'ok' });
    expect(good.health).toMatchObject({ remote: true });
    expect(good.message).toMatch(/audio will cross/i);

    const bad = await ipcHandles['speech:test-network'](null, {
      networkEndpoint: endpoint,
      networkToken: 'x'.repeat(64),
    });
    expect(bad).toMatchObject({ ok: false, code: 'network-unauthorized' });

    const state = await ipcHandles['speech:get-state']();
    expect(state.remote).toBe(false); // a test never claims a running engine
    expect(state.running).toBe(false);
  }, 30000);

  it('cloud still refuses honestly (no local fallback)', async () => {
    const reply = await ipcHandles['speech:start'](null, {
      enabled: true,
      where: 'cloud',
      networkEndpoint: endpoint,
      networkToken: TOKEN,
    });
    expect(reply).toMatchObject({ ok: false, reason: 'where-not-implemented' });
    expect(reply.engine).toBeNull();
  }, 30000);
});
