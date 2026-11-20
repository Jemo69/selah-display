#!/usr/bin/env node
/**
 * speech-engine/scripts/prepare-smoke.mjs — fetch the light smoke-test inputs.
 *
 * WHAT THIS IS. The one-time setup for `smoke.mjs` on a machine that has no
 * speech engine installed. It downloads three external, pinned artifacts into
 * `.speech-smoke/` (gitignored):
 *
 *   1. whisper.cpp's prebuilt CLI for this platform, from the same pinned
 *      upstream release the app's installer uses, verified against the same
 *      SHA-256, and unpacked with the same archive reader.
 *   2. Tiny English Q5_1 — the lightest English whisper model in Selah's
 *      catalog. 31 MiB on disk, runs on CPU, no GPU and no cloud.
 *   3. The King James Bible as JSON (public domain, 4.1 MiB), so the verse
 *      detector can search a real 31,102-verse corpus instead of a toy
 *      excerpt. The smoke test converts it to Selah's bible shape in memory;
 *      no app data is touched.
 *
 * All three are external artifacts that run locally. Nothing here calls a
 * hosted API, and nothing is written into the app's user data, so this cannot
 * change what an installed Selah uses.
 *
 * WHY CACHE AND IDEMPOTENCE MATTER. CI runs this on every speech change. The
 * workflow caches `.speech-smoke/`; on a hit this script verifies what is
 * already there and returns without a network request. On a miss the whole
 * download is ~45 MiB — 31 MiB model, 10 MiB binary, 4.1 MiB Bible — paid once
 * per cache key, not once per run.
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

/**
 * Public-domain KJV JSON, pinned to one commit and one digest.
 *
 * Source: https://github.com/thiagobodruk/bible (json/en_kjv.json). The file
 * is an array of books, each with chapters of verse strings; smoke.mjs maps
 * that into the `{ books: [{ name, chapters: [{ number, verses }] }] }` shape
 * the detector consumes. Pinned to a commit so a force-push upstream cannot
 * change what CI proves.
 */
const KJV = Object.freeze({
  name: 'KJV',
  url: 'https://raw.githubusercontent.com/thiagobodruk/bible/df0860fe0921b5b899d1b554041900ab072cd4c4/json/en_kjv.json',
  sha256: 'f627b3c24a617013a4514ab24b6dd1bb305b09af237994c018f74cb9c7e71f41',
  fileName: 'kjv.json',
});

/** Records the hash of the binary this script installed, so cache hits can self-check. */
const BINARY_MARKER = '.smoke-binary.sha256';

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

/** Replace `target` with `buffer`, keeping a recoverable old copy on Windows. */
function replaceAtomically(target, buffer, backup) {
  const part = `${target}.part`;
  writeFileSync(part, buffer);
  // POSIX rename() replaces atomically; Windows refuses to rename onto an
  // existing file. Try the atomic path first. On Windows, move the old file to
  // a backup and restore it if the new rename fails, so there is always one
  // usable file on disk (the next run also restores the backup at startup).
  try {
    renameSync(part, target);
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM' && error?.code !== 'EACCES') {
      rmSync(part, { force: true });
      throw error;
    }
    if (!existsSync(target)) {
      renameSync(part, target);
      return;
    }
    rmSync(backup, { force: true });
    renameSync(target, backup);
    try {
      renameSync(part, target);
      rmSync(backup, { force: true });
    } catch (renameError) {
      rmSync(part, { force: true });
      try { renameSync(backup, target); } catch { /* next run restores it */ }
      throw renameError;
    }
  }
}

/**
 * Ensure one external file exists and matches its pinned SHA-256.
 *
 * Idempotent: a matching file is reported and left alone. A mismatch is
 * replaced. The download only becomes the final file after its digest passes.
 */
