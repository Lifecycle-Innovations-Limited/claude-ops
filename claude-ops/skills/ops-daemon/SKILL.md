---
name: ops-daemon
description: Check claude-ops background daemon end-to-end and auto-fix common issues. Detects stale plist paths after plugin upgrades, missing service commands, dead processes, corrupt health files, and bash version mismatches.
argument-hint: "[check|fix|restart|status|uninstall]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
effort: low
maxTurns: 20
---

## Runtime Context

Before diagnosing, load:

1. **Plugin root**: `echo "${CLAUDE_PLUGIN_ROOT:-$(ls -d "$HOME/.claude/plugins/cache/ops-marketplace/ops"/*/ 2>/dev/null | sort -V | tail -1)}"` — newest installed version
2. **Daemon health**: `cat ${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/daemon-health.json` — primary diagnostic input
3. **Services config**: `cat ${CLAUDE_PLUGIN_DATA_DIR}/daemon-services.json` — per-service command + cron definitions
4. **OS**: `uname -s` — daemon install is macOS-only (launchd). Linux/WSL/Windows fall back to manual invocation.

# OPS ► DAEMON

Diagnostic + auto-fix surface for the background `ops-daemon` process. Acts like `ops-doctor` but scoped to the one subsystem users actually see break: the launchd daemon that keeps `briefing-pre-warm`, `memory-extractor`, `message-listener`, `inbox-digest`, and `competitor-intel` alive.

## CLI/API Reference

### bin/ops-daemon-manager.sh

| Command | Usage | Output |
|---------|-------|--------|
| `${CLAUDE_PLUGIN_ROOT}/scripts/ops-daemon-manager.sh status` | Emit JSON snapshot | `{os, installed, running, pid, plist_version_match, health_fresh, ...}` |
| `${CLAUDE_PLUGIN_ROOT}/scripts/ops-daemon-manager.sh install` | First-time install (idempotent) | Writes plist, loads launchd |
| `${CLAUDE_PLUGIN_ROOT}/scripts/ops-daemon-manager.sh upgrade` | Re-point plist at current PLUGIN_ROOT + reload | Fixes stale version paths |
| `${CLAUDE_PLUGIN_ROOT}/scripts/ops-daemon-manager.sh restart` | Unload + reload without reconfiguring | Clears stuck state |
| `${CLAUDE_PLUGIN_ROOT}/scripts/ops-daemon-manager.sh uninstall` | Stop + remove plist | Returns system to pre-install state |

Accepts `--plugin-root PATH` to override auto-detection and `--dry-run` to preview without side effects.

### Health file schema

`${CLAUDE_PLUGIN_DATA_DIR}/daemon-health.json`:

```json
{
  "timestamp": "<ISO-8601 UTC>",
  "pid": <int>,
  "uptime_seconds": <int>,
  "services": {
    "<name>": {
      "status": "running|polling|scheduled|dead|needs_reauth|max_restarts_exceeded",
      "pid": <int|null>,
      "last_health": "<string|null>",
      "last_run": "<ISO-8601|empty>",
      "next_run": "<ISO-8601|empty>",
      "restarts": <int>,
      "latency_ms": <int>,
      "last_success": "<ISO-8601|empty>",
      "error_count": <int>,
      "last_error": "<string|null>"
    }
  },
  "action_needed": null | {"kind": "...", "service": "...", "message": "..."},
  "credential_warnings": ["<string>", ...],
  "rate_limit_warnings": ["<string>", ...]
}
```

A healthy daemon refreshes this file every 30s. An `mtime` older than 120s is a strong fail signal.

**Per-service fields (Phase 16 additions):**

- `latency_ms` — duration of the most recent run for warm/cron services, in milliseconds. 0 when no run has occurred yet.
- `last_success` — ISO-8601 UTC of the last clean run (no errors). Empty until the first success.
- `error_count` — cumulative error count since daemon start. Reset on daemon restart.
- `last_error` — truncated (≤300 chars) message from the most recent failure. `null` when there have been no failures.

**Top-level fields (Phase 16 additions):**

- `credential_warnings` — list of credentials that are expiring within 7 days or are keys older than 180 days. Populated from offline inspection of `preferences.json` (never a live API call).
- `rate_limit_warnings` — list of integrations currently at ≥80% of their quota window. Populated from `rate-limits.json` counters.

