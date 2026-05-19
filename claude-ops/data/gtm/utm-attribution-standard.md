# UTM Attribution Standard

Opinionated naming convention for all campaigns tracked through GA4 and Meta CAPI.
Validated at creation time by `scripts/lib/utm-validate.sh`.

## Required dimensions

| Parameter       | Required | Notes                                                   |
|-----------------|----------|---------------------------------------------------------|
| `utm_source`    | yes      | Traffic origin: `meta`, `google`, `email`, `organic`   |
| `utm_medium`    | yes      | Channel type: `cpc`, `social`, `newsletter`, `display` |
| `utm_campaign`  | yes      | Must follow `{name}_{variant}_{date}` format            |
| `utm_term`      | optional | Keyword (search campaigns only)                         |
| `utm_content`   | optional | Creative/ad set identifier                              |

## Naming regex

All values are **lowercase only**. Tokens consist of `[a-z0-9_-]`, starting with an
alphanumeric character.

```
utm_source   : ^[a-z0-9][a-z0-9_-]*$
utm_medium   : ^[a-z0-9][a-z0-9_-]*$
utm_campaign : ^[a-z0-9][a-z0-9_-]*_[a-z0-9][a-z0-9_-]*_[0-9]{8}$
               └─── name ───┘ └── variant ──┘ └─ date ─┘
               date = YYYYMMDD (e.g. 20260601)
```

## Examples

### Valid

```
utm_source=meta           utm_medium=cpc    utm_campaign=summer-sale_v1_20260601
utm_source=google         utm_medium=cpc    utm_campaign=brand-awareness_control_20260115
utm_source=email          utm_medium=newsletter utm_campaign=weekly-digest_promo_20260520
utm_source=organic        utm_medium=social utm_campaign=launch_a_20260301
```

### Invalid

```
utm_campaign=summer sale_v1_20260601   # spaces not allowed
utm_campaign=summersale_20260601       # missing variant segment
utm_campaign=v1_20260601               # missing name segment
utm_campaign=sale_v1_2026              # date must be 8 digits (YYYYMMDD)
utm_source=Meta                        # uppercase not allowed
utm_medium=CPC                         # uppercase not allowed
```

## GA4 alignment notes

- GA4 Measurement Protocol events populated by `bin/ops-conversion-send` forward
  `utm_source`, `utm_medium`, and `utm_campaign` as session-scoped custom dimensions
  when the `client_id` ties back to an active GA4 session.
- Campaign names that violate this standard will appear as uncategorised traffic in
  the "Session source / medium" report.
- Measurement ID format: `G-XXXXXXXXXX`.

## Meta CAPI alignment notes

- Meta Conversions API events sent by `bin/ops-meta-capi-send` pass the campaign
  name through `custom_data.campaign` so Meta can align offline signals to the
  originating ad set.
- `fbp` and `fbc` cookies are forwarded verbatim as `user_data.fbp` / `user_data.fbc`
  for deduplication against browser-pixel events.
- SHA-256 hashing of `email` and `phone` is mandatory (handled automatically by
  `bin/ops-meta-capi-send`).

## Validation hook integration point

<!-- TODO(P3): wire utm_validate into ops-marketing-autopilot campaign-create paths:
     - Meta /campaigns POST (near ops-marketing-autopilot:315): call
       utm_validate "$utm_source" "$utm_medium" "$utm_campaign" before the API call;
       refuse with non-zero exit and log the violation if validation fails.
     - Google Ads campaigns:mutate (near ops-marketing-autopilot:1532): same gate.
     This TODO is intentionally deferred to the P3 PR to avoid collision with
     in-flight PRs #256 and feat/marketing-p1-expand. The library is ready to source.
-->

Source `scripts/lib/utm-validate.sh` and call:

```bash
utm_validate "$utm_source" "$utm_medium" "$utm_campaign" \
  || { log "invalid UTM — refusing campaign create"; exit 1; }
```
