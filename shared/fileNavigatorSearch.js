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

export function prepareNavigatorSearchRecord(record = {}) {
  const fileName = String(record.fileName || '');
  const extensionIndex = fileName.lastIndexOf('.');
  const stem = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
  const normalizedStem = normalizeNavigatorSearchText(stem);
  const normalizedContent = normalizeNavigatorSearchText(record.contentText || '');

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
  };
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
// Import is lazy to avoid a require cycle: fileNavigatorSentence is standalone
// and never imports this file.
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
  // Synchronous fast path: replicate the sentence gate without the async import.
  // Exact phrase in stem/content wins; else ordered proximity.
  const normStem = record.normalizedStem || '';
  const normContent = contentAllowed ? (record.normalizedContent || '') : '';
  const normPath = record.normalizedRelativePath || '';
  const phrase = (query.phrase ?? query.terms.join(' ')).trim();
  if (phrase && normStem === phrase) return { score: 2200, matchedField: 'name', sentence: true };
  if (phrase && normStem.includes(phrase)) return { score: 1800, matchedField: 'name', sentence: true };
  if (contentAllowed && phrase && normContent.includes(phrase)) {
    const titleHit = query.terms.some((t) => normStem.includes(t));
    return { score: titleHit ? 1900 : 1600, matchedField: titleHit ? 'both' : 'content', sentence: true };
  }
  // Ordered proximity over content tokens (stopwords kept for span, but
  // coverage is measured on content terms only).
  const STOP = new Set(['the','a','an','and','or','of','to','in','on','for','with','from','as','is','are','was','were','be','been','am','it','its','this','that','these','those']);
  const contentTerms = query.terms.filter((t) => t && !STOP.has(t));
  const useTerms = contentTerms.length > 0 ? contentTerms : query.terms;
  // Prefilter: the ordered walk below splits + scans the full lyric body.
  // Unless at least two strong terms (or all, when <=2) appear as substrings
  // anywhere in title/content, the walk cannot reach coverage — skip it and
  // fall through to the title fallback. Same recall, ~5x less work on misses.
  if (contentAllowed && useTerms.length >= 2) {
    let subHits = 0;
    for (const q of useTerms) {
      if (normContent.includes(q) || normStem.includes(q)) subHits += 1;
      if (subHits >= 2 && useTerms.length > 2) break;
    }
    const need = useTerms.length > 2 ? 2 : useTerms.length;
    if (subHits < need) {
      const titleHit = query.terms.some((t) => normStem.includes(t) || normPath.includes(t));
      if (titleHit && useTerms.length <= 2) return { score: 500, matchedField: 'name', sentence: false };
      return null;
    }
  }
  // Hay tokens shorter than 3 chars (or stopwords) carry no signal and only
  // create false substring hits (query "watre" matching lyric "at" via
  // q.includes(hay)). Skip them; the title fallback below still works.
  const hayTokens = normContent.split(' ').filter((t) => t && t.length >= 3 && !STOP.has(t));
  let cursor = 0;
  let first = -1;
  let last = -1;
  let matched = 0;
  for (const q of useTerms) {
    let found = -1;
    for (let i = cursor; i < hayTokens.length; i++) {
      if (hayTokens[i].includes(q) || q.includes(hayTokens[i])) { found = i; break; }
    }
    if (found === -1) continue;
    if (first === -1) first = found;
    last = found;
    cursor = found + 1;
    matched += 1;
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
  // Also reward title term hits.
  const titleBonus = query.terms.some((t) => normStem.includes(t)) ? 300 : 0;
  const strongest = titleBonus > 0 && normContent ? 'both' : (titleBonus > 0 ? 'name' : 'content');
  return { score: 700 + spanBonus + coverage * 200 + titleBonus, matchedField: strongest, sentence: true };
}
