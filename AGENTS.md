# AGENTS.md

## Cursor Cloud specific instructions

claude-ops — a Claude Code plugin ("Business Operating System": skills, agents, hooks, daemons). Not a web app; there is no HTTP dev server. Node 18+ (CI uses 20).

### Layout
The repo root is a Claude Code *marketplace*; the actual plugin lives one level down at `claude-ops/claude-ops/`. Run npm/test/lint commands from there.

### Commands (run from `claude-ops/claude-ops/`)
| Action | Command |
|--------|---------|
| Install | `npm ci` (`node_modules/` is committed intentionally; usually a no-op) |
| Lint | `npm run lint` (Prettier `--check`) |
| Test | `npm test` (runs `tests/run-all.sh` + secret-scan; ~25 checks) |
| Load plugin | from repo root: `claude --plugin-dir ./claude-ops/claude-ops` then `/reload-plugins` |

### Gotchas
- **Public repo** — no PII/secrets in commits; `npm test` includes a secret scanner that must pass.
- Designed for macOS (launchd daemons, Keychain); on Linux the plugin/skills/tests work but some daemons are macOS-only.
