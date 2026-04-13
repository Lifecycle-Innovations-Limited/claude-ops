---
name: ops-speedup
description: Cross-platform system speedup and cleanup. Auto-detects macOS/Linux/WSL, scans for reclaimable disk space, memory pressure, runaway processes, startup bloat, network issues. CleanMyMac built into Claude Code.
argument-hint: "[scan|clean|deep|auto]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - AskUserQuestion
effort: low
maxTurns: 30
---

## Runtime Context

Before scanning, load:
1. **Preferences**: `cat ${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json` — read `timezone` for timestamps


# OPS > SPEEDUP — System Optimizer

## CLI/API Reference

### ops-speedup bin script

| Command | Usage | Output |
|---------|-------|--------|
| `${CLAUDE_PLUGIN_ROOT}/bin/ops-speedup` | Visual header + quick scan | Formatted ASCII output |
| `${CLAUDE_PLUGIN_ROOT}/bin/ops-speedup --json` | Machine-readable diagnostics | JSON with disk, memory, process data |
| `zsh ~/.claude/scripts/speedup.sh` | macOS comprehensive cleanup script | Autonomous cleanup with progress |

### System commands used

| Command | Purpose |
|---------|---------|
| `diskutil apfs list` | Purgeable space on APFS volumes |
| `vm_stat` | macOS memory pressure and page stats |
| `ps aux -m` / `ps aux --sort=-%mem` | Top processes by CPU/RAM |
| `brew outdated --json` / `brew cleanup --dry-run` | Homebrew cache analysis |
| `xcrun simctl list runtimes` / `xcrun simctl delete unavailable` | Xcode simulator management |
| `tmutil listlocalsnapshots /` | Time Machine local snapshots |
| `launchctl list` / `launchctl bootout` | Launch agent management |
| `sudo dscacheutil -flushcache` + `sudo killall -HUP mDNSResponder` | macOS DNS flush |
| `sudo systemd-resolve --flush-caches` | Linux DNS flush |
| `journalctl --vacuum-time=7d` | Linux journal log cleanup |

---

## Phase 1 — Visual header + system scan

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-speedup 2>/dev/null || echo "SCAN_FAILED"
```

## Phase 2 — Deep diagnostic scan

Gather full diagnostics (the --json flag returns machine-readable data):

```!
${CLAUDE_PLUGIN_ROOT}/bin/ops-speedup --json 2>/dev/null || echo '{}'
```

## macOS fast path

On macOS, there's an existing comprehensive speedup script at `~/.claude/scripts/speedup.sh`. For `auto`, `clean`, or `deep` modes, run it directly:

```bash
zsh ~/.claude/scripts/speedup.sh
```

This handles process cleanup, memory optimization, disk cleanup, network optimization, and more — all autonomously. The ops-speedup adds the visual dashboard wrapper and cross-platform support on top.

## Your task

Parse the diagnostic JSON and present an actionable cleanup report. Then execute cleanup actions the user approves. Run ALL diagnostic probes in parallel — never sequential when independent.

### OS-specific scan additions

After parsing the pre-gathered JSON, run these **parallel** additional scans based on detected OS:

#### macOS additional scans

```bash
# Parallel scans — run all at once
# 1. Homebrew outdated
brew outdated --json 2>/dev/null | jq 'length' || echo "0"

# 2. Simulator runtimes (Xcode)
xcrun simctl list runtimes 2>/dev/null | grep -c "unavailable" || echo "0"

# 3. Old iOS device support files
du -sm ~/Library/Developer/Xcode/iOS\ DeviceSupport 2>/dev/null | awk '{print $1}' || echo "0"

# 4. Homebrew cleanup potential
brew cleanup --dry-run 2>/dev/null | tail -1 || echo "nothing"

# 5. Time Machine local snapshots
tmutil listlocalsnapshots / 2>/dev/null | wc -l | tr -d ' ' || echo "0"

# 6. System caches
du -sm ~/Library/Caches 2>/dev/null | awk '{print $1}' || echo "0"

# 7. Application caches (Electron apps)
du -sm ~/Library/Application\ Support/Slack/Cache 2>/dev/null | awk '{print $1}' || echo "0"
du -sm ~/Library/Application\ Support/discord/Cache 2>/dev/null | awk '{print $1}' || echo "0"
du -sm ~/Library/Application\ Support/Code/Cache 2>/dev/null | awk '{print $1}' || echo "0"

# 8. Disabled SIP check
csrutil status 2>/dev/null || echo "unknown"

# 9. Spotlight indexing status
mdutil -s / 2>/dev/null || echo "unknown"

# 10. Purgeable space
diskutil apfs list 2>/dev/null | grep -i "purgeable" || echo "unknown"
```

#### Linux additional scans

```bash
# 1. Old kernels
dpkg --list 'linux-image-*' 2>/dev/null | grep ^ii | wc -l || rpm -qa kernel 2>/dev/null | wc -l || echo "?"

# 2. Package cache
du -sm /var/cache/apt/archives 2>/dev/null | awk '{print $1}' || du -sm /var/cache/yum 2>/dev/null | awk '{print $1}' || echo "0"

# 3. Journal logs
journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[MG]' || echo "?"

# 4. Orphan packages
apt list --installed 2>/dev/null | wc -l || echo "?"

