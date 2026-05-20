---
name: ops-settings
description: Post-setup credential manager. Shows current integration status (configured/missing/expired) and lets you update individual credentials without re-running the full setup wizard. Runs a smoke test after each update.
argument-hint: "[integration-name] [--status]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
effort: low
maxTurns: 20
---

## Runtime Context

```!
PREFS="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json"
cat "$PREFS" 2>/dev/null || echo '{}'
```

# OPS ► SETTINGS

Manage credentials and integration config after initial setup.

## Parse arguments

- `--status` or empty → show full credential status dashboard
- `<integration-name>` → jump directly to updating that integration (e.g. `/ops:settings stripe`)
- `--status <integration-name>` → show status of one integration only

## Credential Status Dashboard

Read `preferences.json`. For each known integration, check whether the key exists and is non-empty. Also probe liveness where possible.

Display as a table:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► SETTINGS — Integration Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Integration         Status        Last Updated
 ─────────────────── ────────────  ─────────────
 GitHub (gh cli)     ✅ active     (always active if gh auth status)
 Stripe              ✅ configured  2026-04-14
 RevenueCat          ✅ configured  2026-04-14
 Telegram            ✅ configured  2026-04-13
 Slack               ⚠️  missing    —
 Linear              ✅ configured  2026-04-11
 Sentry              ⚠️  missing    —
 AWS                 ✅ active     (always active if aws sts works)
 Shopify             ⚠️  missing    —
 Klaviyo             ⚠️  missing    —
 Meta Ads            ⚠️  missing    —
 GA4                 ⚠️  missing    —
 ElevenLabs          ⚠️  missing    —
 Datadog             ⚠️  missing    —
 New Relic           ⚠️  missing    —
 ...

 ✅ N configured   ⚠️ N missing
──────────────────────────────────────────────────────
```

## Probe liveness

For integrations with a cheap health check, run it to distinguish "configured but expired" from "configured and active":

| Integration | Probe | Active signal |
|-------------|-------|---------------|
| Stripe | `curl -s -o /dev/null -w "%{http_code}" -u "${stripe_key}:" https://api.stripe.com/v1/balance` | 200 |
| GitHub | `gh auth status 2>&1` | "Logged in" |
| AWS | `aws sts get-caller-identity --output text 2>/dev/null` | exits 0 |
| Linear | `cat "$PREFS" | jq -r .linear_team` | non-empty |
| Doppler MCP | Check if DOPPLER_TOKEN is set and valid | Token present and MCP server responds |

Show `🔴 expired` if probe fails for a previously-configured key.

## Update an integration

When a specific integration is selected (via argument or user pick from dashboard):

1. Show current value (masked): `sk_live_••••••••••••••••` (last 4 chars visible)
2. Use AskUserQuestion to confirm the update action:
   ```
   [Enter new value]  [Test current value]  [Clear this credential]  [Back to dashboard]
   ```
3. For "Enter new value": prompt with `AskUserQuestion` text input
4. Write new value to `preferences.json` via `jq` update:
   ```bash
   tmp=$(mktemp)
   jq --arg v "$NEW_VALUE" --arg k "$KEY_NAME" '.[$k] = $v' "$PREFS" > "$tmp" && mv "$tmp" "$PREFS"
   ```
5. Run smoke test immediately after update (see Smoke Tests section)
6. Report: `✅ Stripe key updated — smoke test passed` or `⚠️ Key saved but smoke test failed: <reason>`

## Smoke Tests

| Integration | Smoke test command |
|-------------|-------------------|
| Stripe | `curl -s -u "${new_key}:" https://api.stripe.com/v1/balance \| jq .object` → must be "balance" |
| RevenueCat | `curl -s -H "Authorization: Bearer ${new_key}" "https://api.revenuecat.com/v2/projects" \| jq '.items \| length'` → non-zero |
| Telegram | `node ${CLAUDE_PLUGIN_ROOT}/telegram-server/index.js --health 2>&1` → "healthy" |
| Slack | `curl -s -H "Authorization: Bearer ${new_token}" https://slack.com/api/auth.test \| jq .ok` → true |
| Shopify | `curl -s -H "X-Shopify-Access-Token: ${new_token}" "https://${store_url}/admin/api/2024-01/shop.json" \| jq .shop.name` → non-null |
| Klaviyo | `curl -s -H "Authorization: Klaviyo-API-Key ${new_key}" https://a.klaviyo.com/api/accounts/ \| jq '.data[0].id'` → non-null |
| Datadog | `curl -s -H "DD-API-KEY: ${new_key}" https://api.datadoghq.com/api/v1/validate \| jq .valid` → true |
| New Relic | `curl -s -H "Api-Key: ${new_key}" https://api.newrelic.com/v2/applications.json \| jq '.applications | length'` → numeric |
| Doppler MCP | `npx -y @dopplerhq/mcp-server --help 2>&1` with DOPPLER_TOKEN set | exits 0 |

