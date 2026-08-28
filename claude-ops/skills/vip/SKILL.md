---
name: vip
description: "OPS on-demand: This skill should be used when the user asks to \"vip list\", \"who is a VIP\", \"add someone…"
argument-hint: '[list|show <person>|set <person> --tier N|suggest|why <person>]'
allowed-tools:
  - Bash
  - Read
  - Grep
  - Skill
  - AskUserQuestion
---

# /ops:vip — VIP List

Load `ops-rules` before acting. Public repo (no personal data). Outbound: one draft → one approval → one send. If `AskUserQuestion` / `Workflow` are missing, follow Rule 10 in `ops-rules` (Hermes: numbered options / two-turn Telegram card; `delegate_task`).

The priority layer over every inbox. VIPs are checked FIRST in any sweep,
answered first, drafted with extra care, and never buried in a bulk digest.

## Scope (deliberately narrow)

This skill does four things and nothing else:

1. Enforce the list — VIP senders rank ahead of everything else in every sweep.
2. Require FULL context before answering or drafting for a VIP: the whole
   thread, every account on that channel, both directions, plus the ledger brief.
3. Order triage output by tier.
4. **Suggest** additions when the signals below appear.

It does not read histories for their own sake, does not draft unasked, and does
not open a second channel just because one record is open. A tier edit is
metadata only. Tagging someone is never an instruction to sweep their history.

## Configuration

Nothing here is machine-specific. Every value resolves from `userConfig`, an env
var, or `$HOME`.

| userConfig key        | Env override     | Default                                     | Meaning                              |
| --------------------- | ---------------- | ------------------------------------------- | ------------------------------------ |
| `vip_list_path`       | `VIP_LIST_PATH`  | `$HOME/.claude-ops/state/vip-list.json`     | Tier data + why/register notes       |
| `vip_max_tier`        | `VIP_MAX_TIER`   | `2`                                         | Highest tier treated as VIP          |
| `vip_suggest_enabled` | —                | `true`                                      | Emit VIP candidate suggestions       |
| `vip_volume_days`     | —                | `30`                                        | Window for the volume signal         |
| `vip_volume_min`      | —                | `12`                                        | Two-way messages that trip volume    |
| `relations_cli`       | `RELATIONS_CLI`  | `$HOME/.claude-ops/relations/bin/relations-cli` | Shared ledger CLI (see `relations`) |

```bash
PREFS_PATH="${PREFS_PATH:-${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json}"
read_pref() { [ -f "$PREFS_PATH" ] && python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],"") or "")' "$PREFS_PATH" "$1" 2>/dev/null; }

VIP_LIST_PATH="${VIP_LIST_PATH:-$(read_pref vip_list_path)}"
VIP_LIST_PATH="${VIP_LIST_PATH:-$HOME/.claude-ops/state/vip-list.json}"
VIP_MAX_TIER="${VIP_MAX_TIER:-$(read_pref vip_max_tier)}"
VIP_MAX_TIER="${VIP_MAX_TIER:-2}"
```

The list file lives OUTSIDE the repo tree — it is the operator's identity and
must never be committed (`ops-rules` Rule 0). Shape:
`templates/vip-list.example.json`.

## Tiers

| Tier | Meaning                | Handling                                                  |
| ---- | ---------------------- | --------------------------------------------------------- |
| 1    | Inner circle           | Never let it sit. Checked first, answered first, never batched |
| 2    | Key business           | Same day. Ranked above general triage                      |
| 3-5  | Reserved               | Not VIP by default (`vip_max_tier` = 2)                     |

The ledger's `importance_tier` column is the source of truth for the tier value;
the JSON file carries the why and the register notes (language, tone, dates to
avoid). Both are read; the DB wins on conflict.

## Operations

| Subcommand              | What it does                                                     |
| ----------------------- | ---------------------------------------------------------------- |
| `list` (default)        | Every person at or above `vip_max_tier`, grouped by tier          |
| `show <person>`         | Tier, type, why, channel, register notes                          |
| `set <person> --tier N` | Audited tier write via the ledger CLI, reason required            |
| `suggest`               | Read-only candidate scan (see signals below); never writes        |
| `why <person>`          | Which signal put a suggested candidate on the list                |

```bash
"$RELATIONS_CLI" vip-list --max-tier "$VIP_MAX_TIER"
"$RELATIONS_CLI" vip <person_id> --tier 1 --type personal --reason "<why>"
```

**Tier writes go through the CLI, never raw SQL.** The CLI owns
`source_reference`, the audit log, and the rollback path. A direct
`UPDATE` on the ledger DB — inline or wrapped in a script — leaves an
unauditable row and is forbidden even where no guard happens to fire.

## Sweep order

Any inbox, chat, email, or ticket sweep runs in this order:

1. Resolve the VIP set once (`vip list`), cache it for the sweep.
2. Tier 1 senders, every channel, both directions, every account.
3. Tier 2 senders, same.
4. Everything else, normal triage.

A VIP with an unanswered inbound is always surfaced individually, with the
thread context, never as a line in a digest.

## Suggesting additions

Suggest, never add silently. A tier change needs the owner's word, then the
audited CLI write. Three signals:

| Signal      | Trigger                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| volume      | `vip_volume_min`+ two-way messages in `vip_volume_days` with someone off the list |
| frustration | They say they are being ignored or chased ("still waiting", "any update") |
| chain-break | Their last message is inbound and still unanswered                       |

Two filters keep this honest, both learned from real false positives:

- **Anchor every keyword on both sides.** A bare stem matches inside longer
  words (`ping` inside "tapping") and produces phantom frustration hits.
- **A thread ending on a sign-off is CLOSED, not broken.** "Thanks!", "sounds
  good", an emoji, or any short ack with no question mark is not an open ask.
  Without this filter most chain-breaks are noise that buries the real ones.

Present at most 5 a week: who, which signal, the evidence line, and the exact
CLI command to apply it. Then ask plainly. On "no", do not raise that person
again.

## Related skills

- `relations` — the ledger, decision queue and draft path this list ranks
- `ops-inbox` — the sweep that consumes the tier order
- `ops-comms` — the send path, still gated by Rule 6 for every VIP
- `people` — contact directory / identity resolution
- `ops-rules` — Rule 0 (the list is operator data, never committed)
