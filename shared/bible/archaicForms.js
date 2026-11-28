/**
 * shared/bible/archaicForms.js — modern English → King James surface forms.
 *
 * WHY THIS FILE EXISTS. The index and the scorer both tokenize verse text
 * literally. That is right for a quote, and wrong for the way operators
 * actually type. An operator in a live service writes the verse the way he
 * speaks it:
 *
 *     "God has not given us a spirit of fear"      2 Tim 1:7
 *     "the Lord says to my Lord"                   Psalm 110:1
 *     "God loved the world and gave his only son"  John 3:16
 *
 * The KJV says "hath", "saith", "loveth", "begotten". Not one of those query
 * words is in the corpus under the spelling he typed, so retrieval never even
 * returns the candidate — this is not a ranking problem, and no amount of
 * scoring can rescue a verse that is not in the pool. So the bridge has to sit
 * on BOTH sides of the search:
 *
 *   1. RETRIEVAL (`experimentalTermVariants` in index.js) — a modern query
 *      token is expanded into the KJV spellings before postings are looked up,
 *      so "has" finds the verses that say "hath".
 *   2. SCORING (`scoreSentenceVerse`) — the same expansion is passed down as a
 *      Set per query token, so the ordered walk recognises "hath" as an exact
 *      hit for "has" instead of falling to edit-distance fuzz.
 *
 * DELIBERATELY ONE-DIRECTIONAL. We expand the QUERY, never the corpus, and we
 * never rewrite verse text. A verse is projected exactly as the translation
 * words it; a match is our inference alone. It also means verbatim-KJV queries
 * keep working untouched — the operator who types "hath" is already typing a
 * corpus word.
 *
 * WHAT THIS IS NOT. This is not a paraphrase engine and it does not pretend to
 * be one. It bridges (a) KJV inflection (loveth/lovest/loved), (b) KJV
 * vocabulary that has left the language or changed meaning (charity, ghost,
 * meat, raiment, mammon, quick, remission, conversation, wont), and (c) a
 * short list of ordinary paraphrases that are not ambiguous in scripture
 * (take/get, money/riches, garment/raiment, heart/mind). It cannot know that
 * "he cares for you" means "he careth for you, for he careth for you" — that
 * is the unordered-coverage tier's job in sentenceSearch.js, and even that
 * only reaches so far. Saying otherwise in a comment would be a lie the next
 * maintainer inherits.
 *
 * COST. Every route is a Map/Set lookup on a small table, memoized per token.
 * The memo is bounded because the only caller with unbounded input is the
 * query, not the corpus.
 */

/**
 * Groups of surface forms that mean the same thing for matching purposes.
 *
 * Rules this table follows, so it stays maintainable:
 *   - Every member must be a single token of `[a-z0-9]` after normalization.
 *   - A token may appear in exactly one group (asserted in the test file).
 *   - A group earns its place by being either a KJV inflection family or a
 *     documented meaning shift. "They are kind of similar" is not enough.
 */
