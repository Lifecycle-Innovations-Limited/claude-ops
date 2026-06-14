---
name: ops-home
description: Smart home command center via Homey Pro. Devices, flows, scenes, energy, climate, presence, alarms. Works via Homey local API (preferred) + Athom cloud API fallback. Configure once via /ops:setup.
argument-hint: '[status|devices|flow|scene|energy|climate|presence|alarm|setup]'
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

# OPS ► HOME — Smart Home Command Center (Homey Pro)

## Runtime Context

Before executing, load available context:

1. **Preferences**: Read `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json`
   - `timezone` — display all timestamps in user's timezone
   - `home_automation.homey_local_url` — e.g. `http://192.168.1.100` (preferred path, faster, no cloud dependency)
   - `home_automation.homey_local_token` — Personal Access Token for local API
   - `home_automation.homey_cloud_token` — Athom OAuth token for cloud fallback
   - `home_automation.homey_id` — Homey ID (cloud resolution)

2. **Daemon health**: Read `${CLAUDE_PLUGIN_DATA_DIR}/daemon-health.json`
   - If `action_needed` is not null → surface it before running any Homey operations
   - On any auth/connectivity failure in this skill, write `action_needed` back to daemon-health.json

3. **Secrets**: Resolve Homey credentials via userConfig → env vars → Doppler → keychain (see Phase 1 below)

## CLI/API Reference

### Homey Pro Web API v3 — LOCAL (preferred)

Base URL: `${HOMEY_LOCAL_URL}` (e.g. `http://192.168.1.100`)

| Endpoint                                                   | Method | Description                                           |
| ---------------------------------------------------------- | ------ | ----------------------------------------------------- |
| `/api/manager/devices/device`                              | GET    | List all devices                                      |
| `/api/manager/devices/device/{id}`                         | GET    | Get one device with capabilities                      |
| `/api/manager/devices/device/{id}/capability/{capability}` | PUT    | Set capability (onoff, dim, target_temperature, etc.) |
| `/api/manager/flow/flow`                                   | GET    | List all flows                                        |
| `/api/manager/flow/flow/{id}/trigger`                      | POST   | Run a flow                                            |
| `/api/manager/zones/zone`                                  | GET    | List zones (rooms)                                    |
| `/api/manager/energy/live`                                 | GET    | Live power draw (watts)                               |
| `/api/manager/energy/report`                               | GET    | Historical energy report (kWh)                        |
| `/api/manager/presence`                                    | GET    | Presence status (who is home)                         |
| `/api/manager/alarms/alarm`                                | GET    | Active alarms (smoke, water, security)                |
| `/api/manager/system`                                      | GET    | Homey system info (firmware, name, uptime)            |

**Auth header (local)**: `Authorization: Bearer ${HOMEY_LOCAL_TOKEN}`

### Athom Cloud API — FALLBACK

Base URL: `https://api.athom.com`

| Endpoint                                   | Method | Description       |
| ------------------------------------------ | ------ | ----------------- |
| `/v2/homey/${HOMEY_ID}/devices`            | GET    | Devices via cloud |
| `/v2/homey/${HOMEY_ID}/flows`              | GET    | Flows via cloud   |
| `/v2/homey/${HOMEY_ID}/flows/{id}/trigger` | POST   | Trigger a flow    |
| `/v2/homey/${HOMEY_ID}/zones`              | GET    | Zones via cloud   |

**Auth header (cloud)**: `Authorization: Bearer ${HOMEY_CLOUD_TOKEN}`

### Common capability strings (Homey)

`onoff`, `dim` (0.0–1.0), `target_temperature`, `measure_temperature`, `measure_humidity`, `measure_power`, `meter_power`, `alarm_motion`, `alarm_smoke`, `alarm_water`, `alarm_contact`, `locked`, `windowcoverings_state`, `light_hue`, `light_saturation`, `volume_set`.

## Agent Teams support

If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, use **Agent Teams** for parallel hub probing:

