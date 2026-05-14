#!/usr/bin/env bash
# credential-store.sh — Cross-OS secret storage with a cascading backend chain.
#
# This file is a SOURCED library, not a standalone executable. The shebang
# above exists purely so editors pick the right syntax highlighter. Source
# it from other scripts via:
#   source "$(dirname "$0")/../lib/credential-store.sh"
#
# It abstracts credential storage across OSes so that callers never have to
# care whether the host has macOS Keychain, libsecret, Windows Credential
# Manager, keytar, or nothing at all. The same API works everywhere; backends
# are tried in priority order and the first that succeeds wins.
#
# Public API (all idempotent, all return 0/1 without leaking secrets to logs):
#   ops_cred_set      <service> <account> <secret>
#   ops_cred_get      <service> <account>
#   ops_cred_delete   <service> <account>
#   ops_cred_backends_available
#   ops_cred_backend_for <service> <account>
#
# Direct-execution CLI (for the .mjs helper to shell out to):
#   credential-store.sh set|set-stdin|get|delete|backends|backend-for ...

# ─── Re-source guard ────────────────────────────────────────────────────────
if [[ -n "${__OPS_CREDENTIAL_STORE_SH_LOADED__:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
__OPS_CREDENTIAL_STORE_SH_LOADED__=1

# Only clobber shell options when run directly; sourced callers keep their own.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
fi

# ─── Dependency: os-detect.sh ───────────────────────────────────────────────
if ! declare -F ops_keyring_backend >/dev/null 2>&1; then
  # shellcheck source=./os-detect.sh
  . "$(dirname "${BASH_SOURCE[0]}")/os-detect.sh"
fi

# ─── Paths & constants ──────────────────────────────────────────────────────
__OPS_CRED_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/claude-ops"
__OPS_CRED_ENC_FILE="$__OPS_CRED_DATA_DIR/secrets.enc.json"
__OPS_CRED_PLAIN_FILE="$__OPS_CRED_DATA_DIR/secrets.plain.json"
__OPS_CRED_MASTERKEY_FILE="$__OPS_CRED_DATA_DIR/.masterkey"
__OPS_CRED_MJS_HELPER="$(dirname "${BASH_SOURCE[0]}")/credential-store.mjs"
__OPS_CRED_WIN_PREFIX="claude-ops"
__OPS_CRED_PLAIN_WARNED=0

# ─── 1. Logging helpers ─────────────────────────────────────────────────────
# Never echoes the secret itself — only backend names and service/account.
_ops_cred_log() {
  printf 'credential-store: %s\n' "$*" >&2
}

_ops_cred_warn_plaintext_once() {
  if [[ "$__OPS_CRED_PLAIN_WARNED" == "0" ]]; then
    printf '⚠ credential-store: using plaintext JSON fallback — install secret-tool (linux) or cmdkey (windows) for better security\n' >&2
    __OPS_CRED_PLAIN_WARNED=1
  fi
}

# ─── 2. JSON helpers (jq-optional) ──────────────────────────────────────────
# Flat shape: {"service_account": {"service":"...", "account":"...", "secret":"..."}}
_ops_cred_json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

_ops_cred_key() { printf '%s\x1f%s' "$1" "$2"; }
_ops_cred_jkey() {
  # JSON-safe composite key: "service\u001faccount" collapsed to service_account.
  local svc acc
  svc="$(_ops_cred_json_escape "$1")"
  acc="$(_ops_cred_json_escape "$2")"
  printf '%s__%s' "$svc" "$acc"
}

# Reads field from a flat JSON blob on stdin. Writes value to stdout or empty.
#   _ops_cred_json_get <json> <key> <field>
_ops_cred_json_get() {
  local blob="$1" key="$2" field="$3"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$blob" | jq -r --arg k "$key" --arg f "$field" \
      '.[$k][$f] // empty' 2>/dev/null
    return 0
  fi
  # Hand-rolled: match "key":{ ... "field":"value" ... }
  # This parser is deliberately tolerant but assumes we wrote the file ourselves.
  local esc_key esc_field
  esc_key="$(_ops_cred_json_escape "$key")"
  esc_field="$(_ops_cred_json_escape "$field")"
  local py
  py="$(printf '%s' "$blob" | awk -v k="$esc_key" -v f="$esc_field" '
    BEGIN { RS="\0" }
    {
      # Find "k":{...}
      idx = index($0, "\"" k "\":{")
      if (!idx) exit 0
      rest = substr($0, idx)
      # Find enclosing object end — naive: first } after the opening {
      brace = index(rest, "{")
      if (!brace) exit 0
      obj_start = brace + 1
      depth = 1
      i = obj_start + 1
      n = length(rest)
      while (i <= n && depth > 0) {
        c = substr(rest, i, 1)
        if (c == "{") depth++
        else if (c == "}") depth--
        i++
      }
      obj = substr(rest, obj_start, i - obj_start - 1)
      fidx = index(obj, "\"" f "\":\"")
      if (!fidx) exit 0
      val_start = fidx + length(f) + 4
      # Read until unescaped quote.
      out = ""
      j = val_start
      m = length(obj)
      while (j <= m) {
        c = substr(obj, j, 1)
        if (c == "\\") { out = out substr(obj, j, 2); j += 2; continue }
        if (c == "\"") break
        out = out c; j++
      }
      print out
    }')"
  # Unescape minimal sequences we wrote.
  py="${py//\\n/$'\n'}"
  py="${py//\\r/$'\r'}"
  py="${py//\\t/$'\t'}"
  py="${py//\\\"/\"}"
  py="${py//\\\\/\\}"
  printf '%s' "$py"
}

# Writes a single entry into a flat JSON blob on stdin, emitting the updated
# blob on stdout. If `secret` is empty, deletes the key.
#   _ops_cred_json_set <blob> <key> <service> <account> <secret>
_ops_cred_json_set() {
  local blob="${1:-}" key="$2" svc="$3" acc="$4" sec="$5"
  [[ -z "$blob" ]] && blob='{}'
  if command -v jq >/dev/null 2>&1; then
    if [[ -z "$sec" ]]; then
      printf '%s' "$blob" | jq --arg k "$key" 'del(.[$k])'
    else
      printf '%s' "$blob" | jq --arg k "$key" --arg s "$svc" \
        --arg a "$acc" --arg v "$sec" \
        '.[$k] = {service:$s, account:$a, secret:$v}'
    fi
    return 0
  fi
  # Hand-rolled: collect existing keys by scanning top-level entries, then
  # reassemble. Because we always round-trip through this writer, the shape
  # is predictable.
  local -a pairs=()
  if command -v jq >/dev/null 2>&1; then :; fi
  # Extract existing keys via a crude tokenizer.
  local keys_line
  keys_line="$(printf '%s' "$blob" | tr -d '\n' | grep -oE '"[^"]+":\{[^}]*\}' || true)"
  local entry ekey existing_svc existing_acc existing_sec
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    ekey="${entry%%\":*}"; ekey="${ekey#\"}"
    if [[ "$ekey" == "$key" ]]; then
      continue  # Will be replaced below.
    fi
    existing_svc="$(printf '%s' "$blob" | _ops_cred_json_get_inline "$ekey" service)"
    existing_acc="$(printf '%s' "$blob" | _ops_cred_json_get_inline "$ekey" account)"
    existing_sec="$(printf '%s' "$blob" | _ops_cred_json_get_inline "$ekey" secret)"
    pairs+=("$(_ops_cred_json_emit_pair "$ekey" "$existing_svc" "$existing_acc" "$existing_sec")")
  done <<<"$keys_line"
  if [[ -n "$sec" ]]; then
    pairs+=("$(_ops_cred_json_emit_pair "$key" "$svc" "$acc" "$sec")")
  fi
  local out="{"
  local i
  for i in "${!pairs[@]}"; do
    [[ "$i" -gt 0 ]] && out+=","
    out+="${pairs[$i]}"
  done
  out+="}"
  printf '%s' "$out"
}

# Inline helper for the hand-rolled path above: reads a field value from blob
# on stdin for the given key.
_ops_cred_json_get_inline() {
  local blob key field
  blob="$(cat)"
  key="$1"; field="$2"
  _ops_cred_json_get "$blob" "$key" "$field"
}

_ops_cred_json_emit_pair() {
  local key svc acc sec
  key="$(_ops_cred_json_escape "$1")"
  svc="$(_ops_cred_json_escape "$2")"
  acc="$(_ops_cred_json_escape "$3")"
  sec="$(_ops_cred_json_escape "$4")"
  printf '"%s":{"service":"%s","account":"%s","secret":"%s"}' \
    "$key" "$svc" "$acc" "$sec"
}

# ─── 3. Master-key management ───────────────────────────────────────────────
_ops_cred_ensure_masterkey() {
  local umask_saved
  umask_saved="$(umask)"
  umask 077
  mkdir -p "$__OPS_CRED_DATA_DIR" 2>/dev/null || { umask "$umask_saved"; return 1; }

  if [[ -n "${CLAUDE_OPS_MASTER_KEY:-}" ]]; then
    umask "$umask_saved"
    printf '%s' "$CLAUDE_OPS_MASTER_KEY"
    return 0
  fi

  if [[ ! -s "$__OPS_CRED_MASTERKEY_FILE" ]]; then
    local rand=""
    if command -v openssl >/dev/null 2>&1; then
      rand="$(openssl rand -base64 48 2>/dev/null | tr -d '\n')"
    fi
    if [[ -z "$rand" ]] && [[ -r /dev/urandom ]]; then
      rand="$(head -c 48 /dev/urandom 2>/dev/null | base64 2>/dev/null | tr -d '\n')"
    fi
    if [[ -z "$rand" ]]; then
      umask "$umask_saved"
      return 1
    fi
    printf '%s' "$rand" >"$__OPS_CRED_MASTERKEY_FILE" 2>/dev/null || {
      umask "$umask_saved"; return 1; }
    chmod 0600 "$__OPS_CRED_MASTERKEY_FILE" 2>/dev/null || true
  fi
  umask "$umask_saved"
  cat "$__OPS_CRED_MASTERKEY_FILE" 2>/dev/null
}

# ─── 4. Encrypted JSON read/write ───────────────────────────────────────────
_ops_cred_enc_read() {
  # Emits the decrypted JSON blob on stdout. Empty string on miss/failure.
  [[ -s "$__OPS_CRED_ENC_FILE" ]] || { printf ''; return 0; }
  command -v openssl >/dev/null 2>&1 || { printf ''; return 1; }
  local key
  key="$(_ops_cred_ensure_masterkey)" || { printf ''; return 1; }
  [[ -n "$key" ]] || { printf ''; return 1; }
  openssl enc -aes-256-cbc -d -salt -pbkdf2 -pass env:__OPS_CRED_PASS \
    -in "$__OPS_CRED_ENC_FILE" 2>/dev/null <<<"" >/dev/null 2>&1 || true
  # Run properly via env var (avoid putting the key on a cmdline).
  __OPS_CRED_PASS="$key" openssl enc -aes-256-cbc -d -salt -pbkdf2 \
    -pass env:__OPS_CRED_PASS -in "$__OPS_CRED_ENC_FILE" 2>/dev/null || printf ''
}

_ops_cred_enc_write() {
  # Writes the given blob (stdin) encrypted to the enc file.
  local umask_saved
  umask_saved="$(umask)"
  umask 077
  mkdir -p "$__OPS_CRED_DATA_DIR" 2>/dev/null || { umask "$umask_saved"; return 1; }
  command -v openssl >/dev/null 2>&1 || { umask "$umask_saved"; return 1; }
  local key
  key="$(_ops_cred_ensure_masterkey)" || { umask "$umask_saved"; return 1; }
  [[ -n "$key" ]] || { umask "$umask_saved"; return 1; }
  local tmp="$__OPS_CRED_ENC_FILE.tmp.$$"
  if __OPS_CRED_PASS="$key" openssl enc -aes-256-cbc -salt -pbkdf2 \
      -pass env:__OPS_CRED_PASS -out "$tmp" 2>/dev/null; then
    chmod 0600 "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$__OPS_CRED_ENC_FILE" 2>/dev/null || {
      rm -f "$tmp" 2>/dev/null; umask "$umask_saved"; return 1; }
    umask "$umask_saved"
    return 0
  fi
  rm -f "$tmp" 2>/dev/null
  umask "$umask_saved"
  return 1
}

# ─── 5. Plaintext JSON fallback ─────────────────────────────────────────────
_ops_cred_plain_read() {
  [[ -s "$__OPS_CRED_PLAIN_FILE" ]] || { printf ''; return 0; }
  cat "$__OPS_CRED_PLAIN_FILE" 2>/dev/null || printf ''
}

_ops_cred_plain_write() {
  local umask_saved
  umask_saved="$(umask)"
  umask 077
  mkdir -p "$__OPS_CRED_DATA_DIR" 2>/dev/null || { umask "$umask_saved"; return 1; }
  local tmp="$__OPS_CRED_PLAIN_FILE.tmp.$$"
  cat >"$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; umask "$umask_saved"; return 1; }
  chmod 0600 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$__OPS_CRED_PLAIN_FILE" 2>/dev/null || {
    rm -f "$tmp" 2>/dev/null; umask "$umask_saved"; return 1; }
  umask "$umask_saved"
  return 0
}

# ─── 6. Per-backend primitive operations ────────────────────────────────────
# Each returns 0 on success, 1 on failure or "not supported here".
# None of them ever print the secret to stdout (except `*_get`, which prints
# only the retrieved value).

# ── 6a. OS-native keyring ──
_ops_cred_native_available() {
  local backend; backend="$(ops_keyring_backend)"
  [[ -n "$backend" ]]
}

_ops_cred_native_set() {
  local svc="$1" acc="$2" sec="$3" backend
  backend="$(ops_keyring_backend)"
  case "$backend" in
    security)
      command -v security >/dev/null 2>&1 || return 1
      security add-generic-password -U -s "$svc" -a "$acc" -w "$sec" 2>/dev/null ;;
    secret-tool)
      command -v secret-tool >/dev/null 2>&1 || return 1
      printf '%s' "$sec" | secret-tool store --label="$svc/$acc" \
        service "$svc" account "$acc" 2>/dev/null ;;
    wincred)
      local cmdkey_bin=""
      if command -v cmd.exe >/dev/null 2>&1; then
        cmd.exe //c "cmdkey /generic:${__OPS_CRED_WIN_PREFIX}:${svc}:${acc} /user:${acc} /pass:${sec}" >/dev/null 2>&1
      elif command -v cmdkey.exe >/dev/null 2>&1; then
        cmdkey.exe "/generic:${__OPS_CRED_WIN_PREFIX}:${svc}:${acc}" "/user:${acc}" "/pass:${sec}" >/dev/null 2>&1
      elif command -v cmdkey >/dev/null 2>&1; then
        cmdkey "/generic:${__OPS_CRED_WIN_PREFIX}:${svc}:${acc}" "/user:${acc}" "/pass:${sec}" >/dev/null 2>&1
      else
        return 1
      fi ;;
    *) return 1 ;;
  esac
}

