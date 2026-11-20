/**
 * useSpeechRuntime.test.js — Live Sermon Assist Phase 4, the rail's data path
 * as UNITS: gate order, capability gating, and the four send actions.
 *
 * The components exercise the same functions through real clicks (see
 * SermonAssistSuggestions.test.jsx); this file pins the contract itself:
 *
 *   - `deriveSuggestions` gates FIRST and blanks every lane on a failing gate,
 *     with a text-free reason — never transcript text — for the user;
 *   - below `clearsSuggestionFloor` a lane reports no suggestion at all;
 *   - a disabled lane (D11) yields no suggestion AND keeps its reason;
 *   - every send action moves the real store it claims to move, through the
 *     app's own symbols: `selectLine`, `loadBibleVerse`, `saveFreeNoteDraft`,
 *     and the control-socket emit functions the existing UI uses.
 *
 * No store of ours is mocked — only `window.__controlSocketContext` stands in
 * for a connected renderer, exactly as it does in the app.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  capabilitiesForProviderId,
  deriveSuggestions,
  resolveToggleCombo,
  sendLyricLine,
  sendSermonNote,
  sendVerseLive,
  stageVerseInPanel,
  enableStageOutput,
  buildVersePayload,
  translationOptionsFor,
  verseNumberList,
  formatVerseReference,
  findBibleBook,
} from '../useSpeechRuntime';
import useLyricsStore from '../../context/LyricsStore';
import useBibleStore from '../../context/BibleStore';
import useSpeechRuntimeStore from '../../context/SpeechRuntimeStore';
import { DEFAULT_BINDINGS } from '../../constants/hotkeyBindings';
import { THRESHOLDS, clearsSuggestionFloor, createSermonNote, appendFinalSegment } from '../../speech';

const LYRICS = ['Amazing grace how sweet the sound', 'That saved a wretch like me', 'I once was lost but now am found'];

const KJV = {
  id: 'kjv',
  name: 'KJV',
  books: [
    {
      number: 43,
      name: 'John',
      chapters: [
        {
          number: 3,
          verses: [{ number: 16, text: 'For God so loved the world, that he gave his only begotten Son.' }],
        },
      ],
    },
  ],
};

const LYRIC_LANES = [
  { id: 'lyric', enabled: true, degraded: false, reason: '' },
  { id: 'verse', enabled: true, degraded: false, reason: '' },
  { id: 'note', enabled: true, degraded: false, reason: '' },
];

const OFF_LANES = [
  { id: 'lyric', enabled: false, degraded: false, reason: "This provider can't align words to audio." },
  { id: 'verse', enabled: false, degraded: false, reason: 'No provider capabilities reported' },
  { id: 'note', enabled: false, degraded: false, reason: 'No provider capabilities reported' },
];

const segment = (text, extra = {}) => ({ t: 'final', text, sessionId: 's', tStartMs: 0, tEndMs: 1000, ...extra });

let socket = null;

beforeEach(() => {
  socket = {
    emitLineUpdate: vi.fn(),
    emitBibleVerseLoaded: vi.fn(),
    emitIndividualOutputToggle: vi.fn(),
  };
  window.__controlSocketContext = socket;

  useLyricsStore.setState({
    lyrics: LYRICS,
    selectedLine: 0,
    contentMode: 'song',
    freeNotesDrafts: [],
    stageEnabled: false,
  });
  useBibleStore.setState({
    bibles: { kjv: KJV },
    bibleMetadata: { kjv: { id: 'kjv', name: 'KJV' } },
    activeBibleId: 'kjv',
    activeReference: null,
    selectedVerses: [[1]],
  });
  useSpeechRuntimeStore.getState().reset();
});

afterEach(() => {
  delete window.__controlSocketContext;
});

// ---------------------------------------------------------------------------
// deriveSuggestions — gate order, then floor
// ---------------------------------------------------------------------------

describe('deriveSuggestions', () => {
  it('lane 1: the newest segment ranks current / match / after', () => {
    const out = deriveSuggestions({
      segments: [segment('that saved a wretch like me')],
      lyrics: LYRICS,
      selectedIndex: 0,
      lanes: LYRIC_LANES,
      dismissed: [],
      note: null,
    });

    expect(out.gateReason).toBe('');
    expect(out.lyric.match.index).toBe(1);
    expect(out.lyric.current.index).toBe(0);
    expect(out.lyric.next.index).toBe(2);
    expect(out.verse).toBeNull();
  });

  it('lane 2: a spoken reference resolves to a verse, lane 3 carries the draft', () => {
    const note = appendFinalSegment(createSermonNote({ now: 1 }), segment('the Lord is my shepherd'));
    const out = deriveSuggestions({
      segments: [segment('John 3:16 for God so loved the world')],
      lyrics: LYRICS,
      selectedIndex: 0,
      lanes: LYRIC_LANES,
      dismissed: [],
      note,
    });

    expect(out.gateReason).toBe('');
    expect(out.verse.verse.reference).toBe('John 3:16');
    expect(out.note.content).toContain('the Lord is my shepherd');
  });

  it('lane 2: a reference in the recent tail survives the next sentence', () => {
    const out = deriveSuggestions({
      segments: [
        segment('Isaiah chapter 45 verse 2.'),
        segment('I will go before you and lead the mountains.'),
      ],
      lyrics: LYRICS,
      selectedIndex: 0,
      lanes: LYRIC_LANES,
      dismissed: [],
      note: null,
    });
    expect(out.verse).not.toBeNull();
    expect(out.verse.verse.reference).toBe('Isaiah 45:2');
  });

  /**
   * The fake engine ignores the audio bytes and replays a canned sentence. It
   * is NOT noisy, NOT repetitive, and reports whatever confidence the fake
   * chose — so it sails through every hallucination gate and every confidence
   * floor. Without an explicit check, canned text becomes a clean, correctly
   * formatted, high-confidence verse card one tap from the sanctuary screens.
   *
   * These assertions use a segment that genuinely WOULD produce all three
   * lanes (identical to the test above), so they fail if the guard is removed.
   */
  it('a canned engine produces no suggestion on any lane', () => {
    const note = appendFinalSegment(createSermonNote({ now: 1 }), segment('the Lord is my shepherd'));
    const out = deriveSuggestions({
      segments: [segment('John 3:16 for God so loved the world')],
      lyrics: LYRICS,
      selectedIndex: 0,
      lanes: LYRIC_LANES,
      dismissed: [],
      note,
      health: { backend: 'fake' },
    });

    expect(out.lyric).toBeNull();
    expect(out.verse).toBeNull();
    expect(out.note).toBeNull();
  });

  it('a canned engine reports no gate reason — nothing was rejected by a gate', () => {
    const out = deriveSuggestions({
      segments: [segment('John 3:16 for God so loved the world')],
      lyrics: LYRICS,
      selectedIndex: 0,
      lanes: LYRIC_LANES,
      dismissed: [],
      note: null,
      health: { backend: 'fake' },
    });

    // Fabricating a gate phrase here would be a lie: the segment passed every
    // gate. The UI reports the ENGINE via engineModeLabel instead.
    expect(out.gateReason).toBe('');
  });

  it('a real engine is unaffected by the canned guard', () => {
    const out = deriveSuggestions({
      segments: [segment('John 3:16 for God so loved the world')],
      lyrics: LYRICS,
      selectedIndex: 0,
      lanes: LYRIC_LANES,
      dismissed: [],
      note: null,
      health: { backend: 'whispercpp' },
    });

    expect(out.verse.verse.reference).toBe('John 3:16');
  });

  it('no health payload at all is treated as "not proven canned"', () => {
    const out = deriveSuggestions({
      segments: [segment('John 3:16 for God so loved the world')],
      lyrics: LYRICS,
      selectedIndex: 0,
      lanes: LYRIC_LANES,
      dismissed: [],
      note: null,
    });

    expect(out.verse.verse.reference).toBe('John 3:16');
  });

  it('a failing gate blanks every lane — and the reason is text-free', () => {
    const out = deriveSuggestions({
      segments: [segment('John 3:16 for God so loved the world', { noSpeechProb: 0.95 })],
      lyrics: LYRICS,
      selectedIndex: 0,
      lanes: LYRIC_LANES,
      dismissed: [],
      note: null,
    });

    expect(out.lyric).toBeNull();
    expect(out.verse).toBeNull();
    expect(out.note).toBeNull();
    expect(out.gateReason).toBe('flagged as no speech by the model');
    // The reason never carries anything that was said.
    expect(out.gateReason).not.toContain('John');
    expect(out.gateReason).not.toContain('3:16');
  });

  it('below the shared floor the lane reports no suggestion', () => {
    // Passes the gates (0.5 < 0.6) but halves the segment weight.
    const low = segment('that saved a wretch like me', { noSpeechProb: 0.5 });
    const out = deriveSuggestions({
      segments: [low],
      lyrics: LYRICS,
      selectedIndex: null,
      lanes: LYRIC_LANES,
      dismissed: [],
      note: null,
    });

    expect(out.gateReason).toBe('');
    expect(out.lyric).toBeNull();
    expect(clearsSuggestionFloor(THRESHOLDS.suggestion - 0.01)).toBe(false);
    expect(clearsSuggestionFloor(THRESHOLDS.suggestion)).toBe(true);
  });

  it('a disabled lane yields no suggestion and keeps its reason in the lane list', () => {
    const out = deriveSuggestions({
      segments: [segment('that saved a wretch like me')],
      lyrics: LYRICS,
      selectedIndex: 0,
      lanes: OFF_LANES,
      dismissed: [],
      note: appendFinalSegment(createSermonNote({ now: 1 }), segment('a note line')),
    });

    expect(out.lyric).toBeNull();
    expect(out.verse).toBeNull();
    expect(out.note).toBeNull();
    expect(OFF_LANES.every((lane) => lane.reason.trim().length > 0)).toBe(true);
  });

  it('a dismissed reference never comes back as a card', () => {
    const out = deriveSuggestions({
      segments: [segment('John 3:16 for God so loved the world')],
      lyrics: LYRICS,
      selectedIndex: null,
      lanes: LYRIC_LANES,
      dismissed: ['John 3:16'],
      note: null,
    });

    expect(out.verse).toBeNull();
    expect(out.gateReason).toBe('');
  });
});

