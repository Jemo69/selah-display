/**
 * tests/speech/invariants.test.js — Live Sermon Assist, plan section 5.
 *
 * Six testable invariants, enforced mechanically so the feature stays
 * OPTIONAL: not installed by default, not spawned by default, not networked
 * by default, never tracked as weights, never defaulted on.
 *
 *   1. No weights or ASR binaries in the installer.
 *   2. Zero new root dependencies.
 *   3. Zero weights in git.
 *   4. Off by default, cold by default.
 *   5. Audio stays local unless cloud is chosen.
 *   6. Uninstall is real.
 *
 * Each describe block quotes the invariant it enforces. This file is
 * documentation as much as a gate — a reviewer should be able to read the
 * constraint without the plan.
 *
 * RULES FOR FUTURE PHASES
 * -----------------------
 * When a later phase legitimately changes what an assertion can say (Phase 2
 * adds a speech IPC channel to preload.js; Phase 3 may add an engine
 * installer; Phase 5 adds the cloud acknowledgement), change the assertion in
 * the SAME PR that lands the feature, and say why in the comment above it.
 * Never delete an assertion to make CI green — the assertions are the
 * mechanism, and intentions decay.
 *
 * Zero npm dependencies are introduced by this file: the glob matcher, the
 * source scanner, and the git checks all use node built-ins only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, sep, basename } from 'node:path';
import {
  planErase,
  removePathStep,
  describeErase,
  formatBytes,
  ERASE_STEPS,
} from '../../main/speechErase.js';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { render, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import { isLoopbackHost, isAllowedOrigin, ALLOWED_ORIGINS } from '../../shared/speech/protocol.js';
import { decidePermission } from '../../main/permissionPolicy.js';
import useSpeechStore, { speechDefaults } from '../../src/context/SpeechStore.js';
import SermonAssistPanel from '../../src/components/Speech/SermonAssistPanel.jsx';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// jsdom installs a global URL that ignores the base argument, and Vite
// rewrites the literal `new URL('<string>', import.meta.url)` asset pattern.
// Importing the WHATWG URL under an alias (see tests/speech/modelsCatalog.test.js)
// yields a real file:// URL that fileURLToPath accepts.
const REPO_ROOT = fileURLToPath(new NodeURL('../../', import.meta.url)).replace(/\/+$/, '');

/** Repo-relative POSIX path of an absolute path (for failure messages). */
const rel = (absPath) => relative(REPO_ROOT, absPath).split(sep).join('/');

const readText = (relPath) => readFileSync(join(REPO_ROOT, relPath), 'utf8');
const readJson = (relPath) => JSON.parse(readText(relPath));

const pkg = readJson('package.json');

/** Recursively list every file under an absolute directory (missing dir -> []). */
function walkFiles(absDir, out = []) {
  if (!existsSync(absDir)) return out;
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) walkFiles(abs, out);
    else out.push(abs);
  }
  return out;
}

const gitLsFiles = () =>
  execSync('git ls-files -z', {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);

// ---------------------------------------------------------------------------
// Invariant 1 machinery — a small, honest glob matcher.
//
// WHAT IT MODELS: electron-builder file patterns as they are used in this
// repo — literal segments, `*` (any run of characters inside one segment),
// `**` (any number of segments), `?` (one character), a trailing `/`
// (directory == everything under it), and a leading `!` (exclusion, which
// cannot ADD bytes and is therefore skipped). A pattern with no `/` at all
// is additionally matched against the basename, because electron-builder,
// like gitignore, resolves slash-less patterns at any depth.
//
// WHAT IT DOES NOT MODEL: brace expansion (`{a,b}` — none exist today and a
// literal `{` would be matched literally), character classes (`[a-z]`),
// negated segments, or `from`/`to` object semantics beyond inspecting both
// `from` and `to` strings. If this repo ever needs those, extend the matcher
// deliberately — do not weaken the probes.
// ---------------------------------------------------------------------------

function normalizePattern(raw) {
  let p = String(raw).trim();
  if (p.startsWith('!')) return { negated: true, pattern: p.slice(1) };
  if (p.startsWith('./')) p = p.slice(2);
  if (p === '.') p = '**'; // a bare `.` would copy the entire tree
  if (p.endsWith('/')) p += '**'; // bare directory == everything under it
  return { negated: false, pattern: p };
}

function globToRegExp(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:[^/]+/)*'; // `**/` matches zero or more segments
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Could `rawPattern` match the repository-relative `path`? */
function globMatches(rawPattern, path) {
  const { negated, pattern } = normalizePattern(rawPattern);
  if (negated) return false;
  if (globToRegExp(pattern).test(path)) return true;
  if (!pattern.includes('/')) return globToRegExp(pattern).test(basename(path));
  return false;
}

/** Collect every string pattern (and object `from`/`to`) from the four build fields. */
function installerPatterns() {
  const build = pkg.build ?? {};
  const out = [];
  const add = (field, value) => {
    if (typeof value === 'string') {
      out.push({ field, raw: value });
    } else if (value && typeof value === 'object') {
      if (typeof value.from === 'string') out.push({ field: `${field}.from`, raw: value.from });
      if (typeof value.to === 'string') out.push({ field: `${field}.to`, raw: value.to });
    }
  };
  for (const v of build.files ?? []) add('build.files', v);
  for (const v of build.asarUnpack ?? []) add('build.asarUnpack', v);
  for (const v of build.extraResources ?? []) add('build.extraResources', v);
  for (const v of build.extraFiles ?? []) add('build.extraFiles', v);
  return out;
}

/**
 * The one sanctioned shipping exception: the `shared` glob
 * (`shared` + `/**` + `/*`) ships the ~12 KB
 * model CATALOG on purpose (the app must know which models exist before any
 * engine is installed). It is exempted from the weights probes below and
 * asserted directly instead — the catalog is checked to be metadata-only in
 * this block and in the closing describe.
 */
const ALLOWED_SHARED_PATTERN = 'shared/**/*';

/**
 * The second sanctioned exception, and the reason this invariant had to change.
 *
 * Invariant 1 was written when the engine was a scaffold: "zero bytes in the
 * installer". It is now a real engine, and the app FORKS it — `fork()` spawns a
 * plain Node process with no asar support, so an engine left inside app.asar
 * would exist for Electron's patched fs and be unreadable to the child. There
 * is no other install path for the package: nothing downloads it, and
 * `resolveEngineDiscovery` only ever finds it on disk.
 *
 * Without this, every packaged build answers `no-engine-installed` forever and
 * the feature cannot start — which is exactly the bug this change fixes.
 *
 * What the invariant was actually protecting is unchanged: no model WEIGHTS and
 * no ASR BINARY may ship. The engine is ~230 KB of source, and the negations in
 * build.files keep `models/` and `bin/` out of the installer even if someone
 * drops a weight into the repo. The on-disk check below fails loudly if one
 * appears.
 */
const ALLOWED_ENGINE_PATTERN = 'speech-engine/**/*';

/** Paths an installer pattern must never be able to match: engine binaries and
 *  weights. NOTE: plain `speech-engine/**` is now allowed — see
 *  ALLOWED_ENGINE_PATTERN — so the probes name only the things that must never
 *  ship. */
const ENGINE_PROBES = [
  'speech-engine/engine',
  'speech-engine/bin/whisper-server',
  'speech-engine/bin/whisper-server',
  'speech-engine/models/ggml-large-v3.bin',
  'speech-engine/models/model.onnx',
  'speech-engine/models/model.gguf',
  'speech-engine/models/model.safetensors',
];

/**
 * Weight files wherever this feature could drop them: repo root, `models/`,
 * `weights/`. Deliberately NOT under `dist/`, `server/`, `main/`, `public/`
 * or `shared/`: those directories already ship wholesale by design, no
 * speech-feature weight path lives inside them, and `shared/` is the
 * documented catalog exception. `speech-engine/models/*` is covered by
 * ENGINE_PROBES.
 */
const WEIGHT_PROBES = [
  'ggml-large-v3.bin',
  'ggml-tiny.bin',
  'model.bin',
  'model.onnx',
  'model.gguf',
  'model.safetensors',
  'model.ggml',
  'models/ggml-large-v3.bin',
  'models/model.onnx',
  'weights/model.gguf',
];

// ---------------------------------------------------------------------------
// Invariant 4 machinery — the cold-by-default source scanner.
//
// It reads source, blanks comments / string literals / template literals /
// regex literals (preserving newlines so reported line numbers are real) and
// then flags FORBIDDEN CALLS THAT WOULD RUN AT IMPORT TIME — i.e. calls that
// appear outside every function body, arrow-expression body, or `=> {` block.
// A capture hook that calls getUserMedia() inside startCapture() is fine; a
// module that calls it at the top level is a cold-start violation.
//
// HONEST LIMITATIONS — this is a heuristic, not a parser:
//   - Scope detection is lexical (brace classification by the tokens in
//     front of `{`). It does not model `eval`, generated code, or
//     decorators.
//   - False negatives (accepted): a forbidden call inside an IIFE at module
//     top level; a forbidden call across an ASI newline after an unclosed
//     arrow expression (this repo uses semicolons); an aliased call
//     (`const s = spawn; s(...)`); a call reached through a re-export.
//   - False positives (accepted and guarded against where cheap): none known
//     for the current tree; the scanner is exercised against a table of
//     cases below so a regression in the scanner itself fails loudly.
//   - JSX text with unbalanced quotes on one line is treated as code; it can
//     blank a neighbouring string but not unbalance brackets.
// ---------------------------------------------------------------------------

const FORBIDDEN_CALL_TOKENS = ['spawn', 'fork', 'fetch', 'io', 'getUserMedia'];

/** Regex-vs-division: keywords after which a `/` starts a regex literal. */
const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await',
]);

