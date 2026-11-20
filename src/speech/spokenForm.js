// src/speech/spokenForm.js — spoken-form normalisation (plan 11, detector 1)
//
// "A pure function converts number words to digits and ordinals to book
//  numbers, then feeds the reference regex that already exists at
//  shared/bible/index.js:148 (REFERENCE_REGEX)."
//
// Examples from the plan, all handled here or by detectVerse on top of it:
//   "John chapter three verse sixteen"  -> "John 3:16"
//   "first Peter five"                  -> "1 Peter 5"
//   "forty two"                         -> "42"
//   "Psalms twenty three"               -> "Psalm 23"   (the ":1" comes from
//      the chapter-only rule in detectVerse; the plural fix is detector 2's
//      confusion table, not this normaliser's job)
//   "sixteen through eighteen"          -> "16-18"
//   "the book of John three verse sixteen" -> "John 3:16"  ("the book of"
//      stripped FIRST, never after)
//
// Pure: takes text, returns text. No I/O, no logging, no store reads.

import { REFERENCE_REGEX } from 'shared/bible';
import { stripBookPrefix } from 'shared/bible/bookAliases.js';
import { dictionaryFor } from 'shared/speech/numberDictionary.js';

/**
 * The number vocabulary is now per-locale (Phase 3), but the PARSING is not.
 *
 * `wordsToDigits` below is the same state machine it always was — units, tens,
 * scales, ordinals, the "two numbers in a row" rule. All that changed is where
 * the lookup tables come from. A new language is therefore a data change in
 * shared/speech/numberDictionary.js, not a new parser, and the English
 * behaviour is byte-identical to before because the English vocabulary was
 * moved verbatim rather than retyped.
 */

/**
 * Strip edge punctuation and lower-case a token for dictionary lookup.
 *
 * ACCENTS ARE PRESERVED. The old version stripped to `[a-z0-9]`, which silently
 * deleted the accented characters in "trois" no — but in "treize", "quatorze",
 * "cinquième" and every other accented form, leaving a mangled key that could
 * never match. Stripping punctuation while keeping letters means a French or
 * German token is looked up as the user actually typed it.
 */
function bare(token) {
  return String(token)
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '');
}

/**
 * Split whitespace tokens, breaking letter-hyphen-letter compounds
 * ("twenty-three") into separate words while leaving digit ranges
 * ("16-18") and already-digit references ("3:16") untouched.
 */
function tokenizeWords(text) {
  const out = [];
  for (const token of String(text ?? '').split(/\s+/)) {
    if (!token) continue;
    // Unicode letter classes, not [a-zA-Z]. The old pattern could not see an
    // accented compound at all, so "vingt-et-un" stayed one token and never
    // parsed. \p{L} covers every alphabet this module ships a dictionary for.
    if (/^[\p{L}]+(?:-[\p{L}]+)+$/u.test(token)) {
      out.push(...token.split('-'));
    } else {
      out.push(token);
    }
  }
  return out;
}

/**
 * The spoken KEYWORDS (verse / chapter / range) for a locale.
 *
 * NOT part of numberDictionary.js, because these are not numbers — they are
 * the words that mark a citation. They live here, next to the only function
 * that rewrites them, so there is exactly one place where a language's spoken
 * citation vocabulary is described.
 *
 * Keys are the same locale codes as the number dictionary. English is the
 * fallback, so an unknown locale keeps the previous behaviour rather than
 * losing citation detection entirely.
 */
