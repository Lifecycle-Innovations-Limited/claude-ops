#!/usr/bin/env bash
# =============================================================================
# claude-ops foundation smoke tests
# =============================================================================
#
# Purpose:
#   Exercise the cross-OS foundation helpers (OS detection + credential store)
#   for both the Bash and Node (ESM) implementations without requiring bats or
#   any other test framework. This is a smoke suite: it verifies the happy
#   path, basic contracts, and parity between the two implementations.
#
# How to run:
#   From the repo root:
#     bash tests/lib/smoke.sh
#
# What it covers:
#   - lib/os-detect.sh       : sourced export surface + JSON output
#   - lib/os-detect.mjs      : Node equivalent, JSON output
#   - parity                 : .os field matches across both
#   - lib/credential-store.sh: backends list + plaintext + enc-json roundtrips,
#                              best-effort native keyring roundtrip
#   - lib/credential-store.mjs: CLI surface (backends)
#
# Isolation:
#   XDG_DATA_HOME is redirected to a per-run temp dir and removed on exit so
#   the host's real secrets.json is never touched. No network access required.
#
# Exit: 0 if no FAIL, non-zero otherwise. SKIPs do not fail the suite.
# =============================================================================

set -euo pipefail

# ---- locate repo root (realpath with readlink -f fallback) -------------------
_resolve() {
  if command -v realpath >/dev/null 2>&1; then
    realpath "$1"
  else
    readlink -f "$1"
  fi
}
SCRIPT_PATH="$(_resolve "${BASH_SOURCE[0]}")"
REPO_ROOT="$(cd "$(dirname "$SCRIPT_PATH")/../.." && pwd)"

# ---- isolated environment ----------------------------------------------------
XDG_DATA_HOME="$(mktemp -d)"
export XDG_DATA_HOME
TMP_WORK="$(mktemp -d)"
trap 'rm -rf "$XDG_DATA_HOME" "$TMP_WORK"' EXIT

# ---- counters / reporting ----------------------------------------------------
PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); }
fail() { printf 'FAIL: %s -- %s\n' "$1" "$2"; FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); }
skip() { printf 'SKIP: %s -- %s\n' "$1" "$2"; SKIP=$((SKIP+1)); TOTAL=$((TOTAL+1)); }

have() { command -v "$1" >/dev/null 2>&1; }

# ---- test helpers ------------------------------------------------------------
VALID_OS_RE='^(macos|debian|fedora|arch|suse|alpine|linux|wsl|windows|freebsd|openbsd|netbsd|unknown)$'

rand_suffix() {
  # portable-ish random suffix: pid + nanoseconds-or-seconds
  local n
  n="$(date +%N 2>/dev/null || date +%s)"
  printf '%s-%s' "$$" "${n:-0}"
}

# ---- individual tests --------------------------------------------------------

test_os_detect_sh() {
  local name="test_os_detect_sh"
  # shellcheck disable=SC1091
  if ! source "$REPO_ROOT/lib/os-detect.sh" 2>/tmp/os-detect-sh.err; then
    fail "$name" "sourcing lib/os-detect.sh failed: $(cat /tmp/os-detect-sh.err)"
    return
  fi
  local os arch json
  os="$(ops_os || true)"
  arch="$(ops_arch || true)"
  json="$(ops_os_json || true)"
  if ! [[ "$os" =~ $VALID_OS_RE ]]; then
    fail "$name" "ops_os returned unexpected value: '$os'"; return
  fi
  if [[ -z "$arch" ]]; then
    fail "$name" "ops_arch was empty"; return
  fi
  if ! printf '%s' "$json" | grep -q '"os":'; then
    fail "$name" "ops_os_json missing \"os\" key"; return
  fi
  if have jq && ! printf '%s' "$json" | jq . >/dev/null 2>&1; then
    fail "$name" "ops_os_json is not valid JSON"; return
  fi
  pass "$name"
}

test_os_detect_mjs() {
  local name="test_os_detect_mjs"
  if ! have node; then skip "$name" "node not installed"; return; fi
  local out
  if ! out="$(node "$REPO_ROOT/lib/os-detect.mjs" 2>/dev/null)"; then
    fail "$name" "node lib/os-detect.mjs exited non-zero"; return
  fi
  case "$out" in
    '{'*) ;;
    *) fail "$name" "stdout does not start with '{'"; return ;;
  esac
  if ! printf '%s' "$out" | grep -q '"os"'; then
    fail "$name" "stdout missing \"os\" key"; return
  fi
  pass "$name"
}

test_os_detect_parity() {
  local name="test_os_detect_parity"
  if ! have jq; then skip "$name" "jq not installed"; return; fi
  if ! have node; then skip "$name" "node not installed"; return; fi
  local sh_os mjs_os
  # shellcheck disable=SC1091
  source "$REPO_ROOT/lib/os-detect.sh"
  sh_os="$(ops_os_json | jq -r .os 2>/dev/null || true)"
  mjs_os="$(node "$REPO_ROOT/lib/os-detect.mjs" 2>/dev/null | jq -r .os 2>/dev/null || true)"
  if [[ -z "$sh_os" || -z "$mjs_os" ]]; then
    fail "$name" "could not extract .os (sh='$sh_os', mjs='$mjs_os')"; return
  fi
  if [[ "$sh_os" != "$mjs_os" ]]; then
    fail "$name" "parity mismatch: sh='$sh_os' mjs='$mjs_os'"; return
  fi
  pass "$name"
}

