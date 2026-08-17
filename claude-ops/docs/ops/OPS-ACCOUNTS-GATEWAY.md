# ops-accounts-gateway

**Status:** skeleton shipped (`scripts/account-rotation/ops-accounts-gateway.mjs`).

**Goal:** an optional thin OpenAI-compat gateway, owned by this plugin, for
fleets that want one local endpoint in front of their seats.

For pooling several accounts, the supported backend is
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). `rotate.mjs`
writes its seat files directly, `/ops:ops-fleet` reads the pool, and
`/ops:ops-rotate-setup` enrolls a seat. This gateway is a smaller, separate
thing: a local compat shim, not an account pool.

## What it does (skeleton)

| Route / job | Backend |
|-------------|---------|
| `GET /health`, `/v1/health` | Local JSON: seat-state path, picked Claude seat, grok proxy URL |
| `GET /v1/models` | Stub model list |
| `GET /accounts` | Schedulable seats from file seat-state (no secrets) |
| `/grok/*`, `/v1/images/*` | Forward to plugin `grok-cli-auth-proxy` (`GROK_PROXY_URL`, default `:31845`) |
| `POST /v1/chat/completions`, `/v1/messages` | Pick schedulable Claude seat; optional `CLAUDE_UPSTREAM_URL` forward; else **501** with seat id until vault OAuth hop lands |
| API key gate | `OPS_ACCOUNTS_GATEWAY_KEY` → Bearer / `x-api-key` / `api-key` (open if unset) |
| State | File seat-state only — **no Redis** |

## What it must not do

- Admin SPA, multi-tenant product UI
- Grafana / Prometheus stack by default
- Require Docker
- Re-implement Grok seat table inside Claude account rows
- Hold long-lived bearer tokens on behalf of a session

## CLI

```bash
ops-accounts gateway status|start|path|self-test|config
node scripts/account-rotation/ops-accounts-gateway.mjs --self-test
```

Env: `OPS_ACCOUNTS_GATEWAY_HOST` (127.0.0.1), `OPS_ACCOUNTS_GATEWAY_PORT` (3005),
`OPS_ACCOUNTS_GATEWAY_KEY`, `OPS_ACCOUNTS_STATE_PATH`, `GROK_PROXY_URL`,
`CLAUDE_UPSTREAM_URL`.

Clients set `OPS_ACCOUNTS_GATEWAY_URL` and keep their OpenAI-compat shape.

## Build order

1. Dual backend policy + seat-state (**done** in ops-accounts local-backend PR)
2. Plugin Grok proxy (**done**)
3. Gateway skeleton (**this**) — health, auth, grok hop, Claude seat pick + 501
4. Claude vault OAuth hop (next) — wire seat → access token → Anthropic/OpenAI upstream
5. Harness matrix update (`docs/ops` CLI path matrix)
