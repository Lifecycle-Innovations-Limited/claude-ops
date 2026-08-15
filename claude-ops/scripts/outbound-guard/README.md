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

`outbound_guard.py` and `outbound-guard.mjs` are the same logic in two languages,
reading and writing one file:

```
/tmp/.claude-outbound-guard.json
{"remaining": 3, "minted": 1786732800, "ttl": 900, "spent": {"<fingerprint>": 1786732801}}
```

A message is identified by recipient plus content:
`sha256(recipient|whitespace-normalised body, first 400 chars)`, first 32 hex chars.
Both languages compute it identically, which is what the test suite checks first.

When a guard sees a fingerprint it has already recorded within `SPENT_WINDOW_SEC`
(120s), that is the same message arriving at a second layer. It passes and nothing is
deducted. So one message costs exactly one unit no matter how many guards it crosses,
and the approval count means what it says.

If the shared file is absent, both sides fall back to the old single-use token so a
partially migrated environment keeps working rather than failing open or shut.

## Arming

```
ok           1 message,   2 minute window
ok 3         3 messages, 15 minute window
ok all       10 messages, 15 minute window   (also: ok these)
```

`all` is capped, not unlimited. Every draft is still shown to the owner individually
before it goes; the counter only removes the need to retype the approval per message.

## Two rules for anyone adding a send path

**Run sends inline.** The hook reads the text of the command. A send hidden inside a
script file is invisible to it. Build and print the command from a helper if you like,
then run the real thing inline. The helpers in this repo refuse to send for that reason.

**Match tool names by pattern, never by exact string.** Accounts get added. An exact
list silently stops covering `-nl`, `-us`, or any future suffix, and the failure is
invisible: the hook still runs, still logs nothing, and allows everything.

## Tests

```
bash claude-ops/tests/outbound-guard/test-shared-guard.sh     # cross-language agreement
python3 claude-ops/tests/outbound-guard/test-hook-matrix.py   # block/pass per send path
```

The matrix test checks every send path blocks without an approval (WhatsApp per account,
the bridge curl on either port, `gog gmail send`, `gog gmail drafts send`, the Gmail MCP
tool, Slack) and that read-only calls still pass (search, archive, list). Point it at a
specific hook with `OUTBOUND_HOOK=/path/to/block-outbound-comms.py`.
