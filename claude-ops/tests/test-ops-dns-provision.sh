#!/usr/bin/env bash
# test-ops-dns-provision.sh — Dry-run shape assertions for bin/ops-dns-provision.
#
# Strategy: invoke each subcommand with OPS_DRY_RUN=1 and assert that the
# planned API calls (logged to stderr by the lib + bin) include the
# expected endpoint + verb + payload markers.

# shellcheck disable=SC2015  # `ok` always returns 0, so && A || B is safe
set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$PLUGIN_ROOT/bin/ops-dns-provision"

pass=0
fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1"; fail=$((fail+1)); }

if [[ ! -x "$BIN" ]]; then
  echo "FAIL: bin not executable at $BIN"
  exit 1
fi

# Common env for every subcommand under test.
export OPS_DRY_RUN=1
export CLOUDFLARE_API_TOKEN="test-token-fixture"
export PREFS_PATH=/dev/null

run_capture() {
  # Echo combined stdout+stderr of subcommand.
  "$BIN" "$@" 2>&1 || true
}

assert_contains() {
  local needle="$1" haystack="$2" desc="$3"
  if printf '%s' "$haystack" | grep -q -- "$needle"; then
    ok "$desc"
  else
    err "$desc — missing: $needle"
    printf 'HAYSTACK:\n%s\n' "$haystack" | head -20
  fi
}

# --- help ---------------------------------------------------------------------
echo "Testing --help"
help_out="$(run_capture --help)"
assert_contains "SUBCOMMANDS"     "$help_out" "help lists subcommands"
assert_contains "provision-all"   "$help_out" "help lists provision-all"
assert_contains "OPS_DRY_RUN"     "$help_out" "help documents OPS_DRY_RUN"

# --- gsc ----------------------------------------------------------------------
echo "Testing gsc dry-run"
out="$(run_capture gsc myproj example.com)"
assert_contains "POST https://www.googleapis.com/siteVerification/v1/token" "$out" "gsc plans token POST"
assert_contains "GET https://api.cloudflare.com/client/v4/zones?name=example.com" "$out" "gsc looks up zone"
assert_contains "PUT|POST" "$out" "gsc plans TXT upsert"
assert_contains "\"name\":\"example.com\"" "$out" "gsc TXT at apex"

# --- meta-aem -----------------------------------------------------------------
echo "Testing meta-aem dry-run"
out="$(run_capture meta-aem myproj example.com)"
assert_contains "GET https://graph.facebook.com/v19.0/me/owned_domains" "$out" "meta-aem plans owned_domains GET"
assert_contains "facebook-domain-verification=" "$out" "meta-aem TXT content has fb prefix"

# --- apple-pay (static-file default) -----------------------------------------
echo "Testing apple-pay static-file mode"
out="$(run_capture apple-pay myproj example.com)"
assert_contains ".well-known/apple-developer-merchantid-domain-association" "$out" "apple-pay surfaces association path"
assert_contains "static-file" "$out" "apple-pay uses static-file default mode"

# --- spf ----------------------------------------------------------------------
echo "Testing spf dry-run"
out="$(run_capture spf myproj example.com)"
assert_contains "v=spf1 include:_spf.resend.com include:_spf.klaviyo.com -all" "$out" "spf default content"
assert_contains "marker=v=spf1" "$out" "spf uses safe-merge marker"

# --- dkim (resend default) ----------------------------------------------------
echo "Testing dkim dry-run"
out="$(run_capture dkim myproj example.com)"
assert_contains "POST https://api.resend.com/domains" "$out" "dkim plans resend POST"

# --- dmarc --------------------------------------------------------------------
echo "Testing dmarc dry-run"
out="$(run_capture dmarc myproj example.com)"
assert_contains "v=DMARC1; p=quarantine" "$out" "dmarc default policy=quarantine"
assert_contains "rua=mailto:dmarc@example.com" "$out" "dmarc default rua"
assert_contains "_dmarc.example.com" "$out" "dmarc record at _dmarc."

# --- mx (google-workspace default) -------------------------------------------
echo "Testing mx dry-run"
out="$(run_capture mx myproj example.com)"
assert_contains "MX upsert at example.com priority=1 target=smtp.google.com" "$out" "mx defaults to google-workspace"

# --- klaviyo-sending ---------------------------------------------------------
echo "Testing klaviyo-sending dry-run"
out="$(run_capture klaviyo-sending myproj example.com)"
assert_contains "POST https://a.klaviyo.com/api/dedicated-sending-domains/" "$out" "klaviyo-sending plans POST"
assert_contains "em.example.com" "$out" "klaviyo-sending defaults to em.<apex>"

# --- provision-all sequencing ------------------------------------------------
echo "Testing provision-all"
# provision-all needs a domain in prefs; create a temp prefs file with one.
TMP_PREFS="$(mktemp)"
trap 'rm -f "$TMP_PREFS"' EXIT
cat > "$TMP_PREFS" <<'EOF'
{
  "marketing": {
    "projects": {
      "myproj": {
        "domain": "example.com"
      }
    }
  }
}
EOF
PREFS_PATH="$TMP_PREFS" out="$(PREFS_PATH="$TMP_PREFS" run_capture provision-all myproj --skip dkim,klaviyo-sending)"
assert_contains "provision-all: row=spf"       "$out" "provision-all runs spf"
assert_contains "provision-all: row=dmarc"     "$out" "provision-all runs dmarc"
assert_contains "provision-all: row=mx"        "$out" "provision-all runs mx"
assert_contains "provision-all: row=gsc"       "$out" "provision-all runs gsc"
assert_contains "provision-all: skipping dkim" "$out" "provision-all honors --skip"
assert_contains "provision-all: skipping klaviyo-sending" "$out" "provision-all honors --skip multi"

# --- unknown subcommand ------------------------------------------------------
echo "Testing unknown subcommand"
set +e
"$BIN" frobnicate myproj 2>/dev/null
rc=$?
set -e
[[ "$rc" = "2" ]] && ok "unknown subcommand exits 2" || err "unknown subcommand exit=$rc"

# --- missing required args ---------------------------------------------------
echo "Testing missing args"
set +e
"$BIN" dmarc 2>/dev/null
rc=$?
set -e
[[ "$rc" = "2" ]] && ok "missing args exits 2" || err "missing args exit=$rc"

echo ""
echo "test-ops-dns-provision.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
