#!/usr/bin/env bash
# test-secret-sync.sh — Unit tests for bin/ops-secret-sync using mock gh + doppler
set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$PLUGIN_ROOT/bin/ops-secret-sync"
MOCKS_DIR="$PLUGIN_ROOT/tests/mocks"

pass=0
fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1"; fail=$((fail+1)); }

# ── helpers ───────────────────────────────────────────────────────────────────

# Run ops-secret-sync with PATH-injected mock binaries.
# Usage: run_sync [extra args...]
# Env vars consumed by mocks:
#   MOCK_GH_SECRET_JSON    — JSON array for `gh secret list`
#   MOCK_DOPPLER_JSON      — JSON object for `doppler secrets --json`
run_sync() {
  PATH="$MOCKS_DIR:$PATH" \
  MOCK_GH_SECRET_JSON="${MOCK_GH_SECRET_JSON:-}" \
  MOCK_DOPPLER_JSON="${MOCK_DOPPLER_JSON:-}" \
    "$BIN" --repo "your-org/your-repo" --project "your-project" --config "prd" "$@" 2>&1 || true
}

# Returns the exit code of ops-secret-sync as a plain integer on stdout.
get_rc() {
  PATH="$MOCKS_DIR:$PATH" \
  MOCK_GH_SECRET_JSON="${MOCK_GH_SECRET_JSON:-}" \
  MOCK_DOPPLER_JSON="${MOCK_DOPPLER_JSON:-}" \
    "$BIN" --repo "your-org/your-repo" --project "your-project" --config "prd" "$@" >/dev/null 2>&1
  echo $?
}

# ── prereqs ───────────────────────────────────────────────────────────────────

if [[ ! -x "$BIN" ]]; then
  echo "FAIL: $BIN not found or not executable"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: jq not available — skipping all tests"
  exit 0
fi

# Verify mock stubs exist
for mock in gh doppler; do
  if [[ ! -x "$MOCKS_DIR/$mock" ]]; then
    echo "SKIP: mock '$mock' not found at $MOCKS_DIR/$mock — skipping"
    exit 0
  fi
done

echo ""
echo "Running: ops-secret-sync tests"
echo ""

# ── test 1: all secrets in sync → exit 0 ─────────────────────────────────────
echo "Test 1: all secrets in sync"

# GH secret updated AFTER Doppler — no drift
export MOCK_GH_SECRET_JSON='[
  {"name":"INNGEST_SIGNING_KEY","updatedAt":"2026-05-01T10:00:00Z"},
  {"name":"DATABASE_URL","updatedAt":"2026-05-01T10:00:00Z"}
]'
export MOCK_DOPPLER_JSON='{
  "INNGEST_SIGNING_KEY": {"updatedAt":"2026-04-01T09:00:00Z","computed":"v1"},
  "DATABASE_URL":        {"updatedAt":"2026-04-01T09:00:00Z","computed":"v1"}
}'

OUTPUT=$(run_sync --json)
RC=$(get_rc --json)

DRIFTED=$(echo "$OUTPUT" | jq '.drifted | length' 2>/dev/null || echo "ERR")
MISSING=$(echo "$OUTPUT" | jq '.missing_from_gh | length' 2>/dev/null || echo "ERR")

if [[ "$DRIFTED" == "0" && "$MISSING" == "0" ]]; then
  ok "no drift detected when GH is current"
else
  err "expected drifted=0 missing=0, got drifted=$DRIFTED missing=$MISSING"
fi

if [[ "$RC" == "0" ]]; then
  ok "exit 0 when no drift"
else
  err "expected exit 0, got $RC"
fi

echo ""

# ── test 2: stale GH secret → exit 1, shows in drifted ──────────────────────
echo "Test 2: INNGEST_SIGNING_KEY stale in GH by 25 days"

# Doppler updated 2026-04-23, GH updated 2026-03-30 (delta = 24d 1h stale)
export MOCK_GH_SECRET_JSON='[
  {"name":"INNGEST_SIGNING_KEY","updatedAt":"2026-03-29T09:00:00Z"},
  {"name":"DATABASE_URL","updatedAt":"2026-04-23T10:00:00Z"}
]'
export MOCK_DOPPLER_JSON='{
  "INNGEST_SIGNING_KEY": {"updatedAt":"2026-04-23T10:00:00Z","computed":"new-key"},
  "DATABASE_URL":        {"updatedAt":"2026-04-23T10:00:00Z","computed":"db-url"}
}'

OUTPUT=$(run_sync --json)
RC=$(get_rc --json)

DRIFTED=$(echo "$OUTPUT" | jq '.drifted | length' 2>/dev/null || echo "ERR")
DRIFTED_NAME=$(echo "$OUTPUT" | jq -r '.drifted[0].name // ""' 2>/dev/null)
MISSING=$(echo "$OUTPUT" | jq '.missing_from_gh | length' 2>/dev/null || echo "ERR")

