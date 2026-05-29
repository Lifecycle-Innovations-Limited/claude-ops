# pocket-env-broker

A peer-authenticated secrets broker that lets **restricted** pocket workers request
specific allowlisted secrets at runtime — instead of the all-or-nothing choice
between "worker inherits every secret" and "worker has none".

## Why

The pocket executor spawns autonomous `claude --bg` workers as a restricted unix
user (`POCKET_WORKER_USER`, e.g. `pocket-worker`) that deliberately does not
inherit the orchestrator's secret environment (see the worker-isolation change in
2.11.9). That cap is good for blast-radius, but some legitimate tasks need a
specific secret (e.g. a Gmail account id). The broker is the supervising
orchestrator's controlled way to hand out **one named, allowlisted** secret at a
time, over an authenticated channel, with an audit trail.

## Architecture

```
restricted worker (uid: pocket-worker)        orchestrator (privileged uid)
┌───────────────────────────────┐             ┌──────────────────────────────┐
│ claude --bg task              │  AF_UNIX    │ pocket-env-broker.py (daemon) │
│   $ pocket-env GOG_ACCOUNT  ──┼──socket────▶│  1. SO_PEERCRED → uid check   │
│        ▲           value      │             │  2. allowlist (default-deny)  │
│        └───────────────────────┼◀───────────┤  3. value from OWN env        │
└───────────────────────────────┘             │  4. append audit record       │
                                               └──────────────────────────────┘
```

- **Transport:** unix-domain socket. Secrets are returned over the socket only —
  they are never written to disk.
- **Peer auth:** the broker reads the caller's uid with `SO_PEERCRED` and rejects
  any uid that is not the worker user's. Filesystem perms on the socket
  (group/ACL) gate who can even connect; `SO_PEERCRED` is the application-layer
  backstop.
- **Policy:** `env-broker-policy.json` → `{"allow": ["VAR", ...]}`. **Default-deny**
  — a missing or malformed policy grants nothing. A variable is only returned if
  it is both in the allowlist *and* present in the broker's environment.
- **Secret source:** the broker's own process environment, populated the same way
  the executor's secrets are (e.g. an `EnvironmentFile` / a wrapper that sources
  `~/.mcp-secrets.env`). The broker never reads a secrets file itself.
- **Audit:** every request — granted or denied — is appended to
  `env-broker-audit.log` as `{ts, uid, var, task_id, worker_id, decision}`.

## Components

| File | Role |
|------|------|
| `scripts/pocket-env-broker.py` | the daemon (server) — runs as the orchestrator user |
| `scripts/pocket-env` | worker-side client CLI — on the worker's PATH |
| `scripts/env-broker-policy.example.json` | allowlist template (copy + edit) |
| `scripts/systemd/pocket-env-broker.service.template` | systemd unit template |

## Worker usage

```bash
# In a worker task (runs as the restricted user):
ACCOUNT=$(pocket-env GOG_ACCOUNT) || { echo "no access to GOG_ACCOUNT"; exit 1; }
```

`pocket-env` prints the value to stdout with no trailing newline (so command
substitution captures it exactly), or exits non-zero and prints the denial reason
to stderr.

## Configuration (env)

| Variable | Default | Used by |
|----------|---------|---------|
| `POCKET_ENV_BROKER_SOCK` | `$POCKET_STATE_DIR/env-broker.sock` | broker + client |
| `POCKET_ENV_BROKER_POLICY` | `$POCKET_STATE_DIR/env-broker-policy.json` | broker |
| `POCKET_ENV_BROKER_AUDIT` | `$POCKET_STATE_DIR/env-broker-audit.log` | broker |
| `POCKET_STATE_DIR` | `/var/lib/pocket-pipeline` | broker + client |
| `POCKET_WORKER_USER` | `pocket-worker` | broker (uid to authorize) |
| `POCKET_ENV_BROKER_HEALTH` | `$POCKET_STATE_DIR/env-broker-health.json` | broker (metrics snapshot) |
| `POCKET_ENV_BROKER_NOTIFY_CMD` | _(unset — off)_ | broker (alert command; alert text appended as final arg) |
| `POCKET_ENV_BROKER_NOTIFY_COOLDOWN` | `300` | broker (per-event rate-limit, seconds) |

## Security notes

- **Never** add high-blast-radius secrets (AWS keys, SSH material, Doppler service
  tokens) to the allowlist. The point of the worker isolation is that those stay
  out of worker reach; the broker is for narrowly-scoped, lower-sensitivity values.
- The socket is `0660`; provisioning grants the worker user connect access via
  group or ACL. Even if a third user could connect, `SO_PEERCRED` denies them.
- Review `env-broker-audit.log` to see exactly which secrets workers have pulled.

## Observability

The broker is observable at three levels:

1. **Live status** — `pocket-env-broker --status` (add `--json` for machine output)
   prints request counters (`requests / granted / denied / unknown_var /
   uid_rejected`), last-request time, and the most recent denials. Backed by a
   metrics snapshot the broker rewrites after every request at
   `env-broker-health.json` (`POCKET_ENV_BROKER_HEALTH`).
2. **Ops dashboard** — `/ops:ops-status` shows an `Env-broker` line with request
   and denial counts, and raises a `⚠` anomaly when there are any **uid
   rejections** (a non-worker uid attempting to pull secrets — a probing signal).
3. **Audit + logs** — `env-broker-audit.log` (every grant/deny, append-only JSON)
   and the daemon's structured stderr via `journalctl -u pocket-env-broker`.
4. **Push notifications (opt-in)** — set `POCKET_ENV_BROKER_NOTIFY_CMD` to a
   command (e.g. a Telegram self-send helper) and the broker fires it with an
   alert message on a **uid rejection** or a **not-allowed denial** — the
   prompt-injection probing signals. Rate-limited per event by
   `POCKET_ENV_BROKER_NOTIFY_COOLDOWN` (default 300s) so it can't spam. The
   command receives the alert text as its final argument; delivery is best-effort
   and never blocks request handling. Because the broker runs as the orchestrator
   user, wiring this to the operator's own chat is an operational self-notification
   (exempt from the per-message outbound-comms approval gate).

The health snapshot carries an `anomaly: true` flag whenever denials or uid
rejections have occurred, so downstream monitors can alert on it without parsing
counters themselves.
