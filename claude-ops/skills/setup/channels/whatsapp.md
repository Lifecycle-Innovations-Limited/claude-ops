### 3b — WhatsApp (bridge health + QR pair)

> **Cross-OS gate (read first):** the `launchctl` / `~/Library/LaunchAgents` steps below are **macOS-only**. Branch on `case "$(uname -s)" in Darwin) … ;; Linux) … ;; esac`. On **Linux**, the bridge is a `systemd --user` unit — install via `scripts/install-whatsapp-bridge-linux.sh` (do NOT run the launchctl commands); manage with `systemctl --user {status,restart} whatsapp-bridge`. On **WSL** use the systemd path if `systemctl --user` works, else run the bridge under `nohup`. Secrets use the cross-OS `credential-store.sh` (`secret-tool`/file on Linux), not macOS `security`.

WhatsApp is handled by the whatsmeow `whatsapp-bridge` and accessed via `mcp__whatsapp__*` (or per-account `mcp__whatsapp-<label>__*`) tools. The bridge may run **on this machine** or **on another host** (this box is then a client).

Account topology is **user data written by this wizard**, never committed:

- `$PREFS_PATH` → `.channels.whatsapp` (wins)
- `$OPS_DATA_DIR/registry.json` → `.whatsapp` (same shape; see `scripts/registry.example.json`)

Do not hardcode ports, IPs, PIDs, or phone numbers in the plugin repo.

#### Step 3b.0 — Where does the bridge run?

`AskUserQuestion`:

- `[This machine runs the bridge]`
- `[This machine is a client — bridge is on another host]`
- `[Skip WhatsApp]`

**Client path:** do **not** install a local LaunchAgent or systemd unit. Collect, then jump to 3b.5:

- E.164 (digits only, no `+`)
- `label` (e.g. `personal`, `work`)
- `api` — local reverse-proxy URL (`http://127.0.0.1:<port>`). Never a remote IP.
- `bridge_port` — that local listen port
- optional `ssh` (`user@host`) and `remote_store` (path on that host to `messages.db`)
- `agent_enabled` true/false

Repeat per extra number (max 4 options per `AskUserQuestion`).

**Local path:** continue 3b.1.

#### Step 3b.1 — Presence

Check bridge binary exists and the platform service is installed:

```bash
ls ~/.local/share/whatsapp-mcp/whatsapp-bridge/whatsapp-bridge 2>/dev/null && echo "binary ok"
case "$(uname -s)" in
  Darwin) launchctl list com.${USER}.whatsapp-bridge 2>/dev/null | head -3 ;;
  Linux) systemctl --user status whatsapp-bridge --no-pager ;;
esac
"${CLAUDE_PLUGIN_ROOT}/bin/ops-wa-accounts" --list
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
case "$(uname -s)" in
  Darwin)
    PLIST_TEMPLATE="${CLAUDE_PLUGIN_ROOT}/assets/launchagents/com.claude-ops.whatsapp-bridge.plist"
    PLIST_DEST="$HOME/Library/LaunchAgents/com.${USER}.whatsapp-bridge.plist"
    BRIDGE_DIR="$HOME/.local/share/whatsapp-mcp/whatsapp-bridge"
    mkdir -p "$BRIDGE_DIR/logs" "$HOME/Library/LaunchAgents"
    sed -e "s|__BRIDGE_BINARY_PATH__|$BRIDGE_DIR/whatsapp-bridge|g" \
        -e "s|__BRIDGE_WORKING_DIR__|$BRIDGE_DIR|g" \
        -e "s|__HOME__|$HOME|g" \
        -e "s|__USER__|$USER|g" \
        "$PLIST_TEMPLATE" > "$PLIST_DEST"
    launchctl bootstrap gui/$(id -u) "$PLIST_DEST"
    ;;
  Linux)
    # Ask for WA_PHONE first: digits-only E.164 without "+" (for example, 12025551234).
    bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-whatsapp-bridge-linux.sh" --wa-phone "$WA_PHONE"
    systemctl --user enable --now whatsapp-bridge.service
    ;;
  *)
    echo "WhatsApp bridge auto-install is unsupported on this OS."
    ;;
esac
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
"${CLAUDE_PLUGIN_ROOT}/bin/ops-wa-accounts" --list
# Per agent_enabled account: curl the resolved `api` (401 is healthy when Bearer-gated).
# Local store only: sqlite3 "$store" "SELECT COUNT(*) FROM messages;"
```

