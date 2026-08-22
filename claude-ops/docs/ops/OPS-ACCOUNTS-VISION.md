# ops-accounts vision

**Status:** product SSOT. Multi-provider account system — same shape as Anthropic/Claude today, for every paid CLI seat.

**Date:** 2026-07-30 (revised: full provider parity, not Claude-only + late rename)

## Direction

Ship **`/ops:accounts`** as the only operator surface for paid AI accounts:

- Register / list / switch seats  
- OAuth capture  
- Access-token refresh  
- Unattended reauth when refresh dies  
- Utilization / quota queries  
- Optional load balancing / cooldown  

**Aliases (compat ≥1 major version):** `/ops:rotate`, `/ops:rotate-setup`, `/ops:account`.

Ideal box: **public claude-ops plugin only** — no host-only `grok-rotate`, `codex-rotate`, or one-off reauth scripts as the path of record.

## Anthropic reference stack (what “done” looks like)

Claude already has (in plugin + optional cliproxy / CLIProxyAPI relay):

| Layer | Role |
|-------|------|
| Capture | magic-link / browser setup (`rotate.mjs`, `rotate-magic.mjs`) |
| Store | vault / keychain `Claude-Rotation-*` |
| Refresh | proactive token refresh + keepalive |
| Reauth | magic-link-autoloop + captcha cascade (residential egress) |
| Util | 5h / 7d utilization queries |
| Switch | keychain swap / force-rotate |
| Optional LB | cliproxy / CLIProxyAPI pool priority, 429 cooldown, token feed |

**Every other provider gets the same layers**, with provider-native OAuth and util APIs.

## Provider adapters (required set)

| Provider | OAuth / capture | Reauth | Util | Switch / LB notes |
|----------|-----------------|--------|------|-------------------|
| **Claude (Anthropic)** | magic-link + captcha | magic-link-autoloop | 5h/7d | keychain daemon; cliproxy / CLIProxyAPI relay optional |
| **Grok (xAI SuperGrok)** | device-code + Google (dcli) | residential cascade (EFG SOCKS → Bright Data residential → ISP → mobile) | weekly / 429 | `grok-cli-auth-proxy` RR; optional CLIProxyAPI-compatible hop only |
| **OpenAI / Codex** | OAuth / API key | codex OAuth bridge | usage API | `codex-rotate` absorbed |
| **CLIProxyAPI (local multi-provider pool)** | per-provider OAuth login flows (browser/device-code) | proxy-internal token refresh | management API (pool-level) | single static binary + flat-file auth-dir; chosen over sub2api (no Postgres/Redis to maintain). Optional local backend: `providers/cliproxy.mjs` adapter reports auth-dir inventory; `bin/ops-accounts` prints per-provider counts + `util <provider>` views. Env overrides: `CLIPROXYAPI_HOME`, `CLIPROXYAPI_AUTH_DIR`, `CLIPROXYAPI_BASE_URL`. |
| **Factory** | provider OAuth / tokens | native reauth | quota-feed-factory patterns | full adapter |
| **Cursor** | Cursor account OAuth | browser/device OAuth | plan limits if available | full adapter |
| **Extensible** | adapter interface | same contract | best-effort | `provider-env` / `provider-router` |

### Grok + CLIProxyAPI-compatible relay (do not mis-sell)

Grok Build can use `CRS_GROK_BASE_URL` as a legacy env alias for its CLIProxyAPI-compatible endpoint. The optional relay hop **does not** own a SuperGrok account pool. It forwards to the configured **`grok-cli-auth-proxy`** (`GROK_PROXY_URL`), which holds OAuth seats and round-robins. ops-accounts status must show:

1. CLIProxyAPI-compatible hop present/absent
2. Proxy RR seat health + exhaust cooldowns
3. Slot ↔ `auth.json` sync

## Adapter contract (every provider)

```
status()        # seats, token validity, active, LB state
list()          # same, machine-readable
setup(email)    # interactive or flag-driven capture
refresh([email])# proactive access refresh
reauth(email)   # unattended when RT dead
util([email])   # quota / utilization best-effort
switch([email]) # active CLI seat where applicable
```

