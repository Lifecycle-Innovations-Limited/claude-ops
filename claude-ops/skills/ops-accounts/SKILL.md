---
name: ops-accounts
description: Multi-provider AI account manager (Claude, Grok/xAI, Codex, Factory, Cursor). Status, switch, refresh, and reauth behind one skill. Node adapters under scripts/ops-accounts/; /ops:rotate remains a Claude-focused alias.
argument-hint: '[status|switch|refresh|reauth|list|providers] [provider] [email]'
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
effort: low
maxTurns: 20
---

# OPS ► ACCOUNTS (phase 0)

One skill for **all** paid AI seats on the box. Engines stay specialized;
`scripts/ops-accounts/` is the **router + adapters**.

| Provider | Adapter | Unattended reauth |
|----------|---------|-------------------|
| Claude | `providers/claude.mjs` → rotate / rotate-magic | magic-link + captcha cascade (#727) |
| Grok | `providers/grok.mjs` → grok-oauth-reauth | xAI device-code + Google (dcli); **EFG SOCKS residential** default `socks5://127.0.0.1:1089` |
| OpenAI/Codex | `providers/openai.mjs` | status only phase 0 (`codex login` handoff) |
| Factory | `providers/factory.mjs` | billing restore (402 ≠ reauth) |
| Cursor | `providers/cursor.mjs` | cloud login; remaining needs session cookie |

CRS is **optional** and Claude-oriented (relay LB). Not required for standalone reauth.

## Subcommands (`$ARGUMENTS`)

| Args | Action |
|------|--------|
| (none) / `status` / `list` | Cross-provider AccountRows (no secrets) |
| `providers` | List adapter ids |
| `switch grok` | SuperGrok next seat |
| `switch claude` | Handoff to rotate-now |
| `refresh [all\|claude\|grok\|openai]` | Best-effort token refresh |
| `reauth claude <email>` | `rotate-magic.mjs` |
| `reauth grok <email>` | `grok-oauth-reauth` (residential SOCKS) |

## How to run

```bash
export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/marketplaces/ops-marketplace/claude-ops}"
"${CLAUDE_PLUGIN_ROOT}/bin/ops-accounts" status
"${CLAUDE_PLUGIN_ROOT}/bin/ops-accounts" reauth grok <email>
node "${CLAUDE_PLUGIN_ROOT}/scripts/ops-accounts/__tests__/ops-accounts-smoke.mjs"
```

`/ops:rotate *` remains a **Claude-only alias** for one major version.

## Rules

1. **Never print tokens, cookies, or full vault dumps.**
2. Prefer this bin over host paths so cutover retargets one file.
3. Grok reauth uses residential EFG SOCKS unless `GROK_REAUTH_DIRECT=1`.
4. Factory 402 / Cursor empty pools: report honestly; do not invent remaining.
5. Dead Claude RT: `reauth claude <email>` — do not claim CRS fixes OAuth.

See `docs/ops/OPS-ACCOUNTS-VISION.md` and plan `2026-07-30T1705Z-ops-accounts-phase0-adapter.md`.
