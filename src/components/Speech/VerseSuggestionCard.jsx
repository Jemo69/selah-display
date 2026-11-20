/**
 * VerseSuggestionCard.jsx — lane 2, the Bible verse.
 *
 * THE CARD IS THE VERIFICATION SURFACE (plan: "a hallucinated 'John 3:16'
 * arrives as a clean, correctly-formatted suggestion, one tap from the
 * sanctuary screens"). So it shows the reference AND the resolved text from a
 * real installed translation before anything can be pressed, and it names the
 * translation it resolved against.
 *
 * THREE PRESS-ACTIVATED ACTIONS, deliberately hard to confuse:
 *   Send Live — resolves to the output immediately (loadBibleVerse +
 *               emitBibleVerseLoaded, the app's own verse-load path).
 *   Stage     — stages the reference in the Bible panel and routes the Stage
 *               output ON. It does not touch contentMode, lyrics, or any main
 *               output: the operator fires it from the panel when ready.
 *   Dismiss   — a labelled negative action: the card goes away and NOTHING
 *               moves anywhere. Named and styled so it can never be mistaken
 *               for a send.
 *
 * "Different translation" re-resolves the SAME detected reference against
 * another installed translation. No re-transcription, no engine involvement —
 * it is a different lookup of the same reference, which is exactly why the
 * lane can offer it.
 *
 * KEYBOARD (plan 6.3 defaults): Alt+V = Send Live, Alt+X = Dismiss. Both are
 * declared in DEFAULT_BINDINGS (so they are rebindable in User Preferences)
 * and registered HERE — by the card, for as long as the card exists — never by
 * a global hook. With no verse suggestion on screen there is no send key at
 * all, which is the same rule as the buttons: a press always names a card the
 * operator can see. Alt-only combos are suppressed by TanStack while a text
 * field has focus, so the sermon-note textarea cannot be typing into a send.
 *
 * Nothing here runs automatically: translations load and buttons enable only
 * after the operator has a card to look at, and every effect below is a local
 * read (IndexedDB through the BibleStore's own loader) — no network, no spawn.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getHotkeyManager, formatForDisplay } from '@tanstack/hotkeys';
import useHotkeysStore from '../../context/HotkeysStore';
import useSpeechRuntimeStore from '../../context/SpeechRuntimeStore';
import { DEFAULT_BINDINGS } from '../../constants/hotkeyBindings';
import { describeMatch } from '../../speech/matchVerdict';
import { recordTuningEvent } from '../../speech/tuningData.js';
import {
  buildVersePayload,
  enableStageOutput,
  listVerseTranslations,
  sendVerseLive,
  stageVerseInPanel,
} from '../../hooks/useSpeechRuntime';

/**
 * Verdict tone -> colour (Phase 4).
 *
 * Three tones, three treatments, and the colour is never the ONLY signal: the
 * label beside it already says "Strong match" / "Likely" / "Close — check the
 * text". Colour-blind operators get the same information from the word, which
 * is the whole reason the word exists rather than a bar.
 */
const toneClass = (tone, darkMode) => {
  if (tone === 'high') return darkMode ? 'text-emerald-400' : 'text-emerald-700';
  if (tone === 'medium') return darkMode ? 'text-amber-400' : 'text-amber-700';
  return darkMode ? 'text-orange-300' : 'text-orange-700';
};

const buttonClass = (darkMode, tone) => {
  const base = 'rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors';
  if (tone === 'primary') {
    return `${base} ${
      darkMode
        ? 'border-blue-500/50 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20'
        : 'border-blue-400 bg-blue-50 text-blue-700 hover:bg-blue-100'
    }`;
  }
  return `${base} ${
    darkMode
      ? 'border-gray-700 bg-gray-900 text-gray-300 hover:bg-gray-800'
      : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
  }`;
};

/**
 * Live binding with the shipped default as fallback (a partially rehydrated
 * hotkeys store must never leave the card without its two keys).
 */
const resolveCombo = (bindings, id) =>
  bindings && typeof bindings[id] === 'string' && bindings[id].length > 0
    ? bindings[id]
    : DEFAULT_BINDINGS[id];

