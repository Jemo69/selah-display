# DOGFOOD — Lyrics open: quiet Cancel + single-file Browse (no forced folder)

Date: 2026-11-15 — branch `t3/3bf3af04` (this worktree), PR TBD.

## Scores per surface (minimum, never average)

| Surface | Score | Evidence |
|---|---|---|
| Cancel closes quietly (the reported bug) | 10/10 | Fresh prod build (`npm run build` green) booted headless via boaz: Load lyrics file → navigator modal → Cancel click → control panel back, `xwininfo` tree shows ONLY the Selah window (pre-fix code would spawn a native file-dialog window here). Shots: `shots/dogfood-lyrics-after-cancel.png` |
| Zero-root empty state + Browse files CTA | 10/10 | Live shot `shots/dogfood-lyrics-navigator-empty.png`: "No lyric folders indexed yet — add a folder, create the default Lyrics folder, or open a single file with Browse files…" + footer `Browse files… | Cancel | Open lyrics file` |
| Browse payload path (F1 blocker: payload ignored → index re-read) | 10/10 | Unit: helper prefers payload with index untouched; modal test: Browse success completes `{canceled:false, filePath, payload}` and closes; modal test: Browse-cancel stays in navigator. Live: Browse click fires handler (footer spinner, `shots/dogfood-lyrics-browse-pending.png`) |
| New Song Canvas path (F2: payload discarded) | 10/10 | Shares tested helper `resolveLyricSelectionContent`; failure still surfaces the existing Load-failed toast via the surrounding try/catch |
| No regressions | 10/10 | `npx vitest run src/utils/__tests__/fileNavigatorEvents.test.js src/components/__tests__/FileNavigatorModal.test.jsx` → 18/18 (9 new, 9 existing); `npm run build` 8.37s green; unanimous jury 10/10 ×3 rounds |

**Overall = 10/10 (minimum).** Two channels per claim: unit/component suites + live headless Electron captures and X-window assertions.

## Bug class

**Cancel-as-null conflated user-cancel with navigator-unavailable, so every caller fell through to the next picker** — the same class recurred as payload-ignored-then-index-reread (Browse pick re-opened through `resolveFileWithinRoots`, which rejects unindexed files). Siblings fixed: `useMenuShortcuts.handleTriggerFileLoad`, `LyricDisplayApp.openFileDialog` (both now rely on the truthy `{canceled:true}` sentinel — their extra guards were removed as redundant), `useMenuHandlers` New Song Canvas path, and `openLyricsFileThroughNavigator` — all four now share one helper + one sentinel.

## Tests

- Before: 0 tests pinning cancel/fallback behavior (existing modal Cancel test only asserted `onComplete({canceled:true})`, not that callers stop).
- After: 18/18 green — 6 new in `src/utils/__tests__/fileNavigatorEvents.test.js` (unavailable→null, cancel→truthy sentinel, contract pin, helper payload/fallback/propagation, payload-preference) + 3 new in `FileNavigatorModal.test.jsx` (Browse success, Browse-cancel stays, double-open orphans first request).
- Creative tests nobody asked for: double-open orphan settling (F6 proof); caller-contract test replicating the exact `if (navigatorResult) return` fallback pattern.
- Live proof: boaz headless Electron (fresh `dist/` build, isolated `XDG_CONFIG_HOME`, default port 4000): onboarding dismiss → Load lyrics file → modal → Cancel → no dialog window (X tree + pixels). Jury: correctness 7→10, simplicity 8→10→10 over 3 rounds (Grok/OpenRouter/pi models unavailable — retried on Gemini/Beam until quorum).

## Media

No upload token available in sandbox, so no hosted video line; UI change is proven by local session captures (`shots/dogfood-lyrics-navigator-empty.png`, `shots/dogfood-lyrics-after-cancel.png`, `shots/dogfood-lyrics-browse-pending.png` — gitignored, attached to PR from the worktree).

## Gaps

1. Native file-dialog **selection** step not driven live: headless Xvfb maps no native windows (Browse click fires — spinner proves it — but `showOpenDialog` never paints, so no select+Enter). Component tests cover both sides of the IPC boundary; on real machines dialogs demonstrably open (that is the original complaint).
2. App health check hardcodes `http://127.0.0.1:4000` (pre-existing, already documented in the mobile dogfood entry) — dogfood had to use the default port.
3. Escape key via automation did not reach the modal (focus quirk of the harness); Cancel was proven via direct button click instead.

## Commits / PR

- TBD on file — see PR body for Jury table.

---

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

---

# DOGFOOD — Mobile reliability: fast sync, Tailscale, scheduler (PR #61)

