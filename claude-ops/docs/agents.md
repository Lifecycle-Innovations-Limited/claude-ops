<div align="center">

# Specialized Agents

*Pre-installed subagent personas + the auto-suggestion hook that routes `general-purpose` calls to the right specialist.*

[![version](https://img.shields.io/badge/version-2.0.9-blue)](../CHANGELOG.md)
[![agents](https://img.shields.io/badge/agents-18-8b5cf6)](.)
[![hook](https://img.shields.io/badge/PreToolUse-Agent-6366f1)](.)

</div>

---

## What changed in v2

In v1.x, every `Agent` tool call defaulted to `subagent_type: general-purpose`, which meant the same broad persona handled SRE work, dependency upgrades, and code review.

v2 ships **four pre-installed specialist agents** and a **PreToolUse hook on `Agent`** that silently swaps `general-purpose` → matching specialist via `updatedInput`. If no match exists, a Haiku drafter proposes a new agent file under `~/.claude/agents/`.

The swap is silent by design — Claude doesn't have to know to pick the right agent; the hook does it.

---

## Pre-installed specialists

| Agent | File | Purpose | Used by |
|-------|------|---------|---------|
| `general-purpose` | [`agents/general-purpose.md`](../agents/general-purpose.md) | Local override of the default — restricted to research and read-only investigation. | Fallback when no specialist matches. |
| `deploy-fixer` | [`agents/deploy-fixer.md`](../agents/deploy-fixer.md) | Single-shot SRE persona — diagnoses one failed deploy, opens one PR, exits. | Deploy auto-fix subsystem ([`docs/deploy-fix.md`](deploy-fix.md)). |
| `build-fixer` | [`agents/build-fixer.md`](../agents/build-fixer.md) | TypeScript/bundler error fixer for local build failures. | Deploy auto-fix subsystem (build-trigger hook). |
| `dependency-auditor` | [`agents/dependency-auditor.md`](../agents/dependency-auditor.md) | Runs `npm audit` / `pip-audit` / SCA equivalents and proposes minimal upgrades. | Manual dispatch + future scheduled cron. |

The full v1 agent roster (scanners, fixers, C-suite analysts, daemon brain) is unchanged — see [`docs/agents-reference.md`](agents-reference.md).

---

## How the auto-suggestion hook works

```
Claude calls Task with subagent_type=general-purpose
                    │
                    ▼
hooks/hooks.json PreToolUse:Agent
                    │
                    ▼
bin/ops-suggest-specialized-agent
                    │
       ┌────────────┴────────────┐
       ▼                         ▼
  prompt matches              no match
  config/specialist-          ┌────────────────────┐
  keywords.example.json       │ fire Haiku drafter │
       │                      │ → propose new      │
       ▼                      │ agent file under   │
  rewrite updatedInput        │ ~/.claude/agents/  │
  with subagent_type =        └────────────────────┘
  matched specialist
       │
       ▼
  Claude tool call proceeds with the swapped type
```

The swap uses the standard Claude Code `updatedInput` PreToolUse mechanism — no warning, no prompt, no UI noise. The user only notices when they look at the agent transcript and see `deploy-fixer` instead of `general-purpose`.

---

## Keyword map

The default map ships at [`config/specialist-keywords.example.json`](../config/specialist-keywords.example.json):

```json
{
  "deploy-fixer": ["deploy", "deployment", "ECS", "Vercel", "Render", "GitHub Actions", "workflow failed", "rollback"],
  "build-fixer": ["npm run build", "tsc", "TypeScript error", "webpack", "vite", "esbuild", "module not found"],
  "dependency-auditor": ["npm audit", "vulnerable", "CVE", "security advisory", "outdated dependency", "pip-audit"]
}
```

Each value is an array of substrings (case-insensitive). The hook scans the `prompt` field of the `Agent` input. First match wins.

To extend: copy the file to `~/.claude/config/specialist-keywords.json` and add your own. User file overrides the plugin default.

---

## Adding your own specialist

1. Drop a `<name>.md` file under `~/.claude/agents/` (user-scoped) or `agents/` (committed to your project's `.claude/`).
2. Frontmatter must include `name`, `description`, `model`, `tools` (allow-list).
3. Add an entry to your `~/.claude/config/specialist-keywords.json` mapping keywords → agent name.
4. Verify with `/ops:deploy-fix test` (which exercises the keyword path) or by manually invoking `Task` with a matching prompt.

Minimal example:

```markdown
---
name: my-rust-fixer
description: Diagnoses and fixes Rust compile errors
model: claude-haiku-4-5
tools: [Bash, Read, Edit, Write]
---

You are a focused Rust compile-error fixer. ...
```

```json
{
  "my-rust-fixer": ["cargo build", "cargo check", "rustc error", "borrow checker"]
}
```

---

## Configuration

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `suggest_specialized_agents` | boolean | `true` | Master switch for the PreToolUse:Agent hook. |

Set to `false` in `/plugins` settings to restore v1 behavior (every `general-purpose` call passes through unchanged).

---

## See also

- [`docs/agents-reference.md`](agents-reference.md) — complete v1+v2 agent catalog.
- [`docs/deploy-fix.md`](deploy-fix.md) — primary consumer of `deploy-fixer` and `build-fixer`.
- [`docs/INDEX.md`](INDEX.md) — full documentation index.
