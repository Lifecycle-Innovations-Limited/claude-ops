# claude-ops — Business Operating System for Claude Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./claude-ops/LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)](https://github.com/auroracapital/claude-ops/releases)
[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-Plugin-blueviolet.svg)](https://github.com/anthropics/claude-plugins-official)
[![Stars](https://img.shields.io/github/stars/auroracapital/claude-ops?style=social)](https://github.com/auroracapital/claude-ops/stargazers)

A **claude code plugin** that turns Claude into a complete business operating system. One command — `/ops:go` — delivers a morning briefing covering every dimension of your business: infrastructure health, CI/CD status, unread messages, open PRs, sprint state, and revenue snapshot.

```bash
# Install — add to Claude Code settings.json
{
  "plugins": [{ "source": "https://github.com/auroracapital/claude-ops" }]
}
# Then run:
/ops:setup
```

> Also installable via: `/plugin install claude-ops@claude-plugins-official`

---

## What claude-ops does

| Area | Skills | Integrations |
|------|--------|--------------|
| Morning briefing | `/ops:go` — full cross-platform snapshot | GitHub, Linear, Sentry, AWS |
| Inbox zero | `/ops:inbox` — read + triage all channels | Slack, Telegram, WhatsApp, email |
| PR automation | `/ops:merge` — autonomous PR review + merge pipeline | GitHub |
| Slack integration | `/ops:comms slack` — send/read messages | Slack API |
| Telegram bot | `/ops:comms telegram` — full message history | Telegram MTProto |
| WhatsApp automation | `/ops:comms whatsapp` — WhatsApp Web bridge | WhatsApp |
| DevOps dashboard | `/ops:fires` — production incidents + ECS health | AWS ECS, Sentry |
| Revenue tracker | `/ops:revenue` — AWS spend + billing snapshot | AWS Cost Explorer |
| Project status | `/ops:projects` — all active projects at a glance | Linear, GitHub |
| YOLO mode | `/ops:yolo` — 4 parallel C-suite agents, fully autonomous | Everything |

---

## Why claude-ops vs manual

| Without claude-ops | With claude-ops |
|--------------------|-----------------|
| Open 6 tabs every morning | `/ops:go` — one command, 60 seconds |
| Manually check Slack + Telegram + email | `/ops:inbox` — unified inbox, zero switching |
| Copy-paste PR descriptions | `/ops:merge` — full PR automation pipeline |
| SSH into servers to check health | `/ops:fires` — production dashboard in Claude |
| Forget to track AWS spend | `/ops:revenue` — automatic cost snapshot |
| Context-switch between Linear + GitHub | `/ops:linear` + `/ops:projects` — unified view |

---

## Features

- **Morning briefing** — infra health, CI status, unread messages, open PRs, sprint velocity, revenue in one shot
- **Inbox zero** — unified read/triage across Slack, Telegram, WhatsApp, and email
- **PR automation** — autonomous review, approval, and merge pipeline with `/ops:merge`
- **Slack integration** — full send/read/search via Slack API
- **Telegram bot** — MTProto client, full message history and send
- **WhatsApp automation** — WhatsApp Web bridge for automated messaging
- **DevOps dashboard** — ECS health, Sentry incidents, CloudWatch alerts
- **Revenue tracker** — AWS Cost Explorer snapshot, spend anomaly detection
- **YOLO mode** — 4 parallel autonomous agents handling all ops simultaneously
- **Business operations** — `/ops:linear`, `/ops:deploy`, `/ops:next`, and 15+ more skills

---

## Installation

Add to `~/.claude/settings.json`:

```json
{
  "plugins": [
    {
      "source": "https://github.com/auroracapital/claude-ops"
    }
  ]
}
```

Then configure integrations:

```
/ops:setup
```

The setup wizard walks through Slack, Telegram, Linear, Sentry, and AWS configuration. All credentials stored locally — never transmitted.

---

## Skill Reference

| Skill | Description |
|-------|-------------|
| `/ops:go` | Token-efficient morning briefing across all platforms |
| `/ops:inbox` | Full inbox management — read, triage, reply |
| `/ops:comms` | Send and read messages across Slack, Telegram, WhatsApp |
| `/ops:merge` | Autonomous PR merge pipeline |
| `/ops:fires` | Production incidents dashboard |
| `/ops:deploy` | Deploy status across all projects |
| `/ops:revenue` | Revenue and AWS cost tracker |
| `/ops:projects` | Portfolio dashboard |
| `/ops:linear` | Linear command center |
| `/ops:next` | Business-level "what should I do next" |
| `/ops:yolo` | Spawns 4 parallel C-suite agents for autonomous ops |
| `/ops:triage` | Cross-platform issue triage (Sentry + Linear + GitHub) |
| `/ops:setup` | Interactive setup wizard |

---

## Screenshots / Demo

> Screenshots and GIF demo coming soon. Star the repo to get notified.

---

## Repository Structure

```
claude-ops-marketplace/
├── .claude-plugin/
│   └── marketplace.json   # Marketplace registry
└── claude-ops/            # Plugin source
    ├── README.md          # Full plugin documentation
    ├── skills/            # All /ops:* skill implementations
    ├── agents/            # Autonomous agent definitions
    ├── bin/               # CLI entry points
    └── hooks/             # Claude Code lifecycle hooks
```

---

## Contributing

PRs welcome. See [`claude-ops/README.md`](./claude-ops/README.md) for full documentation.

## License

[MIT](./claude-ops/LICENSE) — built by [auroracapital](https://github.com/auroracapital)
