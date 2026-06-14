#!/bin/sh
# statusline-command.sh — config-driven 3-line Claude Code cockpit statusline.
# Wire into ~/.claude/settings.json: { "statusLine": { "command": "/path/to/this" } }
#
# Config file resolution (first wins):
#   $CLAUDE_STATUSLINE_CONFIG  →  ~/.claude/statusline.config.json  →  built-in defaults
#
# Hard constraints:
#   - Every external call is async — render reads caches, never blocks.
#   - No line exceeds $COLUMNS visible characters (ANSI-stripped + emoji+1).
#   - POSIX sh, BMP-safe glyphs (works over mosh/tmux/SSH).
#   - Target <50ms warm render.
#   - No Sam-specific data; all project config comes from statusline.config.json.

LC_ALL=C; export LC_ALL
ESC=$(printf '\033')
input=$(cat)
now=$(date +%s)
uid=$(id -u)

# ── Portable mtime ────────────────────────────────────────────────────────────
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }

# ── async_cache <cache_file> <ttl_sec> <command…> ────────────────────────────
# Never blocks the render. Returns cached content; refreshes in a locked
# background job when stale. Core cockpit principle: read instruments, never
# go fetch fuel mid-frame.
async_cache() {
  _cf=$1; _ttl=$2; shift 2
  if [ ! -s "$_cf" ] || [ $(( now - $(mtime "$_cf") )) -ge "$_ttl" ]; then
    _lk="${_cf}.lock"
    [ -d "$_lk" ] && [ $(( now - $(mtime "$_lk") )) -gt 30 ] && rmdir "$_lk" 2>/dev/null
    if mkdir "$_lk" 2>/dev/null; then
      ( "$@" > "${_cf}.tmp" 2>/dev/null && [ -s "${_cf}.tmp" ] && mv "${_cf}.tmp" "$_cf"
        rmdir "$_lk" 2>/dev/null ) >/dev/null 2>&1 &
    fi
  fi
  [ -s "$_cf" ] && cat "$_cf"
}

# ── gauge <pct> <width> → sets GAUGE_BAR and GAUGE_C ────────────────────────
# Color-graded fill bar. Green (calm) → yellow → orange → bold-red at >=90%.
# GAUGE_C is the last-used color code (for the trailing pct label).
gauge() {
  _p=$1; _w=$2
  case "$_p" in ''|*[!0-9]*) _p=0;; esac
  _f=$(( _p * _w / 100 )); [ "$_f" -gt "$_w" ] && _f=$_w; [ "$_f" -lt 0 ] && _f=0
  _e=$(( _w - _f ))
  if   [ "$_p" -ge 90 ]; then GAUGE_C="${T_gauge_crit:-1;31}"
  elif [ "$_p" -ge 75 ]; then GAUGE_C="${T_gauge_hot:-38;5;208}"
  elif [ "$_p" -ge 50 ]; then GAUGE_C="${T_gauge_warn:-33}"
  else                        GAUGE_C="${T_gauge_ok:-32}"; fi
  _b="${ESC}[${GAUGE_C}m"
  _i=0; while [ "$_i" -lt "$_f" ]; do _b="${_b}█"; _i=$(( _i + 1 )); done
  _b="${_b}${ESC}[${T_gauge_empty:-38;5;236}m"
  _i=0; while [ "$_i" -lt "$_e" ]; do _b="${_b}░"; _i=$(( _i + 1 )); done
  GAUGE_BAR="${_b}${ESC}[0m"
}

# ── visible_width <string> → echoes char count (ANSI-stripped, emoji+1) ──────
# Used to measure segments before packing them into a line.
if [ "$(uname -s)" = "Darwin" ]; then _u8lc="en_US.UTF-8"; else _u8lc="C.UTF-8"; fi
vis_width() {
  _s=$(printf '%s' "$1" | sed "s/${ESC}\[[0-9;]*m//g")
  _cw=$(printf '%s' "$_s" | LC_ALL=$_u8lc wc -m | tr -d ' ')
  # Each wide emoji costs an extra column (they render in 2 cells):
  _ew=$(printf '%s' "$_s" | LC_ALL=$_u8lc grep -o -e '🤖' -e '📬' -e '🚧' -e '🔥' \
    -e '💾' -e '⚡' -e '📣' -e '🛒' -e '📈' -e '🥊' -e '🎧' -e '❄' -e '✦' \
    -e '🔄' -e '🔴' 2>/dev/null | wc -l | tr -d ' ')
  echo $(( _cw + _ew ))
}

# ── Config load — single jq call, fall back to built-in defaults ──────────────
_cfg_file=""
if [ -n "$CLAUDE_STATUSLINE_CONFIG" ] && [ -f "$CLAUDE_STATUSLINE_CONFIG" ]; then
  _cfg_file="$CLAUDE_STATUSLINE_CONFIG"
elif [ -f "$HOME/.claude/statusline.config.json" ]; then
  _cfg_file="$HOME/.claude/statusline.config.json"
fi

# Built-in defaults (used when cfg file absent or key missing):
CFG_theme="cockpit"
CFG_ctx_w=10
CFG_quota_w=8
CFG_carousel_sec=15
CFG_fleet_bg=1
CFG_fleet_rot=1
CFG_fleet_sdk=1
CFG_fleet_cache=1
CFG_sys_cpu=1
CFG_sys_ram=1
CFG_sys_disk=1