## Autopilot Studio (per-project)

Lets an operator view and edit per-project autopilot config **without re-running setup**. See `skills/ops-marketing/SKILL.md` → `## autopilot` for the full field semantics.

**List projects that have an autopilot block:**

```bash
jq -r '.marketing.projects | to_entries[] | select(.value.autopilot) | .key' "$PREFS"
```

If more than 4 projects, paginate the picker at 4 per `AskUserQuestion` page with `[More...]` as the bridge (Rule 1).

**Show current config for the chosen project `$P`:**

```bash
jq --arg p "$P" '.marketing.projects[$p].autopilot' "$PREFS"
```

**Editor.** Drive edits via `AskUserQuestion`, batching the editable fields across multiple ≤4-option questions (Rule 1):

- **Q1 — autonomy & kill switch:** `[autonomy_level]` `[envelope.kill_switch]` `[Back]`
- **Q2 — envelope limits:** `[envelope.max_campaigns]` `[envelope.max_new_audiences]` `[envelope.max_daily_budget_usd]` `[More...]`
- **Q3 — envelope allowlists:** `[envelope.objective_allowlist]` `[envelope.geo_allowlist]` `[Back]`
- **Q4 — source & creative:** `[source.url]` `[creative_gen.daily_gen_spend_cap_usd]` `[creative_gen.neurons.enabled]` `[Back]`

For `autonomy_level` offer the 4 fixed values across one question: `[create_once]` `[sandbox]` `[unrestricted]` `[Back]`. Allowlists are comma-separated free text; numeric/boolean fields are free text or a 2-option toggle.

**Merge-write pattern** (mirrors the "Update an integration" jq pattern, nested under `.marketing.projects[$p].autopilot` — never clobber sibling keys):

```bash
tmp=$(mktemp)
jq --arg p "$P" --arg v "$V" \
  '.marketing.projects[$p].autopilot.autonomy_level = $v' "$PREFS" > "$tmp" && mv "$tmp" "$PREFS"
```

Use the matching jq path per field, e.g.:

```bash
# numeric envelope field (jq tonumber to keep it a number)
jq --arg p "$P" --argjson v "$V" \
  '.marketing.projects[$p].autopilot.envelope.max_campaigns = $v' "$PREFS" > "$tmp" && mv "$tmp" "$PREFS"

# boolean kill switch
jq --arg p "$P" --argjson v true \
  '.marketing.projects[$p].autopilot.envelope.kill_switch = $v' "$PREFS" > "$tmp" && mv "$tmp" "$PREFS"

# allowlist (comma-separated input -> JSON array)
jq --arg p "$P" --arg v "NL,US" \
  '.marketing.projects[$p].autopilot.envelope.geo_allowlist = ($v | split(","))' \
  "$PREFS" > "$tmp" && mv "$tmp" "$PREFS"

# source URL
jq --arg p "$P" --arg v "https://example.com" \
  '.marketing.projects[$p].autopilot.source.url = $v' "$PREFS" > "$tmp" && mv "$tmp" "$PREFS"

# Gemini gen spend cap (must be <= daily_spend_cap_usd — validate before write)
jq --arg p "$P" --argjson v "$V" \
  '.marketing.projects[$p].autopilot.creative_gen.daily_gen_spend_cap_usd = $v' \
  "$PREFS" > "$tmp" && mv "$tmp" "$PREFS"

# Neurons external signal
jq --arg p "$P" --argjson v false \
  '.marketing.projects[$p].autopilot.creative_gen.neurons.enabled = $v' \
  "$PREFS" > "$tmp" && mv "$tmp" "$PREFS"
```

**Safety note (surface this before writing):**

