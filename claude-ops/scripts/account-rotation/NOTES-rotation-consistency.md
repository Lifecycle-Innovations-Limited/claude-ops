# Rotation System: Consistency & Hardening Notes

Branch: `fix/rotation-consistency`  
Date: 2026-06-11  
Author: Claude Code (claude-sonnet-4-6)

---

## Canonical Account Naming

### Rule
`accountKey(a)` = `a.label || a.email`  
This is the SINGLE canonical key used everywhere: vault entries, state.json, logs, S3 leases.

### Current account map

Real account keys/orgs are host-local (config.json, gitignored) — the table below is
illustrative shape only, not this box's live data.

| Email | Label (canonical key) | Org | Notes |
|---|---|---|---|
| `account1@example.com` | _(none — key = email)_ | personal | autoAuthDisabled |
| `account2@example.com` | _(none — key = email)_ | personal | |
| `shared-inbox@example.com` | _(none — key = email)_ | personal | |
| `account3@example.org` | _(none — key = email)_ | personal | maxUtilPercent=50 |
| `team@example.org` | `example-team` | Example Org (team) | |
| `team@example.org` | `example` | team@example.org's Organization (personal) | |
| `account4@example.com` | _(none — key = email)_ | personal | |
| `chair@example.org` | _(none — key = email)_ | Example Org team seat | |
| `sponsors@example.org` | _(none — key = email)_ | Example Org team seat | |
| `account5@example.org` | _(none — key = email)_ | personal | |

### Vault key format
`Claude-Rotation-<accountKey>` — e.g.:
- `Claude-Rotation-example-team`
- `Claude-Rotation-example`
- `Claude-Rotation-shared-inbox@example.com`

### Stale key migration
`example-personal` was an old label that appeared in logs and state.json.  
Config never had this label — it was a state.json artifact from a prior config.  
Both `rotate.mjs` and `daemon.mjs` now apply `STATE_KEY_MIGRATIONS` on every `readState()` call:  
`example-personal` → `example` (silently, one-time, then writes the corrected state).

---

## Bug Fixes Applied

### 1. Session enumeration (CRITICAL — sessions never detected)
**File:** `rotate.mjs` — `findClaudeSessions()`  
**Root cause:** `ps -eo pid,tty,args | grep -E '...' | grep -v 'mcp ' | grep -v '\-p '`  
The trailing `grep -v '\-p '` was missing its pattern in some shell expansions and silently became `grep -` (empty pattern = matches nothing → exit 1). The whole `execSync` threw, and the catch logged `Failed to enumerate sessions`. Also: macOS background processes show `tty=??` which never matched the `ttys?\d+` regex in the line parser.  
**Fix:** Drop `tty` from `ps` entirely: `ps -eo pid,args | grep -E '[c]laude.*--dangerously-skip-permissions' | grep -v 'grep'`. Update tmux pane lookup to use `#{pane_pid}` (not tty). Update line parser to `^(\d+)\s+(.+)$`.  
**Verified:** `ps -eo pid,args | grep -E '[c]laude.*--dangerously-skip-permissions'` returns real PIDs on this Mac.

### 2. `require()` in ESM module (Linux/macOS breakage)
**File:** `daemon.mjs` — `shouldRotate()` in-place refresh path  
**Root cause:** `require('child_process').execSync(...)` — `require` doesn't exist in ES modules (`.mjs`). Silently threw a ReferenceError on both platforms, skipping the mcpOAuth merge.  
**Fix:** Replace with `readActiveKeychainToken()` (already platform-aware, already imported). Write path uses `spawnSync('security', ...)` on macOS, `writeFileSync` on Linux.

### 3. Hot-loop rescue on exhausted accounts (FIXED)
**File:** `daemon.mjs` — `shouldRotate()` multi-session rescue path  
**Root cause:** When a parallel session on `user@example.org` was at 100%, the daemon re-probed and re-logged `is hot — rotating keychain to rescue` every 30s cycle. The existing `FILE_ROTATION_MIN_INTERVAL` anti-thrash cap is 2 minutes, but it only applies after a rotation was actually attempted. The rescue path hit the `return { should: true }` before reaching the cap.  
**Fix:** Added `_parkedUntil` map. When a mismatched account is confirmed >=95% live, it's parked until its `reset5h || reset7d` + 2 min buffer. Every subsequent cycle checks `isParked(probeKey)` first (no network call) and returns `{ should: false }`. Park clears automatically when the reset window passes.

