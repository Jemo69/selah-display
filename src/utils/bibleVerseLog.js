// Decision helper for the Bible verse request log (bibleVerseLog).
// The log holds plain reference strings only (e.g. "Matthew 1:1").

/** Trim a reference to its log form; non-strings become ''. */
export function normalizeVerseLogReference(reference) {
  return typeof reference === 'string' ? reference.trim() : '';
}

/**
 * True when sending this verse counts as a new request worth logging.
 * First-slide sends always log (including intentional re-sends). Sends
 * that start on a later slide (previous-verse landing, direct slide pick)
 * log only when they show a different reference than the verse already
 * displayed — same-reference slide navigation is not a new request. The
 * reference comparison only applies when Bible content is displayed; a
 * song or note that happens to share the name never suppresses logging.
 */
export function shouldLogBibleVerseRequest({ slideIndex, reference, previousReference, previousContentMode }) {
  const cleaned = normalizeVerseLogReference(reference);
  if (!cleaned) return false;
  if (!Number.isInteger(slideIndex) || slideIndex === 0) return true;
  if (previousContentMode !== 'bible') return true;
  return normalizeVerseLogReference(previousReference) !== cleaned;
}
