/**
 * tests/speech/installFlow.test.jsx — Live Sermon Assist Phase 2.
 *
 * The renderer half of the install flow, against a stubbed
 * `window.electronAPI.speech` bridge (no Electron, no network, no download):
 *
 *   - a cold render starts NOTHING (install is only ever a user click),
 *   - not-installed -> downloading -> installed -> first-benchmark-pending,
 *   - Cancel really sends `{ modelId, cancel: true }`,
 *   - failures surface as one sentence that names the offline drop-in
 *     directory,
 *   - the catalog's per-model states: Install / Resume / Installed, and a
 *     click on an installed card goes through speech:select-model.
 *
 * The target model defaults to the store's modelId (large-v3) — installing
 * the best model, not the smallest.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import UserPreferencesModal from '@/components/UserPreferencesModal';
import useSpeechStore, { speechDefaults } from '@/context/SpeechStore';
import { modelsForProvider } from 'shared/speech';

const MODELS_DIR = '/home/user/.config/Selah/speech-engine/models';

// These tests transform and mount the whole preferences modal while the rest
// of the suite runs; the assertions are synchronous, so give them headroom
// rather than letting load contention flake them.
const itFlow = (name, fn) => it(name, fn, 30000);

const emptyInstallState = () => ({
  available: false,
  mode: 'none',
  endpoint: null,
  entry: null,
  reason: 'no engine installed',
  modelsDir: MODELS_DIR,
  installed: [],
  partials: [],
  activeDownloads: [],
  engine: {
    installed: false,
    binDir: '/home/user/.config/Selah/speech-engine/bin',
    supported: true,
    release: 'b5454',
  },
});

/** A deterministic stand-in for the preload speech bridge. */
const createBridge = (installState = emptyInstallState()) => {
  const state = { installState };
  const listeners = { progress: [], installState: [], error: [] };
  const subscribe = (key, callback) => {
    listeners[key].push(callback);
    return () => {
      listeners[key] = listeners[key].filter((entry) => entry !== callback);
    };
  };

  let pendingInstall = null;

  const speech = {
    installCalls: [],
    selectCalls: [],
    getState: vi.fn(async () => ({
      ok: true,
      status: 'idle',
      running: false,
      installState: state.installState,
    })),
    install: vi.fn((payload) => {
      speech.installCalls.push(payload);
      if (payload?.cancel === true) {
        const pending = pendingInstall;
        pendingInstall = null;
        pending?.resolve({ ok: false, code: 'cancelled', message: 'Download cancelled.' });
        return Promise.resolve({
          ok: true,
          cancelled: true,
          modelId: payload.modelId,
          bytesReclaimed: 4096,
        });
      }
      // The real download is long-lived: hold the promise open until the
      // test decides how it settles.
      return new Promise((resolve) => {
        pendingInstall = { resolve };
      });
    }),
    selectModel: vi.fn(async (payload) => {
      speech.selectCalls.push(payload);
      return { ok: true, verified: true, modelId: payload.modelId, digestSource: 'catalog-sha256' };
    }),
    installEngine: vi.fn(async () => {
      state.installState = {
        ...state.installState,
        engine: { ...state.installState.engine, installed: true },
      };
      return { ok: true, version: 'b5454', binDir: state.installState.engine.binDir };
    }),
    onProgress: (callback) => subscribe('progress', callback),
    onInstallState: (callback) => subscribe('installState', callback),
    onError: (callback) => subscribe('error', callback),
    emit: (key, payload) => [...listeners[key]].forEach((callback) => callback(payload)),
    setInstallState: (next) => {
      state.installState = next;
    },
    currentInstallState: () => state.installState,
    resolveInstall: (result) => {
      const pending = pendingInstall;
      pendingInstall = null;
      pending?.resolve(result);
    },
  };
  return speech;
};

const renderPrefs = () =>
  // Experimental, not a first-class "localAi" section — see
  // tests/SpeechSettingsSection.test.jsx for why that was reversed.
  render(<UserPreferencesModal darkMode={false} onClose={() => {}} initialSection="experimental" />);

const resetStore = () => {
  useSpeechStore.setState({
    ...speechDefaults(),
    status: 'idle',
    health: null,
    lastError: null,
  });
};

