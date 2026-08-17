#!/usr/bin/env bash
# test-ops-merge-salvage-safety.sh — Guardrails for Phase 0 stale-copy prevention.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL="$ROOT/skills/ops-merge/SKILL.md"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

assert_contains() {
  local label="$1" pattern="$2"
  if grep -Fq "$pattern" "$SKILL"; then
    pass "$label"
  else
    fail "$label"
  fi
}

echo "== ops-merge salvage stale-copy safety =="
assert_contains "documents stale-copy guard step" "Stale-copy guard (mandatory, per candidate file before commit)"
assert_contains "uses merge-base against integration branch" 'BASE=$(git merge-base HEAD origin/<integration_branch>)'
assert_contains "checks integration-side file movement" 'git diff --quiet "$BASE..origin/<integration_branch>" -- "<f>"'
assert_contains "requires hunk-level staging" "Only stage hunks that are genuinely new work from the salvage branch"
assert_contains "aborts when freshness is unprovable" 'If you cannot prove the salvage branch is newer for `<f>`, mark the finding `aborted_for_review`'
assert_contains "safety rails forbid stale snapshot commits" "NEVER commit stale snapshots over integration branch progress"

echo "---"
echo "Results: $PASS passed, $FAIL failed"
if (( FAIL > 0 )); then
  exit 1
fi
