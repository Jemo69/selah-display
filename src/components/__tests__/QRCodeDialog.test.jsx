/**
 * Regression test for the dogfood 10/10 run on PR #61: the Tailscale QR
 * dialog patch once referenced `allIPs`/`setAllIPs` without declaring the
 * state — a runtime ReferenceError that crashed the whole app behind the
 * error boundary (no test rendered the dialog, `npm run build` passed).
 * This test renders the dialog open and fails on any render-time throw.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import QRCodeDialog from '../QRCodeDialog';

describe('QRCodeDialog (mobile connect, Tailscale)', () => {
  beforeEach(() => {
    window.electronAPI = {
      getJoinCode: async () => '494155',
      getLocalIPs: async () => ({
        lan: [{ address: '10.0.0.32', interface: 'eth0', tailscale: false }],
        tailnet: [],
        all: [{ address: '10.0.0.32', interface: 'eth0', tailscale: false }],
      }),
      getLocalIP: async () => '10.0.0.32',
    };
  });

  afterEach(() => {
    cleanup();
    delete window.electronAPI;
  });

  it('renders open with QR, join code, and URLs without throwing', async () => {
    const onClose = vi.fn();
    render(<QRCodeDialog isOpen onClose={onClose} darkMode={false} />);
    expect(
      await screen.findByRole('dialog', { name: /connect mobile controller/i }),
    ).toBeInTheDocument();
  });

  it('shows the fetched join code', async () => {
    const onClose = vi.fn();
    render(<QRCodeDialog isOpen onClose={onClose} darkMode={false} />);
    expect(await screen.findByText(/494155/)).toBeInTheDocument();
  });

  it('exposes a network picker when multiple addresses exist', async () => {
    window.electronAPI.getLocalIPs = async () => ({
      lan: [{ address: '192.168.1.10', interface: 'wlan0', tailscale: false }],
      tailnet: [{ address: '100.90.1.2', interface: 'tailscale0', tailscale: true }],
      all: [
        { address: '192.168.1.10', interface: 'wlan0', tailscale: false },
        { address: '100.90.1.2', interface: 'tailscale0', tailscale: true },
      ],
    });
    const onClose = vi.fn();
    render(<QRCodeDialog isOpen onClose={onClose} darkMode={false} />);
    // Tailscale address offered as a selectable chip.
    expect(await screen.findByText(/100\.90\.1\.2/)).toBeInTheDocument();
  });

  it('falls back to the single-IP call when getLocalIPs is absent', async () => {
    delete window.electronAPI.getLocalIPs;
    const onClose = vi.fn();
    render(<QRCodeDialog isOpen onClose={onClose} darkMode={false} />);
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  it('encodes the port the page was served from (custom PORT boots)', async () => {
    // jsdom serves the test page itself; the dialog must echo that port,
    // not the 4000 build-time default, or custom-port QR codes misdial.
    const onClose = vi.fn();
    render(<QRCodeDialog isOpen onClose={onClose} darkMode={false} />);
    const expectedPort = window.location.port || '4000';
    await waitFor(() => {
      const urls = screen.getAllByText(new RegExp(`:${expectedPort}/`, 'i'));
      expect(urls.length).toBeGreaterThan(0);
    });
  });

  it('renders nothing when closed', () => {
    const onClose = vi.fn();
    const { container } = render(
      <QRCodeDialog isOpen={false} onClose={onClose} darkMode={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