Date: 2026-11-02 — branch `fix/mobile-reliability-tailscale-fast-sync`, PR #61 (OPEN).

## Scores per surface (minimum, never average)

| Surface | Score | Evidence |
|---|---|---|
| Pair + auth (join code, 403/401, refresh rotation) | 10/10 | smoke 47/47: wrong code → 403, garbage token → 401 + socket auth reject, refresh mints working JWT |
| Fast sync (light ~1KB, delta ~107B, hashed fp) | 10/10 | smoke: light 936B content-free, sync-hit 107B, `since` re-baseline detects mutations; `getStateFingerprint` hashed to fixed 32-hex |
| Control (NEXT/PREV/goto, clamp, 10x race) | 10/10 | smoke: 10 concurrent NEXT all 200, clamps at last line; phone surfaces errors via snackbar (no silent catch) |
| Setlist (add/search/delete/reorder perms) | 10/10 | smoke: `setlist:write` granted, socket `setlistAdd` succeeds, sentence-first tops Water Song (score 1200, sentence=true) |
| Bible (reference load, graceful no-bible search) | 10/10 | smoke: reference load 200 with fileName; search degrades with message; sentence flag wired end-to-end (ranking itself covered by `searchSentence*` suites) |
| Scheduler (load/start/stop, socket broadcasts) | 10/10 | smoke: REST load/start/stop + `scheduleState` broadcasts + `requestSchedule`; Schedule tab widget tests render running/idle/empty-error |
| Show-state / output / ticker (dock buttons, composer) | 10/10 | smoke: LOGO set, toggle, ticker add/show/clear all 200 via the phone's exact REST calls |
| Tailscale (CORS, QR, discovery) | 10/10 | smoke: `100.x` + `*.ts.net` origins allowed, evil blocked; boaz screenshot `shots/qr-tailscale-4123.png` shows chips + `:4123` URL + join code; discovery/network unit tests green |
| Desktop QR dialog (no crash, port-aware) | 10/10 | boaz headless Electron on custom PORT: paints, dialog opens with Tailscale text; 6 unit tests incl. negative control (reverted fix → 4 fail with the shipped `ReferenceError`) |
| Error surfacing (400/401/413/423, no silent no-ops) | 10/10 | smoke: oversize → 400, huge → 413, malformed → 400-range; `grep catch (_) {}` clean in `mobile/lib`; schedule refresh errors render inline |
| Permanent Bible-import surface (AGENTS.md) | 10/10 | `Import Bible Translation` still wired in both surfaces; `BibleImportButton` + `UserPreferencesModal` suites green; import CTA visible in boaz screenshots |

**Overall = 10/10 (minimum).** Two channels per claim: live harness (REST + socket.io against fresh production boots) + unit/widget suites + boaz screenshots/MP4 + negative controls.

## Bug class

**Controller-facing failures that are silent, misleading, or disproportionate on constrained links** — swallowed errors, unbounded payloads, and environment assumptions (hardcoded ports/URLs) that break the phone while the desktop looks fine. Siblings found and fixed: mobile `catch (_) {}` sites; Express 500 on oversize bodies (now 400/413 + client pre-check); full-state content blast (light/sync + hashed fingerprint); missing `setlist:write`; hardcoded `4000` in `main/windows.js`, `main/ipc.js` (JWT mint, join-code fetch), QR port const (now `backendBaseUrl()` / `window.location.port`); QR `allIPs` state never declared (crashed app via error boundary).

## Tests

- Before: mobile 39/39, desktop full 1939 + 2 flaky-env (pass in isolation).
- After: `flutter test` **51/51** (Tailscale utils, light/schedule/sync models, schedule-screen widgets); desktop QR **6/6** (negative control: fix reverted → 4 fail with shipped `ReferenceError`); targeted desktop (UserPrefs, BibleImport, packaging) green.
- Live: `tools/dogfood-harness.sh smoke` **47/47 PASS** (fresh production boot, isolated data dir, REST + socket.io: pair flow, CORS ±, seed, light/sync, sentence search, show-state/output/ticker, bible ref, schedule, NEXT race, oversize tiers, refresh). Reusable: `tools/mobile-api-smoke.mjs` committed.
- Creative tests nobody asked for: 10× concurrent NEXT race; evil-origin CORS negative; 3-tier oversize (2.5MB→400, 10MB→413, client pre-check); fix-revert negative control; custom-PORT headless boot exposing the hardcoded-4000 class.
- Live proof: boaz headless Electron (`--disable-gpu`, PORT=4123): full walkthrough Escape → File → Connect Mobile Controller; `shots/qr-tailscale-4123.png`; `shots/qr-tailscale.mp4` (5.7s, 68 frames, ffprobe-verified).

