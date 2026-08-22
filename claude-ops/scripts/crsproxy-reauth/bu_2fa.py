#!/usr/bin/env python3
"""cliproxy Browser Use 2FA helpers.

This module supports the Browser Use reauth scripts without exposing long-lived
secrets to Browser Use Cloud. It reads 1Password Connect configuration from the
local runtime environment, fetches a configured OTP field, and returns only the
current short-lived TOTP code to the caller.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import struct
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# Runtime compatibility: the deployed hub may still store cliproxy files under
# this legacy path while service paths are migrated. Do not treat the path name
# as product terminology.
LEGACY_RUNTIME_HOME = Path(os.environ.get("CLIPROXY_HOME", "/opt/crsproxy"))
DEFAULT_ENV_FILE = LEGACY_RUNTIME_HOME / ".env"
DEFAULT_OP_FIELD = "one-time password"


class TwoFactorError(RuntimeError):
    """Raised when a configured 2FA method cannot produce a code."""


def load_env_file(path: Path = DEFAULT_ENV_FILE) -> dict[str, str]:
    """Read a simple KEY=VALUE env file without logging any values."""
    env: dict[str, str] = {}
    try:
        text = path.read_text()
    except FileNotFoundError:
        return env
    except OSError as exc:
        raise TwoFactorError(f"cannot read env file: {exc.__class__.__name__}")

    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        env[key] = value
    return env


def merged_runtime_env(env: dict[str, str] | None = None,
                       env_file: Path = DEFAULT_ENV_FILE) -> dict[str, str]:
    """Merge os.environ with the runtime env file, preferring os.environ."""
    merged = load_env_file(env_file)
    merged.update(os.environ)
    if env:
        merged.update(env)
    return merged


def _op_connect_settings(env: dict[str, str]) -> tuple[str, str]:
    host = env.get("OP_CONNECT_HOST") or env.get("OP_CONNECT_URL") or ""
    token = env.get("OP_CONNECT_TOKEN") or ""
    if not host:
        raise TwoFactorError("OP_CONNECT_HOST is not configured")
    if not token:
        raise TwoFactorError("OP_CONNECT_TOKEN is not configured")
    return host.rstrip("/"), token


def fetch_1password_item(vault_id: str, item_id: str,
                         env: dict[str, str] | None = None,
                         timeout: int = 15) -> dict:
    """Fetch one item from 1Password Connect using local credentials."""
    if not vault_id or not item_id:
        raise TwoFactorError("1Password vault/item id missing")
    try:
        import requests
    except ImportError as exc:
        raise TwoFactorError("Python requests package is required for 1Password Connect") from exc
    host, token = _op_connect_settings(merged_runtime_env(env))
    url = f"{host}/v1/vaults/{vault_id}/items/{item_id}"
    try:
        response = requests.get(
            url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise TwoFactorError(f"1Password Connect request failed: {exc.__class__.__name__}")
    if response.status_code == 401:
        raise TwoFactorError("1Password Connect rejected the token")
    if response.status_code == 404:
        raise TwoFactorError("1Password item or vault not found")
    try:
        response.raise_for_status()
    except requests.HTTPError as exc:
        raise TwoFactorError(f"1Password Connect HTTP {response.status_code}") from exc
    try:
        return response.json()
    except json.JSONDecodeError as exc:
        raise TwoFactorError("1Password Connect returned invalid JSON") from exc


def item_field_value(item: dict, field_name: str = DEFAULT_OP_FIELD) -> str:
    """Return a field value by label/id/type from a 1Password item."""
    wanted = (field_name or DEFAULT_OP_FIELD).strip().lower()
    candidates = []
    for field in item.get("fields", []) or []:
        if not isinstance(field, dict):
            continue
        label = str(field.get("label", "")).strip().lower()
        field_id = str(field.get("id", "")).strip().lower()
        field_type = str(field.get("type", "")).strip().lower()
        value = field.get("value") or field.get("totp") or ""
        candidates.append((label, field_id, field_type, str(value)))

    for label, field_id, field_type, value in candidates:
        if value and wanted in {label, field_id}:
            return value
    for label, field_id, field_type, value in candidates:
        if value and ("otp" in label or "otp" in field_id or "otp" in field_type):
            return value
    raise TwoFactorError(f"1Password OTP field not found: {field_name}")


def _normalize_base32(secret: str) -> str:
    cleaned = re.sub(r"\s+", "", secret).upper()
    padding = "=" * ((8 - len(cleaned) % 8) % 8)
    return cleaned + padding


def totp_from_secret(secret: str, now: int | None = None,
                     period: int = 30, digits: int = 6,
                     algorithm: str = "SHA1") -> str:
    """Generate a TOTP code using only the Python standard library."""
    if not secret:
        raise TwoFactorError("empty TOTP secret")
    if digits <= 0 or digits > 10:
        raise TwoFactorError("unsupported TOTP digit count")
    algo = algorithm.upper().replace("-", "")
    digest = {
        "SHA1": hashlib.sha1,
        "SHA256": hashlib.sha256,
        "SHA512": hashlib.sha512,
    }.get(algo)
    if digest is None:
        raise TwoFactorError(f"unsupported TOTP algorithm: {algorithm}")
    try:
        key = base64.b32decode(_normalize_base32(secret), casefold=True)
    except Exception as exc:
        raise TwoFactorError("invalid TOTP secret encoding") from exc
    counter = int((now if now is not None else time.time()) // period)
    msg = struct.pack(">Q", counter)
    mac = hmac.new(key, msg, digest).digest()
    offset = mac[-1] & 0x0F
    code_int = struct.unpack(">I", mac[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(code_int % (10 ** digits)).zfill(digits)


def totp_from_otpauth(value: str, now: int | None = None) -> str:
    """Generate a TOTP from an otpauth:// URI or raw base32 seed."""
    value = value.strip()
    if value.startswith("otpauth://"):
        parsed = urlparse(value)
        params = parse_qs(parsed.query)
        secret = (params.get("secret") or [""])[0]
        period = int((params.get("period") or ["30"])[0])
        digits = int((params.get("digits") or ["6"])[0])
        algorithm = (params.get("algorithm") or ["SHA1"])[0]
        return totp_from_secret(secret, now=now, period=period,
                                digits=digits, algorithm=algorithm)
    return totp_from_secret(value, now=now)


def current_totp_from_1password(vault_id: str, item_id: str,
                                field_name: str = DEFAULT_OP_FIELD,
                                env: dict[str, str] | None = None,
                                now: int | None = None) -> str:
    """Fetch a configured 1Password OTP field and return the current code."""
    item = fetch_1password_item(vault_id, item_id, env=env)
    otp_value = item_field_value(item, field_name)
    return totp_from_otpauth(otp_value, now=now)


def current_totp_from_config(config: dict | None,
                             env: dict[str, str] | None = None,
                             now: int | None = None) -> str | None:
    """Return a code for a supported two_factor config, or None if disabled."""
    config = config or {}
    method = str(config.get("method") or "none").strip().lower()
    if method in ("", "none", "false"):
        return None
    if method != "onepassword_totp":
        raise TwoFactorError(f"2FA method requires human checkpoint: {method}")
    return current_totp_from_1password(
        vault_id=str(config.get("op_vault_id") or ""),
        item_id=str(config.get("op_item_id") or ""),
        field_name=str(config.get("op_field") or DEFAULT_OP_FIELD),
        env=env,
        now=now,
    )
