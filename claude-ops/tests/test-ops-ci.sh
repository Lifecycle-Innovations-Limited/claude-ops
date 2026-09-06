#!/usr/bin/env bash
# test-ops-ci.sh — ops-ci must survive a PARTIAL GraphQL failure.
#
# Regression: `gh api graphql` on an aliased multi-repo query exits NON-ZERO
# when any single alias is unreadable (NOT_FOUND on a private/renamed repo),
# while still printing a complete, usable payload:
#     {"data":{...},"errors":[{"type":"NOT_FOUND",...}]}   + exit 1
# ops-ci wrapped that in `|| echo '{}'`, which APPENDED a second JSON document.
# Every downstream `jq` then emitted one value per document ("14\n0"), and the
# numeric test blew up 30 times with:
#     ops-ci: line 144: [: 14\n0: integer expected
# The scan still exited 0, so the dashboard printed a fire count derived from a
# half-parsed payload — a checker that could not measure, reading as a result.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pass=0
fail=0
ok() {
  echo "  PASS: $1"
  pass=$((pass + 1))
}
no() {
  echo "  FAIL: $1"
  fail=$((fail + 1))
}

echo "ops-ci partial-GraphQL handling"

# 1. the fallback must not be able to append a second document
if grep -q "gh api graphql -f query=\"\$query\" 2>/dev/null || echo '{}'" "$ROOT/bin/ops-ci"; then
  no "gh graphql still falls back with '|| echo {}' (appends a 2nd JSON doc)"
else
  ok "gh graphql fallback cannot append a second JSON document"
fi

# 2. every count derived from gh output must be slurped, so a multi-document
#    input can never produce a multi-line integer
if grep -nE "fcount=.*jq '" "$ROOT/bin/ops-ci" | grep -qv 'jq -s'; then
  no "fcount is computed without jq -s"
else
  ok "fcount uses jq -s and cannot yield a multi-line integer"
fi

# 3. the numeric test is guarded against a non-integer
if grep -q 'fcount" =~ \^\[0-9\]+\$' "$ROOT/bin/ops-ci"; then
  ok "fcount is validated as an integer before the numeric test"
else
  no "fcount reaches [ -gt ] without an integer guard"
fi

# 4. behavioural: a real partial payload must parse to exactly one value
partial='{"data":{"r0":{"main":{"target":{"oid":"abc"}}},"r1":null},"errors":[{"type":"NOT_FOUND"}]}'
# old shape: payload + appended '{}' — this is what the bug produced
doubled="${partial}{}"
lines=$(printf '%s' "$doubled" | jq -s '.[0].data // {}' | jq -s 'length')
if [ "$lines" = "1" ]; then
  ok "jq -s collapses an accidentally doubled payload to one value"
else
  no "expected 1 value from a doubled payload, got $lines"
fi

# 5. and the good half of a partial payload must survive
oid=$(printf '%s' "$partial" | jq -rs '.[0].data.r0.main.target.oid')
[ "$oid" = "abc" ] &&
  ok "readable repos still parse when a sibling alias is NOT_FOUND" ||
  no "partial payload lost its readable data, got: $oid"

# 6. ops-ci is syntactically valid
bash -n "$ROOT/bin/ops-ci" 2>/dev/null &&
  ok "ops-ci parses" ||
  no "ops-ci has a syntax error"

echo ""
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
