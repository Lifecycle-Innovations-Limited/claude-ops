# CRS removal plan

Date: 2026-08-16
Status: **executed, with a changed scope.** This document is the survey that
preceded the removal; it is kept as the record of what the tree looked like
beforehand. Every path and line number below describes the pre-removal tree.

The plan proposed extracting CRS into an optional installable companion. The
owner decided instead that CRS is insecure and must be removed outright, with
CLIProxyAPI as the only supported path for multi-account rotation and OAuth
seat management. There is no companion package. Section 8 was not built.

Scope as executed: remove claude-relay-service (CRS) from this repo.

All paths are repo-relative. Line numbers are from the tree at the time of writing.

---

## 1. What CRS is in this repo today

### 1.1 Headline counts

| Group | Tracked files | Lines | Bytes |
|---|---|---|---|
| `claude-ops/scripts/account-rotation/` | 106 | 34,210 | 1,360,958 |
| `claude-ops/scripts/crsproxy-reauth/` | 7 | 3,532 | 140,618 |
| Other CRS-named files (installers, units, plists, runbook) | 14 | 786 | not measured |
| **Total matched by the inventory grep** | **127** | **~38,528** | **~1.5 MB** |

The repo tracks 959 files in total, 850 of them under `claude-ops/`. So the inventory grep touches
about 13% of the tree by file count.

The grep used was:
`git ls-files | grep -iE 'crs|claude-relay|account-rotation|rotation'`

### 1.2 The important distinction: `account-rotation` is not CRS

`account-rotation/` is 106 files, but only **14** carry a `crs-` filename prefix. Of the 106,
**53 mention "CRS" somewhere** and **53 do not**. Treating `account-rotation/` as "the CRS directory"
and deleting it would remove a large amount of non-CRS functionality (keychain rotation, the credit
ledger, the captcha cascade, staged enrollment, seat state, the CLIProxyAPI writer inside
`rotate.mjs`).

Three tiers, by evidence:

**Tier A — CRS-only. Extractable with no functional loss to the rest of the plugin.**

14 files in `account-rotation/`:

```
crs-401-refresher.mjs      crs-egress-failover.sh    crs-priority-daemon.mjs
crs-429-cooldown.mjs       crs-health-watch.mjs      crs-priority-daemon.sh
crs-429-cooldown.sh        crs-pool-config.mjs       crs-reconciler-state.mjs
crs-bedrock-guard.mjs      crs-pool-config.test.mjs  crs-refresh-lock.mjs
                                                     crs-token-feed.mjs
                                                     crs-token-feed.sh
```

Plus, outside `account-rotation/`:

```
claude-ops/scripts/crsproxy-reauth/                (7 files, 3,532 lines — CRS reauth, Python)
claude-ops/scripts/install-crs-fra-tunnel.sh
claude-ops/scripts/install-crs-priority-agent.sh
claude-ops/scripts/install-crs-reconcilers-agent.sh
claude-ops/scripts/systemd/crs-bedrock-guard.service
claude-ops/scripts/systemd/crs-bedrock-guard.timer
claude-ops/scripts/systemd/crs-compose.service
claude-ops/scripts/systemd/crs-token-feed.service
claude-ops/scripts/systemd/crs-token-feed.timer
claude-ops/templates/com.claude-ops.crs-429-cooldown.plist
claude-ops/templates/com.claude-ops.crs-fra-tunnel.plist
claude-ops/templates/com.claude-ops.crs-priority.plist
claude-ops/templates/com.claude-ops.magic-link-autoloop.plist   (installed only by install-crs-reconcilers-agent.sh)
docs/runbooks/crs-full-tuning-plan.md                            (269 lines, host-specific CRS tuning)
```

**Tier B — CRS-coupled but not CRS-only. Needs editing, not deleting.**

These are core rotation files that carry CRS logic inline. Counts are `git grep -c -i CRS`:

| File | CRS mentions | Why it matters |
|---|---|---|
| `claude-ops/scripts/account-rotation/bg-respawn.mjs` | 97 | highest CRS density in the tree; background respawn is CRS-aware throughout |
| `claude-ops/scripts/account-rotation/route-state.mjs` | 56 | exports `routeStatus()`, consumed by a **registered PreToolUse hook** |
| `claude-ops/scripts/account-rotation/claude-stack.mjs` | 35 | backs the `bin/claude-stack` wrapper; route modes are CRS-named |
| `claude-ops/scripts/account-rotation/session-router.mjs` | 25 | |
| `claude-ops/scripts/account-rotation/claude-settings-mode.mjs` | 20 | |
| `claude-ops/scripts/account-rotation/captcha-helper.mjs` | 18 | |
| `claude-ops/scripts/account-rotation/magic-link-autoloop.mjs` | 16 | **hard-imports two Tier-A modules** |
| `claude-ops/scripts/account-rotation/reauth-env.mjs` | 13 | |
| `claude-ops/scripts/account-rotation/launch-claude.mjs` | 11 | |
| `claude-ops/scripts/account-rotation/claude-harness-env.mjs` | 11 | |
| `claude-ops/scripts/account-rotation/config.example.json` | 11 | shipped config schema carries a `crs` block |
| `claude-ops/scripts/account-rotation/refresh-tokens.mjs` | 10 | **hard-imports one Tier-A module** |
| `claude-ops/scripts/account-rotation/ops-accounts-backend.mjs` | 9 | |
| `claude-ops/scripts/account-rotation/ops-accounts-gateway.mjs` | 5 | the declared CRS **replacement**; still speaks CRS in migration text |
| `claude-ops/scripts/account-rotation/README.md` | 14 | |
| `claude-ops/scripts/account-rotation/CAPTCHA-CASCADE.md` | 8 | |

