#!/usr/bin/env bash
# Helpers for moving the Unreleased changelog body into one versioned release.

release_unreleased_body() {
  local changelog="$1"
  awk '
    /^## Unreleased[[:space:]]*$/ { in_unreleased=1; next }
    in_unreleased && /^## / { exit }
    in_unreleased { lines[++n]=$0 }
    END {
      first=1; last=n
      while (first <= last && lines[first] ~ /^[[:space:]]*$/) first++
      while (last >= first && lines[last] ~ /^[[:space:]]*$/) last--
      for (i=first; i<=last; i++) print lines[i]
    }
  ' "$changelog"
}

release_write_changelog() {
  local changelog="$1" section_file="$2" output="$3"
  awk -v secfile="$section_file" '
    function emit_sec(  line) {
      while ((getline line < secfile) > 0) print line
      close(secfile)
      print ""
    }
    /^## Unreleased[[:space:]]*$/ {
      print "## Unreleased"
      print ""
      emit_sec()
      found=1
      skip=1
      next
    }
    skip && /^## / { skip=0 }
    skip { next }
    { print }
    END {
      if (!found) {
        print ""
        print "## Unreleased"
        print ""
        emit_sec()
      }
    }
  ' "$changelog" > "$output"
}
