# Pocket webhook receiver (deployed-only backup)

These two files run the **front door** of the Pocket pipeline on
`dev-sandbox-fra` and were previously **deployed only** to `/opt/pocket-mcp/`
with no copy in git. They are version-controlled here so the deployment is
reproducible. This directory is a faithful backup — filenames are preserved
because `app.py` references its handler by the absolute deployed path.

| File | Deployed path | Role |
|---|---|---|
| `app.py` | `/opt/pocket-mcp/app.py` | FastAPI receiver. Verifies HMAC signature, dedupes via SQLite (`/var/lib/pocket-webhook/seen.db`), enforces a 5-min replay window, then hands each event to the handler. Runs under `pocket-webhook.service` (root). |
| `on-memory.sh` | `/opt/pocket-mcp/on-memory.sh` | Handler invoked by `app.py`. Journals every event to `/var/lib/pocket-webhook/journal/events.jsonl`, then feeds it into the real-time triage ingest (`ops-pocket-webhook-ingest.py`) as `ec2-user`. |

## Deploy / restore

```sh
sudo cp app.py        /opt/pocket-mcp/app.py
sudo cp on-memory.sh  /opt/pocket-mcp/on-memory.sh
sudo chmod +x         /opt/pocket-mcp/on-memory.sh
sudo systemctl restart pocket-webhook.service
```

`app.py` expects:
- `SECRET_FILE` = `/etc/pocket-webhook/secret` (HMAC shared secret)
- handler at `/opt/pocket-mcp/on-memory.sh`
- writable `/var/log/pocket-webhook/` and `/var/lib/pocket-webhook/`

> Backup captured 2026-05-29 from the live `/opt/pocket-mcp/` deployment
> (verified byte-identical to the running files at capture time).
