import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import UserPreferencesModal from '@/components/UserPreferencesModal';
import useSpeechStore, { speechDefaults } from '@/context/SpeechStore';
import { modelsForProvider } from 'shared/speech';

const getState = () => useSpeechStore.getState();

const resetSpeechStore = () => {
  useSpeechStore.setState({
    ...speechDefaults(),
    status: 'idle',
    health: null,
    lastError: null,
  });
};

/**
 * Sermon Assist is EXPERIMENTAL: it is reached from User Preferences →
 * Experimental, behind its own master switch, not from a first-class
 * "Speech & AI" sidebar entry (the plan suggested one; that was reversed
 * deliberately while the feature cannot yet transcribe).
 *
 * So every test that needs the surface must do what an operator does: open
 * Experimental, then turn the feature on. `enableThenRender` does exactly
 * that, and asserting on the toggle keeps the tests honest about the gate
 * rather than bypassing it.
 */
const renderExperimental = () =>
  render(<UserPreferencesModal darkMode={false} onClose={() => {}} initialSection="experimental" />);

const renderLocalAi = () => renderExperimental();

/** Reset the store to an explicit state (defaults to off). */
const resetStore = (over = {}) => {
  resetSpeechStore();
  useSpeechStore.setState({ enabled: false, ...over });
};

/**
 * A getUserMedia/enumerateDevices spy pair. The settings surface must never
 * touch a device merely by being rendered or by the flag flipping — invariant
 * 4 — and this is how that is proven here rather than assumed.
 */
const installMediaMocks = () => {
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [], close() {} }));
  const enumerateDevices = vi.fn(async () => []);
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia, enumerateDevices },
  });
  return { getUserMedia, enumerateDevices };
};

/**
 * The only engine that can run today is the contract-conformant fake, which
 * ignores audio and replays a fixed sentence. `backend` reaches the renderer on
 * `speech:health` and was previously read nowhere, so Settings showed a bare
 * "Local · large-v3" with no indication that nothing real was behind it.
 */
describe('SpeechSettingsSection: engine truth', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSpeechStore();
  });

  const itRenders = (name, fn) => it(name, fn, 30000);

  itRenders('says so plainly when the running engine is the canned one', () => {
    useSpeechStore.setState({ health: { backend: 'fake', model: 'large-v3' } });
    renderLocalAi();

    const mode = screen.getByTestId('speech-settings-mode');
    expect(mode).toHaveTextContent(/canned/i);
    expect(mode).toHaveTextContent('not real transcription');
    expect(mode).toHaveTextContent('Local · large-v3');

    const notice = screen.getByTestId('speech-canned-engine-notice');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent(/ignores the audio/i);
    expect(notice).toHaveTextContent(/no suggestion will be offered/i);
  });

  itRenders('shows no canned notice for a real engine', () => {
    useSpeechStore.setState({ health: { backend: 'whispercpp', model: 'large-v3' } });
    renderLocalAi();

    expect(screen.getByTestId('speech-settings-mode')).toHaveTextContent('Local · large-v3');
    expect(screen.getByTestId('speech-settings-mode')).not.toHaveTextContent(/canned/i);
    expect(screen.queryByTestId('speech-canned-engine-notice')).toBeNull();
  });

  itRenders('shows no canned notice before any health has arrived', () => {
    renderLocalAi();

    expect(screen.getByTestId('speech-settings-mode')).toHaveTextContent('Local · large-v3');
    expect(screen.queryByTestId('speech-canned-engine-notice')).toBeNull();
  });
});

// Full-suite runs transform and mount 60+ files at once, and the first render
// of the whole preferences modal can cross vitest's 5s default purely from
// load. These tests are synchronous and I/O-free — give them headroom rather
// than letting contention flake them. Assertions are unchanged.
const itRenders = (name, fn) => it(name, fn, 30000);