```
TeamCreate("home-team")
Agent(team_name="home-team", name="devices-scanner", prompt="List all Homey devices, group by zone, return online/offline state and current capabilities")
Agent(team_name="home-team", name="flows-scanner", prompt="List all flows and their last-fired timestamps")
Agent(team_name="home-team", name="energy-scanner", prompt="Pull live power draw + today's kWh + top consumers, flag anomalies vs 7-day baseline")
Agent(team_name="home-team", name="presence-scanner", prompt="Return presence state and active alarms")
```

If the flag is NOT set, dispatch `ops:home-agent` as standard fire-and-forget subagents per scope (devices, flows, energy, presence, alarms).

## Phase 1 — Resolve credentials

Resolve Homey credentials in this order. Local path is preferred (faster, works offline, lower latency):

```bash
PREFS_PATH="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json"

# 1. Plugin userConfig (preferences.json)
HOMEY_LOCAL_URL=$(jq -r '.home_automation.homey_local_url // empty' "$PREFS_PATH" 2>/dev/null)
HOMEY_LOCAL_TOKEN=$(jq -r '.home_automation.homey_local_token // empty' "$PREFS_PATH" 2>/dev/null)
HOMEY_CLOUD_TOKEN=$(jq -r '.home_automation.homey_cloud_token // empty' "$PREFS_PATH" 2>/dev/null)
HOMEY_ID=$(jq -r '.home_automation.homey_id // empty' "$PREFS_PATH" 2>/dev/null)

# 2. Environment variables (override userConfig if set)
[ -n "$HOMEY_LOCAL_URL" ] || HOMEY_LOCAL_URL="${HOMEY_LOCAL_URL:-}"
[ -n "$HOMEY_LOCAL_TOKEN" ] || HOMEY_LOCAL_TOKEN="${HOMEY_LOCAL_TOKEN:-}"
[ -n "$HOMEY_CLOUD_TOKEN" ] || HOMEY_CLOUD_TOKEN="${HOMEY_CLOUD_TOKEN:-${HOMEY_ACCESS_TOKEN:-}}"
[ -n "$HOMEY_ID" ] || HOMEY_ID="${HOMEY_ID:-}"

# 3. Doppler fallback (project: homey-pro)
if [ -z "$HOMEY_LOCAL_TOKEN" ] && command -v doppler &>/dev/null; then
  HOMEY_LOCAL_TOKEN=$(doppler secrets get HOMEY_LOCAL_TOKEN --project homey-pro --plain 2>/dev/null)
fi
if [ -z "$HOMEY_CLOUD_TOKEN" ] && command -v doppler &>/dev/null; then
  HOMEY_CLOUD_TOKEN=$(doppler secrets get HOMEY_ACCESS_TOKEN --project homey-pro --plain 2>/dev/null)
fi
if [ -z "$HOMEY_LOCAL_URL" ] && command -v doppler &>/dev/null; then
  HOMEY_LOCAL_URL=$(doppler secrets get HOMEY_LOCAL_URL --project homey-pro --plain 2>/dev/null)
fi
if [ -z "$HOMEY_ID" ] && command -v doppler &>/dev/null; then
  HOMEY_ID=$(doppler secrets get HOMEY_ID --project homey-pro --plain 2>/dev/null)
fi

# 4. Keychain fallback
[ -z "$HOMEY_LOCAL_TOKEN" ] && HOMEY_LOCAL_TOKEN=$(security find-generic-password -s "homey-local-token" -w 2>/dev/null)
[ -z "$HOMEY_CLOUD_TOKEN" ] && HOMEY_CLOUD_TOKEN=$(security find-generic-password -s "homey-cloud-token" -w 2>/dev/null)
```

If neither a (`HOMEY_LOCAL_URL` + `HOMEY_LOCAL_TOKEN`) pair nor (`HOMEY_CLOUD_TOKEN` + `HOMEY_ID`) is resolvable, tell the user and exit gracefully:

```
No Homey credentials configured. Run /ops:setup --section home to configure your Homey Pro hub.
```

