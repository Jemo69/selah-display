/**
 * SuggestionLanes.jsx — the Suggestions section: three lanes, one gate, and
 * the D5 rule ("nothing reaches an output window until the operator presses
 * send") made structural.
 *
 * SHAPE OF THE SECTION, in reading order:
 *   1. gate reason   — muted, when the newest settled segment failed a
 *                      hallucination gate. Machine reason -> human phrase,
 *                      never transcript text.
 *   2. lane reasons  — a lane the provider's capabilities disable (or degrade)
 *                      states WHY inline. Nothing is ever silently off:
 *                      `lane-<id>-reason` with `data-lane-state` telling a
 *                      disabled lane from a degraded one.
 *   3. the cards     — rendered only when there is something to show. A card
 *                      is a proposal; it sends only on a press.
 *   4. empty state   — the shipped sentence when no lane has a card, so the
 *                      section never implies suggestions are coming from
 *                      something the operator cannot see.
 *
 * Selection of store values is primitive-by-primitive on purpose: an object
 * selector in zustand returns a fresh reference every call and re-renders the
 * rail forever.
 */
import React, { useEffect, useRef } from 'react';
import useSpeechStore from '../../context/SpeechStore';
import useLyricsStore from '../../context/LyricsStore';
import useSpeechRuntimeStore from '../../context/SpeechRuntimeStore';
import { capabilitiesForProviderId, deriveSuggestions } from '../../hooks/useSpeechRuntime';
import { useCurrentBibleReference, useVerseSearchWorker, resolveSpeechLocale } from '../../hooks/useVerseSearchWorker';
import { recordTuningEvent } from '../../speech/tuningData.js';
import NextLyricSuggestion from './NextLyricSuggestion';
import VerseSuggestionCard from './VerseSuggestionCard';
import SermonNoteSuggestion from './SermonNoteSuggestion';
import QuoteSuggestionCard from './QuoteSuggestionCard';

/** Shipped empty-state copy (asserted by SermonAssistPanel.test.jsx). */
export const EMPTY_SUGGESTIONS_COPY =
  'Next lyric line, Bible verse, and sermon note suggestions appear here.';

/** Operator-facing lane names, for a reason that covers more than one lane. */
const LANE_LABELS = Object.freeze({ lyric: 'next-lyric', verse: 'verse', note: 'sermon note' });

/**
 * Group the lane reasons by exact sentence, so one sentence printed for two
 * lanes is rendered once naming both. Returns [] when every reason is unique.
 */
function findRepeatedReasons(lanes) {
  const byReason = new Map();
  for (const lane of lanes) {
    if (!lane.reason || (!lane.degraded && lane.enabled)) continue;
    if (!byReason.has(lane.reason)) byReason.set(lane.reason, []);
    byReason.get(lane.reason).push(lane.id);
  }
  return [...byReason.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([reason, ids]) => ({ reason, lanes: ids }));
}

