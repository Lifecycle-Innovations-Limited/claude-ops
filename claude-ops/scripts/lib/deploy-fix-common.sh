#!/usr/bin/env bash
# deploy-fix-common.sh — shared helpers for the deploy/build auto-fix subsystem.
# Sourced by hook scripts and the background monitor. Uses ${CLAUDE_PLUGIN_ROOT}
# when invoked from inside the plugin; falls back to inferred paths.

set -u

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -z "$PLUGIN_ROOT" ] && PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PLUGIN_ROOT

PREFS_DIR="${HOME}/.claude/plugins/data/ops-ops-marketplace"
PREFS_FILE="$PREFS_DIR/preferences.json"
STATE_DIR="${OPS_DEPLOY_FIX_STATE:-${HOME}/.claude/state/ops-deploy-fix}"
LOGS_DIR="${OPS_DEPLOY_FIX_LOGS:-${HOME}/.claude/logs/ops-deploy-fix}"
mkdir -p "$STATE_DIR" "$LOGS_DIR" 2>/dev/null

# config <key> <default>  — reads CLAUDE_PLUGIN_OPTION_<KEY>, then plugin prefs, then default
config() {
  local key="$1" default="$2"
  local env_var="CLAUDE_PLUGIN_OPTION_$(echo "$key" | tr '[:lower:]' '[:upper:]')"
  if [ -n "${!env_var:-}" ]; then echo "${!env_var}"; return; fi
  if [ -f "$PREFS_FILE" ]; then
    local v=$(jq -r --arg k "$key" '.[$k] // .deploy_fix[$k] // empty' "$PREFS_FILE" 2>/dev/null)
    [ -n "$v" ] && [ "$v" != "null" ] && { echo "$v"; return; }
  fi
  echo "$default"
}

is_enabled() {
  [ "$(config deploy_fix_enabled true)" = "true" ] && [ "$(config "$1" true)" = "true" ]
}

repo_slug_safe() { echo "$1" | tr '/' '-'; }

# Single-flight lock per repo+kind. Returns 0 if acquired, 1 if held.
lock_acquire() {
  local id="$1"
  local f="$STATE_DIR/lock-$id"
  if [ -f "$f" ]; then
    local pid=$(cat "$f" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 1  # alive
    fi
    rm -f "$f"  # stale
  fi
  echo $$ > "$f"
  return 0
}
lock_release() { rm -f "$STATE_DIR/lock-$1" 2>/dev/null; }

# Hourly budget per repo. Returns 0 if under cap (and increments), 1 if over.
budget_check_increment() {
  local slug="$1"
  local cap=$(config max_fixes_per_hour 3)
  local hour=$(date +%Y%m%d-%H)
  local f="$STATE_DIR/budget-$slug-$hour"
  local n=$(cat "$f" 2>/dev/null || echo 0)
  if [ "$n" -ge "$cap" ]; then return 1; fi
  echo $((n + 1)) > "$f"
  return 0
}

# Dedup by content hash — same failure tail twice in a row = skip second dispatch.
already_seen() {
  local slug="$1" content="$2"
  local hash=$(printf '%s' "$content" | shasum | awk '{print $1}')
  local f="$STATE_DIR/last-failure-$slug"
  local last=$(cat "$f" 2>/dev/null || echo "")
  if [ "$last" = "$hash" ]; then return 0; fi
  echo "$hash" > "$f"
  return 1
}

# Detect transient failure signatures. Returns 0 (transient) or 1.
is_transient() {
  local pat='ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|TLS handshake timeout|unexpected EOF while reading|Could not resolve host|network is unreachable'
  pat="$pat|npm error code E429|npm error 5(0[0-9]|2[0-9])|HTTP(S)?Error:? 429|HTTP(S)?Error:? 5[0-9]{2}"
  pat="$pat|The runner has received a shutdown signal|The hosted runner lost communication|The operation was canceled\.|GH001:"
  pat="$pat|TooManyRequestsException|ThrottlingException|RequestLimitExceeded|Service Unavailable Exception"
  pat="$pat|Apple ID server.*temporarily unavailable|App Store Connect.*timed out|ASC.*5[0-9]{2}"
  pat="$pat|Simulator failed to launch|ECR.*throttle"
  printf '%s' "$1" | grep -qE "$pat"
}

notify() {
  local title="$1" msg="$2"
  local channel=$(config notify_channel macos)
  case "$channel" in
    macos)
      command -v terminal-notifier >/dev/null && \
        terminal-notifier -title "$title" -message "$msg" -sender com.apple.Terminal 2>/dev/null
      ;;
    ntfy)
      local topic=$(config ntfy_topic "")
      [ -n "$topic" ] && curl -sS -X POST "https://ntfy.sh/$topic" -H "Title: $title" -d "$msg" >/dev/null 2>&1
      ;;
    discord)
      local hook=$(config discord_default_webhook_url "")
      [ -n "$hook" ] && curl -sS -X POST "$hook" -H 'Content-Type: application/json' \
        -d "$(jq -n --arg c "**$title** — $msg" '{content:$c}')" >/dev/null 2>&1
      ;;
    pushover)
      local user=$(config pushover_user_key "") token=$(config pushover_app_token "")
      [ -n "$user" ] && [ -n "$token" ] && \
        curl -sS https://api.pushover.net/1/messages.json \
          --form-string "token=$token" --form-string "user=$user" \
          --form-string "title=$title" --form-string "message=$msg" >/dev/null 2>&1
      ;;
    none) : ;;
  esac
}