**Persistent service failure:** a service that hits `max_restarts_exceeded` status dispatches a one-shot `HIGH` severity push notification via `ops-notify.sh` to every configured sink (Telegram / Discord / ntfy / Pushover / macOS). The notification is re-armed the moment the service returns to `running`, so subsequent regressions still notify.

### Smart Cache Invalidation (git hooks)

Cache timestamp files (`.briefing_ts`, `.projects_ts`, `.marketing_ts`, `.prs_ts`, `.ci_ts`) are deleted on local `git commit` and `git merge` so the next daemon warm cycle refreshes those specific caches without waiting for the normal throttle window.

Install:

    bash ${CLAUDE_PLUGIN_ROOT}/scripts/ops-install-git-hooks.sh

Preview without writing:

    bash ${CLAUDE_PLUGIN_ROOT}/scripts/ops-install-git-hooks.sh --dry-run

Remove:

    bash ${CLAUDE_PLUGIN_ROOT}/scripts/ops-install-git-hooks.sh --uninstall

The installer is idempotent and only touches the block between `# BEGIN ops-daemon-invalidate` and `# END ops-daemon-invalidate` — existing husky / lefthook / pre-commit content in `.git/hooks/post-commit` or `.git/hooks/post-merge` is preserved.

### Marketing Pre-Warm

The opt-in `marketing-prewarm` cron service pre-fetches cross-platform marketing data (Klaviyo, Meta Ads, GA4, GSC, Google Ads) every 15 minutes so `/ops:marketing` loads instantly from cache. Disabled by default; enable with `/ops:setup marketing` once marketing credentials are configured.

### Rate Limit Tracking

Per-integration counters in `${CLAUDE_PLUGIN_DATA_DIR}/rate-limits.json` — `{quota, calls, window_start, warned_80pct}` per integration. On each tracked API call the daemon advances the rolling window, increments the counter, and sends a single `MEDIUM` push notification when the ratio crosses 80%. Windows reset automatically on rollover, which re-arms the 80% warning.

Override the seeded defaults by setting `rate_limit_quotas` in `${CLAUDE_PLUGIN_DATA_DIR}/preferences.json`:

```json
{
  "rate_limit_quotas": {
    "meta_ads": {"quota": 200, "window_seconds": 3600},
    "klaviyo":  {"quota": 75,  "window_seconds": 60}
  }
}
```

### Credential Rotation Alerts

The daemon checks `${CLAUDE_PLUGIN_DATA_DIR}/preferences.json` once an hour for:

- `<integration>_expires_at` — ISO-8601 timestamp or the literal string `"never"`. Warns when within 7 days of expiry.
- `<integration>_created_at` — ISO-8601 timestamp of when an API key was last created/rotated. Warns once the key is 180 days old.

The check is **entirely offline** — it never makes a network call. Warnings surface in `daemon-health.json` as `credential_warnings` and trigger a `MEDIUM` push notification once per `(credential, day)` tuple. `/ops:fires` lists them alongside Sentry / infra / CI issues.

---

## Your task

Route on the first argument:

| Argument | Action |
|----------|--------|
| `check` (default) | Run all diagnostics, print a colored report, exit 0 if green / 1 otherwise |
| `fix` | Run `check`, then per detected issue ask the user for confirmation and apply the fix |
| `restart` | Call `ops-daemon-manager.sh restart` |
| `status` | Print the JSON output of `ops-daemon-manager.sh status` verbatim — consumed by other skills |
| `uninstall` | Ask `[Uninstall]` / `[Cancel]` via `AskUserQuestion`, then call the manager |

### Diagnostic checklist

Run each check and track results as `pass` / `fail` / `warn`:

1. **Plugin root resolved** — `CLAUDE_PLUGIN_ROOT` env var set OR `~/.claude/plugins/cache/ops-marketplace/ops/<version>/scripts/ops-daemon.sh` exists.
2. **OS supported** — `uname -s` is `Darwin`. On Linux/WSL print the manual invocation and exit 0 with a `warn` note. On native Windows print "not supported".
3. **Plist installed** — `~/Library/LaunchAgents/com.claude-ops.daemon.plist` exists.
4. **Plist points at current version** — the second `<string>` inside `ProgramArguments` equals `${PLUGIN_ROOT}/scripts/ops-daemon.sh`. Mismatch = **stale after upgrade** (the most common failure mode).
5. **Plist is valid XML** — `plutil -lint` passes.
6. **Launchctl registered** — `launchctl list` shows the label with a real PID (not `-`).
7. **Process alive** — `kill -0 <pid>` succeeds.
8. **Bash binary exists** — the first `<string>` in `ProgramArguments` is executable and reports `BASH_VERSINFO >= 4` (required for `declare -A` in the daemon script).
9. **Health file fresh** — `daemon-health.json` exists, `mtime` within last 120 seconds.
10. **Every service has a command** — iterate `daemon-services.json` services; each enabled entry must have a non-empty `command` field. Missing `command` silently skips the service (historical bug).
11. **Running services alive** — for each service in the health file with `status=running|polling`, verify `kill -0 <pid>` succeeds.
12. **Cron services have future `next_run`** — `scheduled` services must have a `next_run` timestamp in the future.
13. **wacli-sync path resolves** — if enabled, `~/.wacli/.health` exists and is fresh. (Optional — mark warn not fail if missing.)
14. **No zombie children** — no orphaned `ops-message-listener.sh` or `wacli-keepalive.sh` processes without a parent `ops-daemon.sh`.

### Fix playbook

For each failed check, `fix` mode proposes a specific repair and asks the user with `AskUserQuestion` (**max 4 options** — always include `[Skip]`):

| Failure | Fix | Destructive? |
|---------|-----|--------------|
| Plist stale version path | `ops-daemon-manager.sh upgrade` | Yes — unloads + reloads |
| Plist missing | `ops-daemon-manager.sh install` | No |
| Plist invalid XML | Regenerate via `install` (after backup) | Yes — overwrites |
| Process dead but plist ok | `ops-daemon-manager.sh restart` | Yes — restarts |
| Health file stale (>120s) | `ops-daemon-manager.sh restart` | Yes |
| Service missing `command` | Merge from `scripts/daemon-services.example.json` into user's `daemon-services.json` after showing a diff | Yes — writes config |
| Bash binary missing/<4 | `brew install bash` on macOS; on Linux check `$(command -v bash)` version; ask user to install | No (reports only) |
| Zombie child processes | `kill <pid>` with per-process confirmation (Rule 5) | Yes |
| Services config corrupt JSON | Restore from `scripts/daemon-services.default.json` after confirmation + backup | Yes |

**Never batch fixes.** Per Rule 5, each destructive action needs its own `AskUserQuestion` with `[Apply]` / `[Skip]` options.

### Output format for `check`

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► DAEMON CHECK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 OS:           macos
 Plugin root:  ${CLAUDE_PLUGIN_ROOT}
 Daemon PID:   57004
 Uptime:       1h 12m

 ✓ Plist installed
 ✓ Plist points at current version
 ✓ Plist is valid XML
 ✓ Launchctl registered, PID alive
 ✓ Bash binary found (5.3)
 ✓ Health file fresh (mtime 23s ago)
 ✓ All 5 enabled services have commands
 ✓ Running services alive
 ✓ Cron services have future next_run

 STATUS: GREEN — daemon healthy
```

On failure, replace `✓` with `✗` and append a one-line remediation hint. Exit 1 so `/ops:ops-status` can surface red.

### Output format for `status`

Print the JSON from `ops-daemon-manager.sh status` verbatim. No wrapping. This is the machine-readable contract consumed by `ops-status`, `ops-go`, and other skills.

### Output format for `fix`

Render the `check` report, then for each failing check enter a confirmation loop:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► DAEMON FIX — 3 issues found
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 ✗ Plist points at old version 1.0.0
   → Proposed: ops-daemon-manager.sh upgrade
```

Then `AskUserQuestion` with `[Apply fix]` / `[Skip this issue]` / `[Cancel all]`. Repeat for each issue. After all actions, re-run `check` and print a before/after diff.

## Cross-OS notes

- **macOS**: full support via launchd. All subcommands available.
- **Linux / WSL**: `ops-daemon-manager.sh install` exits `EX_UNAVAILABLE` (69) and prints the manual `nohup` invocation. `check` still validates the daemon script and services config.
- **Windows native**: unsupported. Use WSL.

Do not hardcode `launchctl` in this SKILL — always route through the manager script so future systemd / Task Scheduler support is a one-line addition.

## Examples

```
# Morning habit: confirm the daemon survived overnight
/ops:daemon check

# After a plugin upgrade (`/plugin upgrade claude-ops`):
/ops:daemon fix
# → detects stale plist, asks [Apply upgrade], reloads, verifies

# Embedded in another skill:
/ops:daemon status | jq -r '.health_fresh'
```
