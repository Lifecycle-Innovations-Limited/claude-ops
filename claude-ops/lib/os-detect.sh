#!/usr/bin/env bash
# os-detect.sh — Cross-OS detection helpers for the claude-ops plugin.
#
# This file is a SOURCED library, not a standalone executable. The shebang
# above exists purely so editors (vim/VS Code/etc.) pick the right syntax
# highlighter and LSP. Source it from other scripts via:
#   source "$(dirname "$0")/../lib/os-detect.sh"
#
# It exposes a handful of `ops_*` functions that normalize host OS, CPU arch,
# package manager, keyring backend, URL opener, shell, and browser-profile
# locations across macOS, Linux (incl. WSL), and Windows (Git Bash/MSYS/Cygwin).
#
# Running this file directly (e.g. `bash os-detect.sh`) emits the full
# detection result as JSON — handy for debugging (see guard at EOF).
#
# Design notes:
#   - Idempotent: gated by __OPS_OS_DETECT_SH_LOADED__ so repeat sourcing is free.
#   - Non-invasive: we only enable `set -euo pipefail` if invoked directly; when
#     sourced we leave the caller's shell options untouched.
#   - No hard dependency on jq — we fall back to a hand-rolled JSON emitter.

# ─── Re-source guard ────────────────────────────────────────────────────────
if [[ -n "${__OPS_OS_DETECT_SH_LOADED__:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
__OPS_OS_DETECT_SH_LOADED__=1

# Only clobber shell options when run directly; sourced callers keep their own.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
fi

# ─── ops_os: normalized OS/distro identifier ────────────────────────────────
# Echoes: macos | debian | fedora | arch | suse | alpine | linux | wsl | windows | unknown
ops_os() {
  local uname_s
  uname_s="$(uname -s 2>/dev/null || echo unknown)"
  case "$uname_s" in
    Darwin) echo "macos"; return 0 ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows"; return 0 ;;
    Linux)
      # WSL advertises itself in /proc/version.
      if [[ -r /proc/version ]] && grep -qi microsoft /proc/version 2>/dev/null; then
        echo "wsl"; return 0
      fi
      if [[ -r /etc/os-release ]]; then
        # shellcheck disable=SC1091
        local ID="" ID_LIKE=""
        ID="$(. /etc/os-release 2>/dev/null; echo "${ID:-}")"
        ID_LIKE="$(. /etc/os-release 2>/dev/null; echo "${ID_LIKE:-}")"
        case " $ID $ID_LIKE " in
          *" debian "*|*" ubuntu "*|*" linuxmint "*|*" pop "*|*" raspbian "*) echo "debian"; return 0 ;;
          *" fedora "*|*" rhel "*|*" centos "*|*" rocky "*|*" almalinux "*|*" amzn "*) echo "fedora"; return 0 ;;
          *" arch "*|*" manjaro "*|*" endeavouros "*) echo "arch"; return 0 ;;
          *" suse "*|*" opensuse "*|*" sles "*|*" opensuse-leap "*|*" opensuse-tumbleweed "*) echo "suse"; return 0 ;;
          *" alpine "*) echo "alpine"; return 0 ;;
        esac
      fi
      echo "linux"; return 0
      ;;
    *) echo "unknown"; return 0 ;;
  esac
}

# ─── ops_arch: normalized CPU architecture ──────────────────────────────────
# Echoes: x86_64 | arm64 | armv7 | i686 | unknown
ops_arch() {
  local m
  m="$(uname -m 2>/dev/null || echo unknown)"
  case "$m" in
    x86_64|amd64) echo "x86_64" ;;
    aarch64|arm64) echo "arm64" ;;
    armv7l|armv7|armhf) echo "armv7" ;;
    i386|i686) echo "i686" ;;
    *) echo "unknown" ;;
  esac
}

# ─── ops_pkg_mgr: first-available package manager in priority order ─────────
# Cascade: brew > (distro-native on Linux) > (winget > scoop > choco on Windows).
ops_pkg_mgr() {
  # brew wins everywhere it exists (macOS, Linuxbrew, WSL with brew installed).
  if command -v brew >/dev/null 2>&1; then echo "brew"; return 0; fi

  local os; os="$(ops_os)"
  case "$os" in
    debian|wsl)
      command -v apt-get >/dev/null 2>&1 && { echo "apt-get"; return 0; } ;;
    fedora)
      command -v dnf >/dev/null 2>&1 && { echo "dnf"; return 0; }
      command -v yum >/dev/null 2>&1 && { echo "dnf"; return 0; } ;;
    arch)
      command -v pacman >/dev/null 2>&1 && { echo "pacman"; return 0; } ;;
    suse)
      command -v zypper >/dev/null 2>&1 && { echo "zypper"; return 0; } ;;
    alpine)
      command -v apk >/dev/null 2>&1 && { echo "apk"; return 0; } ;;
    linux)
      # Generic Linux — probe in order.
      for m in apt-get dnf pacman zypper apk; do
        command -v "$m" >/dev/null 2>&1 && { echo "$m"; return 0; }
      done ;;
    windows)
      for m in winget scoop choco; do
        command -v "$m" >/dev/null 2>&1 && { echo "$m"; return 0; }
      done ;;
  esac

  # WSL may also surface Windows managers via interop — try them last.
  if [[ "$os" == "wsl" ]]; then
    for m in winget.exe scoop choco.exe; do
      command -v "$m" >/dev/null 2>&1 && { echo "${m%.exe}"; return 0; }
    done
  fi

  echo ""
  return 0
}

