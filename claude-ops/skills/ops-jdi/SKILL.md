---
name: ops-jdi
description: "OPS on-demand: This skill should be used when the user asks to \"just do it\", \"install jdi\", \"keep going until delivered\", or…"
argument-hint: '[status|install|update|uninstall|rollback BACKUP|test]'
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - AskUserQuestion
effort: low
maxTurns: 20
---

# OPS ► JDI — Just Do It

Load `ops-rules` before acting. Public repo (no personal data). Outbound: one draft → one approval → one send. If `AskUserQuestion` / `Workflow` are missing, follow Rule 10 in `ops-rules` (Hermes: numbered options / two-turn Telegram card; `delegate_task`).

Bundled Claude Code plugin (`plugin/`) that keeps an authorized task going until it is verified and delivered. It is **opt-in**: nothing here is registered in the ops hooks, so installing `ops` never adds a Stop gate by itself.

## What it does

- Native command hooks (SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure, Stop) run `plugin/hooks/bridge.py`: a deterministic, model-free state machine. Every Stop costs zero model calls.
- A contract (outcomes + definition of done) is accepted only with inspected evidence plus a delivery record that matches the real final message.
- Pause/stop requests and approval waits always win. Failed tool calls become incidents; harmless ones (guard refusals, empty results, timeouts) are closed with `waive-incident`.
- `/just-do-it maintain` diagnoses named Claude Code config files; `maintain fix` repairs only plugin-owned issues with backup, pre/post hashes and rollback. Anything outside the plugin folder is a proposal only. Security policy is never touched.
- `/just-do-it audit` is an on-demand semantic check (one `$.model.fork`). It needs an interactive session; headless it returns `nothing-to-fork` at zero cost.

Full contract, state machine and known limitations: `plugin/README.md`.

## Commands

| Arg | Action |
| --- | --- |
| `status` (default) | `claude plugin list` entry for `just-do-it@local-just-do-it` |
| `install` | `bash ${CLAUDE_PLUGIN_ROOT}/skills/ops-jdi/install.sh install` (copy owned files into a local marketplace, register it, then install the plugin at user scope; refuses an existing installation) |
| `update` | `bash ${CLAUDE_PLUGIN_ROOT}/skills/ops-jdi/install.sh update` (requires an owned, registered user installation; back up source, copy managed files, then update via the CLI; preserve unknown files and runtime) |
| `uninstall` | `bash ${CLAUDE_PLUGIN_ROOT}/skills/ops-jdi/install.sh uninstall` (remove plugin and marketplace registrations; retain source, backups and runtime) |
| `rollback BACKUP` | `bash ${CLAUDE_PLUGIN_ROOT}/skills/ops-jdi/install.sh rollback "BACKUP"` (restore managed source from a matching printed backup and update the installed plugin; refuse source conflicts and preserve current runtime) |
| `test` | `cd ${CLAUDE_PLUGIN_ROOT}/skills/ops-jdi/plugin && python3 -I -m unittest discover -s . -p 'test*.py'` |

Uninstall is not a full rollback: retained files and runtime remain. Rollback restores the previous managed source of an existing installation, not a complete historical filesystem or runtime snapshot. A first-install backup has no previous source tree and cannot be used with `rollback`.

`maintain` and `audit` are slash commands of the installed plugin (`/just-do-it maintain`, `/just-do-it audit`); tell the user to run them in their own session.

## Rules

1. Ask before `install`/`update`/`uninstall`/`rollback`: they change the user's installed plugins. Updates apply at the next session start or `/reload-plugins`.
2. Never run `plugin/smoke.py`: it is a paid live test. Only with an explicit budget the user names.
3. Never edit `plugin/` and the installed copy in parallel; update the repo copy, then run `install.sh update`.
4. Never weaken an acceptance gate or touch security policy to get green.
