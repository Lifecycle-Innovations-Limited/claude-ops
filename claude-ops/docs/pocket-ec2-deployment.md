# Pocket pipeline — EC2 deployment on dev-sandbox

Pocket runs entirely on the dev-sandbox EC2 instance (i-0b207951a7dff925d,
m8g.2xlarge). This is an approved exception to the no-EC2 rule; pocket
workloads are too persistent for a laptop.

## Access

Web UI: `https://dev-sandbox.tail6aeed8.ts.net` (Tailscale only — never
exposed via public DNS or Cloudflare). Auth is enforced by the
`Tailscale-User-Login` header injected by `tailscale serve`; only
the configured owner identity is admitted (set via `TAILSCALE_USER` env in the systemd unit).

SSH: `ssh dev-ts` (ec2-user, pem at `~/.ssh/dev-sandbox-2026-05-17.pem`,
Tailscale IP 100.109.217.31).

## Systemd units

Seven services + timers managed by systemd as `ec2-user`:

| Unit | Schedule | Purpose |
|---|---|---|
| `pocket-watcher` | every 5 min | polls Pocket AI MCP for new recordings |
| `pocket-executor` | every 5 min | runs inferred tasks via Claude |
| `pocket-out-queue` | every 2 min | drains out-queue to notification channels |
| `pocket-activity-notifier` | every 5 min | sends WhatsApp/email on task events |
| `pocket-email-bridge` | every 2 min | drains email out-queue |
| `pocket-whatsapp-bridge` | every 2 min | drains WhatsApp out-queue |
| `pocket-ops-ui` | always-on | Flask web UI on 127.0.0.1:7777 |

Unit templates live in `claude-ops/scripts/systemd/`. To reinstall after a
plugin upgrade: `bash claude-ops/scripts/systemd/install-systemd-units.sh`.

## Tailscale serve

`tailscale serve --https=443 http://127.0.0.1:7777` is configured on
dev-sandbox (runs as root via `sudo tailscale serve`). It terminates TLS,
injects the identity header, and proxies to gunicorn. Config persists across
reboots. Verify with `sudo tailscale serve status`.

## State directory

All pipeline state lives in `$HOME/.claude/state/pocket/`. Do not
delete; it holds task cursors, queue files, and notification history.

## Logs

| Log | Path |
|---|---|
| ops-ui stdout | `$HOME/.claude/state/pocket/ops-ui.log` |
| ops-ui stderr | `$HOME/.claude/state/pocket/ops-ui-stderr.log` |
| pocket-watcher | `journalctl -u pocket-watcher` |
| all units | `journalctl -u pocket-*` |

## Mac cleanup

No pocket processes should be running on the Mac. Verify:
```
launchctl list | grep -iE "pocket|whatsapp-bridge"   # expect empty
crontab -l | grep -iE "pocket|ops-cron-pocket"        # expect empty
ps aux | grep pocket-watcher | grep -v grep            # expect empty
```
