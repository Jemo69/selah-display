const QUERY_PART_PATTERN = /"([^"]+)"|(\S+)/g;

const TYPE_ALIASES = new Map([
  ['text', 'txt'],
  ['txt', 'txt'],
  ['lrc', 'lrc'],
  ['md', 'md'],
  ['markdown', 'md'],
  ['rtf', 'rtf'],
  ['doc', 'docx'],
  ['docx', 'docx'],
]);

export function normalizeNavigatorSearchText(value = '') {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseFileNavigatorQuery(value = '') {
  const terms = [];
  const fileTypes = new Set();
  const input = String(value || '').trim();
  let match;

  QUERY_PART_PATTERN.lastIndex = 0;
  while ((match = QUERY_PART_PATTERN.exec(input))) {
    const part = String(match[1] || match[2] || '').trim();
    const filterMatch = part.match(/^(?:ext|type):\.?([a-z0-9]+)$/i);
    if (filterMatch) {
      const normalizedType = TYPE_ALIASES.get(filterMatch[1].toLowerCase());
      if (normalizedType) fileTypes.add(normalizedType);
      continue;
    }

    const normalized = normalizeNavigatorSearchText(part);
    const clean = normalized.replace(/^[,.!?;:]+|[,.!?;:]+$/g, '');
    if (clean) terms.push(clean);
  }

  const compactTerms = terms.map((t) => t.replace(/\s+/g, ''));
  const phrase = terms.join(' ');
  return { input, terms, compactTerms, phrase, fileTypes: [...fileTypes] };
}

// Stopwords + single/double-char tokens carry no title signal on their own.
// Without this guard, a snippet like "as we worship You" matches the title
// "you are my strength when i am weak" via "we"->"weak" prefix and
// "as"->includes, outscoring the file whose LYRICS contain the phrase.
// Weak terms only count on exact word match, at low weight; the content
// phrase bonus below decides snippet queries.
const NAVIGATOR_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'it',
  'its', 'this', 'that', 'these', 'those', 'we', 'you', 'he', 'she',
  'they', 'them', 'his', 'her', 'our', 'your', 'my', 'me', 'him', 'us',
]);

function isWeakNavigatorTerm(term) {
  if (!term) return true;
  if (term.length <= 2) return true;
  return NAVIGATOR_STOPWORDS.has(term);
}

function isOrderedSubsequence(needle, haystack) {
  if (!needle || !haystack || needle.length < 3) return false;
  let needleIndex = 0;
  let firstMatch = -1;
  let lastMatch = -1;

  for (let index = 0; index < haystack.length && needleIndex < needle.length; index += 1) {
    if (haystack[index] !== needle[needleIndex]) continue;
    if (firstMatch < 0) firstMatch = index;
    lastMatch = index;
    needleIndex += 1;
  }

  if (needleIndex !== needle.length) return false;
  return lastMatch - firstMatch <= Math.max(needle.length * 2, needle.length + 4);
}

const EDIT_DISTANCE_MAX_LEN = 64;
const prevRowBuffer = new Int32Array(EDIT_DISTANCE_MAX_LEN);
const currRowBuffer = new Int32Array(EDIT_DISTANCE_MAX_LEN);

function boundedEditDistance(left, right, maximum) {
  const leftLen = left.length;
  const rightLen = right.length;
  if (Math.abs(leftLen - rightLen) > maximum) return maximum + 1;
  if (rightLen >= EDIT_DISTANCE_MAX_LEN || leftLen >= EDIT_DISTANCE_MAX_LEN) return maximum + 1;

  for (let j = 0; j <= rightLen; j++) prevRowBuffer[j] = j;

  for (let leftIndex = 1; leftIndex <= leftLen; leftIndex += 1) {
    currRowBuffer[0] = leftIndex;
    const leftCharCode = left.charCodeAt(leftIndex - 1);
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= rightLen; rightIndex += 1) {
      const substitutionCost = leftCharCode === right.charCodeAt(rightIndex - 1) ? 0 : 1;
      const val = Math.min(
        currRowBuffer[rightIndex - 1] + 1,
        prevRowBuffer[rightIndex] + 1,
        prevRowBuffer[rightIndex - 1] + substitutionCost
      );
      currRowBuffer[rightIndex] = val;
      if (val < rowMinimum) rowMinimum = val;
    }
    if (rowMinimum > maximum) return maximum + 1;
    for (let j = 0; j <= rightLen; j++) prevRowBuffer[j] = currRowBuffer[j];
  }
  return prevRowBuffer[rightLen];
}

