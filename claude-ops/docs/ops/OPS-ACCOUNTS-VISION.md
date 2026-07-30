# ops-accounts vision

**Status:** product SSOT for multi-provider account management (not a late add-on).

**Date:** 2026-07-30 (revised same day: multi-provider rotator is **phase 0**)

## Direction

Ship **`/ops:accounts`** (alias `/ops:rotate` for one major version) as the
**sole** place to register, refresh, reauth, and load-balance paid AI seats:

- Claude Max / Pro
- OpenAI / Codex
- Grok (xAI SuperGrok)
- Extensible adapters later

Ideal box state: **public claude-ops plugin only** — no host forks, no
provider-specific manual scripts left as the path of record.

| Layer | Role | Required? |
|-------|------|-----------|
| **Provider adapter** | Capture + OAuth reauth + token store for one vendor | Yes (one per provider you use) |
| **Refresh loop** | Proactive access-token refresh while refresh_token lives | Yes |
| **Reauth dispatcher** | When RT dies: vendor-specific unattended reauth (Claude magic-link, Grok device-code+Google, Codex OAuth) | Yes |
| **Active-seat / CLI switch** | Which account the interactive CLI uses now | Yes for TUI CLIs |
| **Load balancer** | Multi-account concurrent pool, 429 cooldown, priority, token feed | Optional (rate-limit / weekly-cap spread) |

CRS remains an **optional** external balancer for Claude (and any path that
already speaks CRS). It is **not** the multi-provider OAuth engine and must
not be required for single-seat users.

## Why phase 0 (not phase 3)

Without a multi-provider contract first:

- Grok weekly-cap / dead RT is handled by host-only tools (`grok-rotate`,
  `grok-oauth-reauth`, `grok-cli-auth-proxy`) outside the plugin skill surface.
- Claude magic-link autoloop and Grok device reauth never share a dispatcher.
- “Public plugin only” cutover cannot retire host trees that still own Grok.

So the **north star is ops-accounts**. Claude captcha port and CRS-optional UX
are **enablers** under that contract, not a separate product that might grow
multi-provider later.

## Provider matrix (target)

| Provider | Capture / reauth | Token store | Refresh | Unattended reauth | LB path today |
|----------|------------------|-------------|---------|-------------------|---------------|
| Claude | magic-link + captcha cascade (`rotate.mjs`) | vault / keychain `Claude-Rotation-*` | `refresh-tokens` + keepalive | `magic-link-autoloop` | CRS optional |
| Grok | xAI device-code + Google (dcli password/TOTP) | `~/.grok/auth-slots` (later: plugin-managed) | RT refresh in keepalive / proxy | `grok-oauth-reauth` (must become timer + skill) | `grok-cli-auth-proxy` round-robin |
| Codex | OpenAI OAuth / API key | provider-scoped vault | codex OAuth bridge patterns | adapter TBD | optional |

## Phased plan (revised)

| Phase | Work | Exit criteria |
|-------|------|----------------|
| **0** | **ops-accounts contract** — skill surface, provider adapter interface, unified status/switch/refresh/reauth verbs, wire existing Claude + Grok + Codex tools behind it (thin orchestration first, no big rewrite) | `/ops:accounts status` shows all providers; `switch`/`refresh`/`reauth` work for Claude and Grok without knowing host script names |
| **1** | Close host / plugin Claude rotate gap | Plugin cascade modules; gap doc; host units still host until proven |
| **2** | CRS optional wire (Claude only) | Detect CRS; install vs standalone; never required for single seat |
| **2b** | **Dual backend + local seat-state** | `OPS_ACCOUNTS_BACKEND=auto\|crs\|local`; policy tick without Docker CRS; dual-write seat-state |
| **3** | Absorb host Grok/Codex scripts into plugin (portable, env-templated) | Plugin `grok-cli-auth-proxy.py` + reauth egress; no load-bearing `~/.local/bin/grok-*` for happy path |
| **4** | Optional `ops-accounts-gateway` (thin OpenAI-compat multi-provider) | Replaces `:3005` for most fleets; CRS advanced-only |