Write `action_needed: "configure_homey"` to `daemon-health.json` and exit.

Set helpers used by all phases below:

```bash
HOMEY_BASE_LOCAL="${HOMEY_LOCAL_URL}/api/manager"
HOMEY_BASE_CLOUD="https://api.athom.com/v2/homey/${HOMEY_ID}"
HOMEY_AUTH_LOCAL="Authorization: Bearer ${HOMEY_LOCAL_TOKEN}"
HOMEY_AUTH_CLOUD="Authorization: Bearer ${HOMEY_CLOUD_TOKEN}"

# homey_call <path> [method] [body] — tries local first, falls back to cloud on failure
homey_call() {
  local path="$1" method="${2:-GET}" body="${3:-}"
  local resp http_code
  if [ -n "$HOMEY_LOCAL_URL" ] && [ -n "$HOMEY_LOCAL_TOKEN" ]; then
    resp=$(curl -s -o /tmp/homey_resp -w "%{http_code}" -X "$method" \
      -H "$HOMEY_AUTH_LOCAL" -H "Content-Type: application/json" \
      ${body:+--data "$body"} \
      "${HOMEY_BASE_LOCAL}${path}" 2>/dev/null)
    if [ "$resp" -ge 200 ] && [ "$resp" -lt 300 ]; then
      cat /tmp/homey_resp; return 0
    fi
  fi
  # Fallback to cloud
  if [ -n "$HOMEY_CLOUD_TOKEN" ] && [ -n "$HOMEY_ID" ]; then
    # Map manager-style local paths to cloud equivalents where possible
    local cloud_path="${path/\/devices\/device/\/devices}"
    cloud_path="${cloud_path/\/flow\/flow/\/flows}"
    cloud_path="${cloud_path/\/zones\/zone/\/zones}"
    curl -s -X "$method" \
      -H "$HOMEY_AUTH_CLOUD" -H "Content-Type: application/json" \
      ${body:+--data "$body"} \
      "${HOMEY_BASE_CLOUD}${cloud_path}"
    return $?
  fi
  echo '{"error":"no homey transport available"}'
  return 1
}
```

---

## Phase 2 — Route by $ARGUMENTS

| Input                                   | Action                |
| --------------------------------------- | --------------------- |
| (empty)                                 | Home status dashboard |
| status, dashboard                       | Home status dashboard |
| devices, device, lights, locks, sensors | Devices manager       |
| flow, flows                             | Trigger / list flows  |
| scene, scenes                           | Trigger scene (alias) |
| energy, power, kwh                      | Energy dashboard      |
| climate, temp, thermostat, heating      | Climate manager       |
| presence, who, home                     | Presence              |
| alarm, alarms, arm, disarm, security    | Alarms / security     |
| health, diagnose, outage                | Health / outage scan  |
| setup, configure, init, token           | Setup flow            |

---

## STATUS (default — empty $ARGUMENTS)

One-screen home dashboard. Run devices/flows/energy/presence/alarms calls in parallel (separate Bash calls or Agent Team), then render.

```bash
# Devices online state
homey_call "/devices/device" | jq '{
  total: (. | length),
  online: ([.[] | select(.available == true)] | length),
  offline: ([.[] | select(.available == false)] | length)
}'

# Flows
homey_call "/flow/flow" | jq '{
  total: (. | length),
  enabled: ([.[] | select(.enabled == true)] | length),
  last_fired: ([.[] | select(.lastExecuted != null)] | sort_by(.lastExecuted) | reverse | .[0] | {name, lastExecuted})
}'

# Live energy
homey_call "/energy/live" | jq '{watts: .totalPower // 0}'

# Presence
homey_call "/presence" | jq '[.[] | select(.present == true) | .name]'

# Alarms (active)
homey_call "/alarms/alarm" | jq '[.[] | select(.active == true)]'

# Zones
homey_call "/zones/zone" | jq '[.[] | .name]'
```