if [ -n "$_cfg_file" ]; then
  eval $(jq -r '
    @sh "CFG_theme=\(.theme // "cockpit")",
    @sh "CFG_ctx_w=\(.gauge_width.ctx // 10)",
    @sh "CFG_quota_w=\(.gauge_width.quota // 8)",
    @sh "CFG_carousel_sec=\(.carousel_interval_sec // 15)",
    @sh "CFG_fleet_bg=\(if .fleet.show_bg_agents    == false then 0 else 1 end)",
    @sh "CFG_fleet_rot=\(if .fleet.show_rotation    == false then 0 else 1 end)",
    @sh "CFG_fleet_sdk=\(if .fleet.show_sdk_fallback== false then 0 else 1 end)",
    @sh "CFG_fleet_cache=\(if .fleet.show_cache_ttl == false then 0 else 1 end)",
    @sh "CFG_sys_cpu=\(if .sys_metrics.show_cpu  == false then 0 else 1 end)",
    @sh "CFG_sys_ram=\(if .sys_metrics.show_ram  == false then 0 else 1 end)",
    @sh "CFG_sys_disk=\(if .sys_metrics.show_disk == false then 0 else 1 end)"
  ' "$_cfg_file" 2>/dev/null) 2>/dev/null || true
fi

# ── Theme colors — one jq from themes.json bundled alongside this script ─────
_themes_file="$(dirname "$0")/themes.json"
T_ok="${ESC}[32m"; T_warn="${ESC}[33m"; T_danger="${ESC}[1;31m"; T_dim="${ESC}[38;5;245m"
T_acc="${ESC}[36m"; T_acc2="${ESC}[35m"
T_gauge_ok="32"; T_gauge_warn="33"; T_gauge_hot="38;5;208"; T_gauge_crit="1;31"
T_gauge_empty="38;5;236"
T_loc_remote="1;97;41"; T_loc_home="1;97;44"

if [ -f "$_themes_file" ]; then
  eval $(jq -r --arg t "$CFG_theme" '
    .[$t] // .cockpit |
    @sh "T_ok=\(.ok // "32")",
    @sh "T_warn=\(.warn // "33")",
    @sh "T_danger=\(.danger // "1;31")",
    @sh "T_dim=\(.dim // "38;5;245")",
    @sh "T_acc=\(.accent // "36")",
    @sh "T_acc2=\(.accent2 // "35")",
    @sh "T_gauge_ok=\(.gauge_ok // "32")",
    @sh "T_gauge_warn=\(.gauge_warn // "33")",
    @sh "T_gauge_hot=\(.gauge_hot // "38;5;208")",
    @sh "T_gauge_crit=\(.gauge_crit // "1;31")",
    @sh "T_gauge_empty=\(.gauge_empty // "38;5;236")",
    @sh "T_loc_remote=\(.loc_remote // "1;97;41")",
    @sh "T_loc_home=\(.loc_home // "1;97;44")"
  ' "$_themes_file" 2>/dev/null) 2>/dev/null || true
fi

# Convert raw codes to full sequences for convenience:
T_ok="${ESC}[${T_ok}m";    T_warn="${ESC}[${T_warn}m";  T_danger="${ESC}[${T_danger}m"
T_dim="${ESC}[${T_dim}m";  T_acc="${ESC}[${T_acc}m";    T_acc2="${ESC}[${T_acc2}m"
R="${ESC}[0m"

# ── Project list from config ──────────────────────────────────────────────────
# Each project: { "key": "myapp", "label": "MyApp", "match": "myapp", "badges": ["ecs","orders"] }
# Built-in default: empty (no per-project badges).
CFG_proj_keys=""
CFG_proj_count=0
if [ -n "$_cfg_file" ]; then
  CFG_proj_count=$(jq -r '(.projects // []) | length' "$_cfg_file" 2>/dev/null || echo 0)
  if [ "${CFG_proj_count:-0}" -gt 0 ] 2>/dev/null; then
    CFG_proj_keys=$(jq -r '(.projects // []) | map(.key) | join(" ")' "$_cfg_file" 2>/dev/null)
  fi
fi

# ── Column width ──────────────────────────────────────────────────────────────
cols=${COLUMNS:-0}
[ "$cols" -eq 0 ] && cols=$(tput cols 2>/dev/null || echo 120)

# ── Parse input JSON ─────────────────────────────────────────────────────────
eval $(printf '%s' "$input" | jq -r '
  @sh "cwd=\(.workspace.current_dir // .cwd // "")",
  @sh "model=\(.model.display_name // "")",
  @sh "rl_5h=\(.rate_limits.five_hour.used_percentage // "")",
  @sh "rl_7d=\(.rate_limits.seven_day.used_percentage // "")",
  @sh "rl_5h_reset=\(.rate_limits.five_hour.resets_at // 0)",
  @sh "rl_7d_reset=\(.rate_limits.seven_day.resets_at // 0)",
  @sh "ctx_used=\(.context_window.used_percentage // "")",
  @sh "cost=\(.cost.total_cost_usd // "")",
  @sh "lines_add=\(.cost.total_lines_added // 0)",
  @sh "lines_rm=\(.cost.total_lines_removed // 0)",
  @sh "session_id=\(.session_id // "")",
  @sh "transcript_path=\(.transcript_path // "")"
' 2>/dev/null)

# ── Location badge ────────────────────────────────────────────────────────────
# Linux/remote: derive from hostname. Mac: cache in ~/.claude/.statusline-location.
# Linux never trusts the Mac's cached value (prevents masquerading).
loc_file="$HOME/.claude/.statusline-location"
host=$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
if [ "$(uname -s)" != "Darwin" ]; then
  case "$host" in
    *fra*) loc="⚑ FRA" ;;
    *)     loc="⚑ ${host}" ;;
  esac
  printf '%s' "$loc" > "$loc_file" 2>/dev/null
elif [ -s "$loc_file" ]; then
  loc=$(cat "$loc_file")
else
  loc="⌂ $(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  printf '%s' "$loc" > "$loc_file" 2>/dev/null
fi
case "$loc" in
  "⚑ "*) loc_badge="${ESC}[${T_loc_remote}m ${loc} ${R}" ;;
  "⌂ "*) loc_badge="${ESC}[${T_loc_home}m ${loc} ${R}" ;;
  *)     loc_badge="${T_acc}${loc}${R}" ;;
