# Contributing to Claude Ops Marketplace

Thanks for your interest in contributing!

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/<your-username>/claude-ops.git`
3. Create a feature branch (see branch naming below)
4. Make your changes, commit, and push
5. Open a pull request against `dev`

## Branch Naming

| Prefix | Use |
|--------|-----|
| `feat/` | New features or integrations |
| `fix/` | Bug fixes |
| `docs/` | Documentation only changes |

Examples: `feat/stripe-integration`, `fix/auth-token-refresh`, `docs/setup-guide`

## Pull Request Process

1. Target the `dev` branch (never `main` directly)
2. Fill out the PR template completely
3. Ensure all CI checks pass
4. Request a review from a maintainer
5. Address feedback promptly — stale PRs may be closed

## Code Style

- TypeScript: follow existing ESLint/Prettier config (`npm run lint`)
- Shell scripts: `shellcheck`-clean
- Python: `ruff` for linting, `black` for formatting
- No placeholder comments or TODOs — ship complete code only
- Keep changes surgical; avoid scope creep

## Testing

- Add or update unit tests for any logic you change
- Run the test suite before opening a PR:
  ```bash
  npm run type-check && npm run lint && npm run test
  ```
- Integration tests must not mock external services

## Reporting Issues

Use the issue templates in `.github/ISSUE_TEMPLATE/`. Include as much context as possible — vague reports are hard to act on.

## License

By contributing, you agree your contributions will be licensed under the project's existing license.