function cheapFieldMatch(term, record, compactTerm = null, allowFuzzy = true) {
  const stem = record.normalizedStem || '';
  const name = record.normalizedName || '';
  const relativePath = record.normalizedRelativePath || '';

  // Weak terms (stopwords / <=2 chars): exact word match only, low weight.
  // Prevents "we" matching "weak", "to" matching "into", "the"
  // matching every title via substring — the top snippet-query failure mode.
  if (isWeakNavigatorTerm(term)) {
    const words = record.stemWords || stem.split(' ');
    for (let i = 0; i < words.length; i++) {
      if (words[i] === term) return { score: 120, field: 'name' };
    }
    if (name) {
      const nameWords = name.split(' ');
      for (let i = 0; i < nameWords.length; i++) {
        if (nameWords[i] === term) return { score: 100, field: 'name' };
      }
    }
    return null;
  }

  if (stem === term) return { score: 1300, field: 'name' };
  if (stem.startsWith(term)) return { score: 980, field: 'name' };
  const words = record.stemWords || stem.split(' ');
  for (let i = 0; i < words.length; i++) {
    if (words[i].startsWith(term)) return { score: 820, field: 'name' };
  }
  if (stem.includes(term)) return { score: 700, field: 'name' };
  if (name.includes(term)) return { score: 640, field: 'name' };
  if (relativePath.includes(term)) return { score: 420, field: 'path' };

  // Fuzzy title matching (subsequence + edit distance) is the most
  // expensive part of scoring. Two-tier search runs a cheap pass first
  // (allowFuzzy=false) and only pays for fuzzy when the cheap pass finds
  // nothing — snippet/phrase queries never reach the slow path.
  if (!allowFuzzy) return null;

  const cTerm = compactTerm ?? term.replace(/\s+/g, '');
  const cStem = record.compactStem ?? stem.replace(/\s+/g, '');
  if (isOrderedSubsequence(cTerm, cStem)) {
    return { score: 310, field: 'name' };
  }

  if (cTerm.length >= 4) {
    const maximumDistance = cTerm.length >= 7 ? 2 : 1;
    for (let i = 0; i < words.length; i++) {
      if (boundedEditDistance(cTerm, words[i], maximumDistance) <= maximumDistance) {
        return { score: 290, field: 'name' };
      }
    }
    if (boundedEditDistance(cTerm, cStem, maximumDistance) <= maximumDistance) {
      return { score: 290, field: 'name' };
    }
  }

  return null;
}

