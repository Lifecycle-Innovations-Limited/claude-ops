#!/usr/bin/env bash
# test-registry-schema-skills.sh — the jq queries embedded in ops-orchestrate and
# ops-next must read the schema that scripts/ops-gsd-registry-sync.sh actually
# writes (name/path/remote_url/status/phase/branch), not the hand-written
# alias/paths/repos/gsd shape of registry.example.json.
#
# Regression for 2026-09-09: both skills queried .alias/.paths/.gsd against the
# synced file and got "null|null|none|false" for all 98 projects, so GLOBAL
# mode found nothing to orchestrate.
#
# Runs against the REAL registry when present ($OPS_DATA_DIR/registry.json),
# otherwise against a fixture with the synced schema.
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
pass=0; fail=0
ok()   { echo "  ✓ $1"; pass=$((pass+1)); }
bad()  { echo "  ✗ $1"; fail=$((fail+1)); }

. "$PLUGIN_ROOT/lib/registry-path.sh"
if [ ! -s "$REGISTRY" ]; then
  REGISTRY="$TESTS_DIR/fixtures/registry-synced-schema.json"
  echo "  (real registry absent — using fixture $REGISTRY)"
else
  echo "  (using real registry $REGISTRY)"
fi

extract_jq() {
  # first jq -r '...' "$REGISTRY" line in a SKILL.md, filter only
  grep -m1 -o "jq -r '[^']*'" "$1" | sed "s/^jq -r '//; s/'$//"
}

check_skill() {
  local skill="$1" file="$PLUGIN_ROOT/skills/$1/SKILL.md"
  local filter; filter="$(extract_jq "$file")"
  [ -n "$filter" ] || { bad "$skill: no jq filter found in SKILL.md"; return; }

  if grep -q 'scripts/registry.json' "$file"; then
    bad "$skill: still hardcodes scripts/registry.json instead of lib/registry-path.sh"
  else
    ok "$skill: resolves registry via lib/registry-path.sh"
  fi
  if grep -qE '\.alias\b|\.paths\[|\.repos\[|\.gsd\b' "$file"; then
    bad "$skill: queries example-schema fields (.alias/.paths/.repos/.gsd)"
  else
    ok "$skill: no example-schema fields"
  fi

  local out; out="$(jq -r "$filter" "$REGISTRY" 2>&1 | head -50)" || { bad "$skill: jq filter errors: $out"; return; }
  local n; n="$(printf '%s\n' "$out" | grep -c . || true)"
  [ "$n" -gt 0 ] || { bad "$skill: jq filter returns no rows"; return; }
  if printf '%s\n' "$out" | grep -qE '^null\||\|null\||\|null$|^null$'; then
    bad "$skill: jq filter yields null fields against synced registry:"
    printf '%s\n' "$out" | head -3 | sed 's/^/      /'
  else
    ok "$skill: $n rows, no null fields"
  fi
}

echo "test-registry-schema-skills"
check_skill ops-orchestrate
check_skill ops-next

echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
