---
name: ops-unifi
description: UniFi network command center. Full control across the three official UniFi APIs — Site Manager (cloud multi-site oversight), Network Integration (local per-console device/client control), and Protect Integration (cameras/NVR). Plus a predict mode that flags WAN/AP/client anomalies before they page you. Configure once via /ops:setup.
argument-hint: "[status|sites|devices|clients|isp|sdwan|protect|snapshot|restart|block|predict|setup]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Grep
  - Glob
  - Agent
  - TeamCreate
  - SendMessage
  - AskUserQuestion
  - WebFetch
  - WebSearch
effort: medium
maxTurns: 30
---

# OPS ► UNIFI — Network Command Center (UniFi OS)

Control Ubiquiti UniFi infrastructure across **all three official APIs**:

1. **Site Manager API** (cloud, `api.ui.com`) — fleet-wide oversight: every console, site, device, and ISP/WAN health metric across all your UniFi deployments in one call. Read-first (write endpoints roll out per-key).
2. **Network Integration API** (local, `https://<gateway>/proxy/network/integration/v1`) — per-console control: list/restart devices, list/block clients, manage hotspot vouchers, read live statistics.
3. **Protect Integration API** (local, `https://<host>/proxy/protect/integration/v1`) — cameras, NVR, sensors, lights, chimes, viewers: list, snapshot, stream, and patch device settings; real-time WebSocket event stream.

This skill is **curl-native** (works headless, no SDK dependency) — consistent with the rest of `/ops:*`. If you want a richer natural-language surface, an optional community MCP can be enabled (see **Optional MCP path** at the end); the skill never depends on it.

## Runtime Context

Before executing, load available context:

1. **Preferences**: Read `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json`
   - `timezone` — display all timestamps in user's timezone
   - `home_network.unifi_site_manager_api_key` — cloud API key from unifi.ui.com (read-only multi-site)
   - `home_network.unifi_local_gateway_url` — e.g. `https://192.168.1.1` (UniFi OS console LAN address)
   - `home_network.unifi_local_api_key` — Network Integration API key (generated in the Network app)
   - `home_network.unifi_protect_url` — Protect host (often same as gateway); defaults to gateway URL
   - `home_network.unifi_protect_api_key` — Protect Integration API key (defaults to local key if unset — one UniFi OS key often works for both)

2. **Daemon health**: Read `${CLAUDE_PLUGIN_DATA_DIR}/daemon-health.json`
   - If `action_needed` is not null → surface it before running any UniFi operations
   - On any auth/connectivity failure in this skill, write `action_needed` back to daemon-health.json

3. **Secrets**: Resolve UniFi credentials via userConfig → env vars → Doppler → keychain (see Phase 1 below)

## CLI/API Reference

### A. Site Manager API — CLOUD (multi-site oversight)

