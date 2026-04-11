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
- This is a *conversation*, not a script dump. Use `AskUserQuestion` for every decision — never ask in prose when a structured selector will do.
- Never install anything or write any file without explicit user confirmation via `AskUserQuestion`.
- Skip sections the user declines. Don't nag.
- Show what's already configured first, so the user only fills gaps.
- All writes go to one of these paths — and nothing else:
  - **`$PREFS_PATH`** — per-user preferences + secrets. Resolves to `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json`. Lives in Claude Code's plugin data dir so it survives plugin reinstalls and version bumps. Never committed to git.
  - **`${CLAUDE_PLUGIN_ROOT}/scripts/registry.json`** — per-user project registry (gitignored in the source repo). `mkdir -p` its parent if missing.
  - **`${CLAUDE_PLUGIN_ROOT}/.mcp.json`** — only to add `${user_config.*}` placeholders, never hardcoded tokens.
  - The user's shell profile (`~/.zshrc` etc.) — append-only, never rewrite.
- At the top of every wizard step, make sure `$PREFS_PATH`'s parent directory exists: `mkdir -p "$(dirname "$PREFS_PATH")"`. Claude Code creates `~/.claude/plugins/data/ops-ops-marketplace/` on plugin install but don't assume.

---

## Step 0 — Detect current state

Run the detector and parse its JSON output:

```!
${CLAUDE_PLUGIN_ROOT:-/Users/samrenders/Projects/claude-ops}/bin/ops-setup-detect 2>/dev/null
```

If `CLAUDE_PLUGIN_ROOT` is unset, fall back to `~/.claude/plugins/cache/ops-marketplace/ops/<latest-version>/` or the marketplace source at `~/Projects/claude-ops` — whichever exists. Store the resolved path as `PLUGIN_ROOT` for the rest of the session.

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

| Option | Header | Description |
|---|---|---|
| Install CLIs | cli | Install missing command-line tools via Homebrew |
| Configure channels | channels | Set tokens for Telegram, WhatsApp, Email, Slack |
| Configure MCPs | mcp | Enable Linear, Sentry, Vercel, Gmail MCP servers |
| Build registry | registry | Register projects Claude should manage |
| Save preferences | prefs | Owner name, timezone, default priorities |
| Shell env | env | Export `CLAUDE_PLUGIN_ROOT` in shell profile |

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

## Step 3 — Configure channels (if selected)

Ask which channels the user wants to configure using `AskUserQuestion` with `multiSelect: true`:

| Option | Header | Description |
|---|---|---|
| Telegram | telegram | Bot token + owner ID for `/ops-comms telegram` |
| WhatsApp | whatsapp | wacli doctor + auto-heal + backfill |
| Email | email | gog CLI → Gmail MCP fallback for `/ops-inbox email` |
| Slack | slack | Slack MCP server (managed by Claude Code) |
| Calendar | calendar | gog cal → Google Calendar MCP fallback — schedule context for briefings |

For each selected channel, run the matching sub-flow below.

---

#### Shared: prefer OAuth over manual tokens

Whenever a channel has a **browser-based OAuth flow** available, offer that first and put manual-token entry behind it as a fallback. OAuth is safer (scoped, revocable, no secrets in dotfiles), and usually faster for the user.

| Channel | OAuth path | Manual fallback |
|---|---|---|
| Email (gog) | `gog auth login` (browser) | n/a — gog is OAuth-only |
| Calendar (gog) | same `gog auth login` with `--scopes=calendar` | n/a |
| Slack | `claude mcp add slack` (handles OAuth through Claude Code) | bot token via auto-scan + manual paste |
| Linear | `claude mcp add linear` | API key |
| Sentry | `claude mcp add sentry` | DSN / auth token |
| Vercel | `claude mcp add vercel` | personal access token |
| Telegram | ❌ no OAuth (Bot API is token-only by design) | auto-scan + manual paste (only option) |
| WhatsApp | QR pairing via `wacli auth` (similar UX to OAuth) | n/a — paired sessions only |

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

### 3a — Telegram

Telegram's Bot API is token-only — **no OAuth path exists**. Auto-scan first, then fall back to manual entry.

