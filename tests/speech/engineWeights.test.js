/**
 * The driver and the downloader must agree on ONE file name per model.
 *
 * Agreement coverage, asserted per catalog row on purpose: each row writes
 * via `modelPaths` (what an install leaves behind) and resolves via the
 * driver, so if a future change makes the two disagree on any row, this
 * fails the build instead of failing in a sanctuary. The legacy `<id>.bin`
 * is kept as a fallback for hand-placed drop-ins.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import catalog from '../../shared/speech/models.catalog.json' with { type: 'json' };
import { modelPaths } from '../../main/speechDownloader.js';
import { resolveWeights, weightsFileName } from '../../speech-engine/drivers/whispercpp.js';
import { chooseModelAfterInstall } from '../../src/components/Speech/InstallEngineWizard.jsx';

const whisperRows = (catalog.models || []).filter(
  (model) => model.providerId === 'whispercpp' && typeof model.fileName === 'string'
);

const created = [];
function scratchModelsDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ld-weights-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop(), { recursive: true, force: true });
  }
});

describe('the engine resolves the weights the downloader actually wrote', () => {
  it('covers the whisper.cpp catalog', () => {
    expect(whisperRows.length).toBeGreaterThan(0);
  });

  it.each(whisperRows.map((model) => [model.id, model.fileName]))(
    'model id %s resolves to the downloaded %s',
    (id, fileName) => {
      const modelsDir = scratchModelsDir();
      const { finalPath } = modelPaths(modelsDir, fileName);
      writeFileSync(finalPath, 'weights');

      expect(weightsFileName(id)).toBe(fileName);
      expect(resolveWeights(modelsDir, id)).toBe(finalPath);
    }
  );

  it('still accepts the legacy <id>.bin shape', () => {
    const modelsDir = scratchModelsDir();
    writeFileSync(path.join(modelsDir, 'base.bin'), 'weights');

    expect(resolveWeights(modelsDir, 'base')).toBe(path.join(modelsDir, 'base.bin'));
  });

  it('prefers the catalog name when both shapes are present', () => {
    const modelsDir = scratchModelsDir();
    const { finalPath } = modelPaths(modelsDir, 'ggml-tiny.en-q5_1.bin');
    writeFileSync(finalPath, 'catalog');
    writeFileSync(path.join(modelsDir, 'tiny.en-q5_1.bin'), 'legacy');

    expect(resolveWeights(modelsDir, 'tiny.en-q5_1')).toBe(finalPath);
  });

  it('treats a zero-byte weights file as not installed', () => {
    const modelsDir = scratchModelsDir();
    const { finalPath } = modelPaths(modelsDir, 'ggml-tiny.en-q5_1.bin');
    writeFileSync(finalPath, '');

    expect(resolveWeights(modelsDir, 'tiny.en-q5_1')).toBeNull();
  });

  it('cannot be walked out of the models directory', () => {
    const base = scratchModelsDir();
    const modelsDir = path.join(base, 'models');
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(path.join(base, 'decoy.bin'), 'outside the models directory');

    expect(resolveWeights(modelsDir, '../decoy')).toBeNull();
    expect(resolveWeights(modelsDir, '../decoy.bin')).toBeNull();
  });
});

describe('a finished install becomes the active model only when the current one cannot run', () => {
  it('adopts the fresh download when nothing is installed', () => {
    expect(
      chooseModelAfterInstall({
        currentModelId: 'large-v3',
        installedIds: ['tiny.en-q5_1'],
        justInstalledId: 'tiny.en-q5_1',
      })
    ).toBe('tiny.en-q5_1');
  });

  it('leaves a working selection alone', () => {
    expect(
      chooseModelAfterInstall({
        currentModelId: 'tiny.en-q5_1',
        installedIds: ['tiny.en-q5_1', 'base.en-q5_1'],
        justInstalledId: 'base.en-q5_1',
      })
    ).toBeNull();
  });

  it('ignores a joined (still-downloading) install', () => {
    // chooseModelAfterInstall itself only sees finished installs; the
    // alreadyRunning guard lives in the install() callback. Here: unknown id.
    expect(
      chooseModelAfterInstall({
        currentModelId: 'large-v3',
        installedIds: ['large-v3'],
        justInstalledId: 'tiny.en-q5_1',
      })
    ).toBeNull();
  });
});
