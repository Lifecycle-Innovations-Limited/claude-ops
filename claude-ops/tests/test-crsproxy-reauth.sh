#!/usr/bin/env bash
# test-crsproxy-reauth.sh — run the cliproxy reauth Python unit tests
#
# The scripts/crsproxy-reauth/test_*.py files existed but no suite ran them,
# so a break in the reauth path only showed up on the hub. This wraps them
# so run-all.sh (and CI) covers them like every other suite.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REAUTH_DIR="$PLUGIN_ROOT/scripts/crsproxy-reauth"

pass=0
fail=0
ok() { echo "  PASS: $1"; pass=$((pass + 1)); }
err() { echo "  FAIL: $1"; fail=$((fail + 1)); }

echo "Checking: crsproxy-reauth"
echo ""

if [[ ! -d "$REAUTH_DIR" ]]; then
  err "scripts/crsproxy-reauth missing"
  echo ""
  echo "Passed: $pass  Failed: $fail"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "  SKIP: python3 not available"
  echo ""
  echo "Passed: $pass  Failed: $fail"
  exit 0
fi

# Keep __pycache__ out of the checkout; a stray cache dir trips the
# public-cleanliness and no-secrets suites.
PYCACHE="$(mktemp -d)"
trap 'rm -rf "$PYCACHE"' EXIT
export PYTHONPYCACHEPREFIX="$PYCACHE"
export PYTHONDONTWRITEBYTECODE=1

count=0
while IFS= read -r t; do
  count=$((count + 1))
  name="$(basename "$t")"
  if output="$(cd "$REAUTH_DIR" && python3 "$name" 2>&1)"; then
    ok "$name"
  else
    err "$name"
    echo "$output" | tail -20 | sed 's/^/      /'
  fi
done < <(find "$REAUTH_DIR" -maxdepth 1 -name 'test_*.py' | sort)

if [[ "$count" -eq 0 ]]; then
  err "no test_*.py found in scripts/crsproxy-reauth"
fi

echo ""
echo "Passed: $pass  Failed: $fail"
[[ "$fail" -eq 0 ]]
