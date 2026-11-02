#!/usr/bin/env bash
# tools/dogfood-harness.sh — reuse, do not rebuild.
# Verbs:
#   smoke   Boots the REAL server on a test port and runs tools/mobile-api-smoke.mjs
#           (every mobile fast-path claim, two channels: REST + socket.io).
#   shot <url>            Needs an MCP browser session (mishpat); no headless driver in shell.
#   pixel-diff <a> <b>    Needs an MCP browser session; see above.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "${1:-}" in
  smoke)
    exec node "$ROOT/tools/mobile-api-smoke.mjs"
    ;;
  shot|pixel-diff)
    echo "error: '$1' needs an MCP browser session (mishpat headless) — cannot run from shell." >&2
    echo "Use the dogfood skill's browser path for screenshots; API proof lives in 'smoke'." >&2
    exit 2
    ;;
  *)
    echo "usage: dogfood-harness.sh {smoke|shot <url>|pixel-diff <a> <b>}" >&2
    exit 2
    ;;
esac
