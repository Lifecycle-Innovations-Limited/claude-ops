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

| Field                         | Required | Notes                                                                                                                   |
| ----------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `email`                       | yes      | Login email for the Claude Max account.                                                                                 |
| `label`                       | no       | Disambiguator if you have two configs for the same email (multi-org).                                                   |
| `orgName` / `orgUuid`         | **yes**  | Exact account organization identity; required for every account, including personal accounts.                           |
| `automatedCredentialMutation` | no       | Reserved; currently fail-closed even when `true`. Identity verification or configuration never grants write permission. |
| `dashlaneTokenPath`           | no       | If you store the token in Dashlane: `dl://<vault-name>/password`.                                                       |
| `extraUsageEnabled`           | no       | Set to `true` ONLY if the account has paid overage on. Triggers safety margin.                                          |
| `capacityMultiplier`          | no       | Override per-account threshold (default 1.0 = standard Max 20x quota).                                                  |
| `crsAccountName`              | no       | Legacy compatibility field for the cliproxy/CLIProxyAPI account name this vault entry maps to (for `crs-token-feed` / `crs-priority` compatibility). |

## Signed staged Claude enrollment

Direct browser and magic-link reauthentication entrypoints are fail-closed. New
CLIProxyAPI Claude credentials must be captured outside this plugin, then passed
to `staged-enrollment.mjs`: first with a short-lived signed `stage` approval for
the exact candidate SHA-256 and `additive-publish` action, then with a distinct
signed `activate` approval for the exact `canonical-switch` action.
The manifest explicitly binds one ID and auth filename to provider, normalized
email, organization UUID/name, and owner. Approval keys and usage, staging, and
rollback directories must be owner-only. The CLI intentionally cannot sign
approvals and prints only redacted receipt metadata.

All direct OAuth writers are denied, including absent/unconfigured accounts,
Claude Code, manual setup, magic-link, and CLIProxy. Automatic token refresh,
save-back, active-slot updates, and destructive 401 cleanup are disabled;
`automatedCredentialMutation` alone cannot authorize them. Denied runs do not
launch authentication subprocesses or change credential storage. A 401 retains credential bytes and reports
`needsReauth`/status for a separately approved staged enrollment. A successful
exact identity check proves which credential was observed; it is not write
authorization.

Legacy browser-pin apply, publication, and restore are disabled. A portable
filesystem compare-and-swap cannot prove that a nonparticipating writer did not
replace the destination between validation and rename. Existing recovery
evidence is retained for operator inspection; this code never uses it to
overwrite or delete credential state.

Runtime invocation accepts exactly `--config`, `--entry`, `--approval`, and, for
stage only, `--candidate`. Activate additionally requires explicit absolute
owner-only `--inventory` and `--canary` JSON paths; there are no default evidence
paths. The owner-only deployment config pins every trust
root, the canonical operation lock, environment/operator, and a finite approval
TTL no greater than 15 minutes. Inventory and canary use strict JSON and exact
schemas. The signed switch approval binds their immutable raw SHA-256 digests,
the manifest and candidate digests, exact credential ID and complete provider,
email, organization UUID/name, owner and destination identity, the prior target
digest (or explicit absence), expiry, and nonce. Canary evidence must select the
exact candidate and report both `noFallback: true` and `pass: true`; malformed,
incomplete, stale, fallback, or mismatched evidence fails closed.

`stage` validates without changing active auth, manifest, quarantine, cooldowns,
services, or replicas. `activate` compare-and-swaps the manifest digest, replaces
only the approved auth filename, and restores its backup if verification fails.
The old credential/config backup remains until rollback verification and the
existing bounded cleanup completes. This tool has no invalidate, revoke, or
delete operation and performs none implicitly. Any later invalidation requires
a separate fresh signed permission handled by a different authorized tool; a
stage or switch approval never authorizes it.

Activation uses an authenticated phase journal beside the operation lock. The
journal binds the original signed exact-switch payload and raw evidence digests,
so recovery proves the same authorization rather than reinterpreting current
state. After
an interrupted activation, run `staged-enrollment.mjs recover --config <path>`;
other writers refuse while that journal is pending. A stale lock is reclaimed
only when its HMAC is valid, it names this host, and its PID is demonstrably
dead. Malformed and cross-host locks require operator investigation.

