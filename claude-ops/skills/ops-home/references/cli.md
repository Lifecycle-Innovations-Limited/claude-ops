# CLI/API reference

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

