# Changelog

All notable changes to this project will be documented in this file.

## [2.8.2] — 2026-05-21

`/ops:ops-dash` rewritten as a 2026-aesthetic hybrid live command center — pixel-art hero + 12 section-by-section panels ingesting live data from every `/ops:*` skill (PR #282).

### Fixed

- **Unread counts always 0** — `bin/ops-dash` was reading `.whatsapp.count` / `.email.count` / `.slack.count` from `ops-unread`, but the actual schema is `.channels.whatsapp.recent_chats` / `.channels.email.inbox_count` / `.channels.slack.workspaces[]`. Smoke test: 90 unread now detected (was 0).
- **PR count always `?`** — `gh pr list --state open` with no `--repo` flag returns nothing when run outside a repo cwd (the bin script runs from `$HOME`). Replaced with `gh api graphql` cross-org search. Smoke test: 17 PRs now detected (was `?`).
- **Marketing project name rendered outside its parens** — cosmetic alignment fix.

### Changed

- **`bin/ops-dash` — hybrid live command center.** 12 section panels render top-to-bottom after the hero header: FIRES, INBOX, OPEN PRs, PORTFOLIO, REVENUE, MARKETING, LINEAR, DEPLOYS, COMPETITOR, YOLO, QUICK ACTIONS, footer. All probes fire in parallel via background subshells; render is sequential top-to-bottom once `wait` completes.
- **2026 visual layer** — pixel-art hero with double-line borders + drop shadow, animated braille spinner + progress bar during probe-wait, emoji icons on every section header and data row (🔥📬🔀🗂️💰📣📊🚀🕵️🤖⚡ / 💬📧💼✈️📓 / ✅⚠️🚨⏳🟢🔴🟡), unicode sparklines on time-series data (`▁▂▃▄▅▆▇█`), truecolor cyan-violet gradient palette (`38;2;R;G;B` when `$COLORTERM=truecolor`, else 256-color fallback), at-a-glance vitals strip, randomized footer one-liner.
- **Mobile/SSH graceful degradation** — detected via `$SSH_CONNECTION$SSH_CLIENT$SSH_TTY` or `$OPS_MOBILE=1`; falls back to plain-text section list, no ANSI boxes, no animations. `NO_COLOR=1` and `TERM=dumb` also honored.

### Known follow-up

- Portfolio section shows `(no git)` for registry paths stored with literal `~/` prefix (e.g. `~/my-project-api`) because `git -C` doesn't expand tildes. Cosmetic — does not affect rolled-up stats. To be fixed by tilde-expanding paths at read time.

## [2.8.1] — 2026-05-21

Hotfix: three production bugs in `/ops:ops-inbox` (PR #280).

### Fixed

- **WhatsApp bridge restart** — bare `launchctl kickstart -k gui/$UID/<label>` fails with `Could not find service` when the LaunchAgent isn't loaded (common after reboot or partial plist edit). Replaced with load-then-kickstart recipe (quoted target + `launchctl load -w "$PLIST"` fallback + `lsof -i :8080` verify). Health check now uses `launchctl print "gui/$(id -u)/<label>"` instead of `launchctl list` (which only shows already-loaded services).
- **`gog gmail thread get -j` parsing** — agents kept writing naive `d['messages']` or `d['payload']` parsers expecting the search-array shape, then crashing with `KeyError` on the actual `{thread: {messages: [{payload: {headers}}]}}` envelope. Added an explicit shape table for the three read commands and a canonical copy-paste-safe `classify_thread()` Python recipe with graceful empty/error handling. Documented the fast-path: triage from the search envelope's `labels` + `from` fields without per-thread fetches.
- **Stale plugin-version pin** — when `installed_plugins.json` (source of truth for `ops-plugin-version-heal.sh`) references a cache dir that no longer exists on disk, the heal hook becomes a no-op and downstream files keep their stale path, producing a recurring `Stop hook error: Plugin directory does not exist: …` on every turn. Added a runtime self-heal step at the top of the Runtime Context section that detects the mismatch, patches the source pin to the latest version present in the cache dir, then re-runs the existing heal script.

## [2.7.0] — 2026-05-20

`/ops:marketing` becomes the marketing control center. Every credential discoverable across Doppler/env/keychain auto-links into every project; live KPI rollup across all projects in one render; ad spend aggregated across every paid surface; Stripe revenue with UTM-attributed ROAS; Sentry crash-rate correlation flags ad-spend-at-risk projects.

Builds on v2.6.0 (`/ops:marketing <project>` point-and-go).

### Added

- **`marketing-auth-prewarm` daemon** (`scripts/ops-marketing-auth-prewarm.sh`) — nightly at 04:23 UTC, scans every Doppler project + env vars + shell profiles + macOS keychain + `~/.gcp/*.json` for marketing credentials. Classifies into 20 categories (ads_meta, ads_google, ads_tiktok, ads_linkedin, analytics_ga4, analytics_amplitude, analytics_posthog, email_resend, email_klaviyo, payments_stripe, ecommerce_shopify, fulfillment_shipbob, sms_twilio, errors_sentry, issues_linear, mta_appsflyer, prospect_apollo, infra_cloudflare, infra_vercel). Writes cache at `$OPS_DATA_DIR/marketing-auth-prewarm.json`. Initial scan across 47 Doppler projects found 19 active categories.

- **`bin/ops-marketing-link-prewarm`** — reads the prewarm cache and idempotently writes Doppler cred-refs into `marketing.projects.<key>.<category>.*` slots that are not yet configured. Modes: `--project <key>`, `--all-projects`, `--project <key> --category <cat>`. Atomic prefs writes; never overwrites existing values. Eliminates per-credential prompts during `/ops:marketing setup`.

- **`bin/ops-marketing-portfolio` extension** — new flags `--live`, `--kpis`, `--prewarm-status`. `--live` fans out in parallel to every signal source (Meta + Google Ads spend, Stripe revenue + MRR + UTM-attributed ROAS, GA4 sessions/conversions/CVR, Sentry crash-free-rate) and renders a unified KPI table. Mobile-aware per CLAUDE.md Rule 7. `--prewarm-status` surfaces untapped credentials (creds exist in Doppler but not linked to any project).

- **`scripts/lib/ad-spend-aggregator.sh`** — `ad_spend_meta`, `ad_spend_google`, `ad_spend_tiktok`, `ad_spend_linkedin`, `ad_spend_reddit`, `ad_spend_microsoft`, `ad_spend_pinterest`, `ad_spend_all`. Each normalizes to `{surface, project, spend, impressions, clicks, conversions, conversions_value, roas, window_days}`.

- **`scripts/lib/stripe-revenue.sh`** — `stripe_revenue_7d <project>` returns `{revenue_7d, charge_count, refund_count, active_mrr, active_sub_count, by_utm_source[]}`. UTM-attributed breakdown closes the ground-truth ROAS gap.

- **`scripts/lib/sentry-crash.sh`** — `sentry_crash_rate <project>` returns `{crash_free_7d, crash_free_24h, delta_dod, at_risk}`. When `at_risk == true` AND project has live ad spend, `portfolio --live` shows the project as "ad spend likely wasted today".

- **`scripts/lib/marketing-kpis.sh`** — pure functions: `kpi_roas`, `kpi_cac`, `kpi_ltv`, `kpi_payback_months`, `kpi_cvr`, `kpi_ctr`, `kpi_health_score`, `kpi_compute_all`. Derives metrics from already-fetched JSON — no external API calls.

- **`ops-marketing-provision provision-instagram` + `provision-google-ads`** verbs (from PR #266) — Meta token + page_id → IG Business Account ID auto-resolution with appsecret_proof signing; full 4-step Google Ads OAuth flow.

### Fixed

- `bin/ops-marketing-dash` — Meta + IG Graph API calls now compute and append `appsecret_proof` when `meta.app_secret` is configured. Previously the dash silently returned zeros for any project using a system-user token with "Require App Secret" enabled.

### Tests

107 tests passing across 6 test files: `test-ad-spend-aggregator.sh` (18), `test-stripe-revenue.sh` (6), `test-sentry-crash.sh` (2), `test-marketing-kpis.sh` (36), `test-ops-marketing-link-prewarm.sh` (15), `test-ops-marketing-auth-prewarm.sh` (1), plus all existing `test-ops-marketing-provision.sh` (11). Zero secrets leaked (`test-no-secrets.sh` 14/14 green).


## [2.6.0] — 2026-05-19

`/ops:marketing <project>` — point-and-go autonomous marketing agent (self-provisioning + self-healing + closed ROAS loop).

Seven PRs (#258, #260, #261, #256, #257, #262, #263) complete the arc from v2.4/v2.5's spend-bounded autopilot into a fully self-sufficient agent: it provisions its own analytics and DNS, fires its own conversion events, reads real revenue to close the ROAS loop, generates organic content as a parallel growth lane, and self-heals credential failures — all without manual intervention after the initial `/ops:marketing <project>` invocation.

### Added

- **Single-entry-point `/ops:marketing <project>`** — one command provisions, enables autopilot, and starts the loop for a new project (#258). New verbs `autopilot enable|disable|run|kill <project>` added alongside the existing `autopilot` subcommand surface. New `bin/ops-daemon-manager` shim closes a silent-fallback gap in the daemon setup flow (previously, a missing launchd plist silently fell through without error).

- **Self-provisioning across 4 surfaces** (#256, #260, #257):
  - `bin/ops-marketing-provision` — end-to-end GA4 property creation + Google Search Console site registration, full OAuth bootstrap, Doppler secret push, idempotent GET-before-create pattern throughout. Shared resolver extracted to `scripts/lib/ga4-resolve.sh` so both `ops-marketing-provision` and `ops-marketing-dash` share one GA4 lookup path (#256).
  - `bin/ops-dns-provision` — Cloudflare-API-driven DNS provisioner covering GSC TXT ownership verification, Meta AEM domain verification, SPF/DKIM/DMARC email-auth records, MX, Apple Pay domain association, and Klaviyo dedicated-sending setup. 8 named subcommands plus `audit` (diff current vs desired) and `provision-all` (idempotent full-stack). Backed by new reusable lib `scripts/lib/cloudflare-dns.sh` which any other ops bin can source for idempotent CF DNS operations (#260).
  - `bin/ops-conversion-send` (GA4 Measurement Protocol v2 event sender) + `bin/ops-meta-capi-send` (Meta Conversions API sender with SHA-256 PII hashing) + `scripts/ops-stripe-conversion-bridge.mjs` (Node.js Stripe webhook handler that fans out to GA4 MP + Meta CAPI in parallel) — closes the "we provisioned conversion secrets but never fire them" gap (#257). UTM enforcement library `scripts/lib/utm-validate.sh` + canonical attribution standard documented at `data/gtm/utm-attribution-standard.md`.

- **Closed ROAS loop (#262):** autopilot now reads real performance data on every pass — GA4 conversion events (Measurement Protocol), GSC search-analytics (clicks/impressions/CTR/position), Klaviyo flow revenue, and Stripe ground-truth revenue. Bandit reward path upgraded from Meta-CPL-only to **blended** (GA4 + Meta) when available, or **Stripe ground-truth** when `STRIPE_WEBHOOK_SECRET` is configured. New **ROAS-rescue gate**: campaigns where `stripe_revenue >= OPS_PAUSE_ROAS_FLOOR × meta_spend` are excluded from the Meta-CPL pause sweep — preventing the autopilot from pausing profitable campaigns that happen to have high CPL. UTM enforcement wired into campaign-creation paths so all new campaigns produce attributable data from day one. Shared GA4 Data API helper extracted to `scripts/lib/ga4-data-api.sh`.

- **Organic content generation (#261):** four new bins — `bin/ops-content-landing` (landing page variant generation), `bin/ops-content-seo` (SEO blog post drafting), `bin/ops-content-email` (Klaviyo email flow copy), `bin/ops-content-social` (LinkedIn/X/Instagram social calendar). Corresponding cron daemons: `content-seo` (GSC opportunity loop — surfaces high-impression/low-CTR queries, drafts posts targeting them), `content-email` (Klaviyo flow draft cadence), `content-social` (rolling 7-day social calendar). **Draft-only discipline throughout** — no bin auto-publishes, no bin auto-sends; all output is staged files + human-action recommendations, fully compliant with Rule 6. Generation is refused when `marketing.projects.<key>.brand.voice` is absent, escalating with an onboarding prompt — no wellness-defaults or placeholder voice will leak into generated copy.

- **Self-healing autopilot (#263):**
  - **Meta token auto-refresh:** error 190 (access token expired) triggers automatic long-lived token exchange via Graph OAuth `fb_exchange_token` endpoint; new token written back to Doppler immediately. Requires `marketing.projects.<key>.meta.app_id` + `meta.app_secret` in config (gracefully escalates if absent rather than silently skipping).
  - **Google Ads OAuth recovery:** refresh failures promoted from silent skip to `escalate()` with distinction between `invalid_grant` (requires re-auth, 48h outage threshold before escalating) and transient network errors (retry with backoff).
  - **Strict credential resolver:** new `resolve_cred_strict()` distinguishes "credential not configured" (rc=1, normal skip) from "Doppler key declared but value empty" (rc=2, escalate — a provisioning gap that should never silently pass).
  - **Multi-sink notify fan-out:** `notify()` now iterates the `marketing.notify.sinks` array and delivers to all configured sinks (telegram, slack, email, whatsapp) in parallel. Per-project legacy `notify_sink` string still works as single-sink fallback.
  - **`--health-check` subcommand** — probes Meta token TTL, Google Ads OAuth validity, ad-account status, Doppler secret freshness, GA4 service-account key, and GSC site auth. Exits non-zero and prints a remediation checklist on any failure. New `marketing-health-check` daemon (Sunday 08:00 UTC, disabled by default) runs this check weekly and routes failures to the notify fan-out.

### Changed

- **Rule 0 cleanup (#258):** 9 files scrubbed of real domains, emails, and repo slugs that had leaked into committed code: `bin/ops-meta-workspace-bootstrap`, `bin/ops-deploy-fix-build-trigger`, `prompts/build-fix.md`, `prompts/deploy-fix.md`, `skills/ops-secret-sync/SKILL.md`, `scripts/account-rotation/bulk-setup-token.mjs`, `scripts/lib/competitor/context.sh`, `scripts/lib/creative/context.sh`, `scripts/lib/creative/generate.sh`, `scripts/ops-gsd-registry-sync.sh`, `skills/setup/SKILL.md`. All replaced with `<placeholder>` / `$ENV_VAR` / `your-org/your-repo` forms.
- **Hardcoded brand-voice defaults removed (#258):** wellness-vocabulary defaults stripped from `bin/ops-marketing-autopilot` and `scripts/lib/creative/generate.sh`. Autopilot now refuses content generation when `brand.voice` is absent and escalates with an onboarding prompt rather than silently substituting a default voice. This prevents content intended for one brand's audience from being generated with another brand's vocabulary.
- **Per-project install marker (#258):** `${STATE_DIR}/${proj}.installed` replaces a prior global marker so each newly-added project gets its own forced dry-run on first pass, regardless of whether other projects are already installed.
- **Mutation-counter leak fix (#258):** `MUTATIONS`, `ESCALATED`, and `CREATED_CAMPAIGNS` counters now reset at the top of each project iteration, preventing counts from accumulating across projects in a single autopilot run.
- **`scripts/lib/cloudflare-dns.sh`** (#260) is a general-purpose reusable lib — any other ops bin can `source` it for idempotent Cloudflare DNS record management without duplicating CF API boilerplate.
- **`scripts/lib/ga4-data-api.sh`** (#262) extracted from `ops-marketing-dash` so both the dashboard and the autopilot share one GA4 Data API helper with consistent error handling.
- **`scripts/ops-stripe-conversion-bridge.mjs`** (#257) lives at `scripts/` as a `.mjs` Node.js module rather than `bin/` (which is bash-only by convention). Invoke via `node scripts/ops-stripe-conversion-bridge.mjs` or the provided systemd/launchd example in the file header.

### Breaking Changes

- **`META_<BRAND>_*` Doppler key pattern** — previously, per-brand Meta credentials used a hardcoded prefix. Operators with existing configurations must migrate their Doppler keys to the `META_${PROJECT^^}_*` pattern (e.g., `META_MYPROJECT_ACCESS_TOKEN`, `META_MYPROJECT_AD_ACCOUNT_ID`). The autopilot will emit a `resolve_cred_strict rc=2` escalation (not a silent skip) for any project where the old key pattern is detected, making the migration gap visible rather than silently passing with no data.
- **`OPS_DEPLOY_FIX_REPO_SLUG` + `OPS_DEPLOY_FIX_REPO_ORG`** — these env vars are now required for the build-trigger hook; previously they were hardcoded. Existing deployments must add both vars to their environment or Doppler project before the next deploy-fix invocation.
- **`marketing.projects.<key>.meta.app_id` + `meta.app_secret`** — required for Meta auto-refresh (error 190 recovery). If absent, the autopilot does not fail — it escalates with a remediation prompt — but token refresh will not be attempted and an expired token will block the Meta channel until manually rotated.

### Migration Guide

1. **Existing autopilot users** — no action required for existing projects. All new features are additive and opt-in. The autopilot's spend-safety guarantees, `create_once` default, and `--dry-run` behavior are unchanged.

2. **New project setup** — `/ops:marketing <project>` is the one-shot entry point. It runs `provision-all` (GA4 + GSC + DNS), then `autopilot enable`, then starts the daemon. For projects with existing GA4/GSC already provisioned, the GET-first idempotency pattern means re-running provision is safe.

3. **Conversion senders** — after provisioning, fire one debug event per channel to verify the full pipeline before live traffic: `bin/ops-conversion-send --debug` (GA4 MP — check Realtime in GA4 UI), `bin/ops-meta-capi-send --test-event-code <code>` (Meta — check Events Manager test events tab). Stripe bridge: deploy with `STRIPE_WEBHOOK_SECRET` set and send a `payment_intent.succeeded` test event from the Stripe dashboard.

4. **Multi-sink notify** — populate `marketing.notify.sinks` array in `preferences.json` with any combination of `["telegram", "slack", "email", "whatsapp"]`. Legacy per-project `notify_sink: "telegram"` string still works as a single-sink fallback and does not need migration.

## [2.5.0] — 2026-05-18
### Added
- **Autopilot Studio — the autonomous self-optimizing marketing agent.** Extends v2.4.0's pause-sweep autopilot into a closed compounding loop: give it a website + a spend cap + a few settings, and it researches, generates, pre-analyzes, launches, measures, and self-optimizes — bounded and auditable.
  - **Autonomy as a per-project configurable level** (`marketing.projects.*.autopilot.autonomy_level`): `create_once` (default — = the shipped spend-safety doctrine verbatim: campaign/audience/budget creation is staged under "Requires human action" until a one-time `$STATE_DIR/<project>.create-ok` token unlocks the autonomous daily loop), `sandbox` (creation allowed only when every `envelope` assert passes — `objective_allowlist`, `geo_allowlist`, `max_campaigns`, `max_new_audiences`, post-create Σ budget ≤ `max_daily_budget_usd` ≤ `daily_spend_cap_usd`), `unrestricted` (cap-bounded only; explicitly overrides the default guardrail). `envelope.kill_switch` hard-stops all creation. New `create_object()` gate, sibling of `mutate()`; all object-creation API calls isolated to one auditable gated region.
  - **Creative pre-analysis brain (`scripts/lib/creative/`)** — Tier 0 deterministic (ffmpeg/ffprobe keyframes + tesseract-or-Gemini-Flash OCR; **hard-fails garbled on-asset text**), Tier 1 Gemini 3.1 Pro multimodal (native video+audio) / Gemini Flash + copy compliance via Claude Opus 4.7, Tier 2 Opus 4.7 judge → `PASS|BLOCK|REVISE` + 0–100 prior (hard BLOCK on hallucination/policy), optional Neurons ensemble (off by default). Only a clean asset deploys PAUSED, then bandit swap-in.
  - **Self-learning calibration loop** — `scripts/lib/creative/calibrate.py` (python3 stdlib only) weekly joins the per-project creative ledger to realized KPIs and fits a monotone score→predicted-CPL calibrator; the daily pass ranks live + candidate creatives by calibrated predicted-CPL and does ε-greedy bandit allocation, reusing the existing pause/keep + `min_live_creatives` machinery. Compounds per project. New `marketing-autopilot-calibrate` daemon (`0 9 * * 1` UTC, disabled by default).
  - **Autonomous onboarding** — `source.url` → scrape → derive ICP/value-props/objectives/geo + campaign scaffold via Claude → stage (create_once) or envelope-asserted create (sandbox/unrestricted) → write `campaign_ids` back. New route `/ops:marketing autopilot onboard <url>`.
  - **Gemini gen metered safely** — every Veo 3.1 Fast / Gemini 3.1 Flash-Image generation reserved-under-lock against a separate `daily_gen_spend_cap_usd` (process-global floor, correct under N concurrent; unit-tested). Models default to verified-latest (`veo-3.1-fast-generate-preview`, `gemini-3.1-flash-image-preview`, `gemini-3.1-pro-preview`, `claude-opus-4-7`).
  - `skills/ops-marketing/SKILL.md`, `skills/setup/channels/marketing.md`, `skills/ops-settings/SKILL.md` — autonomy levels & envelope, Tier 0–3 brain, calibration loop, onboarding; per-project config surfaces. `tests/` — reworked `test-autopilot-cap.sh` (gated-region scan), new `test-autopilot-autonomy.sh` + `test-autopilot-calibrate.py`.
- **Spend-safety unchanged and unconditional:** no `daily_spend_cap_usd` ⇒ refuse; cap pre-flight, runaway `amount_spent` abort, pause-only-down to `min_live_creatives`, first-run/`--dry-run` forced dry, kill_switch, and the metered-gen ceiling all hold regardless of `autonomy_level`. The default (`create_once`) is the v2.4.0 doctrine verbatim — operators consciously opt up; the guardrail is never silently removed.

## [2.4.0] — 2026-05-18
### Added
- **Autonomous ad management ("autopilot") for `/ops:marketing`.** Productizes the per-project autonomous ad optimizer into a reusable, config-driven capability — daily Meta + Google Ads optimization bounded by a mandatory per-project spend cap.
  - `bin/ops-marketing-autopilot` — iterates `marketing.projects.*` where `autopilot.enabled`. Per project/channel: hard cap pre-flight, deterministic worst-first pause sweep (keeps ≥ `min_live_creatives` live), creative-fatigue detection. All money-touching logic is bash (no LLM in the path); creative regeneration + frame hallucination audit + weekly synthesis are delegated to a credit-pool-gated headless `claude_invoke` pass with a self-contained prompt built from project config. Flags: `--dry-run`, `--project`, `--channel`.
  - `scripts/ops-cron-marketing-autopilot.sh` — thin daemon wrapper.
  - `daemon-services.default.json` — new `marketing-autopilot` service (disabled by default, `0 8 * * *` UTC, opt-in via `/ops:setup marketing`).
  - `skills/ops-marketing/SKILL.md` — `autopilot` sub-command route + full doctrine section. `skills/setup/channels/marketing.md` — autopilot opt-in block (spend cap, channels, regen).
  - `tests/test-autopilot-cap.sh` — asserts the spend-safety invariants.
- **Spend-safety (NEVER LEAK MONEY + Rule 5):** no `daily_spend_cap_usd` ⇒ refuse + escalate; Σ campaign budget > cap or runaway `amount_spent` ⇒ abort + escalation note, zero mutations. Autopilot may only pause/swap/regenerate creatives — budget raises, campaign/audience creation, and objective changes are written as human-action recommendations, never executed. `--dry-run` + first install run forced dry.

## [2.3.2] — 2026-05-17
### Changed
- **Docs/wiki/metadata sync for v2.3.x.** Producer side (v2.3.0) and consumer side (v2.3.1) shipped without doc surface updates; v2.3.2 catches everything up.
  - `README.md`: new "Competitor Intelligence (v2.3)" section with pipeline overview, signal-source matrix, consumer integrations, config schema, cost model. Daemon-services list now reflects `competitor-intel` (Mon 10:00), `competitor-alert` (every 10 min), and `competitor-daily` (17:00). `/ops:competitors` added to the skills table. Skill count bumped 30 → 36.
  - `claude-ops/docs/daemon-guide.md`: 3 competitor cron services listed with correct cadence + purpose.
  - `claude-ops/docs/agents-reference.md`: each of `yolo-ceo`/`cto`/`cfo`/`coo` now documents its `competitor_vertical_slice` source and how the slice folds into the analysis.
  - `claude-ops/docs/skills-reference.md`: `/ops:competitors` entry added with all 6 subcommands.
  - Wiki: new `Competitor-Intelligence.md` page covering full architecture + signal sources + severity routing + consumer integrations + state/reports layout + cost model + operational commands. Sidebar updated. Version stamp bumped 2.2.0 → 2.3.2.
  - Skill count drift fixed: `plugin.json` + `marketplace.json` descriptions now say "36 skills, 18 agents" (was "35 skills") to reflect the new `/ops:competitors` skill.

## [2.3.1] — 2026-05-17
### Added
- **Competitor-intel outputs now consumed across the plugin.** v2.3.0 shipped the producer side (signal collectors, severity routing, weekly synthesis). v2.3.1 wires the consumer side so the data actually shows up where decisions get made:

  **Shared context lib** (`scripts/lib/competitor/context.sh`, 292 lines):
  - `competitor_context [--brand X] [--window-days N] [--severity S]` — aggregated JSON with brands list, per-brand state + latest report path, events in window grouped by severity, pending queue sizes.
  - `competitor_briefing_line` — one-line summary for briefing surfaces.
  - `competitor_priority_items --top N` — bullet list of high-severity events for priority advisors.
  - `competitor_vertical_slice <vertical>` — role-filtered slices (`marketing`, `ecom`, `ceo`, `cfo`, `coo`, `cto`) so each consumer gets only what's relevant to its lens.
  - jq-only, no external calls — cheap enough to read on every command invocation.

  **`/ops:go` morning briefing**: new `COMPETITOR` row in `bin/ops-gather` (parallel gather, skipped silently when unconfigured) shows alerts count, med-delta count, last_run, plus top-3 event snippets. Mobile mode compresses to `comp: N alerts (top: brief)`.

  **`/ops:next` priority stack**: high-severity competitor events now slot between `fires` and `unread comms` as Priority 2, framed as `REACT: <competitor> <source> changed — see latest-<brand>.md`. Downstream priorities renumbered 3→6.

  **`/ops:marketing`**: new "Competitor signals (last 7d)" section in dashboard — PRICING MOVES (campaign-react triggers), FUNDING/NEWS (positioning opportunities), SENTIMENT (Reddit/HN themes). Skipped when slice is empty.

  **`/ops:ecom`**: new "Competitor activity (last 7d)" section — APP RELEASES (App Store version snapshots), PRODUCT/PRICING CHANGES (feature + pricing page diffs).

  **`/ops:yolo` C-suite agents**: each of CEO/CTO/CFO/COO agent files (`agents/yolo-{ceo,cto,cfo,coo}.md`) now sources `competitor_vertical_slice <role>` and weaves role-specific signals into their analysis. CEO sees new entrants + funding; CFO sees pricing diffs with money tokens; COO sees Greenhouse/Lever hiring signals; CTO sees changelog/feature page-diffs.

  **New `/ops:competitors` skill** + `bin/ops-competitors` CLI:
  - Dashboard mode (no args): all tracked brands with alert counts, last_run, recent high events.
  - Drill-down (`ops-competitors <brand>`): 30d event timeline, top competitors, latest report excerpt.
  - `refresh [brand]` — manually trigger the weekly cron immediately, optional per-brand env override.
  - `add-url <brand> <competitor> <kind> <url>` — jq-merges a page-diff URL into `preferences.json` with confirm prompt.
  - `alerts` — tail last 20 of `reports/competitor-intel/alerts.log`.
  - Mobile-aware rendering, no external deps beyond curl + jq.

## [2.3.0] — 2026-05-17
### Added
- **Competitor-intel v2.3 — full pipeline redesign with 5 signal sources, severity-tiered routing, and append-only event log.** Goes from "weekly Tavily dump + Sonnet synth" to a real CI system that rivals Crayon/Klue/Kompyte's signal breadth at $0 incremental cost.

  **New signal collectors** (`scripts/lib/competitor/`, all bash + jq + curl, no extra deps):
  - `reddit-search.sh` — Reddit JSON API (no auth), severity-classified by score + keyword heuristics (complaint, vs, alternative, switching from).
  - `hn-search.sh` — HN Algolia API (no auth), severity by points + comments + Show HN/Launch HN/is hiring detection.
  - `appstore-lookup.sh` — Apple iTunes Lookup API (no auth), version + rating + release-date snapshots for mobile competitors (opt-in via `preferences.json .competitor_intel.app_store: true`).
  - `jobs-feed.sh` — Greenhouse + Lever public job APIs (no auth), strategic-hire detection (VP / Head of / Director / Chief / Founding → high severity).
  - `page-diff.sh` — HTML pricing/features/careers/changelog page-diff engine. Fetches with curl, normalizes via Python (strip script/style/svg, decode entities, collapse whitespace), SHA-256, persists snapshots to `competitor_state/<brand>/<comp>/snapshots/<kind>.<sha8>.txt` with `<kind>.latest` symlink. Diffs emit lines-changed + extracted snippet. Severity: pricing-page change with money token (`$`, `€`, `/mo`, `/yr`) → high; other pricing/features/changelog → med; tiny copy tweaks → low. Last 12 snapshots retained per kind.

  **Severity-tiered routing** (`scripts/lib/competitor/event-router.sh` + 2 new crons):
  - All events append to `competitor_state/events.jsonl` (audit log).
  - `severity: high` → also writes to `queue/immediate.jsonl`, drained every 10min by `ops-competitor-alert.sh` (Telegram push if creds + always `alerts.log`).
  - `severity: med` → `queue/daily.jsonl`, drained at 17:00 by `ops-cron-competitor-daily.sh` (grouped-by-competitor roll-up, dated daily-YYYY-MM-DD.md + Telegram digest with 4000-char cap).
  - `severity: low` → state-only, surfaced in weekly strategic synthesis.

  **Weekly cron pipeline rewrite** (`ops-cron-competitor-intel.sh`, 432 lines):
  - Discovery cached 30d (skips Tavily when state has fresh `last_discovery`, saving ~60% Tavily spend).
  - Per-competitor signals collected in parallel background jobs with 30s timeout guards; page-diff URLs read per-competitor from `preferences.json .competitor_intel.urls.<competitor>`.
  - Reads 7d window of `events.jsonl` (jq epoch filter) and merges into Sonnet prompt (capped at 100k chars).
  - Raw synthesis always persisted to `reports/competitor-intel/YYYY-MM-DD_<brand>-synthesis.md` BEFORE extraction so partial LLM output is never lost.
  - State extended with `last_discovery` and `app_store_enabled` keys (backward compat with v2.2.5 `competitors` + `last_run` preserved).
  - Graceful degradation: missing `TAVILY_API_KEY` AND no cached state → SKIP cleanly; missing Tavily but cached state present → proceed with non-Tavily signals only.

  **Daemon services config** — `competitor-alert` (`*/10 * * * *`) and `competitor-daily` (`0 17 * * *`) added to `daemon-services.default.json` and `daemon-services.example.json` alongside existing weekly `competitor-intel` (`0 10 * * 1` Europe/Amsterdam).

  **Cost model at 10-brand scale**: ~13 Tavily calls/wk total (cached discovery), ~320k Sonnet tokens/mo on Max-OAuth — $0 incremental.

## [2.2.5] — 2026-05-17
### Fixed
- **`competitor-intel` LLM synth dropped to raw Tavily fallback when output didn't include `---REPORT---` marker.** Sonnet was producing valid strategic deltas but the strict marker check threw them away. Three-strategy JSON extraction now: (1) fenced ` ```json ` block, (2) bare `{"competitors":[...]}` regex anywhere in output, (3) bullet-list scrape from "NEW entrants" / "Competitor moves" sections. Report extraction now falls back to stripping JSON blocks from full synthesis instead of dropping to raw Tavily dump.
- **Weekly reports invisible without Telegram bot configured.** Cron now writes every report to `$DATA_DIR/reports/competitor-intel/YYYY-MM-DD_<brand>.md` and maintains a `latest-<brand>.md` symlink. Telegram push is now additive — disk write happens unconditionally, even when bot creds are missing.

## [2.2.4] — 2026-05-17
### Fixed
- **Daemon silent crash-loop under launchd.** `scripts/ops-daemon.sh` included `com.claude-ops.daemon` in its own `EXPECTED_SERVICES` self-healing list. On startup the ENSURE loop read its own previous launchctl `exit=1` status (a normal post-install state), called `launchctl kickstart "gui/$UID/com.claude-ops.daemon"`, received SIGTERM, and respawned every ~30s via launchd's `ThrottleInterval`. Net effect: no `daemon-health.json` refresh, no service supervision, no message-listener, but `launchctl list` showed the entry registered with exit=1, no PID. Removed `com.claude-ops.daemon` from `EXPECTED_SERVICES` (launchd's `KeepAlive=true` already handles auto-restart). Also removed the decommissioned `com.claude-ops.wacli-keepalive` entry — it was a v2.0.3 leftover whose plist no longer ships, causing noisy "cannot repair — missing bash or source plist" log entries every monitor cycle. `install_daemon_launchd()` cleaned up to stop trying to install the non-existent wacli plist. (#241)

## [2.2.3] — 2026-05-17
### Fixed
- **Doppler MCP server failed to connect on every reload.** Plugin's `.mcp.json` invoked `npx -y @dopplerhq/mcp-server` which tries to run a binary matching the package name. The actual bin is `doppler-mcp` (`bin: { "doppler-mcp": "bin/doppler-mcp" }`), so npx couldn't find a command and exited with `command not found`. Switched to `npx -y -p @dopplerhq/mcp-server doppler-mcp` form which explicitly names the binary, eliminating the `Failed to connect` error from `/reload-plugins`.

## [2.2.2] — 2026-05-16
### Changed
- **`competitor-intel` cron rewritten as self-discovering LLM-driven analyzer.** Previous version posted Telegram digests from 2 hardcoded queries (`COMPETITOR_A_QUERY`, `COMPETITOR_B_QUERY`, `BRAND_QUERY`) that `/ops:setup` never collected — every Monday at 10am the cron broadcast placeholder garbage like `"competitor-a reviews 2026"`. New pipeline: Tavily discovery pass auto-surfaces the current competitor landscape for `{brand_name}` in `{category}`; diffs against persisted `competitor_state.json` to flag NEW entrants week-over-week; runs per-competitor news searches (pricing/launches/funding/layoffs, last 7d); brand-mention pass; Sonnet synthesis (`claude_invoke`, ~5–10k tokens/week against Max-OAuth, no API billing) produces a one-page strategic delta with NEW entrants / competitor moves / brand signal / threats & opportunities. Graceful degradation: missing `TAVILY_API_KEY` → SKIP and exit 0; missing `claude_invoke` or empty LLM response → raw Tavily fallback. (#237)
- **`/ops:setup` gates `competitor-intel` per Rule 3.** Step 5b-i now asks `[Configure now]` / `[Skip — disable]` instead of always-enabling. Configure path collects 2 free-text values (`brand_name`, `category`) — system auto-discovers competitors instead of hardcoding them. Skip path sets `enabled: false` in `daemon-services.json`. (#234, #237)

### Schema
- `preferences.json` `.competitor_intel` shape changed:
  - **Before:** `{competitor_a_query, competitor_b_query, brand_query, report_timezone}`
  - **After:** `{brand_name, category, max_competitors, report_timezone}` (cron auto-discovers; state persisted at `$DATA_DIR/competitor_state.json`)

## [2.2.1] — 2026-05-16
### Fixed
- **Plugin load error: `marketplace.json` rejected by validator.** Removed unsupported `screenshots` key from `.claude-plugin/marketplace.json`. `claude plugin validate` was reporting `Unrecognized key: "screenshots"` and the Claude Code loader surfaced this as an error on `/reload-plugins`.

## [2.2.0] — 2026-05-16
### Fixed
- **Plugin installation blocked by unsupported `enum` keys in `plugin.json`.** Claude Code's plugin validator rejects `enum` as an unrecognized key in userConfig fields. Removed `enum` from 7 fields (`fix_model`, `max_fixes_per_hour`, `watcher_timeout_seconds`, `notify_channel`, `task_reminder_threshold`, `aws_region`, `doppler_config`) and moved allowed values into descriptions.
- **`ops-package` SKILL.md YAML frontmatter parse error.** Unquoted colon in description field caused YAML parse failure, silently dropping all frontmatter metadata at runtime. Wrapped in quotes.
- **Version number alignment.** Synchronized version across `plugin.json` (was 2.0.6), `package.json` (was 1.7.2), and `marketplace.json` (was 2.0.6) to 2.2.0.
- **Plugin description counts updated.** Changed "30 skills, 14 agents" to "35 skills, 18 agents" to match actual inventory.
- **Deploy-fix test suite: 45/45 passing (was 39/45).** Refactored `dispatch_fix_agent` from template-based (`prompts/*.md`) to agent-based dispatch (`claude --agent <name>`). Fixed `is_transient` regex line continuations. Fixed `resolve_health_url`/`resolve_version_url` multi-`local` cross-references. Updated test cases to use real agent names (`build-fixer`, `deploy-fixer`).
- **`set -e` safety for `locate_repo` and `resolve_*` functions.** Added `|| true` guards so `locate_repo` returning 1 no longer aborts `ops-deploy-fix-build-trigger` under `set -e`. Added explicit `return 0` to `resolve_health_url` and `resolve_version_url`.
- **Account rotation stdin handling.** Fixed `claude -p` subprocess invocation in `bulk-setup-token.mjs` and `kapture-claim-credits.mjs` to explicitly close stdin via `stdio: ['ignore','pipe','pipe']`, preventing newer CLI versions from warning about missing stdin.

## [2.0.6] — 2026-04-30

### Added

- **`/ops:credentials` skill + `bin/ops-credentials` audit CLI.** Scans shell env, ops preferences.json, Doppler (resolves `doppler:KEY` references live), macOS Keychain, and Dashlane to report which integration credentials are configured vs missing. Output formats: human table (default), JSON (`--json`), single-service filter (`--service stripe`). Values masked as `first6•••last4`; never prints raw secrets. Auto-switches to compact one-line-per-cred format on SSH/mobile (`$SSH_CONNECTION` or `$OPS_MOBILE=1` per Rule 7). Solves the "Claude Code settings UI can't see my keychain" problem — users can now check at a glance which integrations are ready to use.
- **Credential field hints in plugin.json descriptions.** All 22 credential fields now include "If already configured via /ops:setup or stored in keychain/Doppler, leave blank — runtime resolves automatically" in their description, so users don't waste time pasting values that are already in scope.

## [2.0.5] — 2026-04-30

### Fixed

- **Plugin settings UI: enums + sensitive flags.** Added `enum` to every userConfig field with a finite known value space — `fix_model` (opus/sonnet/haiku), `notify_channel` (macos/ntfy/pushover/discord/telegram/none), `aws_region` (16 regions), `max_fixes_per_hour` (1/3/5/10), `task_reminder_threshold` (5/10/20/50), `watcher_timeout_seconds` (5min–1hr buckets), `doppler_config` (dev/stg/prd/ci). Marked 22 credential fields `sensitive: true` so the settings UI masks them: Telegram api_hash/session, Klaviyo, Meta Ads, Shopify admin, ShipBob, Bland AI, ElevenLabs, Groq, Stripe, RevenueCat, Datadog, New Relic, Pushover, Discord bot/webhook, Doppler token, DPD password, UPS/FedEx client secrets. Remaining text inputs are user-specific identifiers (Sentry org slug, Linear team key, store URLs, account/customer IDs) with no enumerable value space — freeform text is correct for those.

## [2.0.4] — 2026-04-30

### Fixed

- **Registry path resolution: survive plugin updates.** Bin scripts read `registry.json` from `$PLUGIN_ROOT/scripts/registry.json` (the cache path), which is wiped on every plugin upgrade. Symptom: after a version bump, `/ops:ops-dash` and friends report "No project registry found" until the user manually re-runs `/ops:setup`, even though their data-dir registry is intact. Introduced `lib/registry-path.sh` that resolves `OPS_DATA_DIR` and `REGISTRY` with precedence: data-dir → caller-supplied legacy fallback → `$PLUGIN_ROOT/scripts` → canonical default. Patched `bin/ops-dash`, `ops-merge-scan`, `ops-ci`, `ops-external`, `ops-infra`, `ops-prs`, `ops-git`, `ops-doctor`, `ops-setup-detect`, and `scripts/ops-daemon.sh::prefetch_project_health`. `bin/ops-projects` already followed this pattern; this brings the rest of the surface in line. (#180)

## [2.0.3] — 2026-04-30

### Fixed

- **Daemon: WhatsApp state now reads from Baileys bridge `messages.db` directly.** Removed last 4 references to deprecated `wacli_chats.json` / `wacli_urgent.json` keepalive caches in `scripts/ops-daemon.sh` (briefing refresh, urgent-message detection, smart memory trigger, contact activity index). Briefings no longer surface false "WhatsApp disconnected" warnings when the bridge is healthy.

### Added

- **`bin/ops-post-update-migrate`: auto-fire migrations on plugin update.** Wired into `hooks/hooks.json` SessionStart and `scripts/ops-daemon-manager.sh ensure-current`. Idempotent, gated by per-version sentinel (`$DATA_DIR/.migrated/v<VERSION>`), wall-clock budget 60s. Currently runs: `whatsapp-bridge-migrate.sh` (FTS5 + contacts), refreshes `com.claude-ops.whatsapp-bridge` LaunchAgent, decommissions stale `com.claude-ops.wacli-keepalive` plist. Future migrations chain into `run_migrations()`.

## [Unreleased] — 2026-04-27

### Changed

- **Decommission wacli daemon. WhatsApp ops now Baileys-only via `mcp__whatsapp__*`.** Migration script in `scripts/whatsapp-bridge-migrate.sh`.
  - All skill references to `wacli chats list`, `wacli messages list/search`, `wacli contacts --search`, `wacli send`, `wacli history backfill`, and `wacli doctor` replaced with `mcp__whatsapp__*` tool calls or direct `sqlite3` queries against the bridge `messages.db`.
  - `scripts/wacli-keepalive.sh` and `scripts/com.claude-ops.wacli-keepalive.plist` moved to `legacy/` (preserved for reference).
  - `bin/wacli-health` rewritten to check bridge port 8080 and launchd status.
  - `bin/wacli-safe` replaced with a deprecation shim.
  - New `bin/ops-pretool-whatsapp-bridge-health` PreToolUse hook for bridge liveness.
  - New `assets/launchagents/com.${USER}.whatsapp-bridge.plist` template.
  - `scripts/whatsapp-bridge-migrate.sh`: idempotent FTS5 virtual table + contacts table migration for `messages.db`; seeds contacts from macOS Contacts.app via osascript.

### Migration steps (manual, post-merge)

1. Run `scripts/whatsapp-bridge-migrate.sh` to add FTS5 index and contacts table to bridge `messages.db`.
2. Revoke the wacli linked device on your phone (WhatsApp → Settings → Linked Devices).
3. `launchctl bootout gui/$UID ~/Library/LaunchAgents/com.claude-ops.wacli-keepalive.plist 2>/dev/null || true`
4. `rm -f ~/Library/LaunchAgents/com.claude-ops.wacli-keepalive.plist`

### Rollback

WhatsApp supports 4 linked devices. Re-link wacli at any time:
```bash
wacli auth   # scan QR
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.claude-ops.wacli-keepalive.plist
```
History from before rollback won't be in new wacli store, but bridge keeps running independently — no message loss.

---

## [2.0.0] — 2026-04-26

> **Major release.** Purely additive — no behavior of any v1.x skill changes by default. Existing users can upgrade in place. Every new subsystem is gated by a `userConfig` toggle (defaults documented per-feature below) and can be turned off from `/plugins` settings without uninstalling. See [`docs/migrating-from-v1.md`](docs/migrating-from-v1.md) and the [Migrating-from-v1 wiki page](https://github.com/Lifecycle-Innovations-Limited/claude-ops/wiki/Migrating-from-v1).

### Headline

v2.0 turns claude-ops from a *briefing + comms surface* into an **autonomy layer** for Claude Code itself. It now:

1. Watches every `gh pr merge` you run, follows the deploy workflow, audits service health + verifies the served commit, and dispatches a Haiku **deploy-fixer** if anything goes wrong (PR #158).
2. Watches every `npm run build:*`, parses the failure, and dispatches a Haiku **build-fixer** (PR #158).
3. Pre-installs four specialist subagents (`general-purpose`, `deploy-fixer`, `build-fixer`, `dependency-auditor`) and silently swaps `general-purpose` → matching specialist via a PreToolUse hook on `Agent` (PRs #161, #162).
4. Ships three universal **safety hooks** that block the most common foot-guns: secrets-in-staged-diff, `rm -rf` against anchor paths, and direct `git push` to `main` (PR #163).
5. Periodically nudges Claude to use `Task*` tools when a session has gone N tool calls without one (PR #163).
6. Runs a **recap marquee daemon** that synthesises a one-line digest across all parallel Claude sessions and surfaces it in tmux `status-right` or the Claude Code `statusLine` (PR #160).
7. Folds in a **multi-account Claude Max rotator** with launchd daemon + AI-brain heuristics so you never blow a weekly cap (PR #160).
8. Expands `/ops:setup` with steps 2d, 3o, and 6.5a–6.5d so every new subsystem has a guided wizard.
9. Overhauls `plugin.json` `userConfig` so 19+ entries render as proper spacebar-toggle booleans / numeric caps / file pickers in `/plugins` settings (PR #164).
10. Adds two new test scripts (`tests/test-deploy-fix-hooks.sh`, `tests/test-safety-hooks.sh`) wired into `tests/run-all.sh` (PR #163).

### Added

#### 1. Deploy auto-fix subsystem — `/ops:deploy-fix` (PR #158)

The flagship v2 feature. Watches your merges and your local builds; verifies the result; auto-fixes failures.

- **`hooks/hooks.json` PostToolUse:Bash → `bin/ops-deploy-fix-merge-trigger`** — fires on `gh pr merge *`, parses repo + PR + base + sha, spawns `scripts/ops-deploy-monitor.sh` in the background. The monitor:
  1. Polls the deploy GitHub Actions workflow until completion (regex configurable via `deploy_workflow_pattern`, default `deploy|Deploy|build|Build|ECS|cd|CD`).
  2. On success: optionally `curl`s the service `/health` URL and verifies `/version` returns the merged SHA.
  3. On failure: classifies as **transient** (npm registry blip, rate limit, network timeout) and `gh run rerun`s, OR dispatches a headless Haiku `deploy-fixer` agent with the failing log tail injected into [`prompts/deploy-fix.md`](prompts/deploy-fix.md).
- **`hooks/hooks.json` PostToolUse:Bash → `bin/ops-deploy-fix-build-trigger`** — fires on `npm run build:*`, parses the local build script output, dispatches a Haiku `build-fixer` agent with [`prompts/build-fix.md`](prompts/build-fix.md). Single-flight per repo.
- **`scripts/lib/deploy-fix-common.sh`** — shared library: single-flight lock acquisition, per-repo hourly budget cap (default 3, see `max_fixes_per_hour`), content-hash dedup, transient classifier, notify dispatcher.
- **Layered service registry**: project `.claude/post-merge-services.json` → user `~/.claude/config/post-merge-services.json` → plugin `config/post-merge-services.example.json`. Maps `owner/repo:base` → `{ health_url, version_url, deploy_workflow }`.
- **Notification channel** (`notify_channel` userConfig): `macos` (osascript), `ntfy` (ntfy.sh topic), `pushover`, `discord` webhook, `telegram`, or `none`.
- **`/ops:deploy-fix` skill** — `status` (live runs, today's history, budget remaining), `tail <run-id>` (stream the monitor log), `configure` (open the registry), `test` (dry-run the hook against a synthetic merge).
- **userConfig toggles** (all spacebar-toggleable in `/plugins` settings): `deploy_fix_enabled`, `monitor_post_merge`, `monitor_build_failures`, `auto_dispatch_fixer`, `allow_dangerous`, `auto_rerun_transients`, `audit_health_after_deploy`, `verify_served_commit`, `fix_model`, `max_fixes_per_hour`, `watcher_timeout_seconds`, `registry_path`, `repo_search_roots`, `deploy_workflow_pattern`, `notify_channel`. See [`docs/deploy-fix.md`](docs/deploy-fix.md) for the full table with defaults.

#### 2. Specialized agent system (PRs #161, #162)

- [`agents/general-purpose.md`](agents/general-purpose.md) — local override that limits the default agent to research and read-only investigation.
- [`agents/deploy-fixer.md`](agents/deploy-fixer.md) — single-shot SRE persona invoked by the deploy auto-fix subsystem.
- [`agents/build-fixer.md`](agents/build-fixer.md) — focused TypeScript/bundler error fixer for local build failures.
- [`agents/dependency-auditor.md`](agents/dependency-auditor.md) — runs `npm audit` / `pip-audit` / SCA equivalents and proposes minimal upgrades.
- **`bin/ops-suggest-specialized-agent`** — PreToolUse hook on `Agent`. When `subagent_type=general-purpose`, inspects the prompt against [`config/specialist-keywords.example.json`](config/specialist-keywords.example.json) (also user-extensible at `~/.claude/config/specialist-keywords.json`) and **silently swaps** to the matching specialist via `updatedInput`. If no match, fires a Haiku drafter that proposes a brand-new agent file under `~/.claude/agents/`.
- **userConfig**: `suggest_specialized_agents` (default `true`).
- **Deep dive**: [`docs/agents.md`](docs/agents.md).

#### 3. Universal safety hooks (PR #163)

Three PreToolUse:Bash hooks. Always-on by design; per-hook escape via `permissionDecision`.

- **`bin/ops-prevent-secret-commit`** — denies `git commit` when the staged diff matches secret patterns (AWS keys, GitHub PATs, Slack tokens, OpenAI/Anthropic keys, `.env` content).
- **`bin/ops-no-rm-rf-anchor`** — denies `rm -rf` when the resolved target is `/`, `~`, `$HOME`, `..`, or `.`. Symlink-resolved before the check.
- **`bin/ops-warn-mainpush`** — fires `permissionDecision: ask` when the user runs `git push` and the current branch is `main`/`master`/`prod`/`production`.
- **Deep dive**: [`docs/safety-hooks.md`](docs/safety-hooks.md).

#### 4. Universal Task* tracking nudge (PR #163)

- **`bin/ops-task-reminder`** — PostToolUse `*` hook. Increments a session-scoped counter on every non-Task tool call. When the counter exceeds `task_reminder_threshold` (default `10`), emits a single `additionalContext` line nudging Claude to use `TaskCreate` / `TaskUpdate` / `TaskList`. Counter resets when any `Task*` tool fires.
- **userConfig**: `task_reminder_enabled` (default `true`), `task_reminder_threshold` (default `10`, range `3..50`).

#### 5. Recap marquee daemon — `/ops:recap` (PR #160)

- **`scripts/recap/daemon.sh`** — long-lived loop, every 30s reads tool-activity logs from `hooks/recap-tool-activity.sh` + per-session captures from `hooks/recap-capture.sh`.
- **`scripts/recap/digest.sh`** — synthesises the digest (active session count, latest action per session, fire flags).
- **`scripts/recap/marquee.sh`** — formats the digest as a one-line ANSI string for tmux `status-right`.
- **`templates/com.claude-ops.recap-daemon.plist`** — launchd unit; systemd alternative documented inline in [`docs/recap.md`](docs/recap.md).
- **`/ops:recap` skill** — `status`, `tail`, `configure`, `restart`.
- **`/ops:setup` step 2d** — auto-appends the marquee source to `~/.tmux.conf` (or wires the Claude Code `statusLine` if no tmux is detected).
- **userConfig**: `recap_marquee_enabled` (default `true`), `recap_marquee_auto_configure_tmux` (default `true`).

#### 6. Multi-account Claude Max rotator — `/ops:rotate` + `/ops:rotate-setup` (PR #160)

- **`scripts/account-rotation/rotate.mjs`** — swaps the `Claude Code-credentials` keychain entry to the next configured account.
- **`scripts/account-rotation/daemon.mjs`** — launchd-managed; polls each account's usage every N minutes and rotates *before* hitting the cap.
- **`scripts/account-rotation/ai-brain.mjs`** — Haiku-powered heuristic that decides which account to rotate to based on remaining quota + recent usage trajectory.
- **`scripts/account-rotation/setup-account.mjs`** — OAuth init for one account.
- **`scripts/account-rotation/force-rotate.sh`** — manual override.
- **`templates/com.claude-ops.account-rotation.plist`** — launchd unit.
- **`/ops:rotate`** — manual rotate. **`/ops:rotate-setup`** — interactive multi-account onboarding.
- **`/ops:setup` step 3o** — walks through OAuth init for every configured account that lacks a keychain token.
- **userConfig**: `account_rotation_enabled` (default `false` — opt-in), `account_rotation_setup_oauth_each` (default `true`).
- **Hard guardrail**: rotator refuses any account with overage billing enabled unless `--allow-extra-usage` is passed.

#### 7. `/ops:setup` wizard — new steps

- **Step 2d** — recap marquee install + tmux/`statusLine` configuration.
- **Step 3o** — Claude Max account OAuth init loop (one prompt per configured account).
- **Step 6.5a** — deploy auto-fix toggle + registry path picker.
- **Step 6.5b** — recap marquee toggle.
- **Step 6.5c** — task reminder toggle + threshold.
- **Step 6.5d** — account rotator toggle.

#### 8. `plugin.json` userConfig overhaul (PR #164)

19+ new entries. Existing string entries swept to proper types so they render correctly in `/plugins` settings:

- `ga4_property_id`, `newrelic_account_id` — `string` → `number`.
- `aws_region` — description improved with valid options.
- All new toggles use `type: boolean` with explicit `default` so they're spacebar-toggleable.
- All new caps use `type: number` with `min`/`max`.
- `registry_path` uses `type: file` for native file picker.

#### 9. Test suite expansion (PR #163)

- **`tests/test-deploy-fix-hooks.sh`** — 39 assertions across 11 cases (trigger detection, transient classification, dedup, budget cap, single-flight lock, registry layering, notify dispatch).
- **`tests/test-safety-hooks.sh`** — 45/45 pass (each safety hook gets positive + negative tests).
- Both wired into `tests/run-all.sh`.

#### 10. New documentation

- [`docs/deploy-fix.md`](docs/deploy-fix.md), [`docs/agents.md`](docs/agents.md), [`docs/safety-hooks.md`](docs/safety-hooks.md), [`docs/recap.md`](docs/recap.md), [`docs/migrating-from-v1.md`](docs/migrating-from-v1.md), [`docs/INDEX.md`](docs/INDEX.md).
- Wiki: `Auto-Fix-Subsystem`, `Specialized-Agents`, `Safety-Hooks`, `Recap-Marquee`, `Multi-Account-Rotator`, `Migrating-from-v1` (new); `Home`, `Sidebar`, `Setup-Wizard`, `Configuration` (updated).

### Changed

- **Default agent for tool dispatch** is no longer raw `general-purpose`. The PreToolUse hook now silently routes via the specialist keyword map. To restore v1 behaviour, set `suggest_specialized_agents: false`.
- **`/ops:setup`** has six new steps (2d, 3o, 6.5a, 6.5b, 6.5c, 6.5d). Existing steps are unchanged.
- **`plugin.json` description + keywords** rewritten to mention the v2 surface.
- **`README.md` + `claude-ops/README.md`** front-load a "What's new in v2.0" section before the existing feature list.

### Migration

**No breaking changes.** Every v2 subsystem is opt-out via a `userConfig` toggle. Existing v1 settings, registries, preferences, and daemon services are unchanged. Upgrade in place:

```bash
# inside Claude Code:
/plugin update ops@lifecycle-innovations-limited-claude-ops
/ops:setup   # walks through the 6 new steps; safe to skip any
```

See [`docs/migrating-from-v1.md`](docs/migrating-from-v1.md) for the full v1 → v2 reference.

---

## [1.8.1] — 2026-04-26

### Fixed

- **`scripts/wacli-keepalive.sh` — `refresh_wacli_cache` cold-restarted the keepalive every cache cycle.** `refresh_wacli_cache` called `release_wacli_batch` after killing `--follow` to refresh the chats/urgent caches, which removed `BATCH_MARKER`. The supervisor's exit-detect (line 567) saw the marker missing and treated the kill as a clean shutdown instead of a deliberate self-pause, breaking out of the while-loop and letting launchd cold-restart the script with a fresh bootstrap sync. Symptom: persistent `wacli sync --follow` could not stay alive longer than ~15 minutes; the daemon was effectively in a restart loop disguised as healthy backfill cycles. Fix: omit `release_wacli_batch` in `refresh_wacli_cache`, matching the deliberate behavior already documented in `periodic_backfill`. The supervisor's pre-restart `rm -f "$BATCH_MARKER"` (line 571) handles cleanup.
- **`.claude-plugin/marketplace.json` — plugin version pin lagged `plugin.json`.** v1.8.0 bumped `claude-ops/.claude-plugin/plugin.json` but missed the version field in the marketplace manifest at the repo root, so users discovering the plugin via the marketplace still saw `1.7.1`. Now both files agree.

## [1.8.0] — 2026-04-26

### Added

- **Superpowers integration across `/ops:ops-merge`, `/ops:ops-orchestrate`, `/ops:ops-triage`.** Each skill now invokes specific `superpowers:*` skills at well-defined checkpoints to enforce stronger guardrails:
  - `ops-merge` calls `superpowers:verification-before-completion` + `superpowers:finishing-a-development-branch` before the final merge decision (after fixer reports green) so nothing ships half-done.
  - `ops-orchestrate` calls `superpowers:dispatching-parallel-agents` when launching 2+ parallel teammates per wave, enforcing file-ownership boundaries and task-independence checks.
  - `ops-triage` calls `superpowers:systematic-debugging` during root-cause investigation so fix agents target the real defect, not the symptom.
- **`/ops:setup` Step 2b.5 — installs the `superpowers` plugin.** Mirrors the existing GSD install step: detects whether `superpowers` is already present, prompts the user, runs `claude plugin marketplace add obra/superpowers-marketplace && claude plugin install superpowers@superpowers-marketplace`, and falls back to a direct `git clone` of the marketplace if the `claude` CLI is unavailable. Skipping is fine — the superpower checkpoints become no-ops without it.

### Fixed

- **`bin/ops-autofix` — `wacli-health` killed the legitimate `wacli sync --follow` daemon every run.** The auto-fix unconditionally killed any process holding the wacli store lock, despite a comment promising a `>2 min` age check that was never implemented. `wacli sync --follow` legitimately holds the lock for its entire lifetime to stream live messages, so every `/ops:ops-doctor` invocation cold-restarted the keepalive and broke message reception. The fix:
  - Skips the kill outright when the lock holder's command matches `wacli sync --follow`.
  - Implements the >2 min age check the comment promised, parsing `ps etime` formats `SS`, `MM:SS`, `HH:MM:SS`, and `DD-HH:MM:SS`.
  - Logs cmd + age when killing for traceability, and logs skips with a reason (young vs `--follow`) instead of silently passing through.

## [1.7.0] — 2026-04-18

### Added

- **`/gtm` — cross-channel go-to-market planning skill** (PR #141). New `ops-gtm` skill acts as a strategy layer on top of `/marketing`. Guides the operator through GTM intake (audience, positioning, constraints, targets), generates a full plan across paid, unpaid, sales, and AI-automation avenues, and persists dated plan/brief files under `${CLAUDE_PLUGIN_DATA_DIR}/gtm/`. Plan items hand off to `/marketing` sub-commands via the `Skill` tool so credential resolution and API calls stay single-sourced. Approval gates are enforced for every paid or outbound action.
- **`ops-memory-extractor` — Claude Code OAuth support** (PR #138). The background memory extractor now prefers the Claude Code OAuth token stored in macOS Keychain (service `Claude Code-credentials`) over `ANTHROPIC_API_KEY`. Calls use `Authorization: Bearer <oauth-token>` with the `anthropic-beta: oauth-2025-04-20` header, billed against the user's Claude Max subscription instead of their API credit. Falls back to `ANTHROPIC_API_KEY` (env → keychain `anthropic-api-key` → Doppler `sharedsecrets/prd`). The OAuth token is never exported to the shell environment, avoiding the Claude Code misbehavior that occurs when `ANTHROPIC_API_KEY` is set in a parent terminal session.
- **`/ops:projects` — portfolio dashboard** (PR #139). Renders a dashboard of every project in the GSD registry, including active phase, task count, dirty-file count, and open-PR status. Reads from `$OPS_DATA_DIR/registry.json` synced by `scripts/ops-gsd-registry-sync.sh`.
- **`ops-speedup` v2 parity — GPU/ANE monitoring and power-hog detection** (PR #140). Full feature parity with the v1 bash script: `--gpu` reports GPU + Neural Engine utilization via `powermetrics` (macOS) with sampling-window controls, `--power` surfaces top energy consumers from `top -o pmem` / `ps -eo`, `--os-actions` performs cross-platform kernel_task / WindowServer restarts and launchd service masking behind an allowlist.

### Fixed

- **`scripts/wacli-keepalive.sh` — persistent `--follow` connection torn down by immediate backfill** (PR #138, reported via daemon log audit). The supervisor was invoking `wacli sync --once` on the very first supervisor tick before `--follow` had stabilized its store lock, which terminated the persistent connection within ~5-20 minutes every time. Added `INITIAL_BACKFILL_DELAY=30` seconds after follower start before the first `--once` sweep, and introduced `_WACLI_BATCH_HELD` reentrant guards to prevent overlapping sweeps. The `ops-daemon` now keeps `wacli --follow` alive indefinitely.
- **`bin/ops-speedup` — `eval` on user-controlled strings** (PR #140, SEV-9 from Seer). Replaced `eval` with `declare -g` plus a string allowlist to close a shell-injection vector in the OS-action dispatcher.
- **`bin/ops-speedup` — RETURN-trap race** (PR #140, SEV-8). Temp files previously leaked if the function returned mid-trap; now scoped with a local trap per function and cleared on the success path.
- **`bin/ops-speedup` — systemd mask without allowlist** (PR #140, SEV-8). The Linux path now validates the service name against a static allowlist before calling `systemctl mask`, preventing accidental masking of critical services.
- **`bin/ops-speedup` — `lsof +D` wedged the probe on large dirs** (PR #140, SEV-7). Replaced `+D` (recursive descent) with a bounded file-list argument so the liveness check returns in under 200 ms on any realistic directory.
- **`bin/ops-speedup` — non-portable `mktemp`, awk field reorder, and `find` precedence** (PR #140, SEV-low trio). `mktemp` now passes an explicit template for BSD/GNU compatibility, the awk power-hog formatter orders by `%MEM` before `%CPU` (matching the help text), and `find` predicates are correctly parenthesized.
- **`bin/ops-projects` — hardcoded developer registry path** (PR #139, SEV-9 blocker from Seer + blocksorg + cursor + devin + codex). The inline Python heredoc hardcoded `/Users/<user>/…/registry.json` inside a single-quoted heredoc, so the `$REGISTRY` shell variable never expanded and the dashboard printed `(no registry)` for every other user. Rewrote to read `OPS_DATA_DIR` from the environment inside the Python block (`import os; registry = Path(os.environ.get("OPS_DATA_DIR", os.path.expanduser("~/.claude/plugins/data/ops-ops-marketplace"))) / "registry.json"`). Also violated `CLAUDE.md Rule 0` (public repo, no personal paths).
- **`scripts/daemon-services.default.json` — three services enabled without backing scripts** (PR #139, SEV-7 from blocksorg). `inbox-digest`, `message-listener`, and `competitor-intel` were default-enabled but their scripts were not shipped in the diff, so `message-listener` (with `max_restarts: 20`) would have log-spammed 20 restart attempts. Set `enabled: false` for all three; the daemon reconciles them back to `true` once the user configures the relevant channel during `/ops:setup`.
- **`skills/ops-projects/SKILL.md` — `AskUserQuestion` removed from `allowed-tools` but still referenced in body** (PR #139, SEV-7 from blocksorg). Added `AskUserQuestion` back to the allowed-tools frontmatter so the interactive deep-dive flow doesn't crash with `InputValidationError`.

## [1.6.2] — 2026-04-16

### Fixed

- **`bin/ops-marketing-dash` — empty data from background gatherers** (sentry[bot] + cursor[bot], HIGH). `VAR=$(fn) &` with `wait` only assigns inside the backgrounded subshell, so `KLAVIYO_DATA`, `META_DATA`, `GA4_DATA`, `GSC_DATA`, `GADS_DATA`, and `INSTAGRAM_DATA` were all empty after `wait`. Switched to the tempfile pattern already used in `bin/ops-external` / `bin/ops-discover-external`.
- **`bin/ops-marketing-dash` — hardcoded `EMAIL_SCORE=10`** (cursor[bot]). Now derived from Klaviyo last-campaign `open_rate` (≥20% → 20pt, ≥10% → 10pt, else 0), matching the thresholds documented in `skills/ops-marketing/SKILL.md §Marketing Health Score`. `gather_klaviyo` now fetches campaign-values-reports for the most recent campaign.
- **`bin/ops-marketing-dash` — active-channel count used string compare** (cursor[bot] + codex[bot]). After the tempfile fix, unconfigured gatherers emit JSON `null`, so the literal `!= "0"` test mis-counted. Replaced with a numeric `is_positive` awk helper.
- **`skills/ops-marketing/SKILL.md` — Meta ad creative passed ad account ID as page_id** (codex[bot] P1 + sentry[bot]). Meta's `object_story_spec.page_id` requires a real FB Page ID, not `act_…`. Now requires `META_PAGE_ID` in env or plugin config with a clear error message.
- **`skills/ops-marketing/SKILL.md` — Instagram Story publishing sent duplicate `media_type`** (cursor[bot]). Removed the duplicate form field from the Stories container `curl`.
- **`agents/marketing-optimizer.md` — parser keys mismatched dashboard schema** (codex[bot] P1). Optimizer expected `meta_ads.*` / `google_ads.campaigns[]` / `klaviyo.attributed_revenue` but dashboard emits `meta.*` / raw `google_ads` searchStream array / no `attributed_revenue` field. Rewrote the schema reference to match what `bin/ops-marketing-dash` actually produces, with null-safe jq reductions for the Google Ads path.

## [1.6.1] — 2026-04-16

### Added

- **`ops-package` carrier-agnostic shipping skill** — Unified `/ops:package ship|label|track|list|carriers` entrypoint routing to 7 carrier adapters. Each adapter lives in `skills/ops-package/lib/carriers/<carrier>.sh` and shares common helpers (address parsing, credential resolution, label storage) in `lib/common.sh`.
  - **VERIFIED (live API tested)**: MyParcel.nl (api.myparcel.nl v1.1), Sendcloud (Panel API v3).
  - **UNVERIFIED (modelled from vendor docs, live account pending)**: DHL NL (My DHL Parcel Swagger), PostNL (Send API v2.2), DPD (eSolutions REST), UPS (v2403 Ship/Track REST), FedEx (Ship v1 + Track v1 REST). Adapters tagged `# UNVERIFIED - pending live test with account` in source; payloads may need adjustment against live accounts.

### Fixed

- **MyParcel NL insured shipments force `only_recipient:true` + `signature:true`** — MyParcel's own API contract requires both flags when `insurance > 0` for NL domestic shipments; omitting them returns a 422. Flagged by coderabbitai (Major).
- **`mktemp` temp files leaked on `curl` failure** — Under `set -e`, a failed `curl` short-circuited label flows before `rm -f` ran, leaving stale PDFs in `$TMPDIR`. Fixed in myparcel, dhl, dpd, sendcloud label flows via `trap 'rm -f "$tmp"' RETURN` (scoped to the function, cleared on success path before `save_label_pdf` takes ownership). Flagged by sentry[bot] and chatgpt-codex-connector (P1).
- **OAuth token cache written world-readable in `/tmp`** — `mktemp` inherits the ambient umask; on default systems that's 0644. Added `umask 077` before creating token cache files so only the owner can read them. Flagged by cursor[bot] (Medium).
- **`myparcel_list` recipient concatenation NPE on missing name/city** — `jq` join of `.recipient.name` + `.recipient.city` crashed when either field was absent. Added `// empty` fallbacks. Flagged by cursor[bot] (Low).
- **Dead code: `consume_carrier_flag` and `list_configured_carriers`** — Unused helper functions in `ops-package.sh` removed. Flagged by cursor[bot] (Low).
- **`--carrier` without value crashed under `set -u`** — `CARRIER="$2"` expanded to unbound-variable error when user ran `ops-package.sh --carrier` with nothing after it. Now guards with `"${2:-}"` and exits 64 with a usage message. Flagged by devin-ai-integration[bot].
- **MyParcel `Authorization` header scheme capitalization** — Changed `basic` to `Basic` to match RFC 7235 convention and MyParcel vendor docs (scheme matching is case-insensitive per spec but explicit casing avoids edge-case proxies). Flagged by coderabbitai (Minor).
- **MyParcel list page size** — Bumped default from 10 to 30 to match the API's documented page size and reduce pagination chatter on the typical user's recent-shipment view. Flagged by chatgpt-codex-connector (P2).

## [1.6.0] — 2026-04-16

### Added

- **`bin/ops-discover-external`** — Auto-discovers external (non-git) projects from credentials already configured in the plugin: Shopify stores (via prefs/env), Linear teams (via `LINEAR_API_KEY`), Slack workspaces (via keychain `slack-xoxc`/`slack-xoxd`), and Notion databases (via `NOTION_API_KEY` / keychain `notion-api-key`). Emits a JSON array of ready-to-register candidates with pre-built `config` blocks. Never writes to `registry.json` itself — the setup wizard handles registration after user confirmation. Shopify candidates emit the credential key that actually supplied the token (`SHOPIFY_ADMIN_TOKEN` or `SHOPIFY_ACCESS_TOKEN`) so downstream health checks resolve correctly, and Slack lookups use account=`$USER` (matching `bin/ops-slack-autolink.mjs`) so real installations are discovered.
- **Setup Step 5: "Auto-discover external projects"** — New sub-step in `skills/setup/SKILL.md` that runs `ops-discover-external` after the filesystem git-repo scan, cross-references against the existing registry, and presents only unregistered candidates via batched `AskUserQuestion` calls (≤ 4 options per call, per Rule 1).
- **`ops-projects` external candidate surfacing** — The portfolio dashboard now runs `ops-discover-external` alongside `ops-external` and shows an "UNREGISTERED CANDIDATES" footer listing Shopify/Linear/Slack/Notion projects the user has credentials for but has not yet added to `registry.json`, with a one-line path to `/ops:setup registry`.
- **`ops-projects` external deep-dive** — The `/ops:projects <alias>` jump-to-project view now branches on `type: external` and renders a source-specific deep-dive (Shopify order summary, Linear team issues, Slack workspace health, Notion recent edits) with actions that route to the relevant source-specific skill instead of assuming git/CI/PR context.

### Fixed

- **`CODE_OF_CONDUCT.md`** — Enforcement contact changed from a product support address to the plugin maintainer email (`info@lifecycleinnovations.limited`), matching `SECURITY.md`. Fixes Rule 0 (no personal/product-specific emails in a public repo).

## [1.5.0] — 2026-04-15

### Added

- **`bin/wacli-safe`** — Lock-free one-shot wacli command wrapper. Pauses keepalive sync via pause-signal protocol, runs the command, then resumes automatically.
- **`bin/wacli-health`** — Health check script with `--json` and `--repair` flags for any ops skill to verify wacli + keepalive status.
- **Self-healing service supervisor** — `ensure_all_services()` in ops-daemon enumerates all expected `com.claude-ops.*` launchd agents (macOS) and systemd units (Linux), verifies each is installed with a live PID, and auto-repairs (reinstall, kickstart) unhealthy services. Runs at startup + every 5min.
- **Wacli data cache** — Keepalive writes `wacli_chats.json` and `wacli_urgent.json` to cache every 5min. Daemon intelligence functions read from cache instead of calling wacli directly, eliminating store-lock contention.
- **Periodic backfill** — Keepalive re-checks for chats needing backfill every 30min (configurable via `BACKFILL_INTERVAL`).
- **Missed message detection** — Compares chat metadata timestamps against actual DB content; gaps > 1 hour are auto-queued for backfill.
- **Backfill memory integration** — Writes conversation summaries to `$DATA_DIR/memories/` for the ops memory-extractor to consume.
- **Pause-signal protocol** — `$STORE/.pause_sync` + `$STORE/.batch_wacli` files coordinate exclusive wacli access between keepalive, daemon, and external commands.

### Fixed

- **Keepalive P0 crash** — `detect_missed_messages` was called before its function definition; keepalive exited with status 127 on every machine, never reaching persistent sync.
- **Cache directory never created** — `WACLI_CACHE_DIR` was defined but not included in `mkdir -p`, causing all cache writes to silently fail.
- **Restart delay never applied** — `restart_delay` was logged but no `sleep` happened; services restarted immediately ignoring configured backoff.
- **Launchctl PID parsing** — `awk '/PID/{print $2}'` extracted `=` instead of the PID from `launchctl list` dictionary output; replaced with `launchctl list | awk '$3==lbl'` which parses the tabular format correctly.
- **Plist repair early-return** — `_install_launchd_plist` returned early on live PID even when the destination plist file was missing; service would vanish on reboot. Now requires both file existence AND live PID to skip.
- **Store-lock contention in cache refresh** — `refresh_wacli_cache`, `detect_missed_messages`, and `write_backfill_memory` all called wacli directly during persistent sync. Now use `acquire_wacli_batch` / `release_wacli_batch` to pause sync first.
- **dateutil dependency** — Replaced third-party `dateutil.parser` with stdlib `datetime.fromisoformat` in missed-message detection.
- **Restart counter permanent death** — `max_restarts` counter now resets after 30min of stability instead of staying dead forever.
- **Startup race condition** — 15s delay in keepalive when another `wacli sync` is already running.
- **Daemon version tracking** — Health JSON now includes daemon version from package.json.

---

## [1.4.0] — 2026-04-15

### Added

- **External project support** — Non-repo projects (Shopify stores, Linear teams, Slack/Notion workspaces, custom SaaS endpoints) can now be registered in `registry.json` with `type: "external"` and appear across all dashboards, briefings, fire detection, revenue tracking, and C-suite analysis.
- **`bin/ops-external`** — New data collector that probes external project health (Shopify Admin API, Linear GraphQL, custom health endpoints).
- **`registry.templates/external-project.json`** — Registry template for all supported external project types.
- **`/ops:daemon` skill** — Manage the background daemon (start, stop, restart, health check).
- **gog CLI reference** — Comprehensive command reference added to all agent skills.

### Changed

- **`ops-projects`** — Portfolio dashboard now includes an EXTERNAL PROJECTS table.
- **`ops-go`** — Morning briefing includes external project health status.
- **`ops-fires`** — Classifies external project issues by severity (unreachable=CRITICAL, auth_expired=HIGH).
- **`ops-revenue`** — Pulls Shopify GMV for external stores, adds SOURCE column to revenue pipeline.
- **`ops-yolo`** — Pre-gathers external project data for all 4 C-suite agents.
- **`project-scanner` agent** — Handles external projects in scan output.
- **`infra-monitor` agent** — Probes external projects, fire detection rules for auth_expired/unreachable.
- **`revenue-tracker` agent** — Queries Shopify orders API for GMV on external stores.
- **All C-suite agents** (CEO/CTO/CFO/COO) — Factor external projects into strategic, technical, financial, and operational analysis.

### Fixed

- **`ops-daemon`** — Critical installer, test, and arg-parser fixes.
- **Stale plist and wait bugs** in `ops-daemon.sh`.

---

## [1.3.0] — 2026-04-14

### Added

- **Notion integration** — Full channel support for Notion workspaces in inbox, comms, and setup flows.

### Fixed

- **Notion search API** — Corrected API usage, added missing tools and API fallback.
- **Setup wizard** — Renumbered sections after Notion insertion, fixed verification command.

---

## [1.2.0] — 2026-04-14

### Added

- **Agent Teams enforcement** — All agent-spawning skills now support Agent Teams when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set.
- **Discord integration** — `/ops:comms discord` via webhook + bot read.
- **Docker support** — Turnkey container image + compose stack for Linux/CI.
- **Fires-watcher daemon** — Push notification sinks (Telegram/Discord/ntfy/Pushover).
- **`/ops:status` skill** — Lightweight integration health panel.
- **Registry templates** — Starter templates for 4 common stacks (monorepo, Next.js SaaS, Python microservices, React Native).
- **CI release workflow** — Auto-opens PR for version bumps.

### Fixed

- **Daemon** — Services work out of the box on fresh install.

---

## [1.1.1] — 2026-04-14

### Added

- **`docs/os-compatibility.md`** — Authoritative cross-OS reference: support matrix (macOS, Debian/Fedora/Arch/SUSE/Alpine, Windows, WSL2), per-channel install tables, credential cascade explainer, daemon registration mechanisms, browser-profile discovery roots, URL opener resolution, dev/CI guidance, known limitations, contributor testing notes (#100).

### Fixed

- **`bin/ops-setup-preflight`** — Restored `gog calendar calendars --json` (the v1.1.0 release dropped this fix during merge, leaving a probe of the non-existent `gog cal list` that silently wrote `{"error":"failed"}` to the calendar cache) (#101).
- **`bin/ops-unread`** — Error message no longer suggests `npm install -g @example/gog` (a package that doesn't exist on npm); now points to `brew install gogcli` / `winget install -e --id steipete.gogcli` / source build (#101).
- **`skills/ops-inbox/CHANNELS.md`** — Install snippet replaced the private `example/gog` references and invalid `gog auth login` command with an OS-aware `gogcli` install + `gog auth add` flow (#101).
- **`skills/ops-go/SKILL.md`** — Wording fix: "When `gog cal` fails" → "When `gog calendar` fails" (#101).
- **`bin/ops-autofix` + `bin/ops-setup-preflight`** — Back-compat `_cred_*` wrappers now gated by `IS_MACOS` / `[[ "$(uname)" == "Darwin" ]]` so the macOS-only `security` fallback never runs on Linux/Windows (would have crashed under `set -euo pipefail`) (#101).
- **`tests/test-bin-scripts.sh`** — macOS-tool detector now recognizes broader guard patterns (`if [ "$OS" = "macos" ]`, `case "$(uname)" in Darwin)`, the `else` branch of `if declare -F ops_cred_*`), eliminating false-positive failures on `ops-speedup`, `ops-autofix`, and `ops-setup-preflight` that were blocking PR merges (#101).

---

## [1.1.0] — 2026-04-14

### Added

- **"Configure all" first option in every setup phase** — Enter→Enter→Enter = full optimized install with zero friction. Steps 1 (sections), 2 (CLIs), 3 (channels), and 4 (MCPs) all offer "configure/install everything" as the recommended first option.
- **CODE_OF_CONDUCT.md** — Contributor Covenant 2.1.
- **Dependabot** — Weekly npm + GitHub Actions version bumps.
- **`.prettierrc.json`** — Explicit formatting config (was implicit defaults).
- **`npm scripts`** — `lint`, `format`, `test`, `type-check` in package.json.
- **Cross-OS foundation** — `lib/os-detect.{sh,mjs}`, `lib/credential-store.{sh,mjs}`, `lib/opener.{sh,mjs}` for macOS/Linux/WSL/Windows portability.
- **Cross-OS CI matrix** — GitHub Actions workflow tests on ubuntu-latest, macos-latest, windows-latest.
- **Gitleaks coverage** — Custom rules for all 22 integrated services (Shopify, RevenueCat, Sentry, Doppler, Linear, Klaviyo, ElevenLabs, Bland AI, Cloudflare).

### Changed

- **Telegram phone number prompt** — Now a single free-text field starting with `+` instead of country-specific presets.
- **Setup wizard gog install** — Points to `steipete/gogcli` (public) with cross-OS install table instead of private repo.
- **All `gog` commands updated** — `gog auth login` → `gog auth add`, `gog cal` → `gog calendar events`.

### Fixed

- **Gitleaks false positives** — `curl-auth-user` in SKILL.md docs, example phone numbers, `$STRIPE_SECRET_KEY` env var references.
- **Prettier formatting** — All `.mjs`/`.js`/`.json` files formatted with explicit config.

---

## [1.0.0] — 2026-04-14

### Added

- **`/ops:monitor`** — Unified APM surface for Datadog, New Relic, and OpenTelemetry. Active alerts, error traces, entity health. `--watch` for live polling.
- **`/ops:settings`** — Post-setup credential manager. Shows integration status, allows selective updates with smoke tests.
- **`/ops:integrate`** — Onboard any SaaS API into the partner registry (WebSearch discovery → confirm → credential → health check).
- **`monitor-agent`** — Lightweight haiku-4-5 agent for APM polling.
- **`templates/nestjs-api/`** — Full NestJS API template with JWT auth, BullMQ queues, Prisma, Fastify, health endpoint, multi-stage Dockerfile.
- **`templates/nextjs-saas/`** — Full Next.js SaaS App Router template with Auth.js v5, Stripe billing, Prisma, Tailwind, shadcn/ui.
- **`@claude-ops/sdk`** — npm package with TypeScript types (SkillManifest, AgentManifest, PluginManifest, HooksConfig) and `create-ops-skill` CLI scaffolder for third-party skill authors.
- **Automated release pipeline** — GitHub Actions workflow triggered on v* tag push, parses CHANGELOG, creates GitHub Release.
- **Ubuntu 24.04 CI** — Full test suite runs on both ubuntu-latest and ubuntu-24.04.
- **Merge conflict resolution** — `/ops:merge` now auto-rebases on `origin/main`; on failure offers accept-theirs / accept-ours / manual / skip.
- **CLAUDE.md plugin rules** — Plugin-root `CLAUDE.md` with two hard rules enforced across all skills: (1) max 4 options per `AskUserQuestion` call (schema limit), (2) never delegate CLI commands to the user — run via Bash tool instead (exception: `wacli auth` QR code).
- **Shopify admin app template** — `templates/shopify-admin-app/` — full Shopify Admin Remix template with all admin scopes, forked from Shopify/shopify-app-template-remix.
- **`bin/ops-shopify-create`** — Non-interactive Shopify app scaffolding script. Automates device-code OAuth (auto-opens browser via `expect`), fetches org ID from Shopify Partners API cache, runs `shopify app init` with all flags, and injects client ID into `shopify.app.toml`.
- **`expect` as required CLI** — Added to `bin/ops-setup-preflight` detection and `bin/ops-setup-install` for browser-automation flows.
- **Test suite** — New `tests/` directory with bash-based validation covering skills, bin scripts, hooks, templates, and secrets.
- **`briefing-pre-warm` daemon service** — Runs `bin/ops-gather` every 2 minutes and caches dashboards so `/ops:go` loads in <3s instead of <10s. Registered under `ops-daemon` alongside wacli-keepalive and memory-extractor.
- **Early daemon install (Step 2c of setup wizard)** — Setup wizard now installs `ops-daemon` immediately after CLI tooling so the `briefing-pre-warm` service can start caching `/ops:go` data while the remaining setup steps run. Step 5b became "daemon service reconciliation" (verify + restart) instead of fresh install.
- **`/ops:revenue` actual revenue tracking** — `revenue-tracker` agent now queries Stripe (charges, subscriptions → MRR, balance, disputes, open invoices, churn) and RevenueCat (mobile subscription MRR, active subs, churn). AWS cost data still included alongside revenue. `/ops:setup` Step 3k prompts for Stripe + RevenueCat credentials.
- **New `userConfig` keys** — `stripe_secret_key`, `revenuecat_api_key`, `revenuecat_project_id` added to `plugin.json`.
- **`infra-monitor` full-AWS coverage** — Service discovery probes IAM access per service, then reports on ECS, EC2, RDS, Lambda, S3 (flags public buckets), CloudFront, ALB/NLB, API Gateway, SQS (backlogs + DLQ), SNS, DynamoDB, ElastiCache, Route 53, ACM (cert expiry), CloudWatch alarms, Budgets, and IAM (stale access keys).
- **Wiki revamp** — 10 wiki pages rewritten with 2026 GitHub formatting (badges, mermaid diagrams, alert callouts). New pages: `Daemon-Guide`, `Memories-System`, `Plugin-Rules`, `Changelog`, `Privacy-and-Security`.
- **Privacy & Security transparency** — new `Privacy-and-Security.md` wiki page and README section explicitly document every credential scan source, what the daemon does on disk, and the plugin's no-telemetry / no-phone-home stance.

### Changed

- **AskUserQuestion <=4 enforcement** — All 15 skills audited and fixed. setup section picker (11→batched 4+4+3), setup channel picker (7→4+3), ops-comms / deploy / fires / go / inbox / linear / projects / revenue / speedup / triage / yolo all batch >4 menus with `[More options...]` bridges. ops-dash hotkey menu refactored.
- **Subagent models bumped Sonnet 4.5 → Sonnet 4.6** — `comms-scanner`, `infra-monitor`, `project-scanner`, `revenue-tracker`, and `triage-agent` now run on `claude-sonnet-4-6`. `yolo-*` agents stayed on `claude-opus-4-6`; `memory-extractor` stayed on `claude-haiku-4-5`.
- **Agent Teams adoption** — `/ops:fires`, `/ops:inbox`, `/ops:merge`, `/ops:orchestrate`, `/ops:triage`, and `/ops:yolo` now use the `TeamCreate` + `SendMessage` primitives for parallel agent coordination instead of sequential `Task`-based dispatch.
- **`/ops:speedup` is now OS- and hardware-agnostic** — auto-detects macOS / Linux / WSL / Windows, selects the right sub-script per platform, and degrades gracefully when tools are missing instead of erroring out.

### Fixed

- **`gog` install fallback chain** — Setup wizard now tries `npm install -g @example/gog` → `bun install -g @example/gog` → `git clone https://github.com/example/gog ~/.gog && ./install.sh` → clear manual instructions. Removed the previous incorrect pointer to `Lifecycle-Innovations-Limited/tap/gog` (Homebrew) — `gog` is a private `@example` CLI and is not distributed via Homebrew.

## [0.6.0] — 2026-04-13

### Added

- **`/ops:ecom`** — E-commerce operations command center (Shopify, Klaviyo, ShipBob, Meta Ads)
- **`/ops:marketing`** — Marketing analytics (email campaigns, ads, SEO, social, competitors)
- **`/ops:voice`** — Voice channel management
- **Daemon cron jobs** — Competitor intel, inbox digest, store health monitoring scripts
- **Message listener** — Real-time message event processing via wacli
- **Universal credential auto-scan** — Setup wizard auto-discovers API keys from env, Doppler, password managers, and browser sessions
- **Dynamic partner discovery** — Ecom/marketing setup detects installed platforms automatically
- **docs/** — Full reference documentation (skills, agents, daemon, memories)

### Fixed

- MCP namespace corrections across 8 skills and 3 agents (Linear, Gmail, Sentry)
- Broken YAML frontmatter in ops-comms, ops-triage, ops-yolo
- All 19 audit gaps resolved (100/100 score)

### Changed

- README updated with v0.6.0 features, architecture diagram, new skills table
- Plugin userConfig expanded: Klaviyo, Meta Ads, GA4, Search Console, Shopify, ShipBob keys

## [0.5.0] — 2026-04-13

### Added

- **ops-daemon** — Unified background process manager (launchd). Manages wacli sync, memory extraction, and future services with auto-heal, bootstrap sync, and auto-backfill for @lid chats.
- **ops-memories** — Daemon-spawned haiku agent extracts contact profiles, user preferences, communication patterns, and conversation context from chat history every 30 min. Writes structured markdown to `memories/`.
- **wacli-keepalive** — Persistent WhatsApp connection with bootstrap sync, auto-detection of empty @lid chats, health file contract (`~/.wacli/.health`), and launchd integration.
- **Doppler integration** — Setup wizard detects and configures Doppler CLI for secrets management. All skills can query secrets via `doppler secrets get`.
- **Password manager integration** — Setup wizard detects 1Password (`op`), Dashlane (`dcli`), Bitwarden (`bw`), and macOS Keychain. Configures query commands for agent use.
- **CLI/API reference tables** — All 14 operational skills now include complete command reference tables with exact syntax, flags, and output formats for wacli, gog, gh, aws, sentry-cli, and Linear GraphQL.
- **Deep context inbox** — ops-inbox and ops-comms now read full conversation threads (20+ messages), build contact profiles across channels, search for topic context, and draft replies matching user's language and style. Safety rail: NEVER send without full thread understanding.
- **PreToolUse hooks** — Automatic wacli health check before any WhatsApp command. Daemon health surfaced to user when action needed.
- **Stop hooks** — Session cleanup removes stale worktrees and temp files.
- **Runtime Context** — Every skill loads preferences, daemon health, ops-memories, and secrets at execution time.

### Changed

- **Plugin feature adoption ~35% → ~85%** — All 19 skills annotated with `effort`, `maxTurns`, and `disallowedTools`. 3 heavy skills use `claude-opus-4-6`. 4 read-only skills block Edit/Write. All 10 spawnable agents have `memory` (project/user scope). 4 scanner agents have `initialPrompt` for auto-start. Triage agent has `isolation: worktree`.
- **Setup wizard** — New steps for Doppler (3f), password manager (3g), and background daemon (5b). Daemon replaces standalone wacli launchd agent.
- **ops-inbox** — Full thread reads (20 msgs not 5), contact profile cards, topic search, cross-channel history, language/style matching in drafts.
- **ops-comms** — Full conversation context required before any send. Health pre-flight for WhatsApp.

## [0.4.2] — 2026-04-13

### Added

- **`bin/ops-autofix`** — Silent auto-repair script for common ops issues. Fixes wacli FTS5 (rebuilds with `sqlite_fts5` Go build tag), registers Slack MCP (from keychain tokens), and registers Vercel MCP. Runs non-interactively with `--json` output. Supports `--fix=all|wacli-fts|slack-mcp|vercel-mcp` targeting.

### Changed

- **`bin/ops-doctor`** — Now runs `ops-autofix` after diagnostics and reports any auto-applied fixes.
- **`bin/ops-setup-preflight`** — Now runs `ops-autofix` as a background job during preflight, so `/ops:setup` auto-repairs issues before the wizard even starts.

## [0.4.0] — 2026-04-13

### Added

- **`/ops:dash`** — Interactive pixel-art command center dashboard. Visual HQ with instant hotkey navigation (1-9, 0, a-h), live status indicators (fires, unread, PRs, GSD phases), C-suite report viewer, interactive settings editor, share-your-setup social flow, and FAQ/wiki section with links. `/ops` with no args now launches the dashboard instead of a text menu.
- **`/ops:speedup`** — Cross-platform system optimizer. Auto-detects macOS/Linux/WSL, scans for reclaimable disk space (brew, npm, Xcode, Docker, trash, logs, tmp, app caches), reports memory pressure, runaway processes, startup bloat, network latency. Health score (0-100). Tiered cleanup options: quick/full/deep/custom/memory/startup/network. On macOS, leverages the existing comprehensive `speedup.sh` for deep optimization.
- **`bin/ops-dash`** — Shell script that renders the pixel-art dashboard with parallel background data probes (projects, PRs, CI, unread, GSD, YOLO reports).
- **`bin/ops-speedup`** — Shell script for cross-platform system diagnostics (OS detection, hardware fingerprint, disk/memory/process/network metrics). Supports `--json` flag for machine-readable output.

### Changed

- **`/ops` router** — Empty args now launch `/ops:dash` instead of showing a static text menu. Added routing for `speedup`, `clean`, `optimize`, `cleanup` to `/ops:speedup`.
- **Telegram setup** — After authenticating via `ops-telegram-autolink.mjs`, credentials are now auto-written to the MCP config. No more manual paste into `/plugin settings`.
- **GSD companion install** — Now installs automatically with a single "Yes" instead of telling users to run slash commands manually.

## [Unreleased — legacy drafts]

### Added — autolink wizards for Telegram and Slack

- **`bin/ops-telegram-autolink.mjs`** — zero-browser Telegram user-auth wizard. Takes a phone number, uses plain HTTP against `my.telegram.org` (pattern borrowed from [esfelurm/Apis-Telegram](https://github.com/esfelurm/Apis-Telegram) — `my.telegram.org` is fully server-rendered so no Playwright/Selenium is needed for api_id extraction). Scouts existing credentials in macOS keychain and `~/.claude.json` first. If none found, posts phone to `/auth/send_password`, waits for the user's code via `/tmp/telegram-code.txt` bridge file, POSTs `/auth/login`, GETs `/apps`, regex-extracts `api_id` + `api_hash`, creates an app if none exists, then runs gram.js `client.start()` to generate a session string (handling a second code via the same bridge). Final result: JSON line to stdout with `{api_id, api_hash, phone, session}`.
- **`bin/ops-slack-autolink.mjs`** — Slack token wizard with scout-first, Playwright fallback. Scouts `~/.claude.json mcpServers.slack`, process env, macOS keychain (`slack-xoxc`/`slack-xoxd`), shell profile files, and Doppler. If nothing is found, launches Playwright with a persistent Chromium profile dir at `~/.claude-ops/slack-profile`, navigates to `app.slack.com/client/`, waits for the user to log in via a bridge file (`/tmp/slack-login-done`), then extracts the `xoxc-...` token from `localStorage.localConfig_v2.teams[teamId].token` and the `d` cookie (`xoxd-...`) from the cookie jar. Ported from [maorfr/slack-token-extractor](https://github.com/maorfr/slack-token-extractor) (Python → Node).
- **`skills/setup/SKILL.md` Step 3a + 3d rewritten** to invoke these binaries as background processes via the file-bridge pattern, and to display instructions for wiring extracted values into `/plugin settings` (we do not auto-write to `~/.claude.json` — that's Claude Code's internal file and the plugin must not touch it).
- **New deps**: `playwright` (~200MB Chromium browser on first install) added to `telegram-server/package.json`. Only required if the user chooses to run the Playwright fallback path for Slack — scout-only mode has no dependency on Playwright.
- **Bumped to v0.2.2** — `plugin.json` + `marketplace.json`. Earlier user-auth-only fixes were v0.2.1.

### Fixed — public-repo hygiene pass

- **Scrubbed `scripts/registry.json` from all git history** via `git filter-repo` + force-push. The file contained real project data (paths, repo slugs, revenue stages, infra topology) and was tracked in the repo since day one. Now gitignored, with `scripts/registry.example.json` as a starter template.
- **Removed `.planning/` from tracked files** (`git rm -r --cached`). Previously leaked internal phase docs, ROADMAP.md, STATE.md, PROJECT.md. Gitignored going forward.
- **Refactored hardcoded project references to registry-driven iteration** in 7 files: `agents/yolo-cto.md`, `agents/yolo-coo.md`, `agents/infra-monitor.md`, `agents/triage-agent.md`, `agents/comms-scanner.md`, `skills/ops-deploy/SKILL.md`, `skills/ops-triage/SKILL.md`, `skills/ops-next/SKILL.md`, `skills/ops-projects/SKILL.md`. All loops now read `.projects[].repos[]` / `.paths[]` / `.infra.ecs_clusters[]` / `.infra.health_endpoints[]` from `scripts/registry.json` (with `registry.example.json` fallback). Sensible defaults shown in example tables use `example-app` / `example-api` instead of real project names.
- **Removed hardcoded personal data**: hardcoded email in `agents/comms-scanner.md` replaced with preferences-driven `channels.email.account`. Hardcoded home-dir fallback removed from `skills/setup/SKILL.md` detector invocation.
- **Rewrote README installation section** to reflect marketplace-plugin install flow (`/plugin marketplace add` + `/plugin`), not manual `git clone` + `settings.json` editing.
- **Rewrote README Telegram section** to match the v0.2.0 user-auth rewrite (gram.js MTProto) with API ID / API hash / phone / session flow instead of obsolete Bot API token flow.
- **Bumped `marketplace.json` to 0.2.1** to match `plugin.json`.
- Registered `.gitignore` superset: `node_modules/`, `.env*`, editor swap files, `.planning/`, `.claude/worktrees/`, `.DS_Store`, `*.log`, `scripts/preferences.json`, `scripts/registry.json`.

### Added

#### Interactive setup wizard (`/ops:setup`)

- `skills/setup/SKILL.md` — end-to-end config wizard with `AskUserQuestion` selectors
- `bin/ops-setup-detect` — JSON state probe (tools, env vars, MCPs, registry, prefs)
- `bin/ops-setup-install` — idempotent Homebrew/apt installer for CLI dependencies
- `~/.claude/plugins/data/ops-ops-marketplace/preferences.json` — owner, timezone, verbosity, default channels, channel secrets. Lives in Claude Code's per-plugin data dir so it survives reinstalls and version bumps; never stored in the plugin source tree.
- Routes `setup|configure|init|install` in the `/ops` command router

#### WhatsApp auto-heal (Step 3b of wizard)

- Detects stuck `wacli sync` processes via stale store lock + age check
- Detects app-state key desync via `wacli sync` stderr probe (the `didn't find app state key` error class)
- Offers to kill stale sync / logout + re-pair interactively
- Automatic historical backfill via `wacli history backfill` on top 10 most-recent chats after a successful heal

#### Email + Calendar with MCP fallback

- **Email**: primary `gog` CLI (full read + send); fallback Claude Gmail MCP connector (read-only until user grants send perms in Claude Desktop → Connectors)
- **Calendar**: primary `gog cal` (shared gog OAuth token); fallback Google Calendar MCP connector (read-only until user grants write perms in Claude Desktop)
- Both record the chosen backend in the plugin-data `preferences.json` (`channels.email`, `channels.calendar`) so downstream skills (`/ops-go`, `/ops-next`, `/ops-fires`) can cross-correlate with today's schedule

## [0.1.0] — 2026-04-11

### Added

#### Phase 1: Plugin Scaffold + Registry

- `scripts/registry.example.json` — template for the per-user project registry (aliases, paths, repos, infra, revenue stage, GSD flag). Real `scripts/registry.json` is gitignored.
- `bin/ops-unread` — parallel unread counts for WhatsApp, Email, Slack, Telegram
- `bin/ops-git` — git status across all registry projects
- `bin/ops-prs` — open PRs across all registered GitHub repos
- `bin/ops-ci` — CI failures (last 24h) from GitHub Actions
- `bin/ops-infra` — ECS cluster and service health from AWS
- `bin/ops-gather` — meta-runner for all gather scripts

#### Phase 2: Morning Briefing

- `skills/ops-go/SKILL.md` — token-efficient morning briefing using `!` shell injection
- Pre-gathers all data in <10 seconds before model reads context
- Unified business dashboard with prioritized actions

#### Phase 3: Communications Hub

- `skills/ops-inbox/SKILL.md` — inbox zero across WhatsApp, Email, Slack, Telegram
- `skills/ops-comms/SKILL.md` — send/read routing with natural language parsing
- Telegram MCP integration (mcp**claude_ops_telegram**\*)

#### Phase 4: Project Management

- `skills/ops-projects/SKILL.md` — portfolio dashboard with GSD state, CI, PRs
- `skills/ops-linear/SKILL.md` — Linear sprint board, issue management, GSD sync
- `skills/ops-triage/SKILL.md` — cross-platform triage (Sentry + Linear + GitHub)
- `skills/ops-fires/SKILL.md` — production incidents dashboard with agent dispatch
- `skills/ops-deploy/SKILL.md` — ECS + Vercel + GitHub Actions deploy status

#### Phase 5: Business Intelligence

- `skills/ops-revenue/SKILL.md` — AWS costs, credits, revenue pipeline, runway
- `skills/ops-next/SKILL.md` — priority-ordered next action (fires > comms > PRs > sprint > GSD)

#### Phase 6: YOLO Mode

- `skills/ops-yolo/SKILL.md` — 4-agent C-suite analysis + autonomous mode
- `agents/yolo-ceo.md` — Strategic analysis agent (claude-opus-4-5)
- `agents/yolo-cto.md` — Technical health agent (claude-sonnet-4-5)
- `agents/yolo-cfo.md` — Financial analysis agent (claude-sonnet-4-5)
- `agents/yolo-coo.md` — Operations execution agent (claude-sonnet-4-5)

#### Phase 7: Telegram MCP Server

- `telegram-server/index.js` — minimal MCP server using Telegram Bot API
- Tools: `send_message`, `get_updates`, `list_chats`
- `telegram-server/package.json` — @modelcontextprotocol/sdk dependency
- `.mcp.json` — Claude Code MCP server registration

#### Supporting Agents

- `agents/comms-scanner.md` — background comms monitoring agent
- `agents/infra-monitor.md` — infrastructure health monitoring agent
- `agents/project-scanner.md` — project state analysis agent
- `agents/revenue-tracker.md` — revenue and cost monitoring agent
- `agents/triage-agent.md` — issue triage and fix dispatch agent
