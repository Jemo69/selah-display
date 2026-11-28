# Changelog

## [Unreleased]

### Added

- **Limited text scope for Bible search (experimental):** name a passage — `Acts 6`, `Acts 6:1-10`, `Acts 6-7`, `Rom 8:38-9:2` — and the next word or sentence is searched inside that passage only. The scope field appears in the verse-search tray and the Bible search window, and says in plain words what it is doing: "Searching only Acts 6:1-10" or "Not a passage yet — searching the whole Bible", so a typo never silently widens the search. Scoping narrows candidates only: ranking, typo tolerance and modern-English bridging behave exactly as they do canon-wide, the query never turns into a verse lookup while scoped, and a translation that lacks the scoped book is skipped rather than searched unscoped. Off by default and gated by **User Preferences → Experimental → Limited Text Scope**, so the field does not exist (and nothing narrows a search) until an operator turns it on (`shared/bible/index.js`, `src/utils/bibleSearch.worker.js`, `src/components/Bible/BibleControlPanel.jsx`, `src/components/Bible/BibleSearchModal.jsx`, `src/components/UserPreferencesModal.jsx`, `shared/appConfig.js`, `src/context/LyricsStore.js`, `src/utils/appConfigSync.js`, `tests/passageScope.test.js`).

- **Built-in MCP server for app configuration (`POST/GET/DELETE /mcp` + stdio bridge `server/mcp.js`):** AI assistants (Claude Desktop, Cursor, Antigravity, Codex) can now inspect and update Selah preferences, output styles, show state (`LIVE`/`CLEAR`/`BLACKOUT`/`LOGO`), mode templates, and Sermon Assist settings directly through the Model Context Protocol. Enabled on localhost by default (`127.0.0.1:4000/mcp`), with optional Bearer-authenticated LAN/remote access and copyable JSON configs in **User Preferences → MCP Server** (`shared/appConfig.js`, `server/mcpCore.js`, `server/mcpHttp.js`, `server/mcp.js`, `src/utils/appConfigSync.js`, `src/components/McpSettingsSection.jsx`).

- **Live-stream lower-third that never crops the preacher:** a built-in **Stream** output (`/stream`) renders only a transparent band at the bottom of the frame, so OBS/vMix can layer scripture over the camera instead of replacing it. Verses auto-fit the band (short verses grow, long passages shrink, the reference rides underneath), and the band height is adjustable from a quarter to three-quarters of the frame. Every regular output can opt into the same band from **Live Stream Band** in its settings (`src/pages/StreamOutput.jsx`, `src/pages/RegularOutput.jsx`, `src/utils/streamBand.js`, `src/components/OutputSettingsPanel.jsx`, `src/context/LyricsStore.js`, `server/events.js`).

- **Sunday service verse log:** every verse sent to display is appended to a human-readable service file in the app folder (`service-logs/service-YYYY-MM-DD.txt`, one file per day), so Sunday’s verses are on record after the service. Stepping through the slides of one verse logs one line, not one per slide. User Preferences > Bible shows today’s file with its verse count and a button that reveals it in the file manager (desktop app); the file is also readable remotely via `GET /api/service-log/today` (`shared/serviceVerseLog.js`, `server/serviceVerseLog.js`, `server/events.js`, `main/serviceVerseLogIpc.js`, `src/components/UserPreferencesModal.jsx`).

- **Lyric search that finds songs from any pasted line or stanza:** the file search now ranks whole-sentence holders first (tag-stripped, punctuation-insensitive matching, so stanzas spanning `[Verse]` dividers stay contiguous), tolerates inflections ("turn" finds lyric "turned" and back) and typos, and answers unique queries an order of magnitude faster via a precomputed token-position index, rarest-first candidate pruning, a per-query fuzzy-variant map, and a keystroke result cache. A pasted title always outranks lyric bodies holding the same words. Proven by 10,000 true-paste queries plus a 6396-query old-vs-new race (768 fixed, zero regressions) that run in CI (`shared/fileNavigatorSearch.js`, `shared/navigatorTokenIndex.js`, `shared/fileNavigatorSentence.js`, `main/fileNavigator.js`, `tests/searchLyricsV3.test.js`, `tests/searchTwoFolder.test.js`, `tests/searchAccuracy5000.test.js`, `tests/searchFullSentence10k.test.js`).