_ops_cred_native_get() {
  local svc="$1" acc="$2" backend out
  backend="$(ops_keyring_backend)"
  case "$backend" in
    security)
      command -v security >/dev/null 2>&1 || return 1
      out="$(security find-generic-password -s "$svc" -a "$acc" -w 2>/dev/null)" || return 1
      [[ -n "$out" ]] || return 1
      printf '%s' "$out" ;;
    secret-tool)
      command -v secret-tool >/dev/null 2>&1 || return 1
      out="$(secret-tool lookup service "$svc" account "$acc" 2>/dev/null)" || return 1
      [[ -n "$out" ]] || return 1
      printf '%s' "$out" ;;
    wincred)
      # cmdkey cannot read passwords back; treat as write-only.
      return 1 ;;
    *) return 1 ;;
  esac
}

_ops_cred_native_delete() {
  local svc="$1" acc="$2" backend
  backend="$(ops_keyring_backend)"
  case "$backend" in
    security)
      command -v security >/dev/null 2>&1 || return 1
      security delete-generic-password -s "$svc" -a "$acc" >/dev/null 2>&1 ;;
    secret-tool)
      command -v secret-tool >/dev/null 2>&1 || return 1
      secret-tool clear service "$svc" account "$acc" >/dev/null 2>&1 ;;
    wincred)
      if command -v cmd.exe >/dev/null 2>&1; then
        cmd.exe //c "cmdkey /delete:${__OPS_CRED_WIN_PREFIX}:${svc}:${acc}" >/dev/null 2>&1
      elif command -v cmdkey.exe >/dev/null 2>&1; then
        cmdkey.exe "/delete:${__OPS_CRED_WIN_PREFIX}:${svc}:${acc}" >/dev/null 2>&1
      elif command -v cmdkey >/dev/null 2>&1; then
        cmdkey "/delete:${__OPS_CRED_WIN_PREFIX}:${svc}:${acc}" >/dev/null 2>&1
      else
        return 1
      fi ;;
    *) return 1 ;;
  esac
}

