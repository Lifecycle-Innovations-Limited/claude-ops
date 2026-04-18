#!/usr/bin/env bash
# ops-memory-extractor.sh — Extracts user preferences, contact profiles, and behavioral
# patterns from WhatsApp + email history and writes structured memory files.
# Runs every 30 min via ops-daemon cron service.
set -euo pipefail

# ── Portable shell helpers ────────────────────────────────────────────────────
_date_days_ago() {
  # Portable: echoes "N days ago" in the given format (default YYYY-MM-DD)
  local days=$1 fmt=${2:-+%Y-%m-%d}
  if date -d "$days days ago" "$fmt" >/dev/null 2>&1; then
    date -d "$days days ago" "$fmt"   # GNU coreutils (Linux, Windows/Git Bash)
  else
    date -v-"${days}"d "$fmt"         # BSD (macOS)
  fi
}

# ── Config ────────────────────────────────────────────────────────────────────
MEMORIES_DIR="${HOME}/.claude/plugins/data/ops-ops-marketplace/memories"
HEALTH_FILE="${MEMORIES_DIR}/.health"
TMP_RAW="${TMPDIR:-/tmp}/ops-memory-raw-$$.json"
TMP_PROMPT="${TMPDIR:-/tmp}/ops-memory-prompt-$$.txt"
TMP_RESPONSE="${TMPDIR:-/tmp}/ops-memory-response-$$.json"
MAX_TOTAL_BYTES=51200   # 50KB ceiling across all memory files
MAX_FILE_BYTES=5120     # 5KB per file before auto-compression
LOG_PREFIX="[ops-memory-extractor]"

