---
name: ops-package
description: Ship parcels via MyParcel.nl. Create shipments, download labels, track status, and list recent shipments. Wraps https://api.myparcel.nl with Basic auth (key base64-encoded at runtime).
argument-hint: "<ship|label|track|list> [args...]"
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
effort: low
maxTurns: 15
disallowedTools:
  - Edit
  - Write
  - NotebookEdit
---

# OPS ► PACKAGE — MyParcel.nl

## Runtime Context

Credentials resolve in this order (script handles it — do not inline the key):

1. `$MYPARCEL_API_KEY` env var (plain text — the script base64-encodes it).
2. `preferences.json` key `myparcel_api_key` at `${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json`.
3. Doppler: `doppler secrets get MYPARCEL_API_KEY --plain`.

If none is available, the script exits with a clear error telling the user how to set it.

Docs: https://developer.myparcel.nl/api-reference/

## Route by `$ARGUMENTS`

| First token | Action                            |
| ----------- | --------------------------------- |
| `ship`      | Create a shipment                 |
| `label`     | Download + open label PDF         |
| `track`     | Show status + tracking barcode    |
| `list`      | List last 10 shipments            |
| (empty)     | Show usage + suggest next command |

Delegate the actual API calls to `${CLAUDE_PLUGIN_ROOT}/skills/ops-package/ops-package.sh`. Do not re-implement curl logic inline — pass args through.

---

## ship

Create a shipment. Required: `--to "<address>"`. Address format:

```
"Person / Company, Street 12A, 1011AB Amsterdam, NL"
```

- `/ Company` segment is optional.
- Postcode can be with or without space (normalized to 4-digit+2-letter uppercase).
- Country defaults to NL if missing; common names (Netherlands, Belgium, Germany, France) are mapped to ISO codes.

Flags:
- `--from "<address>"` — override sender. Default: account's configured sender.
- `--weight <grams>` — integer grams (used for carrier rating).
- `--package-type 1|2|3` — 1=parcel (default), 2=mailbox, 3=letter.
- `--signature` — require signature on delivery.
- `--insurance <EUR>` — integer EUR; 0 disables (default). Script converts to cents.
- `--description "<text>"` — label description, max ~45 chars.
- `--pickup` — book home pickup at sender's address (requires `--from` to include address, otherwise MyParcel uses account default).

Run:

```bash
${CLAUDE_PLUGIN_ROOT}/skills/ops-package/ops-package.sh ship \
  --to "$ADDRESS_STRING" \
  [--from "$SENDER_STRING"] \
  [--weight "$WEIGHT_G"] \
  [--package-type "$PKG_TYPE"] \
  [--signature] \
  [--insurance "$INSURANCE_EUR"] \
  [--description "$LABEL_DESC"] \
  [--pickup]
```

On success the script returns:

```json
{"shipment_id": "<id>", "response": { ... raw MyParcel JSON ... }}
```

Summarise to the user as:

```
Shipment created — id <id>
Next: /ops:ops-package label <id>  to download the PDF (or pay if not prepaid).
```

Then offer via `AskUserQuestion` (≤4 options):
- `[Download label now]` — call `ops-package.sh label <id>` immediately
- `[Track it]` — call `ops-package.sh track <id>`
- `[Ship another]`
- `[Done]`

---

## label `<shipment-id>`

```bash
${CLAUDE_PLUGIN_ROOT}/skills/ops-package/ops-package.sh label "$ID"
```

Two possible outcomes:

- **PDF returned** → saved to `/tmp/myparcel_label_<id>.pdf` and opened (macOS `open`). Output: `{"status":"ok","label_pdf":"/tmp/myparcel_label_<id>.pdf"}`.
- **Payment required** → shipment not prepaid. Output: `{"status":"payment_required","payment_url":"https://payv2.multisafepay.com/..."}`. The script opens that URL in the browser on macOS. Tell the user: "Shipment <id> needs payment — MultiSafepay URL opened. After paying, re-run `/ops:ops-package label <id>`."

---

## track `<shipment-id>`

```bash
${CLAUDE_PLUGIN_ROOT}/skills/ops-package/ops-package.sh track "$ID"
```

Returns shipment status + barcode + tracking URL. Render as:

```
Shipment <id>
  Status:    <status>
  Barcode:   <barcode>
  Tracking:  <tracking_url>
  To:        <recipient summary>
  Updated:   <modified timestamp>
```

---

## list

```bash
${CLAUDE_PLUGIN_ROOT}/skills/ops-package/ops-package.sh list
```

Returns an array of the last 10 shipments with id, status, barcode, recipient summary, and created timestamp. Render as a compact table:

```
 ID          STATUS              BARCODE           RECIPIENT                     CREATED
 ─────────────────────────────────────────────────────────────────────────────────────────
 <id>        <status>            <barcode>         <person — city (cc)>          <date>
 ...
```

Then offer via `AskUserQuestion` (≤4 options):
- `[Track a shipment]` — ask for id, then `track`
- `[Download a label]` — ask for id, then `label`
- `[Ship a new parcel]`
- `[Done]`

---

## Error handling

- **No API key** → script exits 2 with instructions. Surface the message verbatim; then ask via `AskUserQuestion`:
  `[Paste key now]`  `[Skip — configure later]`
  If "Paste key now", collect via `AskUserQuestion` free-text and write to `preferences.json`:
  ```bash
  PREFS="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json"
  tmp=$(mktemp)
  jq --arg v "$KEY" '.myparcel_api_key = $v' "$PREFS" > "$tmp" && mv "$tmp" "$PREFS"
  ```
- **4xx from MyParcel** → dump the JSON error and stop. Do not retry silently.
- **Address parser looks wrong** → re-prompt the user with the parsed breakdown and ask for corrections before POSTing.

## Package type reference

| code | type    | notes                                 |
| ---- | ------- | ------------------------------------- |
| 1    | package | default — any parcel                  |
| 2    | mailbox | brievenbuspakje (fits through NL box) |
| 3    | letter  | letter/stamp only                     |

## Carrier

Defaults to PostNL (carrier id `1`), MyParcel's primary NL carrier. Other carrier ids require account configuration — out of scope for this skill.
