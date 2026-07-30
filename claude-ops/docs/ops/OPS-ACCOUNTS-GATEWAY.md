# ops-accounts-gateway (design — not shipped)

**Goal:** Optional thin OpenAI-compat gateway so fleets that today set
`base_url=http://127.0.0.1:3005` (CRS) can point at a plugin-owned process
**without** installing weishaw/claude-relay-service.

## What it must do

| Route / job | Backend |
|-------------|---------|
| `/v1/messages` (Anthropic-shaped) or OpenAI `/v1/chat/completions` for Claude | Pick schedulable Claude seat from `seat-state` + vault OAuth; apply cooldown |
| `/v1/*` Grok | Forward to plugin `grok-cli-auth-proxy` (`:31845`) |
| API key gate | Personal keys (simpler than multi-tenant CRS `cr_` product) |
| State | File/SQLite only by default — **no Redis** |

## What it must not do

- Admin SPA, multi-tenant product UI
- Grafana / Prometheus stack by default
- Require Docker
- Re-implement Grok seat table inside Claude account rows

## Migration

```
CRS_BASE_URL → OPS_ACCOUNTS_GATEWAY_URL
# harnesses keep OpenAI-compat client shape
```

External CRS remains **advanced-only** for operators who want the full CRS admin UI.

## Build order

1. Dual backend policy + seat-state (**done** in ops-accounts local-backend PR)
2. Plugin Grok proxy (**done**)
3. Gateway skeleton (this doc) — next PR
4. Harness matrix update (`docs/ops` CLI path matrix)

## License

If any line is copied from CRS (MIT), keep attribution. Prefer rewrite of the
proxy surface over vendoring the monorepo.
