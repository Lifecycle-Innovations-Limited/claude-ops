---
name: ops-mac
description: macOS diagnose-and-fix command center. Wraps the macos-toolkit CLI suite (machealth, netwhiz, pstop, macdog, lanchr, macbroom, macctl, macfig, updater) behind one entrypoint — self-installs the suite on first use, runs a read-only baseline audit (security, launch agents, processes, network, disk, system health), and applies guarded fixes (firewall, stale daemons, cache cleanup) with per-action confirmation.
argument-hint: '[audit|health|net|disk|procs|security|launchd|fix|ensure|update]'
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - AskUserQuestion
effort: low
maxTurns: 30
---

# OPS ► MAC — macOS Diagnose & Fix

One command for native macOS health: it bundles the [`macos-toolkit`](https://github.com/lu-zhengda/macos-toolkit) CLI suite, **auto-installs it on first use**, runs a read-only baseline, and remediates the common offenders behind explicit confirmations.

All work routes through `${CLAUDE_PLUGIN_ROOT}/bin/ops-mac`, the single source of truth for install + probes + the aggregate audit. The bundled CLIs:

| Tool | Domain | ops-mac subcommand |
| --- | --- | --- |
| `machealth` | composite health (CPU/mem/disk/thermal/battery/iCloud/TM/net) | `health` |
| `netwhiz` | network + WiFi diagnostics | `net` / `net wifi` |
| `macbroom` | disk cleanup & reclaimable cache scan | `disk` |
| `pstop` | process monitoring (CPU/mem hogs) | `procs` |
| `macdog` | security & privacy audit | `security` |
| `lanchr` | launchd agent/daemon health (`doctor`) | `launchd` |
| `macctl` | power / display / audio control | `power` |
| `macfig` | hidden macOS defaults | `defaults` |
| `updater` | app update management | `update` |

## Platform guard

This skill is **macOS only**. The dispatcher exits with code 3 on non-Darwin. For Linux/WSL/Windows system optimization use `/ops:speedup` (cross-platform). The two are complementary — `/ops:mac` is the deep macOS-native surface; `/ops:speedup` is the portable cleaner.

## Two hard-won quirks (baked into the dispatcher)

1. **`machealth check`/`diagnose` can hang forever** on a stuck Time Machine / iCloud probe (its checks run in parallel with no per-probe skip flag). Every machealth call is wrapped in a hard `timeout` (default 25s, override `OPS_MAC_MACHEALTH_TIMEOUT`). If it trips, the other probes are still reliable — never block on it.
2. **The toolkit's pretty TUI tables render EMPTY when stdout isn't a TTY.** The dispatcher forces `--json` for headless/agent consumers (`macbroom`, `pstop`, `macdog`, `lanchr`). When you need machine data, always pass `--json`.

## Runtime Context

Before anything, ensure the suite is installed (idempotent — no-op if already present):

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-mac ensure
```

## Mode routing

Dispatch on `$ARGUMENTS`:

- empty / `audit` → **Baseline flow** (read-only, below)
- `health` / `net` / `disk` / `procs` / `security` / `launchd` / `power` / `update` → run that single probe and print verbatim:
  ```bash
  ${CLAUDE_PLUGIN_ROOT}/bin/ops-mac <subcommand>
  ```
- `fix` → **Remediation flow** (below, Rule 5 confirmations)
- `ensure` / `install` → run `ops-mac ensure` and report what was added

## Baseline flow (`/ops:mac` or `/ops:mac audit`)

Run the aggregate audit — it composes the reliable probes in one call:

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-mac audit
```

Then summarize for the user with a verdict per area:

```
OPS ► MAC AUDIT — [version] ([arch])

🔴/🟡/🟢 Security    grade [X]/100 — [firewall/SIP/FileVault/Gatekeeper/remote-login]
🔴/🟡/🟢 Launchd     [N] genuinely-broken user daemons (Apple -9/SIGKILL noise filtered out)
🟢 Processes  top hog: [name] [N]% CPU
🟢 Network    [iface] [ip] — [ok/degraded]
🟢 Disk       ~[N] GB safe reclaimable (biggest: [cache] [N] GB)
⚠ Health     [machealth result, or "probe timed out — TM/iCloud stuck"]

Next: /ops:mac fix to remediate, or pick one area.
```

**Launchd noise filter** — `lanchr doctor` flags ~50+ "critical" entries; most are normal:
- Apple on-demand agents exit `-9` (SIGKILL) when idle — **expected, not broken**.
- Stale Apple plist paths (cvmsCompAgent, BluetoothUIService, battery helper) — **cosmetic**.
- The **actionable** ones are user/3rd-party daemons with `exit status: 1` or a missing binary you own. Surface only those.

## Remediation flow (`/ops:mac fix`)

Run the audit first to know what's wrong, then offer fixes. **Per plugin Rule 5, every mutating action needs its own confirmation** — never batch-execute. Present via `AskUserQuestion`, max 4 options each.

Common offenders and their guarded fixes:

### 1. Firewall off
```
macdog reports the application firewall is OFF.
  [Enable firewall]  [Enable + stealth mode]  [Skip]
```
On confirm:
```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on
# stealth (optional): sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode on
```

### 2. Stale / crashing launchd user daemons
For each actionable entry from `lanchr doctor` (missing binary, or repeated `exit 1`), confirm **individually**:
```
com.example.foo — binary missing at [path]. This launchd job is dead.
  [Show the plist first]  [Remove it]  [Disable (keep file)]  [Skip]
```
Use `lanchr` to remediate where possible; otherwise `launchctl bootout`/`disable` after showing the plist. **Never touch a daemon the user relies on** (CRS/haproxy, gbrain push, ops-daemon, cloudflared tunnels, watchdogs) without spelling out exactly what it is — cross-check before recommending removal.

### 3. Reclaimable disk
```
macbroom found ~[N] GB of safe cache. Categories: [list].
  [Clean safe caches]  [Pick categories]  [Review largest first]  [Skip]
```
On confirm (safe categories only):
```bash
macbroom clean --caches            # confirm prompt; or --yolo only after explicit approval
```
Never run `macbroom clean --all --yolo` without per-category approval.

### 4. App updates
```bash
${CLAUDE_PLUGIN_ROOT}/bin/ops-mac update    # updater check — then confirm before applying
```

After any fix, re-run the relevant probe and show before→after.

## Mobile mode (Rule 7)

If `$SSH_CONNECTION`/`$SSH_CLIENT`/`$SSH_TTY` is set, `$OPS_MOBILE=1`, or `$COLUMNS` < 80: drop the boxes/tables, emit 3–8 plain lines, one fact each. Example:

```
mac audit:
security B/100 — firewall OFF.
launchd: 2 dead user daemons.
disk: 8.6 GB safe to clean.
health: machealth probe stuck (TM/iCloud).
fix? /ops:mac fix
```

## When to use this vs other skills

| Want… | Use |
| --- | --- |
| macOS-native deep diagnose + fix (firewall, launchd, network, security) | `/ops:mac` |
| Cross-platform cleaner (Linux/WSL/Windows too) | `/ops:speedup` |
| Quick "is everything connected?" integration glance | `/ops:status` |
| Full health check + auto-repair of the **ops plugin itself** | `/ops:doctor` |
