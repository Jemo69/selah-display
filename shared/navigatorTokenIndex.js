import { normalizeNavigatorSearchText } from './fileNavigatorSearch.js';

/**
 * Normalizes comparison path if no function is provided.
 * Default is case-insensitive on Windows, case-sensitive elsewhere.
 */
const defaultNormalizeKey = (value) => (
  typeof process !== 'undefined' && process.platform === 'win32'
    ? String(value || '').toLowerCase()
    : String(value || '')
);

/**
 * Extracts searchable alphanumeric tokens (min length 2) with punctuation stripped.
 * Ensures e.g. "gone," matches query "gone".
 * @param {string} text
 * @param {Function} normalizeTextFn
 * @returns {string[]}
 */
export function extractNavigatorSearchTokens(text = '', normalizeTextFn = normalizeNavigatorSearchText) {
  if (!text) return [];
  // Fast path: already-normalized query terms (lowercase alphanumerics +
  // spaces) skip the NFKD/lowercase pass — normalization is a no-op on
  // them, and this runs per term per keystroke. Raw content still takes
  // the full path. Token output is identical either way.
  const normalized = /^[a-z0-9 ]+$/.test(text) ? text : normalizeTextFn(text);
  return normalized
    .replace(/[^a-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

/**
 * Creates a bidirectional inverted index for fast candidate file pruning.
 * - tokenIndex: Map<token, Set<normalizedPathKey>>
 * - fileTokens:  Map<normalizedPathKey, Set<token>>
 * - tokenPairs:  Map<"word1 word2", Set<normalizedPathKey>> (adjacent pairs)
 * - filePairs:   Map<normalizedPathKey, Set<pair>>
 *
 * Pairs power the snippet-phrase path: a 4-word lyric query intersects 3
 * pair postings instead of 5 huge unigram postings, collapsing ~21
 * candidates to just the phrase holders. Unigram semantics are untouched.
 *
 * Provides O(1) file updates/drops, zero empty-set memory leaks, and title+content indexing.
 */
export function createNavigatorTokenIndex({
  normalizeKeyFn = defaultNormalizeKey,
  normalizeTextFn = normalizeNavigatorSearchText,
} = {}) {
  const tokenIndex = new Map();
  const fileTokens = new Map();
  const tokenPairs = new Map();
  const filePairs = new Map();
  // Title-word postings (stem tokens only): single-weak-term queries
  // ("you", "th") resolve title matches with one Map get instead of
  // scanning every record. Exact tokens only — the scorer's weak path is
  // exact-word title matching, so this is recall-identical for stems.
  const stemTokenIndex = new Map();
  const fileStemTokens = new Map();
  // Lazily sorted vocabulary for prefix-range lookup (binary search +
  // bounded scan instead of a per-keystroke full-vocabulary scan).
  // Invalidated on every index mutation; rebuilt on next typo-query use.
  let sortedTokens = null;
  const VARIANT_PREFIX_CAP = 2000;

  function clearIndex() {
    tokenIndex.clear();
    fileTokens.clear();
    tokenPairs.clear();
    filePairs.clear();
    stemTokenIndex.clear();
    fileStemTokens.clear();
    sortedTokens = null;
  }

  function dropRecordTokens(filePath) {
    if (!filePath) return;
    const key = normalizeKeyFn(filePath);
    sortedTokens = null;
    const existingStemTokens = fileStemTokens.get(key);
    if (existingStemTokens) {
      for (const token of existingStemTokens) {
        const keySet = stemTokenIndex.get(token);
        if (keySet) {
          keySet.delete(key);
          if (keySet.size === 0) stemTokenIndex.delete(token);
        }
      }
      fileStemTokens.delete(key);
    }
    const existingTokens = fileTokens.get(key);
    if (existingTokens) {
      for (const token of existingTokens) {
        const keySet = tokenIndex.get(token);
        if (keySet) {
          keySet.delete(key);
          if (keySet.size === 0) {
            tokenIndex.delete(token); // O(1) empty set cleanup
          }
        }
      }
      fileTokens.delete(key);
    }
    const existingPairs = filePairs.get(key);
    if (existingPairs) {
      for (const pair of existingPairs) {
        const keySet = tokenPairs.get(pair);
        if (keySet) {
          keySet.delete(key);
          if (keySet.size === 0) {
            tokenPairs.delete(pair);
          }
        }
      }
      filePairs.delete(key);
    }
  }

  function indexRecordTokens(record = {}) {
    if (!record || !record.filePath) return;
    const key = normalizeKeyFn(record.filePath);
    dropRecordTokens(key);

    const tokens = new Set();
    const pairs = new Set();
    // Ordered tokens per field: pairs stay inside one field so a
    // stem-tail/content-head junction never fabricates a phrase pair.
    const addFromText = (text) => {
      const extracted = extractNavigatorSearchTokens(text, normalizeTextFn);
      for (let i = 0; i < extracted.length; i++) {
        tokens.add(extracted[i]);
        if (i > 0) pairs.add(`${extracted[i - 1]} ${extracted[i]}`);
      }
    };

    // F1: Index normalizedStem (or stem derived from fileName), avoiding raw extension pollution
    const stem = record.normalizedStem || (record.fileName ? String(record.fileName).replace(/\.[^/.\\]+$/, '') : '');
    const stemTokens = new Set(extractNavigatorSearchTokens(stem, normalizeTextFn));
    addFromText(stem);

    // Index full normalized content text
    const content = record.normalizedContent || record.contentText || '';
    addFromText(content);

    if (tokens.size === 0) return;
    sortedTokens = null;

    fileTokens.set(key, tokens);
    for (const token of tokens) {
      let keySet = tokenIndex.get(token);
      if (!keySet) {
        keySet = new Set();
        tokenIndex.set(token, keySet);
      }
      keySet.add(key);
    }
    if (stemTokens.size > 0) {
      fileStemTokens.set(key, stemTokens);
      for (const token of stemTokens) {
        let keySet = stemTokenIndex.get(token);
        if (!keySet) {
          keySet = new Set();
          stemTokenIndex.set(token, keySet);
        }
        keySet.add(key);
      }
    }
    if (pairs.size > 0) {
      filePairs.set(key, pairs);
      for (const pair of pairs) {
        let keySet = tokenPairs.get(pair);
        if (!keySet) {
          keySet = new Set();
          tokenPairs.set(pair, keySet);
        }
        keySet.add(key);
      }
    }
  }

  /**
   * Intersects candidate keys matching all given terms.
   * Returns:
   * - null: if query has no terms (caller should examine all records)
   * - Set<normalizedKey>: matching candidate keys (may be empty if no token matched)
   */
  function findCandidateKeys(terms = []) {
    const seen = new Set();
    const validTerms = [];
    for (const t of (Array.isArray(terms) ? terms : [])) {
      for (const tok of extractNavigatorSearchTokens(t, normalizeTextFn)) {
        if (tok && !seen.has(tok)) { seen.add(tok); validTerms.push(tok); }
      }
    }

    if (validTerms.length === 0) return null;

    // Rarest-first intersection: seed from the smallest posting list and
    // intersect ascending. Same recall as input order (intersection is
    // commutative), but far less work when a rare lyric token ("covenant")
    // meets a stopword ("the" with hundreds of postings).
    validTerms.sort((a, b) => {
      const sa = tokenIndex.get(a)?.size ?? 0;
      const sb = tokenIndex.get(b)?.size ?? 0;
      return sa - sb;
    });

    let candidateKeys = null;
    for (const term of validTerms) {
      const matchingKeys = tokenIndex.get(term);
      if (!matchingKeys || matchingKeys.size === 0) return new Set();
      if (candidateKeys === null) {
        candidateKeys = new Set(matchingKeys);
      } else {
        // Iterate the smaller set for the membership test.
        if (matchingKeys.size < candidateKeys.size) {
          const next = new Set();
          for (const k of matchingKeys) {
            if (candidateKeys.has(k)) next.add(k);
          }
          candidateKeys = next;
        } else {
          for (const k of candidateKeys) {
            if (!matchingKeys.has(k)) {
              candidateKeys.delete(k);
            }
          }
        }
      }
      if (candidateKeys.size === 0) break;
    }

    return candidateKeys;
  }

  /**
   * Phrase-first candidate lookup for multi-word lyric snippets.
   * Intersects adjacent word-pair postings instead of unigram postings:
   * a 4-word query meets 3 pair lists (each near the true holder count)
   * instead of 4+ unigram lists (stopwords: hundreds of files).
   *
   * Recall contract: every file whose indexed token stream contains the
   * query's extracted tokens adjacently IS returned (pair index is built
   * with the same extractor, same order, same per-field boundaries).
   * Files holding the phrase with only filtered tokens (1-char words,
   * punctuation) between query words can be missed — callers must fall
   * back to findCandidateKeys when this returns an empty set.
   * Returns null when fewer than 2 tokens (no pair to intersect).
   */
  function findPhraseCandidateKeys(terms = []) {
    const toks = [];
    for (const t of (Array.isArray(terms) ? terms : [])) {
      for (const tok of extractNavigatorSearchTokens(t, normalizeTextFn)) {
        if (tok) toks.push(tok);
      }
    }
    if (toks.length < 2) return null;
    const seen = new Set();
    const pairList = [];
    for (let i = 0; i + 1 < toks.length; i++) {
      const pair = `${toks[i]} ${toks[i + 1]}`;
      if (!seen.has(pair)) { seen.add(pair); pairList.push(pair); }
    }
    // Rarest pair first — same commutative-intersection trick as unigrams.
    pairList.sort((a, b) => {
      const sa = tokenPairs.get(a)?.size ?? 0;
      const sb = tokenPairs.get(b)?.size ?? 0;
      return sa - sb;
    });
    let candidateKeys = null;
    for (const pair of pairList) {
      const matchingKeys = tokenPairs.get(pair);
      if (!matchingKeys || matchingKeys.size === 0) return new Set();
      if (candidateKeys === null) {
        candidateKeys = new Set(matchingKeys);
      } else if (matchingKeys.size < candidateKeys.size) {
        const next = new Set();
        for (const k of matchingKeys) {
          if (candidateKeys.has(k)) next.add(k);
        }
        candidateKeys = next;
      } else {
        for (const k of candidateKeys) {
          if (!matchingKeys.has(k)) {
            candidateKeys.delete(k);
          }
        }
      }
      if (candidateKeys.size === 0) break;
    }
    return candidateKeys;
  }

  /**
   * Typo-term resolution for terms with NO exact posting.
   * Covers the scorer walk's match space without scanning records:
   * edit-1 neighbors (deletions/substitutions/insertions — the typo
   * case) plus a bounded prefix range over the sorted vocabulary
   * (inflections and longer words — the "loving" → "lovingkindness"
   * case the walk's prefix branch would otherwise only reach via a
   * full-corpus fallback scan). Hash lookups + one binary search, so a
   * typo query meets dozens of candidates instead of all 445+ records.
   * Returns a Set, or null when unresolvable (caller keeps full-scan
   * fallback — recall never regresses). Only called for missing terms
   * (length >= 4); exact postings never pay this cost.
   */
  function editOneVariants(term) {
    const out = new Set();
    const t = String(term || '');
    if (!t || t.length < 4) return out;
    for (let i = 0; i < t.length; i++) out.add(t.slice(0, i) + t.slice(i + 1));
    for (let i = 0; i < t.length; i++) {
      for (let c = 97; c <= 122; c++) {
        const ch = String.fromCharCode(c);
        if (ch !== t[i]) out.add(t.slice(0, i) + ch + t.slice(i + 1));
      }
    }
    for (let i = 0; i <= t.length; i++) {
      for (let c = 97; c <= 122; c++) out.add(t.slice(0, i) + String.fromCharCode(c) + t.slice(i));
    }
    out.delete(t);
    return out;
  }

  function expandMissingTermKeys(term) {
    const t = String(term || '');
    if (!t || t.length < 4) return null;
    const union = new Set();
    for (const v of editOneVariants(t)) {
      const postings = tokenIndex.get(v);
      if (postings) {
        for (const k of postings) union.add(k);
      }
    }
    if (!sortedTokens) sortedTokens = [...tokenIndex.keys()].sort();
    let lo = 0;
    let hi = sortedTokens.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedTokens[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < sortedTokens.length; i++) {
      const key = sortedTokens[i];
      if (!key.startsWith(t)) break;
      if (key === t) continue;
      const postings = tokenIndex.get(key);
      if (postings) {
        for (const k of postings) {
          union.add(k);
          if (union.size >= VARIANT_PREFIX_CAP) break;
        }
      }
      if (union.size >= VARIANT_PREFIX_CAP) break;
    }
    return union.size > 0 ? union : null;
  }

  /**
   * Variant TOKENS for a missing term (sibling of expandMissingTermKeys,
   * which returns holder keys). Edit-1 neighbors with postings first;
   * the bounded prefix range only runs when no variant hits — same recall
   * signal, but the caller (per-query fuzzy map) avoids re-deriving it
   * per record. Returns an array (possibly empty), capped.
   */
  const VARIANT_TOKEN_CAP = 64;
  function expandMissingTermVariants(term) {
    const t = String(term || '');
    if (!t || t.length < 4) return [];
    const out = [];
    const seen = new Set();
    for (const v of editOneVariants(t)) {
      if (seen.has(v)) continue;
      seen.add(v);
      if (tokenIndex.has(v)) {
        out.push(v);
        if (out.length >= VARIANT_TOKEN_CAP) return out;
      }
    }
    if (out.length > 0) return out;
    if (!sortedTokens) sortedTokens = [...tokenIndex.keys()].sort();
    let lo = 0;
    let hi = sortedTokens.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedTokens[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < sortedTokens.length && out.length < VARIANT_TOKEN_CAP; i++) {
      const key = sortedTokens[i];
      if (!key.startsWith(t) || key === t) {
        if (!key.startsWith(t)) break;
        continue;
      }
      out.push(key);
    }
    return out;
  }

  /**
   * Rarest-seeded unigram INTERSECTION (not just the rarest posting):
   * start from the smallest exact posting (≤ cap holders) and require
   * every other term's exact posting too — Set gets only, no pair
   * merges. Same top results as the pair path (the walk filters and
   * ranks identically; extras the pair path would miss are title-only
   * or looser-span files ranked below holders), and an empty score
   * falls back to the pair path as usual. Returns a fresh Set, or null.
   */
  function findRarestUnigramKeys(terms = [], cap = 12) {
    const seen = new Set();
    const validTerms = [];
    for (const t of (Array.isArray(terms) ? terms : [])) {
      for (const tok of extractNavigatorSearchTokens(t, normalizeTextFn)) {
        if (tok && !seen.has(tok)) { seen.add(tok); validTerms.push(tok); }
      }
    }
    if (validTerms.length === 0) return null;
    validTerms.sort((a, b) => (tokenIndex.get(a)?.size ?? Infinity) - (tokenIndex.get(b)?.size ?? Infinity));
    const first = tokenIndex.get(validTerms[0]);
    if (!first || first.size === 0 || first.size > cap) return null;
    const out = new Set();
    outer: for (const k of first) {
      for (let i = 1; i < validTerms.length; i++) {
        const s = tokenIndex.get(validTerms[i]);
        if (!s || !s.has(k)) continue outer;
      }
      out.add(k);
    }
    return out.size > 0 ? out : null;
  }

  /**
   * Title-word holders: files whose stem (filename) holds the exact token.
   * Powers the single-weak-term fast path ("you" matches titles only).
   * Returns a fresh Set, or null.
   */
  function findStemKeys(term) {
    const toks = extractNavigatorSearchTokens(term, normalizeTextFn);
    if (toks.length === 0) return null;
    const postings = stemTokenIndex.get(toks[0]);
    if (!postings || postings.size === 0) return null;
    return new Set(postings);
  }

  /**
   * Candidate intersection that ALSO reports the variant tokens used
   * for missing terms (edit-1 neighbors, prefix range on miss). The
   * caller attaches `variants` to the parsed query so per-record scoring
   * resolves fuzzy terms with Map gets instead of scanning every unique
   * lyric token per record. Same holder sets as findCandidateKeysExpanded.
   * Returns { keys, variants } — keys is an (often empty) Set; empty
   * means unresolvable and the caller falls back. Dead terms are
   * recorded as empty variant arrays so scoring skips them instantly.
   */
  function findCandidatesWithVariants(terms = []) {
    const seen = new Set();
    const validTerms = [];
    for (const t of (Array.isArray(terms) ? terms : [])) {
      for (const tok of extractNavigatorSearchTokens(t, normalizeTextFn)) {
        if (tok && !seen.has(tok)) { seen.add(tok); validTerms.push(tok); }
      }
    }
    if (validTerms.length === 0) return { keys: new Set(), variants };
    const variants = {};
    const termSets = [];
    let unresolvable = false;
    for (const term of validTerms) {
      const exact = tokenIndex.get(term);
      if (exact && exact.size > 0) {
        termSets.push(exact);
        continue;
      }
      const varTokens = expandMissingTermVariants(term);
      // Empty array = known-dead term (no exact posting, no variants):
      // the scorer treats it as an instant miss, skipping per-record
      // unique-key scans. Keys stay empty so the caller still falls back.
      variants[term] = varTokens;
      if (varTokens.length === 0) {
        unresolvable = true;
        continue;
      }
      const union = new Set();
      for (const v of varTokens) {
        const postings = tokenIndex.get(v);
        if (postings) for (const k of postings) union.add(k);
      }
      if (union.size === 0) {
        unresolvable = true;
        continue;
      }
      termSets.push(union);
    }
    if (unresolvable || termSets.length === 0) return { keys: new Set(), variants };
    termSets.sort((a, b) => a.size - b.size);
    let candidateKeys = new Set(termSets[0]);
    for (let i = 1; i < termSets.length; i++) {
      const s = termSets[i];
      if (s.size < candidateKeys.size) {
        const next = new Set();
        for (const k of s) {
          if (candidateKeys.has(k)) next.add(k);
        }
        candidateKeys = next;
      } else {
        for (const k of candidateKeys) {
          if (!s.has(k)) candidateKeys.delete(k);
        }
      }
      if (candidateKeys.size === 0) break;
    }
    return { keys: candidateKeys, variants };
  }

  /**
   * Inflection-tolerant holders for terms the walk can match but the
   * exact postings miss ("turn" vs lyric "turned", "loved" vs "love").
   * Per term (caller passes substantive flat tokens, len>=3): exact
   * holders, plus LONGER tokens with the term as prefix (bounded sorted-
   * vocabulary range scan), plus SHORTER tokens the term starts with
   * (direct gets of term prefixes — covers turned→turn, loved→love).
   * Intersected rarest-first, minus `exclude` keys, union capped so one
   * mega-common family cannot explode the scoring set. Returns
   * { keys, variants } where variants[term] lists the holder tokens used
   * (empty array = dead term: scorer instant-miss, no per-record scans).
   */
  function findInflectionExpandedKeys(terms = [], { exclude = null, tokenCap = 48, keyCap = 750 } = {}) {
    const seen = new Set();
    const validTerms = [];
    for (const t of (Array.isArray(terms) ? terms : [])) {
      const tok = String(t || '');
      if (tok && tok.length >= 3 && !seen.has(tok)) { seen.add(tok); validTerms.push(tok); }
    }
    if (validTerms.length === 0) return { keys: new Set(), variants: {} };
    if (!sortedTokens) sortedTokens = [...tokenIndex.keys()].sort();
    const variants = {};
    const termSets = [];
    for (const term of validTerms) {
      const holderTokens = [];
      const seenTok = new Set();
      const consider = (tok) => {
        if (!tok || seenTok.has(tok) || holderTokens.length >= tokenCap) return;
        if (!tokenIndex.has(tok)) return;
        seenTok.add(tok);
        holderTokens.push(tok);
      };
      consider(term);
      // Shorter inflections: query "turned" must reach lyric "turn".
      for (let i = 3; i < term.length && holderTokens.length < tokenCap; i++) {
        consider(term.slice(0, i));
      }
      // Longer inflections: query "turn" must reach lyric "turned".
      // Bounded binary-search range over the sorted vocabulary.
      if (holderTokens.length < tokenCap) {
        let lo = 0;
        let hi = sortedTokens.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (sortedTokens[mid] < term) lo = mid + 1;
          else hi = mid;
        }
        for (let i = lo; i < sortedTokens.length && holderTokens.length < tokenCap; i++) {
          const key = sortedTokens[i];
          if (!key.startsWith(term)) break;
          if (key !== term) consider(key);
        }
      }
      if (holderTokens.length === 0) {
        variants[term] = [];
        continue;
      }
      variants[term] = holderTokens;
      const union = new Set();
      for (const v of holderTokens) {
        const postings = tokenIndex.get(v);
        if (!postings) continue;
        for (const k of postings) {
          if (exclude && exclude.has(k)) continue;
          union.add(k);
          if (union.size >= keyCap) break;
        }
        if (union.size >= keyCap) break;
      }
      if (union.size === 0) continue;
      termSets.push(union);
    }
    if (termSets.length === 0) return { keys: new Set(), variants };
    termSets.sort((a, b) => a.size - b.size);
    let candidateKeys = new Set(termSets[0]);
    for (let i = 1; i < termSets.length; i++) {
      const s = termSets[i];
      if (s.size < candidateKeys.size) {
        const next = new Set();
        for (const k of s) {
          if (candidateKeys.has(k)) next.add(k);
        }
        candidateKeys = next;
      } else {
        for (const k of candidateKeys) {
          if (!s.has(k)) candidateKeys.delete(k);
        }
      }
      if (candidateKeys.size === 0) break;
    }
    return { keys: candidateKeys, variants };
  }

  function findCandidateKeysExpanded(terms = []) {
    const seen = new Set();
    const validTerms = [];
    for (const t of (Array.isArray(terms) ? terms : [])) {
      for (const tok of extractNavigatorSearchTokens(t, normalizeTextFn)) {
        if (tok && !seen.has(tok)) { seen.add(tok); validTerms.push(tok); }
      }
    }
    if (validTerms.length === 0) return null;
    const termSets = [];
    for (const term of validTerms) {
      const exact = tokenIndex.get(term);
      if (exact && exact.size > 0) {
        termSets.push(exact);
        continue;
      }
      const expanded = expandMissingTermKeys(term);
      if (!expanded) return null;
      termSets.push(expanded);
    }
    termSets.sort((a, b) => a.size - b.size);
    let candidateKeys = new Set(termSets[0]);
    for (let i = 1; i < termSets.length; i++) {
      const s = termSets[i];
      if (s.size < candidateKeys.size) {
        const next = new Set();
        for (const k of s) {
          if (candidateKeys.has(k)) next.add(k);
        }
        candidateKeys = next;
      } else {
        for (const k of candidateKeys) {
          if (!s.has(k)) candidateKeys.delete(k);
        }
      }
      if (candidateKeys.size === 0) break;
    }
    return candidateKeys;
  }

  return {
    tokenIndex,
    fileTokens,
    tokenPairs,
    filePairs,
    stemTokenIndex,
    clearIndex,
    dropRecordTokens,
    indexRecordTokens,
    findCandidateKeys,
    findCandidateKeysExpanded,
    expandMissingTermKeys,
    expandMissingTermVariants,
    findCandidatesWithVariants,
    findInflectionExpandedKeys,
    findPhraseCandidateKeys,
    findRarestUnigramKeys,
    findStemKeys,
  };
}