# ── 6b. keytar via node (optional tier) ──
_ops_cred_keytar_available() {
  command -v node >/dev/null 2>&1 && [[ -f "$__OPS_CRED_MJS_HELPER" ]]
}

_ops_cred_keytar_set() {
  _ops_cred_keytar_available || return 1
  node "$__OPS_CRED_MJS_HELPER" set-keytar "$1" "$2" "$3" >/dev/null 2>&1
}

_ops_cred_keytar_get() {
  local out
  _ops_cred_keytar_available || return 1
  out="$(node "$__OPS_CRED_MJS_HELPER" get-keytar "$1" "$2" 2>/dev/null)" || return 1
  [[ -n "$out" ]] || return 1
  printf '%s' "$out"
}

_ops_cred_keytar_delete() {
  _ops_cred_keytar_available || return 1
  node "$__OPS_CRED_MJS_HELPER" delete-keytar "$1" "$2" >/dev/null 2>&1
}

# ── 6c. Encrypted JSON ──
_ops_cred_enc_available() {
  command -v openssl >/dev/null 2>&1
}

_ops_cred_enc_set() {
  _ops_cred_enc_available || return 1
  local svc="$1" acc="$2" sec="$3" blob key new_blob
  key="$(_ops_cred_jkey "$svc" "$acc")"
  blob="$(_ops_cred_enc_read)" || blob=""
  new_blob="$(_ops_cred_json_set "$blob" "$key" "$svc" "$acc" "$sec")" || return 1
  printf '%s' "$new_blob" | _ops_cred_enc_write
}

