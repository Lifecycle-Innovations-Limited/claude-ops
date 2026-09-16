#!/usr/bin/env bash
# pii-patterns.sh — THE pattern source for every PII surface in this repo.
#
# WHY THIS FILE EXISTS
#
# `pii-gate` scanned FILES. On 2026-09-16 a personal name reached a public
# commit message and a public pull-request body, and the gate passed the whole
# time, because neither of those is a file. A later sweep found a personal
# email, a phone number, an AWS account id and a cloud budget UUID quoted
# verbatim in old PR descriptions — same root cause.
#
# The fix is not another scanner. It is ONE pattern list that the local hooks,
# the CI job and the tests all read, so the surfaces can never drift apart.
# Before this, the pre-commit hook and `test-no-secrets.sh` each carried their
# own copy of the patterns, and they had already diverged.
#
# WHAT IS AND IS NOT IN HERE
#
# Shapes only. Not one real personal value appears in this file, or in any file
# this gate ships. The operator's actual names, handles, account ids and phone
# numbers reach the gate two other ways:
#   - cleartext, from an out-of-repo denylist (developer machines), and
#   - salted SHA-256 digests in pii-term-digests.txt (works in CI).
# See pii-digest.py for why both exist.
#
# TWO SEVERITIES
#
#   BLOCK  high confidence; refuses the commit, the push, or the PR.
#   WARN   shapes with a real false-positive rate that also have legitimate
#          fixtures in this tree (documented CGNAT examples, an all-zero EC2
#          id, reserved phone ranges, WhatsApp JID fixtures). Printed, never
#          fatal. Promoting one of these to BLOCK means first proving the
#          current tree still passes — `test-pii-metadata-gate.sh` asserts it.
#
# RULE FORMAT — five TAB-separated fields:
#   <label> <regex> <allow-regex or -> <flags or -> <description>
# flags: 'i' case-insensitive. Use '-' for none, NEVER an empty field: see the
# note above the reader loop for what an empty field silently did.

# shellcheck shell=bash

PII_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PII_DIGEST_FILE="${OPS_PII_DIGEST_FILE:-$PII_LIB_DIR/../pii-term-digests.txt}"
# A second, WARN-severity digest set. A GitHub handle belongs here: every commit
# is authored under it, every diff quote repeats it, and bot comments paste it
# inside code snippets. Blocking it would fail the audit on its own evidence.
PII_DIGEST_WARN_FILE="${OPS_PII_DIGEST_WARN_FILE:-$PII_LIB_DIR/../pii-term-digests-warn.txt}"
PII_DIGEST_HELPER="$PII_LIB_DIR/pii-digest.py"
# A tracked salt is public by definition, so it buys nothing against a targeted
# attacker. It only stops a generic rainbow table, which is all it is for.
PII_DIGEST_SALT="${OPS_PII_DIGEST_SALT:-claude-ops-pii-v1}"

# Documented placeholders. A gate that fails on `user@example.com` teaches
# people to pass --no-verify, which costs more than it saves.
PII_PLACEHOLDER_RE='(your\.address@|your-address@|\byou@|user@example|work@example|noreply@|no-reply@|example\.(com|org|net)|@(example|test|localhost|anthropic)\.)'

# The intended PUBLIC identity of this project. It belongs in
# .claude-plugin/marketplace.json and in plugin.json, and flagging it would
# make the manifest scan fail on the manifests' whole reason for existing.
# Written as regexes, never as plain literals, so this file does not itself
# trip the work-email check in the pre-commit hook.
PII_COMPANY_RE='(Lifecycle[[:space:]]+Innovations[[:space:]]+Limited|info@lifecycleinnovations\.limited|lifecycleinnovations\.limited)'

# A GitHub handle is public by construction: every commit is authored under it
# and every diff quote repeats it. Blocking it would fail on legitimate bot
# comments that quote a diff. So a term that fires INSIDE one of these contexts
# is reported as WARN rather than BLOCK.
PII_HANDLE_CONTEXT_RE='(github\.com/|users\.noreply\.github\.com|githubusercontent\.com/|[Cc]o-[Aa]uthored-[Bb]y|Signed-off-by|[Aa]uthor:|/pull/|/issues/)'

