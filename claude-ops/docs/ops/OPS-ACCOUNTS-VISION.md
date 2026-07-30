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
| **3** | Absorb host Grok/Codex scripts into plugin (portable, env-templated) | No load-bearing `~/.local/bin/grok-*` for happy path; timers under plugin installers |
| **4** | Optional bundled balancer (rebranded cherry-pick, not CRS dump-fork) | Only if wire-optional CRS still hurts multi-Claude users |

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
