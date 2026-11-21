/**
 * test.entry.js — the package's test entry point.
 *
 * Node's test runner treats a positional path as a literal program
 * entry: a directory resolves through package.json "main". Pointing
 * `main` here makes `node --test speech-engine/` (from the repo
 * root) execute the whole suite in one process.
 *
 * The name deliberately does NOT match the runner's discovery
 * patterns (*.test.js, test-*.js, *-test.js, *_test.js, test.js),
 * so `npm test` (bare `node --test`, which discovers every file
 * under test/) runs each test file exactly once — never twice.
 *
 * No setup, no fixtures: importing a test file registers its tests
 * with this process's root test harness.
 */
import './test/server.test.js';
import './test/wsTransport.test.js';
import './test/benchmark.test.js';
// The OS on-device driver: same boundary, same requirement — its spawn,
// parse, and cleanup paths run here, not only on a Windows machine.
import './test/osdevice.test.js';
import './test/whisperServer.test.js';
// The DRIVER tests belong here too. They were absent from this entry point,
// so CI exercised the HTTP surface and never the code that spawns
// whisper-cli — the binary boundary had no coverage at all.
import './test/whispercpp.test.js';
import './test/sherpaonnx.test.js';
// Real OpenAI cloud driver: fake fetch proves the request/response contract,
// and the entry-point tests prove cloud starts without a local binary.
import './test/cloudOpenAI.test.js';
// The OpenRouter/Gemini lane: documented Responses API request shape with
// fake fetch, plus entry-point routing with no external network.
import './test/cloudOpenRouter.test.js';
