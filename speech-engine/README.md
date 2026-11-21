# speech-engine — Selah Live Sermon Assist, Phase 2 scaffold

A **self-contained, zero-dependency** implementation of the v1 speech-engine
contract (`shared/speech/protocol.js`) that Selah's main process talks
to over loopback HTTP by default, or over a trusted LAN when explicitly
opted in.

## What this is

- A `node:http` server implementing the contract routes: `/v1/health`,
  `/v1/models`, `/v1/session`, `/v1/session/:id/close`, `/v1/transcribe`,
  plus `501 not-implemented` placeholders for model download/delete and
  benchmark (those phases come later).
- A **`--engine=fake` mode (the default)** that serves the contract from
  canned data. It emits real, schema-validated `ready` / `partial` /
  `final` / `stats` messages so the whole app side — supervisor, health
  poll, IPC surface, renderer — can be exercised end to end with **no
  model, no binary, no download**.
- Its own tests, run by Node's built-in test runner.

## What this is NOT

- **No weights ship.** There is no `models/` content in git (the directory
  is gitignored along with every weight extension), no `npm install`
  step, and no runtime dependencies at all. `dependencies` in
  `package.json` is `{}` on purpose.
- **No native whisper.cpp binary.** The `--engine=whisper` path is not
  wired yet: selecting it exits with a clear message and a non-zero code.
  Binding a real whisper.cpp binary is a later, machine-verified
  follow-up — nothing in this repository requires it to pass its tests.

## Security properties (enforced, not convention)

| Rule | Where |
| --- | --- |
| Binds `127.0.0.1` (loopback) by default — non-loopback host throws | `assertBindHost()` in `server.js`, checked at construction AND `listen()`; LAN needs the explicit opt-in below |
| `Origin` must be in `ALLOWED_ORIGINS` (or absent, i.e. a non-browser client) | request handler, before any route |
| `x-ld-speech-token` required on every request (401 missing / 403 wrong, timing-safe compare) | request handler; the CORS preflight is origin-checked but token-less by browser design |
| Never logs tokens, audio, or transcript text | no logging of payloads anywhere in this package; a LAN bind logs the host only |

## Trusted-LAN remote engine (explicit opt-in)

**Setup ownership:** all Sermon Assist setup belongs to the Selah desktop app
and stays in this repository (`src/`, `main/`, `shared/`, `speech-engine/`,
`tests/`, `docs/`). No external plugin, sidecar repo, separate installer
project, or zip of loose executables; no volunteer-facing step that asks them
to find, copy, configure, or run a file by hand. The app must probe the
machine, verify downloads, install the engine and model, select them, and
explain everything in plain language.

The commands below are **developer lab verification only** for the LAN opt-in
gate. They are not the operator setup path and must not be shipped as one.

Default posture is unchanged: loopback-only, no exceptions. To exercise the
transport against an engine on a second machine in a lab, both of these must
be true on the engine machine:

```sh
# flag form — token is mandatory with a LAN bind (no generated fallback)
node speech-engine/index.js --host=192.168.1.20 --port=4731 \
  --allow-lan --token=<same-long-token>

# or the env form
LD_SPEECH_ALLOW_LAN=1 LD_SPEECH_HOST=192.168.1.20 LD_SPEECH_PORT=4731 \
  LD_SPEECH_TOKEN=<same-long-token> node speech-engine/index.js
```

`--allow-lan` / `LD_SPEECH_ALLOW_LAN=1` widens the bind, HTTP `Origin`, and
WebSocket peer gates to the trusted LAN. It also prints an auditable
`LAN OPT-IN` warning naming the bind host. A non-loopback host **without**
the opt-in is still refused; the opt-in **without** an explicit token is
refused and exits non-zero.

**Security caveat:** the transport is plain HTTP / `ws://` with **no TLS**.
Raw PCM microphone audio crosses the network, as does the shared token in
the WebSocket query string. The token is a gate, not encryption. Only use a
LAN you control. In Selah, enter `http://192.168.1.20:4731` and the token in
User Preferences → Experimental → Speech & AI → Network Device. The token
is session-only (never written to localStorage); the endpoint is persisted.

## Real cloud modes: OpenAI and OpenRouter

`--engine=cloud` (or `LD_SPEECH_ENGINE=cloud`) supports two real lanes through
the **same** session/frames engine contract as the local drivers. Neither needs
a binary or model weights: the loopback HTTP/WS surface is unchanged, so the
renderer still streams PCM locally and only the engine talks to the provider.

- `openai`: multipart WAV POST to
  `https://api.openai.com/v1/audio/transcriptions`, JSON `text` response.
