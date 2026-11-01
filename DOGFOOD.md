# DOGFOOD — Sentence-first search (Experimental)

Date: 2026-11-01 — branch `experimental/sentence-search`, PR #60 (OPEN, do-not-merge per operator).

## Scores per surface (minimum, never average)

| Surface | Score | Worst deviation + evidence |
|---|---|---|
| Bible sentence ranking (`for God so love the world` → John 3:16) | 10/10 | `tests/searchSentence.benchmark.test.js` 13/13 pass; experimental ranks John 3:16 first, typo `word`→`world` tolerated |
| Reference preservation (`isa 44 5` → Isaiah 44:5) | 10/10 | old + experimental both return `Isaiah 44:5` with identical legacy shape (test asserts `book/chapter/verse/reference`) |
| File sentence ranking (`water to into wine`) | 10/10 | sentence file outscores scattered file; single-word file filtered (test asserts) |
| Speed (5k-verse corpus) | 10/10 | experimental ≤ old ×1.2 (5 runs avg, warm JIT); design removes vocab-wide prefix scan |
| Determinism | 10/10 | same query twice → same order (Bible + file) |
| Experimental flag surface | 9/10 | Toggle renders in User Preferences > Experimental (`Sentence Search Ranking`, default OFF); wired into `BibleSearchModal` worker + `FileNavigatorModal` IPC. −1: live toggle-click not driven in headless (empty Bible library, no corpus to type into) |
| Permanent Bible import surface (AGENTS.md) | 10/10 | `Import Bible Translation` still wired in `UserPreferencesModal` + `BibleControlPanel`; `BibleImportButton.test.jsx` + `UserPreferencesModal.test.jsx` green; headless screenshot shows import CTA |

**Overall = 9/10 (minimum).** FAIL to claim 10/10 because the live headless sentence keystroke with a real translation was not driven (empty library). Not a code gap — a harness gap.

## Bug class

**Per-word OR ranking for sentence queries** — a sentence query scored single-word hits almost as highly as the sentence. Siblings: `searchBible` legacy no-index path (`matchCount > 0`), `scoreNavigatorSearchRecord` substring `content.includes(term)` (`to` matches inside many words), sermon `rankVerses` containment (different lane, left untouched).

## Tests

- Before: existing suites green (UserPreferencesModal, BibleImport, fileNavigatorSearch, searchAllRank, bibleSearch.worker, navigatorTokenIndex, freeNoteMode).
- After: + `tests/searchSentence.benchmark.test.js` 13/13 pass. Full re-run of touched suites: 29 + 28 + 8 tests green. No regressions.
- Live proof: Boaz headless Electron boots on :100 (`shots/sentence-005.png` shows Bible panel + import CTA), 5.8s MP4 recorded.

## Media

<video src="https://pub-a14e3233c63f4fe79257ff018c886e81.r2.dev/pr-60/1793572052025-sentence-demo.mp4" width="100%" controls></video>

## Gaps (honestly unmet)

- Live bible-corpus sentence keystroke in headless not driven (empty library — needs `Import Bible Translation` + typed `for God so love the world` in a `boaz run` flow).
- Sermon-assist `rankVerses` lane still containment-scored (intentional: different lane, out of scope).
- Video shows headless boot, not a side-by-side old-vs-new keystroke comparison (benchmark table in slop-plans report carries the comparison).

## Commits / PR

- Commit `abb78eb` — `feat(search): experimental sentence-first ranking for Bible + file search`.
- PR #60 `experimental/sentence-search` → `master` — OPEN, MERGEABLE, CLEAN, CI green. **Do NOT merge per operator — babysit only.**
- Plan: https://slop-plans.vercel.app/p/sentence-search-old-vs-new
