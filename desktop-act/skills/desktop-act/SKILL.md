---
name: desktop-act
description: "Cross-OS computer-use MCP: multi-agent exclusive desktop leases, Xvnc pool on Linux, single-session macOS/Windows. Use for GUI/desktop automation and concurrent agent desktops."
---

# desktop-act

Computer-use primitives via `mcp__desktop-act__*` plus `act(goal)` (OAuth via
claude-agent-sdk — no Anthropic API key).

## Multi-agent (required pattern)

```text
ensure_desktop(owner_id="<agent-id>", geometry="2560x1440")  # exclusive seat
# … primitives with session_id …
heartbeat_desktop(session_id)   # long runs
release_desktop(session_id)     # on stop / idle done
```

If another agent holds every free seat, Linux **auto-spawns** a new Xvnc on the
next free display/port. Leases expire (`DESKTOP_ACT_LEASE_TTL`); reaper frees
the lock and **stops pool VNC** so idle seats do not thrash the host.

## Architecture

- Parent agent is the brain — primitives + screenshots, or hands-off `act(goal)`.
- **Linux:** X11 + Xvnc/websockify pool (`:50`–`:99`), file-locked leases.
- **macOS:** single interactive session (Screen Sharing → noVNC optional).
- **Windows:** full WinBackend (ImageGrab + pyautogui/SendInput); single
  interactive desktop only (no multi-seat pool). Needs a logged-in session.

## Watching the desktop

Pool session returns `novnc_url` (port base `DESKTOP_ACT_NOVNC_PORT_BASE`,
default **6082**). Host default display (often `:1`) is separate and is never
reaped by the idle reaper. Always prefer the returned URL over hardcoding ports.

## Install

- **With claude-ops:** `desktop-act@ops-marketplace` (co-installed by `/ops:setup`
  and `/ops:update` via `plugin-dependencies.json`).
- **Standalone:** marketplace add `Lifecycle-Innovations-Limited/desktop-act`,
  then `desktop-act@desktop-act`.

## When to use

| Task | Approach |
|------|----------|
| Local app you need to click/type into | `desktop-act` primitives |
| Concurrent agents needing isolated seats | Linux pool + `ensure_desktop(owner_id=…)` |
| Hands-off goal | `mcp__desktop-act__act(goal, max_iterations=…)` |
| Browser-only automation | Prefer browser MCP tools when no OS UI is required |

## Defaults

- `act` model: `claude-sonnet-5`
- `act` max_iterations: `20` (not `max_steps`)
- Python: `>=3.11`