_ops_cred_enc_get() {
  _ops_cred_enc_available || return 1
  local svc="$1" acc="$2" blob key out
  key="$(_ops_cred_jkey "$svc" "$acc")"
  blob="$(_ops_cred_enc_read)" || return 1
  [[ -n "$blob" ]] || return 1
  out="$(_ops_cred_json_get "$blob" "$key" secret)"
  [[ -n "$out" ]] || return 1
  printf '%s' "$out"
}

_ops_cred_enc_delete() {
  _ops_cred_enc_available || return 1
  local svc="$1" acc="$2" blob key new_blob
  [[ -s "$__OPS_CRED_ENC_FILE" ]] || return 0
  key="$(_ops_cred_jkey "$svc" "$acc")"
  blob="$(_ops_cred_enc_read)" || return 1
  [[ -n "$blob" ]] || return 0
  new_blob="$(_ops_cred_json_set "$blob" "$key" "$svc" "$acc" "")" || return 1
  printf '%s' "$new_blob" | _ops_cred_enc_write
}

# ── 6d. Plaintext JSON ──
_ops_cred_plain_set() {
  _ops_cred_warn_plaintext_once
  local svc="$1" acc="$2" sec="$3" blob key new_blob
  key="$(_ops_cred_jkey "$svc" "$acc")"
  blob="$(_ops_cred_plain_read)" || blob=""
  new_blob="$(_ops_cred_json_set "$blob" "$key" "$svc" "$acc" "$sec")" || return 1
  printf '%s' "$new_blob" | _ops_cred_plain_write
}

