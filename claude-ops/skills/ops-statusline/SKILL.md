---
name: ops-statusline
description: Statusline command center — preview, configure, switch themes, validate, and reset the Claude Code cockpit statusline. Subcommands: preview, config, theme, doctor, reset.
argument-hint: "[preview|config|theme <name>|doctor|reset]"
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

Before any subcommand, resolve paths:

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(ls -d "$HOME/.claude/plugins/cache/ops-marketplace/ops"/*/ 2>/dev/null | sort -V | tail -1)}"
STATUSLINE_CMD="$HOME/.claude/statusline-command.sh"
STATUSLINE_CFG="$HOME/.claude/statusline.config.json"
THEMES_FILE="${PLUGIN_ROOT}templates/statusline/themes.json"
SETTINGS_FILE="$HOME/.claude/settings.json"
SUGGEST_BIN="${PLUGIN_ROOT}bin/ops-statusline-suggest"
```

---

# OPS ► STATUSLINE

Manages the Claude Code cockpit statusline — a 3-line terminal status bar showing
context-window health, quota gauges, burn rate, git branch, fleet state, sys metrics,
and per-project ops badges.

Parse `$ARGUMENTS` and route:

| Argument (first word) | Action                                                   |
| --------------------- | -------------------------------------------------------- |
| `preview` or empty    | Render a sample output at current terminal width         |
| `config`              | Re-run the wizard: preset, theme, projects, gauge widths |
| `theme <name>`        | Switch theme in config                                   |
| `doctor`              | Validate config, settings.json wiring, renderer path     |
| `reset`               | Restore default config from template                     |
| (anything else)       | Show help + current status                               |

---

## Subcommand: preview

Render the statusline using the current config against a built-in sample payload.
Never touches real config or settings files.

### Step 1 — Build sample payload

```bash
COLS="${COLUMNS:-$(tput cols 2>/dev/null || echo 120)}"
SAMPLE_PAYLOAD=$(cat <<'JSON'
{
  "workspace": { "current_dir": "/home/user/Projects/my-app" },
  "model": { "display_name": "Claude Sonnet 4.6" },
  "rate_limits": {
    "five_hour":  { "used_percentage": 42, "resets_at": 0 },
    "seven_day":  { "used_percentage": 18, "resets_at": 0 }
  },
  "context_window": { "used_percentage": 31 },
  "cost": { "total_cost_usd": 0.14, "total_lines_added": 120, "total_lines_removed": 40 },
  "session_id": "preview-sample",
  "transcript_path": ""
}
JSON
)
```

### Step 2 — Run renderer

```bash
COLUMNS="$COLS" printf '%s' "$SAMPLE_PAYLOAD" | "$STATUSLINE_CMD" 2>/dev/null
```

If `$STATUSLINE_CMD` is not executable, fall back to the template:

```bash
COLUMNS="$COLS" printf '%s' "$SAMPLE_PAYLOAD" | sh "${PLUGIN_ROOT}templates/statusline/statusline-command.sh" 2>/dev/null
```

Print the rendered output between ruler lines so the user sees the actual width context:

```
──────────────────────────────────────── (preview at 120 cols)
<rendered lines>
────────────────────────────────────────
```

If rendering fails (exit non-zero), print:

```
○ Preview failed — renderer returned non-zero.
  Check: /ops:statusline doctor
```

---

## Subcommand: config

Re-run the wizard — preset, theme, projects, and gauge widths. Calls the suggest
engine to seed a recommended config, then lets the user confirm or adjust each section.
Writing to `~/.claude/statusline.config.json` (never touches the real settings.json
statusLine wiring — that is only changed by /ops:setup).

### Step 1 — Run suggest engine

```bash
SUGGESTED=$("$SUGGEST_BIN" 2>/tmp/ops-statusline-suggest.log)
```

Parse the `_detected` block to present context to the user:

```bash
PROJ_COUNT=$(printf '%s' "$SUGGESTED" | jq -r '._detected.projects_found // 0')
INTEGRATIONS=$(printf '%s' "$SUGGESTED" | jq -r '._detected.integrations | to_entries | map(select(.value)) | map(.key) | join(", ") // "none"')
```

Print detection summary:

```
Detected N projects · integrations: <list>
```

### Step 2 — Preset selection

Use `AskUserQuestion` (max 4 options per CLAUDE.md Rule 1):

```
Which preset?
  [cockpit — full color, all widgets (Recommended)]
  [minimal — essentials only, low noise]
  [full — all metrics, widest gauges]
  [Keep current preset]
```

Re-run suggest with chosen preset:

```bash
SUGGESTED=$("$SUGGEST_BIN" --preset "$CHOSEN_PRESET" 2>/dev/null)
```

### Step 3 — Theme selection

Use `AskUserQuestion`:

```
Which theme?
  [cockpit — rich color, graded gauges (Default)]
  [minimal — two shades, no color grading]
  [nord — cool blues]
  [mono — bold only, no color]
```

Patch the suggested config with chosen theme:

```bash
SUGGESTED=$(printf '%s' "$SUGGESTED" | jq --arg t "$CHOSEN_THEME" '.theme = $t')
```

### Step 4 — Write config

```bash
TMP=$(mktemp)
printf '%s\n' "$SUGGESTED" | jq 'del(._comment, ._detected)
  | . + {"_comment": "Configured by /ops:statusline config on '"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'."}' > "$TMP"
mv "$TMP" "$STATUSLINE_CFG"
```

Validate the written JSON:

```bash
jq . "$STATUSLINE_CFG" >/dev/null 2>&1 && echo "✓ Config written to $STATUSLINE_CFG" || echo "✗ JSON validation failed"
```

### Step 5 — Offer preview

Use `AskUserQuestion`:

```
Config saved. Preview now?
  [Yes — show preview]  [No — done]
```

On Yes, run the preview subcommand inline.

---

## Subcommand: theme

Switch the theme key in the existing config without touching other settings.

```bash
NEW_THEME="${ARGUMENTS#theme }"
NEW_THEME=$(printf '%s' "$NEW_THEME" | tr -d '[:space:]')
```

Validate theme exists in themes.json:

```bash
VALID=$(jq -e --arg t "$NEW_THEME" '.[$t] // empty' "$THEMES_FILE" 2>/dev/null)
```

If invalid, list available themes and error:

```bash
AVAILABLE=$(jq -r 'keys | join(", ")' "$THEMES_FILE" 2>/dev/null)
echo "Unknown theme '$NEW_THEME'. Available: $AVAILABLE"
exit 1
```

If valid, merge into existing config:

```bash
TMP=$(mktemp)
if [ -f "$STATUSLINE_CFG" ]; then
  jq --arg t "$NEW_THEME" '.theme = $t' "$STATUSLINE_CFG" > "$TMP"
else
  jq -n --arg t "$NEW_THEME" '{"theme": $t}' > "$TMP"
fi
mv "$TMP" "$STATUSLINE_CFG"
echo "✓ Theme set to '$NEW_THEME'"
```

Run a quick preview automatically after switching.

---

## Subcommand: doctor

Validate that all statusline components are healthy. Check and report:

### Check 1 — Renderer exists and is executable

```bash
if [ -x "$STATUSLINE_CMD" ]; then
  echo "✓ Renderer: $STATUSLINE_CMD"
else
  echo "✗ Renderer not found at $STATUSLINE_CMD"
  echo "  Fix: /ops:setup → Statusline section, or run:"
  echo "  cp '${PLUGIN_ROOT}templates/statusline/statusline-command.sh' '$STATUSLINE_CMD' && chmod +x '$STATUSLINE_CMD'"
fi
```

### Check 2 — settings.json statusLine wiring

```bash
if [ -f "$SETTINGS_FILE" ]; then
  SL_CMD=$(jq -r '.statusLine.command // empty' "$SETTINGS_FILE" 2>/dev/null)
  if [ -n "$SL_CMD" ]; then
    echo "✓ settings.json statusLine.command: $SL_CMD"
    # Verify it points at an executable
    eval SL_EXPANDED="$SL_CMD"
    [ -x "$SL_EXPANDED" ] || echo "  ⚠ command path is not executable — may need /ops:setup statusline"
  else
    echo "○ settings.json has no statusLine.command — statusline not wired"
    echo "  Fix: /ops:setup → Statusline section"
  fi
else
  echo "○ ~/.claude/settings.json not found — statusline not wired"
fi
```

### Check 3 — Config JSON validity

```bash
if [ -f "$STATUSLINE_CFG" ]; then
  if jq . "$STATUSLINE_CFG" >/dev/null 2>&1; then
    THEME=$(jq -r '.theme // "cockpit"' "$STATUSLINE_CFG")
    PROJ_COUNT=$(jq -r '(.projects // []) | length' "$STATUSLINE_CFG")
    echo "✓ Config: $STATUSLINE_CFG (theme=$THEME, projects=$PROJ_COUNT)"
  else
    echo "✗ Config JSON invalid: $STATUSLINE_CFG"
    echo "  Fix: /ops:statusline reset"
  fi
else
  echo "○ No config at $STATUSLINE_CFG — using built-in defaults"
fi
```

### Check 4 — Themes file present

```bash
if [ -f "$THEMES_FILE" ]; then
  THEMES=$(jq -r 'keys | join(", ")' "$THEMES_FILE" 2>/dev/null)
  echo "✓ Themes: $THEMES"
else
  echo "⚠ themes.json missing at $THEMES_FILE — theme switching may fail"
fi
```

### Check 5 — Quick render smoke test

```bash
PAYLOAD='{"model":{"display_name":"Test"},"rate_limits":{},"context_window":{},"cost":{}}'
RESULT=$(printf '%s' "$PAYLOAD" | COLUMNS=80 "$STATUSLINE_CMD" 2>/dev/null)
if [ -n "$RESULT" ]; then
  echo "✓ Render smoke test: PASS ($(printf '%s' "$RESULT" | wc -l | tr -d ' ') lines)"
else
  echo "✗ Render smoke test: FAIL — no output"
fi
```

Print final verdict: **OK** (all checks pass) or **Issues found** (with remediation steps).

---

## Subcommand: reset

Restore `~/.claude/statusline.config.json` from the default template.

Use `AskUserQuestion`:

```
Reset statusline config to defaults?
  [Yes — overwrite ~/.claude/statusline.config.json]  [Cancel]
```

On Yes:

```bash
cp "${PLUGIN_ROOT}templates/statusline/statusline.config.default.json" "$STATUSLINE_CFG"
echo "✓ Config reset to defaults"
```

Then run preview.

---

## CLI/API Reference

| Command                                              | Effect                  |
| ---------------------------------------------------- | ----------------------- |
| `/ops:statusline preview`                            | Render sample output    |
| `/ops:statusline config`                             | Re-run wizard           |
| `/ops:statusline theme cockpit\|minimal\|mono\|nord` | Switch theme            |
| `/ops:statusline doctor`                             | Validate all components |
| `/ops:statusline reset`                              | Restore default config  |

### Key files

| File                                                                | Purpose                                |
| ------------------------------------------------------------------- | -------------------------------------- |
| `~/.claude/statusline-command.sh`                                   | The renderer script                    |
| `~/.claude/statusline.config.json`                                  | User config (theme, widgets, projects) |
| `~/.claude/settings.json`                                           | Contains `.statusLine.command` wiring  |
| `${PLUGIN_ROOT}templates/statusline/statusline-command.sh`          | Canonical renderer template            |
| `${PLUGIN_ROOT}templates/statusline/themes.json`                    | Available themes                       |
| `${PLUGIN_ROOT}templates/statusline/statusline.config.default.json` | Default config                         |
| `${PLUGIN_ROOT}bin/ops-statusline-suggest`                          | Registry-driven config generator       |
