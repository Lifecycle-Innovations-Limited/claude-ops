# desktop-act

> Computer-use primitives + multi-desktop pool + autonomous `act()` loop for
> Claude Code. One MCP server, no API key.

`desktop-act` lets Claude (or any MCP client) drive a desktop: screenshot it,
click, type, scroll, launch apps, run a goal-driven loop. It is **OS-agnostic** —
a backend is selected at startup from `platform.system()`:

- **Linux (`X11Backend`):** python-xlib primitives + a pooled Xvnc/websockify
  backend so you can spin up isolated desktops on demand, each streamed over
  noVNC for live viewing.
- **macOS (`MacBackend`):** `screencapture` for frames, `cliclick`/`osascript`
  for input, and the single real logged-in session (no Xvnc pool). Built-in
  Screen Sharing (VNC :5900) is bridged to noVNC via `websockify` when enabled.
- **Windows (`WinBackend`):** Pillow `ImageGrab` for frames, `pyautogui` (or
  ctypes `SendInput` fallback) for mouse/keyboard, `EnumWindows` for window
  list, `os.startfile` / shell for launch. Single interactive desktop (lease
  model matches macOS — no multi-seat VNC pool).

All tool signatures and return shapes are identical across backends, so callers
never need to know which platform they're on.

Auth path is **Claude CLI OAuth via `claude-agent-sdk`** — costs ride on a
Claude Max subscription, no `ANTHROPIC_API_KEY` needed.

---

## Install

### With claude-ops (recommended)

