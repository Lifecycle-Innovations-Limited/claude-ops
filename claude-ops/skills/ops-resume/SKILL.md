---
name: ops-resume
description: Reopen recently-closed Claude Code sessions, one per Ghostty tab. Finds recent session transcripts in ~/.claude/projects and resumes each in its own new tab via `claude --resume`, from the directory it was running in. macOS + Ghostty only.
argument-hint: "[-m minutes | -H hours | -n max | --here | --dry-run]"
allowed-tools:
  - Bash
---

# ops-resume

Reopen recently-closed Claude Code sessions — **one session per Ghostty tab**.

For every recent session transcript under `~/.claude/projects`, the helper opens a
new Ghostty tab (`cmd+t`) and types `cd <cwd> && claude --resume <sessionId>`, so each
session resumes in its own tab from whatever directory or repo it was running in.

**Default:** every session touched in the **last 60 minutes**, from **any directory**.

Platform: macOS + [Ghostty](https://ghostty.org) only. Tabs are driven via AppleScript
System Events, so Accessibility permission must be granted to the terminal running this.

## How it works

1. Scans `~/.claude/projects/**/*.jsonl` and keeps files whose mtime is inside the
   lookback window (default 60 min) but older than `OPS_RESUME_MIN_AGE_SEC` (default
   45s — so the session you are *currently* in is not reopened).
2. Keeps only real interactive sessions (UUID filenames); skips subagent transcripts
   (`agent-*`), workflow journals, and empty/junk sessions.
3. Reads each session's original `cwd` from the transcript.
4. For each, opens a fresh Ghostty tab and resumes the session there.

## Usage

Run the bundled helper. Pass through any flags the user gave (`$ARGUMENTS`).

Always preview first with `--dry-run`, show the user the list, and — unless they
clearly asked to "just open them" — confirm before opening real tabs (opening many
tabs is hard to undo).

```bash
# Preview what would be resumed
${CLAUDE_PLUGIN_ROOT}/bin/ops-resume --dry-run $ARGUMENTS
```

```bash
# Actually open the tabs
${CLAUDE_PLUGIN_ROOT}/bin/ops-resume $ARGUMENTS
```

### Flags

| Flag | Meaning |
|---|---|
| `-m, --minutes N` | Lookback window in minutes (default 60) |
| `-H, --hours N` | Lookback window in hours |
| `-n, --max N` | Cap number of tabs (default 20, newest first) |
| `--here` | Only sessions whose `cwd` == current directory |
| `--dry-run` | List matches, open nothing |

### Env overrides

- `OPS_RESUME_MINUTES` (60) — lookback window
- `OPS_RESUME_MAX` (20) — safety cap on tabs
- `OPS_RESUME_MIN_AGE_SEC` (45) — skip sessions touched more recently than this

## Reporting

After running, report concisely: how many sessions matched, how many tabs were
opened, and any that were capped/skipped. If `--dry-run`, just show the list and ask
whether to open them for real.
