---
name: ops-rotate
description: Multi-account Claude Max rotator. Status, manual rotation, account list, add-account wizard, and CRS relay-pool auto-prioritization. Requires account_rotation_enabled=true in plugin settings.
argument-hint: '[status|rotate-now|list|add-account|crs|crs-tick]'
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
effort: low
maxTurns: 25
---

# OPS ► ROTATE

Manage the optional multi-account Claude Max rotator. Off by default — flip
`account_rotation_enabled` in plugin settings to use it.

## Subcommands

| `$ARGUMENTS`       | Action                                                                   |
| ------------------ | ------------------------------------------------------------------------ |
| (none) or `status` | Show current account, 5h%/7d%, total rotations, daemon health            |
| `rotate-now`       | Force rotation to the most-cooled candidate (or `--to <email>`)          |
| `list`             | List every configured account with token state + last util               |
| `add-account`      | Interactive wizard: collect email, OAuth into rotator vault              |
| `crs`              | Show the CRS relay-pool schedulable state + priority-daemon health       |
| `crs-tick`         | Run one CRS priority tick now (append `--dry-run` to preview, no writes) |

## Two rotation models, one refresh authority

This skill manages **two complementary** account-management systems:

- **Keychain rotator** (`status`/`rotate-now`/`list`/`add-account`) — for **direct-auth**
  sessions. One active claude.ai OAuth token in the keychain at a time; the daemon swaps
  to the coolest account when the active one heats up.
- **CRS priority daemon** (`crs`/`crs-tick`) — for a **claude-relay-service** pool, which
  load-balances across _many_ accounts simultaneously. Instead of swapping one token, it
  toggles each account's `schedulable` flag from live utilization so the relay avoids
  near-maxed accounts and re-enables them on recovery. Off by default; see
  **ops-rotate-setup** to configure + install.

