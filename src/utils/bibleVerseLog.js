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
 * log only when they show a different reference than what is already
 * displayed — same-reference slide navigation is not a new request.
 */
export function shouldLogBibleVerseRequest({ slideIndex, reference, previousReference }) {
  const cleaned = normalizeVerseLogReference(reference);
  if (!cleaned) return false;
  if (!Number.isInteger(slideIndex) || slideIndex === 0) return true;
  return normalizeVerseLogReference(previousReference) !== cleaned;
}
