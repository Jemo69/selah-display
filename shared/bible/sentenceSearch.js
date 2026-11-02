// shared/bible/sentenceSearch.js — experimental sentence-first ranking
//
// Why this exists: the default searchBible() intersects per-word postings.
// A 4-word sentence like "for God so love the world" then scores verses that
// contain ANY of those words almost as highly as the verse that contains the
// whole sentence. Operators typing a sentence expect the sentence, not OR.
//
// Experimental rules (additive, behind a flag — old path untouched):
//   1. Reference queries ("isa 44 5", "John 3:16") bypass sentence ranking.
//   2. Exact normalized phrase substring wins (+2000).
//   3. Otherwise require ORDERED coverage: content words must appear in order
//      with a tight span. Scattered single-word hits are filtered, not ranked.
//   4. Fuzzy tolerance: love≈loved (prefix), word≈world (edit distance 1).
//   5. No vocabulary-wide prefix scan (the slow Object.keys loop in the old
//      path). Only exact + plural-variant postings are intersected, then
//      reranked — O(candidates), not O(vocab).

export const SENTENCE_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'of', 'to', 'in', 'on',
  'at', 'by', 'for', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'am', 'it', 'its', 'this', 'that', 'these', 'those',
  'he', 'she', 'they', 'we', 'you', 'i', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'our', 'their', 'what', 'which', 'who', 'whom',
  'when', 'where', 'why', 'how', 'not', 'no', 'do', 'does', 'did', 'done',
  'have', 'has', 'had', 'will', 'would', 'shall', 'should', 'can', 'could',
  'may', 'might', 'must', 'there', 'here', 'out', 'up', 'down', 'off',
  'over', 'under', 'again', 'more', 'most', 'than', 'too', 'very', 'just',
  'about', 'all', 'any', 'each', 'some', 'such', 'only', 'own', 'same',
  'both', 'because', 'while', 'during', 'before', 'after', 'above', 'below',
  'between', 'also', 'unto', 'upon', 'ye', 'yea', 'oh',
]);

export function normalizeSentenceText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sentenceTokens(text = '') {
  const norm = normalizeSentenceText(text);
  if (!norm) return [];
  return norm.split(' ');
}

export function sentenceContentTokens(text = '') {
  const toks = sentenceTokens(text);
  const content = toks.filter((t) => t.length >= 3 && !SENTENCE_STOPWORDS.has(t));
  // Fall back to raw tokens when everything is a stopword ("to be", "of thee").
  if (content.length === 0) return toks.filter((t) => t.length > 0);
  return content;
}

// Small edit-distance for typo tolerance (word≈world, love≈loved is prefix).
// Bounded to len<32, max distance 1 — O(n*m) on tiny strings, no allocs.
export function withinEditOne(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === 0 || lb === 0) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else {
      edits += 1;
      if (edits > 1) return false;
      if (la === lb) {
        i += 1;
        j += 1;
      } else if (la > lb) {
        i += 1;
      } else {
        j += 1;
      }
    }
  }
  edits += la - i + (lb - j);
  return edits <= 1;
}

export function sentenceTokensMatch(queryTok, verseTok) {
  if (!queryTok || !verseTok) return false;
  if (queryTok === verseTok) return true;
  // Prefix both ways covers love/loved, god/godly, wine/wines.
  if (queryTok.length >= 4 && verseTok.length >= 4) {
    if (verseTok.startsWith(queryTok) || queryTok.startsWith(verseTok)) return true;
  }
  // Typo tolerance for 4+ char tokens: word≈world.
  if (queryTok.length >= 4 && verseTok.length >= 4) {
    return withinEditOne(queryTok, verseTok);
  }
  return false;
}

/**
 * Score one verse against a sentence query.
 * Returns null when the verse fails the sentence gate (single-word OR hit).
 */
function normalizeBookToken(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s/g, '')
    .replace(/\./g, '');
}

/**
 * Leading-position, EXACT-only book scope for sentence queries.
 *
 * The shared parseCombinedQuery() matches books anywhere in the query via
 * prefix/substring ("so"->Song, "in"->Corinthians, "a"->Amos), which
 * hijacks every sentence containing a function word and scopes the whole
 * search to one wrong book. References ("John 3:16", "isa 44 5") never
 * reach here — they resolve upstream. So a sentence query is only
 * book-scoped when it OPENS with an exact book name/abbreviation
 * ("John love", "Psalm shepherd", "1 Jn grace"). Returns
 * { book, rest } or null.
 */
