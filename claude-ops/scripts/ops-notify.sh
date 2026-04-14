#!/usr/bin/env bash
# ops-notify.sh — Fan-out notification dispatcher for claude-ops.
#
# Usage:
#   scripts/ops-notify.sh <severity> <title> <body> [--link <url>]
#
# <severity> is one of: CRITICAL | HIGH | MEDIUM | LOW (case-insensitive).
# Delivery sinks (all optional, all fanned out when configured):
#   1. Telegram bot      — $TELEGRAM_BOT_TOKEN + $TELEGRAM_NOTIFY_CHAT_ID (or $TELEGRAM_OWNER_ID)
#   2. Discord webhook   — $DISCORD_WEBHOOK_URL
#   3. ntfy.sh           — $NTFY_TOPIC (optionally $NTFY_SERVER, default https://ntfy.sh)
#   4. Pushover          — $PUSHOVER_USER + $PUSHOVER_TOKEN
#   5. macOS osascript   — local desktop notification (only on macOS)
#   6. stderr log        — always runs if nothing else is configured
#
# Rule 0: no hardcoded tokens, chat IDs, or webhooks live in this file — every
# credential is read from the environment or $PREFS_PATH.

set -euo pipefail

# ─── Paths + library sourcing ───────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
[ -r "$SCRIPT_DIR/lib/os-detect.sh" ] && . "$SCRIPT_DIR/lib/os-detect.sh"
# shellcheck disable=SC1091
[ -r "$SCRIPT_DIR/lib/credential-store.sh" ] && . "$SCRIPT_DIR/lib/credential-store.sh"

DATA_DIR="${OPS_DATA_DIR:-${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}}"
LOG_DIR="$DATA_DIR/logs"
LOG="$LOG_DIR/ops-notify.log"
PREFS_PATH="${PREFS_PATH:-$DATA_DIR/preferences.json}"

mkdir -p "$LOG_DIR"

# ─── Portable OS check (matches bin/ops-autofix pattern) ────────────────────
IS_MACOS=false
[ "$(uname -s)" = "Darwin" ] && IS_MACOS=true

# ─── Logging ────────────────────────────────────────────────────────────────
log() {
  printf '%s [ops-notify] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG"
}

# ─── Argument parsing ───────────────────────────────────────────────────────
if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <CRITICAL|HIGH|MEDIUM|LOW> <title> <body> [--link <url>]" >&2
  exit 2
fi

SEVERITY="$(echo "$1" | tr '[:lower:]' '[:upper:]')"
TITLE="$2"
BODY="$3"
shift 3
LINK=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --link)
      LINK="${2:-}"; shift 2 ;;
    *)
      shift ;;
  esac
done

case "$SEVERITY" in
  CRITICAL|HIGH|MEDIUM|LOW) : ;;
  *)
    echo "ops-notify: invalid severity '$SEVERITY' (expected CRITICAL|HIGH|MEDIUM|LOW)" >&2
    exit 2
    ;;
esac

# ─── Severity emoji mapping ─────────────────────────────────────────────────
severity_emoji() {
  case "$1" in
    CRITICAL) echo "🔴" ;;
    HIGH)     echo "🟠" ;;
    MEDIUM)   echo "🟡" ;;
    LOW)      echo "🟢" ;;
    *)        echo "⚪" ;;
  esac
}

severity_color_hex() {
  # Decimal RGB values for Discord embed color field
  case "$1" in
    CRITICAL) echo "15158332" ;;  # red
    HIGH)     echo "15105570" ;;  # orange
    MEDIUM)   echo "15844367" ;;  # yellow
    LOW)      echo "3066993" ;;   # green
    *)        echo "9807270" ;;   # gray
  esac
}

EMOJI="$(severity_emoji "$SEVERITY")"
FULL_TITLE="${EMOJI} [${SEVERITY}] ${TITLE}"

# ─── Pref loading helper ────────────────────────────────────────────────────
# Pulls a top-level key from $PREFS_PATH if the file exists. Caller may
# use this to provide fallbacks when env vars aren't set.
pref_get() {
  local key="$1"
  [ -f "$PREFS_PATH" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  jq -r --arg k "$key" '.[$k] // empty' "$PREFS_PATH" 2>/dev/null || true
}

# ─── Sink: Telegram bot ─────────────────────────────────────────────────────
send_telegram() {
  local token="${TELEGRAM_BOT_TOKEN:-$(pref_get telegram_bot_token)}"
  local chat_id="${TELEGRAM_NOTIFY_CHAT_ID:-${TELEGRAM_OWNER_ID:-$(pref_get telegram_notify_chat_id)}}"
  if [ -z "$token" ] || [ -z "$chat_id" ]; then
    return 1
  fi
  local text
  if [ -n "$LINK" ]; then
    text="${FULL_TITLE}"$'\n\n'"${BODY}"$'\n\n'"${LINK}"
  else
    text="${FULL_TITLE}"$'\n\n'"${BODY}"
  fi
  curl -s -o /dev/null -w '%{http_code}' \
    -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${chat_id}" \
    --data-urlencode "text=${text}" \
    --max-time 10 || echo "000"
}

# ─── Sink: Discord webhook ──────────────────────────────────────────────────
send_discord() {
  local url="${DISCORD_WEBHOOK_URL:-$(pref_get discord_webhook_url)}"
  if [ -z "$url" ]; then
    return 1
  fi
  local color payload
  color="$(severity_color_hex "$SEVERITY")"
  # Build JSON via jq to handle special characters safely
  if command -v jq >/dev/null 2>&1; then
    payload="$(jq -n \
      --arg title "$FULL_TITLE" \
      --arg body "$BODY" \
      --arg link "$LINK" \
      --argjson color "$color" \
      '{
        embeds: [{
          title: $title,
          description: $body,
          color: $color,
          url: (if $link == "" then null else $link end)
        }]
      }')"
  else
    # Fallback: minimal escape of double quotes + newlines
    local esc_title esc_body
    esc_title="$(printf '%s' "$FULL_TITLE" | sed 's/"/\\"/g')"
    esc_body="$(printf '%s' "$BODY" | sed 's/"/\\"/g' | tr '\n' ' ')"
    payload="{\"embeds\":[{\"title\":\"${esc_title}\",\"description\":\"${esc_body}\",\"color\":${color}}]}"
  fi
  curl -s -o /dev/null -w '%{http_code}' \
    -X POST "$url" \
    -H 'Content-Type: application/json' \
    --data "$payload" \
    --max-time 10 || echo "000"
}

