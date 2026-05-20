---
name: ops-mcp
description: MCP server health dashboard and reconnect control. Surfaces the watchdog + keepalive + reauth subsystem as a discoverable slash command. Routes — status, servers, reconnect, reauth, logs, restart, test.
argument-hint: "[status|servers|reconnect [server]|reauth [server]|logs [N]|restart|test [server]]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - AskUserQuestion
effort: low
maxTurns: 20
---

# OPS ► MCP

Surfaces the MCP auto-reconnect subsystem (watchdog + keepalive + reauth) as a discoverable slash command. These three scripts were previously orphaned — no plugin-level entry point. This skill is the entry point.

For full architecture reference (state files, scripts, failure modes) see [`STATUS.md`](./STATUS.md).

## Runtime Context

Before any route runs, resolve:

1. **State dir**: `$HOME/.claude/state/mcp-watchdog` — watchdog state, health, and logs.
2. **Keepalive state dir**: `$HOME/.claude/state/mcp-keepalive` — keepalive logs and health.
3. **Reauth state dir**: `$HOME/.claude/state/mcp-reauth` — reauth logs.
4. **Plugin root**: `${CLAUDE_PLUGIN_ROOT}` — used to invoke scripts.
5. **Claude config**: `$HOME/.claude.json` — source of truth for configured MCP servers.

If the watchdog state dir does not exist, the watchdog has never run — surface a setup hint on the `status` route.

## Routing table

Parse `$ARGUMENTS` and route immediately. First token decides the route.

| First arg               | Route                                                                         |
| ----------------------- | ----------------------------------------------------------------------------- |
| (empty) / `status`      | **Status dashboard** — watchdog health + per-server states + last tick        |
| `servers`               | List all MCP servers from `~/.claude.json` with current state                 |
| `reconnect [server]`    | Manually trigger watchdog reconnect for one server or all                     |
| `reauth [server]`       | Invoke `ops-mcp-reauth.py` for the named server (Playwright OAuth flow)       |
| `logs [N]`              | Tail N lines (default 50) of watchdog + keepalive logs                        |
| `restart`               | Restart the watchdog (update crontab entry)                                   |
| `test [server]`         | Fire a no-op MCP probe against one server to verify reachability              |

Anything else: print the routing table and exit.

---

## Route — `status` (default)

Read state files in parallel, render a compact dashboard.

```bash
WATCHDOG_STATE="$HOME/.claude/state/mcp-watchdog"
KEEPALIVE_STATE="$HOME/.claude/state/mcp-keepalive"

# Watchdog health file
cat "$WATCHDOG_STATE/.health" 2>/dev/null

# Current server states (last watchdog run)
cat "$WATCHDOG_STATE/state.json" 2>/dev/null

# Last run timestamp from log
tail -n 5 "$WATCHDOG_STATE/run.log" 2>/dev/null

# Keepalive health
cat "$KEEPALIVE_STATE/.health" 2>/dev/null

# Crontab entry (to confirm watchdog is scheduled)
crontab -l 2>/dev/null | grep -E "ops-mcp-(watchdog|keepalive)"
```

**Output format:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► MCP — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DAEMONS
  watchdog     [running|never_run]    last tick [Xs ago]   cron [registered|missing]
  keepalive    [ok|warn|never_run]    last tick [Xs ago]

SERVERS ([N] configured)
  [name]       [healthy|token_expired|needs_bootstrap|unreachable|server_error]
               url=[masked — scheme+host only]   last_probed=[Xs ago]

SUMMARY
  healthy=[N] degraded=[N] needs_bootstrap=[N]

LAST RECONNECT ACTIVITY
  [last 3 lines from run.log showing recovered/degraded events]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Mobile mode** (`$SSH_CONNECTION` set, `$OPS_MOBILE=1`, or `$COLUMNS<80`):

```
mcp: watchdog ok, keepalive ok, 5m ago
servers: 4 healthy, 1 needs_bootstrap (giga)
cron: registered
```

After dashboard: if any server is `needs_bootstrap`, surface a one-line hint: "Run `/ops:mcp reauth <name>` to restore OAuth." No `AskUserQuestion` unless something requires a binary choice.

---

## Route — `servers`

List every MCP server from `~/.claude.json` cross-referenced with the last watchdog `state.json`.

```bash
# Parse ~/.claude.json for all mcpServers entries
python3 -c "
import json, os
d = json.load(open(os.path.expanduser('~/.claude.json')))
servers = d.get('mcpServers') or {}
for name, cfg in servers.items():
    print(json.dumps({'name': name, 'type': cfg.get('type','stdio'), 'url': cfg.get('url',''), 'command': cfg.get('command','')}))
"

# Cross-reference with watchdog state
cat "$HOME/.claude/state/mcp-watchdog/state.json" 2>/dev/null
```

Format per server:

```
[name]
  type:     [http|stdio]
  url/cmd:  [masked url or command path]
  state:    [healthy|token_expired|needs_bootstrap|unreachable|not_probed]
  probed:   [ISO timestamp or "never"]
  detail:   [detail field if not healthy]
```

---

## Route — `reconnect [server]`

Manually triggers the watchdog for one server or all. The watchdog already handles auto-refresh; this forces an immediate out-of-schedule run.

