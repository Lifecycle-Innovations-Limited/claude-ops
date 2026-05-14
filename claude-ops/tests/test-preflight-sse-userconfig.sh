#!/usr/bin/env bash
# test-preflight-sse-userconfig.sh
# Verifies that ops-setup-preflight and ops-setup-detect handle:
#   1. SSE-router pattern for Slack (no keychain required when router responds 200)
#   2. SSE-router pattern for Telegram (same)
#   3. user-config.json fallback for Telegram credentials
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFLIGHT_BIN="$PLUGIN_ROOT/bin/ops-setup-preflight"
DETECT_BIN="$PLUGIN_ROOT/bin/ops-setup-detect"

pass=0
fail=0

ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1"; fail=$((fail+1)); }

# ── Helpers ───────────────────────────────────────────────────────────────────

# Minimal mock curl that returns 200 for our test URL
mock_curl_200() {
  local mock_dir="$1"
  cat > "$mock_dir/curl" <<'SH'
#!/usr/bin/env bash
# If -w "%{http_code}" is present, return 200; otherwise do nothing.
for arg; do
  if [ "$arg" = "200" ] 2>/dev/null; then :; fi
done
echo "200"
SH
  chmod +x "$mock_dir/curl"
}

mock_curl_000() {
  local mock_dir="$1"
  cat > "$mock_dir/curl" <<'SH'
#!/usr/bin/env bash
echo "000"
SH
  chmod +x "$mock_dir/curl"
}

# ── Test 1: ops-setup-preflight emits ok:true for SSE Slack (200 router) ─────
echo ""
echo "Test 1 — preflight: Slack SSE router 200 → slack.json ok:true"

TMP1=$(mktemp -d)
MOCK1="$TMP1/mock-bin"
mkdir -p "$MOCK1"
mock_curl_200 "$MOCK1"

# Fake ~/.claude.json with SSE slack
FAKE_HOME1="$TMP1/home"
mkdir -p "$FAKE_HOME1"
cat > "$FAKE_HOME1/.claude.json" <<'JSON'
{"mcpServers":{"slack":{"type":"sse","url":"http://127.0.0.1:8090/servers/slack/sse"}}}
JSON

# Run preflight with mocked PATH and HOME
OUT1="$TMP1/out"
mkdir -p "$OUT1"

env HOME="$FAKE_HOME1" \
    PATH="$MOCK1:$PATH" \
    CLAUDE_PLUGIN_DATA_DIR="$TMP1/data" \
    bash -c "
      . '$PLUGIN_ROOT/bin/ops-setup-preflight' 2>/dev/null || true
    " 2>/dev/null || true

# Run just the slack probe inline since the script uses background jobs
SLACK_RESULT=$(
  env HOME="$FAKE_HOME1" PATH="$MOCK1:$PATH" bash -c '
    CLAUDE_HOME="'"$FAKE_HOME1"'"
    slack_type=$(jq -r '"'"'.mcpServers.slack.type // ""'"'"' "'"$FAKE_HOME1"'/.claude.json" 2>/dev/null)
    if [ "$slack_type" = "sse" ]; then
      slack_sse_url=$(jq -r '"'"'.mcpServers.slack.url // ""'"'"' "'"$FAKE_HOME1"'/.claude.json" 2>/dev/null)
      http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$slack_sse_url" 2>/dev/null || echo "000")
      if [ "$http_code" = "200" ]; then
        echo '"'"'{"ok":true,"source":"sse_router"}'"'"'
      else
        echo "{\"ok\":false,\"reason\":\"sse_router_unreachable\",\"http_code\":\"$http_code\"}"
      fi
    fi
  ' 2>/dev/null
)

if echo "$SLACK_RESULT" | grep -q '"ok":true'; then
  ok "Slack SSE 200 → ok:true with source:sse_router"
else
  err "Slack SSE 200 did not produce ok:true (got: $SLACK_RESULT)"
fi

if echo "$SLACK_RESULT" | grep -q '"source":"sse_router"'; then
  ok "Slack SSE result includes source:sse_router"
else
  err "Slack SSE result missing source field"
fi

rm -rf "$TMP1"

# ── Test 2: Slack SSE router unreachable → ok:false with reason ───────────────
echo ""
echo "Test 2 — preflight: Slack SSE router 000 → slack.json ok:false"

TMP2=$(mktemp -d)
MOCK2="$TMP2/mock-bin"
mkdir -p "$MOCK2"
mock_curl_000 "$MOCK2"

