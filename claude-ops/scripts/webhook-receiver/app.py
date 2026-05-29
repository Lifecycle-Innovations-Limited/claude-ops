"""Pocket webhook receiver — verifies HMAC, dedupes, hands off to local executor."""

import hashlib
import hmac
import json
import logging
import os
import sqlite3
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse

LOG_PATH = "/var/log/pocket-webhook/webhook.log"
DEDUP_DB = "/var/lib/pocket-webhook/seen.db"
HANDLER = "/opt/pocket-mcp/on-memory.sh"
SECRET_FILE = "/etc/pocket-webhook/secret"
MAX_SKEW_SEC = 300  # 5 min replay window
# Keep dedup claims long enough to cover Pocket retries, but bound disk growth.
SEEN_RETENTION_SEC = 7 * 24 * 3600  # 7 days
# Below this magnitude a Unix timestamp is plainly seconds, not milliseconds.
_TS_MS_THRESHOLD = 10_000_000_000

Path(LOG_PATH).parent.mkdir(parents=True, exist_ok=True)
Path(DEDUP_DB).parent.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    filename=LOG_PATH,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("pocket-webhook")

app = FastAPI(title="Pocket Webhook Receiver", version="1.0.0")


def _read_secret() -> str | None:
    try:
        with open(SECRET_FILE, "r") as f:
            return f.read().strip() or None
    except FileNotFoundError:
        return None


@contextmanager
def _db():
    conn = sqlite3.connect(DEDUP_DB, timeout=5.0)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, ts INTEGER NOT NULL)"
        )
        yield conn
        conn.commit()
    finally:
        conn.close()


def _seen(key: str) -> bool:
    """Atomically CLAIM a dedup key. Returns True if it was already claimed.

    The INSERT OR IGNORE is the claim — it also guards against concurrent
    duplicate requests. A claim must be released (see _release) if the
    downstream handoff fails, otherwise a transient dispatch failure would
    permanently drop the event (at-most-once instead of at-least-once).
    """
    with _db() as conn:
        now = int(time.time())
        # Bound table growth: drop claims older than the retention window.
        conn.execute("DELETE FROM seen WHERE ts < ?", (now - SEEN_RETENTION_SEC,))
        cur = conn.execute(
            "INSERT OR IGNORE INTO seen (id, ts) VALUES (?, ?)",
            (key, now),
        )
        return cur.rowcount == 0


def _release(key: str) -> None:
    """Release a previously claimed dedup key so the event can be retried."""
    with _db() as conn:
        conn.execute("DELETE FROM seen WHERE id = ?", (key,))


def _verify_signature(secret: str, timestamp: str, raw_body: bytes, sig: str) -> bool:
    msg = f"{timestamp}.".encode("utf-8") + raw_body
    expected = hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()
    # Pocket may send raw hex or "sha256=<hex>"; accept both
    candidates = [expected, f"sha256={expected}"]
    return any(hmac.compare_digest(c, sig) for c in candidates)


@app.get("/")
def root():
    return PlainTextResponse("pocket-webhook ok", status_code=200)


@app.get("/health")
def health():
    # Do not disclose secret-configuration posture to unauthenticated callers.
    return {"ok": True}


@app.post("/webhook")
async def webhook(
    request: Request,
    x_heypocket_signature: str | None = Header(default=None),
    x_heypocket_timestamp: str | None = Header(default=None),
):
    raw = await request.body()
    secret = _read_secret()

    # Auth path: if a secret is configured, signature MUST verify.
    if secret:
        if not x_heypocket_signature or not x_heypocket_timestamp:
            log.warning("missing signature headers")
            raise HTTPException(status_code=401, detail="missing signature headers")

        # Replay protection. Pocket docs say milliseconds, but it has also sent
        # seconds in the wild — accept both (signature still uses the raw string,
        # so this only affects the skew check, never verification).
        try:
            ts_raw = int(x_heypocket_timestamp)
        except ValueError:
            raise HTTPException(status_code=400, detail="bad timestamp")
        ts_ms = ts_raw if ts_raw >= _TS_MS_THRESHOLD else ts_raw * 1000
        now_ms = int(time.time() * 1000)
        if abs(now_ms - ts_ms) > MAX_SKEW_SEC * 1000:
            log.warning("timestamp skew %sms", now_ms - ts_ms)
            raise HTTPException(status_code=401, detail="stale timestamp")

        if not _verify_signature(
            secret, x_heypocket_timestamp, raw, x_heypocket_signature
        ):
            log.warning("signature mismatch")
            raise HTTPException(status_code=401, detail="invalid signature")
    else:
        # Fail closed: this service runs as root and is reachable externally.
        # An absent/empty secret must NOT degrade into accepting unsigned input.
        log.error(
            "POCKET_WEBHOOK_SECRET not configured at %s — refusing request",
            SECRET_FILE,
        )
        raise HTTPException(status_code=503, detail="webhook secret not configured")

    # Parse payload
    try:
        payload = json.loads(raw.decode("utf-8")) if raw else {}
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="invalid json")

    event = payload.get("event") or payload.get("type") or "unknown"
    data = payload.get("data") or payload.get("recording") or {}
    rec_id = (
        (data.get("id") if isinstance(data, dict) else None)
        or payload.get("recording_id")
        or payload.get("id")
        or "no-id"
    )
    dedup_key = f"{rec_id}:{event}"

    if _seen(dedup_key):
        log.info("dedup hit %s", dedup_key)
        return JSONResponse({"ok": True, "deduped": True}, status_code=200)

    log.info("event=%s rec=%s bytes=%d", event, rec_id, len(raw))

    # Hand off to the executor. We CLAIMED dedup_key above; if dispatch fails we
    # must release the claim and return a non-2xx so Pocket retries — otherwise
    # the recording is lost forever (the claim would dedupe every retry).
    try:
        proc = subprocess.Popen(
            [HANDLER, event],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        proc.stdin.write(json.dumps(payload).encode("utf-8"))
        proc.stdin.close()
    except Exception as e:
        _release(dedup_key)
        log.error(
            "handler dispatch failed for event=%s rec=%s: %s — released dedup claim",
            event,
            rec_id,
            e,
        )
        raise HTTPException(status_code=500, detail="handler dispatch failed")

    return JSONResponse({"ok": True, "event": event, "id": rec_id}, status_code=200)
