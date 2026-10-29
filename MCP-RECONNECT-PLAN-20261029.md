# MCP session reconnect - 2026-10-29

Goal: reconnect transiently failed MCP servers in NEW, launcher-owned Claude Code sessions. The selected scope is managed new sessions. Arbitrary existing CLI sessions and the normal TUI are unsupported.

## Interface

Run `python3 -I claude-ops/scripts/ops-mcp-session.py launch` from the desired project directory. This is a foreground, headless interactive JSON launcher, not a replacement TUI. Keep stdin open. A stream-json client supplies user messages and answers CLI permission control requests with `control_response`; events and permission requests stream unchanged to stdout. Closing stdin ends this owned child. The launcher does not auto-approve permission requests.

Run `python3 -I claude-ops/scripts/ops-mcp-session.py watchdog` for one poll. Both use the owner-only `$HOME/.local/state/ops-mcp` registry by default; `--registry` selects an alternate private path for testing. Unix socket path length is limited. A private random socket is the only registration; no executable, server config or command is read from state.

The child inherits cwd, environment and normal CLI settings discovery, hooks, permissions and model routing. The launcher supplies only print/verbose/stream-json flags and host permission prompts. It does not supply a model, bypass flag, bare mode, settings override, auth operation or MCP configuration override. The caller must use a real JSON client for human permission replies; piping plain text is unsupported.

## Recovery policy

The installed CLI uses `mcp_status` -> `mcpServers`, and `mcp_reconnect` with `serverName`. Its reported disconnected transport state is `failed`. Only that exact status qualifies. Connected, disabled, needs-auth and pending entries never trigger recovery. Unknown states, invalid/duplicate entries, rejected requests and transport errors fail closed. Raw server config/error fields are not exposed by the socket.

Each owner serializes polls. Each server gets at most three attempts during the owner's lifetime, spaced by 60/120/240 seconds, including failed requests. Successful recovery does not replenish its budget. The watchdog never restarts a session, deletes stale sockets, performs OAuth or changes endpoints. At most 64 sockets are examined per invocation; socket frames, clients and control waits are bounded. Registry directories must be owned by the current uid with mode 0700; sockets must be 0600. Symlink registries are rejected. Responses bind a random per-launch identity to the socket filename and require live owner/child PIDs. Same-user processes are within the trust boundary; a compromised same-user process is not isolated by Unix permissions.

## Staging and rollback

`python3 -I claude-ops/scripts/install-mcp-session-guard.py --destination "$HOME/.local/share/ops-mcp-stage"` stages a launcher copy and a rendered plist in a NEW private directory. It never installs into LaunchAgents, bootstraps, replaces files, or changes an existing job. Review the generated absolute Python/script paths before installation. The template runs one watchdog poll every 60 seconds, with no KeepAlive. Installation and launchd invocation remain a separate reviewed operator step.

Rollback before installation: discard only the newly staged directory after confirming its path. After an independently authorized installation, remove only this specific LaunchAgent through the normal reviewed launchd procedure. Ending the foreground launcher terminates only its own child and removes only its own socket.

## Evidence

- Official Python SDK documentation: `https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py` documents `mcp_status`; its client reference documents `reconnect_mcp_server` and statuses. Context7 retrieved these sources.
- No Python Agent SDK was importable in the checked interpreter; no global Node Agent SDK package was found. Installed CLI 2.1.312 contains `reconnectMcpServer` sending `{subtype:"mcp_reconnect",serverName:...}` and `mcpServerStatus` sending `{subtype:"mcp_status"}`. No undocumented attach/control endpoint is used.
- A real isolated child received ONLY an MCP status control request, no user/model prompt: `subtype=success`, `response_keys=[mcpServers]`, `server_count=14`. This establishes the control contract, not actual recovery of those servers.
- `python3 -I -m unittest discover -s claude-ops/tests -p test_ops_mcp_session.py -v`: seven tests passed. A fake stream-json child proves failed -> reconnect -> connected, exclusions, serialized polls, retry limit/backoff, unknown-state refusal, schema refusal, socket modes and symlink rejection.

## Review and live evidence

- Independent review identified permission stdio routing, client initialization and reconnect starvation defects. The implementation now forwards client control requests, explicitly selects the stdio permission callback, and continues to later servers after a rejected reconnect.
- Nine targeted tests pass, including client initialize/permission reply forwarding and failure of the first of two servers.
- A real CLI child with an isolated local MCP fixture transitioned from failed through mcp_reconnect to connected without sending a model prompt. The initial fixture failed only once and CLI recovered automatically; the corrected fixture remained unavailable until the test explicitly enabled it.
- Owner-controlled runtime copy and LaunchAgent installed. launchctl reports run interval 60 seconds, runs 1, last exit code 0. This proves job invocation; no regular managed user session has been enrolled.
- Secret scan: 31 passed, zero failed. Full repository test run remains in progress.

## NOT-DONE

- Full repository gate result and final preservation commit.
- Normal user-session acceptance requires a stream-json host client. This launcher is not the normal interactive TUI and does not enroll existing sessions.
- Existing arbitrary CLI sessions are intentionally unsupported, not pending coverage.

No session attach, auth flow, credential change, endpoint change or desktop interaction was performed.
