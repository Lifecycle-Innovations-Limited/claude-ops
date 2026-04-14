# OS Compatibility

> **TL;DR.** claude-ops targets macOS, Linux (debian/ubuntu/fedora/rhel/arch/suse/alpine + WSL2), and Windows (native via Git Bash/MSYS/Cygwin). Every channel has a supported install path on every OS. Some have reduced functionality on some OSes — see the matrix.

The OS detection layer (`lib/os-detect.{sh,mjs}`), credential cascade (`lib/credential-store.{sh,mjs}`), and URL opener (`lib/opener.{sh,mjs}`) abstract the platform differences so individual skills don't have to. Every install command, keychain call, and daemon registration in the plugin routes through these helpers.

## Supported hosts

| OS | Tier | Pkg manager | Keyring backend | Daemon | Notes |
|---|---|---|---|---|---|
| **macOS 12+** | 1 | `brew` | `security` (Keychain) | `launchd` | All channels, all features. Native. |
| **Ubuntu / Debian** | 1 | `apt-get` | `secret-tool` (libsecret) | `systemd --user` | Install `libsecret-tools` + `gnome-keyring` for secure storage. |
| **Fedora / RHEL / Rocky / Alma** | 1 | `dnf` | `secret-tool` | `systemd --user` | `gnome-keyring` ships by default on most desktop spins. |
| **Arch / Manjaro** | 2 | `pacman` (AUR via `yay`) | `secret-tool` | `systemd --user` | Some tools come from AUR (`gogcli`); install `yay` first. |
| **openSUSE / SLES** | 2 | `zypper` | `secret-tool` | `systemd --user` | Less tested but the same flow as Fedora. |
| **Alpine** | 2 | `apk` | `secret-tool` (if installed) | `openrc` (manual) | Headless deployments — no Slack browser autolink. |
| **Windows 10/11 native** | 2 | `winget` → `scoop` → `choco` | `wincred` (write-only) | Task Scheduler | Use Git Bash or PowerShell. `cmdkey` cannot read passwords from the CLI; reads cascade through `keytar`/encrypted JSON. |
| **WSL2** | 1 | `apt-get` (or distro of choice) | `secret-tool` (preferred) → `wincred` (fallback) | `systemd --user` | Inherits Linux. Browser profiles auto-discovered from `/mnt/c/Users/$USER/AppData/Local/...`. URL opens via `wslview` if installed. |
| **Docker (any host)** | 1 | `apt-get` (Ubuntu 24.04 base) | `enc-json` (default) → `secret-tool` (if you unlock a keyring inside the container) | foreground loop (no init) | Turnkey image with Node 22, `gh`, `aws`, `doppler`, `jq`, `expect`, `libsecret-tools` pre-installed. See [`docker.md`](./docker.md) for quick-start, credential mounting, and limitations (no `launchd`/`systemd`, no browser automation without an X11 socket mount). |

> **Tier 1** = covered by CI (`.github/workflows/cross-os.yml` runs ubuntu-latest, macos-latest, windows-latest on every push; `.github/workflows/docker-build.yml` builds and smoke-tests the container image). **Tier 2** = supported but not in matrix.

## OS / package-manager detection

`bin/ops-setup-detect` emits a `host` block in its JSON output describing the runtime environment. You can also run the helpers directly:

```bash
bash lib/os-detect.sh        # → JSON: {os, distro_id, arch, pkg_mgr, keyring_backend, opener, shell, is_wsl, browser_profiles}
node lib/os-detect.mjs       # same schema, different language
bash bin/ops-setup-install --list-pkg-mgr
# → os=debian pkg_mgr=apt-get cmd="sudo apt-get install -y jq"
```

`ops_pkg_mgr` follows this priority cascade: `brew` (any OS) → `apt-get`/`dnf`/`pacman`/`zypper`/`apk` (Linux native) → `winget`/`scoop`/`choco` (Windows). The first available wins.

## Install commands per channel

### Email — `gog` (a.k.a. `gogcli`)

| OS | Command |
|---|---|
| macOS / Linuxbrew | `brew install gogcli` |
| Debian / Ubuntu | `brew install gogcli` (Linuxbrew) — no native deb yet |
| Fedora / RHEL | `brew install gogcli` (Linuxbrew) |
| Arch / Manjaro | `yay -S gogcli` |
| Windows | `winget install -e --id steipete.gogcli` |
| Anywhere | `git clone https://github.com/steipete/gogcli.git && cd gogcli && make` |

