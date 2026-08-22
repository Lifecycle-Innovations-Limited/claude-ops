# Hermes plugin (ops)

Native Hermes package for the claude-ops skill tree. Claude Code still loads
`.claude-plugin/`. Hermes loads this directory.

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

Do not fork skills into this folder. Edit `../skills/` so Claude Code and
Hermes stay on one source.
