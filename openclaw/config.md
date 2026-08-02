---
title: "claude-ops Configuration"
type: config
tags: [ops, config, system]
created: 2026-08-03
---

# claude-ops Configuration

## Owner
- **Name:** Sam Feldt
- **Timezone:** Europe/Amsterdam
- **Email:** sam.renders@gmail.com

## Channels
| Channel | Status | Notes |
|---------|--------|-------|
| Telegram | ✅ Active | @KikiKimiClawBot |
| WhatsApp | ✅ Active | wacli outbound |
| Email | ⚠️ Check | Gmail OAuth may need refresh |
| Slack | ❌ Not configured | — |

## Projects
| Project | Repo | Status | Priority |
|---------|------|--------|----------|
| Healify | — | Active | P0 |
| RYTEBOX | — | Active | P1 |
| Brand Relaunch | — | Active | P1 |
| Malar Group | — | Active | P2 |

## Integrations
| Service | Status | Config |
|---------|--------|--------|
| g-brain | ✅ | https://gbrain.brein.dev/mcp |
| mem-zero | ✅ | https://mem0.brein.dev/mcp |
| GitHub | ✅ | Personal token |
| Feishu | ✅ | OAuth active |
| Vercel | ✅ | Art's team |

## Health Check Schedule
- **Heartbeat:** Every 30 min (Telegram)
- **Morning briefing:** Daily 08:00 CET
- **System health:** Every 4 hours

## Alerts
- 🚨 Urgent: Immediate Telegram
- ⚠️ Warning: Batch every 30 min
- ℹ️ Info: Morning briefing only
