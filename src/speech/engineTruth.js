/**
 * engineTruth.js — is the engine that is actually running real?
 *
 * WHY THIS FILE EXISTS. The engine shipped in this PR is `fakeEngine.js`: a
 * contract-conformant stand-in that ignores the audio bytes and replays a
 * canned sentence, because the native whisper.cpp binding does not exist yet.
 * It reports `backend: 'fake'` in its health payload, and that value travels
 * all the way to the renderer (`fakeEngine.js` -> `main/speechEngine.js`
 * `buildHealthPayload` -> `speech:health` IPC) — where it was never read.
 *
 * So the UI showed a green ON badge, "Local · large-v3", a "Listening" chip and
 * an install wizard saying "Ready to transcribe with Large v3", attached to a
 * process emitting a string it wrote itself. For a church operator that is
 * worse than a broken feature: it is a feature that confidently reports
 * transcribing a sermon while doing nothing of the kind. `large-v3` also
 * advertises `wordTimestamps` and `biasSupport`, which enables all three
 * suggestion lanes, so a stray tap could put canned text on the sanctuary
 * screens.
 *
 * The rule this module encodes is simple and deliberately blunt: **canned
 * output may never look like transcription.** Anything derived from a fake
 * backend is labelled as such wherever it is shown, and is never eligible to
 * become a sendable suggestion.
 *
 * Pure functions, no I/O, no store access, no imports — so importing this
 * performs nothing (invariant 4: off by default, cold by default).
 */

/**
 * The backend identifier the contract-conformant fake engine reports.
 * Kept as a named constant so a rename in `speech-engine/fakeEngine.js` shows
 * up as a failing test here rather than as a silently-mislabelled badge.
 */
export const FAKE_BACKEND = 'fake';

/**
 * Backends whose output is NOT a real transcription of the room.
 *
 * Exported as a FROZEN ARRAY, not a Set, on purpose. `Object.freeze` on a Set
 * freezes the Set object's own properties but leaves its contents mutable —
 * `CANNED_BACKENDS.add('whispercpp')` succeeds on a "frozen" Set, which would
 * silently reclassify the real engine as canned for every later caller in the
 * process. A frozen array is genuinely immutable.
 *
 * The Set used for lookups is built once here and never exported, so nothing
 * outside this module can widen the classification.
 */
export const CANNED_BACKENDS = Object.freeze([FAKE_BACKEND]);

const CANNED = new Set(CANNED_BACKENDS);

/**
 * @param {unknown} health a `speech:health` payload, or anything else
 * @returns {boolean} TRUE only when the running engine is known-canned
 */
export function isCannedEngine(health) {
  const backend = health?.backend;
  return typeof backend === 'string' && CANNED.has(backend);
}

/**
 * Is this health payload trustworthy as evidence of real transcription?
 *
 * Inverse of {@link isCannedEngine}, named for the call site: it answers
 * "may I treat this engine's output as a real transcript?". An unknown or
 * absent backend is NOT canned, because the only canned engine this codebase
 * ships is named `fake` and reports itself honestly. Failing closed on
 * `backend === 'unknown'` would disable the real engine too, the moment a
 * future whisper.cpp build reported a backend this file has not heard of.
 *
 * @param {unknown} health a `speech:health` payload, or anything else
 * @returns {boolean}
 */
export function isRealEngine(health) {
  return !isCannedEngine(health);
}

/**
 * The operator-facing label for a canned engine.
 *
 * Deliberately blunt and deliberately not styled as a warning the operator
 * can scroll past: it names the fact that nothing real is happening.
 *
 * @returns {string}
 */
export function cannedEngineLabel() {
  return 'TEST ENGINE — canned text, not real transcription';
}

/**
 * Compose the always-visible mode indicator (plan section 10) so it tells the
 * truth about which engine is behind it.
 *
 * The privacy requirement in section 10 is "an accurate, always-visible mode
 * indicator" — accuracy is the point, so a local model id must never be shown
 * on its own while the process behind it is emitting canned strings. The model
 * id is kept in the string (it is still the honest *configured* mode) but the
 * canned qualifier leads, so the operator reads the caveat first.
 *
 * @param {{where?: string, modelId?: string, cloudProviderId?: string|null,
 *          health?: object|null}} state
 * @returns {string}
 */
export function engineModeLabel({ where, modelId, cloudProviderId, health = null } = {}) {
  // The engine reports the model it actually loaded. Preferring it over the
  // configured id is the difference between "Local · large-v3" (what you
  // picked) and "Local · tiny.en" (what is transcribing) — and only the second
  // one is true while the engine runs. A canned engine's model id ("fake-canned")
  // is deliberately NOT used: the caveat is about the configured mode.
  const runningModel =
    !isCannedEngine(health) && typeof health?.model === 'string' && health.model
      ? health.model
      : modelId;
  // `where` is a CONFIGURATION choice, not proof of a connection. A remote
  // engine is labelled "Remote engine" only when a health payload from a
  // health-checked remote engine is present; a refused or dropped start
  // reads "not connected" instead. This is what keeps a failed network
  // start from wearing an honest-sounding but false badge.
  const connectedRemote = health?.remote === true && health?.status === 'ok';
  const base =
    where === 'local'
      ? `Local · ${runningModel}`
      : where === 'network'
        ? connectedRemote
          ? `Remote engine · ${health.model ?? 'connected'}`
          : 'Network · not connected'
        : `Cloud · ${cloudProviderId ?? 'not configured'}`;
  return isCannedEngine(health) ? `${cannedEngineLabel()} (${base})` : base;
}