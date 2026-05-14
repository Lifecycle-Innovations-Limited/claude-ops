### 3a — Telegram (user-auth via ops-telegram-autolink)

**Always ask before starting the Telegram flow** — even when the user selected "all channels". Use `AskUserQuestion`:

```
Set up Telegram personal account access?
  [Yes — enter my phone number and authenticate]
  [Skip Telegram]
```

If the user skips, record `channels.telegram = "skipped"` in `$PREFS_PATH` and move on. Do NOT silently mark Telegram as unconfigured — the explicit skip prevents the status header from showing `○ telegram (no token)` as an action item on subsequent runs.

**Rate-limit guard**: Before starting, check `$PREFS_PATH` for `channels.telegram` being an object with `.status == "rate_limited"` — use a type guard: `if (channels.telegram | type) == "object" and .channels.telegram.status == "rate_limited"` (jq: `if (.channels.telegram | type) == "object" then .channels.telegram.status else "skipped" end`). If `retry_after` is in the future, present the user with `AskUserQuestion`:
```
Telegram is rate-limited until [time]. What would you like to do?
  [Wait and retry after cooldown — re-run /ops:setup telegram after [time]]
  [Skip Telegram for now]
```
Do NOT attempt `send_password` during a rate-limit window — it will fail immediately and may extend the cooldown. If the user selects Skip, record the skip in `$PREFS_PATH` and move to the next channel.

**Bots cannot read user DMs**, so `/ops-inbox telegram` requires a personal-account MCP. The plugin ships `bin/ops-telegram-autolink.mjs` which:

1. Scans scout sources (keychain → ~/.claude.json → shell profiles → Doppler) for previously-extracted `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` / `TELEGRAM_SESSION`.
2. If none found, makes plain HTTP requests to `my.telegram.org` (no browser — `my.telegram.org` uses server-side HTML, no JS required), logs in with a phone code from the bridge file, creates an app if needed, and extracts api_id + api_hash.
3. Runs gram.js `client.start()` to generate a session string, bridging the second code via the same file.
4. Emits final JSON on stdout: `{api_id, api_hash, phone, session}`.

Sub-flow (only runs if user selected Yes above):

1. **Scout first.** Check all sources for previously-extracted Telegram credentials, in priority order:

   a. **SSE-router check** — if `~/.claude.json mcpServers.telegram.type == "sse"`, probe the URL. A 200 response means the router holds auth and Telegram is already configured — tell the user `"✓ Telegram already configured (source: sse_router)"` and skip to step 8.

   b. **user-config.json** — check `${CLAUDE_PLUGIN_DATA_DIR:-~/.claude/plugins/data/ops-ops-marketplace}/user-config.json` for `telegram_api_id`, `telegram_api_hash`, `telegram_phone`, `telegram_session`.
   ```bash
   USER_CONFIG="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/user-config.json"
   if [ -f "$USER_CONFIG" ]; then
     jq -r '{api_id: .telegram_api_id, api_hash: .telegram_api_hash, phone: .telegram_phone, session: .telegram_session}' "$USER_CONFIG" 2>/dev/null
   fi
   ```

   c. **macOS keychain**:
   ```bash
   for svc in telegram-api-id telegram-api-hash telegram-phone telegram-session; do
     security find-generic-password -s "$svc" -w 2>/dev/null && echo "FOUND: $svc"
   done
   ```

   d. **MCP config env** — check `~/.claude.json mcpServers.telegram.env.TELEGRAM_API_ID`.

   If all 4 credentials are found from any combination of the above sources, tell the user `"✓ Telegram already configured (api_id=XXXXXXX, phone=+XX..., source=<source>)"` and skip to step 8.

2. **Ask the user for their phone number** via `AskUserQuestion` with a single free-text option. Do NOT offer country-specific presets or example numbers — just one option that prompts for direct input:

   ```
   Enter your Telegram phone number (include country code, e.g. +31612345678):
     [Enter phone number — type your full number starting with +]
   ```

   The user will select this option and type their number in the "Other" free-text field. Validate it matches `^\+\d{7,15}$`. Explain that the phone is only used once during the first-run extraction and is stored locally only.

3. **Warn about 2 codes.** Inform the user via `AskUserQuestion`: `"Telegram will send TWO codes to your Telegram app — one for my.telegram.org web login, then a second one for gram.js auth. Have your Telegram app ready."` Options: `[I'm ready]`, `[Cancel]`.