_ops_cred_plain_get() {
  local svc="$1" acc="$2" blob key out
  key="$(_ops_cred_jkey "$svc" "$acc")"
  blob="$(_ops_cred_plain_read)" || return 1
  [[ -n "$blob" ]] || return 1
  out="$(_ops_cred_json_get "$blob" "$key" secret)"
  [[ -n "$out" ]] || return 1
  printf '%s' "$out"
}

_ops_cred_plain_delete() {
  local svc="$1" acc="$2" blob key new_blob
  [[ -s "$__OPS_CRED_PLAIN_FILE" ]] || return 0
  key="$(_ops_cred_jkey "$svc" "$acc")"
  blob="$(_ops_cred_plain_read)" || return 1
  [[ -n "$blob" ]] || return 0
  new_blob="$(_ops_cred_json_set "$blob" "$key" "$svc" "$acc" "")" || return 1
  printf '%s' "$new_blob" | _ops_cred_plain_write
}

# ─── 7. Public API ──────────────────────────────────────────────────────────
ops_cred_backends_available() {
  local -a out=()
  _ops_cred_native_available && out+=("native:$(ops_keyring_backend)")
  _ops_cred_keytar_available  && out+=("keytar")
  _ops_cred_enc_available     && out+=("encrypted-json")
  out+=("plaintext-json")  # always available as last-resort
  printf '%s' "${out[*]}"
}

