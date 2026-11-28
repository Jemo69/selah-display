import { beforeEach, describe, expect, it } from 'vitest';
import useLyricsStore from '@/context/LyricsStore';
import useBibleStore from '@/context/BibleStore';
import useSpeechStore from '@/context/SpeechStore';
import { useOnboardStore } from '@/context/OnboardStore';
import useRccgTphbStore from '@/context/RccgTphbStore';
import { applyAppConfigPatchToStores, extractAppConfigFromStores } from '@/utils/appConfigSync';

describe('appConfigSync store bridge', () => {
  beforeEach(() => {
    localStorage.clear();
    useLyricsStore.setState({
      darkMode: false,
      uiScale: 100,
      autoGroupLines: true,
      freeNotesEnabled: false,
      mcpSettings: { enabled: true, allowRemote: false },
    });
    useSpeechStore.getState().resetToDefaults();
    useOnboardStore.setState({ role: 'all', explainMode: false });
    useRccgTphbStore.getState().clearCredentials();
  });

  it('extracts defaults with mcp.enabled=true and speech.enabled=false', () => {
    const cfg = extractAppConfigFromStores();
    expect(cfg.mcp).toEqual({ enabled: true, allowRemote: false });
    expect(cfg.speech.enabled).toBe(false);
    expect(cfg.interface.darkMode).toBe(false);
  });

  it('round-trips the experimental limited text scope switch', () => {
    expect(useLyricsStore.getState().bibleTextScopeEnabled).toBe(false);
    expect(extractAppConfigFromStores().experimental.bibleTextScopeEnabled).toBe(false);

    expect(applyAppConfigPatchToStores({ experimental: { bibleTextScopeEnabled: true } })).toBe(true);
    expect(useLyricsStore.getState().bibleTextScopeEnabled).toBe(true);
    expect(extractAppConfigFromStores().experimental.bibleTextScopeEnabled).toBe(true);

    // A patch that does not name the key must leave it alone.
    applyAppConfigPatchToStores({ experimental: { freeNotesEnabled: true } });
    expect(useLyricsStore.getState().bibleTextScopeEnabled).toBe(true);
  });

  it('applies remote MCP config patches across all preference stores', () => {
    const applied = applyAppConfigPatchToStores({
      interface: { darkMode: true, uiScale: 115 },
      lyrics: { autoGroupLines: false },
      bible: { settings: { splitLongVerses: true, splitMethod: 'legacy' } },
      speech: { where: 'network', networkEndpoint: 'http://192.168.1.50:4700' },
      experimental: { freeNotesEnabled: true },
      onboard: { role: 'streamer', explainMode: true },
      database: { baseUrl: 'https://songs.example.org/' },
      mcp: { allowRemote: true },
    });

    expect(applied).toBe(true);
    expect(useLyricsStore.getState().darkMode).toBe(true);
    expect(useLyricsStore.getState().uiScale).toBe(115);
    expect(useLyricsStore.getState().autoGroupLines).toBe(false);
    expect(useLyricsStore.getState().freeNotesEnabled).toBe(true);
    expect(useLyricsStore.getState().mcpSettings).toEqual({ enabled: true, allowRemote: true });
    expect(useBibleStore.getState().settings.splitLongVerses).toBe(true);
    expect(useBibleStore.getState().settings.splitMethod).toBe('legacy');
    expect(useSpeechStore.getState().where).toBe('network');
    expect(useSpeechStore.getState().networkEndpoint).toBe('http://192.168.1.50:4700');
    expect(useOnboardStore.getState().role).toBe('streamer');
    expect(useOnboardStore.getState().explainMode).toBe(true);
    expect(useRccgTphbStore.getState().baseUrl).toBe('https://songs.example.org');
  });
});
