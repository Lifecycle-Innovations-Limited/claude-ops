---
name: ops-credentials
description: Audit which integration credentials are configured. Scans shell env, ops preferences.json, Doppler, macOS Keychain, and Dashlane to report a configured-vs-missing table per service. Never displays raw values — always masks as first6•••last4. Use when you want to see which integrations have keys set up and which still need /ops:setup.
argument-hint: "[--service <name>] [--json]"
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
effort: low
maxTurns: 5
---

# OPS ► CREDENTIALS

## CLI/API Reference

| Command | Output |
|---------|--------|
| `bin/ops-credentials` | Human table — configured + missing per service |
| `bin/ops-credentials --json` | JSON array, one entry per credential |
| `bin/ops-credentials --service stripe` | Filter to one integration |

The bin script is the source of truth. It scans these sources in order and reports the FIRST hit per credential:

1. Shell env (`$STRIPE_SECRET_KEY`, etc.)
2. `$OPS_DATA_DIR/preferences.json` (`.revenue.stripe.secret_key`, etc., including `doppler:KEY` references that get resolved live)
3. macOS Keychain (`security find-generic-password -s <name> -w`)
4. Dashlane (`dcli password <keyword> --output json`)

Values shorter than 12 chars print as `•••`; longer values print as `first6•••last4`.

## Your task

When the user runs `/ops:credentials`:

1. **Run** `bin/ops-credentials` and present the output verbatim — it's already formatted for the user's terminal (compact mode for SSH/mobile, table layout otherwise).

2. **Offer follow-ups via AskUserQuestion (max 4 options per Rule 1):**

```
What would you like to do next?
  [Configure a missing service — pick one to set up now]
  [Re-audit a specific service]
  [Export to JSON]
  [Done]
```

3. **On "Configure missing"**: list missing services 4-at-a-time via `AskUserQuestion`. For each pick, call the `/ops:setup <service>` skill.

4. **On "Re-audit specific"**: ask for the service name and run `bin/ops-credentials --service <name>`.

5. **On "Export to JSON"**: run `bin/ops-credentials --json` and write the result to `/tmp/ops-credentials-audit-$(date +%s).json`. Print the path.

## Why this skill exists

Claude Code's plugin settings UI cannot introspect external credential stores. If a user has `STRIPE_SECRET_KEY` in macOS Keychain or `klaviyo_api_key` in Doppler, the settings panel shows those fields as empty (because the value isn't stored in Claude Code's user-config). The user can't tell at a glance which integrations they've already wired up.

`/ops:credentials` solves that — one command, one table, complete picture of which integrations are ready to use vs which still need `/ops:setup`.

## Privacy guarantees

- **Never prints raw values.** All output is masked.
- **Never copies values to disk.** Reads happen in-process; the JSON export contains only `{service, label, configured, masked, source}`, never the raw secret.
- **Read-only.** Does not write to keychain, Doppler, or preferences.

## Mobile / SSH (Rule 7)

When `$SSH_CONNECTION` / `$SSH_CLIENT` / `$SSH_TTY` is set or `$OPS_MOBILE=1`, the bin script auto-switches to compact one-line-per-cred format. Skill output should pass it through unchanged.