1. **Auto-scan** for `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID` using the shared credential scan flow above. Valid Telegram bot tokens match the regex `^[0-9]{6,12}:[A-Za-z0-9_-]{30,}$` — use this to filter out placeholder values during the scan.
2. **Present findings** via `AskUserQuestion`:
   - If found: list sources (shell env, `~/.zshrc`, Doppler, existing `.mcp.json`) with last-4 preview and an `[Enter manually]` option.
   - If not found: ask `[I have a bot token — enter it now]`, `[Walk me through creating a bot]`, `[Skip Telegram]`.
3. **On "Walk me through"** print:
   ```
   1. Open https://t.me/BotFather in Telegram
   2. Send /newbot and follow the prompts
   3. Copy the HTTP API token it gives you
   4. Open https://t.me/userinfobot and send /start to get your numeric user ID
   ```
   Then loop back to step 2.
4. **Validate** the token before saving — hit `https://api.telegram.org/bot<TOKEN>/getMe` with a 5s timeout. If it returns `{"ok":true,...}`, continue. If not, show the error and re-ask.
5. **Persist**:
   - Write to `${PLUGIN_ROOT}/.mcp.json` — **preserve existing keys**. Read with `jq`, add/update the `telegram` entry with env vars wired to `${user_config.telegram_bot_token}` and `${user_config.telegram_owner_id}`, write back atomically (`jq ... > tmp && mv tmp .mcp.json`).
   - Store the raw values in `$PREFS_PATH` under `channels.telegram`.
6. **Offer to propagate** (default `[No]`): `"Also export TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID in ~/.zshrc so other tools see them?"` — only on explicit yes, append to the profile file.
7. **Smoke test**: run `node ${PLUGIN_ROOT}/telegram-server/index.js` with the env vars set, capture 3 seconds of output, verify it doesn't exit with ERROR. Report ✓/✗.

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
wacli messages list --after="$(date -v-1d +%Y-%m-%d)" --limit=5 --json 2>&1
wacli chats --json 2>&1 | head -c 4000
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

#### Step 3b.4 — Historical backfill (automatic)

Always run this after a fresh re-pair, AND run it when rule D matches. Never skip unless the user explicitly declines.

1. Load the top 10 chats by recency:
   ```bash
   wacli chats --json 2>&1 | jq -r '[.data[] | select(.jid) | {jid, name, last_msg: .last_message_ts}] | sort_by(.last_msg) | reverse | .[0:10]'
   ```