Enabled first-party credential writers must set
`CLAUDE_AUTH_COORDINATION_CONFIG` to this deployment config and
`CLAUDE_ROTATOR_CONFIG` to the reviewed runtime inventory installed by the same
plan. They share one lock and one exact account identity source.
CLIProxyAPI, remote sync, and other external writers cannot participate in the
local lock and must remain operationally quiesced/fenced during activation.
Successful switch or recovery converts the temporary backup into a retained,
authenticated rollback record. A separate fresh signed `canonical-rollback`
approval is required to restore it; approval use markers remain durable
authenticated replay evidence.

### Coordination rollout and migration

Provisioning is offline and never reads or writes credentials. First update the
authoritative rotator inventory so all nine Claude accounts have exact `email`,
`orgUuid`, and `orgName`; legacy inventories missing either organization field
are refused before any file is written. Supply the reviewed intended 15-entry
manifest separately with `--manifest-source`; plan requires its nine Claude
identities to exactly equal the inventory and digest-binds its raw bytes. Run
`provision-coordination.mjs plan` with explicit absolute manifest target,
active, staging, usage, rollback, quarantine, lock, trust, config, Linux/macOS
environment, `--runtime-inventory` target, `--runtime-home` for the service
account home embedded in reviewed launch artifacts, an owner-only
`--consumer-inventory-source` reviewed JSON file plus
`--authoritative-consumer-inventory` target outside mutable credential roots,
and rendered service paths. The consumer file has exact schema
`{"version":1,"consumers":[{"id","type","path","credentialId","destination"}]}`;
IDs and normalized absolute paths are unique and every credential/destination
pair must match the reviewed manifest. Review
and save its secret-free JSON output, then run `apply --plan <file>
--expected-digest <digest>`.

Apply refuses a changed plan, manifest, inventory binding, or mismatched
existing trust/config file. An absent-trust bootstrap plan is strictly one-shot:
after success, or after any observable journal/progress (including SIGKILL), it
returns `BOOTSTRAP_TRUST_REVIEW_REQUIRED` or
`BOOTSTRAP_JOURNAL_REVIEW_REQUIRED`; a retained owner-only bootstrap-attempt
marker also blocks repeated apply, rollback, and activation with the reviewed
absence. Inspect the
retained preparation, detached evidence, and journal records; establish or
verify the owner-only trust root; then generate and review a **new present-trust
plan**. That plan pins the trust descriptor/digest and any exact recovery journal
state/topology and stale provision-lock descriptor and is the only plan permitted
to finish, validate, or roll back the
bounded interrupted transaction. `TRUST_SNAPSHOT_CHANGED`,
`INVALID_PROVISION_JOURNAL`, `INVALID_PROVISION_RECEIPT`, and
`PROVISION_RECOVERY_UNCERTAIN` require stopping writers, preserving all evidence,
and generating another reviewed plan only after the descriptor discrepancy has
been investigated. Never substitute a bootstrap key plus receipt: absent trust
and receipts do not authenticate one another.

Publication uses fsynced owner-only preparation files and no-replace hard links.
Canonical names are detached atomically to uniquely named evidence before their
descriptor is checked; the implementation does not claim conditional
unlink-by-path and has no privileged broker. Exact digest-derived preparation
aliases and detached tombstones are retained, are not auto-garbage-collected,
and increase disk/inode usage. Readers permit only the explicitly bounded link
topology and reject unrelated hardlinks. Operators must inventory and archive or
remove evidence only through a separate reviewed maintenance procedure; routine
provisioning does not authorize evidence garbage collection.

Tests use temporary fixtures and require `CLAUDE_COORDINATION_TESTING=1` or
`CLAUDE_STAGED_ENROLLMENT_TESTING=1` for fault hooks; they perform no live
credential, service, config, or provisioning action. Run `preflight --plan <file>
--expected-digest <digest>` before enabling each writer, then roll out consumers
one at a time. Every service/manual invocation must receive both generated
environment variables; an omitted coordination environment fails closed before
any credential mutation, and a divergent inventory fails exact identity checks.
Activation's submitted inventory must equal the authoritative consumers for the
selected credential exactly. Canary evidence contains exactly one passing,
no-fallback result per authoritative consumer and binds its ID, absolute path,
candidate digest, credential ID, and destination; both raw evidence digests are
bound by the signed activation approval.

