# Outbound guard

One approval store for every outbound message, shared by every CLI that can send one.

## The problem this solves

Sending a message went through two independent guards, each with its own token file:

- the PreToolUse hook (`/tmp/.claude-send-ok`, 120s, single use)
- the MCP proxy ledger (`/tmp/.claude-send-ok-all`, a separate counter)

One message crossed both, so arming an approval had to write two files and hope the
counts stayed in step. Other CLIs going through the same proxy saw a third picture.
Three failures came out of that on 2026-08-15:

1. A helper script that wrapped the send hid it from the hook completely. The hook
   matches on the text of the shell command, so `bash send.sh <name>` never tripped it.
   Three emails went out with no audit entry and no token consumed.
2. The hook's tool list was an exact-match tuple containing `mcp__whatsapp__send_message`.
   The machine had moved to two accounts, so the real names were
   `mcp__whatsapp-nl__send_message` and `mcp__whatsapp-us__send_message`. Neither
   matched, so the hook ran and did nothing. Every WhatsApp send was ungated.
3. The local bridge's own REST endpoint (`127.0.0.1:8080/api/send`) had no pattern at
   all, so a plain curl to it was invisible to the guard.

## The design

`outbound-guard.mjs` is the Node twin used by the MCP proxy. It no longer reimplements
the store: it hands every decision to `outbound_guard.py` over stdin, because two
implementations of "which message is this, and was it approved" is exactly what drifted.
The guard it delegates to is the installed one at
`~/.claude/scripts/hooks/outbound_guard.py` (override with `OUTBOUND_GUARD_PY`); when it
cannot be reached, the Node side fails closed.

The copy of `outbound_guard.py` in this directory **is** that guard, and `ok` here is its
companion. Both were shipped forward together, because half a migration is not one: a
reservation-schema Node twin delegating to a count-schema Python guard fails closed on
every send, and a bash `ok` calling the retired `mint <n> <ttl>` arms nothing a
reservation guard will honour.

## What an approval is

An approval is a **signature on one exact message**, never a bearer credit.

```
/tmp/.claude-outbound-guard.json
{"minted": 1786732800, "ttl": 900,
 "approved":     {"<fp>": {"ts": ..., "recipient": "...", "preview": "..."}},
 "inflight":     {"<fp>|<tool>": 1786732801},
 "reservations": {"<fp>": {"at": ..., "recipient": "...", "tool": "...",
                           "session_id": "...", "meta": {...}}}}
```

A message is identified by recipient plus content: `sha256(recipient|body)`, first 32 hex
chars, with the body normalised only by stripping trailing whitespace per line and the
trailing newline. Node and Python compute it identically, which is what the test suite
checks first.

The old schema hashed a whitespace-collapsed body truncated at 400 characters, so two
materially different messages sharing a prefix collided and an approval for one satisfied
the other. It also minted a bare count, which any session could spend on any recipient.
Neither is true any more:

- **`ok` mints a set of fingerprints**, read from the drafts this session already showed
  and queued under `~/.claude/state/outbound-pending/<session>.json`. It verifies every
  record against its own stored fingerprint before minting any of them.
- **`consume()` allows only a send whose fingerprint is in that set.** A different
  recipient or one changed byte finds nothing.
- **A delivered fingerprint is refused forever** by an append-only ledger at
  `~/.claude/state/outbound-sent.jsonl`, written the moment approval is granted. An
  ambiguous delivery leaves a paper trail that blocks a silent duplicate.
- **`inflight`** (120s, keyed on fingerprint *plus tool*) is the only free pass, and it
  covers exactly one case: one message crossing both guards in the same PreToolUse cycle.

`reservations` is phase one of a two-phase commit: the approval is held, not spent, while
the send is attempted, and `commit()` / `release()` settle it. A reservation that outlives
its TTL (`OUTBOUND_RESERVATION_TTL`, 180s) expires rather than stranding the approval. So
a send that never happened does not silently burn the owner's yes.

If the shared file is absent, both sides fall back to the old single-use token so a
partially migrated environment keeps working rather than failing open.

## Keeping the installed twin in sync

`sync-installed-copy.sh` mirrors `outbound-guard.mjs` to
`~/.claude/mcp-proxy/outbound-guard.mjs`. `scripts/setup.sh` runs it on every
SessionStart.