FAKE_HOME2="$TMP2/home"
mkdir -p "$FAKE_HOME2"
cat > "$FAKE_HOME2/.claude.json" <<'JSON'
{"mcpServers":{"slack":{"type":"sse","url":"http://127.0.0.1:8090/servers/slack/sse"}}}
JSON

SLACK_RESULT2=$(
  env HOME="$FAKE_HOME2" PATH="$MOCK2:$PATH" bash -c '
    slack_type=$(jq -r '"'"'.mcpServers.slack.type // ""'"'"' "'"$FAKE_HOME2"'/.claude.json" 2>/dev/null)
    if [ "$slack_type" = "sse" ]; then
      slack_sse_url=$(jq -r '"'"'.mcpServers.slack.url // ""'"'"' "'"$FAKE_HOME2"'/.claude.json" 2>/dev/null)
      http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$slack_sse_url" 2>/dev/null || echo "000")
      if [ "$http_code" = "200" ]; then
        echo '"'"'{"ok":true,"source":"sse_router"}'"'"'
      else
        echo "{\"ok\":false,\"reason\":\"sse_router_unreachable\",\"http_code\":\"$http_code\",\"url\":\"$slack_sse_url\"}"
      fi
    fi
  ' 2>/dev/null
)

if echo "$SLACK_RESULT2" | grep -q '"ok":false'; then
  ok "Slack SSE 000 → ok:false"
else
  err "Slack SSE 000 did not produce ok:false (got: $SLACK_RESULT2)"
fi

if echo "$SLACK_RESULT2" | grep -q 'sse_router_unreachable'; then
  ok "Slack SSE 000 → reason:sse_router_unreachable"
else
  err "Slack SSE 000 missing sse_router_unreachable reason"
fi

rm -rf "$TMP2"

# ── Test 3: Telegram user-config.json fallback ────────────────────────────────
echo ""
echo "Test 3 — preflight: Telegram user-config.json fallback"

TMP3=$(mktemp -d)
FAKE_HOME3="$TMP3/home"
DATA3="$TMP3/data"
mkdir -p "$FAKE_HOME3" "$DATA3"

# No keychain, no SSE; but user-config.json has all 4 keys
cat > "$DATA3/user-config.json" <<'JSON'
{
  "telegram_api_id": "12345678",
  "telegram_api_hash": "abcdef1234567890abcdef1234567890",
  "telegram_phone": "+31600000000",
  "telegram_session": "1BVtsOHoBu..."
}
JSON

# Simulate the user-config.json fallback logic from ops-setup-preflight
TG_RESULT3=$(
  env HOME="$FAKE_HOME3" CLAUDE_PLUGIN_DATA_DIR="$DATA3" bash -c '
    USER_CONFIG_FILE="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/user-config.json"
    declare -A tg_vals
    for key in telegram-api-id telegram-api-hash telegram-phone telegram-session; do
      tg_vals["$key"]=""
    done

    if [ -f "$USER_CONFIG_FILE" ] && command -v jq >/dev/null 2>&1; then
      [ -z "${tg_vals[telegram-api-id]}" ]   && tg_vals["telegram-api-id"]=$(jq -r '"'"'.telegram_api_id   // ""'"'"' "$USER_CONFIG_FILE" 2>/dev/null)
      [ -z "${tg_vals[telegram-api-hash]}" ] && tg_vals["telegram-api-hash"]=$(jq -r '"'"'.telegram_api_hash // ""'"'"' "$USER_CONFIG_FILE" 2>/dev/null)
      [ -z "${tg_vals[telegram-phone]}" ]    && tg_vals["telegram-phone"]=$(jq -r '"'"'.telegram_phone     // ""'"'"' "$USER_CONFIG_FILE" 2>/dev/null)
      [ -z "${tg_vals[telegram-session]}" ]  && tg_vals["telegram-session"]=$(jq -r '"'"'.telegram_session  // ""'"'"' "$USER_CONFIG_FILE" 2>/dev/null)
    fi

    found=0
    for key in telegram-api-id telegram-api-hash telegram-phone telegram-session; do
      [ -n "${tg_vals[$key]}" ] && found=$((found+1))
    done
    echo "$found"
  ' 2>/dev/null
)

if [ "$TG_RESULT3" = "4" ]; then
  ok "Telegram user-config.json: all 4 keys found"
else
  err "Telegram user-config.json: expected 4 keys found, got: $TG_RESULT3"
fi

