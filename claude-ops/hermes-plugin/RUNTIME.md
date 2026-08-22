# Claude Code → Hermes (ops runtime)

Use this when a claude-ops skill names a Claude Code primitive that Hermes does not have. Keep the skill's intent. Swap the primitive. Do not copy Claude-only assumptions into Hermes.

Grok loads the same Claude plugin (`skills/` + `.claude-plugin/`) — there is no separate `.grok-plugin`. Missing Claude-only tools (`AskUserQuestion`, `Workflow`, `TeamCreate`) use the same fallbacks as this table (numbered options, sequential / native subagents). Rule 6 does not change.

| Claude Code | Hermes |
|---|---|
| `AskUserQuestion` | Numbered options in chat, then wait. Telegram/gateway: two turns — full draft as its own message, then the Send / Edit / Skip card. Never put the draft only in a clipped preview. Max 4 options per card. |
| `Workflow` | `delegate_task` for parallel read-only work. If that tool is missing, run the same scanners sequentially in the main session. |
| `TeamCreate` / `Agent` teams | `delegate_task`. No Claude agent-team steering. |
| `TaskCreate` / `TaskUpdate` / `TaskList` | Hermes Kanban, or skip. Do not require Paperclip. |
| `CronCreate` / `CronList` | `hermes cron`. |
| `mcp__linear__*` | Linear CLI / GraphQL. Resolve the real tool names at runtime. |
| `mcp__whatsapp__*` | Resolve the live server name (Rule 8). Hermes may also have native `whatsapp_*` plugin tools — same Rule 6 send gate. |
| `gh … --admin` | Never. Merge only when required checks pass, the PR is conflict-free, and blocking review threads are resolved. |
| `${CLAUDE_PLUGIN_ROOT}` | Directory that contains `skills/` and `bin/` for this install. Probe `$CLAUDE_PLUGIN_ROOT`, then the installer symlink, then `~/.hermes/plugins/ops/..`. |

## Hard rules that do not change

- Rule 0: public repo, no personal data.
- Rule 6: every outbound message is one draft → one approval → one send.
- Scanners stay read-only. Sends stay in the main session.

## Do not upstream

Host-only paths, account names, chat IDs, and business routing. Those stay in the local overlay, not this plugin.
