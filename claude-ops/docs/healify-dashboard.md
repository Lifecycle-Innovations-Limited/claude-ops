# Client Dashboard

This repository is public, so client-specific dashboard details live outside the committed docs. Keep this page generic and avoid real customer, operator, or brand identifiers.

## Public Contract

A client dashboard may aggregate only local, already-configured sources and should remain read-only by default. Watch modes may rerender on an interval, but they must not change tmux focus or select another window.

## Data Sources

Allowed source categories for public documentation:

- project health caches
- statusline KPI caches
- live endpoint health caches
- cloud service health caches
- plugin inventory
- runtime health summaries
- important ops and agent-hub logs

Authenticated business intelligence sources, app-store metadata, analytics providers, incident providers, and issue trackers must be documented in private runbooks instead of this public repo.

## Branding

Do not commit client-specific names, logos, colors, or brand assets in this public documentation. Use private docs for client-specific dashboard branding.

## Tmux Integration

Any tmux binding should open a client dashboard only through explicit user action. Background watchdogs, prewarmers, doctors, and repair hooks must not call `select-window` or `switch-client`. While a user is working in a window, focus should remain there unless the user explicitly presses a navigation key.
