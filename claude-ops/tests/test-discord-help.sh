#!/usr/bin/env bash
# test-discord-help.sh — Smoke-tests bin/ops-discord behavior without making
# any real Discord API calls.
#
# Asserts:
#   1. `bin/ops-discord --help`  exits 0 and prints the expected USAGE banner.
#   2. `bin/ops-discord` (no args) exits 0 and prints the same banner.
#   3. `bin/ops-discord read 123456789012345678 --json` exits 1 with
#      `{"error": "no discord credential configured ..."}` when no creds are set.
#   4. `bin/ops-discord send` (no args) exits 2 with a usage error.
#   5. `bin/ops-discord unknown` exits 2.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$PLUGIN_ROOT/bin/ops-discord"

pass=0
fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1"; fail=$((fail+1)); }

if [[ ! -x "$SCRIPT" ]]; then
  err "bin/ops-discord is not executable"
  exit 1
fi

# Sandbox: scrub any Discord env that may have leaked in from the parent shell
# so the `read` test reliably hits the no-credential code path.
unset DISCORD_BOT_TOKEN DISCORD_GUILD_ID DISCORD_WEBHOOK_URL || true
export PREFS_PATH="/nonexistent/should-not-be-read.json"

echo "1. --help exits 0 + prints USAGE"
out="$("$SCRIPT" --help 2>&1)"
ec=$?
if [[ $ec -eq 0 ]] && grep -q "USAGE" <<<"$out" && grep -q "ops-discord send" <<<"$out"; then
  ok "help banner present"
else
  err "help banner missing or non-zero exit ($ec)"
  printf '%s\n' "$out" | head -20
fi

echo "2. no-arg invocation prints help"
out="$("$SCRIPT" 2>&1)"
ec=$?
if [[ $ec -eq 0 ]] && grep -q "SUBCOMMANDS" <<<"$out"; then
  ok "no-arg shows help"
else
  err "no-arg help missing"
fi

echo "3. read with --json + no creds → JSON error + exit 1"
set +e
out="$("$SCRIPT" read 123456789012345678 --json 2>&1)"
ec=$?
set -e
if [[ $ec -eq 1 ]] && grep -q '"error"' <<<"$out" && grep -q "no discord credential configured" <<<"$out"; then
  ok "graceful JSON error on missing creds"
else
  err "expected JSON error + exit 1, got exit=$ec output=$out"
fi

echo "4. send with no args → usage error exit 2"
set +e
"$SCRIPT" send >/dev/null 2>&1
ec=$?
set -e
if [[ $ec -eq 2 ]]; then
  ok "send-without-args exits 2"
else
  err "expected exit 2, got $ec"
fi

echo "5. unknown subcommand → exit 2"
set +e
"$SCRIPT" frobnicate >/dev/null 2>&1
ec=$?
set -e
if [[ $ec -eq 2 ]]; then
  ok "unknown subcommand exits 2"
else
  err "expected exit 2, got $ec"
fi

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
echo ""

if (( fail > 0 )); then
  exit 1
fi
exit 0