# --- BLOCK rules --------------------------------------------------------------
pii_block_rules() {
  # Personal webmail. The brand domains the owner actually uses are NOT listed
  # here (they would be the leak); they arrive via the denylist/digest path.
  printf '%s\t%s\t%s\t%s\t%s\n' \
    'personal-email' \
    '[A-Za-z0-9._%+-]+@(gmail|yahoo|hotmail|outlook|icloud|proton|protonmail|hey|me|mac)\.[a-z]{2,}' \
    "$PII_PLACEHOLDER_RE" \
    '-' \
    'a personal mailbox; use an example address'

  # A macOS home path names its owner. `~` and `$HOME` are fine, and so is a
  # generic username — the coordinator's wiki sweep showed the only "home path"
  # in the docs is `~/.hermes/...`, which carries no username at all.
  printf '%s\t%s\t%s\t%s\t%s\n' \
    'macos-home-path' \
    '/Users/[a-z][A-Za-z0-9_.-]+' \
    '/Users/(user|username|users|you|your[-_]?user|runner|shared|example|admin|me|name|alice|bob|carol|jane|john|jdoe)([^A-Za-z0-9_.-]|$)|/Users/[<$\{]' \
    '-' \
    'a macOS home path names its owner; use ~ or $HOME'

  printf '%s\t%s\t%s\t%s\t%s\n' \
    'linux-home-path' \
    '/home/[a-z][A-Za-z0-9_.-]+/' \
    '/home/(user|username|users|you|your[-_]?user|runner|ubuntu|ec2-user|ops|node|app|shared|example)/|/home/[<$\{]' \
    '-' \
    'a Linux home path names its owner; use ~ or $HOME'

  # Kept in ARN/account/bucket context so this does not flag every 12-digit
  # number. Reserved docs placeholders stay allowed.
  printf '%s\t%s\t%s\t%s\t%s\n' \
    'aws-account-id' \
    '([Aa]ccount|[Bb]ucket|aws|AWS|arn)[^0-9]{0,40}[0-9]{12}([^0-9]|$)' \
    '(123456789012|000000000000|111111111111|[0-9]{13,})' \
    '-' \
    'a real AWS account id; read it from the environment'

  # Any UUID is either a published vendor constant or somebody'"'"'s private
  # identifier, and the two are the same shape. Default to refusing it; the
  # documented ones live in known-public-constants.txt and are filtered by the
  # caller, which is the only place that knows where the checkout is.
  printf '%s\t%s\t%s\t%s\t%s\n' \
    'uuid-literal' \
    '\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b' \
    '\b(0{8}-0{4}|1{8}-1{4})-' \
    '-' \
    'an undocumented UUID; document it in tests/known-public-constants.txt'
}

# --- WARN rules ---------------------------------------------------------------
# Every one of these has a legitimate fixture in the current tree. They are
# printed so a human can look, and they never fail a build.
pii_warn_rules() {
  printf '%s\t%s\t%s\t%s\t%s\n' \
    'phone-shaped' \
    '\+[0-9]{10,15}' \
    '(\+1234567890|\+15551234567|\+14155550100|\+14155551234|\+31612345678|\+10000000000|\+0{10,})' \
    '-' \
    'looks like an international phone number'

  printf '%s\t%s\t%s\t%s\t%s\n' \
    'whatsapp-jid' \
    '[0-9]{6,15}@(s\.whatsapp\.net|lid)\b' \
    '-' \
    '-' \
    'looks like a WhatsApp JID'

  printf '%s\t%s\t%s\t%s\t%s\n' \
    'iban-shaped' \
    '\b[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}\b' \
    '-' \
    '-' \
    'looks like an IBAN'

  # 10.88.x is this estate'"'"'s WireGuard range and 100.64/10 is CGNAT; both are
  # documented in the setup guide as examples and must stay.
  printf '%s\t%s\t%s\t%s\t%s\n' \
    'private-address' \
    '\b(10\.88\.[0-9]{1,3}\.[0-9]{1,3}|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3})\b' \
    '-' \
    '-' \
    'a private or CGNAT address; fine as a documented example'

  printf '%s\t%s\t%s\t%s\t%s\n' \
    'ec2-instance-id' \
    '\bi-[0-9a-f]{17}\b' \
    '\bi-0{17}\b' \
    '-' \
    'looks like an EC2 instance id'

  # Not PII on its own, but it says which machine layout the operator runs.
  printf '%s\t%s\t%s\t%s\t%s\n' \
    'hermes-primary-path' \
    '/home/[a-z]+/\.hermes-primary' \
    '-' \
    '-' \
    'names a specific host layout; ~/.hermes on its own is a documented install path'
}

