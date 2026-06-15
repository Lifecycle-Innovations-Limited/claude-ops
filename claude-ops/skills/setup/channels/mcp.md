# Setup Channel — MCP Server Connectivity

This channel walks through first-time setup of the MCP auto-reconnect subsystem.

## 1. Verify installed servers

```bash
claude mcp list
```

This lists every server Claude Code knows about. Cross-check against `~/.claude.json` under `mcpServers`. HTTP servers (type `http`) are probed by the watchdog; stdio servers (type `stdio` or `command`) are not — they are managed by Claude Code's process lifecycle.

If `~/.claude.json` does not exist or has no `mcpServers` block, there is nothing to monitor. Add servers via `claude mcp add` or by editing the file directly.

## 2. Register the watchdog as a daemon service

The watchdog and keepalive run on cron. Register them with:

```bash
/usr/bin/env bash "${CLAUDE_PLUGIN_ROOT}/skills/ops-mcp/SKILL.md"
```

Or directly via the restart route:

```
/ops:mcp restart
```

This injects two crontab entries if not already present:

```
*/5  * * * *  /opt/homebrew/bin/python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ops-mcp-watchdog.py >> ~/.claude/state/mcp-watchdog/run.log 2>&1
*/15 * * * *  bash ${CLAUDE_PLUGIN_ROOT}/scripts/ops-mcp-keepalive.sh >> ~/.claude/state/mcp-keepalive/run.log 2>&1
```

Verify:

```bash
crontab -l | grep ops-mcp
```

The `daemon-services.default.json` also carries an `mcp-watchdog` entry which the daemon installer reads. If you use the daemon installer, it will handle cron registration automatically.

## 3. OAuth bootstrap for servers that need browser auth

Remote MCP servers using OAuth (giga, linear, atlassian, etc.) require a one-time interactive sign-in before the headless reauth can work. The Playwright reauth stores session cookies in a persistent Chromium profile at `~/.claude/state/mcp-reauth-browser/`. Once a provider session is saved there, all subsequent reauths are zero-touch.

Bootstrap each provider you use:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ops-mcp-reauth.py" --bootstrap
```

A headed Chromium window opens. Sign into each OAuth provider (Google, GitHub, etc.) that your MCP servers use. Close the window when done. After this, `/ops:mcp reauth <server>` runs headlessly.

Run this bootstrap once per machine, or after clearing the browser profile.

## 4. Verify API-key servers

Servers in `API_KEY_MCPS` (currently `pocketai`) use a static Bearer key stored via the cross-OS `credential-store.sh` under service name `POCKET_API_KEY`, account `ops-daemon`. Confirm (macOS uses `security`; Linux/WSL uses `secret-tool`/file backend — prefer the abstraction):

```bash
# Cross-OS (preferred):
bash "${CLAUDE_PLUGIN_ROOT}/scripts/lib/credential-store.sh" get POCKET_API_KEY ops-daemon
# macOS-only fallback:
# security find-generic-password -s POCKET_API_KEY -a ops-daemon -w
```

If the key is missing, add it:

```bash
security add-generic-password -s POCKET_API_KEY -a ops-daemon -w "<key>"
```

## 5. First health check

After registration:

```
/ops:mcp status
```

All configured HTTP servers should show `healthy` or `token_expired` (which the watchdog will auto-resolve on the next tick). If any show `needs_bootstrap`, run `/ops:mcp reauth <name>`.

## 6. Notifications

The watchdog sends WhatsApp notifications on new degradations via the pocket `supervisor-out-queue.jsonl`. This requires the pocket WhatsApp config at `$POCKET_STATE_DIR/whatsapp-config.json` to be configured. If you have not set up the pocket channel, macOS notifications via `osascript` still fire — no extra config needed.

To silence watchdog notifications:

```bash
export MCP_WATCHDOG_NOTIFY=0
```

Add to your shell profile to persist.
