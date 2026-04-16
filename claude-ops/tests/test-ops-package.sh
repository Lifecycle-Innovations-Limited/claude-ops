#!/usr/bin/env bash
# test-ops-package.sh — Validates the carrier-agnostic ops-package skill.
# - bash -n / shellcheck on router + common lib + every carrier adapter
# - Every adapter exposes ship/label/track/list/configured functions
# - Missing credentials → clean exit 2 (not a bash error) for every carrier
# - Router detects unknown carrier, missing credentials, and prints help
# - No real HTTP calls are made
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$PLUGIN_ROOT/skills/ops-package"
LIB_DIR="$PKG_DIR/lib"
CARRIERS_DIR="$LIB_DIR/carriers"
ROUTER="$PKG_DIR/ops-package.sh"

pass=0
fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1"; fail=$((fail+1)); }

if [ ! -f "$ROUTER" ]; then
  echo "FAIL: router not found at $ROUTER"
  exit 1
fi

# Discover all carrier files.
carrier_files=()
while IFS= read -r -d '' f; do
  carrier_files+=("$f")
done < <(find "$CARRIERS_DIR" -maxdepth 1 -name "*.sh" -print0 2>/dev/null)

if [ ${#carrier_files[@]} -eq 0 ]; then
  echo "FAIL: no carrier adapters found in $CARRIERS_DIR"
  exit 1
fi

echo "Found ${#carrier_files[@]} carrier adapter(s) + common lib + router"
echo ""

# ─── 1. Syntax check on every shell file ─────────────────────────────────
echo "Syntax check (bash -n):"
for f in "$ROUTER" "$LIB_DIR/common.sh" "${carrier_files[@]}"; do
  rel="${f#$PLUGIN_ROOT/}"
  if bash -n "$f" 2>/dev/null; then
    ok "$rel parses"
  else
    err "$rel has syntax errors"
    bash -n "$f" 2>&1 | sed 's/^/    /'
  fi
done

# shellcheck (errors only) if available.
if command -v shellcheck &>/dev/null; then
  echo ""
  echo "shellcheck -S error:"
  for f in "$ROUTER" "$LIB_DIR/common.sh" "${carrier_files[@]}"; do
    rel="${f#$PLUGIN_ROOT/}"
    if shellcheck -S error -x "$f" 2>/dev/null; then
      ok "$rel shellcheck clean"
    else
      err "$rel shellcheck errors"
      shellcheck -S error -x "$f" 2>&1 | sed 's/^/    /' | head -20
    fi
  done
fi

# ─── 2. Each adapter exposes the 5 required functions ───────────────────
echo ""
echo "Adapter contract (ship/label/track/list/configured):"
for f in "${carrier_files[@]}"; do
  name=$(basename "$f" .sh)
  for fn in ship label track list configured; do
    if grep -qE "^${name}_${fn}\s*\(\s*\)\s*\{" "$f"; then
      ok "${name}_${fn} defined"
    else
      err "${name}_${fn} missing in $(basename "$f")"
    fi
  done
done

# ─── 3. Missing credentials → exit 2 (not a bash error) ─────────────────
echo ""
echo "Missing-credentials behaviour:"
# Clear every relevant env var and temporarily move preferences.json so
# resolve_env can't find anything.
env_clear="env -i PATH=\"$PATH\" HOME=/tmp/opspkgtest_home TMPDIR=/tmp/opspkgtest_tmp"
mkdir -p /tmp/opspkgtest_home /tmp/opspkgtest_tmp

# Each adapter must exit 2 for `ship --to ...` when no creds are set.
for f in "${carrier_files[@]}"; do
  name=$(basename "$f" .sh)
  # Use env -i to wipe inherited carrier env vars.
  set +e
  output=$(env -i PATH="$PATH" HOME=/tmp/opspkgtest_home TMPDIR=/tmp/opspkgtest_tmp \
    bash "$ROUTER" --carrier "$name" ship --to "Test, Street 1, 1011AB City, NL" 2>&1)
  rc=$?
  set -e
  if [ "$rc" = "2" ]; then
    ok "${name}: exits 2 without credentials"
  else
    err "${name}: expected rc=2, got rc=$rc (output: $(printf '%s' "$output" | head -1))"
  fi
  # Output should contain human-readable guidance, not a raw bash error.
  if printf '%s' "$output" | grep -qE "Missing credentials|not configured|ERROR:"; then
    ok "${name}: produces human error message"
  else
    err "${name}: no clear error message (output: $(printf '%s' "$output" | head -2))"
  fi
done

# ─── 4. Router-level checks ──────────────────────────────────────────────
echo ""
echo "Router behaviour:"

# 4a. --help shows usage without hitting API.
set +e
help_out=$(env -i PATH="$PATH" HOME=/tmp/opspkgtest_home bash "$ROUTER" --help 2>&1)
help_rc=$?
set -e
if [ "$help_rc" = "0" ] && printf '%s' "$help_out" | grep -q "carrier-agnostic"; then
  ok "--help exits 0 and prints banner"
else
  err "--help malfunction (rc=$help_rc)"
fi

# 4b. `carriers` subcommand lists every carrier.
set +e
car_out=$(env -i PATH="$PATH" HOME=/tmp/opspkgtest_home bash "$ROUTER" carriers 2>&1)
car_rc=$?
set -e
if [ "$car_rc" = "0" ]; then
  ok "carriers subcommand exits 0"
else
  err "carriers subcommand rc=$car_rc"
fi
for name in myparcel sendcloud dhl postnl dpd ups fedex; do
  if printf '%s' "$car_out" | grep -q "$name"; then
    ok "carriers lists $name"
  else
    err "carriers output missing $name"
  fi
done

# 4c. Unknown carrier flag fails with exit 64.
set +e
bad_out=$(env -i PATH="$PATH" HOME=/tmp/opspkgtest_home bash "$ROUTER" --carrier nonexistent ship --to "x, y 1, 1000AA c, NL" 2>&1)
bad_rc=$?
set -e
if [ "$bad_rc" = "64" ]; then
  ok "unknown carrier exits 64"
else
  err "unknown carrier: expected rc=64, got rc=$bad_rc"
fi

# 4d. Unknown subcommand fails with exit 64.
set +e
unk_out=$(env -i PATH="$PATH" HOME=/tmp/opspkgtest_home bash "$ROUTER" frobnicate 2>&1)
unk_rc=$?
set -e
if [ "$unk_rc" = "64" ]; then
  ok "unknown subcommand exits 64"
else
  err "unknown subcommand: expected rc=64, got rc=$unk_rc"
fi

# ─── 5. partner-registry.seed.json has every carrier ────────────────────
echo ""
echo "partner-registry seed:"
SEED="$PLUGIN_ROOT/scripts/partner-registry.seed.json"
if command -v jq &>/dev/null && [ -f "$SEED" ]; then
  for name in myparcel sendcloud dhl_parcel_nl postnl dpd ups fedex; do
    if jq -e ".partner_registry.\"$name\"" "$SEED" >/dev/null 2>&1; then
      ok "seed has entry: $name"
    else
      err "seed missing entry: $name"
    fi
  done
else
  echo "  SKIP: jq or seed file missing"
fi

# ─── Cleanup ─────────────────────────────────────────────────────────────
rm -rf /tmp/opspkgtest_home /tmp/opspkgtest_tmp

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
echo ""
if (( fail > 0 )); then
  exit 1
fi
exit 0