It used to be an unconditional overwrite, and that was a defect in its own right. On one
machine the installed copy was the current reservation-schema guard while the shipped
copy was still the old count-schema one, so every session start tried to **downgrade a
security guard** — silently, because setup.sh called it with `|| true` and stderr on
`/dev/null`. It fails closed, so nothing leaked, but the two-phase commit for
MCP-proxy-routed sends stops working and approvals are never redeemed. The only thing
holding it back was a hand-set `chflags uchg` on the installed file, and 304 leaked
`.tmp.<pid>` files were the evidence that the script had been failing unseen for weeks.

So the sync is now a guarded, one-directional upgrade:

- Both files carry a `// outbound-guard-schema: <id>` marker. Unmarked files are placed
  by content (delegating guard vs. own count store).
- An installed copy whose schema cannot be placed is **refused**, on stderr, non-zero.
- An installed copy newer than the source is refused: sync forward only.
- `--force` / `OUTBOUND_GUARD_SYNC_FORCE=1` is the deliberate override for a repair.
- A failed sync cleans up its own temp file (`trap ... EXIT`).

Bump the marker whenever the contract with `outbound_guard.py` changes, and give the new
id a rank in `schema_rank()`.

## Arming

```
ok           approve the pending draft
ok 2         approve the second draft in the queue
ok all       approve every draft this session has queued
```

`ok` never invents an approval. It reads the queue of drafts this session already showed,
mints exactly those fingerprints, and refuses when the queue is empty, stale, malformed,
or when a record does not match its own fingerprint. So `ok all` is not "ten free sends":
it is a yes to the specific drafts on screen, and nothing else can spend it.

`ok` finds the guard module via `OUTBOUND_GUARD_PY`, else a sibling `outbound_guard.py`
next to it, else the installed hook at `~/.claude/scripts/hooks/outbound_guard.py`.

## Two rules for anyone adding a send path

**Run sends inline.** The hook reads the text of the command. A send hidden inside a
script file is invisible to it. Build and print the command from a helper if you like,
then run the real thing inline. The helpers in this repo refuse to send for that reason.

**Match tool names by pattern, never by exact string.** Accounts get added. An exact
list silently stops covering `-nl`, `-us`, or any future suffix, and the failure is
invisible: the hook still runs, still logs nothing, and allows everything.

## Broken send-as aliases

An alias whose SMTP relay credentials have gone stale fails in the worst possible way.
Gmail accepts the message, stamps it SENT, and only then drops a delivery failure into
the thread, in Trash, under CATEGORY_UPDATES. The sender sees a sent message. The
recipient gets nothing. Nobody notices until the other side chases.

Approving such a send changes nothing, so the guard refuses it outright even when an
approval token is present. The list of bad aliases lives in
`~/.claude/state/broken-send-aliases.json` and is written by `refresh_broken_aliases.py`,
which finds bounce threads and reads the failed alias off the SENT message's From header.
An absent or empty list blocks nothing, so a machine that never runs the refresh keeps
working as before.

Two ways out of a listed alias:

**Fix the relay.** Gmail Settings, Accounts, Send mail as, re-enter the app password.
Then `refresh_broken_aliases.py --clear <address>`.

**Skip the relay.** If a Workspace service account can impersonate the mailbox, sending
_as_ that mailbox over the API never touches the send-as relay and needs no app password:

```
gog -a alias@example.com gmail send --to ... --subject ... --body ...
```

The guard checks for a service account file and names this command in the block message
when one exists.

`gog-sa-token` covers the case where that still fails with `unauthorized_client`. gog
requests its whole scope bundle in one token request, so a Workspace that delegated only
`gmail.send` and `gmail.readonly` refuses the entire request, and a mailbox that can in
fact send looks completely unreachable. Minting a narrow token sidesteps it:

```
gog --access-token "$(gog-sa-token alias@example.com send)" -a alias@example.com gmail send ...
```

## Tests

```
bash claude-ops/tests/outbound-guard/test-shared-guard.sh        # Node -> Python delegation contract
bash claude-ops/tests/outbound-guard/test-installed-copy-sync.sh # sync refuses downgrades
python3 claude-ops/tests/outbound-guard/test-hook-matrix.py    # block/pass per send path
python3 claude-ops/tests/outbound-guard/test-broken-alias.py   # broken alias outranks approval
```

The matrix test checks every send path blocks without an approval (WhatsApp per account,
the bridge curl on either port, `gog gmail send`, `gog gmail drafts send`, the Gmail MCP
tool, Slack) and that read-only calls still pass (search, archive, list). Point it at a
specific hook with `OUTBOUND_HOOK=/path/to/block-outbound-comms.py`.
