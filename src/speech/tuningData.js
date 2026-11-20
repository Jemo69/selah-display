/**
 * src/speech/tuningData.js — local, opt-in-by-history tuning events.
 *
 * The transcript is already stored by speech history. This helper adds the
 * labels that make it useful for tuning: which lane fired, the reference,
 * the detector, the confidence, and what the operator did with the card.
 *
 * It NEVER sends network traffic. It writes through the existing local
 * history store (`speech:history:append` op=event), so the current history
 * setting and disk cap apply, and a JSON export includes the events beside
 * the transcript.
 */
export function recordTuningEvent(sessionId, event) {
  if (!sessionId || !event || typeof event !== 'object') return;
  try {
    const api = typeof window === 'undefined' ? null : window.electronAPI?.speech?.history;
    if (typeof api?.event !== 'function') return;
    const pending = api.event(sessionId, { atMs: Date.now(), ...event });
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch {
    // Tuning data is best-effort; it must never affect a live service.
  }
}

export default recordTuningEvent;
