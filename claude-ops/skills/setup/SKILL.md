---
name: setup
description: Interactive setup wizard for the claude-ops plugin. Installs missing CLIs, configures env vars for each channel (Telegram, WhatsApp, Email, Slack, Linear, Sentry, Vercel), builds the project registry, and saves user preferences. Run once after installing the plugin or any time to reconfigure.
argument-hint: "[section]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
---

# OPS ► SETUP WIZARD

You are running an **interactive configuration wizard** for the `claude-ops` plugin. The user wants you to walk them through every step needed to get the plugin working: installing CLIs, setting env vars, configuring channels, populating the project registry, and saving preferences.

**Hard rules:**

- This is a _conversation_, not a script dump. Use `AskUserQuestion` for every decision — never ask in prose when a structured selector will do.
- Never install anything or write any file without explicit user confirmation via `AskUserQuestion`.
- Skip sections the user declines. Don't nag.
- Show what's already configured first, so the user only fills gaps.
- **Never show the user's real name or email in output unless the user explicitly provided it in THIS session.** Do not read from memory, existing configs, or environment variables to populate display names.
- Run ALL diagnostic/probe commands in parallel when possible. Use multiple Bash tool calls in a single message. Never run sequential probes when they're independent (e.g., `gog auth status` AND `wacli doctor` AND keychain scouts should all run simultaneously).
- Background any command that might take >2 seconds (sync, backfill, npm install, brew install).
- All writes go to one of these paths — and nothing else:
  - **`$PREFS_PATH`** — per-user preferences + secrets. Resolves to `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json`. Lives in Claude Code's plugin data dir so it survives plugin reinstalls and version bumps. Never committed to git.
  - **`${CLAUDE_PLUGIN_ROOT}/scripts/registry.json`** — per-user project registry (gitignored in the source repo). `mkdir -p` its parent if missing.
  - **`${CLAUDE_PLUGIN_ROOT}/.mcp.json`** — only to add `${user_config.*}` placeholders, never hardcoded tokens.
  - The user's shell profile (`~/.zshrc` etc.) — append-only, never rewrite.
- At the top of every wizard step, make sure `$PREFS_PATH`'s parent directory exists: `mkdir -p "$(dirname "$PREFS_PATH")"`. Claude Code creates `~/.claude/plugins/data/ops-ops-marketplace/` on plugin install but don't assume.

---

## Step 0 — Preflight (runs in background while you read)

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-setup-preflight &>/dev/null &
```

**Preflight data**: All probe results are cached at `/tmp/ops-preflight/`. Before running ANY diagnostic command, check if the result already exists there:
- CLI status: `cat /tmp/ops-preflight/clis.txt`
- Slack: `cat /tmp/ops-preflight/slack.json`
- Telegram: `cat /tmp/ops-preflight/telegram.txt`
- gog/Gmail: `cat /tmp/ops-preflight/gog-gmail.json`
- gog/Calendar: `cat /tmp/ops-preflight/gog-cal.json`
- WhatsApp: `cat /tmp/ops-preflight/wacli-doctor.json` and `wacli-chats.json`
- MCP servers: `cat /tmp/ops-preflight/mcp-servers.txt`
- GitHub: `cat /tmp/ops-preflight/gh-auth.txt`
- AWS: `cat /tmp/ops-preflight/aws-identity.json`
- Projects: `cat /tmp/ops-preflight/projects.txt`
- Existing registry: `cat /tmp/ops-preflight/existing-registry.json`
- Existing prefs: `cat /tmp/ops-preflight/existing-prefs.json`

Wait for `/tmp/ops-preflight/.complete` to exist before reading (it should be ready within 2-3 seconds). NEVER re-run a probe that already has cached results — read the cache file instead.

---

## Step 0b — Detect current state

Run the detector and parse its JSON output (or read from preflight cache if available):

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-setup-detect 2>/dev/null
```

If `CLAUDE_PLUGIN_ROOT` is unset, fall back to the latest installed cache dir at `~/.claude/plugins/cache/ops-marketplace/ops/<latest-version>/`. Store the resolved path as `PLUGIN_ROOT` for the rest of the session.

Also resolve `PREFS_PATH` once and reuse it everywhere:

```bash
PREFS_PATH="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json"
mkdir -p "$(dirname "$PREFS_PATH")"
```

Print a compact status header to the user, one line per category:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► SETUP WIZARD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Shell:       zsh → ~/.zshrc
 Core CLIs:   ✓ jq  ✓ git  ✓ gh  ✓ aws  ✓ node
 Channels:    ✓ wacli  ✓ gog  ○ telegram (no token)
 MCPs:        ✓ linear  ✓ sentry  ○ slack  ○ vercel
 Registry:    19 projects
 Preferences: not set
