# GPU-aware whisper.cpp engine builds (b5454)

For volunteers using the app, the only guide they need is
[Set up Sermon Assist](sermon-assist-setup.md): one button, no files to unzip
and no model choices. The rest of this document is the technical contract behind
that button.

Status: **probe, verified asset pinning, in-app one-click install, repair, and
guidance are shipped. No runtime speedup has been measured.** There was no GPU,
NVIDIA driver, or Vulkan device on the machine that produced this change, so no
claim is made about real-time transcription on hardware. The honest default
remains the CPU build with the existing on-machine benchmark gate.

## Decision

A serious model (`large-v3`, `large-v3-turbo`) is the catalog default, but the
app must not imply that it keeps up just because a GPU was detected. This change
therefore:

1. probes for CUDA / Vulkan / Metal evidence in main, injectably;
2. selects a **real, checksum-verified** archive only when that probe passes;
3. reports a typed CPU fallback or `unsupported-platform` everywhere else;
4. lets detected GPU backends make large models *eligible for benchmarking*,
   while the recommendation still requires a measured RTF below 1.0 and an
   engine-reported non-CPU backend;
5. leaves the CPU assets and their existing verification path unchanged.

There is **no fake GPU asset**. b5454 publishes no Vulkan CLI, no Linux CUDA
CLI, and no macOS CLI; those cells are gaps, not URLs we invented.

## Supported matrix

| Platform / arch | Probe evidence | Pinned engine asset | Selection outcome |
| --- | --- | --- | --- |
| win32 / x64 | `nvidia-smi` reports CUDA 12.4+ | `whisper-bin-win-cuda-12.4.0-x64.zip` | CUDA 12.4 build when probe passes |
| win32 / x64 | `nvidia-smi` reports CUDA 11.8–12.3 | `whisper-bin-win-cuda-11.8.0-x64.zip` | CUDA 11.8 build when probe passes |
| win32 / x64 | CUDA below 11.8, unknown version, no GPU | `whisper-bin-x64.zip` | Typed CPU fallback (`cuda-driver-too-old` / `cuda-version-unknown` / `cpu`) |
| win32 / x64 | Vulkan only | `whisper-bin-x64.zip` | Typed CPU fallback (`unsupported-backend-asset`); no b5454 Vulkan CLI exists |
| win32 / arm64 | `nvidia-smi` reports CUDA 13.4+ | `whisper-bin-win-cuda-13.4-arm64.zip` | CUDA 13.4 build when probe passes |
| win32 / arm64 | older CUDA / no GPU | `whisper-bin-win-cpu-arm64.zip` | Typed CPU fallback |
| linux / x64, arm64 | any backend | existing Ubuntu tarballs | CPU build; no b5454 Linux CUDA/Vulkan CLI |
| darwin / any | Metal framework present | none | `unsupported-platform`: Metal needs a **local build**; upstream ships only an xcframework |
| win32 / ia32 | no accelerator archive | `whisper-bin-Win32.zip` | CPU build (unchanged) |

Vulkan detection exists because the benchmark must be able to name the backend
it used and because operators ask; a Vulkan loader or `vulkaninfo` result does
**not** make a CUDA archive appropriate, so it never selects one. CUDA wins
when both are present, because CUDA is the only backend with a verified CLI
archive in this release.

## Pinned assets (b5454)

Release: <https://github.com/ggml-org/whisper.cpp/releases/tag/b5454>
Base URL: `https://github.com/ggml-org/whisper.cpp/releases/download/b5454`

Each GPU archive was downloaded in full on 2026-11-20, hashed locally with
`sha256sum`, and the hash matched BOTH GitHub's published `digest` field on the
release asset and the value pinned in code. Every GPU archive is
deflate-compressed, passes `unzip -t`, is not ZIP64, and contains
`Release/whisper-cli.exe` plus `Release/ggml-cuda.dll` under the expected
`Release` payload directory. The existing CPU archives were re-downloaded and
their pinned digests re-confirmed the same way.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `whisper-bin-win-cuda-11.8.0-x64.zip` | 284761231 | `e81c86c542be6e3d7b7245392d4e1c52ab6e5c61dbe38721754bc0ab59d4d027` |
| `whisper-bin-win-cuda-12.4.0-x64.zip` | 684913404 | `afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a` |
| `whisper-bin-win-cuda-13.4-arm64.zip` | 291157544 | `6184ae8887d38ea9add68e883b9c846e7bf562ba1bf619ffc7ee9f8ec7e1699c` |
| `whisper-bin-x64.zip` (CPU, pinned before this change) | 8928640 | `6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb` |
| `whisper-bin-Win32.zip` (CPU) | 5523979 | `b6cb078ee5d4df0f9dcdb4f820210c59bd6534c84fdb13c35bc8a51d1233451f` |
| `whisper-bin-win-cpu-arm64.zip` (CPU, newly pinned) | 4371193 | `28c37e7b598c3d9bbfef94f3bd67f2ee6f12b7c86f3da5edcf5e4308d615ff6d` |
| `whisper-bin-ubuntu-x64.tar.gz` (CPU) | 10364195 | `a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c` |
| `whisper-bin-ubuntu-arm64.tar.gz` (CPU) | 4608377 | `6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149` |

