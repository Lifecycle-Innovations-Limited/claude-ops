# OPS ► SETUP — Reference

Operational reference material for the setup wizard. Load this file when you need daemon health checks, invocation-shortcut routing, or safety rules.

---

## Daemon Health Contract

All ops skills should check daemon health before relying on background services:

```bash
cat ~/.claude/plugins/data/ops-ops-marketplace/daemon-health.json
```

If `action_needed` is not null, surface the required action to the user before proceeding.
If the daemon is not running, offer to start it: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-ops.daemon.plist`

---

## Invocation shortcuts

If `$ARGUMENTS` contains a specific section name, jump straight to that section:

| Argument                               | Go to   |
| -------------------------------------- | ------- |
| `cli`, `install`                       | Step 2  |
| `channels`                             | Step 3  |
| `telegram`                             | Step 3a |
| `whatsapp`, `whatsapp-bridge`, `whatsapp-doctor` | Step 3b |
| `email`                                | Step 3c |
| `slack`                                | Step 3d |
| `notion`                               | Step 3e |
| `calendar`, `cal`                      | Step 3f |
| `doppler`, `secrets`                   | Step 3g |
| `vault`, `password-manager`, `pm`      | Step 3h |
| `ecom`, `shopify`, `store`             | Step 3i |
| `marketing`, `klaviyo`, `ads`, `meta`, `ga4` | Step 3j |
| `google-ads`, `gads` | Step 3j (Google Ads) |
| `voice`, `bland`, `elevenlabs`, `tts`  | Step 3k |
| `network`, `unifi`                     | Step 3q-network |
| `mcp`                                  | Step 4  |
| `registry`, `projects`                 | Step 5  |
| `daemon`, `background`                 | Step 5b |
| `prefs`, `preferences`                 | Step 6  |
| `env`, `shell`                         | Step 7  |
| `deploy-fix`, `auto-fix`               | Step 6.5|

Empty argument → full wizard from Step 0.

---

## Safety

- **Never** run `brew install` or write files without an explicit `AskUserQuestion` confirmation.
- **Never** overwrite an existing file without showing the diff and asking.
- **Never** put secrets in `registry.json` or commit them. Secrets only go in `$PREFS_PATH` (outside the plugin source tree entirely — Claude Code's per-plugin data dir) or the user's shell profile.
- **Never** touch `~/.claude.json` or `~/.claude/settings.json` — MCP registration is Claude Code's job, not yours.
- **Never** show the user's real name or email in output unless they explicitly provided it in the current session. Do not read from memory files, existing preferences, or environment variables to populate display names.

---