- `openrouter`: documented Responses API POST to
  `https://openrouter.ai/api/v1/responses` with base64 `input_audio` WAV and
  a Google Gemini model; text is read from `output[].content[]` entries of
  type `output_text`. This is **not** the OpenAI transcriptions endpoint.

Launch configuration:

```sh
LD_SPEECH_CLOUD_PROVIDER=openai \
LD_SPEECH_CLOUD_KEY='sk-...' \
LD_SPEECH_CLOUD_MODEL=whisper-1 \
node speech-engine/index.js --engine=cloud --port=4731
```

Provider and model may also be passed as `--cloud-provider=openai` /
`--cloud-model=whisper-1`; the key is **environment-only** so it cannot leak
into the process table. A missing provider or key exits 2 with an actionable
message — there is no fallback to the canned or a local engine.

**Model ids** come from documented/catalog sources, never guesses:

- OpenAI: `whisper-1` (default; long-standing endpoint, stable `{"text": ...}`
  body) or `gpt-4o-transcribe` (newer accuracy option).
- OpenRouter: `google/gemini-2.5-flash` (default; the id in OpenRouter's audio
  guide) or `google/gemini-3.8-flash` (current catalog row advertising `audio`
  input). Exact ids are passed through unchanged.

OpenRouter launch example:

```sh
LD_SPEECH_CLOUD_PROVIDER=openrouter \
LD_SPEECH_CLOUD_KEY='sk-or-...' \
LD_SPEECH_CLOUD_MODEL=google/gemini-2.5-flash \
node speech-engine/index.js --engine=cloud --port=4731
```

In the app, each provider has its own key in the keytar-first /
encrypted-file-fallback pattern (`main/speechCloudKeyStore.js`), and the
renderer only learns `{ configured }` per provider. Settings exposes
provider selection, model choice, explicit **Save** / **Clear** buttons, a
boolean status, and an egress acknowledgement that must be checked before the
first cloud start and again after switching lanes. Other providers are shown
as unavailable and refuse before any fork. No error path logs the key, the
audio, or the transcript.

Documentation used: `https://openrouter.ai/docs/guides/overview/multimodal/audio.md`
and `https://openrouter.ai/docs/api_reference/responses/overview.md`.

## Running tests

From the **repository root**:

```sh
node --test speech-engine/
```

or from inside this package:

```sh
cd speech-engine && npm test   # runs `node --test`
```

No setup, no install, no network.

> Note: Node's test runner treats a positional path as a literal program
> entry (directories resolve through `package.json` `main`), so this
> package's `main` deliberately points at `test.entry.js`, which imports
> every test file — including the driver tests that cover the whisper-cli
> boundary. That makes `node --test speech-engine/` execute the whole
> suite instead of booting the HTTP server.
> `npm test` (`node --test test/*.test.js`) runs the same files
> directly. `npm start` (`node index.js`) still starts the engine.

## Live voice smoke test (real engine, no microphone)

The conformance suite above proves the contract with fake shells and canned
messages. It cannot answer "does the real recognizer turn this voice into the
right words on this machine?" — that needs real audio through the real engine.

`scripts/smoke.mjs` answers exactly that, and it is cheap:

- the audio is a committed **6.3-second, 196 KB** John 10:10 spoken clip
  (`test/fixtures/voice-smoke-16k.wav`); no microphone, no human, no API call
- it forks the real `index.js`, creates a real session, sends 63 PCM frames
  over the real HTTP contract, and compares the returned final transcript to
  the spoken sentence using `shared/wer.js`
- it then runs the app's **real verse detector** (`createVerseSearcher`'s indexed search + `detectVerse`)
  over the full 31,102-verse KJV and asserts the transcript resolves to
  **John 10:10** — text is not enough; the reference must come out
- it exits nonzero when the engine is missing, returns an error, returns no
  transcript, returns the wrong words, or detects the wrong verse

```sh
# Light mode: fetch the pinned whisper.cpp binary, tiny.en Q5_1 (31 MiB),
# and the public-domain KJV (4.1 MiB) into the gitignored .speech-smoke/
# folder, once. CI caches the same folder.
npm run speech-smoke:setup
npm run speech-smoke
```

On a machine where Selah already installed its engine, the setup step is
unnecessary — the script finds the app's own bin/models folders. Explicit
paths and a different model still work:

```sh
node speech-engine/scripts/smoke.mjs \
  --bin-dir=.speech-smoke/bin \
  --models-dir=.speech-smoke/models \
  --model=tiny.en-q5_1
```

On Windows, the same clip also exercises the **OS on-device** provider, which
needs no model and no binary at all:

```sh
node speech-engine/scripts/smoke.mjs --engine=osdevice
```

A recording from a real microphone works too. Tell the script what was said
and which reference it must resolve to:

```sh
node speech-engine/scripts/smoke.mjs \
  --audio=/path/john-10-10.wav \
  --expect="The thief comes only to steal and kill and destroy. I came that they may have life, and have it abundantly." \
  --detect="John 10:10"
```

Use `--detect=none` to check transcription only, or `--bible=/path/kjv.json`
to run the verse search against another translation.

### What real recordings showed

The committed clip is synthetic, so CI is deterministic. A real 13-second
John 10:10 recording exposed two limits worth knowing:

- **tiny.en Q5_1 is a CI floor, not a production model.** It transcribed the
  real clip at 38% WER and the detector found nothing; the same audio with a
  larger local model (not used in this test) cleared the errors and resolved
  John 10:10. Most deployments should choose a larger model.
- **System.Speech is old and cautious.** On that same real clip the OS
  recognizer returned fragments at 0.02–0.03 confidence, and one fragment
  could have become a false Obadiah 1:5. The driver now refuses anything below
  `OSDEVICE_MIN_CONFIDENCE` instead of forwarding a guess, and the scorer
  refuses one- and two-word tails. A low-confidence OS result is reported as
  `low-confidence`, never as a verse.

A 24-minute live-sermon stream (auto-captions, 15-second windows) exposed a
third problem in the detector rather than the ASR: the worker was using
`rankVerses`, a containment counter that scored four wrong references
(1 Kings 1:47, 1 Chronicles 16:35, Psalms 106:47, Luke 10:21) at 0.62–0.73.
The indexed scorer (`verseIndex` + `verseScore`) was already built but not
wired to the worker. The worker now uses it: the same windows produced five
matches, all actual sermon references (John 10:35, Numbers 23:19, Genesis
27:38–40), with no containment false positives. Building the index costs
~330 ms and ~100 MB in the worker, once per translation. This audits
detector retrieval against real sermon language, not ASR: YouTube blocked the
audio download, so the ASR half still needs a local recording.

**Cost.** No network after setup, no hosted model, no key. Inference on the
6-second clip is roughly one to three seconds on a CPU, and the full-KJV
scan adds about a quarter second. The only persistent bytes are the 196 KB
fixture and the gitignored light engine: 45 MiB downloaded, about 66 MiB
unpacked into `.speech-smoke/`. CI restores that folder from a cache keyed by
the pinned release, model, and Bible digests.

## Persistent server driver (production model path)

The CLI driver spawns `whisper-cli` once per segment. That is fine for a 31 MiB
tiny model, but a production model is hundreds of MiB and model load dominates
a 15-second chunk. `drivers/whisperServer.js` keeps `whisper-server` alive for
the engine session and posts each WAV to `/inference` on loopback.

`index.js` uses the server when `whisper-server` is present (the installer
ships it) and falls back to the CLI for older installs:

```sh
node index.js --engine=whisper --driver=server   # force persistent server
node index.js --engine=whisper --driver=cli      # old per-segment process
node index.js --engine=whisper                   # auto: server if present
```

Measured on the real 24-minute sermon with large-v3-turbo Q8 on a 12-core CPU:
~1.15x real time on a 35 s chunk even with the model loaded. The server removes
model-reload overhead; it does not turn a CPU that is too slow into a GPU. The
app still needs benchmark-based model selection and GPU builds for large models.

Silence is skipped before the model is called: a segment below the energy floor
returns no final, so a whisper hallucination like "you" cannot become a rail
entry.

## Transport decision (Phase 2)

The v1 plan's renderer↔engine transport is WebSocket. Adding `ws` would cost
a dependency, which invariant 2 forbids, so **Phase 2 ships HTTP only**.
Message-emission code is routed through a single seam — `bus.js` — so the
WebSocket transport drops in later as `bus.subscribe(wsSink)` without
touching engine logic. Until then `index.js` subscribes a parent-process
mirror that forwards messages over the fork IPC channel to Selah's
supervisor, which relays them to the renderer over `speech:*` IPC channels.

## Layout

| File | Purpose |
| --- | --- |
| `index.js` | CLI entry: args/env, fake-vs-whisper mode, listen, fork-IPC handshake |
| `server.js` | HTTP server: origin/token gates, route table, loopback enforcement |
| `fakeEngine.js` | canned engine: sessions, canned segment, canned metrics |
| `drivers/whisperServer.js` | persistent whisper-server driver for production models |
| `bus.js` | message-emission seam + schema validation (`validateMessage`) |
| `scripts/smoke.mjs` | real voice → real engine → checked transcript, CI-friendly |
| `scripts/prepare-smoke.mjs` | fetch/verify the pinned light engine into `.speech-smoke/` |
| `test/` | `node --test` suite (not picked up by the app's vitest run) |

The contract is imported from `../shared/speech/protocol.js` by relative
path — this is a separate package and does not use the app's Vite aliases.
