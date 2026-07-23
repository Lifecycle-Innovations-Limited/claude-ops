# claude-ops-installer

Install, update, and verify the [claude-ops](https://github.com/Lifecycle-Innovations-Limited/claude-ops) plugin across Claude Code, Codex, Gemini CLI, OpenClaw, Hermes, and OpenCode from one command.

```
npx claude-ops-installer install
```

## What it does

Reads the canonical source (`Lifecycle-Innovations-Limited/claude-ops` at a pinned ref) and mirrors skills + scripts + binstubs into each detected agent's expected layout. One central config governs all agents. Re-run any time to refresh after an upstream release.

## Supported agents (day-1)

| Agent | Strategy | Default path |
|---|---|---|
| Claude Code | Marketplace install (or symlink fallback) | `~/.claude/plugins/cache/ops-marketplace/ops/current/` |
| Codex | Flat `ln -s` | `~/.codex/skills` |
| Gemini CLI | Flat `ln -s` | `~/.gemini/skills` |
| OpenClaw | Flat `ln -s` | `~/.openclaw/skills` |
| Hermes | Hybrid (flat + nested `ops/<name>`) | `~/.hermes/skills` |
| OpenCode | Flat `ln -s` | `~/.config/opencode/skills` |

Binstubs from upstream `bin/` are symlinked into `~/bin/` (or `$CLAUDE_OPS_BIN_DIR`).

## Subcommands

```
claude-ops-installer install      [--ref <ref>] [--agents a,b,c] [--dry-run] [--force]
claude-ops-installer update       [--ref <ref>] [--agents a,b,c]
claude-ops-installer verify       [--agents a,b,c]
claude-ops-installer doctor       [--agents a,b,c]
claude-ops-installer uninstall    [--agents a,b,c]
claude-ops-installer agents
claude-ops-installer --help
```

| Flag | Effect |
|---|---|
| `--ref <ref>` | Git ref: tag, branch, or sha. Default from config. |
| `--agents a,b,c` | Limit which agents get touched. Default: all enabled. |
| `--dry-run` | Print the planned actions, change nothing. |
| `--force` | Overwrite a real file/dir at the target with a symlink. Refuses by default. |
| `--json` | Emit machine-readable JSON instead of human text. |

## Central config

Default path: `~/.config/claude-ops-installer/config.yaml` (XDG). Falls back to `~/.claude-ops-installer.yaml`.

```yaml
version: 1

source:
  type: git
  url: https://github.com/Lifecycle-Innovations-Limited/claude-ops.git
  ref: v2.43.0

agents:
  claude:    { enabled: true }
  codex:     { enabled: true,  path: ~/.codex/skills }
  gemini:    { enabled: false, path: ~/.gemini/skills }
  openclaw:  { enabled: true,  path: ~/.openclaw/skills }
  hermes:    { enabled: true,  flat: ~/.hermes/skills, nested: ~/.hermes/skills/ops }
  opencode:  { enabled: false, path: ~/.config/opencode/skills }

bin:
  path: ~/bin
  strategy: symlink    # or copy
```

Override per call: `--agents codex,hermes` ignores the config's `enabled` flag for this invocation.

## Public-repo rule (Sam 2026-07-21)

This package ships in a public repo (`Lifecycle-Innovations-Limited/claude-ops`). It MUST NOT contain:

- Real names, emails, phone numbers, or usernames (use `<owner@example.com>`)
- Real store URLs, project names, or org names (use `<yourstore.myshopify.com>`, `<my-project>`)
- API keys, tokens, secrets, session strings, or chat IDs
- Real GitHub org or repo slugs in examples
- Hardcoded paths like `/Users/<name>/...` (use `~` or `$HOME`)

All user-specific data lives in the central config file, which is gitignored by convention. CI runs `tests/test-no-secrets.sh` to verify before merge.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | All actions succeeded |
| 1 | One or more non-fatal errors (verify/doctor found drift, install skipped some targets) |
| 2 | Source could not be fetched |
| 3 | Central config invalid |
| 4 | No agents enabled / no agents detected |

## License

MIT — see `../LICENSE`.