Base URL: `https://api.ui.com`
Auth header: `X-API-Key: ${UNIFI_SM_KEY}`
Key generation: **unifi.ui.com → (top-right account) → Settings → Control Plane → Integrations → Create API Key** (or developer.ui.com). Key is shown once — store it. Currently read-scoped for most keys; a 429 means you hit the rate limit (back off).

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/hosts` | GET | List every UniFi OS console (host) on the account |
| `/v1/hosts/{id}` | GET | One console: model, fw, IP, owner, state |
| `/v1/sites` | GET | List all sites across all hosts |
| `/v1/devices` | GET | List all adopted devices across all hosts |
| `/v1/isp-metrics/{type}` | GET | ISP/WAN metrics, `type` = `5m` or `1h` (latency, downtime, throughput) |
| `/v1/isp-metrics/{type}/query` | POST | Query ISP metrics for specific sites/time ranges |
| `/v1/sd-wan-configs` | GET | List SD-WAN configurations |
| `/v1/sd-wan-configs/{id}` | GET | SD-WAN config detail |
| `/v1/sd-wan-configs/{id}/status` | GET | SD-WAN config deployment status |

Pagination: responses carry `nextToken`; pass `?pageSize=N&nextToken=…`.

### B. Network Integration API — LOCAL (per-console control)

Base URL: `${UNIFI_LOCAL_URL}/proxy/network/integration/v1`
Auth header: `X-API-Key: ${UNIFI_LOCAL_KEY}`
Key generation: **UniFi Network app → Settings → Control Plane → Integrations → Create API Key** (UniFi OS consoles only — UDM/UDR/UCG/UX/UDW/UCG-Ultra/UniFi OS Server; the legacy self-hosted Network app does **not** support API keys).
TLS: local consoles use a self-signed cert → all curl calls use `-k`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/info` | GET | Network application version + metadata |
| `/sites` | GET | List sites on this console |
| `/sites/{siteId}/devices` | GET | List adopted devices (APs, switches, gateways) |
| `/sites/{siteId}/devices/{deviceId}` | GET | Device detail (uptime, fw, ports, radios) |
| `/sites/{siteId}/devices/{deviceId}/statistics/latest` | GET | Latest device stats (throughput, CPU, mem, uplink) |
| `/sites/{siteId}/devices/{deviceId}/actions` | POST | Device action — `{"action":"RESTART"}` |
| `/sites/{siteId}/clients` | GET | Connected clients (wired + wireless) |
| `/sites/{siteId}/clients/{clientId}` | GET | Client detail (IP, MAC, AP, signal, usage) |
| `/sites/{siteId}/clients/{clientId}/actions` | POST | Client action — `{"action":"BLOCK"}` / `{"action":"UNBLOCK"}` |
| `/sites/{siteId}/vouchers` | GET | Hotspot vouchers |
| `/sites/{siteId}/vouchers` | POST | Create voucher(s) |
| `/sites/{siteId}/vouchers/{voucherId}` | DELETE | Revoke a voucher |

### C. Protect Integration API — LOCAL (cameras / NVR)

Base URL: `${UNIFI_PROTECT_URL}/proxy/protect/integration/v1`
Auth header: `X-API-Key: ${UNIFI_PROTECT_KEY}`
Key generation: **UniFi OS → Protect → Settings → Control Plane → Integrations → Create API Key** (or reuse the UniFi OS console key). `-k` for self-signed cert.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/meta/info` | GET | NVR + Protect application info/version |
| `/nvrs` | GET | NVR(s) detail (storage, recording mode) |
| `/cameras` | GET | List cameras |
| `/cameras/{id}` | GET | Camera detail (state, fw, recording, motion zones) |
| `/cameras/{id}` | PATCH | Update camera settings (partial JSON — only changed fields) |
| `/cameras/{id}/snapshot?highQuality=true` | GET | JPEG snapshot (binary) |
| `/cameras/{id}/rtsps-stream` | GET/POST | Retrieve / manage the RTSPS stream URL |
| `/sensors` | GET | UniFi Protect sensors |
| `/lights` | GET | Protect smart lights (`PATCH /lights/{id}` to control) |
| `/chimes` | GET | Chimes (`PATCH /chimes/{id}`) |
| `/viewers` | GET | Protect viewers (`PATCH /viewers/{id}` to change live view) |

Real-time: WebSocket `wss://${UNIFI_PROTECT_URL#https://}/proxy/protect/integration/v1/subscribe/devices` (and `/subscribe/events`) streams state changes — used only for live-watch flows, not the default dashboard.

---

## Phase 1 — Resolve credentials

Resolve UniFi credentials in this order (userConfig → env → Doppler → keychain). The three surfaces are independent — any subset may be configured; the skill degrades gracefully and only runs the surfaces it has keys for.