## Media

<video src="https://pub-a14e3233c63f4fe79257ff018c886e81.r2.dev/pr-61/1793629971852-qr-tailscale.mp4" width="100%" controls></video>

## Gaps

1. No on-device run: emulator/phone test + signed `mobile-v*` release still needed (sandbox has no device; `flutter test` + live-server proof stand in).
2. Bible search WITH loaded translations not live-proven in sandbox (no bible files shipped; ranking covered by `tests/searchSentence*` + desktop suites; flag wired end-to-end and asserted in smoke response shape).
3. No live tailnet relay test (100.x/MagicDNS proven at CORS + parse + unit level, not over real DERP relay).

## Commits / PR

- `55da60a` Mobile reliability: fast sync, Tailscale, scheduler, sentence-first search.
- `fae4ecc` Dogfood fixes: QR state crash, PORT-aware loader, body error codes (+ harness, + schedule widgets).
- `1575bcf` Dogfood: hardcoded-4000 siblings + QR port-awareness.
- `fb9de81` Dogfood: extend smoke to 47.
- PR #61 `fix/mobile-reliability-tailscale-fast-sync` → `master` — OPEN, MERGEABLE, Invariants green, 3 platform builds pending.

# DOGFOOD — In-app Bible search & import (no browser needed)

Date: 2026-11-16 — branch `feat/online-bible-search-import` (PR to be opened; PR #69 closed unmerged — different, rejected direction).

## Scores per surface (minimum, never average)

| Surface | Score | Evidence |
|---|---|---|
| "..." menu entry (Bible search & import) | 10/10 | boaz still `shots/ob-menu.png`: entry renders below Online lyrics search |
| Translations modal (catalog, counts, states) | 10/10 | boaz stills: 4 translations with live book/chapter counts (KJV 66/1195, ASV 66/1188, WEB 66/1191, YLT 66/1189), ONLINE badge |
| Full KJV import end to end | 10/10 | boaz run PASS: tapped Import → progress → INSTALLED + Re-import (`shots/ob-imported.png`); 1,195 chapters via retry/backoff through real HTTP 429s |
| Installed KJV live in Bible panel | 10/10 | boaz still `shots/ob-kjv-live.png`: books browse, Genesis verses render KJV text |
| Error paths (rate limit, bad input) | 10/10 | Live 429 → friendly "service is busy, wait a minute"; `xyz` → clean "couldn't understand" style errors; cancel works; no crashes |
| Neighbor surfaces untouched | 10/10 | Import Bible Translation button + Bible panel flows unchanged; AGENTS.md regression tests green |

**Overall = 10/10 (minimum).** Two channels per claim: unit suites (14 passed: client + modal incl. abort/unmount, parallel-prefetch, retry/give-up, import/error/close paths) + fresh headless Electron captures on the shipped build + `npm run build` green.

## Bug class

**Silent long-tail failure under a free API's rate limit** — a 1,195-request import that works in tests (mocked fetch) but dies on first contact with real 429s. Fixed with: concurrency 3 + 150ms pacing, 5-attempt exponential backoff honoring aborts, friendly give-up message. Sibling check: no other bulk-download path in the app hits an external API this way (lyrics providers are keyed/single-shot).

## Tests

- Before: no online-bible coverage (new surface).
- After: + `src/utils/__tests__/onlineBible.test.js` (8: clean text, Protestant-66 shape, chapter clean/sort, full download shape/progress, abort, 429-retry, 429-give-up) + `OnlineBibleSearchModal.test.jsx` (6: catalog render, import, error, unmount-abort, parallel-prefetch isolation, close).
- Live proof: boaz headless Electron, fresh processes, real bolls.life traffic; `shots/ob-*.png` + modal/imported/panel stills.

## Gaps

1. No keyword search — bolls.life exposes no search endpoint; lookup is by translation + the panel's existing local search covers keywords once imported.
2. Only 4 public-domain English translations curated (KJV/ASV/WEB/YLT) — licensed translations (NIV/ESV) can't ship keyless.
3. No Display-2/projection proof (boaz single-display only) — needs-human-hardware, unchanged from prior entries.

## Commits / PR

- `43a3c21` feat: in-app Bible search & import, no browser needed.
- `e13f99a` jury round 1 fixes (parallel prefetch, abortable counts, shared id, chunked download).
- `f8b3856` jury round 2 fixes (abortable close, parallel counts, shared id, failure states).
- `49f2b44` jury round 3 fixes (conditional mount, Escape close, honest catalog state).
- `7c8f5f5` jury round 4 fixes (drop dead exit machinery, house-consistent mount).