Plus two test files that assert CRS behaviour:
`__tests__/claude-settings-mode-crs.test.mjs` (28 mentions),
`__tests__/production-recovery.test.mjs` (20).

**Tier C — not CRS.** The remaining ~53 files in `account-rotation/`: `rotate.mjs` (the largest
CLIProxyAPI consumer in the repo, 70 `cliproxy` hits), `ledger.mjs`, `claude-p-as.mjs`,
`seat-state.mjs`, `seat-policy-tick.mjs`, `staged-enrollment.mjs`, the captcha cascade
(`captcha-cascade.mjs`, `visual-captcha-solver.mjs`, `bright-data-cascade.mjs`), `rotate-magic.mjs`,
`kapture-claim-credits.mjs`, `daily-credit-digest.mjs`, `monthly-credit-reclaim.mjs`, the 23 files
under `__tests__/`, and the rest.

### 1.3 Hard code edges into Tier A

Only four `import` statements cross into CRS modules. This is the real coupling surface:

| Consumer | Line | Imports |
|---|---|---|
| `claude-ops/scripts/account-rotation/magic-link-autoloop.mjs` | 33 | `./crs-pool-config.mjs` (`loadRotationConfig`, `buildCrsNameMaps`, `crsFileVaultPath`) |
| `claude-ops/scripts/account-rotation/magic-link-autoloop.mjs` | 34 | `./crs-reconciler-state.mjs` (`loadJsonState`, `saveJsonStateAtomic`, `withOwnStateLock`) |
| `claude-ops/scripts/account-rotation/refresh-tokens.mjs` | 24 | `./crs-refresh-lock.mjs` (`acquireRefreshLock`, `claimRefreshPace`) |
| `claude-ops/scripts/account-rotation/crs-health-watch.mjs` | 33 | `./crs-heal-relay.mjs` — **this file does not exist** (not tracked, not on disk) |

Intra-Tier-A imports (`crs-429-cooldown.mjs:62,63`, `crs-pool-config.test.mjs:3`,
`crs-priority-daemon.mjs:73`, `crs-token-feed.mjs:22,29`) all resolve inside the group and move with it.

---

## 2. What depends on it — blast radius

### 2.1 Executable callers (code, not prose)

| File:line | What it does |
|---|---|
| `claude-ops/hooks/bedrock-fallback-guard.mjs:2` | `import { routeStatus } from '../scripts/account-rotation/route-state.mjs'` |
| `claude-ops/hooks/hooks.json:8` | registers `bedrock-fallback-guard.mjs` as a **PreToolUse hook** — this is a live safety gate |
| `claude-ops/hooks/hooks.json:73` | registers `bedrock-billing-guard.mjs` (PreToolUse); its user-facing text at `:111,112,127,129` tells the user CRS/OAuth will take over |
| `claude-ops/hooks/bedrock-fallback-guard.mjs:21,27,33` | error strings instruct `claude-stack route --mode crs-oauth` |
| `claude-ops/bin/claude-stack:5` | `exec node "$ROOT/scripts/account-rotation/claude-stack.mjs"` |
| `claude-ops/bin/ops-accounts:60` | `ROT="${ROOT}/scripts/account-rotation"` — the whole shell path hangs off this |
| `claude-ops/bin/ops-accounts:34` | `SHELL_CMDS="util setup crs crs-tick seats gateway grok-proxy help …"` |
| `claude-ops/bin/ops-accounts:62,94` | `CRS_GROK_BASE_URL` probe for the Grok hop |
| `claude-ops/bin/ops-accounts:298-311` | `crs` and `crs-tick` subcommands shell out to `crs-priority-daemon.sh` |
| `claude-ops/bin/ops-accounts:368` | prints the `CRS_BASE_URL` → `OPS_ACCOUNTS_GATEWAY_URL` migration hint |
| `claude-ops/bin/ops-accounts:395` | help text lists `crs \| crs-tick` |
| `claude-ops/bin/ops-bg:91-105` | injects a CRS session-settings overlay via `--settings`, gated on a host preflight script that lives outside the repo |
| `claude-ops/scripts/lib/claude-invoke.sh:15,25,34,83` | resolves and execs `scripts/account-rotation/claude-p-as.mjs` (Tier C, not CRS) |
| `claude-ops/scripts/install-account-rotator-linux.sh:19,20,37,66` | systemd installer for `daemon.mjs` + `provision-coordination.mjs` |
| `claude-ops/scripts/install-crs-priority-agent.sh:20,21,22` | wrapper/daemon/plist paths |
| `claude-ops/scripts/install-crs-reconcilers-agent.sh:52,53,89,99,106,107` | 429-cooldown + magic-link autoloop units |
| `claude-ops/scripts/install-daily-credit-digest.sh:23` | `account-rotation/daily-credit-digest.mjs` (Tier C) |
| `claude-ops/scripts/install-monthly-credit-reclaim.sh:23` | `account-rotation/monthly-credit-reclaim.mjs` (Tier C) |
| `claude-ops/scripts/ops-accounts/providers/claude.mjs:13,18` | resolves the `account-rotation` dir and a host config path |
| `claude-ops/scripts/ops-accounts/providers/claude.mjs:121` | returns `note: 'use crs-live-status / priority daemon'` |
| `claude-ops/scripts/ops-accounts/providers/cursor.mjs:11,55` | reads a quota snapshot under a `crs-keys/` host dir |
| `claude-ops/scripts/ops-accounts/providers/factory.mjs:12,60` | same `crs-keys/` host dir |
| `claude-ops/scripts/ops-cron-pocket-watcher.py:358,363` | falls back to a keychain item named `CRS_KEY` for a relay token |
| `claude-ops/scripts/ops-memory-extractor.sh:87,91` | same `CRS_KEY` keychain fallback |
| `claude-ops/templates/statusline/statusline-command.sh:262-275` | CRS-relay detection to suppress a false Bedrock warning |
| `claude-ops/templates/statusline/statusline-command.sh:301` | reads a host `account-rotation` dir for status |
| `claude-ops/templates/statusline/tests/run-tests.sh:88` | creates a fake `account-rotation` dir as fixture |
| `claude-ops/scripts/recap/cron.example.txt:12` | example crontab line running `account-rotation/kapture-claim-credits.mjs` |

