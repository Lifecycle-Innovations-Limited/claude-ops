# statusline — Claude Code cockpit statusline

A config-driven, 3-line terminal statusline for Claude Code that shows context-window
health, quota burn rate, account rotation state, and per-project ops metrics — all
rendered in under 50ms with no blocking external calls.

## Install

Copy the script and wire it into `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "command": "$HOME/.claude/statusline-command.sh"
  }
}
```

Then copy `statusline-command.sh` to `~/.claude/statusline-command.sh` and make it
executable:

```sh
cp templates/statusline/statusline-command.sh ~/.claude/statusline-command.sh
chmod +x ~/.claude/statusline-command.sh
```

Optionally copy the default config and customise it:

```sh
cp templates/statusline/statusline.config.default.json ~/.claude/statusline.config.json
```

## Config file

Resolved in this order (first match wins):

1. `$CLAUDE_STATUSLINE_CONFIG`
2. `~/.claude/statusline.config.json`
3. Built-in defaults (zero-config works out of the box)

### Schema

```jsonc
{
  // Named theme from themes.json. Built-in: "cockpit" | "minimal" | "mono" | "nord"
  "theme": "cockpit",

  // Gauge bar widths (number of fill characters)
  "gauge_width": {
    "ctx":   10,   // context-window gauge
    "quota":  8    // 5h / 7d quota gauges
  },

  // How often the carousel slot and line-3 project cycle (seconds, epoch-based)
  "carousel_interval_sec": 15,

  // Widget visibility toggles — omit a key to keep the default (all on)
  "widgets": {
    "line1": ["ctx_gauge", "quota_gauge", "pace_badge", "cache_badge", "plan_badge", "account_arrow"],
    "line2": ["location", "model", "git_branch", "tasks", "fleet", "sys_metrics", "carousel"],
    "line3": ["project_rotate"]
  },

  // Fleet badges (bg agents, rotation pool, SDK fallback, cache TTL countdown)
  "fleet": {
    "show_bg_agents":    true,
    "show_rotation":     true,
    "show_sdk_fallback": true,
    "show_cache_ttl":    true
  },

  // System metrics on line 2
  "sys_metrics": {
    "show_cpu":           true,
    "show_ram":           true,
    "show_disk":          true,
    "show_load_warning":  true,
    "show_disk_warning":  true,
    // Peer metrics sync (multi-machine: Mac + EC2)
    "publish_peer":       true,  // write ~/.claude/.sysinfo/<hostname>.json on each render (throttled to 10s)
    "show_peer":          true   // read sibling *.json files and show compact peer badge on line 2
  },

  // What to include in the rotating carousel slot on line 2
  "carousel_pool": ["cost", "lines", "global_ops"],

  // Per-project badge groups for line 3 (empty = line 3 falls back to carousel)
  "projects": [
    {
      "key":    "myapp",       // internal identifier
      "label":  "MyApp",       // display label
      "match":  "myapp",       // substring matched against cwd (lowercase)
      "badges": ["ecs", "orders"]  // which metric badge types to show
      // Badge data is read from:
      //   ~/.claude/plugins/data/ops-ops-marketplace/cache/project-<key>.json
      // Write that file from your own daemon or /ops:ops-go precompute step.
    }
  ]
}
```

### Project badge file format

The renderer reads `$ops_dir/project-<key>.json` (precomputed by your ops daemon):

```json
{
  "label": "MyApp",
  "badges": [
    { "icon": "◉", "value": "3/3", "color": "ok" },
    { "icon": "🛒", "value": "12·€340", "color": "ok" }
  ]
}
```

`color` is one of `"ok"`, `"warn"`, `"danger"`, `"dim"`.

## Themes

Themes live in `themes.json` alongside this script. Available built-in themes:

| Theme     | Description                                      |
|-----------|--------------------------------------------------|
| `cockpit` | Default — rich color, graded gauges              |
| `minimal` | Two shades only — no color grading               |
| `mono`    | Monochrome — bold for emphasis, no color at all  |
| `nord`    | Nord palette — cool blues and muted tones        |

To add a custom theme, add a key to `themes.json` with the same semantic role fields
and set `"theme": "<your-key>"` in your config.

## Line layout

```
Line 1 (instruments):
  ctx ████████░░ 82%  │  5h ██████░░ 74%  │  7d ████░░░░ 45%  │  ▸ 0.3%/m  │  ✦2m  │  ● Max  │  acct→next

Line 2 (session + system + fleet + carousel):
  ⚑ FRA  │  Opus 4.8  │  ⎇feature/x  │  ⟳2(1/3)  │  🤖 0  │  🔄acct⚡1  │  cpu12% ram4G df80G  │  <carousel>

Line 3 (per-project, rotates every 15s):
  MyApp ◉ 3/3  │  🛒 12·€340
```

## Width handling

Every line is packed greedily left-to-right with ` │ ` dividers. Segments that
don't fit are silently dropped — nothing is ever truncated mid-segment. On narrow
terminals (`$COLUMNS < 80`) line 2 collapses to a single rotating metric.

## Peer system-metrics sync

When `sys_metrics.publish_peer` is `true` (default), each render writes this
machine's CPU, RAM, load, and disk metrics to:

```
~/.claude/.sysinfo/<short-hostname>.json
```

The write is async and throttled — the file is only rewritten when it is older
than 10 seconds, so the render path is never blocked.

When `sys_metrics.show_peer` is `true` (default), the renderer reads any
**other** `*.json` files in that directory (i.e. the peer machine) and shows a
compact badge on line 2:

```
ams cpu8% ram12G df88G         # fresh — color-graded (red if load>8 or ram<2G)
ams stale                      # greyed when peer file is older than 5 minutes
```

**Cross-machine transport** reuses the existing `~/.claude/` rsync / Tailscale
sync (`com.sam.gbrain-fra-push` or equivalent). No new transport is built — the
sync daemon copies `~/.claude/.sysinfo/` along with the rest of `~/.claude/`.
Each machine publishes its own file; the peer's file arrives via rsync.

## Performance

All external calls (`claude auth status`, `git`, `claude agents`) are async:
the render reads a cache file written by a locked background job on the previous
frame. Warm render target is under 50ms. No synchronous network or subprocess
calls on the hot path.