```bash
PREFS_PATH="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json"

# 1. Plugin userConfig (preferences.json → home_network.*)
UNIFI_SM_KEY=$(jq -r '.home_network.unifi_site_manager_api_key // empty' "$PREFS_PATH" 2>/dev/null)
UNIFI_LOCAL_URL=$(jq -r '.home_network.unifi_local_gateway_url // empty' "$PREFS_PATH" 2>/dev/null)
UNIFI_LOCAL_KEY=$(jq -r '.home_network.unifi_local_api_key // empty' "$PREFS_PATH" 2>/dev/null)
UNIFI_PROTECT_URL=$(jq -r '.home_network.unifi_protect_url // empty' "$PREFS_PATH" 2>/dev/null)
UNIFI_PROTECT_KEY=$(jq -r '.home_network.unifi_protect_api_key // empty' "$PREFS_PATH" 2>/dev/null)

# 2. Environment variables (override userConfig if set)
[ -n "$UNIFI_SM_KEY" ]      || UNIFI_SM_KEY="${UNIFI_SITE_MANAGER_API_KEY:-${UNIFI_SM_KEY:-}}"
[ -n "$UNIFI_LOCAL_URL" ]   || UNIFI_LOCAL_URL="${UNIFI_LOCAL_GATEWAY_URL:-${UNIFI_LOCAL_URL:-}}"
[ -n "$UNIFI_LOCAL_KEY" ]   || UNIFI_LOCAL_KEY="${UNIFI_LOCAL_API_KEY:-${UNIFI_LOCAL_KEY:-}}"
[ -n "$UNIFI_PROTECT_URL" ] || UNIFI_PROTECT_URL="${UNIFI_PROTECT_URL:-}"
[ -n "$UNIFI_PROTECT_KEY" ] || UNIFI_PROTECT_KEY="${UNIFI_PROTECT_API_KEY:-${UNIFI_PROTECT_KEY:-}}"

# 3. Doppler fallback (project: unifi)
if command -v doppler &>/dev/null; then
  [ -z "$UNIFI_SM_KEY" ]    && UNIFI_SM_KEY=$(doppler secrets get UNIFI_SITE_MANAGER_API_KEY --project unifi --plain 2>/dev/null)
  [ -z "$UNIFI_LOCAL_URL" ] && UNIFI_LOCAL_URL=$(doppler secrets get UNIFI_LOCAL_GATEWAY_URL --project unifi --plain 2>/dev/null)
  [ -z "$UNIFI_LOCAL_KEY" ] && UNIFI_LOCAL_KEY=$(doppler secrets get UNIFI_LOCAL_API_KEY --project unifi --plain 2>/dev/null)
  [ -z "$UNIFI_PROTECT_KEY" ] && UNIFI_PROTECT_KEY=$(doppler secrets get UNIFI_PROTECT_API_KEY --project unifi --plain 2>/dev/null)
fi

# 4. Keychain fallback (macOS)
[ -z "$UNIFI_SM_KEY" ]    && UNIFI_SM_KEY=$(security find-generic-password -s "unifi-site-manager-key" -w 2>/dev/null)
[ -z "$UNIFI_LOCAL_KEY" ] && UNIFI_LOCAL_KEY=$(security find-generic-password -s "unifi-local-key" -w 2>/dev/null)
[ -z "$UNIFI_PROTECT_KEY" ] && UNIFI_PROTECT_KEY=$(security find-generic-password -s "unifi-protect-key" -w 2>/dev/null)

# 5. Sensible defaults — Protect commonly shares host + key with the Network console
[ -z "$UNIFI_PROTECT_URL" ] && UNIFI_PROTECT_URL="$UNIFI_LOCAL_URL"
[ -z "$UNIFI_PROTECT_KEY" ] && UNIFI_PROTECT_KEY="$UNIFI_LOCAL_KEY"
```

If **none** of (`UNIFI_SM_KEY`) nor (`UNIFI_LOCAL_URL` + `UNIFI_LOCAL_KEY`) is resolvable, tell the user and exit gracefully:

```
No UniFi credentials configured. Run /ops:setup --section network to configure your UniFi Site Manager and/or local console API keys.
```

Write `action_needed: "configure_unifi"` to `daemon-health.json` and exit.

Set helpers used by all phases below:

```bash
SM_BASE="https://api.ui.com"
NET_BASE="${UNIFI_LOCAL_URL}/proxy/network/integration/v1"
PRO_BASE="${UNIFI_PROTECT_URL}/proxy/protect/integration/v1"

# Site Manager (cloud) call
sm_call() {  # sm_call <path> [method] [body]
  [ -z "$UNIFI_SM_KEY" ] && { echo '{"error":"no site-manager key"}'; return 1; }
  curl -s --max-time 15 -X "${2:-GET}" \
    -H "X-API-Key: ${UNIFI_SM_KEY}" -H "Accept: application/json" -H "Content-Type: application/json" \
    ${3:+--data "$3"} "${SM_BASE}$1"
}

# Network Integration (local) call — self-signed cert ⇒ -k
net_call() {  # net_call <path> [method] [body]
  [ -z "$UNIFI_LOCAL_URL" ] || [ -z "$UNIFI_LOCAL_KEY" ] && { echo '{"error":"no local network creds"}'; return 1; }
  curl -sk --max-time 12 -X "${2:-GET}" \
    -H "X-API-Key: ${UNIFI_LOCAL_KEY}" -H "Accept: application/json" -H "Content-Type: application/json" \
    ${3:+--data "$3"} "${NET_BASE}$1"
}

# Protect Integration (local) call — self-signed cert ⇒ -k
pro_call() {  # pro_call <path> [method] [body]
  [ -z "$UNIFI_PROTECT_URL" ] || [ -z "$UNIFI_PROTECT_KEY" ] && { echo '{"error":"no protect creds"}'; return 1; }
  curl -sk --max-time 12 -X "${2:-GET}" \
    -H "X-API-Key: ${UNIFI_PROTECT_KEY}" -H "Accept: application/json" -H "Content-Type: application/json" \
    ${3:+--data "$3"} "${PRO_BASE}$1"
}
```

---

## Phase 2 — Route by argument

| Input | Action |
| ----- | ------ |
| (empty)                                       | Cross-surface status dashboard |
| status, dashboard                             | Cross-surface status dashboard |
| sites, hosts, consoles                        | Site Manager: hosts + sites |
| devices, device, aps, switches, gateway       | Network: devices per site |
| clients, who, wifi, online                    | Network: clients |
| isp, wan, internet, uptime, latency           | Site Manager: ISP/WAN metrics |
| sdwan, sd-wan                                  | Site Manager: SD-WAN configs |
| protect, cameras, camera, nvr, surveillance   | Protect: cameras + NVR |
| snapshot <camera>                             | Protect: camera snapshot |
| restart, reboot <device>                      | Network: device restart (CONFIRM — Rule 5) |
| block <client> / unblock <client>             | Network: client block/unblock (CONFIRM — Rule 5) |
| voucher [create\|list\|revoke]                | Network: hotspot vouchers |
| predict, insights, anomaly, health            | Predict / insights (cross-surface anomaly scan) |
| setup, configure, init, token                 | Setup flow |

Pick the first site automatically when a surface needs a `siteId` and only one site exists; otherwise present sites via `AskUserQuestion` (max 4, Rule 1) and let the user choose.

---

## STATUS (default — empty argument)

One-screen network dashboard. Probe Site Manager (hosts/devices/ISP), Network (devices/clients), and Protect (cameras) in parallel — separate Bash calls or the Agent Team in **Agent Teams support** below — then render.

```bash
# Site Manager fleet view
sm_call "/v1/hosts" | jq '{hosts: ([.data // [] | .[] | {name:.reportedState.hostname, model:.reportedState.hardware.shortname, state:.reportedState.state}])}'
sm_call "/v1/devices" | jq '{fleet_devices: ([.data // [] | .[].devices // [] ] | add | length)}'

# Local network
SITE=$(net_call "/sites" | jq -r '.data[0].id // .data[0].internalReference // empty')
net_call "/sites/${SITE}/devices" | jq '{net_devices: (.data|length), online: ([.data[]|select(.state=="ONLINE")]|length)}'
net_call "/sites/${SITE}/clients" | jq '{clients: (.data|length)}'

# Protect
pro_call "/cameras" | jq '{cameras: length, recording: ([.[]|select(.isRecording==true)]|length), offline: ([.[]|select(.state!="CONNECTED")]|length)}'
```

Desktop render:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► UNIFI — [host-name] — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CONSOLE      [model]  ([fw])   state: [online]
SURFACES     site-manager [✓]  network [✓]  protect [✓]

NETWORK      [N online] / [N devices]   ([N] offline)
CLIENTS      [N connected]   (wired [N] · wifi [N])
WAN / ISP    [status]  latency [Nms]  uptime [N.NN%] (24h)

