/**
 * tests/speech/osDeviceRouting.test.jsx — the provider actually picks the engine.
 *
 * Selecting "OS on-device" used to change a label and nothing else: the start
 * path always ran whisper (or refused whisper's refusals), so the
 * nothing-to-install provider could never transcribe. These tests pin the
 * routing: provider id -> engine kind, honest refusals for unwired providers
 * and for platforms with no OS backend, and the install wizard standing down
 * when there is no model file.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import UserPreferencesModal from '@/components/UserPreferencesModal';
import useSpeechStore, { speechDefaults } from '@/context/SpeechStore';

const { ipcHandles } = vi.hoisted(() => ({ ipcHandles: {} }));

vi.mock('electron', () => ({
  app: { getPath: () => globalThis.__OS_DEVICE_USER_DATA__ },
  ipcMain: { handle: (channel, handler) => { ipcHandles[channel] = handler; } },
}));

import { registerSpeechIpc, engineKindForProviderId } from '../../main/speechIpc.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lyric-speech-osdevice-'));

const emptyInstallState = () => ({
  available: false,
  mode: 'none',
  endpoint: null,
  entry: null,
  reason: 'no engine installed',
  modelsDir: path.join(USER_DATA, 'models'),
  installed: [],
  partials: [],
  activeDownloads: [],
  engine: {
    installed: false,
    binDir: path.join(USER_DATA, 'bin'),
    supported: true,
    release: 'b5454',
  },
});

const stubBridge = () => {
  const noop = () => () => {};
  return {
    getState: vi.fn(async () => ({ ok: true, status: 'idle', running: false, installState: emptyInstallState() })),
    install: vi.fn(async () => ({ ok: false, code: 'bridge-error', message: 'no' })),
    installEngine: vi.fn(async () => ({ ok: false, code: 'bridge-error', message: 'no' })),
    selectModel: vi.fn(async (payload) => ({ ok: true, verified: true, modelId: payload.modelId })),
    onInstallState: noop,
    onProgress: noop,
    onError: noop,
  };
};

describe('engineKindForProviderId', () => {
  it.each([
    [null, 'whisper'],
    [undefined, 'whisper'],
    ['', 'whisper'],
    ['whispercpp', 'whisper'],
    ['osondevice', 'osdevice'],
  ])('maps %s to %s', (providerId, expected) => {
    expect(engineKindForProviderId(providerId)).toBe(expected);
  });

  it.each(['sherpaonnx', 'vosk', 'fasterwhisper', 'custom', 'whatever'])(
    'refuses unwired provider %s with null (honest refusal, never the wrong engine)',
    (providerId) => {
      expect(engineKindForProviderId(providerId)).toBeNull();
    }
  );
});

describe('speech:start provider routing', () => {
  beforeAll(() => {
    globalThis.__OS_DEVICE_USER_DATA__ = USER_DATA;
    registerSpeechIpc({
      getMainWindow: () => null,
      engineRoots: [path.join(REPO_ROOT, 'speech-engine')],
      modelsDir: path.join(USER_DATA, 'models'),
      historyDir: path.join(USER_DATA, 'history'),
    });
  });

  afterAll(async () => {
    try {
      await ipcHandles['speech:stop']();
    } catch {
      // best effort — the engine also exits with the worker
    }
    fs.rmSync(USER_DATA, { recursive: true, force: true });
  });

  it.runIf(process.platform !== 'win32')('osondevice off Windows refuses early with the working alternative', async () => {
    const reply = await ipcHandles['speech:start'](null, {
      enabled: true,
      engineMode: 'prod',
      providerId: 'osondevice',
      where: 'local',
    });
    expect(reply.ok).toBe(false);
    expect(reply.reason).toBe('os-device-unavailable');
    expect(reply.error.message).toMatch(/whisper/i);
  });

  it('an unwired provider refuses instead of forking the wrong engine', async () => {
    const reply = await ipcHandles['speech:start'](null, {
      enabled: true,
      engineMode: 'prod',
      providerId: 'sherpaonnx',
      where: 'local',
    });
    expect(reply.ok).toBe(false);
    expect(reply.reason).toBe('provider-not-supported');
  });

  it('test mode still wins for an unwired provider (rehearsal never refuses)', async () => {
    // Regression pin for the provider-gate ordering: test mode must reach the
    // canned engine regardless of provider, as it did before the gate existed.
    const reply = await ipcHandles['speech:start'](null, {
      enabled: true,
      engineMode: 'test',
      providerId: 'sherpaonnx',
      where: 'local',
    });
    expect(reply.ok).toBe(true);
    expect(reply.started).toBe(true);
  });

  it('whispercpp still reaches the whisper gates (nothing hijacked)', async () => {
    const reply = await ipcHandles['speech:start'](null, {
      enabled: true,
      engineMode: 'prod',
      providerId: 'whispercpp',
      where: 'local',
    });
    // No binary in the throwaway userData: the WHISPER gate answers, which
    // proves routing sent this provider to whisper and not elsewhere.
    expect(reply.ok).toBe(false);
    expect(reply.reason).toBe('engine-not-installed');
  });
});

describe('install wizard with a nothing-to-install provider', () => {
  beforeEach(() => {
    localStorage.clear();
    useSpeechStore.setState({ ...speechDefaults(), status: 'idle', health: null, lastError: null });
    window.electronAPI = { speech: stubBridge() };
  });

  afterEach(() => {
    delete window.electronAPI;
  });

  it('names the skip instead of inviting a pointless download', async () => {
    useSpeechStore.setState({ providerId: 'osondevice' });
    render(<UserPreferencesModal darkMode={false} onClose={() => {}} initialSection="experimental" />);
    const note = await screen.findByTestId('speech-install-no-model-needed');
    expect(note).toHaveTextContent(/built-in speech service/i);
    expect(note).toHaveTextContent(/whisper\.cpp only/i);
  });

  it('still offers model installs for whisper.cpp', async () => {
    useSpeechStore.setState({ providerId: 'whispercpp' });
    render(<UserPreferencesModal darkMode={false} onClose={() => {}} initialSection="experimental" />);
    await screen.findByTestId('speech-install-not-installed');
    expect(screen.queryByTestId('speech-install-no-model-needed')).not.toBeInTheDocument();
  });
});
