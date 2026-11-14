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
    sortedTokens = null;
  }

  function dropRecordTokens(filePath) {
    if (!filePath) return;
    const key = normalizeKeyFn(filePath);
    sortedTokens = null;
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
   * Unigram intersection with typo-term expansion. Per term: exact
   * postings, else edit-1/prefix expansion, else null (= unresolvable:
   * caller keeps the full-scan fallback, so recall never regresses vs
   * the old intersect-then-scan behavior). Rarest-first intersection.
   * Returns null only when a term is unresolvable or there are no terms.
   */
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
    clearIndex,
    dropRecordTokens,
    indexRecordTokens,
    findCandidateKeys,
    findCandidateKeysExpanded,
    expandMissingTermKeys,
    findPhraseCandidateKeys,
  };
}
