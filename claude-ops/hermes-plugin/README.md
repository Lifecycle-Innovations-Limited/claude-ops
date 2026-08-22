# Hermes plugin (ops)

Native Hermes package for the claude-ops skill tree. One skill tree, three harnesses:

| Harness | Loads | Skills |
|---|---|---|
| Claude Code | `.claude-plugin/` | `../skills/` |
| Grok | Claude plugin as-is (no `.grok-plugin`) | same `../skills/` |
| Hermes | this directory | same `../skills/` |

Versions stay in lockstep with `../.claude-plugin/plugin.json`. Do not fork skills here.

## Install

```bash
ln -sfn /path/to/claude-ops/hermes-plugin ~/.hermes/plugins/ops
```

`claude-ops-installer install` does that symlink when Hermes is enabled.

Then enable it:

```yaml
# ~/.hermes/config.yaml
plugins:
  enabled:
    - ops
```

Restart the gateway / CLI. Slash commands (`/ops-inbox`, `/ops-go`, `/ops`)
and `skill_view("ops:ops-inbox")` become available.

## Layout

| Path | Role |
|---|---|
| `plugin.yaml` | Hermes manifest (`name: ops`) |
| `__init__.py` | Registers skills + slash commands |
| `RUNTIME.md` | Claude Code → Hermes primitive map |
| `../skills/` | Canonical SKILL.md tree (unchanged) |

Do not fork skills into this folder. Edit `../skills/` so Claude Code, Grok,
and Hermes stay on one source.
