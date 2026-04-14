# Security Policy

[![Last Audit](https://img.shields.io/badge/last%20audit-2026--04--14-blue)](#)
[![Response Time](https://img.shields.io/badge/response-%3C48h-brightgreen)](#reporting-a-vulnerability)
[![License](https://img.shields.io/badge/license-MIT-informational)](./LICENSE)

## Supported Versions

`claude-ops` follows semantic versioning. Security patches are backported one major version behind the current release.

| Version | Supported          | Notes                                           |
|---------|--------------------|-------------------------------------------------|
| 0.8.x   | Yes (current)      | Active development; patches land here first.   |
| 0.7.x   | Yes (backport)     | Security fixes only until 0.9.0 ships.         |
| < 0.7   | No                 | Please upgrade.                                 |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT** open a public GitHub issue.
2. Email: `security@example.com`
3. Include: description, reproduction steps, affected version, and impact assessment.

**Expected response time:** we acknowledge within 48 hours and aim to ship a fix or mitigation within 14 days. We will coordinate a disclosure timeline with you and credit you in the release notes (unless you prefer to remain anonymous).

## Scope

### In scope

- Skills under `claude-ops/skills/`
- Agents under `claude-ops/agents/`
- Shell scripts under `claude-ops/bin/`
- Setup wizard (`claude-ops/skills/setup/`, `bin/ops-setup-*`)
- Background daemon (`ops-daemon`, services: `wacli-keepalive`, `memory-extractor`, `briefing-pre-warm`)
- Telegram MCP server (`claude-ops/telegram-server/`)
- Plugin hooks (PreToolUse, Stop) and plugin rule enforcement (`CLAUDE.md`)
- `plugin.json` / `marketplace.json` userConfig handling

### NOT in scope

The following are outside the plugin's security boundary:

- **User-supplied credentials in `userConfig`** — these live in Claude Code's own settings store; see Claude Code's security policy.
- **Third-party CLI tools** shipped or wrapped by the plugin, including `wacli` (WhatsApp), `gog` (Google workspace CLI), the Linear MCP, the Sentry MCP, the Gmail MCP connector, and the Google Calendar MCP connector. Report issues to those projects upstream.
- **Vendor APIs** (Stripe, RevenueCat, Shopify, Klaviyo, Meta, GA4, Search Console, Bland AI, ElevenLabs, Groq, AWS). We consume their APIs; we do not operate them.
- **The user's own AWS account, infrastructure, and IAM policies** — `infra-monitor` only reports on what the user's credentials can already access.

## Known Limitations

- **No sandboxing beyond Claude Code's worktree isolation.** The plugin runs with the user's full shell permissions. Only the `triage-agent` runs with `isolation: worktree`; every other skill and agent executes under the same UID and filesystem access as Claude Code itself.
- **Private repositories referenced.** `@auroracapital/gog` and some internal registry examples reference private repos. Install paths that require them will fail gracefully, but users need their own access credentials; the plugin does not embed any.
- **WhatsApp via `wacli` uses a QR-paired session.** `wacli` exchanges messages over WhatsApp's own E2E-encrypted protocol, but the session state on disk (pairing keys, message history, app state keys) is not encrypted at the plugin layer. Treat `~/.wacli/` as sensitive.
- **No telemetry, no phone-home.** The plugin does not emit analytics, crash reports, or usage pings. All network traffic is either (a) to services the user explicitly configured credentials for, or (b) to `api.anthropic.com` via Claude Code itself.

## Security Measures

- **Secret scanning** — `.gitleaks.toml`, GitHub secret scanning, and push protection enabled on the repo.
- **No secrets in source** — tokens live in the OS keychain, Doppler, a password manager, or the user's `userConfig`; never in tracked files.
- **Credential scrubbing in CI** — `tests/test-no-secrets.sh` runs on every commit and blocks real names, emails, phones, tokens, store URLs, and `/Users/...` paths (see `CLAUDE.md` Rule 0).
- **Encrypted cookie handling** — browser cookie extraction (Slack `xoxd-`, etc.) uses the browser's own keychain key and never persists cleartext cookies to disk.
- **File permissions** — all plugin-generated temp files are created with `umask 077` (mode `0600`).
- **Destructive-action gating** — `CLAUDE.md` Rule 5 requires explicit per-action `AskUserQuestion` confirmation before any deletion, stop, scale-down, history rewrite, or auto-renewal cancellation.
- **Plugin rule enforcement** — `CLAUDE.md` at plugin root codifies Rules 0–5 (privacy, question limits, command delegation, skip behavior, background defaults, destructive-action confirmation) and overrides any conflicting instruction in individual skills.

## Further Reading

- [Privacy and Security wiki page](https://github.com/Lifecycle-Innovations-Limited/claude-ops/wiki/Privacy-and-Security) — full breakdown of every credential scan source, what the daemon touches on disk, and the plugin's no-telemetry stance.
- [Plugin Rules wiki page](https://github.com/Lifecycle-Innovations-Limited/claude-ops/wiki/Plugin-Rules) — the six hard rules every skill must follow.
- [Daemon Guide](https://github.com/Lifecycle-Innovations-Limited/claude-ops/wiki/Daemon-Guide) — what `ops-daemon` runs and how to inspect it.