# 5. Systemd failed units
systemctl --failed --no-pager 2>/dev/null | grep -c "loaded" || echo "0"
```

---

## Phase 3 — Present cleanup report

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS > SYSTEM SPEEDUP — [OS] [version] [chip]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 HEALTH SCORE: [0-100] / 100  [████████░░ 80%]

 DISK                                    RECLAIMABLE
 ────────────────────────────────────────────────────
 Brew cache          [N] MB              ✓ safe
 npm cache           [N] MB              ✓ safe
 Xcode DerivedData   [N] MB              ✓ safe
 Xcode DeviceSupport [N] MB              ✓ safe
 Docker unused       [N] MB              ✓ safe
 System caches       [N] MB              ⚠ review
 App caches          [N] MB              ✓ safe
 Trash               [N] MB              ✓ safe
 Logs                [N] MB              ✓ safe
 Downloads           [N] MB              ⚠ review
 /tmp                [N] MB              ✓ safe
 ────────────────────────────────────────────────────
 TOTAL RECLAIMABLE:  [N] GB

 MEMORY
 ────────────────────────────────────────────────────
 Pressure:    [N]%    Swap: [N] MB
 Processes:   [N]
 Top CPU:     [process] ([N]%)
 Top RAM:     [process] ([N] MB)

 NETWORK
 ────────────────────────────────────────────────────
 DNS:         [N]ms   (< 50ms = good)

 STARTUP
 ────────────────────────────────────────────────────
 Login items:   [N]
 Launch agents: [N]

──────────────────────────────────────────────────────
 Cleanup options:
──────────────────────────────────────────────────────
 1) Quick clean — caches, tmp, logs           ~[N] GB
 2) Full clean — + trash, brew, npm, docker   ~[N] GB
 3) Deep clean — + DerivedData, simulators    ~[N] GB
 4) Custom — pick what to clean
 5) Memory — kill top RAM hogs
 6) Startup — review & disable launch agents
 7) Network — flush DNS, optimize resolver
 8) Skip — just show the report

 → Type a number or describe what you want
──────────────────────────────────────────────────────
```

**Health score calculation:**
- Start at 100
- Disk > 90% used: -20
- Disk > 80% used: -10
- RAM pressure > 80%: -15
- RAM pressure > 60%: -5
- Swap > 1GB: -10
- DNS > 100ms: -5
- > 500 processes: -5
- > 10 launch agents: -5
- > 5GB reclaimable: -10
- > 10GB reclaimable: -20

Use AskUserQuestion for the user's choice.

---

## Phase 4 — Execute cleanup

**Before executing any cleanup**, use `AskUserQuestion` to confirm the scope and estimated impact:

```
About to run [quick/full/deep] clean:
  Brew cache:        [N] MB  ✓
  npm cache:         [N] MB  ✓
  Logs:              [N] MB  ✓
  Tmp files:         [N] MB  ✓
  [Full: Trash:      [N] MB  ✓]
  [Full: Docker:     [N] MB  ✓]
  [Deep: DerivedData [N] MB  ✓]
  [Deep: Simulators  [N] count ✓]
  ────────────────────────────
  Total:             ~[N] GB

  [Proceed]  [Switch to custom — pick categories]  [Cancel]
```

### Quick clean (option 1)

```bash
# macOS
brew cleanup 2>/dev/null
npm cache clean --force 2>/dev/null
rm -rf ~/Library/Logs/*.log 2>/dev/null
rm -rf /tmp/ops-* /tmp/yolo-* /tmp/claude-* 2>/dev/null

# Linux
sudo apt-get autoclean 2>/dev/null || sudo yum clean all 2>/dev/null
npm cache clean --force 2>/dev/null
sudo journalctl --vacuum-time=7d 2>/dev/null
```

### Full clean (option 2)

Quick clean PLUS:

```bash
# macOS
rm -rf ~/.Trash/* 2>/dev/null
brew autoremove 2>/dev/null
docker system prune -f 2>/dev/null

# Linux
rm -rf ~/.local/share/Trash/files/* 2>/dev/null
docker system prune -f 2>/dev/null
```

### Deep clean (option 3)

Full clean PLUS:

```bash
# macOS only
rm -rf ~/Library/Developer/Xcode/DerivedData/* 2>/dev/null
xcrun simctl delete unavailable 2>/dev/null
rm -rf ~/Library/Caches/com.apple.dt.Xcode 2>/dev/null
```

### Custom (option 4)

Show each category with size and let user toggle on/off.

### Memory (option 5)

Show top 10 processes by RAM. Use `AskUserQuestion` with `multiSelect` to let user pick which to kill:

```
Top processes by RAM:
  [ ] [process] — [N] MB (PID [N])
  [ ] [process] — [N] MB (PID [N])
  ...

  [Kill selected]  [Skip]
```

```bash
# macOS
ps aux -m | head -11

# Linux
ps aux --sort=-%mem | head -11
```

**NEVER kill**: Finder, WindowServer, kernel_task, systemd, init, loginwindow, Claude.

### Startup (option 6)

List launch agents with toggle:

```bash
# macOS
ls -la ~/Library/LaunchAgents/ 2>/dev/null
launchctl list 2>/dev/null | grep -v "com.apple" | head -20
```

Offer to disable selected agents:
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/<plist> 2>/dev/null
```

### Network (option 7)

```bash
# macOS
sudo dscacheutil -flushcache 2>/dev/null
sudo killall -HUP mDNSResponder 2>/dev/null

# Linux
sudo systemd-resolve --flush-caches 2>/dev/null || sudo resolvectl flush-caches 2>/dev/null
```

Optionally test and suggest switching to faster DNS (1.1.1.1 or 8.8.8.8).

---

## Phase 5 — Results

After cleanup:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPS > CLEANUP COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Reclaimed:  [N] GB
 Disk free:  [before] GB -> [after] GB
 Health:     [before]/100 -> [after]/100
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If user came from `/ops:dash`, offer `b) Back to dashboard`.

---

## Mode shortcuts

If `$ARGUMENTS` is:
- `scan` or empty — run Phase 1-3 only (report, no cleanup)
- `clean` — run quick clean automatically (no menu)
- `deep` — run deep clean automatically (no menu)
- `auto` — run full clean automatically, report results
