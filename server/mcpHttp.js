import crypto from 'node:crypto';
import express from 'express';
import {
  MCP_RESOURCES,
  MCP_SERVER_INFO,
  MCP_TOOLS,
  handleMcpMessage,
  isLoopbackRemoteAddress,
} from './mcpCore.js';
import { getAppConfigSnapshot } from './events.js';

/**
 * Create the Express router for Selah's Streamable HTTP MCP endpoint (`/mcp`).
 */
export function createMcpRouter({
  getMcpConfig = () => getAppConfigSnapshot().mcp,
  verifyBearerToken = null,
  getClientPermissions = () => [],
} = {}) {
  const router = express.Router();
  const sessions = new Map();

  const sendJsonRpcError = (res, status, code, message, id = null) => {
    return res.status(status).json({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
  };

  const authorizeMcpRequest = (req, res, next) => {
    const mcpCfg = getMcpConfig?.() || { enabled: true, allowRemote: false };
    if (mcpCfg.enabled === false) {
      return sendJsonRpcError(
        res,
        503,
        -32000,
        'MCP server is disabled in Selah Preferences > MCP Server.',
        req.body?.id ?? null
      );
    }

    if (isLoopbackRemoteAddress(req)) {
      return next();
    }

    if (mcpCfg.allowRemote !== true) {
      return sendJsonRpcError(
        res,
        403,
        -32000,
        'MCP remote access is disabled. Enable "Allow LAN / Remote MCP" in Selah Preferences > MCP Server.',
        req.body?.id ?? null
      );
    }

    const authHeader = req.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (!token || typeof verifyBearerToken !== 'function') {
      return sendJsonRpcError(res, 401, -32000, 'Authentication token required for remote MCP access', req.body?.id ?? null);
    }
    const decoded = verifyBearerToken(token);
    if (!decoded) {
      return sendJsonRpcError(res, 401, -32000, 'Invalid or expired token', req.body?.id ?? null);
    }
    const permissions = decoded.permissions || getClientPermissions(decoded.clientType) || [];
    if (!permissions.includes('settings:write') && !permissions.includes('admin:full')) {
      return sendJsonRpcError(res, 403, -32000, 'Insufficient permissions for MCP config access', req.body?.id ?? null);
    }
    req.user = { ...decoded, permissions };
    return next();
  };

  router.use(authorizeMcpRequest);

  router.get('/', (req, res) => {
    const accept = String(req.get('accept') || '');
    if (accept.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      res.write(': connected\n\n');
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(heartbeat);
        }
      }, 25000);
      heartbeat.unref?.();
      req.on('close', () => {
        clearInterval(heartbeat);
      });
      return;
    }

    const mcpCfg = getMcpConfig?.() || { enabled: true, allowRemote: false };
    res.json({
      ok: true,
      transport: 'streamable-http',
      endpoint: '/mcp',
      enabled: mcpCfg.enabled !== false,
      allowRemote: mcpCfg.allowRemote === true,
      server: MCP_SERVER_INFO,
      tools: MCP_TOOLS.map((t) => t.name),
      resources: MCP_RESOURCES.map((r) => r.uri),
    });
  });

  router.post('/', (req, res) => {
    const body = req.body;
    const incomingSessionId = req.get('mcp-session-id');

    if (Array.isArray(body)) {
      if (body.length === 0) {
        return sendJsonRpcError(res, 400, -32600, 'Invalid Request: empty batch');
      }
      const replies = body.map((msg) => handleMcpMessage(msg)).filter((r) => r !== null);
      if (replies.length === 0) {
        return res.status(202).end();
      }
      if (incomingSessionId && sessions.has(incomingSessionId)) {
        res.setHeader('Mcp-Session-Id', incomingSessionId);
      }
      return res.status(200).json(replies);
    }

    if (!body || typeof body !== 'object') {
      return sendJsonRpcError(res, 400, -32600, 'Invalid Request: expected JSON-RPC object');
    }

    const reply = handleMcpMessage(body);

    if (body.method === 'initialize' && reply && !reply.error) {
      const sid = incomingSessionId && sessions.has(incomingSessionId)
        ? incomingSessionId
        : crypto.randomUUID();
      sessions.set(sid, { createdAt: Date.now() });
      res.setHeader('Mcp-Session-Id', sid);
    } else if (incomingSessionId && sessions.has(incomingSessionId)) {
      res.setHeader('Mcp-Session-Id', incomingSessionId);
    }

    if (reply === null) {
      return res.status(202).end();
    }
    return res.status(200).json(reply);
  });

  router.delete('/', (req, res) => {
    const incomingSessionId = req.get('mcp-session-id');
    if (incomingSessionId) sessions.delete(incomingSessionId);
    return res.status(204).end();
  });

  return router;
}
