# ops-accounts vision (plan only)

**Status:** design note. Do **not** rename skills or fork CRS in this pass.

**Date:** 2026-07-30

## Direction

Evolve **ops-rotate** → **ops-accounts**: a multi-provider account manager for
paid AI CLI seats, with optional load balancing.

| Layer | Role | Required? |
|-------|------|-----------|
| **rotate-magic / OAuth engine** | Per-account capture, magic-link reauth, captcha cascade, keychain/vault | Yes (standalone core) |
| **Keychain rotator** | One active Claude token at a time; cool-down swap | Optional (multi Claude Max) |
| **Load balancer** | Multi-account concurrent pool, 429 cooldown, priority pool, token feed | Optional (rate-limit spreading) |

Today the load-balancer layer is often **claude-relay-service (CRS)** wired as
an optional add-on. The product direction is to keep CRS **optional**, and
later cherry-pick open-source balancer ideas under the **ops-accounts** name
only if wire-optional is not enough.

## Providers

| Provider | Near-term | Notes |
|----------|-----------|--------|
| Claude Max / Pro | Core | Existing rotator + magic-link |
| Codex (OpenAI) | Next | OAuth / API key seats; separate vault namespace |
| Grok (xAI) | Next | OAuth reauth already exists out-of-tree; absorb under ops-accounts |
| Extensible | Later | Plugin-shaped provider adapters (`provider-env` / `provider-router` seeds) |

Standalone **rotate-magic** remains the OAuth/captcha engine for Claude.
Other providers get their own capture/reauth engines behind one skill surface.

## CRS relationship

- CRS is useful mainly when you hit **rate limits with many accounts** and want
  a single relay endpoint that spreads load.
- For single-account or few-account users, **standalone rotate-magic is enough**.
- Setup must **detect** CRS (binary, service health, or `crs.enabled` in config)
  and never hard-require it.
- If we later bundle balancer logic: **rebrand** (priority pool, 429 cooldown,
  token feed) under ops-accounts; do not ship a premature full CRS fork.

## Cherry-pick candidates (from CRS / current crs-* scripts)

1. **Priority pool** — deprioritize hot accounts, re-enable on recovery  
2. **429 cooldown** — hold only on real rate-limit signals  
3. **Token feed** — push vault tokens into the pool without re-OAuth  
4. **401 refresher** — proactive refresh before silent failure  
5. **Magic-link autoloop** — unattended reauth dispatcher (already plugin-side)

These already live as portable `crs-*.mjs` scripts in the plugin. Renaming them
to `ops-accounts-*` is a later packaging step, not a rewrite.

## Phased plan

| Phase | Work | Exit criteria |
|-------|------|----------------|
| **1** | Close host / plugin rotate gap | Plugin cascade modules + soft hooks; gap doc; host units still host (reported only) |
| **2** | CRS optional wire | Setup detects CRS; AskUser install vs standalone vs skip; standalone works with zero CRS |
| **3** | ops-accounts rename + multi-provider | Skill rename/alias, provider adapters for Claude + Codex + Grok, docs |
| **4** | Optional bundled balancer | Only if wire-optional CRS is still painful; license review; rebranded cherry-pick, not dump-fork |

This pass targets **phases 1–2** (partial 1: modules + hooks, not full 9k→5k
rotate merge) and **documents** phases 3–4.

## Risks

| Risk | Mitigation |
|------|------------|
| CRS open-source license when forking | Review LICENSE before any copy into repo; prefer process/API wire-in |
| Premature fork | Phase 4 only after phase 2 fails real multi-account users |
| Host fork drift | SSOT = plugin; host units stay until parity, then repoint |
| Multi-provider secret sprawl | One credential-store schema; never commit secrets; provider-scoped service names |
| Name churn for skill users | Keep `/ops:rotate` as alias for at least one major version |

## Non-goals (this plan)

- Implementing the full CRS fork  
- Renaming all `crs-*` scripts in this PR  
- Killing host rotate or repointing production systemd  
- Storing personal account inventories in the public repo  

## Related docs

- `docs/ops/HOST-VS-PLUGIN-ROTATE-GAP.md` — concrete file gap  
- `scripts/account-rotation/CAPTCHA-CASCADE.md` — unattended captcha contract  
- `scripts/account-rotation/reauth-env.mjs` — portable reauth env  
- Skills: `ops-rotate`, `ops-rotate-setup`  
