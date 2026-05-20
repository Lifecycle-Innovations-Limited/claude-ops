#!/usr/bin/env bash
# ops-mcp-keepalive — Silent OAuth refresh for remote (HTTP) MCP servers.
#
# Strategy (no browser, no mcp-remote shell-out):
#   1. For every HTTP MCP in ~/.claude.json, derive the token-cache path:
#      ~/.mcp-auth/mcp-remote-<ver>/<md5(url)>_{tokens.json,client_info.json}
#   2. Read tokens.json:
#        • If no file → SKIP (MCP not yet authorized; needs interactive first-run)
#        • If expires_at > now + grace_minutes → SKIP (still fresh)
#        • Else → call the provider's /token endpoint with the refresh_token
#   3. Token endpoint is derived from client_info.json's `token_endpoint`
#      (OAuth 2.1 server metadata). Falls back to `<server>/token` heuristic.
#   4. On 200, persist new tokens.json. On 4xx/5xx, log and move on (DO NOT
#      open a browser — first-run consent must be done interactively).
#
# Env:
#   MCP_KEEPALIVE_GRACE_MIN   default 15 (refresh if <15min remaining)
#   MCP_KEEPALIVE_URLS        space-separated list; default = all HTTP MCPs
#                             in ~/.claude.json
set -uo pipefail

STATE_DIR="${HOME}/.claude/state/mcp-keepalive"
HEALTH="${STATE_DIR}/.health"
LOG_FILE="${STATE_DIR}/run.log"
GRACE="${MCP_KEEPALIVE_GRACE_MIN:-15}"
mkdir -p "$STATE_DIR"

log() {
  local line
  line="$(date -u +%FT%TZ) [ops-mcp-keepalive] $*"
  echo "$line" >&2
  echo "$line" >> "$LOG_FILE"
}

# Collect target URLs
if [[ -n "${MCP_KEEPALIVE_URLS:-}" ]]; then
  read -r -a URLS <<<"$MCP_KEEPALIVE_URLS"
