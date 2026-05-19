#!/usr/bin/env bash
# test-multi-sink-notify.sh — assert all configured notify sinks fire on ESCALATED=1
#
# Strategy: extract the notify() function, stub HTTP sinks (curl shim writes to
# per-sink sentinel files), drive with ESCALATED=1, assert each sentinel exists.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$PLUGIN_ROOT/bin/ops-marketing-autopilot"

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

echo "Testing multi-sink notify() in $BIN"
echo ""

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

TODAY="$(date +%Y-%m-%d)"

# Preferences with all four sink types configured
cat > "$WORK/prefs.json" <<JSON
{
  "marketing": {
    "notify": {
      "sinks": [
        {"type": "telegram", "ref": "env:_TEST_TG_TOKEN", "chat_ref": "env:_TEST_TG_CHAT"},
        {"type": "slack",    "ref": "env:_TEST_SLACK_URL"},
        {"type": "email",    "ref": "env:_TEST_RESEND_KEY", "to": "owner@example.com", "from": "autopilot@example.com"},
        {"type": "whatsapp", "to": "+1234567890"}
      ]
    },
    "projects": {
      "test-proj": {
        "autopilot": {
          "enabled": true,
          "daily_spend_cap_usd": 50
        }
      }
    }
  }
}
JSON

# Stub environment values for sinks
export _TEST_TG_TOKEN="tg-bot-token"
export _TEST_TG_CHAT="tg-chat-id"
export _TEST_SLACK_URL="https://hooks.slack.example.com/test"
export _TEST_RESEND_KEY="re_testkey"

# Build a curl shim that writes sentinel files keyed by URL pattern
CURL_SHIM="$WORK/curl"
cat > "$CURL_SHIM" <<SH
#!/usr/bin/env bash
# Parse the URL from args to identify which sink fired
url=""
for arg in "\$@"; do
  case "\$arg" in
    https://api.telegram.org/*) printf '1' > "$WORK/sink_telegram" ;;
    https://hooks.slack.example.com/*) printf '1' > "$WORK/sink_slack" ;;
    https://api.resend.com/*) printf '1' > "$WORK/sink_email" ;;
  esac
done
exit 0
SH
chmod +x "$CURL_SHIM"

# wacli shim to detect whatsapp sink
WACLI_SHIM="$WORK/wacli"
cat > "$WACLI_SHIM" <<SH
#!/usr/bin/env bash
printf '1' > "$WORK/sink_whatsapp"
exit 0
SH
chmod +x "$WACLI_SHIM"

# Build harness that sources only the notify() function
HARNESS="$WORK/harness.sh"
{
  echo '#!/usr/bin/env bash'
  echo 'set -uo pipefail'
  echo "PREFS=\"$WORK/prefs.json\""
  echo "TODAY=\"$TODAY\""
  echo 'MUTATIONS=3'
  echo 'ESCALATED=1'
  echo 'REPORT="/dev/null"'
  echo 'log() { :; }'
  echo 'resolve_cred() { local r="${1:-}"; case "$r" in env:*) local v="${r#env:}"; printf "%s" "${!v:-}" ;; *) printf "%s" "$r" ;; esac; }'
  echo 'ap_get() { :; }'
  # Extract notify() from binary
  awk '/^notify\(\)/{p=1} p{print} p && /^}$/{p=0; exit}' "$BIN"
  echo ''
  echo "notify 'test-proj'"
} > "$HARNESS"
chmod +x "$HARNESS"

# Run with PATH shimmed
env \
  PATH="$WORK:$PATH" \
  _TEST_TG_TOKEN="tg-bot-token" \
  _TEST_TG_CHAT="tg-chat-id" \
  _TEST_SLACK_URL="https://hooks.slack.example.com/test" \
  _TEST_RESEND_KEY="re_testkey" \
  bash "$HARNESS" 2>/dev/null || true

# Assert sentinels
if [ -f "$WORK/sink_telegram" ]; then
  ok "telegram sink fired on ESCALATED=1"
else
  err "telegram sink NOT fired" "sentinel file missing"
fi

if [ -f "$WORK/sink_slack" ]; then
  ok "slack sink fired on ESCALATED=1"
else
  err "slack sink NOT fired" "sentinel file missing"
fi

if [ -f "$WORK/sink_email" ]; then
  ok "email (Resend) sink fired on ESCALATED=1"
else
  err "email (Resend) sink NOT fired" "sentinel file missing"
fi

if [ -f "$WORK/sink_whatsapp" ]; then
  ok "whatsapp sink fired on ESCALATED=1"
else
  err "whatsapp sink NOT fired" "sentinel file missing"
fi

# ── Test legacy fallback: per-project notify_sink=telegram still fires ─────────
cat > "$WORK/prefs_legacy.json" <<JSON
{
  "marketing": {
    "projects": {
      "legacy-proj": {
        "autopilot": {
          "enabled": true,
          "daily_spend_cap_usd": 50,
          "notify_sink": "telegram"
        }
      }
    }
  }
}
JSON
rm -f "$WORK/sink_telegram"

HARNESS2="$WORK/harness_legacy.sh"
{
  echo '#!/usr/bin/env bash'
  echo 'set -uo pipefail'
  echo "PREFS=\"$WORK/prefs_legacy.json\""
  echo "TODAY=\"$TODAY\""
  echo 'MUTATIONS=1'
  echo 'ESCALATED=1'
  echo 'REPORT="/dev/null"'
  echo 'log() { :; }'
  echo 'resolve_cred() { local r="${1:-}"; case "$r" in env:*) local v="${r#env:}"; printf "%s" "${!v:-}" ;; *) printf "%s" "$r" ;; esac; }'
  echo 'ap_get() { local p="$1" q="$2"; jq -r --arg pp "$p" ".marketing.projects[\$pp].autopilot${q} // empty" "$PREFS" 2>/dev/null; }'
  awk '/^notify\(\)/{p=1} p{print} p && /^}$/{p=0; exit}' "$BIN"
  echo ''
  echo "notify 'legacy-proj'"
} > "$HARNESS2"
chmod +x "$HARNESS2"

env \
  PATH="$WORK:$PATH" \
  TELEGRAM_BOT_TOKEN="tg-bot-token" \
  TELEGRAM_CHAT_ID="tg-chat-id" \
  bash "$HARNESS2" 2>/dev/null || true

if [ -f "$WORK/sink_telegram" ]; then
  ok "legacy notify_sink=telegram fallback fires"
else
  err "legacy notify_sink=telegram fallback NOT fired" "sentinel file missing"
fi

echo ""
echo "Results: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
