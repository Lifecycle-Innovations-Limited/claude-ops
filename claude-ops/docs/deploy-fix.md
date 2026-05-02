<div align="center">

# Deploy Auto-Fix Subsystem

*Watches every `gh pr merge` and `npm run build:*` you run, verifies the deploy, and dispatches a Haiku fixer if anything fails.*

[![version](https://img.shields.io/badge/version-2.1.0-blue)](../CHANGELOG.md)
[![hook](https://img.shields.io/badge/PostToolUse-Bash-6366f1)](.)
[![model](https://img.shields.io/badge/fixer-haiku--default-22c55e)](.)

</div>

---

## TL;DR

```
gh pr merge --squash --admin
        │
        ▼ PostToolUse:Bash hook
bin/ops-deploy-fix-merge-trigger
        │
        ▼ background fork
scripts/ops-deploy-monitor.sh
        │
        ├──► poll deploy GitHub Actions run
        ├──► curl /health on success
        ├──► curl /version, compare SHA
        └──► on failure:
              ├── transient?  ──► gh run rerun
              └── real?       ──► dispatch headless Haiku deploy-fixer
                                   (uses prompts/deploy-fix.md)
```

The same pattern fires for `npm run build:*` via `bin/ops-deploy-fix-build-trigger`, dispatching a `build-fixer` agent with `prompts/build-fix.md`.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│  Claude Code session                                                   │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Bash tool: gh pr merge --squash 123                            │  │
│  └──────────────────────────────┬───────────────────────────────────┘  │
└─────────────────────────────────┼──────────────────────────────────────┘
                                  │ PostToolUse:Bash if Bash(gh pr merge *)
                                  ▼
              ┌─────────────────────────────────────────┐
              │  bin/ops-deploy-fix-merge-trigger       │
              │  - parse repo, pr, base, sha            │
              │  - check userConfig toggles             │
              │  - check budget (max_fixes_per_hour)    │
              │  - acquire single-flight lock per repo  │
              │  - fork scripts/ops-deploy-monitor.sh   │
              └────────────────┬────────────────────────┘
                               │ background
                               ▼
              ┌─────────────────────────────────────────┐
              │  scripts/ops-deploy-monitor.sh          │
              │  ┌───────────────────────────────────┐  │
              │  │ poll gh run list (deploy regex)   │  │
              │  │   timeout: watcher_timeout_seconds│  │
              │  └─────────────┬─────────────────────┘  │
              │                │                        │
              │      ┌─────────┴─────────┐              │
              │      ▼                   ▼              │
              │  success              failure           │
              │      │                   │              │
              │      ▼                   ▼              │
              │  curl /health       transient?          │
              │      │              ┌────┴────┐         │
              │      ▼              ▼         ▼         │
              │  curl /version    gh run    dispatch    │
              │  cmp SHA          rerun     headless    │
              │      │                      claude      │
              │      └─►  notify   ◄─────────┘          │
              └────────────────┬────────────────────────┘
                               │
                               ▼
              ┌─────────────────────────────────────────┐
              │  scripts/ops-notify.sh                  │
              │  routes to: macos | ntfy | pushover |   │
              │             discord | telegram | none   │
              └─────────────────────────────────────────┘
```

The build-failure path is the same minus the deploy poll — it goes straight to `dispatch headless claude` with the failing build output as context.

---

## Components

| Path | Role |
|------|------|
| `hooks/hooks.json` | Wires both PostToolUse:Bash triggers + the `npm run build:*` `if` matcher. |
| `bin/ops-deploy-fix-merge-trigger` | Hook handler for merges. Parses, gates, forks the monitor. |
| `bin/ops-deploy-fix-build-trigger` | Hook handler for failing local builds. Same pattern, no deploy poll. |
| `scripts/ops-deploy-monitor.sh` | Long-lived background watcher per merge. |
| `scripts/lib/deploy-fix-common.sh` | Shared helpers — lock, budget, dedup, transient classifier, notify. |
| `prompts/deploy-fix.md` | Headless `deploy-fixer` agent prompt template. |
| `prompts/build-fix.md` | Headless `build-fixer` agent prompt template. |
| `agents/deploy-fixer.md` | Pre-installed specialist agent. |
| `agents/build-fixer.md` | Pre-installed specialist agent. |
| `config/post-merge-services.example.json` | Plugin-default service registry. |
| `skills/ops-deploy-fix/SKILL.md` | `/ops:deploy-fix` user-facing skill. |
| `tests/test-deploy-fix-hooks.sh` | 39 assertions / 11 cases. |

---

## Service registry

The monitor needs to know *which* service the merged PR deploys to so it can hit the right `/health` and `/version` endpoints. The registry is layered:

```
project   .claude/post-merge-services.json
              ▲ overrides
user      ~/.claude/config/post-merge-services.json
              ▲ overrides
plugin    config/post-merge-services.example.json   (defaults / examples)
```

Schema:

```json
{
  "your-org/your-api:dev": {
    "health_url": "https://api-dev.example.com/health",
    "version_url": "https://api-dev.example.com/version",
    "deploy_workflow": "deploy-staging.yml",
    "served_sha_jq": ".commit.sha"
  },
  "your-org/your-api:main": {
    "health_url": "https://api.example.com/health",
    "version_url": "https://api.example.com/version",
    "deploy_workflow": "deploy-production.yml"
  }
}
```

`served_sha_jq` is optional; defaults to `.sha // .commit // .version`.

If a merge has no registry entry, the monitor falls back to **deploy-only verification** (poll the workflow, no health/version curl) and notifies on workflow failure.

---

## Dedup, budget, single-flight

Three independent guards prevent runaway agent spawning:

1. **Single-flight lock per repo** — `scripts/lib/deploy-fix-common.sh` acquires a `flock`-style lock on `${OPS_DATA_DIR}/locks/<owner>__<repo>.lock`. Concurrent merges on the same repo queue; no two deploy-fixers run for the same repo at once.
2. **Hourly budget cap** — `max_fixes_per_hour` (default 3, range 0..20). The shared lib increments a per-repo per-hour counter at `${OPS_DATA_DIR}/budgets/<owner>__<repo>__<YYYYMMDDHH>`. When the cap is hit, the failure is logged + notified but the fixer is **not** dispatched.
3. **Content-hash dedup** — the failing log tail (last 4 KB) is sha256'd. If the same hash dispatched a fixer in the last hour for the same repo, the new failure is treated as a duplicate and skipped (the previous fixer is presumed to be either still running or recently shipped a PR).

---

## Transient classification

`auto_rerun_transients` (default `true`) routes failures matching any of these patterns to `gh run rerun --failed` instead of dispatching a fixer:

- `npm ERR! 5\d\d` (npm registry 5xx)
- `EAI_AGAIN` / `getaddrinfo` (DNS blip)
- `Error: read ECONNRESET` / `socket hang up`
- `429 Too Many Requests`
- `The runner has received a shutdown signal`
- `Process completed with exit code 137` (OOM-kill)

The classifier is intentionally narrow — when in doubt, dispatch a real fixer.

---

## Notification channels

`notify_channel` userConfig (default `macos`):

| Value | Mechanism |
|-------|-----------|
| `macos` | `osascript -e 'display notification ...'` |
| `ntfy` | `curl -d "msg" ntfy.sh/<topic>` (set `ntfy_topic`) |
| `pushover` | Pushover API (set `pushover_user_key` + `pushover_app_token`) |
| `discord` | Discord webhook (set `discord_default_webhook_url`) |
| `telegram` | Telegram MCP send (uses `telegram_notify_chat_id`) |
| `none` | Silent — log only |

All channels prefix the message with the repo + PR + run URL so you can jump straight to the failed run.

---

## `/ops:deploy-fix` skill

| Subcommand | Purpose |
|------------|---------|
| `/ops:deploy-fix` | Live status — running monitors, today's history, budget remaining per repo. |
| `/ops:deploy-fix tail <run-id>` | Stream the monitor log for a specific run. |
| `/ops:deploy-fix configure` | Open the layered service registry in `$EDITOR`. |
| `/ops:deploy-fix test` | Dry-run the merge-trigger hook against a synthetic merge — verifies registry, lock, budget logic without dispatching. |

---

## Configuration reference

All settings live under `userConfig` in `plugin.json` and are spacebar-toggleable in `/plugins` settings.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `deploy_fix_enabled` | boolean | `true` | Master switch. |
| `monitor_post_merge` | boolean | `true` | Watch `gh pr merge`. |
| `monitor_build_failures` | boolean | `true` | Watch `npm run build:*`. |
| `auto_dispatch_fixer` | boolean | `true` | Off = log + notify only. |
| `allow_dangerous` | boolean | `false` | Pass `--dangerously-skip-permissions` to fixer. |
| `auto_rerun_transients` | boolean | `true` | Auto-`gh run rerun` on classified blips. |
| `audit_health_after_deploy` | boolean | `true` | `curl /health` after success. |
| `verify_served_commit` | boolean | `true` | `curl /version` and compare SHA. |
| `fix_model` | string | `haiku` | `haiku` / `sonnet` / `opus`. |
| `max_fixes_per_hour` | number | `3` | Per-repo cap (0..20). |
| `watcher_timeout_seconds` | number | `1800` | Max wait for deploy completion (60..7200). |
| `registry_path` | file | `~/.claude/config/post-merge-services.json` | User registry. |
| `repo_search_roots` | string | `~/Projects:~` | Where to find the repo on disk. |
| `deploy_workflow_pattern` | string | `deploy\|Deploy\|build\|Build\|ECS\|cd\|CD` | Regex picking the deploy run. |
| `notify_channel` | string | `macos` | `macos`/`ntfy`/`pushover`/`discord`/`telegram`/`none`. |

---

## Troubleshooting

**No fixer dispatched after a failed merge.** Check in order:
1. `/ops:deploy-fix` — is the master switch on? Budget exhausted?
2. `tail -f $OPS_DATA_DIR/logs/deploy-monitor-*.log` — did the monitor start?
3. `gh run list --repo <owner/repo> --limit 5` — did GH Actions actually emit a run matching `deploy_workflow_pattern`?
4. Registry — does `<owner/repo>:<base>` exist? Without an entry, the monitor will only poll the workflow, not health/version.

**Fixer keeps re-firing on the same failure.** Content-hash dedup looks at the last 4 KB of log. If your build always emits a unique trailer (timestamp, run-id), dedup misses. Either:
- Add a `dedup_strip_pattern` to your registry entry (TODO — pending in v2.1), or
- Lower `max_fixes_per_hour` to `1`.

**Health check fails immediately after success.** Most services need a few seconds to roll over after a green deploy. The monitor sleeps 15s before the first `/health` call. Tune via `HEALTH_GRACE_SECONDS` env var if needed.

**`--dangerously-skip-permissions` makes me nervous.** Leave `allow_dangerous: false` (the default). The fixer will pause on permission prompts, which means unattended runs may stall. The trade-off is yours.

---

## FAQ

**Q: Will this dispatch fixers for PRs I merge from the GitHub web UI?**
No. The hook only fires on `gh pr merge` from inside a Claude Code session. CI-merged or web-merged PRs are invisible to it. (This is intentional — the hook scope is your local Claude Code workflow.)

**Q: Does it work for non-Node deploys?**
The merge trigger is language-agnostic — it only inspects `gh pr merge` arguments. The build trigger currently matches `npm run build:*`; PRs welcome to add `pnpm`, `yarn`, `cargo build`, `go build`, `mvn package` matchers.

**Q: Does it touch my git history?**
No. The fixer creates a new branch (`fix/auto-deploy-<sha>`) and opens a PR. Your main/dev branch is never directly modified.

**Q: How much does a typical fixer run cost?**
~5-15k Haiku tokens for a clean diagnosis + 1-file fix. ~$0.005-$0.015 per dispatch. With `max_fixes_per_hour: 3` your worst-case spend is ~$1.20/day per repo.

---

## See also

- [`docs/agents.md`](agents.md) — pre-installed specialist agents (deploy-fixer + build-fixer live here).
- [`docs/safety-hooks.md`](safety-hooks.md) — universal PreToolUse safety hooks (independent of deploy-fix).
- [`docs/recap.md`](recap.md) — recap marquee shows live deploy-fix activity across sessions.
- [`docs/INDEX.md`](INDEX.md) — full documentation index.
