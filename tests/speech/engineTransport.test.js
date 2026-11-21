/**
 * tests/speech/engineTransport.test.js — the renderer's engine
 * bridge (src/speech/engineTransport.js): the speech:start
 * invoke, the bounded upstream queue, the validated downstream,
 * and the guarded teardown.
 *
 * jsdom's WebSocket and mediaDevices are unreliable, so the
 * socket constructor is injected (FakeWebSocket) and the
 * preload bridge is mocked explicitly. The store is the real
 * one — the transport reads `enabled` from it, which is the
 * point.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createEngineTransport,
  MAX_QUEUED_FRAMES,
  WS_TOKEN_PARAM,
  onRemoteEngineMessage,
} from '../../src/speech/engineTransport';
import useSpeechStore, { speechDefaults } from '../../src/context/SpeechStore';

/** A recording stand-in for the browser's native WebSocket. */
class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sendCalls = [];
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sendCalls.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3; // CLOSED
  }
}

const TOKEN = 'd'.repeat(64);
const DIAL = {
  endpoint: 'http://127.0.0.1:4731',
  token: TOKEN,
  path: '/v1/stream',
};

/** The start reply main sends when the engine (already) runs. */
const okReply = () => ({ ok: true, started: true, engine: { ...DIAL } });

const installBridge = (startImpl, stopImpl) => {
  const speech = {
    start: typeof startImpl === 'function' ? startImpl : vi.fn(async () => okReply()),
    stop: typeof stopImpl === 'function' ? stopImpl : vi.fn(async () => ({ ok: true })),
  };
  window.electronAPI = { speech };
  return speech;
};

const resetStore = (overrides = {}) => {
  localStorage.clear();
  useSpeechStore.setState({
    ...speechDefaults(),
    status: 'idle',
    health: null,
    lastError: null,
    ...overrides,
  });
};

const frame = (n = 0) => new Int16Array(1600).fill(n);

const openSocket = async (transport, speech) => {
  const promise = transport.start({ enabled: true });
  await promise;
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  socket.onopen();
  return socket;
};