/**
 * Blank comments and literal contents; keep everything else, preserving
 * newlines. Template `${...}` interpolations are still scanned as code,
 * because they execute at evaluation time.
 */
function sanitizeSource(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let mode = 'code'; // 'code' | 'template'
  const interpDepths = []; // brace depth at which each open `${` started
  let braceDepth = 0;
  let prev = ''; // last emitted code character (for regex-vs-division)

  const blank = (text) => {
    for (const ch of text) out += ch === '\n' ? '\n' : ' ';
  };
  const emit = (ch) => {
    out += ch;
    if (ch !== '\n') prev = ch;
  };
  const trailingWord = () => {
    const m = /([A-Za-z_$][\w$]*)\s*$/.exec(out);
    return m ? m[1] : '';
  };

  // Returns index just past the closing quote, or -1 if this is not a
  // single-line-terminated string (apostrophes in JSX text, line 2+ ...).
  const scanQuoted = (start, quote) => {
    let j = start + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === quote) return j + 1;
      if (c === '\n') return -1;
      j += 1;
    }
    return -1;
  };

  // Returns index just past the regex literal (incl. flags), or -1 when no
  // closing `/` exists before the end of the line (i.e. this is division).
  const scanRegex = (start) => {
    let j = start + 1;
    let inClass = false;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '\n') return -1;
      if (inClass) {
        if (c === ']') inClass = false;
        j += 1;
        continue;
      }
      if (c === '[') { inClass = true; j += 1; continue; }
      if (c === '/') {
        j += 1;
        while (j < n && /[a-z]/.test(src[j])) j += 1;
        return j;
      }
      j += 1;
    }
    return -1;
  };

  while (i < n) {
    const c = src[i];

    if (mode === 'template') {
      if (c === '\\') { blank(src.slice(i, i + 2)); i += 2; continue; }
      if (c === '$' && src[i + 1] === '{') {
        // Emit `${` as code so brackets stay balanced for the scanner pass.
        emit('$');
        emit('{');
        interpDepths.push(braceDepth);
        mode = 'code';
        i += 2;
        continue;
      }
      if (c === '`') { emit('`'); mode = 'code'; i += 1; continue; }
      blank(c);
      i += 1;
      continue;
    }

    // mode === 'code'
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j += 1;
      blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const j = close === -1 ? n : close + 2;
      blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = scanQuoted(i, c);
      if (end === -1) {
        emit(c); // apostrophe in JSX text, not a string — keep scanning
        i += 1;
        continue;
      }
      emit(c);
      blank(src.slice(i + 1, end - 1));
      emit(c);
      i = end;
      continue;
    }
    if (c === '`') { emit('`'); mode = 'template'; i += 1; continue; }
    if (c === '/') {
      // Regex literal only where a `/` could start one. Note `}` is
      // deliberately NOT in this set: in JSX, `</tag>` and `} />` follow `}`
      // and must stay division, or a fake regex would swallow real braces.
      const prevIsRegexPrefix =
        prev === '' || '(,=:[!&|?{;+-*%~^<>'.includes(prev) || KEYWORDS_BEFORE_REGEX.has(trailingWord());
      if (prevIsRegexPrefix) {
        const end = scanRegex(i);
        if (end !== -1) {
          blank(src.slice(i, end));
          i = end;
          continue;
        }
      }
      emit(c);
      i += 1;
      continue;
    }
    if (c === '}') {
      if (interpDepths.length > 0 && braceDepth === interpDepths[interpDepths.length - 1]) {
        emit('}'); // closes a `${ ... }` interpolation
        interpDepths.pop();
        i += 1;
        continue;
      }
      if (braceDepth > 0) braceDepth -= 1;
      emit(c);
      i += 1;
      continue;
    }
    if (c === '{') {
      braceDepth += 1;
      emit(c);
      i += 1;
      continue;
    }
    emit(c);
    i += 1;
  }
  return out;
}

/** Words after which a `) {` opens a plain block, not a function body. */
const BLOCK_HEADER_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

/**
 * Classify the `{` at `openIndex`: does it open a function body ('fn') or a
 * plain block / object / class-body ('block')? Looks at the tokens in front
 * of the brace: `=> {` and `...(...) {` (function, method) are fn; `if (…) {`
 * and friends are block; anything else (`= {`, `: {`) is block.
 */
function classifyBrace(src, openIndex) {
  let j = openIndex - 1;
  while (j >= 0 && /\s/.test(src[j])) j -= 1;
  if (j >= 1 && src[j] === '>' && src[j - 1] === '=') return 'fn'; // `=> {`
  if (j >= 0 && src[j] === ')') {
    let depth = 1;
    let k = j - 1;
    while (k >= 0 && depth > 0) {
      if (src[k] === ')') depth += 1;
      else if (src[k] === '(') depth -= 1;
      k -= 1;
    }
    let m = k; // index just before the matching `(` (k landed one past it)
    while (m >= 0 && /\s/.test(src[m])) m -= 1;
    const end = m;
    while (m >= 0 && /[\w$]/.test(src[m])) m -= 1;
    const word = src.slice(m + 1, end + 1);
    if (BLOCK_HEADER_WORDS.has(word)) return 'block'; // `if (…) {`
    return 'fn'; // `function f(…) {`, `method(…) {`, `constructor(…) {`
  }
  return 'block'; // `= {`, `: {`, `class X {`, JSX expr container
}

const isIdentStart = (c) => c !== undefined && /[A-Za-z_$]/.test(c);
const isIdentPart = (c) => c !== undefined && /[\w$]/.test(c);
const isBlank = (c) => c === ' ' || c === '\n' || c === '\t';

/**
 * Forbidden calls that run at module import time (top level).
 * Returns [{ line, call }] against the SANITIZED source; line numbers are
 * real because sanitization preserves newlines.
 */