// Punctuation-flat normalization for lyric-snippet phrase matching.
// normalizedContent keeps commas/periods ("is with me, God"), while query
// phrases join punctuation-stripped terms ("is with me god") — a raw
// includes() then misses. Flat form removes apostrophes and maps every
// other non-alphanumeric to a space so both sides compare identically.
export function flattenNavigatorSearchText(value = '') {
  return String(value || '')
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Lyric v3: structure-tag stripping + flat token matching ---
// Whole-line bracket tags ([Verse], [Chorus], [Tag], [Acts 1:8]) are
// projection structure, never sung. They break stanza contiguity: a stanza
// pasted from two adjacent lyric lines spans a [Verse] divider in the file
// ("...sings oh oh oh [Verse] hallelujah..."), so a flat phrase check
// misses and the ordered walk pays a span penalty. Strip whole-line bracket
// tags from the SEARCHABLE copy only — previews and files are untouched.
const STRUCTURE_TAG_LINE_REGEX = /^\s*\[[^\[\]]{1,40}\]\s*$/;

export function stripNavigatorStructureTags(content = '') {
  const text = String(content || '');
  if (!text.includes('[')) return text;
  const lines = text.split('\n');
  let stripped = false;
  for (let i = 0; i < lines.length; i++) {
    if (STRUCTURE_TAG_LINE_REGEX.test(lines[i])) {
      lines[i] = '';
      stripped = true;
    }
  }
  return stripped ? lines.join('\n') : text;
}

// Flat alphanumeric tokens for the ordered walk: punctuation-free so
// lyric "sings," matches query "sings" and quoted '"what' matches
// 'what' without fragile quote bookkeeping on either side.
export function tokenizeNavigatorFlatText(value = '') {
  const flat = flattenNavigatorSearchText(
    String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
  );
  if (!flat) return [];
  return flat.split(' ').filter(Boolean);
}

// Strict token matcher (lyric v3). The old walk accepted ANY substring in
// EITHER direction (q.includes(hay)), so query "heart" matched lyric
// "art" ("heart".includes("art")) — a false early anchor that inflated
// the span past the sentence gate and filtered the owning file. v3 only:
// exact, prefix either-way (length-guarded, covers love/loved/wine/wines),
// or 1-edit distance (length-guarded, covers word/world typos). Suffix /
// infix substring is never a match.
export function matchNavigatorToken(queryTok = '', hayTok = '') {
  if (!queryTok || !hayTok) return false;
  if (queryTok === hayTok) return true;
  const qLen = queryTok.length;
  const hLen = hayTok.length;
  if (qLen >= 4 && hLen >= 4) {
    if (hayTok.startsWith(queryTok) || queryTok.startsWith(hayTok)) return true;
  }
  // 1-edit tolerance (word/world, aginst/against): length-guarded like the
  // Bible sentence matcher, never a bare substring (heart/art stays false).
  // Pure 4/4 substitutions (love/live) are excluded as too promiscuous in a
  // lyric corpus; real typos (4/5, 5/5+) still match via max-length >= 5.
  if (qLen >= 4 && hLen >= 4 && Math.max(qLen, hLen) >= 5 && Math.abs(qLen - hLen) <= 1) {
    return boundedEditDistance(queryTok, hayTok, 1) <= 1;
  }
  return false;
}

export function prepareNavigatorSearchRecord(record = {}) {
  const fileName = String(record.fileName || '');
  const extensionIndex = fileName.lastIndexOf('.');
  const stem = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
  const normalizedStem = normalizeNavigatorSearchText(stem);
  // v3: searchable lyric copy has structure-tag lines removed so pasted
  // stanzas stay contiguous; preview/file bytes are untouched upstream.
  const searchableContent = stripNavigatorStructureTags(record.contentText || '');
  const normalizedContent = normalizeNavigatorSearchText(searchableContent);

  return {
    ...record,
    normalizedStem,
    compactStem: normalizedStem.replace(/\s+/g, ''),
    stemWords: normalizedStem.split(' ').filter(Boolean),
    normalizedName: normalizeNavigatorSearchText(fileName),
    normalizedRelativePath: normalizeNavigatorSearchText(record.relativePath || record.filePath || ''),
    normalizedContent,
    // Precomputed once at index time so per-keystroke phrase checks are a
    // single substring scan instead of a regex + split per record per query.
    normalizedStemFlat: flattenNavigatorSearchText(normalizedStem),
    normalizedContentFlat: flattenNavigatorSearchText(normalizedContent),
    // v3: flat token streams precomputed once — the ordered walk below
    // reuses them instead of splitting the full lyric body per record per
    // keystroke (the dominant cost of the old experimental scorer).
    stemFlatTokens: tokenizeNavigatorFlatText(normalizedStem),
    contentFlatTokens: tokenizeNavigatorFlatText(normalizedContent),
    // v3: pre-split snippet lines (stripped raw + normalized) so
    // per-result match snippets reuse them instead of re-normalizing the
    // full lyric body per result per keystroke (the dominant end-to-end
    // cost: ~0.75ms/result on large files × up to 80 results). Capped to
    // bound memory; longer files fall back to the pure-function path.
    searchSnippetLines: buildNavigatorSnippetLines(searchableContent),
  };
}

const SNIPPET_LINE_CAP = 4000;
// F5: snippet lines duplicate the lyric text (raw + normalized). Cap the
// precompute so one giant compilation cannot bloat the index: files over
// 256KB keep tokens/flat (the recall path) but skip line arrays — the
// snippet builder falls back to the pure-function path for them.
const SNIPPET_BYTE_CAP = 256 * 1024;

export function buildNavigatorSnippetLines(content = '') {
  const text = String(content || '');
  if (!text) return null;
  if (text.length > SNIPPET_BYTE_CAP) return null;
  const rawLines = text.split('\n');
  if (rawLines.length > SNIPPET_LINE_CAP) return null;
  const raw = [];
  const norm = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.length > 2000) return null;
    // F7 parity: trim trailing whitespace (incl. \r from CRLF files) so
    // fast snippets are byte-identical to the pure path, whose preview
    // collapses trailing spaces before newlines. Trailing spaces are
    // never meaningful in lyric display.
    const clean = line.replace(/\s+$/, '');
    raw.push(clean);
    norm.push(normalizeNavigatorSearchText(line));
  }
  return { raw, norm };
}

