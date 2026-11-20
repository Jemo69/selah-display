/**
 * SpeechTuningDataCard — make the local tuning dataset discoverable.
 *
 * The transcript history already stores one JSON file per service. That file
 * now also carries detection and operator-action events (lane, reference,
 * detector, confidence, send/stage/dismiss), which is exactly what is needed
 * to tune the feature against real services later.
 *
 * This card does not collect anything on its own: it reads the existing
 * history summaries and asks the existing history exporter for a JSON file.
 * Local only. Nothing is uploaded, and the file path is shown so the operator
 * can copy it to a USB drive or a research folder deliberately.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Download, Database, RefreshCw } from 'lucide-react';

const bridge = () =>
  typeof window === 'undefined' ? null : window.electronAPI?.speech?.history ?? null;

const formatBytes = (bytes) => {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
};

const SpeechTuningDataCard = ({ darkMode = true, cardClass, titleClass }) => {
  const [sessions, setSessions] = useState([]);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    const api = bridge();
    if (!api || typeof api.list !== 'function') return;
    try {
      const reply = await api.list();
      if (reply?.ok === false) {
        setError(reply.message ?? 'Tuning data is unavailable.');
        return;
      }
      setSessions(Array.isArray(reply?.sessions) ? reply.sessions : []);
      setStatus(reply?.status ?? null);
      setError(null);
    } catch {
      setError('Tuning data could not be read.');
    }
  }, []);

  useEffect(() => {
    setResult(null);
    refresh();
  }, [refresh]);

  const exportData = useCallback(async () => {
    const api = bridge();
    if (!api || typeof api.export !== 'function') return;
    setBusy(true);
    setError(null);
    try {
      const reply = await api.export({ format: 'json' });
      if (!reply?.ok) {
        setError(reply?.message ?? 'The tuning export could not be written.');
        return;
      }
      setResult({ path: reply.path, bytes: reply.bytes, sessions: reply.sessionCount });
    } catch {
      setError('The tuning export could not be written.');
    } finally {
      setBusy(false);
    }
  }, []);

  const eventCount = sessions.reduce((sum, session) => sum + (Number(session.eventCount) || 0), 0);
  const card = cardClass ?? 'rounded-xl border p-5 space-y-4';
  const title = titleClass ?? 'text-[11px] font-bold uppercase tracking-wider';
  const muted = darkMode ? 'text-gray-400' : 'text-gray-500';
  const border = darkMode ? 'border-gray-800' : 'border-gray-200';

  return (
    <section aria-label="Speech tuning data" className={card} data-testid="speech-tuning-data">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className={title}>Local tuning data</h3>
          <p className={`mt-1 text-xs leading-relaxed ${muted}`}>
            Transcript history now includes detection and action events: lane, reference,
            detector, confidence, and send / stage / dismiss. Export the JSON when you want to
            review a real service or tune the detector later.
          </p>
        </div>
        <button
          type="button"
          data-testid="speech-tuning-refresh"
          onClick={refresh}
          disabled={busy}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold disabled:opacity-50 ${
            darkMode ? 'border-gray-700 bg-gray-900 text-gray-200' : 'border-gray-300 bg-white text-gray-700'
          }`}
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>

      <div className={`grid grid-cols-2 gap-2 rounded-lg border p-3 text-xs ${border}`}>
        <div>
          <p className={`text-[10px] uppercase tracking-wider ${muted}`}>Sessions</p>
          <p className="font-mono text-sm" data-testid="speech-tuning-sessions">{sessions.length}</p>
        </div>
        <div>
          <p className={`text-[10px] uppercase tracking-wider ${muted}`}>Detection/action events</p>
          <p className="font-mono text-sm" data-testid="speech-tuning-events">{eventCount}</p>
        </div>
      </div>

      {status?.recording === false ? (
        <p className="text-xs text-amber-400" data-testid="speech-tuning-cap">
          Recording stopped: the local history cap was reached. Erase old sessions to resume.
        </p>
      ) : null}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          data-testid="speech-tuning-export"
          onClick={exportData}
          disabled={busy || sessions.length === 0}
          className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${
            darkMode
              ? 'border-blue-500/40 bg-blue-500/10 text-blue-300'
              : 'border-blue-300 bg-blue-50 text-blue-700'
          }`}
        >
          <Download className="h-3.5 w-3.5" />
          {busy ? 'Exporting…' : 'Export tuning data (JSON)'}
        </button>
        <span className={`inline-flex items-center gap-1 text-[11px] ${muted}`}>
          <Database className="h-3 w-3" /> Local only — never uploaded
        </span>
      </div>

      {error ? (
        <p className="text-xs text-red-400" role="alert" data-testid="speech-tuning-error">{error}</p>
      ) : null}
      {result ? (
        <div className="text-[11px] leading-relaxed" data-testid="speech-tuning-result">
          <p className={muted}>
            Exported {result.sessions ?? sessions.length} session(s), {formatBytes(result.bytes)}.
          </p>
          <p className="break-all font-mono text-[10px]">{result.path}</p>
        </div>
      ) : null}
    </section>
  );
};

export default SpeechTuningDataCard;
export { formatBytes };