function findTopLevelForbiddenCalls(sanitized) {
  const hits = [];
  const n = sanitized.length;
  let i = 0;
  let paren = 0;
  let brack = 0;
  const braces = []; // 'fn' | 'block' for each open `{`
  const arrowStack = []; // combined bracket depth at which each open arrow-expr body started
  let lastIdentifier = '';

  const depth = () => paren + brack + braces.length;
  const fnDepth = () => braces.reduce((count, kind) => count + (kind === 'fn' ? 1 : 0), 0);
  const atTopLevel = () => arrowStack.length === 0 && fnDepth() === 0;
  const lineAt = (idx) => sanitized.slice(0, idx).split('\n').length;
  const skipBlanks = (idx) => {
    let k = idx;
    while (k < n && isBlank(sanitized[k])) k += 1;
    return k;
  };
  const popArrows = () => {
    while (arrowStack.length > 0 && arrowStack[arrowStack.length - 1] >= depth()) arrowStack.pop();
  };

  while (i < n) {
    const c = sanitized[i];

    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(sanitized[j])) j += 1;
      const token = sanitized.slice(i, j);
      const next = skipBlanks(j);

      if (atTopLevel()) {
        if (FORBIDDEN_CALL_TOKENS.includes(token) && sanitized[next] === '(') {
          hits.push({ line: lineAt(i), call: `${token}(` });
        } else if (token === 'WebSocket' && lastIdentifier === 'new' && sanitized[next] === '(') {
          hits.push({ line: lineAt(i), call: 'new WebSocket(' });
        } else if (token === 'navigator' && sanitized.slice(j, j + 14).startsWith('.mediaDevices')) {
          hits.push({ line: lineAt(i), call: 'navigator.mediaDevices' });
        }
      }
      lastIdentifier = token;
      i = j;
      continue;
    }

    if (c === '=' && sanitized[i + 1] === '>') {
      const next = skipBlanks(i + 2);
      // `=> {` is classified as fn when the brace is reached; `=> expr` opens
      // an expression body that closes at the next delimiter at this depth.
      if (sanitized[next] !== '{') arrowStack.push(depth());
      lastIdentifier = '';
      i += 2;
      continue;
    }

    switch (c) {
      case '(':
        paren += 1;
        break;
      case '[':
        brack += 1;
        break;
      case '{':
        braces.push(classifyBrace(sanitized, i));
        break;
      case ')':
        popArrows();
        paren = Math.max(0, paren - 1);
        break;
      case ']':
        popArrows();
        brack = Math.max(0, brack - 1);
        break;
      case '}':
        popArrows();
        if (braces.length > 0) braces.pop();
        break;
      case ';':
      case ',':
        popArrows();
        break;
      default:
        break;
    }
    i += 1;
  }
  return hits;
}

/** Convenience: scan a raw source string. */
const scanSource = (src) => findTopLevelForbiddenCalls(sanitizeSource(src));

/** Repo-relative files covered by the cold-by-default source scan. */
function coldScanTargets() {
  const required = [
    'src/context/SpeechStore.js',
    'src/components/Speech/SermonAssistPanel.jsx',
  ];
  const targets = [];
  for (const relPath of required) {
    if (!existsSync(join(REPO_ROOT, relPath))) {
      throw new Error(`cold-by-default scan: expected file is missing: ${relPath}`);
    }
    targets.push(relPath);
  }

  const isTestFile = (relPath) => /(^|\/)(__tests__|tests\/)/.test(relPath) || /\.(test|spec)\./.test(relPath);
  // `panicstop` and `audiodevices` have to be named explicitly: they are part
  // of the Sermon Assist feature but do not match on `speech`/`audio`/`pcm`,
  // and both open media devices on mount.
  const speechNamed = (relPath) => /speech|audiocapture|pcm|panicstop|audiodevices/i.test(basename(relPath));
  const sourceExt = /\.(js|jsx|ts|tsx)$/;

  // Every source file in the Speech component directory — not just the panel,
  // so files other phases add under src/components/Speech/ are guarded too.
  for (const dir of ['src/components/Speech', 'src/speech']) {
    for (const abs of walkFiles(join(REPO_ROOT, dir))) {
      const r = rel(abs);
      if (sourceExt.test(r) && !isTestFile(r)) targets.push(r);
    }
  }
  // Hooks and workers: only the speech/audio-capture/pcm-named ones, so an
  // unrelated hook never becomes a surprise failure.
  for (const dir of ['src/hooks', 'src/workers']) {
    for (const abs of walkFiles(join(REPO_ROOT, dir))) {
      const r = rel(abs);
      if (sourceExt.test(r) && !isTestFile(r) && speechNamed(r)) targets.push(r);
    }
  }
  // main/speech*.js — INCLUDED DELIBERATELY, and this is the part that used to
  // be missing: speechEngine.js is the module that calls fork(), speechIpc.js
  // registers the channels, speechDownloader.js and speechHistory.js touch the
  // filesystem. None of them has an import-time side effect today, but a
  // top-level `fork()` added to speechEngine.js tomorrow would have passed
  // CI while this scan never once read that file.
  for (const abs of walkFiles(join(REPO_ROOT, 'main'))) {
    const r = rel(abs);
    if (sourceExt.test(r) && !isTestFile(r) && /^main\/speech.*\.js$/.test(r)) targets.push(r);
  }
  return [...new Set(targets)];
}

/** Files invariant 5 checks for wildcard bind addresses. */
function bindScanTargets() {
  const targets = [];
  const isTestFile = (relPath) => /(^|\/)(__tests__|tests\/)/.test(relPath) || /\.(test|spec)\./.test(relPath);
  // Everything under shared/speech/ — the protocol, the barrel, the catalog.
  for (const abs of walkFiles(join(REPO_ROOT, 'shared/speech'))) {
    const r = rel(abs);
    if (/\.(js|jsx|ts|tsx|json)$/.test(r)) targets.push(r);
  }
  // Speech-named files in src/ and main/ (and the Speech component dir),
  // excluding tests — tests may legitimately mention `0.0.0.0` in an
  // assertion; shipped code may not bind it.
  for (const dir of ['src', 'main']) {
    for (const abs of walkFiles(join(REPO_ROOT, dir))) {
      const r = rel(abs);
      if (!/\.(js|jsx|ts|tsx)$/.test(r) || isTestFile(r)) continue;
      if (/speech|audiocapture|pcm/i.test(basename(r)) || r.startsWith('src/components/Speech/')) {
        targets.push(r);
      }
    }
  }
  return [...new Set(targets)];
}

const freshStoreHydration = async (store) => {
  if (store.persist?.hasHydrated?.()) return;
  if (store.persist?.onFinishHydration) {
    await new Promise((resolve) => store.persist.onFinishHydration(resolve));
  }
};

const STORAGE_KEY = 'speech-store';

