<div align="center">

# Documentation Index

_Top-level map of every doc file in `claude-ops/docs/`._

[![version](https://img.shields.io/badge/version-3.8.0-blue)](../CHANGELOG.md)

</div>

---

## v3.6 — harnesses and skill shape

| Doc | Subject |
|---|---|
| [`harness-ports.md`](harness-ports.md) | Claude / Grok / Hermes: one skill tree, lockstep versions, Rule 10 fallbacks, empty `.mcp.json`. |
| [`../hermes-plugin/RUNTIME.md`](../hermes-plugin/RUNTIME.md) | Claude Code primitive → Hermes/Grok swap table. |
| [`../skills/ops-rules/SKILL.md`](../skills/ops-rules/SKILL.md) | Standing rules 0–10. Plugin-root `CLAUDE.md` is a pointer only. |

## v2.0 — autonomy layer

| Doc                                            | Subject                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`deploy-fix.md`](deploy-fix.md)               | Post-merge + build-failure auto-fix subsystem. Architecture, registry, dedup/budget, troubleshooting. |
| [`agents.md`](agents.md)                       | Pre-installed specialist agents + the auto-suggestion PreToolUse hook.                                |
| [`safety-hooks.md`](safety-hooks.md)           | Three universal PreToolUse:Bash hooks (secret-commit, rm-rf-anchor, mainpush warn).                   |
| [`recap.md`](recap.md)                         | Recap marquee daemon — multi-session digest in tmux/`statusLine`.                                     |
| [`migrating-from-v1.md`](migrating-from-v1.md) | v1.x → v2.0 migration. No breaking changes; opt-out matrix.                                           |

## v1 — operations surface (still current in v2)

| Doc                                                        | Subject                                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`agents-reference.md`](agents-reference.md)               | Catalog of all 21 agents (4 v2 specialists + 14 v1 scanners/fixers/C-suite).                   |
| [`skills-reference.md`](skills-reference.md)               | Catalog of all 64 skills with usage examples.                                                  |
| [`daemon-guide.md`](daemon-guide.md)                       | The v1 ops-daemon (briefing pre-warm, whatsapp-bridge-sync, memory-extractor, etc).            |
| [`docker.md`](docker.md)                                   | Running claude-ops in a container.                                                             |
| [`marketplace-submissions.md`](marketplace-submissions.md) | Publishing your own plugin to the same marketplace.                                            |
| [`memories-system.md`](memories-system.md)                 | The cross-session memory system used by agents.                                                |
| [`notifications.md`](notifications.md)                     | Notification channel setup (macos/ntfy/pushover/discord/telegram).                             |
| [`telegram-bot-send.md`](telegram-bot-send.md)             | Bot-token push to the operator's own Telegram chat + the outbound-hook self-channel exception. |
| [`os-compatibility.md`](os-compatibility.md)               | macOS / Linux / WSL feature matrix.                                                            |

## External

- [Wiki](https://github.com/Lifecycle-Innovations-Limited/claude-ops/wiki) — narrative pages, tutorials, FAQ.
- [`CHANGELOG.md`](../CHANGELOG.md) — release history.
- [`README.md`](../README.md) — plugin overview.
- [`CLAUDE.md`](../CLAUDE.md) — pointer. Rules live in `skills/ops-rules/SKILL.md`.
