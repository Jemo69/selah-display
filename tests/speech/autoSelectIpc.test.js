// @vitest-environment node
/**
 * tests/speech/autoSelectIpc.test.js — the main-process boundary of
 * auto-selection: validation happens BEFORE any engine is forked or any model
 * file is touched. No GPU, no models, no weights in this suite.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { ipcHandles } = vi.hoisted(() => ({ ipcHandles: {} }));

vi.mock('electron', () => ({
  app: { getPath: () => globalThis.__AUTO_SELECT_USER_DATA__ },
  ipcMain: {
    handle: (channel, handler) => {
      ipcHandles[channel] = handler;
    },
  },
}));

import { registerSpeechIpc } from '../../main/speechIpc.js';
import { getSpeechEngineSnapshot } from '../../main/speechEngine.js';

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'selah-auto-select-ipc-'));
const CLIP = { pcm: Buffer.alloc(3200), transcript: 'a hand verified reference sentence', sampleRate: 16000 };

beforeAll(() => {
  globalThis.__AUTO_SELECT_USER_DATA__ = USER_DATA;
  registerSpeechIpc({ getMainWindow: () => null });
});

describe('speech:auto-select-model validation', () => {
  it('is registered on the pinned channel with a real handler', () => {
    expect(typeof ipcHandles['speech:auto-select-model']).toBe('function');
  });

  it('refuses a missing reference clip before touching the engine', async () => {
    const reply = await ipcHandles['speech:auto-select-model']({}, { clip: null });
    expect(reply).toMatchObject({ ok: false, field: 'clip' });
    expect(getSpeechEngineSnapshot().running).toBe(false);
  });

  it('refuses TEST mode: a canned engine cannot produce measurements', async () => {
    const reply = await ipcHandles['speech:auto-select-model']({}, {
      clip: CLIP,
      engineMode: 'test',
      where: 'local',
    });
    expect(reply).toMatchObject({ ok: false, code: 'unsupported-mode' });
    expect(reply.message).toMatch(/TEST engine/i);
    expect(getSpeechEngineSnapshot().running).toBe(false);
  });

  it('refuses an empty installed set without starting an engine', async () => {
    const reply = await ipcHandles['speech:auto-select-model']({}, {
      clip: CLIP,
      engineMode: 'prod',
      where: 'local',
      providerId: 'whispercpp',
    });
    expect(reply).toMatchObject({ ok: false, code: 'no-installed-candidates' });
    expect(reply.reason).toMatch(/Nothing was measured or selected/i);
    expect(getSpeechEngineSnapshot().running).toBe(false);
  });
  it('refuses a panel auto-select while one-press setup owns the engine', async () => {
    await ipcHandles['speech:setup-lock'](null, { locked: true });
    try {
      const reply = await ipcHandles['speech:auto-select-model']({}, {
        clip: CLIP,
        engineMode: 'prod',
        where: 'local',
        providerId: 'whispercpp',
      });
      expect(reply).toMatchObject({ ok: false, code: 'setup-busy' });
    } finally {
      await ipcHandles['speech:setup-lock'](null, { locked: false });
    }
  });

});
