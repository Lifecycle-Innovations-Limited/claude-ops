### 3p — Pocket (voice journal activity notifier)

> **Cross-OS gate (read first):** the `launchctl` / `~/Library/LaunchAgents` notifier-install and the macOS `security` Keychain steps below are **macOS-only**. On **Linux/WSL**, register the notifier as a `systemd --user` timer/service and store `POCKET_API_KEY` via the cross-OS `credential-store.sh` (`secret-tool`/file backend) — never `security find-generic-password`. Branch on `case "$(uname -s)"`.

The Pocket subsystem watches your voice journal recordings via the Pocket AI MCP, infers tasks with Haiku, and sends activity notifications (task spawned / task done) to WhatsApp and/or email. This step installs the credential, writes the channel config files, registers the notifier (launchd on macOS, systemd --user on Linux), and smoke-tests delivery.

#### Step 3p.1 — Prerequisites

Before configuring Pocket, check which notification channels are already set up:

```bash
PREFS="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json"
WA_OK=false; EMAIL_OK=false
jq -e '.channels.whatsapp' "$PREFS" >/dev/null 2>&1 && WA_OK=true
jq -e '.channels.email'    "$PREFS" >/dev/null 2>&1 && EMAIL_OK=true
echo "whatsapp=$WA_OK email=$EMAIL_OK"
```

If **both** are false, ask via `AskUserQuestion`:

```
Pocket notifications require at least one delivery channel. Set one up first:
  [Configure WhatsApp — go to channel 3b]
  [Configure Email — go to channel 3c]
  [Skip Pocket for now]
```

Route accordingly. Do NOT proceed with Pocket setup until at least one channel is confirmed green.

#### Step 3p.2 — Pocket API key

The watcher script reads `POCKET_API_KEY` from three sources in order:

1. `POCKET_API_KEY` environment variable
2. macOS Keychain: service `POCKET_API_KEY`, account `ops-daemon`
3. Doppler: key `POCKET_API_KEY`

Run the Universal Credential Auto-Scan (see SHARED.md) for `POCKET_API_KEY` across all three sources. If found, show it masked (last 4 chars) and ask:

```
Found POCKET_API_KEY. Use this?
  [Yes — use found key]  [No — enter a different key]  [Skip Pocket]
```

If not found, ask:

```
POCKET_API_KEY not found. Where would you like to get one?
  [Open Pocket dev portal — https://public.heypocketai.com]
  [Paste key manually]
  [Skip Pocket for now]
```

On "Open Pocket dev portal": run `bash "${CLAUDE_PLUGIN_ROOT}/lib/opener.sh" "https://public.heypocketai.com"` (or `open "https://public.heypocketai.com"` on macOS) then ask `AskUserQuestion`: `[Paste key now]` / `[Skip]`.

Once a key is provided, save it through the cross-OS credential store and expose
it from the detected shell profile when needed:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/lib/credential-store.sh" set POCKET_API_KEY ops-daemon "$POCKET_API_KEY"

PROFILE="${PROFILE_FILE:-$HOME/.profile}"

if ! grep -q "POCKET_API_KEY" "$PROFILE" 2>/dev/null; then
  case "$PROFILE" in
    *config.fish)
      echo 'set -gx POCKET_API_KEY (bash "${CLAUDE_PLUGIN_ROOT}/lib/credential-store.sh" get POCKET_API_KEY ops-daemon 2>/dev/null)' >> "$PROFILE"
      ;;
    *)
      echo 'export POCKET_API_KEY="$(bash "${CLAUDE_PLUGIN_ROOT}/lib/credential-store.sh" get POCKET_API_KEY ops-daemon 2>/dev/null)"' >> "$PROFILE"
      ;;
  esac
fi
```

#### Step 3p.3 — Choose notification channels

Use `AskUserQuestion` with `multiSelect: true`. Only show channels that are already configured (from Step 3p.1 check):

```
Which channels should Pocket send notifications to?
  [WhatsApp self-chat]   (requires channel 3b — WhatsApp bridge running)
  [Email self-send]      (requires channel 3c — gog gmail authenticated)
```

If only one channel is configured, skip the question and auto-select it, then print:

```
Auto-selected <channel> (only configured channel).
```

#### Step 3p.4 — WhatsApp config

If WhatsApp was selected:

Resolve the user's own WhatsApp JID. Try the Baileys bridge DB first:

```bash
DB="$HOME/.local/share/whatsapp-mcp/whatsapp-bridge/store/messages.db"
# The user's own JID is typically stored as the sender in their own messages
sqlite3 "$DB" \
  "SELECT DISTINCT sender FROM messages WHERE sender LIKE '%@s.whatsapp.net' LIMIT 5;" \
  2>/dev/null || true
```

If the query returns results, present up to 4 JIDs via `AskUserQuestion`:

```
Select your WhatsApp JID for self-notifications:
  [<jid-1>]  [<jid-2>]  [Enter manually]  [Skip WhatsApp]
```

If the query returns nothing, ask `AskUserQuestion`: `[Enter JID manually]` / `[Skip WhatsApp]`.

On manual entry: ask for JID in format `1234567890@s.whatsapp.net`.

Write `~/.claude/state/pocket/whatsapp-config.json`:

```bash
mkdir -p "$HOME/.claude/state/pocket"
jq -n --arg jid "$CHAT_JID" \
  '{"enabled": true, "chat_jid": $jid}' \
  > "$HOME/.claude/state/pocket/whatsapp-config.json"
```

#### Step 3p.5 — Email config

If Email was selected:

Resolve `self_address` and `from_account`. Read from prefs or probe gog:

```bash
PREFS="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json"
SELF_EMAIL=$(jq -r '.owner_email // empty' "$PREFS" 2>/dev/null)
# Fallback: list gog accounts
[ -z "$SELF_EMAIL" ] && SELF_EMAIL=$(gog auth status --json 2>/dev/null | jq -r '.accounts[0].email // empty')
```

If found, confirm via `AskUserQuestion`:

```
Send Pocket notifications to <self_email>?
  [Yes — use this address]  [Enter a different address]  [Skip email]
```

Write `~/.claude/state/pocket/email-config.json`:

```bash
mkdir -p "$HOME/.claude/state/pocket"
jq -n \
  --arg addr  "$SELF_EMAIL" \
  --arg from  "$SELF_EMAIL" \
  '{"enabled": true, "self_address": $addr, "from_account": $from,
    "subject_prefix": "[Pocket]", "label": "Pocket",
    "parser_model": "claude-sonnet-4-6"}' \
  > "$HOME/.claude/state/pocket/email-config.json"
```

#### Step 3p.6 — Install the notifier

```bash
case "$(uname -s)" in
  Darwin)
    bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-pocket-notifier.sh"
    ;;
  Linux)
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/pocket-activity-notifier.service" <<SERVICE
[Unit]
Description=Pocket Activity Notifier

[Service]
Type=oneshot
Environment=HOME=$HOME
Environment=POCKET_STATE_DIR=$HOME/.claude/state/pocket
ExecStart=$HOME/.venv-pocket/bin/python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ops-pocket-activity-notifier.py
SERVICE
    cat > "$UNIT_DIR/pocket-activity-notifier.timer" <<TIMER
[Unit]
Description=Run Pocket Activity Notifier every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
Unit=pocket-activity-notifier.service

[Install]
WantedBy=timers.target
TIMER
    systemctl --user daemon-reload
    systemctl --user enable --now pocket-activity-notifier.timer
    ;;
  *)
    echo "Pocket notifier auto-install is unsupported on this OS; run the notifier manually or skip this channel."
    ;;
esac
```

On macOS this generates `~/Library/LaunchAgents/com.claude-ops.pocket-activity-notifier.plist` from the bundled template, resolves Python 3, substitutes paths, and bootstraps the agent. On Linux/WSL, use the printed `systemd --user` or cron wiring until a packaged Linux installer exists. Idempotent — re-running re-bootstraps cleanly.

Verify the agent loaded:

```bash
case "$(uname -s)" in
  Darwin) launchctl list | grep com.claude-ops.pocket-activity-notifier ;;
  Linux) systemctl --user status pocket-activity-notifier ;;
esac
```

If the grep returns nothing, surface the error via `AskUserQuestion`: `[Retry install]` / `[Skip]`.

#### Step 3p.7 — Smoke test

Drop a synthetic `.done.json` into `executor-results/` to trigger the notifier:

```bash
STATE_DIR="$HOME/.claude/state/pocket"
EXEC_DIR="$STATE_DIR/executor-results"
mkdir -p "$EXEC_DIR"
TASK_ID="smoke-$(date +%s)"

# Write a synthetic completion file matching what the executor produces
cat > "$EXEC_DIR/${TASK_ID}.done.json" <<SMOKE_EOF
{
  "task_id": "${TASK_ID}",
  "title": "Smoke test — Pocket notifier",
  "completed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "ok",
  "summary": "This is a synthetic test event from /ops:setup. If you received this, the Pocket notifier is working."
}
SMOKE_EOF

echo "Dropped smoke-test file: ${EXEC_DIR}/${TASK_ID}.done.json"
echo "Waiting up to 90s for notifier to fire (runs every 60s)..."
```

Wait up to 90 seconds for the notifier to process the file (runs on a 60s launchd interval). Check health:

```bash
cat "$HOME/.claude/state/pocket/.activity-notifier-health" 2>/dev/null
```

Ask `AskUserQuestion`:

```
Did you receive the Pocket smoke-test notification?
  [Yes — it arrived on WhatsApp / email]
  [No — I didn't receive it]
  [Skip verification]
```

If "No": show the stderr log for diagnosis:

```bash
tail -30 "$HOME/.claude/state/pocket/activity-notifier.stderr.log" 2>/dev/null
```

Offer `[Retry smoke test]` / `[Continue anyway]` / `[Re-run setup]`.

#### Step 3p.8 — Record state

Write to `$PREFS_PATH`:

```bash
PREFS_PATH="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json"
TMP=$(mktemp)
jq --argjson wa "$WA_ENABLED" --argjson em "$EMAIL_ENABLED" \
  '.pocket = {"enabled": true, "whatsapp": $wa, "email": $em, "notifier": "com.claude-ops.pocket-activity-notifier"}' \
  "$PREFS_PATH" > "$TMP" && mv "$TMP" "$PREFS_PATH"
```

Print:

```
✓ Pocket — notifier installed (com.claude-ops.pocket-activity-notifier).
  Activity events routed to: <channels>.
  Manage: /ops:settings pocket | /ops:pocket status | /ops:ops-doctor
```

> **Deep-dive:** see `${CLAUDE_PLUGIN_ROOT}/skills/ops-pocket/SKILL.md` for full operational instructions and `${CLAUDE_PLUGIN_ROOT}/skills/ops-pocket/STATUS.md` for the health contract.
