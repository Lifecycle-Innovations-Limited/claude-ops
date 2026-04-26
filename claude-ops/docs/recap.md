<div align="center">

# Recap Marquee Daemon

*One-line situational awareness across every parallel Claude Code session, surfaced in tmux `status-right` or the Claude Code `statusLine`.*

[![version](https://img.shields.io/badge/version-2.0.0-blue)](../CHANGELOG.md)
[![daemon](https://img.shields.io/badge/runtime-launchd%20%2F%20systemd-6366f1)](.)
[![cadence](https://img.shields.io/badge/refresh-30s-22c55e)](.)

</div>

---

## What it does

If you run several Claude Code sessions across worktrees, you lose track of which session is doing what. The recap marquee gives you a single line — refreshed every 30 seconds — summarising every active session's latest action.

```
┌ tmux status-right ───────────────────────────────────────────────────────┐
│ [3 sessions] api: editing UserService.ts • web: gh pr merge • db: idle 2m│
└──────────────────────────────────────────────────────────────────────────┘
```

When something *fires* (a deploy-fix dispatched, a safety hook denied, a `/ops:fires` alert) it's flagged with `🔥` and bumped to the front of the line.

---

## Architecture

```
┌─ Claude Code session A (worktree-a) ─┐
│ hooks/recap-tool-activity.sh         │──┐
│ hooks/recap-capture.sh               │  │
└──────────────────────────────────────┘  │
┌─ Claude Code session B (worktree-b) ─┐  │   writes to
│ hooks/recap-tool-activity.sh         │──┼──► $OPS_DATA_DIR/recap/sessions/<sid>.jsonl
│ hooks/recap-capture.sh               │  │
└──────────────────────────────────────┘  │
┌─ Claude Code session C (worktree-c) ─┐  │
│ ...                                  │──┘
└──────────────────────────────────────┘
                                              ▲ tail -f
                                              │
                                ┌─────────────┴─────────────┐
                                │  scripts/recap/daemon.sh  │
                                │  every 30s:               │
                                │   1. read all session     │
                                │      jsonl tails          │
                                │   2. classify & rank      │
                                │   3. write digest         │
                                └─────────────┬─────────────┘
                                              │
                                              ▼
                                ┌──────────────────────────────┐
                                │  scripts/recap/digest.sh     │
                                │  → $OPS_DATA_DIR/recap/digest │
                                └─────────────┬────────────────┘
                                              │
                                              ▼
                                ┌──────────────────────────────┐
                                │  scripts/recap/marquee.sh    │
                                │  formats one-line ANSI       │
                                │  read by tmux status-right   │
                                │  or Claude Code statusLine   │
                                └──────────────────────────────┘
```

---

## Components

| Path | Role |
|------|------|
| `scripts/recap/daemon.sh` | Long-lived loop. Reads session jsonl tails, builds digest. |
| `scripts/recap/digest.sh` | Synthesises the digest (active session count, latest action, fire flags). |
| `scripts/recap/marquee.sh` | Formats one-line ANSI output for tmux/`statusLine`. |
| `hooks/recap-capture.sh` | PostToolUse hook — captures Edit/Write/Bash payloads to per-session jsonl. |
| `hooks/recap-tool-activity.sh` | PostToolUse `*` hook — heartbeat + tool-name log. |
| `templates/com.claude-ops.recap-daemon.plist` | macOS launchd unit. |
| `skills/ops-recap/SKILL.md` | `/ops:recap` user-facing skill. |

---

## Setup

### Automatic (recommended)

```
/ops:setup
```

Step 2d of the wizard:

1. Installs the launchd plist (`~/Library/LaunchAgents/com.claude-ops.recap-daemon.plist`) and `launchctl load`s it.
2. If `tmux` is detected, appends to `~/.tmux.conf`:
   ```
   set -g status-right '#(bash ~/.claude/plugins/installed/ops-ops-marketplace/scripts/recap/marquee.sh) | %H:%M'
   set -g status-interval 5
   ```
3. If no tmux, wires the marquee into the Claude Code `statusLine` in `~/.claude/settings.json`.
4. Verifies the daemon is running and the digest file is fresh.

### Manual (Linux / systemd)

There's no upstream systemd unit shipped (yet — PRs welcome). Use this template:

```ini
# ~/.config/systemd/user/claude-ops-recap.service
[Unit]
Description=claude-ops recap marquee daemon

[Service]
ExecStart=%h/.claude/plugins/installed/ops-ops-marketplace/scripts/recap/daemon.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now claude-ops-recap.service
```

For tmux integration, the same `set -g status-right …` line works on Linux.

---

## `/ops:recap` skill

| Subcommand | Purpose |
|------------|---------|
| `/ops:recap` | Show today's digest as a multi-line summary (richer than the marquee). |
| `/ops:recap status` | Daemon health, last digest age, active session count. |
| `/ops:recap tail` | Tail the daemon log. |
| `/ops:recap configure` | Open `~/.tmux.conf` / `settings.json` for manual tweaks. |
| `/ops:recap restart` | `launchctl unload && load` (or `systemctl restart`). |

---

## Configuration

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `recap_marquee_enabled` | boolean | `true` | Master switch. |
| `recap_marquee_auto_configure_tmux` | boolean | `true` | Append marquee source to `~/.tmux.conf` during setup. |

Disable via `/plugins` settings; then `launchctl unload ~/Library/LaunchAgents/com.claude-ops.recap-daemon.plist` to stop the daemon.

---

## Customisation

The marquee format is controlled by `scripts/recap/marquee.sh`. Override per-user by symlinking your own at `~/.claude/config/recap-marquee.sh`; the daemon prefers user override over plugin default.

Variables available to the marquee script (read from `$OPS_DATA_DIR/recap/digest`):

- `SESSION_COUNT` — active session count.
- `SESSIONS` — newline-delimited `<short-id> <last-action> <idle-secs>`.
- `FIRES` — newline-delimited fire entries (deploy-fix denials, safety-hook blocks, `/ops:fires` alerts).
- `LAST_UPDATED` — Unix timestamp of last digest write.

---

## Troubleshooting

**Marquee shows stale data.** Check the daemon: `/ops:recap status`. If it's not running, `/ops:recap restart`.

**tmux status-right not updating.** Verify `status-interval` is `5` or lower in `~/.tmux.conf`. tmux reloads `status-right` only on this interval.

**Sessions not appearing.** The capture hooks need the plugin's `hooks/hooks.json` to be active in that session. If you spawned the session before installing the plugin, restart it.

**Performance impact.** Each capture write is <1 ms (append-only jsonl). The daemon's 30s loop reads ~10-100 KB total per cycle. Negligible CPU.

---

## See also

- [`docs/deploy-fix.md`](deploy-fix.md) — recap surfaces deploy-fix activity as fires.
- [`docs/safety-hooks.md`](safety-hooks.md) — safety-hook denials surface as fires.
- [`docs/daemon-guide.md`](daemon-guide.md) — the v1 ops-daemon (separate process from recap-daemon).
- [`docs/INDEX.md`](INDEX.md) — full documentation index.
