<div align="center">

# Migrating from v1.x → v2.0

*claude-ops 2.0 is purely additive. No v1 behavior changes by default. This page exists so you know exactly what's new and how to opt out of anything you don't want.*

[![version](https://img.shields.io/badge/version-2.0.0-blue)](../CHANGELOG.md)
[![breaking](https://img.shields.io/badge/breaking%20changes-none-22c55e)](.)

</div>

> **Latest stable: v2.1.0** — see [CHANGELOG.md](../CHANGELOG.md) for releases since v2.0.0.

---

## TL;DR

```bash
# inside Claude Code:
/plugin update ops@lifecycle-innovations-limited-claude-ops
/ops:setup    # walks through the 6 new wizard steps; safe to skip any
```

That's it. Existing settings, registries, preferences, and daemon services are unchanged.

---

## What's actually new

| Area | v1.8.1 | v2.0.0 |
|------|--------|--------|
| Skills | 30 | 33+ (added `/ops:deploy-fix`, `/ops:recap`, `/ops:rotate`, `/ops:rotate-setup`) |
| Agents | 14 | 18 (added `general-purpose` override, `deploy-fixer`, `build-fixer`, `dependency-auditor`) |
| PostToolUse:Bash hooks | 0 | 3 (deploy-fix-merge, deploy-fix-build, task-reminder) |
| PreToolUse:Bash hooks | 1 (whatsapp-bridge-health) | 4 (+ secret-commit, no-rm-rf-anchor, warn-mainpush) |
| PreToolUse:Agent hooks | 0 | 1 (specialized-agent suggestion) |
| Daemons | 1 (ops-daemon, 7 services) | 3 (+ recap-daemon, account-rotation-daemon) |
| `userConfig` toggles | ~25 string entries | 44 (19+ new booleans/numbers/file pickers) |
| Wizard steps | 11 | 17 (+2d, 3o, 6.5a, 6.5b, 6.5c, 6.5d) |
| Test files | 9 | 11 (+ test-deploy-fix-hooks, test-safety-hooks) |

---

## Defaults: what fires automatically

When you upgrade and run `/ops:setup`, these v2 features activate by default:

- **Deploy auto-fix** (`deploy_fix_enabled: true`) — but only fires when you actually run `gh pr merge` or `npm run build:*` from inside a Claude Code session.
- **Specialized agent suggestion** (`suggest_specialized_agents: true`) — silent; you'll only notice via the agent transcripts.
- **Three safety hooks** — always on by design (see [`safety-hooks.md`](safety-hooks.md)).
- **Task* tracking nudge** (`task_reminder_enabled: true`) — adds a one-line reminder to `additionalContext` after 10 non-Task tool calls.
- **Recap marquee** (`recap_marquee_enabled: true`) — daemon installs and runs; harmless if you don't have tmux.

These features are **opt-out** by default:

- **Multi-account rotator** (`account_rotation_enabled: false`) — you must explicitly enable + run `/ops:rotate-setup`.

---

## Restoring v1 behaviour

Edit `/plugins` settings and toggle off:

| To restore v1 | Set |
|---------------|-----|
| Default agent always = raw `general-purpose` | `suggest_specialized_agents: false` |
| No post-merge watcher | `deploy_fix_enabled: false` |
| No build-failure fixer | `monitor_build_failures: false` |
| No task-tracking nudges | `task_reminder_enabled: false` |
| No recap marquee | `recap_marquee_enabled: false` + `launchctl unload ~/Library/LaunchAgents/com.claude-ops.recap-daemon.plist` |

To disable the three safety hooks (not recommended), comment out their entries in [`hooks/hooks.json`](../hooks/hooks.json) under `PreToolUse > Bash`.

---

## File / path migrations

None. v1 file locations, registry shapes, and preferences keys are unchanged.

New paths v2 introduces (all under `$OPS_DATA_DIR`, default `~/.claude/plugins/data/ops-ops-marketplace`):

```
$OPS_DATA_DIR/
├── locks/                         # deploy-fix single-flight per repo
├── budgets/                       # deploy-fix per-repo per-hour counter
├── logs/deploy-monitor-*.log      # one log per active monitor
├── recap/
│   ├── sessions/<sid>.jsonl       # per-session capture
│   └── digest                     # current digest (read by marquee)
└── account-rotation/
    └── usage-cache.json           # per-account quota cache
```

And:

```
~/.claude/config/post-merge-services.json   # user-scope deploy-fix registry
~/.claude/config/specialist-keywords.json   # user-scope keyword map
~/.claude/agents/<name>.md                  # user-scope specialist agents
```

---

## Rolling back to v1.8.1

```bash
/plugin uninstall ops@lifecycle-innovations-limited-claude-ops
/plugin marketplace update Lifecycle-Innovations-Limited/claude-ops
# in Claude Code, install at the v1.8.1 tag:
/plugin install ops@lifecycle-innovations-limited-claude-ops@1.8.1
```

Your `$OPS_DATA_DIR` survives uninstall. v2-specific subdirs (`locks/`, `budgets/`, `recap/`, `account-rotation/`) are ignored by v1 code; you can delete them or leave them.

---

## See also

- [`docs/INDEX.md`](INDEX.md) — full documentation index.
- [`CHANGELOG.md`](../CHANGELOG.md) — full v2.0.0 entry with PR references and file paths.
- Wiki: [`Migrating-from-v1`](https://github.com/Lifecycle-Innovations-Limited/claude-ops/wiki/Migrating-from-v1).