PROTECT      [N cameras]  [N recording]  [N offline]

ALERTS       [N]
  [device] offline / [WAN] degraded / [camera] disconnected   (if any)

──────────────────────────────────────────────────────
 [s] sites   [d] devices   [c] clients   [i] isp
 [p] protect   [x] predict   [setup] credentials
──────────────────────────────────────────────────────
```

Mobile mode (`$SSH_CONNECTION` set or `$OPS_MOBILE=1`): plain text, 5–8 lines, no banners.

```
unifi: [N]/[N] net devices online · [N] clients.
wan: [status] · latency [N]ms · uptime [N.NN]%.
protect: [N] cams ([N] recording, [N] offline).
alerts: [N].
next: /ops-unifi devices | isp | protect | predict
```

If any surface key is missing, show that surface as `[—]` and skip its calls (never error the whole dashboard on one missing key). If a device/WAN/camera alert is critical, surface it at the top and suggest piping to `/ops:ops-comms` (Rule 6 — stage draft, never auto-send).

---

## SITES / HOSTS

Site Manager fleet inventory — every console and site across the account.

```bash
sm_call "/v1/hosts" | jq -r '.data[]? | "• \(.reportedState.hostname // .id)  \(.reportedState.hardware.shortname // "?")  \(.reportedState.state // "?")  ip=\(.ipAddress // "?")"'
sm_call "/v1/sites" | jq -r '.data[]? | "  site: \(.meta.name // .name // .siteId)  devices=\(.statistics.counts.totalDevice // "?")  clients=\(.statistics.counts.totalClient // "?")"'
```

Render grouped by host → its sites, with model/fw/state and device+client counts. Footer offers `[d] drill into a site's devices`.

---

## DEVICES

Local Network device inventory for a site — APs, switches, gateways with live state.

```bash
SITE="${CHOSEN_SITE}"
net_call "/sites/${SITE}/devices" | jq -r '.data[]? | "• \(.name)  \(.model // .shortname)  \(.state)  fw=\(.firmwareVersion // "?")  uplink=\(.uplink.type // "?")"'
# Drill: latest stats for one device
net_call "/sites/${SITE}/devices/${DEVICE_ID}/statistics/latest" | jq '{cpu:.cpuUtilizationPct, mem:.memoryUtilizationPct, rxMbps:(.uplink.rxRateBps/1e6), txMbps:(.uplink.txRateBps/1e6), uptime_s:.uptimeSec}'
```

Filter from argument: `devices aps` → `type=="uap"`/class AP; `devices switches` → `usw`; `devices gateway` → `ugw`/`udm`. Render grouped by type, flag any `state != "ONLINE"`. Offer `[a] restart a device` (→ goes through the confirmed RESTART path below).

---

## CLIENTS

Connected clients on a site, wired + wireless.

```bash
SITE="${CHOSEN_SITE}"
net_call "/sites/${SITE}/clients" | jq -r '.data[]? | "• \(.name // .hostname // .mac)  \(.ipAddress // "?")  \(if .uplinkDeviceId then "wifi@"+(.connectedToName//"?") else "wired" end)  rx=\(.rxBytes // 0)"'
```

Sort by usage; flag clients with weak signal (`.signal < -70`) or high retries. Footer offers `[b] block a client` / `[u] unblock` (confirmed path below).

---

## ISP / WAN

Site Manager ISP metrics — WAN latency, packet loss, downtime, throughput. The backbone of **predict** mode.

```bash
# 1h-granularity metrics for the trailing window
sm_call "/v1/isp-metrics/1h" | jq '{
  sites: [.data[]? | {
    site: (.siteId // .meta.name),
    avgLatencyMs: (.metrics.latencyAvgMs // null),
    maxLatencyMs: (.metrics.latencyMaxMs // null),
    packetLossPct: (.metrics.packetLossPct // null),
    downtimeSec: (.metrics.downtimeSec // 0),
    rxMbps: (.metrics.download.avgMbps // null),
    txMbps: (.metrics.upload.avgMbps // null)
  }]
}'
```

