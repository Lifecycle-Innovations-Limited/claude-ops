---
name: ops-deploy-fix
description: Inspect and control the deploy/build auto-fix subsystem. Use for `/ops:deploy-fix status` (last monitor runs, fixer dispatches, locks, hourly budget), `/ops:deploy-fix tail` (follow latest fixer log), `/ops:deploy-fix configure` (re-run the wizard), and `/ops:deploy-fix test` (synthetic dry-run through the pipeline). Trigger when the user mentions deploy auto-fix, post-merge monitor, build fixer, fix budget, fix-agent log, or asks why a deploy didn't get auto-fixed.
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
  - Skill
---

# /ops:deploy-fix — Auto-fix subsystem control surface

This skill is the operator console for the post-merge + build-failure auto-fix loop installed by `/ops:setup` Step 6.5a. The underlying daemons, hooks, and prompts live in `${CLAUDE_PLUGIN_ROOT}/scripts/`, `${CLAUDE_PLUGIN_ROOT}/hooks/`, and `${CLAUDE_PLUGIN_ROOT}/prompts/`. State lives in `~/.claude/state/ops-deploy-fix/`. Logs live in `~/.claude/logs/ops-deploy-fix/`.

**Plugin rules apply (see `claude-ops/CLAUDE.md`).** In particular:
- Rule 0 — never echo personal data (slugs are fine, but redact tokens, webhooks, emails)
- Rule 1 — max 4 options per `AskUserQuestion`
- Rule 4 — background by default during `configure`
- Rule 5 — destructive ops (clearing locks, wiping state) require explicit per-action confirmation
- Rule 6 — this skill never sends outbound comms; if a future flow needs to, use the universal send gate

## Arguments

The first positional argument selects the subcommand. If absent, present:

```
/ops:deploy-fix — what do you want to do?
  [status]
  [tail]
  [configure]
  [test]
```

Subcommands:

| Subcommand   | Purpose                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| `status`     | Dashboard of recent monitor runs, fixer dispatches, locks, budget        |
| `tail`       | Follow the latest fixer log live                                         |
| `configure`  | Re-run the wizard from `/ops:setup` Step 6.5a                            |
| `test`       | Send a synthetic failure through the pipeline (dry-run, no real fix)     |

---

## Subcommand: `status`

Print a compact dashboard. Read all data via Bash; favor parallel reads.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► DEPLOY-FIX STATUS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Master switch:    <on|off>          (deploy_fix_enabled)
 Auto-dispatch:    <on|off>          (auto_dispatch_fixer)
 Danger flag:      <on|off>          (allow_dangerous)
 Budget cap:       <N>/hour/repo     (max_fixes_per_hour)
 Notify channel:   <macos|ntfy|discord|none>
 Fix model:        <haiku|sonnet|opus>

 Last 5 monitor runs:
   2026-04-26T08:14Z  owner/repo-a:dev   merge-watch         deploy-success
   2026-04-26T08:11Z  owner/repo-b:main  build-watch         transient → rerun
   ...

 Last 5 fixer dispatches:
   2026-04-26T08:09Z  owner/repo-b:main  build-fix.md   in-flight   pid 41123
   2026-04-26T07:42Z  owner/repo-a:dev   deploy-fix.md  done        log:fix-...log

 Active locks:
   owner/repo-b:main:build  pid=41123 (alive)

 Hourly budget remaining (this hour, <YYYYMMDD-HH>):
   owner/repo-a   2 / 3
   owner/repo-b   1 / 3
──────────────────────────────────────────────────────
```

**Data sources:**

```bash
PREFS=~/.claude/plugins/data/ops-ops-marketplace/preferences.json
STATE=~/.claude/state/ops-deploy-fix
LOGS=~/.claude/logs/ops-deploy-fix

# Config snapshot (all keys read with defaults from plugin.json userConfig)
jq -r '{
  deploy_fix_enabled, auto_dispatch_fixer, allow_dangerous,
  max_fixes_per_hour, notify_channel, fix_model
}' "$PREFS" 2>/dev/null