/**
 * The card's two keyboard actions, registered only while the card is mounted.
 *
 * Handlers arrive as props and are mirrored into refs, so a re-render (a new
 * translation, a new feedback line) never re-registers the listener; the
 * effect keys on the COMBOS only, which is what live rebinds change. Both
 * registrations are torn down on unmount, which is what makes "no card, no
 * send key" true rather than aspirational.
 */
const VerseCardHotkeys = ({ sendCombo, dismissCombo, onSend, onDismiss }) => {
  const sendRef = useRef(onSend);
  const dismissRef = useRef(onDismiss);
  sendRef.current = onSend;
  dismissRef.current = onDismiss;

  useEffect(() => {
    const manager = getHotkeyManager();
    const sendHandle = manager.register(sendCombo, () => sendRef.current(), {
      conflictBehavior: 'allow',
    });
    const dismissHandle = manager.register(dismissCombo, () => dismissRef.current(), {
      conflictBehavior: 'allow',
    });
    return () => {
      sendHandle.unregister();
      dismissHandle.unregister();
    };
  }, [sendCombo, dismissCombo]);

  return null;
};

const VerseSuggestionCard = ({ darkMode = false, suggestion = null, sessionId = null }) => {
  const dismiss = useSpeechRuntimeStore((state) => state.dismissVerse);
  const sendCombo = useHotkeysStore((state) => resolveCombo(state.bindings, 'verseSendLive'));
  const dismissCombo = useHotkeysStore((state) => resolveCombo(state.bindings, 'verseDismiss'));

  const verse = suggestion?.verse ?? null;
  const candidates = suggestion?.candidates ?? [];
  // Phase 4 — the verdict and the runner-up disclosure, computed once per
  // render rather than inline in JSX so both are testable as pure functions.
  const verdict = useMemo(
    () => describeMatch(suggestion),
    [suggestion?.confidence, suggestion?.runnerUp]
  );
  const referenceKey = verse
    ? `${verse.book}|${verse.chapter}|${verse.verse}|${verse.endVerse ?? ''}`
    : '';
  const candidateKey = candidates.join('|');

  const [options, setOptions] = useState(null); // null = still resolving
  const [index, setIndex] = useState(0);
  const [feedback, setFeedback] = useState('');

  const bookNames = useMemo(
    () => (verse ? [verse.book, ...candidates] : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [referenceKey, candidateKey]
  );

  useEffect(() => {
    if (!referenceKey) return undefined;
    let alive = true;
    setOptions(null);
    setIndex(0);
    setFeedback('');

    const names = verse ? [verse.book, ...candidates] : [];
    listVerseTranslations(verse, names)
      .then((list) => {
        if (alive) setOptions(list);
      })
      .catch(() => {
        if (alive) setOptions([]);
      });

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referenceKey, candidateKey]);

  const resolving = options === null;
  const current = options && options.length > 0 ? options[Math.min(index, options.length - 1)] : null;

  const payload = useMemo(
    () => (current && verse ? buildVersePayload({ verse, option: current, bookName: bookNames[0] }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current, referenceKey, candidateKey]
  );

  if (!verse) return null;

  const muted = darkMode ? 'text-gray-400' : 'text-gray-500';
  const canSend = Boolean(payload);
  const canStage = options === null || options.length > 0;

  const cycleTranslation = () => {
    if (!options || options.length < 2) {
      setFeedback('Only one installed translation contains this verse.');
      return;
    }
    setIndex((current2) => (current2 + 1) % options.length);
    setFeedback('');
  };

  const sendLive = () => {
    if (!payload) {
      setFeedback('This verse could not be resolved in that translation.');
      return;
    }
    if (sendVerseLive(payload)) {
      setFeedback(`${payload.reference} sent to the output.`);
      recordTuningEvent(sessionId, {
        type: 'action', lane: 'verse', action: 'send',
        reference: payload.reference, confidence: suggestion?.confidence,
      });
    }
  };

  const stage = () => {
    if (!stageVerseInPanel(verse, bookNames)) {
      setFeedback('This reference is not in the active translation — stage it from the Bible panel.');
      return;
    }
    enableStageOutput();
    setFeedback('Staged in the Bible panel with the Stage output on. The main outputs did not change.');
    recordTuningEvent(sessionId, {
      type: 'action', lane: 'verse', action: 'stage',
      reference: verse.reference, confidence: suggestion?.confidence,
    });
  };

  const dismissCard = () => {
    recordTuningEvent(sessionId, {
      type: 'action', lane: 'verse', action: 'dismiss',
      reference: verse.reference, confidence: suggestion?.confidence,
    });
    dismiss(verse.reference);
  };

  return (
    <div
      data-testid="suggestion-verse"
      className={`rounded-lg border p-3 space-y-2 ${
        darkMode ? 'border-gray-800 bg-gray-950/40' : 'border-gray-200 bg-gray-50'
      }`}
    >
      <VerseCardHotkeys
        sendCombo={sendCombo}
        dismissCombo={dismissCombo}
        onSend={sendLive}
        onDismiss={dismissCard}
      />
      <p className={`text-[11px] font-bold uppercase tracking-wider ${muted}`}>Bible verse</p>

      <p
        data-testid="verse-reference"
        className={`text-sm font-semibold leading-snug ${darkMode ? 'text-gray-100' : 'text-gray-900'}`}
      >
        {verse.reference}
      </p>

      {/* PHASE 4 — a word, not a number.
          The old UI rendered "94% match", which invites the operator to read as
          "94% chance this is John 3:16". It is not that: confidence is
          matchQuality x segmentWeight, so a perfect text match on a half-heard
          segment arrives low for reasons that have nothing to do with the
          verse. The gates in hallucination.js still own whether a card exists
          at all — this only describes one that already passed.

          And when the detector was genuinely torn between two passages, the
          card says so. FreeShow computes that runner-up for its ambiguity
          penalty and discards it, leaving its operator to trust a colour. */}
      {typeof suggestion.confidence === 'number' ? (
        <p
          data-testid="verse-verdict"
          data-tone={verdict.tone}
          className={`text-[11px] font-semibold ${toneClass(verdict.tone, darkMode)}`}
        >
          {verdict.label}
        </p>
      ) : null}

      {verdict.disclosure ? (
        <p data-testid="verse-runner-up" className={`text-[11px] ${muted}`}>
          {verdict.disclosure}
        </p>
      ) : null}

      <p data-testid="verse-translation" className={`text-[11px] ${muted}`}>
        {resolving
          ? 'Resolving this reference against your installed translations…'
          : current
            ? `Resolved from ${current.bibleName}`
            : 'Not found in any installed translation.'}
      </p>

      {!resolving && current ? (
        <p
          data-testid="verse-text"
          className={`max-h-24 overflow-y-auto text-xs leading-snug ${
            darkMode ? 'text-gray-300' : 'text-gray-700'
          }`}
        >
          {current.text}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="verse-different-translation"
          onClick={cycleTranslation}
          className={buttonClass(darkMode, 'quiet')}
        >
          Different translation
        </button>
        <button
          type="button"
          data-testid="verse-send-live"
          onClick={sendLive}
          disabled={!canSend}
          className={buttonClass(darkMode, 'primary')}
        >
          Send Live
        </button>
        <button
          type="button"
          data-testid="verse-stage"
          onClick={stage}
          disabled={!canStage}
          className={buttonClass(darkMode, 'quiet')}
        >
          Stage only
        </button>
        <button
          type="button"
          data-testid="verse-dismiss"
          onClick={dismissCard}
          className={buttonClass(darkMode, 'quiet')}
        >
          Dismiss
        </button>
      </div>

      <p className={`text-[11px] leading-snug ${muted}`}>
        Send Live puts {verse.reference} on the output. Stage only prepares the Bible panel and the
        Stage output — nothing else moves. Dismiss closes this card and changes nothing.
      </p>

      <p
        data-testid="verse-hotkey-hint"
        className={`text-[11px] font-semibold ${muted}`}
      >
        Keys while this card is showing — Send Live: {formatForDisplay(sendCombo)} · Dismiss:{' '}
        {formatForDisplay(dismissCombo)}.
      </p>

      {feedback ? (
        <p data-testid="verse-feedback" role="status" className={`text-xs ${muted}`}>
          {feedback}
        </p>
      ) : null}
    </div>
  );
};

export default VerseSuggestionCard;
