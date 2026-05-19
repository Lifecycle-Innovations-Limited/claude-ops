"""Daily Stagery spend poller.

Polls platforms without native spending-limit APIs and emits SNS alerts when
usage crosses configured thresholds. Lands in `arn:aws:sns:us-east-1:410126241301:healify-cost-alerts`.

Platform coverage (verified 2026-05-19):
  - Resend  : counts emails sent this month via GET /emails. Threshold = email count proxy.
  - fal.ai  : SKIPPED. All probed endpoints (/users/me, /billing/usage, /v1/usage, /usage,
              /billing/user-spend, /billing/credits) return 404. No usage API.
  - Inngest : SKIPPED. /v1/usage, /v1/account, /v1/billing, /v1/runs all 404 with both
              SIGNING_KEY and EVENT_KEY. SDK keys are not billing API tokens.

GCP (Gemini) is already covered by gcloud billing budget 771c9623-... created earlier.

Env contract:
  RESEND_API_KEY              required
  RESEND_THRESHOLD_EMAILS     optional, default 12500 (~$5/mo at $0.0004/email)
  SNS_TOPIC_ARN               default arn:aws:sns:us-east-1:410126241301:healify-cost-alerts
  AWS_REGION                  default us-east-1
  DRY_RUN                     if "1", skip SNS publish

Idempotency: per-period marker file under /tmp prevents double-alerts in same period.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import boto3
import requests

LOG = logging.getLogger("stagery-spend-poller")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

SNS_TOPIC = os.environ.get(
    "SNS_TOPIC_ARN",
    "arn:aws:sns:us-east-1:410126241301:healify-cost-alerts",
)
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
DRY_RUN = os.environ.get("DRY_RUN") == "1"
MARKER_DIR = Path(os.environ.get("MARKER_DIR", "/tmp/stagery-spend-poller"))


def already_alerted(platform: str, period_key: str) -> bool:
    MARKER_DIR.mkdir(parents=True, exist_ok=True)
    marker = MARKER_DIR / f"{platform}-{period_key}.alerted"
    return marker.exists()


def mark_alerted(platform: str, period_key: str) -> None:
    MARKER_DIR.mkdir(parents=True, exist_ok=True)
    marker = MARKER_DIR / f"{platform}-{period_key}.alerted"
    marker.write_text(datetime.now(timezone.utc).isoformat())


def publish_alert(payload: dict) -> None:
    if DRY_RUN:
        LOG.info("DRY_RUN — would publish: %s", json.dumps(payload))
        return
    client = boto3.client("sns", region_name=AWS_REGION)
    subject = f"[Stagery spend] {payload['platform']} crossed {payload['period']} threshold"
    client.publish(
        TopicArn=SNS_TOPIC,
        Subject=subject[:100],
        Message=json.dumps(payload, indent=2),
    )
    LOG.info("Alert published to %s", SNS_TOPIC)


def poll_resend() -> dict | None:
    """Returns alert payload if threshold crossed, else None."""
    key = os.environ.get("RESEND_API_KEY")
    if not key:
        LOG.warning("RESEND_API_KEY missing — skipping Resend")
        return None
    threshold = int(os.environ.get("RESEND_THRESHOLD_EMAILS", "12500"))

    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    headers = {"Authorization": f"Bearer {key}"}
    count = 0
    cursor = None
    pages = 0
    max_pages = 200  # safety bound — at 100/page that's 20k emails

    while pages < max_pages:
        url = "https://api.resend.com/emails?limit=100"
        if cursor:
            url += f"&after={cursor}"
        resp = requests.get(url, headers=headers, timeout=30)
        resp.raise_for_status()
        body = resp.json()
        data = body.get("data", [])
        if not data:
            break

        oldest_this_page = None
        for item in data:
            created_at = item.get("created_at", "")
            try:
                created = datetime.fromisoformat(created_at.replace(" ", "T").replace("+00", "+00:00"))
            except ValueError:
                continue
            oldest_this_page = created
            if created >= month_start:
                count += 1
            else:
                # Page is sorted desc; once we cross month_start we can stop.
                pages = max_pages
                break

        if not body.get("has_more"):
            break
        if oldest_this_page and oldest_this_page < month_start:
            break
        cursor = data[-1].get("id")
        if not cursor:
            break
        pages += 1

    period_key = now.strftime("%Y-%m")
    LOG.info(
        "resend: emails_this_month=%d threshold=%d period=%s",
        count, threshold, period_key,
    )

    if count < threshold:
        return None
    if already_alerted("resend", period_key):
        LOG.info("resend: already alerted for %s — skipping", period_key)
        return None

    payload = {
        "platform": "resend",
        "period": "monthly",
        "period_key": period_key,
        "metric": "emails_sent",
        "actual": count,
        "threshold": threshold,
        "exceeded_by_pct": round(((count - threshold) / threshold) * 100, 1),
        "polled_at": now.isoformat(),
    }
    mark_alerted("resend", period_key)
    return payload


SKIPPED_PLATFORMS = [
    {
        "platform": "fal.ai",
        "reason": "no billing API",
        "probed": [
            "https://fal.run/users/me",
            "https://api.fal.ai/billing/usage",
            "https://api.fal.ai/v1/usage",
            "https://api.fal.ai/usage",
            "https://rest.alpha.fal.ai/billing/user-spend",
            "https://rest.alpha.fal.ai/billing/credits",
        ],
        "result": "all 404 (verified 2026-05-19)",
    },
    {
        "platform": "inngest",
        "reason": "no billing API",
        "probed": [
            "https://api.inngest.com/v1/usage",
            "https://api.inngest.com/v1/account",
            "https://api.inngest.com/v1/billing",
            "https://api.inngest.com/v1/runs",
        ],
        "result": "all 404 with SIGNING_KEY and EVENT_KEY (verified 2026-05-19)",
    },
]


def main() -> int:
    LOG.info("Stagery spend poller starting (dry_run=%s)", DRY_RUN)
    for skipped in SKIPPED_PLATFORMS:
        LOG.info("SKIP %s: %s", skipped["platform"], skipped["reason"])

    alerts: list[dict] = []
    try:
        resend_alert = poll_resend()
        if resend_alert:
            alerts.append(resend_alert)
    except requests.HTTPError as exc:
        LOG.error("Resend poll failed: %s", exc)
        return 2
    except Exception:
        LOG.exception("Resend poll crashed")
        return 2

    for alert in alerts:
        publish_alert(alert)

    LOG.info("Stagery spend poller done (alerts_emitted=%d)", len(alerts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
