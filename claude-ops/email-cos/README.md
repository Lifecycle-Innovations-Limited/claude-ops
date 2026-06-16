# email-cos — Agentic Email Chief-of-Staff

A two-tier, approval-gated email automation system that runs as systemd user timers. It classifies every new inbox message, enriches and drafts replies using Claude, routes approval requests to your preferred channel(s), and sends approved replies only after you say so.

Every channel is optional. The system works on Gmail alone.

> **Channels are consolidated to ONE wire by default.** The default + recommended approval surface is the **Telegram inline buttons** (tap ✅/❌ to approve/reject, with tap feedback and failure alerts on the same bot). Slack, WhatsApp, and iCloud are **opt-in and OFF by default** — enable them only via their respective `EMAIL_COS_*_ENABLE=true` flags.

## Architecture

```
inbox
  └── L1 sweep (Haiku, ~10 min)
        classify → label/archive → queue pending.d/<id>.json
              └── L2 orchestrator (Opus, ~20 min)
                    enrich (gbrain + Tavily) → compose draft
                    Legal/Finance → iCloud reminder (no draft)
                    Others → pocket review.jsonl ASK
                          └── pocket digest → email + Telegram + WhatsApp
                                └── approve-agent (~3 min)
                                      reads Gmail/Slack/Telegram replies
                                      interprets APPROVE A1 / natural language
                                      writes tasks.jsonl
                                          └── sender (~3 min)
                                                gog gmail send (hook-exempt)
```

Drafts are NEVER sent without your explicit approval. The outbound guardrail (`block-outbound-comms.py`) is an additional defense layer; the approval gate in the orchestrator prompt is the primary control.

## Install

```bash
# 1. Clone / update the claude-ops plugin (already done if you're reading this).
# 2. Run the installer:
bash claude-ops/email-cos/install.sh

# 3. Edit the config that was created:
$EDITOR ~/.config/email-cos/config.sh

# 4. Edit the category rules:
$EDITOR ~/.config/email-cos/categories.json

# 5. Re-run the installer to activate timers for your enabled channels:
bash claude-ops/email-cos/install.sh
```

### Prerequisites

- `claude` CLI authenticated (`claude auth login`)
- `gog` CLI authenticated for your Gmail account (`gog auth add your@gmail.com --services gmail`)
- `python3` (3.9+) in PATH
- `systemd --user` (Linux)
- `once.sh` lock library at `~/.claude/scripts/lib/once.sh` (included in claude-ops)

## Configuration

Copy `email-cos.config.example.sh` to `~/.config/email-cos/config.sh` and fill in your values. Every setting has a sensible default except `EMAIL_COS_ACCOUNT`, which is required.

### Per-channel setup

#### Email (gog/Gmail) — required

The only required channel. Handles sweep, draft, send, and approve-by-reply.

```sh
EMAIL_COS_ACCOUNT="your.address@gmail.com"
```

Auth: `gog auth add your.address@gmail.com --services gmail`

Common auth issues:

- `GOG_KEYRING_PASSWORD` not set: add it to `~/.mcp-secrets.env` (it is the password for gog's keychain).
- Token expired: re-run `gog auth add ...` to refresh.
- `--no-input` fails silently: ensure `GOG_KEYRING_PASSWORD` is exported before calling gog.

#### Telegram

Outbound notifications (via Bot API) + inbound approval reads (via MTProto client).

```sh
EMAIL_COS_TG_ENABLE="true"
EMAIL_COS_TG_CHAT_ID="123456789"       # your Telegram user ID or channel ID
EMAIL_COS_TG_BOT_USERNAME="YourBot"   # @username of the bot (no @)
```

Required env (in `~/.mcp-secrets.env` or Doppler):

- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` — from my.telegram.org
- `TELEGRAM_SESSION` — MTProto StringSession (generate once with gramjs)

Common auth issues:

- Bot not started: send `/start` to your bot before the first run.
- MTProto session expired: regenerate `TELEGRAM_SESSION` with a one-time gramjs script (see telegram-server/README in this repo).
- `approve-agent` reads the bot DM to get your replies. If the MTProto session is missing, Telegram approval still works via Gmail reply.

Known limit: Telegram approval requires a live MTProto session. If the session is expired, only Gmail and Slack approval paths are active.

#### Telegram inline-button approvals

An alternative approval path that requires no text replies — each digest item is posted as a Telegram message with tappable ✅ / ❌ buttons (or a) / b) / c) for multi-option items). Tapping a button immediately promotes the decision to `tasks.jsonl`.

**How it works:**

```
pocket digest → email-cos-tg-approve.py send
                  posts one button message per open ASK to Telegram
                  writes tg-callmap.json (short_id → full item)
                      │
user taps ✅/❌/a/b/c in Telegram
                      │
ops-message-listener (getUpdates owner)
  tees callback_query → $POCKET_STATE_DIR/tg-callbacks.jsonl
  advances offset via tg-maxoffset (so callbacks are not re-fetched)
                      │
email-cos-tg-process.timer (~60s)
  email-cos-tg-approve.py process
    drains tg-callbacks.jsonl
    promotes APPROVE → tasks.jsonl / REJECT → approval-resolved.jsonl
    answers the callback (toast notification in Telegram)
    edits the message to show the result (freezes buttons)
```

**Dependency on the message-listener tee:** The listener script (`scripts/ops-message-listener.sh`) owns the bot's `getUpdates` long-poll. A second `getUpdates` poller for the same token would conflict and cause updates to be delivered to only one. The listener tees `callback_query` updates to `tg-callbacks.jsonl` so `email-cos-tg-approve.py process` can drain them without competing. This means the button system only works when `ops-message-listener` is running as the sole `getUpdates` consumer for the bot.

**Setup:**

```sh
EMAIL_COS_TG_ENABLE="true"
EMAIL_COS_TG_CHAT_ID="123456789"       # numeric ID — find via @userinfobot
# EMAIL_COS_APPROVAL_BOT_TOKEN=""      # defaults to TELEGRAM_BOT_TOKEN
# EMAIL_COS_APPROVALS_PY=""            # defaults to scripts/ops-pocket-approvals.py
```

After configuring, re-run `install.sh` — it will enable `email-cos-tg-process.timer` automatically when `EMAIL_COS_TG_ENABLE=true` and `EMAIL_COS_TG_CHAT_ID` are both set.

To post button messages manually: `~/.local/share/email-cos/email-cos-tg-approve.py send`

To drain callbacks manually: `~/.local/share/email-cos/email-cos-tg-process.sh`

**Same-bot caveat:** Buttons are sent by the same bot token that the message-listener uses for `getUpdates`. Using a different bot token for button messages would require that bot to also own `getUpdates`, creating a conflict. Keep `EMAIL_COS_APPROVAL_BOT_TOKEN` unset (inherits `TELEGRAM_BOT_TOKEN`) unless you have explicitly set up the listener to use a different token for its polling.

#### WhatsApp

Outbound confirmation only (no inbound approval reads — WhatsApp self-chat reply-read is not supported).

```sh
EMAIL_COS_WA_ENABLE="true"
EMAIL_COS_WA_JID="YOURPHONENUMBER@s.whatsapp.net"
EMAIL_COS_WA_BRIDGE_URL="http://localhost:8080"
```

Requires a running WhatsApp bridge (whatsapp-mcp or similar) paired to your number. Pair via the bridge's QR flow.

Common auth issues:

- Bridge not running: `systemctl --user status whatsapp-bridge`
- JID format wrong: use `<countrycode><number>@s.whatsapp.net` (no + prefix, no spaces).
- Bridge unpaired: re-scan QR.

Known limit: WhatsApp approval (APPROVE/REJECT replies) is not read by the approve-agent. Use Gmail or Slack for approval replies.

#### Slack

Self-DM via browser-session tokens. Posts notifications to your Slack self-DM and reads your replies for approval interpretation.

```sh
EMAIL_COS_SLACK_ENABLE="true"
EMAIL_COS_SLACK_UID="UYOURSLACKUID"          # your Slack member ID (U...)
EMAIL_COS_SLACK_DM_CHANNEL=""                # leave empty; auto-resolved on first run
```

Required env (in `~/.mcp-secrets.env`):

- `SLACK_MCP_XOXC` or `SLACK_MCP_XOXC_TOKEN` — xoxc- user token (from browser DevTools)
- `SLACK_MCP_XOXD` or `SLACK_MCP_XOXD_TOKEN` — d= cookie value

Common auth issues:

- xoxc token expired: Slack browser-session tokens expire when you log out or Slack rotates them. Extract fresh values from browser DevTools → Application → Cookies (d=) and Network → any API call header (Authorization: xoxc-...).
- Channel not resolving: if `conversations.open` returns empty, set `EMAIL_COS_SLACK_DM_CHANNEL` to your known D\* channel ID directly.

#### iCloud Reminders

Pushes VTODO items for Legal and Finance emails (no reply drafted — human-in-loop only).

```sh
EMAIL_COS_ICLOUD_ENABLE="true"
EMAIL_COS_ICLOUD_LIST_URL="https://pXX-caldav.icloud.com:443/NUMERICID/calendars/UUID"
```

Required env:

- `ICLOUD_APPLE_ID` — your Apple ID email
- `ICLOUD_APP_PW` — app-specific password (Settings → Apple ID → Passwords & Security → App-Specific Passwords). Never your main Apple password.

Common auth issues:

- HTTP 401: app-specific password revoked or wrong. Generate a new one.
- HTTP 404: list URL is wrong. Find yours by navigating to iCloud web → Reminders → share a list → the URL contains your numeric ID and list UUID.

## Categories

Edit `~/.config/email-cos/categories.json` to define your routing rules. The sweep agent reads this at runtime and injects the category list into its prompt. You can add, rename, or remove categories without editing any script.

Categories with `"no_autodraft": true` (Legal, Finance by default) skip reply drafting and create reminders instead.

The `"fallback": true` category catches everything not matched by prior rules.

## Security

- Outbound email is never sent without explicit approval (write to `tasks.jsonl` only after human APPROVE).
- Subagents spawned by the orchestrator are read-only by design (they cannot call `gog gmail send`).
- The orchestrator treats email body content as untrusted data and never acts on instructions embedded in emails.
- Self-identity exemption: emails from the configured account's own address are never staged for reply.
- Legal and Finance emails never get auto-drafted replies — they get reminders only.

## Timers reference

| Timer                | Default cadence  | Enabled when                              |
| -------------------- | ---------------- | ----------------------------------------- |
| email-cos-sweep      | every 10 min     | EMAIL_COS_ACCOUNT set                     |
| email-cos-orch       | every 20 min     | EMAIL_COS_ACCOUNT set                     |
| email-cos-sender     | every 3 min      | EMAIL_COS_ACCOUNT set                     |
| email-cos-compact    | weekly Sun 04:30 | EMAIL_COS_ACCOUNT set                     |
| email-cos-approve    | every 3 min      | any channel + account                     |
| email-cos-status     | daily 08:00      | TG or Slack enabled                       |
| email-cos-tg-process | every ~60s       | EMAIL_COS_TG_ENABLE=true + TG_CHAT_ID set |

Check timer health: `systemctl --user list-timers 'email-cos*'`

Check live output: `journalctl --user -u email-cos-sweep.service -f`

Manual status: `~/.local/share/email-cos/email-cos-status.sh`