const TOKEN_GROUPS = [
  // --- KJV inflection families (same lemma, different endings) ------------
  ['have', 'has', 'hath', 'hast', 'had', 'hadst', 'having'],
  ['do', 'does', 'doth', 'dost', 'doest', 'did', 'didst', 'done', 'doing'],
  ['say', 'says', 'saith', 'sayeth', 'sayest', 'said', 'saidst', 'saying'],
  ['speak', 'speaks', 'speaketh', 'speakest', 'spake', 'spakest', 'spoke', 'spoken', 'speaking'],
  ['go', 'goes', 'goeth', 'goest', 'went', 'gone', 'going'],
  ['come', 'comes', 'cometh', 'comest', 'came', 'coming'],
  ['know', 'knows', 'knoweth', 'knowest', 'knew', 'knewest', 'known', 'knowing', 'knowledge'],
  ['see', 'sees', 'seeth', 'seest', 'saw', 'sawest', 'seen', 'seeing', 'behold', 'beholds', 'beholding', 'beheld', 'look', 'looks', 'looketh', 'looked', 'looking'],
  ['hear', 'hears', 'heareth', 'hearest', 'heard', 'heardest', 'hearing', 'hearken', 'hearkened', 'hearkeneth', 'harken'],
  ['give', 'gives', 'giveth', 'givest', 'gave', 'gavest', 'given', 'giving'],
  ['take', 'takes', 'taketh', 'takest', 'took', 'tookest', 'taken', 'taking', 'get', 'gets', 'getteth', 'got', 'gotten', 'getting'],
  ['receive', 'receives', 'receiveth', 'received', 'receiving'],
  ['make', 'makes', 'maketh', 'makest', 'made', 'madest', 'making'],
  ['love', 'loves', 'loveth', 'lovest', 'loved', 'lovedst', 'loving', 'charity', 'beloved'],
  ['fear', 'fears', 'feareth', 'fearest', 'feared', 'fearing', 'afraid'],
  ['believe', 'believes', 'believeth', 'believest', 'believed', 'believing', 'belief', 'faith', 'faithful'],
  ['pray', 'prays', 'prayeth', 'prayest', 'prayed', 'praying', 'prayer', 'prayers', 'supplication', 'supplications'],
  ['forgive', 'forgives', 'forgiveth', 'forgave', 'forgiven', 'forgiving', 'forgiveness', 'remission', 'pardon', 'pardoned'],
  ['teach', 'teaches', 'teacheth', 'taught', 'teaching', 'doctrine', 'doctrines'],
  ['keep', 'keeps', 'keepeth', 'keepest', 'kept', 'keeping', 'preserve', 'preserved', 'preserveth', 'observe', 'observed'],
  ['walk', 'walks', 'walketh', 'walked', 'walking'],
  ['work', 'works', 'worketh', 'worked', 'working', 'labour', 'labours', 'laboured', 'labor', 'toil', 'deed', 'deeds'],
  ['call', 'calls', 'calleth', 'called', 'calling'],
  ['send', 'sends', 'sendeth', 'sent', 'sending'],
  ['ask', 'asks', 'asketh', 'asked', 'asking', 'enquire', 'inquire', 'enquired', 'inquired'],
  ['show', 'shows', 'shew', 'shews', 'sheweth', 'shewed', 'shewn', 'shown', 'showed', 'declare', 'declared', 'declareth', 'declaring'],
  ['follow', 'follows', 'followeth', 'followed', 'following'],
  ['live', 'lives', 'liveth', 'lived', 'living', 'alive', 'quick', 'quicken', 'quickened', 'quickeneth'],
  ['dead', 'death', 'die', 'dies', 'dieth', 'died', 'dying'],
  ['grow', 'grows', 'groweth', 'grew', 'grown', 'growing', 'wax', 'waxed', 'waxeth', 'waxen'],
  ['wait', 'waits', 'waiteth', 'waited', 'waiting', 'tarry', 'tarried', 'tarrying', 'abide', 'abideth', 'abode'],
  ['care', 'cares', 'careth', 'carest', 'cared', 'caring', 'careful', 'anxious', 'anxiety', 'worry', 'worries', 'worried'],
  ['judge', 'judges', 'judgeth', 'judged', 'judging', 'judgment', 'judgments', 'judgements', 'condemn', 'condemned', 'condemneth', 'condemnation'],
  ['save', 'saves', 'saveth', 'saved', 'saving', 'salvation', 'deliver', 'delivered', 'delivereth', 'deliverance'],
  ['heal', 'heals', 'healeth', 'healed', 'healing', 'cure', 'cured'],
  ['wash', 'washes', 'washeth', 'washed', 'washing', 'cleanse', 'cleansed', 'cleansing', 'purify', 'purified'],
  ['redeem', 'redeemed', 'redeemeth', 'redemption', 'ransom', 'ransomed'],
  ['trust', 'trusts', 'trusteth', 'trusted', 'trusting', 'confidence'],
  ['rejoice', 'rejoiced', 'rejoiceth', 'rejoicing', 'joy', 'joys', 'joyful'],

  // --- KJV vocabulary: meaning shifted or the word left the language ------
  ['man', 'men', 'mankind'],
  ['woman', 'women'],
  ['child', 'children'],
  ['brother', 'brothers', 'brethren'],
  ['spirit', 'spirits', 'ghost', 'ghosts'], // Holy Ghost / Holy Spirit
  ['heart', 'hearts', 'mind', 'minds', 'soul', 'souls', 'understanding'],
  ['money', 'riches', 'rich', 'wealth', 'mammon', 'treasure', 'treasures'],
  ['food', 'meat', 'meats', 'victuals', 'sustenance'],
  ['clothing', 'clothes', 'clothe', 'clothed', 'garment', 'garments', 'raiment', 'apparel', 'robe', 'robes'],
  ['house', 'houses', 'household', 'home', 'dwelling', 'dwellings'],
  ['servant', 'servants', 'slave', 'slaves', 'bondman', 'bondmen'],
  ['prophet', 'prophets', 'prophecy', 'prophecies', 'prophesy', 'prophesied', 'prophesieth', 'prophesying'],
  ['disciple', 'disciples', 'follower', 'followers'],
  ['gentile', 'gentiles', 'heathen', 'nations'],
  ['kingdom', 'kingdoms', 'reign', 'reigns', 'reigned', 'reigneth'],
  ['church', 'churches', 'congregation', 'assembly'],
  ['gospel', 'gospels'],
  ['law', 'laws', 'commandment', 'commandments', 'statute', 'statutes', 'precept', 'precepts'],
  ['sin', 'sins', 'sinneth', 'sinned', 'sinning', 'iniquity', 'iniquities', 'transgression', 'transgressions', 'trespass', 'trespasses', 'trespassed'],
  ['evil', 'wicked', 'wickedness', 'bad'],
  ['lust', 'lusts', 'lusted', 'concupiscence', 'desire', 'desires', 'desired'],
  ['mercy', 'mercies', 'merciful', 'compassion', 'compassions', 'pity', 'lovingkindness', 'bowels'],
  ['grace', 'gracious', 'favour', 'favor'],
  ['glory', 'glorious', 'glorify', 'glorified', 'glorifieth', 'praise', 'praised', 'praiseth', 'honour', 'honor', 'worship'],
  ['peace', 'peaceable', 'quiet', 'quietness', 'rest', 'rested', 'resteth'],
  ['sorrow', 'sorrows', 'sorrowful', 'grief', 'griefs', 'grieve', 'grieved', 'grieveth', 'mourn', 'mourned', 'mourneth', 'mourning', 'weep', 'wept', 'weepeth', 'weeping', 'cry', 'cried', 'crieth', 'crying'],
  ['anger', 'angry', 'wrath', 'wroth', 'fury', 'fierce'],
  ['wise', 'wisdom', 'wiser', 'prudent', 'prudence'],
  ['strong', 'stronger', 'strength', 'mighty', 'power', 'powers', 'powerful', 'stablish', 'establish', 'established'],
  ['truth', 'truths', 'true', 'truly', 'verily'],
  ['forever', 'everlasting', 'eternal', 'eternity', 'evermore'],
  ['thanks', 'thank', 'thanked', 'thanksgiving', 'grateful', 'thankfulness'],
  ['beautiful', 'comely', 'fair', 'lovely', 'beauty'],
  ['astonished', 'astonied', 'amazed', 'astounded'],
  ['entreat', 'entreated', 'intreat', 'intreated', 'persuade', 'persuaded', 'persuasion'],
  ['conversation', 'conduct', 'behaviour', 'behavior'],
  ['suffer', 'suffers', 'suffereth', 'suffered', 'suffering', 'allow', 'allowed', 'alloweth', 'permit'],
];