export function matchLeadingBook(books, query) {
  if (!Array.isArray(books) || books.length === 0) return null;
  const tokens = String(query || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const exact = new Map();
  for (const book of books) {
    if (!book) continue;
    const name = normalizeBookToken(book.name);
    if (name) exact.set(name, book);
    const abbr = normalizeBookToken(book.abbreviation || '');
    if (abbr) exact.set(abbr, book);
  }
  for (let n = Math.min(3, tokens.length); n >= 1; n--) {
    const candidate = normalizeBookToken(tokens.slice(0, n).join(' '));
    if (!candidate) continue;
    const book = exact.get(candidate);
    if (book) {
      return { book, rest: tokens.slice(n).join(' ') };
    }
  }
  return null;
}

export function scoreSentenceVerse(queryNorm, queryContent, verseText) {
  const verseNorm = normalizeSentenceText(verseText);
  if (!verseNorm || !queryNorm) return null;
  const verseToks = verseNorm.split(' ').filter(Boolean);
  if (verseToks.length === 0 || queryContent.length === 0) return null;

  // 1. Exact phrase wins outright — cheapest check, C-level includes().
  if (verseNorm.includes(queryNorm)) {
    const lenPenalty = Math.log(1 + verseNorm.length) * 8;
    return {
      score: 2000 - lenPenalty,
      matched: queryContent.length,
      coverage: 1,
      phrase: true,
      ordered: true,
      span: queryNorm.length,
    };
  }

  // 2. Ordered coverage: walk verse tokens once, matching query tokens in order.
  //    versePos[q] = index in verseToks where q matched, or -1.
  let qi = 0;
  let firstPos = -1;
  let lastPos = -1;
  let matched = 0;
  // For each query token, find next matching verse token at/after cursor.
  let cursor = 0;
  for (let q = 0; q < queryContent.length; q += 1) {
    const qt = queryContent[q];
    let found = -1;
    for (let v = cursor; v < verseToks.length; v += 1) {
      if (sentenceTokensMatch(qt, verseToks[v])) {
        found = v;
        break;
      }
    }
    if (found === -1) continue;
    if (firstPos === -1) firstPos = found;
    lastPos = found;
    cursor = found + 1;
    matched += 1;
    // Keep order: only count in-order matches. Out-of-order tokens are skipped
    // (they simply don't increment matched), so scattered hits score low.
  }

  if (matched === 0) return null;

  const coverage = matched / queryContent.length;

  // Sentence gate: single-word OR hits are filtered, not ranked.
  //  - 1-token query: any match passes (same as old single-word path).
  //  - 2-token query: require both (or exact phrase above).
  //  - 3+ tokens: require >=60% coverage AND >=2 matched.
  if (queryContent.length === 1) {
    // pass
  } else if (queryContent.length === 2) {
    if (matched < 2) return null;
  } else {
    if (matched < 2 || coverage < 0.6) return null;
  }

  const span = firstPos === -1 ? verseToks.length : lastPos - firstPos + 1;
  // Tight span = sentence-like. Loose span = words scattered across a long verse.
  let orderBonus = 0;
  if (matched === queryContent.length) {
    // All content words in order.
    if (span <= queryContent.length + 2) orderBonus = 800;
    else if (span <= queryContent.length + 6) orderBonus = 400;
    else if (span <= queryContent.length + 12) orderBonus = 150;
    else orderBonus = 0;
  } else {
    // Partial coverage: still reward order, less.
    if (span <= queryContent.length + 4) orderBonus = 250;
    else if (span <= queryContent.length + 10) orderBonus = 80;
    else orderBonus = 0;
  }

  const lenPenalty = Math.log(1 + verseNorm.length) * 20;
  // Weight rare (long) words more: sum of matched token lengths.
  // Recompute cheaply: approximate by coverage * avg length 5.
  const score = coverage * 600 + orderBonus - lenPenalty;

  return { score, matched, coverage, phrase: false, ordered: orderBonus > 0, span };
}