No secrets in skill output. Provider-scoped vault service names. Env-templated paths only.

## Phased plan

| Phase | Work | Exit criteria |
|-------|------|----------------|
| **0** | Skill merge + contract — `/ops:accounts` owns verbs; rotate/setup are aliases; thin router over existing engines | One entrypoint; multi-provider status |
| **1** | Claude plugin parity (captcha cascade, standalone reauth) | Host not required for Claude magic-link |
| **2** | Claude CLIProxyAPI/legacy relay optional | Detect; never required for single seat |
| **3** | Grok adapter complete (plugin reauth + residential cascade + slot sync + proxy status) | Multi-seat healthy under weekly cap without host-only ops |
| **4** | OpenAI/Codex + Factory adapters | same verbs |
| **5** | Cursor adapter | same verbs |
| **6** | Companions required co-install | done (#726) |
| **7** | Cutover: units → `$CLAUDE_PLUGIN_ROOT`; retire host forks | public plugin only |
| **8** | Optional bundled multi-provider LB | license-safe cherry-pick if still needed |



## cliproxy / CLIProxyAPI gateway path (legacy aliases retained)

### Split cliproxy-compatible behavior into three jobs

1. **API gateway** — OpenAI-compat `:3005`, `cr_` keys, harness routing  
2. **Claude seat LB** — schedulable pool, 429/weekly park, token feed  
3. **Grok thin hop** — forward to host SuperGrok OAuth proxy (not a Claude relay pool)

ops-accounts absorbs (1)+(2) as optional **ops-accounts-gateway** + **policy daemons**,
and treats (3) as the **Grok provider backend** (port `grok-cli-auth-proxy` into
the plugin). External legacy relay stacks remain advanced-only compatibility paths.

### Already portable in this repo (legacy filenames retained for compatibility)

- `crs-priority-daemon.mjs` — pool priority / schedulable policy  
- `crs-429-cooldown.mjs` — rate-limit cooldown  
- `crs-401-refresher.mjs` — proactive refresh  
- `crs-token-feed.mjs` — vault → pool  
- `crs-pool-config.mjs`, `crs-health-watch.mjs`, `crs-bedrock-guard.mjs` — optional

These legacy-named modules currently call cliproxy-compatible admin APIs. Dual-mode target:

- `backend=crs` — legacy alias for the cliproxy-compatible admin API backend
- `backend=local` — file/SQLite seat state, no Docker

### Build sequence

| Step | Deliverable |
|------|-------------|
| A | Local seat-state backend for policy daemons (no relay required) |
| B | Plugin-owned Grok OAuth proxy (today’s `:31845` logic) |
| C | Optional OpenAI-compat gateway replacing `:3005` for most harnesses |
| D | Docs: migrate legacy `CRS_BASE_URL` aliases → gateway; cliproxy optional advanced |

### License

Historical relay lineage on this box is **MIT**. Cherry-pick with attribution;
prefer reimplemented policy + small gateway over vendoring deprecated relay
monorepos (Redis/Grafana/admin SPA out of default install).

### Non-goals

- Shipping Redis/Prometheus/Grafana as required deps
- Multi-tenant relay admin SPA
- Claiming Grok seats live inside a Claude-style relay account table

## Risks

| Risk | Mitigation |
|------|------------|
| Big-bang rewrite of Claude | Keep Claude engines; wrap first |
| Provider util APIs differ | Best-effort util; never fake numbers |
| Grok CF blocks on reauth | Same residential cascade as captcha/oauth for Claude |
| Secret sprawl | Provider-scoped vault; never commit secrets |
| Alias churn | Keep `/ops:rotate` for one major version |

## Non-goals (immediate)

- Full deprecated-relay fork for every vendor
- Deleting host trees before parity proof
- Hard-requiring a relay

## Related

- `docs/ops/HOST-VS-PLUGIN-ROTATE-GAP.md`
- `scripts/account-rotation/CAPTCHA-CASCADE.md`
- Skills: `ops-accounts` (canonical), `ops-rotate` / `ops-rotate-setup` (aliases)
- Local plan: `Projects/memory/plans/2026-07-30T1557Z-public-ops-plugin-only.md`
