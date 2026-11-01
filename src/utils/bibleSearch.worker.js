import { searchBible, searchBibleExperimental } from 'shared/bible';

let cachedBibles = {};
let cachedCurrentBible = null;
// Group: God fast — LRU of recent query results so retype/backspace is instant.
// Key includes corpus ids + query + scope; values are result arrays.
const queryCache = new Map();
const QUERY_CACHE_LIMIT = 100;

function cacheKey(query, maxResults, defaultBibleId, searchAll, experimental = false) {
  const ids = Object.keys(cachedBibles).sort().join(',');
  const cur = cachedCurrentBible?.id || '';
  return `${cur}|${ids}|${String(query).toLowerCase()}|${maxResults}|${defaultBibleId}|${searchAll}|exp:${experimental ? 1 : 0}`;
}

function cacheGet(key) {
  if (!queryCache.has(key)) return null;
  const v = queryCache.get(key);
  queryCache.delete(key);
  queryCache.set(key, v);
  return v;
}

function cacheSet(key, value) {
  queryCache.set(key, value);
  if (queryCache.size > QUERY_CACHE_LIMIT) {
    const first = queryCache.keys().next().value;
    queryCache.delete(first);
  }
}

self.onmessage = function(e) {
  const { currentBible, query, allBibles, maxResults, defaultBibleId, searchAll, refreshBibles, pruneBibles, qid, experimental } = e.data; // experimental: sentence-first ranking (Experimental flag)

  if (refreshBibles && allBibles && typeof allBibles === 'object') {
    cachedBibles = allBibles;
    queryCache.clear();
  }
  if (currentBible) {
    if (cachedCurrentBible?.id !== currentBible.id) queryCache.clear();
    cachedCurrentBible = currentBible;
  }
  if (pruneBibles && typeof pruneBibles === 'object') {
    const keptIds = new Set(Object.keys(pruneBibles));
    for (const bibleId of Object.keys(cachedBibles)) {
      if (!keptIds.has(bibleId)) delete cachedBibles[bibleId];
    }
    queryCache.clear();
  }

  const activeCurrent = currentBible || cachedCurrentBible;
  if (typeof query === 'string' && query.trim().length > 0) {
    const useExp = experimental === true;
    const key = cacheKey(query, maxResults, defaultBibleId, searchAll, useExp);
    const cached = cacheGet(key);
    if (cached) {
      if (qid != null) self.postMessage({ qid, results: cached, cached: true });
      else self.postMessage(cached);
      return;
    }
    const results = useExp
      ? searchBibleExperimental(activeCurrent, query, cachedBibles, maxResults, defaultBibleId, searchAll)
      : searchBible(activeCurrent, query, cachedBibles, maxResults, defaultBibleId, searchAll);
    cacheSet(key, results);
    if (qid != null) self.postMessage({ qid, results });
    else self.postMessage(results);
  }
};
