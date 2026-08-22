# Host vs plugin rotate-magic gap

Snapshot for making **plugin** `scripts/account-rotation/` standalone-capable
without the box-local host tree `~/.claude/scripts/account-rotation/`.

Public-repo clean: no host emails, IPs, or personal account lists.

## Summary

| Surface | Host (box-local fork) | Plugin (`claude-ops`) |
|--------|------------------------|------------------------|
| `rotate.mjs` | ~8981 lines | ~5275 lines (after this pass: soft captcha hooks) |
| Captcha helper stack | Present (full) | **Ported this pass** |
| CLIProxyAPI/legacy CRS reconcilers / priority | Present (ops + host forks) | Present (portable subset) |
| Magic-link autoloop + reauth env | Host thicker; plugin has portable `reauth-env.mjs` | Present (PR #723 era) |
| Production systemd/user units | Still point at **host** path | Templates only (`%h` / `$CLAUDE_PLUGIN_ROOT`) |

**CLIProxyAPI/legacy relay is optional.** Standalone rotate-magic (keychain + `rotate.mjs` /
`rotate-magic.mjs`) is enough for one or a few accounts. CLIProxyAPI-compatible relay mode is multi-account
load balancing / rate-limit spreading for a relay pool.

## Line-count delta (key modules)

| File | Host | Plugin (this branch) | Notes |
|------|------|----------------------|--------|
| `rotate.mjs` | 8981 | ~5275 | Host has magic-link-auto depth, OAuth harden, CRS sync, vault safety, captcha call sites throughout |
| `captcha-helper.mjs` | 1023 | 1023 | Ported; residualAfterWait + multi-provider |
| `visual-captcha-solver.mjs` | 496 | ~531 | Ported; portable desktop-act resolve + self-contained Gemini check |
| `bright-data-cascade.mjs` | 296 | 296 | Ported; env-only zones |
| `captcha-cascade.mjs` | (inlined in host rotate) | ~450 | Orchestration extract + `trySolveCaptchaWall` |
| `rotate-captcha-soft.mjs` | — | new | Soft-load helpers for rotate |
| `ensure-rotate-captcha-hooks.mjs` | — | new | Idempotent call-site patcher for public rotate.mjs |
| `reauth-env.mjs` | missing on host | 135 | Plugin-first portable env |
| `magic-link-autoloop.mjs` | ~548 | ~277 | Host fork thicker; plugin uses reauth-env |
| `CAPTCHA-CASCADE.md` | host wording | plugin contract | Plugin is SSOT contract |

Delta `rotate.mjs` ≈ **3.7k lines** still host-only (not a full port this pass).

## Files present only on host (load-bearing or related)

Minimal set operators still lean on from host for unattended reauth:

1. Full inlined captcha call sites across magic-link-auto step loop (host `rotate.mjs`)
2. `auth-repair.mjs` — 401 repair path used by host utilization
3. `rotation-vault.mjs` / `rotation-safety.mjs` — vault + process lock hardening
4. `secrets-bootstrap.mjs` — Doppler/env secret hydrate (host-coupled; not ported)
5. `virtual-display.mjs` — headed X seat helpers
6. `magic-link-cleanup.mjs` — gog trash after reauth
7. `proxy-helper.mjs` / `oauth-proxy-fetch.mjs` — residential egress helpers
8. `crs-operator.mjs`, `crs-token-refresher.mjs`, host-only CRS ops scripts
9. One-off captcha debug drivers (`solve-*.mjs`, `click-turnstile*.mjs`, `.tmp-*`) — **not** for port
10. `refresh-tokens.mjs` — unit `claude-token-refresh.service` still references host

Also host-only (ops noise / personal debug): dozens of `click-*`, `trace-*`,
`.tmp-*`, account-named captcha solvers — never port.

## Files present only in plugin (or thicker in plugin)

- `reauth-env.mjs`, `setup-account.mjs`, `bulk-setup-token.mjs`
- `provider-env.mjs` / `provider-router.mjs` (multi-provider direction)
- `vault-linux.mjs`, credit digest / kapture claim helpers
- `crs-reconciler-state.mjs`, shell wrappers for reconcilers
- Public `config.example.json`, launchd templates, install agents
- `rotate-captcha-soft.mjs`, `ensure-rotate-captcha-hooks.mjs`, `rotate-magic.mjs` ensure-on-start

## What host systemd still points at host path

Do **not** repoint production units in this PR. Observed on a typical box
(paths use `%h` or absolute host tree):

| Unit | Exec / config points at |
|------|-------------------------|
| `claude-rotation-daemon.service` | `%h/.claude/scripts/account-rotation/daemon.mjs` |
| `claude-account-rotation.service` | host `daemon.mjs` + host WorkingDirectory |
| `claude-token-refresh.service` | host `refresh-tokens.mjs` |
| `crs-magic-link-autoloop.service` | host `magic-link-autoloop.sh` |
| `crs-priority.service` | host `crs-priority-daemon.sh` |
| `crs-token-feed.service` | host `crs-token-feed.sh` |
| `crs-bedrock-guard.service` | host `crs-bedrock-guard.mjs` |
| `crs-egress-failover.service` | host `crs-egress-failover.sh` |
| Drop-ins `20-crs-config.conf` | `CRS_CONFIG=%h/.claude/scripts/account-rotation/config.json` |

Safe later end-state (not this PR): repoint to
`$CLAUDE_PLUGIN_ROOT/scripts/account-rotation/…` after cascade parity, then
archive the host fork.

## Top missing pieces in plugin `rotate.mjs` (vs host)

After this pass, cascade **modules** exist; full host `rotate.mjs` still has:

1. Dense magic-link-auto step loop captcha hooks (OTP re-submit caps, stall PNG thrash guards)
2. `completeOAuthWithGogMagicLink` / session-reuse paths
3. `rotation-safety` process lock + deadline wrappers
4. `auth-repair` on utilization 401
5. `rotation-vault` dual-backend token read/write
6. Residential Chrome / PAC / EFG proxy args for reauth browser
7. `secrets-bootstrap` before solver use
8. `virtual-display` ensure for headed seats
9. Legacy CRS push helpers (`--sync-crs-all` compatibility style)
10. Stricter OAuth callback / credential race handling

## Minimal port set (standalone plugin rotate-magic)

**Done this pass**

- `captcha-helper.mjs`
- `visual-captcha-solver.mjs`
- `bright-data-cascade.mjs`
- `captcha-cascade.mjs` (orchestration extract + `trySolveCaptchaWall` alias)
- `rotate-captcha-soft.mjs` soft-load helpers
- `ensure-rotate-captcha-hooks.mjs` — idempotent patcher that wires:
  - every `runAuthFlow` step on claude.ai/com when a **blocking** wall is detected
  - `/oauth/authorize` before Authorize
  - after inline code/link verify path
  - (keeps after-magic-link verify in `finishMagicLinkLogin`)
- `rotate-magic.mjs` runs ensure before spawning `rotate.mjs`
- Thin `rotate-magic.mjs` entry → `rotate.mjs --magic-link`
- CLIProxyAPI/legacy relay optional UX in `/ops:rotate-setup` and `/ops:rotate` skills
- Units: `__tests__/captcha-cascade.test.mjs`, `__tests__/ensure-rotate-captcha-hooks.test.mjs`

**Apply hooks on a checkout**

```bash
node scripts/account-rotation/ensure-rotate-captcha-hooks.mjs
# or via magic entry (auto):
node scripts/account-rotation/rotate-magic.mjs --to user@example.com
node scripts/account-rotation/__tests__/run-captcha-unit-tests.mjs
```

**Deferred (follow-up PRs)**

- Full host magic-link-auto depth (OTP re-submit caps, stall PNG thrash guards, session-reuse)
- Optional `secrets-bootstrap` that is env/credential-store only (no host Doppler hardcodes)
- `rotation-safety` / vault harden merge
- Repoint host systemd → plugin (operator change, not automatic)

## How to run standalone (no CRS)

```bash
export CLAUDE_PLUGIN_ROOT=/path/to/claude-ops
export CLAUDE_DESKTOP_DISPLAY=:1   # headed reauth seat
export CLAUDE_ROT_HEADED=1
# optional solver keys: TWOCAPTCHA_API_KEY, CAPSOLVER_API_KEY, …
node "$CLAUDE_PLUGIN_ROOT/scripts/account-rotation/rotate-magic.mjs" --to user@example.com
# or:
node "$CLAUDE_PLUGIN_ROOT/scripts/account-rotation/rotate.mjs" --setup --only=user@example.com --auto --skip-valid
```

See `scripts/account-rotation/CAPTCHA-CASCADE.md` and `reauth-env.mjs`.
