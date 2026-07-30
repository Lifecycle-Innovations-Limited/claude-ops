---
name: ops-rotate-setup
description: Alias of /ops:accounts setup for Claude OAuth init wizard. Prefer /ops:accounts setup. CRS optional multi-account LB only.
argument-hint: '[--all|--account <email>|--add|--crs|--standalone]'
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
effort: medium
maxTurns: 25
---
> **Alias:** Prefer **`/ops:accounts setup`** (or `/ops:accounts setup claude`).  
> This file remains the detailed Claude OAuth wizard. Multi-provider entry is ops-accounts.



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
  - Gmail polling) is long-running; always launch it with
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

## Step 4.4 — CRS detection (optional enhancement — never required)

**CRS is not required for rotate-magic or the keychain rotator.**

- **Standalone rotate-magic** (recommended for single/few accounts): captures
  and refreshes one account at a time via `rotate.mjs` / `rotate-magic.mjs`
  (magic-link + captcha cascade). Enough when you are not spreading load across
  a large pool.
- **CRS** (claude-relay-service): multi-account **load balancing / rate-limit
  spreading** — one relay endpoint, many seats, `schedulable` flags. Useful
  mainly when you hit 429s with multi-account traffic.

### Detect CRS (env-templated; no host hardcodes)

Run detection before offering install. Any hit = "CRS likely present":

```bash
CRS_DETECTED=0
# binary on PATH
command -v crs >/dev/null 2>&1 && CRS_DETECTED=1
# common compose / service names (user-space; ignore if missing)
systemctl --user is-active crs-compose.service >/dev/null 2>&1 && CRS_DETECTED=1
# config already enabled
CFG="${USER_CFG:-$HOME/.claude/plugins/data/ops-ops-marketplace/account-rotation-config.json}"
[[ -f "$CFG" ]] && jq -e '.crs.enabled == true' "$CFG" >/dev/null 2>&1 && CRS_DETECTED=1
# optional env base URL responds
CRS_URL="${CRS_BASE_URL:-${CRS_URL:-http://127.0.0.1:3000}}"
curl -fsS --max-time 2 "$CRS_URL/health" >/dev/null 2>&1 && CRS_DETECTED=1
echo "CRS_DETECTED=$CRS_DETECTED"
```

### Branch

**If CRS detected (`CRS_DETECTED=1`)** — offer wire-in as optional enhancement:

```
CRS looks installed or already configured. Wire ops-rotate to it for multi-account
rate-limit load balancing? (Not required for standalone rotate-magic.)
  [Wire CRS]     — continue to Step 4.5 (priority daemon + reconcilers)
  [Standalone]   — keychain + rotate-magic only; leave CRS alone
  [Skip]         — neither; finish summary
  [What is CRS?] — short explainer, then re-ask
```

**If CRS not detected** — explain + choose path:

```
CRS (claude-relay-service) was not detected.

What it is: multi-account load balancing / rate-limit spreading across a relay
pool. Useful mainly when you hit rate limits with many accounts.

Standalone rotate-magic targets one account at a time and is enough for most
users (single seat or a few seats with the keychain rotator).

  [Use rotate-magic standalone (Recommended for single/few accounts)]
  [Install CRS]   — open CRS install docs / print next steps; do not block OAuth
  [Skip]          — finish without CRS
```

- **[Use rotate-magic standalone]**: print that OAuth tokens from Steps 3–4 are
  enough; captcha cascade is in `scripts/account-rotation/CAPTCHA-CASCADE.md`.
  Jump to **Step 5 — Summary** (CRS lines = not configured). Do **not** run
  Steps 4.5–4.7 unless the user later passes `--crs`.
- **[Install CRS]**: print a short pointer to upstream CRS install (docker
  compose / project README), note that after install they can re-run
  `/ops:rotate-setup --crs`. Do not hard-fail if they never install. Then offer
  to continue OAuth summary or exit.
- **[Skip]**: same as standalone for this wizard — jump to Step 5.
- **[Wire CRS]** / **[What is CRS?]**: continue into Step 4.5 as today.

`--standalone` argument: force the standalone branch (skip 4.5–4.7).
`--crs` argument: skip detection ask; jump to Step 4.5 (existing behavior).

## Step 4.5 — CRS relay-pool priority daemon (optional)

Only when the user chose **Wire CRS** / **Install CRS** completed / `--crs`, or
detection found CRS and they opted in. Install the **priority daemon** that
auto-deprioritizes near-maxed accounts and re-enables them on recovery. This is
independent of the keychain rotator — skip for keychain-only setups.

`AskUserQuestion` (if not already answered in 4.4):

