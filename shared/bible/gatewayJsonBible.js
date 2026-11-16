import createSharedLogger from '../logger.js';

const log = createSharedLogger('GatewayJsonBible');

// Canonical book order matching bible_gateway.py in bible-translations
export const GATEWAY_BOOK_ORDER = [
  'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges', 'Ruth',
  '1 Samuel', '2 Samuel', '1 Kings', '2 Kings', '1 Chronicles', '2 Chronicles', 'Ezra',
  'Nehemiah', 'Esther', 'Job', 'Psalm', 'Proverbs', 'Ecclesiastes', 'Song Of Solomon',
  'Isaiah', 'Jeremiah', 'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos',
  'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk', 'Zephaniah', 'Haggai', 'Zechariah',
  'Malachi', 'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans', '1 Corinthians',
  '2 Corinthians', 'Galatians', 'Ephesians', 'Philippians', 'Colossians', '1 Thessalonians',
  '2 Thessalonians', '1 Timothy', '2 Timothy', 'Titus', 'Philemon', 'Hebrews', 'James',
  '1 Peter', '2 Peter', '1 John', '2 John', '3 John', 'Jude', 'Revelation'
];

export function isGatewayJsonObject(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const keys = Object.keys(data).filter((k) => k !== 'Info');
  if (keys.length === 0) return false;
  // At least one key must be a known book whose value is { chapter: { verse: string } }
  return keys.some((book) => {
    if (!GATEWAY_BOOK_ORDER.includes(book)) return false;
    const chapters = data[book];
    if (!chapters || typeof chapters !== 'object') return false;
    return Object.values(chapters).some(
      (verses) =>
        verses &&
        typeof verses === 'object' &&
        Object.values(verses).some((text) => typeof text === 'string')
    );
  });
}

export function parseGatewayJsonBible(content, fileName = 'bible') {
  log.info('parseGatewayJsonBible: parsing Bible Gateway JSON');
  let data;
  try {
    data = JSON.parse(content);
  } catch (e) {
    log.warn('parseGatewayJsonBible: invalid JSON');
    return { name: fileName, books: [] };
  }
  if (!isGatewayJsonObject(data)) {
    return { name: fileName, books: [] };
  }
  if (data.Info) delete data.Info;

  const books = [];
  const orderedNames = GATEWAY_BOOK_ORDER.filter((name) => data[name]);
  // Include any extra books not in the canonical order (e.g. alternate names)
  for (const key of Object.keys(data)) {
    if (key !== 'Info' && !orderedNames.includes(key)) orderedNames.push(key);
  }

  orderedNames.forEach((bookName, index) => {
    const chaptersObj = data[bookName];
    if (!chaptersObj || typeof chaptersObj !== 'object') return;
    const chapters = Object.keys(chaptersObj)
      .map((n) => parseInt(n, 10))
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b)
      .map((chapterNumber) => {
        const versesObj = chaptersObj[String(chapterNumber)] || {};
        const verses = Object.keys(versesObj)
          .map((n) => parseInt(n, 10))
          .filter((n) => Number.isInteger(n))
          .sort((a, b) => a - b)
          .map((verseNumber) => ({
            number: verseNumber,
            text: String(versesObj[String(verseNumber)] ?? '').replace(/\s+/g, ' ').trim()
          }))
          .filter((v) => v.text.length > 0);
        return { number: chapterNumber, verses };
      })
      .filter((c) => c.verses.length > 0);

    if (chapters.length === 0) return;
    books.push({
      number: GATEWAY_BOOK_ORDER.indexOf(bookName) >= 0 ? GATEWAY_BOOK_ORDER.indexOf(bookName) + 1 : index + 1,
      name: bookName,
      abbreviation: bookName,
      chapters
    });
  });

  log.info(`parseGatewayJsonBible: parsed ${books.length} books`);
  return {
    name: fileName,
    metadata: { source: 'bible-translations (Bible Gateway JSON)' },
    books
  };
}