[`claude-ops`](https://github.com/Lifecycle-Innovations-Limited/claude-ops) ships
this plugin in the same **ops-marketplace** and co-installs it with ops:

```text
/plugin marketplace add Lifecycle-Innovations-Limited/claude-ops
/plugin install ops@ops-marketplace
/plugin install desktop-act@ops-marketplace
# or let /ops:setup and /ops:update run scripts/install-companions.sh
```

The ops `desktop-act-launcher.py` resolves the marketplace checkout first, then
falls back to a per-user cache clone (`$XDG_CACHE_HOME/desktop-act-mcp` on
Linux, `~/Library/Caches/desktop-act-mcp` on macOS, `%LOCALAPPDATA%\desktop-act-mcp`
on Windows) when `$DESKTOP_ACT_REPO` is set.

### Standalone Claude Code plugin

```text
/plugin marketplace add Lifecycle-Innovations-Limited/desktop-act
/plugin install desktop-act@desktop-act
```

### Manual

```bash
git clone https://github.com/Lifecycle-Innovations-Limited/desktop-act.git
# Point your MCP host at desktop-act/mcp-server/run.sh (stdio transport)
```

The first invocation auto-bootstraps a Python venv at `${CLAUDE_PLUGIN_ROOT}/.venv`
(or `$DESKTOP_ACT_VENV` if set) from `requirements.txt` (**Python 3.11+**).

### System dependencies

#### Linux (X11Backend)

You need an X11 stack and a VNC server reachable as `Xvnc` (TigerVNC):

```bash
# Amazon Linux 2023 / RHEL / Fedora
sudo dnf install -y tigervnc-server websockify metacity xterm python3

# Ubuntu / Debian
sudo apt install -y tigervnc-standalone-server websockify metacity xterm python3-venv
```

Optional but recommended: `openbox`, `xdotool`, `firefox`, `nautilus`,
`libreoffice` (whatever GUI apps you want to drive).

#### macOS (MacBackend)

Input is driven by [`cliclick`](https://github.com/BlueM/cliclick); everything
else (`screencapture`, `osascript`, `open`) is built into macOS.

```bash
brew install cliclick
# Optional — for a live noVNC view bridged off built-in Screen Sharing:
brew install websockify   # (or: pip install websockify)
```

**Required macOS permissions** (System Settings → Privacy & Security):

- **Screen Recording** — for `screenshot`/`observe`/`act_step` (the
  `screencapture` capture path). Without it, captures fail with
  `could not create image from display`.
- **Accessibility** — for `click`/`type_text`/`keypress`/`scroll` (the
  `cliclick` and System Events input path).

Grant both to the host process driving the MCP server (your terminal, Claude
Code, etc.). For a live view, optionally enable **Screen Sharing** (System
Settings → General → Sharing → Screen Sharing); `acquire_desktop` still returns
a session without it and surfaces a `vnc_hint`.

#### Windows (WinBackend)

Runs against the **logged-in interactive session** (same machine the MCP host
is on). No Xvnc pool — multi-agent exclusive leases still apply, but there is
only one real desktop (`win-main`).

```powershell
# Python 3.11+ (see pyproject.toml requires-python); venv from requirements.txt
py -3 -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
# pyautogui is installed only on win32 (see requirements marker)
```

**Requirements / limits:**

- An interactive desktop session (console or RDP with a real desktop). Pure
  headless / Session 0 service accounts cannot drive GUI input.
- Optional: install a browser or app you want `launch_app` to start
  (`chrome`, `notepad`, path to `.exe` / `.lnk`).
- `pyautogui` is preferred; if it is missing, WinBackend uses ctypes
  `SendInput` + clipboard paste for `type_text`.
- Multi-seat isolation is Linux-only. On Windows, concurrent agents share one
  screen and must coordinate via leases (`ensure_desktop` / `heartbeat_desktop`).

---

## Tools exposed by the MCP server

| Tool                  | Purpose                                                      |
|-----------------------|--------------------------------------------------------------|
| `ensure_desktop`      | Exclusive lease; Linux auto-spawns seat if busy              |
| `acquire_desktop`     | Spawn/attach desktop (Linux pool; single seat on mac/Win)    |
| `heartbeat_desktop`   | Refresh exclusive lease during long work                     |
| `release_desktop`     | Free lease; Linux stops pool VNC                             |
| `list_desktops`       | Inspect pool / lease state                                   |
| `reap_idle_desktops`  | Free expired leases (Linux also stops idle VNC)              |
| `screenshot`          | Grab the display (JPEG default, SHA-deduped)                 |
| `observe`             | Screenshot + window list in one round-trip                   |
| `list_windows`        | Enumerate top-level windows + geometry                       |
| `launch_app`          | Spawn a GUI app (`command` argument)                         |
| `click`               | Absolute-coord mouse click                                   |
| `keypress`            | Press a key chord                                            |
| `type_text`           | Type a string into the focused window                        |
| `scroll`              | Scroll wheel                                                 |
| `batch`               | Execute many primitives in one MCP round-trip                |
| `act`                 | Goal loop via `claude-agent-sdk` (`max_iterations`, default model `claude-sonnet-5`) |
| `act_step`            | Single-step variant                                          |
| `status`              | Pool + binary inventory                                      |

A `/desktop:act <goal>` slash command is also registered.

---

## Configuration

All knobs are environment variables — no config file required.

| Env var                          | Default                         | Meaning                                 |
|----------------------------------|---------------------------------|-----------------------------------------|
| `CLAUDE_PLUGIN_ROOT`             | (set by Claude Code)            | Plugin root for logs + venv             |
| `DESKTOP_ACT_DISPLAY`            | `:1`                            | Default display when no `session_id`    |
| `DESKTOP_ACT_DISPLAY_MIN`/`MAX`  | `50` / `99`                     | Pool display number range               |
| `DESKTOP_ACT_VNC_PORT_BASE`      | `5900`                          | Pool VNC port base (display N → 5900+N) |
| `DESKTOP_ACT_NOVNC_PORT_BASE`    | `6082`                          | noVNC websockify port base              |
| `DESKTOP_ACT_GEOMETRY`           | `2560x1440`                     | Default geometry for new desktops       |
| `DESKTOP_ACT_OWNER`              | (process/agent id)              | Exclusive lease owner id                |
| `DESKTOP_ACT_LEASE_TTL`          | `600`                           | Lease seconds; idle past this → reaped  |
| `DESKTOP_ACT_REAP_INTERVAL`      | `30`                            | Background reaper tick (0 = off)        |
| `DESKTOP_ACT_REAP_ON_IDLE`       | `1`                             | Free lock + stop VNC when lease expires |
| `DESKTOP_ACT_AUTO_SPAWN`         | `1`                             | Spawn new desktop if others are busy    |
| `DESKTOP_ACT_RELEASE_ON_EXIT`    | `1` (CLI forces `0`)            | Free owned pool seats when process ends |
| `DESKTOP_ACT_TMP`                | `/tmp`                          | Where pool state + screenshots live     |
| `DESKTOP_ACT_LOG_DIR`            | `$CLAUDE_PLUGIN_ROOT/logs`      | Where session logs go                   |
| `DESKTOP_ACT_VENV`               | `$CLAUDE_PLUGIN_ROOT/.venv`     | Venv location                           |
| `DESKTOP_ACT_PYTHON`             | `python3`                       | Bootstrap interpreter                   |
| `CLAUDE_CLI_PATH`                | `which claude`                  | Path to `claude` CLI for `act()`        |

---

## Usage patterns

### Streaming primitives (recommended)

Let the parent session drive the loop — call primitives, Read screenshots,
decide, repeat. Every action is visible in the chat transcript.

```text
mcp__desktop-act__ensure_desktop(owner_id="agent-a") # → exclusive session_id
mcp__desktop-act__launch_app(session_id, "firefox")
mcp__desktop-act__screenshot(session_id)             # → /tmp/desktop-act-shots/…jpg
mcp__desktop-act__click(session_id, 640, 400)
mcp__desktop-act__heartbeat_desktop(session_id)      # keep lease during long work
mcp__desktop-act__release_desktop(session_id)        # always on agent stop
```

### Multi-agent (concurrent desktops)

Each agent must use its own `owner_id` (or set `DESKTOP_ACT_OWNER`):

1. `ensure_desktop(owner_id=…)` reuses that agent's lease, or **auto-spawns** a new
   Xvnc + noVNC on the next free display/port if every seat is leased.
2. Leases expire after `DESKTOP_ACT_LEASE_TTL` (default 600s) without heartbeat.
3. Background reaper (every `DESKTOP_ACT_REAP_INTERVAL`) and process exit/SIGTERM:
   **free the lock and stop pool VNC** (Xvnc + websockify) so idle seats do not
   thrash the host. The host default display (e.g. reauth Chrome on `:1`) is never
   reaped — only pool sessions (`:50`–`:99`).

```text
# Agent A
ensure_desktop(owner_id="agent-a", geometry="2560x1440")  # → :50
# Agent B (while A still holds :50)
ensure_desktop(owner_id="agent-b", geometry="2560x1440")  # → :51 auto-spawn
# Agent A stops / idle past TTL
release_desktop / reaper → free lock, kill VNC on :50
```

CLI:

```bash
./cli/desktop-act ensure --owner-id agent-a --geometry 2560x1440
./cli/desktop-act heartbeat --session-id desk-… --owner-id agent-a
./cli/desktop-act reap
./cli/desktop-act release --session-id desk-…
```

### Autonomous goal loop

```text
/desktop:act open firefox, navigate to example.com, and screenshot the page
```

`act()` spawns a sub-session via `claude-agent-sdk`. Use this when you want
hands-off; otherwise streaming primitives give better transparency.

### Stdio CLI (no MCP host)

For scripts, CI, or agents that only have a shell, use the bundled client:

```bash
./cli/desktop-act which
./cli/desktop-act status
./cli/desktop-act run --goal "Open a browser and go to example.com" --timeout 180
```

It speaks JSON-RPC over stdio to the same server. Paths resolve from
`DESKTOP_ACT_COMMAND` / `DESKTOP_ACT_HOME`, this checkout, or the per-user
cache — nothing host-specific is hard-coded. See [cli/README.md](./cli/README.md).

**Note:** `act()` takes `max_iterations` (and `timeout_seconds`), not `max_steps`.

### Watching live

Every desktop session returns a `novnc_url`. Open it in any browser:

```
http://<box-host>:6082   # first pool desktop
http://<box-host>:6083   # second, etc.
```

---

## Architecture notes

- **OS-agnostic backend.** A module-level `BACKEND` is chosen at startup from
  `platform.system()` — `MacBackend` on macOS, `WinBackend` on Windows,
  `X11Backend` on Linux. All three implement the same `Backend` protocol; every
  `@mcp.tool` simply delegates to `BACKEND.<method>`, so tool signatures and
  return shapes are identical across platforms. Platform-only imports
  (`Xlib`, `ImageGrab`/`ctypes.windll`, Quartz) stay inside backend methods so
  the module imports cleanly on any host.
- **Persistent X11 connections (Linux).** One `Xlib.Display` per display name,
  cached for the life of the MCP process. Saves the connection-establishment
  hit per primitive call.
- **File-locked pool + exclusive leases.** Pool state lives under
  `$DESKTOP_ACT_TMP` (default `/tmp` on Unix, `%TEMP%` on Windows), guarded by
  `flock` / `msvcrt` locking. Each session carries `owner_id` + `lease_until`.
  On Linux, busy seats auto-spawn Xvnc and idle seats are reaped (lock free +
  VNC stop). On macOS/Windows the reaper clears lease metadata only.
- **SHA-deduped screenshots.** Identical frames return the same path without
  re-encoding. Keeps token/byte cost down across tight loops.
- **JPEG by default.** Switch to PNG with `fmt="png"` when you need lossless.

---

## Project layout

```
desktop-act/
├── .claude-plugin/plugin.json     # plugin manifest (registers MCP server)
├── commands/act.md                # /desktop:act slash command
├── skills/desktop-act/SKILL.md    # when-to-use skill doc
├── cli/
│   ├── desktop-act                # shell entrypoint
│   ├── desktop_act_cli.py         # stdio JSON-RPC client
│   └── README.md                  # CLI usage
├── mcp-server/
│   ├── run.sh                     # launcher (auto-bootstraps venv)
│   └── server.py                  # FastMCP server (single file)
└── requirements.txt
```

---

## License

MIT — see [LICENSE](./LICENSE).
