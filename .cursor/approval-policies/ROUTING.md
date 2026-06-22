- product: Documentation
  boundary: "{claude-ops/docs/**,docs/**,**/README.md,**/CHANGELOG.md}"
  policies:
    - .cursor/approval-policies/docs-policy.md

- product: Skills and prompts
  boundary: "claude-ops/skills/**"
  policies:
    - .cursor/approval-policies/skills-policy.md

- product: Safety hooks and automation hooks
  boundary: "{claude-ops/hooks/**,hooks/**,.cursor/hooks/**}"
  policies:
    - .cursor/approval-policies/hooks-policy.md

- product: CI and release workflows
  boundary: ".github/workflows/**"
  policies:
    - .cursor/approval-policies/ci-policy.md

- product: MCP servers and integrations
  boundary: "claude-ops/mcp-servers/**"
  policies:
    - .cursor/approval-policies/mcp-policy.md

- product: Daemons launchd and background services
  boundary: "{claude-ops/launchd/**,claude-ops/scripts/**}"
  policies:
    - .cursor/approval-policies/daemon-policy.md

- product: Plugin core runtime
  boundary: "{claude-ops/bin/**,claude-ops/lib/**,claude-ops/agents/**,claude-ops/config/**}"
  policies:
    - .cursor/approval-policies/runtime-policy.md

- product: Tests
  boundary: "{claude-ops/tests/**,**/test/**,**/*.test.*,**/*.spec.*}"
  policies:
    - .cursor/approval-policies/tests-policy.md
