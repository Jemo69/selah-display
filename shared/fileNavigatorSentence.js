// shared/fileNavigatorSentence.js — experimental sentence-first file scoring
// A sentence query ("water to into wine") wants the file whose lyrics contain
// the sentence in order, not files containing water OR into OR wine.
// Rules: exact phrase wins; else require ordered proximity with tight span;
// single-word scattered hits are filtered for 3+ term queries.
// Faster than default: phrase hit short-circuits before edit-distance fuzzy.

const normalizeNavigatorSentenceText = (value = '') => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase()
  .replace(/[_-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const FILE_STOPWORDS = new Set([
  'the','a','an','and','or','of','to','in','on','for','with','from','as','is',
  'are','was','were','be','been','am','it','its','this','that','these','those',
]);

function contentTermsOf(terms) {
  const c = (terms || []).filter((t) => t && t.length >= 2 && !FILE_STOPWORDS.has(t));
  return c.length > 0 ? c : (terms || []).filter(Boolean);
}

function tokenPositions(hayTokens, needle) {
  const out = [];
  for (let i = 0; i < hayTokens.length; i++) {
    if (hayTokens[i].includes(needle) || needle.includes(hayTokens[i])) out.push(i);
  }
  return out;
}

export function scoreSentenceField(queryTerms, hayText) {
  const hay = normalizeNavigatorSentenceText(hayText || '');
  if (!hay || queryTerms.length === 0) return null;
  const phrase = queryTerms.join(' ');
  if (phrase && hay.includes(phrase)) {
    return { ordered: true, phrase: true, span: phrase.length, coverage: 1 };
  }
  const hayTokens = hay.split(' ').filter(Boolean);
  const content = contentTermsOf(queryTerms);
  // Ordered walk: each query term must appear at/after cursor.
  let cursor = 0;
  let first = -1;
  let last = -1;
  let matched = 0;
  for (const q of content) {
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
  if (matched === 0) return null;
  const coverage = matched / content.length;
  if (content.length >= 3 && (matched < 2 || coverage < 0.6)) return null;
  if (content.length === 2 && matched < 2) return null;
  const span = first === -1 ? hayTokens.length : last - first + 1;
  return { ordered: true, phrase: false, span, coverage, matched };
}

export function scoreNavigatorRecordSentence(record, parsedQuery) {
  const query = parsedQuery || { terms: [], fileTypes: [] };
  if (query.fileTypes?.length > 0 && !query.fileTypes.includes(record.fileType)) return null;
  if (!query.terms?.length) return null;
  const terms = query.terms;

  const stem = record.normalizedStem || '';
  const rel = record.normalizedRelativePath || '';
  const content = record.normalizedContent || '';

  // Title phrase first — title sentence match outranks everything.
  const titleRes = scoreSentenceField(terms, stem);
  if (titleRes?.phrase) {
    return { score: 2200 + terms.join(' ').length, matchedField: 'name', sentence: true };
  }
  const contentRes = scoreSentenceField(terms, content);
  if (contentRes?.phrase) {
    const bonus = titleRes ? 600 : 0;
    return { score: 1600 + bonus, matchedField: titleRes ? 'both' : 'content', sentence: true };
  }
  // Ordered proximity without exact phrase.
  if (titleRes && contentRes) {
    // Both sides partial — rare, reward.
    return { score: 900, matchedField: 'both', sentence: true };
  }
  if (titleRes) {
    // Title contains terms in order but not exact phrase.
    if (titleRes.coverage < 0.6) return null;
    const spanPenalty = Math.min(200, (titleRes.span || 10) * 10);
    return { score: 800 - spanPenalty + titleRes.coverage * 200, matchedField: 'name', sentence: true };
  }
  if (contentRes) {
    const span = contentRes.span || 10;
    // Tight span = sentence-like ("water ... into ... wine" within ~8 tokens).
    // Loose span = scattered words — filter for sentence queries.
    if (terms.length >= 3 && span > 12 && contentRes.coverage < 1) return null;
    const spanBonus = span <= 6 ? 500 : span <= 10 ? 250 : 80;
    return { score: 500 + spanBonus + contentRes.coverage * 200, matchedField: 'content', sentence: true };
  }
  // Path fallback (not sentence): keep weak signal so folder queries still work.
  if (rel && terms.every((t) => rel.includes(t))) {
    return { score: 200, matchedField: 'path', sentence: false };
  }
  return null;
}
