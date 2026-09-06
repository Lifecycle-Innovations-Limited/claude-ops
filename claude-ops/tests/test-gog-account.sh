#!/usr/bin/env bash
# test-gog-account.sh — lib/gog-account.sh must distinguish "cannot measure"
# from "nothing there".
#
# Regression: bin/ops-unread probed `gog gmail search` with no --account. Any
# store holding more than one token answers "missing --account" on stderr and
# the caller swallowed it into "gog not authenticated" — an authenticated
# mailbox rendered identically to a broken one on the dashboard. Same shape for
# a locked keyring ("no TTY available ... GOG_KEYRING_PASSWORD").
set -uo pipefail

LIB="$(cd "$(dirname "$0")/.." && pwd)/lib/gog-account.sh"
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

BIN_DIR=$(mktemp -d)
PREFS_DIR=$(mktemp -d)
trap 'rm -rf "$BIN_DIR" "$PREFS_DIR"' EXIT

mk_gog() { # $1 = behaviour
  cat >"$BIN_DIR/gog" <<EOF
#!/usr/bin/env bash
BEHAVIOUR="$1"
case "\$1 \$2" in
  "auth list")
    printf 'a@example.com\t\tservice-account\t2026-01-01\tservice_account\n'
    printf 'b@example.com\tdefault\tgmail,calendar\t2026-01-01\toauth\n'
    exit 0
    ;;
esac
# every real call requires an explicit -a; a bare call is the bug under test
case " \$* " in
  *" -a "*) ;;
  *) echo "missing --account (or set GOG_ACCOUNT, ...)" >&2; exit 1 ;;
esac
case "\$BEHAVIOUR" in
  locked) echo "gmail options: token source: no TTY available for keyring file backend password prompt; set GOG_KEYRING_PASSWORD" >&2; exit 1 ;;
  expired) echo "oauth2: invalid_grant" >&2; exit 1 ;;
  ok) echo '[]'; exit 0 ;;
esac
EOF
  chmod +x "$BIN_DIR/gog"
}

run_probe() { # runs ops_gog_ready in a clean shell, echoes "rc|account|note"
  env -i HOME="$PREFS_DIR" PATH="$BIN_DIR:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" \
    PREFS_PATH="$PREFS_DIR/preferences.json" \
    bash -c ". '$LIB'; if ops_gog_ready; then echo \"0|\$OPS_GOG_ACCOUNT|\"; else echo \"1|\$OPS_GOG_ACCOUNT|\$OPS_GOG_NOTE\"; fi"
}

echo "gog-account resolver"

# 1. authenticated store with several tokens must resolve, not report "not authenticated"
mk_gog ok
echo '{"gmail_account":"b@example.com"}' >"$PREFS_DIR/preferences.json"
out=$(run_probe)
[[ "$out" == 0\|b@example.com\|* ]] &&
  ok "multi-token store resolves the account from preferences" ||
  no "multi-token store should resolve, got: $out"

# 2. no preferences → falls back to the account gog marks default
mk_gog ok
rm -f "$PREFS_DIR/preferences.json"
out=$(run_probe)
[[ "$out" == 0\|b@example.com\|* ]] &&
  ok "falls back to the gog default account" ||
  no "expected default-account fallback, got: $out"

# 3. locked keyring must NOT read as an empty/clean mailbox
mk_gog locked
echo '{"gmail_account":"b@example.com"}' >"$PREFS_DIR/preferences.json"
out=$(run_probe)
[[ "$out" == 1\|* && "$out" == *GOG_KEYRING_PASSWORD* ]] &&
  ok "locked keyring reports the lock, not a clean result" ||
  no "locked keyring must surface GOG_KEYRING_PASSWORD, got: $out"

# 4. expired token names re-auth, and never claims success
mk_gog expired
out=$(run_probe)
[[ "$out" == 1\|* && "$out" == *expired* ]] &&
  ok "expired token reports re-auth" ||
  no "expired token should report re-auth, got: $out"

# 5. gog absent is its own distinct note
out=$(env -i HOME="$PREFS_DIR" PATH="/usr/bin:/bin" PREFS_PATH="$PREFS_DIR/preferences.json" \
  bash -c ". '$LIB'; ops_gog_ready; echo \"\$OPS_GOG_NOTE\"")
[[ "$out" == *"not installed"* ]] &&
  ok "missing gog binary is distinguished from missing auth" ||
  no "expected 'not installed', got: $out"

# 6. no bin/ caller may invoke gog without an explicit account.
#    Command position only: start of line, or after ( ! | && ; $( — so log
#    strings and comments that merely mention "gog gmail search" don't trip it.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
offenders=$(grep -rnE '(^|[|&;!]|\$\()[[:space:]]*gog[[:space:]]+(gmail|calendar)[[:space:]]+[a-z]' "$ROOT/bin" 2>/dev/null |
  awk -F: '{ line=$0; sub(/^[^:]*:[0-9]*:/, "", line); if (line ~ /^[[:space:]]*#/) next; print }' |
  grep -v -- '-a ' | grep -v -- '--account' | grep -v 'ACCT_ARGS' || true)
if [ -z "$offenders" ]; then
  ok "no bin/ caller invokes gog without an account"
else
  no "gog called without an account:"
  echo "$offenders" | head -5
fi

echo ""
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
