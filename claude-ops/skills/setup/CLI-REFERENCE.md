# OPS ► SETUP — CLI Reference

Exact syntax for external CLIs used by the setup wizard and downstream channel skills. **Never guess** — copy from here.

---

## CLI Reference (EXACT SYNTAX — never guess)

### gog (v0.12.0+)

#### Top-level commands
auth, gmail, calendar, contacts, drive, docs, slides, sheets, forms, tasks, keep, chat, people, appscript, config, agent

#### Gmail — Search & Read
```bash
gog gmail search "<query>" --max N -j --results-only --no-input    # Search threads (Gmail query syntax)
gog gmail thread get <threadId> -j                                  # Get full thread with all messages
gog gmail get <messageId> -j                                        # Get single message
```

#### Gmail — Actions
```bash
gog gmail archive <messageId> ... --no-input --force               # Archive messages (remove from inbox)
gog gmail archive --query "<gmail-query>" --max N --force           # Archive by query
gog gmail mark-read <messageId> ... --no-input                     # Mark as read
gog gmail unread <messageId> ... --no-input                        # Mark as unread
gog gmail trash <messageId> ... --no-input --force                 # Move to trash
```

#### Gmail — Labels
```bash
gog gmail labels list -j                                            # List all labels
gog gmail labels modify <threadId> --add LABEL --remove LABEL       # Modify thread labels
gog gmail messages modify <messageId> --add LABEL --remove LABEL    # Modify message labels
```

#### Gmail — Send & Reply
```bash
gog gmail send --to "user@example.com" --subject "subj" --body "text"                    # Send new email
gog gmail send --to "a@b.com" --subject "Re: ..." --body "reply" --reply-to-message-id <msgId>  # Reply
gog gmail send --reply-to-message-id <msgId> --reply-all --body "reply text"             # Reply all
gog gmail send --to "a@b.com" --subject "subj" --body "text" --attach /path/to/file      # With attachment
```

#### Gmail — Drafts
```bash
gog gmail drafts list -j                                            # List drafts
gog gmail drafts create --to "user@example.com" --subject "subj" --body "text"
```

#### Calendar
```bash
gog calendar calendars -j                                           # List calendars
gog calendar events primary --today -j                              # Today's events
gog calendar events primary --from "2026-04-14" --to "2026-04-15" -j  # Date range
gog calendar create primary --summary "Meeting" --from "2026-04-15T10:00:00" --to "2026-04-15T11:00:00"
gog calendar freebusy --from "2026-04-14T00:00:00Z" --to "2026-04-14T23:59:59Z" -j
```

#### Contacts
```bash
gog contacts search "name" -j                                       # Search contacts
gog contacts list -j                                                # List all contacts
```

#### Drive
```bash
gog drive ls -j                                                     # List files
gog drive search "query" -j                                         # Search files
gog drive download <fileId>                                         # Download file
```

#### Tasks
```bash
gog tasks lists                                                     # List task lists
gog tasks list <tasklistId> -j                                      # List tasks
```

#### Auth
```bash
gog auth status                                                     # Check auth status
gog auth add user@example.com --services gmail,calendar,drive,contacts,docs,sheets
```

### whatsapp-bridge

```bash
# Health check
lsof -i :8080 | grep LISTEN --json

# Auth status
whatsapp-bridge auth status --json

# List chats (MUST use subcommand `list`)
whatsapp-bridge chats list --json

# List messages (--after flag uses YYYY-MM-DD)
# macOS
whatsapp-bridge messages list --after="$(date -v-1d +%Y-%m-%d)" --limit=5 --json
# Linux
whatsapp-bridge messages list --after="$(date -d '1 day ago' +%Y-%m-%d)" --limit=5 --json

# Send message
whatsapp-bridge send --to "JID" --message "text"

# Sync (connect and pull)
whatsapp-bridge sync

# Backfill history
whatsapp-bridge history backfill --chat="JID" --count=50 --requests=2 --wait=30s --idle-exit=5s --json

# Contact lookup
whatsapp-bridge contacts --search "name" --json
```

> After setup, the memory-extractor daemon service will populate `memories/contact_*.md` from this contact data.

### Slack token validation

```bash
curl -s -H "Authorization: Bearer XOXC_TOKEN" -b "d=XOXD_TOKEN" "https://slack.com/api/auth.test"
```

### macOS Keychain

```bash
security find-generic-password -s "KEY_NAME" -w 2>/dev/null
security add-generic-password -U -s "KEY_NAME" -a "$USER" -w "VALUE"
security delete-generic-password -s "KEY_NAME" 2>/dev/null
```
