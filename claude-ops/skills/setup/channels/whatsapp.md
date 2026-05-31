### 3b — WhatsApp (bridge health + QR pair)

WhatsApp is handled exclusively by the whatsmeow `whatsapp-bridge` (managed by `com.${USER}.whatsapp-bridge` LaunchAgent — `${USER}` is your macOS username, expanded at install time so each user gets their own per-account bridge) and accessed via `mcp__whatsapp__*` tools.

#### Step 3b.1 — Presence

Check bridge binary exists and LaunchAgent is installed:

```bash
ls ~/.local/share/whatsapp-mcp/whatsapp-bridge/whatsapp-bridge 2>/dev/null && echo "binary ok"
launchctl list com.${USER}.whatsapp-bridge 2>/dev/null | head -3
lsof -i :8080 2>/dev/null | grep LISTEN
```

If binary missing: ask `AskUserQuestion`: `[Show install docs]`, `[Skip WhatsApp]`. On install docs, print:

```
whatsapp-bridge (whatsmeow) is not installed. Install:
  git clone https://github.com/lharries/whatsapp-mcp ~/.local/share/whatsapp-mcp
  cd ~/.local/share/whatsapp-mcp/whatsapp-bridge && go build -tags "sqlite_fts5" -o whatsapp-bridge .
  mkdir -p ~/.local/share/whatsapp-mcp/whatsapp-bridge/logs
```

If LaunchAgent not installed, install it from template. The template ships as `com.claude-ops.whatsapp-bridge.plist` with a `__USER__` Label placeholder; sed substitutes the running user so the installed plist's Label becomes `com.${USER}.whatsapp-bridge`:
```bash
PLIST_TEMPLATE="${CLAUDE_PLUGIN_ROOT}/assets/launchagents/com.claude-ops.whatsapp-bridge.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.${USER}.whatsapp-bridge.plist"
BRIDGE_DIR="$HOME/.local/share/whatsapp-mcp/whatsapp-bridge"
mkdir -p "$BRIDGE_DIR/logs"
sed -e "s|__BRIDGE_BINARY_PATH__|$BRIDGE_DIR/whatsapp-bridge|g" \
    -e "s|__BRIDGE_WORKING_DIR__|$BRIDGE_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__USER__|$USER|g" \
    "$PLIST_TEMPLATE" > "$PLIST_DEST"
launchctl bootstrap gui/$(id -u) "$PLIST_DEST"
```

#### Step 3b.2 — QR pairing (first run)

On first run, the bridge needs QR pairing. Check `bridge.err.log`:

```bash
tail -50 ~/.local/share/whatsapp-mcp/whatsapp-bridge/logs/bridge.err.log 2>/dev/null
```

If log contains a QR code or "scan QR" message, print to the user:

```
The bridge is waiting for QR pairing.
Open ~/.local/share/whatsapp-mcp/whatsapp-bridge/logs/bridge.err.log in a terminal to see the QR code.
Scan it from WhatsApp → Settings → Linked Devices → Link a device.
```

Use `AskUserQuestion`: `[Done — QR scanned]`, `[Skip WhatsApp]`. This is the ONLY step that requires user's phone.

#### Step 3b.3 — Schema migration

After bridge is running and paired, run the idempotent schema migration:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/whatsapp-bridge-migrate.sh"
```

This adds FTS5 index and contacts table to messages.db. Safe to re-run.

#### Step 3b.4 — Smoke test

```bash
lsof -i :8080 | grep LISTEN   # bridge running?
DB="$HOME/.local/share/whatsapp-mcp/whatsapp-bridge/store/messages.db"
sqlite3 "$DB" "SELECT COUNT(*) FROM messages;" 2>/dev/null   # messages present?
sqlite3 "$DB" "SELECT COUNT(*) FROM messages_fts;" 2>/dev/null   # FTS index present?
```

If messages > 0 and FTS index present, print:

```
✓ WhatsApp — bridge running, N messages, FTS indexed
```

#### Step 3b.5 — Record state

Write `channels.whatsapp = "whatsapp-bridge"` to `$PREFS_PATH`.

**Health contract for other ops skills:**

All ops skills that use WhatsApp must check `lsof -i :8080 | grep LISTEN` before MCP tool calls.
If bridge is not running:
1. Print: "WhatsApp bridge is not running."
2. Use `AskUserQuestion`: `[Restart bridge]`, `[Skip WhatsApp]`.
3. On restart: `launchctl kickstart -k gui/$(id -u)/com.${USER}.whatsapp-bridge`, wait 5s.

> **Deep-dive:** see `${CLAUDE_PLUGIN_ROOT}/skills/ops-comms/SKILL.md` and `${CLAUDE_PLUGIN_ROOT}/skills/ops-inbox/SKILL.md` for full operational instructions.