- Lowering `autonomy_level` to `unrestricted` **removes the default creation guardrail** — autonomous campaign/audience/budget creation becomes bounded only by `daily_spend_cap_usd`. Confirm via `AskUserQuestion` (`[Set unrestricted]` / `[Keep current]`) before writing.
- Setting `envelope.kill_switch: true` **hard-stops all mutations** on the next pass (stage-only, zero writes) regardless of `autonomy_level`.
- The Credential Status Dashboard MUST surface `autonomy_level` and `kill_switch` for every project with `autopilot.enabled == true`.

## Pocket

Manages the voice-journal activity notifier (POCKET_API_KEY watcher + WhatsApp/email bridges + launchd agent).

Route here when the user runs `/ops:settings pocket` or selects "Pocket" from the dashboard.

### View status

Read all four health files and print a compact status block:

```bash
STATE_DIR="$HOME/.claude/state/pocket"
for f in .activity-notifier-health .out-queue-health .email-bridge-health .whatsapp-bridge-health; do
  label="${f#.}"
  label="${label%-health}"
  content=$(cat "$STATE_DIR/$f" 2>/dev/null)
  if [ -z "$content" ]; then
    echo "$label: missing"
  else
    status=$(echo "$content" | jq -r '.status // "unknown"' 2>/dev/null)
    msg=$(echo "$content"    | jq -r '.message // ""'       2>/dev/null)
    last=$(echo "$content"   | jq -r '.last_run // ""'      2>/dev/null)
    echo "$label: $status  $msg  ($last)"
  fi
done
```

For each service whose status is not `"ok"`, flag it:

```
activity-notifier: ok  (2026-05-20T12:34:56Z)
out-queue:         ok  sent=3  (2026-05-20T12:34:55Z)
email-bridge:      disabled  (2026-05-20T12:34:50Z)
whatsapp-bridge:   ok  scanned=12 routed=1  (2026-05-20T12:34:54Z)
```

Show `✗ missing` for any health file that does not exist.

### View task counts

```bash
STATE_DIR="$HOME/.claude/state/pocket"
echo "tasks.jsonl:          $(wc -l < "$STATE_DIR/tasks.jsonl"         2>/dev/null || echo 0) lines"
echo "pending-triage.jsonl: $(wc -l < "$STATE_DIR/pending-triage.jsonl" 2>/dev/null || echo 0) lines"
echo "executor-results/:    $(ls "$STATE_DIR/executor-results/" 2>/dev/null | wc -l | tr -d ' ') files"
```

### Toggle channels

Ask `AskUserQuestion`:

```
Which Pocket notification channel setting would you like to change?
  [Toggle WhatsApp]  [Toggle Email]  [Edit self-address]  [Back]
```

**Toggle WhatsApp** — read `~/.claude/state/pocket/whatsapp-config.json`, flip `.enabled`, write back:

```bash
F="$HOME/.claude/state/pocket/whatsapp-config.json"
CUR=$(jq -r '.enabled' "$F" 2>/dev/null || echo false)
NEW=$([ "$CUR" = "true" ] && echo false || echo true)
jq --argjson v "$NEW" '.enabled = $v' "$F" > "${F}.tmp" && mv "${F}.tmp" "$F"
echo "WhatsApp notifications: $NEW"
```

**Toggle Email** — same pattern with `~/.claude/state/pocket/email-config.json`.

**Edit self-address** — show current `email-config.json:.self_address`, ask for new value via `AskUserQuestion` text input, write back:

```bash
F="$HOME/.claude/state/pocket/email-config.json"
jq --arg v "$NEW_ADDR" '.self_address = $v | .from_account = $v' "$F" > "${F}.tmp" && mv "${F}.tmp" "$F"
```

### Force a fresh Pocket pull

