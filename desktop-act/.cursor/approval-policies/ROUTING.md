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