Desktop render:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► HOME — [hub-name] — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HUB          [name]  ([firmware version])
TRANSPORT    local | cloud  ([latency-ms]ms)

DEVICES      [N online] / [N total]   [N offline]
FLOWS        [N enabled] / [N total]
LAST FLOW    [name] fired [N min] ago

POWER        [W] now    [kWh] today
ZONES        [N rooms]
PRESENCE     [name1], [name2]   — home

ALARMS       [N active]
  [type] in [zone] — [device]    (if active)

──────────────────────────────────────────────────────
 [d] devices   [f] flows   [e] energy
 [c] climate   [p] presence   [a] alarms
 /ops:ops-home setup — configure credentials
──────────────────────────────────────────────────────
```

Mobile mode (`$SSH_CONNECTION` set or `$OPS_MOBILE=1`): plain text only, 5–8 lines max, no banners.

```
home: [N]/[N] devices · [W]W now · [kWh] today.
flows: [N] enabled · last "[name]" [N]m ago.
presence: [names] home.
alarms: [N] active.
next: /ops-home devices | flows | energy
```

If `[N] alarms active` is non-zero AND any are critical (smoke/leak/security), surface immediately at top of output and suggest piping to `/ops:ops-comms` to broadcast.

Use `AskUserQuestion` for next-action selection (max 4 options per Rule 1).

---

## DEVICES

List devices, group by zone. Support filter and bulk-toggle.

```bash
# All devices with zone + capabilities
homey_call "/devices/device" | jq '[.[] | {
  id: .id,
  name: .name,
  zone: .zoneName,
  driverId: .driverId,
  class: .class,
  available: .available,
  capabilities: .capabilities,
  capabilityValues: (.capabilitiesObj // {} | to_entries | map({key: .key, value: .value.value}))
}]'

# Zones for grouping
homey_call "/zones/zone" | jq '[.[] | {id: .id, name: .name}]'
```

Apply filter from `$ARGUMENTS`:

- `devices lights` → filter `class == "light"` or capability includes `dim`/`light_hue`
- `devices locks` → filter `class == "lock"` or capability includes `locked`
- `devices climate` → filter capability includes `target_temperature` or `measure_temperature`
- `devices sensors` → filter capability starts with `measure_` or `alarm_`
- `devices --off` → set `onoff=false` on filtered set (REQUIRES `AskUserQuestion` confirmation — destructive)
- `devices --on` → set `onoff=true` on filtered set (REQUIRES `AskUserQuestion` confirmation)

Render grouped by zone:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► HOME ► DEVICES — [filter] — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[ZONE: Living Room]
  [Living Room Lamp]      light    on    dim:0.65    online
  [Sofa Outlet]           socket   off                online
  [Thermostat]            climate  22.5°C → 21.0°C   online

[ZONE: Kitchen]
  [Kitchen Ceiling]       light    on    dim:1.0     online
  ...

OFFLINE
  [Garage Sensor]         sensor                     offline 2h

──────────────────────────────────────────────────────
 Actions:
 a) Toggle a specific device
 b) Turn all [filter] off
 c) Filter by zone
 d) View device capabilities
──────────────────────────────────────────────────────
```

For toggle / set capability:

```bash
# Set onoff
homey_call "/devices/device/${DEVICE_ID}/capability/onoff" PUT '{"value": false}'

# Set dim (0.0 - 1.0)
homey_call "/devices/device/${DEVICE_ID}/capability/dim" PUT '{"value": 0.5}'

# Set target temperature
homey_call "/devices/device/${DEVICE_ID}/capability/target_temperature" PUT '{"value": 21.0}'
```

Bulk operations REQUIRE `AskUserQuestion` confirmation (Rule 5 — destructive-like behavior). Show device count + sample before executing.

---

## FLOWS (and SCENES — alias)

Homey calls scenes "flows". Both `flow` and `scene` arguments route here.

```bash
# List flows
homey_call "/flow/flow" | jq '[.[] | {
  id: .id,
  name: .name,
  enabled: .enabled,
  lastExecuted: .lastExecuted,
  triggerable: .triggerable
}]'
```