```
Configure CRS pool auto-prioritization?
  [Yes — configure + install]   — set base URL + admin creds, install the 120s daemon
  [Not now]                     — skip (you can run /ops:rotate-setup --crs later)
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

Weekly-cap reconciliation (`crs.weeklyReconcile`, default on) is built into the
priority daemon itself — no separate install step. It clears a stale
`weeklyRateLimitEndAt` hold once live 7d utilization drops back under `on7d`,
and is a no-op on any deployment that never sets that field. Set
`crs.weeklyReconcile=false` (or `$CRS_WEEKLY_RECONCILE=0`) to disable it.

## Step 4.6 — CRS reconciler add-ons (optional)

Only offer this if Step 4.5 configured a CRS pool (`crs.enabled=true`) — these
reconcilers assume one exists. Two independent, opt-in daemons close gaps the
priority daemon (Step 4.5) doesn't cover:

- **429-cooldown**: holds an account out of rotation only on a real
  `rateLimitStatus.isRateLimited=true` from CRS (never a utilization
  heuristic). Fast cadence (60s) since it reacts to a live rate limit.
- **401-refresher**: proactively refreshes each account's CRS-pool OAuth
  token before it expires, so accounts don't silently start 401ing between
  priority-daemon ticks. Slower cadence (300s) — refreshes ahead of a 30min
  expiry window.

`AskUserQuestion`:

```
Enable the optional CRS reconcilers?
  [Both]              — 429-cooldown + 401-refresher (recommended if you run a busy pool)
  [429-cooldown only]  — fast rate-limit hold, skip proactive token refresh
  [401-refresher only] — proactive token refresh, skip rate-limit hold
  [Skip]               — neither (you can re-run /ops:rotate-setup --crs later)
```

On anything but `[Skip]`:

1. **Write the config flags.**
   ```bash
   CFG="$USER_CFG"
   jq --argjson cooldown "$COOLDOWN_ENABLED" --argjson tokenRefresh "$TOKEN_REFRESH_ENABLED" \
      '.crs = ((.crs // {}) + {cooldownEnabled:$cooldown, tokenRefreshEnabled:$tokenRefresh})' \
      "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"
   ```
   (`$COOLDOWN_ENABLED`/`$TOKEN_REFRESH_ENABLED` are `true`/`false` per the
   selection above.) Optional: also ask for `crs.stateDir`/`crs.logDir` if the
   user wants non-default paths — see `config.example.json` for the full
   annotated schema. Both reconcilers default to
   `<plugin-data-dir>/account-rotation` if left unset.

2. **Smoke-test before installing** (each enabled reconciler, no writes):
   ```bash
   [[ "$COOLDOWN_ENABLED" == "true" ]] && node "${CLAUDE_PLUGIN_ROOT}/scripts/account-rotation/crs-429-cooldown.mjs" --status
   [[ "$TOKEN_REFRESH_ENABLED" == "true" ]] && node "${CLAUDE_PLUGIN_ROOT}/scripts/account-rotation/crs-401-refresher.mjs" --status
   ```
   If either errors (login failed / unreachable), surface the message and let
   the user re-check Step 4.5's CRS creds — do NOT install a broken daemon.

3. **Install** (idempotent — installs whichever flags are true, uninstalls
   whichever were turned back off):
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-crs-reconcilers-agent.sh"
   ```
   macOS → launchd, 60s / 300s cadence (RunAtLoad fires the first tick).
   Linux → the installer prints the equivalent systemd-timer snippets.

## Step 4.7 — Magic-link autoloop (optional, unattended re-auth)

Only offer this if Step 4.6's 401-refresher was enabled — this reconciler
reads its needs-reauth flags. Unlike the other reconcilers, this one
dispatches a REAL browser-based re-auth attempt (via `rotate.mjs --setup`,
the same Gmail-via-`gog` flow this wizard itself uses in Step 4) — make sure
the user understands that before enabling it.

`AskUserQuestion`:

```
Enable unattended re-auth for accounts with a confirmed dead token?
  [Yes — enable]   — magic-link-autoloop dispatches rotate.mjs --setup automatically
  [Not now]        — a human handles re-auth manually when 401-refresher flags an account
  [What is this?]  — one-paragraph explainer, then re-ask
```

On **[Yes]**:

1. **Write the config flag.**
   ```bash
   CFG="$USER_CFG"
   jq '.crs = ((.crs // {}) + {enableMagicLinkRecovery:true})' \
      "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"
   ```
   Optional: ask for a non-default `crs.magicLinkRetryCooldownMs` (default 6h) —
   see `config.example.json`.

2. **Smoke-test** (no writes, no dispatch):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/account-rotation/magic-link-autoloop.mjs" --status
   ```

3. **Install** (folded into the same idempotent installer as Step 4.6):
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-crs-reconcilers-agent.sh"
   ```
   macOS → launchd, 600s cadence, `RunAtLoad=false` (does NOT fire immediately
   on install, unlike the other reconcilers — first tick waits for the normal
   schedule so a fresh install never triggers a surprise browser launch).
   Linux → the installer prints the equivalent systemd-timer snippet.