**This week’s PRs (#726 companions, #727 captcha/CRS-optional) are phase 1–2
enablers.** They must not re-label phase 0 as “later design only.”

## Gaps proven live (2026-07-30)

- Active Grok CLI seat stuck on one account while alternates have dead RTs.
- Claude magic-link autoloop is timer-driven; Grok reauth service is oneshot
  with **no timer** — not parity.
- rotate-magic does not speak xAI device-code; CRS does not reauth Grok.

## Risks

| Risk | Mitigation |
|------|------------|
| Big-bang rewrite of Claude rotate | Thin adapters over existing engines first |
| CRS license if forking | Prefer wire-in; cherry-pick only after license review |
| Host fork drift | Plugin SSOT; host units until phase 3 proof |
| Secret sprawl | Provider-scoped vault names; never commit secrets |
| Skill rename churn | Keep `/ops:rotate` alias ≥1 major version |

## Non-goals (immediate)

- Full CRS fork in one PR
- Deleting host rotate before live parity
- Hard-requiring CRS for single-account users

## Related

- `docs/ops/HOST-VS-PLUGIN-ROTATE-GAP.md`
- `scripts/account-rotation/CAPTCHA-CASCADE.md`
- Host (temporary): `grok-rotate`, `grok-oauth-reauth`, `grok-cli-auth-proxy`, `host-token-keepalive`
- Skills today: `ops-rotate`, `ops-rotate-setup` → become aliases of `ops-accounts`

## Phase 0 — multi-provider adapter contract (design only)

Target skill surface: **`/ops:accounts`** (alias `/ops:rotate` for ≥1 major version).

### Commands (stable)

| Verb | Meaning |
|------|---------|
| `status` | List registered seats per provider + token health (no secrets) |
| `list` | Same as status, table form |
| `add` / `register` | Interactive capture into provider vault namespace |
| `reauth` | Provider-specific reauth (Claude → rotate-magic; Grok → oauth reauth; Codex → session OAuth) |
| `switch` | Make seat active for that provider’s CLI |
| `lb` / `crs` | Optional load-balancer plane (Claude CRS today; others later) |

### Adapter interface (plugin-local modules)

Each provider ships a small adapter under `scripts/account-rotation/providers/<id>.mjs`
(or future `scripts/accounts/providers/`). Minimum exports:

```js
// providers/<id>.mjs
export const id = 'claude' | 'codex' | 'grok';
export const displayName = 'Claude Max';
/** @returns {Promise<{ok:boolean, seats:Array<{key,label,tokenValid,util?}>, note?:string}>} */
export async function status(ctx) {}
/** Capture or refresh vault entry. No secret logging. */
export async function register(ctx, { emailOrLabel, mode }) {}
/** Unattended reauth when token dead. May use browser/cascade. */
export async function reauth(ctx, { key }) {}
/** Optional: mark seat active for the CLI that reads this provider. */
export async function switchTo(ctx, { key }) {}
```

`ctx` carries portable paths only: `pluginRoot`, `dataDir`, `log`, `env` — never host hardcodes.

### Vault namespaces (credential-store service names)

| Provider | Service pattern | Notes |
|----------|-----------------|-------|
| Claude | `Claude-Rotation-<key>` + live `Claude Code-credentials` | Existing |
| Codex | `Codex-Rotation-<key>` (proposed) | Session OAuth; no public remaining API |
| Grok | `Grok-Rotation-<key>` (proposed) | Absorb host oneshot into plugin adapter |

### Dispatcher

- Shared timer / autoloop dispatches `adapter.reauth` per `needsReauth` flags.
- Claude path uses `rotate-magic.mjs` + captcha cascade (this PR).
- CRS / balancer remains **optional** and Claude-scoped until a second provider needs LB.

### Out of scope for phase 0 implementation

- Renaming skills on disk
- Forking CRS
- Absorbing every host grok/codex script in one PR