// ---------------------------------------------------------------------------
// capability gating (D11)
// ---------------------------------------------------------------------------

describe('capabilitiesForProviderId', () => {
  it('word timestamps off disables the lyric lane with a stated reason', () => {
    const lanes = capabilitiesForProviderId({ where: 'local', providerId: 'vosk' });
    const lyric = lanes.find((lane) => lane.id === 'lyric');
    expect(lyric.enabled).toBe(false);
    expect(lyric.reason.trim().length).toBeGreaterThan(0);
  });

  it('word timestamps on leaves the lyric lane enabled and silent', () => {
    const lanes = capabilitiesForProviderId({ where: 'local', providerId: 'whispercpp' });
    const lyric = lanes.find((lane) => lane.id === 'lyric');
    expect(lyric.enabled).toBe(true);
    expect(lyric.reason).toBe('');
  });

  it('an unknown provider turns every lane off, each with a reason', () => {
    // Four lanes as of Phase 7: lyric, verse, note (engine capability) plus
    // quote (consent). The quote lane is off for a different reason than the
    // other three, and it still carries one — a lane with no reason is a lane
    // nobody can act on.
    const lanes = capabilitiesForProviderId({ where: 'local', providerId: 'nope' });
    expect(lanes).toHaveLength(4);
    for (const lane of lanes) {
      expect(lane.enabled, `${lane.id} should be off`).toBe(false);
      expect(lane.reason.trim().length, `${lane.id} has no reason`).toBeGreaterThan(0);
    }
  });

  it('the quote lane is off without consent even when the engine is fine', () => {
    // The quote lane's enablement is a CONSENT question, not a provider one —
    // which is why it is composed alongside `lanesForCapabilities` rather than
    // folded into it. A working engine must not switch it on.
    const lanes = capabilitiesForProviderId({
      where: 'local',
      providerId: 'whispercpp',
      quoteProviderId: 'ollama',
      quoteConsented: false,
      quoteKeyReady: true,
    });
    const quote = lanes.find((lane) => lane.id === 'quote');
    expect(quote.enabled).toBe(false);
    expect(quote.reason).toMatch(/not turned the quote lane on/i);
  });

  it('the quote lane turns on only with consent AND a ready provider', () => {
    const on = capabilitiesForProviderId({
      where: 'local',
      providerId: 'whispercpp',
      quoteProviderId: 'ollama',
      quoteConsented: true,
      quoteKeyReady: true,
    });
    expect(on.find((lane) => lane.id === 'quote').enabled).toBe(true);

    const notReady = capabilitiesForProviderId({
      where: 'local',
      providerId: 'whispercpp',
      quoteProviderId: 'openai',
      quoteConsented: true,
      quoteKeyReady: false,
    });
    expect(notReady.find((lane) => lane.id === 'quote').enabled).toBe(false);
  });

  it('the cloud axis is read from cloudProviderId when where is cloud', () => {
    const lanes = capabilitiesForProviderId({ where: 'cloud', cloudProviderId: 'custom' });
    expect(lanes.find((lane) => lane.id === 'lyric').enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the send actions, on the real stores
// ---------------------------------------------------------------------------

describe('send actions', () => {
  it('sendLyricLine selects the line through the app path and announces it once', () => {
    expect(sendLyricLine(2)).toBe(true);
    expect(useLyricsStore.getState().selectedLine).toBe(2);
    expect(socket.emitLineUpdate).toHaveBeenCalledWith(2);
    expect(socket.emitBibleVerseLoaded).not.toHaveBeenCalled();
    expect(useLyricsStore.getState().contentMode).toBe('song');

    // Guarded: an invalid index is refused rather than guessed at.
    expect(sendLyricLine(-1)).toBe(false);
    expect(sendLyricLine('1')).toBe(false);
    expect(useLyricsStore.getState().selectedLine).toBe(2);
  });

  it('sendVerseLive loads the verse atomically and emits ONE event', () => {
    const bibleState = useBibleStore.getState();
    const option = translationOptionsFor({ book: 'John', chapter: 3, verse: 16 }, bibleState)[0];
    const payload = buildVersePayload({
      verse: { book: 'John', chapter: 3, verse: 16, endVerse: null, reference: 'John 3:16' },
      option,
      bookName: 'John',
      bibleState,
      lyricsState: useLyricsStore.getState(),
    });

    expect(payload.reference).toBe('John 3:16');
    expect(payload.slides).toHaveLength(1);
    expect(sendVerseLive(payload)).toBe(true);

    const state = useLyricsStore.getState();
    expect(state.contentMode).toBe('bible');
    expect(state.selectedLine).toBe(0);
    expect(state.lyrics[0]).toContain('For God so loved the world');
    expect(socket.emitBibleVerseLoaded).toHaveBeenCalledTimes(1);
    expect(socket.emitBibleVerseLoaded.mock.calls[0][0].reference).toBe('John 3:16');
    // The server fans everything else out of that one event: emit nothing else.
    expect(socket.emitLineUpdate).not.toHaveBeenCalled();
    expect(socket.emitIndividualOutputToggle).not.toHaveBeenCalled();

    expect(sendVerseLive(null)).toBe(false);
    expect(sendVerseLive({})).toBe(false);
  });

  it('stageVerseInPanel stages the reference without loading it', () => {
    const verse = { book: 'John', chapter: 3, verse: 16, endVerse: null, reference: 'John 3:16' };
    expect(stageVerseInPanel(verse)).toBe(true);

    expect(useBibleStore.getState().activeReference).toMatchObject({
      id: 'kjv',
      book: 43,
      chapters: ['3'],
      verses: [[16]],
    });
    expect(useBibleStore.getState().selectedVerses).toEqual([[16]]);
    // Nothing on any output moved: no contentMode, no lyrics, no announcement.
    expect(useLyricsStore.getState().contentMode).toBe('song');
    expect(useLyricsStore.getState().lyrics).toEqual(LYRICS);
    expect(socket.emitBibleVerseLoaded).not.toHaveBeenCalled();
    expect(socket.emitIndividualOutputToggle).not.toHaveBeenCalled();

    // A reference with no such book here is refused rather than half-staged.
    expect(stageVerseInPanel({ book: 'Obadiah', chapter: 1, verse: 1 })).toBe(false);
  });

  it('enableStageOutput routes the Stage output and only the Stage output', () => {
    expect(useLyricsStore.getState().stageEnabled).toBe(false);
    expect(enableStageOutput()).toBe(true);
    expect(useLyricsStore.getState().stageEnabled).toBe(true);
    expect(socket.emitIndividualOutputToggle).toHaveBeenCalledWith({
      output: 'stage',
      enabled: true,
    });
    expect(socket.emitBibleVerseLoaded).not.toHaveBeenCalled();
    expect(useLyricsStore.getState().contentMode).toBe('song');
  });

  it('sendSermonNote lands the existing freeNotesDrafts shape', () => {
    let note = createSermonNote({ now: 1000 });
    note = appendFinalSegment(note, segment('Blessed assurance Jesus is mine'), { now: 1001 });

    expect(sendSermonNote(note)).toBe(true);
    const drafts = useLyricsStore.getState().freeNotesDrafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ id: note.id, title: 'Sermon Note' });
    expect(drafts[0].content).toBe('Blessed assurance Jesus is mine');

    // A draft save is not a projection.
    expect(useLyricsStore.getState().contentMode).toBe('song');
    expect(socket.emitBibleVerseLoaded).not.toHaveBeenCalled();
    expect(socket.emitLineUpdate).not.toHaveBeenCalled();

    expect(sendSermonNote(null)).toBe(false);
    expect(useLyricsStore.getState().freeNotesDrafts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// verse helpers + the hotkey fallback
// ---------------------------------------------------------------------------

describe('verse helpers', () => {
  it('verseNumberList expands ranges and rejects nonsense', () => {
    expect(verseNumberList({ verse: 16 })).toEqual([16]);
    expect(verseNumberList({ verse: 16, endVerse: 18 })).toEqual([16, 17, 18]);
    expect(verseNumberList({})).toEqual([]);
    expect(verseNumberList(null)).toEqual([]);
  });

  it('formatVerseReference renders the label the card and the output both use', () => {
    expect(formatVerseReference('John', 3, [16])).toBe('John 3:16');
    expect(formatVerseReference('John', 3, [16, 17, 18])).toBe('John 3:16-18');
    expect(formatVerseReference('John', 3, [])).toBe('John 3');
  });

  it('findBibleBook matches canonical names case- and punctuation-insensitively', () => {
    expect(findBibleBook(KJV, 'john').name).toBe('John');
    expect(findBibleBook(KJV, '1 John')).toBeNull();
    expect(findBibleBook(null, 'John')).toBeNull();
  });

  it('translationOptionsFor lists only translations that actually carry the verse', () => {
    const options = translationOptionsFor(
      { book: 'John', chapter: 3, verse: 16 },
      { bibles: { kjv: KJV }, bibleMetadata: { kjv: { name: 'KJV' } }, activeBibleId: 'kjv' }
    );
    expect(options).toHaveLength(1);
    expect(options[0].bibleName).toBe('KJV');
    expect(options[0].text).toContain('only begotten Son');

    expect(translationOptionsFor({ book: 'Obadiah', chapter: 1, verse: 1 }, { bibles: { kjv: KJV } })).toEqual([]);
    expect(translationOptionsFor(null, { bibles: { kjv: KJV } })).toEqual([]);
  });
});

describe('resolveToggleCombo', () => {
  it('prefers the live binding and falls back to the shipped default', () => {
    expect(resolveToggleCombo({ toggleSermonAssist: 'Mod+Shift+K' })).toBe('Mod+Shift+K');
    expect(resolveToggleCombo({})).toBe(DEFAULT_BINDINGS.toggleSermonAssist);
    expect(resolveToggleCombo(undefined)).toBe(DEFAULT_BINDINGS.toggleSermonAssist);
    expect(resolveToggleCombo({ toggleSermonAssist: '' })).toBe(DEFAULT_BINDINGS.toggleSermonAssist);
    expect(DEFAULT_BINDINGS.toggleSermonAssist).toBe('Mod+Shift+A');
  });
});
