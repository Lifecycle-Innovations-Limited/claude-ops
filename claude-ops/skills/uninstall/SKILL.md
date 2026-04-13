---
name: uninstall
description: Completely remove claude-ops plugin, all stored credentials, cached files, shell exports, and MCP registrations. Confirms each step before deletion.
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
effort: low
maxTurns: 15
---

# OPS > UNINSTALL

You are running a **complete uninstall** of the claude-ops plugin. This removes everything the plugin and `/ops:setup` created. Every deletion step requires user confirmation via `AskUserQuestion` — never delete silently.

---

## Step 1 — Confirm intent

Use `AskUserQuestion`:

```
This will completely remove claude-ops and all its data:
  - Plugin installation and marketplace registration
  - Stored preferences and project registry
  - Cached plugin files
  - Keychain credentials (Telegram, Slack tokens)
  - Shell profile exports (CLAUDE_PLUGIN_ROOT)
  - MCP server registrations (Telegram, Slack)

  [Uninstall everything]  [Cancel]
```

If cancelled, stop immediately.

---

## Step 2 — Detect what exists

Scan for all claude-ops artifacts. Build a list of what's present:

```bash
# Preferences
PREFS_DIR="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
ls -la "$PREFS_DIR" 2>/dev/null

# Cache
CACHE_DIR="$HOME/.claude/plugins/cache/ops-marketplace"
ls -la "$CACHE_DIR" 2>/dev/null

# Keychain entries (macOS)
for key in telegram-api-id telegram-api-hash telegram-phone telegram-session slack-xoxc slack-xoxd; do
  security find-generic-password -s "$key" 2>/dev/null && echo "FOUND: $key"
done

# Shell profile exports
grep -l 'CLAUDE_PLUGIN_ROOT' ~/.zshrc ~/.bashrc ~/.zprofile ~/.bash_profile 2>/dev/null

# MCP registrations
grep -l 'telegram\|slack-mcp' ~/.claude.json 2>/dev/null
```

Print a summary of what was found, then proceed to delete each category.

---

## Step 3 — Remove keychain credentials

For each found keychain entry, ask via `AskUserQuestion`:

```
Remove keychain credential: <key-name>?
  [Yes]  [Skip]
```

On Yes:

```bash
security delete-generic-password -s "<key-name>" 2>/dev/null
```

---

## Step 4 — Remove preferences and cache

Ask via `AskUserQuestion`:

```
Remove plugin data?
  - Preferences: <prefs-dir>
  - Cache: <cache-dir>

  [Yes, delete both]  [Skip]
```

On Yes:

```bash
rm -rf "$PREFS_DIR"
rm -rf "$CACHE_DIR"
```

---

## Step 5 — Clean shell profile

For each shell profile file that contains `CLAUDE_PLUGIN_ROOT`:

Ask via `AskUserQuestion`:

```
Remove CLAUDE_PLUGIN_ROOT export from <file>?
  [Yes]  [Skip]
```

On Yes, read the file and remove lines containing `CLAUDE_PLUGIN_ROOT`. Use `sed` or similar — do NOT rewrite the entire file. Only remove the specific export line.

```bash
sed -i '' '/CLAUDE_PLUGIN_ROOT/d' "<file>"
```

---

## Step 6 — Remove MCP registrations

Check if `~/.claude.json` contains MCP server entries added by the plugin (telegram, slack-mcp). For each:

Ask via `AskUserQuestion`:

```
Remove MCP server registration: <server-name> from ~/.claude.json?
  [Yes]  [Skip]
```

On Yes, use `jq` to remove the entry:

```bash
jq 'del(.mcpServers["<server-name>"])' ~/.claude.json > /tmp/claude-json-tmp && mv /tmp/claude-json-tmp ~/.claude.json
```

---

## Step 7 — Uninstall plugin and marketplace

Run the Claude Code uninstall commands:

```bash
claude plugin uninstall ops@lifecycle-innovations-limited-claude-ops 2>/dev/null || true
claude plugin marketplace remove lifecycle-innovations-limited-claude-ops 2>/dev/null || true
```

If these commands fail (e.g. not in an interactive Claude Code session), print:

```
Run these manually in Claude Code:
  /plugin uninstall ops@lifecycle-innovations-limited-claude-ops
  /plugin marketplace remove lifecycle-innovations-limited-claude-ops
```

---

## Step 8 — Final confirmation

Print:

```
claude-ops has been completely removed.

  Keychain:    <N> credentials deleted
  Preferences: deleted
  Cache:       deleted
  Shell:       <N> exports removed
  MCP:         <N> servers removed
  Plugin:      uninstalled

To reinstall later:
  /plugin marketplace add Lifecycle-Innovations-Limited/claude-ops
  /plugin install ops@lifecycle-innovations-limited-claude-ops
  /ops:setup
```
