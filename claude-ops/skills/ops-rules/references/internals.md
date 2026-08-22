# Deploy-fix and credit-pool

## Deploy-fix fleet contract

- Fixer is **fully autonomous up to opening a DRAFT PR** (`gh pr create --draft`); it never merges, triggers builds, or promotes to prod.
- Global concurrency is capped by `max_concurrent_fixers` (default 3); if a fleet agent is already active on the same repo the dispatch is skipped (rc=7 via `respect_fleet_claims`).
- Running fixers register in `~/.claude/state/deploy-fix-active.jsonl` (source=deploy-fix) for fleet-census visibility.

## Credit-pool gate — `CLAUDE_OPS_USE_CREDIT_POOL`

Daemon scripts that invoke Claude (recap digest, deploy-fix fixer, agent-drafter hook) route through `scripts/lib/claude-invoke.sh`, which provides a `claude_invoke` shell function. When `CLAUDE_OPS_USE_CREDIT_POOL=1` is exported in the environment, `claude_invoke` delegates to `scripts/account-rotation/claude-p-as.mjs`, which selects the highest-credit Max-OAuth account from the shared ledger. When the variable is unset or any other value, `claude_invoke` calls `claude` directly (standard keychain account), preserving existing behaviour. Set `CLAUDE_OPS_USE_CREDIT_POOL=1` only after the credit ledger is activated (target: 2026-06-15); before that date the wrapper exits 2 when the ledger is empty and daemons would fail silently. The gate can be exported in your shell profile or per-launch environment and takes effect immediately without restarting daemons.
