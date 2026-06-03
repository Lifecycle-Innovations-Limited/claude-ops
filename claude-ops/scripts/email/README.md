# email scripts

## `gog-reply.sh` — account-safe Gmail reply helper

A robust wrapper around the `gog` CLI for replying to a Gmail thread **without
sending to the wrong account or burning the outbound-comms approval token**.

### The bug it prevents

Replying with `gog gmail send --reply-to-message-id <ID>` **404s** when the
message-ID was scanned from one Gmail account (e.g. account A) but
the send defaults to a **different** account (e.g. account B) — the same
thread has different message/thread IDs per account.

Worse: **every** `gog gmail send` attempt — even one that errors on a 404 or a bad
flag combo — trips the outbound-comms approval hook and **consumes the single-use
`/tmp/.claude-send-ok` token**, so each failed attempt forces a re-approval.

`gog-reply.sh` fixes this by:

1. **Resolving the correct account + reply-to message-id with read-only calls
   first** (`gog auth list`, `gog gmail search`, `gog gmail thread get`).
2. Issuing **exactly one** `gog gmail send`, and only after resolution succeeds —
   so a doomed send never wastes the token.
3. **Never** passing both `--reply-to-message-id` and `--thread-id` together
   (gog rejects that combo — the second bug seen the same day).

### Usage

```bash
gog-reply.sh --to <email> --body <text> \
  [--subject <subj>] \
  [--match-from <email>] \
  [--match-subject <text>] \
  [--account <acct>] \
  [--dry-run]
```

| Flag | Meaning |
|---|---|
| `--to <email>` | Recipient. **Required.** |
| `--body <text>` | Reply body (plain text). **Required.** |
| `--subject <subj>` | Subject. If omitted, derived as `Re: <original subject>`. |
| `--match-from <email>` | From-address used to find the thread. Defaults to `--to`. |
| `--match-subject <text>` | Substring to disambiguate the thread. Optional. |
| `--account <acct>` | Pin a gog account. If omitted, **auto-discovers** (enumerates oauth gmail accounts via `gog auth list`, always also probing any accounts in `$GOG_EXTRA_ACCOUNTS`). |
| `--dry-run` | Resolve and print the account / threadId / message-id / to / subject / body, then exit 0 without sending. |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Sent (or printed in `--dry-run`). |
| `2` | Bad/missing arguments. |
| `3` | No matching thread on any account — **no send attempted** (token preserved). |
| `4` | Ambiguous match across multiple accounts — pin with `--account` (no send). |
| `5` | The single send call failed. |

### How it resolves

For each candidate account it runs
`gog gmail search -a <acct> "from:<match-from> subject:(<match-subject>)" --max 5 -j --results-only --no-input`,
picks the most-recent matching thread, then
`gog gmail thread get -a <acct> <threadId> -j` and takes the **last** message's
real `id` as the reply-to message-id. JSON is parsed defensively in python3
(handles `thread get`'s `.thread.messages[]` nesting and `search`'s flat array,
and never crashes on empty / non-JSON output).

### Examples

```bash
# Dry-run: see what would be sent, resolving the account automatically.
gog-reply.sh --to user@example.com --body "On it, thanks." --dry-run

# Pin an account + disambiguate by subject, then actually reply.
gog-reply.sh --to client@example.com \
  --match-subject "invoice" \
  --account <your-account> \
  --body "Attached, let me know if anything's off."
```
