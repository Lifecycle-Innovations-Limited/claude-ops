# CRS Full-Tuning Execution Plan (FRA EC2)

> Linear: [HEA-4672](https://linear.app/lifecycle-innovations/issue/HEA-4672) · Owner: Sam Renders · Created: 2026-06-19
>
> Scope: tune the **Claude Relay Service (CRS)** running on the Frankfurt EC2 box so the
> agent fleet load-balances dynamically across the account pool, cools exhausted accounts
> correctly, and survives concurrent-stream storms without `ConnectionRefused` cascades.
> This plan is grounded in the **actual** CRS deployment as verified on the box on
> 2026-06-19 — not generic relay advice.

---

## 0. Ground truth — the actual CRS deployment

| Fact | Value (verified 2026-06-19) |
|---|---|
| Host | `dev-sandbox-fra` EC2 (`i-071b16e6328dbc876`, eu-central-1). SSM-managed; reachable via SSH alias `fra` (tailnet `100.107.38.70`) or `dev-sandbox-fra-cf` (CF-Access SSH) |
| CRS dir | `/home/ec2-user/crs` — **a working copy on the box, NOT a git repo** (`git remote -v` empty). The Dockerfile/package.json/lock are on-disk; `docker-compose.yml` has `build: .` |
| Relay container | `crs-claude-relay-1` (`weishaw/claude-relay-service`), bound `127.0.0.1:3005 → 3000`, status healthy |
| Live image | `weishaw/claude-relay-service:cve-fix-20260615` (the CVE-clean node:22-alpine rebuild). **NOT** a `loadbalance-fix-*` tag — see §1 gap |
| Redis | `crs-redis-1` (`redis:7-alpine`, :6379). Account state + concurrency counters + utilization live here |
| Aux containers | redis-commander, prometheus, grafana (compose-defined) |
| Account pool | ~10 Claude **Max OAuth** accounts: `pool-aurora/samfeldt/samrenders/chairman/foundation/heartfeldt-personal/heartfeldt-team` + `canary-lifecycle/support/sponsors`. Records: Redis hash `claude:account:<uuid>` |
| Token refresh | `crs-token-feed.timer` (systemd `--user`, every 5 min) — FRA is the OAuth refresher-of-record |
| Coarse priority cron | `dynamic-priority.py` (every 5 min) writes CRS `priority` from the same util formula |
| Routing in | Fleet sessions route via overlay `~/.claude/crs-session-settings.json` (`ANTHROPIC_BASE_URL=…:3005/api` + `ANTHROPIC_AUTH_TOKEN=cr_…`). The `cr_` key MUST be `ANTHROPIC_AUTH_TOKEN`, never `ANTHROPIC_API_KEY` |

### Key scheduler/relay files on disk
- `src/services/scheduler/unifiedClaudeScheduler.js` — pool selection, concurrency gating, util load-balancing, overload/503 handling, rate-limit tracking. **(modified 2026-06-19 — newest file)**
- `src/services/account/claudeAccountService.js` — account state, `markAccountRateLimited()`, util writeback (`claudeFiveHourResetsAt`, etc.)
- `src/services/relay/claudeRelayService.js` — request proxy + 429/error mark sites (non-stream / stream-error / stream-end)
- `config/config.js` (+ `config.example.js`, `models.js`) — defaults

### What is ALREADY on disk (verified by grep)
- **Util-based concurrency cap** — `_getMaxConcurrencyFromUtilization(util)` returns a per-account max concurrent stream count keyed on 5-hour utilization:

  ```js
  // src/services/scheduler/unifiedClaudeScheduler.js:593
  _getMaxConcurrencyFromUtilization(utilization) {
    const util = parseFloat(utilization) || 0
    if (util < 20) return 8
    if (util < 40) return 5
    if (util < 60) return 3
    if (util < 80) return 2
    return 1
  }
  ```
  Enforced at selection time (line ~801): `currentConcurrency = redis.getClaudeAccountConcurrency(account.id)`; account skipped if `currentConcurrency >= maxConcurrency`.
- **Dedicated 503 when all accounts saturated** — `CONSOLE_ACCOUNT_CONCURRENCY_FULL` error code thrown when every eligible account is at its concurrency limit.
- **Util load-balancing** — pool picks sorted by live utilization (`claudeFiveHourUtilization*0.4 + claudeSevenDayUtilization*0.6`), tie-break priority then `lastUsedAt` (the `📊 Load-balance pick` path).
- **Rate-limit tracking** — `rateLimitEndAt` / `rateLimitResetTimestamp` per account, `overloaded` status handled.

---

## 1. ⚠️ The critical gap — credit-exhaustion cooldown is NOT on disk

This is the **single highest-priority finding** and the most likely cause of repeat-account hammering.

**Symptom (documented 2026-06-16):** an `out_of_credits` / `org_level_disabled` account
gets re-selected every ~90 s and re-429'd (~40 wasted 429 calls/min). These 429s carry
**no authoritative reset header** (`anthropic-ratelimit-unified-overage-disabled-reason: out_of_credits`,
`overage-status: rejected`, body "credit balance too low"), so the relay only applied the
short transient cooldown and re-hammered the dead account.

**The 2026-06-16 fix (`loadbalance-fix-20260616`) introduced:**
- `_detectCreditExhaustion(status, headers, body)` in `claudeRelayService.js`
- wired into all 3× 429 mark sites → passes `{creditExhausted}` to `markAccountRateLimited()`
- which cools the account until its `claudeFiveHourResetsAt` (if future) else
  `CREDIT_EXHAUSTION_COOLDOWN_SECONDS` (default **3600 s / 1 h**); transient no-reset 429s
  keep the short 90 s.

**Verified 2026-06-19: NONE of `_detectCreditExhaustion`, `creditExhausted`, or
`CREDIT_EXHAUSTION_COOLDOWN_SECONDS` exist on disk.** The live image is `cve-fix-20260615`,
which predates this fix. **Conclusion: the CVE rebuild on 2026-06-15 produced an image that
never carried the credit-cooldown fix, OR a later restore reverted it.** The util-LB +
concurrency-cap code survived (it lives in `unifiedClaudeScheduler.js`), but the
credit-cooldown patch in `claudeRelayService.js` / `claudeAccountService.js` did **not**.

**This must be re-applied before any other tuning** — it is the root cause of the
out_of_credits 429-hammer and wastes pool capacity on a billing-dead account.

---

## 2. Tuning workstreams

### 2.1 Re-apply credit-exhaustion cooldown (P0)
1. Confirm the diff is recoverable: check the box for `~/crs` git stash / `.bak` copies of
   `claudeRelayService.js` and `claudeAccountService.js`, and for the
   `loadbalance-fix-20260616` image (`docker images | grep loadbalance`). If neither exists,
   re-implement from the spec in §1.
2. Re-add `_detectCreditExhaustion(status, headers, body)` — strict match on
   `out_of_credits` / `org_level_disabled` / `overage-status: rejected` / "credit balance too low".
3. Wire it into the 3 × 429 mark sites in `claudeRelayService.js` (non-stream, stream-error,
   stream-end) → pass `{ creditExhausted: true }`.
4. In `claudeAccountService.js markAccountRateLimited(..., options)`: when `creditExhausted`,
   set cooldown to `max(now → claudeFiveHourResetsAt, CREDIT_EXHAUSTION_COOLDOWN_SECONDS)`.
5. Fire the `CLAUDE_OAUTH_CREDIT_EXHAUSTED` webhook so billing-dead accounts surface in ops.
6. Leave transient (no-reset) 429s on the short cooldown (see §2.2 for the value).

### 2.2 Scheduler / cooldown knob tuning
The cooldowns currently live as **code defaults with no compose override** (verified: the
`COOLDOWN`/`CREDIT_EXHAUSTION`/`UTILIZATION` env names are absent from `docker-compose.yml`
and `.env`). Promote them to env knobs so they are tunable without a rebuild:

| Knob | Current default | Recommended | Rationale |
|---|---|---|---|
| `CLAUDE_DEFAULT_RATELIMIT_COOLDOWN_SECONDS` | 90 | **90** (keep) | transient no-reset 429s; 90 s is fine for genuine short ratelimits |
| `CREDIT_EXHAUSTION_COOLDOWN_SECONDS` | 3600 | **3600** (keep) | billing exhaustion; do not re-probe for 1 h |
| `CLAUDE_UTILIZATION_LOAD_BALANCING` | ON | **ON** | dynamic least-util picks; `=false` reverts to pure priority |

Action: add these three to `docker-compose.yml` `environment:` (with `${VAR:-default}` form,
mirroring the existing `CRS_OAUTH_REAUTH_COOLDOWN_MS=${...:-1800000}` pattern) and to `.env`.
This makes future tuning a `docker compose up -d` (env reload), not a code rebuild.

### 2.3 Account-pool load-balancing verification
- Confirm `_sortPrimaryClaudeAccountsBeforeFallback` is wired and the `📊 Load-balance pick`
  log line fires on new (non-sticky) session assignment.
- Confirm session stickiness is resolved **before** the util sort (sticky sessions must not
  be re-balanced mid-conversation).
- Confirm `dynamic-priority.py` cron is running and not erroring. **Known pre-existing bug:**
  `NoneType .get` traceback on accounts with no usage object — non-blocking but should be
  guarded so the cron doesn't half-update priorities.
- Verify the dead account: `pool-samrenders` (`a9f4806a…`) was the out_of_credits trigger;
  it needs a **credit top-up** to truly rejoin (5h/7d windows are not the constraint).
  Until topped up, the credit-cooldown (§2.1) keeps it parked instead of hammered.

### 2.4 Concurrency caps + overload protection (today's storm)
Today a **ConnectionRefused storm** hit under ~17 concurrent agents; recovered via keepalive.
The relay restarted (container up only minutes at audit time). Hardening:

1. **Right-size the util→concurrency tiers.** Current tiers (`8/5/3/2/1`) are generous at low
   util. With ~10 accounts × 8 = 80 theoretical concurrent low-util streams, the bottleneck is
   **not** per-account concurrency — it is the node process / socket layer dropping connections
   under burst. Validate the tiers hold the fleet's real peak (≈17–25 concurrent) without the
   process refusing connections.
2. **Bound the proxy socket pool.** `PROXY_MAX_SOCKETS` / `PROXY_MAX_FREE_SOCKETS` are present
   in compose but **unset** (default unbounded). Set explicit ceilings (e.g.
   `PROXY_MAX_SOCKETS=256`, `PROXY_MAX_FREE_SOCKETS=32`) so a burst can't exhaust file
   descriptors → `ECONNREFUSED`.
3. **Confirm the 503 backpressure path returns cleanly** rather than dropping the socket.
   When all accounts are at concurrency limit the scheduler throws
   `CONSOLE_ACCOUNT_CONCURRENCY_FULL`; verify the relay turns that into a **503 with
   `Retry-After`**, not a connection reset — clients should back off, not see `ConnectionRefused`.
4. **Container resilience.** Ensure `restart: unless-stopped` on the relay service and a
   `healthcheck` so Docker auto-recovers a wedged process. Confirm the node process file-descriptor
   `ulimit` (`docker inspect` → `Ulimits`/host `LimitNOFILE`) is high enough (≥ 65536) for the
   socket count above.
5. **Fleet-side ceiling.** The durable fix for "17 concurrent heavy streams" is **also** to cap
   concurrent fleet dispatch (the spawner / keepalive), so the relay is never asked to hold more
   live streams than the pool's summed concurrency budget. Document the agreed cap with Sam
   before raising relay limits.

### 2.5 Session-routing health
- **Auth var:** every routed session must use `ANTHROPIC_AUTH_TOKEN=cr_…` (Bearer), never
  `ANTHROPIC_API_KEY` (format-validated client-side → "Invalid API key format / Please run /login").
- **Key-validity probe (authoritative — the relay decides):** malformed POST to
  `…:3005/api/v1/messages` with the `cr_` key → **HTTP 400 = key accepted**, **401 = stale/rejected**.
- **Canonical key:** macOS keychain `crs-fleet-key` (== Mac overlay token). Doppler
  `claude-ops/prd CRS_FLEET_KEY` has drifted stale before — if the box 401s, re-sync from keychain
  and re-push Doppler, else the next Doppler→box push re-breaks it.
- **Preflight gate:** `~/.claude/scripts/crs-overlay-preflight.sh` must accept
  `ANTHROPIC_AUTH_TOKEN` (it previously only checked `CLAUDE_CODE_OAUTH_TOKEN` and blocked ALL
  dispatch). Confirm it still passes (HTTP 400 = exit 0).
- **`✅ Cleared 401 error count` in relay logs is a SUCCESS** (counter cleared after a 200), not an
  error. Do not blindly grep-count `401`. Genuine failures are `🔒 Invalid API key attempt`.

---

## 3. Execution sequence (do in this order)

> All commands run **on the FRA box** (`ssh fra`). `$RP` = `$(docker exec crs-claude-relay-1 printenv REDIS_PASSWORD)`.

1. **Snapshot for rollback** (see §5) — back up `docker-compose.yml`, tag the running image, note current account state.
2. **Re-apply credit-cooldown** (§2.1) on-disk in `~/crs/src/...`. Do NOT bulk find-replace — edit the 3 mark sites + the service method surgically; grep each site first.
3. **Promote cooldown/util knobs to env** (§2.2) in `docker-compose.yml` + `.env`.
4. **Set socket-pool ceilings + restart policy + ulimit** (§2.4).
5. **Rebuild + restart relay only:**
   ```bash
   cd ~/crs && docker compose build claude-relay && \
   docker compose up -d claude-relay
   ```
   (Redis is NOT touched — preserve queues/account state.)
6. **Run §4 verification.** If any check fails, **roll back via §5** (must complete < 2 min).
7. Tag the validated image (e.g. `tuned-20260619`) and pin it in compose so a future restore is deterministic.

---

## 4. Verification (post-deploy)

Run all of these; the deploy is good only if every one passes.

1. **Health:** `curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:3005/health` → `200`.
2. **Key accepted:** malformed POST to `…:3005/api/v1/messages` with the `cr_` key → `400` (not 401).
3. **Real relay:** a `claude -p "reply: OK" --model haiku` through the overlay → returns a completion (proves end-to-end forward + auth).
4. **Credit-cooldown active (the P0 check):** in relay logs, confirm an `out_of_credits` 429
   produces a long cooldown, NOT a 90 s one — grep for the credit-exhaustion mark + the
   `CLAUDE_OAUTH_CREDIT_EXHAUSTED` webhook. Then confirm the exhausted account is **not
   re-selected** within the cooldown window:
   ```bash
   docker logs crs-claude-relay-1 --since 10m 2>&1 | grep -iE "credit|out_of_credits|cooldown|Load-balance pick"
   ```
   No account should appear in a `Load-balance pick` while it is credit-cooled.
5. **No repeat-hammer:** over a 5-min window, no single `claude:account:<uuid>` should accumulate
   more than a handful of 429s. (Pre-fix baseline was ~40/min on the dead account.)
6. **Load-balancing live:** under real fleet load, `📊 Load-balance pick` shows picks spread
   across multiple low-util accounts, not one account pinned to 100% while others sit at 0%.
7. **Concurrency gating:** force burst load (or replay the 17-agent peak) and confirm the relay
   returns `503` + `Retry-After` when saturated — **no `ECONNREFUSED` / ConnectionRefused** in
   client logs.
8. **Container auto-recovery:** `docker inspect crs-claude-relay-1 --format '{{.HostConfig.RestartPolicy.Name}}'`
   → `unless-stopped`; healthcheck status `healthy`.
9. **Cron clean:** `dynamic-priority.py` last run logged no `NoneType` traceback.

---

## 5. Rollback procedure (must complete in < 2 minutes — test it first)

> Redis is never cleared — account state and queues survive a relay rollback.

```bash
cd ~/crs

# 1. Restore the pre-tuning compose (taken in §3 step 1)
cp docker-compose.yml.bak-pretune-<TS> docker-compose.yml

# 2. Re-pin the last-known-good image (the running image at audit = cve-fix-20260615;
#    OR the validated prior tag if one exists)
#    Edit compose `image:` → weishaw/claude-relay-service:cve-fix-20260615
#    (compose has `build: .`, so to force the prebuilt image either comment out `build:`
#     for the rollback, or `docker compose up -d --no-build claude-relay`)

# 3. Restart relay ONLY (Redis untouched)
docker compose up -d --no-build claude-relay

# 4. Verify (< 30 s)
curl -s -o /dev/null -w 'health=%{http_code}\n' 127.0.0.1:3005/health   # expect 200
```

**Manual park/unpark a misbehaving account** (faster than a full rollback if only one account is bad):
```bash
RP=$(docker exec crs-claude-relay-1 printenv REDIS_PASSWORD)
docker exec crs-redis-1 redis-cli -a "$RP" --no-auth-warning \
  hset claude:account:<uuid> schedulable false   # true to re-enable
```
> Note: `schedulable=false` only stops **new** session assignment — existing session-sticky
> requests drain over their window.

**Pre-flight the rollback before the real deploy:** do steps 1–4 against the current image once,
time it, confirm < 2 min and health 200, then proceed with the tuning deploy.

---

## 6. Constraints & safety (carried from the agent brief)

- **No destructive bulk edits** on scheduler code — grep/inspect each site before editing.
- **Preserve Redis data** — never `FLUSHDB`/clear queues mid-fix.
- **Rollback < 2 min, tested first.**
- **Fleet impact:** changes affect every agent using the relay — coordinate the concurrency-cap
  and fleet-dispatch-ceiling numbers with Sam before deploying.
- **Never print** the `cr_` key, OAuth tokens, AWS secrets, or `REDIS_PASSWORD`.

---

## 7. Open items to confirm with Sam before deploy

1. Agreed **fleet concurrent-dispatch ceiling** (relay-side cap is moot if the fleet over-dispatches).
2. Whether the `loadbalance-fix-20260616` image/diff is recoverable on the box, or the
   credit-cooldown must be re-implemented from §1 spec.
3. Top-up status of `pool-samrenders` (billing-dead account) — keep parked vs. top up vs. remove from pool.
