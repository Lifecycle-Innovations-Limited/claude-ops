<!-- generated-by: gsd-doc-writer -->
# Getting Started with claude-ops

claude-ops v1.7.0 — Business Operating System for Claude Code. This guide takes you from zero to your first morning briefing in under five minutes.

---

## Prerequisites

- **Claude Code 1.0+** — the only hard requirement. Install from [claude.ai/code](https://claude.ai/code).

Everything else (CLIs, tools, integrations) is installed automatically by `/ops:setup` via Homebrew on macOS, apt on Linux, or winget on Windows. No manual dependency management required.

---

## Installation

### Option 1 — Marketplace (recommended)

Install directly from the Claude Code plugin marketplace in two commands:

```bash
# Add the marketplace source
/plugin marketplace add Lifecycle-Innovations-Limited/claude-ops

# Install the plugin
/plugin install ops@lifecycle-innovations-limited-claude-ops
```

### Option 2 — Local development

Clone the repo and point Claude Code at the inner plugin directory:

```bash
git clone https://github.com/Lifecycle-Innovations-Limited/claude-ops.git
claude --plugin-dir ./claude-ops/claude-ops
```

> **Why the nested `claude-ops/claude-ops/` path?** Claude Code's marketplace system requires a two-level layout. The repo root is the marketplace container; the inner `claude-ops/` directory is the actual plugin root that Claude Code loads. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full explanation.

To reload after making changes in local dev mode:

```bash
/reload-plugins
```

---

## Setup Wizard (`/ops:setup`)

Run the guided wizard immediately after installing:

```
/ops:setup
```

The wizard walks you through every integration in a conversational, step-by-step flow:

1. **Preflight** — detects already-configured CLIs, credentials, and MCP servers. Reads from `/tmp/ops-preflight/` cache so no probe runs twice.
2. **Core CLIs** — installs `jq`, `git`, `gh`, `aws`, and `node` if missing.
3. **Daemon install** — installs `briefing-pre-warm` early (Step 2c) so it begins pre-fetching ECS health, git state, PRs, CI, and unread counts while you answer the remaining wizard questions. By the time setup finishes, your first `/ops:go` loads in **<3 seconds** from warm cache instead of ~30 seconds cold.
4. **Channels** — configures each integration you choose: Telegram, WhatsApp, Gmail, Slack, Linear, Sentry, Vercel, Stripe, RevenueCat, Shopify, and more.
5. **Project registry** — scans your local directories and builds `scripts/registry.json` with your project list.
6. **Preferences** — saves your name, timezone, and default channels to `preferences.json` in Claude Code's plugin data directory.

**Rules the wizard enforces:**

- Never skips a channel silently — if a credential isn't found, you are always offered `[Paste manually]`, `[Deep hunt]`, or `[Skip]`.
- Never installs anything without your confirmation.
- Runs all probes in parallel and in the background — the conversation keeps moving while tools install.

For credentials, the wizard resolves secrets in this order: Doppler → 1Password/Dashlane/Bitwarden → macOS Keychain → environment variables. If none are found, it asks you directly.

See [CONFIGURATION.md](./CONFIGURATION.md) for the full list of configurable values and their plugin.json `userConfig` keys.

---

## Health Check (`/ops:doctor`)

After setup, verify the plugin is healthy:

```
/ops:doctor
```

The doctor runs a diagnostic script and displays a report:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► DOCTOR — 2026-04-14 09:00
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Plugin:      1.1.0 at /path/to/plugin
 Skills:      22 defined
 Agents:      12 defined
 Bin scripts: 8 available

 ERRORS       0
 WARNINGS     0

 TOOLS
 [table of CLI tool availability]

 ENV VARS
 [table of env var status]

 Registry:    19 projects
 Preferences: configured
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If errors or warnings are found, the doctor automatically spawns a repair agent to fix them. After the agent completes, diagnostics re-run to confirm the fix. To check without auto-repairing:

```
/ops:doctor --check-only
```

---

## First Briefing (`/ops:go`)

Once the doctor reports all checks passing, run your first briefing:

```
/ops:go
```

Output looks like this:

```
╭──────────────────────────────────────────────────────────────────────────────╮
│  /ops:go  ►  MORNING BRIEFING                              2026-04-14  09:03 │
├─────────────────────────────────┬────────────────────────────────────────────┤
│  INFRA    ████████████████  ok  │  ECS: 4/4 healthy  RDS: ok  Redis: ok     │
│  CI/CD    ████████████░░░░  75% │  3 passing  1 failing  (my-api #847)       │
│  INBOX    ░░░░░░░░░░░░░░░░  14  │  Slack: 9  Telegram: 3  Gmail: 2 unread   │
│  PRs      ████████████████  3   │  3 ready to merge  1 needs review          │
│  SPRINT   ████████████░░░░  67% │  Sprint 24  —  8 of 12 issues complete     │
│  REVENUE  ████████████████  $   │  $2,847 MTD  ↑12% vs last month           │
├─────────────────────────────────┴────────────────────────────────────────────┤
│  Next action: merge feat/user-profile  ·  fix my-api CI  ·  reply @alice    │
╰──────────────────────────────────────────────────────────────────────────────╯
```

Each section (INFRA, CI/CD, INBOX, PRs, SPRINT, REVENUE) is pre-gathered by shell scripts before model context loads — no extra latency. The `briefing-pre-warm` daemon runs every 2 minutes in the background so data is always warm.

From here, explore the other 29 skills — see the full command table in the root [README.md](../README.md).

---

## Common Issues

### Plugin not found after marketplace install

The marketplace cache can lag by a few seconds. Try:

```bash
/plugin list
/plugin install ops@lifecycle-innovations-limited-claude-ops
```

If the plugin still does not appear, confirm Claude Code is version 1.0 or later: `claude --version`.

### `/ops:setup` hangs on a credential scan

Background probes run in parallel during setup. If a step appears stuck for more than 30 seconds, it is likely waiting on a slow network probe (Doppler, keychain, password manager). You can safely answer the current `AskUserQuestion` — the wizard will resume when the background result arrives. If a probe never completes, `/ops:doctor` will flag the affected integration.

### `/ops:go` shows cold load (~30s) on first run

This means the `briefing-pre-warm` daemon was not installed during setup, or has not yet completed its first cycle. Run `/ops:setup` again and confirm the daemon step (Step 2c). After installation, pre-warm runs every 2 minutes — subsequent briefings will be fast.

### Missing integration data in `/ops:go`

Each integration only appears if its credential is configured. Run `/ops:doctor` to see which env vars or API keys are unset, then run `/ops:setup <section>` (e.g., `/ops:setup slack`) to configure just that integration.

### WhatsApp shows `needs_auth`

WhatsApp authentication requires a QR code scan on your phone — this is the one step that cannot be automated. Run `/ops:setup whatsapp` and point your phone camera at the QR code shown in the terminal.

---

## Next Steps

- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the plugin is structured, the daemon, and the two-level directory layout
- [CONFIGURATION.md](./CONFIGURATION.md) — full reference for every configurable value, credential key, and userConfig field
- [../CONTRIBUTING.md](../CONTRIBUTING.md) — branch rules, PR workflow, and how to add new skills