esac

# ── Auth cache (async, 45s TTL) ───────────────────────────────────────────────
auth_cache="/tmp/claude-authjson-${session_id}"
auth_age=$(( now - $(mtime "$auth_cache") ))
if [ ! -s "$auth_cache" ] || [ "$auth_age" -ge 45 ]; then
  _lk="${auth_cache}.lock"
  [ -d "$_lk" ] && [ $(( now - $(mtime "$_lk") )) -gt 30 ] && rmdir "$_lk" 2>/dev/null
  if mkdir "$_lk" 2>/dev/null; then
    ( claude auth status > "${auth_cache}.tmp" 2>/dev/null \
        && [ -s "${auth_cache}.tmp" ] && mv "${auth_cache}.tmp" "$auth_cache"
      rmdir "$_lk" 2>/dev/null ) >/dev/null 2>&1 &
  fi
fi
account_email=""; _sub=""; _method=""
[ -s "$auth_cache" ] && eval $(jq -r '
  @sh "account_email=\(.email // "")",
  @sh "_sub=\(.subscriptionType // "")",
  @sh "_method=\(.authMethod // "")"
' "$auth_cache" 2>/dev/null)

# Billing mode
billing_cache="/tmp/claude-billing-${session_id}"
if [ "${CLAUDE_CODE_USE_BEDROCK:-}" = "1" ]; then
  sub_type="bedrock"
elif [ -n "$_sub" ] && [ "$_sub" != "null" ]; then
  sub_type="$_sub"
elif [ "$_method" = "claude.ai" ]; then
  sub_type="max"
elif [ -s "$billing_cache" ]; then
  sub_type=$(cat "$billing_cache")
else
  sub_type="api"
fi
[ "$sub_type" != "api" ] && printf '%s' "$sub_type" > "$billing_cache" 2>/dev/null
case "$sub_type" in max|pro|team|enterprise) is_sub=1 ;; *) is_sub="" ;; esac

# ── Account alias helper ──────────────────────────────────────────────────────
# Maps email → short label. Falls back to domain-sans-TLD for unknown addresses.
# Customize by adding entries in your config or by overriding this function in a
# wrapper script — the shipped version contains no personal emails.
acct_alias() {
  case "$1" in
    *@*) _d=${1#*@}; printf '%s' "${_d%%.*}" ;;
    *)   printf '%s' "$1" ;;
  esac
}

# ── Export rate limits for rotation daemon ────────────────────────────────────
rot_dir="$HOME/.claude/scripts/account-rotation"
if { [ -n "$rl_5h" ] || [ -n "$rl_7d" ]; } && [ -d "$rot_dir" ]; then
  printf '{"five_hour":{"pct":%s,"reset":%s},"seven_day":{"pct":%s,"reset":%s},"account_email":"%s","ts":%s}\n' \
    "${rl_5h:-0}" "${rl_5h_reset}" "${rl_7d:-0}" "${rl_7d_reset}" \
    "${account_email}" "$now" \
    > "$rot_dir/.rate-limits.json" 2>/dev/null
fi

# Per-account session count (multi-session badge)
sessions_n=0
if [ -n "$account_email" ]; then
  pid_file="/tmp/claude-pids-${account_email}"
  new_content="$PPID"
  if [ -f "$pid_file" ]; then
    while IFS= read -r p; do
      [ -z "$p" ] && continue; [ "$p" = "$PPID" ] && continue
      kill -0 "$p" 2>/dev/null && new_content="${new_content}
${p}"
    done < "$pid_file"
  fi
  printf '%s\n' "$new_content" > "$pid_file" 2>/dev/null
  sessions_n=$(printf '%s\n' "$new_content" | grep -c .)
fi

# ── Git branch (async, 10s TTL) ───────────────────────────────────────────────
git_part=""
if [ -n "$cwd" ] && [ -d "$cwd" ]; then
  git_cache="/tmp/claude-gitbranch-${uid}-$(printf '%s' "$cwd" | cksum | cut -d' ' -f1)"
  branch=$(async_cache "$git_cache" 10 git -C "$cwd" --no-optional-locks rev-parse --abbrev-ref HEAD)
  [ -n "$branch" ] && git_part="${T_acc}⎇${branch}${R}"
fi

# ── Model badge ───────────────────────────────────────────────────────────────
model_part=""
# Shorten verbose display names: "Claude Opus 4.8 (1M context)" → "Opus 4.8"
model=$(printf '%s' "$model" | sed -E 's/^Claude //; s/ *\([^)]*\)//g; s/ +$//')
[ -n "$model" ] && model_part="${T_warn}${model}${R}"

# ── Plan badge ────────────────────────────────────────────────────────────────
case "$sub_type" in
  max)        plan_badge="${T_acc2}●${R} ${ESC}[1;${T_acc2#*[}Max${R}" ;;
  pro)        plan_badge="${T_acc}●${R} ${ESC}[1;${T_acc#*[}Pro${R}" ;;
  team)       plan_badge="${T_acc2}●${R} ${ESC}[1;${T_acc2#*[}Team${R}" ;;
  enterprise) plan_badge="${T_acc2}●${R} ${ESC}[1;${T_acc2#*[}Ent${R}" ;;
  bedrock)    plan_badge="${T_warn}●${R} ${ESC}[1;${T_warn#*[}Bedrock${R}" ;;
  *)          plan_badge="${T_warn}●${R} ${ESC}[1;${T_warn#*[}API${R}" ;;