### 2.2 Service definitions

| File:line | Note |
|---|---|
| `claude-ops/scripts/systemd/claude-account-rotation.service:3,4` | `After=`/`Wants= crs-compose.service` — the rotation daemon unit is ordered behind CRS |
| `claude-ops/scripts/systemd/claude-account-rotation.service:16,17` | ExecStart / WorkingDirectory into `account-rotation/daemon.mjs` |
| `claude-ops/scripts/systemd/crs-bedrock-guard.service:3,4,8` | depends on `crs-compose.service`, runs `crs-bedrock-guard.mjs` from a host path |
| `claude-ops/scripts/systemd/crs-token-feed.service:3,4,10,11` | depends on `crs-compose.service`, sets `CRS_BASE`, runs `crs-token-feed.sh` |
| `claude-ops/scripts/systemd/crs-bedrock-guard.timer:8`, `crs-token-feed.timer:8` | timers bound to the above |
| `claude-ops/templates/com.claude-ops.account-rotation.plist` | launchd unit for the rotation daemon (not CRS-specific) |
| `claude-ops/templates/com.claude-ops.crs-*.plist` (3 files) | launchd units for CRS reconcilers/tunnel/priority |
| `claude-ops/templates/com.claude-ops.magic-link-autoloop.plist:7,65` | installed by the CRS reconciler installer; sets `CRS_MAGIC_LINK_ROTATE_TIMEOUT_MS` |

`claude-ops/scripts/systemd/install-systemd-units.sh` does **not** reference any `crs-*` unit —
verified with a targeted grep that returned nothing. The CRS units are installed only by the three
`install-crs-*.sh` scripts, or by hand.

**No cron entries** ship in the repo other than the example at `claude-ops/scripts/recap/cron.example.txt:12`.

### 2.3 Configuration surfaces

| File:line | Note |
|---|---|
| `claude-ops/.claude-plugin/plugin.json:184-189` | userConfig `account_rotation_enabled` (default false) |
| `claude-ops/.claude-plugin/plugin.json:190-194` | userConfig `account_rotation_setup_oauth_each` (default true) |
| `claude-ops/.gitleaks.toml:179` | comment noting the scanner still runs against `scripts/account-rotation/` because it handles real auth tokens |
| `claude-ops/package.json` | **no** npm script references CRS or account-rotation. Verified by reading the file. |
| `claude-ops/plugin-dependencies.json:20` | companion `essentialFor` names "unattended captcha cascade (rotate-magic / magic-link-autoloop)" — magic-link-autoloop is Tier B |

### 2.4 Documentation

| File:line | Note |
|---|---|
| `claude-ops/README.md:3,7,8,10,32,93,94` | rotator is a headline feature; two commands listed |
| `claude-ops/CLAUDE.md:46-48` | the Credit-pool gate section (see §6) |
| `claude-ops/CHANGELOG.md` | 20+ hits across the history. Changelog entries are historical record and should not be rewritten. |
| `claude-ops/docs/ops/HOST-VS-PLUGIN-ROTATE-GAP.md:3,4,50,62,73-84,99,124-149` | the gap analysis between host tree and plugin tree; enumerates host-only CRS units |
| `claude-ops/docs/ops/OPS-ACCOUNTS-GATEWAY.md:3,7,32,42,54` | states the gateway's purpose is to work **without** installing claude-relay-service |
| `claude-ops/docs/ops/OPS-ACCOUNTS-VISION.md:52,102-106,120,153` | phase map with "CRS optional" and "gateway (no CRS)" as the end state |
| `claude-ops/docs/daemon-guide.md:10`, `claude-ops/docs/migrating-from-v1.md:37,56,90,113`, `claude-ops/docs/os-compatibility.md:182`, `claude-ops/docs/safety-hooks.md:124` | rotation references |
| `docs/runbooks/crs-full-tuning-plan.md` | 269 lines. Entirely CRS. Contains host-specific operational detail. |
| `docs/PII-AUDIT.md:37` | already flags issue keys in credit-rotation code |

---

## 3. What breaks if deleted, per skill

Read from the SKILL.md files themselves.

### `ops-accounts` — **breaks partially, degrades loudly**

- `SKILL.md:3,4` — description and `argument-hint` both advertise `crs` and `crs-tick` verbs.
- `SKILL.md:28` — router table row "Optional Claude LB (CRS or future gateway) → `crs`, `crs-tick`".
- `SKILL.md:37` — Claude provider engine is `scripts/account-rotation/rotate.mjs` (Tier C, survives).
- `SKILL.md:38,90-94` — Grok flows describe an optional CRS hop in front of a host OAuth proxy.
- `SKILL.md:43,66,78,101,102` — the skill **already** says CRS is optional and "Missing CRS is not a failure".
- `SKILL.md:83,86` — seat-state calls into `account-rotation/seat-state.mjs` (Tier C, survives).
- `SKILL.md:107,108` — the phase map already ends at "8 gateway (no CRS)".