describe('SpeechSettingsSection (User Preferences > Speech & AI)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSpeechStore();
  });

  itRenders('lives under Experimental, not as its own sidebar section', () => {
    renderExperimental();

    // Reached through Experimental, badged as experimental.
    expect(screen.getByRole('button', { name: /Experimental/ })).toBeInTheDocument();
    expect(screen.getByText('Live Sermon Assist')).toBeInTheDocument();
    expect(screen.getAllByText('Experimental').length).toBeGreaterThan(0);

    // NOT a first-class sidebar entry — that was the plan's suggestion and it
    // has been reversed while the feature cannot yet transcribe.
    expect(screen.queryByRole('button', { name: /Speech & AI/ })).not.toBeInTheDocument();

    // The surface itself is there, with its own master switch.
    expect(screen.getByTestId('speech-enable-toggle')).toBeInTheDocument();
    expect(
      screen.getByRole('radiogroup', { name: 'Where Sermon Assist runs' })
    ).toBeInTheDocument();
  });

  itRenders('the Experimental switch is the same store flag, and opens no microphone', () => {
    const { getUserMedia } = installMediaMocks();
    resetStore({ enabled: false });
    renderExperimental();

    const cardToggle = screen.getByTestId('sermon-assist-experimental-toggle');
    expect(getState().enabled).toBe(false);

    // Turning the feature ON is not arming: invariant 4 still holds, so no
    // device call may happen from a render or a flag flip.
    fireEvent.click(cardToggle);
    expect(getState().enabled).toBe(true);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(screen.queryByTestId('speech-rail-vu')).toBeNull();

    // And the section's own switch reflects the same value — one flag, and
    // neither control can disagree with the other.
    expect(screen.getByTestId('speech-enable-toggle')).toHaveAttribute('aria-checked', 'true');

    // Flipping it back off from the section also updates the card.
    fireEvent.click(screen.getByTestId('speech-enable-toggle'));
    expect(getState().enabled).toBe(false);
    expect(screen.getByTestId('sermon-assist-experimental-toggle')).toHaveAttribute(
      'data-state',
      'unchecked'
    );
  });

  itRenders('is OFF on a fresh store, and the card says so', () => {
    resetStore({ enabled: false });
    renderExperimental();
    expect(screen.getByTestId('sermon-assist-experimental-toggle')).toHaveAttribute(
      'data-state',
      'unchecked'
    );
    // "Feature Inactive" also appears on the other experimental cards, so scope
    // the assertion to Sermon Assist's own card.
const card = screen.getByTestId('sermon-assist-experimental-card');
    expect(within(card).getByText(/Feature Inactive/)).toBeInTheDocument();
  });

  itRenders('wires the audio source picker, cold, into the Audio Source card', () => {
    renderLocalAi();

    // Disabled: the picker renders its one-line prompt and never touches a device.
    expect(screen.getByTestId('audio-source-picker-disabled')).toBeInTheDocument();
    expect(screen.queryByTestId('audio-source-picker')).not.toBeInTheDocument();

    // Enabled: the picker mounts, still cold — status stays 'idle', so no
    // permission request and no enumeration happened merely by rendering it.
    fireEvent.click(screen.getByTestId('speech-enable-toggle'));
    expect(screen.getByTestId('audio-source-picker')).toBeInTheDocument();
    // Idle means cold: the only affordance is the explicit "choose" button, so
    // mounting the settings section has not requested a microphone.
    expect(screen.getByTestId('audio-source-choose')).toBeInTheDocument();
    expect(getState().enabled).toBe(true);
    expect(screen.queryByTestId('audio-source-picker-disabled')).not.toBeInTheDocument();
  });

  itRenders('starts OFF on a fresh store and only flips on an explicit user click', () => {
    renderLocalAi();
    const toggle = screen.getByTestId('speech-enable-toggle');

    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(getState().enabled).toBe(false);
    expect(screen.getByText('Sermon Assist is OFF')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(getState().enabled).toBe(true);
    expect(screen.getByText('Sermon Assist is ON')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(getState().enabled).toBe(false);
    expect(screen.getByText('Sermon Assist is OFF')).toBeInTheDocument();
  });

  itRenders('keeps the catalog visible (but visibly inert) while disabled', () => {
    renderLocalAi();
    expect(getState().enabled).toBe(false);
    expect(screen.getByTestId('speech-config-inert-note')).toBeInTheDocument();
    expect(
      document.querySelectorAll('[data-testid^="speech-model-"]')
    ).toHaveLength(modelsForProvider('whispercpp').length);
    expect(
      document.querySelector('[aria-disabled="true"]')
    ).not.toBeNull();
  });

  itRenders('defaults the three-way control to This Device with local copy first', () => {
    renderLocalAi();
    expect(screen.getByTestId('speech-where-local')).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByTestId('speech-where-network')).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(screen.getByTestId('speech-where-cloud')).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(screen.getByText('Audio stays on this computer.')).toBeInTheDocument();
  });

  itRenders('reveals the cloud block on Cloud and clears cloudProviderId on This Device', () => {
    renderLocalAi();
    expect(screen.queryByTestId('speech-cloud-block')).toBeNull();

    fireEvent.click(screen.getByTestId('speech-where-cloud'));
    expect(screen.getByTestId('speech-cloud-block')).toBeInTheDocument();
    expect(
      screen.getByRole('radiogroup', { name: 'Cloud provider' })
    ).toBeInTheDocument();

    // OpenAI and OpenRouter are the two selectable lanes. Other rows are
    // shown as unavailable rather than silently selectable but non-functional.
    expect(screen.getByTestId('speech-cloud-provider-groq')).toBeDisabled();
    expect(screen.getByTestId('speech-cloud-provider-groq')).toHaveTextContent('Unavailable');
    expect(screen.getByTestId('speech-cloud-provider-openrouter')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('speech-cloud-provider-openai'));
    expect(getState().cloudProviderId).toBe('openai');
    expect(
      screen.getByTestId('speech-settings-mode')
    ).toHaveTextContent('Cloud · openai');

    fireEvent.click(screen.getByTestId('speech-where-local'));
    expect(screen.queryByTestId('speech-cloud-block')).toBeNull();
    expect(getState().cloudProviderId).toBeNull();
    expect(
      screen.getByTestId('speech-settings-mode')
    ).toHaveTextContent('Local · large-v3');
  });

  itRenders('reaches a working local provider without entering a key', () => {
    renderLocalAi();

    // No cloud form, no API-key field, while `where` is local.
    expect(screen.queryByTestId('speech-cloud-block')).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();

    const whispercpp = screen.getByTestId('speech-provider-whispercpp');
    expect(whispercpp).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(whispercpp);
    expect(getState().providerId).toBe('whispercpp');
    expect(getState().cloudProviderId).toBeNull();

    // The "needs nothing installed" provider is in the recommended pair.
    expect(screen.getByTestId('speech-provider-osondevice')).toBeInTheDocument();
    expect(screen.getByText('No install needed')).toBeInTheDocument();
  });

  itRenders('lists every published whisper.cpp model with large-v3 selected, badged, and open on the default', () => {
    // Derived from the catalog, never a literal: the catalog grew from 12 to
    // the full published list, and a hardcoded count is exactly how a test
    // ends up asserting a number nobody chose any more.
    expect(modelsForProvider('whispercpp').length).toBeGreaterThan(12);
    renderLocalAi();

    expect(
      document.querySelectorAll('[data-testid^="speech-model-"]')
    ).toHaveLength(modelsForProvider('whispercpp').length);

    const largeV3 = screen.getByTestId('speech-model-large-v3');
    expect(largeV3).toHaveAttribute('aria-pressed', 'true');
    expect(within(largeV3).getByText('Default')).toBeInTheDocument();
    expect(
      within(largeV3).getByText(
        'Best accuracy in the catalog — recommended for capable hardware.'
      )
    ).toBeInTheDocument();
    // Read what the card must show straight from the catalog rather than typing
    // literals: the card renders these verbatim, and a hand-typed number here
    // would re-freeze whatever value the catalog had when the test was written.
    const largeV3Row = modelsForProvider('whispercpp').find((m) => m.id === 'large-v3');
    expect(largeV3Row).toBeTruthy();
    expect(largeV3.textContent).toContain(`RAM ~${largeV3Row.ramGb} GB`);
    expect(largeV3.textContent).toContain(`${largeV3Row.params} params`);
    // Size is rendered through formatBytes(downloadBytes), so assert a size is
    // present rather than pinning a particular unit or rounding.
    expect(largeV3.textContent).toMatch(/\d+(\.\d+)?\s?(GiB|MiB|GB|MB)/);
    // large-v3 has a digest read from the upstream API, so no "not pinned"
    // note — and never a bare "null".
    expect(
      within(largeV3).queryByText('digest not pinned yet')
    ).toBeNull();
    expect(largeV3.textContent).not.toContain('null');

    // An unpinned digest is stated honestly, never rendered as `null`. Which
    // models are pinned changes as the upstream API is re-read, so this asserts
    // the card says something TRUE about its digest rather than a fixed string.
    const q8 = screen.getByTestId('speech-model-large-v3-q5_0');
    expect(
      within(q8).getByText(/digest not pinned yet|^sha256 [0-9a-f]{12}/)
    ).toBeInTheDocument();
    expect(q8.textContent).not.toContain('null');

    // Benchmark affordance exists, honestly disabled.
    const benchmark = within(q8.closest('li')).getByRole('button', {
      name: /Run benchmark/,
    });
    expect(benchmark).toBeDisabled();
    expect(benchmark).toHaveAttribute('title', 'Benchmarking arrives in Phase 3');

    // Selecting another model moves the selection.
    fireEvent.click(q8);
    expect(getState().modelId).toBe('large-v3-q5_0');
    expect(q8).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('speech-model-large-v3')).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  itRenders('shows an honest empty model state (and capability gating) for a catalog-less provider', () => {
    // The INTENT of this test is unchanged by Phase 6: a provider with no
    // downloadable models must say so in plain words and list nothing, rather
    // than showing an empty picker that reads as "nothing is installed" when it
    // really means "there is nothing to install".
    //
    // sherpaonnx was the empty provider when this was written. Phase 6 gave it
    // a real pinned Nemotron row, so the assertion moved to vosk — still a
    // declared provider with zero models, which is exactly the case under test.
    // `sherpaonnx` now has its own assertions in modelsCatalog.test.js.
    renderLocalAi();

    fireEvent.click(screen.getByRole('button', { name: /Show all providers/ }));
    expect(screen.getByTestId('speech-provider-vosk')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('speech-provider-vosk'));
    expect(getState().providerId).toBe('vosk');

    expect(
      screen.getByText('No downloadable models for this provider')
    ).toBeInTheDocument();
    expect(
      document.querySelectorAll('[data-testid^="speech-model-"]')
    ).toHaveLength(0);

    // The empty state must say WHAT would have been here — a provider reading
    // a format the app does not host is a different situation from a broken
    // download, and "nothing to choose from" alone does not distinguish them.
    expect(
      screen.getByText(/It reads vosk supplied separately/)
    ).toBeInTheDocument();
  });

  itRenders('sherpaonnx now offers its pinned Nemotron model with its exclusions stated', () => {
    // Phase 6. The provider was a declared row with zero models; it is now the
    // choice for a non-English congregation, so the UI has to be honest about
    // BOTH what it offers and where it cannot run.
    renderLocalAi();

    fireEvent.click(screen.getByRole('button', { name: /Show all providers/ }));
    fireEvent.click(screen.getByTestId('speech-provider-sherpaonnx'));
    expect(getState().providerId).toBe('sherpaonnx');

    expect(
      document.querySelectorAll('[data-testid^="speech-model-"]').length
    ).toBeGreaterThan(0);

    // Its stated capability gap must still be visible — a lane that cannot
    // align words is disabled with a reason, never silently.
    expect(
      screen.getByText(/Sermon profile biasing/)
    ).toBeInTheDocument();
  });

  itRenders('always shows an accurate mode indicator', () => {
    renderLocalAi();
    const mode = screen.getByTestId('speech-settings-mode');

    expect(mode).toHaveTextContent('Local · large-v3');

    fireEvent.click(screen.getByTestId('speech-where-network'));
    // Choosing the mode is not proof of a connection: no health has arrived.
    expect(mode).toHaveTextContent('Network · not connected');

    fireEvent.click(screen.getByTestId('speech-where-cloud'));
    expect(mode).toHaveTextContent('Cloud · not configured');

    expect(screen.getByTestId('speech-cloud-provider-deepgram')).toBeDisabled();
    fireEvent.click(screen.getByTestId('speech-cloud-provider-openai'));
    expect(mode).toHaveTextContent('Cloud · openai');
  });

  itRenders('stores the OpenAI key through the bridge and reports status without persisting text', async () => {
    const KEY = 'sk-ui-test-NEVER-STORED';
    const cloudKeyStatus = vi.fn(async () => ({ ok: true, configured: false }));
    const saveCloudKey = vi.fn(async () => ({ ok: true, configured: true }));
    const clearCloudKey = vi.fn(async () => ({ ok: true, configured: false }));
    window.electronAPI = { speech: { cloudKeyStatus, saveCloudKey, clearCloudKey } };
    try {
      resetStore({ where: 'cloud', cloudProviderId: 'openai' });
      renderLocalAi();

      expect(await screen.findByTestId('speech-cloud-key-status-openai')).toHaveTextContent('No key saved');
      expect(cloudKeyStatus).toHaveBeenCalledWith('openai');
      const input = screen.getByTestId('speech-cloud-key-input-openai');
      fireEvent.change(input, { target: { value: KEY } });
      fireEvent.click(screen.getByTestId('speech-cloud-key-save-openai'));

      await vi.waitFor(() => expect(saveCloudKey).toHaveBeenCalledWith({ provider: 'openai', key: KEY }));
      await vi.waitFor(() => expect(screen.getByTestId('speech-cloud-key-status-openai')).toHaveTextContent('Key saved in secure storage'));
      expect(input).toHaveValue('');
      expect(JSON.stringify(localStorage)).not.toContain(KEY);

      fireEvent.click(screen.getByTestId('speech-cloud-key-clear-openai'));
      await vi.waitFor(() => expect(clearCloudKey).toHaveBeenCalledWith({ provider: 'openai' }));
      await vi.waitFor(() => expect(screen.getByTestId('speech-cloud-key-status-openai')).toHaveTextContent('No key saved'));
    } finally {
      delete window.electronAPI;
    }
  });

  itRenders('selects OpenRouter/Gemini, changes model, and scopes key status to the provider', async () => {
    const OR_KEY = 'sk-or-ui-test-NEVER-STORED';
    const cloudKeyStatus = vi.fn(async (provider) => ({
      ok: true,
      configured: provider === 'openai',
    }));
    const saveCloudKey = vi.fn(async () => ({ ok: true, configured: true }));
    const setCloudConsent = vi.fn(async () => ({ ok: true, granted: true }));
    window.electronAPI = { speech: { cloudKeyStatus, saveCloudKey, setCloudConsent } };
    try {
      resetStore({ where: 'cloud', cloudProviderId: 'openai' });
      renderLocalAi();
      expect(await screen.findByTestId('speech-cloud-key-status-openrouter')).toHaveTextContent('Key saved in secure storage');

      fireEvent.click(screen.getByTestId('speech-cloud-provider-openrouter'));
      expect(getState().cloudProviderId).toBe('openrouter');
      expect(getState().cloudModelId).toBeNull();
      expect(await screen.findByTestId('speech-cloud-key-status-openrouter')).toHaveTextContent('No key saved');
      await vi.waitFor(() => expect(cloudKeyStatus).toHaveBeenCalledWith('openrouter'));
      await vi.waitFor(() => expect(setCloudConsent).toHaveBeenCalledWith(false));

      const modelSelect = screen.getByTestId('speech-cloud-model-openrouter');
      expect(modelSelect).toHaveValue('google/gemini-2.5-flash');
      fireEvent.change(modelSelect, { target: { value: 'google/gemini-3.8-flash' } });
      expect(getState().cloudModelId).toBe('google/gemini-3.8-flash');

      fireEvent.change(screen.getByTestId('speech-cloud-key-input-openrouter'), { target: { value: OR_KEY } });
      fireEvent.click(screen.getByTestId('speech-cloud-key-save-openrouter'));
      await vi.waitFor(() => expect(saveCloudKey).toHaveBeenCalledWith({ provider: 'openrouter', key: OR_KEY }));
      expect(JSON.stringify(localStorage)).not.toContain(OR_KEY);
    } finally {
      delete window.electronAPI;
    }
  });

  itRenders('requires an explicit egress acknowledgement action', async () => {
    const setCloudConsent = vi.fn(async () => ({ ok: true, granted: true }));
    window.electronAPI = { speech: { setCloudConsent } };
    try {
      resetStore({ where: 'cloud', cloudProviderId: 'openai' });
      renderLocalAi();
      const checkbox = screen.getByTestId('speech-cloud-consent');
      expect(checkbox).not.toBeChecked();
      fireEvent.click(checkbox);
      await vi.waitFor(() => expect(setCloudConsent).toHaveBeenCalledWith(true));
      expect(checkbox).toBeChecked();
    } finally {
      delete window.electronAPI;
    }
  });

  itRenders('resets every Sermon Assist setting in one click and stays off', () => {
    renderLocalAi();

    fireEvent.click(screen.getByTestId('speech-enable-toggle'));
    fireEvent.click(screen.getByTestId('speech-where-cloud'));
    fireEvent.click(screen.getByTestId('speech-cloud-provider-openai'));
    fireEvent.click(screen.getByRole('button', { name: /Show all providers/ }));
    fireEvent.click(screen.getByTestId('speech-provider-vosk'));
    expect(getState().enabled).toBe(true);

    fireEvent.click(
      screen.getByRole('button', { name: 'Reset all Sermon Assist settings' })
    );

    expect(getState()).toMatchObject({
      ...speechDefaults(),
      status: 'idle',
      health: null,
      lastError: null,
    });
    expect(getState().enabled).toBe(false);
    expect(getState().cloudProviderId).toBeNull();
    expect(
      screen.getByTestId('speech-settings-mode')
    ).toHaveTextContent('Local · large-v3');
  });

  itRenders('the Rail display toggle hides and restores the rail error banner', () => {
    // The settings checkbox and the rail checkbox are the same store flag:
    // disconnecting either one must fail this test.
    resetStore({ enabled: false });
    renderExperimental();

    const setting = screen.getByTestId('speech-show-engine-errors-setting');
    expect(setting).toBeChecked();
    expect(getState().ui.showEngineErrors).toBe(true);

    fireEvent.click(setting);
    expect(getState().ui.showEngineErrors).toBe(false);
    expect(screen.getByTestId('speech-show-engine-errors-setting')).not.toBeChecked();

    // A pre-existing opt-out is reflected, not reset, by rendering.
    cleanup();
    resetStore({ enabled: false, ui: { ...speechDefaults().ui, showEngineErrors: false } });
    renderExperimental();
    expect(screen.getByTestId('speech-show-engine-errors-setting')).not.toBeChecked();
  });

  itRenders('Network Device exposes an endpoint, a session-only token, and a real test button', async () => {
    const testNetwork = vi.fn(async () => ({
      ok: true,
      code: 'ok',
      message: 'Connected to http://192.168.1.20:4731.',
      health: { remote: true, status: 'ok', backend: 'whispercpp' },
    }));
    window.electronAPI = { speech: { testNetwork } };
    try {
      renderLocalAi();
      expect(screen.queryByTestId('speech-network-block')).toBeNull();

      fireEvent.click(screen.getByTestId('speech-where-network'));
      const block = screen.getByTestId('speech-network-block');
      expect(block).toHaveTextContent(/trusted LAN/i);
      expect(block).toHaveTextContent(/no TLS/i);
      expect(block).toHaveTextContent(/raw microphone audio crosses the network/i);

      fireEvent.change(screen.getByTestId('speech-network-endpoint'), {
        target: { value: 'http://192.168.1.20:4731' },
      });
      fireEvent.change(screen.getByTestId('speech-network-token'), {
        target: { value: 'a'.repeat(64) },
      });
      expect(getState().networkEndpoint).toBe('http://192.168.1.20:4731');
      expect(getState().networkToken).toBe('a'.repeat(64));
      expect(screen.getByTestId('speech-network-token')).toHaveAttribute('type', 'password');

      // The endpoint is a preference; the token is NOT written to storage.
      const persisted = JSON.parse(localStorage.getItem('speech-store') ?? '{}');
      expect(JSON.stringify(persisted)).toContain('networkEndpoint');
      expect(JSON.stringify(persisted)).not.toContain('networkToken');
      expect(JSON.stringify(persisted)).not.toContain('a'.repeat(64));

      fireEvent.click(screen.getByTestId('speech-network-test'));
      await waitFor(() => expect(testNetwork).toHaveBeenCalledWith({
        networkEndpoint: 'http://192.168.1.20:4731',
        networkToken: 'a'.repeat(64),
      }));
      expect(await screen.findByTestId('speech-network-status')).toHaveTextContent(/Connected/i);
      // Choosing the mode is not a connection claim until health arrives.
      expect(screen.getByTestId('speech-settings-mode')).toHaveTextContent('Network · not connected');
    } finally {
      delete window.electronAPI;
    }
  });

  itRenders('a failed network test shows the reason without claiming a connection', async () => {
    window.electronAPI = {
      speech: { testNetwork: vi.fn(async () => ({ ok: false, code: 'network-unauthorized', message: 'Token rejected.' })) },
    };
    try {
      renderLocalAi();
      fireEvent.click(screen.getByTestId('speech-where-network'));
      fireEvent.click(screen.getByTestId('speech-network-test'));
      const status = await screen.findByTestId('speech-network-status');
      expect(status).toHaveTextContent('Not connected.');
      expect(status).toHaveTextContent('Token rejected.');
      expect(screen.getByTestId('speech-settings-mode')).toHaveTextContent('Network · not connected');
    } finally {
      delete window.electronAPI;
    }
  });

  itRenders('AGENTS.md guard: Import Bible Translation stays available in User Preferences > Bible', () => {
    render(<UserPreferencesModal darkMode={false} onClose={() => {}} initialSection="bible" />);

    expect(
      screen.getByRole('button', { name: 'Import Bible Translation' })
    ).toBeInTheDocument();
    expect(screen.getByText(/Zefania, OSIS, Beblia, and OpenSong/)).toBeInTheDocument();
  });
});
