#!/bin/bash
# Per-seat reauth writer for cliproxy-heal-tick.
# Args: <provider> <seat-id> [auth-file]
# Exit 0 success, 2 checkpoint/human-only, 3 no writer / unusable seat.
# Never prints tokens, cookies, or raw emails.
set -euo pipefail
PROVIDER="${1:-}"
SEAT="${2:-}"
AUTH_FILE="${3:-}"
AUTH_DIR="${CLIPROXY_AUTH_DIR:-/opt/crsproxy/auths}"
ROOT="${CLIPROXY_ROOT:-/opt/crsproxy}"
if [ -x "${CLIPROXY_PYTHON:-}" ]; then
  PY="$CLIPROXY_PYTHON"
elif [ -x "$ROOT/venv/bin/python" ]; then
  PY="$ROOT/venv/bin/python"
else
  PY="$(command -v python3 || true)"
fi

if [ -z "$PROVIDER" ] || [ -z "$SEAT" ]; then
  echo "cliproxy-reauth-one: missing provider or seat" >&2
  exit 3
fi
if [ -z "$PY" ]; then
  echo "cliproxy-reauth-one: no python writer runtime" >&2
  exit 3
fi

if [ -z "$AUTH_FILE" ] || [ ! -f "$AUTH_FILE" ]; then
  if [ -f "$AUTH_DIR/$SEAT.json" ]; then
    AUTH_FILE="$AUTH_DIR/$SEAT.json"
  else
    AUTH_FILE=""
  fi
fi
if [ -z "$AUTH_FILE" ] || [ ! -f "$AUTH_FILE" ]; then
  echo "cliproxy-reauth-one: auth file not found" >&2
  exit 3
fi

# Resolve email + optional profile id without printing them.
eval "$("$PY" - "$AUTH_FILE" "$PROVIDER" "$ROOT/reauth_seats.json" <<'PY'
import json, os, sys
auth_path, provider, seats_path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    data = json.load(open(auth_path))
except Exception:
    print("echo cliproxy-reauth-one: unreadable auth >&2; exit 3")
    raise SystemExit(0)
email = data.get("email") or ""
if not email or "@" not in str(email):
    print("echo cliproxy-reauth-one: no email in auth >&2; exit 3")
    raise SystemExit(0)
profile = ""
if os.path.isfile(seats_path):
    try:
        raw = json.load(open(seats_path))
        seats = raw.get("seats") if isinstance(raw, dict) else raw
        for s in seats or []:
            if not isinstance(s, dict):
                continue
            if str(s.get("provider") or "").lower() != provider.lower():
                continue
            if str(s.get("email") or "").lower() != str(email).lower():
                continue
            profile = str(s.get("profile_id") or s.get("profileId") or "")
            break
    except Exception:
        profile = ""
# Export via env-safe quoted assignment without echoing.
def q(v):
    return "'" + str(v).replace("'", "'\"'\"'") + "'"
print("EMAIL=" + q(email))
print("PROFILE=" + q(profile))
PY
)"

if [ -z "${EMAIL:-}" ]; then
  echo "cliproxy-reauth-one: could not resolve seat identity" >&2
  exit 3
fi

if [ -n "${PROFILE:-}" ] && [ -f "$ROOT/bu_profile_reauth.py" ]; then
  exec "$PY" "$ROOT/bu_profile_reauth.py" -provider "$PROVIDER" -email "$EMAIL" -profile-id "$PROFILE"
fi
if [ "$PROVIDER" = "xai" ] && [ -f "$ROOT/xai_device_reauth.py" ]; then
  exec "$PY" "$ROOT/xai_device_reauth.py" -email "$EMAIL"
fi
if [ -f "$ROOT/bu_reauth_lib.py" ]; then
  exec "$PY" "$ROOT/bu_reauth_lib.py" -provider "$PROVIDER" -email "$EMAIL"
fi
echo "cliproxy-reauth-one: no writer for provider" >&2
exit 3