# Locate repo on disk via configurable search roots.
locate_repo() {
  local slug="$1" repo_only="${1#*/}"
  local roots="$(config repo_search_roots "$HOME/Projects:$HOME")"
  IFS=':' read -ra arr <<< "$roots"
  for root in "${arr[@]}"; do
    root="${root/#\~/$HOME}"
    [ -d "$root/$repo_only" ] && { echo "$root/$repo_only"; return 0; }
    [ -d "$root/$slug" ] && { echo "$root/$slug"; return 0; }
  done
  return 1
}

# Resolve health URL via layered registry: project → user → plugin example.
resolve_health_url() {
  local slug="$1" base="$2"
  local key="$slug:$base"
  local proj=$(locate_repo "$slug" 2>/dev/null) || true
  if [ -n "$proj" ] && [ -f "$proj/.claude/post-merge-services.json" ]; then
    local v=$(jq -r --arg k "$key" '.[$k].health // ""' "$proj/.claude/post-merge-services.json" 2>/dev/null)
    [ -n "$v" ] && { echo "$v"; return; }
  fi
  local user_path="$(config registry_path "$HOME/.claude/config/post-merge-services.json")"
  user_path="${user_path/#\~/$HOME}"
  if [ -f "$user_path" ]; then
    local v=$(jq -r --arg k "$key" '.[$k].health // ""' "$user_path" 2>/dev/null)
    [ -n "$v" ] && { echo "$v"; return; }
  fi
  if [ -f "$PLUGIN_ROOT/config/post-merge-services.example.json" ]; then
    jq -r --arg k "$key" '.[$k].health // ""' "$PLUGIN_ROOT/config/post-merge-services.example.json" 2>/dev/null
  fi
}

resolve_version_url() {
  local slug="$1" base="$2"
  local key="$slug:$base"
  local proj=$(locate_repo "$slug" 2>/dev/null) || true
  if [ -n "$proj" ] && [ -f "$proj/.claude/post-merge-services.json" ]; then
    local v=$(jq -r --arg k "$key" '.[$k].version // ""' "$proj/.claude/post-merge-services.json" 2>/dev/null)
    [ -n "$v" ] && { echo "$v"; return; }
  fi
  local user_path="$(config registry_path "$HOME/.claude/config/post-merge-services.json")"
  user_path="${user_path/#\~/$HOME}"
  if [ -f "$user_path" ]; then
    local v=$(jq -r --arg k "$key" '.[$k].version // ""' "$user_path" 2>/dev/null)
    [ -n "$v" ] && { echo "$v"; return; }
  fi
  if [ -f "$PLUGIN_ROOT/config/post-merge-services.example.json" ]; then
    jq -r --arg k "$key" '.[$k].version // ""' "$PLUGIN_ROOT/config/post-merge-services.example.json" 2>/dev/null
  fi
}

dispatch_fix_agent() {
  # $1 = agent_name (matches claude-ops/agents/<name>.md OR ~/.claude/agents/<name>.md)
  # $2 = lock_id, rest = context vars as KEY=VAL (substituted into a thin task brief)
  local agent_name="$1" lock_id="$2"; shift 2
  if ! lock_acquire "$lock_id"; then
    return 2  # already in flight
  fi
  local slug="${lock_id%%:*}"
  if ! budget_check_increment "$slug"; then
    notify "Auto-fix budget exhausted" "$slug hit hourly cap — manual intervention needed"
    lock_release "$lock_id"
    return 3
  fi

  # Build the thin task brief — full persona/tools/model come from the agent file.
  local context=""
  for kv in "$@"; do
    local k="${kv%%=*}" v="${kv#*=}"
    context="${context}${k}: ${v}"$'\n'
  done

  local fix_log="$LOGS_DIR/fix-${lock_id}-$(date +%s).log"
  local danger_flag="--permission-mode acceptEdits"
  [ "$(config allow_dangerous false)" = "true" ] && danger_flag="--dangerously-skip-permissions"

  command -v claude >/dev/null || { lock_release "$lock_id"; return 5; }

  # Use --agent <name> so the agent's frontmatter (model/tools/persona) is honored.
  # The brief is just the failure context — persona + workflow + guardrails come from agent file.
  local brief="Failure context for your repair task:

${context}
Execute per your agent definition. Final line of output must be RESOLVED/RERUN/RETRY/BLOCKED."

  nohup bash -c "
    printf '%s' \"\$1\" | claude -p --agent '$agent_name' $danger_flag --no-session-persistence > '$fix_log' 2>&1
    rm -f '$STATE_DIR/lock-$lock_id'
  " _ "$brief" </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
  echo "$fix_log"
  return 0
}
