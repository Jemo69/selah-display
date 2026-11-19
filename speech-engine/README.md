# speech-engine — Selah Live Sermon Assist, Phase 2 scaffold

A **self-contained, zero-dependency** implementation of the v1 speech-engine
contract (`shared/speech/protocol.js`) that Selah's main process talks
to over loopback HTTP.

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
| Binds `127.0.0.1` (loopback) **only** — non-loopback host throws | `assertLoopbackBindHost()` in `server.js`, checked at construction AND `listen()` |
| `Origin` must be in `ALLOWED_ORIGINS` (or absent, i.e. a non-browser client) | request handler, before any route |
| `x-ld-speech-token` required on every request (401 missing / 403 wrong, timing-safe compare) | request handler; the CORS preflight is origin-checked but token-less by browser design |
| Never logs tokens, audio, or transcript text | no logging of payloads anywhere in this package |

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

- the audio is a committed **3.2-second, 99 KB** spoken clip
  (`test/fixtures/voice-smoke-16k.wav`); no microphone, no human, no API call
- it forks the real `index.js`, creates a real session, sends 32 PCM frames
  over the real HTTP contract, and compares the returned final transcript to
  the spoken sentence using `shared/wer.js`
- it exits nonzero when the engine is missing, returns an error, returns no
  transcript, or returns the wrong words

```sh
# Light mode: fetch the pinned whisper.cpp binary + tiny.en Q5_1 (31 MiB)
# into the gitignored .speech-smoke/ folder, once. CI caches the same folder.
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

**Cost.** No network after setup, no hosted model, no key. Inference on the
3-second clip is roughly one second on a CPU. The only persistent bytes are
the gitignored 41 MiB light engine and the 99 KB fixture; CI restores them
from a cache keyed by the pinned release + model digest.

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
| `bus.js` | message-emission seam + schema validation (`validateMessage`) |
| `scripts/smoke.mjs` | real voice → real engine → checked transcript, CI-friendly |
| `scripts/prepare-smoke.mjs` | fetch/verify the pinned light engine into `.speech-smoke/` |
| `test/` | `node --test` suite (not picked up by the app's vitest run) |

The contract is imported from `../shared/speech/protocol.js` by relative
path — this is a separate package and does not use the app's Vite aliases.