# ─── Sink: ntfy.sh ──────────────────────────────────────────────────────────
send_ntfy() {
  local topic="${NTFY_TOPIC:-$(pref_get ntfy_topic)}"
  if [ -z "$topic" ]; then
    return 1
  fi
  local server="${NTFY_SERVER:-https://ntfy.sh}"
  local priority
  case "$SEVERITY" in
    CRITICAL) priority="5" ;;
    HIGH)     priority="4" ;;
    MEDIUM)   priority="3" ;;
    LOW)      priority="2" ;;
    *)        priority="3" ;;
  esac
  local body_with_link="$BODY"
  [ -n "$LINK" ] && body_with_link="${BODY}"$'\n\n'"${LINK}"
  local sev_lc
  sev_lc="$(echo "$SEVERITY" | tr '[:upper:]' '[:lower:]')"
  curl -s -o /dev/null -w '%{http_code}' \
    -X POST "${server}/${topic}" \
    -H "Title: ${FULL_TITLE}" \
    -H "Priority: ${priority}" \
    -H "Tags: warning,${sev_lc}" \
    --data "$body_with_link" \
    --max-time 10 || echo "000"
}

# ─── Sink: Pushover ─────────────────────────────────────────────────────────
send_pushover() {
  local user="${PUSHOVER_USER:-$(pref_get pushover_user_key)}"
  local token="${PUSHOVER_TOKEN:-$(pref_get pushover_app_token)}"
  if [ -z "$user" ] || [ -z "$token" ]; then
    return 1
  fi
  local priority
  case "$SEVERITY" in
    CRITICAL) priority="1" ;;   # high-priority, bypass quiet hours
    HIGH)     priority="1" ;;
    MEDIUM)   priority="0" ;;
    LOW)      priority="-1" ;;
    *)        priority="0" ;;
  esac
  local url_args=()
  if [ -n "$LINK" ]; then
    url_args+=(--data-urlencode "url=${LINK}")
  fi
  curl -s -o /dev/null -w '%{http_code}' \
    -X POST "https://api.pushover.net/1/messages.json" \
    --data-urlencode "token=${token}" \
    --data-urlencode "user=${user}" \
    --data-urlencode "title=${FULL_TITLE}" \
    --data-urlencode "message=${BODY}" \
    --data-urlencode "priority=${priority}" \
    "${url_args[@]}" \
    --max-time 10 || echo "000"
}

# ─── Sink: macOS osascript ──────────────────────────────────────────────────
send_macos() {
  $IS_MACOS || return 1
  command -v osascript >/dev/null 2>&1 || return 1
  # Escape double quotes for AppleScript literal
  local esc_title esc_body
  esc_title="$(printf '%s' "$FULL_TITLE" | sed 's/"/\\"/g')"
  esc_body="$(printf '%s' "$BODY" | sed 's/"/\\"/g')"
  osascript -e "display notification \"${esc_body}\" with title \"${esc_title}\"" >/dev/null 2>&1 || true
  echo "200"
}

# ─── Sink: stderr ───────────────────────────────────────────────────────────
send_stderr() {
  {
    printf '%s\n' "$FULL_TITLE"
    printf '%s\n' "$BODY"
    [ -n "$LINK" ] && printf 'link: %s\n' "$LINK"
  } >&2
  echo "200"
}

# ─── Dispatch ───────────────────────────────────────────────────────────────
delivered=0

run_sink() {
  local name="$1" fn="$2"
  local result
  result="$($fn 2>/dev/null || true)"
  if [ -n "$result" ] && [ "$result" != "000" ]; then
    log "SINK ${name}: status=${result}"
    delivered=$((delivered + 1))
  else
    log "SINK ${name}: skipped (not configured or failed)"
  fi
}

run_sink telegram send_telegram
run_sink discord  send_discord
run_sink ntfy     send_ntfy
run_sink pushover send_pushover
run_sink macos    send_macos

if [ "$delivered" -eq 0 ]; then
  log "SINK stderr: fallback (no sinks configured)"
  send_stderr >/dev/null 2>&1 || true
  printf '%s [ops-notify] %s | %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$FULL_TITLE" "$BODY" >> "$LOG"
fi

log "DISPATCHED severity=${SEVERITY} delivered=${delivered} title=\"${TITLE}\""
exit 0
