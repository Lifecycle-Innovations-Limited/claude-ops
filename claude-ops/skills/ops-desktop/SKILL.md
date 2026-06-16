---
name: ops-desktop
description: Autonomous desktop + browser control via the desktop-act MCP companion. Acquires an isolated noVNC desktop session, takes screenshots, clicks, types, scrolls, and runs the optional autonomous act() loop. First run auto-bootstraps the desktop-act server into a per-user cache.
argument-hint: "[goal text | 'status' | 'list' | 'release [session_id]']"
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
  - ToolSearch
  - mcp__desktop-act__acquire_desktop
  - mcp__desktop-act__release_desktop
  - mcp__desktop-act__list_desktops
  - mcp__desktop-act__list_windows
  - mcp__desktop-act__launch_app
  - mcp__desktop-act__screenshot
  - mcp__desktop-act__observe
  - mcp__desktop-act__click
  - mcp__desktop-act__keypress
  - mcp__desktop-act__type_text
  - mcp__desktop-act__scroll
  - mcp__desktop-act__act
  - mcp__desktop-act__act_step
  - mcp__desktop-act__batch
  - mcp__desktop-act__status
effort: medium
maxTurns: 40
---

# OPS ► DESKTOP

`/ops:desktop` drives a real GUI desktop (Linux noVNC pool, partial macOS / Windows support) through the `desktop-act` FastMCP server. Use it for tasks that browser-only automation can't reach: native dialogs, OS file pickers, multi-window flows, screen-recording verification.

The MCP tool schemas are **deferred**. Load them with `ToolSearch` on demand:

```
ToolSearch select:mcp__desktop-act__acquire_desktop,mcp__desktop-act__screenshot,mcp__desktop-act__click,mcp__desktop-act__type_text,mcp__desktop-act__release_desktop
```

## Runtime Context

Before any route runs, resolve:

1. **Plugin root**: `${CLAUDE_PLUGIN_ROOT}` — used to locate the launcher.
2. **MCP launcher**: `${CLAUDE_PLUGIN_ROOT}/mcp-servers/desktop-act-launcher.py` — auto-discovers an installed desktop-act marketplace or, if absent, clones from `$DESKTOP_ACT_REPO` (default `https://github.com/your-org/desktop-act.git`) and bootstraps a venv on first run.
3. **noVNC default**: `http://<box-host>:6081` — primary desktop. `acquire_desktop()` provisions extra sessions on `:6082+`.
4. **Mobile / SSH mode**: if `$SSH_CONNECTION`, `$SSH_CLIENT`, or `$SSH_TTY` is set, emit compact text-only output per Rule 7 (no banners, no tables, plain lines). The noVNC URL is the one piece the user definitely needs — print it once on a copy-able line.

## Routing table

Parse `$ARGUMENTS` and route. First token decides:

| First arg          | Route                                                                           |
| ------------------ | ------------------------------------------------------------------------------- |
| (empty) / `status` | Print MCP status, default noVNC URL, active sessions, and platform support note |
| `list`             | `mcp__desktop-act__list_desktops` — show pool state                             |
| `release <id>`     | `mcp__desktop-act__release_desktop(session_id)` — free a session                |
| `release-all`      | Release every session this skill has open this turn                             |
| anything else      | Treat as a **goal** — acquire → observe → drive → verify → release              |

Anything else: treat the whole argument string as the goal.

---

## Route — `status` (default)

1. Probe the MCP via `mcp__desktop-act__status` (auto-load schema first).
2. Print compact summary — plugin connected? venv ready? pool size? default URL?
3. If the MCP is **not reachable**, the launcher likely needs to bootstrap. Show:
   - one-line install command (`/plugin marketplace add <repo> && /plugin install desktop-act`)
   - or the env override (`export DESKTOP_ACT_COMMAND=/path/to/run.sh`)
   - or the bootstrap repo (`export DESKTOP_ACT_REPO=https://...`)
4. Mobile/SSH mode: drop banners, output 4–6 plain lines.

## Route — `list`

```
ToolSearch select:mcp__desktop-act__list_desktops
```

Call it. Format as `session_id · display · vnc · last_used`. Linux only renders full info; macOS/Windows fall back to a "limited platform" note.

## Route — `release <id>` / `release-all`

