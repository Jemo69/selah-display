/**
 * tests/speech/speechDownloader.test.js — Live Sermon Assist Phase 2.
 *
 * The downloader is verified against REAL loopback HTTP servers (127.0.0.1,
 * ephemeral ports, closed in afterEach). No model is ever downloaded from the
 * internet, no binary is spawned, and the repo's `speech-engine/` directory is
 * never written to — every test uses a throwaway temp models directory.
 *
 * What is pinned here:
 *   - resume: a transport interruption KEEPS the `.part` and the retry sends
 *     `Range: bytes=<n>-`, producing a byte-identical verified file,
 *   - a server that IGNORES Range (200) restarts cleanly instead of
 *     appending a whole file onto a partial (never corrupt on resume),
 *   - a stale 416 re-issues from zero,
 *   - the digest policy: catalog sha256 > catalog sha1 > sha256 pinned on
 *     first fetch; a sha1 never outranks an available sha256; mismatches
 *     reclaim the partial and name the drop-in directory,
 *   - cancel cleans up, progress never violates receivedBytes <= totalBytes,
 *   - drop-in discovery is filesystem-only (fetch is never called).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  MANIFEST_FILE_NAME,
  buildProgressPayload,
  createModelInstallManager,
  downloadModel,
  interpretResponse,
  listInstalledModels,
  listPartialDownloads,
  rangeRequestHeaders,
  readManifestSync,
  resolveDigestPolicy,
  resolveModelsDir,
  verifyInstalledModel,
} from '../../main/speechDownloader.js';
import { registerSpeechIpc, SPEECH_INVOKE_CHANNELS, SPEECH_EVENT_CHANNELS } from '../../main/speechIpc.js';

// electron is stubbed for main/speechIpc.js so the REAL invoke handlers can
// be exercised without an Electron process (the downloader itself never
// imports electron — see the "never binds a socket" test below).
const electron = vi.hoisted(() => ({ handlers: new Map() }));
vi.mock('electron', () => ({
  app: { getPath: (name) => `/tmp/electron-mock/${name}` },
  ipcMain: {
    handle: (channel, handler) => electron.handlers.set(channel, handler),
    removeHandler: (channel) => electron.handlers.delete(channel),
  },
}));

// ---------------------------------------------------------------------------
// Harness: loopback-only servers + per-test temp models directories
// ---------------------------------------------------------------------------

const openServers = [];
const tempDirs = [];

afterEach(async () => {
  while (openServers.length) {
    const server = openServers.pop();
    await new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/** Start a server bound to 127.0.0.1 only. Anything else fails the run. */
const startServer = (handler) =>
  new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    openServers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const { address, port } = server.address();
      if (address !== '127.0.0.1') {
        reject(new Error(`test server bound to ${address}, expected 127.0.0.1`));
        return;
      }
      resolve(server);
    });
  });

const urlFor = (server) => `http://127.0.0.1:${server.address().port}/model`;

const makeModelsDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-dl-'));
  tempDirs.push(dir);
  const modelsDir = resolveModelsDir(dir);
  fs.mkdirSync(modelsDir, { recursive: true });
  return modelsDir;
};

const payloadBytes = (size = 256 * 1024) => crypto.randomBytes(size);
const sha256Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const makeModel = (url, overrides = {}) => ({
  id: 'test-model',
  displayName: 'Test Model',
  fileName: 'ggml-test-model.bin',
  url,
  downloadBytes: 0,
  sha1: null,
  sha256: null,
  ...overrides,
});

const partPathFor = (modelsDir, fileName) => path.join(modelsDir, `${fileName}.part`);
const finalPathFor = (modelsDir, fileName) => path.join(modelsDir, fileName);