if [[ "$DRIFTED" == "1" && "$DRIFTED_NAME" == "INNGEST_SIGNING_KEY" ]]; then
  ok "INNGEST_SIGNING_KEY flagged as drifted"
else
  err "expected drifted=1 (INNGEST_SIGNING_KEY), got drifted=$DRIFTED name=$DRIFTED_NAME"
fi

if [[ "$RC" == "1" ]]; then
  ok "exit 1 when drift found"
else
  err "expected exit 1, got $RC"
fi

if [[ "$MISSING" == "0" ]]; then
  ok "DATABASE_URL not in missing (it exists in GH)"
else
  err "expected missing=0, got $MISSING"
fi

echo ""

# ── test 3: secret in Doppler but absent from GH → missing ──────────────────
echo "Test 3: CEREBRAS_API_KEY in Doppler but absent from GH"

export MOCK_GH_SECRET_JSON='[
  {"name":"DATABASE_URL","updatedAt":"2026-05-01T10:00:00Z"}
]'
export MOCK_DOPPLER_JSON='{
  "CEREBRAS_API_KEY": {"updatedAt":"2026-04-01T09:00:00Z","computed":"key"},
  "DATABASE_URL":     {"updatedAt":"2026-04-01T09:00:00Z","computed":"db"}
}'

OUTPUT=$(run_sync --json)
RC=$(get_rc --json)

MISSING=$(echo "$OUTPUT" | jq '.missing_from_gh | length' 2>/dev/null || echo "ERR")
MISSING_NAME=$(echo "$OUTPUT" | jq -r '.missing_from_gh[0].name // ""' 2>/dev/null)

if [[ "$MISSING" == "1" && "$MISSING_NAME" == "CEREBRAS_API_KEY" ]]; then
  ok "CEREBRAS_API_KEY flagged as missing from GH"
else
  err "expected missing=1 (CEREBRAS_API_KEY), got missing=$MISSING name=$MISSING_NAME"
fi

if [[ "$RC" == "1" ]]; then
  ok "exit 1 when missing found"
else
  err "expected exit 1 for missing secrets, got $RC"
fi

echo ""

# ── test 4: delta exactly at threshold (24h) → NOT drifted ──────────────────
echo "Test 4: delta exactly 24h — should NOT flag as drifted (threshold is >24h)"

# Doppler updated exactly 24h after GH — should be in sync (threshold is strictly >86400s)
export MOCK_GH_SECRET_JSON='[
  {"name":"API_KEY","updatedAt":"2026-04-22T10:00:00Z"}
]'
export MOCK_DOPPLER_JSON='{
  "API_KEY": {"updatedAt":"2026-04-23T10:00:00Z","computed":"val"}
}'

OUTPUT=$(run_sync --json)
DRIFTED=$(echo "$OUTPUT" | jq '.drifted | length' 2>/dev/null || echo "ERR")

if [[ "$DRIFTED" == "0" ]]; then
  ok "delta exactly 24h not flagged (threshold is strictly >24h)"
else
  err "expected drifted=0 at exactly 24h, got $DRIFTED"
fi

echo ""

# ── test 5: empty Doppler + empty GH → no drift, exit 0 ─────────────────────
echo "Test 5: empty project (no secrets on either side)"

export MOCK_GH_SECRET_JSON='[]'
export MOCK_DOPPLER_JSON='{}'

OUTPUT=$(run_sync --json)
RC=$(get_rc --json)

DRIFTED=$(echo "$OUTPUT" | jq '.drifted | length' 2>/dev/null || echo "ERR")
MISSING=$(echo "$OUTPUT" | jq '.missing_from_gh | length' 2>/dev/null || echo "ERR")

if [[ "$DRIFTED" == "0" && "$MISSING" == "0" ]]; then
  ok "empty project reports no drift"
else
  err "expected drifted=0 missing=0, got drifted=$DRIFTED missing=$MISSING"
fi

if [[ "$RC" == "0" ]]; then
  ok "exit 0 for empty project"
else
  err "expected exit 0 for empty project, got $RC"
fi

echo ""

# ── test 6: human output contains DRIFTED label ──────────────────────────────
echo "Test 6: human (non-JSON) output mentions DRIFTED"

export MOCK_GH_SECRET_JSON='[
  {"name":"OPENROUTER_API_KEY","updatedAt":"2026-03-01T00:00:00Z"}
]'
export MOCK_DOPPLER_JSON='{
  "OPENROUTER_API_KEY": {"updatedAt":"2026-05-01T00:00:00Z","computed":"key"}
}'

OUTPUT=$(run_sync)  # no --json

if echo "$OUTPUT" | grep -qi "DRIFTED\|stale\|drift"; then
  ok "human output mentions drift"
else
  err "human output should mention DRIFTED/stale, got: $(echo "$OUTPUT" | head -5)"
fi

echo ""

# ── summary ──────────────────────────────────────────────────────────────────
echo "---"
echo "Results: $pass passed, $fail failed"
echo ""

if (( fail > 0 )); then exit 1; fi
exit 0
