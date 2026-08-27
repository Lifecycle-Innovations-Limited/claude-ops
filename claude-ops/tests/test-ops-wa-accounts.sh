#!/usr/bin/env bash
# Hermetic coverage for ops-wa-accounts: prefs / registry / leftover-store overlay.
# No real bridge, no network, no personal numbers.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/ops-wa-accounts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PY=python3
[ -x /usr/bin/python3 ] && PY=/usr/bin/python3

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "  PASS: $*"; }

"$PY" -c "import py_compile,sys; py_compile.compile(sys.argv[1], doraise=True)" "$BIN" \
  || fail "ops-wa-accounts must compile"

# Placeholders in the public tree — never personal ports or hostnames.
for needle in 8482 8483 8082; do
  if grep -R --include='*.md' --include='*.py' --include='*.sh' --include='*.json' \
      -n "$needle" "$ROOT/bin/ops-wa-accounts" "$ROOT/skills/ops-inbox" \
      "$ROOT/skills/setup/channels/whatsapp.md" "$ROOT/scripts/registry.example.json" \
      >/dev/null 2>&1; then
    fail "public WhatsApp docs/code still mention port $needle"
  fi
done
ok "no personal bridge ports in public WhatsApp files"

export CLAUDE_PLUGIN_DATA_DIR="$TMP/data"
export OPS_DATA_DIR="$TMP/data"
export PREFS_PATH="$TMP/data/preferences.json"
export OPS_REGISTRY="$TMP/data/registry.json"
export WHATSAPP_AGENT_POLICY="$TMP/missing-policy.json"
export WHATSAPP_BRIDGE_GLOB="$TMP/bridges/whatsapp-bridge*"
mkdir -p "$TMP/data" "$TMP/bridges"

run_json() {
  "$PY" "$BIN"
}

# --------------------------------------------------------------------------
# 1. empty → exit 4 on --list
# --------------------------------------------------------------------------
if "$PY" "$BIN" --list >/dev/null 2>"$TMP/err"; then
  fail "empty discovery should fail --list"
fi
grep -q "no WhatsApp accounts" "$TMP/err" || fail "--list stderr should name prefs/registry"
ok "empty --list exits non-zero"

# --------------------------------------------------------------------------
# 2. client-only account from $PREFS_PATH
# --------------------------------------------------------------------------
cat > "$PREFS_PATH" <<'EOF'
{
  "channels": {
    "whatsapp": {
      "backend": "whatsapp-bridge",
      "default_agent_enabled": true,
      "accounts": {
        "15551230001": {
          "label": "personal",
          "agent_enabled": true,
          "api": "http://127.0.0.1:19001",
          "bridge_port": 19001,
          "ssh": "user@bridge-host",
          "remote_store": "/var/lib/wa/store/messages.db"
        }
      }
    }
  }
}
EOF

JSON="$(run_json)"
echo "$JSON" | "$PY" -c '
import json,sys
d=json.load(sys.stdin)
accts=d["accounts"]
assert len(accts)==1, accts
a=accts[0]
assert a["phone"]=="15551230001"
assert a["api"]=="http://127.0.0.1:19001"
assert a["port"]==19001
assert a["agent_enabled"] is True
assert a["ssh"]=="user@bridge-host"
assert a["remote_store"]=="/var/lib/wa/store/messages.db"
assert a["store"]==""
assert d["default"]["phone"]=="15551230001"
assert d["policy_sources"]["prefs"].endswith("preferences.json")
'
ok "prefs client-only account resolves"

PORT="$("$PY" "$BIN" --port)"
[ "$PORT" = "19001" ] || fail "--port expected 19001, got $PORT"
ok "--port from prefs api"

# --------------------------------------------------------------------------
# 3. registry used when prefs has no accounts (string leftover is ignored)
# --------------------------------------------------------------------------
cat > "$PREFS_PATH" <<'EOF'
{ "channels": { "whatsapp": "whatsapp-bridge" } }
EOF
cat > "$OPS_REGISTRY" <<'EOF'
{
  "version": "1.0",
  "whatsapp": {
    "default_agent_enabled": true,
    "accounts": {
      "15551230002": {
        "label": "work",
        "agent_enabled": true,
        "api": "http://127.0.0.1:19002",
        "bridge_port": 19002
      }
    }
  }
}
EOF

JSON="$(run_json)"
echo "$JSON" | "$PY" -c '
import json,sys
d=json.load(sys.stdin)
assert len(d["accounts"])==1
assert d["accounts"][0]["phone"]=="15551230002"
assert d["accounts"][0]["port"]==19002
'
ok "registry accounts used when prefs is a legacy string"

# --------------------------------------------------------------------------
# 4. prefs overlay wins over registry
# --------------------------------------------------------------------------
cat > "$PREFS_PATH" <<'EOF'
{
  "channels": {
    "whatsapp": {
      "accounts": {
        "15551230002": {
          "api": "http://127.0.0.1:19099",
          "bridge_port": 19099,
          "agent_enabled": true
        }
      }
    }
  }
}
EOF

JSON="$(run_json)"
echo "$JSON" | "$PY" -c '
import json,sys
d=json.load(sys.stdin)
a=d["accounts"][0]
assert a["phone"]=="15551230002"
assert a["port"]==19099, a
assert a["api"]=="http://127.0.0.1:19099"
'
ok "prefs wins over registry on the same number"

# --------------------------------------------------------------------------
# 5. leftover local store port loses to policy api
# --------------------------------------------------------------------------
STORE="$TMP/bridges/whatsapp-bridge/store"
mkdir -p "$STORE"
: > "$STORE/messages.db"
cat > "$TMP/bridges/whatsapp-bridge/run-bridge.sh" <<'EOF'
#!/bin/bash
WA_PHONE="${WA_PHONE:-15551230002}"
WA_PORT="${WA_PORT:-8080}"
EOF

JSON="$(run_json)"
echo "$JSON" | "$PY" -c '
import json,sys
d=json.load(sys.stdin)
assert len(d["accounts"])==1, d
a=d["accounts"][0]
assert a["phone"]=="15551230002"
assert a["port"]==19099, a
assert a["api"]=="http://127.0.0.1:19099"
'
ok "policy api wins over leftover local launcher port"

# --------------------------------------------------------------------------
# 6. two agent-enabled accounts → --port exits 3
# --------------------------------------------------------------------------
rm -rf "$TMP/bridges/whatsapp-bridge"
cat > "$PREFS_PATH" <<'EOF'
{
  "channels": {
    "whatsapp": {
      "accounts": {
        "15551230001": {
          "label": "personal",
          "agent_enabled": true,
          "api": "http://127.0.0.1:19001",
          "bridge_port": 19001
        },
        "15551230002": {
          "label": "work",
          "agent_enabled": true,
          "api": "http://127.0.0.1:19002",
          "bridge_port": 19002
        }
      }
    }
  }
}
EOF
rm -f "$OPS_REGISTRY"

if "$PY" "$BIN" --port >/dev/null 2>"$TMP/err2"; then
  fail "--port must exit 3 when two accounts are enabled"
fi
RC=0
"$PY" "$BIN" --port >/dev/null 2>/dev/null || RC=$?
[ "$RC" = "3" ] || fail "--port exit $RC, expected 3"
ok "two enabled accounts: --port exits 3"

JSON="$(run_json)"
echo "$JSON" | "$PY" -c '
import json,sys
d=json.load(sys.stdin)
assert d["default"] is None
assert len([a for a in d["accounts"] if a["agent_enabled"]])==2
'
ok "two enabled accounts listed, default is null"

echo "ops-wa-accounts: PASS"