// Fast per-result snippet from precomputed lines: finds the first line
// holding any query term (no per-line normalization — lines were
// normalized once at index time), returns up to 3 surrounding raw lines.
// Same shape as createNavigatorMatchSnippet (plain text, capped).
export function createNavigatorSnippetFromLines(record, query = '', maxCharacters = 360) {
  const lines = record?.searchSnippetLines;
  if (!lines || !Array.isArray(lines.raw) || !Array.isArray(lines.norm)) return null;
  const { terms } = parseFileNavigatorQuery(query);
  if (!terms.length) return null;
  let lineIndex = -1;
  for (let i = 0; i < lines.norm.length; i++) {
    const normalized = lines.norm[i];
    if (!normalized) continue;
    for (let t = 0; t < terms.length; t++) {
      if (normalized.includes(terms[t])) { lineIndex = i; break; }
    }
    if (lineIndex >= 0) break;
  }
  const start = lineIndex >= 0 ? Math.max(0, lineIndex - 1) : 0;
  const end = lineIndex >= 0
    ? Math.min(lines.raw.length, lineIndex + 3)
    : Math.min(lines.raw.length, 5);
  const snippet = lines.raw.slice(start, end).join('\n').trim();
  if (!snippet) return '';
  return snippet.length > maxCharacters
    ? `${snippet.slice(0, Math.max(0, maxCharacters - 3)).trimEnd()}...`
    : snippet;
}

// Highlight a precomputed plain snippet (no re-derivation): escape then
// mark query terms longest-first. Same markup as createHighlightedSnippet.
export function highlightNavigatorSnippetText(plainSnippet = '', query = '') {
  if (!plainSnippet) return '';
  const { terms } = parseFileNavigatorQuery(query);
  const escaped = escapeHtml(plainSnippet);
  const sortedTerms = [...terms].filter(Boolean).sort((a, b) => b.length - a.length);
  if (sortedTerms.length === 0) return escaped;
  const regex = new RegExp(`(${sortedTerms.map(escapeRegex).join('|')})`, 'gi');
  return escaped.replace(regex, '<mark class="bg-yellow-200 text-yellow-900 dark:bg-yellow-500/30 dark:text-yellow-200 px-0.5 rounded font-medium">$1</mark>');
}

