#!/usr/bin/env node
/**
 * Selah stdio MCP bridge.
 *
 * Bridges standard MCP JSON-RPC 2.0 messages on stdin/stdout to the running
 * Selah backend HTTP `/mcp` endpoint (default http://127.0.0.1:4000/mcp).
 *
 * Environment variables:
 *   SELAH_MCP_URL    Full MCP endpoint URL (default: http://127.0.0.1:4000/mcp)
 *   SELAH_URL        Base Selah server URL (used if SELAH_MCP_URL is unset)
 *   SELAH_ADMIN_KEY  Optional admin key when connecting to a remote Selah server
 *   SELAH_API_TOKEN  Optional pre-issued Bearer JWT
 */
import readline from 'node:readline';

const baseUrl = (process.env.SELAH_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const mcpUrl = (process.env.SELAH_MCP_URL || `${baseUrl}/mcp`).trim();
const adminKey = process.env.SELAH_ADMIN_KEY || '';
let bearerToken = process.env.SELAH_API_TOKEN || '';
let sessionId = null;

function writeLine(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function ensureRemoteTokenIfNeeded() {
  if (bearerToken) return bearerToken;
  if (!adminKey) return null;
  const authUrl = `${baseUrl}/api/auth/token`;
  const res = await fetch(authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientType: 'api',
      deviceId: `selah-mcp-stdio-${process.pid}`,
      adminKey,
    }),
  });
  if (!res.ok) {
    throw new Error(`Selah auth failed (${res.status}) at ${authUrl}`);
  }
  const data = await res.json();
  bearerToken = data.token || '';
  return bearerToken;
}

async function forwardToSelah(message) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const token = await ensureRemoteTokenIfNeeded();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });

  const nextSessionId = res.headers.get('mcp-session-id');
  if (nextSessionId) sessionId = nextSessionId;

  if (res.status === 202) {
    return null;
  }

  const text = await res.text();
  if (!text) {
    if (!res.ok) {
      throw new Error(`Selah MCP returned HTTP ${res.status}`);
    }
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid response from Selah MCP (${res.status}): ${text.slice(0, 200)}`);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

// Process messages sequentially to preserve JSON-RPC ordering and session state.
let queue = Promise.resolve();

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  queue = queue.then(async () => {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      writeLine({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      });
      return;
    }

    try {
      const reply = await forwardToSelah(parsed);
      if (reply !== null && reply !== undefined) {
        writeLine(reply);
      }
    } catch (error) {
      const id = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed.id ?? null) : null;
      if (id !== null && id !== undefined) {
        const message = error?.cause?.code === 'ECONNREFUSED'
          ? `Cannot connect to Selah at ${mcpUrl}. Make sure the Selah app is running.`
          : (error?.message || 'Failed to reach Selah MCP server');
        writeLine({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message },
        });
      } else {
        process.stderr.write(`[selah-mcp] ${error?.message || error}\n`);
      }
    }
  });
});

rl.on('close', () => {
  queue.finally(() => process.exit(0));
});
