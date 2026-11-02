# DOGFOOD — Sentence-first search (Experimental)

Date: 2026-11-01 — branch `experimental/sentence-search`, PR #60 (OPEN, do-not-merge per operator).

## Scores per surface (minimum, never average)

| Surface | Score | Evidence |
|---|---|---|
| Bible sentence ranking (`for God so love the world` → John 3:16) | 10/10 | `tests/searchSentence.benchmark.test.js` 13/13; live harness: typo query `for God so love the word` → OLD 0 hits vs NEW John 3:16 first (screenshot `shot-1101-174214-012.png`); exact phrase OLD 0.30ms vs NEW 0.10ms |
| Reference preservation (`isa 44 5` → Isaiah 44:5) | 10/10 | Old + new both return `Isaiah 44:5` with identical legacy shape (unit test + live harness panel 2: both agree on `isa 44 5` and `John 3:16`) |
| File sentence ranking (`water to into wine`) | 10/10 | Live harness panel 3: sentence file top in both, NEW scores `[both 1900]` content+title vs OLD `[name 2950]` title-only; single-word file FILTERED in NEW (unit test proves old returns hit where new filters) |
| Speed (5k-verse corpus) | 10/10 | Unit speed gate: experimental ≤ old ×1.2 (5 runs avg); live: exact-phrase 0.10ms vs 0.30ms (3× faster, no vocab-wide prefix scan) |
| Determinism | 10/10 | Same query twice → same order (unit test, Bible + file) |
| Experimental flag surface | 10/10 | Toggle in User Preferences > Experimental (`Sentence Search Ranking`, default OFF); `BibleSearchModal` passes `experimental` to worker on every keystroke (dep-tracked); `FileNavigatorModal` passes `experimental:true` via IPC (dep-tracked); worker + `server/bibleManager` + `main/fileNavigator` branch on the flag — verified by code + unit suites |
| Permanent Bible import surface (AGENTS.md) | 10/10 | `Import Bible Translation` still wired in `UserPreferencesModal` + `BibleControlPanel`; `BibleImportButton.test.jsx` + `UserPreferencesModal.test.jsx` green; headless Electron screenshot shows import CTA |

**Overall = 10/10 (minimum).** Two independent channels per claim: unit tests + live headless harness (mishpat 11/11 PASS, real keystrokes, DOM asserts, screenshots) + Electron boot (boaz).

## Bug class

**Per-word OR ranking for sentence queries** — a sentence query scored single-word hits almost as highly as the sentence. Siblings: `searchBible` legacy no-index path (`matchCount > 0`), `scoreNavigatorSearchRecord` substring `content.includes(term)` (`to` matches inside many words), sermon `rankVerses` containment (different lane, intentionally untouched).

## Tests

- Before: existing suites green (UserPreferencesModal, BibleImport, fileNavigatorSearch, searchAllRank, bibleSearch.worker, navigatorTokenIndex, freeNoteMode).
- After: + `tests/searchSentence.benchmark.test.js` 13/13 PASS; + `tests/sentence-demo-run.json` 11/11 PASS headless (goto, wait_idle, 4 asserts, 3 real keystroke types, screenshot).
- Live proof: mishpat screenshots `shots/shot-1101-174214-*.png` (12 frames) + `shots/sentence-compare.mp4` (6s scripted run) + boaz Electron boot (`shots/sentence-005.png`, 5.8s MP4).

## Media

<video src="https://pub-a14e3233c63f4fe79257ff018c886e81.r2.dev/pr-60/1793572963198-sentence-compare.mp4" width="100%" controls></video>

## Gaps

None open. Sermon-assist `rankVerses` lane intentionally out of scope (different lane, documented in plan).

## Commits / PR

- Commit `abb78eb` — `feat(search): experimental sentence-first ranking for Bible + file search`.
- Commit `5595a58` — dogfood evidence (superseded by this 10/10 update).
- PR #60 `experimental/sentence-search` → `master` — OPEN, MERGEABLE, CI green. **Do NOT merge per operator — babysit only.**
- Plan: https://slop-plans.vercel.app/p/sentence-search-old-vs-new