- **Foldable parallel-display block:** the parallel-translation control in the verse tray now folds to a one-line header, so it stops taking a full row of the tray while it is not in use. Collapsed, the header keeps reporting what the link is doing — translation name, "Hidden", or "Off" — so the operator never reopens it just to look. Folding is a UI concern only: it never touches the link, so a second translation stays paired across a reload (`src/components/Bible/ParallelBibleLinkControl.jsx`).
- **Live Sermon Assist (optional, off by default):** transcribe the sermon live and offer the operator three tap-to-use suggestions — the next lyric line, the Bible verse just quoted, and a running sermon note. Ships **disabled**: while it is off the app opens no microphone, starts no extra process, and makes no network request, and no suggestion ever reaches an output screen without an explicit press (`shared/speech/`, `src/context/SpeechStore.js`, `src/components/Speech/`, `main/speechEngine.js`, `speech-engine/`).
- **Live Sermon Assist settings (experimental):** the surface lives in User Preferences → Experimental behind a master switch and an Experimental badge, leading with *This Device / Network Device / Cloud*, then the provider, then the model list filtered to that provider (`src/components/Speech/SpeechSettingsSection.jsx`). It graduates to its own sidebar section once the native engine ships.
- **Measured model benchmark (experimental):** run a model against a reference clip *on the user's own computer* and show word error rate, real-time factor, first-partial latency, backend, and peak memory — because every other answer to "which model?" is a guess, and two guesses fail badly (silent CPU fallback, thermal decay). Results persist per model and engine version, so a re-benchmark is always deliberate. **The panel shows no numbers until a real engine is installed:** the only engine that runs today is the test engine, which reports `measured: false` and a stated reason instead of a plausible-looking WER. Cancel genuinely stops the work (`speech-engine/benchmark.js`, `src/speech/benchmark.js`, `shared/wer.js`, `src/components/Speech/ModelBenchmarkPanel.jsx`).
- **Resource guardrails sized to the machine (experimental):** the engine is suspended when it holds more than a fraction of *this* computer's memory or CPU, computed per machine rather than fixed — because an 8 GB church laptop and a 64 GB desktop need different limits. It warns before acting, needs sustained pressure to trip, and needs a cooldown and clean samples to come back, so it cannot oscillate mid-sermon (`main/speechGuardrails.js`).
- **Transcript redaction, with its limits stated next to it:** email addresses, phone numbers, government ID numbers, and street addresses are removed before a transcript is saved. The panel says plainly, beside the toggle, that it cannot catch names, dates of birth, or anything said in plain words — so a transcript is presented as private, not as anonymous (`shared/speech/redaction.js`, `src/components/Speech/SermonAssistSafetyPanel.jsx`).
- **One-click full erase with a real preview:** one action removes the engine, every model file, all transcripts, exports, and the stored benchmark results, and reports the bytes reclaimed. Two clicks by design — the confirmation quotes the actual size from a disk walk, because a single click can only say "this cannot be undone", which is the one sentence that trains people to click through destructive dialogs (`main/speechErase.js`, `src/components/Speech/EraseSermonAssistCard.jsx`).
- **In-app whisper.cpp engine installer:** the real recognition engine is now installable from the app instead of being something you had to place by hand. *Install speech engine* downloads the pinned official whisper.cpp release for this machine (~9 MB), verifies its SHA-256 against the value baked into the app, and unpacks the binary and its libraries into the app's data directory. Windows x64/ia32 and Linux x64/arm64 are supported; macOS is not, because upstream ships only an Xcode framework (`main/speechEngineInstaller.js`, `main/speechIpc.js`, `src/components/Speech/InstallEngineWizard.jsx`).
- **Engine self-test:** the engine card now has a *Test engine* button that actually runs `whisper-cli --help` and reports whether the operating system can load the binary, instead of only checking that a file exists. It is the difference between "installed" and "runnable", and it turns a silent empty transcript into one sentence with the fix (`main/speechEngineDiagnostics.js`, `main/speechIpc.js`, `src/components/Speech/InstallEngineWizard.jsx`).
- **Model catalog and resumable installer:** a real catalog of 29 models with published download sizes and RAM cost, opened on the best model rather than the smallest, with resumable downloads (`Range` continuation), checksum verification, and honest offline/drop-in handling (`shared/speech/models.catalog.json`, `main/speechDownloader.js`, `src/components/Speech/InstallEngineWizard.jsx`).
- **Audio source picker:** grouped by kind — microphones, USB and line inputs, loopback/monitor sources, and network sources — so a church feeding a digital console is a supported setup rather than an accidental exclusion. Includes a three-second "test this source" meter, a remembered choice with a stated fallback, and a re-pick prompt when the active source disappears mid-service (`src/components/Speech/AudioSourcePicker.jsx`).
- **Live transcript history, on by default:** one record per service with date, duration, model, provider, and per-segment provider attribution, with rotation, a hard cap that stops recording rather than filling the drive, and one-click erase. The sermon is usually published, so persisting it is the useful default rather than a risk (`main/speechHistory.js`, `src/components/Speech/TranscriptHistoryBrowser.jsx`).
- **Hardware guards for live use:** a panic-stop hotkey that tears the microphone down from any state, an unmute-on-launch guard that never resumes capture by itself, a rail VU meter with a device-health line, and a downloader that resumes rather than restarting.

