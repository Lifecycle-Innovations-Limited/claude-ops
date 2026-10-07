# Inbox read paths

Loaded from the parent SKILL.md. Follow `ops-rules` and current host policy.
Read the installed tool schema/help before calls; names below are discovery hints,
not guaranteed API parameters. Load only tools needed for the current candidate.

## Email and calendars

- `gog auth list`: enumerate configured mailboxes; keep results account-labelled.
- `gog gmail search`: candidate discovery per mailbox across All Mail, including
  archived/read mail and discovered todo/action/follow-up labels, not just INBOX.
  Bound and disclose lookback; paginate rather than treating the first page as all.
- `gog gmail thread get <threadId> -j`: full chain, typically `thread.messages[]`.
- `gog gmail get <messageId> -j` / `gog gmail raw <messageId>`: inspect source
  body/headers and authoritative labels. Search envelopes alone do not prove SENT.
- `gog calendar events --all` for relevant dates, plus all configured calendar,
  show/tour/travel sources for an availability claim.

Use the actual mailbox/account options from current installed help. Replies are
samimizer `message` only, with canonical thread/reply-all identifiers. Never use
an independent CLI or raw API send route from this reference.

## WhatsApp

Resolve `ops-wa-accounts --list` when installed, then load the actual account's
read tools. Multi-account registration names alone do not prove either coverage
or current routing; verify account-specific output.

Read tools may include `list_chats`, `list_messages`, `search_contacts`, `get_chat`,
and `get_message_context`. Read both directions for each authoritative JID/LID
pair, deduplicate mirror message IDs and account for every connected account.
Read only enabled authorized accounts; disabled accounts remain explicit coverage
gaps, never an implicit clean zero. Stored `last_message_time` or unread/archive flags do not prove the latest
request state. Keep account/source retention gaps explicit.

Use only existing host-approved live/snapshot/merged-thread read helpers. A client
read failure does not authorize local-store fallback, pairing, restart, backfill,
auth repair, session reset or raw transport. Sends use samimizer `message`.

## Slack

Enumerate every Slack workspace and actual tool binding. Load scoped read/search
schemas: `channels_me` for allowed `im,mpim` and `public_channel,private_channel`,
`conversations_history`, `conversations_replies` and supported message search.
Read every relevant reply thread and user mention; paginate. Unread is never a
reply-debt filter. One workspace's tool result proves only that workspace.

## Other sources

Read allowlisted iMessage conversations through its installed plugin. Use configured
user-auth Telegram, scoped Discord reads and Notion page/comments/task reads. No
allowlist changes, profile switching or new setup during triage. If the installed
outbound gate does not support a channel, keep its reply owned with that gap; do
not call a separate sender.

## Authorized archive verification

Sending does not grant archive authorization. After explicit authorization and
confirmed resolution, use the installed supported account-specific archive path.
For Gmail thread IDs, inspect whether the installed archive command requires
`--thread`; verify live raw label state rather than cached search envelopes.
For WhatsApp discover the account-specific `get_chat` read schema and inspect
its actual archived flag for each authoritative phone JID and every LID after
the archive call. Record the exact account/JID and readback surface, not a cached
list or a successful write response. If the schema omits the flag, keep unknown.
For a phone/browser archive claim, use the existing host-approved WhatsApp Web
or connected client archive-state read for that same account/profile: bridge
metadata alone is not phone/browser proof. A false, missing or inaccessible
readback remains owned archive failure/unknown and prevents inbox-zero claims.
No archive on a channel lacking a supported archive operation. No hardcoded
endpoints, new browser pairing, integration mutations or security-repair ladder.