# ─── ops_pkg_install_cmd: the full install invocation for a given package ───
# Prints empty + exits 1 when no package manager is available.
ops_pkg_install_cmd() {
  local pkg="${1:-}"
  if [[ -z "$pkg" ]]; then echo ""; return 1; fi
  local mgr; mgr="$(ops_pkg_mgr)"
  case "$mgr" in
    brew)    echo "brew install $pkg" ;;
    apt-get) echo "sudo apt-get install -y $pkg" ;;
    dnf)     echo "sudo dnf install -y $pkg" ;;
    pacman)  echo "sudo pacman -S --noconfirm $pkg" ;;
    zypper)  echo "sudo zypper install -y $pkg" ;;
    apk)     echo "sudo apk add --no-cache $pkg" ;;
    winget)  echo "winget install -e --id $pkg" ;;
    scoop)   echo "scoop install $pkg" ;;
    choco)   echo "choco install -y $pkg" ;;
    *)       echo ""; return 1 ;;
  esac
}

# ─── ops_keyring_backend: which secret-store CLI to prefer ──────────────────
# Echoes: security | secret-tool | wincred | "" (unsupported).
ops_keyring_backend() {
  local os; os="$(ops_os)"
  case "$os" in
    macos) echo "security" ;;
    windows)
      command -v cmdkey >/dev/null 2>&1 && { echo "wincred"; return 0; }
      command -v cmdkey.exe >/dev/null 2>&1 && { echo "wincred"; return 0; }
      echo "" ;;
    wsl)
      # Prefer Linux libsecret when present; otherwise reach over to Windows cmdkey.
      if command -v secret-tool >/dev/null 2>&1; then echo "secret-tool"
      elif command -v cmdkey.exe >/dev/null 2>&1; then echo "wincred"
      else echo ""; fi ;;
    debian|fedora|arch|suse|alpine|linux)
      command -v secret-tool >/dev/null 2>&1 && { echo "secret-tool"; return 0; }
      echo "" ;;
    *) echo "" ;;
  esac
}

# ─── ops_opener: URL / file opener command ──────────────────────────────────
# Echoes the full command string (may contain spaces, e.g. "cmd.exe /c start").
ops_opener() {
  local os; os="$(ops_os)"
  case "$os" in
    macos) echo "open" ;;
    wsl)
      command -v wslview >/dev/null 2>&1 && { echo "wslview"; return 0; }
      command -v xdg-open >/dev/null 2>&1 && { echo "xdg-open"; return 0; }
      echo "cmd.exe /c start" ;;
    windows) echo "cmd.exe /c start" ;;
    debian|fedora|arch|suse|alpine|linux)
      command -v xdg-open >/dev/null 2>&1 && { echo "xdg-open"; return 0; }
      echo "" ;;
    *) echo "" ;;
  esac
}

# ─── ops_shell: basename of the user's login/current shell ──────────────────
# Echoes: bash | zsh | fish | sh | pwsh | cmd | unknown
ops_shell() {
  local s=""
  if [[ -n "${SHELL:-}" ]]; then
    s="$(basename "$SHELL")"
  fi
  if [[ -z "$s" ]] || [[ "$s" == "unknown" ]]; then
    s="$(ps -p $$ -o comm= 2>/dev/null | tr -d ' ' | sed 's|^-||')"
    s="$(basename "${s:-unknown}")"
  fi
  case "$s" in
    bash|zsh|fish|sh|pwsh|cmd) echo "$s" ;;
    powershell|powershell.exe|pwsh.exe) echo "pwsh" ;;
    cmd.exe) echo "cmd" ;;
    *) echo "unknown" ;;
  esac
}

