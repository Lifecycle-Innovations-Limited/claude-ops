#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

node "$ROOT/scripts/account-rotation/__tests__/refresh-pacing.test.mjs"
node "$ROOT/scripts/account-rotation/__tests__/production-recovery.test.mjs"
