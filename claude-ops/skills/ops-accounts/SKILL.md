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
| Optional Claude LB (CRS **or** local seat-state) | `crs`/`policy`, `crs-tick`/`policy-tick` |
| SuperGrok OAuth RR (plugin, no CRS) | `grok-proxy` |

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
| `crs` / `policy` / `crs-tick` / `policy-tick` | Dual backend: CRS admin when up, else local seat-state (`OPS_ACCOUNTS_BACKEND=auto\|crs\|local`) |
| `seats` / `seats tick` | Local multi-provider seat-state (no CRS) |
| `grok-proxy status\|start` | Plugin-bundled SuperGrok OAuth RR (`scripts/account-rotation/grok-cli-auth-proxy.py`) |

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
"$PLUGIN_ROOT/bin/ops-accounts" seats tick          # policy without CRS
"$PLUGIN_ROOT/bin/ops-accounts" policy-tick         # auto: CRS if up, else local
OPS_ACCOUNTS_BACKEND=local "$PLUGIN_ROOT/bin/ops-accounts" policy-tick
```

File: `$CLAUDE_PLUGIN_DATA_DIR/account-rotation/seat-state.json` (or `OPS_ACCOUNTS_STATE_PATH`).

When CRS is present, `crs-tick` dual-writes schedulable/util into the same file
(unless `OPS_ACCOUNTS_DUAL_WRITE=0`).

### Cherry-pick map (what we use CRS for → plugin)

| CRS job | Plugin path |
|---------|-------------|
| Claude multi-seat schedulable policy | `crs-priority-daemon` dual backend + `seat-policy-tick` |
| Seat util / cooldown state | `seat-state.json` |
| Grok multi-seat RR | `grok-cli-auth-proxy.py` in plugin (not CRS account table) |
| OpenAI-compat gateway `:3005` | future `ops-accounts-gateway` (not required for CLI keychain rotate) |
| Redis / admin SPA / Grafana | **not** shipped |

## Grok notes

1. Prefer plugin proxy: `ops-accounts grok-proxy start` → `http://127.0.0.1:31845/v1`.  
2. Optional CRS `/grok` is only a thin hop to that proxy.  
3. Seats: `~/.grok/auth.json` + `auth-slots/`; set `GROK_PREFERRED_EMAILS` / `GROK_SLOT_FILES` (no emails committed).  
4. Reauth egress: `scripts/account-rotation/grok-reauth-egress.sh` (residential cascade).  
5. Status: `ops-accounts grok-proxy status` or `curl -sS http://127.0.0.1:31845/accounts`.

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
