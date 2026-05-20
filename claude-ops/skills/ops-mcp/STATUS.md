# OPS ► MCP — Architecture Reference

Long-form architecture, state, and lifecycle reference for the MCP auto-reconnect subsystem. Cross-referenced from [`SKILL.md`](./SKILL.md).

The subsystem keeps HTTP MCP servers alive and authenticated without user intervention. Three scripts form the core: a watchdog that probes + diffs + notifies, a keepalive that proactively refreshes OAuth tokens before they expire, and a reauth script that drives a headless Playwright browser through the OAuth consent flow when a token cannot be silently refreshed.

## Subsystem overview

```
 ~/.claude.json (mcpServers)
         │
         ▼
 [1] ops-mcp-watchdog.py       (cron */5 * * * *)
         │  probe each HTTP MCP via JSON-RPC initialize
         │  classify: healthy / token_expired / needs_bootstrap /
         │            cloudflare_ua / unreachable / server_error
         │  diff vs last tick (state.last.json)
         │  on token_expired → attempt_refresh() [direct OAuth POST]
         │  on needs_bootstrap → invoke ops-mcp-reauth.py (Playwright)
         │  on new degradations → WhatsApp notify (via supervisor-out-queue)
         │  on all paths → write_health() to .health
         │  write current state → state.json
         ▼
 [2] ops-mcp-keepalive.sh      (cron */15 * * * *)
         │  for every HTTP MCP, find ~/.mcp-auth/mcp-remote-*/
         │      <md5(url)>_tokens.json
         │  if expires_at < now + grace_min → POST refresh_token
         │  token endpoint from client_info.json or .well-known discovery
         │  atomic write back to tokens.json
         │  write health JSON to ~/.claude/state/mcp-keepalive/.health
         ▼
 [3] ops-mcp-reauth.py         (invoked by watchdog OR /ops:mcp reauth)
         │  spawn `npx -y mcp-remote <url>` in background
         │  capture the OAuth authorize URL from its stdout
         │  launch Playwright Chromium (persistent profile at
         │      ~/.claude/state/mcp-reauth-browser/)
         │  click Approve/Authorize/Allow button
         │  watch for localhost /oauth/callback intercept
         │  verify tokens.json was written by mcp-remote
         │  --bootstrap mode: headed window so user signs into each
         │      provider once; subsequent reauths headless
```

## Scripts

All paths relative to `$CLAUDE_PLUGIN_ROOT/scripts/`.

| # | Script                    | Role                     | Triggered by                      | Interval   |
|---|---------------------------|--------------------------|-----------------------------------|------------|
| 1 | `ops-mcp-watchdog.py`     | Probe + diff + notify    | cron, `/ops:mcp reconnect`        | */5 min    |
| 2 | `ops-mcp-keepalive.sh`    | Proactive token refresh  | cron                              | */15 min   |
| 3 | `ops-mcp-reauth.py`       | Playwright OAuth consent | watchdog (auto), `/ops:mcp reauth`| on-demand  |

## Hook flow (CLAUDE.md MCP auto-reconnect doctrine)

The MCP auto-reconnect behavior documented in `CLAUDE.md` has two layers:

1. **In-session layer** (`PreToolUse` hook on `mcp__*` tools): When a tool call fails due to disconnection, the hook kills the stale server process and Claude Code respawns it. Claude Code then waits 5 seconds and retries. This is handled by Claude Code itself.

2. **Background layer** (this subsystem): Runs out-of-band on cron. Detects HTTP MCP degradation before an active session hits it, attempts silent recovery (token refresh or Playwright reauth), and sends WhatsApp notification if manual intervention is required.

The two layers are complementary: the hook handles transient in-session crashes; the watchdog handles persistent auth failures and proactively prevents them via keepalive.

## State directory layout

```
~/.claude/state/mcp-watchdog/
├── state.json              # current per-server probe results (canonical)
├── state.last.json         # previous tick's results (for diff)
├── .health                 # watchdog health file (read by ops-doctor)
│                           # fields: status, message, last_run, summary,
│                           #         degraded_count, recovered_count
└── run.log                 # watchdog log (appended each tick)

~/.claude/state/mcp-keepalive/
├── .health                 # keepalive health JSON
└── run.log                 # keepalive log

~/.claude/state/mcp-reauth/
├── run.log                 # reauth log (per OAuth flow attempt)
└── [mcp-reauth-browser/]   # Playwright persistent Chromium profile
                            # (actually at ~/.claude/state/mcp-reauth-browser/)
```