esac

# Simplified inline variant (no bold prefix dot):
case "$sub_type" in
  max)        plan_short="${ESC}[35mMax${R}" ;;
  pro)        plan_short="${T_acc}Pro${R}" ;;
  team)       plan_short="${ESC}[35mTeam${R}" ;;
  enterprise) plan_short="${ESC}[35mEnt${R}" ;;
  bedrock)    plan_short="${T_warn}BDR${R}" ;;
  *)          plan_short="${T_warn}API${R}" ;;
esac

# ── Tasks badge ───────────────────────────────────────────────────────────────
tasks_part=""
if [ -n "$session_id" ] && [ -d "$HOME/.claude/tasks/$session_id" ]; then
  set -- "$HOME/.claude/tasks/$session_id"/[!.]*.json
  if [ -e "$1" ]; then
    total=$#
    running=$(grep -l '"status":"in_progress"' "$@" 2>/dev/null | grep -c .)
    done_count=$(grep -l '"status":"completed"' "$@" 2>/dev/null | grep -c .)
    if [ "$running" -gt 0 ]; then
      tasks_part="${T_ok}⟳${running}${R}${T_dim}(${done_count}/${total})${R}"
    else
      tasks_part="${T_dim}✓${done_count}/${total}${R}"
    fi
  fi
fi

# ── Active subagents count ────────────────────────────────────────────────────
agents_n=0
if [ -n "$session_id" ]; then
  agents_n=$( {
    for taskdir in /tmp/claude-${uid}/*/"$session_id"/tasks; do
      [ -d "$taskdir" ] || continue
      find "$taskdir" -maxdepth 1 -name 'a*.output' -mmin -5 2>/dev/null \
        | sed 's|.*/||; s|\.output$||'
    done
    for subdir in "$HOME"/.claude/projects/*/"$session_id"/subagents; do
      [ -d "$subdir" ] || continue
      find "$subdir" -maxdepth 1 -name 'agent-*.jsonl' -mmin -5 2>/dev/null \
        | sed 's|.*/agent-||; s|\.jsonl$||'
    done
  } | sort -u | grep -c . )
fi
if [ "$agents_n" -gt 0 ]; then
  agents_part="${T_acc}🤖 ${agents_n}${R}"
else
  agents_part="${T_dim}🤖 0${R}"
fi

# ── Rate-limit badges ─────────────────────────────────────────────────────────
rl_5h_int=0; rl_7d_int=0
[ -n "$rl_5h" ] && rl_5h_int=$(printf '%.0f' "${rl_5h}" 2>/dev/null || echo 0)
[ -n "$rl_7d" ] && rl_7d_int=$(printf '%.0f' "${rl_7d}" 2>/dev/null || echo 0)
_rl_pick=$rl_5h_int; [ "$rl_7d_int" -gt "$_rl_pick" ] && _rl_pick=$rl_7d_int
if   [ "$_rl_pick" -ge 90 ]; then rl_col="$T_danger"
elif [ "$_rl_pick" -ge 50 ]; then rl_col="$T_warn"
else                               rl_col="$T_ok"; fi

