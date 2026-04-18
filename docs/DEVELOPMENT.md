<!-- generated-by: gsd-doc-writer -->
# Development Guide

This guide covers everything you need to contribute to claude-ops — from understanding the nested directory layout to adding new skills, agents, and bin scripts.

---

## Local Setup

```bash
git clone https://github.com/Lifecycle-Innovations-Limited/claude-ops.git
cd claude-ops

# Load the plugin directly from the local checkout
claude --plugin-dir ./claude-ops/claude-ops
```

After making any change to a skill, agent, hook, or CLAUDE.md, reload without restarting Claude Code:

```bash
/reload-plugins
```

No additional install step is required for the plugin itself. The `claude-ops/node_modules/` directory (used by the `.mjs` autolink scripts) is committed, so no `npm install` is needed unless you are adding new bin-script dependencies.

---

## Repo Structure

The repository uses a two-level layout required by the Claude Code plugin marketplace:

```
claude-ops/                          ← marketplace root (the GitHub repo)
├── .claude-plugin/
│   └── marketplace.json             # points "source" to ./claude-ops
├── README.md
├── CONTRIBUTING.md
├── LICENSE
├── SECURITY.md
│
└── claude-ops/                      ← plugin root (Claude Code loads from here)
    ├── .claude-plugin/plugin.json   # plugin manifest (name, version, userConfig)
    ├── CLAUDE.md                    # 6 non-negotiable plugin rules (Rule 0–5)
    ├── skills/                      # 30 slash commands — one subdirectory per skill
    ├── agents/                      # 14 autonomous agents (Opus/Sonnet/Haiku)
    ├── bin/                         # ops-* shell scripts called by skills
    ├── hooks/
    │   └── hooks.json               # SessionStart / PreToolUse / Stop hooks
    ├── scripts/                     # daemon plists, cron scripts, registry.json
    ├── telegram-server/             # bundled MTProto MCP server (gram.js)
    ├── templates/                   # Shopify Admin scaffolding
    ├── tests/                       # bash validation suites
    ├── output-styles/               # reusable output format templates
    ├── node_modules/                # runtime deps for .mjs autolink scripts
    └── package.json                 # claude-ops-bin v0.2.2
```

**Why the nested `claude-ops/claude-ops/` layout?** Claude Code's marketplace resolves the plugin root from the `"source"` field in `marketplace.json`. The outer directory is the marketplace container; the inner directory is what Claude Code actually loads. This cannot be flattened — the marketplace system requires exactly this two-level structure.

---

## Adding a Skill

Each skill is a subdirectory under `claude-ops/claude-ops/skills/` containing a single `SKILL.md` file.

```
skills/
└── ops-myfeature/
    └── SKILL.md
```

`SKILL.md` format (YAML frontmatter + markdown body):

```markdown
---
name: ops-myfeature
description: One-sentence description shown in the skills list.
argument-hint: "[optional-arg]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - AskUserQuestion
effort: low          # low | medium | high
maxTurns: 20
---

# OPS ► MY FEATURE

Skill body — instructions Claude follows when this slash command is invoked.
```

**Key frontmatter fields:**

| Field | Required | Notes |
|---|---|---|
| `name` | Yes | Must match the directory name exactly |
| `description` | Yes | Shown in `/ops` dashboard |
| `allowed-tools` | Yes | Allowlist of Claude tools the skill can use |
| `effort` | No | `low` / `medium` / `high` — controls token budget hint |
| `maxTurns` | No | Hard turn limit for the skill |
| `argument-hint` | No | Displayed after the slash command in autocomplete |

After adding a skill, run `/reload-plugins` and verify it appears in `/ops`.

---

## Adding an Agent

Agents live under `claude-ops/claude-ops/agents/` as individual `.md` files:

```
agents/
└── my-agent.md
```

Agent `.md` format:

```markdown
---
name: my-agent
description: What this agent does and when it is invoked.
model: claude-sonnet-4-6      # claude-opus-4-6 | claude-sonnet-4-6 | claude-haiku-4-5
effort: medium
maxTurns: 25
tools:
  - Bash
  - Read
  - Grep
disallowedTools:
  - Write
  - Edit
  - Agent
memory: project               # project | user | none
---

# MY AGENT

Agent instructions here.
```

