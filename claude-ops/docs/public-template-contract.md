# Public template/config contract

Claude Ops upstream docs, templates, and tests must stay portable. Any machine-, organization-, person-, channel-, or runtime-specific value belongs in user config or a runtime adapter, not in public plugin content.

## Configuration keys

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `OPS_PLUGIN_ROOT` | path | discovered package/plugin root | Root of the installed Claude Ops plugin. |
| `OPS_DATA_DIR` | path | `${XDG_STATE_HOME:-$HOME/.local/state}/claude-ops` | Writable state and generated data. |
| `OPS_CONFIG_PATH` | path | `${XDG_CONFIG_HOME:-$HOME/.config}/claude-ops/config.yaml` | User-owned configuration file. |
| `OPS_CACHE_DIR` | path | `${XDG_CACHE_HOME:-$HOME/.cache}/claude-ops` | Cache files safe to delete. |
| `OPS_RUNTIME_ADAPTER` | string | `claude-code` | Runtime integration layer. |
| `ORG_NAME` | string | none | User-supplied display label for organization workflows. |
| `PROJECT_ROOTS` | list[path] | none | User-supplied repository roots. |
| `ISSUE_TRACKER_PROVIDER` | string | none | Issue tracker adapter, for example Linear, GitHub, or Jira. |
| `LINEAR_TEAM_KEY` | string | none | Optional team key when the issue tracker adapter is Linear. |
| `APPROVAL_CHAIN` | list | none | User-configured approval roles. |
| `COMM_CHANNELS` | map | none | User-configured communication destinations. |
| `SERVICE_REGISTRY_PATH` | path | none | Optional user-owned service registry file. |
| `MCP_CAPABILITIES` | map | runtime-discovered | Capability-to-tool mapping. |
| `SECRET_PROVIDER` | string | `env` | Secret backend, for example environment, 1Password, or Doppler. |

## Placeholder rules

| Local/private value | Public replacement |
| --- | --- |
| Absolute local path | `$HOME`, XDG dirs, package-relative paths, `{{PLUGIN_ROOT}}`, `{{OPS_DATA_DIR}}` |
| Organization, project, or company name | `{{ORG_NAME}}`, `{{PROJECT_NAME}}` |
| Person, username, or approval identity | `{{USER_NAME}}`, `{{APPROVER}}`, `{{ASSIGNEE}}` |
| Email address | `{{CONTACT_EMAIL}}` or a reserved `example.com` address |
| Chat or channel ID | `{{APPROVAL_CHANNEL}}`, `{{COMM_CHANNELS.review}}` |
| Repository path | `{{ORG}}/{{REPO}}` or `{{PROJECT_ROOT}}` |
| Legacy task system name | `legacy task system` |
| Runtime-specific primitive | runtime adapter or capability name |
| Concrete MCP tool function | capability name, for example `issue_tracker.search` |

## Runtime adapter wording

Describe behavior as a capability first, then map it in runtime-specific docs.

| Capability | Claude Code adapter wording | Generic wording |
| --- | --- | --- |
| Shell command | Bash/Shell | host shell command capability |
| Read file | Read | file read capability |
| Write or edit file | Write/Edit | file write/edit capability |
| Search files | Grep/Glob | file search capability |
| Spawn worker | Task adapter | runtime task adapter |
| Ask user | Ask user adapter | user decision adapter |
| Fetch web content | Web fetch/search | web research capability |
| Issue tracker | configured MCP/API | issue tracker capability |

## Public PR gate

A public PR is not ready unless:

1. The diff contains no hardcoded local absolute paths.
2. The diff contains no private organization, project, person, email, or channel values.
3. The diff contains no real chat IDs, private service URLs, or internal repo names.
4. Runtime-specific primitives are behind an adapter or clearly isolated in runtime docs.
5. Example config uses placeholders and neutral examples only.
6. The public-content sanitizer passes on changed docs, templates, and tests.
