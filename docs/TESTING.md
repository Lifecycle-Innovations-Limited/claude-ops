<!-- generated-by: gsd-doc-writer -->
# Testing

## Test framework and setup

claude-ops uses a custom Bash-based test framework. There is no external test runner dependency — all tests are plain shell scripts executed directly with `bash`. Each script follows a consistent pattern: `ok()` / `err()` helpers accumulate pass/fail counts and the script exits non-zero if any check fails.

Before running tests, install Node dependencies (required by `test-bin-scripts.sh` when `shellcheck` lints `.mjs` files indirectly, and by the CI syntax checks):

```bash
cd claude-ops
npm ci
```

`shellcheck` is used by `test-bin-scripts.sh` when available. Install it with:

```bash
brew install shellcheck   # macOS
apt-get install shellcheck  # Debian/Ubuntu
```

## Running tests

Run the full test suite from the `claude-ops/` directory:

```bash
bash tests/run-all.sh
```

Run a single suite in isolation:

```bash
bash tests/test-skills-lint.sh
bash tests/test-bin-scripts.sh
bash tests/test-hooks.sh
bash tests/test-template.sh
bash tests/test-claude-md.sh
bash tests/test-no-secrets.sh
```

`run-all.sh` executes all six suites in the order listed above, prints per-suite pass/fail, and exits 1 if any suite fails.

## Writing new tests

Test files live in `claude-ops/tests/` and are named `test-<area>.sh`. Each script must:

1. Start with `#!/usr/bin/env bash` and `set -euo pipefail`.
2. Resolve `PLUGIN_ROOT` relative to `$0` so the script is location-independent:
   ```bash
   PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
   ```
3. Use the `ok()` / `err()` helper pattern and exit with code 1 when `$fail > 0`.
4. Be registered in `run-all.sh` via a `run_suite "$TESTS_DIR/test-<area>.sh"` call.

No shared test helper file exists — each script is self-contained.

## Coverage requirements

No line/branch/function coverage thresholds are configured. Coverage is structural: each test suite validates a specific area of the plugin (skills, bin scripts, hooks, templates, CLAUDE.md rules, secrets). A new feature is considered covered when a corresponding `test-<area>.sh` check exists for its key invariants.

## CI integration

**Workflow:** `.github/workflows/ci.yml` — "CI"

**Triggers:** push to `dev`; pull requests targeting `dev` or `main`

**Steps run in CI (in order):**

1. Install Node dependencies: `cd claude-ops && npm ci`
2. Syntax check Node scripts (`node --check`) for `ops-slack-autolink.mjs`, `ops-telegram-autolink.mjs`, and `telegram-server/index.js`
3. Syntax check shell scripts (`bash -n`) for `ops-merge-scan`, `ops-prs`, `ops-ci`, `ops-git`, `ops-infra`, `ops-unread`, `ops-gather`, `ops-setup-detect`, `ops-setup-install`
4. Prettier format check: `npx prettier --check "**/*.{js,mjs,json}"`
5. Secret scanning: gitleaks v8.30.1 using `claude-ops/.gitleaks.toml`

Note: the six `tests/` suite scripts are not currently invoked in CI — they run locally and in the pre-commit hook. The CI job focuses on syntax validity, formatting, and secret detection.

## Pre-commit hook

`.githooks/pre-commit` runs automatically on `git commit`. It:

- Scans the staged diff for secrets and personal data (tokens, API keys, emails, hardcoded paths, phone numbers, IP addresses)
- Invokes `tests/test-no-secrets.sh` against the full working tree

To install the hook:

```bash
git config core.hooksPath .githooks
```

To bypass in an emergency (not recommended for this public repo):

```bash
git commit --no-verify
```
