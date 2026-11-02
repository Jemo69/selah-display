// server/index.js
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import registerSocketEvents, { onSessionStateChanged, getOutputPresenceSnapshot } from './events.js';
import { assertJoinCodeAllowed, recordJoinCodeAttempt, getJoinCodeGuardSnapshot } from './joinCodeGuard.js';
import { issueObsDockPin, verifyObsDockPin, getObsDockPairingSnapshot } from './auth/obsDockPairing.js';
import SimpleSecretManager from './secretManager.js';
import createServerLogger from './logger.js';
import apiRouter from './api.js';
import mdnsAdvertiser from './mdnsAdvertiser.js';
import {
  loadPersistedSessionState,
  schedulePersistSessionState,
  flushSessionStateNow,
} from './sessionPersistence.js';

const log = createServerLogger('Server');

const cleanupOldMediaFiles = async (outputKey, excludeFilename) => {
  try {
    const files = await fs.promises.readdir(backgroundMediaDir);
    const pattern = new RegExp(`^bg-${outputKey}-\\d+-[a-f0-9-]+\\.(jpg|jpeg|png|gif|webp|avif|mp4|webm|ogg|mov)$`, 'i');

    for (const file of files) {
      if (pattern.test(file) && file !== excludeFilename) {
        const filePath = path.join(backgroundMediaDir, file);
        await fs.promises.unlink(filePath);
        log.info(`Cleaned up old media file: ${file}`);
      }
    }
  } catch (error) {
    log.warn('Media cleanup warning (non-critical):', error.message);
  }
};

const deleteAllMediaForOutput = async (outputKey) => {
  try {
    const safeKey = String(outputKey || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 80);
    if (!safeKey) return;
    const files = await fs.promises.readdir(backgroundMediaDir);
    const pattern = new RegExp(`^bg-${safeKey}-\\d+-[a-f0-9-]+\\.(jpg|jpeg|png|gif|webp|avif|mp4|webm|ogg|mov)$`, 'i');
    const offscreenPattern = new RegExp(`^bg-${safeKey}-offscreen-\\d+-[a-f0-9-]+\\.(jpg|jpeg|png|gif|webp|avif|mp4|webm|ogg|mov)$`, 'i');
    for (const file of files) {
      if (pattern.test(file) || offscreenPattern.test(file)) {
        const filePath = path.join(backgroundMediaDir, file);
        await fs.promises.unlink(filePath);
        log.info(`Deleted media file for output ${safeKey}: ${file}`);
      }
    }
  } catch (error) {
    log.warn('Media deletion warning (non-critical):', error.message);
  }
};

global.deleteOutputMedia = deleteAllMediaForOutput;

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const secretManager = new SimpleSecretManager();
const secrets = await secretManager.loadSecrets();

const JWT_SECRET = secrets.JWT_SECRET;
const TOKEN_EXPIRY = secrets.TOKEN_EXPIRY || process.env.TOKEN_EXPIRY || '24h';
const ADMIN_TOKEN_EXPIRY = secrets.ADMIN_TOKEN_EXPIRY || process.env.ADMIN_TOKEN_EXPIRY || '7d';

global.controllerJoinCode = String(Math.floor(100000 + Math.random() * 900000));
const VALID_CLIENT_TYPES = ['desktop', 'web', 'output1', 'output2', 'stage', 'mobile', 'api'];
const CONTROLLER_CLIENT_TYPES = ['web', 'mobile'];
const isControllerClient = (clientType) => CONTROLLER_CLIENT_TYPES.includes(clientType);


const app = express();
const server = http.createServer(app);

// SELAH_DATA_DIR is the current name; LYRICDISPLAY_DATA_DIR is still accepted
// so standalone-server setups documented under the old name keep working.
const dataRootEnv = process.env.SELAH_DATA_DIR || process.env.LYRICDISPLAY_DATA_DIR;
const dataRoot = dataRootEnv
  ? path.resolve(dataRootEnv)
  : path.join(__dirname, '..');