const SPOKEN_KEYWORDS = Object.freeze({
  en: {
    verse: ['verse', 'v'],
    versePlural: ['verses'],
    range: ['through', 'thru', 'till', 'until', 'to'],
    chapter: ['chapter', 'chap'],
  },
  fr: {
    verse: ['verset'],
    versePlural: ['versets'],
    range: ['à', 'au', 'jusqu'],
    chapter: ['chapitre'],
  },
  es: {
    verse: ['versículo', 'versiculo'],
    versePlural: ['versículos', 'versiculos'],
    range: ['hasta', 'a'],
    chapter: ['capítulo', 'capitulo'],
  },
  de: {
    verse: ['vers'],
    versePlural: ['verse'],
    range: ['bis'],
    chapter: ['kapitel'],
  },
  pt: {
    verse: ['versículo', 'versiculo'],
    versePlural: ['versículos', 'versiculos'],
    range: ['até', 'ate', 'a'],
    chapter: ['capítulo', 'capitulo'],
  },
  it: {
    verse: ['versetto'],
    versePlural: ['versetti'],
    range: ['fino', 'a'],
    chapter: ['capitolo'],
  },
  nl: {
    verse: ['vers'],
    versePlural: ['verzen'],
    range: ['tot'],
    chapter: ['hoofdstuk'],
  },
  no: {
    verse: ['vers'],
    versePlural: ['vers'],
    range: ['til', 'til'],
    chapter: ['kapittel'],
  },
});

/**
 * Build a regex-safe alternation from a locale's keyword list.
 *
 * SORTED LONGEST-FIRST. Without this, a language containing both "vers" and
 * "verset" would match "vers" inside "verset" and leave "et" behind — turning
 * "Jean chapitre 3 verset 16" into "Jean chapitre 3 vers et 16". Sorting makes
 * the longest alternative win the alternation.
 *
 * The empty case returns `(?!)`, a pattern that can never match, rather than an
 * empty string — which would build a regex matching everything.
 *
 * @param {string|null|undefined} locale
 * @param {'verse'|'versePlural'|'range'|'chapter'} field which keyword list
 * @returns {string} an alternation body, safe to embed in a larger regex
 */
function localeKeywords(locale, field) {
  const base = String(locale ?? '').trim().toLowerCase().split(/[-_]/)[0];
  const table = SPOKEN_KEYWORDS[base] || SPOKEN_KEYWORDS.en;
  const list = table[field] || SPOKEN_KEYWORDS.en[field] || [];

  const unique = [...new Set(list)]
    .filter((word) => typeof word === 'string' && word.length > 0)
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (unique.length === 0) return '(?!)';
  return unique.join('|');
}

/**
 * Convert English number words to digits, in place, preserving every other
 * token. Handles compounds ("twenty three"), hundreds/thousands
 * ("two hundred and twenty one" -> 221), ordinals ("first" -> 1,
 * "twenty first" -> 21), and leaves digits exactly as they were.
 *
 * @param {string} text
 * @returns {string} the text with number words replaced by digits
 */
