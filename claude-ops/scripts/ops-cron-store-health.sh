#!/usr/bin/env bash
# ops-cron-store-health.sh — Daily Store Health cron job
# Migrated from OpenClaw "Daily Store Health" (cron: 0 9 * * *, tz: Europe/Amsterdam)
# Queries Shopify API, reports inventory status to Telegram
set -euo pipefail

DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="$DATA_DIR/logs"
LOG="$LOG_DIR/store-health.log"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/marketplaces/ops-marketplace/claude-ops}"

mkdir -p "$LOG_DIR"
log() { printf '%s [store-health] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" | tee -a "$LOG"; }

# ── Resolve credentials ───────────────────────────────────────────────────
SHOPIFY_STORE="${SHOPIFY_STORE_DOMAIN:-}"
SHOPIFY_TOKEN="${SHOPIFY_STOREFRONT_TOKEN:-}"
TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT="${TELEGRAM_CHAT_ID:-1335137548}"
LOW_STOCK_THRESHOLD="${LOW_STOCK_THRESHOLD:-20}"

if [[ -z "$SHOPIFY_TOKEN" ]]; then
  SHOPIFY_TOKEN=$(doppler secrets get SHOPIFY_STOREFRONT_TOKEN --plain 2>/dev/null || true)
fi
if [[ -z "$SHOPIFY_STORE" ]]; then
  SHOPIFY_STORE=$(doppler secrets get SHOPIFY_STORE_DOMAIN --plain 2>/dev/null || echo "abshelf.myshopify.com")
fi
if [[ -z "$TELEGRAM_TOKEN" ]]; then
  TELEGRAM_TOKEN=$(doppler secrets get TELEGRAM_BOT_TOKEN --plain 2>/dev/null || true)
fi

# ── Try bin/ops-ecom-health first ─────────────────────────────────────────
ECOM_HEALTH_BIN="$PLUGIN_ROOT/bin/ops-ecom-health"
if [[ -x "$ECOM_HEALTH_BIN" ]]; then
  log "Running ops-ecom-health bin"
  HEALTH_OUTPUT=$("$ECOM_HEALTH_BIN" --json 2>/dev/null || "$ECOM_HEALTH_BIN" 2>/dev/null || true)
  if [[ -n "$HEALTH_OUTPUT" ]]; then
    log "ops-ecom-health output received"
    REPORT="$HEALTH_OUTPUT"
  fi
fi

# ── Fallback: direct Shopify Storefront API call ──────────────────────────
if [[ -z "${REPORT:-}" ]]; then
  if [[ -z "$SHOPIFY_TOKEN" ]]; then
    log "ERROR: SHOPIFY_STOREFRONT_TOKEN not set and ops-ecom-health unavailable"
    exit 1
  fi

  log "Querying Shopify Storefront API: $SHOPIFY_STORE"
  INVENTORY_JSON=$(curl -s -X POST \
    "https://${SHOPIFY_STORE}/api/2024-04/graphql.json" \
    -H "X-Shopify-Storefront-Access-Token: ${SHOPIFY_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"query": "{ products(first: 10) { edges { node { title variants(first: 10) { edges { node { title quantityAvailable availableForSale } } } } } } }"}' \
    2>/dev/null || echo '{"errors":[{"message":"request failed"}]}')

  REPORT=$(echo "$INVENTORY_JSON" | python3 -c "
import json, sys
data = json.load(sys.stdin)

if 'errors' in data:
    print('Store Health: ERROR — ' + data['errors'][0].get('message', 'unknown'))
    sys.exit(0)

products = data.get('data', {}).get('products', {}).get('edges', [])
threshold = int('${LOW_STOCK_THRESHOLD}')
lines = ['*Daily Store Health*', '']
low_stock = []
all_ok = []

for p in products:
    node = p['node']
    name = node['title']
    for v in node.get('variants', {}).get('edges', []):
        vn = v['node']
        qty = vn.get('quantityAvailable') or 0
        avail = vn.get('availableForSale', False)
        label = vn['title'] if vn['title'] != 'Default Title' else ''
        display = f'{name}' + (f' — {label}' if label else '')
        if qty < threshold or not avail:
            low_stock.append(f'  LOW: {display} ({qty} units)')
        else:
            all_ok.append(f'  OK: {display} ({qty} units)')

if low_stock:
    lines.append('*LOW STOCK ALERTS:*')
    lines.extend(low_stock)
    lines.append('')
lines.append('*In Stock:*')
lines.extend(all_ok[:5])
if len(all_ok) > 5:
    lines.append(f'  ...and {len(all_ok)-5} more')
print('\n'.join(lines))
" 2>/dev/null || echo "Store Health: failed to parse inventory response")
fi

log "Report generated — sending to Telegram"

# ── Send to Telegram ──────────────────────────────────────────────────────
if [[ -n "$TELEGRAM_TOKEN" ]]; then
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\": \"$TELEGRAM_CHAT\", \"text\": $(echo "$REPORT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'), \"parse_mode\": \"Markdown\"}" \
    >> "$LOG" 2>&1
  log "Store health sent to Telegram chat=$TELEGRAM_CHAT"
else
  log "WARN: TELEGRAM_BOT_TOKEN not set — printing report to stdout"
  echo "$REPORT"
fi

log "HEARTBEAT_OK"
