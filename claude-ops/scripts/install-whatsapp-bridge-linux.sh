#!/usr/bin/env bash
# install-whatsapp-bridge-linux.sh — set up the WhatsApp MCP stack on a
# Linux (systemd-user) host so /ops:ops-inbox whatsapp works the same way
# it does on macOS (where launchctl manages com.${USER}.whatsapp-bridge).
#
# Idempotent: rerunning is safe. Existing unit files are overwritten only
# if the in-tree templates differ; source patches use sentinel strings so
# they apply at most once. A live pairing session is NOT disturbed unless
# --reset-session is passed.
#
# Required:
#   --wa-phone <E.164>     The phone number of the WhatsApp account that
#                          will host this device. E.164 without '+' or
#                          spaces (e.g. --wa-phone 12025551234).
#
# Optional:
#   --install-dir <path>   Where to clone the lharries/whatsapp-mcp repo
#                          (default: ~/.local/share/whatsapp-mcp)
#   --skip-build           Don't rebuild the bridge binary
#   --reset-session        Delete whatsapp.db so a fresh pair code is
#                          generated (you'll need to scan with the phone)
#   --no-backfill-timer    Drop only the bridge unit, skip the 2h timer
#   --no-transcribe-timer  Skip the 10-min voice-note transcription timer
#                          (voice notes won't be auto-transcribed into content)
#   --no-enrich-timer      Skip the 10-min media enrichment timer
#                          (video/image/document won't be auto-described)

set -euo pipefail

REPO_URL="https://github.com/lharries/whatsapp-mcp.git"
INSTALL_DIR_DEFAULT="$HOME/.local/share/whatsapp-mcp"
SYSTEMD_DIR="$HOME/.config/systemd/user"

WA_PHONE=""
INSTALL_DIR="$INSTALL_DIR_DEFAULT"
SKIP_BUILD=0
RESET_SESSION=0
WITH_BACKFILL_TIMER=1
WITH_TRANSCRIBE_TIMER=1
WITH_ENRICH_TIMER=1

# Source-tree dir (where this script lives in claude-ops checkout)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WA_ASSETS="$SCRIPT_DIR/whatsapp"

usage() {
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
  exit "${1:-0}"
}

while (("$#")); do
  case "$1" in
    --wa-phone)            WA_PHONE="$2"; shift 2 ;;
    --install-dir)         INSTALL_DIR="$2"; shift 2 ;;
    --skip-build)          SKIP_BUILD=1; shift ;;
    --reset-session)       RESET_SESSION=1; shift ;;
    --no-backfill-timer)   WITH_BACKFILL_TIMER=0; shift ;;
    --no-transcribe-timer) WITH_TRANSCRIBE_TIMER=0; shift ;;
    --no-enrich-timer)     WITH_ENRICH_TIMER=0; shift ;;
    -h|--help)             usage 0 ;;
    *) echo "unknown flag: $1" >&2; usage 1 ;;
  esac
done

# ─── Preconditions ───────────────────────────────────────────────────────────
if [ -z "$WA_PHONE" ]; then
  echo "ERROR: --wa-phone <E.164> is required (e.g. --wa-phone 12025551234)" >&2
  exit 2
