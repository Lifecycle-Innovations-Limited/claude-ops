#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node "$ROOT/scripts/account-rotation/__tests__/cliproxy-heal-policy.test.mjs"
node "$ROOT/scripts/account-rotation/__tests__/cliproxy-isolate-compat.test.mjs"
