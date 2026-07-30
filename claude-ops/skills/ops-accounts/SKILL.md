---
name: ops-accounts
description: Multi-provider AI account manager (Claude, Grok/xAI, OpenAI/Codex, Factory, Cursor). Status, setup, switch, refresh, reauth, util, optional CRS/LB. Canonical replacement for /ops:rotate and /ops:rotate-setup (those remain aliases).
argument-hint: '[status|list|setup|switch|refresh|reauth|util|rotate-now|crs|crs-tick|help] [provider] [args…]'
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
effort: medium
maxTurns: 40
---

# OPS ► ACCOUNTS

**Canonical** multi-provider seat manager. Same layers Anthropic has for Claude —
for every provider:

| Layer | Verbs |
|-------|--------|
| Status / list | `status`, `list` |
| Setup / OAuth capture | `setup` |
| Switch active seat | `switch`, `rotate-now` (Claude) |
| Refresh tokens | `refresh` |
| Unattended reauth | `reauth` |
| Utilization / quota | `util` |
| Optional Claude LB (CRS or future gateway) | `crs`, `crs-tick` |

**Aliases (compat):** `/ops:rotate` → this skill (Claude-focused shortcuts).  
`/ops:rotate-setup` → `setup` (wizard). `/ops:account` → same as this skill.

## Providers

| Provider | Engine | Reauth | Util |
|----------|--------|--------|------|
| Claude | `scripts/account-rotation/rotate.mjs` + `rotate-magic.mjs` | magic-link + captcha cascade | 5h/7d |
| Grok | slots + `grok-cli-auth-proxy` (+ optional CRS hop) | device-code + Google (dcli); residential egress cascade | weekly / 429 |
| OpenAI / Codex | `codex-rotate` when present | OAuth bridge | usage best-effort |
| Factory | adapter TBD / quota-feed seeds | native | quota-feed patterns |
| Cursor | adapter TBD | browser/device OAuth | plan limits if available |

**CRS is optional.** For Grok, CRS is only a thin hop to the SuperGrok OAuth proxy — multi-seat RR lives on the proxy, not a CRS account table. See `docs/ops/OPS-ACCOUNTS-VISION.md` (CRS cherry-pick / no-CRS path).

## Router (`bin/ops-accounts`)

Always prefer:

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(ls -d "$HOME/.claude/plugins/cache/ops-marketplace/ops"/*/ 2>/dev/null | sort -V | tail -1)}"
"$PLUGIN_ROOT/bin/ops-accounts" <cmd> …
```

| Command | Action |
|---------|--------|
| `status` / `list` | All configured providers (no secrets) |
| `util [claude\|grok\|all]` | Quota / utilization best-effort |
| `switch claude` / `rotate-now` | Claude keychain rotate (`force-rotate` / `rotate.mjs`) |
| `switch grok` | Next SuperGrok seat (`grok-rotate switch`) |
| `refresh [all\|claude\|grok]` | Keepalive / RT refresh |
| `reauth claude <email>` | `rotate-magic.mjs --to <email>` |
| `reauth grok <email>` | Device reauth with residential cascade env |
| `setup` / `setup claude` | Full Claude OAuth wizard (former rotate-setup steps) |
| `setup grok` | Add/reauth SuperGrok seat |
| `crs` / `crs-tick` | Optional Claude CRS pool status / one tick |
| `seats` | Local multi-provider seat-state (no CRS) |

## Claude setup / OAuth

When `$ARGUMENTS` is `setup`, `setup claude`, or this skill is invoked via
**ops-rotate-setup** alias: follow the full wizard in
`skills/ops-rotate-setup/SKILL.md` (Steps 1–5, CRS optional 4.4–4.7). That file
remains the detailed Claude setup procedure; this skill is the entrypoint.

Claude day-2 ops (`status`/`rotate-now`/`list`/`reauth`/`crs`) also match
`skills/ops-rotate/SKILL.md` — treat that as Claude detail appendix.

## Local seat-state (no CRS)

```bash
"$PLUGIN_ROOT/bin/ops-accounts" seats status
"$PLUGIN_ROOT/bin/ops-accounts" seats import-claude-config
node "$PLUGIN_ROOT/scripts/account-rotation/seat-state.mjs" toggle claude <email> false
```

File: `$CLAUDE_PLUGIN_DATA_DIR/account-rotation/seat-state.json` (or `OPS_ACCOUNTS_STATE_PATH`).

## Grok notes

1. CLI models often use `base_url` → CRS `/grok/v1` → **host OAuth proxy** → SuperGrok seats.  
2. `grok-rotate` / `auth.json` is the SuperGrok seat set; keep **auth-slots** in sync after reauth.  
3. Reauth egress: EFG SOCKS (`GROK_REAUTH_SOCKS`) → Bright Data tiers via  
   `scripts/account-rotation/grok-reauth-egress.sh` (residential cascade).  
4. Proxy RR status: `curl -sS http://127.0.0.1:31845/accounts` (no tokens).

## Rules

1. Never print tokens, cookies, OTP codes, or vault dumps.  
2. Never write real emails into committed files.  
3. Prefer `bin/ops-accounts` over ad-hoc host paths.  
4. Missing CRS is not a failure.  
5. Dead RT → `reauth`, not “install CRS.”  
6. Background long OAuth (Rule 4).  

## Phase map

0 contract + this skill · 1 Claude parity · 2 CRS optional · 3 Grok complete ·  
4 Codex+Factory · 5 Cursor · 6 companions · 7 host cutover · 8 gateway (no CRS)
