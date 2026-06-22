# MCP servers approval policy

## Default posture

Treat all MCP server changes as **medium–high risk**. Do not auto-approve unless every condition below is met.

## Auto-approve when ALL are true

- Change is test-only or documentation inside `claude-ops/mcp-servers/**`
- OR narrow bugfix with no new tools, scopes, network hosts, or filesystem paths
- Bugbot and Security Agent report no findings
- No secrets, tokens, or PII handling logic added or relaxed

## Never auto-approve

- New MCP tools or expanded tool permissions
- New outbound network destinations or SSRF-prone URL fetch patterns
- Authentication or token passthrough changes
- Dependency upgrades that alter MCP SDK major versions without maintainer sign-off

## Reviewer routing

- Request platform maintainers for any runtime MCP server change