async function ensureVerifiedFile({
  url,
  expectedSha256,
  target,
  force,
  kind,
  name,
  host,
  sizeLabel,
}) {
  const backup = `${target}.old`;

  // A previous Windows replacement may have died after moving the old file
  // aside. Put it back before deciding anything, so a cache is never left with
  // no usable file at all.
  if (!existsSync(target) && existsSync(backup)) {
    try {
      renameSync(backup, target);
      console.log(`  ${kind.padEnd(13)} restored ${name} from a previous interrupted replacement`);
    } catch {
      // If this fails, the download below is still a valid recovery path.
    }
  }

  if (!force && existsSync(target)) {
    const existing = readFileSync(target);
    if (sha256(existing) === expectedSha256) {
      console.log(`  ${kind.padEnd(13)} ${name} already present (${formatMiB(existing.length)}, sha256 verified)`);
      return { bytes: existing.length, downloaded: false };
    }
    console.log(`  ${kind.padEnd(13)} ${name} is present but does not match its digest — replacing it`);
  }

  mkdirSync(path.dirname(target), { recursive: true });
  console.log(
    `  ${kind.padEnd(13)} downloading ${name} (${sizeLabel}) from ${host || 'the pinned source'}`
  );
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${name} download failed (HTTP ${response.status}).`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const digest = sha256(buffer);
  if (digest !== expectedSha256) {
    throw new Error(
      `${name} digest mismatch (expected ${expectedSha256}, got ${digest}). Nothing was installed.`
    );
  }

  replaceAtomically(target, buffer, backup);
  return { bytes: buffer.length, downloaded: true };
}

/** Download the pinned light model into the models directory. */
async function prepareModel(modelsDir, { force }) {
  const row = (catalog.models || []).find((model) => model.id === MODEL_ID && model.providerId === 'whispercpp');
  if (!row) throw new Error(`The catalog no longer has the ${MODEL_ID} model row.`);
  if (!row.url || !row.sha256) {
    throw new Error(`The ${MODEL_ID} row must have both a URL and a pinned SHA-256 to be fetched safely.`);
  }

  return ensureVerifiedFile({
    url: row.url,
    expectedSha256: row.sha256,
    target: path.join(modelsDir, row.fileName),
    force,
    kind: 'model',
    name: MODEL_ID,
    host: 'huggingface.co',
    sizeLabel: row.downloadLabel || formatMiB(row.downloadBytes || 0),
  });
}

/** Download the pinned public-domain KJV used by the verse-detection check. */
async function prepareBible(biblesDir, { force }) {
  return ensureVerifiedFile({
    url: KJV.url,
    expectedSha256: KJV.sha256,
    target: path.join(biblesDir, KJV.fileName),
    force,
    kind: 'bible',
    name: KJV.name,
    host: 'github.com',
    sizeLabel: '4.1 MiB',
  });
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

  const binaryName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const binaryPath = path.join(binDir, binaryName);
  const markerPath = path.join(binDir, BINARY_MARKER);

  if (!force && hasEngineBinary(binDir, process.platform)) {
    const actual = sha256(readFileSync(binaryPath));
    const recorded = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : '';
    if (!recorded) {
      // A binary installed by Selah rather than this script: trust it once and
      // record its hash, so the next cache hit can detect corruption.
      mkdirSync(binDir, { recursive: true });
      writeFileSync(markerPath, `${actual}\n`);
      console.log(`  binary        whisper.cpp already present in ${path.relative(process.cwd(), binDir)}`);
      return { installed: false, reason: 'already-present' };
    }
    if (recorded === actual) {
      console.log(`  binary        whisper.cpp already present in ${path.relative(process.cwd(), binDir)} (sha256 verified)`);
      return { installed: false, reason: 'already-present' };
    }
    console.log('  binary        cached whisper.cpp does not match its recorded digest — reinstalling');
  }

  console.log(`  binary        downloading whisper.cpp ${ENGINE_RELEASE.version} (${path.basename(asset.file)}) from github.com`);
  const result = await installEngineBinary({
    binDir,
    downloadsDir: path.join(CACHE_ROOT, 'downloads'),
    platform: process.platform,
    arch: process.arch,
  });

  if (!result.ok) throw new Error(`Engine install failed (${result.code}): ${result.message}`);
  writeFileSync(markerPath, `${sha256(readFileSync(binaryPath))}\n`);
  return { installed: true, version: result.version, bytes: result.bytes };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: node speech-engine/scripts/prepare-smoke.mjs ' +
      '[--force] [--bible-only] [--bin-dir=DIR] [--models-dir=DIR] [--bibles-dir=DIR]'
    );
    return;
  }

  const force = args.force === true || args.force === 'true';
  const bibleOnly = args['bible-only'] === true || args['bible-only'] === 'true';
  const binDir = path.resolve(String(args['bin-dir'] || path.join(CACHE_ROOT, 'bin')));
  const modelsDir = path.resolve(String(args['models-dir'] || path.join(CACHE_ROOT, 'models')));
  const biblesDir = path.resolve(String(args['bibles-dir'] || path.join(CACHE_ROOT, 'bibles')));

  console.log('Preparing the light speech smoke test');
  console.log(`  cache         ${path.relative(process.cwd(), CACHE_ROOT) || '.'}`);

  const binary = bibleOnly ? { installed: false } : await prepareBinary(binDir, { force });
  const model = bibleOnly ? { downloaded: false, bytes: 0 } : await prepareModel(modelsDir, { force });
  const bible = await prepareBible(biblesDir, { force });

  const downloadedBytes =
    (model.downloaded ? model.bytes : 0) +
    (bible.downloaded ? bible.bytes : 0) +
    (binary.installed ? binary.bytes : 0);

  if (!bibleOnly) {
    console.log(`  bin dir       ${path.relative(process.cwd(), binDir)}`);
    console.log(`  models dir    ${path.relative(process.cwd(), modelsDir)}`);
  }
  console.log(`  bibles dir    ${path.relative(process.cwd(), biblesDir)}`);
  console.log(
    downloadedBytes > 0
      ? `READY: downloaded ${formatMiB(downloadedBytes)} of verified artifacts. Run: npm run speech-smoke`
      : 'READY: cache hit, nothing downloaded. Run: npm run speech-smoke'
  );
}

main().catch((error) => {
  console.error(`FAIL: ${error?.message ?? error}`);
  process.exitCode = 1;
});
