#!/bin/bash
# PreToolUse advisory — fires when an agent is about to ASK THE USER for a
# credential (auth stall). Injects the credential-source search order so the
# agent exhausts local vaults BEFORE bothering Sam.
#
# Trigger: AskUserQuestion whose text mentions a credential keyword
#          (password, token, api key, secret, credential, ssh, login,
#           passphrase, 2fa/otp, key).
#
# Why: 2026-05-26 an agent burned ~1h "stuck" on UniFi gateway SSH before
#      checking dcli (Dashlane CLI), which had the creds all along. dcli holds
#      device/router/SSH passwords that are NOT in Doppler or keychain.
#
# Contract: advisory only — never blocks. Emits hookSpecificOutput.additionalContext
#           (the reminder) on stdout, exit 0. If keyword not matched, exit 0 silent.
#
# Source of truth: ~/Projects/claude-ops/claude-ops/hooks/auth-stall-guard.sh
# Symlinked to ~/.claude/scripts/hooks/auth-stall-guard.sh.

raw="${TOOL_INPUT:-}"
[ -z "$raw" ] && raw=$(cat) || true

TOOL=$(printf '%s' "$raw" | jq -r '(.tool_name // empty)' 2>/dev/null || true)
[ "$TOOL" = "AskUserQuestion" ] || { exit 0; }

# Flatten all question + option text to one lowercase blob.
BLOB=$(printf '%s' "$raw" | jq -r '
  [ (.tool_input.questions // [])[]
    | (.question // ""), (.header // ""),
      ((.options // [])[] | (.label // ""), (.description // "")) ]
  | join(" ")' 2>/dev/null | tr '[:upper:]' '[:lower:]')
[ -z "$BLOB" ] && exit 0

# Credential keywords that signal an auth stall. Word-ish boundaries to cut
# false positives (e.g. "tokenize", "keyboard" excluded by the patterns).
if printf '%s' "$BLOB" | grep -qE '(password|passphrase|credential|api[ _-]?key|secret[ _-]?key|access[ _-]?key|\bsecret\b|\btoken\b|\bssh\b|\blogin\b|\bauth\b|\b2fa\b|\botp\b|\bapi key\b|client[ _-]?secret|private[ _-]?key|\bpat\b)'; then
  python3 - <<'PY'
import json
msg = (
  "AUTH-STALL CHECK — you are about to ask Sam for a credential. "
  "Sam's rule: exhaust local credential sources FIRST, in this order, before prompting:\n"
  "  1. dcli (Dashlane — the master vault, has ALL accounts incl. device/SSH/router pw):\n"
  "       dcli password --output json <query>   |   dcli password --output json ''   |   dcli note --output json   |   dcli otp <query>\n"
  "  2. Doppler:   doppler secrets   /   doppler secrets get <NAME> --plain\n"
  "  3. macOS keychain:   security find-generic-password -s <svc> -w   /   security find-internet-password -s <host> -w\n"
  "  4. Env vars:   env | grep -i <name>\n"
  "  5. Filesystem scan:   ~/.secrets, ~/.config, repo .env*, ~/.aws, ~/.ssh\n"
  "Only ask Sam if ALL of the above miss. (2026-05-26: ~1h lost on UniFi SSH before checking dcli.)"
)
print(json.dumps({
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": msg
  }
}))
PY
fi
exit 0
