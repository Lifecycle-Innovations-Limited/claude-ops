---
name: ops-rotate-setup
description: Interactive OAuth init wizard for the multi-account Claude rotator. Walks through every account in the rotation config and, for any account missing a valid keychain token, delegates to the proven `rotate.mjs` magic-link flow (browser-driver cascade + Gmail polling), which writes the verified OAuth token to `Claude-Rotation-<key>` (key = account label or email, keychain account `$USER`). Re-runnable any time. Standalone alias of the same step inside `/ops:setup`.
argument-hint: "[--all|--account <email>|--add|--crs]"
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
effort: medium
maxTurns: 25
---

## Purpose

Initialize OAuth tokens for the multi-account Claude rotator system (the
`account-rotation` daemon). For each configured account that does not already
have a valid keychain token, delegate to `rotate.mjs --setup --only=<email>
--auto --skip-valid`, which drives the browser-driver cascade (CDP-attach to a
real Chrome → spawn Chrome with a real profile → bundled Chromium), polls Gmail
for the magic link via `gog`, verifies the token, and writes it to the OS
keychain under the schema the daemon/rotator consume: service
`Claude-Rotation-<key>` (key = account `label` or `email`), keychain account
`$USER` (override with `$CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT`), value
`{ "claudeAiOauth": { "accessToken": ... } }`.

> Why delegate: a freshly launched Playwright Chromium is blocked by
> claude.ai's Cloudflare Turnstile (the magic link is never sent), and a
> hand-rolled web-cookie capture writes a credential shape no consumer reads.
> `rotate.mjs` solves both correctly, so `setup-account.mjs` is a thin wrapper
> around it.

Use this skill when:
- You ran `/ops:setup` and skipped the account-rotation step
- You added a new Claude account and need to wire it in
- A keychain entry was rotated/expired and needs re-init
- You want to re-run only the OAuth portion without touching other ops config

## Rules (mandatory)

- **Rule 0**: Never write real emails to any committed file. Account email and
  display name come from runtime user input only.
- **Rule 1**: Max 4 options per `AskUserQuestion`. Paginate at 4 with
  `[More...]` bridges when listing accounts.
- **Rule 4**: Background by default. The OAuth flow (rotate.mjs browser cascade
  + Gmail polling) is long-running; always launch it with
  `run_in_background: true` and tail the log.
- Never auto-enable `account_rotation_enabled` after init. The user flips that
  switch from `/plugins` settings.

## Step 1 — Load config

```bash
USER_CFG="$HOME/.claude/plugins/data/ops-ops-marketplace/account-rotation-config.json"
REPO_CFG="${CLAUDE_PLUGIN_ROOT}/scripts/account-rotation/config.json"
CFG="$([[ -f "$USER_CFG" ]] && echo "$USER_CFG" || echo "$REPO_CFG")"
jq '.accounts // []' "$CFG"
```

If `accounts` is empty AND no `--add` argument was passed, jump to **Step 2 —
Bootstrap**. Otherwise jump to **Step 3 — Token check**.

## Step 2 — Bootstrap (no accounts configured)

`AskUserQuestion`:

```
No Claude accounts are configured for the rotator yet. Add some now?
  [Add now]               — collect email/display/plan, then run OAuth
  [Use existing keychain] — skip — assume keychain already has tokens
  [Skip]                  — exit, do nothing
  [Help]                  — explain how the rotator works and exit
```

- `[Help]`: print one-paragraph explainer (rotator purpose, where keychain entries live, how `/plugins` toggles `account_rotation_enabled`) and exit.
- `[Use existing keychain]`: print "Looking for `Claude-Rotation-*` entries..." and run `CRED="${CLAUDE_PLUGIN_ROOT}/lib/credential-store.sh"; ACCT="${CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT:-$USER}"; bash "$CRED" backends 2>/dev/null && jq -r '.accounts[] | (.label // .email)' "$CFG" 2>/dev/null | while read -r key; do bash "$CRED" get "Claude-Rotation-$key" "$ACCT" >/dev/null 2>&1 && echo "✓ $key" || echo "✗ $key"; done || echo "(no backends available — re-run with [Add now])"`. Exit.
- `[Skip]`: exit.
- `[Add now]`: enter the **add loop** below.

### Add loop

For each new account:

1. Prompt for **email** (free text). Validate `*@*.*` shape, reject empties.
2. Prompt for **display name** (free text, defaults to email local-part).
3. `AskUserQuestion` for **plan**:
   ```
   Plan tier for this account?
     [Max]   — Claude Max ($100/$200 tier)
     [Pro]   — Claude Pro
     [Team]  — Team plan seat
     [Other] — type a label
   ```