export function wordsToDigits(text, locale) {
  const {
    cardinals: CARDINALS,
    ordinals: ORDINALS,
    scales: SCALES,
    joiners,
    tensJoiners = [],
  } = dictionaryFor(locale);

  const isNumberWord = (word) =>
    Object.prototype.hasOwnProperty.call(CARDINALS, word) ||
    Object.prototype.hasOwnProperty.call(ORDINALS, word) ||
    Object.prototype.hasOwnProperty.call(SCALES, word);

  const tokens = tokenizeWords(text);
  const out = [];
  let total = 0;
  let current = 0;
  let inNumber = false;
  let afterScale = false; // last number word was hundred/thousand/million
  let afterTens = false; // last number word was a tens word (twenty..ninety)
  let openUnit = false; // the open number ENDS with a unit word (< 20)

  const flush = () => {
    if (inNumber) {
      out.push(String(total + current));
      total = 0;
      current = 0;
      inNumber = false;
      afterScale = false;
      afterTens = false;
      openUnit = false;
    }
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const word = bare(token);
    const nextIsNumber = i + 1 < tokens.length && isNumberWord(bare(tokens[i + 1]));

    // TWO JOINER RULES, because two languages need them.
    //
    //   joiners     fires after a SCALE — English "two hundred AND twenty one".
    //   tensJoiners fires after a TENS  — French "vingt ET un", Portuguese
    //                "vinte E um". English has none, because it writes
    //                twenty-one with a hyphen.
    //
    // Without the second rule "vingt-et-un" parsed as "20 et 1" — two numbers
    // where the preacher said one. Getting this wrong produces a wrong
    // reference, which is the failure mode this whole module exists to avoid.
    if (
      nextIsNumber &&
      inNumber &&
      ((joiners.includes(word) && afterScale) || (tensJoiners.includes(word) && afterTens))
    ) {
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(CARDINALS, word)) {
      const value = CARDINALS[word];
      const isUnit = value < 20; // not a tens word (twenty..ninety) or scale
      // Two unit words in a row are TWO numbers, not one: "philippians four
      // seven" is chapter 4 verse 7, and "corinthian five sixteen" is 5:16.
      // Only a tens/scale opener lets a unit continue the same number
      // ("twenty three" -> 23, "one hundred fifteen" -> 115).
      if (inNumber && openUnit && isUnit) flush();
      current += value;
      inNumber = true;
      afterScale = false;
      // A tens word is 20-90: the range where a language may put a joiner
      // before a unit ("vingt et un" = 21). Units and scales clear it.
      afterTens = value >= 20 && value < 100;
      openUnit = isUnit;
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(ORDINALS, word)) {
      // An ordinal closes the number: "first" -> 1, "twenty first" -> 21.
      const value = (inNumber ? total + current : 0) + ORDINALS[word];
      total = 0;
      current = 0;
      inNumber = false;
      afterScale = false;
      afterTens = false;
      openUnit = false;
      out.push(String(value));
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(SCALES, word)) {
      const scale = SCALES[word];
      // "hundred" is special in English ("two hundred" = 200) but the rule is
      // the same in every language: a bare scale word means one of it.
      if (scale === 100) {
        current = (current === 0 ? 1 : current) * scale;
      } else {
        total += (current === 0 ? 1 : current) * scale;
        current = 0;
      }
      inNumber = true;
      afterScale = true;
      afterTens = false;
      openUnit = false;
      continue;
    }

    flush();
    out.push(token);
  }
  flush();
  return out.join(' ');
}

/**
 * Remove a leading "the book of" phrase. Re-exported from the confusion
 * table so callers only need this module; kept as its own named step
 * because the plan insists the strip happens BEFORE matching.
 */
export { stripBookPrefix };

/**
 * The full spoken-form normalisation pipeline, in the order the plan
 * specifies:
 *
 *   1. strip "the book of"        (before anything matches)
 *   2. number words -> digits     ("chapter three" -> "chapter 3")
 *   3. spoken ranges -> "-"       ("sixteen through eighteen" -> "16-18")
 *   4. "chapter"/"verse" words -> reference punctuation
 *      ("John 3 verse 16" -> "John 3:16")
 *
 * Already-digit references pass through unchanged; prose passes through
 * unchanged (detectVerse then finds no reference and returns null).
 *
 * @param {string} text
 * @param {string} [locale] UI locale for the spoken vocabulary (Phase 3).
 *   Words that mark a range ("through", "bis", "hasta") and the "verse" /
 *   "chapter" keywords are language-specific too, so the whole normalization
 *   is locale-aware rather than just the number words.
 * @returns {string} normalised text ready for REFERENCE_REGEX
 */