const uploadsRoot = path.join(dataRoot, 'uploads');
const backgroundMediaDir = path.join(uploadsRoot, 'backgrounds');
fs.mkdirSync(backgroundMediaDir, { recursive: true });

const TAILSCALE_HOST_RE = /(^|\.)tail[a-z0-9-]*\.ts\.net$/i;
const isTailnetOrigin = (origin = '') => {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (host.endsWith('.ts.net')) return true;
    if (TAILSCALE_HOST_RE.test(host)) return true;
    // Tailscale CGNAT range 100.64.0.0/10 — church phones on the tailnet
    // reach the desktop via 100.x, which the old allow-list rejected.
    if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    return false;
  } catch { return false; }
};

const allowedMediaTypes = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'
]);

const backgroundStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, backgroundMediaDir),
  filename: (req, file, cb) => {
    const rawOutputKey = req.body.outputKey || 'output1';
    const outputKey = String(rawOutputKey).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 80) || 'output1';
    const ext = path.extname(file.originalname || '').slice(0, 16) || '.bin';
    const uniqueName = `bg-${outputKey}-${Date.now()}-${crypto.randomUUID()}${ext}`;
    cb(null, uniqueName);
  }
});

const backgroundUpload = multer({
  storage: backgroundStorage,
  limits: {
    fileSize: 200 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (!file?.mimetype || !allowedMediaTypes.has(file.mimetype)) {
      return cb(new Error('Unsupported media type'));
    }
    cb(null, true);
  },
});