rl_part=""; rl_short=""
if [ -n "$rl_5h" ] || [ -n "$rl_7d" ]; then
  # Account prefix
  acct_label=""
  if [ -n "$account_email" ]; then
    a=$(acct_alias "$account_email")
    if [ "$sessions_n" -gt 1 ]; then
      acct_label="${T_dim}${a}${R}${T_acc}×${sessions_n}${R} "
    else
      acct_label="${T_dim}${a}${R} "
    fi
  fi
  # 5h reset countdown
  reset_label=""
  case "$rl_5h_reset" in
    ''|*[!0-9]*) ;;
    *)
      if [ "$rl_5h_reset" -gt "$now" ]; then
        rsec=$(( rl_5h_reset - now ))
        rh=$(( rsec / 3600 )); rm_=$(( (rsec % 3600) / 60 ))
        if [ "$rh" -gt 0 ]; then reset_label=" ${T_dim}↻${rh}h${rm_}m${R}"
        else reset_label=" ${T_dim}↻${rm_}m${R}"; fi
      fi ;;
  esac
  # Next-rotation target (memoized 30s)
  next_label=""
  next_cache="/tmp/claude-nexttarget-${uid}"
  if [ -s "$next_cache" ] && [ $(( now - $(mtime "$next_cache") )) -lt 30 ]; then
    next_line=$(cat "$next_cache")
  else
    next_line=""
    next_file="$rot_dir/.next-rotation-target.json"
    [ -f "$next_file" ] && next_line=$(jq -r '"\(.email // "") \(.pct // 0 | floor)"' "$next_file" 2>/dev/null)
    _ne=${next_line% *}
    if { [ -z "$_ne" ] || [ "$_ne" = "$account_email" ]; } \
       && [ -f "$rot_dir/config.json" ] && [ -f "$rot_dir/state.json" ]; then
      next_line=$(jq -r --arg cur "$account_email" --slurpfile cfg "$rot_dir/config.json" '
        ($cfg[0].accounts | map(select(.disabled != true) | {(.label // .email): .email}) | add) as $k2e
        | (.accounts // {}) | to_entries
        | map(select($k2e[.key] != null))
        | map({email: $k2e[.key], pct: (.value.lastUtilization.pct // null)})
        | map(select(.pct != null and .email != $cur))
        | sort_by(.pct) | .[0] // empty
        | "\(.email) \(.pct|floor)"' "$rot_dir/state.json" 2>/dev/null)
    fi
    printf '%s' "$next_line" > "$next_cache" 2>/dev/null
  fi
  next_email=${next_line% *}; next_pct=${next_line##* }
  [ -n "$next_email" ] && [ "$next_email" != "$account_email" ] && \
    next_label=" ${T_dim}→$(acct_alias "$next_email") (${next_pct}%)${R}"

  rl_part="${acct_label}${rl_col}⚡ ${rl_5h_int}%${R}${T_dim}/${R}${rl_col}▥ ${rl_7d_int}%${R}${reset_label}${next_label}"
  rl_short="${rl_col}⚡ ${rl_5h_int}%${R}${T_dim}/${R}${rl_col}▥ ${rl_7d_int}%${R}"
fi

# ── Cost / lines badges ───────────────────────────────────────────────────────
cost_part=""
if [ -n "$cost" ]; then
  cost_fmt=$(printf '%.2f' "$cost")
  if [ -n "$is_sub" ]; then
    cost_part="${ESC}[9;90m\$${cost_fmt}${R}"
  elif [ "$sub_type" = "bedrock" ]; then
    cost_part="${T_warn}\$${cost_fmt}${R}"
  else
    cost_part="${T_acc}\$${cost_fmt}${R}"
  fi
fi

lines_part=""
if [ "${lines_add:-0}" -gt 0 ] || [ "${lines_rm:-0}" -gt 0 ]; then
  lines_part="${T_ok}+${lines_add:-0}${R}${T_danger}-${lines_rm:-0}${R}"
fi

# ── Prompt-cache freshness ────────────────────────────────────────────────────
cache_badge=""
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
  cache_age=$(( now - $(mtime "$transcript_path") ))
  if [ "$cache_age" -ge 300 ]; then
    cache_badge="${T_danger}❄ cold${R}"
  else
    left=$(( 300 - cache_age )); lm=$(( left / 60 )); ls_=$(( left % 60 ))
    if [ "$left" -lt 60 ]; then cache_badge="${T_warn}✦${ls_}s${R}"
    else cache_badge="${T_ok}✦${lm}m${R}"; fi
  fi
fi

# ── Gauge widths — scale down on narrow terminals ────────────────────────────
_ctx_w=$CFG_ctx_w; _quota_w=$CFG_quota_w
if [ "$cols" -lt 100 ]; then _ctx_w=6; _quota_w=5; fi
if [ "$cols" -lt 80  ]; then _ctx_w=4; _quota_w=4; fi

# ── Context-window gauge (L1) ─────────────────────────────────────────────────
ctx_bar=""
if [ -n "$ctx_used" ]; then
  gauge "$ctx_used" "$_ctx_w"
  ctx_bar="${T_dim}ctx${R} ${GAUGE_BAR} ${ESC}[${GAUGE_C}m${ctx_used}%${R}"
fi

# ── Quota gauges 5h + 7d (L1) ────────────────────────────────────────────────
quota_bar=""
if [ -n "$rl_5h" ] || [ -n "$rl_7d" ]; then
  gauge "${rl_5h_int}" "$_quota_w"
  g5="${T_dim}5h${R} ${GAUGE_BAR} ${ESC}[${GAUGE_C}m${rl_5h_int}%${R}"
  gauge "${rl_7d_int}" "$_quota_w"
  g7="${T_dim}7d${R} ${GAUGE_BAR} ${ESC}[${GAUGE_C}m${rl_7d_int}%${R}"
  quota_bar="${g5}  ${T_dim}│${R}  ${g7}"
fi

# ── Burn-rate speedometer (L1) ────────────────────────────────────────────────
# Samples binding quota %/min; answers: will I hit rotation before 5h resets?
pace_badge=""
if [ -n "$rl_5h" ] || [ -n "$rl_7d" ]; then
  q5=${rl_5h_int}; q7=${rl_7d_int}
  qpick=$q5; [ "$q7" -gt "$qpick" ] && qpick=$q7
  burn_file="/tmp/claude-burn-${account_email:-default}"
  rate10=0
  if [ -s "$burn_file" ]; then
    IFS=' ' read -r prev_pct prev_ts < "$burn_file"
    case "${prev_pct}${prev_ts}" in ''|*[!0-9]*) prev_pct=0; prev_ts=0;; esac
    dt=$(( now - prev_ts )); dp=$(( qpick - prev_pct ))
    [ "$dt" -ge 20 ] && [ "$dp" -gt 0 ] && rate10=$(( dp * 600 / dt ))
  fi
  [ ! -s "$burn_file" ] || [ $(( now - $(mtime "$burn_file") )) -ge 20 ] && \
    printf '%s %s' "$qpick" "$now" > "$burn_file" 2>/dev/null
  reset_min=0
  case "$rl_5h_reset" in ''|*[!0-9]*) ;;
    *) [ "$rl_5h_reset" -gt "$now" ] && reset_min=$(( (rl_5h_reset - now) / 60 )) ;; esac
  if [ "$qpick" -ge 90 ]; then
    pace_badge="${T_danger}🔴 rotating${R}"
  elif [ "$rate10" -le 0 ]; then
    pace_badge="${T_dim}▪ idle${R}"
  else
    dist=$(( 90 - qpick )); [ "$dist" -lt 0 ] && dist=0
    eta_rot=$(( dist * 10 / rate10 ))
    r1=$(( rate10 / 10 )); r2=$(( rate10 % 10 ))
    if [ "$reset_min" -gt 0 ] && [ "$eta_rot" -lt "$reset_min" ]; then
      pace_badge="${T_danger}🔥 ${r1}.${r2}%/m rot~${eta_rot}m${R}"
    elif [ "$rate10" -ge 20 ]; then
      pace_badge="${T_warn}▲ ${r1}.${r2}%/m${R}"
    else
      pace_badge="${T_ok}▸ ${r1}.${r2}%/m${R}"
    fi
  fi
fi

# ── Account → next-rotation arrow (L1) ───────────────────────────────────────
account_arrow=""
if [ -n "$account_email" ]; then
  a=$(acct_alias "$account_email")
  if [ -n "${next_email:-}" ] && [ "$next_email" != "$account_email" ]; then
    account_arrow="${T_dim}${a}${R}${T_dim}→$(acct_alias "$next_email")${R}"
  else
    account_arrow="${T_dim}${a}${R}"
  fi
  [ "$sessions_n" -gt 1 ] && account_arrow="${account_arrow}${T_acc}×${sessions_n}${R}"
fi

# ── System metrics (L2) ───────────────────────────────────────────────────────
if [ -r /proc/loadavg ]; then
  load1=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)
  ncpu=$(nproc 2>/dev/null || echo 4)
  ram_free_g=$(awk '/MemAvailable/{printf "%.0f", $2/1048576}' /proc/meminfo 2>/dev/null)
else
  load1=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')
  ncpu=$(sysctl -n hw.ncpu 2>/dev/null || echo 8)
  pagesz=$(sysctl -n hw.pagesize 2>/dev/null || echo 16384)
  ram_free_g=$(vm_stat 2>/dev/null | awk -v ps="$pagesz" '/Pages (free|inactive|speculative)/{gsub(/\./,"",$NF); s+=$NF} END{printf "%.0f", s*ps/1073741824}')
fi
df_free_g=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{printf "%.0f", $4/1048576}')
disk_pct=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
case "$disk_pct" in *[!0-9]*|'') disk_pct=0;; esac
load_int=${load1%%.*}; case "$load_int" in *[!0-9]*|'') load_int=0;; esac
cpu_pct=$(awk -v l="${load1:-0}" -v n="${ncpu:-4}" 'BEGIN{printf "%.0f", (l/n)*100}')

sys_part=""
if [ "$CFG_sys_cpu" = "1" ]; then
  ld_col="$T_dim"
  [ "$cpu_pct" -ge 70 ] && ld_col="$T_warn"
  [ "$cpu_pct" -gt 100 ] && ld_col="$T_danger"
  sys_part="${ld_col}cpu${cpu_pct}%${R}"
fi
if [ "$CFG_sys_ram" = "1" ]; then
  ram_col="$T_dim"
  case "$ram_free_g" in ''|*[!0-9]*) ;; *) [ "$ram_free_g" -lt 2 ] && ram_col="$T_danger";; esac
  sys_part="${sys_part:+$sys_part }${ram_col}ram${ram_free_g:-?}G${R}"
fi
if [ "$CFG_sys_disk" = "1" ]; then
  sys_part="${sys_part:+$sys_part }${T_dim}df${df_free_g:-?}G${R}"
fi

# Discrete warning badges (only appear past threshold):
load_warn=""
[ "$load_int" -gt "${ncpu:-4}" ] && load_warn="${T_danger}🔥 load${load1}${R}"
disk_warn=""
[ "$disk_pct" -ge 90 ] && disk_warn="${T_danger}💾 ${disk_pct}%${R}"

# ── Slow-cache (60s TTL): global ops badges read from daemon output files ─────
slow_cache="/tmp/claude-statusline-slow-${uid}"
if [ -s "$slow_cache" ] && [ $(( now - $(mtime "$slow_cache") )) -lt 60 ]; then
  . "$slow_cache" 2>/dev/null
else
  ops_global=""
  ops_dir="$HOME/.claude/plugins/data/ops-ops-marketplace/cache"
  # Unread email count (briefing cache)
  bf="$ops_dir/briefing.json"
  if [ -s "$bf" ] && [ $(( now - $(mtime "$bf") )) -lt 7200 ]; then
    unread=$(jq -r '.email.unread_count // 0' "$bf" 2>/dev/null)
    case "$unread" in *[!0-9]*|'') unread=0;; esac
    [ "$unread" -gt 0 ] && ops_global="${ops_global}${T_acc}📬 ${unread}${R} "
  fi
  # Projects needing attention
  ph="$ops_dir/projects_health.json"
  if [ -s "$ph" ] && [ $(( now - $(mtime "$ph") )) -lt 7200 ]; then
    attn=$(jq -r '(.summary.needs_attention // 0) + (.summary.blocked // 0)' "$ph" 2>/dev/null)
    case "$attn" in *[!0-9]*|'') attn=0;; esac
    [ "$attn" -gt 0 ] && ops_global="${ops_global}${T_warn}🚧 ${attn}${R} "
  fi
  ops_global="${ops_global% }"

  # Per-project badge groups from config
  # For each project in config, read its badge file from the ops cache dir.
  # Badge file: $ops_dir/project-<key>.json — daemon precomputes it.
  # Generic schema: { "badges": [ { "icon": "◉", "value": "3/3", "color": "ok|warn|danger|dim" } ] }
  proj_badges=""
  if [ "${CFG_proj_count:-0}" -gt 0 ] 2>/dev/null; then
    for _pk in $CFG_proj_keys; do
      _pbf="$ops_dir/project-${_pk}.json"
      if [ -s "$_pbf" ] && [ $(( now - $(mtime "$_pbf") )) -lt 7200 ]; then
        _label=$(jq -r '.label // ""' "$_pbf" 2>/dev/null)
        _bdgs=$(jq -r '(.badges // []) | map(
          if .color == "ok" then "[32m"
          elif .color == "warn" then "[33m"
          elif .color == "danger" then "[1;31m"
          else "[38;5;245m" end
          + (.icon // "") + " " + (.value // "") + "[0m"
        ) | join(" ")' "$_pbf" 2>/dev/null)
        if [ -n "$_bdgs" ]; then
          _pgrp="${T_acc}${_label:-$_pk}${R} ${_bdgs}"
          proj_badges="${proj_badges}${_pgrp}${SEP_PB}"
        fi
      fi
    done
  fi

  esc1() { printf '%s' "$1" | sed "s/'/'\\\\''/g"; }
  printf "ops_global='%s'\nproj_badges='%s'\n" "$(esc1 "$ops_global")" "$(esc1 "$proj_badges")" \
    > "$slow_cache" 2>/dev/null
fi

# ── Fleet badges (L2) — bg agents, rotation, SDK fallback ────────────────────
line2_fleet=""
if [ "$CFG_fleet_bg" = "1" ]; then
  bg_cache="/tmp/claude-bgcount-${uid}"
  bg_ttl=30
  bg_age=$(( now - $(mtime "$bg_cache") ))
  bg_counts=$(async_cache "$bg_cache" "$bg_ttl" sh -c 'claude agents --json 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(len([a for a in d if a.get(\"status\")==\"running\"]), len(d))
except Exception:
    print(0,0)"')
  IFS=' ' read -r bg_running bg_total <<EOF
$bg_counts
EOF
  : "${bg_running:=0}"; : "${bg_total:=0}"
  if [ "${bg_running:-0}" -gt 0 ] 2>/dev/null; then
    line2_fleet="${line2_fleet}${line2_fleet:+${T_dim}│${R}}${T_acc}🤖${bg_running}/${bg_total}${R}"
  fi
fi

if [ "$CFG_fleet_rot" = "1" ]; then
  rot_state="$rot_dir/state.json"
  if [ -s "$rot_state" ]; then
    active_acct=$(jq -r '.activeAccount // ""' "$rot_state" 2>/dev/null)
    rl_locked=$(jq -r '[.accounts | to_entries[] | select(.value.rateLimited == true or (.value.lastUtilization.pct // 0) >= 90)] | length' "$rot_state" 2>/dev/null)
    if [ -n "$active_acct" ]; then
      rc="${T_ok}"; [ "${rl_locked:-0}" -gt 0 ] && rc="${T_warn}"
      rot_badge="${rc}🔄$(acct_alias "$active_acct")${R}"
      [ "${rl_locked:-0}" -gt 0 ] && rot_badge="${rot_badge}${T_dim}⚡${rl_locked}${R}"
      line2_fleet="${line2_fleet}${line2_fleet:+${T_dim}│${R}}${rot_badge}"
    fi
  fi
fi

if [ "$CFG_fleet_sdk" = "1" ]; then
  sdk_flag="$HOME/.claude/state/quota-fallback/sdk-mode.active"
  sdk_spend="$HOME/.claude/state/quota-fallback/sdk-usage.log"
  if [ -f "$sdk_flag" ]; then
    sdk_turns=$(grep -c . "$sdk_spend" 2>/dev/null || echo 0)
    line2_fleet="${line2_fleet}${line2_fleet:+${T_dim}│${R}}${T_warn}⚠${sdk_turns}${R}"
  fi
fi

# Cache-refresh countdown
if [ "$CFG_fleet_cache" = "1" ] && [ -n "$line2_fleet" ]; then
  refresh_left=$(( ${bg_ttl:-30} - ${bg_age:-0} ))
  [ "$refresh_left" -lt 0 ] && refresh_left=0
  line2_fleet="${line2_fleet} ${T_dim}↻${refresh_left}s${R}"
fi

# ── Current project detection from cwd ───────────────────────────────────────
cur_proj=""
if [ "${CFG_proj_count:-0}" -gt 0 ] 2>/dev/null && [ -n "$_cfg_file" ]; then
  cwd_lc=$(printf '%s' "$cwd" | tr '[:upper:]' '[:lower:]')
  # Check each configured project's match substring
  for _pk in $CFG_proj_keys; do
    _match=$(jq -r --arg k "$_pk" '.projects[] | select(.key==$k) | .match // ""' "$_cfg_file" 2>/dev/null)
    case "$cwd_lc" in
      *"$_match"*) cur_proj="$_pk"; break ;;
    esac
  done
fi

# ── SEP for carousel pool ─────────────────────────────────────────────────────
SEP=$(printf '\037')

# ── Carousel pool (L2) ────────────────────────────────────────────────────────
# Rotates every $CFG_carousel_sec seconds (epoch-based, sessions stay in sync).
cpool=""
for x in "$cost_part" "$lines_part" "$rl_part"; do
  [ -n "$x" ] && cpool="${cpool}${SEP}${x}"
done
[ -n "$ops_global" ] && cpool="${cpool}${SEP}${ops_global}"

# Per-project badge groups NOT matching the current project go in carousel too
if [ -n "$proj_badges" ]; then
  _oIFS=$IFS; IFS=$(printf '\035')
  set -f
  for _pg in $proj_badges; do
    [ -n "$_pg" ] && cpool="${cpool}${SEP}${_pg}"
  done
  set +f; IFS=$_oIFS
fi

carousel_slot=""
cpool=${cpool#"$SEP"}
if [ -n "$cpool" ]; then
  cn=0; _oIFS=$IFS; IFS=$SEP; set -f
  for c in $cpool; do cn=$(( cn + 1 )); done
  if [ "$cn" -gt 0 ]; then
    pick=$(( (now / CFG_carousel_sec) % cn )); i=0
    for c in $cpool; do
      [ "$i" -eq "$pick" ] && { carousel_slot="$c"; break; }
      i=$(( i + 1 ))
    done
  fi
  set +f; IFS=$_oIFS
fi

# ── Width-limited line packer ─────────────────────────────────────────────────
# Greedy: takes segments, packs with " │ " dividers until $cols is exhausted.
# Never truncates mid-segment; overflow is silently dropped.
pack_line() {
  # $1 = max width; remaining args = segments (may be empty, skipped)
  _max=$1; shift
  _out=""; _used=0; _div="  ${T_dim}│${R}  "
  _div_w=4  # "  |  " = 4 visible chars
  for _seg; do
    [ -z "$_seg" ] && continue
    _sw=$(vis_width "$_seg")
    if [ -z "$_out" ]; then
      [ $(( _used + _sw )) -le "$_max" ] && { _out="$_seg"; _used=$(( _used + _sw )); }
    else
      [ $(( _used + _div_w + _sw )) -le "$_max" ] && {
        _out="${_out}${_div}${_seg}"
        _used=$(( _used + _div_w + _sw ))
      }
    fi
  done
  printf '%s' "$_out"
}

# ── Line 3 — per-project rotate ───────────────────────────────────────────────
# One project per tick (15s), cycling through configured project badge groups.
line3=""
if [ "${CFG_proj_count:-0}" -gt 0 ] 2>/dev/null && [ -n "$proj_badges" ]; then
  pn=0; _oIFS=$IFS; IFS=$(printf '\035')
  set -f
  for _pg in $proj_badges; do [ -n "$_pg" ] && pn=$(( pn + 1 )); done
  set +f; IFS=$_oIFS
  if [ "$pn" -gt 0 ]; then
    pslot=$(( (now / CFG_carousel_sec) % pn )); pi=0
    _oIFS=$IFS; IFS=$(printf '\035'); set -f
    for _pg in $proj_badges; do
      [ -z "$_pg" ] && continue
      [ "$pi" -eq "$pslot" ] && { line3="$_pg"; break; }
      pi=$(( pi + 1 ))
    done
    set +f; IFS=$_oIFS
  fi
fi
# Fall back to just the cpool carousel if no project badges configured
[ -z "$line3" ] && line3="$carousel_slot"

# ── Assemble Line 1 (cockpit instruments) ────────────────────────────────────
line1=$(pack_line "$cols" "$ctx_bar" "$quota_bar" "$pace_badge" "$cache_badge" "$plan_badge" "$account_arrow")

# ── Assemble Line 2 (session + system + fleet + carousel) ────────────────────
if [ "$cols" -lt 80 ]; then
  # Narrow: single rotating metric
  pool2=""
  for p in "$model_part" "$git_part" "$tasks_part" "${rl_short:-$rl_part}" "$cost_part" "$lines_part"; do
    [ -n "$p" ] && pool2="${pool2}${SEP}${p}"
  done
  pool2=${pool2#"$SEP"}
  if [ -n "$pool2" ]; then
    pn=0; _oIFS=$IFS; IFS=$SEP; set -f
    for p in $pool2; do pn=$(( pn + 1 )); done
    if [ "$pn" -gt 0 ]; then
      ps=$(( (now / CFG_carousel_sec) % pn )); pi=0; chosen=""
      for p in $pool2; do
        [ "$pi" -eq "$ps" ] && { chosen="$p"; break; }
        pi=$(( pi + 1 ))
      done
      set +f; IFS=$_oIFS
      line2=$(pack_line "$cols" "$loc_badge" "$chosen")
    else
      set +f; IFS=$_oIFS
      line2=$(pack_line "$cols" "$loc_badge" "$plan_short")
    fi
  else
    line2=$(pack_line "$cols" "$loc_badge" "$plan_short")
  fi
else
  # Wide: loc + model + git + tasks + project_slot + fleet + sys + carousel
  proj_slot=""
  if [ -n "$cur_proj" ] && [ -n "$proj_badges" ]; then
    _oIFS=$IFS; IFS=$(printf '\035'); set -f
    for _pg in $proj_badges; do
      [ -z "$_pg" ] && continue
      # match by prefix (label is first word)
      _plabel=$(jq -r --arg k "$cur_proj" '.projects[] | select(.key==$k) | .label // .key' "$_cfg_file" 2>/dev/null)
      case "$_pg" in *"${_plabel:-$cur_proj}"*) proj_slot="$_pg"; break;; esac
    done
    set +f; IFS=$_oIFS
  fi
  line2=$(pack_line "$cols" "$loc_badge" "$model_part" "$git_part" "$tasks_part" \
    "${agents_part}" "${proj_slot}" "${line2_fleet}" "${sys_part}" \
    "${load_warn}" "${disk_warn}" "${carousel_slot}")
fi

# ── Output ────────────────────────────────────────────────────────────────────
# Always emit line1 and line2 (guaranteed non-empty: at minimum the plan badge).
# Line3 only when it has content (project badges or carousel).
if [ -n "$line3" ] && [ "$line3" != "$carousel_slot" ] 2>/dev/null; then
  line3_out=$(pack_line "$cols" "$line3")
  printf '%s\n%s\n%s' "$line1" "$line2" "$line3_out"
else
  printf '%s\n%s' "$line1" "$line2"
fi