Per Rule 5 (destructive actions): `release_desktop` tears down the X server. Ask before bulk release:

```
AskUserQuestion: Release session abcd1234?
  [Release]  [Skip]
```

For `release-all`, batch confirm once.

---

## Route — **goal** (default for free-form $ARGUMENTS)

The autonomous loop. Use this when the owner types `/ops:desktop open the AWS console and screenshot the ECS cluster page`.

### Step 1 — Acquire

```python
# Load schemas
ToolSearch select:mcp__desktop-act__acquire_desktop,mcp__desktop-act__screenshot,...

session = mcp__desktop-act__acquire_desktop()
session_id = session["session_id"]
display    = session["display"]      # e.g. ":51"
novnc_url  = session["novnc_url"]    # e.g. http://host:6082
```

Print the noVNC URL on a line by itself so the user can watch live. On mobile, the URL is the most useful thing — surface it FIRST.

### Step 2 — Observe

```python
shot = mcp__desktop-act__screenshot(session_id=session_id)
Read(file_path=shot["path"])   # let Claude see the screen
```

If you need window-level metadata before clicking blindly:

```python
windows = mcp__desktop-act__list_windows(session_id=session_id)
```

### Step 3 — Drive

Two modes:

**A. Streaming primitives** — full reasoning visibility, per-action transparency. Preferred for sensitive flows (anything touching credentials, billing pages, destructive UIs).

```python
mcp__desktop-act__launch_app(session_id, app="firefox")
mcp__desktop-act__click(session_id, x=640, y=400)
mcp__desktop-act__type_text(session_id, text="ECS clusters")
mcp__desktop-act__keypress(session_id, key="Return")
mcp__desktop-act__scroll(session_id, direction="down", amount=3)
mcp__desktop-act__screenshot(session_id)   # verify
```

**B. Autonomous loop** — hands the goal to `act()` which runs claude-agent-sdk against the OAuth-bundled CLI (no API key needed; rides Claude Max). Faster but less observable.

```python
result = mcp__desktop-act__act(
    session_id=session_id,
    goal="$ARGUMENTS",
    max_steps=20,
)
```

For multi-step macros, prefer `batch` (single round-trip) or `act_step` (one micro-step at a time with explicit verification).

### Step 4 — Verify

Always `screenshot` and `Read` the path once at the end before claiming the goal is done. If the verification screenshot doesn't show the expected state, iterate or escalate to the user.

### Step 5 — Release

**Always** release in the same turn, even on failure:

```python
mcp__desktop-act__release_desktop(session_id=session_id)
```

If the user wants to keep the session for follow-up actions, ask first via `AskUserQuestion`:

```
Keep session abcd1234 alive for follow-up?
  [Keep]  [Release]
```

---

## Cross-platform notes

| OS      | Status  | Notes                                                               |
| ------- | ------- | ------------------------------------------------------------------- |
| Linux   | Full    | X11 + Xvnc + websockify + python-xlib. Multi-desktop pool live.     |
| macOS   | Partial | Server runs; native X11 calls no-op. Browser tools still work.      |
| Windows | Partial | Server runs via Python launcher. Native automation requires manual. |

On non-Linux platforms, prefer Kapture (`mcp__kapture__*`) or Playwright for browser-only tasks. The launcher prints a clear "limited platform" notice if it can't bring up a full session.

## Safety

- **Outbound comms** (Rule 6): if a goal involves sending email/messages/forms, stage the draft and ask before pressing Send. Per-message approval, never batch.
- **Destructive UI clicks**: anything that says "Delete", "Terminate", "Force quit" routes through `AskUserQuestion` first per Rule 5.
- **Credentials**: never type passwords into a goal string — leave it for the owner to fill in the live noVNC viewer.
- **Session isolation**: each invocation of `/ops:desktop` gets its own `session_id`. Don't pass session IDs between concurrent agents or skills.

## Examples

```
/ops:desktop                                    # status
/ops:desktop list                               # pool state
/ops:desktop release abcd1234                   # free session
/ops:desktop open the AWS ECS console and screenshot the my-project-api cluster
/ops:desktop launch Firefox and navigate to https://finops.lifecycleinnovations.limited
```

## $ARGUMENTS

$ARGUMENTS
