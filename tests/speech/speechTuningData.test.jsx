import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import SpeechTuningDataCard from '@/components/Speech/SpeechTuningDataCard';

describe('SpeechTuningDataCard', () => {
  let list;
  let exportHistory;

  beforeEach(() => {
    list = vi.fn(async () => ({
      ok: true,
      sessions: [
        { sessionId: 's1', eventCount: 3 },
        { sessionId: 's2', eventCount: 2 },
      ],
      status: { recording: true },
    }));
    exportHistory = vi.fn(async () => ({ ok: true, path: '/tmp/tuning.json', bytes: 2048, sessionCount: 2 }));
    window.electronAPI = { speech: { history: { list, export: exportHistory } } };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('shows local session and detection/action event counts', async () => {
    render(<SpeechTuningDataCard />);
    await waitFor(() => expect(screen.getByTestId('speech-tuning-sessions')).toHaveTextContent('2'));
    expect(screen.getByTestId('speech-tuning-events')).toHaveTextContent('5');
  });

  it('exports a JSON tuning file and reports the path', async () => {
    render(<SpeechTuningDataCard />);
    await waitFor(() => expect(screen.getByTestId('speech-tuning-export')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('speech-tuning-export'));
    await waitFor(() => expect(screen.getByTestId('speech-tuning-result')).toHaveTextContent('/tmp/tuning.json'));
    expect(exportHistory).toHaveBeenCalledWith({ format: 'json' });
    expect(screen.getByTestId('speech-tuning-result')).toHaveTextContent('2.0 KiB');
  });
});