export function scoreNavigatorSearchRecord(record, parsedQuery, options = {}) {
  const query = typeof parsedQuery === 'string'
    ? parseFileNavigatorQuery(parsedQuery)
    : (parsedQuery || { terms: [], fileTypes: [] });
  const allowFuzzy = options.fuzzy !== false;

  if (query.fileTypes?.length > 0 && !query.fileTypes.includes(record.fileType)) {
    return null;
  }
  if (!query.terms?.length) return null;

  let score = 0;
  let strongestField = 'path';
  let strongestScore = 0;

  const compactTerms = query.compactTerms || query.terms.map((t) => t.replace(/\s+/g, ''));
  const contentAllowed = query.searchContent !== false;
  const phrase = query.phrase ?? query.terms.join(' ');
  const termCount = query.terms.length;

  // FAST PATH — exact lyric-snippet phrase in content dominates everything.
  // Flat (punctuation-insensitive) comparison so "is with me god" matches
  // lyric "is with me, God". A single includes() replaces per-term
  // subsequence + edit-distance work for the common snippet case, and the
  // +1500 bonus outranks any title-partial sum (title partials are capped
  // because weak terms now score <=120). Single/double-term queries skip
  // this path so keystroke title ranking ("amazing" > content "wretch")
  // is unchanged. Runs in both tiers (cheap + fuzzy) for consistent ranking.
  if (contentAllowed && termCount >= 3 && phrase && phrase.length >= 8) {
    const flatContent = record.normalizedContentFlat
      ?? flattenNavigatorSearchText(record.normalizedContent || '');
    if (flatContent) {
      // Cache per parsed-query object: searchFileNavigator parses once then
      // scores up to 100k records — recomputing this regex per record costs
      // ~15% of snippet-query time for zero benefit.
      let flatPhrase = query.flatPhrase;
      if (flatPhrase === undefined) {
        flatPhrase = flattenNavigatorSearchText(phrase);
        try { query.flatPhrase = flatPhrase; } catch { /* frozen — recompute */ }
      }
      if (flatPhrase && flatContent.includes(flatPhrase)) {
        const stem = record.normalizedStem || '';
        // Small title kicker when the title also shares a strong (non-weak)
        // term — breaks ties between duplicate lyric files deterministically
        // toward the file whose title matches the snippet vocabulary.
        let titleKicker = 0;
        let titleField = 'content';
        for (let i = 0; i < termCount; i++) {
          const t = query.terms[i];
          if (isWeakNavigatorTerm(t)) continue;
          if (stem.includes(t)) { titleKicker = 200; titleField = 'both'; break; }
        }
        // Focus bonus: among files holding the same lyric line, prefer the
        // focused song sheet over a multi-service compilation (e.g. the 60KB
        // TPHB compilation holds every lyric). Length-norm is TF-IDF
        // standard practice; the ~70pt spread only breaks ties between
        // phrase holders, never outranks a phrase hit itself.
        const contentLen = record.contentText?.length || flatContent.length || 1;
        const focusBonus = Math.max(0, Math.round(120 - 25 * Math.log10(contentLen)));
        return { score: 250 * termCount + 1500 + titleKicker + focusBonus, matchedField: titleField };
      }
    }
  }

  // Two-phase scoring: name/path/subsequence fields are cheap and match the
  // vast majority of keystroke queries, so the expensive normalized-content
  // scan only runs for terms that failed every cheap field. This keeps
  // per-keystroke main-process search work bounded (searchFileNavigator
  // iterates up to 100k records synchronously).
  const contentTerms = [];
  for (let i = 0; i < query.terms.length; i++) {
    const term = query.terms[i];
    const match = cheapFieldMatch(term, record, compactTerms[i], allowFuzzy);
    if (match) {
      score += match.score;
      if (match.score > strongestScore) {
        strongestScore = match.score;
        strongestField = match.field;
      }
    } else {
      contentTerms.push(term);
    }
  }

  let contentScanned = false;
  if (contentTerms.length > 0) {
    if (query.searchContent === false) return null;
    const content = record.normalizedContent || '';
    for (const term of contentTerms) {
      if (!content.includes(term)) return null;
      score += 250;
      if (250 > strongestScore) {
        strongestScore = 250;
        strongestField = 'content';
      }
    }
    contentScanned = true;
  }

  if (phrase && record.normalizedStem === phrase) score += 1000;
  else if (phrase && record.normalizedStem.startsWith(phrase)) score += 600;
  else if (phrase && record.normalizedStem.includes(phrase)) score += 350;
  else if (phrase && record.normalizedRelativePath.includes(phrase)) score += 140;
  // The +80 content-phrase bonus only applies when content was already
  // scanned; records whose terms all matched cheap fields skip the scan.
  else if (phrase && contentScanned && record.normalizedContent?.includes(phrase)) score += 80;

  return { score, matchedField: strongestField };
}

