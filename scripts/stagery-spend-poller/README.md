# Stagery spend poller

Daily cron that polls the spend-relevant platforms used by Stagery and emits SNS
alerts when usage crosses a configured threshold. Compensates for platforms that
do not expose native spending-limit APIs.

## Coverage (verified 2026-05-19)

| Platform | Status | Notes |
|---|---|---|
| Resend | ACTIVE | counts emails sent in current calendar month via `GET /emails` |
| fal.ai | SKIPPED | no usage API (all `/billing/*` `/usage` `/users/me` endpoints 404) |
| Inngest | SKIPPED | `/v1/usage` `/v1/account` `/v1/billing` `/v1/runs` all 404 with both SIGNING_KEY and EVENT_KEY |
| GCP / Gemini | OUT_OF_SCOPE | already covered by GCP billing budget `771c9623-9fb2-4ac9-8170-4cf90335cc18` |

When fal.ai or Inngest expose a billing API, extend `poll.py` and remove the
relevant entry from `SKIPPED_PLATFORMS`.

## Alert destination

SNS topic `arn:aws:sns:us-east-1:410126241301:healify-cost-alerts`.

Subscribers (verified 2026-05-19):
- `support@healify.ai`
- `sam.renders@gmail.com`
- SMS `+31614446458`

## Idempotency

A marker file per `<platform>-<period_key>` lives at `/tmp/stagery-spend-poller/`
to prevent re-alerting for the same period. In CI the runner is ephemeral, so
the marker is effectively per-run; in practice the threshold pattern (cross
once per period) is fine without persistent state, but the marker also guards
against re-runs triggered from the workflow UI.

## Dry-run

```bash
RESEND_API_KEY=$(doppler secrets get RESEND_API_KEY --project stagery-api --config prd --plain) \
DRY_RUN=1 \
python3 scripts/stagery-spend-poller/poll.py
```

## Workflow

`.github/workflows/stagery-spend-poller.yml` runs daily at 06:00 UTC.
Secrets required on the `claude-ops` repo:

- `DOPPLER_TOKEN_STAGERY_API_PRD` — Doppler service token, read-only on
  `stagery-api/prd`, used to pull `RESEND_API_KEY`.
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — must be allowed to
  `sns:Publish` on the `healify-cost-alerts` topic.
- `AWS_REGION` (optional, defaults to `us-east-1`).

If the AWS creds are missing, the job will fail loudly — that is intentional
so the silent-guardrail failure mode does not recur.

## Threshold tuning

Default thresholds:

| Platform | Metric | Threshold | Approx $ |
|---|---|---|---|
| Resend | emails / month | 12500 | ~$5 |

Override via env (e.g. `RESEND_THRESHOLD_EMAILS=20000`).

## Why not native budgets

`fal.ai`, `Inngest`, and `Resend` only expose spending limits via their web
dashboards. Per the "never punt dashboard tasks" rule, this poller replaces
those clicks with auditable infrastructure.