ops_cred_set() {
  if [[ $# -ne 3 ]]; then
    _ops_cred_log "ops_cred_set: usage: ops_cred_set <service> <account> <secret>"
    return 1
  fi
  local svc="$1" acc="$2" sec="$3"

  if _ops_cred_native_available && _ops_cred_native_set "$svc" "$acc" "$sec"; then
    _ops_cred_log "stored via=native:$(ops_keyring_backend) service=$svc account=$acc"
    return 0
  fi
  if _ops_cred_keytar_available && _ops_cred_keytar_set "$svc" "$acc" "$sec"; then
    _ops_cred_log "stored via=keytar service=$svc account=$acc"
    return 0
  fi
  if _ops_cred_enc_available && _ops_cred_enc_set "$svc" "$acc" "$sec"; then
    _ops_cred_log "stored via=encrypted-json service=$svc account=$acc"
    return 0
  fi
  if _ops_cred_plain_set "$svc" "$acc" "$sec"; then
    _ops_cred_log "stored via=plaintext-json service=$svc account=$acc"
    return 0
  fi
  _ops_cred_log "stored via=NONE service=$svc account=$acc (all backends failed)"
  return 1
}

ops_cred_get() {
  if [[ $# -ne 2 ]]; then
    _ops_cred_log "ops_cred_get: usage: ops_cred_get <service> <account>"
    return 1
  fi
  local svc="$1" acc="$2" out=""

  if _ops_cred_native_available; then
    out="$(_ops_cred_native_get "$svc" "$acc" 2>/dev/null || true)"
    if [[ -n "$out" ]]; then printf '%s' "$out"; return 0; fi
  fi
  if _ops_cred_keytar_available; then
    out="$(_ops_cred_keytar_get "$svc" "$acc" 2>/dev/null || true)"
    if [[ -n "$out" ]]; then printf '%s' "$out"; return 0; fi
  fi
  if _ops_cred_enc_available; then
    out="$(_ops_cred_enc_get "$svc" "$acc" 2>/dev/null || true)"
    if [[ -n "$out" ]]; then printf '%s' "$out"; return 0; fi
  fi
  out="$(_ops_cred_plain_get "$svc" "$acc" 2>/dev/null || true)"
  if [[ -n "$out" ]]; then printf '%s' "$out"; return 0; fi
  return 1
}

ops_cred_delete() {
  if [[ $# -ne 2 ]]; then
    _ops_cred_log "ops_cred_delete: usage: ops_cred_delete <service> <account>"
    return 1
  fi
  local svc="$1" acc="$2"
  local any_err=0

  # Best-effort on each: missing-key is NOT an error.
  _ops_cred_native_available && _ops_cred_native_delete "$svc" "$acc" >/dev/null 2>&1 || true
  _ops_cred_keytar_available && _ops_cred_keytar_delete "$svc" "$acc" >/dev/null 2>&1 || true
  if _ops_cred_enc_available; then
    _ops_cred_enc_delete "$svc" "$acc" >/dev/null 2>&1 || any_err=1
  fi
  _ops_cred_plain_delete "$svc" "$acc" >/dev/null 2>&1 || any_err=1

  # Only fail catastrophically if BOTH writable-file backends errored AND the
  # files existed (otherwise "nothing to delete" is fine).
  if [[ "$any_err" == "1" ]] \
      && [[ ! -s "$__OPS_CRED_ENC_FILE" ]] \
      && [[ ! -s "$__OPS_CRED_PLAIN_FILE" ]]; then
    any_err=0
  fi
  return $any_err
}

ops_cred_backend_for() {
  if [[ $# -ne 2 ]]; then
    _ops_cred_log "ops_cred_backend_for: usage: ops_cred_backend_for <service> <account>"
    return 1
  fi
  local svc="$1" acc="$2"
  if _ops_cred_native_available && _ops_cred_native_get "$svc" "$acc" >/dev/null 2>&1; then
    printf 'native:%s' "$(ops_keyring_backend)"; return 0
  fi
  if _ops_cred_keytar_available && _ops_cred_keytar_get "$svc" "$acc" >/dev/null 2>&1; then
    printf 'keytar'; return 0
  fi
  if _ops_cred_enc_available && _ops_cred_enc_get "$svc" "$acc" >/dev/null 2>&1; then
    printf 'encrypted-json'; return 0
  fi
  if _ops_cred_plain_get "$svc" "$acc" >/dev/null 2>&1; then
    printf 'plaintext-json'; return 0
  fi
  printf ''
  return 0
}

# ─── 8. Direct-execution CLI ────────────────────────────────────────────────
# Lets the .mjs helper (or a human) shell out for cross-language testing.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  cmd="${1:-}"; shift || true
  case "$cmd" in
    set)
      [[ $# -eq 3 ]] || { echo "usage: credential-store.sh set <service> <account> <secret>" >&2; exit 2; }
      ops_cred_set "$@" ;;
    set-stdin)
      [[ $# -eq 2 ]] || { echo "usage: credential-store.sh set-stdin <service> <account>" >&2; exit 2; }
      sec="$(cat)" || sec=""
      [[ -n "$sec" ]] || { echo "error: empty secret on stdin (pipe the secret, e.g. echo \"tok\" | credential-store.sh set-stdin svc acct)" >&2; exit 2; }
      ops_cred_set "$1" "$2" "$sec" ;;
    get)
      [[ $# -eq 2 ]] || { echo "usage: credential-store.sh get <service> <account>" >&2; exit 2; }
      ops_cred_get "$@" ;;
    delete)
      [[ $# -eq 2 ]] || { echo "usage: credential-store.sh delete <service> <account>" >&2; exit 2; }
      ops_cred_delete "$@" ;;
    backends)
      ops_cred_backends_available; echo ;;
    backend-for)
      [[ $# -eq 2 ]] || { echo "usage: credential-store.sh backend-for <service> <account>" >&2; exit 2; }
      ops_cred_backend_for "$@"; echo ;;
    ""|-h|--help|help)
      cat >&2 <<EOF
credential-store.sh — cross-OS secret storage with cascading backends
Usage:
  credential-store.sh set         <service> <account> <secret>
  credential-store.sh set-stdin   <service> <account>   # secret on stdin (avoids argv exposure)
  credential-store.sh get         <service> <account>
  credential-store.sh delete      <service> <account>
  credential-store.sh backends
  credential-store.sh backend-for <service> <account>
EOF
      exit 0 ;;
    *)
      echo "unknown subcommand: $cmd (try --help)" >&2; exit 2 ;;
  esac
fi
