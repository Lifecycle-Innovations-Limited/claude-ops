# Daemon and launchd approval policy

## Default posture

**Never auto-approve** changes to background services, launchd plists, or scripts that install/start/stop daemons.

## Human review must verify

- Daemons remain single-instance where required (orchestrator, rotator, briefing pre-warm)
- No new always-on network listeners without documented purpose
- Cron/interval changes will not cause cost leaks or API hammering
- Log rotation and failure backoff behavior is preserved
- Doppler/secret fallback behavior is fail-safe, not fail-open

## Reviewer routing

- Request platform maintainers
- Flag PRs that touch rotator or CRS-related scripts for extra scrutiny