// Rate limiting for token endpoints
const tokenRateLimit = rateLimit({
  windowMs: secrets.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000,
  max: secrets.RATE_LIMIT_MAX_REQUESTS || 50,
  message: { error: 'Too many token requests, try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// CORS middleware
const corsMiddleware = (req, res, next) => {
  const origin = req.get('origin');

  // Allow all origins in development
  if (isDev) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin) {
    // In production, allow same-origin, LAN, and Tailscale tailnet origins.
    // Tailscale serves the desktop as 100.x and/or <name>.tail*.ts.net —
    // phones off-site ("out of charge" hotspot + tailnet) must pass CORS.
    const isLocal = origin.includes('localhost') || origin.includes('127.0.0.1') || origin.startsWith('http://192.168.') || origin.startsWith('http://10.') || origin.startsWith('http://172.') || isTailnetOrigin(origin);
    if (isLocal) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
};

// Middleware
app.use(corsMiddleware);
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth', tokenRateLimit);

const localhostOnly = (req, res, next) => {
  const candidates = [
    req.ip,
    req.socket?.remoteAddress,
    req.connection?.remoteAddress,
    req.headers?.['x-forwarded-for']?.split(',')[0]?.trim(),
  ].filter(Boolean).map((value) => String(value));

  const isLocalAddress = (value) => {
    const normalized = value.replace(/^::ffff:/, '');
    return normalized === '127.0.0.1' ||
      normalized === '::1' ||
      normalized === 'localhost' ||
      normalized.startsWith('127.');
  };

  if (req.hostname === 'localhost' || req.hostname === '127.0.0.1' || candidates.some(isLocalAddress)) {
    return next();
  }

  return res.status(403).json({ error: 'Local access only' });
};

const authenticateRequest = (requiredPermission) => (req, res, next) => {
  try {
    const authHeader = req.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    if (!token) {
      return res.status(401).json({ error: 'Authentication token required' });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const permissions = decoded.permissions || getClientPermissions(decoded.clientType);
    if (requiredPermission && !permissions.includes(requiredPermission) && !permissions.includes('admin:full')) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    req.user = { ...decoded, permissions };
    return next();
  } catch (error) {
    log.error('HTTP authentication error:', error);
    return res.status(401).json({ error: 'Authentication failed' });
  }
};


// Mount REST API v1 routes (requires authentication)
app.use('/api/v1', authenticateRequest(null), apiRouter);

// Token generation utilities
const generateToken = (payload, expiresIn = TOKEN_EXPIRY) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
};

const verifyToken = (token) => {
  const decode = (secret) => {
    try {
      return jwt.verify(token, secret);
    } catch (error) {
      return null;
    }
  };

  let decoded = decode(JWT_SECRET);

  if (!decoded && secrets.previousSecret && secrets.previousSecretExpiry) {
    const graceExpiry = new Date(secrets.previousSecretExpiry);
    if (new Date() < graceExpiry) {
      decoded = decode(secrets.previousSecret);
    }
  }

  if (!decoded) {
    return null;
  }

  if (isControllerClient(decoded.clientType)) {
    if (decoded.joinCode !== global.controllerJoinCode) {
      return null;
    }
  }

  return decoded;
};

// Authentication endpoints
app.post('/api/auth/token', (req, res) => {
  const { clientType, deviceId, sessionId, adminKey, joinCode } = req.body;

  if (!clientType || !deviceId) {
    return res.status(400).json({
      error: 'Missing required fields: clientType and deviceId'
    });
  }

  if (!VALID_CLIENT_TYPES.includes(clientType)) {
    return res.status(400).json({
      error: 'Invalid client type. Must be one of: ' + VALID_CLIENT_TYPES.join(', ')
    });
  }

  if (clientType === 'desktop' || clientType === 'api') {
    const isProduction = process.env.NODE_ENV === 'production';
    const isDev = process.env.NODE_ENV === 'development' || !isProduction;

    if (isProduction && adminKey !== secrets.ADMIN_ACCESS_KEY) {
      log.warn(`Desktop token request denied - invalid admin key from ${req.ip}`);
      return res.status(403).json({
        error: 'Admin access key required for desktop/api client tokens'
      });
    }

    if (isDev && !adminKey) {
      log.warn(`${clientType} token issued without admin key (development mode)`);
    } else if (isDev && adminKey && adminKey !== secrets.ADMIN_ACCESS_KEY) {
      log.warn(`${clientType} token issued with incorrect admin key (development mode - allowing anyway)`);
    }
  } else if (isControllerClient(clientType)) {
    const guardContext = { ip: req.ip, deviceId, sessionId };

    if (!joinCode || joinCode !== global.controllerJoinCode) {
      recordJoinCodeAttempt({ ...guardContext, success: false });
      const guardStatus = assertJoinCodeAllowed(guardContext);

      if (!guardStatus.allowed) {
        log.warn(`Controller token request locked out for ${req.ip} (${deviceId})`);
        return res.status(423).json({
          error: 'Too many invalid join code attempts. Try again later.',
          retryAfterMs: guardStatus.retryAfterMs,
        });
      }

      log.warn(`Controller token denied - bad join code from ${req.ip}`);
      return res.status(403).json({ error: 'Join code required or invalid' });
    }

    recordJoinCodeAttempt({ ...guardContext, success: true });
  }

  try {
    const payload = {
      clientType,
      deviceId,
      sessionId: sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      permissions: getClientPermissions(clientType),
      issuedAt: Date.now()
    };

    if (isControllerClient(clientType)) {
      payload.joinCode = global.controllerJoinCode;
    }

    const expiresIn = clientType === 'desktop' ? ADMIN_TOKEN_EXPIRY : TOKEN_EXPIRY;
    const token = generateToken(payload, expiresIn);

    log.info(`Generated ${clientType} token (${deviceId}) - Admin key: ${adminKey ? 'provided' : 'not provided'}`);

    res.json({
      token,
      expiresIn,
      clientType,
      deviceId,
      sessionId: payload.sessionId,
      permissions: payload.permissions
    });
  } catch (error) {
    log.error('Token generation error:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

app.get('/api/auth/join-code', localhostOnly, (req, res) => {
  res.json({ joinCode: global.controllerJoinCode || null });
});

app.post('/api/auth/obs-dock/pin', localhostOnly, (req, res) => {
  const { deviceLabel } = req.body || {};
  try {
    const issued = issueObsDockPin({ deviceLabel });
    res.json({ success: true, ...issued });
  } catch (error) {
    log.error('OBS dock PIN issue failed:', error);
    res.status(500).json({ error: 'Failed to issue OBS dock PIN' });
  }
});

app.post('/api/auth/obs-dock/token', (req, res) => {
  const { pin, deviceId, sessionId } = req.body || {};

  if (!pin || !deviceId) {
    return res.status(400).json({
      error: 'Missing required fields: pin and deviceId'
    });
  }

  const result = verifyObsDockPin(pin, { ip: req.ip, deviceId, sessionId });
  if (!result.ok) {
    if (result.locked) {
      log.warn(`OBS dock token request locked out for ${req.ip} (${deviceId})`);
      return res.status(423).json({
        error: 'Too many invalid PIN attempts. Try again later.',
        retryAfterMs: result.retryAfterMs,
      });
    }
    log.warn(`OBS dock token denied - bad PIN from ${req.ip}`);
    return res.status(403).json({
      error: result.error || 'Invalid or expired PIN',
      remainingAttempts: result.remainingAttempts,
    });
  }

  try {
    const dockSessionId = sessionId || `obsdock_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const dockDeviceId = `obs-dock:${String(deviceId).slice(0, 64)}`;
    const payload = {
      clientType: 'web',
      deviceId: dockDeviceId,
      sessionId: dockSessionId,
      permissions: getClientPermissions('web'),
      issuedAt: Date.now(),
      joinCode: global.controllerJoinCode,
      obsDockPinId: result.pinId,
    };

    const token = generateToken(payload, TOKEN_EXPIRY);

    log.info(`Issued OBS dock token (${dockDeviceId})`);

    res.json({
      token,
      expiresIn: TOKEN_EXPIRY,
      clientType: 'web',
      deviceId: dockDeviceId,
      sessionId: dockSessionId,
      permissions: payload.permissions
    });
  } catch (error) {
    log.error('OBS dock token generation error:', error);
    res.status(500).json({ error: 'Failed to generate OBS dock token' });
  }
});

app.post('/api/auth/refresh', (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token required for refresh' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  try {
    const newPayload = {
      clientType: decoded.clientType,
      deviceId: decoded.deviceId,
      sessionId: decoded.sessionId,
      permissions: decoded.permissions,
      issuedAt: Date.now()
    };

    if (isControllerClient(decoded.clientType)) {
      newPayload.joinCode = global.controllerJoinCode;
    }

    const expiresIn = decoded.clientType === 'desktop' ? ADMIN_TOKEN_EXPIRY : TOKEN_EXPIRY;
    const newToken = generateToken(newPayload, expiresIn);

    log.info(`Refreshed token for ${decoded.clientType} client (${decoded.deviceId})`);

    res.json({
      token: newToken,
      expiresIn,
      clientType: decoded.clientType,
      deviceId: decoded.deviceId,
      sessionId: decoded.sessionId,
      permissions: decoded.permissions
    });
  } catch (error) {
    log.error('Token refresh error:', error);
    res.status(500).json({ error: 'Failed to refresh token' });
  }
});

app.post('/api/auth/validate', (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token required' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ valid: false, error: 'Invalid or expired token' });
  }

  res.json({
    valid: true,
    clientType: decoded.clientType,
    deviceId: decoded.deviceId,
    sessionId: decoded.sessionId,
    permissions: decoded.permissions,
    expiresAt: decoded.exp * 1000
  });
});

app.get('/api/outputs/resolve/:slug', (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase().replace(/^\/+/, '');
  const builtIns = [
    { id: 'output1', key: 'output1', name: 'Output 1', slug: 'output1', type: 'regular', builtIn: true },
    { id: 'output2', key: 'output2', name: 'Output 2', slug: 'output2', type: 'regular', builtIn: true },
    { id: 'stage', key: 'stage', name: 'Stage', slug: 'stage', type: 'stage', builtIn: true },
  ];
  const customOutputs = global.getOutputRegistry?.().customOutputs || [];
  const output = [...builtIns, ...customOutputs].find((item) => item.slug === slug);
  if (!output) return res.status(404).json({ error: 'Output not found' });
  res.json({ id: output.id, key: output.key || output.id, name: output.name, slug: output.slug, type: output.type, builtIn: Boolean(output.builtIn) });
});

app.get('/api/connection/clients', authenticateRequest('lyrics:read'), (req, res) => {
  try {
    const connectedClientsData = global.getConnectedClients ? global.getConnectedClients() : [];

    res.json({
      success: true,
      clients: connectedClientsData,
      totalCount: connectedClientsData.length,
      timestamp: Date.now()
    });
  } catch (error) {
    log.error('Error fetching connected clients:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch connected clients'
    });
  }
});

app.get('/api/v1/outputs/presence', authenticateRequest('lyrics:read'), (req, res) => {
  try {
    // NOTE: registered after the /api/v1 router mount above; the router has
    // no matching route so requests fall through to this handler.
    const snapshot = typeof getOutputPresenceSnapshot === 'function'
      ? getOutputPresenceSnapshot()
      : { presence: [], timestamp: Date.now() };

    res.json({
      success: true,
      presence: snapshot.presence || [],
      timestamp: snapshot.timestamp || Date.now()
    });
  } catch (error) {
    log.error('Error fetching output presence:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch output presence'
    });
  }
});

app.post(
  '/api/media/backgrounds',
  authenticateRequest('settings:write'),
  async (req, res, next) => {
    backgroundUpload.single('background')(req, res, async (err) => {
      if (err) {
        log.error('Background upload error:', err);
        if (err instanceof multer.MulterError) {
          return res.status(400).json({ error: err.message });
        }
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const relativePath = `/media/backgrounds/${req.file.filename}`;

      const outputKey = req.body.outputKey;
      if (outputKey && /^(output[12]|stage|custom_[a-z0-9_-]+)$/.test(outputKey)) {
        cleanupOldMediaFiles(outputKey, req.file.filename).catch(err =>
          log.warn('Background cleanup failed (non-blocking):', err.message)
        );
      }

      res.json({
        url: relativePath,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        uploadedAt: Date.now(),
      });
    });
  }
);

app.delete(
  '/api/media/backgrounds/:outputKey',
  authenticateRequest('settings:write'),
  async (req, res) => {
    try {
      const outputKey = String(req.params.outputKey || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 80);
      if (!outputKey) return res.status(400).json({ error: 'Invalid outputKey' });
      await deleteAllMediaForOutput(outputKey);
      res.json({ success: true, outputKey });
    } catch (error) {
      log.error('Delete media error:', error);
      res.status(500).json({ error: 'Failed to delete media' });
    }
  }
);

app.use('/media', express.static(uploadsRoot, {
  maxAge: '1d',
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
  },
}));

// Admin endpoint for secret management
app.get('/api/admin/secrets/status', localhostOnly, async (req, res) => {
  const status = await secretManager.getSecretsStatus();
  res.json(status);
});

app.post('/api/admin/secrets/rotate', localhostOnly, async (req, res) => {
  try {
    const newSecrets = await secretManager.rotateJWTSecret();
    res.json({
      success: true,
      message: 'JWT secret rotated successfully. Server restart required.',
      lastRotated: newSecrets.lastRotated
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Permission system
function getClientPermissions(clientType) {
  const permissions = {
    desktop: [
      'lyrics:read', 'lyrics:write', 'lyrics:delete',
      'setlist:read', 'setlist:write', 'setlist:delete',
      'output:control', 'settings:write', 'admin:full'
    ],
    web: [
      'lyrics:read', 'lyrics:write', 'lyrics:draft',
      'setlist:read', 'setlist:write',
      'output:control', 'settings:read', 'settings:write'
    ],
    output1: ['lyrics:read', 'settings:read'],
    output2: ['lyrics:read', 'settings:read'],
    stage: ['lyrics:read', 'settings:read'],
    mobile: [
      'lyrics:read', 'lyrics:write', 'lyrics:draft',
      'setlist:read', 'setlist:write',
      'output:control', 'settings:read', 'settings:write'
    ],
    api: [
      'lyrics:read', 'lyrics:write', 'lyrics:delete',
      'setlist:read', 'setlist:write', 'setlist:delete',
      'output:control', 'settings:write', 'admin:full'
    ]
  };

  return permissions[clientType] || ['lyrics:read'];
}

// Socket.IO authentication middleware (strict JWT required)
const authenticateSocket = (socket, next) => {

  if (socket.handshake.query?.token) {
    const error = new Error('Token in query string not allowed');
    error.data = { code: 'AUTH_TOKEN_IN_QUERY' };
    return next(error);
  }

  const token = socket.handshake.auth?.token;

  if (!token) {
    log.warn('Socket connection rejected: missing authentication token');
    const error = new Error('Authentication token required');
    error.data = { code: 'AUTH_TOKEN_REQUIRED' };
    return next(error);
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    log.warn('Socket connection rejected: invalid or expired token');
    const error = new Error('Invalid or expired token');
    error.data = { code: 'AUTH_TOKEN_INVALID' };
    return next(error);
  }

  socket.userData = {
    clientType: decoded.clientType,
    deviceId: decoded.deviceId,
    sessionId: decoded.sessionId,
    permissions: decoded.permissions,
    connectedAt: Date.now()
  };

  log.info('Socket authenticated:', decoded.clientType, '(' + decoded.deviceId + ')');
  return next();
};

// Permission checking utility
const hasPermission = (socket, permission) => {
  return socket.userData?.permissions?.includes(permission) ||
    socket.userData?.permissions?.includes('admin:full');
};

// Create Socket.IO server with authentication
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
const isDev = process.env.NODE_ENV === 'development';
      if (isDev) return callback(null, true);
      if (!origin) return callback(null, true); // allow non-browser clients
      const isLocal = origin.includes('localhost') || origin.includes('127.0.0.1') || origin.startsWith('http://192.168.') || origin.startsWith('http://10.') || origin.startsWith('http://172.') || isTailnetOrigin(origin);
      if (isLocal) return callback(null, true);
      callback(new Error('CORS: origin not allowed'));
    },
    credentials: true,
  },
  maxHttpBufferSize: 5 * 1024 * 1024, // 5MB
});

// Apply authentication middleware
io.use(authenticateSocket);

// Register socket events with authentication
registerSocketEvents(io, { hasPermission });

const PORT = process.env.PORT || 4000;
const isDev = process.env.NODE_ENV === 'development';

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: isDev ? 'development' : 'production',
    name: 'Selah',
    mdns: '_lyricdisplay._tcp',
  });
});

// Detailed health info restricted to localhost (Electron app only)
app.get('/api/admin/health', localhostOnly, async (req, res) => {
  const secretsStatus = await secretManager.getSecretsStatus();
  const joinCodeMetrics = getJoinCodeGuardSnapshot();
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: isDev ? 'development' : 'production',
    security: {
      secretsLoaded: secretsStatus.exists,
      daysSinceRotation: secretsStatus.daysSinceRotation,
      needsRotation: secretsStatus.needsRotation,
      joinCodeGuard: joinCodeMetrics,
      obsDockPairing: getObsDockPairingSnapshot(),
    }
  });
});

app.get('/api/health/ready', async (req, res) => {
  try {
    const secretsStatus = await secretManager.getSecretsStatus();
    const checks = {
      serverListening: true,
      secretsLoaded: !!secretsStatus?.exists,
      joinCodeGenerated: !!global.controllerJoinCode,
      socketIOReady: !!(io && io.engine),
      rateLimiterActive: !!tokenRateLimit,
    };

    const allChecksPass = Object.values(checks).every(check => check === true);

    if (allChecksPass) {
      res.json({
        status: 'ready',
        serverListening: true,
        timestamp: new Date().toISOString(),
        checks,
        uptime: process.uptime(),
        port: PORT,
        secretsStatus,
      });
    } else {
      res.status(503).json({
        status: 'not_ready',
        serverListening: true,
        timestamp: new Date().toISOString(),
        checks,
        failedChecks: Object.entries(checks)
          .filter(([_, passed]) => !passed)
          .map(([check]) => check),
        secretsStatus,
      });
    }
  } catch (error) {
    log.error('Health ready check error:', error);
    res.status(503).json({
      status: 'error',
      serverListening: true,
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});
const forceServeStatic = process.argv.includes('--serve-static');
const frontendPath = path.join(__dirname, '..', 'dist');
const hasBuiltFrontend = fs.existsSync(path.join(frontendPath, 'index.html'));

const shouldServeStatic = !isDev || forceServeStatic;

if (shouldServeStatic) {
  log.info('Serving static files from:', frontendPath);
  serveFrontend();
} else if (hasBuiltFrontend) {
  log.info('Dev mode detected built frontend at', frontendPath, '- serving fallback. Start the Vite dev server for HMR.');
  serveFrontend();
}

function serveFrontend() {
  app.use(express.static(frontendPath));

  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'API endpoint not found' });
    }
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  log.error('Express error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

server.listen(PORT, '0.0.0.0', async () => {
  const secretsStatus = await secretManager.getSecretsStatus();

  log.info(`Server running at http://0.0.0.0:${PORT} (and http://localhost:${PORT})`);
  log.info('Authentication enabled with JWT');
  log.info('Rate limiting active for auth endpoints');
  if (secretsStatus?.configPath) {
    log.info(`Secrets loaded from: ${secretsStatus.configPath}`);
  }

  if (secretsStatus?.needsRotation) {
    log.info(`JWT secret is ${secretsStatus.daysSinceRotation} days old - consider rotation`);
  }

  log.info('Server fully initialized and listening on port', PORT);

  if (process.env.ENABLE_MDNS !== 'false') {
    try {
      const instanceName = process.env.SELAH_MDNS_NAME || process.env.LYRICDISPLAY_MDNS_NAME
        || os.hostname().replace(/\.local$/, '') || 'Selah';
      mdnsAdvertiser.advertise({
        name: `Selah (${instanceName})`,
        port: PORT,
        txt: { version: '1', path: '/', api: 'v1' },
      });
    } catch (error) {
      log.warn('mDNS advertising failed (non-critical):', error.message);
    }
  }

  try {
    const restored = await loadPersistedSessionState({ dataRoot });
    if (restored) log.info('Realtime session state restored from disk');
  } catch (error) {
    log.warn('Session state restore failed (non-fatal):', error.message);
  }

  onSessionStateChanged(() => schedulePersistSessionState());

  const flushSessionState = () => {
    try {
      flushSessionStateNow().catch(() => {});
    } catch { }
  };
  process.once('SIGTERM', flushSessionState);
  process.once('SIGINT', flushSessionState);

  if (process.send) {
    process.send({
      status: 'ready',
      port: PORT,
      timestamp: new Date().toISOString(),
      pid: process.pid
    });
  }
}).on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log.error(`Port ${PORT} is already in use. Another instance may be running.`);
    if (process.send) {
      process.send({
        status: 'error',
        error: 'EADDRINUSE',
        port: PORT,
        message: `Port ${PORT} is already in use`
      });
    }
    process.exit(1);
  } else {
    log.error('Server error:', error);
    if (process.send) {
      process.send({
        status: 'error',
        error: error.code || 'UNKNOWN',
        message: error.message
      });
    }
    process.exit(1);
  }
});

const shutdown = () => {
  try {
    mdnsAdvertiser.unadvertise();
  } catch (error) {
    log.warn('mDNS shutdown hook failed (non-critical):', error.message);
  }
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);