Note on provider scope: this reconciler's own logic (which account, when, how
often) has no email-provider dependency — it only decides what to retry and
delegates the actual OAuth+email-poll work to `rotate.mjs --setup`, which is
Gmail-via-`gog` today. A fully provider-agnostic email backend (e.g. IMAP)
would be a `rotate.mjs`-internals change, out of scope here.

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
 Mode: standalone rotate-magic | CRS pool wired
 CRS priority daemon: ✓ installed (every 120s) | ✗ not configured (optional)
 CRS 429-cooldown:    ✓ installed (every 60s)  | ✗ not enabled (optional)
 CRS 401-refresher:   ✓ installed (every 300s) | ✗ not enabled (optional)
 Magic-link autoloop: ✓ installed (every 600s) | ✗ not enabled (optional)

 Standalone reauth (no CRS): node $CLAUDE_PLUGIN_ROOT/scripts/account-rotation/rotate-magic.mjs --to <email>

 To enable automatic keychain rotation, open /plugins → claude-ops → settings and
 toggle "Multi-account Claude rotator" (account_rotation_enabled).
──────────────────────────────────────────────────────
```

(Show CRS daemon lines as `not configured (optional)` when Step 4.4 chose
standalone/skip. Show installed only if 4.5–4.7 ran. All four CRS daemons are
independent of `account_rotation_enabled` — each is gated by its own config flag
(`crs.enabled`, `crs.cooldownEnabled`, `crs.tokenRefreshEnabled`,
`crs.enableMagicLinkRecovery`) plus whether its launchd/systemd timer is
installed. **Never treat missing CRS as setup failure.**)

Exit. Do NOT auto-enable `account_rotation_enabled` — that decision belongs
to the user, made explicitly through the plugin settings UI.

## Argument handling

- `--all` (default): full wizard as described above (includes Step 4.4 CRS detection).
- `--account <email>`: skip Step 2; only init the matching account.
- `--add`: skip token check; jump straight to Step 2 add loop, then init.
- `--standalone`: after OAuth (or immediately if tokens already valid), force standalone rotate-magic path — skip Steps 4.5–4.7.
- `--crs`: jump straight to **Step 4.5** (configure + install the CRS priority daemon), then **Step 4.6** (offer the reconciler add-ons), skipping the keychain-account OAuth steps.
- `--reconcilers`: jump straight to **Step 4.6** (offer/reconfigure the 429-cooldown and 401-refresher reconcilers, then Step 4.7's magic-link autoloop offer) — requires Step 4.5 already configured (`crs.enabled=true`); if not, print the same message as `--crs` needing configuration first and exit.

## Failure modes

| Symptom                              | Cause                                                          | Action                                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `oauth_failed` (rotate.mjs exit ≠ 0) | login did not complete — Turnstile, Google SSO/2FA, or timeout | Open `$LOG` + `rotation.log`; if the cascade is waiting on a visible Chrome, let the user finish login there, then re-run |
| `playwright install failed`          | npm offline / sandbox                                          | Run `npx playwright install chromium` in `${CLAUDE_PLUGIN_ROOT}/scripts/account-rotation`, then retry                     |
| token still `✗` after success        | account `label`/`email` mismatch vs config                     | Confirm the config `key` (`label // email`) matches the `Claude-Rotation-<key>` service name                              |
| no CDP browser available             | no Chrome on `:9222` and none installed                        | rotate.mjs falls back to bundled Chromium, which Turnstile may block — install/launch Chrome so the cascade can attach    |
| Google SSO / 2FA prompt              | Workspace-domain account needs interactive Google login        | Let the user complete login in the cascade's visible Chrome; do NOT auto-solve 2FA                                        |
| CRS `--status` "login failed"        | wrong admin user/password or CRS not reachable                 | Re-enter creds (Step 4.5); admin creds are in the CRS container `data/init.json`; verify `curl $CRS_URL/health`           |
| CRS daemon installed but no effect   | `crs.enabled=false`, or all accounts already correctly flagged | Check `crs.enabled` in config; `tail logs/crs-priority.log`; a steady-state tick logs `0 change(s)`                       |
| CRS reconciler `--status` errors     | wrong admin creds or CRS unreachable (same creds as priority daemon) | Re-check Step 4.5's CRS creds; `curl $CRS_URL/health`                                                                     |
| CRS reconciler installed but no effect | `crs.cooldownEnabled`/`crs.tokenRefreshEnabled` false, or no account currently needs it | Check the relevant flag in config; `tail logs/crs-429-cooldown.log` or `crs-401-refresher.log` — both are safe no-ops when nothing needs action |
| magic-link-autoloop never dispatches  | `crs.enableMagicLinkRecovery` false, 401-refresher not enabled/hasn't flagged anyone, or account is on `magicLinkRetryCooldownMs` cooldown | `node magic-link-autoloop.mjs --status`; confirm 401-refresher is enabled and has a `needsReauth` entry |
| magic-link-autoloop dispatches too often | `magicLinkRetryCooldownMs` too low for a persistently-broken account | Raise the cooldown in config; each attempt is a real browser-automation run, not free |
