# Inbox runtime

Loaded from the parent SKILL.md. Follow `ops-rules`. Account discovery and checks
are read-only; inbox triage does not authorize installation, recovery or repairs.

## Ownership and reuse first

Run the host's bounded peer/claim check. Inspect the **existing owner** and actual
recent evidence for each matching resource. One writer per request/thread; no
second scanner for the same already-covered slice. A finished report can be reused
with a fresh live-tail/delta check; an idle label alone is not a finished report.
The addressed parent retains the outcome. Keep the actual task list and existing
executing-machine board honest; do not invent profiles, assignees or transfers.

## Enumerate once

Read scoped preferences and the current tool list, then verify actual reads.
Configuration and MCP names are discovery hints, not proof of account coverage.

- Email: `gog auth list` or the installed account enumerator; include every mailbox
  and known sending alias. Discover user follow-up/action labels once.
- WhatsApp: `ops-wa-accounts --list` when installed; enumerate every agent-enabled
  account with its configured route. Match each live read to its actual account.
  Never hardcode ports or choose whichever service answers first.
- Slack: enumerate every configured workspace with its actual scoped token/tool
  binding. A single successful MCP read proves that workspace only.
- Other channels: identify allowlisted iMessage, user-auth Telegram, configured
  Discord/Notion sources and relevant contact/task/calendar sources.

For each source record read success, partial, failed, not checked, or not configured
plus account, window and tool evidence. A 401 does not prove a healthy authenticated
read; a healthy port does not prove fresh messages or usable account access.

## Freshness without a global barrier

Probe the installed authorized read route for each candidate's sources. Use
read-only live history or an authorized fresh consistent snapshot. The bundled
`ops-inbox-scan` may refresh/enrich stores: inspect its current behavior and host
policy before running it in a read-only pass; never assume the script name is a
safety guarantee. An already-owned fresh report avoids another whole-inbox scan.

A failure on one account is a coverage gap for that account. On a client machine,
use only the existing configured remote route: do not fall back to local desktop
stores, start/pair another bridge, restart clients/gateways, alter permissions,
install integrations or mutate auth/security state to make the inbox scan work.
Escalate the exact diagnostic to the authorized integration owner and continue
other source work. Existing credentials only through the approved secret path;
never print a token or dump environment/vault contents.

## Execution and waits

Independent readers run in parallel after availability is known, within the
machine's concurrency ceiling. Use the native background result/notification
mechanism. Process the first complete candidate while slower readers continue.
Preserve per-source cutoffs for a bounded final delta read, not repeated full sweeps.

Do not create a watcher, heartbeat loop or recurring job during inbox triage.
Reuse an already-authorized verified monitor when applicable. Status cadence is
the host's current cadence, not a skill-specific 30-second timer; deliver actual
results as soon as ready. A genuine approval/input wait preserves the queue and
ends the active turn. No empty keepalives or polling to appear busy.

Load `details.md` for candidate context/approval and `fan-out.md` only when reader
volume requires it. Setup, deployment and integration repair are separate tasks,
not mandatory latency before the first useful draft.
