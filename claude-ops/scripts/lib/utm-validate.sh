#!/usr/bin/env bash
# scripts/lib/utm-validate.sh — UTM parameter enforcement library
#
# Source this file to get utm_validate.
#
# Usage:
#   . "${PLUGIN_ROOT}/scripts/lib/utm-validate.sh"
#   utm_validate "$utm_source" "$utm_medium" "$utm_campaign" || exit 1
#
# Conforms to the standard documented in data/gtm/utm-attribution-standard.md.
# Returns 0 on valid input, 1 with a diagnostic on stderr on violation.
#
# Rule 0: public repo — no real project identifiers in this file.

# Regex fragments (POSIX ERE)
_UTM_TOKEN='[a-z0-9][a-z0-9_-]*'                    # single token: starts with alnum, continues with alnum/underscore/dash
_UTM_SOURCE_RE="^${_UTM_TOKEN}$"                     # source: one token
_UTM_MEDIUM_RE="^${_UTM_TOKEN}$"                     # medium: one token
_UTM_CAMPAIGN_RE="^${_UTM_TOKEN}_${_UTM_TOKEN}_[0-9]{8}$"  # campaign: token_token_YYYYMMDD

# utm_validate <utm_source> <utm_medium> <utm_campaign>
# Returns 0 if all three conform; 1 otherwise.
# Writes diagnostic to stderr on failure.
utm_validate() {
  local source="${1:-}" medium="${2:-}" campaign="${3:-}"
  local ok=0

  if [ -z "$source" ]; then
    echo "utm_validate: utm_source is required" >&2
    ok=1
  elif ! echo "$source" | grep -qE "$_UTM_SOURCE_RE"; then
    echo "utm_validate: utm_source '${source}' invalid — must match ${_UTM_SOURCE_RE}" >&2
    ok=1
  fi

  if [ -z "$medium" ]; then
    echo "utm_validate: utm_medium is required" >&2
    ok=1
  elif ! echo "$medium" | grep -qE "$_UTM_MEDIUM_RE"; then
    echo "utm_validate: utm_medium '${medium}' invalid — must match ${_UTM_MEDIUM_RE}" >&2
    ok=1
  fi

  if [ -z "$campaign" ]; then
    echo "utm_validate: utm_campaign is required" >&2
    ok=1
  elif ! echo "$campaign" | grep -qE "$_UTM_CAMPAIGN_RE"; then
    echo "utm_validate: utm_campaign '${campaign}' invalid — must match <name>_<variant>_YYYYMMDD (e.g. summer-sale_v1_20260601)" >&2
    ok=1
  fi

  return $ok
}
