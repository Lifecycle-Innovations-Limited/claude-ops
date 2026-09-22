#!/usr/bin/env bash
# The CI probe used to walk every registry repo in series with no time limit.
# One slow `gh` held the whole dashboard: measured 45s of a 56s render, which
# pushed the render past the inline threshold so it landed as a background task
# instead of on screen. The probe must fan out and must give up on a repo.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DASH="$PLUGIN_ROOT/bin/ops-dash"

fail=0

# The per-repo count still has to be exactly the old one: failures among the
# last 10 runs. A broader query would change the number the dashboard shows.
if ! grep -Fq 'gh run list --repo "$repo" --limit 10 --json conclusion' "$DASH"; then
  echo "FAIL: CI probe no longer counts failures in the last 10 runs per repo"
  fail=1
fi

# Serial is the bug. The gh call has to sit inside a subshell that is
# backgrounded, so the next repo starts before this one returns.
if ! grep -A6 -F 'gh run list --repo "$repo"' "$DASH" | grep -Eq '^[[:space:]]*\) &'; then
  echo "FAIL: the per-repo gh call is not in a backgrounded subshell"
  fail=1
fi

# A repo that never answers must not hold the render. Bound the call.
if ! grep -Eq 'timeout [0-9]+ gh run list' "$DASH"; then
  echo "FAIL: CI probe has no timeout on gh run list"
  fail=1
fi

# The count is a sum. Parallel workers have to write their own number and be
# added afterwards, or two repos clobber one counter.
if ! grep -Fq 'ci_fail_' "$DASH"; then
  echo "FAIL: CI probe has no per-repo result file to sum"
  fail=1
fi

[ "$fail" -eq 0 ]
echo "PASS: ops-dash CI probe fans out and times out"
