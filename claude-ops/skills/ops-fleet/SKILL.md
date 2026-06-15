---
name: ops-fleet
description: Read-only fleet dashboard — every Claude session (local + remote) with token type (oauth/api/bedrock/crs), CRS relay state, account utilization, and per-session detail. No actions.
argument-hint: '[--once] [--tui] [--all] [--no-color] [--no-ec2]'
allowed-tools:
  - Bash
  - Read
effort: low
maxTurns: 6
---

# OPS ► FLEET

Unified, read-only dashboard over the whole Claude session fleet — local `claude --bg`
sessions plus any remote box reached over SSM — built from `claude agents --json`,
`claude daemon status`, the account-rotation daemon state, and the CRS (Claude Relay
Service) relay. It renders, it never mutates.

## Runtime Context

The dashboard sources everything live; nothing needs to be parsed by this skill:

- **Sessions**: `claude agents --json` (authoritative; nameless sessions fall back to their session id).
- **CRS relay**: health at `http://127.0.0.1:${CRS_PORT:-3005}/health`, allowlist at
  `~/.claude/scripts/account-rotation/crs-allowlist.json`, recent 429/529 from the relay window.
- **Account pool**: the rotation daemon's keychain/util state (per-account util%, reset countdown).
- **Remote (EC2/FRA) sessions**: a background-refreshed SSM cache (`~/.claude/state/fleet-ec2.json`,
  TTL ~45s); degrades to `refreshing…` / empty when unavailable.

These paths are the standard account-rotator install locations
(`scripts/install-account-rotator-linux.sh`). If the rotator isn't installed the CRS /
account / remote rows simply degrade to `?` — the session table still renders.

## Invocation

Run the bin script and relay its output verbatim (strip ANSI for the chat block):

```
${CLAUDE_PLUGIN_ROOT}/bin/ops-fleet $ARGUMENTS
```

Behavior:
- In a real terminal it defaults to a **live full-screen TUI** (alt-screen, adaptive width, `q` to quit).
- With stdout captured (slash command / cron) it auto-falls back to a **one-shot snapshot**.
- Flags: `--once`/`--snapshot` force a single render · `--tui`/`--watch [secs]` force the loop ·
  `--all` include completed sessions · `--no-color` plain · `--no-ec2` skip the remote SSM round-trip.
- Override the CRS port with `CRS_PORT=NNNN` (default 3005; 3000 is the legacy alias).

## Output

ALWAYS render the dashboard to the user first — re-emit the snapshot inside a fenced code
block (keep the box-drawing/bars/layout, strip ANSI). Below it add a one-line summary:
total sessions + token-type breakdown, anything blocked or flapping (high `att:`), CRS
health, and any account ≥90% util. The dashboard is the deliverable; the summary is the footnote.

End with a single line noting the live full-screen TUI is `${CLAUDE_PLUGIN_ROOT}/bin/ops-fleet`
(or `--tui`) in a real terminal.