else
  mapfile -t URLS < <(python3 -c "
import json, os
d = json.load(open(os.path.expanduser('~/.claude.json')))
for n, c in (d.get('mcpServers') or {}).items():
    if c.get('type') == 'http' and c.get('url'):
        print(c['url'])
")
fi

if [[ ${#URLS[@]} -eq 0 ]]; then
  log "no HTTP MCPs configured"
  cat >"$HEALTH" <<EOF
{"status":"ok","message":"no urls","last_run":"$(date -u +%FT%TZ)","refreshed":0,"skipped_fresh":0,"skipped_no_token":0,"failed":0}
EOF
  exit 0
fi

refreshed=0
skipped_fresh=0
skipped_no_token=0
failed=0

for url in "${URLS[@]}"; do
  result=$(python3 - "$url" "$GRACE" <<'PY'
import hashlib, json, os, sys, time, urllib.error, urllib.parse, urllib.request

url = sys.argv[1]
grace_min = int(sys.argv[2])
h = hashlib.md5(url.encode()).hexdigest()
base = os.path.expanduser("~/.mcp-auth")
if not os.path.isdir(base):
    print(json.dumps({"action": "no_cache_dir"})); sys.exit(0)

# Find newest mcp-remote-<ver>/ subdir holding this hash
cands = sorted(
    [os.path.join(base, d) for d in os.listdir(base) if d.startswith("mcp-remote-")],
    key=lambda p: os.path.getmtime(p), reverse=True,
)
tokens_path = None
client_path = None
for d in cands:
    tp = os.path.join(d, f"{h}_tokens.json")
    cp = os.path.join(d, f"{h}_client_info.json")
    if os.path.exists(tp):
        tokens_path = tp
        client_path = cp if os.path.exists(cp) else None
        break

if not tokens_path:
    print(json.dumps({"action": "skip_no_token", "url": url}))
    sys.exit(0)

try:
    tokens = json.load(open(tokens_path))
except Exception as e:
    print(json.dumps({"action": "fail", "reason": f"read_tokens: {e}"})); sys.exit(0)

# expires_at is either a unix-ms (mcp-remote stores ms) or seconds — handle both.
exp = tokens.get("expires_at") or 0
if isinstance(exp, (int, float)) and exp:
    # Heuristic: > 10^12 → ms, else seconds
    exp_sec = exp / 1000 if exp > 10**12 else exp
else:
    # No expires_at — try issued_at + expires_in
    issued = tokens.get("issued_at") or 0
    exp_in = tokens.get("expires_in") or 0
    if issued and exp_in:
        issued_sec = issued / 1000 if issued > 10**12 else issued
        exp_sec = issued_sec + exp_in
    else:
        # Unknown expiry — assume valid for now; skip
        print(json.dumps({"action": "skip_unknown_expiry", "url": url}))
        sys.exit(0)

remaining = exp_sec - time.time()
if remaining > grace_min * 60:
    print(json.dumps({
        "action": "skip_fresh", "url": url,
        "remaining_min": int(remaining / 60),
    }))
    sys.exit(0)

refresh_tok = tokens.get("refresh_token")
if not refresh_tok:
    print(json.dumps({"action": "fail", "reason": "no_refresh_token", "url": url}))
    sys.exit(0)

# Resolve token endpoint
token_endpoint = None
if client_path and os.path.exists(client_path):
    try:
        ci = json.load(open(client_path))
        token_endpoint = ci.get("token_endpoint")
    except Exception:
        pass
if not token_endpoint:
    # Try OAuth 2.0 well-known discovery
    parsed = urllib.parse.urlparse(url)
    discovery = f"{parsed.scheme}://{parsed.netloc}/.well-known/oauth-authorization-server"
    try:
        with urllib.request.urlopen(discovery, timeout=8) as resp:
            meta = json.loads(resp.read().decode())
            token_endpoint = meta.get("token_endpoint")
    except Exception:
        pass
if not token_endpoint:
    # Heuristic fallback
    parsed = urllib.parse.urlparse(url)
    token_endpoint = f"{parsed.scheme}://{parsed.netloc}/token"

# Build refresh request
client_id = ""
if client_path and os.path.exists(client_path):
    try:
        ci = json.load(open(client_path))
        client_id = ci.get("client_id", "")
    except Exception:
        pass

body = urllib.parse.urlencode({
    "grant_type": "refresh_token",
    "refresh_token": refresh_tok,
    **({"client_id": client_id} if client_id else {}),
}).encode()
req = urllib.request.Request(
    token_endpoint, data=body, method="POST",
    headers={"Content-Type": "application/x-www-form-urlencoded",
             "Accept": "application/json"},
)
try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        new_tokens = json.loads(resp.read().decode())
except urllib.error.HTTPError as e:
    err_body = ""
    try:
        err_body = e.read().decode()[:200]
    except Exception:
        pass
    print(json.dumps({"action": "fail", "reason": f"http_{e.code}: {err_body}", "url": url}))
    sys.exit(0)
except Exception as e:
    print(json.dumps({"action": "fail", "reason": f"{type(e).__name__}: {e}", "url": url}))
    sys.exit(0)

# Merge: keep old refresh_token if new payload doesn't include one
merged = dict(tokens)
merged.update(new_tokens)
if "refresh_token" not in new_tokens:
    merged["refresh_token"] = refresh_tok
# Set expires_at if not present
if "expires_at" not in new_tokens and "expires_in" in new_tokens:
    merged["expires_at"] = int((time.time() + new_tokens["expires_in"]) * 1000)
# Atomic write
tmp = tokens_path + ".tmp"
with open(tmp, "w") as f:
    json.dump(merged, f, indent=2)
os.replace(tmp, tokens_path)
print(json.dumps({"action": "refreshed", "url": url, "new_expires_in": new_tokens.get("expires_in")}))
PY
  )
  action=$(echo "$result" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('action',''))" 2>/dev/null)
  case "$action" in
    refreshed) refreshed=$((refreshed+1)); log "✓ refreshed $url" ;;
    skip_fresh) skipped_fresh=$((skipped_fresh+1)) ;;
    skip_no_token) skipped_no_token=$((skipped_no_token+1)) ;;
    skip_unknown_expiry) skipped_no_token=$((skipped_no_token+1)) ;;
    fail) failed=$((failed+1)); log "✗ refresh failed for $url: $(echo "$result" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('reason',''))" 2>/dev/null)" ;;
    no_cache_dir) skipped_no_token=$((skipped_no_token+1)) ;;
  esac
done

ts=$(date -u +%FT%TZ)
log "done refreshed=$refreshed fresh=$skipped_fresh no_token=$skipped_no_token failed=$failed"

python3 -c "
import json
print(json.dumps({
  'status': 'ok' if $failed == 0 else 'warn',
  'message': 'refreshed=$refreshed fresh=$skipped_fresh no_token=$skipped_no_token failed=$failed',
  'last_run': '$ts',
  'refreshed': $refreshed,
  'skipped_fresh': $skipped_fresh,
  'skipped_no_token': $skipped_no_token,
  'failed': $failed,
  'grace_minutes': $GRACE,
}, indent=2))
" >"$HEALTH"
exit 0
