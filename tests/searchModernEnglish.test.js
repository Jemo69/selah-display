/**
 * The bridge between how an operator types and how the KJV words it.
 *
 * The user's report: they searched the sense of a verse in their own English
 * and the KJV verse did not come back. Two separate reasons, both covered here:
 *
 *   1. VOCABULARY. They typed "has", the corpus says "hath". Retrieval is a
 *      literal posting lookup, so the verse was never a candidate. The fix is
 *      query-side expansion (shared/bible/archaicForms.js), and the tests below
 *      prove the candidate now exists AND scores as an exact hit.
 *   2. ORDER. They typed the sense in their own clause order. The ordered walk
 *      gave up at 60% coverage even though every word was in the verse. The fix
 *      is the bag-of-words tier in scoreSentenceVerse, which must always rank
 *      BELOW an equivalent ordered match.
 *
 * The compact corpus uses real KJV wording so these assertions mean something.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { buildSearchIndex, parseBible, searchBible, searchBibleExperimental } from 'shared/bible/index.js';
import {
  archaicFormsOf,
  archaicTokenGroups,
  isArchaicEquivalent,
} from 'shared/bible/archaicForms.js';
import { scoreSentenceVerse, sentenceContentTokens } from 'shared/bible/sentenceSearch.js';

// --- table discipline -----------------------------------------------------

const TOKEN_SHAPE = /^[a-z0-9]+$/;

describe('archaic form table', () => {
  it('keeps every token single, normalized, and owned by one group', () => {
    const owner = new Map();
    for (const group of archaicTokenGroups()) {
      expect(group.length).toBeGreaterThan(1);
      for (const token of group) {
        expect(token).toMatch(TOKEN_SHAPE);
        // Duplicate membership would make the result depend on table order,
        // which is exactly the class of bug nobody debugs a year later.
        expect(owner.has(token) ? `${token} in ${owner.get(token)} and ${group[0]}` : null).toBeNull();
        owner.set(token, group[0]);
      }
    }
  });

  it('bridges the archaisms that actually break a modern query', () => {
    expect(isArchaicEquivalent('has', 'hath')).toBe(true);
    expect(isArchaicEquivalent('says', 'saith')).toBe(true);
    expect(isArchaicEquivalent('love', 'loveth')).toBe(true);
    expect(isArchaicEquivalent('love', 'charity')).toBe(true);
    expect(isArchaicEquivalent('spirit', 'ghost')).toBe(true);
    expect(isArchaicEquivalent('alive', 'quick')).toBe(true);
    expect(isArchaicEquivalent('food', 'meat')).toBe(true);
    expect(isArchaicEquivalent('clothing', 'raiment')).toBe(true);
    expect(isArchaicEquivalent('forgiveness', 'remission')).toBe(true);
    expect(isArchaicEquivalent('conduct', 'conversation')).toBe(true);
    expect(isArchaicEquivalent('taking', 'getteth')).toBe(true);
  });

  it('generates regular -eth/-est endings it has no table row for', () => {
    expect(archaicFormsOf('hope')).toContain('hopeth');
    expect(archaicFormsOf('keep')).toContain('keepeth');
    expect(archaicFormsOf('pray')).toContain('prayeth');
    expect(archaicFormsOf('pray')).toContain('prayest');
  });

  it('never drops the token the operator actually typed', () => {
    for (const token of ['has', 'charity', 'hath', 'world', 'pray']) {
      expect(archaicFormsOf(token)).toContain(token);
    }
    expect(archaicFormsOf('')).toEqual([]);
  });

  it('leaves unrelated words alone', () => {
    expect(isArchaicEquivalent('world', 'word')).toBe(false);
    expect(isArchaicEquivalent('grace', 'grief')).toBe(false);
  });
});

// --- scoring: the ordered winner must survive ----------------------------

describe('scoreSentenceVerse tiering', () => {
  const query = 'god gave his son because he loved the world';
  const content = sentenceContentTokens(query);
  const variants = content.map((t) => new Set(archaicFormsOf(t)));

  it('rescues a paraphrase whose words are all present out of order', () => {
    const verse = 'For God so loved the world, that he gave his only begotten Son';
    const bridged = scoreSentenceVerse(query, content, verse, null, variants);
    expect(bridged).not.toBeNull();
    expect(bridged.coverage).toBe(1);
    expect(bridged.paraphrase).toBe(true);
  });

  it('counts a KJV spelling as the word the operator typed', () => {
    // "says" is a content token; without the table it can only reach "saith"
    // through fuzz, and fuzz is not exactness.
    const saysQuery = 'jesus says i am the way the truth and the life';
    const saysContent = sentenceContentTokens(saysQuery);
    const saysVariants = saysContent.map((t) => new Set(archaicFormsOf(t)));
    const verse = 'Jesus saith unto him I am the way the truth and the life no man cometh unto the Father but by me';
    const bridged = scoreSentenceVerse(saysQuery, saysContent, verse, null, saysVariants);
    const plain = scoreSentenceVerse(saysQuery, saysContent, verse);
    expect(bridged.exact).toBe(saysContent.length);
    expect(bridged.exact).toBeGreaterThan(plain.exact);
    expect(bridged.score).toBeGreaterThan(plain.score);
  });

  it('ranks an ordered hit above the same words out of order', () => {
    const orderedVerse = 'God gave his only son because he loved the world';
    const looseVerse = 'The world loved his only son and God gave';
    const ordered = scoreSentenceVerse(query, content, orderedVerse, null, variants);
    const loose = scoreSentenceVerse(query, content, looseVerse, null, variants);
    expect(ordered.coverage).toBe(1);
    expect(ordered.paraphrase).toBeUndefined();
    expect(loose.paraphrase).toBe(true);
    expect(ordered.score).toBeGreaterThan(loose.score);
  });

  it('still rejects a one-word coincidence posing as a sentence', () => {
    const verse = 'And God made the beast of the earth after his kind';
    expect(scoreSentenceVerse(query, content, verse, null, variants)).toBeNull();
  });
});

// --- integration through the real search path ----------------------------

const KJV_STYLE = {
  id: 'kjv-style',
  name: 'KJV STYLE',
  books: [
    { number: 1, name: 'Genesis', abbreviation: 'Gen', chapters: [{ number: 1, verses: [
      { number: 1, text: 'In the beginning God created the heaven and the earth' },
      { number: 3, text: 'And God said Let there be light and there was light' },
    ] }] },
    { number: 19, name: 'Psalms', abbreviation: 'Ps', chapters: [{ number: 23, verses: [
      { number: 1, text: 'The LORD is my shepherd I shall not want' },
    ] }, { number: 110, verses: [
      { number: 1, text: 'The LORD said unto my Lord Sit thou at my right hand until I make thine enemies thy footstool' },
    ] }] },
    { number: 43, name: 'John', abbreviation: 'Jn', chapters: [
      { number: 3, verses: [
        { number: 16, text: 'For God so loved the world that he gave his only begotten Son that whosoever believeth in him should not perish but have everlasting life' },
      ] },
      { number: 14, verses: [
        { number: 1, text: 'Let not your heart be troubled ye believe in God believe also in me' },
        { number: 6, text: 'Jesus saith unto him I am the way the truth and the life no man cometh unto the Father but by me' },
      ] },
    ] },
    { number: 55, name: '2 Timothy', abbreviation: '2 Tim', chapters: [{ number: 1, verses: [
      { number: 7, text: 'For God hath not given us the spirit of fear but of power and of love and of a sound mind' },
    ] }] },
    { number: 60, name: '1 Peter', abbreviation: '1 Pet', chapters: [{ number: 5, verses: [
      { number: 7, text: 'Casting all your care upon him for he careth for you' },
    ] }] },
    { number: 62, name: '1 John', abbreviation: '1 Jn', chapters: [{ number: 2, verses: [
      { number: 15, text: 'Love not the world neither the things that are in the world' },
    ] }] },
  ],
};

/**
 * Give the corpus the same lookup maps finishBibleParse() adds, then the real
 * posting index — without the maps the indexed path (the one production uses)
 * is not exercised at all.
 */