Rollback means stopping before service activation and removing only artifacts
created by the failed apply; injected or real apply failures do this
automatically. After consumers are active, retain the key/config and roll back
service definitions to the prior reviewed version—never regenerate or overwrite
the coordination key. Trust files must remain outside all mutable auth roots.

## Legacy rotate-magic (disabled)

`rotate-magic.mjs`, browser setup modes, refresh emergency fallback, and the
autoloop no longer dispatch authentication. They return a staged-enrollment
handoff instead; no environment flag restores the old write path.

## cliproxy / CLIProxyAPI pool (optional)

cliproxy / CLIProxyAPI relay mode provides multi-account **load balancing / rate-limit spreading** via a relay pool.
Useful mainly when many accounts share one API endpoint and you hit 429s.
Skip the relay for single/few-account keychain rotation.

If you run a cliproxy relay alongside the rotator:

1. Add `crsAccountName` on each account (legacy field name; must match the cliproxy account `name`), or supply `crs.nameByVaultKey` in `config.json`.
2. Set `crs.enabled`, `crs.baseUrl`, and install the priority daemon: `scripts/install-crs-priority-agent.sh` (legacy filename retained).
3. On Linux/EC2, `crs-token-feed.mjs` propagates vault tokens into the cliproxy pool (systemd timer when installed).
4. On macOS clients that reach a **remote** relay via SSH, install the tunnel (legacy env `CRS_TUNNEL_SSH_HOST` is still accepted):

   ```bash
   CRS_TUNNEL_SSH_HOST=your-remote-host bash scripts/install-crs-fra-tunnel.sh
   ```

   Point Claude Code at `http://127.0.0.1:3005/api` (or your `CRS_TUNNEL_LOCAL_PORT`).

See `config.example.json` → `crs` block for all tunables (`policy`, `fileVaultPath`, `containerName`, thresholds; legacy key names retained for compatibility).
Configure via `/ops:rotate-setup` (detects cliproxy / CLIProxyAPI; never required).

## Keychain layout

- `Claude Code-credentials` (account = your OS user) — the live token Claude Code reads.
- `Claude-Rotation-<account_id>` (account = your OS user) — vault per configured account.

The `<account_id>` is the email or label, picked when you `add-account`.

Override the keychain account name via `CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT` if you need to (defaults to `$USER`).

## Files

| File                        | Purpose                                                                   |
| --------------------------- | ------------------------------------------------------------------------- |
| `rotate.mjs`                | Main rotation logic. CLI: `--status`, `--utilization`, `--to`, `--setup`. |
| `rotate-magic.mjs`          | Thin entry → `rotate.mjs --magic-link` (standalone reauth, no cliproxy required). |
| `captcha-cascade.mjs`       | Post-verify captcha orchestration (token + visual + desktop-act + VNC).   |
| `captcha-helper.mjs`        | Pluggable token captcha solvers + residential wait.                       |
| `visual-captcha-solver.mjs` | Vision tile clicks, desktop-act, VNC layers.                              |
| `bright-data-cascade.mjs`   | Optional Bright Data proxy tiers for solver IP alignment.                 |
| `daemon.mjs`                | launchd-managed monitor. Polls every 15s, rotates at 80% utilization.     |
| `ai-brain.mjs`              | Claude Haiku fallback for unexpected OAuth pages.                         |
| `force-rotate.sh`           | Out-of-band rotation when Claude Code is unreachable.                     |
| `config.example.json`       | Schema reference. Copy to `config.json` and populate.                     |

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

## Captcha cascade (plugin-native)

See `CAPTCHA-CASCADE.md`, `captcha-helper.mjs`, and `bright-data-cascade.mjs`.

Token solvers (env): `TWOCAPTCHA_API_KEY`, `CAPSOLVER_API_KEY`, `ANTICAPTCHA_API_KEY`, `YESCAPTCHA_CLIENT_KEY`.
Bright Data is last-resort cascade for proxy-aligned re-solve (zone/password envs), not a primary token API.

Residual host-only: interactive click helpers (`click-turnstile*.mjs`) and Chrome profile automation — next PR.
Browser walls on magic-link / OAuth go through `trySolveCaptchaWall` (see
`CAPTCHA-CASCADE.md`). Solvers need env keys (`TWOCAPTCHA_API_KEY`, etc.) via
Doppler/`secrets-bootstrap.mjs`. Interactive tile challenges use vision + desktop-act.
