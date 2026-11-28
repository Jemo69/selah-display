import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import UserPreferencesModal from '@/components/UserPreferencesModal';
import useRccgTphbStore from '@/context/RccgTphbStore';
import useBibleStore from '@/context/BibleStore';
import useLyricsStore from '@/context/LyricsStore';

const getState = () => useRccgTphbStore.getState();

describe('UserPreferencesModal - RCCGTPHB settings', () => {
  beforeEach(() => {
    localStorage.clear();
    getState().clearCredentials();
  });

  it('gates limited text scope behind the Experimental section', async () => {
    useLyricsStore.setState({ bibleTextScopeEnabled: false });
    render(<UserPreferencesModal darkMode={false} onClose={() => {}} initialSection="experimental" />);

    const toggle = screen.getByTestId('bible-text-scope-experimental-toggle');
    const card = toggle.closest('.rounded-xl');

    expect(screen.getByText('Limited Text Scope')).toBeTruthy();
    expect(within(card).getByText(/Feature Inactive:/)).toBeTruthy();

    fireEvent.click(toggle);

    await waitFor(() => expect(useLyricsStore.getState().bibleTextScopeEnabled).toBe(true));
    expect(within(card).getByText(/Feature Active:/)).toBeTruthy();
  });

  it('renders the RCCGTPHB database configuration section', () => {
    render(<UserPreferencesModal darkMode={false} onClose={() => {}} initialSection="database" />);
    expect(screen.getByText('RCCGTPHB Database')).toBeTruthy();
    expect(screen.getByPlaceholderText('https://your-rccgtphb-api.com')).toBeTruthy();
    expect(screen.getByPlaceholderText('sk_live_...')).toBeTruthy();
  });

  it('saves the base url and api key to the store', async () => {
    render(<UserPreferencesModal darkMode={false} onClose={() => {}} initialSection="database" />);
    fireEvent.change(screen.getByPlaceholderText('https://your-rccgtphb-api.com'), {
      target: { value: 'https://rccg.example.com/' },
    });
    fireEvent.change(screen.getByPlaceholderText('sk_live_...'), {
      target: { value: 'sk_test_abc' },
    });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      expect(getState().baseUrl).toBe('https://rccg.example.com');
      expect(getState().apiKey).toBe('sk_test_abc');
    });
  });

  it('clears credentials from the store', async () => {
    getState().setBaseUrl('https://rccg.example.com');
    getState().setApiKey('sk_test_abc');
    render(<UserPreferencesModal darkMode={false} onClose={() => {}} initialSection="database" />);
    fireEvent.click(screen.getByText('Clear'));
    await waitFor(() => {
      expect(getState().apiKey).toBe('');
      expect(getState().baseUrl).toBe('');
    });
  });

  it('keeps the Bible import action available in User Preferences', () => {
    render(<UserPreferencesModal darkMode={false} onClose={() => {}} initialSection="bible" />);

    expect(screen.getByRole('button', { name: 'Import Bible Translation' })).toBeTruthy();
    expect(screen.getByText(/Zefania, OSIS, Beblia, and OpenSong/)).toBeTruthy();
  });

  it('shows the Sunday service log card without requiring the desktop bridge', () => {
    render(<UserPreferencesModal darkMode={false} onClose={() => {}} initialSection="bible" />);

    expect(screen.getByText('Sunday service log')).toBeTruthy();
    expect(screen.getByTestId('service-log-status')).toBeTruthy();
    // Outside the desktop app there is no file-manager reveal action.
    expect(screen.queryByText('Reveal today’s file')).toBeNull();
  });

  it('trims translation previews by default and lets the user turn it off', () => {
    // Simulate settings persisted before this key existed: the trim must
    // still read as ON until the operator opts out.
    useBibleStore.setState({
      settings: { ...useBibleStore.getState().settings, truncateVersionPreviews: undefined },
    });

    render(<UserPreferencesModal darkMode={false} onClose={() => {}} initialSection="bible" />);

    const switchControl = screen.getByLabelText('Trim long verses in translation previews');
    expect(switchControl.getAttribute('data-state')).toBe('checked');

    fireEvent.click(screen.getByTestId('truncate-version-previews-toggle'));

    expect(useBibleStore.getState().settings.truncateVersionPreviews).toBe(false);
    expect(screen.getByLabelText('Trim long verses in translation previews').getAttribute('data-state')).toBe('unchecked');
  });

  it('renders the MCP Server config section with MCP enabled by default and lets the user toggle settings', () => {
    useLyricsStore.setState({ mcpSettings: { enabled: true, allowRemote: false } });
    render(<UserPreferencesModal darkMode={false} onClose={() => {}} initialSection="mcp" />);

    expect(screen.getByTestId('mcp-settings-section')).toBeTruthy();
    const enabledSwitch = screen.getByLabelText('Enable MCP Server for Config');
    expect(enabledSwitch.getAttribute('data-state')).toBe('checked');

    fireEvent.click(screen.getByTestId('mcp-allow-remote-toggle'));
    expect(useLyricsStore.getState().mcpSettings.allowRemote).toBe(true);

    fireEvent.click(screen.getByTestId('mcp-enabled-toggle'));
    expect(useLyricsStore.getState().mcpSettings.enabled).toBe(false);
  });
});