### Changed

- **Verse Log panel removed (service file replaces it):** the separate in-app Verse Log list is gone — Recent Verses already records what was sent, and the new Sunday service file in the app folder is the durable record. The verse-log store state, send-wiring helper, and their tests are deleted with it (`src/components/Bible/BibleControlPanel.jsx`, `src/context/BibleStore.js`, `src/components/LyricDisplayApp.jsx`).

- **Sentence-first search ranking is now permanent:** Bible + song search always rank whole sentences first — the Experimental toggle and its opt-out are gone. Typing a sentence ("for God so love the world", "water you turn into") puts the verse / lyric file holding the whole sentence first; reference lookups ("isa 44 5", "John 3:16") keep working unchanged. The per-word rankers stay in the codebase as the accuracy-race baselines that prove the new ranker never regresses (`main/fileNavigator.js`, `src/utils/bibleSearch.worker.js`, `src/components/UserPreferencesModal.jsx`).

### Notes

- **No new runtime dependencies, and no model files.** The recognition engine is a separate, zero-dependency package that is *not* in the installer; the six invariants that guarantee this are enforced by tests that now gate every build.
- **Not usable end to end yet.** The engine ships a contract-conformant fake engine today. The native whisper.cpp binding is not yet published, so a fresh install can configure and inspect the feature but cannot yet produce a transcript. This entry stays in `[Unreleased]` until that lands.

## [6.14.0] - 2026-10-26

### Changed

- **Rebrand: LyricDisplay → Selah.** The app is several steps past its origin — Bible projection, sermon assist, announcements, NDI output, mobile control — and upstream's trademark policy requires modified distributions to use their own name and branding, so the product is now **Selah**, maintained by Jemo, built on [LyricDisplay](https://github.com/PeterAlaks/lyric-display-app) by Peter Alakembi and David Okaliwe (credited in the README, the About box, and `NOTICE`). Window titles, installer artifacts, logos, favicons, docs, API names, and the mobile display name all say Selah. **Existing setups come along:** the data folder migrates in place (`LyricDisplay` / `lyric-display-app` → `Selah`) before anything reads it, the Documents lyrics and import folders stay where they are (an existing `Documents/LyricDisplay/Lyrics` is reused, not duplicated), and everything that talks to the outside world keeps its old identity on purpose — the `_lyricdisplay._tcp` discovery service, the `/lyricdisplay/*` OSC hardware routes (new canonical `/selah/*` routes added alongside), the `com.lyricdisplay` bundle id (so updaters replace the old install rather than leaving two), and legacy `LYRICDISPLAY_*` env-var aliases for standalone server setups. Release artifacts are now named `Selah-<version>-*`; a packaged Windows install may leave the old uninstall entry behind once (`package.json`, `main/userDataPin.js`, `main/appIdentity.js`, `shared/hardwareCommands.js`).
- **Licensing settled:** the repository now ships the full GPL-3.0 text in `LICENSE` (upstream LyricDisplay is GPL-3.0-or-later), as `NOTICE` had already called for.