If `$ARGUMENTS` includes a flow name (e.g. `flow movie-time`, `scene good-night`), fuzzy-match by name (case-insensitive substring), then trigger:

```bash
FLOW_ID="[matched id]"
homey_call "/flow/flow/${FLOW_ID}/trigger" POST '{}'
```

If multiple flows match, present top 4 via `AskUserQuestion` (Rule 1) and let user pick.

If `flow list` or no flow name provided, render the list with last-fired age.

Common scene names users may try: `movie-time`, `good-night`, `leaving-home`, `coming-home`, `wake-up`, `dinner`, `away`. Fuzzy match handles variations (`goodnight`, `good night`, `night`).

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► HOME ► FLOWS — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ENABLED FLOWS ([N])
  [name]                 fired [N min] ago
  [name]                 never
  ...

DISABLED ([N])
  [name]
  ...

──────────────────────────────────────────────────────
 Actions:
 a) Trigger a flow
 b) Enable / disable a flow
 c) View flow definition
──────────────────────────────────────────────────────
```

Trigger results: confirm `{"success": true}` or surface the error.

---

## ENERGY

Live power draw + today's kWh + top consumers + anomaly detection.

```bash
# Live power
homey_call "/energy/live" | jq '{
  totalWatts: .totalPower // 0,
  byDevice: [.devices // {} | to_entries[] | {id: .key, watts: .value.power}] | sort_by(-.watts) | .[:10]
}'

# Today's energy report
TODAY=$(date -u +"%Y-%m-%d")
homey_call "/energy/report?period=today" | jq '{
  todayKwh: .totalEnergy // 0,
  byZone: .zones // {}
}'

# 7-day baseline for anomaly detection
homey_call "/energy/report?period=last7days" | jq '.dailyAverage // 0'
```

Compute anomaly: if `todayKwh > 1.5 * dailyAverage`, flag as anomaly.

Render:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► HOME ► ENERGY — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

LIVE         [W] right now
TODAY        [kWh]    (baseline: [kWh]/day  → [+/-N%])

TOP CONSUMERS (live)
  1. [device]  [W]
  2. [device]  [W]
  ...

ANOMALY      [yes/no]  [reason if yes]

──────────────────────────────────────────────────────
 Actions:
 a) View 30-day energy trend
 b) Estimate monthly cost
 c) Set energy alert threshold
──────────────────────────────────────────────────────
```

If anomaly detected AND cost projection > threshold, route to `/ops:ops-fires` (see Phase 3).

Mobile mode: 3 lines only — `now [W]W · today [kWh] (baseline [kWh]) · top: [device] [W]W`.

---

## CLIMATE

Per-zone temperature, humidity, target temp, heating mode. Allow setting.

```bash
# Climate devices
homey_call "/devices/device" | jq '[.[] | select(
  (.capabilities | index("target_temperature")) or
  (.capabilities | index("measure_temperature")) or
  (.capabilities | index("measure_humidity"))
) | {
  name: .name,
  zone: .zoneName,
  measure_temperature: (.capabilitiesObj.measure_temperature.value // null),
  target_temperature: (.capabilitiesObj.target_temperature.value // null),
  measure_humidity: (.capabilitiesObj.measure_humidity.value // null),
  mode: (.capabilitiesObj.thermostat_mode.value // null)
}] | group_by(.zone)'
```

If `$ARGUMENTS` is `climate <zone> <temp>` (e.g. `climate bedroom 19`), find the thermostat in that zone and set target temp via `AskUserQuestion` confirmation:

```bash
homey_call "/devices/device/${THERMO_ID}/capability/target_temperature" PUT '{"value": 19.0}'
```

Render:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► HOME ► CLIMATE — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[ZONE: Living Room]
  Temperature   21.5°C   target 21.0°C   mode: heat
  Humidity      45%

[ZONE: Bedroom]
  Temperature   19.0°C   target 19.0°C   mode: heat
  Humidity      52%