beforeEach(() => {
  localStorage.clear();
  // Reset through the feature's own action so every test starts at defaults.
  useSpeechStore.getState().resetToDefaults();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

// ===========================================================================
// Invariant 1
// ===========================================================================

/**
 * "No weights or ASR binaries in the installer. A test parses package.json's
 * build.files, asarUnpack, extraResources, and extraFiles and fails if any
 * pattern can match a weights file or an engine binary."
 *
 * AMENDED in the phase that made the engine real. The original wording was
 * "zero bytes in the installer" because the engine was a scaffold that nothing
 * could start. It is now the thing the supervisor forks, and it has no other
 * install path — so the package's ~230 KB of SOURCE must ship or the feature
 * can never start in a packaged build. See ALLOWED_ENGINE_PATTERN for the
 * reasoning and for what is still forbidden.
 */
describe('invariant 1: no weights or ASR binaries in the installer', () => {
  it('no build.files, asarUnpack, extraResources, or extraFiles pattern can match an engine binary or a weights file', () => {
    const violations = [];

    // electron-builder defaults `files` to ['**/*'] when it is missing or
    // empty — model that default, or deleting the list would silence us.
    const files = pkg.build?.files;
    if (!Array.isArray(files) || files.length === 0) {
      violations.push({
        field: 'build.files',
        pattern: '<absent — electron-builder would default to **/*>',
        couldShip: 'speech-engine',
      });
    }

    for (const entry of installerPatterns()) {
      const { negated, pattern } = normalizePattern(entry.raw);
      if (negated) continue; // `!` excludes, it cannot add bytes
      if (pattern === ALLOWED_SHARED_PATTERN) {
        // Documented exception: ships the ~12 KB catalog, asserted below.
        continue;
      }
      if (pattern === ALLOWED_ENGINE_PATTERN) {
        // Documented exception: the engine SOURCE ships so the supervisor can
        // fork it. Weights and binaries inside it are negated in build.files
        // and checked on disk below.
        continue;
      }
      for (const probe of [...ENGINE_PROBES, ...WEIGHT_PROBES]) {
        if (globMatches(entry.raw, probe)) {
          violations.push({ field: entry.field, pattern: entry.raw, couldShip: probe });
        }
      }
    }

    expect(
      violations,
      'plan section 5 invariant 1: an installer pattern would ship the speech engine or a ' +
      'model weight. Remove the pattern, or — if a later phase genuinely ships engine bytes — ' +
      'change this assertion in the same PR and say why.'
    ).toEqual([]);
  });

  it('the one shipping exception is explicit: shared/**/* carries a catalog that contains no weights', () => {
    // The catalog ships ON PURPOSE (4-12 KB of text) so the app can offer
    // models before any engine is installed. That is the whole exception.
    expect(pkg.build.files).toContain(ALLOWED_SHARED_PATTERN);

    const raw = readText('shared/speech/models.catalog.json');
    expect(raw.length, 'catalog must stay a small text file').toBeLessThan(40 * 1024);
    // A weight blob could not hide: no single value may approach the file
    // size, and no base64 run may exist at all.
    const catalog = JSON.parse(raw);
    const strings = [];
    (function collect(value) {
      if (typeof value === 'string') strings.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    })(catalog);
    expect(Math.max(...strings.map((s) => s.length))).toBeLessThan(1024);
    expect(/[A-Za-z0-9+/]{200,}={0,2}/.test(raw)).toBe(false);
    expect(/data:/i.test(raw)).toBe(false);
  });

  it('the engine exception is source only: no weights, no binaries, no tests', () => {
    expect(pkg.build.files).toContain(ALLOWED_ENGINE_PATTERN);

    // The negations are load-bearing and must FOLLOW the positive pattern —
    // that ordering is what makes electron-builder read them as exclusions
    // rather than as another include.
    const files = pkg.build.files;
    const at = files.indexOf(ALLOWED_ENGINE_PATTERN);
    for (const exclusion of [
      '!speech-engine/models/**',
      '!speech-engine/bin/**',
      '!speech-engine/test/**',
    ]) {
      expect(
        files.indexOf(exclusion),
        `${exclusion} must follow ${ALLOWED_ENGINE_PATTERN}`
      ).toBeGreaterThan(at);
    }

    // And nothing on disk that would need excluding in the first place.
    const engineRoot = join(REPO_ROOT, 'speech-engine');
    const weightish = /\.(bin|onnx|gguf|ggml|safetensors|pt|pth)$/i;
    const offenders = walkFiles(engineRoot).filter((abs) => {
      const posix = rel(abs);
      return weightish.test(posix) || posix.includes('/bin/');
    });
    expect(
      offenders.map(rel),
      'a model weight or ASR binary is sitting under speech-engine/ — negate it in build.files ' +
        'or move it out; it must never reach the installer'
    ).toEqual([]);

    // The supervisor forks this exact file, so it has to be real on disk.
    expect(existsSync(join(engineRoot, 'index.js')), 'supervisor forks speech-engine/index.js').toBe(
      true
    );
  });
});

// ===========================================================================
// Invariant 2
// ===========================================================================

/**
 * "Zero new root dependencies. A test snapshots the root `dependencies`
 * object. A diff fails the build. Whisper bindings, ONNX runtimes, and
 * transformers.js are all explicitly banned by name."
 *
 * BANNED_SPEECH_ENGINE_DEPENDENCIES is exported so Phase 9 (and any later
 * phase) can EXTEND it — additions to the ban list are free; additions to
 * package.json dependencies are not.
 */
export const BANNED_SPEECH_ENGINE_DEPENDENCIES = [
  '@xenova/transformers',
  'transformers',
  'whisper-node',
  'nodejs-whisper',
  'whisper.cpp',
  'node-whisper',
  'onnxruntime-node',
  'onnxruntime-web',
  'onnxruntime',
  'sherpa-onnx',
  'vosk',
  'faster-whisper',
  '@huggingface/transformers',
  'transformers.js',
  'node-vad',
  '@ricky0123/vad-web',
  'vosk-browser',
];

/** Belt and braces: no dependency key may even CONTAIN these substrings. */
const BANNED_SUBSTRINGS = ['whisper', 'onnx', 'transformers', 'vosk'];

describe('invariant 2: zero new root dependencies', () => {
  it('root dependencies match the checked-in baseline exactly — any added, removed, or changed entry fails', () => {
    const baseline = readJson('tests/speech/fixtures/root-dependencies.baseline.json').dependencies;
    const current = pkg.dependencies ?? {};

    const added = Object.keys(current).filter((k) => !(k in baseline));
    const removed = Object.keys(baseline).filter((k) => !(k in current));
    const changed = Object.keys(current).filter((k) => k in baseline && baseline[k] !== current[k]);

    expect(
      { added, removed, changed },
      'package.json dependencies drifted from ' +
      'tests/speech/fixtures/root-dependencies.baseline.json. Live Sermon Assist ships a speech ' +
      'engine the user installs SEPARATELY — a new root dependency needs a plan change. If the ' +
      'change is genuinely required, update the baseline deliberately, in review, in the same PR.'
    ).toEqual({ added: [], removed: [], changed: [] });
  });

  it('no banned whisper, ONNX, transformers.js, or VAD runtime appears in dependencies or devDependencies', () => {
    const depKeys = Object.keys(pkg.dependencies ?? {});
    const devDepKeys = Object.keys(pkg.devDependencies ?? {});
    const bannedFound = BANNED_SPEECH_ENGINE_DEPENDENCIES.filter((banned) =>
      [...depKeys, ...devDepKeys].some((key) => key.toLowerCase() === banned.toLowerCase())
    );

    expect(
      bannedFound,
      'these packages are exactly the speech-engine runtimes this plan keeps OUT of the app ' +
      'installer; adding one violates invariant 2 (extend the list, never remove from it)'
    ).toEqual([]);
  });

  it('no dependency key contains whisper, onnx, transformers, or vosk at all', () => {
    const offenders = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
      .filter((key) => BANNED_SUBSTRINGS.some((needle) => key.toLowerCase().includes(needle)));

    expect(offenders, 'substring ban beyond the literal list — a renamed wrapper still fails').toEqual([]);
  });
});

// ===========================================================================
// Invariant 3
// ===========================================================================

/**
 * "Zero weights in git. `/speech-engine/models/`, `*.bin`, `*.onnx`, and
 * `*.gguf` are gitignored. CI fails on any tracked file over 20 MB."
 *
 * MEASURED 2026-09-27 with `git ls-files -z | xargs -0 -n1 du -b`: the repo
 * has NO tracked file over 20 MB (683 tracked files; the largest is
 * src/assets/fonts/Noto_Sans/NotoSans-Italic-VariableFont_wdth,wght.ttf at
 * 2.30 MB) and NO tracked file with a weight extension. The allowlist below
 * is therefore empty and both rules are hard assertions. If a legitimate
 * large file ever lands, record it here BY NAME with a review comment —
 * never widen the threshold.
 */
const PREEXISTING_OVER_20MB = [];
const MAX_TRACKED_BYTES = 20 * 1024 * 1024;

const WEIGHT_EXT_RE = /\.(ggml|bin|onnx|gguf|safetensors)$/i;
const FEATURE_PATH_RE = /speech|audiocapture|pcm/i;

describe('invariant 3: zero weights in git', () => {
  it('no tracked file exceeds 20 MB', () => {
    const oversize = [];
    for (const tracked of gitLsFiles()) {
      if (PREEXISTING_OVER_20MB.includes(tracked)) continue;
      let size;
      try {
        size = statSync(join(REPO_ROOT, tracked)).size;
      } catch {
        continue; // tracked-but-locally-deleted (e.g. concurrent checkout) is not this rule
      }
      if (size > MAX_TRACKED_BYTES) oversize.push(`${tracked} (${size} bytes)`);
    }
    expect(
      oversize,
      'plan section 5 invariant 3: no tracked file may exceed 20 MB — model weights are multi-GB ' +
      'and must never enter git history'
    ).toEqual([]);
  });

  it('no tracked weights: speech-engine/models is empty, no weight extensions, no oversize speech paths', () => {
    const tracked = gitLsFiles();

    // What the plan actually forbids (section 5, invariant 3, verbatim):
    //   "/speech-engine/models/, *.bin, *.onnx, and *.gguf are gitignored.
    //    CI fails on any tracked file over 20 MB."
    //
    // Note what is NOT forbidden: source under speech-engine/ itself. Phase 2
    // makes speech-engine/ a self-contained package with its own package.json
    // and its own tests, so that source IS meant to be committed — only its
    // WEIGHTS never are. An earlier revision of this assertion banned every
    // tracked path under speech-engine/, which contradicted the plan and would
    // have made Phase 2 unimplementable. The engine package ships in source;
    // the weights never enter git at all.
    const engineModels = tracked.filter(
      (p) => p === 'speech-engine/models' || p.startsWith('speech-engine/models/')
    );
    const weights = tracked.filter((p) => WEIGHT_EXT_RE.test(p));
    const oversizeFeatureFiles = tracked.filter((p) => {
      if (!FEATURE_PATH_RE.test(p)) return false;
      try {
        return statSync(join(REPO_ROOT, p)).size > MAX_TRACKED_BYTES;
      } catch {
        return false;
      }
    });

    expect(
      engineModels,
      'the engine models directory must never be committed — model weights are downloaded, never tracked'
    ).toEqual([]);
    expect(
      weights,
      '*.bin / *.onnx / *.gguf / *.ggml / *.safetensors are gitignored — a weight file must never be tracked'
    ).toEqual([]);
    expect(oversizeFeatureFiles, 'speech-named paths must stay far under the size cap').toEqual([]);
  });

  it('.gitignore actively blocks the engine models directory and every weight extension', () => {
    const activeEntries = readText('.gitignore')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    for (const required of [
      'speech-engine/models/',
      '*.bin',
      '*.onnx',
      '*.gguf',
      '*.ggml',
      '*.safetensors',
    ]) {
      expect(
        activeEntries,
        `.gitignore must contain an active (non-comment) rule "${required}" under the ` +
        '"Live Sermon Assist — model weights are never tracked" block'
      ).toContain(required);
    }
  });

  it('git check-ignore confirms the rules take effect on synthetic paths', () => {
    const checkIgnore = (syntheticPath) => {
      try {
        const out = execSync(`git check-ignore -v -- ${JSON.stringify(syntheticPath)}`, {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        });
        return { ignored: true, out: out.trim() };
      } catch (err) {
        return { ignored: false, out: String(err.stdout ?? err.message).trim() };
      }
    };

    const cases = [
      { path: 'speech-engine/models/ggml-large-v3.bin', rule: /(\*\.bin|speech-engine\/models\/)/ },
      { path: 'speech-engine/models/notes.txt', rule: /speech-engine\/models\// },
      { path: 'weights/model.onnx', rule: /\*\.onnx/ },
      { path: 'weights/model.gguf', rule: /\*\.gguf/ },
    ];
    for (const { path, rule } of cases) {
      const result = checkIgnore(path);
      expect(result.ignored, `git check-ignore must ignore synthetic path ${path} (exit 0)`).toBe(true);
      expect(result.out, `${path} must be ignored by one of the weight rules`).toMatch(rule);
      expect(result.out).toContain('.gitignore:');
    }
  });
});

// ===========================================================================
// Invariant 4
// ===========================================================================

/**
 * "Off by default, cold by default. `speech.enabled` defaults to `false`.
 * With the default state, no process is spawned, no permission is requested,
 * no socket event is emitted, and no network request is made. Asserted in a
 * boot smoke test."
 */
describe('invariant 4: off by default, cold by default', () => {
  it('speechDefaults() and a reset store are enabled:false and where:local', () => {
    const defaults = speechDefaults();
    expect(defaults.enabled).toBe(false);
    expect(defaults.where).toBe('local');

    const state = useSpeechStore.getState();
    expect(state.enabled).toBe(false);
    expect(state.where).toBe('local');
    expect(state.status).toBe('idle');
  });

  it('a corrupt raw blob {enabled:true, status:"listening"} in localStorage rehydrates to enabled:false', async () => {
    // Written BEFORE the fresh import so rehydration sees it. The store's
    // merge/sanitize path drops the envelope-less blob entirely: zustand
    // passes `deserialized.state` (undefined here) to merge, and the store's
    // sanitizer rebuilds from defaults. A truthy non-boolean enabled collapses
    // even inside a valid envelope (asserted next).
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ enabled: true, status: 'listening' })
    );

    vi.resetModules();
    const { default: fresh } = await import('../../src/context/SpeechStore.js');
    await freshStoreHydration(fresh);

    expect(fresh.getState().enabled).toBe(false);
    expect(fresh.getState().status).toBe('idle');
    expect(fresh.getState().where).toBe('local');
  });

  it('an enveloped blob with non-boolean enabled also rehydrates to enabled:false', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { enabled: 'yes', status: 'listening' }, version: 0 })
    );

    vi.resetModules();
    const { default: fresh } = await import('../../src/context/SpeechStore.js');
    await freshStoreHydration(fresh);

    expect(fresh.getState().enabled).toBe(false);
    expect(fresh.getState().status).toBe('idle');
  });

  it('the scanner itself flags top-level calls and ignores calls inside functions, arrows, and comments', () => {
    const cases = [
      { src: "spawn('x');", hits: 1 },
      { src: "const f = function () { spawn('x'); };", hits: 0 },
      { src: "const f = () => fetch('/x');", hits: 0 },
      { src: "// spawn('x')\nconst s = 'spawn()'; /* fork('x') */", hits: 0 },
      { src: "if (armed) {\n  getUserMedia();\n}", hits: 1 },
      { src: "const md = () => navigator.mediaDevices.getUserMedia();", hits: 0 },
      { src: "new WebSocket('ws://127.0.0.1:4000');", hits: 1 },
      { src: "const routes = { ping: fetch('https://example.com') };", hits: 1 },
      { src: "const el = <div onClick={() => spawn('x')} />;", hits: 0 },
      { src: "const el = <div className={c} />;", hits: 0 },
      { src: "const url = `v${fetch('/x')}`;", hits: 1 },
      { src: "const a = radio('x'); video('y');", hits: 0 },
      { src: "const io = require('socket.io');", hits: 0 },
    ];
    for (const { src, hits } of cases) {
      expect(scanSource(src).length, `scan(${JSON.stringify(src)}) should report ${hits} hit(s)`).toBe(hits);
    }
    // Line numbers survive comment stripping.
    expect(scanSource("// note\nspawn('x');")[0].line).toBe(2);
  });

  it('no speech module contains an import-time spawn, socket, permission, or network call', () => {
    const violations = [];
    for (const relPath of coldScanTargets()) {
      const sanitized = sanitizeSource(readText(relPath));
      for (const hit of findTopLevelForbiddenCalls(sanitized)) {
        violations.push(`${relPath}:${hit.line}: top-level call to ${hit.call}`);
      }
    }
    expect(
      violations,
      'plan section 5 invariant 4: with default state nothing may spawn a process, open a ' +
      'socket, request a permission, or make a network request — and that must hold at IMPORT ' +
      'time, not only at runtime. Move the call inside a function that only runs after the user ' +
      'enables Sermon Assist.'
    ).toEqual([]);
  });

  /**
   * The scan above is only as good as its file list, and the list used to omit
   * the modules that matter most: speechEngine.js (which calls fork()),
   * speechIpc.js, speechDownloader.js, speechHistory.js, all of src/speech/**
   * (including engineTransport.js, the one renderer file that opens a socket),
   * usePanicStop.js and useAudioDevices.js. Nothing in them had an import-time
   * side effect, so the invariant held — but a top-level `fork()` added to
   * speechEngine.js tomorrow would have passed CI, because the gate never read
   * that file.
   *
   * So the coverage itself is pinned. If one of these files is ever renamed,
   * deleted, or deliberately dropped from the scan, this fails and the reason
   * has to be written down rather than discovered later.
   */
  it('the cold-by-default scan covers the modules that spawn, socket, and capture', () => {
    const covered = coldScanTargets();

    const mustCover = [
      // the forker — the single most important file for this invariant
      'main/speechEngine.js',
      'main/speechIpc.js',
      'main/speechDownloader.js',
      'main/speechHistory.js',
      // the only renderer file that opens a socket
      'src/speech/engineTransport.js',
      'src/speech/index.js',
      // media capture, by mount-time behaviour rather than by filename
      'src/hooks/usePanicStop.js',
      'src/hooks/useAudioDevices.js',
      'src/hooks/useAudioCapture.js',
      'src/workers/pcmWorklet.js',
      'src/workers/pcmCapture.js',
      'src/components/Speech/SermonAssistPanel.jsx',
      'src/context/SpeechStore.js',
    ];
    for (const relPath of mustCover) {
      expect(covered, `cold-by-default scan must cover ${relPath}`).toContain(relPath);
    }

    // And it must actually be reading a non-trivial number of files, so a
    // future edit that empties the glob cannot pass unnoticed.
    expect(covered.length).toBeGreaterThanOrEqual(30);
  });

  it('boot smoke: a fresh store import and a default-state render trip no fetch, WebSocket, XHR, or mediaDevices', async () => {
    const trips = [];
    const restore = [];

    const spyOn = (obj, key, label) => {
      const original = obj[key];
      restore.push(() => {
        obj[key] = original;
      });
      obj[key] = function spy(...args) {
        trips.push(`${label}: ${String(args[0] ?? '')}`);
        return original ? original.apply(this, args) : undefined;
      };
    };

    spyOn(globalThis, 'fetch', 'fetch');
    if (typeof globalThis.WebSocket === 'function') spyOn(globalThis, 'WebSocket', 'WebSocket');
    if (typeof XMLHttpRequest !== 'undefined') {
      spyOn(XMLHttpRequest.prototype, 'open', 'xhr.open');
      spyOn(XMLHttpRequest.prototype, 'send', 'xhr.send');
    }
    // navigator.mediaDevices may not exist in jsdom; install a recording getter.
    const hadMediaDevices = Object.prototype.hasOwnProperty.call(navigator, 'mediaDevices');
    const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    restore.push(() => {
      if (hadMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
      else delete navigator.mediaDevices;
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      get() {
        trips.push('navigator.mediaDevices');
        return undefined;
      },
    });

    try {
      // Fresh module graph: the store must boot cold even from scratch.
      vi.resetModules();
      const { default: fresh } = await import('../../src/context/SpeechStore.js');
      await freshStoreHydration(fresh);
      expect(fresh.getState().enabled).toBe(false);
      expect(fresh.getState().where).toBe('local');

      // Default-state render of the panel (static graph — same React instance
      // as @testing-library/react): must be zero DOM nodes, no side effects.
      useSpeechStore.getState().resetToDefaults();
      const { container } = render(createElement(SermonAssistPanel));
      expect(container.innerHTML).toBe('');
    } finally {
      restore.reverse().forEach((fn) => fn());
    }

    expect(
      trips,
      'boot smoke: something performed a side effect while the feature was off — ' +
      'invariant 4 forbids network, socket, and media access at boot'
    ).toEqual([]);
  });

  it('SermonAssistPanel renders zero DOM nodes with the default state', () => {
    useSpeechStore.getState().resetToDefaults();
    const { container } = render(createElement(SermonAssistPanel));
    expect(container.innerHTML).toBe('');
    expect(container.childNodes.length).toBe(0);
  });

  it('preload.js exposes exactly the Phase 2 speech: channel set — pinned, not merely present', () => {
    // DELIBERATE CHANGE (Phase 2). This assertion used to read:
    //     expect(/speech/i.test(preload)).toBe(false);
    // — i.e. "preload.js exposes no speech: IPC channel yet". Phase 2 lands
    // the engine-control surface, so the assertion now PINS the set instead
    // of banning it: every speech:* channel literal in preload.js must appear
    // in the explicit list below, and every listed channel must exist there.
    // Adding or renaming a channel is therefore a two-place, reviewed diff
    // with a comment per channel — never a silent surface change, and never a
    // weakened assertion.
    const extractSpeechChannels = (relPath) =>
      [...new Set([...readText(relPath).matchAll(/'(speech:[a-z0-9:-]+)'/g)].map((m) => m[1]))].sort();

    // The inventory: every renderer->main invoke and main->renderer event,
    // including the trusted-LAN probe, cloud control plane, and measured
    // auto-selection. Sorted, so the comparison is order-blind.
    const EXPECTED_SPEECH_CHANNELS = [
      'speech:auto-select-model', // INVOKE, live: measured matrix + verified auto-selection
      'speech:benchmark', // INVOKE, stub: Phase 3 benchmark
      'speech:cloud:consent', // INVOKE: explicit egress acknowledgement before first cloud start
      'speech:cloud:key:clear', // INVOKE: delete the stored OpenAI key
      'speech:cloud:key:get', // INVOKE: { configured } only — never the key text
      'speech:cloud:key:set', // INVOKE: save the key through the keytar-backed store
      'speech:engine-selftest', // INVOKE, live: spawn whisper-cli --help and report loader failures
      'speech:error', // EVENT: one clear engine error (crash loop, bad API, spawn failure)
      'speech:get-state', // INVOKE, live: current supervisor + install state
      'speech:health', // EVENT: engine health snapshot (apiVersion, rtf, memory, pid, uptime)
      // Decision D9 / Phase 4 — the six transcript-history invokes (added
      // with the history feature; summaries-only list, full get, bounded
      // search excerpts, file export, whole-history erase with bytes
      // reclaimed, and the append write path for the supervisor).
      'speech:history:append', // INVOKE, live: { op:'begin'|'segment'|'end' } — the history write path
      'speech:history:erase', // INVOKE, live: erase ALL transcript history, report bytes reclaimed
      'speech:history:export', // INVOKE, live: { format:'json'|'text' } -> writes an export file, returns its path
      'speech:history:get', // INVOKE, live: { sessionId } -> one session WITH its segments
      'speech:history:list', // INVOKE, live: -> summaries newest first (no segment text in the payload)
      'speech:history:search', // INVOKE, live: { query } -> matching sessions + segment excerpts
      'speech:install', // INVOKE, stub: model downloader
      'speech:install-engine', // INVOKE, live: download + verify + unpack the real whisper.cpp binary
      'speech:install-state', // EVENT: discovery outcome { available, mode, endpoint, reason }
      'speech:progress', // EVENT: model download / benchmark progress
      'speech:select-model', // INVOKE, stub: engine session wiring
      'speech:start', // INVOKE, live: the one start path (invariant 4's gate)
      'speech:status', // EVENT: supervisor lifecycle { status, reason, at }
      'speech:stop', // INVOKE, live: stop the local engine, or just tear down a remote session
      'speech:test-network', // INVOKE, live: read-only health check for the trusted-LAN engine
      'speech:transcript', // EVENT: relayed partial/final segments (the only channel carrying text)
      'speech:uninstall', // INVOKE: { confirm:false } preview; { confirm:true } erase
      'speech:vad', // EVENT: voice-activity state word — feedback before the first final, never audio
    ];

    expect(
      extractSpeechChannels('preload.js'),
      'preload.js must expose exactly the pinned speech:* channel set'
    ).toEqual(EXPECTED_SPEECH_CHANNELS);

    // The main-process half must agree — or a channel exists that the
    // renderer can never reach, or one is handled that no renderer can call.
    expect(
      extractSpeechChannels('main/speechIpc.js'),
      'main/speechIpc.js must register exactly the same speech:* channel set'
    ).toEqual(EXPECTED_SPEECH_CHANNELS);
  });

  /**
   * Regression: `useModelInstallState` is instantiated TWICE on the Sermon
   * Assist settings screen — by InstallEngineWizard and by ModelCatalogList,
   * both rendered by SpeechSettingsSection. The preload subscribe helper once
   * called `ipcRenderer.removeAllListeners(channel)` before adding its own
   * listener, so mounting the second consumer silently evicted the first
   * consumer's listeners on speech:install-state, speech:progress and
   * speech:error.
   *
   * The visible damage was the worst kind: the install wizard's progress bar
   * froze at its initial state, and because ModelCatalogList renders no error
   * surface of its own, a failed multi-gigabyte download produced no error
   * message anywhere in the UI.
   *
   * So this is pinned as an invariant, not a comment: a speech:* channel with
   * more than one subscriber must not be able to evict its other subscribers.
   */
  it('preload speech subscribe does not evict other subscribers on the same channel', () => {
    const preload = readText('preload.js');

    // Isolate the speech subscribe helper, then assert on its body only.
    const helperStart = preload.indexOf('const onSpeechEvent = (channel, callback) =>');
    expect(helperStart, 'preload.js must define onSpeechEvent').toBeGreaterThan(-1);
    const helperEnd = preload.indexOf('\n};', helperStart);
    expect(helperEnd, 'onSpeechEvent must be a complete function').toBeGreaterThan(helperStart);
    const helper = preload.slice(helperStart, helperEnd);

    expect(
      helper,
      'onSpeechEvent must not removeAllListeners: two components subscribe to the ' +
        'same speech:* channels on the same screen, and eviction freezes the install ' +
        "wizard's progress and swallows download errors"
    ).not.toMatch(/removeAllListeners/);

    // The unsubscribe closure must still release exactly this listener.
    expect(helper, 'onSpeechEvent must return an unsubscribe closure').toMatch(
      /removeListener\(channel, listener\)/
    );
  });

  /**
   * The two-subscriber fact above is load-bearing, so pin it too: if one of
   * these components stops consuming the shared hook, the preload assertion
   * above is asserting a scenario that no longer exists and should be revisited
   * rather than silently kept.
   */
  it('useModelInstallState still has more than one consumer on the settings screen', () => {
    const consumers = ['InstallEngineWizard.jsx', 'ModelCatalogList.jsx'];
    for (const file of consumers) {
      expect(
        /useModelInstallState\s*\(/.test(readText(`src/components/Speech/${file}`)),
        `${file} must still consume useModelInstallState — two subscribers per ` +
          'speech:* channel is the case preload.js must keep supporting'
      ).toBe(true);
    }
  });
});