## Server state classification

| State              | Meaning                                                           | Auto-recovery |
|--------------------|-------------------------------------------------------------------|---------------|
| `healthy`          | JSON-RPC initialize returned valid result                         | N/A           |
| `token_expired`    | 401 + refresh_token exists in tokens.json                         | Silent refresh |
| `needs_bootstrap`  | 401 + no refresh_token (first-time or refresh expired)            | Playwright reauth |
| `cloudflare_ua`    | 403 from Cloudflare bot challenge (change UA or use different path) | Manual       |
| `unreachable`      | DNS failure or connection refused                                 | Wait / manual |
| `server_error`     | 5xx from MCP server                                               | Wait          |
| `weird_2xx`        | 200 but response was not a valid MCP init result                  | Check server  |

## Token cache location

mcp-remote writes OAuth tokens under `~/.mcp-auth/mcp-remote-<version>/`. The watchdog and keepalive find tokens by taking `md5(url)` and looking for `<hash>_tokens.json` in the most recently modified `mcp-remote-*` subdirectory. Client metadata (OAuth endpoints, client_id) is in `<hash>_client_info.json` alongside.

The token cache is what Claude Code itself uses — the watchdog reads and writes to the same files, making token state consistent between the watchdog and active sessions.

## API-key MCPs vs OAuth MCPs

Servers listed in `API_KEY_MCPS` in `ops-mcp-watchdog.py` (currently: `pocketai`) use a static Bearer key retrieved from macOS Keychain via `security find-generic-password`. They do not use token refresh — the key is either valid or not. The watchdog skips the OAuth token-cache lookup for these servers.

## Notification behavior

On new degradations (server was healthy on previous tick, now not):
1. macOS notification via `osascript` (fires immediately, no config needed)
2. WhatsApp message via `supervisor-out-queue.jsonl` (same queue as pocket notifier)

On recovery (server was degraded, now healthy): logged only, no notification.

Notification can be suppressed with `MCP_WATCHDOG_NOTIFY=0`.

## Environment variables

| Variable                    | Default | Effect                                              |
|-----------------------------|---------|-----------------------------------------------------|
| `MCP_WATCHDOG_AUTO_REFRESH` | `1`     | Attempt silent OAuth refresh on token_expired       |
| `MCP_WATCHDOG_AUTO_REAUTH`  | `1`     | Invoke Playwright reauth on needs_bootstrap         |
| `MCP_WATCHDOG_NOTIFY`       | `1`     | Send WhatsApp + macOS notifications on degradation  |
| `MCP_WATCHDOG_PROBE_TIMEOUT`| `6`     | Per-server HTTP probe timeout in seconds            |
| `MCP_KEEPALIVE_GRACE_MIN`   | `15`    | Refresh token if expiry < this many minutes away    |
| `MCP_KEEPALIVE_URLS`        | (all)   | Space-separated URL list; overrides full scan       |
| `MCP_REAUTH_HEADLESS`       | `1`     | Set to `0` to see the Playwright browser            |
| `MCP_REAUTH_TIMEOUT`        | `90`    | Per-MCP consent flow timeout in seconds             |

## Common failure modes

| Symptom | Likely cause | Remediation |
|---------|-------------|-------------|
| All servers `needs_bootstrap` after machine restart | mcp-remote token cache wiped or Keychain locked | `/ops:mcp reauth <name>` for each |
| Server `token_expired` but auto-refresh fails | Provider rotated signing key or revoked refresh | `/ops:mcp reauth <name>` |
| `cloudflare_ua` state | Cloudflare WAF blocking the watchdog's UA | Not auto-recoverable; use Claude Code directly |
| `unreachable` for remote server | Network change, server down, or DNS failure | Check server status; wait and run `/ops:mcp reconnect` |
| Playwright reauth exits 1 | Browser profile has no session for the OAuth provider | Run `python3 $CLAUDE_PLUGIN_ROOT/scripts/ops-mcp-reauth.py --bootstrap` once |
| Watchdog health file stale > 15 min | Cron not registered or Python binary path wrong | `/ops:mcp restart` to re-register crontab |
