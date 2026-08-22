# CLI/API reference

## CLI/API Reference

### whatsapp-bridge (WhatsApp — mcp**whatsapp**\*)

**Bridge health** — check bridge is running before any WhatsApp operation:

```bash
lsof -i :8080 | grep LISTEN
launchctl list com.${USER}.whatsapp-bridge
```

If not running: `launchctl kickstart -k gui/$(id -u)/com.${USER}.whatsapp-bridge`

| Tool                                 | Params                     | Output                                                        |
| ------------------------------------ | -------------------------- | ------------------------------------------------------------- |
| `mcp__whatsapp__list_chats`          | `{sort_by: "last_active"}` | Array of chats with jid, name, last_message_time              |
| `mcp__whatsapp__list_messages`       | `{chat_jid, limit, query}` | Array of messages with is_from_me, content, timestamp, sender |
| `mcp__whatsapp__search_contacts`     | `{query}`                  | Contacts matching name or phone                               |
| `mcp__whatsapp__send_message`        | `{recipient, message}`     | Send result                                                   |
| `mcp__whatsapp__get_chat`            | `{chat_jid}`               | Chat metadata                                                 |
| `mcp__whatsapp__get_message_context` | `{chat_jid, message_id}`   | Message context window                                        |

`whatsapp` above is the single-account server name. With one bridge per account the servers are named
`whatsapp-personal`, `whatsapp-work`, and so on, and plain `mcp__whatsapp__*` does not exist. Resolve
the real name from the available tools first, and send from the account the thread is already on. See
CLAUDE.md Rule 8.

### gog CLI (Gmail/Calendar)

| Command                                                                            | Usage                             | Output                |
| ---------------------------------------------------------------------------------- | --------------------------------- | --------------------- |
| `gog gmail search "in:inbox" --max 50 -j --results-only --no-input`                | Search inbox                      | JSON array of threads |
| `gog gmail thread get <threadId> -j`                                               | Get full thread with all messages | Full message JSON     |
| `gog gmail send --to "user@example.com" --subject "subj" --body "text"`            | Send new email                    | Send result           |
| `gog gmail send --reply-to-message-id <msgId> --reply-all --body "text"`           | Reply all                         | Send result           |
| `gog gmail send --to "a@b.com" --subject "subj" --body "text" --attach /path/file` | With attachment                   | Send result           |
| `gog gmail archive <messageId> ... --no-input --force`                             | Archive messages                  | Archive result        |

---

Parse `$ARGUMENTS` and route immediately:

