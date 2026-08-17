# Captcha cascade (unattended re-auth)

Contract for **unattended** re-auth owned by `magic-link-autoloop` →
`rotate.mjs` / `rotate-magic.mjs`. No interactive agent session is required.
Agents must not spawn parallel `rotate.mjs` drivers against the same fleet
(they thrash the global `.rotating` lock and the reauth browser profile).

Captcha cascade runs in standalone rotate-magic. No relay or proxy backend is involved.

## Ownership

| Component | Role |
|-----------|------|
| `magic-link-autoloop` | Serial, one account per tick; opt-in |
| `rotate.mjs` / `rotate-magic.mjs` | Browser OAuth / magic-link / setup |
| `captcha-helper.mjs` | Token solvers + residential wait (`residualAfterWait`) |
| `visual-captcha-solver.mjs` | Vision tiles + desktop-act + VNC layers |
| `bright-data-cascade.mjs` | Optional proxy-aligned solver tiers |
| `captcha-cascade.mjs` | Post-verify orchestration (`maybeSolvePostVerifyVisualChallenge`, `trySolveCaptchaWall`) |
| `rotate-captcha-soft.mjs` | Soft-load helpers for rotate |
| `ensure-rotate-captcha-hooks.mjs` | Idempotent wiring of `trySolveCaptchaWall` into rotate browser walls |

If captcha modules fail to load, the env keys below are harmless no-ops.

## Browser wall call sites (plugin rotate)

`trySolveCaptchaWall(page, reason, log)` is the public soft hook. Wired at:

1. Every `runAuthFlow` step when URL is claude.ai/com and a **blocking** wall is detected
2. `/oauth/authorize` before Authorize clicks
3. After magic-link / code verify (`finishMagicLinkLogin` + inline path)
4. `rotate-magic.mjs` runs `ensureRotateCaptchaHooks()` before spawning rotate so checkouts stay patched

## Order (when captcha helpers are present)

1. Residential / browser wait (`CLAUDE_ROT_CAPTCHA_BROWSER_WAIT_MS`)
2. **Large interactive** walls (visible hCaptcha challenge / CF frame): prefer
   autonomous cascade first (paid token inject rarely clears pick/drag).
   Override with `CLAUDE_ROT_LARGE_HC_TOKEN_FIRST=1` only when debugging.
3. Token solvers (2captcha / CapSolver / …) when keys are configured
4. Autonomous cascade (`runAutonomousCaptchaCascade` when implemented):
   - Playwright + vision tile clicks
   - **desktop-act** `act` (not pool `run`) on `CLAUDE_DESKTOP_DISPLAY`
   - VNC computer-use as last autonomous layer
5. Dashboard marker file only if all layers fail — **not** a human handoff.
   The autoloop re-dispatches after `magicLinkRetryCooldownMs`.

## Env (all optional; defaults in `reauth-env.mjs` / `magic-link-autoloop.sh`)

| Variable | Default | Meaning |
|----------|---------|---------|
| `CLAUDE_DESKTOP_DISPLAY` | `:1` | X display of headed reauth Chrome |
| `DESKTOP_ACT_DISPLAY` | same | desktop-act seat |
| `CLAUDE_ROT_HEADED` | `1` | Headed browser (required for most walls) |
| `CLAUDE_ROT_VISUAL_CAPTCHA` | `1` | Vision tile layer |
| `CLAUDE_ROT_DESKTOP_ACT` | `1` | desktop-act `act` layer |
| `CLAUDE_ROT_VNC_AGENT` | `1` | Last-resort VNC computer-use |
| `CLAUDE_ROT_CAPTCHA_MAX_ATTEMPTS` | `4` | Per-page solver budget |
| `CLAUDE_ROT_CAPTCHA_BROWSER_WAIT_MS` | `8000` | Residential wait before paid solvers |
| `CLAUDE_ROT_SKIP_TOKEN_SOLVERS` | `0` | Debug only; autoloop clears sticky `1` |
| `CLAUDE_REAUTH_DISPATCH` | `setup` | `setup` or `magic-link` |
| `CLAUDE_REAUTH_TIMEOUT_MS` | `1200000` | Child wall-clock (20m) |
| `DESKTOP_ACT_CLI` | auto | Path to desktop-act CLI if not on `PATH` |
| `DESKTOP_ACT_HOME` / `DESKTOP_ACT_VENV` | — | Optional install roots |
| `CLAUDE_PLUGIN_ROOT` | installer | Plugin root (never hardcode) |
| `CLAUDE_PLUGIN_DATA_DIR` | installer | Plugin data root |

## Background run

```bash
export CLAUDE_PLUGIN_ROOT=/path/to/claude-ops   # or rely on installer
export CLAUDE_ROTATION_ENABLE_MAGIC_LINK=1
export CLAUDE_DESKTOP_DISPLAY=:1
export CLAUDE_ROT_HEADED=1
# optional: forks with magic-link + captcha cascade in rotate.mjs
# export CLAUDE_REAUTH_DISPATCH=magic-link

bash "$CLAUDE_PLUGIN_ROOT/scripts/account-rotation/magic-link-autoloop.sh"
# or one-shot:
node "$CLAUDE_PLUGIN_ROOT/scripts/account-rotation/magic-link-autoloop.mjs"
# ensure hooks + magic:
node "$CLAUDE_PLUGIN_ROOT/scripts/account-rotation/rotate-magic.mjs" --to user@example.com
```

## Anti-patterns

- Spawning multiple agent sessions each running `rotate.mjs --magic-link --to …`
- Leaving `CLAUDE_ROT_SKIP_TOKEN_SOLVERS=1` in the unit environment permanently
- Pointing desktop-act at a **pool** display while reauth Chrome is on another seat
- Treating captcha markers as "page a human" instead of autoloop retry