Observed but **not selected**: `whisper-bin-win-opencl-adreno-arm64.zip`
(4,944,717 bytes, `915b48289f362c5f4cf33f3ffdd30f1f43de68f6103a3088858e346635719007`).
There is no OpenCL probe in this MVP, so wiring it would be a guess. The
macOS `whisper-b5454-xcframework.zip` is a library for app builds, not a
`whisper-cli` payload, and is not an installer asset.

## Setup (what an operator can actually do)

1. In Selah, open **User Preferences → Experimental → Speech & AI** and press
   **Set up Sermon Assist**. The app probes the machine, downloads and verifies
   the engine, proves it starts, downloads a small candidate ladder, measures
   each candidate on the committed reference clip, selects the largest model
   that keeps up, and starts listening. No terminal, file copy, unzip, or driver
   command is part of this path.
2. If an older CPU engine is already present on a CUDA machine, the same press
   asks the installer to replace it in-app. The installed backend is recorded
   in `engine-manifest.json`; setup never guesses GPU from a probe.
3. Weights are never bundled. The app downloads the selected model, verifies
   it, and selects it. **Only then** does a recommendation appear.
4. Check the benchmark's **Backend** cell and GPU utilisation. If it says CPU
   while CUDA was selected, the app flags a silent fallback and refuses to
   recommend a large model from that row.

The pinned CUDA archives and digests below are the engineering contract behind
that button. A volunteer never sees or handles them.

The 12.4 archive is ~685 MB compressed. Download time, disk footprint, memory
use, and whether the bundled DLLs load on a given driver are **not** established
by these tests; the installer verifies bytes before writing, unpacks into a
staging directory, and swaps it into place only after the complete payload is
present. A failed swap restores the previous engine, so retry is safe.

## macOS build gap

Metal is detected from `/System/Library/Frameworks/Metal.framework`, but
b5454 does not publish a `whisper-cli` for macOS. Keeping the existing honest
behaviour, the installer returns `unsupported-platform` with a reason naming
the xcframework. To ship a Metal engine later, a separate build/signing path
must produce a CLI (or an in-process adapter), with its own provenance,
checksum, and hardware verification. Until then, the app refuses with a plain
sentence and does not ask a volunteer to copy files; a future in-app build must
produce a signed CLI (or an in-process adapter) with its own provenance and
hardware verification. The benchmark still decides whether any model keeps up.

## What requires real GPU hardware

None of the following was verified here. They are deliberately called out
instead of being presented as facts:

- actual inference RTF for `large-v3` / `large-v3-turbo` on CUDA 11.8, 12.4,
  or 13.4, and therefore whether "faster than real time" is achieved on any
  particular PC;
- whether `nvidia-smi`'s reported CUDA version is the right compatibility
  signal for every driver; the selector refuses unknown/older values instead
  of guessing;
- DLL loading on Windows x64/ARM64, VC++/CUDA runtime side effects, and GPU
  utilisation reported by the engine;
- Vulkan device suitability — `vulkaninfo`/loader evidence is presence only,
  and there is no b5454 Vulkan CLI to install;
- the macOS Metal build path (framework presence is not a runnable engine);
- thermal behaviour and sustained 25-minute service performance.

The tests prove selection and verification logic with injected command/file
stubs; they do not prove a GPU ran anything.

## Verification performed

- `node --test speech-engine/` — engine unit tests.
- `npx vitest run tests/speech/speechGpuProbe.test.js tests/speech/speechGpuSelection.test.js
  tests/speech/modelGuidance.test.js tests/speech/speechEngineInstaller.test.js
  tests/speech/benchmark.test.js tests/speech/speechDownloader.test.js` — probe
  matrix, checksum pins, fallback/unsupported paths, existing installer tests.
- `node --check` on every changed `.js` file.
- `npm run build` — production Vite build.

`tests/speech/invariants.test.js` uses `git ls-files` / `git check-ignore` and
therefore fails in this jj-only workspace (no `.git` directory) before and after
this change. Supplying git metadata through an external `GIT_DIR`/`GIT_WORK_TREE`
(with no `.git` written into the workspace) makes all 40 invariant tests pass,
including the updated channel pin. The full `npx vitest run` additionally shows
two unrelated, environment-bound failures: `better-sqlite3` was compiled for a
different Node ABI in the shared `node_modules` symlink, and one KJV search
timing guard overruns by ~1 ms under parallel load. Both pass in isolation or
are unrelated to speech; they are not fixes in this change.
