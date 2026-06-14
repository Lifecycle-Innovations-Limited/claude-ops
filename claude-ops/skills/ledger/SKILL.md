---
name: ledger
description: Inspect the shared Ops Ledger — what's awaiting owner, what was handled autonomously, what claude-ops or Perplexity did in the last 24h. Always the single source of truth between the two systems.
allowed-tools:
  - Bash
---

# /ops:ledger

Single source of truth shared between claude-ops (Mac) and Perplexity (off-Mac).
Stored at `~/.claude-ops/ledger.jsonl` and mirrored to Notion DB "Ops Ledger".

## Usage

```bash
# Default: human digest of last 24h
/ops:ledger

# What needs owner's attention right now?
/ops:ledger awaiting

# What did Perplexity do while I was at the gym?
/ops:ledger query --source perplexity --since -PT4H

# What's been touched on this Gmail thread?
/ops:ledger query --claim-key gmail:thread:19e690a55d213f52
```

## Behavior

Wraps `~/.claude-ops/bin/ledger` (the CLI from this skill). Always reports:

1. Awaiting owner (top of digest, sorted newest first)
2. Drafted by either system (needs send / merge / approve)
3. Done autonomously in last 24h, grouped by source (claude-ops, Perplexity)
4. Skipped or expired claims

## Conventions every command in this plugin follows

Before doing real work, run:

```bash
~/.claude-ops/bin/ledger query --claim-key "$CLAIM_KEY" --since -PT24H
```

If result has any entry with `status in (in_progress, done, drafted, awaiting_sam)`,
SKIP — the other system already handled it. Don't duplicate.

After doing work:

```bash
~/.claude-ops/bin/ledger claim --claim-key "$CLAIM_KEY" --kind <kind> --brand <brand> \
  --title "<title>" --source claude-ops
# ... do work ...
~/.claude-ops/bin/ledger resolve <id> --status done|drafted|awaiting_sam
```
