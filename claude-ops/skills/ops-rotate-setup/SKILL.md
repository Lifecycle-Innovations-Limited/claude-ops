---
name: ops-rotate-setup
description: Interactive OAuth init wizard for the multi-account Claude rotator. Walks through every account in the rotation config, runs the Playwright magic-link flow for any account missing a keychain token, and writes verified tokens to `Claude-Rotation-<account_id>`. Re-runnable any time. Standalone alias of the same step inside `/ops:setup`.
argument-hint: "[--all|--account <email>|--add]"
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
have a keychain entry `Claude-Rotation-<account_id>`, run the Playwright magic-
link login flow against `claude.ai`, capture the session cookie, verify it,
and write it to the OS keychain via `lib/credential-store.sh`.

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
- **Rule 4**: Background by default. The Playwright OAuth flow is long-running;
  always launch it with `run_in_background: true` and tail the log.
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
- `[Use existing keychain]`: print "Looking for `Claude-Rotation-*` entries..." and run `bash $CRED_STORE backends 2>/dev/null && for id in $(jq -r '.accounts[].id' "$CFG" 2>/dev/null); do bash $CRED_STORE get "Claude-Rotation" "$id" >/dev/null 2>&1 && echo "✓ $id" || echo "✗ $id"; done || echo "(no backends available — re-run with [Add now])"`. Exit.
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

For each account in the merged config, check the keychain:

```bash
CRED="${CLAUDE_PLUGIN_ROOT}/lib/credential-store.sh"
for id in $(jq -r '.accounts[].id' "$USER_CFG"); do
  if bash "$CRED" get "Claude-Rotation" "$id" >/dev/null 2>&1; then
    echo "✓ $id"
  else
    echo "✗ $id (needs OAuth)"
  fi
done
```

If every account is `✓`, print a success line and jump to **Step 5 — Summary**.

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
- The script:
  1. Opens Playwright Chromium
  2. Navigates to `claude.ai/login`, fills email, submits magic-link
  3. Polls Gmail via `gog` (best-effort) OR waits up to 10 minutes for the user to click the link manually
  4. Captures `sessionKey` or `__Secure-next-auth.session-token` cookie
  5. Verifies via `GET claude.ai/api/organizations`
  6. Writes to keychain as `Claude-Rotation-<account_id>` via `credential-store.sh`
- **2FA / TOTP**: the script polls the page for two-factor prompts every 3 seconds.
  If it detects one it logs `2FA prompt detected` to stderr. When you see that
  line in the log, ask the user via `AskUserQuestion` to provide the TOTP code.
  In **headless** mode the code cannot be typed into the browser — re-run the
  account with `--no-headless` so the user can complete 2FA interactively.
  Do NOT attempt to auto-solve 2FA.

After each account completes (success or failure):

```
Result for <email>:
  [✓ Success — continue with next]      ← only if more remain
  [✗ Failed — view log and retry]
  [Stop here]
```

If success and no more accounts remain, jump to **Step 5**.

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
 Keychain: Claude-Rotation-<id>

 To enable automatic rotation, open /plugins → claude-ops → settings and
 toggle "Multi-account Claude rotator" (account_rotation_enabled).
──────────────────────────────────────────────────────
```

Exit. Do NOT auto-enable `account_rotation_enabled` — that decision belongs
to the user, made explicitly through the plugin settings UI.

## Argument handling

- `--all` (default): full wizard as described above.
- `--account <email>`: skip Step 2; only init the matching account.
- `--add`: skip token check; jump straight to Step 2 add loop, then init.

## Failure modes

| Symptom | Cause | Action |
|---|---|---|
| `playwright install failed` | npm offline / sandbox | Run `npx playwright install chromium` via Bash tool, then retry |
| `oauth_failed` | login form selector changed | Open log, surface the page URL at failure, suggest `--no-headless` retry |
| `verify_failed` | session cookie captured but rejected | Re-run; likely transient |
| `keychain_write_failed` | no backend available | Run `bash $CRED backends` and surface options |
| `no session cookie` | login flow blocked by 2FA | Re-run with `--no-headless` so user can complete in-browser |
| `2FA prompt detected` + timeout | 2FA required in headless mode | Re-run with `--no-headless`; prompt user for TOTP via `AskUserQuestion` |