**Model selection convention:**
- `claude-opus-4-6` — C-suite agents (`yolo-ceo`, `yolo-cfo`, `yolo-coo`, `yolo-cto`)
- `claude-sonnet-4-6` — Scanner, monitor, and fix agents
- `claude-haiku-4-5` — High-frequency lightweight agents (memory extraction)

Agents are invoked from skills via the `Agent` tool. They never call other agents (note `Agent` in `disallowedTools` for most agents — this prevents recursive spawning).

---

## Adding a Bin Script

Bin scripts live under `claude-ops/claude-ops/bin/` and are called directly by skills via the `Bash` tool or from `hooks.json`.

**Naming convention:** all scripts use the `ops-` prefix (e.g., `ops-gather`, `ops-prs`, `ops-infra`).

**Standard structure:**

```bash
#!/usr/bin/env bash
# ops-myscript — Short description of what this script does
# Usage: ops-myscript [--json] [args...]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ... implementation ...

# Output: emit JSON to stdout
jq -n --arg key "value" '{"key": $key}'
```

**`--json` convention:** scripts that can be called in two modes (human-readable summary vs. machine-readable data) accept a `--json` flag. When present, output is pure JSON consumed by `ops-gather` or skills. Without the flag, output is formatted for direct terminal display.

`ops-gather` runs all data-collecting scripts in parallel and merges their JSON output into a single payload:

```bash
"$SCRIPT_DIR/ops-git"   > "$TMPDIR_OPS/git.json"   2>/dev/null &
"$SCRIPT_DIR/ops-infra" > "$TMPDIR_OPS/infra.json"  2>/dev/null &
"$SCRIPT_DIR/ops-prs"   > "$TMPDIR_OPS/prs.json"    2>/dev/null &
wait
```

New data-gathering scripts should be added to `ops-gather` so they are included in pre-warm briefing data.

---

## Hooks

Hooks are declared in `claude-ops/claude-ops/hooks/hooks.json`. Three event types are supported:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ${CLAUDE_PLUGIN_ROOT}/bin/ops-welcome 2>/dev/null || true"
          },
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh 2>/dev/null | grep '✗' | head -3 || true"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash ${CLAUDE_PLUGIN_ROOT}/bin/ops-pretool-wacli-health \"$TOOL_INPUT\" 2>/dev/null || true"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ${CLAUDE_PLUGIN_ROOT}/bin/ops-post-session-cleanup 2>/dev/null || true"
          }
        ]
      }
    ]
  }
}
```

| Event | Matcher | Current use |
|---|---|---|
| `SessionStart` | (all) | Run `ops-welcome` banner + surface any setup health failures |
| `PreToolUse` | `Bash` | Check wacli health before any Bash call |
| `Stop` | (all) | Post-session cleanup |

Hook commands must always exit `0` (note the `|| true` suffix). A failing hook causes Claude Code to surface an error — never let hooks fail loudly.

The `$CLAUDE_PLUGIN_ROOT` environment variable is injected by Claude Code at runtime and resolves to the `claude-ops/claude-ops/` directory.

---

## CLAUDE.md Rules

`claude-ops/claude-ops/CLAUDE.md` defines six rules that apply to every skill and agent. They cannot be overridden by individual skill instructions.

| Rule | Name | Summary |
|---|---|---|
| Rule 0 | PUBLIC REPO — No personal data ever | Never commit real names, emails, tokens, org names, store URLs, or hardcoded paths. Use placeholders (`owner`, `user@example.com`, `<YOUR_TOKEN>`). Run `tests/test-no-secrets.sh` before every commit. |
| Rule 1 | Max 4 options per AskUserQuestion | The `AskUserQuestion` tool enforces a hard limit of `<=4` items. Paginate larger lists at 4 per page using `[More options...]` as a bridge. |
| Rule 2 | Never delegate commands to the user | Run all commands via the `Bash` tool. Use `run_in_background: true` for OAuth flows and long-running installs. The only exception is QR-based auth (`wacli auth`). |
| Rule 3 | Never auto-skip channels or integrations | If auto-scan returns empty for a credential, always present an explicit `AskUserQuestion` with `[Paste manually]`, `[Deep hunt]`, `[Skip]`. Never silently skip. |
| Rule 4 | Background by default during setup | Use `run_in_background: true` on every Bash call in setup flows unless the result is immediately needed for the next decision. |
| Rule 5 | Destructive actions require per-action confirmation | Never execute `delete-*`, `stop-*`, `terminate-*`, force-push, or any infrastructure destruction without an explicit `AskUserQuestion` confirmation per action. |

When writing a new skill or agent, verify each of these rules applies correctly before submitting a PR.

---

## Build Commands

The plugin has no compilation step — all skills and agents are plain markdown. The `package.json` at `claude-ops/claude-ops/package.json` manages runtime dependencies for the `.mjs` autolink scripts only.

| Command | What it does |
|---|---|
| `bash tests/run-all.sh` | Run all six test suites and report pass/fail |
| `bash tests/test-no-secrets.sh` | Scan for leaked secrets, tokens, or personal data |
| `bash tests/test-skills-lint.sh` | Lint all SKILL.md files for required frontmatter fields |
| `bash tests/test-bin-scripts.sh` | Validate bin scripts are executable and have correct shebangs |
| `bash tests/test-hooks.sh` | Validate hooks.json structure |
| `bash tests/test-claude-md.sh` | Verify CLAUDE.md contains all required rules |
| `bash tests/test-template.sh` | Validate Shopify scaffolding template |

All commands run from the `claude-ops/claude-ops/` directory.

---

## Pre-commit Checklist

There is no automated pre-commit hook wired to git. Before every commit, run these manually:

```bash
cd claude-ops/claude-ops