const waitFor = async (predicate, { timeoutMs = 3000, label = 'condition' } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** A body streamed in chunks with pauses, so progress events can fire.
 *  Resolves (never rejects) when the client disconnects mid-stream: an
 *  aborted download is an expected outcome here, not an error. */
const streamInChunks = (res, buffer, { chunkSize = 32 * 1024, delayMs = 5 } = {}) =>
  new Promise((resolve) => {
    let offset = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
      resolve();
    };
    res.on('error', stop);
    res.on('close', stop);
    const writeNext = () => {
      if (stopped) return;
      if (offset >= buffer.length) {
        res.end();
        resolve();
        return;
      }
      const chunk = buffer.subarray(offset, offset + chunkSize);
      offset += chunk.length;
      try {
        res.write(chunk);
      } catch {
        stop();
        return;
      }
      setTimeout(writeNext, delayMs);
    };
    writeNext();
  });

// ---------------------------------------------------------------------------
// Pure helpers (the decision core, no I/O)
// ---------------------------------------------------------------------------

describe('speechDownloader pure decisions', () => {
  it('applies the documented digest policy: sha256 > sha1 > recorded > pin-on-first-fetch', () => {
    expect(resolveDigestPolicy({ sha1: null, sha256: 'b'.repeat(64) })).toEqual({
      algorithm: 'sha256',
      expected: 'b'.repeat(64),
      source: 'catalog-sha256',
    });
    expect(resolveDigestPolicy({ sha1: 'a'.repeat(40), sha256: null })).toEqual({
      algorithm: 'sha1',
      expected: 'a'.repeat(40),
      source: 'catalog-sha1',
    });
    expect(resolveDigestPolicy({ sha1: null, sha256: null }, { sha256: 'c'.repeat(64) })).toEqual({
      algorithm: 'sha256',
      expected: 'c'.repeat(64),
      source: 'recorded-sha256',
    });
    expect(resolveDigestPolicy({ sha1: null, sha256: null })).toEqual({
      algorithm: 'sha256',
      expected: null,
      source: 'pin-on-first-fetch',
    });
  });

  it('never lets a sha1 outrank a sha256 the catalog already pinned', () => {
    // A row that later gains a `sha1` field must not silently downgrade the
    // integrity check on every platform.
    expect(resolveDigestPolicy({ sha1: 'a'.repeat(40), sha256: 'b'.repeat(64) })).toEqual({
      algorithm: 'sha256',
      expected: 'b'.repeat(64),
      source: 'catalog-sha256',
    });
    // ...and a recorded sha256 still loses to a catalog sha256, but beats sha1.
    expect(
      resolveDigestPolicy({ sha1: 'a'.repeat(40), sha256: null }, { sha256: 'c'.repeat(64) })
    ).toEqual({
      algorithm: 'sha1',
      expected: 'a'.repeat(40),
      source: 'catalog-sha1',
    });
  });

  it('never appends a Range-ignoring 200 (restart), and treats a 206 from elsewhere as unsafe', () => {
    expect(interpretResponse({ offset: 4096, status: 200 })).toMatchObject({ mode: 'restart' });
    expect(interpretResponse({ offset: 4096, status: 206, contentRange: 'bytes 0-9/10' })).toMatchObject({
      mode: 'restart',
    });
    expect(
      interpretResponse({ offset: 4096, status: 206, contentRange: 'bytes 4096-9/10' })
    ).toMatchObject({ mode: 'append', startOffset: 4096 });
    expect(
      interpretResponse({ offset: 4096, status: 206, contentRange: 'bytes 12-99/100' })
    ).toMatchObject({ mode: 'fail', reason: 'range-mismatch' });
    expect(interpretResponse({ offset: 100, status: 416, contentRange: 'bytes */100' })).toMatchObject({
      mode: 'complete',
    });
    expect(interpretResponse({ offset: 7, status: 416, contentRange: 'bytes */100' })).toMatchObject({
      mode: 'reissue',
    });
    expect(interpretResponse({ offset: 0, status: 503 })).toMatchObject({
      mode: 'fail',
      reason: 'http-status-503',
    });
  });

  it('emits Range only when there is something to resume', () => {
    expect(rangeRequestHeaders(0)).toEqual({});
    expect(rangeRequestHeaders(65536)).toEqual({ Range: 'bytes=65536-' });
  });

  it('clamps progress so receivedBytes <= totalBytes can never be violated', () => {
    // Catalog estimates are rounded: declared smaller than what actually arrives.
    const payload = buildProgressPayload({
      taskId: 'download:x',
      modelId: 'x',
      receivedBytes: 1200,
      declaredTotalBytes: 1000,
      mbps: 3.14159,
    });
    expect(payload.receivedBytes).toBeLessThanOrEqual(payload.totalBytes);
    expect(payload.totalBytes).toBe(1200);
    expect(payload.mbps).toBe(3.14);
    expect(payload).toMatchObject({ taskId: 'download:x', modelId: 'x' });
  });

  it('derives the runtime models directory under userData, never the repo checkout', () => {
    const resolved = resolveModelsDir('/home/user/.config/Selah');
    expect(resolved).toBe(path.join('/home/user/.config/Selah', 'speech-engine', 'models'));
    expect(() => resolveModelsDir('')).toThrow();
  });

  it('never binds a socket: no server or listener code in the downloader source', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'main/speechDownloader.js'), 'utf8');
    // Import statements only — comments may legitimately mention node:http.
    expect(source).not.toMatch(/from ['"]node:(http|net|dgram)['"]/);
    expect(source).not.toMatch(/require\(['"](node:)?(http|net|dgram)['"]\)/);
    expect(source).not.toMatch(/\bcreateServer\b/);
    expect(source).not.toMatch(/\b\.listen\(/);
    expect(source).not.toMatch(/from ['"]electron['"]/);
  });
});

// ---------------------------------------------------------------------------
// Resume (the Range path)
// ---------------------------------------------------------------------------

describe('resumable download against a real loopback server', () => {
  it('keeps the .part after an interruption and resumes with Range to a byte-identical file', async () => {
    const payload = payloadBytes();
    const modelsDir = makeModelsDir();
    const requests = [];
    let breakNext = true;
    let interrupt = null;

    const server = await startServer((req, res) => {
      requests.push({ range: req.headers.range ?? null, host: req.headers.host });
      const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
      if (!match) {
        res.writeHead(200, { 'content-length': String(payload.length) });
        if (breakNext) {
          breakNext = false;
          res.write(payload.subarray(0, 64 * 1024));
          // Kill the transport mid-body: this is a crash/interruption, not a
          // cancel, so the bytes already on disk must survive.
          //
          // The kill is armed here but fired by the CLIENT, once it reports
          // that it has actually received bytes. A timer cannot do this job:
          // it assumes the client read the body within its window, which is
          // false on a loaded machine — the socket then dies before the first
          // chunk lands, the download reports 0 bytes, and the test fails for
          // a reason that has nothing to do with resumable downloads.
          interrupt = () => res.destroy();
          return;
        }
        res.end(payload);
        return;
      }
      const start = Number(match[1]);
      if (start > payload.length) {
        res.writeHead(416, { 'content-range': `bytes */${payload.length}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'content-length': String(payload.length - start),
        'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
      });
      res.end(payload.subarray(start));
    });
    const url = urlFor(server);
    const model = makeModel(url, { downloadBytes: payload.length });

    // The fallback exists so a download that somehow never reports progress
    // fails this test instead of hanging it. It is generous on purpose: it
    // must never be the thing that decides the outcome.
    const fallback = setTimeout(() => {
      if (interrupt) {
        const kill = interrupt;
        interrupt = null;
        kill();
      }
    }, 10000);

    const first = await downloadModel({
      model,
      modelsDir,
      fetchImpl: globalThis.fetch,
      progressIntervalMs: 0,
      // The interruption is triggered by the client confirming it received
      // bytes, so the transport always dies mid-body with data on disk.
      onProgress: (event) => {
        if (event.receivedBytes > 0 && interrupt) {
          const kill = interrupt;
          interrupt = null;
          kill();
        }
      },
    });
    clearTimeout(fallback);
    expect(first).toMatchObject({ ok: false, code: 'interrupted', resumable: true });
    expect(first.receivedBytes).toBeGreaterThan(0);
    expect(first.receivedBytes).toBeLessThan(payload.length);

    // The partial is the resume path: kept, not reclaimed.
    const partialSize = fs.statSync(partPathFor(modelsDir, model.fileName)).size;
    expect(partialSize).toBe(first.receivedBytes);
    expect(fs.existsSync(finalPathFor(modelsDir, model.fileName))).toBe(false);
    expect(requests[0].range).toBeNull();

    const second = await downloadModel({ model, modelsDir, fetchImpl: globalThis.fetch });
    expect(second.ok).toBe(true);
    expect(second.resumed).toBe(true);
    expect(second.digestSource).toBe('pin-on-first-fetch');
    expect(requests[1].range).toBe(`bytes=${partialSize}-`);

    // Byte-identical, promoted out of .part, digest pinned in the manifest.
    expect(fs.readFileSync(finalPathFor(modelsDir, model.fileName))).toEqual(payload);
    expect(fs.existsSync(partPathFor(modelsDir, model.fileName))).toBe(false);
    const manifest = readManifestSync(path.join(modelsDir, MANIFEST_FILE_NAME));
    expect(manifest.models[model.id].sha256).toBe(sha256Of(payload));
    expect(manifest.models[model.id].source).toBe('download');

    // Loopback only: every request landed on 127.0.0.1 and nowhere else.
    expect(requests.every((entry) => entry.host.startsWith('127.0.0.1:'))).toBe(true);
    // Two real downloads over a real socket, one of them deliberately
    // interrupted. Slower than the default budget on a busy machine.
  }, 60000);

  it('restarts cleanly when the server ignores Range and answers 200 with the whole file', async () => {
    const payload = payloadBytes(64 * 1024);
    const modelsDir = makeModelsDir();
    const requests = [];
    const server = await startServer((req, res) => {
      requests.push(req.headers.range ?? null);
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
    });
    const model = makeModel(urlFor(server), { downloadBytes: payload.length });

    // A stale partial whose bytes must NOT be appended to.
    fs.writeFileSync(partPathFor(modelsDir, model.fileName), Buffer.alloc(1000, 0xab));

    const result = await downloadModel({ model, modelsDir, fetchImpl: globalThis.fetch });
    expect(result.ok).toBe(true);
    expect(requests[0]).toBe('bytes=1000-');
    // Truncated, not appended: the file is exactly the served payload.
    expect(fs.readFileSync(finalPathFor(modelsDir, model.fileName))).toEqual(payload);
    expect(fs.existsSync(partPathFor(modelsDir, model.fileName))).toBe(false);
  });

  it('re-issues from zero when the host answers 416 for a stale partial', async () => {
    const payload = payloadBytes(32 * 1024);
    const modelsDir = makeModelsDir();
    const requests = [];
    const server = await startServer((req, res) => {
      requests.push(req.headers.range ?? null);
      if (req.headers.range) {
        res.writeHead(416, { 'content-range': `bytes */${payload.length}` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
    });
    const model = makeModel(urlFor(server), { downloadBytes: payload.length });
    fs.writeFileSync(partPathFor(modelsDir, model.fileName), Buffer.alloc(7, 0xcd));

    const result = await downloadModel({ model, modelsDir, fetchImpl: globalThis.fetch });
    expect(result.ok).toBe(true);
    expect(requests).toEqual([`bytes=7-`, null]);
    expect(fs.readFileSync(finalPathFor(modelsDir, model.fileName))).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// Failure taxonomy
// ---------------------------------------------------------------------------

describe('failure taxonomy', () => {
  it('reclaims the partial on a sha1 digest mismatch and names the drop-in directory', async () => {
    const payload = payloadBytes(32 * 1024);
    const modelsDir = makeModelsDir();
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
    });
    const model = makeModel(urlFor(server), {
      sha1: '0'.repeat(40), // wrong on purpose: catalog digests win over pinning
      downloadBytes: payload.length,
    });

    const result = await downloadModel({ model, modelsDir, fetchImpl: globalThis.fetch });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('digest-mismatch');
    expect(result.digestSource).toBe('catalog-sha1');
    expect(result.bytesReclaimed).toBe(payload.length);
    expect(fs.existsSync(partPathFor(modelsDir, model.fileName))).toBe(false);
    expect(fs.existsSync(finalPathFor(modelsDir, model.fileName))).toBe(false);
    // The recovery path is in the message: the offline drop-in directory.
    expect(result.message).toContain(modelsDir);
    expect(result.message).toContain(model.fileName);
  });

  it('reports an HTTP error without leaving a partial behind', async () => {
    const modelsDir = makeModelsDir();
    const server = await startServer((req, res) => {
      res.writeHead(503, { 'content-length': '0' });
      res.end();
    });
    const model = makeModel(urlFor(server));

    const result = await downloadModel({ model, modelsDir, fetchImpl: globalThis.fetch });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('http-error');
    expect(result.status).toBe(503);
    expect(result.message).toContain(modelsDir);
    expect(fs.existsSync(partPathFor(modelsDir, model.fileName))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verification + progress
// ---------------------------------------------------------------------------

describe('verification and progress', () => {
  /**
   * A declared length is only a claim. Without an in-loop ceiling, a hostile or
   * hijacked model host can declare 2.9 GB and then stream forever: the
   * shortfall check runs only after the body ends, so the drive fills first.
   * The loop must stop writing the moment the body passes the declared size.
   */
  it('stops writing when the body overruns the length it declared', async () => {
    const modelsDir = makeModelsDir();
    const declared = 64 * 1024;
    // The catalog says 64 KB. The host then streams 8 MB.
    //
    // Sent chunked (no content-length) on purpose: a server that declares a
    // content-length is clamped by Node to that length, so the client could
    // never receive the overrun and the guard would look like it worked for
    // the wrong reason. Chunked is also the realistic shape of the attack —
    // the catalog's downloadBytes is then the declared total.
    const overshoot = payloadBytes(8 * 1024 * 1024);
    const server = await startServer(async (req, res) => {
      res.writeHead(200);
      await streamInChunks(res, overshoot, { chunkSize: 64 * 1024, delayMs: 0 });
    });
    const model = makeModel(urlFor(server), {
      sha256: sha256Of(overshoot),
      downloadBytes: declared,
    });

    const result = await downloadModel({
      model,
      modelsDir,
      fetchImpl: globalThis.fetch,
      progressIntervalMs: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('size-mismatch');

    // The decisive assertion: the partial is gone, so the runaway stream
    // cannot have filled the disk.
    const partPath = path.join(modelsDir, `${model.fileName}.part`);
    expect(fs.existsSync(partPath)).toBe(false);
    // And nothing was promoted to the installed name either.
    expect(fs.existsSync(path.join(modelsDir, model.fileName))).toBe(false);
  });

  it('verifies against a real catalog sha256 and streams progress that never violates the protocol relation', async () => {
    const payload = payloadBytes(160 * 1024);
    const modelsDir = makeModelsDir();
    const server = await startServer(async (req, res) => {
      res.writeHead(200, { 'content-length': String(payload.length) });
      await streamInChunks(res, payload, { chunkSize: 16 * 1024, delayMs: 4 });
    });
    const model = makeModel(urlFor(server), {
      sha256: sha256Of(payload),
      downloadBytes: payload.length,
    });

    const events = [];
    const result = await downloadModel({
      model,
      modelsDir,
      fetchImpl: globalThis.fetch,
      progressIntervalMs: 0,
      onProgress: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    expect(result.digestSource).toBe('catalog-sha256');
    expect(result.verified).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.taskId).toBe('download:test-model');
      expect(event.modelId).toBe('test-model');
      expect(event.receivedBytes).toBeLessThanOrEqual(event.totalBytes);
      expect(event.totalBytes).toBe(payload.length);
      expect(typeof event.mbps).toBe('number');
    }

    // Re-running with the file already present verifies instead of downloading.
    const again = await downloadModel({ model, modelsDir, fetchImpl: globalThis.fetch });
    expect(again).toMatchObject({ ok: true, alreadyPresent: true, digestSource: 'catalog-sha256' });
  });

  it('pins a null-digest model on first fetch, then verifies the installed file and flags tampering', async () => {
    const payload = payloadBytes(48 * 1024);
    const modelsDir = makeModelsDir();
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
    });
    const model = makeModel(urlFor(server), { sha1: null, sha256: null });

    const download = await downloadModel({ model, modelsDir, fetchImpl: globalThis.fetch });
    expect(download.ok).toBe(true);
    expect(download.digestSource).toBe('pin-on-first-fetch');

    const firstUse = await verifyInstalledModel({ model, modelsDir });
    expect(firstUse.ok).toBe(true);
    expect(firstUse.digestSource).toBe('recorded-sha256');

    // Tamper with the installed file: reported, but never auto-deleted.
    const finalPath = finalPathFor(modelsDir, model.fileName);
    fs.appendFileSync(finalPath, Buffer.from([0x00]));
    const tampered = await verifyInstalledModel({ model, modelsDir });
    expect(tampered.ok).toBe(false);
    expect(tampered.code).toBe('digest-mismatch');
    expect(tampered.scope).toBe('installed');
    expect(tampered.message).toContain(modelsDir);
    expect(fs.existsSync(finalPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Manager: dedupe, cancel, snapshot, discovery
// ---------------------------------------------------------------------------

describe('model install manager', () => {
  it('deduplicates a second install, cancels cleanly, and reclaims the partial', async () => {
    const payload = payloadBytes(192 * 1024);
    const modelsDir = makeModelsDir();
    const server = await startServer(async (req, res) => {
      res.writeHead(200, { 'content-length': String(payload.length) });
      // Slow enough that the 150 ms progress throttle fires before the cancel.
      await streamInChunks(res, payload, { chunkSize: 4 * 1024, delayMs: 10 });
    });
    const model = makeModel(urlFor(server), { downloadBytes: payload.length });

    const onProgress = vi.fn();
    const onStateChange = vi.fn();
    const onError = vi.fn();
    const manager = createModelInstallManager({
      modelsDir,
      catalog: [model],
      fetchImpl: globalThis.fetch,
      onProgress,
      onStateChange,
      onError,
    });

    const first = manager.install(model);
    await waitFor(() => onProgress.mock.calls.length > 0, { label: 'first progress event' });
    expect(manager.snapshot().activeDownloads).toEqual([
      { taskId: 'download:test-model', modelId: 'test-model' },
    ]);

    // A second click JOINS the in-flight task instead of starting another.
    const joined = await manager.install(model.id);
    expect(joined).toMatchObject({ ok: true, alreadyRunning: true, state: 'downloading' });

    const cancelled = await manager.cancel('test-model');
    expect(cancelled).toMatchObject({ ok: true, cancelled: true, modelId: 'test-model' });
    expect(cancelled.bytesReclaimed).toBeGreaterThan(0);

    const settlement = await first;
    expect(settlement.code).toBe('cancelled');
    expect(fs.existsSync(partPathFor(modelsDir, model.fileName))).toBe(false);
    expect(fs.existsSync(finalPathFor(modelsDir, model.fileName))).toBe(false);
    expect(manager.snapshot().activeDownloads).toEqual([]);
    expect(manager.snapshot().partials).toEqual([]);
    expect(onStateChange).toHaveBeenCalled();
    // A user cancel is not an error banner.
    expect(onError).not.toHaveBeenCalled();
    await expect(manager.cancel('test-model')).resolves.toMatchObject({
      ok: false,
      code: 'no-active-download',
    });
  });

  it('discovers a drop-in file with zero network calls and pins it on first use', async () => {
    const payload = payloadBytes(40 * 1024);
    const modelsDir = makeModelsDir();
    const model = makeModel('http://127.0.0.1:1/never-called', {
      fileName: 'ggml-dropin.bin',
      sha1: null,
      sha256: null,
    });
    fs.writeFileSync(finalPathFor(modelsDir, model.fileName), payload);

    const fetchSpy = vi.fn(async () => {
      throw new Error('discovery must not touch the network');
    });
    const manager = createModelInstallManager({ modelsDir, catalog: [model], fetchImpl: fetchSpy });

    const snapshot = manager.snapshot();
    expect(snapshot.installed).toHaveLength(1);
    expect(snapshot.installed[0]).toMatchObject({
      id: model.id,
      fileName: model.fileName,
      bytes: payload.length,
      source: 'drop-in',
      digestRecorded: false,
    });
    expect(snapshot.partials).toEqual([]);
    expect(snapshot.modelsDir).toBe(modelsDir);

    expect(listInstalledModels({ modelsDir, catalog: [model] })).toHaveLength(1);
    expect(listPartialDownloads({ modelsDir, catalog: [model] })).toEqual([]);

    const verdict = await manager.verify(model.id);
    expect(verdict).toMatchObject({ ok: true, verified: true, digestSource: 'pin-on-first-fetch' });
    expect(fetchSpy).not.toHaveBeenCalled();

    // Second use verifies against the digest pinned by the first — still offline.
    const again = await manager.verify(model.id);
    expect(again).toMatchObject({ ok: true, digestSource: 'recorded-sha256' });
    expect(fetchSpy).not.toHaveBeenCalled();
    const manifest = readManifestSync(path.join(modelsDir, MANIFEST_FILE_NAME));
    expect(manifest.models[model.id].source).toBe('drop-in');

    // Selecting something that is not on disk fails honestly, offline.
    await expect(manager.verify('missing-model')).resolves.toMatchObject({
      ok: false,
      code: 'unknown-model',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// IPC surface: the real handlers, with electron stubbed
// ---------------------------------------------------------------------------

describe('speech: IPC wiring (electron mocked, no network, no spawn)', () => {
  const sent = [];
  let ipcBase = null;
  let modelsDir = null;
  let registered = null;

  const invoke = (channel, payload) => {
    const handler = electron.handlers.get(channel);
    if (!handler) throw new Error(`no handler registered for ${channel}`);
    return handler(null, payload);
  };

  beforeAll(() => {
    ipcBase = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-ipc-'));
    modelsDir = resolveModelsDir(ipcBase);
    fs.mkdirSync(modelsDir, { recursive: true });
    sent.length = 0;
    registered = registerSpeechIpc({
      getMainWindow: () => ({
        isDestroyed: () => false,
        webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      }),
      engineRoots: [],
      endpoint: null,
      engineToken: null,
      modelsDir,
    });
  });

  afterAll(async () => {
    registered?.dispose?.();
    registered = null;
    if (ipcBase) await fsp.rm(ipcBase, { recursive: true, force: true });
  });

  it('registers exactly the pinned channel set, no renames and no additions', () => {
    expect([...electron.handlers.keys()].sort()).toEqual([...SPEECH_INVOKE_CHANNELS].sort());
    // DELIBERATE CHANGE (Decision D9 / Phase 4): the six speech:history:*
    // transcript-history invokes joined the surface — 7 -> 13. The set is
    // still pinned (first assertion) and mirrored by the channel pin in
    // tests/speech/invariants.test.js; only the count moved, in the same
    // change that added the channels.
    // DELIBERATE CHANGE (engine installer): speech:install-engine joined the
    // surface — 13 -> 14. Production mode refuses to start without the real
    // binary, so the control that installs it is part of the pinned set.
    // DELIBERATE CHANGE (engine diagnostics): speech:engine-selftest joined
    // the invokes (14 -> 15) and speech:vad joined the events (6 -> 7). The
    // probe is what tells "installed" from "runnable", and vad is the only
    // feedback the real engine gives before its first final.
    // 15 original invokes + speech:test-network + four cloud control-plane
    // invokes (key get/set/clear and the explicit egress acknowledgement).
    expect(SPEECH_INVOKE_CHANNELS).toHaveLength(20);
    expect(SPEECH_EVENT_CHANNELS).toHaveLength(7);
  });

  it('answers speech:get-state with the filesystem install snapshot', async () => {
    const state = await invoke('speech:get-state');
    expect(state.ok).toBe(true);
    expect(state.installState).toMatchObject({ modelsDir, activeDownloads: [] });
    expect(state.installState.installed).toEqual([]);
    expect(state.installState.partials).toEqual([]);
    expect(typeof state.installState.mode).toBe('string');
    expect(registered.getInstallState()).toMatchObject({ modelsDir });
  });

  it('validates arguments before touching disk or the network', async () => {
    await expect(invoke('speech:install', undefined)).resolves.toMatchObject({
      ok: false,
      code: 'invalid-argument',
      field: 'modelId',
    });
    await expect(invoke('speech:install', { modelId: 'not-in-the-catalog' })).resolves.toMatchObject({
      ok: false,
      code: 'unknown-model',
    });
    await expect(invoke('speech:select-model', { modelId: 'not-in-the-catalog' })).resolves.toMatchObject({
      ok: false,
      code: 'unknown-model',
    });
    // speech:uninstall went LIVE in Phase 6. What matters HERE is the property
    // that made it a good stub and makes it safe now: an argument that is not
    // an object is refused before anything touches disk. The destructive path
    // is exercised in tests/speech/invariants.test.js against a real temp
    // directory, because a mocked rm would pass forever while the real handler
    // pointed at the wrong path.
    await expect(invoke('speech:uninstall', 'not-an-object')).resolves.toMatchObject({
      ok: false,
      code: 'invalid-argument',
      field: 'payload',
    });
    // A plain `invoke('speech:uninstall')` — no payload at all — is a PREVIEW,
    // never a delete. If that ever regressed, an unrelated caller could erase
    // a user's transcripts.
    const preview = await invoke('speech:uninstall');
    expect(preview).toMatchObject({ ok: true, confirm: false, removed: [] });
    // speech:benchmark went LIVE in Phase 3, so the old "not-implemented"
    // assertion was asserting a state the code has left. It now pins the
    // argument validation instead — which is what this test is actually about
    // ("validates arguments before touching disk or the network") — and asserts
    // that a missing modelId is refused WITHOUT reaching an engine.
    await expect(invoke('speech:benchmark', {})).resolves.toMatchObject({
      ok: false,
      code: 'invalid-argument',
      field: 'modelId',
    });
    await expect(invoke('speech:benchmark', { modelId: '' })).resolves.toMatchObject({
      ok: false,
      code: 'invalid-argument',
    });
    await expect(invoke('speech:benchmark', 'not-an-object')).resolves.toMatchObject({
      ok: false,
      code: 'invalid-argument',
      field: 'payload',
    });
    // An unknown model is refused from the catalog, not forwarded blindly.
    await expect(invoke('speech:benchmark', { modelId: 'no-such-model' })).resolves.toMatchObject({
      ok: false,
      code: 'unknown-model',
    });
  });

  it('selecting a model that is not installed says so, naming the drop-in directory, offline', async () => {
    const verdict = await invoke('speech:select-model', { modelId: 'large-v3' });
    expect(verdict).toMatchObject({ ok: false, code: 'model-not-installed' });
    expect(verdict.message).toContain(modelsDir);
    expect(verdict.message).toContain('ggml-large-v3.bin');
  });

  it('cancelling a download that never started is a documented no-op', async () => {
    await expect(invoke('speech:install', { modelId: 'large-v3', cancel: true })).resolves.toMatchObject({
      ok: false,
      code: 'no-active-download',
    });
    expect(registered.getInstallState().activeDownloads).toEqual([]);
  });

  it('speech:start (disabled) publishes speech:install-state instead of starting anything', async () => {
    sent.length = 0;
    const result = await invoke('speech:start', { enabled: false });
    expect(result).toMatchObject({ ok: false, started: false });
    expect(result.installState).toMatchObject({ modelsDir });
    const event = sent.find((entry) => entry.channel === 'speech:install-state');
    expect(event).toBeDefined();
    expect(event.payload).toMatchObject({ modelsDir, activeDownloads: [] });
    expect(sent.some((entry) => entry.channel === 'speech:progress')).toBe(false);
  });
});
