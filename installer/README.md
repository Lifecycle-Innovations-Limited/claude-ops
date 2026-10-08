# claude-ops-installer

Install, update, and verify the [claude-ops](https://github.com/Lifecycle-Innovations-Limited/claude-ops) plugin across Claude Code, Codex, Gemini CLI, OpenClaw, Hermes, and OpenCode from one command.

```bash
git clone https://github.com/Lifecycle-Innovations-Limited/claude-ops.git
cd claude-ops/installer
npm install
node bin/claude-ops-installer.mjs install
```

## Check first: is every CLI on the same skills? (read-only)

On a machine that already has OPS installed, this answers in one command whether
Claude Code, Codex, Grok, Cursor and Hermes load byte-identical OPS skills. It
writes, fetches and locks nothing.

```bash
node bin/claude-ops-installer.mjs check --source claude-installed
```

`--source claude-installed` uses the release Claude Code has installed as the
reference. To compare against a tagged release instead, fetch it into the
installer cache first (the only step that downloads), then check:

```bash
node bin/claude-ops-installer.mjs fetch --ref v3.10.28
node bin/claude-ops-installer.mjs check --ref v3.10.28
```

`check --source <dir>` needs no npm dependencies. The other subcommands need
`npm install`; without it they stop with an environment error (exit 5), not a
drift or auth error. Statuses, every exit code and the fix for each case are in
the plugin's `docs/skill-parity.md`.

## What it does

Reads the canonical source (`Lifecycle-Innovations-Limited/claude-ops` at a pinned ref) and mirrors skills + scripts + binstubs into each detected agent's expected layout. One central config governs all agents. Re-run any time to refresh after an upstream release.

## Supported agents (day-1)

| Agent       | Strategy                                  | Default path                                           |
| ----------- | ----------------------------------------- | ------------------------------------------------------ |
| Claude Code | Marketplace install (or symlink fallback) | `~/.claude/plugins/cache/ops-marketplace/ops/current/` |
| Codex       | Flat `ln -s`                              | `~/.codex/skills`                                      |
| Gemini CLI  | Flat `ln -s`                              | `~/.gemini/skills`                                     |
| OpenClaw    | Flat `ln -s`                              | `~/.openclaw/skills`                                   |
| Hermes      | Hybrid skills + native plugin             | `~/.hermes/skills` and `~/.hermes/plugins/ops`         |
| OpenCode    | Flat `ln -s`                              | `~/.config/opencode/skills`                            |

Binstubs from upstream `bin/` are symlinked into `~/bin/` (or `$CLAUDE_OPS_BIN_DIR`).

## Subcommands

```
claude-ops-installer check        [--source <dir>|claude-installed] [--ref <ref>] [--host a,b] [--require a,b] [--paths] [--json]
claude-ops-installer fetch        [--ref <ref>]
claude-ops-installer install      [--ref <ref>] [--agents a,b,c] [--dry-run] [--force]
claude-ops-installer update       [--ref <ref>] [--agents a,b,c]
claude-ops-installer verify       [--agents a,b,c]
claude-ops-installer doctor       [--agents a,b,c]
claude-ops-installer uninstall    [--agents a,b,c]
claude-ops-installer agents
claude-ops-installer --help
```

| Flag             | Effect                                                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--ref <ref>`    | Git ref: tag, branch, or sha. Default from config.                                                                                                          |
| `--agents a,b,c` | Limit which agents get touched. Default: all enabled.                                                                                                       |
| `--dry-run`      | Print the planned actions, change nothing.                                                                                                                  |
| `--force`        | Kept for compatibility. A real file/dir at a target is never deleted: it is reported as `OWNERSHIP_CONFLICT`. The installer only replaces symlinks it owns. |
| `--source <dir>` | `check` only: reference plugin root, or `claude-installed`.                                                                                                 |
| `--host a,b`     | `check` only: diagnostic selection. Required hosts left out report `NOT_CHECKED`.                                                                           |
| `--require a,b`  | `check` only: required hosts. Default: `required` in `~/.config/claude-ops/parity.json`, else none.                                                         |
| `--offline`      | `check` only: skip the read-only `git ls-remote` that reports a stale cache.                                                                                |

`verify`, `doctor` and `check` never fetch or create the cache. `install`,
`update` and `fetch` are the only subcommands that download, and they key the
cache by the resolved commit SHA, so a cache for a moving ref is reported as
`STALE_SOURCE` instead of passing silently. A failed fetch keeps the existing
cache and names the error class. One writer per target root: a second run gets
`LOCKED` (exit 6).
| `--json` | Emit machine-readable JSON instead of human text. |

## Central config

Default path: `~/.config/claude-ops-installer/config.yaml` (XDG). Falls back to `~/.claude-ops-installer.yaml`.

```yaml
version: 1

source:
  type: git
  url: https://github.com/Lifecycle-Innovations-Limited/claude-ops.git
  ref: v3.10.29

agents:
  claude: { enabled: true }
  codex: { enabled: true, path: ~/.codex/skills }
  gemini: { enabled: true, path: ~/.gemini/skills }
  openclaw: { enabled: true, path: ~/.openclaw/skills }
  hermes:
    {
      enabled: true,
      flat: ~/.hermes/skills,
      nested: ~/.hermes/skills/ops,
      plugin: ~/.hermes/plugins/ops,
    }
  opencode: { enabled: false, path: ~/.config/opencode/skills }

bin:
  path: ~/bin
  strategy: symlink # or copy
```

Override per call: `--agents codex,hermes` ignores the config's `enabled` flag for this invocation.

## Public-repo rule (the operator 2026-07-21)

This package ships in a public repo (`Lifecycle-Innovations-Limited/claude-ops`). It MUST NOT contain:

- Real names, emails, phone numbers, or usernames (use `<owner@example.com>`)
- Real store URLs, project names, or org names (use `<yourstore.myshopify.com>`, `<my-project>`)
- API keys, tokens, secrets, session strings, or chat IDs
- Real GitHub org or repo slugs in examples
- Hardcoded paths like `/Users/<name>/...` (use `~` or `$HOME`)

All user-specific data lives in the central config file, which is gitignored by convention. CI runs `tests/test-no-secrets.sh` to verify before merge.

## Exit codes

One table for the installer, `sync-companion-clis.sh` and the parity check
(`claude-ops/lib/parity/status.json`; a test fails if this table drifts from it):

| Code | Class         | Meaning                                                                                        |
| ---- | ------------- | ---------------------------------------------------------------------------------------------- |
| 0    | `clean`       | Everything matched or applied and verified                                                     |
| 1    | `drift`       | Bytes differ, or a target points at a developer checkout                                       |
| 2    | `gap`         | A required target or the reference is missing, stale or unverifiable                           |
| 3    | `partial`     | Some targets applied, others failed or were refused; the failed ones kept their previous state |
| 4    | `usage`       | Bad arguments, or no agents enabled                                                            |
| 5    | `environment` | Missing dependency, invalid config, unexpected runtime error                                   |
| 6    | `locked`      | Another OPS run holds the target lock                                                          |

Earlier versions documented 2 = fetch failed and 3 = config invalid; neither
was ever returned (both failures exited 1). 4 for "no agents enabled" is
unchanged.

## License

MIT — see `../LICENSE`.
