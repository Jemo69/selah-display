// @vitest-environment node
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_CONFIG_SECTIONS,
  createDefaultAppConfig,
  sanitizeAppConfigSection,
} from '../shared/appConfig.js';
import {
  MCP_TOOLS,
  handleMcpMessage,
} from '../server/mcpCore.js';
import { createMcpRouter } from '../server/mcpHttp.js';
import {
  getAppConfigSnapshot,
  resetAppConfigSectionInternal,
  updateAppConfigInternal,
} from '../server/events.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

describe('shared/appConfig', () => {
  it('defaults mcp.enabled to true and speech.enabled to false', () => {
    const cfg = createDefaultAppConfig();
    expect(cfg.mcp).toEqual({ enabled: true, allowRemote: false });
    expect(cfg.speech.enabled).toBe(false);
    expect(cfg.speech.where).toBe('local');
  });

  it('rejects non-boolean speech.enabled in strict mode and clamps uiScale', () => {
    expect(() => sanitizeAppConfigSection('speech', { enabled: 'yes' }, null, { strict: true })).toThrow();
    const ui = sanitizeAppConfigSection('interface', { uiScale: 999 }, null, { strict: true });
    expect(ui.uiScale).toBe(150);
  });
});

describe('server/mcpCore JSON-RPC protocol', () => {
  beforeEach(() => {
    resetAppConfigSectionInternal('all');
  });

  it('handles initialize, ping, notifications, and lists all tools/resources/prompts', () => {
    const init = handleMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', clientInfo: { name: 'test', version: '1.0' } },
    });
    expect(init.result.protocolVersion).toBe('2025-03-26');
    expect(init.result.serverInfo.name).toBe('selah-display-mcp');

    expect(handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 2, result: {} });

    const toolsRes = handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(toolsRes.result.tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));

    const resourcesRes = handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
    expect(resourcesRes.result.resources.map((r) => r.uri)).toContain('selah://config');

    const promptsRes = handleMcpMessage({ jsonrpc: '2.0', id: 5, method: 'prompts/list' });
    expect(promptsRes.result.prompts.length).toBeGreaterThanOrEqual(3);
  });

  it('updates and resets app config and output settings via tools/call', () => {
    const update = handleMcpMessage({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'update_app_config',
        arguments: {
          config: {
            interface: { darkMode: true, uiScale: 120 },
            lyrics: { autoGroupLines: false },
            bible: { settings: { splitLongVerses: true, splitMethod: 'legacy' } },
          },
        },
      },
    });
    expect(update.result.isError).toBe(false);
    expect(update.result.structuredContent.updatedSections).toEqual(['interface', 'lyrics', 'bible']);
    expect(getAppConfigSnapshot().interface.darkMode).toBe(true);
    expect(getAppConfigSnapshot().interface.uiScale).toBe(120);
    expect(getAppConfigSnapshot().lyrics.autoGroupLines).toBe(false);
    expect(getAppConfigSnapshot().bible.settings.splitMethod).toBe('legacy');

    const outUpdate = handleMcpMessage({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'update_output_settings',
        arguments: {
          output: 'stream',
          settings: { streamBandHeightPercent: 40, streamBandBackdrop: 'solid', fontSize: 96 },
        },
      },
    });
    expect(outUpdate.result.isError).toBe(false);
    expect(outUpdate.result.structuredContent.settings.streamBandHeightPercent).toBe(40);
    expect(outUpdate.result.structuredContent.settings.streamBandBackdrop).toBe('solid');

    const show = handleMcpMessage({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'set_show_state', arguments: { state: 'CLEAR' } },
    });
    expect(show.result.structuredContent).toEqual({ showState: 'CLEAR', isOutputOn: false });

    const reset = handleMcpMessage({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'reset_config_section', arguments: { section: 'interface' } },
    });
    expect(reset.result.structuredContent.config.interface.darkMode).toBe(false);
    expect(reset.result.structuredContent.config.interface.uiScale).toBe(100);
  });

  it('reads selah://config and selah://schema resources', () => {
    const res = handleMcpMessage({
      jsonrpc: '2.0',
      id: 20,
      method: 'resources/read',
      params: { uri: 'selah://schema' },
    });
    const parsed = JSON.parse(res.result.contents[0].text);
    expect(parsed.sections).toEqual(APP_CONFIG_SECTIONS);
  });
});

describe('HTTP /mcp transport and stdio bridge (server/mcp.js)', () => {
  let server;
  let baseUrl;
  let forceRemoteIp = false;

  beforeEach(() => {
    resetAppConfigSectionInternal('all');
    forceRemoteIp = false;
  });

  const startServer = async () => {
    if (server) return;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (forceRemoteIp) {
        Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.55', configurable: true });
      }
      next();
    });
    app.use('/mcp', createMcpRouter({
      getMcpConfig: () => getAppConfigSnapshot().mcp,
      verifyBearerToken: (token) => (token === 'valid-token'
        ? { clientType: 'api', permissions: ['settings:write'] }
        : null),
      getClientPermissions: () => ['settings:write'],
    }));
    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  };

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  });

  it('serves GET /mcp info, POST /mcp JSON-RPC sessions, and honors mcp.enabled toggle', async () => {
    await startServer();

    const infoRes = await fetch(`${baseUrl}/mcp`);
    expect(infoRes.status).toBe(200);
    const info = await infoRes.json();
    expect(info.ok).toBe(true);
    expect(info.tools).toContain('update_app_config');

    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const notifRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(notifRes.status).toBe(202);

    // Disable MCP via config and verify /mcp refuses subsequent calls with 503
    updateAppConfigInternal({ mcp: { enabled: false } });
    const disabledRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(disabledRes.status).toBe(503);

    updateAppConfigInternal({ mcp: { enabled: true } });
    const deleteRes = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': sessionId },
    });
    expect(deleteRes.status).toBe(204);
  });

  it('blocks remote MCP calls unless allowRemote=true and Bearer token is valid', async () => {
    await startServer();
    forceRemoteIp = true;

    const denied = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(denied.status).toBe(403);

    updateAppConfigInternal({ mcp: { allowRemote: true } });
    const missingAuth = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(missingAuth.status).toBe(401);

    const authorized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    expect(authorized.status).toBe(200);
    const data = await authorized.json();
    expect(data.result.tools.length).toBe(MCP_TOOLS.length);
  });

  it('bridges stdio JSON-RPC through server/mcp.js to the running /mcp server', async () => {
    await startServer();
    const mcpScript = path.join(repoRoot, 'server', 'mcp.js');
    const child = spawn(process.execPath, [mcpScript], {
      env: { ...process.env, SELAH_URL: baseUrl },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) lines.push(JSON.parse(line));
      }
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'update_app_config',
        arguments: { section: 'interface', settings: { darkMode: true } },
      },
    })}\n`);

    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Timed out waiting for stdio MCP response')), 5000);
      const check = setInterval(() => {
        if (lines.length >= 2) {
          clearInterval(check);
          clearTimeout(deadline);
          resolve();
        }
      }, 25);
    });

    child.stdin.end();
    await new Promise((resolve) => child.once('exit', resolve));

    expect(lines[0].id).toBe(1);
    expect(lines[0].result.serverInfo.name).toBe('selah-display-mcp');
    expect(lines[1].id).toBe(2);
    expect(lines[1].result.structuredContent.config.interface.darkMode).toBe(true);
    expect(getAppConfigSnapshot().interface.darkMode).toBe(true);
  });
});
