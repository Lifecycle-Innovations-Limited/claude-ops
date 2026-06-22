- product: Documentation
  boundary: "{docs/**,**/README.md,**/CHANGELOG.md,**/*.md}"
  policies:
    - .cursor/approval-policies/docs-policy.md

- product: CI and workflows
  boundary: ".github/workflows/**"
  policies:
    - .cursor/approval-policies/ci-policy.md

- product: Tests
  boundary: "{**/test/**,**/tests/**,**/*.test.*,**/*.spec.*,e2e/**}"
  policies:
    - .cursor/approval-policies/tests-policy.md

- product: Application runtime
  boundary: "{src/**,app/**,lib/**,packages/**,convex/**,agents/**,lambdas/**}"
  policies:
    - .cursor/approval-policies/runtime-policy.md

- product: Hooks and safety
  boundary: "{hooks/**,.cursor/hooks/**,**/hooks/**}"
  policies:
    - .cursor/approval-policies/hooks-policy.md

- product: MCP servers
  boundary: "**/mcp-servers/**"
  policies:
    - .cursor/approval-policies/mcp-policy.md

- product: Repository automation scripts
  boundary: "{scripts/**,claude-ops/scripts/**}"
  policies:
    - .cursor/approval-policies/scripts-policy.md
