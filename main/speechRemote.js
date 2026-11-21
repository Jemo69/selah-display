/**
 * main/speechRemote.js — the trusted-LAN remote-engine client.
 *
 * ONE job: prove that a configured speech engine on another machine is the
 * v1 engine we can talk to, and hand main/speechIpc.js the dial-in block the
 * renderer needs. It NEVER forks a local engine, NEVER opens the WebSocket
 * (that is the renderer's transport), and NEVER logs or returns the token.
 *
 * SECURITY: the engine is exposed over plain HTTP/ws:// on a trusted LAN.
 * The token gates every request; it is NOT encryption. Raw PCM audio leaves
 * this machine once the renderer dials the returned endpoint. Requiring an
 * explicit `where === 'network'` plus an explicit endpoint and token is the
 * whole consent boundary — there is no silent fallback to a local engine.
 *
 * Dependency-free on purpose: node:fetch is injected in tests, so the remote
 * contract is unit-testable with a fake health responder and no real LAN.
 */
import { checkApiCompatibility, TOKEN_HEADER } from '../shared/speech/protocol.js';

/** Bounded health-check wait. A hung LAN engine must not hang speech:start. */
export const REMOTE_HEALTH_TIMEOUT_MS = 5000;

const failure = (code, message) => ({ ok: false, code, message });

/**
 * Validate the configured engine origin. Only http(s) URLs with no embedded
 * credentials, no path/query/fragment, and a usable host are accepted.
 * LAN hosts ARE accepted here — the explicit `where: 'network'` choice in the
 * start payload is the operator's opt-in; the UI warns about trusted LAN/no
 * TLS before the endpoint can be entered.
 *
 * @param {unknown} value
 * @returns {{ok:true, endpoint:string, loopback:boolean}|
 *           {ok:false, code:string, message:string}}
 */
export function validateNetworkEndpoint(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return failure(
      'network-endpoint-missing',
      'Enter the remote speech engine URL (for example http://192.168.1.20:4731) in Settings before starting Network Device.'
    );
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return failure(
      'network-endpoint-invalid',
      'The remote engine endpoint must be a full http(s) URL, such as http://192.168.1.20:4731.'
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return failure(
      'network-endpoint-invalid',
      'The remote engine endpoint must use http or https (not ' + url.protocol + ').'
    );
  }
  if (url.username || url.password) {
    return failure(
      'network-endpoint-credentials',
      'Remove the username/password from the remote engine URL. Use the token field instead.'
    );
  }
  if (!url.hostname || url.hostname === '0.0.0.0' || url.hostname === '[::]') { // bind-scan-exempt: client-side rejection, never a bind target
    return failure(
      'network-endpoint-invalid',
      'The remote engine URL needs a real hostname or IP address, not a wildcard bind address.'
    );
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    return failure(
      'network-endpoint-invalid',
      'Use only the engine origin (for example http://192.168.1.20:4731), with no path or query string.'
    );
  }

  return {
    ok: true,
    endpoint: `${url.protocol}//${url.host}`,
    loopback: /^(localhost|::1|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.test(url.hostname),
  };
}

/**
 * The token is a session secret typed into Settings. Never persisted, never
 * logged; only sent as x-ld-speech-token and as the WebSocket query param.
 */
export function validateNetworkToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token) {
    return failure(
      'network-token-missing',
      'Enter the remote engine launch token in Settings. Network Device refuses to start without it.'
    );
  }
  if (token.length < 16 || token.length > 256) {
    return failure(
      'network-token-invalid',
      'The remote engine token must be between 16 and 256 characters.'
    );
  }
  return { ok: true, token };
}

/** Never echo the body of an error response: it may carry request details. */
function healthError(status) {
  if (status === 401 || status === 403) {
    return failure(
      'network-unauthorized',
      'The remote engine rejected the token. Check the launch token on the engine machine.'
    );
  }
  if (status === 404) {
    return failure(
      'network-incompatible',
      'The remote engine has no /v1/health route. This app needs the v1 speech-engine protocol.'
    );
  }
  return failure(
    'network-health-failed',
    `The remote engine answered HTTP ${status} to its health check.`
  );
}

/**
 * GET <endpoint>/v1/health with the token. Returns a renderer-shaped health
 * payload on success (with `remote: true` so the label cannot claim a remote
 * engine without evidence), and a clear machine code on every refusal.
 *
 * @param {{endpoint:string, token:string, timeoutMs?:number,
 *          fetchImpl?:typeof fetch}} options
 */
export async function probeRemoteEngine({
  endpoint,
  token,
  timeoutMs = REMOTE_HEALTH_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return failure(
      'network-fetch-unavailable',
      'This build cannot make the remote engine health check (fetch is unavailable).'
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || REMOTE_HEALTH_TIMEOUT_MS));
  try {
    const response = await fetchImpl(`${endpoint.replace(/\/+$/, '')}/v1/health`, {
      method: 'GET',
      headers: { [TOKEN_HEADER]: token, accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response?.ok) return healthError(response?.status ?? 0);

    let raw;
    try {
      raw = await response.json();
    } catch {
      return failure('network-invalid-response', 'The remote engine health response was not JSON.');
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return failure('network-invalid-response', 'The remote engine health response was not an object.');
    }
    const version = checkApiCompatibility(raw.apiVersion);
    if (!version.ok) {
      return failure(
        'network-api-incompatible',
        `The remote engine speaks a different speech protocol (${version.level}). Update both machines together.`
      );
    }

    const numberOrNull = (value) =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;
    return {
      ok: true,
      code: 'ok',
      health: {
        status: 'ok',
        remote: true,
        apiVersion: raw.apiVersion,
        model: typeof raw.model === 'string' ? raw.model : null,
        backend: typeof raw.backend === 'string' ? raw.backend : 'unknown',
        rtf: numberOrNull(raw.rtf),
        memoryMb: numberOrNull(raw.memoryMb),
        pid: numberOrNull(raw.pid),
        uptimeMs: numberOrNull(raw.uptimeMs),
      },
      warning: version.level === 'minor-mismatch' ? version.reason : null,
    };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      return failure(
        'network-unreachable',
        'The remote engine did not answer its health check in time. Check that it is running and reachable.'
      );
    }
    return failure(
      'network-unreachable',
      'The remote engine could not be reached. Check the address, the trusted LAN, and the engine process.'
    );
  } finally {
    clearTimeout(timer);
  }
}
