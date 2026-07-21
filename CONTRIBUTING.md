# Contributing to claude-ops

PRs welcome from anyone. This document covers the branch strategy, protection rules, and PR workflow.

## Branch Strategy

- **`main`** is the only long-lived branch and the default branch.
- All work happens on **feature branches** (e.g., `fix/setup-gog-url`, `feat/stripe-revenue`).
- Feature branches are merged into `main` via PR.
- There is no `dev` branch.

## Branch Protection

`main` is protected by three layers of rulesets (repo-level + org-level):

| Rule                      | Maintainer | External contributors |
| ------------------------- | ---------- | --------------------- |
| Direct push               | Allowed    | Blocked               |
| Force push                | Blocked    | Blocked               |
| Delete branch             | Blocked    | Blocked               |
| Merge PR without approval | Allowed    | Requires 1 approval   |
| Unresolved review threads | Allowed    | Blocked               |

These rules are enforced at both the repository and organization level and cannot be overridden by repository settings alone.

## PR Workflow

### For external contributors

1. Fork the repo
2. Create a feature branch from `main`
3. Make your changes
4. Open a PR targeting `main`
5. Wait for review and approval from a maintainer
6. Once approved, a maintainer will merge your PR

### For maintainers

1. Create a feature branch from `main`
2. Push the branch and open a PR targeting `main`
3. Resolve any automated review comments (Copilot code review runs on push)
4. Merge via `gh pr merge --merge --admin`

## Local Development

```bash
# Clone and run in development mode
git clone https://github.com/Lifecycle-Innovations-Limited/claude-ops.git
cd claude-ops
claude --plugin-dir ./claude-ops/claude-ops

# After making changes, reload without restarting
/reload-plugins
```

## Code Review

- Copilot code review runs automatically on every push and may leave review threads.
- All review threads must be resolved before merge (for non-maintainers).
- Maintainers can resolve threads and merge without external approval.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./claude-ops/LICENSE).

## Adding a new agent adapter (installer)

The `installer/` package ships per-agent adapters so a single `npx claude-ops-installer install` works across CLIs. To add support for a new CLI:

1. Add an entry to `installer/src/detect.mjs` `AGENT_DEFS` with the CLI binary name + the expected skill path.
2. Add the same agent to `installer/src/config.mjs` `DEFAULT_CONFIG.agents` (default off; let the operator opt in).
3. Smoke-test: `cd installer && npm test` — the smoke test reads the source layout, plans, and applies; it covers all agent paths through the same code, so a new agent passes automatically as long as `AGENT_DEFS` and the config are consistent.
4. Update `installer/README.md` with the new agent in the "Supported agents" table.
5. Update `CHANGELOG.md` under `## Unreleased` → `### Added`.

The adapter is pure: it does not need an `agents/<name>.mjs` file unless the new CLI needs a non-flat layout. If it does, see `installer/src/dispatch.mjs` `pickAgents` and add the per-agent branch.