test_credential_backends_available() {
  local name="test_credential_backends_available"
  local out
  if ! out="$(bash "$REPO_ROOT/lib/credential-store.sh" backends 2>/dev/null)"; then
    fail "$name" "credential-store.sh backends exited non-zero"; return
  fi
  if [[ -z "${out//[[:space:]]/}" ]]; then
    fail "$name" "no backends printed"; return
  fi
  if ! printf '%s' "$out" | grep -q 'plaintext-json'; then
    fail "$name" "plaintext-json fallback missing from backends list"; return
  fi
  pass "$name"
}

_roundtrip() {
  # _roundtrip <test-name> <backend> [extra-env-assignment]
  local name="$1" backend="$2" extra_env="${3:-}"
  local svc="claude-ops-test" acct="smoke-$(rand_suffix)"
  local secret="s3cr3t-$(rand_suffix)"
  local store="$REPO_ROOT/lib/credential-store.sh"
  local env_prefix="CLAUDE_OPS_CRED_BACKEND=$backend"
  [[ -n "$extra_env" ]] && env_prefix="$env_prefix $extra_env"

  if ! eval "$env_prefix bash \"$store\" set \"$svc\" \"$acct\" \"$secret\"" \
       >/dev/null 2>"$TMP_WORK/err"; then
    fail "$name" "set failed: $(cat "$TMP_WORK/err")"; return
  fi
  local got
  if ! got="$(eval "$env_prefix bash \"$store\" get \"$svc\" \"$acct\"" 2>"$TMP_WORK/err")"; then
    fail "$name" "get failed: $(cat "$TMP_WORK/err")"; return
  fi
  if [[ "$got" != "$secret" ]]; then
    fail "$name" "roundtrip mismatch: expected '$secret' got '$got'"; return
  fi
  if ! eval "$env_prefix bash \"$store\" delete \"$svc\" \"$acct\"" \
       >/dev/null 2>"$TMP_WORK/err"; then
    fail "$name" "delete failed: $(cat "$TMP_WORK/err")"; return
  fi
  pass "$name"
}

test_credential_roundtrip_plaintext() {
  _roundtrip "test_credential_roundtrip_plaintext" "plaintext-json"
}

test_credential_roundtrip_encjson() {
  _roundtrip "test_credential_roundtrip_encjson" "enc-json" "CLAUDE_OPS_MASTER_KEY=test-key-$$"
}

test_credential_native_if_available() {
  local name="test_credential_native_if_available"
  # shellcheck disable=SC1091
  source "$REPO_ROOT/lib/os-detect.sh" 2>/dev/null || true
  local backend
  backend="$(ops_keyring_backend 2>/dev/null || true)"
  if [[ -z "$backend" || "$backend" == "none" ]]; then
    skip "$name" "no native keyring backend on this host"; return
  fi
  local svc="claude-ops-test" acct="smoke-native-$(rand_suffix)"
  local secret="native-$(rand_suffix)"
  local store="$REPO_ROOT/lib/credential-store.sh"
  if ! CLAUDE_OPS_CRED_BACKEND="$backend" bash "$store" set "$svc" "$acct" "$secret" \
       >/dev/null 2>"$TMP_WORK/err"; then
    skip "$name" "native backend '$backend' unavailable/locked on CI: $(cat "$TMP_WORK/err")"; return
  fi
  local got
  if ! got="$(CLAUDE_OPS_CRED_BACKEND="$backend" bash "$store" get "$svc" "$acct" 2>"$TMP_WORK/err")"; then
    CLAUDE_OPS_CRED_BACKEND="$backend" bash "$store" delete "$svc" "$acct" >/dev/null 2>&1 || true
    skip "$name" "native get failed (likely locked keyring): $(cat "$TMP_WORK/err")"; return
  fi
  CLAUDE_OPS_CRED_BACKEND="$backend" bash "$store" delete "$svc" "$acct" >/dev/null 2>&1 || true
  if [[ "$got" != "$secret" ]]; then
    fail "$name" "native roundtrip mismatch: expected '$secret' got '$got'"; return
  fi
  pass "$name"
}

test_credential_mjs_cli() {
  local name="test_credential_mjs_cli"
  if ! have node; then skip "$name" "node not installed"; return; fi
  local out
  if ! out="$(node "$REPO_ROOT/lib/credential-store.mjs" backends 2>/dev/null)"; then
    fail "$name" "node credential-store.mjs backends exited non-zero"; return
  fi
  if [[ -z "${out//[[:space:]]/}" ]]; then
    fail "$name" "mjs backends output is empty"; return
  fi
  pass "$name"
}

# ---- run ---------------------------------------------------------------------
printf '# claude-ops smoke suite (XDG_DATA_HOME=%s)\n' "$XDG_DATA_HOME"

test_os_detect_sh
test_os_detect_mjs
test_os_detect_parity
test_credential_backends_available
test_credential_roundtrip_plaintext
test_credential_roundtrip_encjson
test_credential_native_if_available
test_credential_mjs_cli

printf '\n# %d PASSED / %d TOTAL (skipped: %d, failed: %d)\n' \
  "$PASS" "$TOTAL" "$SKIP" "$FAIL"

[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