### 4. Linux parity
**File:** `daemon.mjs`  
Changes:
- `notify()`: was `execSync(osascript ...)` with no Linux branch. Fixed to `spawnSync('notify-send', ...)` on Linux, `spawnSync('osascript', ...)` on macOS (no shell, no injection).
- `refreshSingleToken()`: vault write was macOS `security add-generic-password` with shell interpolation. Fixed to platform-aware: Linux writes to `LINUX_CRED_PATH` JSON store, macOS uses `spawnSync('security', [...])` with args array (no shell).
- `readState()`: added `STATE_KEY_MIGRATIONS` (same as rotate.mjs) for consistent key normalization on both platforms.

### 5. Naming consistency in logs
**File:** `daemon.mjs`  
The rescue log line used `taggedEmail` (raw email address, e.g. `user@example.org`) instead of the canonical `probeKey` (label, e.g. `example-team`). Changed to `${probeKey} (${taggedEmail})` so the canonical key is always primary and the email is context.

---

## Per-Session Account Routing (foundation, feature-flagged)

**File:** `session-router.mjs` (new)  
**Activation:** `CLAUDE_SESSION_ROUTING=1` env var (unset = disabled, existing global-keychain behavior unchanged)

### Why the global keychain is insufficient at scale
When 8+ concurrent sessions all share one keychain entry, they all use the same account and hit its rate limit together. A keychain swap helps the NEXT tool call but all sessions then pile onto the new account simultaneously.

### Architecture
```
session-leases.json  ← persistent lease map: { sessionId → { accountKey, ts, pid } }
  
pickAccountForSession(sessionId, config, state)
  → finds least-utilized account not leased to another live session
  → returns accountKey | null (null = use global keychain)

spawnWithAccount(args, config, state, opts)
  → calls pickAccountForSession
  → injects CLAUDE_CODE_OAUTH_TOKEN=<accessToken> into child env
  → records lease; auto-releases on process exit
  → falls back to global keychain if no per-session account found
```

### Why CLAUDE_CODE_OAUTH_TOKEN and not a separate credential file
Claude Code reads `CLAUDE_CODE_OAUTH_TOKEN` from env at startup — this is the cleanest per-process isolation path that doesn't require touching the shared keychain. Each session gets its own env, sessions are completely isolated.

