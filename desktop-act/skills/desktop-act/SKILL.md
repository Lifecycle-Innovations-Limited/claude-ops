---
name: desktop-act
description: "Cross-OS computer-use MCP: multi-agent exclusive desktop leases, Xvnc pool on Linux, single-session macOS, limited Windows. Use for GUI/desktop automation and concurrent agent desktops."
---

# desktop-act

Computer-use primitives via `mcp__desktop-act__*` plus `act(goal)` (OAuth, no API key).

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
- Linux: X11 + Xvnc/websockify pool (`:50`–`:99`), file-locked leases.
- macOS: single real session (Screen Sharing bridge optional).
- Windows: server starts; native click/type limited — prefer browser tools.

## Watching the desktop

Pool session returns `novnc_url` (e.g. `http://localhost:6082`). Host default
display (often `:1`) is separate and is never reaped by the idle reaper.

## When to use

| Task | Approach |
|------|----------|
| Browser dashboard with auth (Stripe/Vercel/AWS/etc) | Prefer `mcp__kapture__*` (Sam's real Chrome) |
| Local app you need to click/type into | `desktop-act` primitives |
| Generic public site automation | `mcp__playwright__*` |
| Perf/console/Lighthouse | `mcp__chrome-devtools__*` |
| "Just do it" hands-off | `mcp__desktop-act__act(goal)` |

See `~/.claude/skills-library/browser-automation.md` for the full decision tree.