## [6.11.0] - 2026-10-18

### Added

- **Dynamic input for HTTP actions:** an HTTP action can now declare variables (text, number, or dropdown) and pressing the button asks the operator to fill them in *before* the request is sent. Answers are substituted into the URL, headers, and body using `{{name}}` or `${name}`; JSON bodies stay valid even when an answer contains quotes, and numbers can be dropped in unquoted (`{"count": {{count}}}`). Actions with no variables fire immediately, exactly as before (`src/utils/httpActionVariables.js`, `src/components/HttpActionVariableForm.jsx`, `src/components/HttpActionVariablesEditor.jsx`, `src/hooks/useHttpActionRunner.js`).
- **Operator metronome, ported from FreeShow:** a click bar carrying the look-ahead beat scheduler, accent/secondary gain ratio, metal/wood/custom click sounds, stereo/mono channel routing, per-output sink selection, numbered beat indicator and ping-pong sweep across unchanged, along with the shipped click samples. It is a single horizontal row where FreeShow stacked three, because the operator sidebar is short and the outputs carry the Bible verses — width is cheap here, height is not. The click deliberately survives the bar unmounting: the sidebar unmounts on a switch to Bible mode, and a click that dies mid-song is a live-service hazard (`src/components/MetronomeBar.jsx`, `src/components/MetronomeVisualizer.jsx`, `src/context/LyricsStore.js`, `public/sounds/metronome/`). FreeShow is GPL-3.0; attribution and the redistributed audio assets are recorded in `NOTICE`.
- **Hide the parallel translation without unlinking it:** the second translation can be taken off the screen while it stays bound, so hiding it no longer costs the operator the pairing they set up — re-showing is one click. Linking a translation still shows the pair again, on the grounds that an explicit "link this translation" is an explicit "show it" (`src/components/Bible/ParallelBibleLinkControl.jsx`, `src/components/Bible/BibleControlPanel.jsx`, `src/context/BibleStore.js`).
- **Translation previews no longer print copy-pasted verse blobs:** previewing *all* translations trims each entry so a translation that stores a whole passage as one string renders as a readable sample instead of a wall of duplicated text. Trimming is on by default and honours the existing Settings → Bible toggle; the search modal now reads that toggle and renders the truncated marker instead of silently ignoring it (`src/utils/biblePreview.js`, `src/components/Bible/BibleControlPanel.jsx`, `src/components/Bible/BibleSearchModal.jsx`, `src/context/BibleStore.js`).

### Fixed

