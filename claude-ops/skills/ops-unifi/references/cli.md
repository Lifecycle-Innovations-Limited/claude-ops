# CLI/API reference

## CLI/API Reference

### A. Site Manager API — CLOUD (multi-site oversight)

Base URL: `https://api.ui.com`
Auth header: `X-API-Key: ${UNIFI_SM_KEY}`
Key generation: **unifi.ui.com → (top-right account) → Settings → Control Plane → Integrations → Create API Key** (or developer.ui.com). Key is shown once — store it. Currently read-scoped for most keys; a 429 means you hit the rate limit (back off).

| Endpoint                         | Method | Description                                                            |
| -------------------------------- | ------ | ---------------------------------------------------------------------- |
| `/v1/hosts`                      | GET    | List every UniFi OS console (host) on the account                      |
| `/v1/hosts/{id}`                 | GET    | One console: model, fw, IP, owner, state                               |
| `/v1/sites`                      | GET    | List all sites across all hosts                                        |
| `/v1/devices`                    | GET    | List all adopted devices across all hosts                              |
| `/v1/isp-metrics/{type}`         | GET    | ISP/WAN metrics, `type` = `5m` or `1h` (latency, downtime, throughput) |
| `/v1/isp-metrics/{type}/query`   | POST   | Query ISP metrics for specific sites/time ranges                       |
| `/v1/sd-wan-configs`             | GET    | List SD-WAN configurations                                             |
| `/v1/sd-wan-configs/{id}`        | GET    | SD-WAN config detail                                                   |
| `/v1/sd-wan-configs/{id}/status` | GET    | SD-WAN config deployment status                                        |

Pagination: responses carry `nextToken`; pass `?pageSize=N&nextToken=…`.

### B. Network Integration API — LOCAL (per-console control)

Base URL: `${UNIFI_LOCAL_URL}/proxy/network/integration/v1`
Auth header: `X-API-Key: ${UNIFI_LOCAL_KEY}`
Key generation: **UniFi Network app → Settings → Control Plane → Integrations → Create API Key** (UniFi OS consoles only — UDM/UDR/UCG/UX/UDW/UCG-Ultra/UniFi OS Server; the legacy self-hosted Network app does **not** support API keys).
TLS: local consoles use a self-signed cert → all curl calls use `-k`.

| Endpoint                                               | Method | Description                                                   |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------- |
| `/info`                                                | GET    | Network application version + metadata                        |
| `/sites`                                               | GET    | List sites on this console                                    |
| `/sites/{siteId}/devices`                              | GET    | List adopted devices (APs, switches, gateways)                |
| `/sites/{siteId}/devices/{deviceId}`                   | GET    | Device detail (uptime, fw, ports, radios)                     |
| `/sites/{siteId}/devices/{deviceId}/statistics/latest` | GET    | Latest device stats (throughput, CPU, mem, uplink)            |
| `/sites/{siteId}/devices/{deviceId}/actions`           | POST   | Device action — `{"action":"RESTART"}`                        |
| `/sites/{siteId}/clients`                              | GET    | Connected clients (wired + wireless)                          |
| `/sites/{siteId}/clients/{clientId}`                   | GET    | Client detail (IP, MAC, AP, signal, usage)                    |
| `/sites/{siteId}/clients/{clientId}/actions`           | POST   | Client action — `{"action":"BLOCK"}` / `{"action":"UNBLOCK"}` |
| `/sites/{siteId}/vouchers`                             | GET    | Hotspot vouchers                                              |
| `/sites/{siteId}/vouchers`                             | POST   | Create voucher(s)                                             |
| `/sites/{siteId}/vouchers/{voucherId}`                 | DELETE | Revoke a voucher                                              |

### C. Protect Integration API — LOCAL (cameras / NVR)

Base URL: `${UNIFI_PROTECT_URL}/proxy/protect/integration/v1`
Auth header: `X-API-Key: ${UNIFI_PROTECT_KEY}`
Key generation: **UniFi OS → Protect → Settings → Control Plane → Integrations → Create API Key** (or reuse the UniFi OS console key). `-k` for self-signed cert.

| Endpoint                                  | Method   | Description                                                 |
| ----------------------------------------- | -------- | ----------------------------------------------------------- |
| `/meta/info`                              | GET      | NVR + Protect application info/version                      |
| `/nvrs`                                   | GET      | NVR(s) detail (storage, recording mode)                     |
| `/cameras`                                | GET      | List cameras                                                |
| `/cameras/{id}`                           | GET      | Camera detail (state, fw, recording, motion zones)          |
| `/cameras/{id}`                           | PATCH    | Update camera settings (partial JSON — only changed fields) |
| `/cameras/{id}/snapshot?highQuality=true` | GET      | JPEG snapshot (binary)                                      |
| `/cameras/{id}/rtsps-stream`              | GET/POST | Retrieve / manage the RTSPS stream URL                      |
| `/sensors`                                | GET      | UniFi Protect sensors                                       |
| `/lights`                                 | GET      | Protect smart lights (`PATCH /lights/{id}` to control)      |
| `/chimes`                                 | GET      | Chimes (`PATCH /chimes/{id}`)                               |
| `/viewers`                                | GET      | Protect viewers (`PATCH /viewers/{id}` to change live view) |

Real-time: WebSocket `wss://${UNIFI_PROTECT_URL#https://}/proxy/protect/integration/v1/subscribe/devices` (and `/subscribe/events`) streams state changes — used only for live-watch flows, not the default dashboard.

---

