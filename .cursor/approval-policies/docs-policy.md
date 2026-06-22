# Documentation approval policy

## Auto-approve when

- Changes are limited to markdown, comments, or generated reference docs
- No executable code, hook config, workflow YAML, or secret placeholders are modified
- Bugbot and Security Agent report no findings

## Never auto-approve

- Docs that embed credentials, tokens, or live infrastructure endpoints not already public
- Docs changes bundled with runtime logic changes in the same PR (evaluate under the stricter runtime policy)

## Reviewer routing

- Docs-only PRs: no specialist reviewer required
- Docs + code: route to maintainers for the non-doc paths
