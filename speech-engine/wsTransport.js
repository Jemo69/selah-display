/**
 * speech-engine/wsTransport.js — the renderer <-> engine WebSocket ingest.
 *
 * Plan section 3: "a raw ws://127.0.0.1 WebSocket to the engine ... both are
 * zero-dependency in the renderer — Chromium ships native WebSocket ... Inventing
 * a third transport would be pure cost." Node ships a WebSocket CLIENT
 * (globalThis.WebSocket) but no SERVER, and this package must stay at zero
 * dependencies (`package.json` `dependencies` is `{}` on purpose), so the
 * minimal RFC 6455 server surface is hand-rolled here:
 *
 *   IMPLEMENTED
 *     - the `101 Switching Protocols` handshake
 *       (`Sec-WebSocket-Accept` = base64(sha1(key + GUID)))
 *     - client frames: unmasking (clients MUST mask), the 7 / 16 / 64-bit
 *       length forms, binary opcode (0x2) payload delivery
 *     - control frames: close (0x8, echoed), ping (0x9 -> pong 0xA)
 *     - protocol-error close codes 1002 (malformed) / 1003 (wrong data) /
 *       1009 (message too big), and a clean teardown on socket end
 *
 *   DELIBERATELY SKIPPED (nothing in the contract needs them)
 *     - fragmentation: the upstream contract is one binary frame = one
 *       3200-byte PCM frame, back to back, never fragmented -> FIN=0 data is
 *       refused with a close frame instead of reassembled
 *     - permessage-deflate / any extension: no `Sec-WebSocket-Extensions` is
 *       ever offered, and RSV bits are refused (close 1002)
 *     - subprotocols, continuation frames, mask rotation tricks
 *
 * SECURITY (all three enforced here, not by convention):
 *   1. Loopback only. `attachWebSocketTransport` refuses a non-loopback
 *      BIND host through the same `isLoopbackHost` gate server.js uses, and
 *      additionally refuses any peer whose address is not loopback.
 *   2. Origin. An upgrade carrying an `Origin` outside `ALLOWED_ORIGINS` is
 *      refused with 403 before the handshake completes. No Origin (a
 *      non-browser client) is allowed — the token still gates it.
 *   3. Token. Plan 7.1: "requires it as an `x-ld-speech-token` header on REST
 *      and a query parameter on the WebSocket upgrade" — the token travels as
 *      `?token=<secret>` on the upgrade URL and is checked (timing-safe)
 *      BEFORE the 101 is written and before any frame is read.
 *   Rejection responses are a bare status + JSON error code: the request line
 *   and query string are never echoed, because the token lives there. The
 *   token is never logged anywhere in this package.
 *
 * DATA FLOW (bus.js stays the single emission point — see its header):
 *   inbound   socket bytes -> unmask -> ingest() -> engine.transcribe()
 *             (endpointing below decides WHEN; the engine decides WHAT)
 *   outbound  every message the engine or this transport produces is
 *             `bus.emit(...)`-ed -> bus subscribers = [parent-process mirror
 *             (index.js), every connected WebSocket, anything else]. When the
 *             engine is forked, the mirror's `process.send` means main gets
 *             the exact messages the WebSocket clients see.
 *
 * ENDPOINTING (transport-local, so the canned engine behaves like a live
 * one): frames accumulate into one open segment; the segment is handed to
 * `engine.transcribe()` when silence reaches `SILENCE_FINALIZE_MS`, when the
 * segment reaches `HARD_SEGMENT_CAP_MS`, or when the connection closes (the
 * tail is finalized so the transcript log keeps the last words). The `vad`
 * message type reports speech/silence transitions. RMS is computed ONLY here,
 * ONLY as a number in memory — it is never logged, and neither are samples,
 * audio bytes, or transcript text (messages travel on the wire, not the log).
 */
import crypto from 'node:crypto';
import {
  ALLOWED_ORIGINS,
  isAllowedOrigin,
  FRAME_MS,
  SILENCE_FINALIZE_MS,
  HARD_SEGMENT_CAP_MS,
  isLoopbackHost,
} from '../shared/speech/protocol.js';
import { tokenMatches, assertLoopbackBindHost } from './server.js';

/** Upgrade path for the audio stream. Mirrored by the renderer client. */
export const WS_PATH = '/v1/stream';

