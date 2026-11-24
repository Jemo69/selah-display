import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import useLyricsStore, { defaultStreamSettings } from '../../context/LyricsStore';
import RegularOutput from '../RegularOutput.jsx';

vi.mock('../../hooks/useSocket', () => ({
  default: () => ({
    socket: { connected: false, on: vi.fn(), off: vi.fn(), emit: vi.fn() },
    isConnected: false,
    connectionStatus: 'disconnected',
    isAuthenticated: false,
    emitStyleUpdate: vi.fn(),
    emitOutputMetrics: vi.fn(),
  }),
}));

vi.mock('../../utils/fontLoader', () => ({
  ensureFontLoaded: () => Promise.resolve(),
}));

vi.mock('../../utils/maxLinesCalculator', () => ({
  calculateOptimalFontSize: vi.fn(() => ({ adjustedSize: 64, isTruncated: false })),
}));

const VERSE = 'For God so loved the world that he gave his one and only Son';

describe('RegularOutput stream band', () => {
  beforeEach(() => {
    useLyricsStore.setState({
      lyrics: [`${VERSE}\n\nJohn 3:16`],
      selectedLine: 0,
      lyricsFileName: 'John 3:16',
      bibleVersion: '',
      contentMode: 'bible',
      isOutputOn: true,
      showState: 'LIVE',
      streamEnabled: true,
      streamSettings: { ...defaultStreamSettings },
      tickerQueue: [],
      tickerActiveId: null,
    });
  });

  it('paints only a bottom band and auto-fits the verse inside it', async () => {
    render(<RegularOutput outputKey="stream" displayName="Stream" />);

    const band = await screen.findByTestId('stream-band');
    expect(band.className).toContain('fixed');
    expect(band.className).toContain('bottom-0');
    expect(band.style.height).toBe('33vh');

    const verse = await screen.findByText(VERSE);
    expect(band.contains(verse)).toBe(true);
    await waitFor(() => expect(verse.style.fontSize).toBe('64px'));

    const reference = screen.getByText('John 3:16');
    expect(band.contains(reference)).toBe(true);

    // The band route must never mount a full-frame background or the
    // full-screen show-state covers used by the projector outputs.
    expect(screen.queryByTestId('show-blackout')).toBeNull();
    expect(screen.queryByTestId('show-logo')).toBeNull();
  });
});
