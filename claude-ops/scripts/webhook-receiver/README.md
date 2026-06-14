# Pocket webhook receiver (version-controlled source)

These two files run the **front door** of the Pocket pipeline on your
remote host. They were previously **deployed only** to `/opt/pocket-mcp/`
with no copy in git; this directory is now the version-controlled **source of
truth** and the deployed copies should be (re)deployed from here via the steps
below. Filenames are preserved because `app.py` references its handler by the
absolute deployed path. The deployed `/opt/pocket-mcp/` copies may lag this
source until the next deploy — re-run the deploy steps after changes.

| File           | Deployed path                  | Role                                                                                                                                                                                                                 |
| -------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.py`       | `/opt/pocket-mcp/app.py`       | FastAPI receiver. Verifies HMAC signature, dedupes via SQLite (`/var/lib/pocket-webhook/seen.db`), enforces a 5-min replay window, then hands each event to the handler. Runs under `pocket-webhook.service` (root). |
| `on-memory.sh` | `/opt/pocket-mcp/on-memory.sh` | Handler invoked by `app.py`. Journals every event to `/var/lib/pocket-webhook/journal/events.jsonl`, then feeds it into the real-time triage ingest (`ops-pocket-webhook-ingest.py`) as `ec2-user`.                  |

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

> Originally captured 2026-05-29 from the live `/opt/pocket-mcp/` deployment.
> This source has since received review-hardening fixes (fail-closed auth,
> dedup-claim release on dispatch failure, path-sanitized journal names,
> seconds/ms timestamp handling, journal retention) and may differ from the
> currently-running files until redeployed via the steps above.