function indexBible(bible) {
  const bookMap = {};
  for (const book of bible.books) {
    bookMap[book.number] = book;
    const chapterMap = {};
    for (const chapter of book.chapters) {
      chapterMap[chapter.number] = chapter;
      const verseMap = {};
      for (const verse of chapter.verses) verseMap[verse.number] = verse;
      chapter.verseMap = verseMap;
    }
    book.chapterMap = chapterMap;
  }
  return { ...bible, bookMap, searchIndex: buildSearchIndex(bible) };
}

const INDEXED = indexBible(KJV_STYLE);
const top = (query, limit = 5) => searchBibleExperimental(INDEXED, query, {}, limit);

describe('modern English finds the KJV verse (indexed corpus)', () => {
  it('"has" reaches the verse that says "hath"', () => {
    expect(top('god has not given us a spirit of fear')[0]?.reference).toBe('2 Timothy 1:7');
  });

  it('"says" reaches the verse that says "saith"', () => {
    expect(top('jesus says i am the way the truth and the life')[0]?.reference).toBe('John 14:6');
  });

  it('"worries" reaches the verse that says "careth"', () => {
    const refs = top('casting all your worries on him because he cares for you').map((r) => r.reference);
    expect(refs[0]).toBe('1 Peter 5:7');
  });

  it('a paraphrase in the operator\'s clause order still finds John 3:16', () => {
    const refs = top('god gave his son because he loved the world').map((r) => r.reference);
    expect(refs[0]).toBe('John 3:16');
  });

  it('keeps the ambiguity policy: the literal verse leads, the near verse stays visible', () => {
    const refs = top('so love the world that').map((r) => r.reference);
    expect(refs[0]).toBe('1 John 2:15');
    expect(refs).toContain('John 3:16');
  });

  it('leaves a verbatim KJV quote exactly where it was', () => {
    expect(top('for God so loved the world')[0]?.reference).toBe('John 3:16');
    expect(top('let not your heart be troubled')[0]?.reference).toBe('John 14:1');
  });

  it('leaves references alone — the bridge is not in that path', () => {
    expect(top('john 14 6')[0]?.reference).toBe('John 14:6');
    expect(searchBible(INDEXED, 'john 14 6', {}, 5)[0]?.reference).toBe('John 14:6');
  });

  it('does not turn a single common word into a sentence match', () => {
    const refs = top('light').map((r) => r.reference);
    expect(refs).toContain('Genesis 1:3');
  });
});