Run the watcher directly (picks up POCKET_API_KEY from keychain/env):

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(ls -d "$HOME/.claude/plugins/cache/ops-marketplace/ops"/*/ 2>/dev/null | sort -V | tail -1)}"
python3 "$PLUGIN_ROOT/scripts/ops-cron-pocket-watcher.py"
```

Report exit code and last line of `~/.claude/state/pocket/run.log`.

### Restart notifier

```bash
launchctl kickstart -k "gui/$(id -u)/com.claude-ops.pocket-activity-notifier"
```

Wait 3 seconds then print the updated `.activity-notifier-health` status.

### View last 3 outbound notifications

```bash
STATE_DIR="$HOME/.claude/state/pocket"
echo "=== WhatsApp (out-queue-sent.jsonl) ==="
tail -3 "$STATE_DIR/out-queue-sent.jsonl" 2>/dev/null | jq -r '"\(.sent_at // .ts // "?")  \(.message // .body // "" | .[0:80])"' 2>/dev/null || echo "(none)"
echo "=== Email (email-sent.jsonl) ==="
tail -3 "$STATE_DIR/email-sent.jsonl"     2>/dev/null | jq -r '"\(.sent_at // .ts // "?")  \(.subject // "" | .[0:80])"'                2>/dev/null || echo "(none)"
```

## Daemon Services

Manage background daemon services declared in `daemon-services.default.json`. Route here when the user runs `/ops:settings daemons` or selects "Daemon services" from the dashboard.

### Display the daemon services table

```bash
DAEMON_DEFAULT="${CLAUDE_PLUGIN_ROOT}/scripts/daemon-services.default.json"
DAEMON_OVERRIDE="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/daemon-services.override.json"

# Merge: override file wins on matching service keys
if [ -f "$DAEMON_OVERRIDE" ]; then
  jq -s '.[0].services * .[1].services' "$DAEMON_DEFAULT" "$DAEMON_OVERRIDE" 2>/dev/null
else
  jq '.services' "$DAEMON_DEFAULT" 2>/dev/null
fi
```

Display as a table (for each service, show enabled state, last_run age, and health status from the `health_file` if declared):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS ► SETTINGS — Daemon Services
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Service                   Enabled   Last Run      Health
 ──────────────────────── ───────── ────────────  ────────────
 briefing-pre-warm          ✅ on    2m ago        ✓ ok
 memory-extractor           ✅ on    18m ago       ✓ ok
 message-listener           ⏸ off   —             —
 competitor-intel           ⏸ off   —             —
 marketing-autopilot        ⏸ off   —             —

──────────────────────────────────────────────────────────────────
```

For each `enabled: true` service with a `health_file`, expand `~` → `$HOME`, read the JSON file, extract `.last_run` and `.status`. Services with no `health_file` show `—`.

### Toggle a service on or off

Writes to the **override file only** — never edits `daemon-services.default.json`.

Confirm each toggle via `AskUserQuestion` (`[Enable]` / `[Disable]` / `[Cancel]`) before writing.

```bash
DAEMON_OVERRIDE="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/daemon-services.override.json"
tmp=$(mktemp)
# Enable:
jq --arg svc "$SERVICE_NAME" '.services[$svc].enabled = true' \
  "${DAEMON_OVERRIDE}" > "$tmp" 2>/dev/null \
  || echo "{\"services\":{\"$SERVICE_NAME\":{\"enabled\":true}}}" > "$tmp"
mv "$tmp" "$DAEMON_OVERRIDE"
# Disable: same pattern with `= false`
```

If the override file does not exist yet, initialise it with `{"services":{}}` before writing.

### View last 5 log lines for a service

```bash
OPS_DATA_DIR="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
tail -n 5 "$OPS_DATA_DIR/logs/${SERVICE_NAME}.log" 2>/dev/null || echo "(no log file found)"
```

### Manually trigger a service

- **launchd-registered** (plist-backed, e.g. `whatsapp-bridge`):
  ```bash
  launchctl kickstart -k "gui/$UID/com.<user>.${SERVICE_NAME}"
  ```
- **Cron-style / script-based** (have a `command` pointing to a `.sh` file):
  ```bash
  COMMAND=$(jq -r ".services[\"$SERVICE_NAME\"].command" "$DAEMON_DEFAULT" \
    | sed "s|\${CLAUDE_PLUGIN_ROOT}|${CLAUDE_PLUGIN_ROOT}|g")
  bash "$COMMAND"
  ```

Always confirm via `AskUserQuestion` (`[Run now]` / `[Cancel]`) before triggering.

## CLI/API Reference

| Command | Purpose |
|---------|---------|
| `cat "$PREFS" \| jq 'keys'` | List all configured keys |
| `jq --arg v "$V" --arg k "$K" '.[$k] = $v' "$PREFS"` | Update a single key |
| `gh auth status` | Verify GitHub CLI auth |
| `aws sts get-caller-identity` | Verify AWS auth |
