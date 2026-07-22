#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/bin/ops-inbox-zero"

bash -n "$SCRIPT"

grep -q '^DO_ARCHIVE=0$' "$SCRIPT"
grep -q -- '--archive)     DO_ARCHIVE=1' "$SCRIPT"
grep -q 'if c\["verdict"\] == "unsure"' "$SCRIPT"
grep -q 'approval required' "$SCRIPT"

echo "ops-inbox-zero safety defaults: PASS"
