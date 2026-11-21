/**
 * src/speech/setupPlan.js — the volunteer's view of Sermon Assist setup.
 *
 * Nobody should have to know what a whisper binary, a GGML weight, a CUDA
 * runtime or a checksum is to use Sermon Assist. This module turns a probe and
 * the current install state into one plain plan: which model to get, which
 * steps still need doing, and what to say when a step fails.
 *
 * PURE: no bridge, no I/O, no React. Model ids come from the catalog, so a
 * rename upstream fails a test instead of silently offering a missing file.
 */
import catalog from '../../shared/speech/models.catalog.json';
import { normalizeBackend, probeBackendOf } from './modelGuidance.js';

/** The model we install for the operator. Serious on GPU, quick on CPU. */
export const STARTER_MODELS = Object.freeze({
  gpu: 'large-v3-turbo',
  cpu: 'tiny.en-q5_1',
});

const MODEL_IDS = new Set((catalog.models ?? []).map((model) => model.id));

export const SETUP_STEPS = Object.freeze([
  { id: 'check', label: 'Checking this computer' },
  { id: 'engine', label: 'Installing the speech engine' },
  { id: 'test', label: 'Checking the engine starts' },
  { id: 'model', label: 'Downloading the voice model' },
  { id: 'select', label: 'Finishing setup' },
]);

/** Current CUDA version from the probe, using the same nested shape as main. */
function probeCudaVersion(gpu) {
  if (typeof gpu?.cudaVersion === 'string') return gpu.cudaVersion;
  if (typeof gpu?.backends?.cuda?.cudaVersion === 'string') return gpu.backends.cuda.cudaVersion;
  return null;
}

/**
 * What a one-click setup will do on this machine.
 *
 * FIXED AFTER JURY REVIEW: the starter model follows the engine that is
 * actually installed (or the one the installer says it selected), never the
 * raw hardware probe. A Vulkan/Metal/Linux-CUDA probe or an old CPU binary
 * must not download a 1.5 GB large model onto a CPU engine.
 *
 * @param {object} [options]
 * @param {object|null} [options.gpu] probe result from main
 * @param {boolean} [options.engineInstalled] is a usable engine on disk?
 * @param {string|null} [options.engineBackend] manifest backend: cuda|cpu|null
 * @param {string|null} [options.engineSelectionCode] why the installed backend was chosen
 * @param {string[]} [options.installedIds] model ids already on disk
 * @returns {{backend: string, probeBackend: string, engineBackend: string|null,
 *            graphicsCard: boolean, modelId: string, modelName: string,
 *            steps: Array<object>, needsEngine: boolean, needsModel: boolean,
 *            ready: boolean, sizeNote: string, deviceNote: string}}
 */