- **A failed engine is no longer silent.** `speech:error` was broadcast to a channel no speech component listened to, and the rail rendered `lastError` only when the status was already `error` — so a segment that failed to transcribe left a green LISTENING badge and an empty transcript. The rail now shows the message whenever one exists, with a *Test engine* action and a dismiss button (`src/hooks/useSpeechRuntime.js`, `src/components/Speech/SermonAssistPanel.jsx`).
- **Production refuses a binary the OS cannot load.** The official whisper.cpp Windows archive links against `MSVCP140`/`VCRUNTIME140`, which the archive does not contain; without the Visual C++ Redistributable every spawn died at the loader. The start gate now probes the binary and refuses with the exact remedy (including the correct redistributable link for the architecture) instead of starting an engine that cannot transcribe (`main/speechEngineDiagnostics.js`, `main/speechIpc.js`).
- **Production shows that it is hearing you.** The real engine emits no partials, so before this the first sign of life was the first `final` after a pause. Voice-activity state is now relayed and the rail says "Hearing speech — the line appears when you pause" while audio is arriving (`speech:vad`, `src/hooks/useSpeechRuntime.js`).
- **Stopping no longer discards the last phrase.** Closing the PCM socket is what makes the real engine finalize, but the supervisor killed the process immediately. Stop now waits a bounded 2.5 s for that final before tearing the engine down, and a newer start supersedes the pending stop (`src/speech/engineTransport.js`).
- **Production mode no longer silently runs the test engine.** Selecting *Production (Live Mic)* without an installed engine used to fall back to the canned engine while the rail still said PROD, which is how the app could look like it was transcribing when it was not. Production now refuses to start and says exactly what is missing — engine binary or model weights — with the path to fix it, and stopping or failing to start clears the stale health so the rail cannot keep showing an engine that is not running. Switching between TEST and PROD restarts the engine instead of reusing whichever one was already up (`main/speechIpc.js`, `main/speechEngine.js`, `src/speech/engineTruth.js`).
- HTTP action templates are validated *after* variable substitution, so a body like `{"count": {{count}}}` is no longer reported as broken JSON and no longer blocks firing or saving.
- Values substituted into a URL are escaped against an explicit allowlist (`/ ? & = :` pass through), so a value can no longer contain `#` and be silently swallowed as a URL fragment while the request still reports success, and `+` or `%` can no longer be re-read by the server as a space or a bogus escape.
- Saving an HTTP action from the header pill no longer silently deletes variable rows that Settings created but left unnamed or duplicated; the save is blocked with a reason instead. Both edit surfaces now persist dropdown options in the same shape.
- The parallel translation control sits directly under the verse header row instead of below the slide list. On a passage that splits into many slides the list grows, so parking it underneath made the control drift further down the longer the passage ran — ahead of the list it holds one predictable spot (`src/components/Bible/BibleControlPanel.jsx`).
- Accidentals on scale-degree chords are now decided against the key's actual scale instead of by subtracting the tonic's own alteration. In a key of `F#`, the chord `F` belongs to the scale and must print a bare `1`; the old arithmetic printed `♭1`. The same bug printed `♯4` for a plain `D` in `E♭`. Only chords genuinely outside the key now carry a `♯`/`♭`, and a minor-key song is read in its natural minor (`shared/chords.js`).

### Notes

- **No new runtime dependencies, and no model files.** The recognition engine is a separate, zero-dependency package that is *not* in the installer; the six invariants that guarantee this are enforced by tests that now gate every build.
- **A fresh install still has no engine or model, by design.** The packaged app ships neither the binary nor model weights, so the first run of Live Sermon Assist needs two deliberate downloads in User Preferences → Experimental → Live Sermon Assist: *Install speech engine* (~9 MB) and a model (Tiny English is 78 MB). Until then, Production refuses to start rather than pretending. The test engine remains available under *Test (canned audio)* for checking the wiring, and it can never be labeled or reported as production.

## [6.10.0] - 2026-09-25

### Added

- **Scale-degree chord notation on the stage display:** the stage chord line can render number charts relative to the song's key (`C` → `1`, `G7` → `57`, `D/F#` → `2/♯4`) with a `1 = G` reference badge; letter names stay the default and songs without a `{key:}` directive keep letter chords instead of printing wrong numbers (`shared/chords.js`, `src/components/Stage/ChordChartView.jsx`).
- **Collapsible show-control dock:** the show-control bar and announcement ticker fold away so the song list stays above the fold; the collapsed header keeps reporting the active show state and queue depth (`src/components/ShowControlBar.jsx`, `src/components/AnnouncementTickerPanel.jsx`).
- **Mobile show control:** the Flutter controller gains the show state machine and announcement ticker, with a fallback to the legacy master boolean so older servers still drive it (`mobile/lib/core/models.dart`, `mobile/lib/core/server_api.dart`).

### Fixed

- The preview multiview smoke test is no longer timing-dependent when the suite runs in parallel.

## [6.9.0] - 2026-09-24

### Added

