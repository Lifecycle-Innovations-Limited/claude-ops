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

Claude already has:

| Layer | Role |
|-------|------|
| Capture | magic-link / browser setup (`rotate.mjs`, `rotate-magic.mjs`) |
| Store | vault / keychain `Claude-Rotation-*` |
| Refresh | proactive token refresh + keepalive |
| Reauth | magic-link-autoloop + captcha cascade (residential egress) |
| Util | 5h / 7d utilization queries |
| Switch | keychain swap / force-rotate |
| Pooling | CLIProxyAPI seat files, written by `rotate.mjs` |

**Every other provider gets the same layers**, with provider-native OAuth and util APIs.

## Provider adapters (required set)

| Provider | OAuth / capture | Reauth | Util | Switch / LB notes |
|----------|-----------------|--------|------|-------------------|
| **Claude (Anthropic)** | magic-link + captcha | magic-link-autoloop | 5h/7d | keychain daemon; CLIProxyAPI for pooling |
| **Grok (xAI SuperGrok)** | device-code + Google (dcli) | residential cascade (EFG SOCKS → Bright Data residential → ISP → mobile) | weekly / 429 | `grok-cli-auth-proxy` round-robin |
| **OpenAI / Codex** | OAuth / API key | codex OAuth bridge | usage API | `codex-rotate` absorbed |
| **CLIProxyAPI (local multi-provider pool)** | per-provider OAuth login flows (browser/device-code) | proxy-internal token refresh | management API (pool-level) | single static binary + flat-file auth-dir; chosen over sub2api (no Postgres/Redis to maintain). Optional local backend: `providers/cliproxy.mjs` adapter reports auth-dir inventory; `bin/ops-accounts` prints per-provider counts + `util <provider>` views. Env overrides: `CLIPROXYAPI_HOME`, `CLIPROXYAPI_AUTH_DIR`, `CLIPROXYAPI_BASE_URL`. |
| **Factory** | provider OAuth / tokens | native reauth | quota-feed-factory patterns | full adapter |
| **Cursor** | Cursor account OAuth | browser/device OAuth | plan limits if available | full adapter |
| **Extensible** | adapter interface | same contract | best-effort | `provider-env` / `provider-router` |

### Grok (do not mis-sell)

No relay owns a SuperGrok account pool. Requests go to **`grok-cli-auth-proxy`** (`GROK_PROXY_URL`), which holds the OAuth seats and round-robins between them. ops-accounts status must show:

1. Proxy reachable or not  
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
| **2** | Claude pooling via CLIProxyAPI | Detect; never required for a single seat |
| **3** | Grok adapter complete (plugin reauth + residential cascade + slot sync + proxy status) | Multi-seat healthy under weekly cap without host-only ops |
| **4** | OpenAI/Codex + Factory adapters | same verbs |
| **5** | Cursor adapter | same verbs |
| **6** | Companions required co-install | done (#726) |
| **7** | Cutover: units → `$CLAUDE_PLUGIN_ROOT`; retire host forks | public plugin only |
| **8** | Optional local OpenAI-compat gateway | `ops-accounts gateway`, no external service required |



## Pooling: CLIProxyAPI only

An earlier design ran a self-hosted relay (claude-relay-service) in front of the
accounts. That is removed. It handed every session a static `cr_` bearer token
pinned into `settings.json`, and the plugin had to keep base URL and token in
lockstep across respawns, overlays and daemons. One half-applied pair meant a
401 loop, and the token itself was long-lived credential material sitting in a
settings file.

CLIProxyAPI replaces it, and is the only supported multi-account path:

- one OAuth seat file per account in its auth dir, refreshed by the proxy
- `rotate.mjs` writes those seat files during a rotation, so there is no separate
  token feed to keep in sync
- `providers/cliproxy.mjs` reports the inventory; `/ops:ops-fleet` shows the pool
- `CLIPROXYAPI_HOME`, `CLIPROXYAPI_AUTH_DIR`, `CLIPROXYAPI_BASE_URL` locate it

What this plugin still owns:

| Job | Where |
|-----|-------|
| Seat policy / schedulable state | `seat-state.mjs`, `seat-policy-tick.mjs` |
| Proactive token refresh | `refresh-tokens.mjs` |
| Grok OAuth seats | `grok-cli-auth-proxy` |
| Optional local OpenAI-compat endpoint | `ops-accounts-gateway.mjs` |

### Non-goals

- Shipping Redis/Prometheus/Grafana as required deps  
- A multi-tenant admin SPA  
- Injecting a long-lived bearer token into `settings.json` for any provider  
- Claiming Grok seats live inside a Claude-style account table  

## Risks

| Risk | Mitigation |
|------|------------|
| Big-bang rewrite of Claude | Keep Claude engines; wrap first |
| Provider util APIs differ | Best-effort util; never fake numbers |
| Grok CF blocks on reauth | Same residential cascade as captcha/oauth for Claude |
| Secret sprawl | Provider-scoped vault; never commit secrets |
| Alias churn | Keep `/ops:rotate` for one major version |

## Non-goals (immediate)

- A relay fork for every vendor  
- Deleting host trees before parity proof  
- Hard-requiring CLIProxyAPI for a single seat  

## Related

- `docs/ops/HOST-VS-PLUGIN-ROTATE-GAP.md`  
- `scripts/account-rotation/CAPTCHA-CASCADE.md`  
- Skills: `ops-accounts` (canonical), `ops-rotate` / `ops-rotate-setup` (aliases)  
- Local plan: `Projects/memory/plans/2026-07-30T1557Z-public-ops-plugin-only.md`  
