#!/usr/bin/env bash
# Regression: failed git probes must not leave duplicate numeric output (for example 0\n0).
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DASH="$PLUGIN_ROOT/bin/ops-dash"

fail=0
if grep -Eq 'dirty=\$\(.*\|\| echo "?0"?' "$DASH"; then
  echo "FAIL: dirty probe appends a fallback to partial pipeline output"
  fail=1
fi
if grep -Eq 'ahead=\$\(.*\|\| echo "?0"?' "$DASH"; then
  echo "FAIL: ahead probe appends a fallback to partial git output"
  fail=1
fi

grep -Fq 'dirty=0' "$DASH"
grep -Fq 'ahead=0' "$DASH"

[ "$fail" -eq 0 ]
echo "PASS: ops-dash portfolio git counts use assignment fallbacks"