/** Query parameter carrying the per-launch token on the upgrade (plan 7.1). */
export const WS_TOKEN_PARAM = 'token';

/** RFC 6455 magic GUID, for `Sec-WebSocket-Accept` = base64(sha1(key+GUID)). */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Largest accepted payload, before unmasking (one PCM frame is 3200 bytes). */
const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * After a close frame is written, how long a peer that never finishes the
 * closing handshake may hold the socket before it is destroyed anyway.
 * unref()'d — it never keeps a process (or `node --test`) alive.
 */
const CLOSE_HANDSHAKE_DRAIN_MS = 500;

/**
 * RMS (0..1 of full scale) at or above which a frame counts as speech. A
 * transport-side heuristic for the canned engine's benefit — deliberately NOT
 * a protocol constant (shared/speech/protocol.js owns the wire numbers).
 */
const VAD_RMS_FLOOR = 0.01;

const OPCODE = Object.freeze({ CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa });
const CLOSE_CODE = Object.freeze({ NORMAL: 1000, GOING_AWAY: 1001, PROTOCOL: 1002, UNSUPPORTED: 1003, TOO_BIG: 1009 });

/**
 * Is `address` a loopback peer? Tolerates IPv4-mapped spellings
 * (`::ffff:127.0.0.1`) before delegating to the protocol's own gate.
 *
 * @param {unknown} address
 * @returns {boolean}
 */
export function isLoopbackPeer(address) {
  if (typeof address !== 'string') return false;
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return isLoopbackHost(normalized);
}

/**
 * Encode ONE server->client frame (servers never mask). Text frames carry
 * UTF-8 JSON downstream messages; close/ping/pong carry their small payloads.
 *
 * @param {number} opcode
 * @param {Buffer} [payload]
 * @returns {Buffer}
 */
export function encodeServerFrame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

/**
 * Unmask ONE client frame payload in place (RFC 6455 5.3): byte[i] ^= key[i
 * & 3]. Exported so the test can assert on known bytes directly.
 *
 * @param {Buffer} payload mutated in place
 * @param {Buffer} mask 4 bytes
 * @returns {Buffer} the same buffer
 */
export function unmaskPayload(payload, mask) {
  for (let i = 0; i < payload.length; i += 1) {
    payload[i] ^= mask[i & 3];
  }
  return payload;
}

/** Timing-safe reject: status + error code, never the URL or query string. */
function rejectUpgrade(socket, status, code) {
  if (socket.destroyed || socket.writableEnded) return;
  const body = JSON.stringify({ error: code });
  socket.end(
    `HTTP/1.1 ${status} ${code}\r\n` +
      'content-type: application/json; charset=utf-8\r\n' +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      'connection: close\r\n' +
      '\r\n' +
      body
  );
  // A rejected peer that never finishes closing the connection must
  // not hold the socket open. unref()'d, so it can never keep a
  // process (or `node --test`) alive.
  const drain = setTimeout(() => {
    if (!socket.destroyed) socket.destroy();
  }, CLOSE_HANDSHAKE_DRAIN_MS);
  drain.unref?.();
}

