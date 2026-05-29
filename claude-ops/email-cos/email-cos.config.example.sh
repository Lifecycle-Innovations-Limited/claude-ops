#!/usr/bin/env bash
# email-cos.config.example.sh — Copy to ~/.config/email-cos/config.sh, fill in values,
# then run email-cos/install.sh.
#
# This file contains PLACEHOLDERS ONLY — no real addresses, IDs, JIDs, or tokens.
# Never commit config.sh (it is in .gitignore).
# Every script sources this via the EMAIL_COS_CONFIG env var, or falls back to
#   ./email-cos.config.sh -> ~/.config/email-cos/config.sh

# ── Core ─────────────────────────────────────────────────────────────────────

# Primary Gmail account used for all gog commands.
EMAIL_COS_ACCOUNT="your.address@gmail.com"

# Directory where runtime state lives (seen_sweep.txt, pending.d/, metrics.jsonl…).
# Must be writable by the user running the service.
EMAIL_COS_STATE_DIR="${HOME}/.local/state/email-cos"

# Pocket pipeline state directory (review.jsonl, tasks.jsonl, approval-codemap.json…).
EMAIL_COS_POCKET_STATE_DIR="/var/lib/pocket-pipeline"

# ── LLM models ───────────────────────────────────────────────────────────────

# L1 sweep classifier (fast, cheap — haiku-class recommended).
EMAIL_COS_SWEEP_MODEL="claude-haiku-4-5-20251001"

# L2 orchestrator (full reasoning — opus recommended for quality drafts).
EMAIL_COS_ORCH_MODEL="claude-opus-4-5"

# Natural-language approval interpreter (haiku-class recommended).
EMAIL_COS_NL_MODEL="claude-haiku-4-5-20251001"
# Optional: path to a JSON file with ONLY the enrichment MCP servers the
# orchestrator needs (e.g. gbrain + tavily). Headless agents must NOT load the
# full MCP env or the model context overflows. Empty => orchestrator runs with
# no MCP (drafts from thread context only).
EMAIL_COS_ORCH_MCP_CONFIG=""

# ── Caps ─────────────────────────────────────────────────────────────────────

# Max LLM draft-reply calls per orchestrator run.
EMAIL_COS_DRAFT_CAP_RUN="4"

# Max LLM draft-reply calls across all runs in a single calendar day.
EMAIL_COS_DRAFT_CAP_DAY="30"

# Max iCloud reminder pushes per orchestrator run.
EMAIL_COS_REMIND_CAP_RUN="12"

# ── Channel: Telegram ────────────────────────────────────────────────────────
# Token comes from env TELEGRAM_BOT_TOKEN (set in ~/.mcp-secrets.env or Doppler).
# Leave ENABLE unset or set to "false" to skip Telegram entirely.

EMAIL_COS_TG_ENABLE="false"

# Numeric Telegram chat ID to receive notifications (your user ID or a group/channel).
EMAIL_COS_TG_CHAT_ID="YOUR_TELEGRAM_CHAT_ID"

# @username of the Telegram bot used for outbound notifications.
EMAIL_COS_TG_BOT_USERNAME="YourTelegramBotUsername"

# ── Channel: WhatsApp ────────────────────────────────────────────────────────
# Requires a running whatsapp-bridge (default: http://localhost:8080).
# Leave ENABLE unset or set to "false" to skip WhatsApp entirely.

EMAIL_COS_WA_ENABLE="false"

# WhatsApp JID to send confirmations to (e.g. self-chat or a dedicated number).
# Format: <country-code><phone>@s.whatsapp.net
EMAIL_COS_WA_JID="YOURPHONENUMBER@s.whatsapp.net"

# URL of the local WhatsApp bridge API.
EMAIL_COS_WA_BRIDGE_URL="http://localhost:8080"

# ── Channel: Slack ───────────────────────────────────────────────────────────
# Tokens come from env SLACK_MCP_XOXC (xoxc- user token) and SLACK_MCP_XOXD
# (d= cookie value). Set in ~/.mcp-secrets.env or Doppler.
# Leave ENABLE unset or set to "false" to skip Slack entirely.

EMAIL_COS_SLACK_ENABLE="false"

# Slack DM channel ID to post to (e.g. your self-DM D* channel).
# If left empty the script will auto-resolve it via conversations.open on first run
# and cache the result in $EMAIL_COS_STATE_DIR/slack-dm-channel.
EMAIL_COS_SLACK_DM_CHANNEL=""

# Your Slack member ID (U* format). Used by conversations.open when SLACK_DM_CHANNEL
# is not pre-filled.
EMAIL_COS_SLACK_UID="UYOURSLACKUID"

# ── Channel: iCloud Reminders ────────────────────────────────────────────────
# Credentials come from env ICLOUD_APPLE_ID and ICLOUD_APP_PW
# (app-specific password — never your main Apple password).
# Leave ENABLE unset or set to "false" to skip iCloud reminders entirely.

EMAIL_COS_ICLOUD_ENABLE="false"

# CalDAV URL for the target Reminders list.
# Find yours: Settings → iCloud → Reminders → share link (contains the numeric path).
EMAIL_COS_ICLOUD_LIST_URL="https://pXX-caldav.icloud.com:443/YOURNUMERICID/calendars/YOUR-LIST-UUID"
