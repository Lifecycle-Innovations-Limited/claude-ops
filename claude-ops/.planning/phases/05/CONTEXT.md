# Phase 5: Business Intelligence + Revenue + Next — Context

## Scope
Verify ops-revenue and ops-next priority routing logic.

## ops-revenue
- AWS Cost Explorer via aws ce CLI
- Project registry for revenue stages and MRR
- Route by: costs | credits | revenue | runway | (all)

## ops-next priority stack
1. FIRES — unhealthy ECS, broken main/dev CI
2. URGENT COMMS — bin/ops-unread human messages
3. READY PRs — CI green, no unresolved comments, not draft
4. LINEAR SPRINT — current cycle highest-priority issue
5. GSD WORK — highest revenue-impact active phase