# --- Operator identity, cleartext (developer machines) ------------------------
# Same sources the existing scanner and hook already use, so an operator
# configures this once.
pii_operator_terms() {
  local cand file="" terms="" root
  root="${PII_REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
  for cand in "${OPS_PII_DENYLIST_FILE:-}" "$root/.pii-denylist" \
              "$root/claude-ops/.pii-denylist" \
              "$HOME/.config/claude-ops/pii-denylist.txt"; do
    [[ -n "$cand" && -f "$cand" ]] && { file="$cand"; break; }
  done
  [[ -n "$file" ]] && terms="$(grep -vE '^[[:space:]]*(#|$)' "$file" 2>/dev/null || true)"
  if [[ -n "${OPS_PII_DENYLIST:-}" ]]; then
    terms="$terms"$'\n'"$(printf '%s' "$OPS_PII_DENYLIST" | tr ',[:space:]' '\n\n')"
  fi
  printf '%s\n' "$terms" | grep -vE '^[[:space:]]*$' | sort -u || true
}

# Emit findings for one rule.
#
# The obvious shape — loop over the matching lines and shell out to `grep -oE`
# for each one to recover the matched term — costs a process PER FINDING. On a
# 29-page wiki that is thousands of forks and the scan never finishes, which
# means in practice the gate gets removed. So: ONE `grep -noE` recovers every
# term at once, keyed by line number, and one `awk` joins it back. Two
# processes per rule, regardless of how much text or how many hits.
pii_emit() {
  local sev="$1" label="$2" regex="$3" hits_file="$4"
  local terms_file
  terms_file="$(mktemp -t ops-pii-terms.XXXXXX)"
  grep -noE "$regex" "$hits_file" 2>/dev/null \
    | sed 's/^\([0-9]*\):/\1\t/' \
    | awk -F'\t' '!seen[$1]++' > "$terms_file" || true
  awk -F'\t' -v sev="$sev" -v label="$label" -v OFS='\t' '
    NR == FNR { term[$1] = $2; next }
    {
      origin = $1
      text = $0
      sub(/^[^\t]*\t/, "", text)
      # A hit with no extractable term means grep -E and grep -oE disagreed,
      # which is an anomaly worth seeing — so it is reported, but never dressed
      # up as if a term had been recovered.
      print sev, label, (FNR in term ? term[FNR] : "<no term extracted>"), origin, text
    }' "$terms_file" "$hits_file"
  rm -f "$terms_file"
}

