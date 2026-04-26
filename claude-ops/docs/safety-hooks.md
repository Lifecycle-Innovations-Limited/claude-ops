<div align="center">

# Universal Safety Hooks

*Three PreToolUse:Bash hooks that block the most common foot-guns: secrets in commits, `rm -rf` against anchor paths, and direct `git push` to `main`.*

[![version](https://img.shields.io/badge/version-2.0.0-blue)](../CHANGELOG.md)
[![hook](https://img.shields.io/badge/PreToolUse-Bash-6366f1)](.)
[![always-on](https://img.shields.io/badge/always--on-by%20design-ef4444)](.)

</div>

---

## Why these are not gated by userConfig

The other v2 subsystems (deploy-fix, recap, rotator, task-reminder) are toggleable from `/plugins` settings because they're additive convenience layers. The three safety hooks are different — they prevent **irrecoverable damage** (committed secrets, deleted home directories, broken main branches). They're always-on by design, with a per-incident escape via Claude Code's standard `permissionDecision` flow.

If you genuinely need to disable one, comment out the entry in `hooks/hooks.json`. There is no shame in this — but make it a deliberate choice, not a forgotten toggle.

---

## The three hooks

### 1. `bin/ops-prevent-secret-commit`

**Trigger:** PreToolUse:Bash matching `git commit *`.

**Action:** Scans `git diff --cached` for known secret patterns. On match, returns `permissionDecision: deny` with an explanation listing the matched pattern + offending file.

**Patterns detected:**

| Pattern | Match |
|---------|-------|
| AWS access key | `AKIA[0-9A-Z]{16}` |
| AWS secret key | `aws_secret_access_key\s*=\s*["']?[A-Za-z0-9/+=]{40}` |
| GitHub PAT | `ghp_[A-Za-z0-9]{36}` / `github_pat_[A-Za-z0-9_]{82}` |
| Slack token | `xox[baprs]-[A-Za-z0-9-]{10,}` |
| OpenAI API key | `sk-(proj-)?[A-Za-z0-9]{20,}` |
| Anthropic API key | `sk-ant-[A-Za-z0-9_-]{20,}` |
| Stripe live key | `sk_live_[A-Za-z0-9]{24,}` |
| `.env` content | any staged `.env*` file (excluding `.env.example`, `.env.template`) |
| Generic high-entropy string | any 32+ char base64-ish run with `KEY` / `TOKEN` / `SECRET` in the variable name |

**Override:** un-stage the offending file (`git restore --staged <path>`), or scrub the value. There's no env-var override; this is intentional.

---

### 2. `bin/ops-no-rm-rf-anchor`

**Trigger:** PreToolUse:Bash matching `rm -rf *` (and equivalents: `rm -fr`, `rm -rfv`, etc.).

**Action:** Resolves each target via `realpath`/`readlink -f` (so symlinks don't sneak past). On any of these resolved targets, returns `permissionDecision: deny`:

- `/`
- `$HOME` / `~` (and any path that resolves *to* `$HOME`)
- `..` and `.` (when CWD itself is `$HOME` or `/`)
- Mount points listed in `/etc/fstab` (root-level only)

**Override:** there is none for the listed anchors. If you genuinely need to wipe `~`, do it outside Claude Code.

---

### 3. `bin/ops-warn-mainpush`

**Trigger:** PreToolUse:Bash matching `git push *`.

**Action:** Reads the current branch via `git rev-parse --abbrev-ref HEAD`. If the branch is in the protected list (`main`, `master`, `prod`, `production`, `release`), returns `permissionDecision: ask` (not deny — ask) with the message:

```
About to push directly to <branch>. This bypasses the PR review flow.
Confirm by accepting the prompt; abort by rejecting.
```

**Override:** accept the standard Claude Code permission prompt. No env-var or config override.

This hook intentionally uses `ask` not `deny` because force-push to main is sometimes legitimate (recovering from a broken merge, hotfix, etc.) — but it should never be silent.

---

## How `permissionDecision` works

Claude Code's standard PreToolUse mechanism supports three decisions:

- `allow` — pass through silently.
- `ask` — prompt the user; user accepts → pass through.
- `deny` — block the call, return the explanation to Claude.

The three safety hooks use this mechanism. They never modify the command or rewrite arguments; they only inspect and decide.

---

## Disabling a single hook

Edit [`hooks/hooks.json`](../hooks/hooks.json) and remove the relevant entry under `PreToolUse > Bash`. Reload the plugin (`/plugin reload ops`) for the change to take effect.

To re-enable, copy the entry back from the v2 release notes or the [GitHub source](https://github.com/Lifecycle-Innovations-Limited/claude-ops/blob/main/claude-ops/hooks/hooks.json).

---

## Testing

[`tests/test-safety-hooks.sh`](../tests/test-safety-hooks.sh) covers every hook with positive (should-deny / should-ask) and negative (should-allow) cases. 45/45 pass on macOS + Linux.

Run locally:

```bash
bash claude-ops/tests/test-safety-hooks.sh
```

---

## See also

- [`docs/deploy-fix.md`](deploy-fix.md) — auto-fix subsystem (independent of safety hooks).
- [`docs/agents.md`](agents.md) — specialized agent system.
- [`docs/INDEX.md`](INDEX.md) — full documentation index.
