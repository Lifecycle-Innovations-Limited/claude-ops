#!/usr/bin/env bash
# test-template.sh — Validates Shopify admin app template
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE_DIR="$PLUGIN_ROOT/templates/shopify-admin-app"

pass=0
fail=0

ok()   { echo "  PASS: $1"; pass=$((pass+1)); }
err()  { echo "  FAIL: $1"; fail=$((fail+1)); }

echo "Checking: templates/shopify-admin-app/"
echo ""

# 1. Template directory exists
if [[ ! -d "$TEMPLATE_DIR" ]]; then
  echo "FAIL: templates/shopify-admin-app/ not found"
  exit 1
fi
ok "template directory exists"

# 2. shopify.app.toml exists
TOML="$TEMPLATE_DIR/shopify.app.toml"
if [[ -f "$TOML" ]]; then
  ok "shopify.app.toml exists"
else
  err "shopify.app.toml missing"
fi

# 3. shopify.app.toml has scopes
if [[ -f "$TOML" ]]; then
  if grep -q "scopes" "$TOML"; then
    ok "shopify.app.toml has scopes"
  else
    err "shopify.app.toml missing scopes declaration"
  fi

  # 4. scopes line has actual scope values (not empty)
  scopes_line=$(grep "^scopes" "$TOML" | head -1 || true)
  if echo "$scopes_line" | grep -qE 'scopes\s*=\s*"[^"]+'; then
    ok "scopes is non-empty"
  else
    err "scopes appears to be empty in shopify.app.toml"
  fi

  # 5. client_id should be empty (template placeholder, not hardcoded)
  client_id_line=$(grep "^client_id" "$TOML" | head -1 || true)
  if [[ -n "$client_id_line" ]]; then
    # Should be empty string or unset for a template
    if echo "$client_id_line" | grep -qE '^client_id\s*=\s*""'; then
      ok "client_id is empty (correct for template)"
    else
      err "client_id appears to be hardcoded: $client_id_line"
    fi
  else
    ok "client_id not present (template will set at install time)"
  fi
fi

# 6. package.json exists
PKG="$TEMPLATE_DIR/package.json"
if [[ -f "$PKG" ]]; then
  ok "package.json exists"
else
  err "package.json missing"
fi

# 7. package.json is valid JSON
if [[ -f "$PKG" ]]; then
  if command -v jq &>/dev/null; then
    if jq empty "$PKG" 2>/dev/null; then
      ok "package.json is valid JSON"
    else
      err "package.json is invalid JSON"
    fi
  elif command -v python3 &>/dev/null; then
    if python3 -c "import json,sys; json.load(open('$PKG'))" 2>/dev/null; then
      ok "package.json is valid JSON (python3)"
    else
      err "package.json is invalid JSON"
    fi
  else
    echo "  SKIP: no JSON validator available for package.json"
  fi

  # 8. package.json has name field
  if command -v jq &>/dev/null; then
    name=$(jq -r '.name // empty' "$PKG" 2>/dev/null || true)
    if [[ -n "$name" ]]; then
      ok "package.json has name: $name"
    else
      err "package.json missing 'name' field"
    fi

    # 9. package.json has scripts
    scripts=$(jq -r '.scripts // empty' "$PKG" 2>/dev/null || true)
    if [[ -n "$scripts" ]]; then
      ok "package.json has scripts section"
    else
      err "package.json missing 'scripts' section"
    fi
  fi

  # 10. No hardcoded client_id in package.json (should not contain shp_ or actual client IDs)
  if grep -qE '"client_id"\s*:\s*"[a-f0-9-]{30,}"' "$PKG" 2>/dev/null; then
    err "package.json contains a hardcoded client_id value"
  else
    ok "package.json has no hardcoded client_id"
  fi
fi

# 11. shopify.web.toml exists (if present, validate it has [roles])
WEB_TOML="$TEMPLATE_DIR/shopify.web.toml"
if [[ -f "$WEB_TOML" ]]; then
  ok "shopify.web.toml exists"
  if grep -q "\[" "$WEB_TOML"; then
    ok "shopify.web.toml has section headers"
  else
    err "shopify.web.toml appears empty or malformed"
  fi
fi

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
echo ""

if (( fail > 0 )); then
  exit 1
fi
exit 0
