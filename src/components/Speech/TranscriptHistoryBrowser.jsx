import React, { useCallback, useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// TranscriptHistoryBrowser — the Decision D9 / Phase 4 history surface:
// browse, search, export, and erase the local transcript history.
//
// COLD CONTRACT (invariant 4): rendering performs no spawn, no fetch, no
// getUserMedia, and no disk access from the renderer. The ONE thing mount
// does is an explicit, cheap `history.list()` invoke — summaries only, no
// segment text — because a browser with no rows would otherwise render an
// empty shell that lies about there being no history. Everything else
// (opening a session, searching, exporting, erasing) waits for a click.
//
// HONESTY RULES held here:
//  - WER renders as "—" / "not benchmarked" until Phase 3 computes a real
//    reference-based estimate. A fabricated number would poison the
//    "running quality record" the plan wants this to become.
//  - Erase is labelled for what it is — it deletes EVERY transcript — and
//    always passes through an explicit confirmation step before anything is
//    destroyed. The bytes reclaimed afterwards are shown, not guessed.
//  - Per-segment provider attribution is visible: a session that trialled
//    cloud and returned to local shows exactly where the boundary fell.
//
// This component is NOT mounted by this change; the rail (SermonAssistPanel)
// mounts it. It renders nothing without the preload bridge, like every other
// Speech surface.
// ---------------------------------------------------------------------------

const historyBridge = () =>
  typeof window === 'undefined' ? null : window.electronAPI?.speech?.history ?? null;

/** `m:ss` / `h:mm:ss` for a millisecond duration or offset. */
export const formatClock = (ms) => {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
};

export const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const rounded = index === 0 || value >= 100 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${units[index]}`;
};

const formatDate = (startedAt) => {
  if (!Number.isFinite(startedAt)) return 'Unknown date';
  try {
    return new Date(startedAt).toLocaleString();
  } catch {
    return 'Unknown date';
  }
};

const TranscriptHistoryBrowser = ({ darkMode = false }) => {
  const [sessions, setSessions] = useState(null); // null = list still loading
  const [selected, setSelected] = useState(null); // full record, text included
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [format, setFormat] = useState('json');
  const [exportResult, setExportResult] = useState(null);
  const [eraseConfirming, setEraseConfirming] = useState(false);
  const [eraseResult, setEraseResult] = useState(null);
  const [notice, setNotice] = useState(null); // { tone:'error'|'info', text }
  const [busy, setBusy] = useState(false);

  const bridge = historyBridge();

  const refresh = useCallback(async () => {
    const api = historyBridge();
    if (!api) return;
    try {
      const reply = await api.list();
      if (reply?.ok === false) {
        setNotice({ tone: 'error', text: reply.message ?? 'Transcript history is unavailable.' });
        setSessions([]);
        return;
      }
      setSessions(Array.isArray(reply?.sessions) ? reply.sessions : []);
      if (reply?.status?.recording === false) {
        setNotice({
          tone: 'error',
          text:
            'Transcript recording has stopped: the local history cap was reached. ' +
            'Erase history below to make room.',
        });
      }
    } catch {
      setSessions([]);
      setNotice({ tone: 'error', text: 'Transcript history could not be read.' });
    }
  }, []);

  // The single explicit initial load — summaries only, one invoke. Nothing
  // else runs until the user interacts.
  useEffect(() => {
    if (!historyBridge()) return undefined;
    refresh();
    // React 18+ ignores state updates after unmount; no teardown needed.
  }, [refresh]);

  if (!bridge) return null;

  const cardClass = `rounded-xl border p-4 space-y-3 ${
    darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white'
  }`;
  const labelClass = `text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`;
  const mutedClass = `text-xs leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-600'}`;
  const quietButton = `inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold ${
    darkMode
      ? 'border-gray-700 bg-gray-900 text-gray-300 hover:bg-gray-800'
      : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
  }`;
  const dangerButton =
    'inline-flex items-center gap-1.5 rounded-md border border-red-500/60 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40';
  const rowClass = `w-full text-left rounded-lg border px-3 py-2 transition-colors ${
    darkMode
      ? 'border-gray-800 bg-gray-950/60 hover:bg-gray-900 text-gray-200'
      : 'border-gray-200 bg-gray-50 hover:bg-gray-100 text-gray-800'
  }`;
  const inputClass = `flex-1 min-w-0 rounded-md border px-2.5 py-1.5 text-xs ${
    darkMode
      ? 'border-gray-700 bg-gray-950 text-white placeholder:text-gray-500'
      : 'border-gray-300 bg-white text-gray-900 placeholder:text-gray-400'
  }`;

  const fail = (text) => setNotice({ tone: 'error', text });
  const clearNotice = () => setNotice(null);

  const openSession = async (sessionId) => {
    clearNotice();
    setBusy(true);
    try {
      const reply = await bridge.get(sessionId);
      if (reply?.ok === false) {
        fail(reply.message ?? 'That session could not be opened.');
        return;
      }
      setSelected(reply?.session ?? null);
    } catch {
      fail('That session could not be opened.');
    } finally {
      setBusy(false);
    }
  };

  const handleSearch = async (event) => {
    event.preventDefault();
    clearNotice();
    setBusy(true);
    try {
      const reply = await bridge.search(query);
      if (reply?.ok === false) {
        fail(reply.message ?? 'Search failed.');
        return;
      }
      setResults(reply ?? null);
    } catch {
      fail('Search failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    clearNotice();
    setBusy(true);
    try {
      const reply = await bridge.export({ format });
      if (reply?.ok === false) {
        fail(reply.message ?? 'The export could not be written.');
        return;
      }
      setExportResult(reply);
    } catch {
      fail('The export could not be written.');
    } finally {
      setBusy(false);
    }
  };

  const handleErase = async () => {
    clearNotice();
    setBusy(true);
    try {
      const reply = await bridge.erase();
      if (reply?.ok === false) {
        fail(reply.message ?? 'History could not be erased.');
        return;
      }
      setEraseResult(reply);
      setEraseConfirming(false);
      setSelected(null);
      setResults(null);
      await refresh();
    } catch {
      fail('History could not be erased.');
    } finally {
      setBusy(false);
    }
  };

  const werCell = (werEstimate) =>
    Number.isFinite(werEstimate)
      ? `${Math.round(werEstimate * 100)}%`
      : '—';

  const sessionCount = sessions?.length ?? 0;

  return (
    <section className={cardClass} data-testid="speech-history-browser">
      <div className="space-y-1.5">
        <span className={labelClass}>Transcript history</span>
        <p className={mutedClass}>
          Every transcribed session is stored on this computer — browsable, searchable, exportable,
          and erasable. One file per session, capped, and never written to the app log.
        </p>
        <p className={mutedClass} data-testid="history-tuning-note">
          JSON exports also include detection and action events — lane, reference, detector,
          confidence, and send/stage/dismiss — for offline tuning.
        </p>
      </div>

      {notice ? (
        <div
          role="alert"
          data-testid="history-error"
          className={`rounded-lg border p-2.5 text-xs leading-relaxed ${
            darkMode
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
              : 'border-amber-200 bg-amber-50 text-amber-800'
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      {/* --- toolbar: search, export, erase ------------------------------- */}
      <form onSubmit={handleSearch} className="flex items-center gap-2 flex-wrap">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search transcripts…"
          aria-label="Search transcript history"
          data-testid="history-search-input"
          className={inputClass}
        />
        <button type="submit" disabled={busy} className={quietButton} data-testid="history-search-button">
          Search
        </button>
      </form>

      {results ? (
        <div className="space-y-2" data-testid="history-search-results">
          <span className={mutedClass}>
            {results.matches.length === 0
              ? `No matches for “${results.query}”.`
              : `${results.matches.length} session(s) match “${results.query}”.`}
          </span>
          {results.matches.map((match) => (
            <div key={match.sessionId} className="space-y-1">
              <button
                type="button"
                className={rowClass}
                onClick={() => openSession(match.sessionId)}
                data-testid="history-search-match"
              >
                <span className="font-semibold">{formatDate(match.startedAt)}</span>{' '}
                <span className={mutedClass}>
                  {match.modelId ?? 'unknown model'} · {match.segmentCount} segments ·{' '}
                  {match.providers?.length > 1
                    ? `${match.providers.length} providers`
                    : (match.providerId ?? 'unknown provider')}
                </span>
              </button>
              {match.segments.map((hit) => (
                <p
                  key={hit.segmentId}
                  className={`pl-3 text-xs leading-relaxed border-l-2 ${
                    darkMode ? 'border-gray-700 text-gray-300' : 'border-gray-200 text-gray-700'
                  }`}
                  data-testid="history-search-excerpt"
                >
                  <span className={mutedClass}>
                    [{formatClock(hit.tStartMs)}] {hit.providerId ?? 'unknown'}:{' '}
                  </span>
                  {hit.excerpt}
                </p>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={format}
          onChange={(event) => setFormat(event.target.value)}
          aria-label="Export format"
          data-testid="history-export-format"
          className={inputClass}
          style={{ flex: '0 0 auto' }}
        >
          <option value="json">JSON (full records)</option>
          <option value="text">Plain text</option>
        </select>
        <button
          type="button"
          onClick={handleExport}
          disabled={busy}
          className={quietButton}
          data-testid="history-export"
        >
          Export
        </button>

        {!eraseConfirming ? (
          <button
            type="button"
            onClick={() => {
              setEraseResult(null);
              setEraseConfirming(true);
            }}
            disabled={busy}
            className={dangerButton}
            data-testid="history-erase"
          >
            Erase all transcripts
          </button>
        ) : (
          <span
            className={`inline-flex items-center gap-2 rounded-md border border-red-500/60 px-2.5 py-1.5 text-xs ${
              darkMode ? 'text-red-300' : 'text-red-700'
            }`}
            data-testid="history-erase-confirm"
          >
            <span>Delete every stored transcript? This cannot be undone.</span>
            <button
              type="button"
              onClick={handleErase}
              disabled={busy}
              className={dangerButton}
              data-testid="history-erase-confirm-yes"
            >
              Yes, erase everything
            </button>
            <button
              type="button"
              onClick={() => setEraseConfirming(false)}
              className={quietButton}
              data-testid="history-erase-confirm-no"
            >
              Cancel
            </button>
          </span>
        )}
      </div>

      {exportResult ? (
        <p className={mutedClass} data-testid="history-export-result">
          Exported {formatBytes(exportResult.bytes)} — saved to{' '}
          <span className="font-semibold break-all">{exportResult.path}</span>
        </p>
      ) : null}

      {eraseResult ? (
        <p className={mutedClass} data-testid="history-erase-result">
          Every transcript was deleted — {formatBytes(eraseResult.bytesReclaimed)} reclaimed.
        </p>
      ) : null}

      {/* --- browse -------------------------------------------------------- */}
      {sessions === null ? (
        <p className={mutedClass} data-testid="history-loading">
          Loading transcript history…
        </p>
      ) : sessionCount === 0 ? (
        <p className={mutedClass} data-testid="history-empty">
          No transcript history yet — sessions transcribed during a service will be listed here.
        </p>
      ) : (
        <ul className="space-y-1.5" data-testid="history-list">
          {sessions.map((session) => (
            <li key={session.sessionId}>
              <button
                type="button"
                onClick={() => openSession(session.sessionId)}
                aria-pressed={selected?.sessionId === session.sessionId}
                className={rowClass}
                data-testid="history-session-row"
              >
                <span className="flex items-baseline justify-between gap-2 flex-wrap">
                  <span className="font-semibold">{formatDate(session.startedAt)}</span>
                  <span className={mutedClass}>
                    {formatClock(session.durationMs)} · {session.modelId ?? 'unknown model'} ·{' '}
                    {(session.providers?.length ?? 0) > 1
                      ? `${session.providers.length} providers`
                      : (session.providerId ?? 'unknown provider')}{' '}
                    · {session.segmentCount} segment{session.segmentCount === 1 ? '' : 's'}
                  </span>
                </span>
                <span className={`flex items-baseline justify-between gap-2 flex-wrap ${mutedClass}`}>
                  <span>
                    WER {werCell(session.werEstimate)}
                    {!Number.isFinite(session.werEstimate) ? ' · not benchmarked' : ''}
                  </span>
                  {(session.providers?.length ?? 0) > 1 ? (
                    <span
                      className={`text-[11px] font-semibold ${
                        darkMode ? 'text-[#7DDBD3]' : 'text-[#1a5c54]'
                      }`}
                      data-testid="history-provider-mixed"
                    >
                      mixed providers — open to see the boundary
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* --- detail: the selected session, with the provider boundary ------ */}
      {selected ? (
        <div className="space-y-2" data-testid="history-session-detail">
          <div className="space-y-0.5">
            <span className={labelClass}>{formatDate(selected.startedAt)}</span>
            <p className={mutedClass}>
              {formatClock(selected.durationMs)} · {selected.modelId ?? 'unknown model'} · session
              provider {selected.providerId ?? 'unknown'} · where {selected.where ?? 'unknown'} ·{' '}
              {(selected.segments ?? []).length} segments
            </p>
            <p className={mutedClass} data-testid="history-session-wer">
              WER:{' '}
              {Number.isFinite(selected.werEstimate)
                ? `${Math.round(selected.werEstimate * 100)}%`
                : 'not benchmarked — no reference yet'}
            </p>
          </div>

          <div className="space-y-1.5">
            {(selected.segments ?? []).map((segment, index) => {
              const previous = index > 0 ? selected.segments[index - 1] : null;
              const boundary = previous && previous.providerId !== segment.providerId;
              return (
                <React.Fragment key={segment.segmentId ?? `${selected.sessionId}-${index}`}>
                  {boundary ? (
                    <p
                      className={`rounded-md border px-2.5 py-1.5 text-[11px] font-semibold ${
                        darkMode
                          ? 'border-[#7DDBD3]/40 bg-[#7DDBD3]/10 text-[#7DDBD3]'
                          : 'border-[#1a5c54]/30 bg-[#1a5c54]/5 text-[#1a5c54]'
                      }`}
                      data-testid="history-provider-boundary"
                    >
                      Provider boundary: {previous.providerId ?? 'unknown'} →{' '}
                      {segment.providerId ?? 'unknown'}
                    </p>
                  ) : null}
                  <p
                    className={`text-xs leading-relaxed ${
                      darkMode ? 'text-gray-200' : 'text-gray-800'
                    }`}
                  >
                    <span className={mutedClass}>
                      [{formatClock(segment.tStartMs)}] {segment.providerId ?? 'unknown'}:{' '}
                    </span>
                    {segment.text}
                  </p>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
};

export default TranscriptHistoryBrowser;