──────────────────────────────────────────────────────
 Actions:
 a) Set temperature for a zone
 b) Switch mode (heat/cool/off/auto)
 c) View 24h history
──────────────────────────────────────────────────────
```

---

## PRESENCE

Who is home, based on Homey presence detection.

```bash
homey_call "/presence" | jq '[.[] | {
  id: .id,
  name: .name,
  present: .present,
  lastSeen: .lastSeen
}]'
```

Render:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► HOME ► PRESENCE — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HOME ([N])
  [name]    home since [HH:MM]
  ...

AWAY ([N])
  [name]    left [HH:MM]   away [N]h
  ...

──────────────────────────────────────────────────────
 Actions:
 a) Trigger 'leaving-home' flow
 b) Trigger 'coming-home' flow
 c) Check presence-linked automations
──────────────────────────────────────────────────────
```

If house has been empty for > 1 hour, surface "empty since HH:MM" for cross-reference with `/ops:ops-go` briefing.

---

## ALARMS / SECURITY

Active alarms (smoke, water, motion in armed zone, contact). Allow arm/disarm.

```bash
# Active alarms
homey_call "/alarms/alarm" | jq '[.[] | select(.active == true) | {
  type: .type,
  zone: .zoneName,
  device: .deviceName,
  triggeredAt: .triggeredAt,
  severity: .severity
}]'

# Security mode (fw 13.2.0+: /api/manager/system — NOT /system/info, that returns the Web App HTML)
homey_call "/system" | jq '.securityMode // "unknown"'
```

If `$ARGUMENTS` is `alarm arm` or `alarm disarm`, set security mode (use a flow if Homey exposes it as such — typical Homey setups use a "Security Armed" flow):

```bash
# Find the arm/disarm flow by name
FLOW_ID=$(homey_call "/flow/flow" | jq -r '.[] | select(.name | test("arm|security"; "i")) | .id' | head -1)
homey_call "/flow/flow/${FLOW_ID}/trigger" POST '{}'
```

Arm/disarm REQUIRES `AskUserQuestion` confirmation (Rule 5 — security-impacting action).

Render:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► HOME ► ALARMS — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECURITY MODE     [armed | disarmed | partial]

ACTIVE ALARMS ([N])
  CRITICAL  [smoke]  [zone]  [device]  triggered [time]
  HIGH      [water]  [zone]  [device]  triggered [time]
  MEDIUM    [motion] [zone]  [device]  triggered [time]

NO ACTIVE ALARMS  (if N == 0)

RECENT (last 24h)
  [time]  [type]  [zone]  [device]  — cleared

──────────────────────────────────────────────────────
 Actions:
 a) Arm security
 b) Disarm security
 c) Clear all active alarms
 d) Broadcast critical alarm to /ops:ops-comms