# Required — scan for secrets and personal data
bash tests/test-no-secrets.sh

# Recommended — run the full suite
bash tests/run-all.sh
```

If `test-no-secrets.sh` fails, the commit must not proceed. This is enforced by Rule 0 in CLAUDE.md.

---

## Coding Conventions

**Shell scripts (`bin/`):**
- Always start with `#!/usr/bin/env bash` and `set -euo pipefail`
- Include a one-line comment after the shebang: `# ops-scriptname — what it does`
- Emit JSON to stdout; emit errors to stderr (`2>/dev/null` at the call site silences them)
- Scripts must be idempotent — calling them multiple times must not cause side effects
- Never hardcode paths; use `$HOME`, `~`, `$CLAUDE_PLUGIN_ROOT`, or `$CLAUDE_PLUGIN_DATA_DIR`

**Skills (`skills/`):**
- One skill per directory; one `SKILL.md` per skill directory
- Frontmatter `name` must match directory name exactly
- Never include personal data, real org names, store URLs, or tokens in examples (Rule 0)
- Use pre-execution shell blocks (`!` fences) to gather data before model context loads — this is the primary token-saving pattern used across all 30 skills

**Agents (`agents/`):**
- Agents are read-only by default — add `Write` and `Edit` to `disallowedTools` unless the agent genuinely needs to write files
- C-suite agents run on `claude-opus-4-6`; scanner and fix agents run on `claude-sonnet-4-6`
- Agents must not call other agents (`Agent` in `disallowedTools`) to prevent recursive spawning

**Secrets and credentials:**
- Never committed to the repo
- Stored in `$PREFS_PATH` (preferences.json, gitignored), `scripts/registry.json` (gitignored), Claude Code's encrypted `userConfig` (`~/.claude.json`), or the credential resolution chain: Doppler → 1Password/Dashlane/Bitwarden → macOS Keychain → env vars

---

## Branch Conventions

- `main` is the only long-lived branch
- Feature branches: `feat/description` or `fix/description`
- All changes go through a PR targeting `main`
- No direct pushes to `main` (enforced at repo and org level)
- Merge via `gh pr merge --merge --admin` (maintainers); external contributors require 1 approval

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full PR workflow.