Net: losing CRS costs this skill exactly two verbs. `bin/ops-accounts:298-311` already prints
"CRS priority script missing (optional)" when the script is absent, so the removal is
already handled at runtime for `crs`; `crs-tick` exits 1.

### `ops-rotate` — **breaks two documented verbs**

`SKILL.md:3,4,26` advertise `crs` / `crs-tick` and map them onto `ops-accounts`. The skill is a thin
alias; everything else routes to `bin/ops-accounts`. Fix is a doc edit.

### `ops-rotate-setup` — **does not break**

`SKILL.md:18,23` point at `account-rotation/staged-enrollment.mjs` (Tier C) and describe capturing a
**CLIProxyAPI** Claude auth candidate. This skill is already on the replacement path. It never
mentions CRS.

### `ops-fleet` — **does not break, already on CLI proxy**

`SKILL.md:3,17,23,32,48-66` are entirely CLIProxyAPI: `CLIPROXYAPI_BASE_URL`,
`fleet.cliproxy_base_url`, `CLIPROXY_API_KEY`, `CLIPROXYAPI_POOL_COMMAND`, `CLIPROXYAPI_SSH_HOST`,
`CLIPROXYAPI_REMOTE_HELPER`. A targeted grep for `crs` over `bin/ops-fleet` and
`bin/ops-fleet-pool-snapshot` returned nothing. This skill is the model for where the rest should land.

### `ops-credentials` — **does not break**

A targeted grep over `bin/ops-credentials` and `skills/ops-credentials/` found exactly one hit,
`SKILL.md:71`, about rotating an unrelated third-party token. No CRS coupling.

### Others that reference CRS in prose only

- `skills/ops-desk/SKILL.md:75` — one sentence about relay/CRS setups and batch sizing.
- `skills/ops-mac/SKILL.md:113` — names CRS in a "never kill a daemon the user relies on" warning list.
- `skills/setup/SKILL.md:1109,1487,1695` and `skills/setup/channels/claude-rotator.md:3,8,9,31,34` —
  the rotator setup channel. References `account-rotation/config.json`, not CRS.

### Not a skill, but the loudest break

`hooks/bedrock-fallback-guard.mjs` is a **registered PreToolUse hook** (`hooks/hooks.json:8`) that
imports `route-state.mjs`. `route-state.mjs:7` defines `ROUTE_MODES = new Set(['crs-oauth',
'fail-closed'])`. If `route-state.mjs` is deleted the hook throws on every tool call. If the mode name
`crs-oauth` is renamed without updating the hook's three message strings
(`bedrock-fallback-guard.mjs:21,27,33`), the guidance the user sees becomes wrong.

---

## 4. CI

Both CRS test paths run in CI today.

**Workflow:** `.github/workflows/ci.yml`

| Job | Step | Line | CRS relevance |
|---|---|---|---|
| `lint-and-check` | "Prettier check" | `ci.yml:71` | formats `**/*.{js,mjs,json}` — includes all of `account-rotation/` |
| `lint-and-check` | "Run gitleaks" | `ci.yml:78` | uses `claude-ops/.gitleaks.toml`, whose comment at `:179` exists specifically because of `account-rotation/` |
| `pii-gate` | "PII / personal-data scan" | `ci.yml:90` | `claude-ops/tests/test-no-secrets.sh` |
| `test-suite` | "Run full test suite" | `ci.yml:105` | `bash claude-ops/tests/run-all.sh` — this is the one that matters |

**Inside `claude-ops/tests/run-all.sh`**, six suites reach into the removal area:

| Line | Suite | Reaches |
|---|---|---|
| 42 | `test-rotate-cliproxy-integration.sh` | `account-rotation/auto-auth-policy.mjs` (:14), `refresh-tokens.mjs` (:42), `rotate.mjs` (:64); sets `CLAUDE_ROTATION_SKIP_CRS_SYNC: '1'` (:50) |
| 43 | `test-model-args.sh` | `account-rotation/__tests__/model-args.test.mjs` |
| 44 | `test-account-recovery.sh` | `__tests__/refresh-pacing.test.mjs`, `refresh-lock.test.mjs`, `production-recovery.test.mjs` |
| 45 | `../scripts/crsproxy-reauth/test-python-suites.sh` | **the only pure-CRS suite in CI.** Runs 4 Python files: `test_browser_cleanup.py`, `test_checkpoint.py`, `test_lease_cooldown.py`, `test_candidate_validation.py` |
| 46 | `test-staged-enrollment.sh` | `__tests__/staged-enrollment.test.mjs` |
| 47 | `test-coordination-provisioning.sh` | `__tests__/coordination-provisioning.test.mjs` |
| 63 | `../templates/statusline/tests/run-tests.sh` | creates an `account-rotation` fixture dir at `:88` |

Two test files exist but are **not** wired into `run-all.sh`, so they do not run in CI:
`account-rotation/crs-pool-config.test.mjs` and `claude-ops/tests/test-claude-invoke.sh`.
`account-rotation/__tests__/run-captcha-unit-tests.mjs` is likewise not in `run-all.sh`.

`claude-ops/.github/workflows/cross-os.yml` and `docker-build.yml` contain no CRS or
account-rotation references — verified by grep.

---

## 5. What already references "cliproxy" — how much of the replacement exists

The replacement is not hypothetical. It is roughly half-built.