──────────────────────────────────────────────────────
```

**Critical alarm protocol**: If a smoke / water / unauthorized-entry alarm fires, IMMEDIATELY suggest piping a message to `/ops:ops-comms` (WhatsApp + Telegram). Stage the draft and follow Rule 6 (per-message approval). Never auto-send.

Example draft (stage for approval):

```
Channel: WhatsApp + Telegram
To: [user's emergency contacts from preferences.json → emergency_contacts]
Body:
  [HOMEY ALERT] Smoke alarm triggered in [zone] at [time].
  Device: [device name].
  Check the home immediately. Hub: [hub name].
```

Then `AskUserQuestion` with `[Send]` / `[Edit]` / `[Skip]`.

---

## HEALTH (`health`, `diagnose`, `outage`)

Plejd-style mass-outage detector. Groups offline devices by `driverUri` (the source app/integration), then flags any driver where > 30% of its devices are offline as a probable single-driver outage — usually an app crash, expired credentials, or hub-side disconnect inside that integration.

```bash
# Pull devices once, then group/aggregate locally
DEVICES_JSON=$(homey_call "/devices/device")

echo "$DEVICES_JSON" | jq '{
  total: (. | length),
  online: ([.[] | select(.available == true)] | length),
  offline: ([.[] | select(.available == false)] | length),
  drivers: (
    [.[] | {driverUri: (.driverUri // "unknown"), available: .available}]
    | group_by(.driverUri)
    | map({
        driverUri: .[0].driverUri,
        total: length,
        offline: ([.[] | select(.available == false)] | length),
        offline_pct: (([.[] | select(.available == false)] | length) * 100 / length)
      })
    | sort_by(-.offline_pct)
  )
}'
```

Driver short-name: strip `homey:app:` prefix and dotted namespace (e.g. `homey:app:com.plejd` → `com.plejd` → `plejd`). Display logic:

- Total banner: `total devices: N (X online, Y offline)`.
- For each driver where `offline_pct > 30` AND `total >= 2`, surface a `MASS OUTAGE` line with the count, percentage, and a likely-cause hint based on the driver namespace.
- For drivers where `total == 1` AND offline, label as `likely powered off` (single device — not a mass outage).
- For drivers where `offline_pct <= 30`, list under a `partial outage` section only if `offline >= 2`.

Likely-cause hints (keyed by driver namespace substring):

- `plejd`, `hue`, `tradfri`, `lifx`, `tuya`, `smartthings`, `homekit` → `app credentials expired or app crashed. Fix: open Homey app → Apps → [app name] → reconfigure.`
- `chromecast`, `sonos`, `airplay` → `media device dropped off network. Fix: power-cycle device + check Wi-Fi.`
- `zwave`, `zigbee`, `433` → `radio congestion or hub-mesh issue. Fix: check Homey → Settings → Z-Wave/Zigbee mesh.`
- `whisker`, `litter`, `vacuum`, generic single-device → `likely powered off`.
- Unknown → `unknown integration — check the app's status in Homey app → Apps.`

Render (desktop):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► HOME ► HEALTH — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HOMEY ► HEALTH
  total devices: 181 (82 online, 99 offline)

  ⚠ MASS OUTAGE: com.plejd — 96 / 96 offline (100%)
    likely: app credentials expired or app crashed.
    Fix: open Homey app → Apps → Plejd → reconfigure.

  whisker: 1 / 1 offline (100%) — likely powered off
  chromecast: 2 / 4 offline (50%) — media device dropped off network.

──────────────────────────────────────────────────────
 Actions:
 a) Reconfigure flagged app (deep-link to Homey app)
 b) Power-cycle Homey hub
 c) Re-run health scan after fix
 d) Broadcast outage to /ops:ops-comms
──────────────────────────────────────────────────────
```

Mobile mode:

```
home health: 82/181 online.
⚠ plejd: 96/96 offline (app down — reconfigure in Homey app).
whisker: 1/1 offline (powered off).
next: /ops-home devices | reconfigure plejd
```

If any MASS OUTAGE is flagged, surface it at the top of the default STATUS dashboard as well (after the DEVICES line), so the user sees it without needing to run `/ops-home health` explicitly.

Cross-channel: if `MASS OUTAGE` count > 50 devices OR a security-related integration is down (alarm panel, locks, cameras), suggest piping to `/ops:ops-comms` (Rule 6 — stage draft, never auto-send).

---

## SETUP FLOW (`setup`, `configure`, `init`, `token`)

Delegate to the central setup wizard with the home section:

```
/ops:setup --section home
```

If for any reason the wizard is not available, run the inline credential discovery (background per Rule 4):

```bash
# 1. Env vars
printenv HOMEY_LOCAL_URL HOMEY_LOCAL_TOKEN HOMEY_ACCESS_TOKEN HOMEY_CLOUD_TOKEN HOMEY_ID 2>/dev/null

# 2. Shell profiles
grep -hE 'HOMEY_' ~/.zshrc ~/.bashrc ~/.zprofile ~/.envrc 2>/dev/null | grep -v '^#'

