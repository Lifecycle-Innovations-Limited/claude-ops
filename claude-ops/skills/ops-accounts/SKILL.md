---
name: ops-accounts
description: Multi-provider AI account manager (Claude, Grok/xAI, Codex). Status, switch, refresh, and reauth behind one skill. Phase 0 thin router over existing engines; /ops:rotate remains a Claude-focused alias.
argument-hint: '[status|switch|refresh|reauth|list] [provider] [email]'
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
effort: low
maxTurns: 20
---

# OPS ► ACCOUNTS (phase 0)

One skill for **all** paid AI seats on the box. Provider engines stay specialized;
this skill is the **router** and the product surface for “public plugin only.”

| Provider | Engine today | Unattended reauth |
|----------|--------------|-------------------|
| Claude | `scripts/account-rotation/rotate.mjs` + `rotate-magic.mjs` | magic-link + captcha cascade |
| Grok | `grok-rotate`, `grok-oauth-reauth`, `grok-cli-auth-proxy` | xAI device-code + Google (dcli) |
| Codex | `codex-rotate` if present | OpenAI OAuth bridge patterns |

CRS is **optional** and Claude-oriented (relay LB). It is not required for
standalone reauth on any provider.

## Subcommands (`$ARGUMENTS`)

| Args | Action |
|------|--------|
| (none) / `status` | Cross-provider status (no secrets) |
| `list` | Same as status (phase 0) |
| `switch grok` | Next SuperGrok seat (`grok-rotate switch`) |
| `switch claude` | Point at `/ops:rotate rotate-now` |
| `refresh` / `refresh all` | `host-token-keepalive --force` |
| `refresh grok` / `refresh claude` | Provider-scoped keepalive |
| `reauth grok <email>` | Device-code reauth (dcli password/TOTP) |
| `reauth claude <email>` | `rotate-magic.mjs --to <email>` |

## How to run

```bash
# preferred: plugin bin
"${CLAUDE_PLUGIN_ROOT}/bin/ops-accounts" status
"${CLAUDE_PLUGIN_ROOT}/bin/ops-accounts" reauth grok <email>
"${CLAUDE_PLUGIN_ROOT}/bin/ops-accounts" switch grok
```

If `CLAUDE_PLUGIN_ROOT` is unset, resolve the latest
`~/.claude/plugins/cache/ops-marketplace/ops/*/`.

## Rules

1. **Never print tokens, cookies, or full vault dumps.**
2. Prefer the bin router over ad-hoc host paths so cutover can retarget one file.
3. On weekly-cap / 429 for Grok interactive TUI: `switch grok` after seats are healthy.
4. On dead refresh_token: `reauth <provider> <email>` — do not claim CRS will fix OAuth.
5. `/ops:rotate` stays as Claude alias until one major version after rename.

## Phase map

- **0 (this skill):** unified verbs + docs
- **1–2:** Claude captcha port + CRS optional (enablers)
- **3:** absorb host `grok-*` into plugin installers/timers
- **4:** optional bundled LB (not a full CRS fork)

See `docs/ops/OPS-ACCOUNTS-VISION.md`.