const GROUP_OF = new Map();
for (const group of TOKEN_GROUPS) {
  for (const token of group) {
    if (!GROUP_OF.has(token)) GROUP_OF.set(token, group);
  }
}

const EMPTY = Object.freeze([]);
const CACHE_LIMIT = 4096;
const formsCache = new Map();

/**
 * Every surface form a query token may legitimately be spelled as in the KJV:
 * the token itself, its inflection family, and the regular archaic -eth/-est
 * endings. Always includes the token you passed in, so callers can treat the
 * result as "all acceptable spellings" rather than "extras".
 *
 * @param {string} rawToken already-normalized `[a-z0-9]` token
 * @returns {ReadonlyArray<string>}
 */
export function archaicFormsOf(rawToken) {
  const token = String(rawToken || '');
  if (!token) return EMPTY;
  const cached = formsCache.get(token);
  if (cached) return cached;

  const forms = new Set([token]);

  const group = GROUP_OF.get(token);
  if (group) for (const member of group) forms.add(member);

  // Regular KJV inflection. Only worth generating for word-like tokens; a
  // digit or a 2-char token has no archaic paradigm and the misses cost
  // posting lookups.
  if (token.length >= 3 && !/^\d+$/.test(token)) {
    const endsWithE = token.endsWith('e');
    const stem = endsWithE ? token.slice(0, -1) : token;
    // love -> loveth / lovest ; keep -> keepeth / keepest
    forms.add(`${stem}eth`);
    forms.add(`${stem}est`);
    if (endsWithE) {
      forms.add(`${token}th`);
      forms.add(`${token}st`);
    }
    // Plural / third-person -s, so "nation" also accepts "nations".
    if (!token.endsWith('s')) forms.add(`${token}s`);
  }

  const out = Object.freeze([...forms]);
  // Bounded memo. Query vocabulary is small; the bound is here so a future
  // caller that feeds corpus text cannot grow this without limit.
  if (formsCache.size >= CACHE_LIMIT) formsCache.clear();
  formsCache.set(token, out);
  return out;
}

/** True when two tokens are the same word in different KJV/modern clothes. */
export function isArchaicEquivalent(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return archaicFormsOf(a).includes(b);
}

/** Exposed for tests and for anyone auditing the table. */
export function archaicTokenGroups() {
  return TOKEN_GROUPS;
}
