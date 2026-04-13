---
name: ops-ecom
description: Shopify store command center. Orders, inventory, fulfillment, analytics, and store health. Works with any Shopify store via Admin API.
argument-hint: "[orders|inventory|fulfillment|health|products|customers|analytics|setup]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
  - WebFetch
  - WebSearch
effort: medium
maxTurns: 40
---

# OPS ► ECOM — Shopify Store Command Center

## Runtime Context

Before executing, load available context:

1. **Preferences**: Read `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json`
   - `timezone` — display all timestamps correctly
   - `shopify_store_url`, `shopify_admin_token` — check userConfig keys before env vars

2. **Daemon health**: Read `${CLAUDE_PLUGIN_DATA_DIR}/daemon-health.json`
   - If `action_needed` is not null → surface it before running any store operations

3. **Secrets**: Resolve Shopify credentials via userConfig → env vars → Doppler (see Phase 1 below)

## CLI/API Reference

### Shopify Admin REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/api/2024-10/shop.json` | GET | Store info and plan |
| `/admin/api/2024-10/orders.json?status=any&limit=50` | GET | Recent orders |
| `/admin/api/2024-10/products.json?limit=250` | GET | Product catalog |
| `/admin/api/2024-10/customers.json?limit=50` | GET | Customer list |
| `/admin/api/2024-10/themes.json` | GET | Theme list |
| `/admin/api/2024-10/variants/${ID}.json` | PUT | Update variant price |

**Auth header**: `X-Shopify-Access-Token: ${SHOPIFY_TOKEN}`

### ShipBob API (optional)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `https://api.shipbob.com/1.0/shipment?Status=Processing&PageSize=20` | GET | Pending shipments |

**Auth header**: `Authorization: Bearer ${SHIPBOB_TOKEN}`

## Phase 1 — Resolve credentials

Resolve Shopify credentials in this order:

```bash
# 1. Plugin userConfig
SHOPIFY_STORE="${user_config.shopify_store_url}"
SHOPIFY_TOKEN="${user_config.shopify_admin_token}"
SHIPBOB_TOKEN="${user_config.shipbob_access_token}"

# 2. Environment variables (override userConfig if set)
[ -n "$SHOPIFY_STORE_URL" ] && SHOPIFY_STORE="$SHOPIFY_STORE_URL"
[ -n "$SHOPIFY_ACCESS_TOKEN" ] && SHOPIFY_TOKEN="$SHOPIFY_ACCESS_TOKEN"
[ -n "$SHIPBOB_ACCESS_TOKEN" ] && SHIPBOB_TOKEN="$SHIPBOB_ACCESS_TOKEN"

# 3. Doppler fallback
if [ -z "$SHOPIFY_TOKEN" ] && command -v doppler &>/dev/null; then
  SHOPIFY_TOKEN=$(doppler secrets get SHOPIFY_ACCESS_TOKEN --plain 2>/dev/null)
fi
if [ -z "$SHOPIFY_STORE" ] && command -v doppler &>/dev/null; then
  SHOPIFY_STORE=$(doppler secrets get SHOPIFY_STORE_URL --plain 2>/dev/null)
fi
if [ -z "$SHIPBOB_TOKEN" ] && command -v doppler &>/dev/null; then
  SHIPBOB_TOKEN=$(doppler secrets get SHIPBOB_ACCESS_TOKEN --plain 2>/dev/null)
fi
```

If `$SHOPIFY_STORE` or `$SHOPIFY_TOKEN` is still empty after all resolution steps, route to **setup flow** below.

Set base URLs:
```bash
SHOPIFY_BASE="https://${SHOPIFY_STORE}/admin/api/2024-10"
SHOPIFY_GQL="https://${SHOPIFY_STORE}/admin/api/2024-10/graphql.json"
SHOPIFY_AUTH="X-Shopify-Access-Token: ${SHOPIFY_TOKEN}"
```

---

## Phase 2 — Route by $ARGUMENTS

| Input                                      | Action              |
| ------------------------------------------ | ------------------- |
| (empty)                                    | Show store summary  |
| orders, order                              | Orders dashboard    |
| inventory, stock, inv                      | Inventory levels    |
| fulfillment, fulfill, shipbob, shipping    | Fulfillment status  |
| health, check, status                      | Store health check  |
| products, product, catalog                 | Products manager    |
| customers, customer, crm                   | Customer stats      |
| analytics, revenue, stats, metrics         | Analytics dashboard |
| setup, configure, init, token              | Setup flow          |

