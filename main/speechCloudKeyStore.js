/**
 * main/speechCloudKeyStore.js — secure storage for the cloud speech API key.
 *
 * Follows the existing keytar-first, encrypted-file-fallback pattern in
 * main/secureTokenStore.js and main/providerCredentials.js:
 *   - keytar is the primary store (service `LyricDisplaySpeechCloudKeys`,
 *     one account per provider: `openai` / `openrouter`);
 *   - when keytar is unavailable, an AES-256-GCM ciphertext is written under
 *     a 0600 config directory with a separate 0600 random key file;
 *   - the renderer only ever learns `{ configured: boolean }` — no key text
 *     crosses IPC, localStorage, or the logs.
 *
 * Every method takes a provider (default `openai`). Keys are scoped by
 * account and by separate encrypted files, so saving a Gemini/OpenRouter key
 * can never overwrite an OpenAI key. Only those two providers are enabled.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import createMainLogger from './logger.js';

const log = createMainLogger('SpeechCloudKeyStore');

const SERVICE_NAME = 'LyricDisplaySpeechCloudKeys';
const DEFAULT_PROVIDER = 'openai';
const SUPPORTED_PROVIDERS = Object.freeze(['openai', 'openrouter']);

function assertProvider(provider) {
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw Object.assign(
      new Error('Only openai and openrouter cloud keys are supported.'),
      { code: 'cloud-provider-not-supported' }
    );
  }
}

/**
 * Provider-scoped fallback paths. `openai` keeps the original file names so
 * an existing saved key survives this change; every other provider gets its
 * own ciphertext and its own random 0600 key.
 */
function fallbackPaths(baseDir, provider) {
  if (provider === 'openai') {
    return {
      secretPath: path.join(baseDir, 'speech-cloud-key.json'),
      keyPath: path.join(baseDir, 'speech-cloud-key.key'),
    };
  }
  return {
    secretPath: path.join(baseDir, `speech-cloud-key-${provider}.json`),
    keyPath: path.join(baseDir, `speech-cloud-key-${provider}.key`),
  };
}

function resolveConfigDir() {
  const home = typeof os.homedir === 'function' ? os.homedir() : (process.env.HOME || process.cwd());
  if (process.env.CONFIG_PATH) return process.env.CONFIG_PATH;
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Selah', 'speech-cloud');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Selah', 'speech-cloud');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'lyricdisplay', 'speech-cloud');
}

/**
 * @param {object} [options]
 * @param {object|null} [options.keytar] inject a keytar-shaped object; pass
 *   `null` to force the encrypted fallback in tests. `undefined` loads keytar
 *   lazily in production.
 * @param {string} [options.configDir] override the fallback directory
 */
export function createSpeechCloudKeyStore({ keytar, configDir } = {}) {
  let keytarModule = keytar; // undefined = not attempted yet, null = unavailable
  const cache = new Map(); // provider -> key | null (absent entry = unknown)

  const baseDir = configDir || resolveConfigDir();

  async function ensureDir() {
    await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
  }

  async function loadKeytar() {
    if (keytarModule !== undefined) return keytarModule;
    try {
      const mod = await import('keytar');
      keytarModule = mod.default ?? mod;
    } catch (error) {
      keytarModule = null;
      log.warn('Keytar unavailable, using encrypted fallback for cloud key:', error.message);
    }
    return keytarModule;
  }

  async function getFallbackKey(paths) {
    await ensureDir();
    try {
      const existing = await fs.readFile(paths.keyPath);
      if (existing?.length === 32) return existing;
    } catch (error) {
      if (error.code !== 'ENOENT') log.warn('Could not read cloud key encryption key:', error.message);
    }
    const key = crypto.randomBytes(32);
    await fs.writeFile(paths.keyPath, key, { mode: 0o600 });
    return key;
  }

  async function encrypt(plaintext, paths) {
    const key = await getFallbackKey(paths);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify({ key: plaintext, updatedAt: Date.now() }), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  async function decrypt(ciphertext, paths) {
    const key = await getFallbackKey(paths);
    const raw = Buffer.from(ciphertext, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 16));
    decipher.setAuthTag(raw.subarray(16, 32));
    const decrypted = Buffer.concat([decipher.update(raw.subarray(32)), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'))?.key ?? null;
  }

  async function readEncrypted(paths) {
    try {
      const contents = await fs.readFile(paths.secretPath, 'utf8');
      return JSON.parse(contents)?.ciphertext ?? null;
    } catch (error) {
      if (error.code !== 'ENOENT') log.warn('Could not read cloud key fallback store:', error.message);
      return null;
    }
  }

  async function writeEncrypted(ciphertext, paths) {
    await ensureDir();
    await fs.writeFile(paths.secretPath, `${JSON.stringify({ ciphertext }, null, 2)}\n`, { mode: 0o600 });
  }

  /** Never returns the key to IPC callers; only the supervisor uses it. */
  async function read(provider = DEFAULT_PROVIDER) {
    assertProvider(provider);
    if (cache.has(provider)) return cache.get(provider);

    const paths = fallbackPaths(baseDir, provider);
    const keytar = await loadKeytar();
    if (keytar) {
      try {
        const raw = await keytar.getPassword(SERVICE_NAME, provider);
        if (raw) {
          cache.set(provider, raw);
          return raw;
        }
      } catch (error) {
        log.warn('Keytar read failed, checking encrypted fallback:', error.message);
      }
    }

    const ciphertext = await readEncrypted(paths);
    if (!ciphertext) {
      cache.set(provider, null);
      return null;
    }
    try {
      const key = await decrypt(ciphertext, paths);
      cache.set(provider, key);
      return key;
    } catch (error) {
      log.warn('Could not decrypt cloud key fallback:', error.message);
      cache.set(provider, null);
      return null;
    }
  }

  return {
    read,

    async has(provider = DEFAULT_PROVIDER) {
      return Boolean(await read(provider));
    },

    async save(key, provider = DEFAULT_PROVIDER) {
      assertProvider(provider);
      if (typeof key !== 'string' || !key.trim()) {
        throw new Error('API key must be a non-empty string');
      }
      const trimmed = key.trim();
      cache.set(provider, trimmed);

      const keytar = await loadKeytar();
      if (keytar) {
        try {
          await keytar.setPassword(SERVICE_NAME, provider, trimmed);
          return;
        } catch (error) {
          log.warn('Keytar write failed, persisting encrypted fallback:', error.message);
        }
      }
      const paths = fallbackPaths(baseDir, provider);
      await writeEncrypted(await encrypt(trimmed, paths), paths);
    },

    async clear(provider = DEFAULT_PROVIDER) {
      assertProvider(provider);
      cache.set(provider, null);

      const keytar = await loadKeytar();
      if (keytar) {
        try {
          await keytar.deletePassword(SERVICE_NAME, provider);
        } catch (error) {
          log.warn('Keytar delete failed, clearing encrypted fallback:', error.message);
        }
      }
      const paths = fallbackPaths(baseDir, provider);
      // Remove the fallback copy too, even when keytar was used, so clearing
      // cannot leave a second valid key behind. Only this provider's files.
      await Promise.all([
        fs.rm(paths.secretPath, { force: true }),
        fs.rm(paths.keyPath, { force: true }),
      ]);
    },
  };
}

export const speechCloudKeyStore = createSpeechCloudKeyStore();