/** RMS of an Int16-LE payload, normalized to 0..1. Never logged. */
function rmsOf(payload) {
  const samples = payload.length >> 1;
  if (samples === 0) return 0;
  let sum = 0;
  for (let offset = 0; offset + 1 < payload.length; offset += 2) {
    const value = payload.readInt16LE(offset) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

/**
 * Attach the WebSocket upgrade surface to an ALREADY BOUND engine server
 * (same host, same port as the REST surface — one engine, one socket).
 *
 * @param {import('node:http').Server} server the engine's http server
 * @param {Object} options
 * @param {string} options.token per-launch secret required as `?token=`
 * @param {{emit:Function, subscribe:Function}} options.bus single emission point
 * @param {object} options.engine engine implementation (fake today)
 * @param {readonly string[]} [options.allowedOrigins=ALLOWED_ORIGINS]
 * @param {string} [options.path=WS_PATH] upgrade path
 * @returns {{path: string, connectionCount: () => number, close: () => void}}
 * @throws {Error} when the token/bus/engine are missing or the BIND host
 *   option (if given) is not loopback — same chokepoint as server.js.
 */
export function attachWebSocketTransport(server, options = {}) {
  const {
    token,
    bus,
    engine,
    allowedOrigins = ALLOWED_ORIGINS,
    path = WS_PATH,
    host = null,
  } = options;

  if (!server || typeof server.on !== 'function') {
    throw new Error('speech-engine: attachWebSocketTransport requires an http server');
  }
  if (typeof token !== 'string' || token.length < 16) {
    throw new Error('speech-engine: a token of at least 16 characters is required on the WebSocket upgrade');
  }
  if (!bus || typeof bus.emit !== 'function' || typeof bus.subscribe !== 'function') {
    throw new Error('speech-engine: attachWebSocketTransport requires a message bus');
  }
  if (!engine || typeof engine.transcribe !== 'function') {
    throw new Error('speech-engine: attachWebSocketTransport requires an engine');
  }
  // Loopback-only chokepoint for this surface too (defense in depth: server.js
  // already refuses a non-loopback bind, and a caller may pass `host` here).
  if (host !== null) assertLoopbackBindHost(host);

  /** Live connections, so close() can tear every one down. */
  const connections = new Set();

  const onUpgrade = (req, socket, head) => {
    handleUpgrade(req, socket, head);
  };

  function handleUpgrade(req, socket, head) {
    // 1. Method / handshake prerequisites (RFC 6455 4.2.1).
    if (req.method !== 'GET') {
      rejectUpgrade(socket, 405, 'method-not-allowed');
      return;
    }
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      rejectUpgrade(socket, 400, 'not-a-websocket-upgrade');
      return;
    }
    if (String(req.headers['sec-websocket-version'] || '') !== '13') {
      rejectUpgrade(socket, 400, 'unsupported-websocket-version');
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || key.length === 0) {
      rejectUpgrade(socket, 400, 'missing-websocket-key');
      return;
    }

    // 2. Origin gate — an Origin that is not ours never reaches the token check.
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin, allowedOrigins)) {
      rejectUpgrade(socket, 403, 'origin-not-allowed');
      return;
    }

    // 3. Loopback peer gate: engine traffic never arrives from the LAN.
    if (!isLoopbackPeer(req.socket.remoteAddress)) {
      rejectUpgrade(socket, 403, 'non-loopback-peer');
      return;
    }

    // 4. Path gate.
    let pathname = req.url || '/';
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      rejectUpgrade(socket, 400, 'bad-request-target');
      return;
    }
    if (pathname !== path) {
      rejectUpgrade(socket, 404, 'not-found');
      return;
    }

    // 5. Token gate (plan 7.1: a QUERY PARAMETER on the upgrade), before the
    //    101, before any frame is read. Timing-safe compare.
    let provided = null;
    try {
      provided = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get(WS_TOKEN_PARAM);
    } catch {
      provided = null;
    }
    if (provided === null || provided === '') {
      rejectUpgrade(socket, 401, 'missing-token');
      return;
    }
    if (!tokenMatches(provided, token)) {
      rejectUpgrade(socket, 403, 'invalid-token');
      return;
    }

    // 6. Accept the upgrade.
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'upgrade: websocket\r\n' +
        'connection: Upgrade\r\n' +
        `sec-websocket-accept: ${accept}\r\n` +
        '\r\n'
    );
    socket.setNoDelay?.(true);
    openConnection(socket, head);
  }

  function openConnection(socket, head) {
    /** Per-connection state: one engine session + one open segment. */
    const connection = {
      socket,
      sessionId: null,
      closed: false,
      closing: false,
      handlers: null,
      unsubscribe: null,
      pending: Buffer.alloc(0),
      segment: [],
      segmentMs: 0,
      silenceMs: 0,
      vad: null,
      framesIn: 0,
      bytesIn: 0,
    };
    connections.add(connection);

    // Outbound: this connection is a BUS SUBSCRIBER — the seam bus.js
    // documents. Nothing is written to a socket without going through the bus.
    connection.unsubscribe = bus.subscribe((message) => {
      if (connection.closed || socket.destroyed) return;
      socket.write(encodeServerFrame(OPCODE.TEXT, Buffer.from(JSON.stringify(message), 'utf8')));
    });

    // One engine session per connection; `ready` rides out on the bus like
    // every other downstream message.
    if (typeof engine.createSession === 'function') {
      try {
        const created = engine.createSession({});
        connection.sessionId = created.session.sessionId;
        for (const message of created.messages) bus.emit(message);
      } catch {
        connection.sessionId = null;
      }
    }

    /** Hand the open segment to the engine; engine output rides the bus. */
    connection.finalize = (reason) => {
      if (connection.segment.length === 0) return;
      const frames = connection.segment;
      connection.segment = [];
      connection.segmentMs = 0;
      connection.silenceMs = 0;
      try {
        const body = connection.sessionId ? { sessionId: connection.sessionId, frames } : { frames };
        const result = engine.transcribe(body);
        if (result && typeof result.then === 'function') {
          result.then((resolved) => {
            for (const message of resolved?.messages || []) bus.emit(message);
          }).catch((error) => {
            bus.emit({
              t: 'error',
              code: 'engine-ingest-failed',
              message: `speech-engine could not consume the buffered segment (${reason}: ${error?.code || 'error'})`,
              fatal: false,
            });
          });
        } else {
          for (const message of result?.messages || []) bus.emit(message);
        }
      } catch (error) {
        // Code only — the failure message may not carry audio or text.
        bus.emit({
          t: 'error',
          code: 'engine-ingest-failed',
          message: `speech-engine could not consume the buffered segment (${reason}: ${error?.code || 'error'})`,
          fatal: false,
        });
      }
    };

    /** Route ONE inbound binary frame into the engine's endpointing logic. */
    const ingest = (payload) => {
      connection.framesIn += 1;
      connection.bytesIn += payload.length;
      connection.segment.push(payload);
      connection.segmentMs += FRAME_MS;

      const state = rmsOf(payload) >= VAD_RMS_FLOOR ? 'speech' : 'silence';
      if (connection.vad !== state) {
        connection.vad = state;
        if (connection.sessionId) bus.emit({ t: 'vad', sessionId: connection.sessionId, state });
      }
      if (state === 'silence') connection.silenceMs += FRAME_MS;
      else connection.silenceMs = 0;

      if (connection.silenceMs >= SILENCE_FINALIZE_MS || connection.segmentMs >= HARD_SEGMENT_CAP_MS) {
        connection.finalize('endpoint');
      }
    };

    /** Handle ONE fully unmasked frame. */
    const onFrame = (fin, opcode, payload) => {
      if (connection.closed) return;
      switch (opcode) {
        case OPCODE.CLOSE:
          closeConnection(connection, CLOSE_CODE.NORMAL, payload);
          return;
        case OPCODE.PING:
          if (!socket.destroyed) socket.write(encodeServerFrame(OPCODE.PONG, payload));
          return;
        case OPCODE.PONG:
          return;
        case OPCODE.BINARY:
          if (!fin) {
            closeConnection(connection, CLOSE_CODE.UNSUPPORTED, null, 'fragmentation-not-supported');
            return;
          }
          ingest(payload);
          return;
        case OPCODE.TEXT:
          closeConnection(connection, CLOSE_CODE.UNSUPPORTED, null, 'binary-frames-only');
          return;
        case OPCODE.CONTINUATION:
          closeConnection(connection, CLOSE_CODE.PROTOCOL, null, 'fragmentation-not-supported');
          return;
        default:
          closeConnection(connection, CLOSE_CODE.PROTOCOL, null, 'unknown-opcode');
      }
    };

    /** Incremental parser: consume as many complete frames as are buffered. */
    const drain = () => {
      while (!connection.closed) {
        const buffer = connection.pending;
        if (buffer.length < 2) return;

        const b0 = buffer[0];
        const b1 = buffer[1];
        const fin = (b0 & 0x80) !== 0;
        const rsv = b0 & 0x70;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let length = b1 & 0x7f;
        let offset = 2;

        if (rsv !== 0) {
          closeConnection(connection, CLOSE_CODE.PROTOCOL, null, 'no-extensions-negotiated');
          return;
        }
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const big = buffer.readBigUInt64BE(2);
          if (big > BigInt(MAX_PAYLOAD_BYTES)) {
            closeConnection(connection, CLOSE_CODE.TOO_BIG, null, 'payload-too-large');
            return;
          }
          length = Number(big);
          offset = 10;
        }
        // RFC 6455 5.1: client frames MUST be masked.
        if (!masked) {
          closeConnection(connection, CLOSE_CODE.PROTOCOL, null, 'client-frames-must-be-masked');
          return;
        }
        if (length > MAX_PAYLOAD_BYTES) {
          closeConnection(connection, CLOSE_CODE.TOO_BIG, null, 'payload-too-large');
          return;
        }
        if (buffer.length < offset + 4 + length) return; // wait for more bytes

        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        unmaskPayload(payload, mask);
        connection.pending = buffer.subarray(offset + 4 + length);
        onFrame(fin, opcode, payload);
      }
    };

    const onData = (chunk) => {
      if (connection.closed) return;
      connection.pending = connection.pending.length
        ? Buffer.concat([connection.pending, chunk])
        : chunk;
      // Hard backstop: a peer that never completes a frame cannot buffer forever.
      if (connection.pending.length > MAX_PAYLOAD_BYTES + 16) {
        closeConnection(connection, CLOSE_CODE.TOO_BIG, null, 'payload-too-large');
        return;
      }
      drain();
    };

    const onEnd = () => closeConnection(connection, CLOSE_CODE.NORMAL, null, 'peer-closed');
    const onError = () => closeConnection(connection, CLOSE_CODE.GOING_AWAY, null, 'socket-error');
    const onClose = () => closeConnection(connection, CLOSE_CODE.NORMAL, null, 'socket-closed');

    // Kept on the connection so closeConnection can remove exactly these —
    // "no dangling listeners" is a teardown guarantee, not a hope.
    connection.handlers = { onData, onEnd, onError, onClose };

    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('error', onError);
    socket.on('close', onClose);
    if (head && head.length > 0) onData(head);
  }

  function closeConnection(connection, code, payload = null, reason = 'closed') {
    if (connection.closed || connection.closing) return;
    connection.closing = true;

    // Finalize FIRST — while `closed` is still false — so this connection's
    // own bus subscriber can still write the tail of a sentence that ended as
    // the operator pressed stop; the close frame follows those frames on the
    // wire. `closing` is the re-entrancy guard for that window.
    try {
      connection.finalize?.(reason);
    } catch {
      // A broken engine must not keep the socket alive.
    }
    connection.closed = true;

    try {
      connection.unsubscribe?.();
    } catch {
      // best effort
    }
    connection.unsubscribe = null;

    if (
      connection.sessionId &&
      typeof engine.closeSession === 'function'
    ) {
      try {
        engine.closeSession(connection.sessionId);
      } catch {
        // session already gone
      }
    }

    const socket = connection.socket;
    // Remove exactly the handlers this connection registered: a torn-down
    // connection leaves no listener behind holding the closure alive.
    const handlers = connection.handlers;
    connection.handlers = null;
    if (handlers && typeof socket.removeListener === 'function') {
      socket.removeListener('data', handlers.onData);
      socket.removeListener('end', handlers.onEnd);
      socket.removeListener('error', handlers.onError);
      socket.removeListener('close', handlers.onClose);
    }

    if (!socket.destroyed && !socket.writableEnded) {
      try {
        // The teardown owns the socket now and its handlers were
        // just removed — a write to a peer that already reset
        // would otherwise surface as an uncaught 'error' event.
        // One swallow-all listener covers the final close frame.
        socket.once('error', () => { /* peer gone — teardown already ran */ });
        const body = Buffer.alloc(2);
        body.writeUInt16BE(code, 0);
        socket.write(encodeServerFrame(OPCODE.CLOSE, body));
        socket.end();
        // Backstop: a peer that never finishes the closing handshake must not
        // hold the socket open. unref()'d, so it can never keep a test alive.
        const drain = setTimeout(() => {
          if (!socket.destroyed) socket.destroy();
        }, CLOSE_HANDSHAKE_DRAIN_MS);
        drain.unref?.();
      } catch {
        // socket already tearing down
      }
    }
    connections.delete(connection);
    // `reason` is a machine token for diagnostics — never audio, never text.
    void reason;
    void payload;
  }

  server.on('upgrade', onUpgrade);

  return {
    path,
    connectionCount: () => connections.size,
    /** Detach the upgrade listener and tear down every live connection. */
    close() {
      server.removeListener('upgrade', onUpgrade);
      for (const connection of [...connections]) {
        try {
          closeConnection(connection, CLOSE_CODE.GOING_AWAY, null, 'server-shutdown');
        } catch {
          // best effort
        }
      }
    },
  };
}