```bash
WATCHDOG="${CLAUDE_PLUGIN_ROOT}/scripts/ops-mcp-watchdog.py"

if [[ -n "$SERVER_ARG" ]]; then
  # Single server: set env to probe only that URL
  URL=$(python3 -c "
import json, os, sys
d = json.load(open(os.path.expanduser('~/.claude.json')))
s = (d.get('mcpServers') or {}).get(sys.argv[1], {})
print(s.get('url', ''))
" "$SERVER_ARG")
  MCP_KEEPALIVE_URLS="$URL" python3 "$WATCHDOG"
else
  # All servers
  python3 "$WATCHDOG"
fi
```

Print the exit code and last 5 lines of `run.log` on completion.

---

## Route — `reauth [server]`

Invokes `ops-mcp-reauth.py` (Playwright headless OAuth flow) for the named server. If no server is named, list `needs_bootstrap` servers and `AskUserQuestion` which to reauth.

```bash
REAUTH="${CLAUDE_PLUGIN_ROOT}/scripts/ops-mcp-reauth.py"

# Resolve URL for the named server
URL=$(python3 -c "
import json, os, sys
d = json.load(open(os.path.expanduser('~/.claude.json')))
s = (d.get('mcpServers') or {}).get(sys.argv[1], {})
print(s.get('url', ''))
" "$SERVER_ARG")

if [[ -z "$URL" ]]; then
  echo "Server '$SERVER_ARG' not found or has no URL (stdio servers cannot be reauthed this way)"
  exit 1
fi

python3 "$REAUTH" "$URL"
```

On exit 0: confirm tokens were written, suggest running `/ops:mcp test <server>` to verify.
On exit 1: the consent page required a login the browser profile didn't have. Surface the bootstrap hint: `python3 $REAUTH --bootstrap` opens a headed browser for one-time sign-in.

---

## Route — `logs [N]`

Tail the most recent N lines (default 50) from watchdog, keepalive, and reauth logs.

```bash
N="${LOG_N:-50}"
WATCHDOG_LOG="$HOME/.claude/state/mcp-watchdog/run.log"
KEEPALIVE_LOG="$HOME/.claude/state/mcp-keepalive/run.log"
REAUTH_LOG="$HOME/.claude/state/mcp-reauth/run.log"

echo "=== watchdog (last $N) ==="
tail -n "$N" "$WATCHDOG_LOG" 2>/dev/null || echo "(no log)"

echo ""
echo "=== keepalive (last $N) ==="
tail -n "$N" "$KEEPALIVE_LOG" 2>/dev/null || echo "(no log)"

echo ""
echo "=== reauth (last $N) ==="
tail -n "$N" "$REAUTH_LOG" 2>/dev/null || echo "(no log)"
```

---

## Route — `restart`

Ensures both `ops-mcp-watchdog.py` (cron `*/5`) and `ops-mcp-keepalive.sh` (cron `*/15`) are in the user's crontab. Does NOT remove existing entries — adds if missing.

```bash
WATCHDOG="${CLAUDE_PLUGIN_ROOT}/scripts/ops-mcp-watchdog.py"
KEEPALIVE="${CLAUDE_PLUGIN_ROOT}/scripts/ops-mcp-keepalive.sh"

# Idempotent crontab injection
TMPFILE=$(mktemp)
crontab -l 2>/dev/null > "$TMPFILE" || true

if ! grep -q "ops-mcp-watchdog" "$TMPFILE"; then
  echo "*/5 * * * * /opt/homebrew/bin/python3 $WATCHDOG >> $HOME/.claude/state/mcp-watchdog/run.log 2>&1" >> "$TMPFILE"
  echo "Added watchdog cron entry"
fi

if ! grep -q "ops-mcp-keepalive" "$TMPFILE"; then
  echo "*/15 * * * * bash $KEEPALIVE >> $HOME/.claude/state/mcp-keepalive/run.log 2>&1" >> "$TMPFILE"
  echo "Added keepalive cron entry"
fi

crontab "$TMPFILE"
rm "$TMPFILE"
echo "Crontab updated. Verify with: crontab -l | grep ops-mcp"
```

---

## Route — `test [server]`

Fire a direct JSON-RPC `initialize` probe at the named server (or all) using the same logic as the watchdog.

```bash
python3 - "$SERVER_ARG" <<'PY'
import json, os, sys
from pathlib import Path

# Import probe logic from watchdog
import importlib.util
wp = Path(os.environ.get("CLAUDE_PLUGIN_ROOT", "")) / "scripts/ops-mcp-watchdog.py"
spec = importlib.util.spec_from_file_location("watchdog", wp)
wdog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wdog)

target = sys.argv[1] if len(sys.argv) > 1 else None
mcps = wdog.list_http_mcps()
if not mcps:
    print("No HTTP MCPs configured")
    sys.exit(0)

for name, url in mcps.items():
    if target and name != target:
        continue
    r = wdog.probe(url, name)
    print(f"{name}: {r['state']}" + (f" — {r.get('detail','')}" if r.get('detail') else ""))
PY
```

Print result per server. On `healthy`: confirm reachable. On any other state: describe the failure and suggest the remediation route (`/ops:mcp reauth <name>` or `/ops:mcp reconnect <name>`).
