---
description: "Live agentic desktop + browser control via OAuth (no API key)"
allowed-tools: [Bash, Read]
---

# /desktop:act — autonomous goal execution

Routes the goal through the desktop-act MCP server. The server uses
claude-agent-sdk (bundled CLI + OAuth) so no Anthropic API key is required —
costs are covered by a Claude Max subscription.

Usage:
- `/desktop:act <goal>` — kick off the loop (`act` tool, `max_iterations`)
- Live view: use the `novnc_url` returned by `ensure_desktop` / `acquire_desktop`
  (pool noVNC base defaults to port **6082**, not a fixed host port)
- Reasoning streams as normal chat output

For finer control with full reasoning visibility, call the MCP primitives
directly: `mcp__desktop-act__screenshot()`, then Read the path, then
`mcp__desktop-act__click(x, y)`, etc.

## Goal

$ARGUMENTS