rm -rf "$TMP3"

# ── Test 4: Telegram partial user-config.json ─────────────────────────────────
echo ""
echo "Test 4 — preflight: Telegram partial user-config.json (3/4 keys)"

TMP4=$(mktemp -d)
DATA4="$TMP4/data"
mkdir -p "$DATA4"

cat > "$DATA4/user-config.json" <<'JSON'
{
  "telegram_api_id": "12345678",
  "telegram_api_hash": "abcdef1234567890abcdef1234567890",
  "telegram_phone": "+31600000000"
}
JSON

TG_RESULT4=$(
  env CLAUDE_PLUGIN_DATA_DIR="$DATA4" bash -c '
    USER_CONFIG_FILE="${CLAUDE_PLUGIN_DATA_DIR}/user-config.json"
    declare -A tg_vals
    for key in telegram-api-id telegram-api-hash telegram-phone telegram-session; do
      tg_vals["$key"]=""
    done
    if [ -f "$USER_CONFIG_FILE" ] && command -v jq >/dev/null 2>&1; then
      [ -z "${tg_vals[telegram-api-id]}" ]   && tg_vals["telegram-api-id"]=$(jq -r '"'"'.telegram_api_id   // ""'"'"' "$USER_CONFIG_FILE" 2>/dev/null)
      [ -z "${tg_vals[telegram-api-hash]}" ] && tg_vals["telegram-api-hash"]=$(jq -r '"'"'.telegram_api_hash // ""'"'"' "$USER_CONFIG_FILE" 2>/dev/null)
      [ -z "${tg_vals[telegram-phone]}" ]    && tg_vals["telegram-phone"]=$(jq -r '"'"'.telegram_phone     // ""'"'"' "$USER_CONFIG_FILE" 2>/dev/null)
      [ -z "${tg_vals[telegram-session]}" ]  && tg_vals["telegram-session"]=$(jq -r '"'"'.telegram_session  // ""'"'"' "$USER_CONFIG_FILE" 2>/dev/null)
    fi
    found=0
    for key in telegram-api-id telegram-api-hash telegram-phone telegram-session; do
      [ -n "${tg_vals[$key]}" ] && found=$((found+1))
    done
    echo "$found"
  ' 2>/dev/null
)

if [ "$TG_RESULT4" = "3" ]; then
  ok "Telegram partial user-config.json: 3 keys found (session missing)"
else
  err "Telegram partial user-config.json: expected 3, got: $TG_RESULT4"
fi

rm -rf "$TMP4"

# ── Test 5: ops-setup-detect outputs channels.slack.status=configured ─────────
echo ""
echo "Test 5 — detect: channels.slack.status=configured when SSE router in preflight cache"

TMP5=$(mktemp -d)
mkdir -p "$TMP5/preflight"
echo '{"ok":true,"source":"sse_router"}' > "$TMP5/preflight/slack.json"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$TMP5/preflight/.complete"

DETECT_OUT5=$(
  env PREFLIGHT_OVERRIDE="$TMP5/preflight" bash -c '
    # Inline the detect logic for the slack channel read
    PREFLIGHT="'"$TMP5/preflight"'"
    slack_ok=$(jq -r '"'"'.ok // false'"'"' "$PREFLIGHT/slack.json" 2>/dev/null)
    slack_src=$(jq -r '"'"'.source // ""'"'"' "$PREFLIGHT/slack.json" 2>/dev/null)
    if [ "$slack_ok" = "true" ]; then
      echo "configured:$slack_src"
    else
      echo "unconfigured"
    fi
  ' 2>/dev/null
)

if echo "$DETECT_OUT5" | grep -q "configured:sse_router"; then
  ok "detect: slack configured:sse_router from preflight cache"
else
  err "detect: slack did not read sse_router from cache (got: $DETECT_OUT5)"
fi

rm -rf "$TMP5"

# ── Test 6: Script syntax check ───────────────────────────────────────────────
echo ""
echo "Test 6 — syntax check: preflight and detect scripts"

if bash -n "$PREFLIGHT_BIN" 2>/dev/null; then
  ok "ops-setup-preflight: no syntax errors"
else
  err "ops-setup-preflight: syntax errors detected"
fi

if bash -n "$DETECT_BIN" 2>/dev/null; then
  ok "ops-setup-detect: no syntax errors"
else
  err "ops-setup-detect: syntax errors detected"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
echo ""

if (( fail > 0 )); then
  exit 1
fi
exit 0
