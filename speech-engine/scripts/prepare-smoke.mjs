#!/usr/bin/env node
/**
 * speech-engine/scripts/prepare-smoke.mjs — fetch the light smoke-test engine.
 *
 * WHAT THIS IS. The one-time setup for `smoke.mjs` on a machine that has no
 * speech engine installed. It downloads two external, pinned artifacts into
 * `.speech-smoke/` (gitignored):
 *
 *   1. whisper.cpp's prebuilt CLI for this platform, from the same pinned
 *      upstream release the app's installer uses, verified against the same
 *      SHA-256, and unpacked with the same archive reader.
 *   2. Tiny English Q5_1 — the lightest English whisper model in Selah's
 *      catalog. 31 MiB on disk, runs on CPU, no GPU and no cloud.
 *
 * Both are external artifacts that run locally. Nothing here calls a hosted
 * API, and nothing is written into the app's user data, so this cannot change
 * what an installed Selah uses.
 *
 * WHY CACHE AND IDEMPOTENCE MATTER. CI runs this on every speech change. The
 * workflow caches `.speech-smoke/`; on a hit this script verifies what is
 * already there and returns without a network request. On a miss the whole
 * download is ~41 MiB — one 31 MiB model plus a 10 MiB binary — paid once per
 * cache key, not once per run.
 *
 * USAGE
 *   node speech-engine/scripts/prepare-smoke.mjs
 *   node speech-engine/scripts/prepare-smoke.mjs --force
 *   node speech-engine/scripts/prepare-smoke.mjs --bin-dir=/tmp/bin --models-dir=/tmp/models
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import catalog from '../../shared/speech/models.catalog.json' with { type: 'json' };
import {
  ENGINE_RELEASE,
  engineAssetFor,
  hasEngineBinary,
  installEngineBinary,
} from '../../main/speechEngineInstaller.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CACHE_ROOT = path.join(REPO_ROOT, '.speech-smoke');

/** The lightest English model in the catalog — 31 MiB, CPU-friendly. */
const MODEL_ID = 'tiny.en-q5_1';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const match = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match) continue;
    if (match[2] !== undefined) {
      out[match[1]] = match[2];
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      out[match[1]] = argv[i + 1];
      i += 1;
    } else {
      out[match[1]] = true;
    }
  }
  return out;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Download the pinned light model, verify its published digest, and place it
 * atomically in the models directory.
 */
async function prepareModel(modelsDir, { force }) {
  const row = (catalog.models || []).find((model) => model.id === MODEL_ID && model.providerId === 'whispercpp');
  if (!row) throw new Error(`The catalog no longer has the ${MODEL_ID} model row.`);
  if (!row.url || !row.sha256) {
    throw new Error(`The ${MODEL_ID} row must have both a URL and a pinned SHA-256 to be fetched safely.`);
  }

  const target = path.join(modelsDir, row.fileName);
  if (!force && existsSync(target)) {
    const existing = readFileSync(target);
    if (sha256(existing) === row.sha256) {
      console.log(`  model         ${MODEL_ID} already present (${formatMiB(existing.length)}, sha256 verified)`);
      return { bytes: existing.length, downloaded: false };
    }
    console.log(`  model         ${MODEL_ID} is present but does not match its digest — replacing it`);
  }

  mkdirSync(modelsDir, { recursive: true });
  console.log(`  model         downloading ${MODEL_ID} (${row.downloadLabel || formatMiB(row.downloadBytes || 0)}) from huggingface.co`);
  const response = await fetch(row.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Model download failed (HTTP ${response.status}).`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const digest = sha256(buffer);
  if (digest !== row.sha256) {
    throw new Error(
      `Model digest mismatch (expected ${row.sha256}, got ${digest}). Nothing was installed.`
    );
  }

  const part = `${target}.part`;
  writeFileSync(part, buffer);
  // POSIX rename() replaces atomically; Windows refuses to rename onto an
  // existing file. Try the atomic path first and only clear the target when
  // the platform makes that unavoidable, so an interruption never leaves the
  // models directory with neither the old file nor the new one on POSIX.
  try {
    renameSync(part, target);
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM' && error?.code !== 'EACCES') {
      rmSync(part, { force: true });
      throw error;
    }
    rmSync(target, { force: true });
    renameSync(part, target);
  }
  return { bytes: buffer.length, downloaded: true };
}

/** Download and unpack the pinned whisper.cpp binary for this platform. */
async function prepareBinary(binDir, { force }) {
  const asset = engineAssetFor(process.platform, process.arch);
  if (!asset) {
    console.warn(
      `  binary        no prebuilt whisper.cpp asset for ${process.platform}/${process.arch}; ` +
      'assuming one is installed elsewhere. Pass --bin-dir if it is not on the default path.'
    );
    return { installed: false, reason: 'unsupported-platform' };
  }

  if (!force && hasEngineBinary(binDir, process.platform)) {
    console.log(`  binary        whisper.cpp already present in ${path.relative(process.cwd(), binDir)}`);
    return { installed: false, reason: 'already-present' };
  }

  console.log(`  binary        downloading whisper.cpp ${ENGINE_RELEASE.version} (${path.basename(asset.file)}) from github.com`);
  const result = await installEngineBinary({
    binDir,
    downloadsDir: path.join(CACHE_ROOT, 'downloads'),
    platform: process.platform,
    arch: process.arch,
  });

  if (!result.ok) throw new Error(`Engine install failed (${result.code}): ${result.message}`);
  return { installed: true, version: result.version, bytes: result.bytes };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node speech-engine/scripts/prepare-smoke.mjs [--force] [--bin-dir=DIR] [--models-dir=DIR]');
    return;
  }

  const force = args.force === true || args.force === 'true';
  const binDir = path.resolve(String(args['bin-dir'] || path.join(CACHE_ROOT, 'bin')));
  const modelsDir = path.resolve(String(args['models-dir'] || path.join(CACHE_ROOT, 'models')));

  console.log('Preparing the light speech smoke test');
  console.log(`  cache         ${path.relative(process.cwd(), CACHE_ROOT) || '.'}`);

  const binary = await prepareBinary(binDir, { force });
  const model = await prepareModel(modelsDir, { force });

  const total = model.bytes + (binary.installed ? binary.bytes : 0);

  console.log(`  bin dir       ${path.relative(process.cwd(), binDir)}`);
  console.log(`  models dir    ${path.relative(process.cwd(), modelsDir)}`);
  console.log(
    `READY: ${model.downloaded || binary.installed ? 'downloaded' : 'cached'} ` +
    `${formatMiB(total)} of external artifacts. Run: npm run speech-smoke`
  );
}

main().catch((error) => {
  console.error(`FAIL: ${error?.message ?? error}`);
  process.exitCode = 1;
});