──────────────────────────────────────────────────────
```

Use `✓` for present/set, `○` for missing/unset, `✗` for broken.

---

## Step 1 — Ask which sections to configure

Use `AskUserQuestion` with `multiSelect: true`. Offer **only sections that need attention** (skip ones already green):

| Option             | Header   | Description                                      |
| ------------------ | -------- | ------------------------------------------------ |
| Install CLIs       | cli      | Install missing command-line tools via Homebrew  |
| Configure channels | channels | Set tokens for Telegram, WhatsApp, Email, Slack  |
| Configure MCPs     | mcp      | Enable Linear, Sentry, Vercel, Gmail MCP servers |
| Companion plugins  | plugins  | Install GSD for project roadmap tracking         |
| Build registry     | registry | Register projects Claude should manage           |
| Save preferences   | prefs    | Owner name, timezone, default priorities         |
| Shell env          | env      | Export `CLAUDE_PLUGIN_ROOT` in shell profile     |

Store the user's selections and run each selected section in order.

---

## Step 2 — Install CLIs (if selected)

For each missing tool in the detector output, ask with `AskUserQuestion` one question per tool (or a single multiSelect listing all missing ones):

```
Install jq?           [Yes, install now] [Skip]
Install gh?           [Yes, install now] [Skip]
Install wacli?        [Yes, install now] [Skip — manual install required]
```

For each `Yes`, run:

```bash
${PLUGIN_ROOT}/bin/ops-setup-install <tool>
```

Report success/failure. If Homebrew is missing on macOS, stop and tell the user to install it from https://brew.sh first — do not attempt to install brew automatically.

After installation, re-run `ops-setup-detect` to refresh status before continuing.

---

## Step 2b — Companion plugins (if selected)

### GSD (Get Shit Done)

GSD is a third-party Claude Code plugin that adds project roadmap tracking. When installed, claude-ops dashboards (`/ops:go`, `/ops:projects`, `/ops:next`, `/ops:yolo`) automatically show active phases, progress, and next actions per project. Without it, those sections are simply omitted.

Check if GSD is already installed:

```bash
ls ~/.claude/plugins/cache/*/gsd*/skills/gsd-progress/SKILL.md 2>/dev/null && echo "installed" || echo "not_installed"
```

If not installed, ask via `AskUserQuestion`:

```
GSD adds project roadmap tracking to your ops dashboards.
  /ops:go shows active phases and progress per project
  /ops:projects shows GSD state alongside CI/PR status
  /ops:next factors in GSD work priority

  [Install GSD (latest)] [Skip — I don't need roadmap tracking]
```

On install, tell the user:

```
To install GSD, run these commands in Claude Code:
  /plugin marketplace add auroracapital/get-shit-done
  /plugin install gsd@auroracapital-get-shit-done
```

These are slash commands — run them in the Claude Code interface, not in a terminal. After running them, come back and re-run `/ops:setup` to continue.

Report success/failure. If the user confirms they've installed it, record `plugins.gsd = "installed"` in `$PREFS_PATH`. If they skip:

```
Skipped GSD install. You can install it later:
  /plugin marketplace add auroracapital/get-shit-done
  /plugin install gsd@auroracapital-get-shit-done
```

---

## Step 3 — Configure channels (if selected)

Ask which channels the user wants to configure using `AskUserQuestion` with `multiSelect: true`:

| Option   | Header   | Description                                                             |
| -------- | -------- | ----------------------------------------------------------------------- |
| Telegram | telegram | Bot token + owner ID for `/ops-comms telegram`                          |
| WhatsApp | whatsapp | wacli doctor + auto-heal + backfill                                     |
| Email    | email    | gog CLI → Gmail MCP fallback for `/ops-inbox email`                     |
| Slack    | slack    | Slack MCP server (managed by Claude Code)                               |
| Calendar | calendar | gog cal → Google Calendar MCP fallback — schedule context for briefings |

For each selected channel, run the matching sub-flow below.

---

#### Shared: prefer OAuth over manual tokens

Whenever a channel has a **browser-based OAuth flow** available, offer that first and put manual-token entry behind it as a fallback. OAuth is safer (scoped, revocable, no secrets in dotfiles), and usually faster for the user.

| Channel        | OAuth path                                                 | Manual fallback                        |
| -------------- | ---------------------------------------------------------- | -------------------------------------- |
| Email (gog)    | `gog auth login` (browser)                                 | n/a — gog is OAuth-only                |
| Calendar (gog) | same `gog auth login` with `--scopes=calendar`             | n/a                                    |
| Slack          | `claude mcp add slack` (handles OAuth through Claude Code) | bot token via auto-scan + manual paste |
| Linear         | `claude mcp add linear`                                    | API key                                |
| Sentry         | `claude mcp add sentry`                                    | DSN / auth token                       |
| Vercel         | `claude mcp add vercel`                                    | personal access token                  |
| Telegram       | ❌ no OAuth (Bot API is token-only by design)              | auto-scan + manual paste (only option) |
| WhatsApp       | QR pairing via `wacli auth` (similar UX to OAuth)          | n/a — paired sessions only             |

When a channel supports OAuth, the default `AskUserQuestion` should lead with it:

```
[Connect via OAuth (recommended)]  [Enter a token manually]  [Skip]
```

Only go into the credential auto-scan flow below when the user picks "manually" or when the channel (Telegram, local tools) has no OAuth path.

---

#### Shared: credential auto-scan

**Before prompting the user to paste any token**, scan for it in these sources (in order). Show the user what was found and ask them to confirm or override. Never silently use a token without confirmation.

For each variable name (e.g. `TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`):

1. **Current shell environment** — `printenv <VAR>`. Running shell inherits exports, Doppler injections, dotenv-loaded files. Most likely to be correct.
2. **Shell profile files** — grep `~/.zshrc`, `~/.bashrc`, `~/.zprofile`, `~/.config/fish/config.fish`, `~/.envrc` (direnv) for `<VAR>=` or `export <VAR>=`. Show the file path next to the value so the user knows where it's from.
3. **Doppler** — if `command -v doppler` succeeds:
   - Run `doppler secrets --json 2>/dev/null` on the current Doppler project (if one is configured). Parse the output.
   - Also try `doppler secrets get <VAR> --plain 2>/dev/null` for an exact-name match across the default project.
   - If multiple Doppler projects exist, don't iterate all of them — ask the user which project to scan.
4. **Installed MCP configs** — read each `.mcp.json` the detector found (`mcp_configured` provides the server names, but we also need the raw files). For each server entry, look at `.env` and `.args` for the variable name or for literal values that look like the target (e.g. `123456:ABC-...` for Telegram tokens, `xoxb-...` / `xoxp-...` for Slack tokens). Show the MCP server name as the source.
5. **System keychain** — do NOT scan. Keychain access requires user approval and leaks cross-app secrets. Skip.

**Present the findings** with `AskUserQuestion`:

```
Found credential for TELEGRAM_BOT_TOKEN:
  [A] shell env ($TELEGRAM_BOT_TOKEN) — 12345...xyz  (last 4 chars shown, never full)
  [B] ~/.zshrc line 42 — 12345...xyz  (same value — match)
  [C] Doppler (project: claude-ops, config: dev) — 67890...abc  (different!)
  [D] .mcp.json / telegram server — ${user_config.telegram_bot_token} (placeholder, not a value)
  [E] Enter manually
```

Rules for the prompt:

- Only show the **last 4 characters** of any token, never the whole thing.
- If multiple sources have the **same** value, collapse them into one option with `(matched in env + ~/.zshrc)` appended.
- If sources **disagree**, show them all and flag the mismatch prominently — the user needs to pick which one is authoritative and the wizard should offer to sync the others.
- Placeholder values like `${user_config.*}`, `<your-token>`, `CHANGE_ME`, or empty strings count as NOT FOUND.
- Always include an `[Enter manually]` option.

**On selection**, use the chosen value as the source of truth and — with the user's consent — optionally propagate it back to the other sources (e.g. "Also update ~/.zshrc and Doppler to match?"). Default to NO for propagation unless the user opts in.

---

### 3a — Telegram (user-auth via ops-telegram-autolink)

**Always ask before starting the Telegram flow** — even when the user selected "all channels". Use `AskUserQuestion`:

```
Set up Telegram personal account access?
  [Yes — enter my phone number and authenticate]
  [Skip Telegram]
```

If the user skips, record `channels.telegram = "skipped"` in `$PREFS_PATH` and move on. Do NOT silently mark Telegram as unconfigured — the explicit skip prevents the status header from showing `○ telegram (no token)` as an action item on subsequent runs.

**Bots cannot read user DMs**, so `/ops-inbox telegram` requires a personal-account MCP. The plugin ships `bin/ops-telegram-autolink.mjs` which:

1. Scans scout sources (keychain → ~/.claude.json → shell profiles → Doppler) for previously-extracted `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` / `TELEGRAM_SESSION`.
2. If none found, makes plain HTTP requests to `my.telegram.org` (no browser — `my.telegram.org` uses server-side HTML, no JS required), logs in with a phone code from the bridge file, creates an app if needed, and extracts api_id + api_hash.
3. Runs gram.js `client.start()` to generate a session string, bridging the second code via the same file.
4. Emits final JSON on stdout: `{api_id, api_hash, phone, session}`.

Sub-flow (only runs if user selected Yes above):

1. **Scout first.** Check keychain for previously-extracted Telegram credentials:

   ```bash
   for svc in telegram-api-id telegram-api-hash telegram-phone telegram-session; do
     security find-generic-password -s "$svc" -w 2>/dev/null && echo "FOUND: $svc"
   done
   ```

   Also check `~/.claude.json mcpServers.telegram.env.TELEGRAM_API_ID`. If all 4 are found and the stored `TELEGRAM_SESSION` decodes as a StringSession, tell the user `"✓ Telegram already configured (api_id=XXXXXXX, phone=+XX...)"` and skip to step 8.

2. **Ask the user for their phone number** via `AskUserQuestion` (free-text). Validate it matches `^\+\d{7,15}$`. Explain that the phone is only used once during the first-run extraction and is stored locally only.

3. **Warn about 2 codes.** Inform the user via `AskUserQuestion`: `"Telegram will send TWO codes to your Telegram app — one for my.telegram.org web login, then a second one for gram.js auth. Have your Telegram app ready."` Options: `[I'm ready]`, `[Cancel]`.

4. **Spawn the autolink script in the background with restrictive file perms:**

   ```bash
   (umask 077 && node "${CLAUDE_PLUGIN_ROOT}/bin/ops-telegram-autolink.mjs" --phone "$PHONE" 2>/tmp/ops-telegram-autolink.log 1>/tmp/ops-telegram-autolink.out &)
   echo $! > /tmp/ops-telegram-autolink.pid
   ```

   Use the Bash tool's `run_in_background: true`. The `umask 077` creates all bridge files (log, out) with mode 0600. The .out file contains the full credential JSON including the gram.js session string — if it's world-readable, any local process can exfiltrate long-lived Telegram account access.

5. **Poll the stderr log for `need_code` events.** Every 3 seconds, read `/tmp/ops-telegram-autolink.log` and look for the most recent `{"type":"need_code", ...}` line that hasn't been answered yet. When you see one:
   - Determine which code: `channel: "web_login"` (first) or `channel: "gram_auth"` (second).
   - Use `AskUserQuestion` with a free-text input: `"Enter the code Telegram just sent to your Telegram app (digits only):"`.
   - Write the digits to `/tmp/telegram-code.txt` with restrictive perms: `Bash: (umask 077 && printf '%s' "$CODE" > /tmp/telegram-code.txt)`. The `umask 077` is critical — without it the file is created world-readable on macOS (where `/tmp` is `drwxrwxrwt`) and any local process can race to read the code during the 2s poll window.
   - Wait for the next event.
   - If you see `{"type":"need_password"}`, handle 2FA: ask the user via `AskUserQuestion` and write to `/tmp/telegram-password.txt` with `(umask 077 && printf '%s' "$PW" > /tmp/telegram-password.txt)`. Same perm hardening as the code file. The 2FA password is far more sensitive than a one-time code.

6. **Wait for the script to exit.** Poll until the process is no longer running (`ps -p "$(cat /tmp/ops-telegram-autolink.pid)"`). Read `/tmp/ops-telegram-autolink.out` — it should contain a single JSON line with `api_id`, `api_hash`, `phone`, and `session`. **Security note**: the setup skill should have dispatched the autolink with `(umask 077 && node "${CLAUDE_PLUGIN_ROOT}/bin/ops-telegram-autolink.mjs" --phone "$PHONE" 2>/tmp/ops-telegram-autolink.log 1>/tmp/ops-telegram-autolink.out &)` so the .log and .out files get 0600 mode. Verify with `stat -f '%Lp' /tmp/ops-telegram-autolink.out` → must print `600`. Immediately `shred -u` (Linux) or `rm -P` (macOS) the .out file after reading the credentials into memory.

7. **Persist to keychain + preferences.** macOS only:

   ```bash
   security add-generic-password -U -s telegram-api-id -a "$USER" -w "$API_ID"
   security add-generic-password -U -s telegram-api-hash -a "$USER" -w "$API_HASH"
   security add-generic-password -U -s telegram-phone -a "$USER" -w "$PHONE"
   security add-generic-password -U -s telegram-session -a "$USER" -w "$SESSION"
   ```

   Then update `$PREFS_PATH` with `channels.telegram = {backend: "gram.js", api_id: "...", phone: "...", status: "configured"}`. **Never write the api_hash or session to preferences.json** — those stay in keychain only. preferences.json gets only the non-sensitive metadata.

8. **Instruct the user to wire it into Claude Code plugin settings.** Print:

   ```
   Your Telegram credentials are saved. To activate the MCP, open:
     /plugin
   Select ops@ops-marketplace → Settings. Paste these values:
     telegram_api_id:   <api_id>
     telegram_api_hash: (from keychain: `security find-generic-password -s telegram-api-hash -w`)
     telegram_phone:    <phone>
     telegram_session:  (from keychain: `security find-generic-password -s telegram-session -w`)
   Restart Claude Code to pick up the new env vars.
   ```

9. **Smoke test (optional).** Spawn `node ${CLAUDE_PLUGIN_ROOT}/telegram-server/index.js` with the env vars set inline for 3 seconds. If it doesn't print an auth error, the session works.

**Privacy notes for the user** (show once at start):

- The phone number and all credentials stay on your machine. The wizard never transmits them anywhere except to Telegram's own servers during the HTTP login flow.
- If you already have a gram.js / Telethon session for another project, you can skip this and paste those values manually into `/plugin settings`.
- If Telegram replies "Sorry, too many tries. Please try again later." your account is rate-limited for ~8 hours — the wizard cannot bypass this. Wait and retry.

### 3b — WhatsApp (doctor + self-heal + backfill)

WhatsApp is the channel that most often breaks silently. The wizard must **auto-diagnose, doctor, and fix** — not just report status and give up. Run this whole sub-flow top-to-bottom, stopping only when the system is healthy or the user declines a remediation.

#### Step 3b.1 — Presence

Run `command -v wacli`. If missing, ask `AskUserQuestion`: `[Show install docs]`, `[Skip WhatsApp]`. On install docs, print:

```
wacli is not on Homebrew. Install:
  git clone https://github.com/auroracapital/wacli ~/src/wacli
  cd ~/src/wacli && go build -o /usr/local/bin/wacli ./cmd/wacli
```

and stop this sub-flow.

#### Step 3b.2 — Collect state

Run these in parallel:

```bash
wacli doctor --json 2>&1
wacli auth status --json 2>&1
wacli messages list --after="$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d '1 day ago' +%Y-%m-%d)" --limit=5 --json 2>&1
wacli chats list --json 2>&1 | head -c 4000
```

Parse:

- `doctor.data.authenticated` (bool)
- `doctor.data.lock_held` + `doctor.data.lock_info` (PID + acquired_at timestamp)
- `doctor.data.fts_enabled` (bool — if false, search is degraded, not fatal)
- `messages.data.messages` length → **this is the key health signal**. Authed with zero messages in the last 24h = broken.
- `chats` count and whether it populated at all

#### Step 3b.3 — Diagnose and classify

Apply these rules in order. Stop at the first match.

**A. Not authenticated**
If `doctor.authenticated: false` → print "Run `wacli auth` in a separate terminal to scan the pairing QR, then re-run /ops:setup whatsapp." End of sub-flow. Do **not** try to automate the QR scan — it requires the user's phone in hand.

**B. Stuck sync (stale lock)**
If `lock_held: true` AND the `lock_info.acquired_at` is older than 2 minutes AND the lock-holder PID is still alive (`ps -p <pid>`):

1. Run `wacli sync` in the background (`timeout 15 wacli sync 2>&1`) via the existing process's stderr tail — OR if we can't tee into it, fall back to:
2. Ask `AskUserQuestion`: `"A wacli sync process (pid=N) has been holding the store lock for Xm. Most likely stuck. Kill it?"` → `[Kill pid N and restart sync]`, `[Leave it running]`.
3. On kill: `kill <pid>` (not -9 first). Wait 3s. If still alive, `kill -9 <pid>`. Verify with `ps -p <pid>`.
4. After kill, re-run `wacli doctor --json` to confirm lock is released. Continue to the next rule.

**C. App-state key desync (the big one)**
Run `timeout 15 wacli sync 2>&1 | tee /tmp/wacli-sync-probe.log` (must be done after B so the lock is free). Grep the output for:

- `didn't find app state key` → **session keys are desynced**, needs re-pair
- `failed to decode app state` → same class of error
- `Failed to do initial fetch of app state` → same class of error

If any match:

1. Print the diagnosis verbatim:
   ```
   ⚠  WhatsApp session is authenticated but the app-state decryption keys
      are out of sync with your primary device. This happens when the
      linked-device session is partially wiped on the phone side.
      Symptom: sync runs but 0 messages come through.
      Fix: logout this session and re-pair via QR.
   ```
2. Ask `AskUserQuestion`: `[Logout and walk me through re-pair]`, `[Skip — I'll fix manually]`.
3. On logout: run `wacli auth logout --json` and show the result. Then print:
   ```
   Now run `wacli auth` in a separate terminal.
   A QR code will appear — scan it from WhatsApp → Settings → Linked Devices → Link a device.
   When it says "Connected", come back and type "done".
   ```
4. Wait for the user to confirm via `AskUserQuestion`: `[Done — re-paired]`, `[Cancel]`.
5. On Done, re-run Step 3b.2 to re-collect state and continue to rule D.

**D. Authenticated, lock free, no recent messages, no key errors**
This is usually a cold cache. Go to Step 3b.4 (backfill).

**E. Healthy (messages flowing)**
If `messages.data.messages` has ≥1 entry from the last 24h, print a ✓ summary and skip to Step 3b.5.

#### Step 3b.4 — Historical backfill (background, silent)

Always run this after a fresh re-pair, AND run it when rule D matches. Never skip unless the user explicitly declines.

Backfill is a background optimization — it should not produce verbose output or alarming status messages. Run it silently and swallow non-fatal errors.

1. Load the top 10 chats by recency:
   ```bash
   wacli chats list --json 2>&1 | jq -r '[.data[] | select(.jid) | {jid, name, last_msg: .last_message_ts}] | sort_by(.last_msg) | reverse | .[0:10]'
   ```
2. Tell the user: `"Running historical backfill on your 10 most-recent chats. This runs in the background."` Do not print per-chat progress or 0-message results.
3. For each chat JID, run **sequentially** (backfill shares the store lock, can't parallelize):
   ```bash
   wacli history backfill --chat="<jid>" --count=50 --requests=2 --wait=30s --idle-exit=5s --json 2>&1
   ```
4. **Suppress all per-chat output.** If the command exits non-zero, swallow the error silently — backfill failures are not user-visible events. Do NOT print "0 messages synced", error tracebacks, or explanations about device connectivity.
5. After the loop completes, print only the final health summary (Step 3b.6).

#### Step 3b.5 — FTS index check (optional)

If `doctor.fts_enabled: false`, print:

```
ℹ  Full-text search is disabled — `wacli messages search` will use SQL LIKE (slower).
   This is a non-fatal known-limitation. See wacli docs to enable FTS5.
```

Don't block on this.

#### Step 3b.6 — Record state

Write `channels.whatsapp = "wacli"` to `$PREFS_PATH` and print the final ✓ summary:

```
✓ WhatsApp — wacli authenticated, N chats
```

Never include message counts or backfill results in this summary line.

### 3c — Email

Email has two possible backends, tried in this order:

#### Preferred: `gog` CLI

`gog` is the email + calendar CLI that `ops-inbox` and `ops-comms` call by default. It's a self-contained binary with its own OAuth token at `~/.gog/token.json` — full read + send permissions, no Claude Desktop config required.

1. Check `gog` on PATH with `command -v gog`.
2. **If installed**, run `gog auth status 2>&1 || true` and show the output.
   - If auth is red (not authenticated / token expired / exit != 0), print:
     ```
     Run `gog auth login` in a separate terminal (it opens a browser for the OAuth flow),
     then come back and re-run /ops:setup email.
     ```
     Do **not** try to automate the OAuth flow — it needs an interactive browser.
   - If auth is green, probe with:
     ```bash
     gog gmail labels list --json 2>&1 | head -5
     ```
     If this returns JSON containing a `labels` array, gog is authenticated and the Gmail API is working. Report ✓. If the output is an error or empty, treat as broken and instruct the user to re-run `gog auth login`.
   - Record `channels.email = "gog"` in `$PREFS_PATH` and stop here.

#### Fallback: Claude Gmail MCP connector

If `gog` is not on PATH, look at the detector's `mcp_configured` array for any entry matching (case-insensitive) `gmail`, `google-mail`, or `claude_ai_Gmail` — these are the common names for Anthropic's Gmail connector or user-installed Gmail MCP servers.

3. **If a Gmail MCP is configured**, ask `AskUserQuestion`:
   - `[Use Gmail MCP (read-only fallback)]`
   - `[Install gog instead — show docs]`
   - `[Skip email]`
4. On "Use Gmail MCP", record `channels.email = "mcp:<name>"` in `$PREFS_PATH` (where `<name>` is the actual MCP server name you found) and **print this warning verbatim**:
   ```
   ⚠  Using the Gmail MCP connector as a fallback.
      Read operations (list inbox, search, fetch) will work.
      SEND operations will fail until you explicitly grant send permissions
      in Claude Desktop → Settings → Connectors → Gmail → Permissions.
      The ops plugin cannot grant those permissions for you — it's a Claude
      Desktop-side setting tied to your account.
      If you want unattended sending from ops-comms, install `gog` instead.
   ```
5. On "Install gog instead", print:
   ```
   gog is a private CLI — install from source:
     git clone https://github.com/auroracapital/gog ~/.gog && cd ~/.gog && ./install.sh
   Or ask Sam for the latest release binary.
   ```
   Then stop this sub-flow (don't attempt to `brew install` — gog isn't on Homebrew).

#### Neither available

6. **If `gog` is missing AND no Gmail MCP is configured**, ask `AskUserQuestion`:
   - `[Install gog — show docs]`
   - `[Add a Gmail MCP — show docs]` → print `claude mcp add gmail` and tell the user to re-run `/ops:setup email` after
   - `[Skip email for now]`
7. Whatever the user picks, record the resulting state in `$PREFS_PATH` (either `channels.email = "gog"`, `channels.email = "mcp:<name>"`, or omit the key entirely).

### 3d — Slack (scout + ops-slack-autolink)

Slack's official API requires workspace admin approval for most useful scopes. The `slack-mcp-server` MCP uses **browser-session tokens** (xoxc + xoxd) that are per-user — no admin approval needed. The plugin ships `bin/ops-slack-autolink.mjs` which:

1. **Phase 1 — scout** — checks for already-extracted tokens in:
   - `~/.claude.json mcpServers.slack.env` (where Claude Code stores them)
   - Process env (`SLACK_MCP_XOXC_TOKEN` / `SLACK_MCP_XOXD_TOKEN` / `SLACK_BOT_TOKEN`)
   - macOS keychain (`slack-xoxc`, `slack-xoxd`)
   - Shell profile files (`~/.zshrc`, `~/.bashrc`, `~/.zprofile`, `~/.envrc`)
   - Doppler (`doppler secrets --json`)
2. **Phase 2 — Playwright extraction** — only if nothing is found, launches a persistent-profile Chromium, opens `https://app.slack.com/client/`, asks the user to log in (or uses an existing session for headless runs), then pulls `xoxc-...` from `localStorage.localConfig_v2.teams[teamId].token` and the `d=...` cookie (`xoxd-...`) from the cookie jar.

Ported from [maorfr/slack-token-extractor](https://github.com/maorfr/slack-token-extractor) (Python → Node).

Sub-flow:

1. **Scout first.** Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/ops-slack-autolink.mjs" --scout-only 2>/tmp/ops-slack.log
   ```

   Parse the stdout JSON. If non-empty with `xoxc_token` + `xoxd_token`, report `"✓ Slack already configured (source=XXX)"` and skip to step 5.

2. **If no existing tokens**, ask via `AskUserQuestion`:
   - `[Extract tokens via Playwright (Recommended)]` → runs the autolink in headed mode.
   - `[I'll paste tokens manually]` → collect `xoxc-...` and `xoxd-...` via two free-text `AskUserQuestion`s.
   - `[Skip Slack]`

3. **On Playwright path**: spawn the autolink in the background:

   ```bash
   (umask 077 && node "${CLAUDE_PLUGIN_ROOT}/bin/ops-slack-autolink.mjs" \
     --workspace "https://app.slack.com/client/" \
     2>/tmp/ops-slack-autolink.log 1>/tmp/ops-slack-autolink.out &)
   echo $! > /tmp/ops-slack-autolink.pid
   ```

   Poll the log for `{"type":"need_login"}`. When you see it, use `AskUserQuestion`:
   `"A Chromium window should be open on your desktop. Log in to Slack there, then pick [Done]."`. On Done, `touch /tmp/slack-login-done`. The script will finish and write the extracted tokens to `/tmp/ops-slack-autolink.out`.

4. **If Playwright is not installed** (script exits with `playwright is not installed`), offer:
   - `[Install Playwright now]` → run `cd ${CLAUDE_PLUGIN_ROOT}/telegram-server && npm install playwright && npx playwright install chromium` (background, ~150MB download, report progress).
   - `[Fall back to manual paste]` → go to step 2 manual path.

5. **Validate tokens.** Call the Slack auth endpoint with exact syntax:
   ```bash
   curl -s -H "Authorization: Bearer XOXC_TOKEN" -b "d=XOXD_TOKEN" "https://slack.com/api/auth.test"
   ```
   Expect `{"ok":true, "team_id":"T...", "user_id":"U...", "url":"https://<workspace>.slack.com/"}`. If `ok:false`, show the error and re-ask.

6. **Persist.**
   - Keychain: `security add-generic-password -U -s slack-xoxc -a "$USER" -w "$XOXC"; security add-generic-password -U -s slack-xoxd -a "$USER" -w "$XOXD"`.
   - `$PREFS_PATH` → `channels.slack = {backend: "mcp:slack", team_id: "...", source: "...", status: "configured"}`. **Do not** store the raw tokens in preferences.json — keychain only.

7. **Wire into Claude Code plugin settings.** Print instructions:

   ```
   Slack tokens saved to keychain. To activate the MCP, Claude Code needs them
   in ~/.claude.json. Since this skill can't write to ~/.claude.json directly,
   either:
     a) Run: claude mcp add slack --transport stdio -- npx -y slack-mcp-server@latest --transport stdio
        and Claude Code will prompt for the env vars.
     b) Manually paste the xoxc + xoxd into /plugin settings for the Slack MCP.
   ```

   (The reason we don't auto-write: per user-level feedback, ~/.claude.json is a Claude Code internal file and the plugin must not touch it. MCP registration is Claude Code's responsibility.)

8. **Smoke test**: call `https://slack.com/api/conversations.list?limit=1` with the tokens. Expect `ok:true` with at least one channel in the response.

**Privacy notes**:

- Tokens work as long as your browser session stays active — typically weeks to months with regular Slack usage. If the MCP starts returning 401s, re-run `/ops:setup slack`.
- Logging out of Slack invalidates the `d` cookie and breaks the MCP. Use `/ops:setup slack` to re-extract.
- Slack's Terms of Service allow personal-session-token use for your own account. Do not use this flow to access accounts you don't own.

### 3e — Calendar

Calendar isn't a messaging channel, but every other ops skill (briefings, `/ops-next`, `/ops-go`) benefits massively from knowing the user's schedule — meetings blocking deep work, deploy windows, travel days. The wizard wires it up the same way as email: `gog calendar` primary, Google Calendar MCP connector fallback.

#### Preferred: `gog calendar`

`gog` already handles email; the same binary exposes `gog calendar` / `gog cal` with the same OAuth token. No additional auth needed if Step 3c went green.

1. Check `gog` on PATH with `command -v gog`.
2. **If installed and already authed from Step 3c**, probe:
   ```bash
   gog cal list --json --max 3 2>&1 | head -20
   ```
   If this returns JSON with calendar data, record `channels.calendar = "gog"` in `$PREFS_PATH` and print `✓ Calendar — gog cal`. Stop here.
3. **If gog is installed but calendar scope is missing** (typical error: `insufficient scope` or `403 insufficient_permissions`), print:
   ```
   Your gog OAuth token doesn't include the calendar scope.
   Run `gog auth login --scopes=gmail,calendar` in a separate terminal
   to re-authorize with calendar read access, then re-run /ops:setup calendar.
   ```
   Do not attempt to re-auth from the skill — it's a browser flow.

#### Fallback: Claude Google Calendar MCP connector

4. **If gog is not on PATH**, scan the detector's `mcp_configured` array for any entry matching (case-insensitive) `calendar`, `google-calendar`, or `claude_ai_Calendar`.
5. If found, ask `AskUserQuestion`:
   - `[Use Google Calendar MCP (read-only fallback)]`
   - `[Install gog instead — show docs]`
   - `[Skip calendar]`
6. On "Use Google Calendar MCP", record `channels.calendar = "mcp:<name>"` in `$PREFS_PATH` and **print this warning verbatim**:
   ```
   ⚠  Using the Google Calendar MCP connector as a fallback.
      Read operations (list calendars, fetch events, check free/busy) will work.
      WRITE operations (create events, decline meetings, reschedule) will fail
      until you explicitly grant write permissions in
      Claude Desktop → Settings → Connectors → Google Calendar → Permissions.
      The ops plugin cannot grant those permissions for you.
      If you want ops-next to auto-block focus time or ops-comms to confirm
      meetings, install `gog` instead.
   ```
7. On "Install gog instead", print the same gog install snippet as Step 3c.

#### Neither available

8. **If `gog` is missing AND no Calendar MCP is configured**, ask:
   - `[Install gog — show docs]`
   - `[Add the Google Calendar MCP — show docs]` → print `claude mcp add google-calendar` and tell the user to re-run `/ops:setup calendar` after
   - `[Skip calendar]`

#### Why this matters (for context in the skill)

Downstream skills (`/ops-go`, `/ops-next`, `/ops-fires`) read `channels.calendar` from `$PREFS_PATH` to decide whether to cross-correlate today's schedule with their output:

- Briefings note "you have a 2pm standup, so don't start that refactor now"
- `/ops-next` deprioritizes deep work when a meeting is <30min away
- `/ops-fires` warns if a production incident falls during a scheduled call
  So this section is not optional for users who want context-aware briefings.

---

## Step 4 — Configure MCPs (if selected)

For each MCP that isn't in `mcp_configured`, print the one-line command the user should run:

```
Linear:  claude mcp add linear
Sentry:  claude mcp add sentry
Vercel:  claude mcp add vercel
Slack:   claude mcp add slack
Gmail:   claude mcp add gmail   (fallback only — prefer `gog` CLI, see Step 3c)
```

Offer `[Open Claude Code docs]`, `[Skip]`. Do **not** try to register MCPs from the skill — the plugin can't do that safely.

**Email note:** the ops plugin's primary email path is the `gog` CLI (full read + send, own OAuth). The Gmail MCP connector works as a fallback but **cannot send** without extra permission config in Claude Desktop → Settings → Connectors. The wizard handles that detection in Step 3c; this step only lists it so users who deliberately prefer MCP can install it here.

---

## Step 5 — Build the project registry (if selected)

### Auto-discover from filesystem

Before asking the user to manually enter projects, scan for existing git repositories:

```bash
find ~ ~/Projects -maxdepth 2 -name ".git" -type d 2>/dev/null | sed 's|/.git||' | sort
```

Present the discovered paths to the user via `AskUserQuestion` with `multiSelect: true`:

```
Found these git repositories on your filesystem. Select the ones to add to your registry:
  [ ] ~/Projects/healify
  [ ] ~/Projects/healify-api
  [ ] ~/Projects/healify-langgraphs
  [ ] ~/src/sam-manager
  ...
  [ ] None — I'll enter projects manually
```

For each selected project, collect these fields one `AskUserQuestion` at a time:

- `alias` (short name, required — suggest the directory name as default)
- `org` (GitHub org or owner, e.g. `auroracapital` or `Lifecycle-Innovations-Limited`)
- `infra.platform` → select `[aws]`, `[vercel]`, `[cloudflare]`, `[other]`
- `revenue.model` → select `[saas]`, `[subscription]`, `[marketplace]`, `[internal]`, `[portfolio]`, `[other]`

### Existing registry

If `registry.json` already has projects, ask first: `[Keep existing N projects]`, `[Add more projects]`, `[Auto-detect from existing registry]`, `[Start from scratch]`.

- "Keep existing" → skip this step.
- "Auto-detect from existing registry" → re-read the registry, show a summary of what's already there, and offer to add missing fields or newly-discovered repos.
- "Start from scratch" → write an empty skeleton first (`{"version":"1.0","owner":"","projects":[]}`) — **prompt to confirm before overwriting**.
- "Add more" → run the auto-discover scan above, then offer manual entry as a fallback.

### Manual add loop

After auto-discovery (or if the user selects "I'll enter projects manually"):

- Ask `AskUserQuestion`: "Add another project?" → `[Yes]`, `[Done]`.
- If Yes, collect these fields **one `AskUserQuestion` at a time**:
  - `alias` (short name, required)
  - `paths` (comma-separated absolute paths, required)
  - `repos` (comma-separated `org/repo`, required)
  - `type` → select `[monorepo]`, `[multi-repo]`
  - `infra.platform` → select `[aws]`, `[vercel]`, `[cloudflare]`, `[other]`
  - `revenue.model` → select `[saas]`, `[subscription]`, `[marketplace]`, `[internal]`, `[portfolio]`, `[other]`
  - `revenue.stage` → select `[pre-launch]`, `[development]`, `[growth]`, `[active]`
  - `gsd` → select `[Yes]`, `[No]`
  - `priority` (1-99, defaults to max+1)
- Read the current registry with `jq`, append the new project, write back atomically (`jq ... > tmp && mv tmp registry.json`).
- After each addition, print the running count and offer `[Add another]` / `[Done]`.

---

## Step 6 — Save preferences (if selected)

Collect these via `AskUserQuestion` — one question each. **Never auto-fill from memory, existing configs, or previous sessions. Always ask explicitly.**

1. **Owner name** (free text): "What should Claude call you in briefings?" — no default, no suggestions from memory.

2. **Timezone** (single select with common options):
   ```
   Select your timezone:
     [UTC]
     [America/New_York]
     [America/Los_Angeles]
     [Europe/London]
     [Europe/Amsterdam]
     [Asia/Bangkok]
     [Asia/Tokyo]
     [Australia/Sydney]
     [Other — type it]
   ```

3. **Briefing verbosity** (single select):
   ```
   How much detail do you want in briefings?
     [full]     — complete rundown of all channels, projects, and incidents
     [compact]  — key signals only, one line per item
     [minimal]  — just the fires and urgent items
   ```

4. **Primary project** → select from registry aliases (skip if registry is empty).

5. **YOLO mode** → select `[Yes — auto-approve low-risk actions]`, `[No — always confirm]`.

6. **Default channels** (multiSelect over configured channels only — never show channels that weren't configured in Step 3):
   ```
   Which channels should ops skills use by default?
     [ ] whatsapp
     [ ] email
     [ ] telegram
     [ ] slack
   ```

Write to `$PREFS_PATH`:

```json
{
  "version": "1.0",
  "owner": "...",
  "primary_project": "...",
  "timezone": "...",
  "briefing_verbosity": "...",
  "yolo_enabled": false,
  "default_channels": ["whatsapp", "email"],
  "channels": {
    "telegram": { "bot_token": "...", "owner_id": "..." }
  }
}
```

If the file already exists, **merge** — don't overwrite. Read with `jq`, apply updates with `jq '. + { ... }'`, write back.

---

## Step 7 — Shell env (if selected)

1. Check whether `CLAUDE_PLUGIN_ROOT` is already exported in the profile file (grep for `CLAUDE_PLUGIN_ROOT`).
2. If missing, ask: "Append `export CLAUDE_PLUGIN_ROOT=...` to `~/.zshrc`?" → `[Yes]`, `[Skip — I'll do it manually]`.
3. If Yes, append (don't overwrite). Use `>>`, not `>`.
4. Tell the user to run `source ~/.zshrc` or open a new terminal for it to take effect.

---

## Step 8 — Final summary + validation

Re-run the detector and present a final status dashboard:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► SETUP COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ✓ Core CLIs:  jq, git, gh, aws, node
 ✓ Channels:   telegram, whatsapp, email
 ✓ MCPs:       linear, sentry, vercel
 ✓ Registry:   20 projects
 ✓ Prefs:      saved to ~/.claude/plugins/data/ops-ops-marketplace/preferences.json

 Next: /ops-go for your first briefing
──────────────────────────────────────────────────────
```

If any required tool is still missing, list it with the exact command to install it and stop short of claiming success.

After displaying the summary, run the completion banner to celebrate the successful setup. Pass the actual counts from the setup session:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/bin/ops-setup-complete --channels <N> --projects <N> --agents 9 --skills 15
```

Where `<N>` is replaced with the actual number of channels configured and projects registered during this session.

---

## Invocation shortcuts

If `$ARGUMENTS` contains a specific section name, jump straight to that section:

| Argument                               | Go to   |
| -------------------------------------- | ------- |
| `cli`, `install`                       | Step 2  |
| `channels`                             | Step 3  |
| `telegram`                             | Step 3a |
| `whatsapp`, `wacli`, `whatsapp-doctor` | Step 3b |
| `email`                                | Step 3c |
| `slack`                                | Step 3d |
| `calendar`, `cal`                      | Step 3e |
| `mcp`                                  | Step 4  |
| `registry`, `projects`                 | Step 5  |
| `prefs`, `preferences`                 | Step 6  |
| `env`, `shell`                         | Step 7  |

Empty argument → full wizard from Step 0.

---

## Safety

- **Never** run `brew install` or write files without an explicit `AskUserQuestion` confirmation.
- **Never** overwrite an existing file without showing the diff and asking.
- **Never** put secrets in `registry.json` or commit them. Secrets only go in `$PREFS_PATH` (outside the plugin source tree entirely — Claude Code's per-plugin data dir) or the user's shell profile.
- **Never** touch `~/.claude.json` or `~/.claude/settings.json` — MCP registration is Claude Code's job, not yours.
- **Never** show the user's real name or email in output unless they explicitly provided it in the current session. Do not read from memory files, existing preferences, or environment variables to populate display names.

---

## Appendix: CLI Reference (EXACT SYNTAX — never guess)

### gog (v0.12.0+)

```bash
# Auth check
gog auth status

# Gmail — probe if API works
gog gmail labels list --json

# Gmail — search (query is positional, NOT --query flag)
gog gmail search "newer_than:1d" --max 5 --json --results-only

# Gmail — read thread
gog gmail read THREAD_ID --json

# Gmail — send
gog gmail send --to "user@example.com" --subject "test" --body "hello"

# Gmail — archive (remove INBOX label)
gog gmail labels modify MESSAGE_ID --remove INBOX

# Calendar — list today's events (NOT --time-min, use `gog cal list`)
gog cal list --json --max 10

# Calendar — auth with calendar scope
gog auth login --scopes=gmail,calendar
```

### wacli

```bash
# Health check
wacli doctor --json

# Auth status
wacli auth status --json

# List chats (MUST use subcommand `list`)
wacli chats list --json

# List messages (--after flag uses YYYY-MM-DD)
# macOS
wacli messages list --after="$(date -v-1d +%Y-%m-%d)" --limit=5 --json
# Linux
wacli messages list --after="$(date -d '1 day ago' +%Y-%m-%d)" --limit=5 --json

# Send message
wacli send --to "JID" --message "text"

# Sync (connect and pull)
wacli sync

# Backfill history
wacli history backfill --chat="JID" --count=50 --requests=2 --wait=30s --idle-exit=5s --json

# Contact lookup
wacli contacts --search "name" --json
```

### Slack token validation

```bash
curl -s -H "Authorization: Bearer XOXC_TOKEN" -b "d=XOXD_TOKEN" "https://slack.com/api/auth.test"
```

### macOS Keychain

```bash
security find-generic-password -s "KEY_NAME" -w 2>/dev/null
security add-generic-password -U -s "KEY_NAME" -a "$USER" -w "VALUE"
security delete-generic-password -s "KEY_NAME" 2>/dev/null
```
