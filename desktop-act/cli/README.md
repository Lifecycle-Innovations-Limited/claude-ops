# desktop-act CLI

Shell-friendly client for the desktop-act MCP server. Talks JSON-RPC over
stdio — no MCP host required. Useful for scripts, CI smoke checks, and agents
that only have a shell.

## Quick start

From a full checkout (after `mcp-server/run.sh` has bootstrapped the venv once):

```bash
./cli/desktop-act which          # show resolved server command
./cli/desktop-act status
./cli/desktop-act acquire       # → JSON with session_id + novnc_url
./cli/desktop-act screenshot --session-id <id>
./cli/desktop-act act --goal "Open a terminal and list the home directory"
./cli/desktop-act release --session-id <id>
```

One-shot goal loop (acquire → act → release):

```bash
./cli/desktop-act run --goal "Open a browser and navigate to example.com" --timeout 180
```

## Path resolution

No machine-specific paths are baked in. First match wins:

| Priority | Source |
| -------- | ------ |
| 1 | `DESKTOP_ACT_COMMAND` — full argv or path to `run.sh` / `server.py` |
| 2 | `DESKTOP_ACT_HOME` — install root containing `mcp-server/` |
| 3 | Repo root next to this `cli/` directory |
| 4 | Per-user cache: `$XDG_CACHE_HOME/desktop-act-mcp/src` (Linux) or `~/Library/Caches/desktop-act-mcp/src` (macOS) |

Optional:

| Env | Meaning |
| --- | ------- |
| `DESKTOP_ACT_VENV` | Venv with server deps |
| `DESKTOP_ACT_PYTHON` | Bootstrap / client interpreter |
| `DESKTOP_ACT_DISPLAY` | Default X11 display (Linux) |
| `DESKTOP_ACT_MAX_ITERATIONS` | Default for `act` / `run` |
| `DESKTOP_ACT_ACT_TIMEOUT` | Default wall-clock for `act` / `run` (seconds) |
| `DESKTOP_ACT_MODEL` | Optional model id for `act` |
| `DESKTOP_ACT_RPC_TIMEOUT` | Per-request JSON-RPC wait (seconds) |

## Subcommands

| Command | Purpose |
| ------- | ------- |
| `which` | Print resolved server launch command |
| `status` | Health + pool + binary inventory |
| `list` | Active pool sessions |
| `ensure [--owner-id ID]` | Multi-agent: reuse lease or auto-spawn |
| `acquire [--owner-id ID] [--force-new]` | Ensure by default; force-new always spawns |
| `heartbeat --session-id ID` | Refresh lease TTL (avoid idle reap) |
| `reap` | Free locks + stop VNC for idle/dead seats |
| `release --session-id ID` | Tear down a session |
| `screenshot [--session-id ID]` | Capture frame |
| `observe [--session-id ID]` | Screenshot + windows |
| `act --goal "…"` | Autonomous loop (`max_iterations`, not `max_steps`) |
| `run --goal "…"` | Ensure → act → release |
| `call TOOL --arg k=v` | Raw `tools/call` |

Exit codes: `0` success, `1` act reported failure, `2` usage / transport error.

## Notes

- `act()` requires a working Claude CLI OAuth session on the host (see main README).
- On Linux, ensure Xvnc / websockify / a window manager are installed before `acquire`.
- Output is JSON on stdout so scripts can pipe to `jq`.
