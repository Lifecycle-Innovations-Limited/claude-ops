# ops-settings — detailed reference

Loaded from the parent SKILL.md. Follow `ops-rules`.

## CLI/API Reference

| Command                                              | Purpose                  |
| ---------------------------------------------------- | ------------------------ |
| `cat "$PREFS" \| jq 'keys'`                          | List all configured keys |
| `jq --arg v "$V" --arg k "$K" '.[$k] = $v' "$PREFS"` | Update a single key      |
| `gh auth status`                                     | Verify GitHub CLI auth   |
| `aws sts get-caller-identity`                        | Verify AWS auth          |