| File | `cliproxy` hits | State |
|---|---|---|
| `claude-ops/scripts/account-rotation/rotate.mjs` | 70 | Writes CLIProxyAPI auth files directly (`cliproxyAuthSnapshot` :1691, `cliproxyAuthChanged` :1719, `clearCliProxyCooldown` :1729, `syncCliProxyReplica` :1753). Comment at `:117` states CLIProxyAPI "owns the per-seat JSON schema and is the sole" source. |
| `claude-ops/bin/ops-accounts` | 24 | Full CLIProxyAPI backend: `CLIPROXY_HOME` :102, `cliproxy_alive()` :106, `cliproxy_count()` :113, and `codex`/`gemini`/`xai`/`kimi` util paths :177-202 |
| `claude-ops/scripts/crsproxy-reauth/bu_reauth.py` | 17 | CRS-side reauth that already knows about cliproxy |
| `claude-ops/bin/ops-fleet` | 14 | fully CLIProxyAPI |
| `claude-ops/skills/ops-fleet/SKILL.md` | 12 | fully CLIProxyAPI |
| `claude-ops/scripts/ops-accounts/providers/cliproxy.mjs` | 10 | A complete provider adapter (91 lines): `listAccounts`, `utilization`, `reauth`. Note it still carries a vestigial `crs: null` field at `:41,61`. |
| `claude-ops/bin/ops-fleet-pool-snapshot` | 5 | |
| `claude-ops/scripts/account-rotation/README.md` | 3 | |
| `claude-ops/tests/test-rotate-cliproxy-integration.sh` | 2 | an existing CI-run integration test for the cliproxy path |
| `claude-ops/skills/ops-rotate-setup/SKILL.md` | 1 | already instructs a CLIProxyAPI auth candidate |
| `claude-ops/scripts/ops-accounts/cli.mjs` | 1 | |
| `claude-ops/scripts/account-rotation/staged-enrollment.mjs` | 1 | |
| `claude-ops/docs/ops/OPS-ACCOUNTS-VISION.md` | 1 | |

