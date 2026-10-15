#!/usr/bin/env bash
# test-parity-check.sh — runs the node contract tests for lib/parity/check.mjs.
set -euo pipefail
TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
command -v node >/dev/null 2>&1 || {
  echo "  FAIL: node is required for the parity check core tests"
  exit 1
}
node "$TESTS_DIR/test-parity-check.mjs"