4. Append to in-memory accounts list. Then ask:
   ```
   Account added. Next?
     [Add another]
     [Done — start OAuth]
     [Cancel]
   ```

Once `[Done]`, write the new accounts into `$USER_CFG` (create dirs as needed):

```bash
mkdir -p "$(dirname "$USER_CFG")"
jq --argjson new "$NEW_ACCOUNTS_JSON" \
   '.accounts = ((.accounts // []) + $new)' \
   "$CFG" > "$USER_CFG.tmp" && mv "$USER_CFG.tmp" "$USER_CFG"
```

## Step 3 — Token check

For each account in the merged config, check the keychain under the consumed
schema (service `Claude-Rotation-<key>`, account `$USER`):

```bash
CRED="${CLAUDE_PLUGIN_ROOT}/lib/credential-store.sh"
ACCT="${CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT:-$USER}"
jq -r '.accounts[] | (.label // .email)' "$USER_CFG" | while read -r key; do
  if bash "$CRED" get "Claude-Rotation-$key" "$ACCT" >/dev/null 2>&1; then
    echo "✓ $key"
  else
    echo "✗ $key (needs OAuth)"
  fi
done
```

If every account is `✓`, print a success line and jump to **Step 5 — Summary**.
(`rotate.mjs --setup ... --skip-valid` also re-checks token validity itself, so
a stale-but-present entry is re-captured during Step 4.)

## Step 4 — OAuth init loop

For each `✗` account, run the setup script in the background and tail its log.

```bash
SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/account-rotation/setup-account.mjs"
LOG="$HOME/.claude/logs/account-rotation/setup-${ID}-$(date +%s).log"
mkdir -p "$(dirname "$LOG")"
node "$SCRIPT" \
  --email "$EMAIL" \
  --display "$ACCOUNT_DISPLAY" \
  --plan "$PLAN" \
  --account-id "$ID" \
  --gmail-poll \
  >"$LOG" 2>&1 &
echo "PID=$! LOG=$LOG"
```

- Launch with `run_in_background: true`.
- Use `Monitor` (or `Read` of the log file) to surface progress lines.
- `setup-account.mjs` upserts the account into `$USER_CFG`, then delegates to
  `rotate.mjs --setup --only=<email> --auto --skip-valid`, which:
  1. Skips immediately if a valid token already exists (`--skip-valid`).
  2. Runs the browser-driver cascade: attach to a real Chrome on CDP `:9222`
     (passes Cloudflare Turnstile) → else spawn Chrome with a real profile →
     else bundled Chromium.
  3. Submits the email and polls Gmail via `gog` for the magic link, then
     completes login (handling the org chooser).
  4. Verifies the token against `api.anthropic.com/api/oauth/usage`.
  5. Writes it to the keychain as `Claude-Rotation-<key>` (account `$USER`),
     value `{ "claudeAiOauth": { "accessToken": ... } }`.
- It emits a single-line JSON result: `{"ok":true,"accountId":...,"email":...}`
  on success, or `{"ok":false,...,"error":"oauth_failed"}` on failure.
- **2FA / Google SSO**: some accounts (Google Workspace domains) require an
  interactive Google verification that automation cannot complete unattended.
  If `rotate.mjs` logs a 2FA / verification prompt or times out, surface the log
  to the user and let them complete the login in the cascade's visible Chrome.
  Do NOT attempt to auto-solve 2FA.

After each account completes (success or failure):

```
Result for <email>:
  [✓ Success — continue with next]      ← only if more remain
  [✗ Failed — view log and retry]
  [Stop here]
```

If success and no more accounts remain, jump to **Step 5**.

## Step 4.5 — CRS relay-pool priority daemon (optional)

If the user runs a **claude-relay-service** (CRS) pool (load-balances Claude
requests across many accounts at once, exposing a per-account `schedulable`
flag), offer to install the **priority daemon** that auto-deprioritizes
near-maxed accounts and re-enables them on recovery. This is independent of the
keychain rotator above — skip it for keychain-only setups.

`AskUserQuestion`:

```
Do you run a claude-relay-service (CRS) pool you want auto-prioritized?
  [Yes — configure + install]   — set base URL + admin creds, install the 120s daemon
  [Not now]                     — skip (you can run /ops:rotate-setup again later)
  [What is this?]               — one-paragraph explainer, then re-ask
```

On **[Yes]**:

1. **Base URL + admin user.** Ask for the CRS base URL (default
   `http://127.0.0.1:3000`) and admin username (default `cradmin`). Write them
   into the rotator config's `crs` block (create from `config.example.json` if
   missing), and set `crs.enabled=true`:
   ```bash
   CFG="$USER_CFG"
   jq --arg url "$CRS_URL" --arg u "$CRS_USER" \
      '.crs = ((.crs // {}) + {enabled:true, baseUrl:$url, adminUser:$u})' \
      "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"
   ```
2. **Admin password → credential store** (never written to config). Ask the user
   to paste the CRS admin password, then:
   ```bash
   CRED="${CLAUDE_PLUGIN_ROOT}/lib/credential-store.sh"
   ACCT="${CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT:-$USER}"
   printf '%s' "$CRS_ADMIN_PW" | bash "$CRED" set-stdin "CRS-Admin-$CRS_USER" "$ACCT"
   ```
   (The CRS admin password is printed once in the container's
   `data/init.json` — `adminUsername`/`adminPassword` — on first boot.)
3. **Smoke-test before installing.** Confirm the creds + reachability with a
   dry-run tick (no writes):
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/account-rotation/crs-priority-daemon.sh" --status
   ```
   If it errors (login failed / unreachable), surface the message and let the
   user re-enter creds — do NOT install a broken daemon.
4. **Install the timer** (background-friendly):
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-crs-priority-agent.sh"
   ```
   macOS → launchd every 120s (RunAtLoad fires the first tick). Linux → the
   installer prints the equivalent systemd-timer snippet.

Tuning (optional, `crs` block): `off5h`/`off7d` (deprioritize thresholds),
`on5h`/`on7d` (re-enable thresholds, hysteresis), `floor` (min usable accounts),
`freshMinutes` (max age of utilization data trusted for proactive deprioritize).

## Step 5 — Summary

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► ROTATE-SETUP COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Accounts initialized:
   ✓ <id> (<plan>)
   ✓ <id> (<plan>)
   ✗ <id> (failed — re-run /ops:rotate-setup --account <email>)

 Config: ~/.claude/plugins/data/ops-ops-marketplace/account-rotation-config.json
 Keychain: Claude-Rotation-<key> (account: $USER)  ·  key = label or email
 CRS priority daemon: ✓ installed (every 120s) | ✗ not configured

 To enable automatic rotation, open /plugins → claude-ops → settings and
 toggle "Multi-account Claude rotator" (account_rotation_enabled).
──────────────────────────────────────────────────────
```

(Show the CRS line only if Step 4.5 ran. The CRS daemon is independent of the
`account_rotation_enabled` toggle — it is gated by `crs.enabled` in config +
whether its launchd/systemd timer is installed.)

Exit. Do NOT auto-enable `account_rotation_enabled` — that decision belongs
to the user, made explicitly through the plugin settings UI.

## Argument handling

- `--all` (default): full wizard as described above.
- `--account <email>`: skip Step 2; only init the matching account.
- `--add`: skip token check; jump straight to Step 2 add loop, then init.
- `--crs`: jump straight to **Step 4.5** (configure + install the CRS priority daemon), skipping the keychain-account OAuth steps.

## Failure modes

| Symptom | Cause | Action |
|---|---|---|
| `oauth_failed` (rotate.mjs exit ≠ 0) | login did not complete — Turnstile, Google SSO/2FA, or timeout | Open `$LOG` + `rotation.log`; if the cascade is waiting on a visible Chrome, let the user finish login there, then re-run |
| `playwright install failed` | npm offline / sandbox | Run `npx playwright install chromium` in `${CLAUDE_PLUGIN_ROOT}/scripts/account-rotation`, then retry |
| token still `✗` after success | account `label`/`email` mismatch vs config | Confirm the config `key` (`label // email`) matches the `Claude-Rotation-<key>` service name |
| no CDP browser available | no Chrome on `:9222` and none installed | rotate.mjs falls back to bundled Chromium, which Turnstile may block — install/launch Chrome so the cascade can attach |
| Google SSO / 2FA prompt | Workspace-domain account needs interactive Google login | Let the user complete login in the cascade's visible Chrome; do NOT auto-solve 2FA |
| CRS `--status` "login failed" | wrong admin user/password or CRS not reachable | Re-enter creds (Step 4.5); admin creds are in the CRS container `data/init.json`; verify `curl $CRS_URL/health` |
| CRS daemon installed but no effect | `crs.enabled=false`, or all accounts already correctly flagged | Check `crs.enabled` in config; `tail logs/crs-priority.log`; a steady-state tick logs `0 change(s)` |
