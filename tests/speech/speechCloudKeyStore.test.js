// @vitest-environment node
/**
 * tests/speech/speechCloudKeyStore.test.js — the storage half of key safety.
 *
 * The key is written to the OS keychain when keytar exists, and to an AES-256-
 * GCM ciphertext next to a 0600 random key when it does not. It is never
 * written to plaintext, never returned to the renderer, and reset is real.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSpeechCloudKeyStore } from '../../main/speechCloudKeyStore.js';

const KEY = 'sk-store-test-SECRET-VALUE';
let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyric-cloud-key-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('createSpeechCloudKeyStore', () => {
  it('uses keytar when available and clears it on request', async () => {
    const calls = [];
    const keytar = {
      async setPassword(...args) { calls.push(['set', ...args]); },
      async getPassword(...args) { calls.push(['get', ...args]); return KEY; },
      async deletePassword(...args) { calls.push(['delete', ...args]); return true; },
    };
    const store = createSpeechCloudKeyStore({ keytar, configDir: dir });

    await store.save(KEY);
    expect(await store.has()).toBe(true);
    expect(await store.read()).toBe(KEY);
    expect(calls[0]).toEqual(['set', 'LyricDisplaySpeechCloudKeys', 'openai', KEY]);
    // A cold store (new cache) must be able to read the key back from keytar.
    const cold = createSpeechCloudKeyStore({ keytar, configDir: dir });
    expect(await cold.read()).toBe(KEY);
    expect(calls.some((call) => call[0] === 'get')).toBe(true);

    await store.clear();
    expect(await store.has()).toBe(false);
    expect(calls.some((call) => call[0] === 'delete')).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('falls back to encrypted files with no plaintext and 0600 permissions', async () => {
    const store = createSpeechCloudKeyStore({ keytar: null, configDir: dir });
    await store.save(KEY);

    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(['speech-cloud-key.json', 'speech-cloud-key.key']);
    const raw = fs.readFileSync(path.join(dir, 'speech-cloud-key.json'), 'utf8');
    expect(raw).not.toContain(KEY);
    expect((fs.statSync(path.join(dir, 'speech-cloud-key.json')).mode & 0o777)).toBe(0o600);
    expect((fs.statSync(path.join(dir, 'speech-cloud-key.key')).mode & 0o777)).toBe(0o600);

    // A fresh store (cold cache) must be able to decrypt the same key.
    const cold = createSpeechCloudKeyStore({ keytar: null, configDir: dir });
    expect(await cold.read()).toBe(KEY);

    await cold.clear();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('keeps OpenAI and OpenRouter keys completely separate', async () => {
    const store = createSpeechCloudKeyStore({ keytar: null, configDir: dir });
    const OR_KEY = 'sk-or-test-DIFFERENT';
    await store.save(KEY, 'openai');
    await store.save(OR_KEY, 'openrouter');
    expect(await store.read('openai')).toBe(KEY);
    expect(await store.read('openrouter')).toBe(OR_KEY);

    const files = fs.readdirSync(dir).sort();
    expect(files).toContain('speech-cloud-key.json');
    expect(files).toContain('speech-cloud-key-openrouter.json');
    expect(files).toContain('speech-cloud-key-openrouter.key');

    // Cold cache must still return the correct key per provider.
    const cold = createSpeechCloudKeyStore({ keytar: null, configDir: dir });
    expect(await cold.read('openai')).toBe(KEY);
    expect(await cold.read('openrouter')).toBe(OR_KEY);

    await cold.clear('openrouter');
    expect(await cold.has('openrouter')).toBe(false);
    expect(await cold.read('openai')).toBe(KEY);
    expect(fs.existsSync(path.join(dir, 'speech-cloud-key.json'))).toBe(true);
  });

  it('refuses an unsupported provider and an empty key', async () => {
    const store = createSpeechCloudKeyStore({ keytar: null, configDir: dir });
    await expect(store.read('groq')).rejects.toMatchObject({ code: 'cloud-provider-not-supported' });
    await expect(store.save('   ')).rejects.toThrow(/non-empty/);
    expect(await store.has()).toBe(false);
  });
});
