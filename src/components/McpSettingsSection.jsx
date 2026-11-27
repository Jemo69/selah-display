import React from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Check, Copy, Plug, RefreshCw, ShieldAlert, Terminal } from 'lucide-react';
import useLyricsStore, { defaultMcpSettings } from '../context/LyricsStore';
import { ControlSocketContext } from '../context/ControlSocketProvider';
import useToast from '../hooks/useToast';
import { resolveBackendOrigin } from '../utils/network';

const DEFAULT_HTTP_MCP_URL = 'http://127.0.0.1:4000/mcp';
const DEFAULT_STDIO_PATH = 'server/mcp.js';

const McpSettingsSection = ({ darkMode }) => {
  const mcpSettings = useLyricsStore((s) => s.mcpSettings) || defaultMcpSettings();
  const setMcpSettings = useLyricsStore((s) => s.setMcpSettings);
  const socketCtx = React.useContext(ControlSocketContext);
  const { showToast } = useToast();

  const enabled = mcpSettings.enabled !== false;
  const allowRemote = mcpSettings.allowRemote === true;

  const [httpUrl, setHttpUrl] = React.useState(() => {
    try {
      const origin = resolveBackendOrigin();
      return origin ? `${origin.replace(/\/+$/, '')}/mcp` : DEFAULT_HTTP_MCP_URL;
    } catch {
      return DEFAULT_HTTP_MCP_URL;
    }
  });
  const [stdioScriptPath, setStdioScriptPath] = React.useState(DEFAULT_STDIO_PATH);
  const [probeState, setProbeState] = React.useState({ status: 'idle', toolsCount: null, error: null });
  const [copiedKey, setCopiedKey] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    const bridge = typeof window !== 'undefined' ? window.electronAPI?.mcp : null;
    if (!bridge?.getInfo) return undefined;
    bridge.getInfo()
      .then((info) => {
        if (cancelled || !info?.success) return;
        if (info.httpUrl) setHttpUrl(info.httpUrl);
        if (info.stdioScriptPath) setStdioScriptPath(info.stdioScriptPath);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const probeServer = React.useCallback(async () => {
    if (!enabled) {
      setProbeState({ status: 'disabled', toolsCount: null, error: null });
      return;
    }
    setProbeState((prev) => ({ ...prev, status: 'checking', error: null }));
    try {
      const res = await fetch(httpUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        setProbeState({ status: 'error', toolsCount: null, error: `HTTP ${res.status}` });
        return;
      }
      const data = await res.json();
      setProbeState({
        status: data?.enabled === false ? 'disabled' : 'ready',
        toolsCount: Array.isArray(data?.tools) ? data.tools.length : null,
        error: null,
      });
    } catch {
      setProbeState({ status: 'unreachable', toolsCount: null, error: null });
    }
  }, [enabled, httpUrl]);

  React.useEffect(() => {
    if (!enabled) {
      setProbeState({ status: 'disabled', toolsCount: null, error: null });
      return undefined;
    }
    probeServer();
    return undefined;
  }, [enabled, probeServer]);

  const emitImmediateSync = React.useCallback((nextSettings) => {
    try {
      const sock = socketCtx?.socket || window.__controlSocketContext?.socket;
      if (sock?.connected) {
        sock.emit('appConfigSync', { patch: { mcp: nextSettings } });
      }
    } catch {
      // non-fatal; debounced subscriber also syncs
    }
  }, [socketCtx]);

  const handleToggleEnabled = () => {
    const nextEnabled = !enabled;
    const next = { enabled: nextEnabled, allowRemote };
    setMcpSettings({ enabled: nextEnabled });
    emitImmediateSync(next);
    showToast({
      title: nextEnabled ? 'MCP Server enabled' : 'MCP Server disabled',
      message: nextEnabled
        ? `Local AI clients can now configure Selah at ${httpUrl}.`
        : 'The /mcp endpoint is now closed.',
      variant: nextEnabled ? 'success' : 'info',
    });
  };

  const handleToggleRemote = () => {
    const nextRemote = !allowRemote;
    const next = { enabled, allowRemote: nextRemote };
    setMcpSettings({ allowRemote: nextRemote });
    emitImmediateSync(next);
    showToast({
      title: nextRemote ? 'Remote MCP access enabled' : 'MCP restricted to this computer',
      message: nextRemote
        ? 'LAN/Tailscale clients can connect to /mcp using a Bearer token.'
        : 'Only loopback (127.0.0.1 / localhost) clients can reach /mcp.',
      variant: nextRemote ? 'warning' : 'info',
    });
  };

  const httpConfigSnippet = React.useMemo(
    () => JSON.stringify({
      mcpServers: {
        selah: {
          url: httpUrl,
        },
      },
    }, null, 2),
    [httpUrl]
  );

  const stdioConfigSnippet = React.useMemo(
    () => JSON.stringify({
      mcpServers: {
        selah: {
          command: 'node',
          args: [stdioScriptPath],
        },
      },
    }, null, 2),
    [stdioScriptPath]
  );

  const copyValue = async (key, value, label) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((curr) => (curr === key ? null : curr)), 1800);
      showToast({ title: `${label} copied`, message: 'Paste into your AI client MCP configuration.', variant: 'success' });
    } catch {
      showToast({ title: 'Copy failed', message: 'Select and copy the snippet manually.', variant: 'error' });
    }
  };

  const statusBadge = () => {
    if (!enabled || probeState.status === 'disabled') {
      return {
        label: 'Disabled',
        cls: darkMode
          ? 'bg-gray-800 text-gray-400 border-gray-700'
          : 'bg-gray-100 text-gray-600 border-gray-200',
      };
    }
    if (probeState.status === 'ready') {
      return {
        label: probeState.toolsCount ? `Active · ${probeState.toolsCount} tools` : 'Active',
        cls: darkMode
          ? 'bg-[#8FCE72]/15 text-[#8FCE72] border-[#8FCE72]/30'
          : 'bg-emerald-50 text-emerald-700 border-emerald-200',
      };
    }
    if (probeState.status === 'checking') {
      return {
        label: 'Checking…',
        cls: darkMode
          ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'
          : 'bg-blue-50 text-blue-700 border-blue-200',
      };
    }
    return {
      label: 'Configured (server offline)',
      cls: darkMode
        ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
        : 'bg-amber-50 text-amber-800 border-amber-200',
    };
  };

  const badge = statusBadge();

  return (
    <div className="space-y-5" data-testid="mcp-settings-section">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className={`text-base font-semibold flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            <Plug className="w-5 h-5" /> MCP Server
          </h3>
          <p className={`text-xs mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            Connect an AI assistant (Claude, Cursor, Antigravity, Codex) to inspect and change Selah settings in plain language.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            data-testid="mcp-status-badge"
            className={`text-[11px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full border ${badge.cls}`}
          >
            {badge.label}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={probeServer}
            className="h-7 px-2 text-xs"
            title="Refresh MCP server status"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={handleToggleEnabled}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleToggleEnabled();
          }
        }}
        data-testid="mcp-enabled-toggle"
        className={`w-full text-left flex items-center justify-between gap-4 rounded-xl border p-4 cursor-pointer transition-all ${darkMode ? 'bg-[#282946]/40 border-[#282946] text-gray-100' : 'bg-white border-gray-200 text-gray-900'}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Enable MCP Server for Config
            </span>
          </div>
          <p className={`text-xs mt-1 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            Exposes Model Context Protocol tools and resources at <span className="font-mono">{httpUrl}</span> and via the stdio bridge (<span className="font-mono">server/mcp.js</span>).
          </p>
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <Switch checked={enabled} onCheckedChange={handleToggleEnabled} aria-label="Enable MCP Server for Config" />
        </div>
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={handleToggleRemote}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleToggleRemote();
          }
        }}
        data-testid="mcp-allow-remote-toggle"
        className={`w-full text-left flex items-center justify-between gap-4 rounded-xl border p-4 cursor-pointer transition-all ${darkMode ? 'bg-[#282946]/40 border-[#282946] text-gray-100' : 'bg-white border-gray-200 text-gray-900'}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Allow LAN / Remote MCP Clients
            </span>
          </div>
          <p className={`text-xs mt-1 leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            Off by default (loopback only). When enabled, non-local devices must send a valid Bearer token with <span className="font-mono">settings:write</span> permission.
          </p>
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <Switch checked={allowRemote} onCheckedChange={handleToggleRemote} aria-label="Allow LAN / Remote MCP Clients" />
        </div>
      </div>

      {allowRemote && (
        <div className={`rounded-xl p-3.5 border flex gap-3 ${darkMode ? 'bg-amber-900/10 border-amber-800/30 text-amber-200/80' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="text-xs leading-relaxed">
            Remote MCP is enabled. Only share your admin/API Bearer token with trusted operators on your church LAN or tailnet.
          </div>
        </div>
      )}

      <div className={`rounded-xl border p-4 space-y-3 ${darkMode ? 'bg-[#282946]/40 border-[#282946]' : 'bg-white border-gray-200'}`}>
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Streamable HTTP Endpoint (Recommended)
            </div>
            <p className={`text-xs mt-0.5 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              For MCP clients that support HTTP servers directly.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => copyValue('http', httpConfigSnippet, 'HTTP MCP config')}
            className="h-7 px-2.5 text-xs shrink-0"
          >
            {copiedKey === 'http' ? <Check className="w-3.5 h-3.5 mr-1 text-emerald-500" /> : <Copy className="w-3.5 h-3.5 mr-1" />}
            {copiedKey === 'http' ? 'Copied' : 'Copy JSON'}
          </Button>
        </div>
        <pre className={`rounded-lg border p-3 text-[11px] font-mono overflow-x-auto ${darkMode ? 'bg-gray-950 border-gray-800 text-gray-200' : 'bg-gray-50 border-gray-200 text-gray-800'}`}>
          {httpConfigSnippet}
        </pre>
      </div>

      <div className={`rounded-xl border p-4 space-y-3 ${darkMode ? 'bg-[#282946]/40 border-[#282946]' : 'bg-white border-gray-200'}`}>
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className={`text-sm font-medium flex items-center gap-1.5 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              <Terminal className="w-4 h-4" /> Stdio Bridge (Claude Desktop / Local CLI)
            </div>
            <p className={`text-xs mt-0.5 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              For clients that spawn a local stdio process. Selah must be running.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => copyValue('stdio', stdioConfigSnippet, 'Stdio MCP config')}
            className="h-7 px-2.5 text-xs shrink-0"
          >
            {copiedKey === 'stdio' ? <Check className="w-3.5 h-3.5 mr-1 text-emerald-500" /> : <Copy className="w-3.5 h-3.5 mr-1" />}
            {copiedKey === 'stdio' ? 'Copied' : 'Copy JSON'}
          </Button>
        </div>
        <pre className={`rounded-lg border p-3 text-[11px] font-mono overflow-x-auto ${darkMode ? 'bg-gray-950 border-gray-800 text-gray-200' : 'bg-gray-50 border-gray-200 text-gray-800'}`}>
          {stdioConfigSnippet}
        </pre>
      </div>

      <div className={`rounded-xl border p-4 ${darkMode ? 'bg-[#111231]/60 border-[#282946]' : 'bg-gray-50 border-gray-200'}`}>
        <div className={`text-xs font-semibold uppercase tracking-wide mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
          What you can ask your AI assistant
        </div>
        <ul className={`text-xs space-y-1.5 list-disc list-inside ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          <li>“Read my current Selah settings and summarize output styles.”</li>
          <li>“Enable Dark Mode and set Output 1 font size to 64.”</li>
          <li>“Set the Stream lower-third band height to 30% with gradient backdrop.”</li>
          <li>“Switch Sermon Assist to local mode using the base.en model.”</li>
        </ul>
      </div>
    </div>
  );
};

export default McpSettingsSection;