function stripLrcDecorations(value) {
  return value
    .replace(/^\s*\[(?:ar|al|ti|au|by|length|offset|lr|re|tool|ve|id|#):[^\]]*\]\s*$/gim, '')
    .replace(/(?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+/g, '')
    .replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, '');
}

export function createNavigatorPreview(content = '', fileType = 'txt', maxCharacters = 20_000) {
  const normalized = String(content || '')
    .replace(/^\uFEFF/, '')
    .replace(/\0/g, '')
    .replace(/\r\n?/g, '\n');
  const readable = fileType === 'lrc' ? stripLrcDecorations(normalized) : normalized;
  return readable
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, maxCharacters);
}

export function createNavigatorMatchSnippet(content = '', query = '', fileType = 'txt', maxCharacters = 360) {
  const preview = createNavigatorPreview(content, fileType, 80_000);
  if (!preview) return '';

  const { terms } = parseFileNavigatorQuery(query);
  const lines = preview.split('\n');
  const lineIndex = lines.findIndex((line) => {
    const normalized = normalizeNavigatorSearchText(line);
    return terms.some((term) => normalized.includes(term));
  });
  const start = lineIndex >= 0 ? Math.max(0, lineIndex - 1) : 0;
  const end = lineIndex >= 0 ? Math.min(lines.length, lineIndex + 3) : Math.min(lines.length, 5);
  const snippet = lines.slice(start, end).join('\n').trim();
  return snippet.length > maxCharacters
    ? `${snippet.slice(0, Math.max(0, maxCharacters - 3)).trimEnd()}...`
    : snippet;
}

export const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]));
}

export function createHighlightedSnippet(content = '', query = '', fileType = 'txt', maxCharacters = 360) {
  const plainSnippet = createNavigatorMatchSnippet(content, query, fileType, maxCharacters);
  if (!plainSnippet) return '';

  const { terms } = parseFileNavigatorQuery(query);
  const escaped = escapeHtml(plainSnippet);
  const sortedTerms = [...terms]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  if (sortedTerms.length === 0) return escaped;

  const regex = new RegExp(`(${sortedTerms.map(escapeRegex).join('|')})`, 'gi');
  return escaped.replace(regex, '<mark class="bg-yellow-200 text-yellow-900 dark:bg-yellow-500/30 dark:text-yellow-200 px-0.5 rounded font-medium">$1</mark>');
}


// --- Experimental sentence-first file scoring (behind Experimental flag) ---
// Import is lazy so scoring stays out of the synchronous module graph:
// fileNavigatorSentence statically imports matchNavigatorToken from here,
// which is safe because this file never statically imports it back.
export async function scoreNavigatorSearchRecordExperimentalAsync(record, parsedQuery) {
  const mod = await import('./fileNavigatorSentence.js');
  return mod.scoreNavigatorRecordSentence(record, parsedQuery);
}