export function normalizeSpokenReference(text, locale) {
  const stripped = stripBookPrefix(text);
  const numbered = wordsToDigits(stripped, locale);

  // The keywords this module rewrites, in every supported language. Built as
  // one alternation so a single replace handles them all — and built from
  // FIRST to LAST as written, then sorted longest-first at build time so
  // "kapittel" cannot be shadowed by a shorter prefix of itself.
  const keywords = {
    verse: localeKeywords(locale, 'verse'),
    versePlural: localeKeywords(locale, 'versePlural'),
    range: localeKeywords(locale, 'range'),
    chapter: localeKeywords(locale, 'chapter'),
  };

  const verseAlt = keywords.verse;
  const versePluralAlt = keywords.versePlural;
  const rangeAlt = keywords.range;
  const chapterAlt = keywords.chapter;

  const ranged = numbered
    // spoken range words between two numbers -> dash
    .replace(new RegExp(`(\\d+)\\s+(?:${rangeAlt})\\s+(\\d+)`, 'giu'), '$1-$2')
    // normalise dash variants between digits (en/em/minus -> hyphen)
    .replace(/(\d+)\s*[–—−]\s*(\d+)/g, '$1-$2')
    // collapse spaces around an existing digit range ("16 - 18" -> "16-18")
    .replace(/(\d+)\s+-\s+(\d+)/g, '$1-$2');

  return ranged
    // "3 verse 16" / "3, verse 16" / "3 verse 16-18" -> "3:16" /
    // "3:16-18". ASR punctuation puts a comma after the chapter; without
    // allowing it the verse keyword is treated as a bare ":16" and the
    // reference silently falls back to verse 1.
    .replace(
      new RegExp(`(\\d+)\\s*[,;.]?\\s*(?:${versePluralAlt}|${verseAlt})\\s*(\\d+)(?:\\s*-\\s*(\\d+))?`, 'giu'),
      (_m, chapter, start, end) => `${chapter}:${start}${end ? `-${end}` : ''}`
    )
    // a bare "verse 16" with no chapter -> ":16" (only useful mid-reference)
    .replace(
      new RegExp(`(?:${versePluralAlt}|${verseAlt})\\s+(\\d+)(?:\\s*-\\s*(\\d+))?`, 'giu'),
      (_m, start, end) => `:${start}${end ? `-${end}` : ''}`
    )
    // "chapter 3" (or "Kapitel 3") -> "3"
    .replace(new RegExp(`\\b(?:${chapterAlt})s?\\s+(?=\\d)`, 'giu'), '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Match REFERENCE_REGEX against the normalised text, anchored at the first
 * position where a resolvable book name begins. The regex is anchored
 * (`^`), so leading filler ("turn to John three", "in John 3:16") is
 * handled by retrying at each word start rather than by mangling the text.
 *
 * Returns the raw regex match parts, or null.
 */
export function matchReference(normalizedText, isKnownBook) {
  const text = String(normalizedText ?? '').trim();
  if (!text) return null;

  const starts = [0];
  for (let i = 1; i < text.length; i += 1) {
    if (/\s/.test(text[i - 1]) && !/\s/.test(text[i])) starts.push(i);
  }

  for (const start of starts) {
    const candidate = start === 0 ? text : text.slice(start);
    const match = candidate.match(REFERENCE_REGEX);
    if (!match) continue;
    if (isKnownBook(match[1])) return match;
  }
  return null;
}

/**
 * Parse a normalised reference into structured parts using
 * REFERENCE_REGEX (shared/bible/index.js:148).
 *
 * Reference shape from the regex:
 *   [1] book part   [2] chapter   [3] verse after : . or ,
 *   [4] verse after a space      [5] range end after -
 *
 * A chapter with no verse resolves to verse 1 — the plan's own example
 * ("Psalms twenty three" -> Psalm 23:1) establishes that convention.
 * A chapter span with no verse ("Psalm 23-24") keeps the chapter and drops
 * the range rather than inventing a verse span.
 *
 * @param {string} normalizedText
 * @param {(bookPart: string) => boolean} isKnownBook
 * @returns {{ bookPart: string, chapter: number, verse: number,
 *             endVerse: number|null } | null}
 */
export function parseReference(normalizedText, isKnownBook) {
  const match = matchReference(normalizedText, isKnownBook);
  if (!match) return null;

  const bookPart = match[1].trim();
  const chapter = Number.parseInt(match[2], 10);
  if (!bookPart || !Number.isFinite(chapter)) return null;

  const versePart = match[3] || match[4] || null;
  const rangeEnd = match[5] || null;

  if (versePart) {
    const verse = Number.parseInt(versePart, 10);
    const endVerse = rangeEnd ? Number.parseInt(rangeEnd, 10) : null;
    if (!Number.isFinite(verse)) return null;
    return { bookPart, chapter, verse, endVerse: Number.isFinite(endVerse) ? endVerse : null };
  }

  return { bookPart, chapter, verse: 1, endVerse: null };
}