describe('engineTransport', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    resetStore({ enabled: true });
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('start invokes speech:start with the payload and dials the reply dial-in', async () => {
    const speech = installBridge();
    const transport = createEngineTransport({ WebSocketImpl: FakeWebSocket });

    const outcome = await transport.start({
      enabled: true,
      modelId: 'large-v3',
      providerId: 'whispercpp',
      where: 'local',
    });

    expect(outcome).toEqual({ ok: true, reason: 'dialed' });
    expect(speech.start).toHaveBeenCalledWith({
      enabled: true,
      modelId: 'large-v3',
      providerId: 'whispercpp',
      where: 'local',
    });
    // ws://<host:port><path>?token=<token> — the token is a
    // query parameter on the upgrade (plan 7.1), never logged.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe(
      `ws://127.0.0.1:4731/v1/stream?${WS_TOKEN_PARAM}=${TOKEN}`
    );
  });

  it('buffers frames before open and flushes them, in order, on open', async () => {
    installBridge();
    const transport = createEngineTransport({ WebSocketImpl: FakeWebSocket });
    await transport.start({ enabled: true });

    const first = frame(1);
    const second = frame(2);
    expect(transport.send(first)).toBe(true);
    expect(transport.send(second)).toBe(true);

    const socket = FakeWebSocket.instances[0];
    // Still connecting: nothing sent, everything queued.
    expect(socket.sendCalls).toHaveLength(0);
    expect(transport.getDiagnostics()).toMatchObject({ state: 'connecting', queued: 2 });

    socket.onopen();
    expect(socket.sendCalls).toEqual([first, second]);
    expect(transport.getDiagnostics()).toMatchObject({ state: 'open', queued: 0 });
  });

  it('the queue is bounded: overflow ages out the oldest frame and is counted', async () => {
    installBridge();
    const transport = createEngineTransport({ WebSocketImpl: FakeWebSocket });
    await transport.start({ enabled: true });

    const overflow = 50;
    for (let i = 0; i < MAX_QUEUED_FRAMES + overflow; i += 1) {
      transport.send(frame(i));
    }

    const socket = FakeWebSocket.instances[0];
    const diagnostics = transport.getDiagnostics();
    // The bound holds — the queue never grows unbounded.
    expect(diagnostics.queued).toBe(MAX_QUEUED_FRAMES);
    expect(diagnostics.dropped).toBe(overflow);
    expect(socket.sendCalls).toHaveLength(0);

    // The freshest audio is what survives: the last frame sent
    // is the last one queued.
    socket.onopen();
    expect(socket.sendCalls[MAX_QUEUED_FRAMES - 1]).toEqual(frame(MAX_QUEUED_FRAMES + overflow - 1));
  });

  it('dials and sends nothing while speech.enabled === false', async () => {
    resetStore({ enabled: false });
    const speech = installBridge();
    const transport = createEngineTransport({ WebSocketImpl: FakeWebSocket });

    const outcome = await transport.start({ enabled: true });
    expect(outcome).toEqual({ ok: false, reason: 'disabled' });
    // No invoke, no spawn, no socket.
    expect(speech.start).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);

    expect(transport.send(frame())).toBe(false);
    expect(transport.getDiagnostics().dropped).toBe(1);
  });

  it('a refused engine start is reported and nothing dials', async () => {
    const speech = installBridge(vi.fn(async () => ({
      ok: false,
      started: false,
      reason: 'no-engine-installed',
    })));
    const transport = createEngineTransport({ WebSocketImpl: FakeWebSocket });

    const outcome = await transport.start({ enabled: true, modelId: 'large-v3' });
    expect(outcome).toEqual({ ok: false, reason: 'no-engine-installed' });
    expect(speech.start).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('without a preload bridge the start is the non-fatal no-speech-bridge reason', async () => {
    delete window.electronAPI;
    const transport = createEngineTransport({ WebSocketImpl: FakeWebSocket });
    const outcome = await transport.start({ enabled: true });
    expect(outcome).toEqual({ ok: false, reason: 'no-speech-bridge' });
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('a non-loopback endpoint is refused before any socket exists', async () => {
    installBridge(vi.fn(async () => ({
      ok: true,
      engine: { endpoint: 'http://192.168.1.5:4731', token: TOKEN, path: '/v1/stream' },
    })));
    const transport = createEngineTransport({ WebSocketImpl: FakeWebSocket });

    const outcome = await transport.start({ enabled: true });
    expect(outcome).toEqual({ ok: false, reason: 'non-loopback-endpoint' });
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('a LAN endpoint is refused when main did not confirm a remote engine', async () => {
    installBridge(vi.fn(async () => ({
      ok: true,
      engine: { endpoint: 'http://192.168.1.5:4731', token: TOKEN, path: '/v1/stream' },
    })));
    const transport = createEngineTransport({ WebSocketImpl: FakeWebSocket });

    const outcome = await transport.start({ enabled: true, where: 'network' });
    expect(outcome).toEqual({ ok: false, reason: 'non-loopback-endpoint' });
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('dials a health-checked remote endpoint only in network mode', async () => {
    installBridge(vi.fn(async () => ({
      ok: true,
      engine: {
        endpoint: 'http://192.168.1.5:4731',
        token: TOKEN,
        path: '/v1/stream',
        remote: true,
      },
    })));
    const transport = createEngineTransport({ WebSocketImpl: FakeWebSocket });

    const outcome = await transport.start({ enabled: true, where: 'network' });
    expect(outcome).toEqual({ ok: true, reason: 'dialed' });
    expect(FakeWebSocket.instances).toHaveLength(1);
    // Same dial contract, different host: ws:// + path + ?token=.
    expect(FakeWebSocket.instances[0].url).toBe(
      `ws://192.168.1.5:4731/v1/stream?${WS_TOKEN_PARAM}=${TOKEN}`
    );

    // A dropped remote socket must not leave the rail claiming a live engine.
    useSpeechStore.getState().setHealth({ remote: true, status: 'ok', backend: 'whispercpp' });
    FakeWebSocket.instances[0].onclose({ code: 1006 });
    expect(useSpeechStore.getState().health).toBeNull();
  });

  it('relays validated remote messages to the rail, but never local ones', async () => {
    const received = [];
    const off = onRemoteEngineMessage((message) => received.push(message));
    try {
      // Local socket: a final must NOT be double-delivered over the relay.
      installBridge();
      const local = createEngineTransport({ WebSocketImpl: FakeWebSocket });
      await local.start({ enabled: true, where: 'local' });
      const localSocket = FakeWebSocket.instances[0];
      localSocket.onopen();
      localSocket.onmessage({ data: JSON.stringify({
        t: 'final', sessionId: 's1', text: 'local', tStartMs: 0, tEndMs: 100,
      }) });
      expect(received).toHaveLength(0);

      // Remote socket: contract-valid messages reach the same rail handler.
      installBridge(vi.fn(async () => ({
        ok: true,
        engine: {
          endpoint: 'http://192.168.1.5:4731',
          token: TOKEN,
          path: '/v1/stream',
          remote: true,
        },
      })));
      const remote = createEngineTransport({ WebSocketImpl: FakeWebSocket });
      await remote.start({ enabled: true, where: 'network' });
      const remoteSocket = FakeWebSocket.instances[1];
      const final = { t: 'final', sessionId: 's2', text: 'remote', tStartMs: 0, tEndMs: 200 };
      remoteSocket.onmessage({ data: JSON.stringify(final) });
      remoteSocket.onmessage({ data: 'not json' });
      expect(received).toEqual([final]);
    } finally {
      off();
    }
  });

  it('invalid downstream JSON is dropped and counted; valid messages reach the callback', async () => {
    installBridge();
    const onMessage = vi.fn();
    const transport = createEngineTransport({ WebSocketImpl: FakeWebSocket, onMessage });
    const socket = await openSocket(transport);

    // Unparseable.
    socket.onmessage({ data: 'not json at all' });
    // Parseable, but not contract-shaped (missing required fields).
    socket.onmessage({ data: JSON.stringify({ t: 'partial', sessionId: 's1' }) });
    // An unknown message type is a contract violation too.
    socket.onmessage({ data: JSON.stringify({ t: 'mystery', sessionId: 's1' }) });
    // Binary downstream is not in the contract.
    socket.onmessage({ data: new Int16Array(4) });

    expect(onMessage).not.toHaveBeenCalled();
    expect(transport.getDiagnostics().invalid).toBe(4);

    const valid = {
      t: 'partial',
      sessionId: 's1',
      text: 'Brothers and sisters,',
      tStartMs: 0,
      tEndMs: 1870,
      confidence: 0.62,
    };
    socket.onmessage({ data: JSON.stringify(valid) });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(valid);
    expect(transport.getDiagnostics().invalid).toBe(4);
  });

  it('teardown detaches every listener, closes the socket, and stops the engine exactly once', async () => {
    const speech = installBridge();
    const transport = createEngineTransport({ WebSocketImpl: FakeWebSocket });
    const socket = await openSocket(transport);

    await transport.stop();

    expect(socket.closed).toBe(true);
    expect(socket.onopen).toBeNull();
    expect(socket.onmessage).toBeNull();
    expect(socket.onerror).toBeNull();
    expect(socket.onclose).toBeNull();
    expect(transport.getDiagnostics()).toMatchObject({ state: 'idle', queued: 0 });
    expect(speech.stop).toHaveBeenCalledTimes(1);

    // The guard: a second teardown (pagehide AND unmount, say)
    // never fires speech:stop again.
    await transport.stop();
    expect(speech.stop).toHaveBeenCalledTimes(1);
  });

  it('a refused engine start forwards main\u2019s error detail instead of a bare reason', async () => {
    // The probe refusal carries the actionable remedy (e.g. the VC++
    // download link) in reply.error. Dropping it here is what used to
    // clobber the banner with "Reason: engine-broken." in arm().
    const speech = installBridge(vi.fn(async () => ({
      ok: false,
      started: false,
      reason: 'engine-broken',
      error: {
        code: 'missing-vc-runtime',
        message: 'Install the Visual C++ Redistributable: https://example.invalid/vc_redist.x64.exe',
        fatal: false,
      },
    })));
    const transport = createEngineTransport({ WebSocketImpl: FakeWebSocket });

    const outcome = await transport.start({ enabled: true, modelId: 'large-v3' });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('engine-broken');
    expect(outcome.error).toMatchObject({ code: 'missing-vc-runtime' });
    expect(outcome.error.message).toMatch(/example\.invalid/);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('a stop() that never started the engine invokes nothing', async () => {
    const speech = installBridge();
    const transport = createEngineTransport({ WebSocketImpl: FakeWebSocket });

    await transport.stop();
    expect(speech.stop).not.toHaveBeenCalled();
    expect(speech.start).not.toHaveBeenCalled();
  });

  it('a start while already dialing refreshes the engine without a second socket', async () => {
    const speech = installBridge();
    const transport = createEngineTransport({ WebSocketImpl: FakeWebSocket });
    await openSocket(transport);

    const outcome = await transport.start({ enabled: true });
    expect(outcome).toEqual({ ok: true, reason: 'already-running' });
    expect(speech.start).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