# ── Helpers ───────────────────────────────────────────────────────────────────
log()  { echo "${LOG_PREFIX} $*" >&2; }
die()  { log "FATAL: $*"; write_health "error" "$*"; exit 1; }
ts()   { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

write_health() {
  local status="$1" msg="${2:-}"
  mkdir -p "${MEMORIES_DIR}"
  cat > "${HEALTH_FILE}" <<EOF
{
  "status": "${status}",
  "message": "${msg}",
  "last_run": "$(ts)",
  "memories_dir": "${MEMORIES_DIR}"
}
EOF
}

cleanup() {
  rm -f "${TMP_RAW}" "${TMP_PROMPT}" "${TMP_RESPONSE}"
}
trap cleanup EXIT

# ── Resolve auth (Claude Code OAuth preferred, API key fallback) ──────────────
# Preference order:
#   1. Claude Code OAuth token from macOS Keychain — uses your Claude Max/Pro
#      subscription (no per-token API billing). Works out of the box if you're
#      signed into Claude Code on this machine. Skipped if the token is expired
#      or within 60 s of expiry.
#   2. ANTHROPIC_API_KEY env var
#   3. macOS Keychain service "ANTHROPIC_API_KEY" (any account)
#   4. Doppler — via OPS_DOPPLER_PROJECT + OPS_DOPPLER_CONFIG, or ambient scope
#
# Why OAuth-first:
#   Subscription users shouldn't pay API-metered rates for daemon-scheduled
#   background work. There is also a known behavioural gotcha with Claude Code
#   itself: if ANTHROPIC_API_KEY is exported globally (shell profile, ~/.env,
#   etc.) Claude Code preferentially bills that key instead of honouring the
#   OAuth subscription. Keeping the API key only in keychain (unexported) and
#   preferring OAuth here sidesteps both problems.
#
# Globals set by this function (consumed by call_claude):
#   OPS_AUTH_HEADER         - full HTTP header value, e.g.
#                             "Authorization: Bearer sk-ant-oat01-..." (OAuth)
#                             "x-api-key: sk-ant-api03-..." (API key)
#   OPS_AUTH_MODE           - "oauth" or "apikey"
#   OPS_AUTH_EXTRA_HEADERS  - bash array of additional curl -H args
#                             (OAuth needs `anthropic-beta: oauth-2025-04-20`)
#
# To seed the API-key fallback in keychain:
#   security add-generic-password -U -s ANTHROPIC_API_KEY -a ops-daemon -w sk-ant-...
resolve_auth() {
  OPS_AUTH_HEADER=""
  OPS_AUTH_MODE=""
  OPS_AUTH_EXTRA_HEADERS=()

  # ─ Try Claude Code OAuth first ─
  if command -v security &>/dev/null; then
    local blob token
    blob=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)
    if [[ -n "${blob}" ]]; then
      token=$(printf '%s' "${blob}" | python3 -c "
import json, sys, time
try:
    d = json.loads(sys.stdin.read())
    o = d.get('claudeAiOauth') or {}
    tok = o.get('accessToken') or ''
    exp = o.get('expiresAt') or 0
    # Require >= 60 s of remaining life to avoid mid-call expiry
    if tok and exp > int(time.time() * 1000) + 60000:
        print(tok)
except Exception:
    pass
" 2>/dev/null || true)
      if [[ -n "${token}" ]]; then
        OPS_AUTH_HEADER="Authorization: Bearer ${token}"
        OPS_AUTH_MODE="oauth"
        OPS_AUTH_EXTRA_HEADERS=(-H "anthropic-beta: oauth-2025-04-20")
        log "Auth: Claude Code OAuth (subscription — no per-token billing)"
        return 0
      fi
    fi
  fi

  # ─ Fallback: API key via env / keychain / doppler ─
  local key=""
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    key="${ANTHROPIC_API_KEY}"
  elif command -v security &>/dev/null; then
    key=$(security find-generic-password -s "ANTHROPIC_API_KEY" -w 2>/dev/null || true)
  fi
  if [[ -z "${key}" ]] && command -v doppler &>/dev/null; then
    local proj="${OPS_DOPPLER_PROJECT:-}" cfg="${OPS_DOPPLER_CONFIG:-}"
    if [[ -n "${proj}" && -n "${cfg}" ]]; then
      key=$(doppler secrets get ANTHROPIC_API_KEY --plain --project "${proj}" --config "${cfg}" 2>/dev/null || true)
    else
      key=$(doppler secrets get ANTHROPIC_API_KEY --plain 2>/dev/null || true)
    fi
  fi

  if [[ -n "${key}" ]]; then
    OPS_AUTH_HEADER="x-api-key: ${key}"
    OPS_AUTH_MODE="apikey"
    log "Auth: ANTHROPIC_API_KEY (API-metered billing)"
    return 0
  fi

  die "No auth available; tried Claude Code OAuth (keychain), \$ANTHROPIC_API_KEY, keychain ANTHROPIC_API_KEY, and doppler"
}

# Back-compat alias so older callers / forks still work
resolve_api_key() { resolve_auth; }

# ── Collect raw data ──────────────────────────────────────────────────────────
collect_data() {
  local wacli_data="" email_data=""
  local yesterday
  yesterday=$(TZ=UTC _date_days_ago 1 "+%Y-%m-%d")

  # WhatsApp via wacli
  if command -v wacli &>/dev/null; then
    local health_status=""
    if [[ -f "${HOME}/.wacli/.health" ]]; then
      health_status=$(cat "${HOME}/.wacli/.health" 2>/dev/null || true)
    fi
    if echo "${health_status}" | grep -qi "connected\|ok\|healthy" 2>/dev/null; then
      log "Collecting WhatsApp messages..."
      wacli_data=$(wacli messages list --after="${yesterday}" --limit=200 --json 2>/dev/null || true)
      if [[ -z "${wacli_data}" ]]; then
        log "wacli returned no data (skipping)"
      fi
    else
      log "wacli not connected (skipping WhatsApp)"
    fi
  else
    log "wacli not available (skipping WhatsApp)"
  fi

  # Email via gog
  if command -v gog &>/dev/null; then
    log "Collecting recent emails..."
    email_data=$(gog gmail search -j --results-only --no-input --max 20 "newer_than:1d" 2>/dev/null || true)
    if [[ -z "${email_data}" ]]; then
      log "gog returned no data (skipping)"
    fi
  else
    log "gog not available (skipping email)"
  fi

  if [[ -z "${wacli_data}" && -z "${email_data}" ]]; then
    log "No data sources available — nothing to extract"
    write_health "skipped" "no data sources"
    exit 0
  fi

  # Write combined raw payload
  cat > "${TMP_RAW}" <<EOF
{
  "whatsapp_messages": ${wacli_data:-null},
  "emails": ${email_data:-null},
  "collected_at": "$(ts)"
}
EOF
}

# ── Read existing memory for context ─────────────────────────────────────────
read_existing_memory() {
  local out=""
  for f in "${MEMORIES_DIR}"/contact_*.md "${MEMORIES_DIR}"/preferences.md \
            "${MEMORIES_DIR}"/topics_active.md "${MEMORIES_DIR}"/donts.md; do
    [[ -f "$f" ]] || continue
    out+="### $(basename "$f")\n"
    out+=$(cat "$f")
    out+="\n\n"
  done
  printf '%s' "${out}"
}

# ── Build extraction prompt ────────────────────────────────────────────────────
build_prompt() {
  local raw_data existing_memory
  raw_data=$(cat "${TMP_RAW}")
  existing_memory=$(read_existing_memory)

  cat > "${TMP_PROMPT}" <<'PROMPT_EOF'
You are a memory extraction assistant. Analyze the provided chat/email data and extract structured information.

Return a JSON object with exactly these keys:
- "contacts": array of contact objects
- "preferences": object with user behavior patterns
- "topics_active": array of ongoing conversation topics
- "donts": array of things to avoid

Each contact object:
{
  "name": string,
  "email": string or null,
  "phone": string or null,
  "company": string or null,
  "role": string or null,
  "relationship": "professional|personal|family|vendor|client",
  "communication_style": string (1-2 sentences),
  "language_preference": string (e.g. "English", "Hindi", "English + Hindi"),
  "channel_preference": "whatsapp|email|both|unknown",
  "recent_context": string (1-3 bullet points as plain text, newline-separated),
  "confidence": float 0.0-1.0
}

Preferences object:
{
  "response_style": string,
  "tone": string,
  "topics_of_interest": array of strings,
  "scheduling_patterns": string or null,
  "language": string,
  "notes": array of strings
}

Topics active array items:
{
  "topic": string,
  "contacts_involved": array of names,
  "summary": string,
  "pending_action": string or null,
  "deadline": string or null (ISO date)
}

Donts array items: plain strings describing things to avoid.

Rules:
- Only include contacts with at least 2 signals of identity
- Merge with existing memory (do not duplicate, update stale info)
- Confidence reflects how certain the extraction is (0.8+ = clear signal)
- Keep responses concise — no padding
- If no meaningful data to extract for a key, return empty array/object

PROMPT_EOF

  # Append existing memory context and raw data as separate user turn content
  printf '\nEXISTING MEMORY (merge with this, do not duplicate):\n%s\n\nRAW DATA TO ANALYZE:\n%s\n' \
    "${existing_memory}" "${raw_data}" >> "${TMP_PROMPT}"
}

# ── Call Claude Haiku ─────────────────────────────────────────────────────────
call_claude() {
  local system_prompt user_content
  system_prompt="You are a memory extraction assistant. Return only valid JSON, no markdown fences, no explanation."
  # Escape for JSON embedding
  user_content=$(cat "${TMP_PROMPT}" | python3 -c "
import sys, json
data = sys.stdin.read()
print(json.dumps(data))
" 2>/dev/null || python3 -c "
import sys, json
data = sys.stdin.read()
print(json.dumps(data))
")

  local payload
  payload=$(cat <<EOF
{
  "model": "claude-haiku-4-5-20251001",
  "max_tokens": 4096,
  "system": $(printf '%s' "${system_prompt}" | python3 -c "import sys, json; print(json.dumps(sys.stdin.read()))"),
  "messages": [
    {"role": "user", "content": ${user_content}}
  ]
}
EOF
)

  log "Calling Claude Haiku for extraction (auth: ${OPS_AUTH_MODE:-unknown})..."
  local http_status
  http_status=$(curl -s -o "${TMP_RESPONSE}" -w "%{http_code}" \
    https://api.anthropic.com/v1/messages \
    -H "content-type: application/json" \
    -H "${OPS_AUTH_HEADER}" \
    -H "anthropic-version: 2023-06-01" \
    "${OPS_AUTH_EXTRA_HEADERS[@]}" \
    -d "${payload}" 2>/dev/null)

  if [[ "${http_status}" != "200" ]]; then
    local err
    err=$(cat "${TMP_RESPONSE}" 2>/dev/null || echo "unknown error")
    die "Claude API returned HTTP ${http_status}: ${err}"
  fi

  # Extract text content from response
  python3 - <<'PYEOF' "${TMP_RESPONSE}"
import sys, json

resp_file = sys.argv[1]
with open(resp_file) as f:
    data = json.load(f)

content = data.get("content", [])
for block in content:
    if block.get("type") == "text":
        print(block["text"])
        sys.exit(0)

print("{}")
PYEOF
}

# ── Write memory files ────────────────────────────────────────────────────────
write_memory_files() {
  local extraction="$1"
  local now
  now=$(ts)

  mkdir -p "${MEMORIES_DIR}"

  python3 - <<'PYEOF' "${MEMORIES_DIR}" "${now}" "${extraction}"
import sys, json, os, re
from pathlib import Path

memories_dir = sys.argv[1]
now = sys.argv[2]
raw = sys.argv[3]

# Strip markdown fences if model added them
raw = re.sub(r'^```(?:json)?\s*', '', raw.strip())
raw = re.sub(r'\s*```$', '', raw.strip())

try:
    data = json.loads(raw)
except json.JSONDecodeError as e:
    print(f"[ops-memory-extractor] WARN: Failed to parse extraction JSON: {e}", file=sys.stderr)
    sys.exit(0)

def read_existing(path):
    if Path(path).exists():
        return Path(path).read_text(encoding="utf-8")
    return ""

def slugify(name):
    return re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')

def build_frontmatter(fields):
    lines = ["---"]
    for k, v in fields.items():
        if v is not None:
            lines.append(f"{k}: {v}")
    lines.append("---")
    return "\n".join(lines)

def write_if_changed(path, content):
    existing = read_existing(path)
    if existing == content:
        return
    Path(path).write_text(content, encoding="utf-8")
    print(f"[ops-memory-extractor] wrote {path}", file=sys.stderr)

# ── Contacts ──────────────────────────────────────────────────────────────────
for contact in data.get("contacts", []):
    name = contact.get("name", "unknown")
    slug = slugify(name)
    path = os.path.join(memories_dir, f"contact_{slug}.md")

    fm = build_frontmatter({
        "type": "contact",
        "name": name,
        "email": contact.get("email"),
        "phone": contact.get("phone"),
        "company": contact.get("company"),
        "role": contact.get("role"),
        "last_updated": now,
        "confidence": contact.get("confidence", 0.7),
    })

    rel = contact.get("relationship", "unknown")
    style = contact.get("communication_style", "")
    lang = contact.get("language_preference", "")
    channel = contact.get("channel_preference", "unknown")
    ctx_raw = contact.get("recent_context", "")
    ctx_lines = [f"- {l.lstrip('- ').strip()}" for l in ctx_raw.split("\n") if l.strip()]
    ctx_block = "\n".join(ctx_lines) if ctx_lines else "- No recent context"

    body = f"""
## Relationship
- {rel.capitalize()} contact
- {style}

## Communication Style
- {style}
- Prefers {channel}
- {lang}

## Recent Context
{ctx_block}
""".lstrip()

    write_if_changed(path, f"{fm}\n\n{body}")

# ── Preferences ───────────────────────────────────────────────────────────────
prefs = data.get("preferences", {})
if prefs:
    path = os.path.join(memories_dir, "preferences.md")
    fm = build_frontmatter({
        "type": "preferences",
        "last_updated": now,
    })
    topics = "\n".join(f"- {t}" for t in prefs.get("topics_of_interest", []))
    notes = "\n".join(f"- {n}" for n in prefs.get("notes", []))

    body = f"""## Response Style
- {prefs.get("response_style", "Unknown")}
- Tone: {prefs.get("tone", "Unknown")}
- Language: {prefs.get("language", "English")}

## Topics of Interest
{topics or "- None identified"}

## Scheduling
- {prefs.get("scheduling_patterns") or "No patterns identified"}

## Notes
{notes or "- None"}
""".lstrip()

    write_if_changed(path, f"{fm}\n\n{body}")

# ── Active Topics ─────────────────────────────────────────────────────────────
topics = data.get("topics_active", [])
if topics:
    path = os.path.join(memories_dir, "topics_active.md")
    fm = build_frontmatter({"type": "topics", "last_updated": now})
    blocks = []
    for t in topics:
        contacts_str = ", ".join(t.get("contacts_involved", []))
        block = f"### {t.get('topic', 'Unnamed')}\n"
        block += f"- **Contacts**: {contacts_str or 'unknown'}\n"
        block += f"- **Summary**: {t.get('summary', '')}\n"
        if t.get("pending_action"):
            block += f"- **Action**: {t['pending_action']}\n"
        if t.get("deadline"):
            block += f"- **Deadline**: {t['deadline']}\n"
        blocks.append(block)
    body = "\n".join(blocks)
    write_if_changed(path, f"{fm}\n\n{body}")

# ── Donts ─────────────────────────────────────────────────────────────────────
donts = data.get("donts", [])
if donts:
    path = os.path.join(memories_dir, "donts.md")
    fm = build_frontmatter({"type": "donts", "last_updated": now})
    lines = "\n".join(f"- {d}" for d in donts)
    write_if_changed(path, f"{fm}\n\n## Things to Avoid\n{lines}\n")

print("[ops-memory-extractor] memory files updated", file=sys.stderr)
PYEOF
}

# ── Auto-compress oversized files ─────────────────────────────────────────────
auto_compress() {
  local total_bytes=0
  for f in "${MEMORIES_DIR}"/*.md; do
    [[ -f "$f" ]] || continue
    local fsize
    fsize=$(wc -c < "$f" 2>/dev/null || echo 0)
    total_bytes=$((total_bytes + fsize))
  done

  log "Total memory size: ${total_bytes} bytes"

  # Per-file compression: truncate overgrown files to most recent sections
  for f in "${MEMORIES_DIR}"/*.md; do
    [[ -f "$f" ]] || continue
    local fsize
    fsize=$(wc -c < "$f" 2>/dev/null || echo 0)
    if [[ "${fsize}" -gt "${MAX_FILE_BYTES}" ]]; then
      log "Compressing ${f} (${fsize} bytes > ${MAX_FILE_BYTES})"
      python3 - <<'PYEOF' "${f}"
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

# Keep frontmatter + last 3KB of body
parts = text.split("---", 2)
if len(parts) >= 3:
    frontmatter = "---" + parts[1] + "---"
    body = parts[2]
    # Keep last 3000 chars of body
    if len(body) > 3000:
        body = "\n\n[...older content trimmed...]\n\n" + body[-3000:]
    path.write_text(frontmatter + body, encoding="utf-8")
    print(f"[ops-memory-extractor] compressed {path}", file=sys.stderr)
PYEOF
    fi
  done

  # Global ceiling: if still over 50KB, remove oldest contact files
  if [[ "${total_bytes}" -gt "${MAX_TOTAL_BYTES}" ]]; then
    log "WARN: Total memory exceeds ${MAX_TOTAL_BYTES} bytes — pruning oldest contacts"
    # Sort contact files by modification time (oldest first) and remove until under limit
    for f in $(ls -tr "${MEMORIES_DIR}"/contact_*.md 2>/dev/null); do
      [[ -f "$f" ]] || continue
      total_bytes=$(du -sb "${MEMORIES_DIR}"/*.md 2>/dev/null | awk '{s+=$1} END{print s}' || echo 0)
      if [[ "${total_bytes}" -le "${MAX_TOTAL_BYTES}" ]]; then
        break
      fi
      log "Removing oldest contact file: ${f}"
      rm -f "${f}"
    done
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  log "Starting memory extraction run at $(ts)"
  mkdir -p "${MEMORIES_DIR}"

  resolve_auth
  collect_data

  build_prompt

  local extraction
  extraction=$(call_claude)

  if [[ -z "${extraction}" || "${extraction}" == "{}" ]]; then
    log "No extraction results from Claude — skipping write"
    write_health "ok" "no new memories extracted"
    exit 0
  fi

  write_memory_files "${extraction}"
  auto_compress

  write_health "ok" "extraction complete"
  log "Memory extraction complete at $(ts)"
}

main "$@"
