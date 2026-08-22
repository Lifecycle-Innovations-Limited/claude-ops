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
bash claude-ops/tests/outbound-guard/test-shared-guard.sh      # cross-language agreement
python3 claude-ops/tests/outbound-guard/test-hook-matrix.py    # block/pass per send path
python3 claude-ops/tests/outbound-guard/test-broken-alias.py   # broken alias outranks approval
```

The matrix test checks every send path blocks without an approval (WhatsApp per account,
the bridge curl on either port, `gog gmail send`, `gog gmail drafts send`, the Gmail MCP
tool, Slack) and that read-only calls still pass (search, archive, list). Point it at a
specific hook with `OUTBOUND_HOOK=/path/to/block-outbound-comms.py`.