# 3. Doppler — homey-pro project
doppler secrets --project homey-pro --config prd --json 2>/dev/null | \
  jq -r 'to_entries[] | select(.key | test("HOMEY"; "i")) | "\(.key)=(present)"'

# 4. Keychain
security find-generic-password -s "homey-local-token" 2>/dev/null
security find-generic-password -s "homey-cloud-token" 2>/dev/null

# 5. Local network scan for Homey Pro (mDNS)
dns-sd -B _homey._tcp 2>/dev/null & sleep 2; kill $! 2>/dev/null

# 6. Existing prefs
jq -r '.home_automation // empty' "$PREFS_PATH" 2>/dev/null
```

If local IP discovered but no token, instruct (Rule 3 — never silently skip):

1. Try `https://developer.athom.com/tools/api` Web API playground to generate a Personal Access Token with scopes `homey`, `homey.device`, `homey.flow`, `homey.zone`.
2. If browser automation is available (Kapture), navigate `https://my.homey.app/account` and automate token creation.
3. Manual fallback: ask user to paste the token via `AskUserQuestion`.

Verify connectivity after acquisition:

```bash
curl -s -H "Authorization: Bearer ${PROVIDED_TOKEN}" \
  "${PROVIDED_LOCAL_URL}/api/manager/system" | jq '{name, firmware: .firmwareVersion}'
```

If 200 — confirm success and write to `preferences.json` under `home_automation.*`. If 401/403 — token invalid, re-prompt via `AskUserQuestion` (`[Paste new token]`, `[Deep hunt — spawn agent]`, `[Skip]`).

---

## Phase 3 — Cross-channel integration

After producing the main output, evaluate cross-channel triggers:

1. **Critical alarm → comms** — If smoke / water leak / unauthorized-entry alarm is active, suggest piping to `/ops:ops-comms` (WhatsApp/Telegram). Stage the draft; follow Rule 6 (per-message approval, never auto-send).

2. **Energy anomaly → fires** — If `todayKwh > 1.5 * 7d_average` AND projected monthly cost spike > $50 / €50, surface as a fire item:
   - Write the anomaly to `daemon-health.json` under `action_needed`
   - Suggest running `/ops:ops-fires`

3. **Presence → morning briefing** — If house has been empty > 1 hour during typical wake hours (06:00–10:00 in user's timezone), suggest cross-referencing `/ops:ops-go`:
   - "Home empty since [HH:MM] — confirm intended for /ops:ops-go briefing?"

4. **Hub offline → status** — If local API fails AND cloud API fails, write `action_needed: "homey_unreachable"` to daemon-health and exit with an action banner.

These integrations are SUGGESTIONS shown in the action footer — never auto-execute Rule-5 / Rule-6 protected actions.

---

## Phase 4 — Error handling

| Failure                            | Behavior                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Local 401                          | Token expired. Tell user to run `/ops:setup --section home`.                                                |
| Local connection refused / timeout | Fall back to cloud API. Log "transport=cloud (local unreachable)".                                          |
| Cloud 401                          | Cloud token expired. Tell user to refresh via Athom OAuth.                                                  |
| Both local + cloud fail            | Report which channel failed; write `action_needed: "homey_unreachable"` to daemon-health; exit with banner. |
| jq missing                         | Print raw JSON, suggest `brew install jq`.                                                                  |
| No credentials at all              | Exit gracefully with `/ops:setup --section home` instruction.                                               |

Audit log every state-changing call (PUT capability, POST flow trigger, arm/disarm) to `${CLAUDE_PLUGIN_DATA_DIR}/ops-home-audit.log` with timestamp, action, device/flow id, result.

---

## Output style

- Terse-direct. Plain text in mobile mode (Rule 7). Tables only on desktop.
- Always show a hotkey footer (`[d] devices [f] flows [e] energy [c] climate [p] presence [a] alarms`) on desktop.
- Use `AskUserQuestion` (max 4 options per Rule 1) for any state-changing action.
- Never auto-send messages — always stage drafts per Rule 6.