4. **Spawn the autolink script in the background with restrictive file perms:**

   ```bash
   (umask 077 && node "${CLAUDE_PLUGIN_ROOT}/bin/ops-telegram-autolink.mjs" --phone "$PHONE" 2>/tmp/ops-telegram-autolink.log 1>/tmp/ops-telegram-autolink.out &)
   echo $! > /tmp/ops-telegram-autolink.pid
   ```

   Use the Bash tool's `run_in_background: true`. The `umask 077` creates all bridge files (log, out) with mode 0600. The .out file contains the full credential JSON including the gram.js session string — if it's world-readable, any local process can exfiltrate long-lived Telegram account access.

5. **Poll the stderr log for `need_code` events.** Every 3 seconds, read `/tmp/ops-telegram-autolink.log` and look for the most recent `{"type":"need_code", ...}` line that hasn't been answered yet. When you see one:
   - Determine which code: `channel: "web_login"` (first) or `channel: "gram_auth"` (second).
   - Use `AskUserQuestion` with a free-text input: `"Enter the code Telegram just sent to your Telegram app:"`. **Do NOT say "digits only"** — Telegram web login codes can contain letters, hyphens, and underscores (e.g. `Zv_-ef77YSU`). The autolink's bridge file accepts any 3-20 character alphanumeric+hyphen+underscore string.
   - Write the code to `/tmp/telegram-code.txt` with restrictive perms: `Bash: (umask 077 && printf '%s' "$CODE" > /tmp/telegram-code.txt)`. The `umask 077` is critical — without it the file is created world-readable on macOS (where `/tmp` is `drwxrwxrwt`) and any local process can race to read the code during the 2s poll window.
   - **Verify the code was consumed** within 10 seconds: `ls /tmp/telegram-code.txt 2>/dev/null`. If the file still exists after 10s, the script's validation regex rejected the code. Read the log for errors. Do NOT re-run the script or request a new code — that burns a login attempt.
   - Wait for the next event.
   - If you see `{"type":"need_password"}`, handle 2FA: ask the user via `AskUserQuestion` and write to `/tmp/telegram-password.txt` with `(umask 077 && printf '%s' "$PW" > /tmp/telegram-password.txt)`. Same perm hardening as the code file. The 2FA password is far more sensitive than a one-time code.

6. **Wait for the script to exit.** Poll until the process is no longer running (`ps -p "$(cat /tmp/ops-telegram-autolink.pid)"`). Read `/tmp/ops-telegram-autolink.out` — it should contain a single JSON line with `api_id`, `api_hash`, `phone`, and `session`. **Security note**: the setup skill should have dispatched the autolink with `(umask 077 && node "${CLAUDE_PLUGIN_ROOT}/bin/ops-telegram-autolink.mjs" --phone "$PHONE" 2>/tmp/ops-telegram-autolink.log 1>/tmp/ops-telegram-autolink.out &)` so the .log and .out files get 0600 mode. Verify with `stat -f '%Lp' /tmp/ops-telegram-autolink.out` → must print `600`. Immediately `shred -u` (Linux) or `rm -P` (macOS) the .out file after reading the credentials into memory.

   **Error recovery — CRITICAL: do NOT burn login attempts.** Each `send_password` call counts toward Telegram's rate limit (~3-5 per 8 hours). If the autolink fails:

   - **`"could not extract ... after 6 extraction strategies"` / extraction failure**: The HTML parsing failed but the login succeeded. Do NOT re-run the script. Instead, check if the error includes `html_snippet` — the snippet shows the stripped page text. If it contains a 5-12 digit number near "api_id" and a 32-char hex near "api_hash", extract them directly with grep/regex from the snippet. If the snippet shows a login page or redirect, the session expired during extraction.
   - **`rate-limited`**: Record `channels.telegram.status = "rate_limited"` and `channels.telegram.retry_after` (now + 8 hours) in `$PREFS_PATH`. Move on to the next channel. On subsequent `/ops:setup` runs, check `retry_after` and skip Telegram if the cooldown hasn't expired.
   - **Code file not consumed**: If `/tmp/telegram-code.txt` still exists 10+ seconds after writing, the validation regex rejected it. Read the file contents and the log. Do NOT ask the user for another code — the original code is still valid, you just need to fix the bridge.
   - **General rule**: You get at most 2 `send_password` attempts per setup session. If the first attempt fails for a non-rate-limit reason, diagnose the root cause before trying again. If the second attempt fails, save state and move on.

