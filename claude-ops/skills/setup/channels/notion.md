### 3e — Notion (MCP integration)

**Always ask before starting the Notion flow** — even when the user selected "all channels". Use `AskUserQuestion`:

```
Set up Notion workspace integration?
  [Yes — configure Notion]
  [Skip Notion]
```

If the user skips, record `channels.notion = "skipped"` in `$PREFS_PATH` and move on.

#### Detection

1. **Check for existing claude.ai Notion integration.** Scan the detector's `mcp_configured` array for any entry matching `Notion`, `claude_ai_Notion`, or `notion`. If found, set `NOTION_MCP_ENABLED=true` and skip to verification.

2. **Check for self-hosted Notion MCP server.** Look in `~/.claude/settings.json` for `mcpServers.notion` or any entry with `notion` in its args/command.

#### Setup paths

**Path A — Claude.ai integration (recommended):**

If no existing integration detected, present `AskUserQuestion`:

```
How would you like to connect Notion?
  [Claude.ai integration (Recommended) — add via claude.ai settings]
  [Self-hosted MCP — use your own Notion API key]
  [Skip Notion]
```

For claude.ai integration:

1. Tell the user: "Add Notion integration at claude.ai > Settings > Integrations > Notion. Authorize access to your workspace, then type 'done'."
2. Use `AskUserQuestion`: `[Done — connected]`, `[Skip Notion]`
3. On "Done", verify by testing `mcp__claude_ai_Notion__notion-search` with a simple query

**Path B — Self-hosted MCP:**

1. Scout keychain for existing Notion API key:
   ```bash
   security find-generic-password -s "notion-api-key" -w 2>/dev/null || \
   security find-generic-password -s "NOTION_API_KEY" -w 2>/dev/null || echo ""
   ```
2. If not found, ask the user:
   ```
   Enter your Notion integration token (starts with ntn_):
     Create one at https://www.notion.so/my-integrations
     [Paste token now]  [Skip Notion]
   ```
3. Store the token:
   ```bash
   security add-generic-password -s "notion-api-key" -a "claude-ops" -w "$TOKEN" -U
   ```
4. Add MCP server config to `~/.claude/settings.json` under `mcpServers.notion`

#### Verification

Test the integration (run in background):

```bash
# For claude.ai: integration auto-detected — test via MCP tool call
# For self-hosted: verify API key works
if [ -n "$NOTION_API_KEY" ]; then
  curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $NOTION_API_KEY" -H "Notion-Version: 2022-06-28" https://api.notion.com/v1/users/me | grep -q "200" && echo "OK" || echo "FAIL"
else
  echo "OK — claude.ai integration (verify via MCP tool call after restart)"
fi
```

#### Finalize

1. Set `NOTION_MCP_ENABLED=true` in `~/.claude/settings.json` env section
2. Record `channels.notion = {"backend": "mcp:notion", "status": "configured", "source": "<claude-ai|self-hosted>"}` in `$PREFS_PATH`
3. Add `"notion"` to `default_channels` array in `$PREFS_PATH`
4. Print: `✓ Notion — workspace connected via [source]`

> **Deep-dive:** see `${CLAUDE_PLUGIN_ROOT}/skills/ops-inbox/CHANNELS.md` for full Notion MCP tool reference and troubleshooting.