# ─── ops_browser_profile_dirs: existing Chromium-family profile roots ───────
# Emits one absolute path per line; only paths that actually exist on disk.
ops_browser_profile_dirs() {
  local os; os="$(ops_os)"
  local -a candidates=()
  case "$os" in
    macos)
      candidates+=("$HOME/Library/Application Support/Google/Chrome")
      candidates+=("$HOME/Library/Application Support/Chromium")
      candidates+=("$HOME/Library/Application Support/BraveSoftware/Brave-Browser")
      candidates+=("$HOME/Library/Application Support/Arc/User Data")
      ;;
    debian|fedora|arch|suse|alpine|linux)
      candidates+=("$HOME/.config/google-chrome")
      candidates+=("$HOME/.config/chromium")
      candidates+=("$HOME/.config/BraveSoftware/Brave-Browser")
      ;;
    wsl)
      candidates+=("$HOME/.config/google-chrome")
      candidates+=("$HOME/.config/chromium")
      candidates+=("$HOME/.config/BraveSoftware/Brave-Browser")
      # Windows-side profiles are reachable via /mnt/c when DrvFs is mounted.
      local win_user="${USER:-$(id -un 2>/dev/null || echo user)}"
      candidates+=("/mnt/c/Users/$win_user/AppData/Local/Google/Chrome/User Data")
      candidates+=("/mnt/c/Users/$win_user/AppData/Local/Chromium/User Data")
      candidates+=("/mnt/c/Users/$win_user/AppData/Local/BraveSoftware/Brave-Browser/User Data")
      ;;
    windows)
      local lad="${LOCALAPPDATA:-$HOME/AppData/Local}"
      candidates+=("$lad\\Google\\Chrome\\User Data")
      candidates+=("$lad\\Chromium\\User Data")
      candidates+=("$lad\\BraveSoftware\\Brave-Browser\\User Data")
      ;;
  esac
  local p
  for p in "${candidates[@]}"; do
    [[ -d "$p" ]] && echo "$p"
  done
  return 0
}

# ─── JSON helpers ───────────────────────────────────────────────────────────
# Minimal string escaper for the fallback JSON emitter (no jq path).
__ops_json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

# ─── ops_os_json: flat JSON blob of all the fields above ────────────────────
ops_os_json() {
  local os distro_id arch pkg_mgr keyring opener shell is_wsl
  os="$(ops_os)"
  arch="$(ops_arch)"
  pkg_mgr="$(ops_pkg_mgr)"
  keyring="$(ops_keyring_backend)"
  opener="$(ops_opener)"
  shell="$(ops_shell)"
  if [[ "$os" == "wsl" ]]; then is_wsl="true"; else is_wsl="false"; fi

  # distro_id is the distro-specific bucket on Linux/WSL; mirrors `os` elsewhere.
  case "$os" in
    debian|fedora|arch|suse|alpine|linux) distro_id="$os" ;;
    wsl)
      distro_id="linux"
      if [[ -r /etc/os-release ]]; then
        local _id=""; _id="$(. /etc/os-release 2>/dev/null; echo "${ID:-}")"
        [[ -n "$_id" ]] && distro_id="$_id"
      fi ;;
    *) distro_id="$os" ;;
  esac

  # Gather profile dirs into an array (portable; no mapfile required).
  local -a profiles=()
  local line
  while IFS= read -r line; do
    [[ -n "$line" ]] && profiles+=("$line")
  done < <(ops_browser_profile_dirs)

  if command -v jq >/dev/null 2>&1; then
    # Prefer jq — handles escaping for us.
    local profiles_json="[]"
    if ((${#profiles[@]} > 0)); then
      profiles_json="$(printf '%s\n' "${profiles[@]}" | jq -R . | jq -s .)"
    fi
    jq -n \
      --arg os "$os" --arg distro_id "$distro_id" --arg arch "$arch" \
      --arg pkg_mgr "$pkg_mgr" --arg keyring "$keyring" --arg opener "$opener" \
      --arg shell "$shell" --argjson is_wsl "$is_wsl" \
      --argjson profiles "$profiles_json" \
      '{os:$os, distro_id:$distro_id, arch:$arch, pkg_mgr:$pkg_mgr,
        keyring_backend:$keyring, opener:$opener, shell:$shell,
        is_wsl:$is_wsl, browser_profiles:$profiles}'
    return 0
  fi

  # Fallback: hand-rolled emitter.
  local profiles_out="["
  local i
  for i in "${!profiles[@]}"; do
    [[ "$i" -gt 0 ]] && profiles_out+=", "
    profiles_out+="\"$(__ops_json_escape "${profiles[$i]}")\""
  done
  profiles_out+="]"

  printf '{'
  printf '"os":"%s",'               "$(__ops_json_escape "$os")"
  printf '"distro_id":"%s",'        "$(__ops_json_escape "$distro_id")"
  printf '"arch":"%s",'             "$(__ops_json_escape "$arch")"
  printf '"pkg_mgr":"%s",'          "$(__ops_json_escape "$pkg_mgr")"
  printf '"keyring_backend":"%s",'  "$(__ops_json_escape "$keyring")"
  printf '"opener":"%s",'           "$(__ops_json_escape "$opener")"
  printf '"shell":"%s",'            "$(__ops_json_escape "$shell")"
  printf '"is_wsl":%s,'             "$is_wsl"
  printf '"browser_profiles":%s'    "$profiles_out"
  printf '}\n'
}

# ─── Direct-execution entry point ───────────────────────────────────────────
# `bash os-detect.sh` prints the full detection blob; sourcing is a no-op here.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  ops_os_json
fi
