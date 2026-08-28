---
name: relations
description: "OPS on-demand: This skill should be used when the user asks to \"who do I owe a reply\", \"relationship…"
argument-hint: '[queue|brief <person>|find <email|phone|name>|draft <person>|close <id>|audit]'
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
  - AskUserQuestion
---

# /ops:relations — Relationship Manager

Load `ops-rules` before acting. Public repo (no personal data). Outbound: one draft → one approval → one send. If `AskUserQuestion` / `Workflow` are missing, follow Rule 10 in `ops-rules` (Hermes: numbered options / two-turn Telegram card; `delegate_task`).

Relationship ledger and decision queue. Answers: who is owed a reply, what was
promised, what is going cold, and what context a draft needs before it is written.
It never sends anything.

## Configuration

Every path and toggle comes from plugin `userConfig`, an env var, or `$HOME`.
Nothing in this skill is machine-specific.

| userConfig key             | Env override             | Default                              | Meaning                                        |
| -------------------------- | ------------------------ | ------------------------------------ | ---------------------------------------------- |
| `relations_cli`            | `RELATIONS_CLI`          | `$HOME/.claude-ops/relations/bin/relations-cli` | Ledger CLI entry point (JSON out)   |
| `relations_db_path`        | `RELATIONS_DB`           | `$HOME/.claude-ops/relations/people.db` | SQLite ledger, the factual source of truth  |
| `relations_shadow_mode`    | `RELATIONS_SHADOW_MODE`  | `true`                               | When true, no external send on any channel     |
| `relations_queue_limit`    | `RELATIONS_QUEUE_LIMIT`  | `10`                                 | Max decision-queue items per report            |
| `relations_followup_limit_personal` | —               | `1`                                  | Unanswered follow-ups allowed, personal        |
| `relations_followup_limit_business` | —               | `2`                                  | Unanswered follow-ups allowed, business        |
| `relations_suppress_days`  | —                        | `30`                                 | Minimum suppression after a dismissal          |

Resolve in this order, first non-empty wins. Never hardcode an absolute path:

```bash
PREFS_PATH="${PREFS_PATH:-${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json}"
read_pref() { [ -f "$PREFS_PATH" ] && python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],"") or "")' "$PREFS_PATH" "$1" 2>/dev/null; }

RELATIONS_CLI="${RELATIONS_CLI:-$(read_pref relations_cli)}"
RELATIONS_CLI="${RELATIONS_CLI:-$HOME/.claude-ops/relations/bin/relations-cli}"
RELATIONS_DB="${RELATIONS_DB:-$(read_pref relations_db_path)}"
RELATIONS_DB="${RELATIONS_DB:-$HOME/.claude-ops/relations/people.db}"

if [ ! -x "$RELATIONS_CLI" ]; then
  echo "relations: no ledger CLI at $RELATIONS_CLI — set userConfig relations_cli or RELATIONS_CLI" >&2
fi
```

A missing CLI is reported as a missing CLI. Never fall back to an empty result:
"no follow-ups" and "the ledger is not installed" must never look the same.

## Hard rules

1. **Shadow mode is the default.** With `relations_shadow_mode` true, this skill
   drafts and stages only. No email, chat, SMS, or calendar invite leaves the box.
2. **Never merge two records on a name.** Hard keys only: contact-provider id,
   normalized email, E.164 phone, or a previously verified alias. Everything else
   goes to the review queue.
3. **Every fact, commitment and follow-up carries a source reference.** No source,
   no row, no draft sentence.
4. **Facts and inference are separate.** An inference never justifies an outbound.
5. **Silence is the default.** Nothing meaningful changed means send nothing.
6. **Contact history never enters agent memory.** Person facts belong in the
   ledger DB, not in a memory plane or a committed file. See `ops-rules` Rule 0.
7. **Progressive disclosure.** Never load the contact list into context. Query the
   one person you need.

## Operations

| Subcommand         | What it does                                                        |
| ------------------ | ------------------------------------------------------------------- |
| `queue` (default)  | Ranked decision queue, max `relations_queue_limit`, one per person   |
| `brief <person>`   | Contact methods, open commitments, sourced facts, recent threads     |
| `find <key>`       | Resolve an identity by email / phone / name; ambiguity → review      |
| `draft <person>`   | Full-context draft, staged for approval, never sent                  |
| `close <id>`       | Close a follow-up with a reason                                      |
| `snooze <id> <ts>` | Defer with a reason                                                  |
| `suppress <id>`    | Dismiss for at least `relations_suppress_days`                       |
| `audit`            | Duplicates, unsourced rows, stale facts, integrity                   |

```bash
"$RELATIONS_CLI" queue --limit "${RELATIONS_QUEUE_LIMIT:-10}"
"$RELATIONS_CLI" brief <person_id>
"$RELATIONS_CLI" find --email user@example.com
"$RELATIONS_CLI" close <follow_up_id> --reason "they replied on chat"
```

## Draft order (fixed)

1. Resolve identity across every channel the person owns — never answer on one
   channel while the real conversation is on another.
2. Read the COMPLETE thread, not the latest message. Check **both directions**
   (sent and received) and **every account** the channel has.
3. Read messages from the recipient and anyone relevant on copy.
4. Check the calendar and open commitments.
5. Check `vip` tier first (see the `vip` skill) — a tier-1 person is drafted
   with more care and never batched into a digest.
6. Load `humanizer`, write ONE draft in the owner's voice, in the language the
   thread is already in.
7. Stage it for approval with recipient, channel, thread, and a content hash.
   If any of those change, ask again. Send only the exact approved content.

Never send. Never produce several near-duplicate drafts.

## Follow-up gate

States: `i_owe_them`, `they_owe_me`, `waiting_date`, `waiting_document`,
`waiting_decision`, `going_cold`, `no_action`, suppressed.

The gate blocks on: do-not-automate, archived person, snoozed, suppressed,
not due yet, they responded elsewhere, upcoming meeting, unanswered limit
(`relations_followup_limit_personal` / `_business`), missing source reference,
cross-channel duplicate.

Not every unanswered message is overdue. Was a response actually requested? Was
something promised? Has that date arrived? Would silence be more natural?

## Report format

Plain text, no decoration, recommendation first, max `relations_queue_limit`
items, numbered actions per item. If nothing survives the gate, output nothing.

```
relationship desk — monday

1. <person>
business, a revised proposal was promised friday (email thread, <date>)
recommendation: send the prepared draft, confidence high

1 approve   2 edit   3 snooze 2 days   4 close   5 show context
```

## Source authority

Current complete thread > verified identity > current calendar event > current
conversation > signed document > this ledger > recent public primary source >
search result > existing summary > draft. A draft is never a source of truth.
On conflict: record it, prefer the newest authoritative primary source, surface
it, and do not send until it is resolved.

## Related skills

- `vip` — who is checked and answered first; always consulted before triage
- `ops-inbox` — channel sweeps feed this ledger
- `ops-comms` — the send path, gated by Rule 6
- `people` — contact directory sync (identity layer under this ledger)
- `humanizer` — voice pass before any draft is staged
- `ops-rules` — Rule 0 (public repo), Rule 6 (per-message approval)
