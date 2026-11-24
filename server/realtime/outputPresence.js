// server/realtime/outputPresence.js
//
// Heartbeat registry for live output instances (feature #03: pre-service
// health + connected outputs strip).
//
// Output pages (Output 1, Output 2, Stage, custom outputs) register here when
// their socket connects, declaring a clientType plus a purpose (the output
// key they render, e.g. `output1` or `custom_lobby`). Entries expire when the
// socket disconnects or goes stale without a heartbeat touch.
//
// The module is intentionally free of socket.io imports so the registry logic
// stays unit-testable; wiring lives in `server/events.js`.
import createServerLogger from '../logger.js';

const log = createServerLogger('OutputPresence');

/** Client types that count as output instances by default. */
export const OUTPUT_CLIENT_TYPES = new Set(['output1', 'output2', 'stream', 'stage']);

/** Accepted purpose values: built-in output keys or custom_* output ids. */
const PURPOSE_PATTERN = /^(output[12]|stream|stage|custom_[a-z0-9_-]+)$/i;

/**
 * Normalize a declared purpose to a canonical output key.
 * An invalid declared purpose falls back to `fallback` (typically the
 * authenticated client type); returns null when neither is a valid key.
 */
export function normalizeOutputPurpose(purpose, fallback = null) {
  for (const candidate of [purpose, fallback]) {
    const normalized = String(candidate ?? '').trim().toLowerCase();
    if (PURPOSE_PATTERN.test(normalized)) return normalized;
  }
  return null;
}

export function createOutputPresenceRegistry({ now = () => Date.now(), ttlMs = 90000 } = {}) {
  // socketId -> { id, outputKey, clientType, deviceId, sessionId, connectedAt, lastSeenAt }
  const entries = new Map();

  const sweepStale = () => {
    const timestamp = now();
    for (const [socketId, entry] of entries) {
      if (timestamp - entry.lastSeenAt > ttlMs) {
        entries.delete(socketId);
        log.debug(`Expired stale output presence: ${entry.outputKey} (${socketId})`);
      }
    }
  };

  const registry = {
    register({ socketId, clientType, purpose, deviceId = '', sessionId = '' } = {}) {
      if (!socketId) return null;
      const outputKey = normalizeOutputPurpose(
        purpose,
        OUTPUT_CLIENT_TYPES.has(clientType) ? clientType : null,
      );
      if (!outputKey) return null;
      const timestamp = now();
      const existing = entries.get(socketId);
      const entry = {
        id: socketId,
        outputKey,
        clientType: clientType || '',
        deviceId: deviceId || '',
        sessionId: sessionId || '',
        connectedAt: existing?.connectedAt ?? timestamp,
        lastSeenAt: timestamp,
      };
      entries.set(socketId, entry);
      return { ...entry };
    },

    /** Refresh the heartbeat timestamp for a live socket. No-op when unknown. */
    touch(socketId) {
      const entry = entries.get(socketId);
      if (!entry) return null;
      entry.lastSeenAt = now();
      return { ...entry };
    },

    /** Refine the declared purpose (e.g. a custom output key) for a live socket. */
    refine(socketId, purpose) {
      const entry = entries.get(socketId);
      if (!entry) return null;
      const outputKey = normalizeOutputPurpose(purpose);
      if (!outputKey) return null;
      entry.outputKey = outputKey;
      entry.lastSeenAt = now();
      return { ...entry };
    },

    /** Remove an entry on socket disconnect. Returns the removed entry or null. */
    remove(socketId) {
      const entry = entries.get(socketId);
      if (!entry) return null;
      entries.delete(socketId);
      return { ...entry };
    },

    clear() {
      entries.clear();
    },

    size() {
      sweepStale();
      return entries.size;
    },

    list() {
      sweepStale();
      return [...entries.values()].map((entry) => ({ ...entry }));
    },

    snapshot() {
      return { presence: registry.list(), timestamp: now() };
    },
  };

  return registry;
}

/** Process-wide singleton used by the socket layer. */
export const outputPresence = createOutputPresenceRegistry();

export function getOutputPresenceSnapshot() {
  return outputPresence.snapshot();
}
