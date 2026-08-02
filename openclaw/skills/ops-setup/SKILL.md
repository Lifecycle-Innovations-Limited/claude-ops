---
name: ops-setup
description: "Setup wizard for claude-ops. Configures all integrations, channels, and services."
triggers:
  - "ops:setup"
  - "setup ops"
  - "configure ops"
  - "ops_setup"
category: Setup
usable_tools:
  - exec
  - read
  - edit
  - write
  - message
---

# OPS:SETUP — Configuration Wizard

## Step-by-Step Setup

### Step 1: Owner Configuration
```
Owner name: Sam Feldt
Timezone: Europe/Amsterdam
Email: sam.renders@gmail.com
```

### Step 2: Channel Configuration
| Channel | Status | How to configure |
|---------|--------|-----------------|
| Telegram | ✅ Active | Bot: @KikiKimiClawBot |
| WhatsApp | ✅ Active | wacli outbound |
| Email | ⚠️ Check | Gmail OAuth required |
| Slack | ❌ Optional | OAuth via Claude.ai |

### Step 3: Service Integration
| Service | Status | Config location |
|---------|--------|----------------|
| g-brain | ✅ | https://gbrain.brein.dev/mcp |
| mem-zero | ✅ | https://mem0.brein.dev/mcp |
| GitHub | ✅ | ~/.openclaw/secrets/.env.credentials |
| Feishu | ✅ | OAuth active |
| Vercel | ✅ | Art's team token |

### Step 4: Project Registration
```yaml
projects:
  - name: Healify
    status: active
    priority: P0
  - name: RYTEBOX
    status: active
    priority: P1
  - name: Brand Relaunch
    status: active
    priority: P1
  - name: Malar Group
    status: active
    priority: P2
```

### Step 5: Health Checks
- Heartbeat: Every 30 min
- Morning briefing: Daily 08:00 CET
- System health: Every 4 hours

### Step 6: Telegram Commands
All ops commands are available as /ops_* bot commands:
- /ops — Dashboard
- /ops_go — Morning briefing
- /ops_status — Health check
- /ops_inbox — Unified inbox
- ... (51 total commands)

## Post-Setup

Run `/ops:go` to test the morning briefing.
Run `/ops:status` to verify all systems.

## Troubleshooting

If any integration fails:
1. Check credentials in ~/.openclaw/secrets/.env.credentials
2. Verify OAuth tokens are not expired
3. Run `/ops:doctor` for auto-repair