Render per-site WAN health. Flag: `downtimeSec > 0` (outage in window), `packetLossPct > 1`, `avgLatencyMs > 1.5×` the site's trailing baseline. If any flagged → suggest **predict** mode for the full picture and offer to broadcast (Rule 6).

Mobile: `wan [site]: [status] · lat [N]ms · loss [N]% · down [N]s`.

---

## SD-WAN

```bash
sm_call "/v1/sd-wan-configs" | jq -r '.data[]? | "• \(.name)  type=\(.type // "?")  status=\(.deploymentStatus // "?")"'
# Detail + status for one
sm_call "/v1/sd-wan-configs/${CFG_ID}/status" | jq '.'
```

Render config list with deployment status; flag any not `ACTIVE`/`DEPLOYED`.

---

## PROTECT (cameras / NVR)

```bash
pro_call "/meta/info" | jq '{nvr:.name, version:.version, mac:.mac}'
pro_call "/cameras" | jq -r '.[]? | "• \(.name)  \(.type // .modelKey)  state=\(.state)  rec=\(.isRecording)  fw=\(.firmwareVersion // "?")"'
```

Render cameras grouped by state; flag `state != "CONNECTED"` and any with `isRecording == false` that are expected to record. Footer offers `[snapshot]` and `[live]` (WebSocket watch).

### Snapshot

```bash
CAM_ID="${CHOSEN_CAM}"
pro_call "/cameras/${CAM_ID}/snapshot?highQuality=true" > "/tmp/unifi-snap-${CAM_ID}.jpg"
echo "saved /tmp/unifi-snap-${CAM_ID}.jpg ($(wc -c < /tmp/unifi-snap-${CAM_ID}.jpg) bytes)"
```

Report the saved path; the snapshot is binary JPEG — do not inline it.

### Camera settings (PATCH) — CONFIRM (Rule 5)

`PATCH /cameras/{id}` with partial JSON (e.g. toggle recording, mic sensitivity) is state-changing. Show the diff and require `AskUserQuestion` confirmation before firing.

---

## RESTART / BLOCK — confirmed state-changing actions

All of the following REQUIRE `AskUserQuestion` confirmation (Rule 5) showing the exact target before executing, and are appended to the audit log.

```bash
# Restart a device
net_call "/sites/${SITE}/devices/${DEVICE_ID}/actions" POST '{"action":"RESTART"}'

# Block / unblock a client
net_call "/sites/${SITE}/clients/${CLIENT_ID}/actions" POST '{"action":"BLOCK"}'
net_call "/sites/${SITE}/clients/${CLIENT_ID}/actions" POST '{"action":"UNBLOCK"}'
```

After firing, re-read the target once to confirm the new state and report it.

---

## VOUCHER (hotspot)

```bash
net_call "/sites/${SITE}/vouchers" | jq -r '.data[]? | "• \(.code)  \(.durationMinutes)min  used=\(.usedCount)/\(.quota)  expires=\(.expiresAt // "—")"'
# Create (CONFIRM — creates a credential)
net_call "/sites/${SITE}/vouchers" POST '{"count":1,"durationMinutes":1440,"quota":1,"name":"ops"}'
# Revoke (CONFIRM — destructive)
net_call "/sites/${SITE}/vouchers/${VOUCHER_ID}" DELETE
```

Create + revoke require `AskUserQuestion` confirmation.

---

## PREDICT / INSIGHTS (`predict`, `insights`, `anomaly`, `health`)

Cross-surface anomaly scan that surfaces problems *before* they become outages. Pull ISP metrics (Site Manager), device stats (Network), and camera state (Protect), then score against simple thresholds and trailing baselines. Read-only — never changes state.

Signals scored:

1. **WAN degradation** — `downtimeSec > 0` in the trailing window, `packetLossPct > 1`, or `avgLatencyMs > 1.5×` the site's 24h baseline → *WAN trending unhealthy*.
2. **AP/switch flapping** — any device with `state` toggling or `uptimeSec` reset within the window (recent reboot), or CPU/mem `> 85%` sustained → *device under stress*.
3. **Client RF health** — share of wireless clients with `signal < -72 dBm` or high retry rate > 20% → *coverage/interference risk in [zone/AP]*.
4. **Uplink saturation** — any uplink at `> 90%` of negotiated speed sustained → *capacity ceiling near*.
5. **Protect** — any camera `state != CONNECTED`, NVR storage `> 90%`, or expected-recording camera not recording → *surveillance gap*.

