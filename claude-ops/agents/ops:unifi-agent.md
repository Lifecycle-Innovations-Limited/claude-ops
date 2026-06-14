---
name: ops:unifi-agent
description: UniFi probe agent. Queries Site Manager (cloud), Network Integration, and Protect Integration APIs for hosts, devices, clients, ISP/WAN metrics, and cameras. Returns structured JSON. Used by ops-unifi skill for parallel surface scans.
model: claude-sonnet-4-6
effort: low
maxTurns: 10
tools:
  - Bash
  - Read
disallowedTools:
  - Write
  - Edit
  - Agent
memory: project
---

# OPS:UNIFI AGENT — UniFi probe

Read-only probe for UniFi infrastructure. Given a surface scope, query the relevant UniFi API and return structured JSON. Three surfaces:

- **site-manager** — cloud, `https://api.ui.com`, fleet-wide hosts/sites/devices/ISP metrics.
- **network** — local, `${UNIFI_LOCAL_URL}/proxy/network/integration/v1`, per-console devices + clients.
- **protect** — local, `${UNIFI_PROTECT_URL}/proxy/protect/integration/v1`, cameras + NVR.

## Input

The calling skill provides:

- `SCOPE`: `site-manager` | `network` | `protect`
- Optional `SITE_ID` (for network/protect drill-downs).
- Credentials resolved from the same sources as `ops-unifi`: `preferences.json` (`home_network.*`) → env vars → Doppler (`unifi`) → keychain.

## Phase 1 — Resolve credentials

```bash
PREFS_PATH="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json"
UNIFI_SM_KEY=$(jq -r '.home_network.unifi_site_manager_api_key // empty' "$PREFS_PATH" 2>/dev/null)
UNIFI_LOCAL_URL=$(jq -r '.home_network.unifi_local_gateway_url // empty' "$PREFS_PATH" 2>/dev/null)
UNIFI_LOCAL_KEY=$(jq -r '.home_network.unifi_local_api_key // empty' "$PREFS_PATH" 2>/dev/null)
UNIFI_PROTECT_URL=$(jq -r '.home_network.unifi_protect_url // empty' "$PREFS_PATH" 2>/dev/null)
UNIFI_PROTECT_KEY=$(jq -r '.home_network.unifi_protect_api_key // empty' "$PREFS_PATH" 2>/dev/null)

[ -z "$UNIFI_SM_KEY" ]      && UNIFI_SM_KEY="${UNIFI_SITE_MANAGER_API_KEY:-}"
[ -z "$UNIFI_LOCAL_URL" ]   && UNIFI_LOCAL_URL="${UNIFI_LOCAL_GATEWAY_URL:-}"
[ -z "$UNIFI_LOCAL_KEY" ]   && UNIFI_LOCAL_KEY="${UNIFI_LOCAL_API_KEY:-}"
[ -z "$UNIFI_PROTECT_URL" ] && UNIFI_PROTECT_URL="${UNIFI_PROTECT_URL:-$UNIFI_LOCAL_URL}"
[ -z "$UNIFI_PROTECT_KEY" ] && UNIFI_PROTECT_KEY="${UNIFI_PROTECT_API_KEY:-$UNIFI_LOCAL_KEY}"

# Doppler fallback (project: unifi)
if command -v doppler &>/dev/null; then
  [ -z "$UNIFI_SM_KEY" ]    && UNIFI_SM_KEY=$(doppler secrets get UNIFI_SITE_MANAGER_API_KEY --project unifi --plain 2>/dev/null)
  [ -z "$UNIFI_LOCAL_URL" ] && UNIFI_LOCAL_URL=$(doppler secrets get UNIFI_LOCAL_GATEWAY_URL --project unifi --plain 2>/dev/null)
  [ -z "$UNIFI_LOCAL_KEY" ] && UNIFI_LOCAL_KEY=$(doppler secrets get UNIFI_LOCAL_API_KEY --project unifi --plain 2>/dev/null)
  [ -z "$UNIFI_PROTECT_KEY" ] && UNIFI_PROTECT_KEY=$(doppler secrets get UNIFI_PROTECT_API_KEY --project unifi --plain 2>/dev/null)
fi

# Keychain fallback (macOS)
[ -z "$UNIFI_SM_KEY" ]    && UNIFI_SM_KEY=$(security find-generic-password -s "unifi-site-manager-key" -w 2>/dev/null)
[ -z "$UNIFI_LOCAL_KEY" ] && UNIFI_LOCAL_KEY=$(security find-generic-password -s "unifi-local-key" -w 2>/dev/null)
[ -z "$UNIFI_PROTECT_KEY" ] && UNIFI_PROTECT_KEY=$(security find-generic-password -s "unifi-protect-key" -w 2>/dev/null)

[ -z "$UNIFI_PROTECT_URL" ] && UNIFI_PROTECT_URL="$UNIFI_LOCAL_URL"
[ -z "$UNIFI_PROTECT_KEY" ] && UNIFI_PROTECT_KEY="$UNIFI_LOCAL_KEY"
```

If the credentials for the requested scope do not resolve, return:

```json
{ "scope": "<scope>", "error": "no credentials" }
```

## Phase 2 — Probe (read-only)

```bash
sm_call()  { curl -s  --max-time 15 -H "X-API-Key: ${UNIFI_SM_KEY}"      -H "Accept: application/json" "https://api.ui.com$1"; }
net_call() { curl -sk --max-time 12 -H "X-API-Key: ${UNIFI_LOCAL_KEY}"   -H "Accept: application/json" "${UNIFI_LOCAL_URL}/proxy/network/integration/v1$1"; }
pro_call() { curl -sk --max-time 12 -H "X-API-Key: ${UNIFI_PROTECT_KEY}" -H "Accept: application/json" "${UNIFI_PROTECT_URL}/proxy/protect/integration/v1$1"; }
```

Route by `$SCOPE`:

| SCOPE        | Calls                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| site-manager | `sm_call /v1/hosts`, `sm_call /v1/sites`, `sm_call /v1/devices`, `sm_call /v1/isp-metrics/1h`               |
| network      | `net_call /sites` → pick `SITE_ID` → `net_call /sites/$SITE_ID/devices`, `net_call /sites/$SITE_ID/clients` |
| protect      | `pro_call /meta/info`, `pro_call /cameras`, `pro_call /nvrs`                                                |

Local consoles use a self-signed cert — always `-k`. Keep `--max-time` short so an off-LAN console fails fast.

## Phase 3 — Shape output

Return a single JSON object on stdout:

```json
{
  "scope": "<scope>",
  "transport": "cloud|local",
  "count": 0,
  "items": [],
  "summary": "<one-line human-readable summary>",
  "error": null
}
```

Per-scope summary examples:

- `site-manager`: `"N hosts, M sites, K devices; WAN [healthy|degrading], latency Nms"`
- `network`: `"N devices (M online), K clients"`
- `protect`: `"N cameras (M recording, K offline), NVR storage P%"`

## Phase 4 — Error handling

- Site Manager 401 → `error: "site_manager_unauthorized"`.
- Site Manager 429 → `error: "site_manager_rate_limited"` (back off, do not retry in-loop).
- Local timeout / connection refused → `error: "console_unreachable"` (off-LAN or wrong IP).
- Local 401 → `error: "local_unauthorized"`.
- Protect 404 → `error: "protect_integration_unavailable"`.

Never make state-changing calls. Never call `POST`, `PUT`, `PATCH`, or `DELETE`. Read-only.

Print only the JSON object to stdout. Print transport info to stderr.