fi
if ! [[ "$WA_PHONE" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --wa-phone must be digits only, no '+' or spaces. Got: $WA_PHONE" >&2
  exit 2
fi
if ! command -v go >/dev/null && [ "$SKIP_BUILD" -ne 1 ]; then
  echo "ERROR: 'go' not found. Install Go (1.22+) or pass --skip-build to skip." >&2
  exit 3
fi
if ! command -v systemctl >/dev/null; then
  echo "ERROR: systemctl not found. This script targets systemd-based Linux hosts." >&2
  exit 3
fi

echo "▶ claude-ops WhatsApp bridge install"
echo "  install dir: $INSTALL_DIR"
echo "  wa-phone:    $WA_PHONE"
echo "  backfill timer: $([ "$WITH_BACKFILL_TIMER" -eq 1 ] && echo on || echo off)"
echo "  transcribe timer: $([ "$WITH_TRANSCRIBE_TIMER" -eq 1 ] && echo on || echo off)"
echo "  enrich timer: $([ "$WITH_ENRICH_TIMER" -eq 1 ] && echo on || echo off)"

# ─── Clone / refresh upstream ────────────────────────────────────────────────
mkdir -p "$(dirname "$INSTALL_DIR")"
if [ ! -d "$INSTALL_DIR/whatsapp-bridge" ]; then
  echo "▶ Cloning $REPO_URL → $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
else
  echo "▶ Install dir already present — leaving upstream as-is"
  echo "  (run a manual 'git pull' inside $INSTALL_DIR if you want the latest upstream)"
fi

# ─── Apply patches (idempotent via sentinels) ────────────────────────────────
echo "▶ Applying source patches"
python3 "$WA_ASSETS/apply-patches.py" --install-dir "$INSTALL_DIR"

# ─── Ship contacts-link helper (ops-inbox auto-syncs it on every invocation) ──
echo "▶ Installing link_contacts.py (contacts link: phone + LID aliases)"
cp "$WA_ASSETS/link_contacts.py" "$INSTALL_DIR/whatsapp-bridge/link_contacts.py"
chmod +x "$INSTALL_DIR/whatsapp-bridge/link_contacts.py"

# ─── Ship voice-note transcriber (whatsapp-transcribe.timer runs it) ──────────
echo "▶ Installing transcribe_voice_notes.py (Whisper voice-note → content)"
mkdir -p "$INSTALL_DIR/transcriber"
cp "$WA_ASSETS/transcribe_voice_notes.py" "$INSTALL_DIR/transcriber/transcribe_voice_notes.py"
chmod +x "$INSTALL_DIR/transcriber/transcribe_voice_notes.py"

# ─── Ship media enricher (whatsapp-enrich.timer runs it) ─────────────────────
echo "▶ Installing enrich_media.py (vision+Whisper video/image/document → content)"
cp "$WA_ASSETS/enrich_media.py" "$INSTALL_DIR/transcriber/enrich_media.py"
chmod +x "$INSTALL_DIR/transcriber/enrich_media.py"

# ─── Ship wa-inbox-fresh.sh (pre-scan freshness gate, run FIRST by ops-inbox) ─
echo "▶ Installing wa-inbox-fresh.sh → ~/bin (pre-scan freshness gate)"
mkdir -p "$HOME/bin"
cp "$SCRIPT_DIR/../bin/wa-inbox-fresh.sh" "$HOME/bin/wa-inbox-fresh.sh"
chmod +x "$HOME/bin/wa-inbox-fresh.sh"

# ─── Ship Mac ground-truth fallback suite (reader + Tier-4 archiver + transport) ─
echo "▶ Installing wa-mac-{transport,latest,archive}.sh → ~/bin (Mac WhatsApp.app fallback)"
for f in wa-mac-transport.sh wa-mac-latest.sh wa-mac-archive.sh; do
  cp "$SCRIPT_DIR/../bin/$f" "$HOME/bin/$f"
  chmod +x "$HOME/bin/$f"
done

# ─── Ship wa-bridge-keepalive.sh (hang-detection so phone-sends always sync) ──
echo "▶ Installing wa-bridge-keepalive.sh → ~/bin (uptime watchdog)"
cp "$SCRIPT_DIR/../bin/wa-bridge-keepalive.sh" "$HOME/bin/wa-bridge-keepalive.sh"
chmod +x "$HOME/bin/wa-bridge-keepalive.sh"

# ─── Bump Go deps + build ────────────────────────────────────────────────────
if [ "$SKIP_BUILD" -ne 1 ]; then
  echo "▶ Bumping Go deps + building bridge"
  pushd "$INSTALL_DIR/whatsapp-bridge" >/dev/null
  # Pin whatsmeow to the known-good rev — whatsmeow has rapid API churn (context
  # params added/removed between releases) that breaks the claude-ops source patches.
  # Do NOT change to @latest without re-verifying all patches compile. (2026-06)
  go get go.mau.fi/whatsmeow@v0.0.0-20260604191253-256f4d77fbd4
  go get ./...
  go mod tidy
  # -tags sqlite_fts5 is REQUIRED: ops-inbox search + whatsapp-bridge-migrate.sh
  # add an fts5 virtual table & triggers on messages.db. The bridge's own
  # mattn/go-sqlite3 must therefore have the fts5 module, or every message
  # INSERT fails with "no such module: fts5" and the bridge stores nothing.
  go build -tags "sqlite_fts5" -o whatsapp-bridge .
  popd >/dev/null
fi

# ─── Python venv for whatsapp-mcp-server ─────────────────────────────────────
if [ -d "$INSTALL_DIR/whatsapp-mcp-server" ]; then
  echo "▶ Syncing Python MCP server deps"
  pushd "$INSTALL_DIR/whatsapp-mcp-server" >/dev/null
  if command -v uv >/dev/null; then
    uv sync --upgrade
  else
    echo "  (uv not found — install with 'pip install uv' for a managed venv)"
  fi
  popd >/dev/null
fi

# ─── Drop systemd-user units ─────────────────────────────────────────────────
echo "▶ Writing systemd-user units → $SYSTEMD_DIR"
mkdir -p "$SYSTEMD_DIR"

# Bridge: substitute WA_PHONE into the template
sed "s/__WA_PHONE__/$WA_PHONE/" \
    "$WA_ASSETS/systemd/whatsapp-bridge.service.template" \
    > "$SYSTEMD_DIR/whatsapp-bridge.service"

if [ "$WITH_BACKFILL_TIMER" -eq 1 ]; then
  cp "$WA_ASSETS/systemd/whatsapp-backfill.service" "$SYSTEMD_DIR/"
  cp "$WA_ASSETS/systemd/whatsapp-backfill.timer"   "$SYSTEMD_DIR/"
fi

# Keepalive watchdog: Restart=always catches crashes; this catches HANGS (socket
# dead, process alive) which would silently drop phone-originated own-sends that
# whatsmeow can never re-fetch. Always installed.
cp "$WA_ASSETS/systemd/whatsapp-bridge-keepalive.service" "$SYSTEMD_DIR/"
cp "$WA_ASSETS/systemd/whatsapp-bridge-keepalive.timer"   "$SYSTEMD_DIR/"

if [ "$WITH_TRANSCRIBE_TIMER" -eq 1 ]; then
  sed "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
      "$WA_ASSETS/systemd/whatsapp-transcribe.service" \
      > "$SYSTEMD_DIR/whatsapp-transcribe.service"
  cp "$WA_ASSETS/systemd/whatsapp-transcribe.timer"   "$SYSTEMD_DIR/"
  # The transcribe service reads OPENAI_API_KEY from this EnvironmentFile.
  if [ ! -f "$HOME/.config/systemd/env/mcp-secrets.env" ]; then
    echo "  NOTE: ~/.config/systemd/env/mcp-secrets.env not found — the transcribe"
    echo "        service needs OPENAI_API_KEY there (KEY=value lines) to run."
  fi
fi

if [ "$WITH_ENRICH_TIMER" -eq 1 ]; then
  sed "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
      "$WA_ASSETS/systemd/whatsapp-enrich.service" \
      > "$SYSTEMD_DIR/whatsapp-enrich.service"
  cp "$WA_ASSETS/systemd/whatsapp-enrich.timer"   "$SYSTEMD_DIR/"
  # The enrich service reads OPENAI_API_KEY from this EnvironmentFile.
  if [ ! -f "$HOME/.config/systemd/env/mcp-secrets.env" ]; then
    echo "  NOTE: ~/.config/systemd/env/mcp-secrets.env not found — the enrich"
    echo "        service needs OPENAI_API_KEY there (KEY=value lines) to run."
  fi
fi

# ─── Disable deprecated wacli daemon if present ──────────────────────────────
if systemctl --user list-unit-files claude-ops-wacli-keepalive.service 2>/dev/null | grep -q wacli-keepalive; then
  echo "▶ Disabling deprecated claude-ops-wacli-keepalive.service (replaced by systemd-managed bridge)"
  systemctl --user disable --now claude-ops-wacli-keepalive.service 2>/dev/null || true
fi

# ─── Optionally wipe the device store for a clean re-pair ────────────────────
if [ "$RESET_SESSION" -eq 1 ]; then
  echo "▶ --reset-session: wiping pairing state"
  rm -f "$INSTALL_DIR/whatsapp-bridge/store/whatsapp.db" \
        "$INSTALL_DIR/whatsapp-bridge/store/messages.db"
fi

# ─── Reload + enable + start ─────────────────────────────────────────────────
echo "▶ Reloading systemd + starting services"
loginctl enable-linger "$USER" 2>/dev/null || true   # survive logout
systemctl --user daemon-reload
systemctl --user enable --now whatsapp-bridge.service
systemctl --user enable --now whatsapp-bridge-keepalive.timer
if [ "$WITH_BACKFILL_TIMER" -eq 1 ]; then
  systemctl --user enable --now whatsapp-backfill.timer
fi
if [ "$WITH_TRANSCRIBE_TIMER" -eq 1 ]; then
  systemctl --user enable --now whatsapp-transcribe.timer
fi
if [ "$WITH_ENRICH_TIMER" -eq 1 ]; then
  systemctl --user enable --now whatsapp-enrich.timer
fi

# ─── Surface the pairing code if present ─────────────────────────────────────
echo "▶ Waiting briefly for the bridge to come up"
sleep 6
CODE=$(journalctl --user -u whatsapp-bridge.service --no-pager --since "30 seconds ago" 2>/dev/null \
       | grep -oE "pairing code: [A-Z0-9-]+" | tail -1 || true)
if [ -n "$CODE" ]; then
  echo ""
  echo "════════════════════════════════════════════════════════════════════"
  echo "  WhatsApp pairing code: ${CODE#pairing code: }"
  echo "  Enter on +$WA_PHONE WhatsApp → Settings → Linked Devices →"
  echo "  Link a Device → Link with phone number"
  echo "════════════════════════════════════════════════════════════════════"
  echo ""
  echo "  Codes expire in 3 minutes. After successful pair, the bridge will"
  echo "  open :8080 and the auto-backfill timer will fire periodically."
else
  if lsof -nP -iTCP:8080 2>/dev/null | grep -q LISTEN; then
    echo "▶ Bridge is already paired and listening on :8080 — done."
  else
    echo "▶ No pairing code visible yet. Tail the log:"
    echo "    journalctl --user -u whatsapp-bridge.service -f"
  fi
fi

echo ""
echo "▶ Status reference:"
echo "    systemctl --user status whatsapp-bridge.service"
echo "    systemctl --user list-timers whatsapp-backfill.timer whatsapp-transcribe.timer whatsapp-enrich.timer"
echo "    curl -fsS -X POST http://127.0.0.1:8080/api/backfill   # on-demand backfill"
echo "    systemctl --user start whatsapp-transcribe.service     # on-demand transcribe"
echo "    systemctl --user start whatsapp-enrich.service         # on-demand media enrich"
echo "    ~/bin/wa-inbox-fresh.sh                                 # pre-scan freshness gate"