const SuggestionLanes = ({ darkMode = false, cardClass, titleClass }) => {
  const segments = useSpeechRuntimeStore((state) => state.segments);
  const note = useSpeechRuntimeStore((state) => state.note);
  const dismissed = useSpeechRuntimeStore((state) => state.dismissed);
  // Phase 7 — dismissed QUOTES. A separate list from dismissed verses, so
  // dismissing one can never suppress the other.
  const dismissedQuotes = useSpeechRuntimeStore((state) => state.dismissedQuotes);
  const lyrics = useLyricsStore((state) => state.lyrics);
  const selectedLine = useLyricsStore((state) => state.selectedLine);
  const where = useSpeechStore((state) => state.where);
  const providerId = useSpeechStore((state) => state.providerId);
  const cloudProviderId = useSpeechStore((state) => state.cloudProviderId);
  const health = useSpeechStore((state) => state.health);
  const speechLocale = useSpeechStore((state) => state.speechLocale);
  // Phase 7 — quote-lane consent, passed through to the capability table so the
  // lane's enablement is decided in one place (see lanesWithQuote).
  const quoteProviderId = useSpeechStore((state) => state.quoteProviderId);
  const quoteConsented = useSpeechStore((state) => state.quoteConsented);
  const quoteKeyReady = useSpeechStore((state) => state.quoteKeyReady);

  const lanes = capabilitiesForProviderId({
    where, providerId, cloudProviderId,
    quoteProviderId, quoteConsented, quoteKeyReady,
  });

  // Phase 1 — detector 3's off-thread index. `verseLane` gates it, so a
  // disabled verse lane never constructs a Worker at all. The current on-screen
  // reference is what gives the scorer its upcoming-verse prior, and it is read
  // from the same state the card renders from, so the prior and the display
  // cannot disagree.
  const transcript = segments.map((segment) => segment?.text || '').join(' ').slice(-600);
  const sessionId = segments.at(-1)?.sessionId ?? null;
  const lastSuggestionRef = useRef('');
  const currentReference = useCurrentBibleReference();
  const { results: searchResults } = useVerseSearchWorker({
    enabled: Boolean(lanes.find((lane) => lane.id === 'verse')?.enabled),
    transcript,
    currentReference,
  });

  // Phase 3 — the spoken citation vocabulary. An operator override wins over
  // the machine's locale, because the language preached in is not necessarily
  // the language the machine is set to.
  const locale = resolveSpeechLocale(speechLocale);

  const suggestions = deriveSuggestions({
    segments,
    lyrics,
    selectedIndex: selectedLine,
    lanes,
    dismissed,
    note,
    health,
    searchResults,
    locale,
    // Phase 7 — dismissed quotes, kept apart from dismissed verse references.
    dismissedQuotes,
  });

  useEffect(() => {
    if (!sessionId) return;
    const verse = suggestions.verse;
    const signature = verse
      ? `verse|${verse.verse?.reference ?? ''}|${verse.detector ?? ''}|${verse.confidence ?? ''}`
      : suggestions.quote
        ? `quote|${String(suggestions.quote.content ?? '').slice(0, 48)}`
        : suggestions.lyric
          ? `lyric|${suggestions.lyric.match?.index ?? ''}`
          : suggestions.note
            ? 'note'
            : '';
    if (!signature || signature === lastSuggestionRef.current) return;
    lastSuggestionRef.current = signature;
    if (verse) {
      recordTuningEvent(sessionId, {
        type: 'suggestion',
        lane: 'verse',
        reference: verse.verse?.reference,
        detector: verse.detector,
        confidence: verse.confidence,
        tStartMs: segments.at(-1)?.tStartMs,
        tEndMs: segments.at(-1)?.tEndMs,
      });
    } else if (suggestions.quote) {
      recordTuningEvent(sessionId, { type: 'suggestion', lane: 'quote' });
    } else if (suggestions.lyric) {
      recordTuningEvent(sessionId, { type: 'suggestion', lane: 'lyric' });
    } else if (suggestions.note) {
      recordTuningEvent(sessionId, { type: 'suggestion', lane: 'note' });
    }
  }, [sessionId, suggestions, segments]);

  const card = cardClass ?? 'rounded-xl border p-5 space-y-4';
  const title = titleClass ?? 'text-[11px] font-bold uppercase tracking-wider';
  const muted = darkMode ? 'text-gray-400' : 'text-gray-500';
  const hasCard = Boolean(suggestions.lyric || suggestions.verse || suggestions.note || suggestions.quote);

  // Reasons rendered individually are the ones that cover a single lane.
  const repeatedReasons = findRepeatedReasons(lanes);
  const repeatedText = new Set(repeatedReasons.map((entry) => entry.reason));

  return (
    <section aria-label="Suggestions" className={card}>
      <h3 className={title}>Suggestions</h3>

      {suggestions.gateReason ? (
        <p data-testid="lane-gate-reason" className={`text-xs leading-snug ${muted}`}>
          No suggestions from the last segment — {suggestions.gateReason}.
        </p>
      ) : null}

      {lanes.map((lane) =>
        lane.reason && !repeatedText.has(lane.reason) && (lane.degraded || !lane.enabled) ? (
          <p
            key={lane.id}
            data-testid={`lane-${lane.id}-reason`}
            data-lane-state={lane.enabled ? 'degraded' : 'disabled'}
            className={`text-xs leading-snug ${muted}`}
          >
            {lane.reason}
          </p>
        ) : null
      )}

      {/* Sections can repeat a lane reason verbatim when two lanes are disabled
          by the same missing capability. Show each DISTINCT sentence once,
          naming every lane it covers — the operator needs to know what is off,
          not to read the same warning twice and conclude the rail is broken. */}
      {repeatedReasons.length > 0 ? (
        <p
          data-testid="lane-shared-reason"
          className={`text-xs leading-snug ${muted} border-l-2 ${
            darkMode ? 'border-gray-700 pl-2' : 'border-gray-300 pl-2'
          }`}
        >
          {repeatedReasons[0].reason} ({repeatedReasons.map((r) => LANE_LABELS[r.lane]).join(' and ')})
        </p>
      ) : null}

      {suggestions.lyric ? (
        <NextLyricSuggestion darkMode={darkMode} suggestion={suggestions.lyric} />
      ) : null}

      {suggestions.verse ? (
        <VerseSuggestionCard
          key={suggestions.verse.verse?.reference ?? 'verse'}
          darkMode={darkMode}
          suggestion={suggestions.verse}
          sessionId={sessionId}
        />
      ) : null}

      {suggestions.note ? (
        <SermonNoteSuggestion darkMode={darkMode} note={suggestions.note} />
      ) : null}

      {/*
        The quote lane (Phase 7). Rendered LAST and after the note, because it
        depends on the note and is the least certain thing on the rail. It has
        no output action — see QuoteSuggestionCard's header for why that is
        structural rather than a setting.
      */}
      {suggestions.quote ? (
        <QuoteSuggestionCard
          key={`quote-${suggestions.quote.content.slice(0, 24)}`}
          darkMode={darkMode}
          suggestion={suggestions.quote}
        />
      ) : null}

      {/* D5: nothing reaches an output window until the operator presses send. */}
      {!hasCard ? (
        <p className={`text-sm ${muted}`}>{EMPTY_SUGGESTIONS_COPY}</p>
      ) : null}
    </section>
  );
};

export default SuggestionLanes;