// ===========================================================================
// Invariant 5
// ===========================================================================

/**
 * "Audio stays local unless cloud is chosen. The engine binds 127.0.0.1 only
 * and rejects non-loopback peers. The cloud path is reachable only after a
 * provider, a stored key, and an explicit acknowledgement that audio leaves
 * the machine."
 *
 * No engine exists yet (Phase 3), so this asserts what exists today: the
 * protocol's loopback and origin gates, the absence of wildcard binds in
 * speech code, and the store/permission defaults that keep audio local.
 */
describe('invariant 5: audio stays local unless cloud is chosen', () => {
  it('isLoopbackHost accepts only loopback addresses', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '127.0.0.53', '[::1]:4000', '127.0.0.1:4000']) {
      expect(isLoopbackHost(host), `${host} is loopback`).toBe(true);
    }
    for (const host of ['0.0.0.0', '192.168.1.5', '10.0.0.1', '', '::', 'example.com', 'myserver.local', null, 42]) {
      expect(isLoopbackHost(host), `${JSON.stringify(host)} must not count as loopback`).toBe(false);
    }
  });

  it('origins are loopback only — the dev server and the packaged backend, no wildcard, no LAN origin', () => {
    expect([...ALLOWED_ORIGINS]).toEqual([
      'http://127.0.0.1:4000',
      'http://localhost:4000',
      'http://127.0.0.1:5174',
      'http://localhost:5174',
    ]);
    // A custom PORT (dogfood/side-by-side) is still loopback and still carries
    // the per-launch token; a LAN or file origin never reaches the token gate.
    expect(isAllowedOrigin('http://localhost:4321')).toBe(true);
    expect(isAllowedOrigin('http://192.168.1.5:4000')).toBe(false);
    expect(isAllowedOrigin('file:///tmp/index.html')).toBe(false);
    expect(isAllowedOrigin('http://evil.example.com')).toBe(false);
  });

  it('no speech module binds 0.0.0.0, "::", or INADDR_ANY', () => {
    const offenders = [];
    for (const relPath of bindScanTargets()) {
      const lines = readText(relPath).split('\n');
      lines.forEach((line, index) => {
        // A `bind-scan-exempt:` marker is an explicit, reviewed decision for a
        // client-side REJECTION of a wildcard endpoint (speechRemote.js): the
        // literal is banned as a BIND target, not as a value we refuse.
        if (/bind-scan-exempt:/.test(line)) return;
        // Comments are fine (a comment may explain "never 0.0.0.0"); an
        // occurrence in code is not. Cheap and honest: strip `//` comments.
        const code = line.split('//')[0];
        if (/0\.0\.0\.0/.test(code)) offenders.push(`${relPath}:${index + 1}: 0.0.0.0`);
        if (/\bINADDR_ANY\b/.test(code)) offenders.push(`${relPath}:${index + 1}: INADDR_ANY`);
        if (/['"]::['"]/.test(code)) offenders.push(`${relPath}:${index + 1}: '::'`);
      });
    }
    expect(
      offenders,
      'plan section 5 invariant 5: the speech engine binds 127.0.0.1 only — a wildcard or LAN ' +
      'bind would expose live sermon audio to the network'
    ).toEqual([]);
  });

  it('the store defaults to local with no cloud provider chosen', () => {
    const defaults = speechDefaults();
    expect(defaults.where).toBe('local');
    expect(defaults.cloudProviderId).toBeNull();
    expect(defaults.networkEndpoint).toBeNull();

    const state = useSpeechStore.getState();
    expect(state.where).toBe('local');
    expect(state.cloudProviderId).toBeNull();
    expect(state.networkEndpoint).toBeNull();
  });

  it('media permission is denied for any window that is not the control window', () => {
    const denied = decidePermission({ permissionName: 'media', isControlWindow: false });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('media-denied-not-control-window');

    const quitting = decidePermission({ permissionName: 'media', isControlWindow: true, isQuitting: true });
    expect(quitting.allowed).toBe(false);
  });

  // The cloud half of this invariant is now exercised for real in
  // tests/speech/cloudOpenAiRouting.test.js: a stored key AND an explicit
  // egress acknowledgement are both required before any fork happens.
});

