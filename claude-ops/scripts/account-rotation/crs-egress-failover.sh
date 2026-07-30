#!/usr/bin/env bash
set -u

DROPIN="$HOME/.config/systemd/user/crs-priority.service.d/40-mac-residential-egress.conf"
LOCK="${XDG_RUNTIME_DIR:-/tmp}/crs-egress-failover.lock"
EFG_PROXY='http://127.0.0.1:1088'
UDM_PROXY='socks5h://127.0.0.1:1087'
MAC_PROXY='socks5h://127.0.0.1:1086'
TARGET='https://api.anthropic.com'

mkdir -p "$(dirname "$DROPIN")"
exec 9>"$LOCK"
flock -n 9 || exit 0

proxy_healthy() {
  local proxy="$1" status
  status=$(curl -ksS --max-time 15 --proxy "$proxy" -o /dev/null -w '%{http_code}' "$TARGET" 2>/dev/null) || return 1
  case "$status" in
    2*|3*|4*|5*) return 0 ;;
    *) return 1 ;;
  esac
}

if proxy_healthy "$UDM_PROXY"; then
  desired='socks5://127.0.0.1:1087'
elif proxy_healthy "$EFG_PROXY"; then
  desired='http://127.0.0.1:1088'
elif proxy_healthy "$MAC_PROXY"; then
  desired='socks5://127.0.0.1:1086'
else
  exit 1
fi

current=$(python3 - "$DROPIN" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
try:
    for line in p.read_text().splitlines():
        if line.startswith('Environment=EFG_PROXY_URL='):
            print(line.split('=', 2)[2])
            break
except FileNotFoundError:
    pass
PY
)

if [ "$current" = "$desired" ]; then
  exit 0
fi

tmp="$DROPIN.tmp.$$"
cat > "$tmp" <<EOF
[Service]
# Scoped to live Anthropic quota probes only. Never changes host-wide routing.
Environment=EFG_PROXY_URL=$desired
EOF
chmod 600 "$tmp"
mv -f "$tmp" "$DROPIN"
systemctl --user daemon-reload
systemctl --user restart crs-priority.service
printf 'switched_proxy=%s\n' "$desired"
