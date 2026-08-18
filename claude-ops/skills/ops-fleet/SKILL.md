---
name: ops-fleet
description: "OPS on-demand: Read-only Claude + CLIProxyAPI fleet dashboard"
argument-hint: '[--once] [--tui] [--all] [--models] [--no-pool] [--no-color]'
allowed-tools:
  - Bash
  - Read
effort: low
maxTurns: 6
---

# OPS ► FLEET

Unified, read-only operational dashboard for:

- local Claude Code sessions and daemon state;
- the configured CLIProxyAPI gateway;
- the effective model catalog grouped by provider;
- the canonical server-side auth-record pool and configured load-balancing policy;
- recent inference-only request, error, and latency signals;
- optional legacy local account-rotator utilization.

It renders state and never changes it. It does not consume the CLIProxyAPI usage queue,
modify configuration, refresh credentials, switch accounts, or restart services.

## Runtime sources

| Layer | Source | Truth represented |
|---|---|---|
| Claude sessions | `claude agents --json` | live interactive/background session census |
| Claude daemon | `claude daemon status` | local supervisor/socket state |
| Gateway | `GET /` | CLIProxyAPI server identity, reachability, latency |
| Models | authenticated `GET /v1/models` | effective client-visible model catalog |
| Pool | sanitized helper/command JSON | enabled/disabled/backup auth records, configured routing/retries, recent inference RED signals |
| Legacy rotator | local state file, opt-in | compatibility utilization only; not canonical gateway pool truth |

A protected model endpoint returning 401/403 means **gateway reachable, auth required** — not
gateway down. A missing pool collector degrades only the pool panel; session and gateway rows
still render.

## Discovery and configuration

### Claude binary

1. `CLAUDE_BIN`
2. `command -v claude`

### CLIProxyAPI base URL

1. `CLIPROXYAPI_BASE_URL`
2. `fleet.cliproxy_base_url` in `$PREFS_PATH`
3. Claude settings `ANTHROPIC_BASE_URL`
4. portable fallback `http://127.0.0.1:8317`

Client authentication uses `CLIPROXY_API_KEY` or `CLIPROXYAPI_API_KEY`. Values are used only as
request headers and are never printed.

### Server-side pool snapshot

Preferred options, in order:

1. `CLIPROXYAPI_POOL_COMMAND` — executable path that prints the sanitized JSON schema below. Shell command strings are rejected.
2. `CLIPROXYAPI_SSH_HOST` plus optional `CLIPROXYAPI_SSH_USER`, or the equivalent
   `fleet.cliproxy_ssh_host` / `fleet.cliproxy_ssh_user` preferences. This invokes
   `bin/ops-fleet-pool-snapshot`, which may sudo only the fixed remote executable
   `${CLIPROXYAPI_REMOTE_HELPER:-/usr/local/libexec/cliproxy-fleet-snapshot}`.

The public plugin intentionally has no real host, IP, username, or account identity defaults.

## Invocation

Run and relay its output verbatim, stripping ANSI for a chat code block:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/ops-fleet $ARGUMENTS
```

Flags:

| Flag | Behavior |
|---|---|
| `--once` / `--snapshot` | single render |
| `--tui` / `--watch [secs]` | live alternate-screen TUI; `q` quits |
| `--all` | include completed sessions when supported by Claude Code |
| `--models` | expand all effective model IDs |
| `--no-pool` / `--no-remote` / `--no-ec2` | skip server-side pool collection |
| `--legacy-accounts` | show local rotator compatibility rows |
| `--no-color` | plain output |

In a real terminal the command defaults to the TUI. Captured stdout defaults to one shot.

## Output contract

Always render the dashboard first in a fenced code block. Then add one concise summary covering:

- total sessions and any blocked/waiting sessions;
- gateway reachability/auth/model count;
- pool enabled/disabled/backup auth-record counts and configured routing strategy;
- recent inference error rate, 429/5xx, and p95 latency;
- any degraded data source.

End with one line noting that the live TUI is
`${CLAUDE_PLUGIN_ROOT}/bin/ops-fleet --tui` in a real terminal.

## Read-only and safety guarantees

- Never query `/v0/management/usage-queue`; it pops telemetry records.
- Never require the remote Management API; lockouts or localhost-only management must not break fleet status.
- Never print client or management keys.
- Never return raw proxy logs or account identities.
- Never treat local rotator state as the canonical remote pool.
- Never report a missing optional collector as gateway failure.
