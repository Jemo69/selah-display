import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, XCircle, Loader2, RefreshCw, HeartPulse } from 'lucide-react';
import { useControlSocket } from '../context/ControlSocketProvider';
import useLyricsStore from '../context/LyricsStore';
import { getAllOutputs, getOutputSettings } from '../utils/outputs';
import { resolveBackendUrl } from '../utils/network';
import { getControlAuthToken } from '../utils/controlAuth';
import { createLogger } from '../utils/logger.js';
import { Button } from '@/components/ui/button';

const log = createLogger('PreServiceHealth');

const REQUEST_TIMEOUT_MS = 8000;
const SOCKET_ACK_TIMEOUT_MS = 6000;

const CHECK_DEFS = [
  { id: 'routes', label: 'Projector outputs reachable', hint: 'Output 1, Output 2, Stream and Stage pages answer over the network.' },
  { id: 'health', label: 'Server health endpoint', hint: 'The lyric server reports healthy.' },
  { id: 'ready', label: 'Server readiness', hint: 'Secrets, join code and live sync are all ready.' },
  { id: 'socket', label: 'Control connection', hint: 'This panel reaches the server live (round-trip latency).' },
  { id: 'media', label: 'Background pictures and videos', hint: 'Custom backgrounds set on each output still resolve.' },
  { id: 'bible', label: 'Bible lookup route', hint: 'Verse search answers for on-the-fly readings.' },
];

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function fetchOk(url, options = {}) {
  const response = await withTimeout(fetch(url, { cache: 'no-store', ...options }), REQUEST_TIMEOUT_MS, 'Request timed out');
  return response;
}

function initialResults() {
  return CHECK_DEFS.map((def) => ({ ...def, status: 'pending', detail: 'Waiting to run…' }));
}

