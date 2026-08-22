# claude-ops

## Business Operating System plugin for Claude Code

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-Plugin-blueviolet.svg)

## 1) A Character (You) Wants Something

You want one place to run engineering and operations workflows without
jumping across tools, tabs, and dashboards.

## 2) But Has a Problem

Most teams lose momentum to context switching, unclear priorities, and
fragmented systems:

- Status lives in different tools
- Operational checks are manual and easy to miss
- Collaboration slows down when context is scattered

## 3) Meets a Guide (claude-ops)

`claude-ops` is the marketplace source for the `ops` plugin and companion
tooling. It helps you run daily ops from inside Claude Code using reusable
skills, agents, hooks, and integrations.

## 4) Who Gives Them a Plan

### Quick start (marketplace install)

Inside Claude Code:

```bash
/plugin marketplace add Lifecycle-Innovations-Limited/claude-ops
/plugin install ops@ops-marketplace
/ops:setup
```

### Local development plan

From this repository root:

```bash
claude --plugin-dir ./claude-ops
```

From the plugin project root
(`/home/runner/work/claude-ops/claude-ops/claude-ops`):

```bash
npm ci
npm run lint
npm test
```

## 5) And Calls Them to Action

- **Install now:** use the quick-start commands above
- **Contribute safely:** open focused PRs with docs and validation
- **Learn fast:** start in the documentation index below

## 6) That Helps Them Avoid Failure

Without an operational system, teams keep paying the tax of fragmented
execution: slower handoffs, missed checks, and inconsistent delivery quality.

## 7) And Ends in Success

With `claude-ops`, teams get a repeatable operating layer in Claude Code for
daily visibility, safer automation, and faster execution.

---

## Repository layout

- `/claude-ops` — main plugin project (skills, agents, hooks, docs, scripts)
- `/installer` — multi-CLI installer package
- `/desktop-act` — companion plugin and CLI tooling

The plugin project root is `/claude-ops` (one level below this repo root).

---

## Contributor best practices

- Keep changes focused and incremental.
- Prefer existing abstractions over one-off scripts.
- Run lint and tests before opening or updating PRs.
- Do not commit credentials, tokens, or private data.
- Update docs when behavior changes.

---

## Documentation

- Main docs index: [`/claude-ops/docs/INDEX.md`](/claude-ops/docs/INDEX.md)
- Rules and conventions:
  [`/claude-ops/skills/ops-rules/SKILL.md`](/claude-ops/skills/ops-rules/SKILL.md)
- Installer usage: [`/installer/README.md`](/installer/README.md)
- Release notes: [`/claude-ops/CHANGELOG.md`](/claude-ops/CHANGELOG.md)

---

## Security and disclosure

If you discover a security issue, report it privately via GitHub Security
Advisories rather than opening a public issue.

---

## License

MIT — see [`LICENSE`](/LICENSE).
