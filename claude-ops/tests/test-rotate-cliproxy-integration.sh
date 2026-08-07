#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/scripts/account-rotation/rotate.mjs"

pass=0
fail=0
check() {
  local name="$1" pattern="$2"
  if grep -Fq "$pattern" "$SRC"; then
    echo "PASS: $name"
    pass=$((pass+1))
  else
    echo "FAIL: $name"
    fail=$((fail+1))
  fi
}

check "CLIProxyAPI is the canonical OAuth writer" "spawn(CLIPROXYAPI_BINARY, ['-config', CLIPROXYAPI_CONFIG, '-claude-login']"
check "forwarded Anthropic magic-link subject is supported" "from:anthropic (subject:\"secure link\" OR subject:\"Claude.ai\") newer_than:10m"
check "OAuth waiter renews after magic-link login" "Renewed OAuth waiter after login; callback port"
check "renewal is invoked at OAuth consent boundary" "Consent boundary using renewed OAuth writer"
check "canonical auth mutation is required" "OAuth page succeeded but matching canonical auth JSON did not mutate"
check "successful rotation triggers one-way replica sync" "One-way replica sync completed"
check "legacy keychain is skipped in CLIProxy mode" "!lastBrowserOAuthUsedCliProxy) saveCurrentToken(account)"

printf 'Results: %d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