After install: `gog auth credentials /path/to/client_secret.json && gog auth add you@example.com --services gmail,calendar,drive,contacts,docs,sheets`. Refresh tokens land in the OS keyring automatically (Keychain / Secret Service / Credential Manager). See [`gogcli.sh`](https://gogcli.sh/) for the full reference.

### Calendar — `gog calendar`

Same install as email — gog ships both. `gog cal` is **not** a valid alias; always use `gog calendar`. Probe with `gog calendar calendars --json`. Today's events: `gog calendar events primary --today --json`. The setup wizard auto-detects the calendar scope and prompts for re-auth if missing.

If `gog` isn't installed, the wizard falls back to the Google Calendar MCP connector (read-only — write ops require explicit Claude Desktop permission grant).

### Slack

The Slack MCP uses browser-session tokens (`xoxc` + `xoxd`) — no admin approval needed. Tokens are extracted via `bin/ops-slack-autolink.mjs` which:

| OS | Browser-profile discovery | Auth flow |
|---|---|---|
| macOS | Chrome / Chromium / Brave / Arc under `~/Library/Application Support/...` | Playwright headed |
| Linux | Chrome / Chromium / Brave under `~/.config/...` | Playwright headed (requires GUI) |
| WSL2 | Linux paths plus `/mnt/c/Users/$USER/AppData/Local/Google/Chrome/User Data` | Playwright headed via WSLg or X server |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data` + Brave/Chromium variants | Playwright headed |

The autolink emits `{"type":"error","message":"no display available","headless_available":false}` when Playwright can't launch a headed Chromium (e.g. headless CI / SSH session). Run `/ops:setup slack` on a desktop machine in that case, or paste tokens manually.

Tokens are stored via the credential cascade (see below). Service names: `slack-xoxc`, `slack-xoxd`.

### Telegram

`bin/ops-telegram-autolink.mjs` uses gram.js to capture an MTProto session string. Works identically on every OS — the only platform difference is where the credentials are persisted (cred cascade). Service names: `telegram-api-id`, `telegram-api-hash`, `telegram-phone`, `telegram-session`.

### WhatsApp — `wacli`

| OS | Status | Notes |
|---|---|---|
| macOS | Tier 1 | `wacli` builds from source: `git clone … && go build -o /usr/local/bin/wacli ./cmd/wacli` |
| Linux | Tier 1 | Same build flow; install Go first: `apt-get install -y golang` etc. |
| WSL2 | Tier 1 | Same as Linux. |
| Windows | Tier 3 | Build under WSL — native Windows builds untested. |

### Doppler

| OS | Command |
|---|---|
| macOS / Linuxbrew | `brew install dopplerhq/cli/doppler` |
| Debian / Ubuntu | `curl -Ls https://cli.doppler.com/install.sh \| sudo sh` |
| Fedora / RHEL | `sudo rpm --import https://packages.doppler.com/public.key && sudo dnf install -y doppler` |
| Arch | `yay -S doppler-cli` |
| Alpine | `apk add --no-cache doppler-cli` |
| Windows (winget) | `winget install Doppler.doppler` |
| Windows (scoop) | `scoop bucket add doppler https://github.com/DopplerHQ/scoop-doppler.git; scoop install doppler` |

### Other CLIs

`bin/ops-setup-install` ships a translation table covering `jq`, `git`, `gh`, `aws`, `node`, `expect`, `sentry-cli`. Where the package name differs across managers, the script picks the right one automatically:

| Tool | brew | apt-get | dnf | pacman | zypper | apk | winget | scoop | choco |
|---|---|---|---|---|---|---|---|---|---|
| `jq`/`git`/`expect` | same | same | same | same | same | same | same | same | same |
| `gh` | gh | gh | gh | github-cli | gh | gh | GitHub.cli | gh | gh |
| `aws` | awscli | awscli | awscli | aws-cli | awscli | awscli | Amazon.AWSCLI | aws | awscli |
| `node` | node | nodejs | nodejs | nodejs | nodejs | nodejs | OpenJS.NodeJS.LTS | nodejs-lts | nodejs-lts |
| `sentry-cli` | sentry-cli | (npm i -g @sentry/cli) | (npm) | (npm) | (npm) | (npm) | (npm) | (npm) | (npm) |

Run `bash bin/ops-setup-install --json` to get a `[{tool, status}]` report (`status ∈ {present, installed, manual, failed}`) consumable by `/ops:setup` and `/ops:doctor`.

## Credential storage

Every secret stored or read by claude-ops flows through `lib/credential-store.{sh,mjs}`. The cascade tries each backend in priority order and uses the first one that works:

```
                    ┌──────────────────────────────────────────────┐
ops_cred_set   ──▶  │ 1. OS-native:  security  (macOS)             │
                    │                secret-tool  (Linux libsecret)│
                    │                cmdkey  (Windows; write-only) │
                    │ 2. keytar    — if `node -e "import('keytar')"│
                    │                resolves                      │
                    │ 3. enc-json  — AES-256-GCM/CBC at            │
                    │                $XDG_DATA_HOME/claude-ops/    │
                    │                secrets.enc.json (master key  │
                    │                in $CLAUDE_OPS_MASTER_KEY or  │
                    │                $XDG_DATA_HOME/.../.masterkey)│
                    │ 4. plain     — 0600 JSON (last resort, warns)│
                    └──────────────────────────────────────────────┘
```

**Backend selection per OS** (defaults; cascade still applies on miss):

| OS | First backend | Notes |
|---|---|---|
| macOS | `security` | Native, full read+write. |
| Linux (with libsecret) | `secret-tool` | Native, full read+write. Requires unlocked keyring. |
| Linux (without libsecret) | `keytar` if installed → `enc-json` | Encrypted JSON works without any system service. |
| Windows | `wincred` (write only) | Reads cascade through `keytar` → `enc-json`. PowerShell `CredentialManager` module would unlock native reads — TODO. |
| WSL2 | `secret-tool` if linked → `wincred` (write only) | Either side, your choice. |
| CI / locked keyring | `enc-json` | Master key via `$CLAUDE_OPS_MASTER_KEY`. |

**Override the cascade for testing:**

```bash
CLAUDE_OPS_CRED_BACKEND=plaintext-json bash lib/credential-store.sh set foo bar baz
bash lib/credential-store.sh get foo bar
# → baz
```

Backend names: `security`, `secret-tool`, `wincred`, `keytar`, `enc-json`, `plaintext-json`.

**Migration from earlier macOS-only versions:** none required. `security`-stored credentials are still found first on macOS. New writes also land in `security` first, then cascade as needed.

## Daemon / background jobs

`scripts/ops-daemon.sh` registers itself with the host's job scheduler via `bash scripts/ops-daemon.sh --install`. Detection routes through `ops_os`:

| OS | Mechanism | Files written |
|---|---|---|
| macOS | `launchd` user agent | `~/Library/LaunchAgents/com.claude-ops.daemon.plist` + `…wacli-keepalive.plist` |
| Linux / WSL2 | `systemd --user` unit + timer | `~/.config/systemd/user/claude-ops.service`, `claude-ops.timer`, `claude-ops-wacli-keepalive.service` |
| Windows | Task Scheduler | `ClaudeOpsDaemon` task running `bash.exe scripts/ops-daemon.sh --run-once` every 5 min (falls back to `pwsh.exe` wrapper if Git Bash isn't on PATH) |

**Cadence** is 5 minutes everywhere (`/SC MINUTE /MO 5` on Windows, `OnUnitActiveSec=5min` on systemd, throttled-loop on launchd).

**Uninstall:** `bash scripts/ops-daemon.sh --uninstall`. Idempotent — reinstalling overwrites.

**Verify:** `bash scripts/ops-daemon.sh --os` echoes the detected OS; `--help` lists every flag.

## Browser automation

`bin/ops-slack-autolink.mjs` (and any future browser-driven setup) uses `lib/os-detect.mjs::browserProfileDirs()` to discover Chrome / Chromium / Brave / Arc profile directories that actually exist on the host:

| OS | Path roots scanned |
|---|---|
| macOS | `~/Library/Application Support/{Google/Chrome, Chromium, BraveSoftware/Brave-Browser, Arc/User Data}` |
| Linux | `~/.config/{google-chrome, chromium, BraveSoftware/Brave-Browser}` |
| WSL2 | Linux roots plus `/mnt/c/Users/$USER/AppData/Local/Google/Chrome/User Data` |
| Windows | `%LOCALAPPDATA%\{Google\Chrome, Chromium, BraveSoftware\Brave-Browser}\User Data` |

The autolink picks the first existing Chrome-family profile by default; pass `--profile-dir <path>` to override. If no profile exists, it falls back to a fresh `$XDG_DATA_HOME/claude-ops/chromium-profile` directory.

When Playwright can't launch a headed Chromium (no display, missing system libs), the script emits a structured error and exits non-zero rather than crashing.

## URL opener

`lib/opener.{sh,mjs}` provides `ops_open` / `ops_open_url` / `ops_open_dir`:

| OS | Resolved opener |
|---|---|
| macOS | `open` |
| Linux | `xdg-open` |
| WSL2 | `wslview` (preferred — opens in Windows host browser) → `xdg-open` |
| Windows | `cmd.exe /c start` |

```bash
bash lib/opener.sh url https://example.com
node lib/opener.mjs url https://example.com
```

## Dev environment

**Required tools:** `bash` (4+), `node` (22+), `git`, `jq` (recommended), `python3` (for some health probes). Install via `bash bin/ops-setup-install <tool>` — it picks the right package manager for you.

**CI matrix:** [`.github/workflows/cross-os.yml`](../.github/workflows/cross-os.yml) runs on every push and PR against `ubuntu-latest`, `macos-latest`, and `windows-latest`. It exercises `lib/os-detect.{sh,mjs}` and `lib/credential-store.{sh,mjs}` plus `tests/lib/smoke.sh`.

**Run tests locally:**

```bash
bash tests/lib/smoke.sh
# → 7 PASSED / 8 TOTAL (1 SKIP on hosts without an unlocked native keyring)
```

The smoke suite isolates state via `mktemp -d` for `XDG_DATA_HOME` so the host's real `secrets.json` is never touched.

## Known limitations

- **Windows `wincred` is write-only from CLI.** `cmdkey` doesn't expose stored passwords. Reads cascade through `keytar` → encrypted JSON. A future PR can add a PowerShell `CredentialManager`-module read path.
- **Slack autolink needs a desktop environment.** Headless Linux servers (CI, SSH-only boxes) emit `{"type":"error","headless_available":false}`. Run `/ops:setup slack` on a workstation, or paste tokens manually.
- **Alpine and Tier-2 distros are best-effort.** They aren't in CI; expect minor friction.
- **WSL credential storage is per-side.** Storing under WSL `secret-tool` doesn't appear in Windows `wincred` and vice versa. Pick one side and stick with it.
- **`gog` on Arch comes from AUR.** Vanilla `pacman` can't install it; `yay` (or another AUR helper) is required.
- **`pkg_install_cmd`'s `sudo` is baked in for Linux.** If you're already root or use `doas`, override the env or shell out to the `ops_pkg_install_cmd` helper to inspect the resolved command first.

## Testing on other OSes

Contributors without every OS locally can verify cross-OS changes by:

1. **Watching CI.** `.github/workflows/cross-os.yml` exercises every helper on the three matrix runners.
2. **Running the smoke suite under the sibling shell.** On macOS: `bash tests/lib/smoke.sh`; on Windows Git Bash: same command. The suite is self-contained.
3. **Forcing a backend.** `CLAUDE_OPS_CRED_BACKEND=enc-json bash tests/lib/smoke.sh` exercises the encrypted-JSON path even on a host with a real keyring.
4. **Spinning up a one-off VM.** `multipass launch --name ops-test 24.04 && multipass exec ops-test -- bash -c "git clone … && bash tests/lib/smoke.sh"` for ad-hoc Ubuntu validation.

## Planned

- PowerShell `CredentialManager` module integration so Windows can read back stored secrets natively.
- `apt`/`dnf` packaging of `gogcli` so Linux users don't need Linuxbrew.
- Smoke tests for the daemon-install flow (currently unit-tested by hand).
- Per-OS performance benchmarks in CI to catch regressions in cold-start time.