---

## ORDERS

Fetch recent orders and compute revenue:

```bash
TODAY=$(date -u +"%Y-%m-%dT00:00:00Z")
WEEK_AGO=$(date -u -v-7d +"%Y-%m-%dT00:00:00Z" 2>/dev/null || date -u -d "7 days ago" +"%Y-%m-%dT00:00:00Z")
MONTH_AGO=$(date -u -v-30d +"%Y-%m-%dT00:00:00Z" 2>/dev/null || date -u -d "30 days ago" +"%Y-%m-%dT00:00:00Z")

# Recent orders (last 50)
curl -s -H "$SHOPIFY_AUTH" \
  "${SHOPIFY_BASE}/orders.json?status=any&limit=50&order=created_at+desc" | \
  jq '{
    total: .orders | length,
    today: [.orders[] | select(.created_at >= "'"$TODAY"'")],
    orders: [.orders[:10] | .[] | {
      id: .order_number,
      name: .name,
      status: .financial_status,
      fulfillment: .fulfillment_status,
      total: .total_price,
      currency: .currency,
      customer: (.customer.first_name + " " + .customer.last_name),
      created: .created_at
    }]
  }'
```

Render:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► ECOM ► ORDERS — [store] — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REVENUE
  Today    [N orders]   $[amount]
  7 days   [N orders]   $[amount]
  30 days  [N orders]   $[amount]

RECENT ORDERS
  #[id]  [customer]  $[total]  [status] / [fulfillment]  [age]
  ...

──────────────────────────────────────────────────────
 Actions:
 a) View order details for #[id]
 b) Mark order as fulfilled
 c) Export orders CSV
 d) Filter by status (unfulfilled/refunded/paid)
──────────────────────────────────────────────────────
```

Use `AskUserQuestion` for action selection.

---

## INVENTORY

Fetch all products and variant inventory:

```bash
# Get all products with variants
curl -s -H "$SHOPIFY_AUTH" \
  "${SHOPIFY_BASE}/products.json?limit=250&fields=id,title,status,variants" | \
  jq '[.products[] | {
    id: .id,
    title: .title,
    status: .status,
    variants: [.variants[] | {
      id: .id,
      title: .title,
      sku: .sku,
      inventory_quantity: .inventory_quantity,
      inventory_policy: .inventory_policy
    }]
  }]'
```

Flag low stock (inventory_quantity < 10) and out-of-stock (inventory_quantity <= 0).

Render:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► ECOM ► INVENTORY — [store] — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OUT OF STOCK
  [product] — [variant] — SKU: [sku]

LOW STOCK (< 10 units)
  [product] — [variant] — [N] units — SKU: [sku]

ALL PRODUCTS
  [product]
    [variant]  [N] units  SKU: [sku]
  ...

──────────────────────────────────────────────────────
 Actions:
 a) Update inventory for [product]
 b) Export inventory CSV
 c) Set reorder alerts
──────────────────────────────────────────────────────
```

Use `AskUserQuestion` for action selection.

---

## FULFILLMENT

Fetch unfulfilled orders and ShipBob status (if token available):

```bash
# Unfulfilled orders
curl -s -H "$SHOPIFY_AUTH" \
  "${SHOPIFY_BASE}/orders.json?fulfillment_status=unfulfilled&status=open&limit=50" | \
  jq '[.orders[] | {
    id: .order_number,
    name: .name,
    customer: (.customer.first_name + " " + .customer.last_name),
    total: .total_price,
    created: .created_at,
    items: [.line_items[] | {title: .title, qty: .quantity}]
  }]'

# Shipments with tracking (fulfilled)
curl -s -H "$SHOPIFY_AUTH" \
  "${SHOPIFY_BASE}/orders.json?fulfillment_status=fulfilled&status=any&limit=20&order=updated_at+desc" | \
  jq '[.orders[] | .fulfillments[] | {
    order: .order_id,
    tracking_number: .tracking_number,
    tracking_url: .tracking_url,
    shipment_status: .shipment_status,
    carrier: .tracking_company,
    updated: .updated_at
  }]'
```

If `$SHIPBOB_TOKEN` is set, also query ShipBob:

```bash
# ShipBob pending shipments
curl -s -H "Authorization: Bearer ${SHIPBOB_TOKEN}" \
  "https://api.shipbob.com/1.0/shipment?Status=Processing&PageSize=20" | \
  jq '[.[] | {
    id: .id,
    status: .status,
    order_id: .reference_id,
    tracking: .tracking_number,
    created: .created_date
  }]'
```

Render fulfillment dashboard with pending/in-transit/delivered counts.

Use `AskUserQuestion` for action selection (mark fulfilled, update tracking, etc.).

---

## HEALTH

Run the health check script, then augment with API checks:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/ops-ecom-health 2>/dev/null || echo '{"error":"health script unavailable"}'
```

Also check:

```bash
# Active theme
curl -s -H "$SHOPIFY_AUTH" \
  "${SHOPIFY_BASE}/themes.json" | \
  jq '[.themes[] | select(.role == "main") | {id: .id, name: .name, updated: .updated_at}]'

# Store info
curl -s -H "$SHOPIFY_AUTH" \
  "${SHOPIFY_BASE}/shop.json" | \
  jq '.shop | {name: .name, domain: .domain, country: .country_name, plan: .plan_display_name, currency: .currency, timezone: .timezone}'
```

Render:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► ECOM ► HEALTH — [store] — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STORE
  Name:      [name]
  Plan:      [plan]
  Currency:  [currency]
  Timezone:  [tz]

API CONNECTIVITY  [OK / FAIL]
ACTIVE THEME      [theme name]
PRODUCT COUNT     [N] active
ORDERS (24h)      [N] orders

ISSUES
  [any warnings from health check]

──────────────────────────────────────────────────────
 Actions:
 a) Check theme assets for errors
 b) Run full SEO audit
 c) View API rate limit status
──────────────────────────────────────────────────────
```

Use `AskUserQuestion` for action selection.

---

## PRODUCTS

List, search, and manage products:

```bash
# All products
curl -s -H "$SHOPIFY_AUTH" \
  "${SHOPIFY_BASE}/products.json?limit=250&order=updated_at+desc" | \
  jq '[.products[] | {
    id: .id,
    title: .title,
    status: .status,
    handle: .handle,
    price: (.variants[0].price // "N/A"),
    inventory: ([.variants[].inventory_quantity] | add // 0),
    variants: (.variants | length),
    updated: .updated_at
  }]'
```

If `$ARGUMENTS` contains a search term (e.g., `products shoes`), filter by title.

For price updates, use:

```bash
# Update variant price
curl -s -X PUT -H "$SHOPIFY_AUTH" -H "Content-Type: application/json" \
  "${SHOPIFY_BASE}/variants/${VARIANT_ID}.json" \
  -d '{"variant":{"id":'${VARIANT_ID}',"price":"'${NEW_PRICE}'"}}'
```

Use `AskUserQuestion` before making any product updates. Show before/after prices.

---

## CUSTOMERS

Fetch customer stats:

```bash
# Customer count and recent
curl -s -H "$SHOPIFY_AUTH" \
  "${SHOPIFY_BASE}/customers.json?limit=50&order=created_at+desc" | \
  jq '{
    total_shown: (.customers | length),
    recent: [.customers[:10] | .[] | {
      id: .id,
      name: (.first_name + " " + .last_name),
      email: .email,
      orders: .orders_count,
      total_spent: .total_spent,
      currency: .currency,
      created: .created_at
    }]
  }'

# Top customers by spend
curl -s -H "$SHOPIFY_AUTH" \
  "${SHOPIFY_BASE}/customers.json?limit=10&order=total_spent+desc" | \
  jq '[.customers[] | {name: (.first_name + " " + .last_name), orders: .orders_count, spent: .total_spent}]'
```

Render customer overview with LTV stats and top spenders.

---

## ANALYTICS

Pull revenue and order data for dashboard:

```bash
TODAY=$(date -u +"%Y-%m-%dT00:00:00Z")
WEEK_AGO=$(date -u -v-7d +"%Y-%m-%dT00:00:00Z" 2>/dev/null || date -u -d "7 days ago" +"%Y-%m-%dT00:00:00Z")
MONTH_AGO=$(date -u -v-30d +"%Y-%m-%dT00:00:00Z" 2>/dev/null || date -u -d "30 days ago" +"%Y-%m-%dT00:00:00Z")

# Orders for revenue calculation
curl -s -H "$SHOPIFY_AUTH" \
  "${SHOPIFY_BASE}/orders.json?status=any&financial_status=paid&created_at_min=${MONTH_AGO}&limit=250" | \
  jq '{
    month_orders: (.orders | length),
    month_revenue: ([.orders[].total_price | tonumber] | add // 0),
    week_orders: ([.orders[] | select(.created_at >= "'"$WEEK_AGO"'")] | length),
    week_revenue: ([.orders[] | select(.created_at >= "'"$WEEK_AGO"'") | .total_price | tonumber] | add // 0),
    today_orders: ([.orders[] | select(.created_at >= "'"$TODAY"'")] | length),
    today_revenue: ([.orders[] | select(.created_at >= "'"$TODAY"'") | .total_price | tonumber] | add // 0),
    avg_order_value: ([.orders[].total_price | tonumber] | (add // 0) / (length // 1)),
    top_products: ([.orders[].line_items[] | {title: .title, qty: .quantity}] | group_by(.title) | map({title: .[0].title, total_qty: map(.qty) | add}) | sort_by(-.total_qty)[:5])
  }'
```

Render:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► ECOM ► ANALYTICS — [store] — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REVENUE
  Today    $[amount]  ([N] orders)
  7 days   $[amount]  ([N] orders)
  30 days  $[amount]  ([N] orders)

AVERAGES
  AOV (30d)  $[amount]

TOP PRODUCTS (30d)
  1. [product]  [N] sold
  2. [product]  [N] sold
  ...

──────────────────────────────────────────────────────
 Actions:
 a) Export revenue report (CSV)
 b) View by product breakdown
 c) Compare to previous period
──────────────────────────────────────────────────────
```

Use `AskUserQuestion` for action selection.

---

## SETUP FLOW

Guide the user through configuring Shopify credentials:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► ECOM ► SETUP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

To connect your Shopify store, you need:

1. Store URL (e.g., mystore.myshopify.com)
2. Admin API access token (shpat_...)

To get your Admin API token:
  1. Go to your Shopify Admin > Settings > Apps and sales channels
  2. Click "Develop apps" > "Create an app"
  3. Under "Configuration", enable Admin API scopes:
     read_orders, write_orders, read_products, write_products,
     read_customers, read_inventory, write_inventory,
     read_fulfillments, write_fulfillments, read_analytics
  4. Click "Install app" to generate the access token
  5. Copy the token (starts with shpat_)

Store the credentials via one of:
  a) Plugin userConfig: set shopify_store_url + shopify_admin_token
  b) Environment: export SHOPIFY_STORE_URL=... SHOPIFY_ACCESS_TOKEN=...
  c) Doppler: doppler secrets set SHOPIFY_STORE_URL SHOPIFY_ACCESS_TOKEN

ShipBob (optional):
  Get your Personal Access Token from app.shipbob.com > Developer > API
  Store as shipbob_access_token in userConfig or $SHIPBOB_ACCESS_TOKEN
```

Use `AskUserQuestion` to collect store URL, then verify connectivity:

```bash
curl -s -H "X-Shopify-Access-Token: ${PROVIDED_TOKEN}" \
  "https://${PROVIDED_STORE}/admin/api/2024-10/shop.json" | \
  jq '.shop | {name, domain, plan: .plan_display_name}'
```

If the connectivity check returns valid shop data, confirm success. If it fails with 401/403, explain the token is invalid and re-prompt.

---

## STORE SUMMARY (empty $ARGUMENTS)

When called with no arguments, show a compact store overview:

Run orders, inventory, and health checks in parallel (separate Bash calls), then render:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► ECOM — [store] — [timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STORE         [name] ([plan])
CURRENCY      [currency]

TODAY         $[revenue]  [N] orders
7 DAYS        $[revenue]  [N] orders
30 DAYS       $[revenue]  [N] orders

INVENTORY     [N] products  |  [N] low stock  |  [N] out of stock
FULFILLMENT   [N] unfulfilled orders pending

──────────────────────────────────────────────────────
 /ops:ops-ecom orders     — order management
 /ops:ops-ecom inventory  — stock levels
 /ops:ops-ecom products   — product catalog
 /ops:ops-ecom customers  — customer stats
 /ops:ops-ecom analytics  — revenue dashboard
 /ops:ops-ecom health     — store health check
 /ops:ops-ecom setup      — configure credentials
──────────────────────────────────────────────────────
```