2. Tell the user: `"Running historical backfill on your 10 most-recent chats (up to 50 messages each). This may take 1–2 minutes."`
3. For each chat JID, run **sequentially** (backfill shares the store lock, can't parallelize):
   ```bash
   wacli history backfill --chat="<jid>" --count=50 --requests=2 --wait=30s --idle-exit=5s --json 2>&1
   ```
4. After each, print a one-line progress: `✓ <name> — N messages backfilled` or `○ <name> — 0 (likely already synced)`.
5. Re-probe after the loop: `wacli messages list --after="$(date -v-1d +%Y-%m-%d)" --limit=5 --json`. If still empty, tell the user: "Backfill completed but no new messages appeared. This usually means your primary device is offline or the chats haven't had activity. Try again later or check your phone."

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
✓ WhatsApp — wacli authenticated, N chats, M recent messages
```

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
   - If auth is green, probe with `gog inbox list --limit 1 --json 2>&1 || true` to confirm the token actually works against Gmail. Report ✓/✗.
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

### 3d — Slack

Slack has a real OAuth flow via Claude Code's MCP installer. That's the recommended path. Manual bot tokens are supported as a fallback for users who already have an app registered.

1. **Check if a Slack MCP is already configured** — look in the detector's `mcp_configured` array for `slack` or `claude_ai_Slack`. If yes, probe it (best-effort): note "Slack MCP already installed, skipping." Record `channels.slack = "mcp:<name>"` and stop.
2. **Offer OAuth first** via `AskUserQuestion`:
   - `[Connect via Claude Code OAuth (recommended)]`
   - `[I already have a bot token — enter manually]`
   - `[Skip Slack]`
3. **On OAuth**: print:
   ```
   Run this in a separate terminal (it opens a browser OAuth window):
     claude mcp add slack
   When the MCP is registered, come back and type "done".
   ```
   Wait for the user via `AskUserQuestion`: `[Done]`, `[Cancel]`. On Done, re-run `ops-setup-detect` and verify `slack` appears in `mcp_configured`. Record `channels.slack = "mcp:slack"` on success.
4. **On manual token**: run the shared credential auto-scan for `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`. Slack bot tokens start with `xoxb-`, user tokens with `xoxp-`, app-level tokens with `xapp-` — use these prefixes to filter placeholder scans.
   - If found, present with last-4 preview and source list.
   - Validate by calling `https://slack.com/api/auth.test` with the token in the `Authorization: Bearer <token>` header. On `{"ok":true}`, record `channels.slack = "token"` and store in `$PREFS_PATH` under `channels.slack_config` (NOT in registry.json).
   - On failure, show the error from the Slack API and re-ask.
5. **Never touch `~/.claude.json` directly.** MCP registration is Claude Code's job — this skill only invokes `claude mcp add` through the user's terminal.

### 3e — Calendar

Calendar isn't a messaging channel, but every other ops skill (briefings, `/ops-next`, `/ops-go`) benefits massively from knowing the user's schedule — meetings blocking deep work, deploy windows, travel days. The wizard wires it up the same way as email: `gog calendar` primary, Google Calendar MCP connector fallback.

#### Preferred: `gog calendar`

`gog` already handles email; the same binary exposes `gog calendar` / `gog cal` with the same OAuth token. No additional auth needed if Step 3c went green.

1. Check `gog` on PATH with `command -v gog`.
2. **If installed and already authed from Step 3c**, probe:
   ```bash
   gog cal list --max 1 --json 2>&1 || true
   gog cal events --time-min="$(date -u +%Y-%m-%dT00:00:00Z)" --max 5 --json 2>&1 || true
   ```
   If either returns events, print `✓ Calendar — gog cal, N calendars, M upcoming events today` and record `channels.calendar = "gog"` in `$PREFS_PATH`. Stop here.
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

1. If `registry.json` already has projects, ask: `[Keep existing 19 projects]`, `[Add more projects]`, `[Start from scratch]`.
2. If "Start from scratch", write an empty skeleton first (`{"version":"1.0","owner":"","projects":[]}`) — **prompt to confirm before overwriting**.
3. For "Add more", loop:
   - Ask `AskUserQuestion`: "Add another project?" → `[Yes]`, `[Done]`.
   - If Yes, collect these fields **one `AskUserQuestion` at a time** (plain text inputs):
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
4. After each addition, print the running count and offer `[Add another]` / `[Done]`.

---

## Step 6 — Save preferences (if selected)

Collect (one `AskUserQuestion` each, skip any the user leaves blank):

- `owner` (display name for briefings)
- `primary_project` → select from registry aliases
- `timezone` → select `[Europe/Amsterdam]`, `[UTC]`, `[America/New_York]`, `[Other — type it]`
- `briefing_verbosity` → select `[compact]`, `[full]`
- `yolo_enabled` → select `[Yes]`, `[No]`
- `default_channels` → multiSelect over configured channels

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

---

## Invocation shortcuts

If `$ARGUMENTS` contains a specific section name, jump straight to that section:

| Argument | Go to |
|---|---|
| `cli`, `install` | Step 2 |
| `channels` | Step 3 |
| `telegram` | Step 3a |
| `whatsapp`, `wacli`, `whatsapp-doctor` | Step 3b |
| `email` | Step 3c |
| `slack` | Step 3d |
| `calendar`, `cal` | Step 3e |
| `mcp` | Step 4 |
| `registry`, `projects` | Step 5 |
| `prefs`, `preferences` | Step 6 |
| `env`, `shell` | Step 7 |

Empty argument → full wizard from Step 0.

---

## Safety

- **Never** run `brew install` or write files without an explicit `AskUserQuestion` confirmation.
- **Never** overwrite an existing file without showing the diff and asking.
- **Never** put secrets in `registry.json` or commit them. Secrets only go in `$PREFS_PATH` (outside the plugin source tree entirely — Claude Code's per-plugin data dir) or the user's shell profile.
- **Never** touch `~/.claude.json` or `~/.claude/settings.json` — MCP registration is Claude Code's job, not yours.
