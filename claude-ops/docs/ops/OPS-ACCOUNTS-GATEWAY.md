# ops-accounts-gateway

**Status:** skeleton shipped (`scripts/account-rotation/ops-accounts-gateway.mjs`).

**Goal:** Optional thin OpenAI-compat CLIProxyAPI gateway so fleets that today set
`base_url=http://127.0.0.1:3005` for cliproxy / CLIProxyAPI can point at a plugin-owned process
**without** installing any deprecated relay stack.

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

## CLI

```bash
ops-accounts gateway status|start|path|self-test|config
node scripts/account-rotation/ops-accounts-gateway.mjs --self-test
```

Env: `OPS_ACCOUNTS_GATEWAY_HOST` (127.0.0.1), `OPS_ACCOUNTS_GATEWAY_PORT` (3005),
`OPS_ACCOUNTS_GATEWAY_KEY`, `OPS_ACCOUNTS_STATE_PATH`, `GROK_PROXY_URL`,
`CLAUDE_UPSTREAM_URL`.

## Migration

```
CRS_BASE_URL → OPS_ACCOUNTS_GATEWAY_URL
# harnesses keep OpenAI-compat client shape
```

Deprecated relay stacks remain **advanced-only** for operators who want the old admin UI.

## Build order

1. Dual backend policy + seat-state (**done** in ops-accounts local-backend PR)
2. Plugin Grok proxy (**done**)
3. Gateway skeleton (**this**) — health, auth, grok hop, Claude seat pick + 501
4. Claude vault OAuth hop (next) — wire seat → access token → Anthropic/OpenAI upstream
5. Harness matrix update (`docs/ops` CLI path matrix) — `CRS_BASE_URL` → `OPS_ACCOUNTS_GATEWAY_URL`

## License

If any line is copied from a deprecated MIT relay, keep attribution. Prefer
rewriting the proxy surface over vendoring the monorepo.