CRS is a **dependency** of the rotator, not a peer: the keychain rotator (specifically
`refresh-tokens.mjs`) is the single source of truth for OAuth token refresh across both
models — both its own keychain single-active-slot pool and every account CRS uses. The
CRS priority daemon never refreshes a token; it only ever toggles `schedulable` from a
genuine 429 (utilization-based parking stays off by standing policy). See
`scripts/account-rotation/NOTES-rotation-consistency.md` for the retired refresh paths
and why splitting this into one authority matters (racing refreshes invalidate each
other's single-use refresh_token and produce CRS "Invalid API key" 401 storms).

## Pre-flight (every invocation)

1. Read `account_rotation_enabled` from plugin preferences. If false, tell the user how to enable and exit.
2. Resolve paths:
   - `ROT_DIR=${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops}/account-rotation`
   - `ROT_SRC=${CLAUDE_PLUGIN_ROOT}/scripts/account-rotation`
3. If `$ROT_DIR` doesn't exist yet, mirror the runtime layout:
   ```
   mkdir -p "$ROT_DIR"
   cp "$ROT_SRC/config.example.json" "$ROT_DIR/config.json"  # only if missing
   ```
4. Verify Node 20+: `node --version`. If missing, fail fast with install hint.

## status (default)

Run:

```
node "$ROT_SRC/rotate.mjs" --status
node "$ROT_SRC/rotate.mjs" --utilization 2>/dev/null | head -40
launchctl list 2>/dev/null | grep com.claude-ops.account-rotation || echo "daemon: not loaded"
```

Render a compact panel:

```
ROTATOR STATUS
  Active account : <email>
  5h utilization : 42% (resets in 1h 23m)
  7d utilization : 18%
  Total rotations: 14
  Daemon         : ✓ running (PID 12345)  |  ✗ not loaded
  Configured     : 4 accounts (3 with valid tokens, 1 expired)
```

## rotate-now

If user passed an explicit target email (`/ops:rotate rotate-now user@example.com`), pass `--to "<email>"`. Otherwise let `rotate.mjs` pick the most-cooled.

```
bash "$ROT_SRC/force-rotate.sh" "${TARGET_EMAIL:-}"
```

Show the trailing status output. Remind the user that running Claude Code sessions hold their own access token until next `/login` or until they exit and re-enter.

## list

```
node "$ROT_SRC/rotate.mjs" --status 2>/dev/null
```

Then for each account in `$ROT_DIR/config.json`, render one row:

```
  [✓] user@example.com           5h 12%   token valid 6.4h  (active)
  [✓] backup@example.com         5h 87%   token valid 3.1h
  [✗] expired@example.com        ── ──    token expired 2d ago
  [○] new@example.com            ── ──    no token captured
```

If any row is `[○]` or `[✗]`, suggest running `/ops:rotate add-account` for that email.

## add-account (interactive)

This is the only mutating subcommand. Walk the user through:

1. **Collect email.** `AskUserQuestion`: "Email of the Claude Max account to add?" (free text via `Edit` to config — the skill must NOT capture sensitive data through chat options; just ask for the email).
2. **Optional metadata.** Ask if it's a Workspace account (`AskUserQuestion`: `[Personal]`, `[Workspace]`, `[Skip]`). If Workspace, prompt for `orgName` (free text) — `orgUuid` is auto-discovered later.
3. **Append to config.** Read `$ROT_DIR/config.json`, append the new account entry to `accounts[]`, write back. Use the schema from `config.example.json._account_schema_example`.
4. **Capture token.** Two paths via `AskUserQuestion`:
   - `[Use current Claude Code login]` — runs `node "$ROT_SRC/rotate.mjs" --capture --to <email>` to copy the live `Claude Code-credentials` token into the rotator vault.
   - `[Run OAuth in browser now]` — runs `node "$ROT_SRC/rotate.mjs" --setup --only=<email>` (background-friendly; opens Chrome).
   - `[Skip — I'll capture later]`.
5. **Daemon install (one-time).** If launchd doesn't show `com.claude-ops.account-rotation`, ask `[Install + start daemon]` / `[Skip]`. On install:
   ```
   sed "s|\${HOME}|$HOME|g" "${CLAUDE_PLUGIN_ROOT}/templates/com.claude-ops.account-rotation.plist" > ~/Library/LaunchAgents/com.claude-ops.account-rotation.plist
   launchctl load ~/Library/LaunchAgents/com.claude-ops.account-rotation.plist
   ```
   Mirror `daemon.mjs` + friends to `$ROT_DIR` if not already symlinked:
   ```
   for f in rotate.mjs daemon.mjs ai-brain.mjs force-rotate.sh; do
     [ -e "$ROT_DIR/$f" ] || ln -s "$ROT_SRC/$f" "$ROT_DIR/$f"
   done
   ```
6. **Verify.** Run `status` subcommand inline.

## crs (relay-pool status)

Show the claude-relay-service pool's per-account schedulable state + the priority
daemon's health. Read-only.

```
WRAP="$ROT_SRC/crs-priority-daemon.sh"
bash "$WRAP" --status 2>&1 | head -40   # prints "● name sched=true 5h=NN%  <status>"
launchctl list 2>/dev/null | grep com.claude-ops.crs-priority || echo "crs-priority daemon: not loaded"
tail -n 5 "${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/logs/crs-priority.log" 2>/dev/null
```

Render a compact panel:

```
CRS POOL  (http://127.0.0.1:3000)
  schedulable : 7 / 10
  off         : canary-sponsors (rate-limited), pool-chairman (warning), pool-foundation (warning)
  daemon      : ✓ running (every 120s)  |  ✗ not loaded — run /ops:rotate-setup
```

If CRS `/health` is unreachable, say so and point to ops-rotate-setup. If the daemon
isn't loaded but `crs.enabled` is true, suggest `/ops:rotate-setup`.

## crs-tick (run one tick now)

Apply (or, with `--dry-run`, preview) one prioritization pass immediately — useful
right after changing thresholds or to confirm the policy.

```
bash "$ROT_SRC/crs-priority-daemon.sh" ${ARGS:-}   # ARGS="--dry-run" to preview
```

This is the same code the launchd timer runs; the daemon only ever toggles
`schedulable` (fully reversible) and never deletes or mutates account credentials.

## Optional npm dep

`rotate.mjs` uses Playwright only for the browser fallback. It is declared as
an optional dep in the plugin's `package.json`. If a browser fallback is needed
and Playwright is missing, the skill should offer:

```
npm install --prefix "$CLAUDE_PLUGIN_ROOT" --no-save playwright
npx --prefix "$CLAUDE_PLUGIN_ROOT" playwright install chromium
```

## Hard rules

- This skill is **read-mostly**. Only `add-account` mutates `config.json`, and only after the user explicitly confirmed the email.
- Never echo refresh tokens or access tokens to chat output.
- Never auto-edit `config.json` outside `add-account` — token rotation is the daemon's job, not the skill's.
- If `account_rotation_enabled` is false, refuse to run subcommands and instead explain the toggle.
- If multiple OS users share the Mac, surface `CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT` as the override env var.
