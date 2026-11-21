// @vitest-environment node
/**
 * tests/speech/cloudOpenAiRouting.test.js — the app-side cloud path.
 *
 * Proves that `where === 'cloud'` routes to the cloud engine with the stored
 * OpenAI key, and that every missing prerequisite refuses BEFORE a local
 * whisper process is forked. The supervisor's fork is spied on: this suite is
 * about routing and validation, not about launching a server (the driver and
 * entry-point tests in speech-engine/test cover that side).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { ipcHandles, relayed, startSpy } = vi.hoisted(() => ({
  ipcHandles: {},
  relayed: [],
  startSpy: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => globalThis.__CLOUD_ROUTING_USER_DATA__ },
  ipcMain: { handle: (channel, handler) => { ipcHandles[channel] = handler; } },
}));

vi.mock('../../main/speechEngine.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    startSpeechEngine: (...args) => startSpy(...args),
  };
});

import { registerSpeechIpc } from '../../main/speechIpc.js';

const KEY = 'sk-routing-test-NEVER-EXPOSED';
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lyric-cloud-routing-'));

// The secure store is injected, so no keychain is touched by this suite.
const OR_KEY = 'sk-or-routing-test-NEVER-EXPOSED';
const keys = {
  values: new Map(),
  reset() { this.values.clear(); },
  async read(provider = 'openai') { return this.values.get(provider) ?? null; },
  async has(provider = 'openai') { return Boolean(await this.read(provider)); },
  async save(key, provider = 'openai') { this.values.set(provider, key); },
  async clear(provider = 'openai') { this.values.delete(provider); },
};

const startCloud = (over = {}) => ipcHandles['speech:start'](null, {
  enabled: true,
  where: 'cloud',
  cloudProviderId: 'openai',
  engineMode: 'prod',
  providerId: 'whispercpp',
  ...over,
});

describe('speech:start — real OpenAI cloud routing', () => {
  beforeAll(() => {
    globalThis.__CLOUD_ROUTING_USER_DATA__ = USER_DATA;
    registerSpeechIpc({
      getMainWindow: () => ({
        isDestroyed: () => false,
        webContents: { send: (channel, payload) => relayed.push({ channel, payload }) },
      }),
      // No engine roots and no binary: any local-whisper fallback would be
      // visible immediately as an unexpected fork or an engine-not-installed
      // refusal, rather than a successful "cloud" start.
      engineRoots: [],
      modelsDir: path.join(USER_DATA, 'models'),
      historyDir: path.join(USER_DATA, 'history'),
      cloudKeyStore: keys,
    });
  });

  beforeEach(() => {
    startSpy.mockClear();
    startSpy.mockResolvedValue({ ok: true, reason: 'started', mode: 'package', health: null });
    keys.reset();
    relayed.length = 0;
  });

  afterAll(() => {
    fs.rmSync(USER_DATA, { recursive: true, force: true });
  });

  it('refuses an unconfigured or unsupported provider before any fork', async () => {
    const missing = await startCloud({ cloudProviderId: null });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe('cloud-provider-not-supported');

    const unsupported = await startCloud({ cloudProviderId: 'groq' });
    expect(unsupported.ok).toBe(false);
    expect(unsupported.reason).toBe('cloud-provider-not-supported');
    expect(unsupported.error.message).toMatch(/Choose OpenAI or OpenRouter/);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('requires the explicit egress acknowledgement before a key is even read', async () => {
    keys.values.set('openai', KEY);
    const reply = await startCloud();
    expect(reply.ok).toBe(false);
    expect(reply.reason).toBe('cloud-egress-required');
    expect(reply.error.message).toMatch(/audio leaves this computer/i);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('refuses a missing key with an actionable message', async () => {
    await ipcHandles['speech:cloud:consent'](null, { granted: true });
    const reply = await startCloud();
    expect(reply.ok).toBe(false);
    expect(reply.reason).toBe('cloud-key-missing');
    expect(reply.error.message).toMatch(/Settings/);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('refuses Test Mode in Cloud instead of labelling canned text as cloud transcript', async () => {
    keys.values.set('openai', KEY);
    await ipcHandles['speech:cloud:consent'](null, { granted: true });
    const reply = await startCloud({ engineMode: 'test' });
    expect(reply.ok).toBe(false);
    expect(reply.reason).toBe('cloud-test-mode-unsupported');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('forks the cloud engine with the stored key and no local binary requirement', async () => {
    keys.values.set('openai', KEY);
    await ipcHandles['speech:cloud:consent'](null, { granted: true });
    const reply = await startCloud();

    expect(reply.ok).toBe(true);
    expect(reply.started).toBe(true);
    expect(startSpy).toHaveBeenCalledTimes(1);
    const options = startSpy.mock.calls[0][0];
    expect(options.engineKind).toBe('cloud');
    expect(options.where).toBe('cloud');
    expect(options.providerId).toBe('cloud-openai'); // honest history attribution
    expect(options.cloud).toEqual({ provider: 'openai', apiKey: KEY, model: 'whisper-1' });
    expect(options.binDir).toBeTruthy(); // present in options but never gated
    expect(JSON.stringify(reply)).not.toContain(KEY);
    expect(JSON.stringify(relayed)).not.toContain(KEY);
  });

  it('revoking the acknowledgement blocks the next cloud start', async () => {
    keys.values.set('openai', KEY);
    await ipcHandles['speech:cloud:consent'](null, { granted: true });
    expect((await startCloud()).ok).toBe(true);
    startSpy.mockClear();

    await ipcHandles['speech:cloud:consent'](null, { granted: false });
    const reply = await startCloud();
    expect(reply.reason).toBe('cloud-egress-required');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('routes OpenRouter with the Gemini model and its own stored key', async () => {
    keys.values.set('openrouter', OR_KEY);
    keys.values.set('openai', KEY);
    await ipcHandles['speech:cloud:consent'](null, { granted: true });
    const reply = await startCloud({
      cloudProviderId: 'openrouter',
      cloudModelId: 'google/gemini-3.8-flash',
    });
    expect(reply.ok).toBe(true);
    const options = startSpy.mock.calls[0][0];
    expect(options.engineKind).toBe('cloud');
    expect(options.providerId).toBe('cloud-openrouter');
    expect(options.cloud).toEqual({
      provider: 'openrouter',
      apiKey: OR_KEY,
      model: 'google/gemini-3.8-flash',
    });
    expect(JSON.stringify(reply)).not.toContain(OR_KEY);
    expect(JSON.stringify(relayed)).not.toContain(OR_KEY);
  });

  it('refuses an OpenRouter model sent to OpenAI and a missing OpenRouter key', async () => {
    keys.values.set('openai', KEY);
    await ipcHandles['speech:cloud:consent'](null, { granted: true });
    const wrongModel = await startCloud({ cloudModelId: 'google/gemini-2.5-flash' });
    expect(wrongModel.reason).toBe('cloud-model-not-supported');
    expect(startSpy).not.toHaveBeenCalled();

    const noKey = await startCloud({ cloudProviderId: 'openrouter' });
    expect(noKey.reason).toBe('cloud-key-missing');
    expect(noKey.error.message).toMatch(/OpenRouter API key/);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('local-network still refuses honestly and never starts a local engine', async () => {
    const reply = await ipcHandles['speech:start'](null, {
      enabled: true, where: 'network', providerId: 'whispercpp', engineMode: 'prod',
    });
    expect(reply.ok).toBe(false);
    expect(reply.reason).toBe('where-not-implemented');
    expect(reply.error.message).toMatch(/This Device/);
    expect(startSpy).not.toHaveBeenCalled();
  });
});

describe('speech cloud key IPC', () => {
  // The same registered handles: the secure store is injectable and never
  // returns key text to the renderer.
  it('saves, checks and clears a key without ever returning it', async () => {
    keys.reset();
    const before = await ipcHandles['speech:cloud:key:get'](null, { provider: 'openai' });
    expect(before).toMatchObject({ ok: true, configured: false, provider: 'openai' });

    const saved = await ipcHandles['speech:cloud:key:set'](null, { provider: 'openai', key: KEY });
    expect(saved).toMatchObject({ ok: true, configured: true });
    expect(keys.values.get('openai')).toBe(KEY);
    const after = await ipcHandles['speech:cloud:key:get'](null, { provider: 'openai' });
    expect(after.configured).toBe(true);
    expect(JSON.stringify(after)).not.toContain(KEY);

    const cleared = await ipcHandles['speech:cloud:key:clear'](null, { provider: 'openai' });
    expect(cleared).toMatchObject({ ok: true, configured: false });
    expect(keys.values.get('openai')).toBeUndefined();
    expect((await ipcHandles['speech:cloud:key:get'](null, { provider: 'openai' })).configured).toBe(false);
  });

  it('checks each provider independently', async () => {
    keys.reset();
    await ipcHandles['speech:cloud:key:set'](null, { provider: 'openai', key: KEY });
    const openrouter = await ipcHandles['speech:cloud:key:get'](null, { provider: 'openrouter' });
    expect(openrouter).toMatchObject({ ok: true, configured: false, provider: 'openrouter' });
    await ipcHandles['speech:cloud:key:set'](null, { provider: 'openrouter', key: OR_KEY });
    expect((await ipcHandles['speech:cloud:key:get'](null, { provider: 'openai' })).configured).toBe(true);
    await ipcHandles['speech:cloud:key:clear'](null, { provider: 'openrouter' });
    expect((await ipcHandles['speech:cloud:key:get'](null, { provider: 'openrouter' })).configured).toBe(false);
    expect((await ipcHandles['speech:cloud:key:get'](null, { provider: 'openai' })).configured).toBe(true);
    keys.reset();
  });

  it('rejects an empty key and an unsupported provider', async () => {
    const empty = await ipcHandles['speech:cloud:key:set'](null, { provider: 'openai', key: '   ' });
    expect(empty.ok).toBe(false);
    expect(empty.code).toBe('invalid-argument');

    const wrong = await ipcHandles['speech:cloud:key:set'](null, { provider: 'groq', key: KEY });
    expect(wrong.ok).toBe(false);
    expect(wrong.code).toBe('cloud-provider-not-supported');
    expect(keys.values.get('openai')).toBeUndefined();
  });
});
