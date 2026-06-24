# Multi-Account Claude Max Rotator

Optional component of the `claude-ops` plugin. Rotates between multiple Claude
Max subscriptions as 5-hour and weekly quotas approach the cap, so an active
session can keep working without a manual `/login`.

## What it does

- Watches the active Claude Code session's reported usage (5h window + 7d window).
- When the active account approaches its cap, picks the most cooled-down account from your configured list and swaps the keychain token.
- Falls back to a Playwright-driven browser OAuth flow when refresh tokens have expired.
- Has an optional Claude Haiku "AI brain" that drives the browser past unexpected pages (new Google challenges, workspace re-consent, etc).

## Status: opt-in, advanced

This is **off by default**. It requires:

1. Multiple Claude Max accounts you legitimately own.
2. macOS (uses the system keychain + `launchd` for the background daemon) **or Linux** (see [Linux setup](#linux-setup) below).
3. Node 20+ (already required by the plugin).
4. Optional: Playwright (installed on first browser-fallback use), Dashlane CLI (`dcli`) for credential reads.

## Enable

In Claude Code settings → plugin `ops` → toggle:

- `account_rotation_enabled` → `true`

Then run:

```
/ops:rotate
```

The skill walks you through:

1. Adding your first account (`add-account`).
2. Capturing the current keychain token into the rotator vault (`capture`).
3. Installing the launchd daemon from `templates/com.claude-ops.account-rotation.plist`.
4. Verifying everything with `status`.

## Config

`config.json` lives in the plugin data dir (`~/.claude/plugins/data/ops/account-rotation/config.json`) and is **never committed**. The shape is documented in `config.example.json`.

Each account entry:

| Field                 | Required | Notes                                                                          |
| --------------------- | -------- | ------------------------------------------------------------------------------ |
| `email`               | yes      | Login email for the Claude Max account.                                        |
| `label`               | no       | Disambiguator if you have two configs for the same email (multi-org).          |
| `orgName` / `orgUuid` | no       | Workspace metadata for accounts in a Claude org.                               |
| `dashlaneTokenPath`   | no       | If you store the token in Dashlane: `dl://<vault-name>/password`.              |
| `extraUsageEnabled`   | no       | Set to `true` ONLY if the account has paid overage on. Triggers safety margin. |
| `capacityMultiplier`  | no       | Override per-account threshold (default 1.0 = standard Max 20x quota).         |
| `crsAccountName`      | no       | CRS admin account name this vault entry maps to (for crs-token-feed / crs-priority). |

## CRS pool (optional)

If you run [claude-relay-service](https://github.com/anthropics/claude-relay-service) (CRS) alongside the rotator:

1. Add `crsAccountName` on each account (must match the account `name` in the CRS admin UI), or supply `crs.nameByVaultKey` in `config.json`.
2. Set `crs.enabled`, `crs.baseUrl`, and install the priority daemon: `scripts/install-crs-priority-agent.sh`.
3. On Linux/EC2, `crs-token-feed.mjs` propagates vault tokens into CRS (systemd timer when installed).
4. On macOS clients that reach a **remote** CRS via SSH, install the tunnel (requires `CRS_TUNNEL_SSH_HOST`):

   ```bash
   CRS_TUNNEL_SSH_HOST=your-remote-host bash scripts/install-crs-fra-tunnel.sh
   ```

   Point Claude Code at `http://127.0.0.1:3005/api` (or your `CRS_TUNNEL_LOCAL_PORT`).

See `config.example.json` → `crs` block for all tunables (`policy`, `fileVaultPath`, `containerName`, thresholds).

## Keychain layout

- `Claude Code-credentials` (account = your OS user) — the live token Claude Code reads.
- `Claude-Rotation-<account_id>` (account = your OS user) — vault per configured account.

The `<account_id>` is the email or label, picked when you `add-account`.

Override the keychain account name via `CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT` if you need to (defaults to `$USER`).

## Files

| File                  | Purpose                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| `rotate.mjs`          | Main rotation logic. CLI: `--status`, `--utilization`, `--to`, `--setup`. |
| `daemon.mjs`          | launchd-managed monitor. Polls every 15s, rotates at 80% utilization.     |
| `ai-brain.mjs`        | Claude Haiku fallback for unexpected OAuth pages.                         |
| `force-rotate.sh`     | Out-of-band rotation when Claude Code is unreachable.                     |
| `config.example.json` | Schema reference. Copy to `config.json` and populate.                     |

## Triggers

The daemon rotates when ANY one fires:

1. 5h utilization >= 80%.
2. 7d utilization >= 80%.
3. The plugin's `rate-limit-detector.cjs` hook writes a 429 signal file.
4. A 401 auth-error hook fires.
5. You run `/ops:rotate rotate-now` or `force-rotate.sh`.

## Disable

```
launchctl unload ~/Library/LaunchAgents/com.claude-ops.account-rotation.plist
```

And toggle `account_rotation_enabled` off in plugin settings.

## Account selection — private-first (v2.11.4)

When multiple accounts are eligible to rotate into, `rotate.mjs` prefers
**personal/private** accounts over **TEAMS/org** accounts (those with `orgName`
or `orgUuid` set). Org accounts hit claude.ai's organisation chooser page and
may trigger Google Workspace push-2FA that headless browser auth cannot clear,
causing the rotation to stall.

Rule: an account is treated as an org account if it has a non-empty `orgName`
**or** `orgUuid`. Personal accounts are selected first; org accounts are used
only when no personal account has sufficient remaining quota.

To opt an account out of this preference (e.g. an org account you know works
headlessly), add `"preferEvenIfOrg": true` to its config entry.

## Linux setup (v2.11.5)

The browser-auth fallback now works headlessly on aarch64/x86-64 Linux. Extra
requirements beyond the base list above:

1. **Brave browser** — acts as the Tier-2 real-Chromium fallback (no ARM Chrome
   builds exist). Install via your distro's package manager or
   `brave.com/linux/`:

   ```bash
   # Debian/Ubuntu
   sudo apt-get install -y brave-browser
   # Fedora/RHEL
   sudo dnf install -y brave-browser
   ```

2. **Xvnc / virtual display** — the auth flow requires a real display
   (`DISPLAY` must be set). Start a virtual framebuffer before running the
   rotator daemon:

   ```bash
   Xvnc :1 -geometry 1280x800 -depth 24 &
   export DISPLAY=:1
   ```

   The 1280×800 viewport is required — narrower viewports (e.g. 1×1) break
   claude.ai's layout and stall the login flow.

3. **Per-account `gog` service accounts** — magic-link auth reads each
   account's own inbox using `gog --account <email>`. Add a service account
   for every rotation email:

   ```bash
   gog auth add you@example.com --services gmail
   ```

   No Gmail-forwarding setup is needed; `gog` reads each inbox directly.

4. **Magic-link only** — on Linux the rotator uses magic-link login exclusively
   (no Google OAuth). This avoids Google Workspace push-2FA which cannot be
   cleared in a headless session. Accounts that require Google OAuth and cannot
   receive a Claude magic-link email are not supported on Linux.

## Safety notes

- Passwords NEVER leave your machine. The AI brain only sees a screenshot + DOM summary; password fields are masked.
- The daemon never touches accounts marked `disabled: true` in `config.json`.
- Accounts with `extraUsageEnabled: true` rotate at 75% (not 80%) to avoid paid overage.
- A 3-minute post-rotation blackout suppresses thrashing.
