# Rotation System: Consistency & Hardening Notes

Branch: `fix/rotation-consistency`  
Date: 2026-06-11

---

## Canonical Account Naming

### Rule

`accountKey(a)` = `a.label || a.email`  
This is the SINGLE canonical key used everywhere: vault entries, state.json, logs, S3 leases.

### Account schema

Each entry in `config.json` has:

- `email` — the Anthropic account email (stored in gitignored config, not committed)
- `label` (optional) — short slug used as the canonical key when the same email has
  multiple org entries (e.g. `team-label` vs `personal-label` for the same address)
- `orgName` (optional) — the org name shown in the claude.ai org-chooser; used to
  disambiguate multi-org accounts during OAuth
- `orgUuid` (optional) — the org UUID for post-rotation verification

When `label` is absent the canonical key is the email itself. When `label` is present
it takes precedence — this is how two config entries that share the same email address
(e.g. a personal-org slot and a team-org slot) can each have a unique vault entry:
`Claude-Rotation-<label>` vs `Claude-Rotation-<email>`.

### Vault key format

`Claude-Rotation-<accountKey>` — examples (using generic placeholders):

- `Claude-Rotation-team-label` (when label is set)
- `Claude-Rotation-user@example.com` (when no label)

Real account emails live only in gitignored `config.json` / plugin data dir, never
committed to the repo.

### Stale key migration

An old label (`account-personal`) appeared in logs and state.json as a state.json
artifact from a prior config. Config never had that label.  
Both `rotate.mjs` and `daemon.mjs` now apply `STATE_KEY_MIGRATIONS` on every
`readState()` call, renaming the stale key to the current canonical key (silently,
one-time, then writes the corrected state).

---

## Bug Fixes Applied

### 1. Session enumeration (CRITICAL — sessions never detected)

**File:** `rotate.mjs` — `findClaudeSessions()`  
**Root cause:** `ps -eo pid,tty,args | grep -E '...' | grep -v 'mcp ' | grep -v '\-p '`  
The trailing `grep -v '\-p '` was missing its pattern in some shell expansions and
silently became `grep -` (empty pattern = matches nothing → exit 1). The whole
`execSync` threw, and the catch logged `Failed to enumerate sessions`. Also: macOS
background processes show `tty=??` which never matched the `ttys?\d+` regex in the
line parser.  
**Fix:** Drop `tty` from `ps` entirely:
`ps -eo pid,args | grep -E '[c]laude.*--dangerously-skip-permissions' | grep -v 'grep'`.
Update tmux pane lookup to use `#{pane_pid}` (not tty). Update line parser to
`^(\d+)\s+(.+)$`.  
**Verified:** fixed command returns real PIDs for running sessions on macOS.

### 2. `require()` in ESM module (Linux/macOS breakage)

**File:** `daemon.mjs` — `shouldRotate()` in-place refresh path  
**Root cause:** `require('child_process').execSync(...)` — `require` doesn't exist in
ES modules (`.mjs`). Silently threw a ReferenceError on both platforms, skipping the
mcpOAuth merge.  
**Fix:** Replace with `readActiveKeychainToken()` (already platform-aware, already
imported). Write path uses `spawnSync('security', ...)` on macOS, `writeFileSync` on
Linux.

### 3. Hot-loop rescue on exhausted accounts

**File:** `daemon.mjs` — `shouldRotate()` multi-session rescue path  
**Root cause:** When a parallel session's account was at 100% utilization, the daemon
re-probed and re-logged `is hot — rotating keychain to rescue` every 30s cycle. The
existing `FILE_ROTATION_MIN_INTERVAL` anti-thrash cap (2 minutes) only applies after
a rotation was actually attempted. The rescue path hit `return { should: true }` before
reaching the cap.  
**Fix:** Added `_parkedUntil` map. When a mismatched account is confirmed >=95% live,
it is parked until its `reset5h || reset7d` + 2 min buffer. Every subsequent cycle
checks `isParked(probeKey)` first (no network call) and returns `{ should: false }`.
Park clears automatically when the reset window passes.

### 4. Linux parity

**File:** `daemon.mjs`  
Changes:

- `notify()`: was `execSync(osascript ...)` with no Linux branch. Fixed to
  `spawnSync('notify-send', ...)` on Linux, `spawnSync('osascript', ...)` on macOS
  (no shell, no injection risk).
- `refreshSingleToken()`: vault write was macOS `security add-generic-password` with
  shell interpolation. Fixed to platform-aware: Linux writes to `LINUX_CRED_PATH` JSON
  store, macOS uses `spawnSync('security', [...])` with args array (no shell).
- `readState()`: added `STATE_KEY_MIGRATIONS` (same as rotate.mjs) for consistent key
  normalization on both platforms.

### 5. Naming consistency in logs

**File:** `daemon.mjs`  
The rescue log line used the raw email address instead of the canonical `probeKey`
(label or email). Changed to `${probeKey} (${taggedEmail})` so the canonical key is
always primary and the raw email is context.

---

## Per-Session Account Routing (foundation, feature-flagged)

**File:** `session-router.mjs` (new)  
**Activation:** `CLAUDE_SESSION_ROUTING=1` env var (unset = disabled, existing
global-keychain behavior unchanged)

### Why the global keychain is insufficient at scale

When many concurrent sessions share one keychain entry, they all use the same account
and hit its rate limit together. A keychain swap helps the NEXT tool call but all
sessions then pile onto the new account simultaneously.

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

Claude Code reads `CLAUDE_CODE_OAUTH_TOKEN` from env at startup — this is the cleanest
per-process isolation path that doesn't require touching the shared keychain. Each
session gets its own env; sessions are completely isolated.

### What's NOT implemented (needs live auth test — left branch-only)

- Daemon auto-spawning sessions with routing (requires knowing the session's final
  command line before it starts — not available at daemon level today).
- Migrating existing sessions mid-flight to a new token (safe only if the session is
  idle; risky to do mid-tool-call — left as future work with explicit `needs input:` gate).
- Dashboard integration (`--session-leases` CLI flag in rotate.mjs).

### Safe to deploy

`session-router.mjs` is import-only. Nothing calls it unless `CLAUDE_SESSION_ROUTING=1`
is set. The global keychain path is completely unaffected.

---

## Files Modified

| File | Change |
|---|---|
| `rotate.mjs` | Bug 1: `findClaudeSessions()` ps command + parser. Naming: `STATE_KEY_MIGRATIONS` in `readState()`. |
| `daemon.mjs` | Bug 2: `require()` → `readActiveKeychainToken()`. Bug 3: `_parkedUntil` park map + park logic in `shouldRotate()`. Bug 4: `notify()` Linux branch, `refreshSingleToken()` platform-aware vault write, `readState()` key migration. Bug 5: log line uses `probeKey` not raw email. |
| `session-router.mjs` | NEW: per-session routing foundation (feature-flagged, no existing behavior changed). |
| `NOTES-rotation-consistency.md` | This file. |

## Deployed live vs branch-only

| Fix | Live | Branch-only | Reason |
|---|---|---|---|
| Session enum fix | YES | — | Pure read-path fix, no auth risk |
| `require()` ESM fix | YES | — | Bug fix, no auth risk |
| Hot-loop park | YES | — | Read-path only, no keychain write |
| Linux parity | YES | — | Guarded by `IS_LINUX`, no darwin change |
| Naming consistency logs | YES | — | Log-only change |
| State key migration | YES | — | Reads then re-writes state.json only |
| Per-session routing | NO | YES | Needs live auth test to validate `CLAUDE_CODE_OAUTH_TOKEN` injection works with real sessions before enabling |