# Monitor runs — last 5 across all repos
ls -t "$LOGS"/monitor-*.log 2>/dev/null | head -5 | while read f; do
  printf '%s  %s\n' "$(stat -f '%Sm' -t '%FT%RZ' "$f" 2>/dev/null || stat --format='%y' "$f" 2>/dev/null | awk '{print $1"T"$2"Z"}')" "$(basename "$f")"
done

# Fixer dispatches — last 5
ls -t "$LOGS"/fix-*.log 2>/dev/null | head -5 | while read f; do
  pid_file="$STATE/lock-$(basename "$f" | sed 's/^fix-//; s/-[0-9]*\.log$//')"
  status="done"
  [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null && status="in-flight"
  printf '%s  %s  %s\n' "$(stat -f '%Sm' -t '%FT%RZ' "$f" 2>/dev/null || stat --format='%y' "$f" 2>/dev/null | awk '{print $1"T"$2"Z"}')" "$status" "$(basename "$f")"
done

# Active locks
for f in "$STATE"/lock-*; do
  [ -f "$f" ] || continue
  pid=$(cat "$f")
  if kill -0 "$pid" 2>/dev/null; then
    echo "$(basename "$f" | sed 's/^lock-//')  pid=$pid (alive)"
  fi
done

# Hourly budget — read all budget files for current hour
hour=$(date +%Y%m%d-%H)
cap=$(jq -r '.max_fixes_per_hour // 3' "$PREFS")
for f in "$STATE"/budget-*-"$hour"; do
  [ -f "$f" ] || continue
  slug=$(basename "$f" | sed "s/^budget-//; s/-$hour\$//")
  used=$(cat "$f")
  echo "$slug  $((cap - used)) / $cap"
done
```

After the dashboard, if any lock is older than the configured `watcher_timeout_seconds`, surface a `⚠️ Stale lock:` line and offer:

```
Stale lock detected for <repo>. Action?
  [Inspect log]
  [Clear lock (Rule 5 — destructive)]
  [Leave it]
  [Skip]
```

Only on `Clear lock` should you delete the file (per-action confirmation per Rule 5).

---

## Subcommand: `tail`

Tail the most-recent fixer log. Resolve via `ls -t`:

```bash
LATEST=$(ls -t ~/.claude/logs/ops-deploy-fix/fix-*.log 2>/dev/null | head -1)
if [ -z "$LATEST" ]; then
  echo "No fixer logs yet. Trigger one with /ops:deploy-fix test or wait for a real failure."
  exit 0
fi
echo "▸ Tailing $LATEST (Ctrl-C to stop)"
tail -f "$LATEST"
```

Run via Bash with `run_in_background: true` and a long timeout so the user can read the stream as it grows. Print the resolved log path and the spawned shell PID up-front so the user knows what's running.

If a second positional arg `--lines N` is passed, do `tail -n N -f`. If `--no-follow`, drop `-f`.

---

## Subcommand: `configure`

Re-run the wizard from `/ops:setup` Step 6.5a, plus optionally 6.5b/c/d. Implementation: route into the `setup` skill with section filter.

Flow:

1. Read current state from `$PREFS_PATH`. Print compact summary (same fields as `status`, no logs).
2. Ask:
   ```
   What do you want to reconfigure?
     [Deploy auto-fix wizard (6.5a)]
     [Recap marquee (6.5b)]
     [Task* reminder (6.5c)]
     [Account rotation toggle (6.5d)]
   ```
3. Execute the corresponding sub-flow inline by following Step 6.5 of `skills/setup/SKILL.md` — same questions, same persistence, same Rule-3 "never silently skip" semantics.
4. After persistence, print:
   ```
   ✓ Reconfigured. Daemons & hooks pick up the new prefs on the next event — no restart required.
   ```

Use `run_in_background: true` (Rule 4) for any CLI install / brew / curl / `tmux source-file` triggered along the way.

---

## Subcommand: `test`

Synthetic dry-run through the pipeline. **No real fix dispatch — no agent runs.** Confirms wiring: hooks fire → monitor classifies → notify channel pings → state files written → would-dispatch path logged.

Steps:

1. Pre-flight check:
   ```bash
   PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
   [ -z "$PLUGIN_ROOT" ] && PLUGIN_ROOT=$(find ~/.claude -type d -name claude-ops 2>/dev/null | head -1)
   COMMON="$PLUGIN_ROOT/scripts/lib/deploy-fix-common.sh"
   [ -f "$COMMON" ] || { echo "✗ deploy-fix-common.sh missing — re-install the plugin"; exit 1; }
   ```

2. Ask:
   ```
   What should the synthetic failure look like?
     [Build failure (npm run build:* exit 1)]
     [Deploy workflow failure (gh actions check_run)]
     [Health check failure (curl /health 503)]
     [Version mismatch (served SHA != merged SHA)]
   ```

3. Generate a fake event payload matching the chosen kind. Set env var `OPS_DEPLOY_FIX_DRY_RUN=1` and invoke the relevant trigger script:

   ```bash
   export OPS_DEPLOY_FIX_DRY_RUN=1
   export OPS_DEPLOY_FIX_TEST_REPO="your-org/your-repo"   # placeholder per Rule 0
   export OPS_DEPLOY_FIX_TEST_BASE="dev"
   case "$kind" in
     build)   bash "$PLUGIN_ROOT/bin/ops-deploy-fix-build-trigger" --synthetic ;;
     deploy)  bash "$PLUGIN_ROOT/bin/ops-deploy-fix-merge-trigger" --synthetic ;;
     health)  bash "$PLUGIN_ROOT/scripts/ops-deploy-monitor.sh" --synthetic-health ;;
     version) bash "$PLUGIN_ROOT/scripts/ops-deploy-monitor.sh" --synthetic-version ;;
   esac
   ```

   Trigger scripts must honor `OPS_DEPLOY_FIX_DRY_RUN=1` by:
   - Skipping the actual `claude -p ...` dispatch in `dispatch_fix_agent`
   - Writing a `would-dispatch-<id>-<ts>.log` to `$LOGS_DIR` instead
   - Still incrementing the budget counter (so the test exercises the cap)
   - Logging `[DRY-RUN] would notify <channel>` instead of firing real `notify` (no actual outbound messages during test — Rule 6)

   *If the trigger scripts don't yet support `--synthetic` / `OPS_DEPLOY_FIX_DRY_RUN`, surface that as a known TODO in the output and degrade to "would-have-dispatched" log-only.*

4. Print the resulting `would-dispatch-*.log` path and a one-line classification result (transient? dedup-hit? budget-exhausted? would-dispatch-template=`<file>`).

5. Offer:
   ```
   Test complete. Next?
     [Tail the would-dispatch log]
     [Run another test]
     [Show status dashboard]
     [Done]
   ```

---

## Failure modes / hand-offs

- **No prefs file** → tell the user to run `/ops:setup` (or `/ops:deploy-fix configure`) first.
- **`claude` CLI missing** (status / test) → instruct via output, do not auto-install.
- **`jq` missing** → run `brew install jq` in background (Rule 4) and retry.
- **Stale lock detection** → see `status` flow above, requires Rule-5 confirmation to clear.
- **Notify channel mis-set** (e.g. `discord` selected but no webhook) → on `status`, surface as `⚠️ notify_channel=discord but no webhook URL configured` and offer `[Reconfigure now]`.

## Files this skill reads / writes

- Read-only: `~/.claude/plugins/data/ops-ops-marketplace/preferences.json`, `~/.claude/state/ops-deploy-fix/*`, `~/.claude/logs/ops-deploy-fix/*`, `${CLAUDE_PLUGIN_ROOT}/scripts/lib/deploy-fix-common.sh`, `${CLAUDE_PLUGIN_ROOT}/prompts/{build-fix,deploy-fix}.md`
- Write (with explicit confirmation only): lock files in `~/.claude/state/ops-deploy-fix/lock-*` (clear on stale)
- Write (via `configure` subcommand): the prefs file, via the merge pattern in Step 6.5