// ===========================================================================
// Invariant 6
// ===========================================================================

/**
 * "Uninstall is real. A single action removes the engine directory, every
 * model file, the transcript history, the benchmark results, and the stored
 * key, and reports the bytes reclaimed."
 *
 * Phase 6 builds the filesystem half. Today this asserts the store half —
 * reset must actually restore every default and stop persisting runtime
 * state — plus the catalog's downloadBytes, which is what makes
 * "bytes reclaimed" computable later.
 */
describe('invariant 6: uninstall is real', () => {
  it('resetToDefaults is a function that restores every default', () => {
    const store = useSpeechStore.getState();
    expect(typeof store.resetToDefaults).toBe('function');

    // Dirty everything a user could dirty.
    store.setEnabled(true);
    store.setWhere('cloud');
    store.setCloudProviderId('openai');
    store.setModelId('small.en-q8_0');
    store.setHistoryEnabled(false);
    store.setAudioSource({ sourceId: 'mic-1', sourceKind: 'microphone' });
    store.setUI({ railCollapsed: false });

    useSpeechStore.getState().resetToDefaults();

    const state = useSpeechStore.getState();
    expect(state.enabled).toBe(false);
    expect(state.where).toBe('local');
    expect(state.modelId).toBe('large-v3');
    expect(state.providerId).toBe('whispercpp');
    expect(state.cloudProviderId).toBeNull();
    expect(state.networkEndpoint).toBeNull();
    expect(state.historyEnabled).toBe(true);
    expect(state.audio.sourceId).toBeNull();
    expect(state.ui.railCollapsed).toBe(true);
  });

  it('reset never persists runtime status, health, or lastError — and storage no longer holds a non-default enabled', () => {
    useSpeechStore.getState().setEnabled(true);
    useSpeechStore.getState().setStatus('listening');
    useSpeechStore.getState().setHealth({ ok: true });
    useSpeechStore.getState().setLastError('boom');
    useSpeechStore.getState().resetToDefaults();

    const blob = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(blob).toBeTruthy();
    expect(blob.state.enabled, 'storage must hold the default enabled after reset').toBe(false);
    expect(blob.state).not.toHaveProperty('status');
    expect(blob.state).not.toHaveProperty('health');
    expect(blob.state).not.toHaveProperty('lastError');
  });

  it('every model declares downloadBytes so bytes reclaimed can be computed', () => {
    const catalog = readJson('shared/speech/models.catalog.json');
    // Not a fixed count: the catalog mirrors whatever upstream publishes, so it
    // grows when upstream grows. What invariant 6 actually needs is that every
    // row can be summed for bytes-reclaimed — which is what is asserted below.
    expect(catalog.models.length).toBeGreaterThan(0);
    for (const model of catalog.models) {
      expect(typeof model.downloadBytes, `${model.id} must declare downloadBytes`).toBe('number');
      expect(model.downloadBytes).toBeGreaterThan(0);
    }
    const total = catalog.models.reduce((sum, model) => sum + model.downloadBytes, 0);
    expect(total).toBeGreaterThan(0);
  });

  // =========================================================================
  // Invariant 6 — one-click erase. This was an it.todo from Phase 0 until
  // Phase 6. It now runs against a REAL temp directory rather than mocks,
  // because the thing being asserted is that files are gone — a mock cannot
  // demonstrate that, and a mocked rm would pass here forever while the real
  // handler pointed at the wrong path.
  // =========================================================================
  describe('one-click erase', () => {
    let userDataDir;

    beforeEach(() => {
      userDataDir = mkdtempSync(join(tmpdir(), 'ld-erase-'));
      // The four things plan 5.6 names, in the four places they live.
      mkdirSync(join(userDataDir, 'speech-engine', 'models'), { recursive: true });
      mkdirSync(join(userDataDir, 'speech-engine', 'history', 'exports'), { recursive: true });
      writeFileSync(join(userDataDir, 'speech-engine', 'models', 'large-v3.bin'), Buffer.alloc(4096));
      writeFileSync(join(userDataDir, 'speech-engine', 'models', 'tiny.bin'), Buffer.alloc(1024));
      writeFileSync(join(userDataDir, 'speech-engine', 'history', 'session-1.jsonl'), 'transcript');
      writeFileSync(join(userDataDir, 'speech-engine', 'history', 'exports', 'sermon.txt'), 'export');
      writeFileSync(join(userDataDir, 'speech-engine', 'engine.mjs'), 'engine');
    });

    afterEach(() => {
      rmSync(userDataDir, { recursive: true, force: true });
    });

    it('plans every one of the four locations and totals their real bytes', async () => {
      const plan = await planErase({ userDataDir });

      expect(plan.exists).toBe(true);
      // All four steps named by the plan: history, exports, models, engine.
      expect(plan.steps.map((s) => s.id).sort()).toEqual([...ERASE_STEPS].sort());

      const byId = Object.fromEntries(plan.steps.map((s) => [s.id, s]));
      expect(byId.models.bytes).toBe(5120); // 4096 + 1024, actually stat()ed
      expect(byId.history.bytes).toBeGreaterThan(0);
      expect(byId.exports.bytes).toBeGreaterThan(0);
      // The engine step contributes only what the inner steps did not already
      // count (here: engine.mjs). Otherwise 3.1 GB becomes 6.2 GB and the
      // user is told they got back twice what they did.
      expect(byId.engine.exists, 'the engine root must always be scheduled when it exists').toBe(true);
      expect(byId.engine.bytes).toBe(6); // "engine"

      const inner = byId.models.bytes + byId.history.bytes + byId.exports.bytes;
      expect(plan.totalBytes).toBe(inner + byId.engine.bytes);
      // And the sum equals the whole tree exactly once — no file counted twice.
      // 4096 + 1024 (models) + 10 ("transcript") + 6 ("export") + 6 ("engine")
      expect(plan.totalBytes).toBe(5142);
    });

    it('the preview removes NOTHING — a preview that deletes is not a preview', async () => {
      await planErase({ userDataDir });
      expect(existsSync(join(userDataDir, 'speech-engine', 'models', 'large-v3.bin'))).toBe(true);
      expect(existsSync(join(userDataDir, 'speech-engine', 'history', 'session-1.jsonl'))).toBe(true);
    });

    it('removes engine dir, model files, and transcript history, and reports bytes reclaimed', async () => {
      const plan = await planErase({ userDataDir });
      for (const step of plan.steps) {
        if (!step.exists) continue;
        const outcome = await removePathStep({ id: step.id, target: step.path, bytes: step.bytes });
        expect(outcome.ok, `${step.id}: ${outcome.code ?? 'failed'}`).toBe(true);
      }

      // Every one of them is actually gone from disk.
      expect(existsSync(join(userDataDir, 'speech-engine'))).toBe(false);

      const reclaimed = plan.totalBytes;
      expect(reclaimed).toBeGreaterThan(0);
    });

    it('a missing directory is a no-op, not a failure', async () => {
      const outcome = await removePathStep({ id: 'models', target: join(userDataDir, 'nope'), bytes: 0 });
      expect(outcome.ok).toBe(true);
      expect(outcome.bytes).toBe(0);
    });

    it('says nothing to remove rather than erroring on a clean machine', async () => {
      rmSync(join(userDataDir, 'speech-engine'), { recursive: true, force: true });
      const plan = await planErase({ userDataDir });
      expect(plan.exists).toBe(false);
      expect(plan.totalBytes).toBe(0);
      expect(describeErase(plan)).toMatch(/nothing to remove/i);
    });

    it('the confirmation states the size, that it cannot be undone, and that a live run stops', () => {
      const plan = { exists: true, totalBytes: 3_100_000_000, steps: [{ id: 'models', exists: true }] };
      const text = describeErase(plan, { running: true });
      // 3.1e9 bytes = 3.1 GB decimal, matching every other size in the UI.
      expect(text).toMatch(/3\.1 GB/);
      expect(text).toMatch(/cannot be undone/i);
      expect(text).toMatch(/stop/i);
      // Without a live run it must not claim something is stopping.
      expect(describeErase(plan, { running: false })).not.toMatch(/will stop/i);
    });

    it('formats bytes in units an operator can act on', () => {
      expect(formatBytes(0)).toBe('0 bytes');
      expect(formatBytes(512)).toBe('512 bytes');
      expect(formatBytes(3_100_000_000)).toBe('3.1 GB');
      expect(formatBytes(-1)).toBe('0 bytes');
      expect(formatBytes(NaN)).toBe('0 bytes');
    });
  });
});

