# Good public sanitizer fixture

Use placeholders in public docs:

- `{{ORG_NAME}}`
- `{{CONTACT_EMAIL}}`
- `{{APPROVAL_CHANNEL}}`
- `{{PLUGIN_ROOT}}`
- `${XDG_STATE_HOME:-$HOME/.local/state}/claude-ops`

Runtime-specific behavior should be described as a capability or adapter.