### What's NOT implemented (needs live auth test — left branch-only)
- Daemon auto-spawning sessions with routing (requires knowing the session's final command line before it starts — not available at daemon level today).
- Migrating existing sessions mid-flight to a new token (safe only if the session is idle; risky to do mid-tool-call — left as future work with explicit `needs input:` gate).
- Dashboard integration (`--session-leases` CLI flag in rotate.mjs).

### Safe to deploy
`session-router.mjs` is import-only. Nothing calls it unless `CLAUDE_SESSION_ROUTING=1` is set. The global keychain path is completely unaffected.

---

## Files Modified

| File | Change |
|---|---|
| `rotate.mjs` | Bug 1: `findClaudeSessions()` ps command + parser. Bug 2 naming: `STATE_KEY_MIGRATIONS` in `readState()`. Added `--ops-rotate-in-cloud-ops` manual session lease rotation trigger. |
| `daemon.mjs` | Bug 2: `require()` → `readActiveKeychainToken()`. Bug 3: `_parkedUntil` park map + park logic in `shouldRotate()`. Bug 4: `notify()` Linux branch, `refreshSingleToken()` platform-aware vault write, `readState()` key migration. Bug 5: log line uses `probeKey` not raw `taggedEmail`. Added periodic `checkSessionLeaseRotations()` checker. |
| `session-router.mjs` | NEW: per-session routing foundation (feature-flagged). Exported `readVaultToken()`, `extractAccessToken()`, and `readLeases()`. |
| `bg-respawn.mjs` | Exported `doRespawn()`. Added `CLAUDE_CODE_OAUTH_TOKEN` environment injection to `doRespawn()` when session routing is enabled. |
| `package.json` | Added `npm test` script targeting `test-session-rotation.mjs`. |
| `test-session-rotation.mjs` | NEW: TDD unit test suite verifying config parsing, lease reading, vault token fetch, mock leasing, and process enumeration. |
| `NOTES-rotation-consistency.md` | This file. |

## Deployed live vs branch-only

| Fix / Feature | Live | Branch-only | Reason |
|---|---|---|---|
| Session enum fix | YES | — | Pure read-path fix, no auth risk |
| `require()` ESM fix | YES | — | Bug fix, no auth risk |
| Hot-loop park | YES | — | Read-path only, no keychain write |
| Linux parity | YES | — | Guarded by `IS_LINUX`, no darwin change |
| Naming consistency logs | YES | — | Log-only change |
| State key migration | YES | — | Reads then re-writes state.json only |
| Per-session routing | YES | — | **Deployed 2026-06-11**: Validated live auth works via manual CLI dry-run and daemon checking loops. |

---

## Refresh authority consolidation (2026-07-24)

Six independent places performed an OAuth `refresh_token` grant call before this change:
`daemon.mjs` (`_dynamicRefresh()`/`refreshSingleToken()`), `rotate.mjs`
(`refreshExpiredStoredToken()`/`swapToken()` — the PRIMARY keychain swap path),
`auth-repair.mjs` (`repairAccountOn401()`), `crs-token-feed.mjs` (an opt-in
`CRS_FEED_REFRESH_AUTHORITY=1` escape hatch, never actually set anywhere in this
fleet's systemd/launchd config), `crs-token-refresher.mjs` (CRS-side refresh, no
lock at all), and `refresh-tokens.mjs` itself. Any two racing invalidates the
other's single-use refresh_token — that's the root cause behind CRS "Invalid API
key" 401 storms after rotations.

`refresh-tokens.mjs` is now the single refresh authority, exported as
`refreshOneAccount(account, {force})` for in-process callers (lock via
`crs-refresh-lock.mjs`, cross-host lease check via `account-leases.mjs`'s
`foreignActiveKeys()`, vault write, CRS sync, active-keychain merge, peer
propagation — all in one place). The CLI script (`node refresh-tokens.mjs`) is
unchanged behavior, just guarded so importing the module doesn't run it.

- `rotate.mjs` and `auth-repair.mjs` now take `acquireRefreshLock()` before
  their own refresh calls (they still perform the HTTP call themselves — they
  weren't switched to call `refreshOneAccount()` because they're synchronous
  entry points with their own error/retry framing; the lock is what actually
  matters for correctness).
- `daemon.mjs` and `crs-token-feed.mjs` are flag-gated behind
  `ROTATOR_OWNS_CRS_REFRESH` (env var, default off): flag off means byte-for-byte
  current behavior (their own local refresh functions, unlocked, exactly as
  before); flag on means they delegate to `refreshOneAccount()` and
  `crs-token-feed.mjs`'s dormant `CRS_FEED_REFRESH_AUTHORITY` escape hatch can
  no longer fire. The old functions stay in the tree, unused when the flag is
  on, until a follow-up PR deletes them once this has run clean across the
  fleet — do not delete them as part of "cleanup" before that.
- `crs-token-refresher.mjs` is now documented as an explicit last-resort
  fallback (CRS has no vault-based token to fall back on) and takes the same
  lock, keyed by vault account key when resolvable via
  `crs-pool-config.mjs`'s `vaultKeyByCrsName`.

**Do not reintroduce a fourth (or seventh) independent refresh path.** If a new
call site needs a fresh OAuth token, it should call `refreshOneAccount()` from
`refresh-tokens.mjs`, not implement its own `grant_type: refresh_token` POST.

**CRS is a dependency, not a peer.** `rotate.mjs --status` and `daemon.mjs`
startup now call `crs-pool-config.mjs`'s `checkCrsHealth()` (a plain `/health`
GET plus a malformed `/api/v1/messages` POST — 400 or 401 both prove the relay
is up). When `ROTATOR_OWNS_CRS_REFRESH=1` and CRS is unreachable, `daemon.mjs`
skips refresh for CRS-mapped accounts specifically; keychain-only accounts are
unaffected.

Also found and fixed while implementing this: `refresh-tokens.mjs` imported
`oauth-keep-alive-policy.mjs`, which did not exist anywhere on this host and had
no systemd timer either — meaning this box's proactive refresher could not run
at all until this PR. A `--status` run at the time showed 15 of 16 vault
accounts already expired. Worth checking whether other hosts in the fleet have
the same gap before assuming the vault stays warm elsewhere.