describe('install flow (renderer, stubbed bridge)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
    delete window.electronAPI;
  });

  afterEach(() => {
    delete window.electronAPI;
  });

  itFlow('renders cold: no install, no download, catalog still lists 12 models', async () => {
    const bridge = createBridge();
    window.electronAPI = { speech: bridge };

    renderPrefs();
    await screen.findByTestId('speech-install-not-installed');

    // Reading state is allowed; acting is not.
    expect(bridge.getState).toHaveBeenCalled();
    expect(bridge.install).not.toHaveBeenCalled();
    expect(bridge.selectModel).not.toHaveBeenCalled();

    // The default target is the store's model — large-v3, the best model.
    expect(screen.getByText('Install Large v3')).toBeInTheDocument();
    expect(useSpeechStore.getState().modelId).toBe('large-v3');

    // The offline drop-in directory is stated up front, not only on failure.
    const dropin = screen.getByTestId('speech-install-dropin');
    expect(dropin).toHaveTextContent('ggml-large-v3.bin');
    expect(dropin).toHaveTextContent(MODELS_DIR);

    // Per-card states are honest before anything is installed.
    expect(screen.getByTestId('speech-card-status-large-v3')).toHaveTextContent('Not installed');
    expect(
      document.querySelectorAll('[data-testid^="speech-model-"]')
    ).toHaveLength(modelsForProvider('whispercpp').length);

    // Hardware never gates the install; it only shapes later recommendations.
    expect(screen.getByText(/never blocks this install/)).toBeInTheDocument();
  });

  itFlow('installs the real engine binary and reports it as installed', async () => {
    const bridge = createBridge();
    window.electronAPI = { speech: bridge };

    renderPrefs();
    const installButton = await screen.findByTestId('speech-engine-install');
    expect(screen.getByTestId('speech-engine-binary-status')).toHaveTextContent('Not installed');
    // Cold render: the engine card must not download anything on its own.
    expect(bridge.installEngine).not.toHaveBeenCalled();

    fireEvent.click(installButton);

    await waitFor(() => expect(bridge.installEngine).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId('speech-engine-binary-status')).toHaveTextContent('Installed')
    );
    expect(screen.queryByTestId('speech-engine-install')).not.toBeInTheDocument();
  });

  itFlow('walks not-installed -> downloading -> installed -> first-benchmark-pending', async () => {    const bridge = createBridge();
    window.electronAPI = { speech: bridge };

    renderPrefs();
    await screen.findByTestId('speech-install-not-installed');

    fireEvent.click(screen.getByTestId('speech-install-start'));
    expect(bridge.install).toHaveBeenCalledWith({ modelId: 'large-v3' });

    // The wizard flips to downloading the moment the click lands.
    await screen.findByTestId('speech-install-downloading');
    expect(screen.getByTestId('speech-install-progress')).toBeInTheDocument();

    act(() =>
      bridge.emit('progress', {
        taskId: 'download:large-v3',
        modelId: 'large-v3',
        receivedBytes: 1555000000,
        totalBytes: 3110000000,
        mbps: 12.5,
      })
    );
    const bar = screen.getByRole('progressbar', { name: /Downloading Large v3/ });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText(/12\.5 MB\/s/)).toBeInTheDocument();

    // The download finishes: main republishes install state, then answers.
    bridge.setInstallState({
      ...emptyInstallState(),
      installed: [
        {
          id: 'large-v3',
          fileName: 'ggml-large-v3.bin',
          bytes: 3110000000,
          sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2',
          digestRecorded: true,
          sizeMatchesRecord: true,
          source: 'download',
        },
      ],
      activeDownloads: [],
    });
    act(() => bridge.emit('installState', bridge.currentInstallState()));
    bridge.resolveInstall({ ok: true, modelId: 'large-v3', digestSource: 'catalog-sha256' });

    const installedCard = await screen.findByTestId('speech-install-installed');
    expect(installedCard).toHaveTextContent('Large v3 is installed');
    expect(installedCard).toHaveTextContent('digest verified against the recorded checksum');

    fireEvent.click(screen.getByTestId('speech-install-continue'));
    const pending = screen.getByTestId('speech-install-benchmark-pending');
    // Model verified on disk. The copy must NOT promise a transcript: this
    // platform may not ship an engine, and saying "this is the model that will
    // transcribe" is the same class of overclaim that pulled the previous
    // release — just moved from the badge to the prose.
    expect(pending).toHaveTextContent('Large v3 is downloaded and verified');
    expect(pending).toHaveTextContent(/Windows and Linux offer a whisper\.cpp download/i);
    expect(pending).toHaveTextContent(/macOS\s+does not yet/i);
    expect(pending).toHaveTextContent(/engine section above/i);
    expect(pending).not.toHaveTextContent(/is the model that will transcribe/i);
    expect(pending).not.toHaveTextContent(/test scaffold/i);
    expect(pending).not.toHaveTextContent(/nothing will transcribe/i);
    expect(pending).not.toHaveTextContent(/Ready to transcribe/);
    expect(pending).not.toHaveTextContent(/is what loads/);

    const benchmark = screen.getByTestId('speech-install-benchmark');
    expect(benchmark).toBeDisabled();
    expect(benchmark).toHaveAttribute('title', 'Benchmarking arrives in Phase 3');
    expect(pending).toHaveTextContent(/only ever recommends/);

    // Nothing else fired: no uninstall, no benchmark, no extra install.
    expect(bridge.install).toHaveBeenCalledTimes(1);
  });

  itFlow('a finished install of a different model becomes the active model', async () => {
    // Wiring-level coverage for the post-install auto-select: installing
    // Tiny English while the store names large-v3 must go through
    // speech:select-model AND move the store. Deleting the auto-select block
    // leaves the pure decision-table tests green, so this is the test that
    // pins the behavior an operator actually sees.
    const bridge = createBridge();
    window.electronAPI = { speech: bridge };

    renderPrefs();
    await screen.findByTestId('speech-install-not-installed');
    expect(useSpeechStore.getState().modelId).toBe('large-v3');

    fireEvent.click(screen.getByTestId('speech-install-tiny'));
    expect(bridge.install).toHaveBeenCalledWith({ modelId: 'tiny.en' });
    // No downloading card: the wizard's progress UI keys on the selected
    // model (large-v3), not the one-off tiny install. The download still
    // runs — the assertion that matters is the select-model below.

    bridge.setInstallState({
      ...emptyInstallState(),
      installed: [
        {
          id: 'tiny.en',
          fileName: 'ggml-tiny.en.bin',
          bytes: 78000000,
          digestRecorded: true,
          sizeMatchesRecord: true,
          source: 'download',
        },
      ],
      activeDownloads: [],
    });
    act(() => bridge.emit('installState', bridge.currentInstallState()));
    bridge.resolveInstall({ ok: true, modelId: 'tiny.en', digestSource: 'catalog-sha256' });

    await waitFor(() => expect(bridge.selectModel).toHaveBeenCalledWith({ modelId: 'tiny.en' }));
    expect(useSpeechStore.getState().modelId).toBe('tiny.en');
  });

  itFlow('sends the documented cancel payload and stops showing progress', async () => {
    const bridge = createBridge();
    window.electronAPI = { speech: bridge };

    renderPrefs();
    await screen.findByTestId('speech-install-not-installed');

    fireEvent.click(screen.getByTestId('speech-install-start'));
    await screen.findByTestId('speech-install-downloading');
    expect(screen.getByTestId('speech-install-cancel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('speech-install-cancel'));
    await waitFor(() =>
      expect(bridge.installCalls).toContainEqual({ modelId: 'large-v3', cancel: true })
    );

    // The cancelled install resolves as cancelled: no error banner, back to
    // the not-installed state.
    await screen.findByTestId('speech-install-not-installed');
    expect(screen.queryByTestId('speech-install-error')).not.toBeInTheDocument();
  });

  itFlow('surfaces a failed download as one sentence naming the drop-in directory', async () => {
    const bridge = createBridge();
    window.electronAPI = { speech: bridge };

    renderPrefs();
    await screen.findByTestId('speech-install-not-installed');

    fireEvent.click(screen.getByTestId('speech-install-start'));
    await screen.findByTestId('speech-install-downloading');

    bridge.resolveInstall({
      ok: false,
      code: 'network-unreachable',
      message:
        'Could not reach the model host (ECONNREFUSED). Offline install: place ' +
        `ggml-large-v3.bin into ${MODELS_DIR} — the app detects it on the next launch.`,
    });

    const error = await screen.findByTestId('speech-install-error');
    expect(error).toHaveTextContent(MODELS_DIR);
    expect(error).toHaveTextContent('ggml-large-v3.bin');
    // Still resumable from the user's point of view: the Install action is back.
    expect(screen.getByTestId('speech-install-start')).toBeInTheDocument();
    expect(screen.queryByTestId('speech-install-downloading')).not.toBeInTheDocument();
  });

  itFlow('resumes a kept partial: the card offers Resume and says how much is left', async () => {
    const bridge = createBridge({
      ...emptyInstallState(),
      partials: [
        { id: 'base.en-q8_0', fileName: 'ggml-base.en-q8_0.bin', receivedBytes: 100, totalBytes: 1000 },
      ],
    });
    window.electronAPI = { speech: bridge };

    renderPrefs();
    await waitFor(() =>
      expect(screen.getByTestId('speech-card-status-base.en-q8_0')).toHaveTextContent(
        'Paused · 10% downloaded'
      )
    );

    const resume = screen.getByTestId('speech-card-install-base.en-q8_0');
    expect(resume).toHaveTextContent('Resume');
    fireEvent.click(resume);
    expect(bridge.install).toHaveBeenCalledWith({ modelId: 'base.en-q8_0' });
  });

  itFlow('marks an installed card Installed, and clicking it verifies via speech:select-model', async () => {
    const bridge = createBridge({
      ...emptyInstallState(),
      installed: [
        {
          id: 'large-v3-q5_0',
          fileName: 'ggml-large-v3-q5_0.bin',
          bytes: 1610000000,
          digestRecorded: true,
          sizeMatchesRecord: true,
          source: 'download',
        },
      ],
    });
    window.electronAPI = { speech: bridge };

    renderPrefs();
    await waitFor(() =>
      expect(screen.getByTestId('speech-card-status-large-v3-q5_0')).toHaveTextContent('Installed')
    );
    expect(screen.getByTestId('speech-card-status-large-v3')).toHaveTextContent('Not installed');
    expect(screen.queryByTestId('speech-card-install-large-v3-q5_0')).not.toBeInTheDocument();

    const card = screen.getByTestId('speech-model-large-v3-q5_0');
    fireEvent.click(card);
    expect(bridge.selectModel).toHaveBeenCalledWith({ modelId: 'large-v3-q5_0' });

    await waitFor(() => expect(useSpeechStore.getState().modelId).toBe('large-v3-q5_0'));
    expect(card).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('speech-card-status-large-v3-q5_0')).toHaveTextContent('Active');
    await waitFor(() => expect(screen.queryByTestId('speech-card-error-large-v3-q5_0')).toBeNull());
  });

  itFlow('refuses to select a model that fails verification, and says why on the card', async () => {
    const bridge = createBridge({
      ...emptyInstallState(),
      installed: [
        {
          id: 'large-v3-q5_0',
          fileName: 'ggml-large-v3-q5_0.bin',
          bytes: 1610000000,
          digestRecorded: false,
          sizeMatchesRecord: false,
          source: 'drop-in',
        },
      ],
    });
    bridge.selectModel.mockResolvedValueOnce({
      ok: false,
      code: 'digest-mismatch',
      message: `The installed ggml-large-v3-q5_0.bin does not match its recorded digest. Delete it from ${MODELS_DIR} and install it again.`,
    });
    window.electronAPI = { speech: bridge };

    renderPrefs();
    await waitFor(() =>
      expect(screen.getByTestId('speech-card-status-large-v3-q5_0')).toHaveTextContent('Installed')
    );

    fireEvent.click(screen.getByTestId('speech-model-large-v3-q5_0'));

    const error = await screen.findByTestId('speech-card-error-large-v3-q5_0');
    expect(error).toHaveTextContent(MODELS_DIR);
    // The selection never committed.
    expect(useSpeechStore.getState().modelId).toBe('large-v3');
    expect(screen.getByTestId('speech-model-large-v3-q5_0')).toHaveAttribute('aria-pressed', 'false');
  });

  itFlow('never renders a dead benchmark control or an extra speech-model card', async () => {
    const bridge = createBridge();
    window.electronAPI = { speech: bridge };

    renderPrefs();
    await screen.findByTestId('speech-install-not-installed');

    // Exactly one card per catalog model — the wizard adds none.
    expect(
      document.querySelectorAll('[data-testid^="speech-model-"]')
    ).toHaveLength(modelsForProvider('whispercpp').length);
    // The wizard's own benchmark affordance is present but honestly disabled.
    const wizardInstall = within(screen.getByTestId('speech-install-wizard'));
    expect(wizardInstall.queryByRole('button', { name: /Run benchmark/ })).toBeNull();
    expect(bridge.install).not.toHaveBeenCalled();
  });
});