# --- The scan -----------------------------------------------------------------
# stdin:  one "<origin>\t<text>" per line.
# stdout: one "<severity>\t<label>\t<term>\t<origin>\t<text>" per finding.
#
# Nothing here decides an exit code. The caller does, because "block" means a
# different thing to a commit-msg hook than to a scheduled audit.
pii_scan() {
  local label regex allow flags desc sev
  local input_file hits_file
  input_file="$(mktemp -t ops-pii-input.XXXXXX)"
  hits_file="$(mktemp -t ops-pii-hits.XXXXXX)"
  cat > "$input_file"
  if [[ ! -s "$input_file" ]]; then
    rm -f "$input_file" "$hits_file"
    return 0
  fi

  local rules
  rules="$( { pii_block_rules | sed 's/^/BLOCK\t/'; pii_warn_rules | sed 's/^/WARN\t/'; } )"

  # EVERY field carries a '-' placeholder when empty, and that is load-bearing.
  # TAB is IFS *whitespace*, so `read` collapses two consecutive tabs into one
  # delimiter: an empty `flags` field silently shifted the DESCRIPTION into
  # $flags, and every description containing the letter "i" turned its rule
  # case-insensitive. That is not theoretical — it made `/Users/` match
  # `/v2/users/me` and report a Zoom API doc line as a leaked home path. A
  # false positive here is how a gate gets switched off.
  while IFS=$'\t' read -r sev label regex allow flags desc; do
    [[ -n "$label" ]] || continue
    [[ "$flags" == "-" ]] && flags=""
    if [[ "$flags" == *i* ]]; then
      grep -iE "$regex" "$input_file" > "$hits_file" 2>/dev/null || true
    else
      grep -E "$regex" "$input_file" > "$hits_file" 2>/dev/null || true
    fi
    if [[ -n "$allow" && "$allow" != "-" && -s "$hits_file" ]]; then
      grep -vE "$allow" "$hits_file" > "$hits_file.f" 2>/dev/null || true
      mv "$hits_file.f" "$hits_file"
    fi
    [[ -s "$hits_file" ]] || continue
    pii_emit "$sev" "$label" "$regex" "$hits_file"
  done <<< "$rules"

  # --- operator identity, cleartext (developer machines) ---
  local terms alt
  terms="$(pii_operator_terms)"
  if [[ -n "$terms" ]]; then
    alt="$(printf '%s\n' "$terms" | sed 's/[.[\*^$()+?{|]/\\&/g' | paste -sd '|' -)"
    # The company identity is the INTENDED public value in marketplace.json and
    # plugin.json. A developer whose own denylist contains the company name
    # would otherwise be blocked by the manifests' entire reason for existing.
    grep -iE "\b($alt)\b" "$input_file" 2>/dev/null \
      | grep -vE '(example|placeholder|your[-_]|<[A-Z_]+>)' 2>/dev/null \
      | grep -vE "$PII_COMPANY_RE" > "$hits_file" 2>/dev/null || true
    if [[ -s "$hits_file" ]]; then
      # A term sitting in a GitHub-handle context is public by construction —
      # every commit is authored under it — so it is split out as a WARN rather
      # than failing every legitimate diff quote.
      grep -E "$PII_HANDLE_CONTEXT_RE" "$hits_file" > "$hits_file.w" 2>/dev/null || true
      grep -vE "$PII_HANDLE_CONTEXT_RE" "$hits_file" > "$hits_file.b" 2>/dev/null || true
      [[ -s "$hits_file.b" ]] && pii_emit BLOCK 'operator-identity' "\b($alt)\b" "$hits_file.b"
      [[ -s "$hits_file.w" ]] && pii_emit WARN  'operator-identity' "\b($alt)\b" "$hits_file.w"
      rm -f "$hits_file.w" "$hits_file.b"
    fi
  fi

  # --- operator identity, hashed (the path that works in CI) ---
  local term body origin text
  if [[ -f "$PII_DIGEST_FILE" ]] && command -v python3 >/dev/null 2>&1; then
    while IFS=$'\t' read -r term body; do
      [[ -n "$term" ]] || continue
      origin="${body%%$'\t'*}"
      text="${body#*$'\t'}"
      sev=BLOCK
      printf '%s\n' "$text" | grep -qE "$PII_HANDLE_CONTEXT_RE" && sev=WARN
      printf '%s\n' "$text" | grep -qE "$PII_COMPANY_RE" && sev=WARN
      printf '%s\t%s\t%s\t%s\t%s\n' "$sev" 'operator-identity' "$term" "$origin" "$text"
    done < <(python3 "$PII_DIGEST_HELPER" "$PII_DIGEST_FILE" "$PII_DIGEST_SALT" \
               < "$input_file" 2>/dev/null || true)
  fi

  if [[ -f "$PII_DIGEST_WARN_FILE" ]] && command -v python3 >/dev/null 2>&1; then
    while IFS=$'\t' read -r term body; do
      [[ -n "$term" ]] || continue
      origin="${body%%$'\t'*}"
      printf '%s\t%s\t%s\t%s\t%s\n' 'WARN' 'public-handle' "$term" "$origin" "${body#*$'\t'}"
    done < <(python3 "$PII_DIGEST_HELPER" "$PII_DIGEST_WARN_FILE" "$PII_DIGEST_SALT" \
               < "$input_file" 2>/dev/null || true)
  fi

  rm -f "$input_file" "$hits_file"
}

# Print the digest of a term so a maintainer can extend pii-term-digests.txt
# WITHOUT ever writing the term itself into the repo. That is the whole point:
#   ops-pii-scan --digest 'some term'   >> claude-ops/tests/pii-term-digests.txt
pii_digest_of() {
  printf '%s' "$PII_DIGEST_SALT$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" \
    | { shasum -a 256 2>/dev/null || sha256sum; } | awk '{print $1}'
}