export function scoreNavigatorSearchRecordExperimental(record, parsedQuery) {
  const query = typeof parsedQuery === 'string'
    ? parseFileNavigatorQuery(parsedQuery)
    : (parsedQuery || { terms: [], fileTypes: [] });
  if (query.fileTypes?.length > 0 && !query.fileTypes.includes(record.fileType)) return null;
  if (!query.terms?.length) return null;
  // Honors the operator's content-search preference exactly like the default
  // scorer: with searchContent === false, lyric bodies are never consulted —
  // title/path matches only. The experimental path must not override an
  // explicit OFF.
  const contentAllowed = query.searchContent !== false;
  const normStem = record.normalizedStem || '';
  const normPath = record.normalizedRelativePath || '';
  const phrase = (query.phrase ?? query.terms.join(' ')).trim();
  // Single weak keystroke ("a", "to", "th"): title/path only, never the
  // content walk. Mirrors the default scorer (weak terms score title-only)
  // and keeps first-keystroke searches instant instead of walking every
  // lyric body for a letter every file contains.
  if (query.terms.length === 1 && isWeakNavigatorTerm(query.terms[0])) {
    // F6: compare normalized forms — an exact title match with differing
    // case/punctuation must still take the 2200 fast path.
    const weakNorm = normalizeNavigatorSearchText(phrase);
    if (weakNorm && normStem === weakNorm) return { score: 2200, matchedField: 'name', sentence: true };
    const weakFlat = flattenNavigatorSearchText(query.terms[0]);
    if (weakFlat) {
      const stemWords = record.stemWords || normStem.split(' ');
      for (let i = 0; i < stemWords.length; i++) {
        if (stemWords[i] === weakFlat) return { score: 500, matchedField: 'name', sentence: false };
      }
      if (weakNorm && normPath.includes(weakNorm)) return { score: 200, matchedField: 'path', sentence: false };
    }
    return null;
  }
  if (phrase && normStem === phrase) return { score: 2200, matchedField: 'name', sentence: true };
  if (phrase && normStem.includes(phrase)) return { score: 1800, matchedField: 'name', sentence: true };
  // v3 flat-phrase fast path (tag-stripped, punctuation-insensitive): the
  // common case — a pasted lyric line or stanza — resolves with one C-level
  // substring scan, no token walk. Structure tags are stripped at index
  // time so stanzas spanning [Verse] dividers stay contiguous.
  let flatContent = '';
  if (contentAllowed) {
    flatContent = record.normalizedContentFlat
      ?? flattenNavigatorSearchText(record.normalizedContent || '');
    if (flatContent) {
      let flatPhrase = query.flatPhrase;
      if (flatPhrase === undefined) {
        flatPhrase = flattenNavigatorSearchText(phrase);
        try { query.flatPhrase = flatPhrase; } catch { /* frozen — recompute */ }
      }
      if (flatPhrase && flatContent.includes(flatPhrase)) {
        const flatStem = record.normalizedStemFlat ?? flattenNavigatorSearchText(normStem);
        let titleKicker = 0;
        let titleField = 'content';
        for (let i = 0; i < query.terms.length; i++) {
          const t = query.terms[i];
          if (isWeakNavigatorTerm(t)) continue;
          const flatT = flattenNavigatorSearchText(t);
          if (flatT && flatStem.includes(flatT)) { titleKicker = 200; titleField = 'both'; break; }
        }
        const contentLen = record.contentText?.length || flatContent.length || 1;
        const focusBonus = Math.max(0, Math.round(120 - 25 * Math.log10(contentLen)));
        return { score: 250 * query.terms.length + 1500 + titleKicker + focusBonus, matchedField: titleField, sentence: true };
      }
    }
  }
  // v3 ordered walk over PRECOMPUTED flat tokens (no per-record split).
  // Coverage is measured on substantive terms only (len>=3, non-stop):
  // short sung syllables ("oh", "my", "eh") are real lyrics but carry
  // no pruning signal — counting them as misses capped stanza coverage at
  // 0.6 and filtered owning files. They now contribute a small exact bonus.
  const STOP = new Set(['the','a','an','and','or','of','to','in','on','for','with','from','as','is','are','was','were','be','been','am','it','its','this','that','these','those']);
  const flatTerms = query.terms.flatMap((t) => flattenNavigatorSearchText(t).split(' ').filter(Boolean));
  const substantive = flatTerms.filter((t) => t.length >= 3 && !STOP.has(t));
  const shortTerms = flatTerms.filter((t) => !(t.length >= 3 && !STOP.has(t)));
  const useTerms = substantive.length > 0 ? substantive : flatTerms;
  const hayTokens = contentAllowed
    ? (record.contentFlatTokens || tokenizeNavigatorFlatText(record.normalizedContent || ''))
    : [];
  // Prefilter on flat includes (punctuation-insensitive): unless at least
  // two substantive terms (or one, when <=2) appear anywhere in the lyric
  // body, the walk cannot reach coverage — skip it. Same recall, far less
  // work on misses. Note <=2 needs only ONE hit: the walk itself
  // fuzzy-matches (typo "betlehem"~"bethlehem") and its coverage gate
  // still requires both terms, so a single exact hit must enter the walk
  // for typo'd 2-term queries ("Anonting fall on me") to recall.
  if (contentAllowed && useTerms.length >= 1 && flatContent) {
    let subHits = 0;
    for (const q of useTerms) {
      if (flatContent.includes(q)) subHits += 1;
      if (subHits >= 2 && useTerms.length > 2) break;
    }
    const need = useTerms.length > 2 ? 2 : 1;
    if (subHits < need) {
      const titleHit = query.terms.some((t) => normStem.includes(t) || normPath.includes(t));
      if (titleHit && useTerms.length <= 2) return { score: 500, matchedField: 'name', sentence: false };
      return null;
    }
  }
  let cursor = 0;
  let first = -1;
  let last = -1;
  let matched = 0;
  if (contentAllowed && hayTokens.length > 0) {
    for (const q of useTerms) {
      let found = -1;
      for (let i = cursor; i < hayTokens.length; i++) {
        if (matchNavigatorToken(q, hayTokens[i])) { found = i; break; }
      }
      if (found === -1) continue;
      if (first === -1) first = found;
      last = found;
      cursor = found + 1;
      matched += 1;
    }
  }
  if (matched === 0) {
    // Title fallback: any single title term still matches (keeps file-title search usable).
    const titleHit = query.terms.some((t) => normStem.includes(t) || normPath.includes(t));
    if (titleHit && useTerms.length <= 2) return { score: 500, matchedField: 'name', sentence: false };
    return null;
  }
  const coverage = matched / useTerms.length;
  if (useTerms.length >= 3 && (matched < 2 || coverage < 0.6)) {
    // Sentence query but only one scattered word matched — filter (fixes OR habit).
    const titleOrdered = query.terms.every((t) => normStem.includes(t));
    if (!titleOrdered) return null;
  }
  if (useTerms.length === 2 && matched < 2) return null;
  const span = first === -1 ? hayTokens.length : last - first + 1;
  if (query.terms.length >= 3 && span > 12 && coverage < 1) return null;
  const spanBonus = span <= 6 ? 500 : span <= 10 ? 250 : 80;
  // Short sung syllables: exact presence is a small bonus, never a miss.
  let shortBonus = 0;
  if (contentAllowed && shortTerms.length > 0 && flatContent) {
    for (const s of shortTerms) {
      if (!s) continue;
      if (flatContent.includes(` ${s} `) || flatContent.startsWith(`${s} `) || flatContent.endsWith(` ${s}`)) shortBonus += 15;
    }
    shortBonus = Math.min(60, shortBonus);
  }
  // Also reward title term hits. Focus bonus (same as the phrase path):
  // among files holding the same lyric words, prefer the focused song
  // sheet over a multi-service compilation.
  const titleBonus = query.terms.some((t) => normStem.includes(t)) ? 300 : 0;
  const focusLen = record.contentText?.length || (flatContent ? flatContent.length : 0) || 1;
  const focusBonus = Math.max(0, Math.round(60 - 12 * Math.log10(focusLen)));
  const strongest = titleBonus > 0 && flatContent ? 'both' : (titleBonus > 0 ? 'name' : 'content');
  return { score: 700 + spanBonus + coverage * 200 + titleBonus + shortBonus + focusBonus, matchedField: strongest, sentence: true };
}
