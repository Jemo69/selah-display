/**
 * QuickSetupCard — the volunteer path. One click must perform the whole setup
 * in plain language, and a failure must never lead with an error code.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import QuickSetupCard from '@/components/Speech/QuickSetupCard';
import useSpeechStore, { speechDefaults } from '@/context/SpeechStore';

vi.mock('@/speech/benchmarkClip.js', () => ({
  loadBenchmarkClip: vi.fn(async () => ({
    pcm: new Uint8Array([1, 2, 3, 4]),
    transcript: 'For God so loved the world',
    sampleRate: 16000,
  })),
}));

const CUDA = { available: true, backend: 'cuda', cudaVersion: '12.4' };
const CPU = { available: false, backend: 'cpu' };

const createBridge = ({
  gpu = CUDA,
  engineInstalled = false,
  engineBackend = null,
  installedIds = [],
  installedBackend = null,
  failAt = null,
  autoChoice = gpu.available ? 'large-v3-turbo' : 'tiny.en-q5_1',
} = {}) => {
  const calls = [];
  let progress = null;
  const bridge = {
    calls,
    getState: vi.fn(async () => ({
      installState: {
        engine: {
          installed: engineInstalled,
          backend: engineBackend,
          manifest: engineBackend ? { selectionCode: installedBackend } : null,
        },
        installed: installedIds.map((id) => ({ id })),
      },
    })),
    gpuCapabilities: vi.fn(async () => gpu),
    installEngine: vi.fn(async (payload) => {
      calls.push(payload?.replace ? 'engine:replace' : 'engine');
      if (failAt === 'engine') return { ok: false, code: 'digest-mismatch', message: 'sha256 mismatch at /tmp/engine.zip' };
      return {
        ok: true,
        backend: gpu.available === true ? gpu.backend : 'cpu',
        cudaVersion: gpu.cudaVersion ?? null,
        selection: { code: null },
      };
    }),
    testEngine: vi.fn(async () => {
      calls.push('test');
      if (failAt === 'test') return { ok: false, code: 'spawn-enoent', message: 'ENOENT whisper-cli.exe' };
      return { ok: true };
    }),
    install: vi.fn(async ({ modelId }) => {
      calls.push(`model:${modelId}`);
      if (failAt === 'model') return { ok: false, code: 'download-failed', message: 'HTTP 503' };
      return { ok: true };
    }),
    selectModel: vi.fn(async ({ modelId }) => {
      calls.push(`select:${modelId}`);
      return { ok: true };
    }),
    autoSelectModel: vi.fn(async () => {
      calls.push('auto-select');
      if (failAt === 'auto') {
        return { ok: false, code: 'no-candidate', reason: 'Nothing passed the gates.' };
      }
      return {
        ok: true,
        results: [],
        decision: { modelId: autoChoice, reason: 'Measured on this computer.' },
      };
    }),
    onProgress: vi.fn((callback) => { progress = callback; return () => {}; }),
    emitProgress: (payload) => act(() => progress?.(payload)),
  };
  return bridge;
};

describe('QuickSetupCard', () => {
  beforeEach(() => {
    useSpeechStore.setState({ ...speechDefaults(), status: 'idle', health: null });
    window.electronAPI = undefined;
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('stays cold on render: one button, no download and no microphone', () => {
    const speech = createBridge();
    window.electronAPI = { speech };
    render(<QuickSetupCard />);

    expect(screen.getByTestId('speech-quick-setup-start')).toHaveTextContent('Set up Sermon Assist');
    expect(speech.installEngine).not.toHaveBeenCalled();
    expect(speech.install).not.toHaveBeenCalled();
    expect(speech.testEngine).not.toHaveBeenCalled();
    expect(screen.queryByTestId('speech-quick-setup-progress')).toBeNull();
  });

  it('installs the serious model on a GPU and reaches a ready state', async () => {
    const speech = createBridge();
    window.electronAPI = { speech };
    render(<QuickSetupCard />);

    fireEvent.click(screen.getByTestId('speech-quick-setup-start'));

    await waitFor(() => expect(screen.getByTestId('speech-quick-setup-ready')).toBeInTheDocument());
    expect(speech.calls).toEqual([
      'engine', 'test', 'model:small.en-q5_1', 'model:large-v3-turbo',
      'auto-select', 'select:large-v3-turbo',
    ]);
    expect(useSpeechStore.getState().modelId).toBe('large-v3-turbo');
    expect(useSpeechStore.getState().enabled).toBe(true);
    expect(useSpeechStore.getState().autoStartRequested).toBe(true);
    expect(screen.getByTestId('speech-quick-setup')).toHaveTextContent('Starting now');
    // No codes or file mechanics in the success surface.
    expect(screen.queryByText(/sha256|CUDA 12\.4|whisper-cli/)).toBeNull();
  });

  it('uses the small model on a CPU machine and says why', async () => {
    const speech = createBridge({ gpu: CPU });
    window.electronAPI = { speech };
    render(<QuickSetupCard />);

    fireEvent.click(screen.getByTestId('speech-quick-setup-start'));

    await waitFor(() => expect(screen.getByTestId('speech-quick-setup-ready')).toBeInTheDocument());
    expect(speech.calls).toEqual([
      'engine', 'test', 'model:tiny.en-q5_1', 'model:base.en-q5_1',
      'model:small.en-q5_1', 'auto-select', 'select:tiny.en-q5_1',
    ]);
    expect(screen.getByText(/using its processor/)).toBeInTheDocument();
  });

  it('shows measured progress only when the bridge reports bytes', async () => {
    let releaseEngine;
    const speech = createBridge();
    speech.installEngine = vi.fn(() => new Promise((resolve) => { releaseEngine = resolve; }));
    window.electronAPI = { speech };
    render(<QuickSetupCard />);

    fireEvent.click(screen.getByTestId('speech-quick-setup-start'));
    await waitFor(() => expect(screen.getByTestId('speech-quick-setup-progress')).toBeInTheDocument());
    expect(screen.getByTestId('speech-quick-setup-progress')).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByTestId('speech-quick-setup-progress').firstElementChild).toHaveStyle({ width: '0%' });

    speech.emitProgress({ kind: 'engine', receivedBytes: 25, totalBytes: 100 });
    expect(screen.getByTestId('speech-quick-setup-progress')).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText('25%')).toBeInTheDocument();

    await act(async () => { releaseEngine({ ok: true, backend: 'cuda', cudaVersion: '12.4', selection: { code: null } }); });
    await waitFor(() => expect(screen.getByTestId('speech-quick-setup-ready')).toBeInTheDocument());
  });

  it('hides error codes until tech support opens the details, then allows retry', async () => {
    const speech = createBridge({ failAt: 'engine' });
    window.electronAPI = { speech };
    render(<QuickSetupCard />);

    fireEvent.click(screen.getByTestId('speech-quick-setup-start'));

    await waitFor(() => expect(screen.getByTestId('speech-quick-setup-error')).toBeInTheDocument());
    expect(screen.getByTestId('speech-quick-setup-error')).toHaveTextContent(/safety check/);
    expect(screen.queryByTestId('speech-quick-setup-details')).toBeNull();

    fireEvent.click(screen.getByTestId('speech-quick-setup-details-toggle'));
    expect(screen.getByTestId('speech-quick-setup-details')).toHaveTextContent('digest-mismatch');

    fireEvent.click(screen.getByTestId('speech-quick-setup-start'));
    await waitFor(() => expect(speech.installEngine).toHaveBeenCalledTimes(2));
  });

  it('explains what will be installed without asking the volunteer to unzip anything', async () => {
    const speech = createBridge();
    window.electronAPI = { speech };
    render(<QuickSetupCard />);

    await waitFor(() => expect(speech.gpuCapabilities).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('speech-quick-setup-what-toggle'));
    await waitFor(() => expect(screen.getByTestId('speech-quick-setup-what')).toHaveTextContent(/graphics card/));
    expect(screen.getByTestId('speech-quick-setup-what')).toHaveTextContent(/1\.51 GiB/);
    expect(screen.getByTestId('speech-quick-setup-what')).toHaveTextContent(/Large v3 Turbo/);
  });
  it('does not download the large model when CUDA was detected but the installer falls back to CPU', async () => {
    const speech = createBridge({ autoChoice: 'tiny.en-q5_1' });
    speech.installEngine = vi.fn(async () => {
      speech.calls.push('engine');
      return { ok: true, backend: 'cpu', cudaVersion: '12.4', selection: { code: 'unsupported-backend-asset' } };
    });
    window.electronAPI = { speech };
    render(<QuickSetupCard />);

    fireEvent.click(screen.getByTestId('speech-quick-setup-start'));

    await waitFor(() => expect(screen.getByTestId('speech-quick-setup-ready')).toBeInTheDocument());
    expect(speech.calls).toEqual([
      'engine', 'test', 'model:tiny.en-q5_1', 'model:base.en-q5_1',
      'model:small.en-q5_1', 'auto-select', 'select:tiny.en-q5_1',
    ]);
    expect(screen.getByTestId('speech-quick-setup')).toHaveTextContent('Tiny English');
  });

  it('repairs an existing CPU engine in-app when CUDA is available', async () => {
    const speech = createBridge({ engineInstalled: true, engineBackend: 'cpu' });
    window.electronAPI = { speech };
    render(<QuickSetupCard />);

    fireEvent.click(screen.getByTestId('speech-quick-setup-start'));

    await waitFor(() => expect(screen.getByTestId('speech-quick-setup-ready')).toBeInTheDocument());
    expect(speech.installEngine).toHaveBeenCalledWith({ replace: true });
    expect(speech.calls).toEqual([
      'engine:replace', 'test', 'model:small.en-q5_1', 'model:large-v3-turbo',
      'auto-select', 'select:large-v3-turbo',
    ]);
  });

  it('normalizes a stale Cloud/Test selection so Press Start cannot lie', async () => {
    useSpeechStore.setState({ ...speechDefaults(), where: 'cloud', engineMode: 'test', providerId: 'openai' });
    const speech = createBridge();
    window.electronAPI = { speech };
    render(<QuickSetupCard />);

    fireEvent.click(screen.getByTestId('speech-quick-setup-start'));

    await waitFor(() => expect(screen.getByTestId('speech-quick-setup-ready')).toBeInTheDocument());
    expect(useSpeechStore.getState()).toMatchObject({
      enabled: true,
      where: 'local',
      engineMode: 'prod',
      providerId: 'whispercpp',
      modelId: 'large-v3-turbo',
    });
  });

  it('keeps the friendly sentence when the engine self-test fails', async () => {
    const speech = createBridge({ failAt: 'test' });
    window.electronAPI = { speech };
    render(<QuickSetupCard />);

    fireEvent.click(screen.getByTestId('speech-quick-setup-start'));

    await waitFor(() => expect(screen.getByTestId('speech-quick-setup-error')).toBeInTheDocument());
    expect(screen.getByTestId('speech-quick-setup-error')).toHaveTextContent(/did not start/);
    fireEvent.click(screen.getByTestId('speech-quick-setup-details-toggle'));
    expect(screen.getByTestId('speech-quick-setup-details')).toHaveTextContent('spawn-enoent');
  });

  it('ignores progress that belongs to another setup task', async () => {
    let releaseEngine;
    const speech = createBridge();
    speech.installEngine = vi.fn(() => new Promise((resolve) => { releaseEngine = resolve; }));
    window.electronAPI = { speech };
    render(<QuickSetupCard />);

    fireEvent.click(screen.getByTestId('speech-quick-setup-start'));
    await waitFor(() => expect(screen.getByTestId('speech-quick-setup-progress')).toBeInTheDocument());

    speech.emitProgress({ modelId: 'large-v3-turbo', receivedBytes: 90, totalBytes: 100 });
    expect(screen.getByTestId('speech-quick-setup-progress')).not.toHaveAttribute('aria-valuenow');

    speech.emitProgress({ kind: 'engine', receivedBytes: 50, totalBytes: 100 });
    expect(screen.getByTestId('speech-quick-setup-progress')).toHaveAttribute('aria-valuenow', '50');

    await act(async () => { releaseEngine({ ok: true, backend: 'cuda', selection: { code: null } }); });
    await waitFor(() => expect(screen.getByTestId('speech-quick-setup-ready')).toBeInTheDocument());
  });

});
