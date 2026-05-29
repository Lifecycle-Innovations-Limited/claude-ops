#!/usr/bin/env bash
# test-pocket-env-broker.sh — exercises the secrets broker: allowlist grant/deny,
# socket round-trip, uid peer-auth gate, and audit logging. No sudo required:
# the broker is told the current user is the authorized worker user, so the
# same-process client round-trips; a negative case points it at a different user.
set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BROKER="$PLUGIN_ROOT/scripts/pocket-env-broker.py"
CLIENT="$PLUGIN_ROOT/scripts/pocket-env"
PY="$(command -v python3 || true)"

pass=0
fail=0
ok() { echo "  PASS: $1"; pass=$((pass + 1)); }
err() {
  echo "  FAIL: $1 — $2"
  fail=$((fail + 1))
}

echo "Testing pocket-env-broker"
echo ""

if [[ -z "$PY" ]]; then
  echo "  SKIP: python3 not available"
  echo "test-pocket-env-broker.sh: 0 passed, 0 failed (skipped)"
  exit 0
fi

TMP="$(mktemp -d)"
BROKER_PID=""
cleanup() {
  [[ -n "$BROKER_PID" ]] && kill "$BROKER_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

SOCK="$TMP/env-broker.sock"
POLICY="$TMP/policy.json"
AUDIT="$TMP/audit.log"
printf '%s\n' '{"allow":["FOO_OK"]}' >"$POLICY"

start_broker() { # $1 = worker user to authorize
  POCKET_ENV_BROKER_SOCK="$SOCK" POCKET_ENV_BROKER_POLICY="$POLICY" \
    POCKET_ENV_BROKER_AUDIT="$AUDIT" POCKET_WORKER_USER="$1" \
    FOO_OK="the-secret-value" BAR_SECRET="should-not-leak" \
    "$PY" "$BROKER" &
  BROKER_PID=$!
  for _ in $(seq 1 50); do
    [[ -S "$SOCK" ]] && return 0
    sleep 0.1
  done
  return 1
}

run_client() { # $1 = var → prints value, sets global RC
  OUT="$(POCKET_ENV_BROKER_SOCK="$SOCK" POCKET_STATE_DIR="$TMP" "$PY" "$CLIENT" "$1" 2>/dev/null)"
  RC=$?
}

# ── Case A: authorized uid (current user) ───────────────────────────────────
ME="$(id -un)"
if start_broker "$ME"; then
  ok "broker started and bound socket"
else
  err "broker startup" "socket never appeared"
  echo "test-pocket-env-broker.sh: $pass passed, $((fail + 1)) failed"
  exit 1
fi

run_client FOO_OK
if [[ $RC -eq 0 && "$OUT" == "the-secret-value" ]]; then
  ok "allowlisted var granted with correct value"
else
  err "grant FOO_OK" "rc=$RC out='$OUT'"
fi

run_client BAR_SECRET
if [[ $RC -eq 1 && -z "$OUT" ]]; then
  ok "non-allowlisted var denied (not in policy)"
else
  err "deny BAR_SECRET" "rc=$RC out='$OUT' (should be denied, no value)"
fi

run_client NOT_IN_ENV_EITHER
if [[ $RC -eq 1 ]]; then
  ok "unknown var denied"
else
  err "deny unknown" "rc=$RC"
fi

# audit log should contain a granted + a denied record
if grep -q '"decision": "granted"' "$AUDIT" && grep -q '"decision": "not_allowed"' "$AUDIT"; then
  ok "audit log records granted + denied decisions"
else
  err "audit log" "missing expected decision records: $(cat "$AUDIT" 2>/dev/null)"
fi

kill "$BROKER_PID" 2>/dev/null
wait "$BROKER_PID" 2>/dev/null
BROKER_PID=""
rm -f "$SOCK"

# ── Case B: uid gate — broker authorizes a DIFFERENT user → current user denied ─
OTHER="nobody"
if id "$OTHER" >/dev/null 2>&1; then
  if start_broker "$OTHER"; then
    run_client FOO_OK
    if [[ $RC -eq 1 && -z "$OUT" ]]; then
      ok "peer-auth gate denies a non-authorized uid"
    else
      err "uid gate" "rc=$RC out='$OUT' (current user should be rejected as != $OTHER)"
    fi
    grep -q '"decision": "not_allowed_uid"' "$AUDIT" && ok "audit records uid rejection" \
      || err "audit uid" "no not_allowed_uid record"
  else
    err "broker startup (case B)" "socket never appeared"
  fi
else
  echo "  SKIP: user '$OTHER' not present — uid-gate negative case"
fi

echo ""
echo "test-pocket-env-broker.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