```bash
# Pull the three inputs in parallel (or via the Agent Team)
sm_call "/v1/isp-metrics/1h"            > /tmp/unifi_isp.json &
net_call "/sites/${SITE}/devices"       > /tmp/unifi_dev.json &
net_call "/sites/${SITE}/clients"       > /tmp/unifi_cli.json &
pro_call "/cameras"                     > /tmp/unifi_cam.json &
wait
# Score locally with jq (thresholds above) and rank findings CRITICAL→LOW.
```

Render:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► UNIFI ► PREDICT — [host] — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WAN          [healthy | degrading | down]
  ⚠ [site] latency 48ms → trending 2.1× baseline, loss 1.4%

DEVICES      [N] under stress
  ⚠ [AP name] CPU 91% sustained 20m — consider load-balance / reboot

CLIENTS      [N]% wireless below -72 dBm near [AP]
UPLINKS      [N] approaching capacity
PROTECT      [N] surveillance gaps

VERDICT      [all clear | watch | act now]

──────────────────────────────────────────────────────
 Actions:
 a) Restart the flagged device
 b) Broadcast WAN/outage risk to /ops:ops-comms
 c) Drill into a finding
 d) Re-run after [N] min
──────────────────────────────────────────────────────
```

Cross-channel: if VERDICT is `act now` (active WAN outage, NVR full, or a security camera offline), suggest piping to `/ops:ops-comms` (Rule 6 — stage draft, never auto-send) and writing the finding to `daemon-health.json` for `/ops:ops-fires`.

Mobile:

```
unifi predict: [verdict].
wan: [site] [status] (lat [N]ms, loss [N]%).
devices: [N] stressed · clients: [N]% weak RF.
protect: [N] gaps.
next: /ops-unifi devices | isp
```

---

## SETUP FLOW (`setup`, `configure`, `init`, `token`)

Delegate to the central setup wizard with the network section:

```
/ops:setup --section network
```

If the wizard is unavailable, run inline discovery (background per Rule 4):

```bash
# 1. Env vars
printenv UNIFI_SITE_MANAGER_API_KEY UNIFI_LOCAL_GATEWAY_URL UNIFI_LOCAL_API_KEY UNIFI_PROTECT_API_KEY 2>/dev/null
# 2. Shell profiles
grep -hE 'UNIFI_' ~/.zshrc ~/.bashrc ~/.envrc ~/.mcp-secrets.env 2>/dev/null | grep -v '^#'
# 3. Doppler
doppler secrets --project unifi --config prd --json 2>/dev/null | jq -r 'to_entries[] | select(.key|test("UNIFI";"i")) | "\(.key)=(present)"'
# 4. Keychain
security find-generic-password -s "unifi-site-manager-key" 2>/dev/null
# 5. Discover the console on the LAN (mDNS / common gateway IPs)
for ip in 192.168.1.1 192.168.0.1 10.0.0.1; do curl -sk --max-time 2 "https://$ip" -o /dev/null -w "$ip → %{http_code}\n" 2>/dev/null; done
```

Instruct the user where to mint each key (Rule 3 — never silently skip):

1. **Site Manager (cloud)**: unifi.ui.com → Settings → Control Plane → Integrations → Create API Key. Header `X-API-Key`.
2. **Network (local)**: Network app → Settings → Control Plane → Integrations → Create API Key. UniFi OS consoles only.
3. **Protect (local)**: Protect → Settings → Control Plane → Integrations → Create API Key (or reuse the OS key).

Verify each acquired key before writing it to `preferences.json` under `home_network.*`:

```bash
# Site Manager
sm_call "/v1/hosts" | jq -e '.data' >/dev/null && echo "site-manager OK"
# Network
net_call "/sites" | jq -e '.data' >/dev/null && echo "network OK"
# Protect
pro_call "/meta/info" | jq -e '.version' >/dev/null && echo "protect OK"
```

401/403 → key invalid; re-prompt via `AskUserQuestion` (`[Paste new key]`, `[Skip this surface]`).

---

## Agent Teams support

If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, use **Agent Teams** for parallel surface probing:

```
TeamCreate("unifi-team")
Agent(team_name="unifi-team", name="fleet-scanner",   prompt="Site Manager: list hosts + sites + fleet device count + ISP metrics, return structured JSON")
Agent(team_name="unifi-team", name="network-scanner", prompt="Network Integration API for the chosen site: devices (online/offline) + clients + per-device latest stats, return structured JSON")
Agent(team_name="unifi-team", name="protect-scanner", prompt="Protect Integration API: cameras + NVR state + recording status + storage, return structured JSON")
```

If the flag is NOT set, dispatch `ops:unifi-agent` as standard fire-and-forget subagents per surface (site-manager, network, protect).

---

## Phase 3 — Cross-channel integration

After the main output, evaluate cross-channel triggers (suggestions only — never auto-execute Rule-5/Rule-6 actions):

1. **WAN outage / security-camera offline → comms** — stage a `/ops:ops-comms` draft (WhatsApp/Telegram) to emergency contacts; Rule 6 per-message approval.
2. **Predict verdict = act now → fires** — write the finding to `daemon-health.json` under `action_needed`; suggest `/ops:ops-fires`.
3. **Recurring device offline → status** — if a device has been offline across consecutive scans, note it for the next `/ops:ops-go` briefing.
4. **Both Site Manager and local unreachable → status** — write `action_needed: "unifi_unreachable"` to daemon-health and exit with a banner.

---

## Phase 4 — Error handling

| Failure | Behavior |
|---------|----------|
| Site Manager 401 | Cloud key expired/invalid. Tell user to regenerate at unifi.ui.com. |
| Site Manager 429 | Rate-limited. Back off; note "site-manager throttled" and use cached/local data. |
| Local connection refused / timeout | Console unreachable on LAN (off-site or wrong IP). Fall back to Site Manager for read-only fleet view; note `transport=cloud-only`. |
| Local 401 | Network/Protect key invalid. Tell user to regenerate in the app. |
| Protect 404 on integration paths | Protect Integration API not enabled / older firmware. Note "protect integration unavailable". |
| All surfaces fail | Report which failed; write `action_needed: "unifi_unreachable"` to daemon-health; exit with banner. |
| jq missing | Print raw JSON, suggest installing jq. |
| No credentials at all | Exit gracefully with `/ops:setup --section network`. |

Audit every state-changing call (device RESTART, client BLOCK/UNBLOCK, camera PATCH, voucher create/revoke) to `${CLAUDE_PLUGIN_DATA_DIR}/ops-unifi-audit.log` with timestamp, action, target id, and result.

---

## Optional MCP path

The skill is fully self-sufficient via curl. If you want a richer natural-language tool surface, community UniFi MCP servers exist (no official Ubiquiti MCP as of 2026):

- `ry-ops/unifi-mcp-server` — local consoles **and** cloud Site Manager in one server.
- `sirkirby/unifi-mcp` — Network (stable, ~169 tools), Protect, Access.
- `DataKnifeAI/unifi-network-mcp` + `unifi-protect-mcp` — split Network / Protect servers.

To use one, register it via the on-demand MCP registry (`~/.claude/mcp-ondemand.json` → `mcp-toggle.sh on unifi`) and restart Claude Code. Treat these as untrusted third-party code — security-review before install. This skill does not require any of them.

---

## Output style

- Terse-direct. Plain text in mobile mode (Rule 7). Tables only on desktop.
- Always show the hotkey footer (`[s] sites [d] devices [c] clients [i] isp [p] protect [x] predict`) on desktop.
- Use `AskUserQuestion` (max 4 options, Rule 1) for any state-changing action and for site selection when ambiguous.
- Never auto-send messages — always stage drafts per Rule 6.
- Local calls always use `-k` (self-signed cert) and a short `--max-time`; degrade to Site Manager read-only when the console is off-LAN.
