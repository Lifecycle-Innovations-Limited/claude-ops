#!/usr/bin/env bash
# lib/registry-resolve.sh — schema-tolerant readers for registry.json
#
# registry.json is operationally owned by ops-gsd-registry-sync, which writes
# the GSD project schema (.name/.path/.remote_url/.phase/...). Older gatherers
# (ops-git, ops-prs) were written against the partner-registry template schema
# (.alias/.paths[]/.repos[]) and crash on the GSD schema ("Cannot iterate over
# null"). These resolvers read EITHER shape, null-guarded, so a gatherer never
# crashes regardless of which writer last touched the file.
#
# Source after registry-path.sh:
#   . "${SCRIPT_DIR}/../lib/registry-resolve.sh"
#
# Functions emit to stdout; callers capture with $(...).

# ops_registry_repos <registry_path>
# → newline-separated, deduped list of "owner/repo" GitHub slugs.
#   Prefers explicit .repos[]; otherwise derives from .remote_url
#   (handles https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git)).
ops_registry_repos() {
  jq -r '
    [ .projects[]?
      | if (.repos // null) != null then .repos[]?
        elif (.remote_url // "") != "" then
          ( .remote_url
            | sub("^git@github.com:"; "")
            | sub("^https?://github.com/"; "")
            | sub("\\.git$"; "") )
        else empty end
    ]
    | map(select(. != null and . != "" and (contains("/"))))
    | unique | .[]
  ' "$1" 2>/dev/null
}

# ops_registry_paths <registry_path> <index>
# → compact JSON array of filesystem paths for project[index].
#   Prefers .paths[]; otherwise wraps .path. Null/empty entries filtered.
ops_registry_paths() {
  jq -c ".projects[$2] | (.paths // [ .path ]) | map(select(. != null and . != \"\"))" \
    "$1" 2>/dev/null
}

# ops_registry_alias <registry_path> <index>
# → a stable, human-meaningful alias for project[index].
#   Order: .alias → repo name from .remote_url → second-to-last path segment
#   (the repo dir, not the "main"/branch leaf) → .name → proj<index>.
ops_registry_alias() {
  jq -r ".projects[$2] | (
      .alias
      // ( if (.remote_url // \"\") != \"\"
             then (.remote_url | sub(\"\\\\.git\$\"; \"\") | split(\"/\") | last)
             else null end )
      // ( if (.path // \"\") != \"\"
             then (.path | rtrimstr(\"/\") | split(\"/\")
                   | (if length >= 2 and (.[-1] == \"main\" or .[-1] == \"master\")
                        then .[-2] else .[-1] end))
             else null end )
      // .name
      // \"proj$2\"
    )" "$1" 2>/dev/null
}
