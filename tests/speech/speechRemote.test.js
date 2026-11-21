// @vitest-environment node
/**
 * tests/speech/speechRemote.test.js — pure remote-contract gates.
 *
 * Fake fetch responses only: no LAN, no engine process, no browser. Every
 * refusal is a machine code plus a sentence, and no reply contains a token.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  validateNetworkEndpoint,
  validateNetworkToken,
  probeRemoteEngine,
  REMOTE_HEALTH_TIMEOUT_MS,
} from '../../main/speechRemote.js';
import { SPEECH_PROTOCOL_VERSION, TOKEN_HEADER } from '../../shared/speech/protocol.js';

const TOKEN = 'r'.repeat(64);
const health = (overrides = {}) => ({
  status: 'ok',
  apiVersion: SPEECH_PROTOCOL_VERSION,
  model: 'tiny.en',
  backend: 'whispercpp',
  rtf: 0.4,
  memoryMb: 120,
  pid: 99,
  uptimeMs: 1000,
  ...overrides,
});
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('validateNetworkEndpoint', () => {
  it.each([
    ['not a url', 'network-endpoint-invalid'],
    ['ws://192.168.1.5:4731', 'network-endpoint-invalid'],
    ['file:///etc/passwd', 'network-endpoint-invalid'],
    ['http://user:pass@192.168.1.5:4731', 'network-endpoint-credentials'],
    ['http://0.0.0.0:4731', 'network-endpoint-invalid'],
    ['http://192.168.1.5:4731/v1', 'network-endpoint-invalid'],
    ['http://192.168.1.5:4731?token=abc', 'network-endpoint-invalid'],
  ])('refuses %s', (value, code) => {
    const verdict = validateNetworkEndpoint(value);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe(code);
  });

  it('refuses a missing endpoint and accepts loopback and LAN http(s) origins', () => {
    expect(validateNetworkEndpoint('   ')).toMatchObject({ ok: false, code: 'network-endpoint-missing' });
    expect(validateNetworkEndpoint('http://127.0.0.1:4731/')).toMatchObject({
      ok: true,
      endpoint: 'http://127.0.0.1:4731',
      loopback: true,
    });
    expect(validateNetworkEndpoint('http://192.168.1.20:4731')).toMatchObject({
      ok: true,
      endpoint: 'http://192.168.1.20:4731',
      loopback: false,
    });
    expect(validateNetworkEndpoint('https://booth.local:4731')).toMatchObject({
      ok: true,
      endpoint: 'https://booth.local:4731',
    });
  });
});

describe('validateNetworkToken', () => {
  it('requires a session token of usable length and never echoes it in errors', () => {
    expect(validateNetworkToken(null)).toMatchObject({ ok: false, code: 'network-token-missing' });
    expect(validateNetworkToken('short')).toMatchObject({ ok: false, code: 'network-token-invalid' });
    expect(validateNetworkToken(TOKEN)).toEqual({ ok: true, token: TOKEN });
  });
});

describe('probeRemoteEngine', () => {
  it('sends the token header to /v1/health and returns an evidence-backed remote health', async () => {
    const fetchImpl = vi.fn(async () => response(health()));
    const verdict = await probeRemoteEngine({
      endpoint: 'http://192.168.1.20:4731',
      token: TOKEN,
      fetchImpl,
    });

    expect(verdict.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://192.168.1.20:4731/v1/health',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ [TOKEN_HEADER]: TOKEN }),
      })
    );
    // The label may only say "Remote engine" when this evidence exists.
    expect(verdict.health).toMatchObject({
      remote: true,
      status: 'ok',
      backend: 'whispercpp',
      model: 'tiny.en',
    });
    expect(JSON.stringify(verdict)).not.toContain(TOKEN);
  });

  it.each([
    [401, 'network-unauthorized'],
    [403, 'network-unauthorized'],
    [404, 'network-incompatible'],
    [500, 'network-health-failed'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const verdict = await probeRemoteEngine({
      endpoint: 'http://192.168.1.20:4731',
      token: TOKEN,
      fetchImpl: async () => response({ error: 'nope' }, status),
    });
    expect(verdict).toMatchObject({ ok: false, code });
    expect(verdict.health).toBeUndefined();
  });

  it('refuses an incompatible or malformed protocol version', async () => {
    const incompatible = await probeRemoteEngine({
      endpoint: 'http://192.168.1.20:4731',
      token: TOKEN,
      fetchImpl: async () => response(health({ apiVersion: { api: 2, minor: 0 } })),
    });
    expect(incompatible.code).toBe('network-api-incompatible');

    const malformed = await probeRemoteEngine({
      endpoint: 'http://192.168.1.20:4731',
      token: TOKEN,
      fetchImpl: async () => response(health({ apiVersion: 'v1' })),
    });
    expect(malformed.code).toBe('network-api-incompatible');
  });

  it('maps a dead LAN engine and a non-JSON answer to clear codes', async () => {
    const unreachable = await probeRemoteEngine({
      endpoint: 'http://192.168.1.20:4731',
      token: TOKEN,
      fetchImpl: async () => { throw new TypeError('fetch failed'); },
    });
    expect(unreachable.code).toBe('network-unreachable');

    const notJson = await probeRemoteEngine({
      endpoint: 'http://192.168.1.20:4731',
      token: TOKEN,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }),
    });
    expect(notJson.code).toBe('network-invalid-response');
  });

  it('aborts a hung health check instead of hanging speech:start', async () => {
    const verdict = await probeRemoteEngine({
      endpoint: 'http://192.168.1.20:4731',
      token: TOKEN,
      timeoutMs: 5,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    });
    expect(verdict.code).toBe('network-unreachable');
    expect(REMOTE_HEALTH_TIMEOUT_MS).toBeGreaterThan(5);
  });
});