7. **Persist to keychain + preferences.** macOS only:

   ```bash
   security add-generic-password -U -s telegram-api-id -a "$USER" -w "$API_ID"
   security add-generic-password -U -s telegram-api-hash -a "$USER" -w "$API_HASH"
   security add-generic-password -U -s telegram-phone -a "$USER" -w "$PHONE"
   security add-generic-password -U -s telegram-session -a "$USER" -w "$SESSION"
   ```

   Then update `$PREFS_PATH` with `channels.telegram = {backend: "gram.js", api_id: "...", phone: "...", status: "configured"}`. **Never write the api_hash or session to preferences.json** — those stay in keychain only. preferences.json gets only the non-sensitive metadata.

8. **Auto-configure the MCP server.** Write the credentials directly into the plugin's user config so the user doesn't have to manually paste anything:

   ```bash
   # Read existing user config or create empty
   USER_CONFIG="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/user-config.json"
   mkdir -p "$(dirname "$USER_CONFIG")"

   # Write Telegram credentials to user config
   jq -n \
     --arg api_id "$API_ID" \
     --arg api_hash "$API_HASH" \
     --arg phone "$PHONE" \
     --arg session "$SESSION" \
     '{telegram_api_id: $api_id, telegram_api_hash: $api_hash, telegram_phone: $phone, telegram_session: $session}' \
     > "${USER_CONFIG}.tmp"

   # Merge with existing config if present
   if [ -f "$USER_CONFIG" ]; then
     jq -s '.[0] * .[1]' "$USER_CONFIG" "${USER_CONFIG}.tmp" > "${USER_CONFIG}.new" && mv "${USER_CONFIG}.new" "$USER_CONFIG"
     rm -f "${USER_CONFIG}.tmp"
   else
     mv "${USER_CONFIG}.tmp" "$USER_CONFIG"
   fi
   chmod 600 "$USER_CONFIG"
   ```

   Also update `~/.claude.json` MCP server config if the telegram server entry exists — inject the credentials as env vars:

   ```bash
   # Update .claude.json mcpServers.telegram.env with actual values
   CLAUDE_JSON="$HOME/.claude.json"
   if [ -f "$CLAUDE_JSON" ] && jq -e '.mcpServers.telegram' "$CLAUDE_JSON" >/dev/null 2>&1; then
     jq --arg id "$API_ID" --arg hash "$API_HASH" --arg phone "$PHONE" --arg session "$SESSION" \
       '.mcpServers.telegram.env.TELEGRAM_API_ID = $id | .mcpServers.telegram.env.TELEGRAM_API_HASH = $hash | .mcpServers.telegram.env.TELEGRAM_PHONE = $phone | .mcpServers.telegram.env.TELEGRAM_SESSION = $session' \
       "$CLAUDE_JSON" > "${CLAUDE_JSON}.tmp" && mv "${CLAUDE_JSON}.tmp" "$CLAUDE_JSON"
   fi
   ```

   Print:
   ```
   ✓ Telegram configured automatically.
     API ID:  [api_id]
     Phone:   [phone]
     Session: stored in keychain + MCP config
     Restart Claude Code to activate the Telegram MCP server.
   ```

9. **Smoke test (optional).** Spawn `node ${CLAUDE_PLUGIN_ROOT}/telegram-server/index.js` with the env vars set inline for 3 seconds. If it doesn't print an auth error, the session works.

**Privacy notes for the user** (show once at start):

- The phone number and all credentials stay on your machine. The wizard never transmits them anywhere except to Telegram's own servers during the HTTP login flow.
- If you already have a gram.js / Telethon session for another project, you can skip this and paste those values manually into `/plugin settings`.
- If Telegram replies "Sorry, too many tries. Please try again later." your account is rate-limited for ~8 hours — the wizard cannot bypass this. Wait and retry.

> **Deep-dive:** see `${CLAUDE_PLUGIN_ROOT}/skills/ops-comms/SKILL.md` for full operational instructions, CLI reference, and troubleshooting for this integration. The setup agent can load that file directly when it needs more depth than this wizard provides.

