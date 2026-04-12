# claude-ops-marketplace

This repository is a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin marketplace that distributes the **claude-ops** plugin — a business operating system for Claude Code.

## Structure

```
claude-ops-marketplace/
├── .claude-plugin/
│   └── marketplace.json   # Marketplace registry (Claude Code reads this)
└── claude-ops/            # Plugin source — skills, agents, bin, hooks
    ├── README.md          # Full plugin documentation
    ├── skills/            # All /ops:* skill implementations
    ├── agents/            # Autonomous agent definitions
    ├── bin/               # CLI entry points
    └── hooks/             # Claude Code lifecycle hooks
```

## Plugin: claude-ops

Turns Claude into a business operating system. One command — `/ops-go` — delivers a complete morning briefing: infra health, CI status, unread messages, open PRs, sprint state, and revenue snapshot.

See [`claude-ops/README.md`](./claude-ops/README.md) for full documentation, installation, and skill reference.

## Installation

Add to your Claude Code `settings.json`:

```json
{
  "plugins": [
    {
      "source": "https://github.com/auroracapital/claude-ops"
    }
  ]
}
```

Then run `/ops:setup` to configure integrations.

## License

[MIT](./claude-ops/LICENSE)