- **Service scheduler and run sheet:** schedule services with a creator wizard, run-sheet timer panel, and late-start reconciliation wizard that realigns the schedule when a service begins late (`src/components/ScheduleCreatorWizard.jsx`, `src/components/SchedulePanel.jsx`, `src/components/ScheduleStartReconciliationWizard.jsx`, `server/realtime/timerScheduler.js`, `shared/scheduleMath.js`).
- **Preview safety and multiview:** preview-lines mode with a live-command safety bridge and on-screen safety bar, plus a configurable preview multiview route for monitoring several outputs at once (`src/components/PreviewSafetyBar.jsx`, `src/hooks/useLiveSafetyBridge.js`, `src/utils/previewSafety.js`, `src/utils/previewMultiview.js`, `src/pages/Preview.jsx`).
- **Pre-service health and connected-output strip:** pre-service health check modal and a live strip showing which outputs are currently connected (`src/components/PreServiceHealthModal.jsx`, `src/components/ConnectedOutputsStrip.jsx`, `src/hooks/useOutputPresence.js`, `server/realtime/outputPresence.js`).
- **Document import:** DOCX, RTF, and Markdown importers plus full EasyWorship database import through a unified presentation import modal (`src/components/PresentationImportModal.jsx`).
- **OBS dock and WebSocket pairing:** headless OBS dock page with OBS-WebSocket auto source setup and authenticated pairing (`src/pages/ObsDock.jsx`, `src/integrations/obs/obsWebSocketClient.js`, `server/auth/obsDockPairing.js`, `main/obsDockStartup.js`).
- **Offline generative motion backgrounds:** built-in motion background presets rendered on the output canvas with operator controls — no internet or media files required (`src/components/outputs/CanvasMotionBackground.jsx`, `src/components/outputs/MotionBackgroundControls.jsx`, `src/utils/motionPresets.js`).
- **Professional song canvas tooling:** floating toolbar and measurement layer for the song canvas, with Vim editing workflow preserved (`src/components/NewSongCanvas/CanvasFloatingToolbar.jsx`, `src/components/NewSongCanvas/CanvasMeasurementLayer.jsx`).
- **Hardware MIDI and OSC automation:** control lyrics, slides, and show actions from MIDI controllers and OSC surfaces with a dedicated settings panel (`main/midiController.js`, `main/oscController.js`, `main/hardwareControl.js`, `src/components/MidiOscSettings.jsx`, `src/hooks/useHardwareCommands.js`, `shared/hardwareCommands.js`).
- **NDI video-over-IP output:** send output over NDI with status monitoring and runtime management (`main/ndi/`, `src/components/NdiOutputSection.jsx`, `src/hooks/useNdiStatus.js`, `src/utils/ndi.js`).
- **Parallel Bible translations:** display two translations side by side with a link control to keep them in sync (`src/components/Bible/ParallelBibleDisplay.jsx`, `src/components/Bible/ParallelBibleLinkControl.jsx`, `src/utils/bibleParallel.js`).
- **Bible verse editor (experimental):** editable Bible verse editor via `Alt+Shift+Enter`, gated behind an experimental preferences toggle (`src/components/Bible/BibleChapterEditorModal.jsx`).
- **Shared Bible import control:** reusable Import Bible Translation button wired into both User Preferences and the Bible Control Panel (`src/components/Bible/BibleImportButton.jsx`).
- **Mobile QR pairing and permissions:** instant QR pairing, camera/location permission flows, and setlist state sync in the Flutter mobile controller (`mobile/`).
- **Show-control bar and announcements:** clear/blackout/logo show-control bar with an announcement ticker overlay; queued announcements can be routed to selected outputs (`src/components/ShowControlBar.jsx`, `src/components/AnnouncementTickerPanel.jsx`, `src/components/outputs/TickerOverlay.jsx`, `shared/showControl.js`).
- **Chord charts and CCLI export:** chord chart support with SongSelect bridge and CCLI export; Stage display shows chord charts with a current-line-only view while audience lyrics stay clean (`shared/chords.js`, `src/components/Stage/ChordChartView.jsx`, `src/utils/chordStripper.js`).
- **Safe persistent storage bridge:** persistent storage with quota and corruption handling (`src/utils/persistentStorage.js`).
- **Batched main-process logging:** log writer with size and retention caps (`main/batchedLogWriter.js`).
- Alt-click and Alt+Enter Bible staging so operators can preview or prepare a verse without changing the live output.
- Local feature audit and Bible XML teardown reference documents.

### Changed

- Completed the unified desktop and Flutter mobile controller feature set, including session state, file navigation, Bible search, output templates, free notes, and cross-platform synchronization.
- Queued announcements are routed to the operator-selected outputs instead of broadcasting everywhere.
- CI now builds slash-prefixed feature branches.

### Fixed

- Stage chord charts stay Stage-only and audience lyrics are sanitized of chord markup.
- Bible translation import controls remain accessible in preferences and the Bible panel.
- Bible verse editor no longer double-fires on `Alt+Shift+Enter` in the search input and no longer loops on fallback loads.
- Render clock is boundary-aligned without per-tick compounding drift.
- User preferences support direct navigation to a section via `initialSection`.
- Removed a duplicate `useLyricsStore` import that broke the build.

### Security

- Output HTML sanitization, secret rotation, and IPC validation hardening (`main/ipcSecurity.js`, `src/utils/controlAuth.js`).

### Operations

- Pre-service health check and connected-output presence tracking for operator confidence before going live.
- Batched main-process log writer with size and retention caps.

## [6.6.2] - 2026-09-07

### Added

- Unified Flutter mobile controller app: LAN discovery, QR/manual pairing, live lyric control, setlists, Bible quick-load, output toggles, tablet layouts, and branded app icon (`mobile/`).
- Persistent desktop session state with atomic writes and reconnect synchronization (`src/context/sessionModel.js`, `src/hooks/useSessionHydration.js`).
- File navigator with indexed folders, token-index search, recent files, and atomic saves (`shared/navigatorTokenIndex.js`, `main/lyricWatcher.js`).
- Bible preview, splitter improvements, and worker-backed search caching (`src/utils/biblePreview.js`, `src/utils/bibleSplitter.js`).
- Output template sync, mode templates, and HTTP action buttons with dedicated worker (`src/hooks/useOutputTemplateSync.js`, `src/utils/modeTemplates.js`, `src/workers/httpAction.worker.js`).
- Keyboard hint (FHint) overlay mode, free-note mode, and lyrics hot-reload (`src/hooks/useFHintMode.js`, `src/utils/freeNote.js`, `src/hooks/useLyricsHotReload.js`).
- Mobile socket service tests and desktop platform runners (`mobile/test/socket_service_test.dart`).

### Changed

- Improved lyric, Bible, setlist, and output state synchronization across desktop, web, output, and mobile clients.
- Stricter upload, import, file navigation, and server request limits.

### Fixed

- Cleaned up disconnected output instances and stale worker Bible data.
- Preserved custom output and display settings across server and client reconnects.

## [6.6.1] - 2026-08-29

### Added

- Keyboard shortcut `Ctrl/Cmd+Shift+D` to open the RCCGTPHB Song Database (`src/constants/hotkeyBindings.js:15`, `src/hooks/LyricDisplayApp/useKeyboardShortcuts.js:145`), rebindable in User Preferences, with menu hint in `src/components/LyricDisplayApp.jsx:932`.
- `Auto-break long lines` preference to toggle intelligent lyric splitting globally, persisted in `src/context/LyricsStore.js:235` and honored by `src/hooks/LyricDisplayApp/useLyricsLoader.js:40` and `src/hooks/useFileUpload.js:15`.

### Changed

- User Preferences `Lyrics` section now exposes both `Auto-break long lines` and `Auto-group lyric lines`.

## [6.6.0] - 2026-08-29

### Added

- Flutter mobile controller for LAN discovery, QR/manual pairing, live lyric control, setlists, Bible quick-load, output toggles, and tablet layouts.
- Persistent desktop session state with atomic writes and reconnect synchronization.
- File navigator with indexed folders, search, recent files, and atomic saves.
- Bible search across translations, geometry-aware slide splitting, previews, and worker-backed search caching.
- Custom output screens, HTTP action buttons, mode templates, keyboard hint mode, bundled fonts, and performance controls.
- Release workflow for building and publishing cross-platform desktop installers.

### Changed

- Expanded REST and Socket.IO API documentation for mobile controllers, setlists, drafts, metrics, and session state.
- Improved lyric, Bible, setlist, and output state synchronization across desktop, web, output, and mobile clients.
- Added stricter upload, import, file navigation, and server request limits.

### Fixed

- Cleaned up disconnected output instances and stale worker Bible data.
- Preserved custom output and display settings across server and client reconnects.
- Updated mobile setlist reordering to use Flutter's current reorder callback API.
