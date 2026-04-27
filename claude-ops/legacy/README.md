# Legacy

Files in this directory are decommissioned and kept only for reference.

## wacli-keepalive.sh.deprecated

Decommissioned in PR #172 (feat: decommission wacli, run WhatsApp ops on Baileys MCP only).

The wacli keepalive daemon (`com.claude-ops.wacli-keepalive`) held a persistent `wacli sync --follow`
connection and wrote `~/.wacli/.health` for ops skills to read. It consumed one of four WhatsApp linked-device
slots and double-stored messages alongside the Baileys bridge.

WhatsApp ops are now handled exclusively by the Baileys-based `whatsapp-bridge` managed by the
`com.samrenders.whatsapp-bridge` LaunchAgent, surfaced via `mcp__whatsapp__*` tools.

## com.claude-ops.wacli-keepalive.plist.deprecated

LaunchAgent plist for the now-decommissioned wacli keepalive daemon. The replacement plist template
lives at `assets/launchagents/com.samrenders.whatsapp-bridge.plist`.

To fully remove the old daemon from a running system:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claude-ops.wacli-keepalive.plist 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.claude-ops.wacli-keepalive.plist
```