Also already built as the CRS replacement: `account-rotation/ops-accounts-gateway.mjs`, documented at
`claude-ops/docs/ops/OPS-ACCOUNTS-GATEWAY.md:3` ("skeleton shipped") and `:7` ("without installing
claude-relay-service"). `bin/ops-accounts:342-383` exposes it as `ops-accounts gateway
status|start|path|self-test|config` on the same default port CRS used.

Conclusion: `ops-fleet`, `ops-rotate-setup`, the cliproxy provider adapter, the cliproxy writer in
`rotate.mjs`, and the gateway all exist. What is missing is the pool-priority / cooldown / token-feed
control loop that the `crs-*` daemons currently provide.

---

## 6. The credit-pool gate — what actually needs rewiring

`claude-ops/CLAUDE.md:46-48` documents `CLAUDE_OPS_USE_CREDIT_POOL`. Verified against the code:

- `claude-ops/scripts/lib/claude-invoke.sh:80` — when `CLAUDE_OPS_USE_CREDIT_POOL=1`, `claude_invoke`
  execs `scripts/account-rotation/claude-p-as.mjs` (`:83,91`). Otherwise it calls `claude` directly
  (`:93`).
- `claude-p-as.mjs` imports **only** `./ledger.mjs` (`:38`) and reads a credit ledger JSON (`:41`).
  It contains **zero** references to CRS, cliproxy, or any relay. Confirmed by grep.

**So the credit-pool gate does not depend on CRS at all.** It depends on `account-rotation/` existing
as a directory, and on `ledger.mjs` + `claude-p-as.mjs` staying put.

What that means for the removal:

- If CRS is extracted (Tier A only), the gate needs **no rewiring**.
- If `account-rotation/` is moved or renamed wholesale, four call sites in
  `claude-ops/scripts/lib/claude-invoke.sh` (`:15` comment, `:25`, `:34`, `:83`) plus
  `claude-ops/tests/test-claude-invoke.sh:114` must be updated, and eleven downstream consumers of
  `claude_invoke` inherit the change:
  `bin/ops-creative-brief:206`, `bin/ops-marketing-autopilot:37`, `bin/ops-suggest-specialized-agent:92`,
  `scripts/lib/creative/analyze.sh:38`, `scripts/lib/creative/landing.sh:66`,
  `scripts/lib/deploy-fix-common.sh:296`, `scripts/ops-cron-competitor-intel.sh:263`,
  `scripts/ops-cron-email-draft.sh:30`, `scripts/ops-cron-seo-blog-gen.sh:26`,
  `scripts/ops-cron-social-calendar.sh:30`, `scripts/recap/digest.sh:12`.
- `claude-invoke.sh:87` already degrades to direct `claude` with a warning if the wrapper is missing,
  so a botched move fails soft rather than dropping daemon jobs.

---

## 7. Removal sequence

Seven steps. Each is independently verifiable and independently revertable. Steps 1-3 are pure
subtraction with no behaviour change; the risk starts at step 4.

### Step 1 — Fix the already-broken import, or delete the file that has it

`crs-health-watch.mjs:33` imports `./crs-heal-relay.mjs`, which does not exist in the repo or on disk.
That file is dead today. Decide: delete `crs-health-watch.mjs`, or carry the broken import into the
extracted package and fix it there.

**Verify:** `node --check claude-ops/scripts/account-rotation/crs-health-watch.mjs` passes (syntax
only, it will not catch the missing module); `git ls-files | grep crs-heal-relay` returns nothing.

### Step 2 — Cut the three code edges from Tier B into Tier A

Three imports, three fixes. Nothing else needs to move first.

1. `refresh-tokens.mjs:24` imports `acquireRefreshLock`, `claimRefreshPace` from `crs-refresh-lock.mjs`.
   These are generic lock/pacing primitives with a CRS-flavoured filename. Rename the module to a
   neutral name (e.g. `refresh-lock.mjs`) and keep it in `account-rotation/`. Update
   `crs-token-feed.mjs:22` to match — it moves out with Tier A but needs the new import path.
2. `magic-link-autoloop.mjs:34` imports `loadJsonState`, `saveJsonStateAtomic`, `withOwnStateLock`
   from `crs-reconciler-state.mjs`. Same treatment: neutral filename, stays.
   Update `crs-429-cooldown.mjs:62` to match.
3. `magic-link-autoloop.mjs:33` imports `loadRotationConfig`, `buildCrsNameMaps`, `crsFileVaultPath`
   from `crs-pool-config.mjs`. This one is genuinely mixed: `loadRotationConfig` is generic,
   `buildCrsNameMaps` and `crsFileVaultPath` are CRS pool concepts. Split it: generic config loading
   stays, the CRS pool mapping leaves. `magic-link-autoloop.mjs` then needs an alternative for the
   name map, or must lose the CRS branch.

**Verify:** `node --check` every changed `.mjs`. Then
`git grep -nE "from '\./crs-" -- claude-ops/scripts/account-rotation/` should list only files that
are themselves Tier A. Run `bash claude-ops/tests/run-all.sh` — the suites at lines 42-47 exercise
`refresh-tokens.mjs` and the `__tests__` tree.

### Step 3 — Extract Tier A to the new home

Move the 14 `crs-*` files (minus whatever was renamed in step 2), `scripts/crsproxy-reauth/`, the
three `install-crs-*.sh`, the five `crs-*` systemd units, the three `com.claude-ops.crs-*.plist`, and
`com.claude-ops.magic-link-autoloop.plist` into the separate installable package (§8). Do **not**
delete them from history; a plain `git rm` is enough, the history stays.

Do not move `docs/runbooks/crs-full-tuning-plan.md` verbatim. It carries host-specific operational
detail. Either rewrite it generically for the new package or drop it — see §9.

**Verify:** `git ls-files | grep -iE 'crs|claude-relay'` returns only intentional survivors.
`bash claude-ops/tests/run-all.sh` — expect line 45 to fail until step 4.

### Step 4 — Unwire CI

- Remove `claude-ops/tests/run-all.sh:45` (the `crsproxy-reauth` suite). This is the only line in
  `run-all.sh` that must go.
- Re-check `test-rotate-cliproxy-integration.sh:50` — it sets `CLAUDE_ROTATION_SKIP_CRS_SYNC: '1'`.
  If `rotate.mjs` no longer has a CRS sync path, that env var is dead and the line should go with it.
- `claude-ops/.gitleaks.toml:179` — update the comment; the reasoning ("account-rotation handles real
  auth tokens") still holds for Tier C, so the rule itself should stay.

**Verify:** `bash claude-ops/tests/run-all.sh` is green locally. Then confirm the `test-suite` job in
`.github/workflows/ci.yml:105` passes on both matrix OS entries.

### Step 5 — Unwire the daemons and units

- `claude-ops/scripts/systemd/claude-account-rotation.service:3,4` — drop
  `After=`/`Wants= crs-compose.service`. The rotation daemon has no real dependency on a relay
  container once CRS is gone, and leaving the ordering in means the unit waits on a unit that will
  never exist.
- Confirm `install-systemd-units.sh` still installs a coherent set (it never referenced the CRS units,
  so this should be a no-op).
- Decide the fate of `com.claude-ops.magic-link-autoloop.plist`: its only installer is
  `install-crs-reconcilers-agent.sh`. If magic-link autoloop survives without CRS, it needs a
  non-CRS installer.

**Verify:** `systemd-analyze verify` on the changed unit where a Linux box is available; otherwise
read the unit and confirm no `crs-` token remains:
`git grep -n crs -- claude-ops/scripts/systemd/`.

### Step 6 — Rewire the routing vocabulary and the safety hook

This is the step most likely to cause a user-visible regression.

- `route-state.mjs:7` — `ROUTE_MODES` contains `crs-oauth`. Renaming it to something like
  `proxy-oauth` requires updating `bedrock-fallback-guard.mjs:21,27,33` (three user-facing strings
  naming `--mode crs-oauth`), `claude-stack.mjs` (35 CRS hits), `claude-settings-mode.mjs` (20), and
  `__tests__/claude-settings-mode-crs.test.mjs` (28) which asserts the current names.
- `route-state.mjs:13` — the base-URL regex hardcodes specific ports **and one specific host IP**.
  That IP is operator-specific and should not be in a public repo regardless of this plan. Replace
  with a configured value.
- `route-state.mjs:46,48,49` — host state paths named `crs-session-settings.json`,
  `crs-fallback-active`, `crs-health-watch.state.json`. Renaming these breaks any live install that
  already has those files; needs a migration or a read-both-write-new shim.
- `hooks/bedrock-billing-guard.mjs:111,112,127,129` — four message strings promise "the rotation
  watchdog should swap you to CRS/OAuth". Reword.
- `bin/ops-bg:91-105` — the CRS overlay injection. It already defaults to a host file and can be
  opted out with `CRS_OVERLAY=""`. Either point it at the CLI proxy overlay or delete the block.

**Verify:** a session start with the PreToolUse hooks active does not throw; `bin/claude-stack route
--mode <new-name>` succeeds and `--mode crs-oauth` gives a clear deprecation message rather than an
opaque failure. Run the two `claude-settings-mode` test files.

### Step 7 — Documentation and the two skill verbs

- `bin/ops-accounts` — remove or deprecate `crs` / `crs-tick` (`:34,298-311,395`), remove the
  `CRS_GROK_BASE_URL` probe (`:62,94`) or rename it, keep the migration hint at `:368` but flip it to
  point at the gateway as the default rather than the migration target.
- `skills/ops-accounts/SKILL.md:3,4,28,38,43,65,66,90,101,102,107,108` — drop the two verbs, keep the
  Grok proxy path, retire the "CRS optional" phase-map language now that phase 8 is the state.
- `skills/ops-rotate/SKILL.md:3,4,26` — drop the two verbs.
- `skills/ops-desk/SKILL.md:75`, `skills/ops-mac/SKILL.md:113` — reword the one-line mentions.
- `claude-ops/README.md:32,93,94` — the rotator entry stays (it is Tier C), but should describe the
  CLI proxy backend, not a relay.
- `claude-ops/docs/ops/HOST-VS-PLUGIN-ROTATE-GAP.md`, `OPS-ACCOUNTS-GATEWAY.md`,
  `OPS-ACCOUNTS-VISION.md` — these three are the CRS-to-gateway migration story. They should be
  rewritten as a single "CLI proxy is the backend, CRS is an optional add-on" document, or archived.
- `claude-ops/CHANGELOG.md` — **do not edit**. It is a historical record. Add a new entry describing
  the removal instead.

**Verify:** `bash claude-ops/tests/run-all.sh` (the skills-lint suite at `run-all.sh:36` will catch
malformed frontmatter). `git grep -icE 'crs|claude-relay' -- claude-ops/skills/` should be zero or
only intentional deprecation notes.

---

## 8. What becomes the installable dependency

### 8.1 Shape

The repo already has the right mechanism: `claude-ops/plugin-dependencies.json` is the declared SSOT
for companions, read by `scripts/install-companions.sh` and `bin/ops-update`. It supports two kinds
today — `claude-plugin` and `skills-clone` — and each entry carries `required`, `coInstallDefault`,
`updateWithOps`, `userConfigGate`, `prefsKey`, `detect`, and `essentialFor`.

CRS should become a **fourth-party optional companion** with:

```
required:          false
coInstallDefault:  false
updateWithOps:     "never"   (or "on-request")
userConfigGate:    "crs_backend_enabled"   (new userConfig key, default false)
prefsKey:          "backends.crs"
essentialFor:      []        (nothing in the plugin requires it)
```

`essentialFor: []` is the honest value and it is the whole point of the change: after this plan,
no ops command depends on CRS.

The package itself needs to contain: the 14 `crs-*` scripts, the 7 `crsproxy-reauth` files, the three
`install-crs-*.sh` installers, the five systemd units, the four plists, and a config schema for the
`crs` block currently living in `account-rotation/config.example.json`.

### 8.2 Where it should live

Two options, and the owner should pick before step 3:

**(a) A separate repo under the same marketplace.** Matches the `desktop-act` pattern
(`plugin-dependencies.json:5-22`): a real plugin, installed with `claude plugin install`, detected
with a `find` glob. Cleanest boundary. Costs a new repo and a new release lane.

**(b) A `skills-clone`-style git clone.** Matches the `gstack` pattern
(`plugin-dependencies.json:39-57`): `installScript` + `detect.pathExists`, no marketplace entry.
Cheaper to set up, but `bin/ops-update` treats these as always-update, which is wrong for an opt-in
backend — so `updateWithOps` would need a value the installer currently may not honour. **This needs
checking against `scripts/install-companions.sh` before committing to it; I did not read that script.**

### 8.3 Install / opt-in path a user would follow

Assuming option (a):

1. User runs `/ops:accounts` and sees the Claude backend reported as CLI proxy. No CRS anywhere.
2. User who wants multiple Claude or other OAuth seats behind one relay opens plugin settings and
   flips `crs_backend_enabled` to true.
3. `/ops:setup` (or `bin/ops-update`) sees the gate, reads the companion entry, and runs
   `claude plugin install <crs-companion>@ops-marketplace`.
4. The companion's own installer prompts for the upstream relay: which container image, which admin
   credential source, which base URL. **The upstream project slug and image tag are not stated in
   this plan on purpose — this is a public repo. They are recorded today in
   `docs/runbooks/crs-full-tuning-plan.md:19-21` and the owner should decide what is safe to
   republish.**
5. The companion writes its own `crs` config block and registers only the units the user asked for
   (`install-crs-priority-agent.sh` for pool priority, `install-crs-reconcilers-agent.sh` for
   cooldown/magic-link, `install-crs-fra-tunnel.sh` for a remote relay over SSH).
6. `bin/ops-accounts crs` / `crs-tick` come back as verbs **provided by the companion**, not the core
   plugin. The core plugin's current behaviour at `bin/ops-accounts:301` — printing "CRS priority
   script missing (optional)" — is already the correct not-installed message.

### 8.4 What must NOT move into the companion

`claude-p-as.mjs`, `ledger.mjs`, `rotate.mjs`, `seat-state.mjs`, `staged-enrollment.mjs`, the captcha
cascade, and the `__tests__/` tree. These are Tier C, they back the credit-pool gate and the
CLIProxyAPI writer, and moving them would break `claude-invoke.sh` and eleven daemon callers (§6).

---

## 9. Risks and what cannot be cleanly removed

**R1 — The PreToolUse safety hook is the sharpest edge.** `hooks/hooks.json:8` registers
`bedrock-fallback-guard.mjs`, which imports `route-state.mjs` at module load. Any error in that
import path fires on **every tool call in every session**, not just when someone runs an accounts
command. This is the one change in the plan that can brick a working install. It is why step 6 is
last and why steps 1-5 must be green first.

**R2 — Live installs have on-disk state named after CRS.** `route-state.mjs:46,48,49` reference
`crs-session-settings.json`, `crs-fallback-active`, and `crs-health-watch.state.json` under the
user's home. `bin/ops-bg:92` defaults to the same session-settings file, and
`templates/statusline/statusline-command.sh:262-275` detects a CRS relay by base URL to suppress a
false Bedrock billing warning. Renaming these without a migration means: a user's routing silently
stops being recognised, and the statusline starts warning about metered Bedrock spend on a session
that is fine. Read-both-write-new, or leave the filenames alone and only change the code that reads
them.

**R3 — `bg-respawn.mjs` has 97 CRS references and no obvious seam.** It is the densest CRS file
outside the `crs-*` group and it is not named `crs-`. I did not read it in full, so I cannot say
whether it decomposes cleanly or whether the CRS logic is load-bearing for non-CRS respawn. **This is
the single largest unknown in the plan and should be scoped before step 6 is estimated.**

**R4 — Host-only dependencies that this repo cannot remove.** Several CRS touchpoints reference files
that live outside the repo entirely and will keep dangling: `bin/ops-bg:95` expects a preflight script
under the user's home; `rotate.mjs:127` defaults to a replica-sync script under the user's
`~/.local/bin`; `ops-accounts/providers/{cursor,factory}.mjs` read quota snapshots from a `crs-keys/`
host directory; `ops-cron-pocket-watcher.py:363` and `ops-memory-extractor.sh:91` fall back to a
keychain item named `CRS_KEY`. Removing CRS from the repo does not remove these from users' machines.
`docs/ops/HOST-VS-PLUGIN-ROTATE-GAP.md:50,62,73-81` already documents this host/plugin split.

**R5 — Two pre-existing public-repo hygiene problems sit inside the removal area.**
`rotate.mjs:116` contains a contributor's first name in a comment, and `rotate.mjs:121` defaults a
path into a specific personal directory layout. `route-state.mjs:13` hardcodes a specific host IP.
`docs/runbooks/crs-full-tuning-plan.md` contains host-specific operational detail throughout. None of
these were introduced by this plan, but step 3 and step 6 touch all of them, so they should be fixed
in the same pass rather than moved into a new package. `docs/PII-AUDIT.md:37` already tracks a related
class of issue.

**R6 — CHANGELOG cannot be cleaned.** 20+ CRS references across the release history. Rewriting them
would falsify the record. They stay, and any future "is CRS gone?" grep will keep hitting them.

**R7 — The `crs` config block ships in a tracked example.** `account-rotation/config.example.json` has
11 CRS references. Users who copied it have a `crs` block in their live config. Removing the block
from the example does not remove it from their file; readers should tolerate an unknown block rather
than fail.

**R8 — Two test files are dead weight and will hide regressions.**
`account-rotation/crs-pool-config.test.mjs` and `tests/test-claude-invoke.sh` are not referenced by
`run-all.sh`, so nothing verifies them in CI. `test-claude-invoke.sh` is the only test of the
credit-pool gate — the exact thing §6 says must not break. Wiring it into `run-all.sh` **before**
step 2 would be cheap insurance.

---

## 10. Open questions for the owner

1. **Scope.** Does "remove CRS" mean Tier A only (~35 files, low risk), or all of `account-rotation/`
   (106 files, breaks the credit-pool gate and eleven daemon callers)? This plan assumes Tier A.

2. **Companion shape.** Separate marketplace plugin (the `desktop-act` pattern) or git clone
   (the `gstack` pattern)? See §8.2. I did not read `scripts/install-companions.sh`, so I cannot say
   whether it honours `updateWithOps: "never"`.

3. **Republishing the upstream relay details.** The upstream project slug, container image tag, and
   port layout are currently recorded in `docs/runbooks/crs-full-tuning-plan.md`. That file also
   contains host-specific operational detail. What may be republished in a public companion package?

4. **Route-mode rename.** Is `crs-oauth` renamed (breaks `--mode crs-oauth` for existing users, needs
   the shim in R2), or kept as a legacy alias forever?

5. **On-disk state migration.** Rename the three `crs-*` state files under the user's home with a
   migration, or leave the filenames and only change the code? R2.

6. **`bg-respawn.mjs`.** Should it be scoped before this plan is scheduled? 97 CRS references, no read
   performed. R3.

7. **Magic-link autoloop.** Does it survive CRS removal? Today it hard-imports two CRS modules
   (`magic-link-autoloop.mjs:33,34`), its only installer is `install-crs-reconcilers-agent.sh`, and
   `plugin-dependencies.json:20` names it as something a required companion is essential for.

8. **`crs-heal-relay.mjs`.** It is imported at `crs-health-watch.mjs:33` and does not exist. Was it
   ever committed, or is `crs-health-watch.mjs` dead code that should just be deleted?

9. **Grok hop.** `bin/ops-accounts:62,94` and `skills/ops-accounts/SKILL.md:38,90` describe CRS as a
   thin hop in front of the Grok OAuth proxy. Does the CLI proxy replace that hop, or does the Grok
   path keep an optional CRS dependency?

10. **Timeline vs. the gateway.** `docs/ops/OPS-ACCOUNTS-GATEWAY.md:3` calls the gateway a "skeleton".
    Does CRS removal wait for the gateway to reach parity with the `crs-priority` / `crs-429-cooldown`
    / `crs-token-feed` control loop, or ship first and leave that gap to the optional companion?
