/**
 * speech-engine/scripts/alias-hooks.mjs — resolve the app's `shared/` imports
 * when the smoke test runs under plain Node.
 *
 * The speech engine is a separate, zero-dependency package, but the smoke test
 * deliberately calls the app's real verse detector (`src/speech/detectVerse.js`)
 * so a transcript has to become a reference, not just text. That detector uses
 * the Vite alias `shared/...`; Node has no such alias. This loader maps only
 * that alias and leaves every other specifier alone.
 *
 * Registered from smoke.mjs via `module.register()`, so `node smoke.mjs` works
 * with no extra flags in CI.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// fileURLToPath, not URL.pathname: on Windows `pathname` starts with `/` and
// path.join turns that into `C:\...`, losing the UNC host the repo lives on
// when the test is driven from WSL.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function resolveAlias(specifier, context, nextResolve) {
  if (specifier === 'shared' || specifier.startsWith('shared/')) {
    let target = path.join(REPO_ROOT, specifier);
    // Vite resolves `shared/bible` to that folder's index.js; Node's ESM
    // resolver does not import directories. Add the index only when the
    // specifier has no extension and the directory has one.
    if (!path.extname(target) && existsSync(path.join(target, 'index.js'))) {
      target = path.join(target, 'index.js');
    }
    return nextResolve(pathToFileURL(target).href, context);
  }
  return nextResolve(specifier, context);
}

/** The loader-hook form used by module.register() on older Node. */
export async function resolve(specifier, context, nextResolve) {
  return resolveAlias(specifier, context, nextResolve);
}
