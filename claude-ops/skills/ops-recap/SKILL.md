---
name: ops-recap
description: Manage the multi-session recap marquee daemon — a background process that synthesizes a one-line digest across all parallel Claude Code sessions and shell activity, displayed in tmux status-right. Subcommands status/tail/configure/restart.
argument-hint: "[status|tail|configure|restart]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
effort: low
maxTurns: 12
---

# OPS ► RECAP

The recap marquee is a launchd-managed daemon that aggregates per-session Claude transcripts (via the `recap-capture` Stop hook) and per-tool activity (via the `recap-tool-activity` PostToolUse hook) into a single rolling headline at `/tmp/claude-recap-digest`. Tmux reads that file every refresh interval via `scripts/recap/marquee.sh` and scrolls it across `status-right`.

**Files:**

| Path | Role |
|------|------|
| `${CLAUDE_PLUGIN_ROOT}/scripts/recap/daemon.sh` | Background loop — polls inputs, calls digest.sh when stale |
| `${CLAUDE_PLUGIN_ROOT}/scripts/recap/digest.sh` | Synthesizes one-line digest via `claude -p --model haiku` |
| `${CLAUDE_PLUGIN_ROOT}/scripts/recap/marquee.sh` | Tmux-side scroller (called from `status-right`) |
| `${CLAUDE_PLUGIN_ROOT}/hooks/recap-capture.sh` | Stop hook → writes `/tmp/claude-recap-<sid>` |
| `${CLAUDE_PLUGIN_ROOT}/hooks/recap-tool-activity.sh` | PostToolUse hook → live activity per session |
| `~/Library/LaunchAgents/com.claude-ops.recap-daemon.plist` | Launchd agent (macOS) |
| `/tmp/claude-recap-digest` | Rolling one-liner (read by tmux + marquee.sh) |
| `/tmp/claude-recap-daemon.log` | Daemon log (rotated at 500KB) |
| `/tmp/claude-recap-digest.log` | Last 50 generated digests, chronological |

## Subcommand: `status` (default)

Print a compact health panel:

```bash
PLIST=~/Library/LaunchAgents/com.claude-ops.recap-daemon.plist
LABEL=com.claude-ops.recap-daemon
DIGEST=/tmp/claude-recap-digest
DAEMON_LOG=/tmp/claude-recap-daemon.log

# Plist installed?
if [ -f "$PLIST" ]; then echo "✓ plist installed: $PLIST"; else echo "✗ plist missing"; fi

# Launchd loaded?
launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 \
  && echo "✓ launchd loaded ($LABEL)" \
  || echo "✗ launchd not loaded — run /ops:recap restart"

# Daemon process alive?
if [ -f /tmp/claude-recap-daemon.pid ]; then
  pid=$(cat /tmp/claude-recap-daemon.pid)
  kill -0 "$pid" 2>/dev/null && echo "✓ daemon alive (pid $pid)" || echo "✗ stale pid file"
else
  echo "✗ no pid file"
fi

# Digest freshness
if [ -f "$DIGEST" ]; then
  age=$(($(date +%s) - $(stat -f %m "$DIGEST" 2>/dev/null || stat -c %Y "$DIGEST" 2>/dev/null || echo 0)))
  echo "✓ digest age: ${age}s"
  echo "  preview: $(head -c 120 "$DIGEST")..."
else
  echo "✗ digest file missing — daemon may not have produced one yet"
fi

# Log size
if [ -f "$DAEMON_LOG" ]; then
  bytes=$(stat -f %z "$DAEMON_LOG" 2>/dev/null || stat -c %s "$DAEMON_LOG" 2>/dev/null)
  echo "  log: $DAEMON_LOG (${bytes} bytes)"
fi

# tmux integration?
if command -v tmux >/dev/null 2>&1; then
  if grep -q claude-recap "$HOME/.tmux.conf" 2>/dev/null; then
    echo "✓ tmux status-right wired"
  else
    echo "○ tmux installed but status-right not wired — run /ops:recap configure"
  fi
else
  echo "○ tmux not installed — marquee won't display, daemon still useful for /ops:recap tail"
fi
```

## Subcommand: `tail`

Stream the rolling digest log:

```bash
echo "─── Last 20 generated digests ───"
tail -n 20 /tmp/claude-recap-digest.log 2>/dev/null || echo "(no digest log yet)"
echo
echo "─── Daemon log (tail 30) ───"
tail -n 30 /tmp/claude-recap-daemon.log 2>/dev/null || echo "(no daemon log yet)"
```

## Subcommand: `configure`

Walk the user through tmux integration if not already wired. Detect existing `status-right` first to avoid clobbering.

1. Check tmux availability:

   ```bash
   if ! command -v tmux >/dev/null 2>&1; then
     echo "tmux not installed — recap daemon still runs and you can read /tmp/claude-recap-digest manually."
     exit 0
   fi
   ```

2. Check current `~/.tmux.conf`:

   ```bash
   TMUX_CONF="$HOME/.tmux.conf"
   if grep -q claude-recap "$TMUX_CONF" 2>/dev/null; then
     echo "✓ already configured."
     exit 0
   fi
   existing=$(grep -E '^\s*set\s+-g\s+status-right' "$TMUX_CONF" 2>/dev/null | head -1)
   ```

3. If `existing` is non-empty, `AskUserQuestion`:

   - Question: "Existing tmux status-right detected: `$existing`. Append recap marquee?"
   - Options: `[Append (keep existing)]` `[Replace with recap-only]` `[Skip]`

4. On append: insert the marquee snippet ahead of the existing setting so both render. On replace: comment out the old line and add the new one.

   Snippet to append:

   ```
   # claude-ops recap marquee
   set -g status-right '#(cat /tmp/claude-recap-digest 2>/dev/null | head -c 80) #[fg=#a6e3a1]%H:%M '
   set -g status-interval 2
   ```

5. Reload if tmux is running:

   ```bash
   tmux info >/dev/null 2>&1 && tmux source-file "$TMUX_CONF" 2>/dev/null
   ```

## Subcommand: `restart`

Reload the launchd agent without reconfiguring:

```bash
LABEL=com.claude-ops.recap-daemon
PLIST=~/Library/LaunchAgents/com.claude-ops.recap-daemon.plist
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
rm -rf /tmp/claude-recap-daemon.lock /tmp/claude-recap-daemon.pid
launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "✓ daemon restarted"
```

## Linux / systemd alternative

The launchd plist is macOS-only. Linux users can wrap `scripts/recap/daemon.sh` in a `systemd --user` unit. Minimal example (`~/.config/systemd/user/claude-recap-daemon.service`):

```ini
[Unit]
Description=Claude Ops Recap Daemon
After=default.target

[Service]
Type=simple
ExecStart=/bin/sh %h/.claude/plugins/cache/ops-marketplace/ops/CURRENT/scripts/recap/daemon.sh
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
```

Then `systemctl --user daemon-reload && systemctl --user enable --now claude-recap-daemon`. The CLI subcommands above (status / tail / restart) won't auto-detect systemd — use `systemctl --user status claude-recap-daemon` directly.

## Invocation

`/ops:recap` (alias: shows status). Subcommand parsing:

```bash
sub="${1:-status}"
case "$sub" in
  status|tail|configure|restart) ;;
  *) echo "Unknown subcommand: $sub. Try: status | tail | configure | restart"; exit 1 ;;
esac
```