export function setupPlan({
  gpu = null,
  engineInstalled = false,
  engineBackend = null,
  engineSelectionCode = null,
  engineCudaVersion = null,
  installedIds = [],
} = {}) {
  const probeBackend = probeBackendOf(gpu);
  const installedBackend = engineInstalled ? normalizeBackend(engineBackend) : null;
  const fallbackCodes = new Set([
    'unsupported-backend-asset',
    'cuda-driver-too-old',
    'cuda-version-unknown',
  ]);
  const currentCudaVersion = probeCudaVersion(gpu);
  // A fallback code only blocks a retry against the SAME driver version.
  // A later driver/CUDA upgrade must be allowed to repair the engine.
  const sameFailedCudaAttempt =
    fallbackCodes.has(engineSelectionCode) &&
    (currentCudaVersion ?? null) === (engineCudaVersion ?? null);
  const canUpgradeToCuda =
    engineInstalled === true &&
    installedBackend !== 'cuda' &&
    probeBackend === 'cuda' &&
    !sameFailedCudaAttempt;
  const needsEngine = !engineInstalled || canUpgradeToCuda;
  const targetBackend = needsEngine
    ? (probeBackend === 'cuda' ? 'cuda' : 'cpu')
    : (installedBackend ?? 'cpu');
  const graphicsCard = engineInstalled === true && installedBackend === 'cuda';
  const modelId = targetBackend === 'cuda' ? STARTER_MODELS.gpu : STARTER_MODELS.cpu;
  const row = (catalog.models ?? []).find((model) => model.id === modelId);
  const needsModel = !(Array.isArray(installedIds) ? installedIds : []).includes(modelId);

  const steps = SETUP_STEPS.filter((step) => {
    if (step.id === 'engine') return needsEngine;
    if (step.id === 'model') return needsModel;
    return true;
  });

  const downloads = [];
  if (needsEngine) {
    downloads.push(
      targetBackend === 'cuda'
        ? 'the graphics-card engine (up to about 650 MB)'
        : 'the standard engine (about 9 MB)'
    );
  }
  if (needsModel) {
    downloads.push(`the voice model (${row?.downloadLabel ?? 'the right size for this computer'})`);
  }
  const sizeNote = downloads.length
    ? `Selah will download ${downloads.join(' and ')}.`
    : 'Everything needed is already installed. Selah will check it and finish setup.';

  let deviceNote;
  if (graphicsCard) {
    deviceNote = 'A graphics-card engine is installed. The benchmark will confirm whether it actually runs on the graphics card.';
  } else if (engineInstalled) {
    deviceNote = 'This computer is using its processor. It still works, but larger voice models are too slow for live use.';
  } else if (probeBackend === 'cuda') {
    deviceNote = 'Selah found a graphics card. It will install the matching engine, then choose the larger voice model only if that engine is really installed.';
  } else {
    deviceNote = 'Selah will check this computer and choose a safe voice model before downloading anything.';
  }

  return {
    backend: targetBackend,
    probeBackend,
    engineBackend: installedBackend,
    engineCudaVersion: engineCudaVersion ?? null,
    engineInstalled: engineInstalled === true,
    graphicsCard,
    modelId,
    modelName: row?.displayName ?? modelId,
    steps,
    needsEngine,
    needsModel,
    ready: !needsEngine && !needsModel,
    sizeNote,
    deviceNote,
  };
}

/** Plain sentences for failures. Codes stay in the collapsed support details. */
const FRIENDLY_ERRORS = Object.freeze({
  'unsupported-platform': 'Selah does not have a ready-made speech engine for this computer. A future Selah update can add support.',
  'digest-mismatch': 'A download did not pass its safety check. Nothing was installed. Try again.',
  'cuda-driver-too-old': 'This computer has a graphics card, but its driver is too old for the faster engine. Selah will use the standard engine instead.',
  'cuda-version-unknown': 'Selah could not tell which graphics driver this computer has, so it will use the standard engine instead.',
  'unsupported-backend-asset': 'There is no ready-made engine for this graphics card yet, so Selah will use the standard engine instead.',
  'download-failed': 'The download did not finish. Check the internet connection and try again.',
  'network-unavailable': 'Selah cannot download the speech engine right now. Check the internet connection and try again.',
  'install-failed': 'Selah could not install the speech engine. Press Set up Sermon Assist again; if it still fails, share the details with support.',
  'corrupt-archive': 'The downloaded engine was not usable. Nothing was installed. Try again.',
  'engine-not-runnable': 'The speech engine installed but did not start. Press Set up Sermon Assist again; if it still fails, share the details with support.',
  'select-model': 'The voice model could not be selected. Press Set up Sermon Assist again.',
  'setup-busy': 'Sermon Assist is running. Stop it before setup, then try again.',
});

export function friendlyError(code, fallback = 'Setup could not finish. Try again.') {
  return FRIENDLY_ERRORS[code] ?? fallback;
}

/** Guard so a catalog rename cannot silently break the volunteer path. */
export function starterModelsAreInCatalog() {
  return Object.values(STARTER_MODELS).every((id) => MODEL_IDS.has(id));
}
