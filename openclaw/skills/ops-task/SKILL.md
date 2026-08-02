---
name: ops-task
description: "Task management with priorities, deadlines, and context."
triggers:
  - "ops:task"
  - "task"
  - "todo"
  - "tasks"
usable_tools:
  - feishu_task_task
  - g-brain__query
---

# OPS:TASK — Task Management

## Commands

| Command | Action |
|---------|--------|
| `ops:task add "description"` | Create new task |
| `ops:task list` | Show all tasks |
| `ops:task done <id>` | Mark complete |
| `ops:task priority <id> <high/medium/low>` | Set priority |

## Integration

Tasks are stored in:
- **Primary**: Feishu Tasks (for UI + mobile)
- **Backup**: g-brain facts (for long-term memory)

## Priority Rules

- 🔴 P0 — Urgent, < 2h (calendar events, blocked deployments)
- 🟡 P1 — Today (PR reviews, follow-ups)
- 🟢 P2 — This week (planning, research)
- ⚪ P3 — Backlog (nice to have)