If at least one agent-enabled account resolves, print:

```
✓ WhatsApp — N account(s) in $PREFS_PATH
```

#### Step 3b.5 — Record state

Write the accounts object to **both** `$PREFS_PATH` and `$OPS_DATA_DIR/registry.json`. Merge; do not clobber other keys. Never commit these files.

```bash
PREFS_PATH="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json"
OPS_DATA_DIR="${OPS_DATA_DIR:-${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}}"
mkdir -p "$(dirname "$PREFS_PATH")" "$OPS_DATA_DIR"

# $WA_JSON is the object below, built from answers (local discovery or 3b.0 client).
# Example shape only — use the user's values, never invent numbers or hosts.
# {
#   "backend": "whatsapp-bridge",
#   "default_agent_enabled": true,
#   "accounts": {
#     "<e164>": {
#       "label": "personal",
#       "agent_enabled": true,
#       "api": "http://127.0.0.1:<proxy-port>",
#       "bridge_port": "<proxy-port>",
#       "ssh": "",
#       "remote_store": ""
#     }
#   }
# }

python3 - "$PREFS_PATH" "$OPS_DATA_DIR/registry.json" "$WA_JSON" <<'PY'
import json, os, sys
prefs_path, reg_path, blob = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])

def load(path):
    try:
        with open(path) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}

prefs = load(prefs_path)
channels = prefs.get("channels") if isinstance(prefs.get("channels"), dict) else {}
channels["whatsapp"] = blob
prefs["channels"] = channels
os.makedirs(os.path.dirname(prefs_path) or ".", exist_ok=True)
tmp = prefs_path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(prefs, fh, indent=2)
    fh.write("\n")
os.replace(tmp, prefs_path)
os.chmod(prefs_path, 0o600)

reg = load(reg_path)
if not reg:
    reg = {"version": "1.0"}
reg["whatsapp"] = blob
os.makedirs(os.path.dirname(reg_path) or ".", exist_ok=True)
tmp = reg_path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(reg, fh, indent=2)
    fh.write("\n")
os.replace(tmp, reg_path)
os.chmod(reg_path, 0o600)
print("wrote WhatsApp accounts to prefs + registry")
PY
```

For a local single-bridge install, fill `api` from `ops-wa-accounts` after pairing (`http://127.0.0.1:<port>`), `label` from the store directory name, E.164 from the paired JID. Keep `channels.whatsapp.backend = "whatsapp-bridge"` so older readers that expected a string still see a backend key.

**Health contract for other ops skills:**

All ops skills that use WhatsApp must call `ops-wa-accounts` and probe each account's `api`. Never `lsof :8080`. Never `launchctl kickstart` unless policy says the bridge is local.

1. Print: "WhatsApp: no accounts in $PREFS_PATH — run /ops:setup step 3b."
2. Use `AskUserQuestion`: `[Re-run setup 3b]`, `[Skip WhatsApp]`.
3. On a **local** bridge restart only: `launchctl kickstart` / `systemctl --user restart whatsapp-bridge`, wait 5s.
4. On a **client** box: fix the reverse proxy or the remote bridge. Do not start a leftover local plist.

> **Deep-dive:** see `${CLAUDE_PLUGIN_ROOT}/skills/ops-comms/SKILL.md` and `${CLAUDE_PLUGIN_ROOT}/skills/ops-inbox/SKILL.md` for full operational instructions.
