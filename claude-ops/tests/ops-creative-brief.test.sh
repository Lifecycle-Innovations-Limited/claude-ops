#!/usr/bin/env bash
# tests/ops-creative-brief.test.sh — rate-floor concurrency test.
#
# Spawns 6 concurrent ops-creative-brief invocations sharing the same hourly
# rate-floor lock and asserts that at most 5 succeed (the others exit with
# code 2 — "rate-floor hit"). Uses --dry-run to avoid real API spend.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN="$PLUGIN_ROOT/bin/ops-creative-brief"

if [ ! -x "$BIN" ]; then
  printf 'FAIL: %s not executable\n' "$BIN" >&2
  exit 1
fi

tmp="$(mktemp -d -t ops-creative-test.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

export OPS_CREATIVE_DIR="$tmp/briefs"
export OPS_HIGGSFIELD_RATE_DIR="$tmp/rate"
export OPS_HIGGSFIELD_RATE_LIMIT=5
mkdir -p "$OPS_HIGGSFIELD_RATE_DIR"

# Pre-seed the rate file so all 6 invocations land in the same hour bucket.
HOUR="$(date -u +%Y%m%dT%H)"
RATE_FILE="${OPS_HIGGSFIELD_RATE_DIR}/.higgsfield-rate-test-${HOUR}"
touch "$RATE_FILE"

run_one() {
  local i="$1"
  if "$BIN" \
      --brand="TestBrand" \
      --product="TestProduct" \
      --audience="TestAudience" \
      --goal="TestGoal-$i" \
      --project=test \
      --num-shots=1 \
      --dry-run \
      --no-pr >/dev/null 2>&1; then
    printf 'ok\n' > "$tmp/result-$i"
  else
    printf 'fail-%d\n' "$?" > "$tmp/result-$i"
  fi
}

# Fire 6 concurrent runs with --num-shots=1 each → total request = 6, ceiling = 5.
pids=()
for i in 1 2 3 4 5 6; do
  run_one "$i" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do
  wait "$pid" || true
done

ok_count=0
ratelimited_count=0
for i in 1 2 3 4 5 6; do
  r="$(cat "$tmp/result-$i" 2>/dev/null || echo missing)"
  case "$r" in
    ok)       ok_count=$((ok_count + 1)) ;;
    fail-2)   ratelimited_count=$((ratelimited_count + 1)) ;;
    *)        printf 'unexpected result for run %d: %s\n' "$i" "$r" >&2 ;;
  esac
done

printf 'concurrent runs: ok=%d rate_limited=%d\n' "$ok_count" "$ratelimited_count"

# Assertions:
#  - Total ok + rate_limited must be 6.
#  - ok must be ≤ 5 (we never exceeded the ceiling).
#  - At least 1 must have been rate-limited (proves the gate engaged).
if [ "$((ok_count + ratelimited_count))" -ne 6 ]; then
  printf 'FAIL: not all runs accounted for\n' >&2
  exit 1
fi
if [ "$ok_count" -gt 5 ]; then
  printf 'FAIL: ok_count=%d exceeded rate ceiling of 5\n' "$ok_count" >&2
  exit 1
fi
if [ "$ratelimited_count" -lt 1 ]; then
  printf 'FAIL: rate-floor never engaged (ratelimited=%d) — gate is broken\n' "$ratelimited_count" >&2
  exit 1
fi

printf 'PASS: rate-floor holds under concurrency (ok=%d ≤ 5, ratelimited=%d ≥ 1)\n' "$ok_count" "$ratelimited_count"