// --- the same claims against a real KJV, when one is on this machine -----

const KJV_PATH = '/home/jemo/projects/video-psalm-reverse-eng-v-2/gpui-app/bibles/KJV.xml';
const HAS_KJV = existsSync(KJV_PATH);

describe.skipIf(!HAS_KJV)('modern English finds the KJV verse (real KJV)', () => {
  let kjv;

  beforeAll(async () => {
    kjv = parseBible(await readFile(KJV_PATH, 'utf8'), 'KJV');
    expect(kjv.books.length).toBe(66);
  });

  const cases = [
    ['god has not given us a spirit of fear', '2 Timothy 1:7'],
    ['jesus says i am the way the truth and the life', 'John 14:6'],
    ['god gave his son because he loved the world', 'John 3:16'],
    ['money is the root of all evil', '1 Timothy 6:10'],
    ['the lord is my shepherd i shall not want', 'Psalm 23:1'],
  ];

  for (const [query, expected] of cases) {
    it(`${JSON.stringify(query)} -> ${expected}`, () => {
      expect(searchBibleExperimental(kjv, query, {}, 5)[0]?.reference).toBe(expected);
    });
  }

  it('the same queries still work when typed as the KJV words', () => {
    expect(searchBibleExperimental(kjv, 'for God so loved the world', {}, 5)[0]?.reference).toBe('John 3:16');
  });
});
