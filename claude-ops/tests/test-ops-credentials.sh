#!/usr/bin/env bash
# test-ops-credentials.sh — bin/ops-credentials must audit the whole catalog.
#
# Regression: the catalog loop used to read from stdin while resolve() shelled
# out to doppler / security / dcli. A child that drains stdin (doppler does when
# it is not attached to a TTY) swallowed the rest of the catalog, so the audit
# reported "1 tracked services" instead of all of them.
#
# The test runs the script against an isolated OPS_DATA_DIR whose preferences
# point the first catalog entry at a doppler: reference, with a mock `doppler`
# that reads stdin to EOF before answering. Every catalog row must still be
# reported.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$PLUGIN_ROOT/bin/ops-credentials"

pass=0
fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1"; fail=$((fail+1)); }

if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: jq not installed"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Mock doppler that drains stdin before answering — the behaviour that broke the loop.
mkdir -p "$TMP/bin" "$TMP/data"
cat > "$TMP/bin/doppler" <<'MOCK'
#!/usr/bin/env bash
cat >/dev/null
printf 'mock-doppler-value-1234567890'
MOCK
chmod +x "$TMP/bin/doppler"

# Isolated preferences: first catalog row (telegram api_hash) resolves via doppler.
printf '%s\n' '{"telegram":{"api_hash":"doppler:TELEGRAM_API_HASH"}}' > "$TMP/data/preferences.json"

# Number of rows in the embedded catalog: service|label|env|prefs|keychain|dashlane
expected=$(sed -n '/^read -r -d .. CATALOG/,/^CATEOF$/p' "$SCRIPT" | grep -cE '^[a-z_]+\|' || true)
if [[ "$expected" -lt 2 ]]; then
  err "could not count catalog rows in bin/ops-credentials (got $expected)"
  echo ""; echo "Results: $pass passed, $fail failed"; exit 1
fi

# Run with a clean env so host credentials never leak into the audit.
json=$(env -i HOME="$TMP" PATH="$TMP/bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" \
  OPS_DATA_DIR="$TMP/data" bash "$SCRIPT" --json 2>/dev/null || true)

reported=$(printf '%s' "$json" | jq 'length' 2>/dev/null || echo 0)
if [[ "$reported" -eq "$expected" ]]; then
  ok "audit reports every catalog row ($reported/$expected)"
else
  err "audit stopped early: $reported of $expected catalog rows reported"
fi

first_src=$(printf '%s' "$json" | jq -r '.[0].source // empty' 2>/dev/null || true)
if [[ "$first_src" == doppler:* ]]; then
  ok "first row resolved through the stdin-draining doppler mock ($first_src)"
else
  err "first row did not resolve via doppler (source='$first_src')"
fi

if printf '%s' "$json" | grep -q 'mock-doppler-value-1234567890'; then
  err "raw secret value leaked into --json output"
else
  ok "secret value is masked in --json output"
fi

echo ""
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
