<div align="center">

# claude-ops

**Business Operating System plugin for Claude Code**

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-Plugin-blueviolet.svg)

</div>

`claude-ops` helps teams run engineering and operations workflows from inside Claude Code with reusable skills, agents, hooks, and integrations.

---

## Why this repository exists

This repository is the marketplace source for the `ops` plugin and companion tooling. It is designed to support:

- Daily operational command surfaces (briefings, inbox, deploy, incidents, projects)
- Automated engineering workflows (triage, merge, fix, orchestration)
- Integration-first operations across common SaaS and infrastructure tools
- Repeatable plugin development and release management

For release-by-release details, see [`/claude-ops/CHANGELOG.md`](/claude-ops/CHANGELOG.md).

---

## Repository layout

- `/claude-ops` — main plugin project (skills, agents, hooks, docs, scripts)
- `/installer` — multi-CLI installer package
- `/desktop-act` — companion plugin and CLI tooling

> The plugin project root is `/claude-ops` (one level below this repo root).

---

## Quick start (marketplace install)

Inside Claude Code:

```bash
/plugin marketplace add Lifecycle-Innovations-Limited/claude-ops
/plugin install ops@ops-marketplace
/ops:setup
```

---

## Local development

From this repository root:

```bash
claude --plugin-dir ./claude-ops
```

From the plugin project root (`/home/runner/work/claude-ops/claude-ops/claude-ops`):

```bash
npm ci
npm run lint
npm test
```

Notes:

- Node 18+ is required (CI uses Node 20).
- `node_modules/` is intentionally committed in the plugin project.
- Some daemon/runtime behaviors are macOS-specific, but skills/tests run on Linux.

---

## Best practices for contributors

- Keep changes focused and incremental.
- Prefer existing abstractions over new one-off scripts.
- Run lint and tests before opening or updating PRs.
- Do not commit credentials, tokens, or private data.
- Update docs alongside behavior changes.

---

## Documentation

- Main docs index: [`/claude-ops/docs/INDEX.md`](/claude-ops/docs/INDEX.md)
- Rules and conventions: [`/claude-ops/skills/ops-rules/SKILL.md`](/claude-ops/skills/ops-rules/SKILL.md)
- Installer usage: [`/installer/README.md`](/installer/README.md)

---

## Security and disclosure

If you discover a security issue, please report it privately via GitHub Security Advisories rather than opening a public issue.

---

## License

MIT — see [`LICENSE`](/LICENSE).
