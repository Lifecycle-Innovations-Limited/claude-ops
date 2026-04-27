# Recap Marquee Scripts

Background daemon + helpers that synthesize a one-line digest across all parallel Claude Code sessions and recent shell activity, written to `/tmp/claude-recap-digest`.

| Script | Role |
|--------|------|
| `daemon.sh` | Long-lived loop — polls per-session recap inputs, calls `digest.sh` when stale, writes `/tmp/claude-recap-digest` |
| `digest.sh` | Synthesizes the one-liner via `claude -p --model haiku` over recent sessions + tool-activity files |
| `marquee.sh` | Tmux-side scroller (called from `status-right`) — reads the digest file and emits a windowed slice |

## Display surfaces

The daemon is decoupled from how the digest is displayed. Two surfaces are supported and they can coexist:

### 1. tmux `status-right` (preferred when tmux is present)

`/ops:setup` Step 2d.3 (or `/ops:recap configure`) appends to `~/.tmux.conf`:

```
set -g status-right '#(cat /tmp/claude-recap-digest 2>/dev/null | head -c 80) #[fg=#a6e3a1]%H:%M '
set -g status-interval 2
```

### 2. Claude Code `statusLine` (fallback when tmux is missing)

When `command -v tmux` returns non-zero, `/ops:setup` Step 2d.3b (or `/ops:recap configure`) offers to wire `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "cat /tmp/claude-recap-digest 2>/dev/null | head -c 80",
    "refreshInterval": 30
  }
}
```

The merge is done with `jq` so any existing keys in `settings.json` are preserved. If a `statusLine` already exists, the user is asked whether to replace, append (chain commands so both render), or skip.

This fallback path also works when tmux *is* installed — both surfaces will render the same digest.

### 3. No surface

If neither tmux nor statusLine is wired, the daemon still produces `/tmp/claude-recap-digest`. Read it on demand with `/ops:recap tail` or `cat /tmp/claude-recap-digest`.

## Status checks

`/ops:recap status` reports which surfaces are currently active (tmux status-right, Claude Code statusLine, both, or neither).
