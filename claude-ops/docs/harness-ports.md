# Harness ports (Claude, Grok, Hermes)

One skill tree. Three harnesses. Versions stay in lockstep.

| Harness | Loads | Skills |
|---|---|---|
| Claude Code | `.claude-plugin/` | `claude-ops/skills/` |
| Grok | the Claude plugin as-is (no `.grok-plugin`) | same `skills/` |
| Hermes | `hermes-plugin/` as `~/.hermes/plugins/ops` | same `skills/` |

`ops-release` bumps all of these together: `plugin.json`, marketplace registry, `package.json`, `hermes-plugin/plugin.yaml`, installer `source.ref`.

When a Claude-only primitive is missing (`AskUserQuestion`, `Workflow`, `TeamCreate`), use Rule 10: numbered options, `delegate_task` / sequential work, never `gh --admin`. Table: `hermes-plugin/RUNTIME.md`.

Plugin `.mcp.json` is empty on purpose. MCP servers start on demand (`/ops:setup`, host `~/.claude.json`, `mcp-toggle`), not once per Claude session.
