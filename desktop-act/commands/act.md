---
description: "Live agentic desktop + browser control via OAuth (no API key)"
allowed-tools: [Bash, Read]
---

# /desktop:act — autonomous goal execution

Routes the goal through the desktop-act MCP server. The server uses claude-agent-sdk
(bundled CLI + OAuth) so no Anthropic API key is required — costs are covered by
your Claude Max subscription.

Usage:
- `/desktop:act <goal>` — kick off the loop
- View desktop live at: http://<box-host>:6081 (noVNC)
- Reasoning streams as normal chat output

For finer control with full reasoning visibility, call the MCP primitives directly
in your prompt: `mcp__desktop-act__screenshot()`, then Read the path, then
`mcp__desktop-act__click(x, y)`, etc. That gives streaming transparency Sam asked for
without a separate dashboard.

## Goal

$ARGUMENTS