const PreServiceHealthModal = ({ darkMode }) => {
  const [results, setResults] = useState(initialResults);
  const [running, setRunning] = useState(false);
  const runIdRef = useRef(0);

  let controlSocket = null;
  try {
    controlSocket = useControlSocket();
  } catch {
    controlSocket = null;
  }

  const setResult = useCallback((id, patch) => {
    setResults((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }, []);

  const checkRoutes = useCallback(async () => {
    const paths = ['/output1', '/output2', '/stream', '/stage'];
    const perRoute = [];
    for (const routePath of paths) {
      try {
        const response = await fetchOk(resolveBackendUrl(routePath));
        perRoute.push({ route: routePath, ok: response.ok });
      } catch (err) {
        perRoute.push({ route: routePath, ok: false });
      }
    }
    const failed = perRoute.filter((entry) => !entry.ok);
    return failed.length === 0
      ? { status: 'pass', detail: 'Output 1, Output 2, Stream and Stage all answered.' }
      : { status: 'fail', detail: `No answer: ${failed.map((entry) => entry.route).join(', ')}` };
  }, []);

  const checkHealth = useCallback(async () => {
    try {
      const response = await fetchOk(resolveBackendUrl('/api/health'));
      if (!response.ok) return { status: 'fail', detail: `Health endpoint answered ${response.status}.` };
      const data = await response.json();
      return data?.status === 'healthy'
        ? { status: 'pass', detail: `Server reports healthy (${data?.environment || 'unknown environment'}).` }
        : { status: 'fail', detail: 'Server answered but did not report healthy.' };
    } catch {
      return { status: 'fail', detail: 'Health endpoint did not answer. Is the server running?' };
    }
  }, []);

  const checkReady = useCallback(async () => {
    try {
      const response = await fetchOk(resolveBackendUrl('/api/health/ready'));
      const data = await response.json().catch(() => null);
      if (response.ok && data?.status === 'ready') {
        return { status: 'pass', detail: 'Secrets, join code and live sync are ready.' };
      }
      const failed = Array.isArray(data?.failedChecks) ? data.failedChecks.join(', ') : `HTTP ${response.status}`;
      return { status: 'fail', detail: `Not ready: ${failed}.` };
    } catch {
      return { status: 'fail', detail: 'Readiness probe did not answer.' };
    }
  }, []);

  const checkSocket = useCallback(async () => {
    const socket = controlSocket?.socket;
    if (!socket || typeof socket.emit !== 'function') {
      return { status: 'fail', detail: 'Control panel is not connected to the server.' };
    }
    try {
      const latencyMs = await withTimeout(
        new Promise((resolve, reject) => {
          const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
          const done = () => {
            const endedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
            resolve(Math.round(endedAt - startedAt));
          };
          try {
            if (typeof socket.once === 'function') socket.once('heartbeat_ack', done);
            else if (typeof socket.on === 'function') socket.on('heartbeat_ack', done);
            else { reject(new Error('Socket cannot listen')); return; }
            socket.emit('heartbeat');
          } catch (err) {
            reject(err);
          }
        }),
        SOCKET_ACK_TIMEOUT_MS,
        'No heartbeat answer within 6 seconds',
      );
      return latencyMs <= 3000
        ? { status: 'pass', detail: `Live round trip answered in ${latencyMs} ms.` }
        : { status: 'fail', detail: `Answer took ${latencyMs} ms — slower than the 3 s Sunday limit.` };
    } catch {
      return { status: 'fail', detail: 'Server did not answer the live ping within 6 seconds.' };
    }
  }, [controlSocket]);

  const checkMedia = useCallback(async () => {
    const state = useLyricsStore.getState();
    const outputs = getAllOutputs(state);
    const problems = [];
    let customCount = 0;
    for (const output of outputs) {
      const settings = getOutputSettings(state, output.key);
      const media = settings?.fullScreenBackgroundMedia;
      if (settings?.fullScreenBackgroundType !== 'media' || !media?.url) continue;
      if (media.dataUrl || media.bundled) continue;
      customCount += 1;
      try {
        const response = await fetchOk(resolveBackendUrl(media.url), { method: 'HEAD' });
        if (!response.ok) problems.push(`${output.name} background (${response.status})`);
      } catch {
        problems.push(`${output.name} background (unreachable)`);
      }
    }
    if (problems.length > 0) return { status: 'fail', detail: `Broken: ${problems.join('; ')}.` };
    return {
      status: 'pass',
      detail: customCount === 0 ? 'No custom backgrounds set — solid colours need no check.' : `${customCount} custom background${customCount === 1 ? '' : 's'} resolved.`,
    };
  }, []);

  const checkBible = useCallback(async () => {
    try {
      const token = await getControlAuthToken();
      if (!token) return { status: 'fail', detail: 'No control sign-in found, so the Bible route could not be checked.' };
      const response = await fetchOk(resolveBackendUrl('/api/v1/bible/list'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return { status: 'fail', detail: `Bible route answered ${response.status}.` };
      const data = await response.json().catch(() => null);
      const count = Array.isArray(data?.bibles) ? data.bibles.length : 0;
      return {
        status: 'pass',
        detail: count > 0 ? `${count} Bible${count === 1 ? '' : 's'} loaded (${data.bibles.map((b) => b.name).join(', ')}).` : 'Route answers. No Bible file loaded — readings will show as plain text.',
      };
    } catch {
      return { status: 'fail', detail: 'Bible route did not answer.' };
    }
  }, []);

  const runAllChecks = useCallback(async () => {
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setRunning(true);
    setResults(CHECK_DEFS.map((def) => ({ ...def, status: 'pending', detail: 'Checking…' })));
    log.info('Pre-service health check started');
    const checks = { routes: checkRoutes, health: checkHealth, ready: checkReady, socket: checkSocket, media: checkMedia, bible: checkBible };
    for (const def of CHECK_DEFS) {
      if (runIdRef.current !== runId) return;
      setResult(def.id, { status: 'pending', detail: 'Checking…' });
      try {
        const outcome = await checks[def.id]();
        if (runIdRef.current !== runId) return;
        setResult(def.id, outcome);
      } catch (err) {
        log.warn(`Health check failed: ${def.id}`);
        if (runIdRef.current !== runId) return;
        setResult(def.id, { status: 'fail', detail: 'Check hit an unexpected error.' });
      }
    }
    if (runIdRef.current === runId) {
      setRunning(false);
      log.info('Pre-service health check finished');
    }
  }, [checkRoutes, checkHealth, checkReady, checkSocket, checkMedia, checkBible, setResult]);

  useEffect(() => {
    runAllChecks();
    return () => { runIdRef.current += 1; };
  }, [runAllChecks]);

  const passed = results.filter((row) => row.status === 'pass').length;
  const failed = results.filter((row) => row.status === 'fail').length;
  const allDone = passed + failed === CHECK_DEFS.length;

  return (
    <div className="space-y-4">
      <div
        className={`flex items-start gap-3 rounded-lg border p-4 ${allDone && failed === 0
          ? darkMode ? 'border-green-700/40 bg-green-900/20' : 'border-green-200 bg-green-50'
          : darkMode ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-gray-50'
          }`}
        aria-live="polite"
      >
        <HeartPulse className={`h-6 w-6 shrink-0 ${darkMode ? 'text-emerald-300' : 'text-emerald-600'}`} aria-hidden="true" />
        <div className="flex-1">
          <h3 className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            {running ? 'Running pre-service checks…' : allDone && failed === 0 ? 'Ready for service' : allDone ? 'Needs attention before service' : 'Pre-service health check'}
          </h3>
          <p className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
            {passed} of {CHECK_DEFS.length} checks passing{failed > 0 ? `, ${failed} failing` : ''}. Run this before the band walks on stage.
          </p>
        </div>
        <Button
          type="button"
          onClick={runAllChecks}
          disabled={running}
          className="shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2"
        >
          <RefreshCw className={`h-4 w-4 ${running ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" />
          Re-run
        </Button>
      </div>

      <ul className="space-y-2" aria-label="Pre-service check results">
        {results.map((row) => (
          <li
            key={row.id}
            className={`flex items-start gap-3 rounded-lg border p-3 ${darkMode ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'}`}
          >
            {row.status === 'pass' ? (
              <CheckCircle2 className={`h-5 w-5 shrink-0 ${darkMode ? 'text-green-400' : 'text-green-600'}`} aria-hidden="true" />
            ) : row.status === 'fail' ? (
              <XCircle className={`h-5 w-5 shrink-0 ${darkMode ? 'text-red-400' : 'text-red-600'}`} aria-hidden="true" />
            ) : (
              <Loader2 className={`h-5 w-5 shrink-0 motion-safe:animate-spin ${darkMode ? 'text-gray-400' : 'text-gray-500'}`} aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              <p className={`flex flex-wrap items-center gap-x-2 text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                {row.label}
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${row.status === 'pass'
                    ? darkMode ? 'bg-green-500/15 text-green-300' : 'bg-green-100 text-green-800'
                    : row.status === 'fail'
                      ? darkMode ? 'bg-red-500/15 text-red-300' : 'bg-red-100 text-red-800'
                      : darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600'
                    }`}
                >
                  {row.status === 'pass' ? 'Pass' : row.status === 'fail' ? 'Fail' : 'Checking'}
                </span>
              </p>
              <p className={`mt-0.5 text-xs ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>{row.hint}</p>
              <p className={`mt-1 text-sm ${darkMode ? 'text-gray-200' : 'text-gray-700'}`}>{row.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default PreServiceHealthModal;
