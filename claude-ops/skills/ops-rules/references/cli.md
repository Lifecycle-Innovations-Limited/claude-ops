# CLI reference (exact syntax)


### gog (v0.12.0+)

#### Top-level commands

auth, gmail, calendar, contacts, drive, docs, slides, sheets, forms, tasks, keep, chat, people, appscript, config

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

#### Gmail — Send & Reply

```bash
gog gmail send --to "user@example.com" --subject "subj" --body "text"                    # Send new email
gog gmail send --to "a@b.com" --subject "Re: ..." --body "reply" --reply-to-message-id <msgId>  # Reply
gog gmail send --reply-to-message-id <msgId> --reply-all --body "reply text"             # Reply all
gog gmail send --to "a@b.com" --subject "subj" --body "text" --attach /path/to/file      # With attachment
```

#### Gmail — Labels & Drafts

```bash
gog gmail labels list -j                                            # List all labels
gog gmail labels modify <threadId> --add LABEL --remove LABEL       # Modify thread labels
gog gmail messages modify <messageId> --add LABEL --remove LABEL    # Modify message labels
gog gmail drafts list -j                                            # List drafts
gog gmail drafts create --to "user@example.com" --subject "subj" --body "text"
```

#### Calendar

```bash
gog calendar calendars -j                                           # List calendars
gog calendar events --all --today -j --sort start                   # Today's events across ALL calendars (preferred)
gog calendar events primary --today -j                              # Today's events — primary calendar only
gog calendar events primary --from "2026-04-14" --to "2026-04-15" -j  # Date range
gog calendar create primary --summary "Meeting" --from "2026-04-15T10:00:00" --to "2026-04-15T11:00:00"
gog calendar freebusy --from "2026-04-14T00:00:00Z" --to "2026-04-14T23:59:59Z" -j
```

#### Contacts / Drive / Tasks

```bash
gog contacts search "name" -j                                       # Search contacts
gog contacts list -j                                                # List all contacts
gog drive ls -j                                                     # List files
gog drive search "query" -j                                         # Search files
gog drive download <fileId>                                         # Download file
gog tasks lists                                                     # List task lists
gog tasks list <tasklistId> -j                                      # List tasks
```

#### Auth

```bash
gog auth status                                                     # Check auth status
gog auth add user@example.com --services gmail,calendar,drive,contacts,docs,sheets
```
