#!/usr/bin/env bash
# test-cloudflare-dns-lib.sh — Unit tests for scripts/lib/cloudflare-dns.sh
#
# Strategy: source the lib, override `curl` with a mock that returns
# canned fixtures, exercise cf_apex_for / cf_zone_id / cf_record_get
# / cf_record_upsert / cf_txt_upsert_safe.

# shellcheck disable=SC2015  # `ok` always returns 0, so && A || B is safe
# shellcheck disable=SC1091  # sourced lib path is relative to plugin root
set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$PLUGIN_ROOT/scripts/lib/cloudflare-dns.sh"

pass=0
fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1"; fail=$((fail+1)); }

if [[ ! -f "$LIB" ]]; then
  echo "FAIL: lib not found at $LIB"
  exit 1
fi

# Mock state.
MOCK_DIR="$(mktemp -d)"
trap 'rm -rf "$MOCK_DIR"' EXIT
MOCK_RESPONSES="$MOCK_DIR/responses"
MOCK_CALLS="$MOCK_DIR/calls"
: > "$MOCK_CALLS"

# curl mock: pops the next response from $MOCK_RESPONSES (responses are
# separated by a literal "---END---" line so multi-line bodies survive),
# logs args to $MOCK_CALLS.
curl() {
  printf '%s\n' "$*" >> "$MOCK_CALLS"
  if [[ ! -s "$MOCK_RESPONSES" ]]; then
    echo '{}'
    return 0
  fi
  awk 'BEGIN{p=1} /^---END---$/{p=0; next} p{print}' "$MOCK_RESPONSES"
  awk 'BEGIN{p=0} /^---END---$/{p=1; next} p{print}' "$MOCK_RESPONSES" > "$MOCK_RESPONSES.tail"
  mv "$MOCK_RESPONSES.tail" "$MOCK_RESPONSES"
}
export -f curl 2>/dev/null || true

# Source under bash test harness.
export CLOUDFLARE_API_TOKEN="test-token-fixture"
export OPS_DRY_RUN=0
# shellcheck source=../scripts/lib/cloudflare-dns.sh
. "$LIB"

# --- cf_apex_for --------------------------------------------------------------
echo "Testing cf_apex_for"
[[ "$(cf_apex_for example.com)"        = "example.com" ]]      && ok "apex of example.com" || err "apex of example.com -> $(cf_apex_for example.com)"
[[ "$(cf_apex_for api.example.com)"    = "example.com" ]]      && ok "apex of api.example.com" || err "apex of api.example.com -> $(cf_apex_for api.example.com)"
[[ "$(cf_apex_for foo.bar.example.com)" = "example.com" ]]     && ok "apex of foo.bar.example.com" || err "apex of foo.bar.example.com -> $(cf_apex_for foo.bar.example.com)"
[[ "$(cf_apex_for example.co.uk)"      = "example.co.uk" ]]    && ok "apex of example.co.uk" || err "apex of example.co.uk -> $(cf_apex_for example.co.uk)"
[[ "$(cf_apex_for api.example.co.uk)"  = "example.co.uk" ]]    && ok "apex of api.example.co.uk" || err "apex of api.example.co.uk -> $(cf_apex_for api.example.co.uk)"
[[ "$(cf_apex_for https://api.example.com/path)" = "example.com" ]] && ok "apex strips proto+path" || err "apex strips proto+path -> $(cf_apex_for https://api.example.com/path)"
[[ "$(cf_apex_for EXAMPLE.COM)"        = "example.com" ]]      && ok "apex is lowercased" || err "apex lowercased -> $(cf_apex_for EXAMPLE.COM)"

# Helper: write a single response (single fixture, terminated).
write_resp_single() {
  printf '%s\n---END---\n' "$1" > "$MOCK_RESPONSES"
}
# Helper: append additional response.
append_resp() {
  printf '%s\n---END---\n' "$1" >> "$MOCK_RESPONSES"
}

# --- cf_zone_id (mocked) ------------------------------------------------------
echo "Testing cf_zone_id"
write_resp_single '{"result":[{"id":"zone-abc123","name":"example.com"}]}'
zone_id="$(cf_zone_id "example.com")"
[[ "$zone_id" = "zone-abc123" ]] && ok "cf_zone_id parses id" || err "cf_zone_id parses id -> $zone_id"
grep -q "zones?name=example.com" "$MOCK_CALLS" && ok "cf_zone_id called correct endpoint" || err "cf_zone_id endpoint missing"

# Empty result.
: > "$MOCK_CALLS"
write_resp_single '{"result":[]}'
zone_id="$(cf_zone_id "missing.example")"
[[ -z "$zone_id" ]] && ok "cf_zone_id empty on miss" || err "cf_zone_id empty on miss -> $zone_id"

# --- cf_record_get ------------------------------------------------------------
echo "Testing cf_record_get"
: > "$MOCK_CALLS"
write_resp_single '{"result":[{"id":"rec-1","type":"TXT","name":"example.com","content":"v=spf1 -all"}]}'
rec="$(cf_record_get "zone-abc123" "TXT" "example.com")"
[[ -n "$rec" ]] && [[ "$(printf '%s' "$rec" | jq -r '.id')" = "rec-1" ]] \
  && ok "cf_record_get parses match" || err "cf_record_get parses match -> $rec"

# --- cf_record_upsert: no-op when content matches ----------------------------
echo "Testing cf_record_upsert no-op"
: > "$MOCK_CALLS"
write_resp_single '{"result":[{"id":"rec-1","type":"TXT","name":"example.com","content":"v=spf1 -all"}]}'
upsert_id="$(cf_record_upsert "zone-abc" "TXT" "example.com" "v=spf1 -all" 120)"
[[ "$upsert_id" = "rec-1" ]] && ok "upsert no-op returns existing id" || err "upsert no-op id -> $upsert_id"
# Should only have made 1 call (the GET), no PUT/POST.
call_count="$(wc -l < "$MOCK_CALLS" | tr -d ' ')"
[[ "$call_count" = "1" ]] && ok "upsert no-op makes 1 call" || err "upsert no-op made $call_count calls"

# --- cf_record_upsert: PUT existing ------------------------------------------
echo "Testing cf_record_upsert PUT path"
: > "$MOCK_CALLS"
# GET response + PUT response (PUT response includes trailing http code line
# because the lib uses -w '\n%{http_code}').
write_resp_single '{"result":[{"id":"rec-1","type":"TXT","name":"example.com","content":"OLD"}]}'
append_resp '{"success":true,"result":{"id":"rec-1"}}
200'
upsert_id="$(cf_record_upsert "zone-abc" "TXT" "example.com" "NEW" 120)"
[[ "$upsert_id" = "rec-1" ]] && ok "upsert PUT returns id" || err "upsert PUT id -> $upsert_id"
grep -q -- "-X PUT" "$MOCK_CALLS" && ok "upsert PUT uses PUT verb" || err "upsert PUT verb missing"

# --- cf_record_upsert: POST new ----------------------------------------------
echo "Testing cf_record_upsert POST path"
: > "$MOCK_CALLS"
write_resp_single '{"result":[]}'
append_resp '{"success":true,"result":{"id":"rec-new"}}
201'
upsert_id="$(cf_record_upsert "zone-abc" "TXT" "new.example.com" "value" 120)"
[[ "$upsert_id" = "rec-new" ]] && ok "upsert POST returns new id" || err "upsert POST id -> $upsert_id"
grep -q -- "-X POST" "$MOCK_CALLS" && ok "upsert POST uses POST verb" || err "upsert POST verb missing"

# --- cf_txt_upsert_safe: foreign value rejection ------------------------------
echo "Testing cf_txt_upsert_safe foreign-value guard"
: > "$MOCK_CALLS"
write_resp_single '{"result":[{"id":"rec-foreign","type":"TXT","name":"example.com","content":"some-other-txt"}]}'
set +e
cf_txt_upsert_safe "zone-abc" "example.com" "v=spf1 include:_spf.resend.com -all" "v=spf1" >/dev/null 2>&1
rc=$?
set -e
[[ "$rc" = "3" ]] && ok "safe-upsert refuses foreign TXT (exit 3)" || err "safe-upsert foreign rejection -> exit=$rc"

# --- OPS_DRY_RUN ---------------------------------------------------------------
echo "Testing OPS_DRY_RUN"
OPS_DRY_RUN=1
: > "$MOCK_CALLS"
zone_id="$(cf_zone_id "example.com")"
[[ "$zone_id" = "dryrun-zone-id" ]] && ok "dry-run returns synthetic zone id" || err "dry-run zone -> $zone_id"
upsert_id="$(cf_record_upsert "zone-x" "TXT" "_dmarc.example.com" "v=DMARC1" 3600)"
[[ "$upsert_id" = "dryrun-record-id" ]] && ok "dry-run returns synthetic record id" || err "dry-run record -> $upsert_id"
# No real curl calls in dry-run path.
[[ ! -s "$MOCK_CALLS" ]] && ok "dry-run fires no curl calls" || err "dry-run hit curl: $(cat "$MOCK_CALLS")"
OPS_DRY_RUN=0

# --- Summary ------------------------------------------------------------------
echo ""
echo "test-cloudflare-dns-lib.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
