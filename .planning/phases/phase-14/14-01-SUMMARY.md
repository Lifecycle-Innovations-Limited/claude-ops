# Phase 14 SUMMARY

**Status**: Shipped (backfilled)
**Shipped via**: PR #129, merge commit `615100e4c02a4621bbd4cd179a0f4a2fdbadbcea`, merged 2026-04-16
**Plan**: `.planning/phases/phase-14/14-01-PLAN.md`

## What Shipped

New skill `skills/ops-whatsapp-biz/SKILL.md` — WhatsApp Business Cloud API (separate from wacli personal):
- `send-template <PHONE> <TEMPLATE_NAME> [PARAMS]` — approved template sends (single + bulk with cost estimate)
- `list-templates` — templates with approval status (✓/✗/…) + pricing note
- `create-template` — guided wizard (name, category, body + optional header/button)
- `check-template <NAME>` — poll approval status
- `catalog` — product catalog viewer
- Credentials: `WABA_TOKEN`, `WABA_PHONE_ID`, `WABA_ACCOUNT_ID` (separate from wacli)
- `skills/setup/SKILL.md` updated with WhatsApp Business setup sub-flow

## Files Changed

- `claude-ops/skills/ops-whatsapp-biz/SKILL.md` (+378, new)
- `claude-ops/skills/setup/SKILL.md` (+40/-5)

## Verification

- Template sends via `POST /{phone-number-id}/messages` type=template
- Template management via `/{waba-id}/message_templates`
- Cost estimate note shown on sends
- MM Lite noted as beta (not implemented)

## Deviations from Plan

None.

## Commits

- `68f82ac1513e5f864a5ac11a765ac6261b4531b0` — feat(v1.5): phases 11-15 (mega-commit)