// ===========================================================================
// The catalog ships, the weights do not — the plan's deliberate bend.
// ===========================================================================

describe('the catalog ships, the weights do not', () => {
  const raw = readText('shared/speech/models.catalog.json');
  const catalog = JSON.parse(raw);

  const allKeys = [];
  const allStrings = [];
  (function collect(value) {
    if (typeof value === 'string') {
      allStrings.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(collect);
    } else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) allKeys.push(key);
      Object.values(value).forEach(collect);
    }
  })(catalog);

  it('the catalog is a small text file under 40 KB', () => {
    expect(raw.length).toBeLessThan(40 * 1024);
  });

  it('no value string is longer than the file containing it', () => {
    // Trivially true for healthy metadata, catastrophically false if someone
    // ever serialises a blob into a field — that is exactly what it guards.
    const longest = allStrings.reduce((max, s) => Math.max(max, s.length), 0);
    expect(longest).toBeLessThan(raw.length);
  });

  it('no field looks like model data: no weight fields, no base64 blobs, no data: URIs', () => {
    const weightishKeys = allKeys.filter((key) =>
      /(weight|tensor|blob|base64|checkpoint|embedding|buffer|state_dict)/i.test(key)
    );
    expect(weightishKeys, 'the catalog is metadata — no field may carry model data').toEqual([]);
    expect(/[A-Za-z0-9+/]{200,}={0,2}/.test(raw), 'no base64 blob may appear in the catalog').toBe(false);
    expect(/data:/i.test(raw), 'no data: URI may appear in the catalog').toBe(false);
  });
});
