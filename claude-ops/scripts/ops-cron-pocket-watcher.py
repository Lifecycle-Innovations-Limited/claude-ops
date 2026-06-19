#!/usr/bin/env python3
"""ops-cron-pocket-watcher — Polls Pocket AI MCP for new voice recordings and
action items, then routes them into auto-memory and queue files for the next
Claude Code session to pick up.

Outputs (idempotent, dedup'd by state file):
  • memories  -> ${POCKET_MEMORY_DIR}/pocket_<slug>.md
  • tasks     -> ${POCKET_TASK_QUEUE}     (one JSON line per task)
  • drafts    -> ${POCKET_DRAFT_QUEUE}    (outbound staged, never sent — Rule 6)

State:
  • cursor    -> ${POCKET_STATE_DIR}/cursor.txt
  • seen ids  -> ${POCKET_STATE_DIR}/seen.json
  • recordings pagination resume (when the 10-page cap is hit)
              -> ${POCKET_STATE_DIR}/recordings-pagination-resume.json
  • health    -> ${POCKET_STATE_DIR}/.health
  • log       -> ${POCKET_STATE_DIR}/run.log

Env (all optional except POCKET_API_KEY):
  POCKET_API_KEY         Bearer key (pk_...); auto-resolved from keychain
                         service POCKET_API_KEY / account ops-daemon if unset.
  POCKET_MCP_URL         default https://public.heypocketai.com/mcp
  POCKET_STATE_DIR       default ~/.claude/state/pocket
  POCKET_MEMORY_DIR      default ~/.claude/memory
  POCKET_TASK_QUEUE      default $POCKET_STATE_DIR/tasks.jsonl
  POCKET_DRAFT_QUEUE     default $POCKET_STATE_DIR/drafts.jsonl
  POCKET_INDEX_FILE      optional path to MEMORY.md index — if set, one-line
                         pointer entries are appended under
                         '## Pocket Voice Journal' (recency-pruned to last 14d).
  POCKET_LOOKBACK_HOURS  default 24 (first run; subsequent runs use cursor)
  POCKET_DRY_RUN=1       skip writes, just log what would happen.

Implicit-task inference (Haiku):
  POCKET_INFER_TASKS=1   default 1; set 0 to disable. Calls Haiku to extract
                         implicit tasks from each recording's transcript that
                         Pocket didn't flag as an actionItem.
  POCKET_INFER_MIN_SECS  default 60 (skip recordings shorter than this).
  POCKET_INFER_CONFIDENCE default 0.7 (skip tasks below this confidence).
  POCKET_MAX_INFER_PER_RUN default 10. Hard cap on Haiku inference calls per
                         run to prevent first-run / backfill blowout (N unseen
                         recordings × 1 Haiku call each = unbounded spend).
                         Recordings beyond the cap are NOT marked seen and are
                         picked up on the next run. Set to 0 to disable the cap
                         (NOT recommended in cron — leaves money-leak open).
  ANTHROPIC_API_KEY      env-or-keychain (service=ANTHROPIC_API_KEY,
                         account=ops-daemon). OAuth from keychain
                         (Claude Code-credentials) preferred if available.

Giga sync (optional but on-by-default):
  GIGA_SYNC=1            default 1; set to 0 to disable Giga writes.
  GIGA_MCP_URL           default https://mcp.gigamind.dev/mcp
  GIGA_MIND              default "global"
  GIGA_CONSOLIDATE=1     default 0; if 1, call mcp__giga__consolidate at the
                         end of each batch that produced new neurons.
  GIGA_TOKEN_FILE        default = auto-derived from
                         ~/.mcp-auth/mcp-remote-<v>/<md5(GIGA_MCP_URL)>_tokens.json
                         (mcp-remote's OAuth cache — runs through normal Claude
                         Code auth; refresh via `npx -y mcp-remote <url>`).
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from collections import OrderedDict
from contextlib import contextmanager
import re
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib import error as urlerr
from urllib import request as urlreq

LOG_PREFIX = "[ops-cron-pocket-watcher]"

# ── Config resolution ────────────────────────────────────────────────────────
HOME = Path(os.path.expanduser("~"))
MCP_URL = os.environ.get("POCKET_MCP_URL", "https://public.heypocketai.com/mcp")
STATE_DIR = Path(os.environ.get("POCKET_STATE_DIR", HOME / ".claude/state/pocket"))
MEMORY_DIR = Path(os.environ.get("POCKET_MEMORY_DIR", HOME / ".claude/memory"))
TASK_QUEUE = Path(os.environ.get("POCKET_TASK_QUEUE", STATE_DIR / "tasks.jsonl"))
DRAFT_QUEUE = Path(os.environ.get("POCKET_DRAFT_QUEUE", STATE_DIR / "drafts.jsonl"))
PENDING_TRIAGE = Path(os.environ.get("POCKET_PENDING_TRIAGE", STATE_DIR / "pending-triage.jsonl"))
INDEX_FILE = os.environ.get("POCKET_INDEX_FILE")
LOOKBACK_HOURS = int(os.environ.get("POCKET_LOOKBACK_HOURS", "24"))
DRY_RUN = os.environ.get("POCKET_DRY_RUN") == "1"

CURSOR_FILE = STATE_DIR / "cursor.txt"
SEEN_FILE = STATE_DIR / "seen.json"
SEEN_CAP = 5000
RECORDINGS_PAGINATION_RESUME_FILE = STATE_DIR / "recordings-pagination-resume.json"
HEALTH_FILE = STATE_DIR / ".health"
# Tracks whether Pocket's search backend is currently unavailable. When the
# watcher hits "search service unavailable" we touch this file with the
# first-seen timestamp; on the next successful search we delete the file
# AND send a recovery notification. This makes outage transitions
# observable and gives the owner a real-time ping when Pocket comes back.
SEARCH_OUTAGE_MARKER = STATE_DIR / ".search-outage-marker"
WHATSAPP_CONFIG = STATE_DIR / "whatsapp-config.json"

# Giga sync
GIGA_SYNC = os.environ.get("GIGA_SYNC", "1") == "1"
GIGA_MCP_URL = os.environ.get("GIGA_MCP_URL", "https://mcp.gigamind.dev/mcp")
GIGA_MIND = os.environ.get("GIGA_MIND", "global")
GIGA_CONSOLIDATE = os.environ.get("GIGA_CONSOLIDATE", "0") == "1"

# Implicit-task inference
INFER_TASKS = os.environ.get("POCKET_INFER_TASKS", "1") == "1"
INFER_MIN_SECS = int(os.environ.get("POCKET_INFER_MIN_SECS", "60"))
INFER_CONFIDENCE = float(os.environ.get("POCKET_INFER_CONFIDENCE", "0.7"))
# Hard cap on Haiku inference calls per run — prevents first-run backfill
# blowout. Recordings beyond the cap are NOT marked seen and roll over to the
# next run. 0 disables the cap (not recommended in cron). See NEVER LEAK MONEY
# in user CLAUDE.md.
MAX_INFER_PER_RUN = int(os.environ.get("POCKET_MAX_INFER_PER_RUN", "10"))
LOG_FILE = STATE_DIR / "run.log"

_USER_CONTEXT_PATH = Path(os.environ.get(
    "POCKET_USER_CONTEXT",
    str(HOME / ".claude/state/pocket/user-context.json"),
))
try:
    _ctx = json.loads(_USER_CONTEXT_PATH.read_text())
    _OWNER_NAME: str = _ctx.get("owner_name") or "the user"
except (OSError, json.JSONDecodeError):
    _OWNER_NAME = "the user"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    line = f"{now_iso()} {LOG_PREFIX} {msg}"
    print(line, file=sys.stderr)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def write_health(status: str, msg: str = "", extra: dict | None = None) -> None:
    payload = {
        "status": status,
        "message": msg,
        "last_run": now_iso(),
        "mcp_url": MCP_URL,
    }
    if extra:
        payload.update(extra)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        HEALTH_FILE.write_text(json.dumps(payload, indent=2))
    except OSError as e:
        log(f"health write failed: {e}")


def resolve_api_key() -> str:
    key = os.environ.get("POCKET_API_KEY", "").strip()
    if key:
        return key
    # macOS keychain
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-s", "POCKET_API_KEY",
             "-a", "ops-daemon", "-w"],
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    # Doppler fallback
    try:
        out = subprocess.run(
            ["doppler", "secrets", "get", "POCKET_API_KEY", "--plain"],
            capture_output=True, text=True, timeout=8,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    raise SystemExit(f"{LOG_PREFIX} FATAL: POCKET_API_KEY not found in env, keychain (POCKET_API_KEY/ops-daemon), or Doppler.")


# ── MCP client (Streamable HTTP, SSE response parsing) ──────────────────────
class MCPClient:
    def __init__(self, url: str, api_key: str) -> None:
        self.url = url
        self.api_key = api_key
        self.session_id: str | None = None
        self._id = 0

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    def _post(self, payload: dict, timeout: int = 30) -> tuple[dict | None, str | None]:
        data = json.dumps(payload).encode("utf-8")
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            # Cloudflare-fronted MCPs (e.g. Giga) block default urllib UA.
            "User-Agent": "ops-pocket-watcher/0.2 (Mozilla/5.0)",
        }
        if self.session_id:
            headers["mcp-session-id"] = self.session_id
        req = urlreq.Request(self.url, data=data, headers=headers, method="POST")
        try:
            resp = urlreq.urlopen(req, timeout=timeout)
        except urlerr.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
            return None, f"HTTP {e.code}: {err_body[:300]}"
        except urlerr.URLError as e:
            return None, f"URLError: {e}"
        except Exception as e:
            return None, f"{type(e).__name__}: {e}"
        try:
            sess = resp.headers.get("mcp-session-id")
            if sess and not self.session_id:
                self.session_id = sess
            ctype = resp.headers.get("content-type", "")
            # If server returned plain JSON, read it all.
            if "text/event-stream" not in ctype:
                body = resp.read().decode("utf-8", errors="replace")
                return self._parse_sse(body), None
            # SSE — read line-by-line and return on first `data:` event.
            pending_event = None
            deadline = time.time() + timeout
            while time.time() < deadline:
                raw = resp.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                if line.startswith("event:"):
                    pending_event = line.split(":", 1)[1].strip()
                elif line.startswith("data:"):
                    payload_str = line.split(":", 1)[1].strip()
                    if not payload_str:
                        continue
                    try:
                        return json.loads(payload_str), None
                    except json.JSONDecodeError:
                        continue
                elif line == "":
                    pending_event = None
            return None, "SSE deadline before data event"
        except Exception as e:
            return None, f"{type(e).__name__}: {e}"
        finally:
            try:
                resp.close()
            except Exception:
                pass

    @staticmethod
    def _parse_sse(body: str) -> dict | None:
        # Streamable HTTP returns one or more SSE events; pick the first
        # 'data:' line that parses as JSON-RPC.
        for line in body.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                payload = line[len("data:"):].strip()
                if not payload:
                    continue
                try:
                    return json.loads(payload)
                except json.JSONDecodeError:
                    continue
        # Some servers return raw JSON when client only sent application/json
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return None

    def initialize(self) -> bool:
        msg, err = self._post({
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "ops-pocket-watcher", "version": "0.1.0"},
            },
        })
        if err or not msg or "result" not in msg:
            log(f"initialize failed: {err or msg}")
            return False
        # Send notifications/initialized (no response expected; best-effort)
        try:
            self._post({
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
                "params": {},
            }, timeout=10)
        except Exception:
            pass
        return True

    def call_tool(self, name: str, arguments: dict, timeout: int = 30) -> tuple[dict | None, str | None]:
        msg, err = self._post({
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }, timeout=timeout)
        if err:
            return None, err
        if not msg:
            return None, "empty response"
        if "error" in msg:
            return None, json.dumps(msg["error"])[:300]
        result = msg.get("result", {})
        # MCP tool spec: top-level `isError: true` means the tool ran but
        # returned a server-side error (e.g. "search service unavailable").
        # Surface this as an err so callers don't silently treat it as
        # "no results found." Without this, an upstream Pocket search
        # outage looks identical to a normal empty result set.
        if result.get("isError"):
            content = result.get("content") or []
            msg_text = ""
            for block in content:
                if block.get("type") == "text":
                    msg_text = block.get("text", "")
                    break
            return None, f"tool_error: {msg_text[:200] or 'isError=true with no text'}"
        content = result.get("content", [])
        # MCP tool responses wrap data in `content` blocks (type=text).
        for block in content:
            if block.get("type") == "text":
                text = block.get("text", "")
                try:
                    return json.loads(text), None
                except json.JSONDecodeError:
                    # Plain text result; bubble up as-is
                    return {"text": text}, None
        return result, None


# ── Anthropic Haiku (implicit-task inference) ────────────────────────────────
def _resolve_anthropic_auth() -> tuple[str, dict] | tuple[None, None]:
    """Returns (header_value, extra_headers) or (None, None) if no auth.

    Prefers Claude Code OAuth (macOS keychain or Linux/WSL file-backed
    credentials at ~/.claude/.credentials.json) so subscription users don't
    pay metered rates. Falls back to ANTHROPIC_API_KEY env / keychain.
    """
    # CRS relay first — fleet-sanctioned path. Subscription OAuth tokens 401 on
    # direct api.anthropic.com after a token rotation; route through the local CRS
    # relay. token from $ANTHROPIC_AUTH_TOKEN or keychain service CRS_KEY.
    crs_tok = os.environ.get("ANTHROPIC_AUTH_TOKEN", "").strip()
    if not crs_tok:
        try:
            r = subprocess.run(
                ["security", "find-generic-password", "-s", "CRS_KEY", "-w"],
                capture_output=True, text=True, timeout=5,
            )
            if r.returncode == 0 and r.stdout.strip():
                crs_tok = r.stdout.strip()
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
    if crs_tok:
        crs_base = os.environ.get("ANTHROPIC_BASE_URL", "http://127.0.0.1:3005/api").strip()
        return (f"Bearer {crs_tok}", {"_base_url": crs_base})
    # Try Claude Code OAuth — macOS keychain
    try:
        blob = subprocess.run(
            ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
            capture_output=True, text=True, timeout=5,
        )
        if blob.returncode == 0 and blob.stdout.strip():
            data = json.loads(blob.stdout.strip())
            o = data.get("claudeAiOauth") or {}
            tok = o.get("accessToken") or ""
            exp = o.get("expiresAt") or 0
            if tok and exp > int(time.time() * 1000) + 60000:
                return (f"Bearer {tok}", {"anthropic-beta": "oauth-2025-04-20"})
    except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError):
        pass
    # Try Claude Code OAuth — Linux/WSL file-backed credentials
    try:
        creds_path = Path(os.path.expanduser("~")) / ".claude" / ".credentials.json"
        if creds_path.exists():
            data = json.loads(creds_path.read_text())
            o = data.get("claudeAiOauth") or {}
            tok = o.get("accessToken") or ""
            exp = o.get("expiresAt") or 0
            if tok and exp > int(time.time() * 1000) + 60000:
                return (f"Bearer {tok}", {"anthropic-beta": "oauth-2025-04-20"})
    except (OSError, json.JSONDecodeError):
        pass
    # API key fallback
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        try:
            r = subprocess.run(
                ["security", "find-generic-password", "-s", "ANTHROPIC_API_KEY", "-a", "ops-daemon", "-w"],
                capture_output=True, text=True, timeout=5,
            )
            if r.returncode == 0 and r.stdout.strip():
                key = r.stdout.strip()
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
    if key:
        return (None, {"_apikey": key})  # caller treats as x-api-key header
    return (None, None)


def _transcript_for_infer_length_gate(recording: dict) -> str:
    """Transcript string used for infer length gating and Haiku prompting.

    Matches infer_tasks_from_recording: use Pocket transcript when non-empty;
    otherwise join transcriptSegments with speaker prefixes (same as inference).
    """
    transcript = recording.get("transcript") or ""
    if not transcript:
        segs = recording.get("transcriptSegments") or []
        transcript = "\n".join(
            f"{s.get('speaker') or 'Speaker'}: {s.get('text', '').strip()}"
            for s in segs[:80] if s.get("text")
        )
    return transcript


def infer_tasks_from_recording(recording: dict) -> tuple[list[dict], bool]:
    """Call Haiku to extract implicit tasks from a recording's transcript.

    Returns ``(tasks, api_ok)`` where *tasks* is a list of
    {title, context, priority, confidence} dicts (filtered by INFER_CONFIDENCE).
    *api_ok* is True only when a Haiku HTTP request completed and the model
    reply was parsed as a JSON array (possibly empty after filtering) — so
    callers can persist dedupe markers and infer-budget without treating transport
    or parse failures as a successful empty extraction.
    """
    if not INFER_TASKS:
        return [], True
    duration = recording.get("durationSec") or recording.get("duration") or 0
    if duration and duration < INFER_MIN_SECS:
        return [], True
    transcript = _transcript_for_infer_length_gate(recording)
    if len(transcript) < 200:
        return [], True

    summary = recording.get("summary") or {}
    if isinstance(summary, dict):
        summary_text = summary.get("text") or summary.get("body") or summary.get("summary") or ""
    else:
        summary_text = str(summary)

    auth_header, extras = _resolve_anthropic_auth()
    if not auth_header and not (extras or {}).get("_apikey"):
        log("infer: no Anthropic auth — skipping implicit-task extraction")
        return [], False

    system_prompt = (
        "You extract implicit actionable tasks from a voice-memo transcript. "
        "Pocket has ALREADY extracted the obvious action items separately, so "
        "your job is to find tasks the speaker IMPLIED but did not explicitly "
        "ask for. Examples of implicit tasks: 'I'm worried about X' → 'Check X', "
        "'I should follow up on Y' → 'Follow up on Y'. Skip mere observations, "
        "musings without a clear action, or things Pocket would already flag. "
        "Return STRICT JSON: an array of objects with keys: title (string, "
        "imperative form, <80 chars), context (string, 1-2 sentences of why), "
        "priority (low|medium|high), confidence (0.0-1.0 — your honest "
        f"certainty that this was implied as a task {_OWNER_NAME} would want done). "
        "Return [] if nothing actionable was implied. NO prose, NO markdown."
    )

    user_msg = (
        f"Recording summary: {summary_text or '(none)'}\n\n"
        f"Transcript:\n{transcript[:8000]}"
    )

    headers = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
    }
    if auth_header:
        headers["Authorization"] = auth_header
        for k, v in (extras or {}).items():
            if k not in ("_apikey", "_base_url"):
                headers[k] = v
    else:
        headers["x-api-key"] = (extras or {}).get("_apikey", "")
    _base_url = (extras or {}).get("_base_url", "https://api.anthropic.com")

    payload = {
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 1024,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_msg}],
    }
    data = json.dumps(payload).encode("utf-8")
    req = urlreq.Request(f"{_base_url}/v1/messages",
                         data=data, headers=headers, method="POST")
    try:
        with urlreq.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urlerr.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")[:200] if e.fp else ""
        log(f"infer: Haiku HTTP {e.code}: {err}")
        return [], False
    except Exception as e:
        log(f"infer: Haiku call failed: {type(e).__name__}: {e}")
        return [], False

    text = ""
    for block in body.get("content", []):
        if block.get("type") == "text":
            text = block.get("text", "")
            break
    text = text.strip()
    # Strip markdown fences if any
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)

    try:
        items = json.loads(text)
    except json.JSONDecodeError:
        log(f"infer: bad JSON from Haiku: {text[:200]}")
        return [], False
    if not isinstance(items, list):
        return [], False
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        try:
            conf = float(it.get("confidence", 0))
        except (TypeError, ValueError):
            conf = 0.0
        if conf < INFER_CONFIDENCE:
            continue
        out.append({
            "title": (it.get("title") or "").strip()[:140],
            "context": (it.get("context") or "").strip()[:500],
            "priority": (it.get("priority") or "low").lower(),
            "confidence": conf,
        })
    return out, True


# ── Giga client (reuses mcp-remote OAuth token cache) ────────────────────────
class GigaClient:
    """Giga MCP client that delegates to `claude -p` subprocess so it uses
    Claude Code's native MCP auth (no mcp-remote token cache management).
    Buffers neurons during the run and flushes in one batch claude call at
    main() end. Avoids per-memory subprocess overhead.
    """

    def __init__(self, url: str, mind: str) -> None:
        self.url = url
        self.mind = mind
        self.ok = False
        self._buffered: list[dict] = []
        self._consolidate_after = False

    def initialize(self) -> bool:
        # Cheap pre-flight: verify claude binary exists. Real auth verified at flush.
        claude_bin = os.environ.get("POCKET_CLAUDE_BIN", str(HOME / ".local/bin/claude"))
        if not Path(claude_bin).exists():
            log(f"Giga disabled: claude binary not found at {claude_bin}")
            return False
        self.ok = True
        return True

    def remember(self, title: str, body: str, neuron_type: str = "context",
                 selector_nl: str = "", priority: int = 0) -> str | None:
        if not self.ok:
            return None
        self._buffered.append({
            "title": title[:120],
            "body": body[:2000],
            "neuron_type": neuron_type,
            "selector_nl": selector_nl[:200],
            "priority": priority,
            "always_on": False,
        })
        # Return a placeholder; real neuron_id only known after flush
        return f"buffered:{len(self._buffered)}"

    def consolidate(self) -> bool:
        if not self.ok:
            return False
        self._consolidate_after = True
        return True

    def flush(self) -> bool:
        """Send all buffered neurons via one `claude -p` invocation. Returns
        True on success. Best-effort: any error logs and returns False but
        does NOT raise — local memory writes already succeeded.
        """
        if not self.ok or not self._buffered:
            return True
        claude_bin = os.environ.get("POCKET_CLAUDE_BIN", str(HOME / ".local/bin/claude"))
        parser_model = os.environ.get("GIGA_FLUSH_MODEL", "claude-sonnet-4-6")
        # Strip ANTHROPIC_API_KEY so claude uses OAuth subscription auth
        env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}

        neurons_json = json.dumps(self._buffered, ensure_ascii=False)
        consolidate_step = (
            f"\nAfter the remember call succeeds, also call mcp__giga__consolidate "
            f'with mind="{self.mind}".'
            if self._consolidate_after else ""
        )
        prompt = (
            f"Call the MCP tool mcp__giga__remember exactly once with these args:\n"
            f'  mind: "{self.mind}"\n'
            f"  neurons: {neurons_json}\n"
            f"{consolidate_step}\n\n"
            f"After the tool call(s) succeed, print on a single line: GIGA_FLUSH_OK\n"
            f"If any tool errors, print: GIGA_FLUSH_ERR <one-line reason>\n"
            f"No other output. No prose. No markdown."
        )
        cmd = [claude_bin, "--dangerously-skip-permissions",
               "--model", parser_model, "-p", prompt]
        try:
            proc = subprocess.run(cmd, env=env, capture_output=True,
                                  text=True, timeout=120)
        except subprocess.TimeoutExpired:
            log(f"giga flush timed out ({len(self._buffered)} neurons buffered locally)")
            return False
        except Exception as e:
            log(f"giga flush invoke failed: {type(e).__name__}: {e}")
            return False
        out = (proc.stdout or "") + "\n" + (proc.stderr or "")
        if "GIGA_FLUSH_OK" in out:
            log(f"giga flush ok: {len(self._buffered)} neurons synced "
                f"(consolidate={self._consolidate_after})")
            self._buffered.clear()
            self._consolidate_after = False
            return True
        log(f"giga flush failed: exit={proc.returncode} "
            f"out_tail={out.strip()[-300:]!r}")
        return False


# ── State ────────────────────────────────────────────────────────────────────
@contextmanager
def pocket_state_lock() -> None:
    """Serialize updates to seen.json and pending-triage.jsonl (watcher + webhook)."""
    if DRY_RUN:
        yield
        return
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    lock_path = STATE_DIR / ".pocket-webhook-state.lock"
    with open(lock_path, "a+b") as lock_f:
        fcntl.flock(lock_f.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_f.fileno(), fcntl.LOCK_UN)


def load_cursor() -> str:
    if CURSOR_FILE.exists():
        return CURSOR_FILE.read_text().strip()
    return (datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_HOURS)).strftime("%Y-%m-%dT%H:%M:%SZ")


def save_cursor(ts: str) -> None:
    if DRY_RUN:
        log(f"(dry-run) would set cursor -> {ts}")
        return
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    CURSOR_FILE.write_text(ts)


def load_seen() -> OrderedDict[str, None]:
    """Most-recently touched ids last (LRU tail); matches save_seen capping."""
    od: OrderedDict[str, None] = OrderedDict()
    if not SEEN_FILE.exists():
        return od
    try:
        raw = json.loads(SEEN_FILE.read_text())
    except json.JSONDecodeError:
        return od
    if not isinstance(raw, list):
        return od
    for x in raw:
        if isinstance(x, str) and x:
            od.pop(x, None)
            od[x] = None
    return od


def _seen_add(seen: OrderedDict[str, None], key: str) -> None:
    """Record id as most recently seen so capped persistence keeps newest entries."""
    seen.pop(key, None)
    seen[key] = None


def save_seen(seen: OrderedDict[str, None]) -> None:
    if DRY_RUN:
        return
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    # Cap at SEEN_CAP ids to bound file size (keep LRU tail deterministically)
    if len(seen) > SEEN_CAP:
        kept = list(seen.keys())[-SEEN_CAP:]
        seen.clear()
        for k in kept:
            seen[k] = None
    SEEN_FILE.write_text(json.dumps(list(seen.keys())))


def load_recordings_pagination_resume(recording_date_after: str) -> str | None:
    if not RECORDINGS_PAGINATION_RESUME_FILE.exists():
        return None
    try:
        data = json.loads(RECORDINGS_PAGINATION_RESUME_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    if data.get("recordingDateAfter") != recording_date_after:
        return None
    nb = data.get("nextRecordingDateBeforeExclusive")
    if not isinstance(nb, str) or not nb:
        return None
    return nb


def save_recordings_pagination_resume(
    recording_date_after: str, next_recording_date_before_exclusive: str,
) -> None:
    if DRY_RUN:
        log("(dry-run) would save recordings-pagination-resume.json")
        return
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    RECORDINGS_PAGINATION_RESUME_FILE.write_text(json.dumps({
        "recordingDateAfter": recording_date_after,
        "nextRecordingDateBeforeExclusive": next_recording_date_before_exclusive,
    }))


def clear_recordings_pagination_resume() -> None:
    if DRY_RUN:
        return
    try:
        RECORDINGS_PAGINATION_RESUME_FILE.unlink(missing_ok=True)
    except OSError:
        pass


# ── Pocket search outage tracking ────────────────────────────────────────────
def _is_search_unavailable(err: str) -> bool:
    """True iff the error string indicates Pocket's search backend is down
    (vs. a network/auth/local issue). We trust the upstream wording rather
    than guessing — Pocket's MCP returns exactly this phrase when their
    hybrid vector+BM25 index is offline."""
    if not err:
        return False
    e = err.lower()
    return "search service unavailable" in e


def _send_whatsapp_notification(message: str) -> bool:
    """Best-effort WhatsApp ping to the configured chat. Uses the same
    WhatsApp bridge REST endpoint pocket-supervisor uses for question
    escalation. Returns True if accepted (HTTP 2xx), False otherwise.
    Failures are non-fatal — recovery alerts are informational."""
    if not WHATSAPP_CONFIG.exists():
        return False
    try:
        cfg = json.loads(WHATSAPP_CONFIG.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    if not cfg.get("enabled") or not cfg.get("chat_jid"):
        return False
    url = os.environ.get("WHATSAPP_BRIDGE_URL", "http://localhost:8080/api/send")
    payload = json.dumps({"recipient": cfg["chat_jid"], "message": message}).encode()
    try:
        req = urlreq.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        with urlreq.urlopen(req, timeout=5) as resp:
            return 200 <= resp.status < 300
    except Exception as e:
        log(f"whatsapp recovery ping failed: {type(e).__name__}: {e}")
        return False


def _on_search_outage_detected(err: str) -> None:
    """First-time outage detection: write marker with timestamp. No-op if
    marker already exists (we're in an ongoing outage)."""
    if SEARCH_OUTAGE_MARKER.exists():
        return
    if DRY_RUN:
        log(f"(dry-run) would mark search outage: {err}")
        return
    try:
        SEARCH_OUTAGE_MARKER.write_text(json.dumps({
            "first_seen": now_iso(),
            "error": err[:200],
        }))
        log(f"NEW Pocket search outage detected: {err[:120]}")
    except OSError as e:
        log(f"failed to write outage marker: {e}")


def _on_search_outage_resolved() -> None:
    """Search came back. If we previously marked an outage, fire a
    WhatsApp notification with the duration and clear the marker."""
    if not SEARCH_OUTAGE_MARKER.exists():
        return
    try:
        info = json.loads(SEARCH_OUTAGE_MARKER.read_text())
        first_seen = info.get("first_seen", "")
        duration_note = ""
        if first_seen:
            try:
                start = datetime.strptime(first_seen, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
                mins = int((datetime.now(timezone.utc) - start).total_seconds() // 60)
                duration_note = f" (outage lasted ~{mins} min)"
            except ValueError:
                pass
        msg = f"🟢 Pocket search backend is back online{duration_note}. Watcher will resume processing new recordings."
        sent = _send_whatsapp_notification(msg)
        log(f"search recovery — whatsapp_sent={sent}")
        SEARCH_OUTAGE_MARKER.unlink(missing_ok=True)
    except (OSError, json.JSONDecodeError) as e:
        log(f"recovery handler failed: {e}")
        # Try to clear the marker anyway so we don't loop alerts
        try:
            SEARCH_OUTAGE_MARKER.unlink(missing_ok=True)
        except OSError:
            pass


# ── Output sinks ─────────────────────────────────────────────────────────────
def slugify(text: str, maxlen: int = 60) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "_", (text or "").lower()).strip("_")
    return (s or "untitled")[:maxlen]


def actionitem_webhook_triage_dedupe_key(recording_id: str, title: str) -> str | None:
    """Matches ops-pocket-webhook-ingest keys for action items without MCP ids."""
    rid = (recording_id or "").strip()
    tit = (title or "").strip()
    if not rid or not tit:
        return None
    return f"action-todo:{rid}:{slugify(tit, 40)}"


def write_memory(recording: dict, giga: "GigaClient | None" = None) -> Path | None:
    """Persist a recording as a memory file. One file per recording_id.

    If a connected GigaClient is provided, also writes a `context` neuron to
    the configured Giga mind with a back-reference to the local file.
    """
    rid = recording.get("id") or recording.get("recordingId") or ""
    summary = recording.get("summary") or {}
    title = recording.get("title") or (summary.get("title") if isinstance(summary, dict) else "") or ""
    if not title:
        # Derive from first transcript line
        segs = recording.get("transcriptSegments") or []
        title = (segs[0].get("text", "") if segs else "")[:80]
    title = title.strip() or "voice memo"

    # Build body from summary + first chunk of transcript
    if isinstance(summary, dict):
        summary_text = summary.get("text") or summary.get("body") or summary.get("summary") or ""
    else:
        summary_text = str(summary)

    transcript = recording.get("transcript", "")
    if not transcript:
        segs = recording.get("transcriptSegments") or []
        transcript = "\n".join(
            f"- {s.get('speaker') or 'Speaker'}: {s.get('text', '').strip()}"
            for s in segs[:60] if s.get("text")
        )

    recorded_at = recording.get("recordingDate") or recording.get("createdAt") or now_iso()
    duration = recording.get("durationSec") or recording.get("duration") or 0

    slug = slugify(title)
    date_part = recorded_at[:10].replace("-", "")
    fname = f"pocket_{date_part}_{slug}.md"
    path = MEMORY_DIR / fname

    body = f"""---
name: pocket-{date_part}-{slug}
description: Pocket voice memo — {title[:120]}
metadata:
  type: project
  source: pocket_voice
  recording_id: {rid}
  recorded_at: {recorded_at}
  duration_sec: {duration}
  imported_at: {now_iso()}
---

# {title}

**Recorded:** {recorded_at} · **Duration:** {duration}s · **ID:** `{rid}`

## Summary
{summary_text or "_(no summary extracted by Pocket)_"}

## Transcript
{transcript or "_(no transcript)_"}
"""

    if DRY_RUN:
        log(f"(dry-run) would write memory {path}")
        return path
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(body)
    log(f"wrote memory {path.name}")

    # Optional index update
    if INDEX_FILE:
        try:
            idx_path = Path(os.path.expanduser(INDEX_FILE))
            if idx_path.exists():
                entry = f"- [{title[:70]}]({fname}) — {recorded_at[:10]} · {duration}s"
                content = idx_path.read_text()
                section_hdr = "## Pocket Voice Journal"
                if section_hdr in content:
                    content = re.sub(
                        rf"({re.escape(section_hdr)}\n)",
                        rf"\1{entry}\n",
                        content, count=1,
                    )
                else:
                    content = content.rstrip() + f"\n\n{section_hdr}\n{entry}\n"
                idx_path.write_text(content)
        except Exception as e:
            log(f"index update failed: {e}")

    # Mirror to Giga global mind
    if giga and giga.ok and not DRY_RUN:
        neuron_body = (
            f"Pocket voice memo — {recorded_at} · {duration}s · `{rid}`\n\n"
            f"Local memory file: {path}\n\n"
            f"## Summary\n{summary_text or '_(none)_'}\n"
        )
        nid = giga.remember(
            title=f"pocket_{date_part}_{slug}"[:120],
            body=neuron_body,
            neuron_type="context",
            selector_nl=f"voice memo {title[:100]}",
        )
        if nid:
            log(f"giga neuron {nid[:8]}.. created for {fname}")

    return path


def append_jsonl(path: Path, obj: dict) -> None:
    if DRY_RUN:
        log(f"(dry-run) would append to {path}: {obj.get('kind') or obj.get('type')}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps(obj) + "\n")


def route_actionitem(item: dict, giga: "GigaClient | None" = None) -> None:
    """Route a Pocket-extracted action item into the appropriate queue.

    Outbound types (send_message, draft_email) -> draft queue (Rule 6).
    Reminder/task -> task queue.

    Also mirrors to Giga as a `task` (or `context` for outbound drafts) neuron
    so the item is recallable across sessions.
    """
    item_id = item.get("id") or item.get("actionItemId") or str(uuid.uuid4())
    action_type = (item.get("actionType") or item.get("type") or "").lower()
    payload = {
        "id": item_id,
        "kind": action_type or "task",
        "title": item.get("title") or item.get("label") or "",
        "context": item.get("context") or "",
        "payload": item.get("payload") or {},
        "priority": item.get("priority"),
        "due": item.get("dueDate") or item.get("dueAt"),
        "recording_id": item.get("recordingId"),
        "source": "pocket",
        "captured_at": now_iso(),
    }
    if action_type in ("send_message", "draft_email"):
        append_jsonl(DRAFT_QUEUE, payload)
        log(f"queued draft ({action_type}): {payload['title'][:60]}")
        giga_type = "context"
    else:
        append_jsonl(TASK_QUEUE, payload)
        log(f"queued task: {payload['title'][:60]}")
        giga_type = "task"

    if giga and giga.ok and not DRY_RUN:
        slug = slugify(payload["title"] or item_id)[:40]
        neuron_body = (
            f"Pocket action item (kind={payload['kind']}) — captured {payload['captured_at']}\n\n"
            f"**Title:** {payload['title']}\n"
            f"**Priority:** {payload['priority'] or 'unset'}\n"
            f"**Due:** {payload['due'] or 'unset'}\n"
            f"**Source recording:** {payload['recording_id'] or 'unknown'}\n\n"
            f"## Context\n{payload['context'] or '_(none)_'}\n"
        )
        nid = giga.remember(
            title=f"pocket_action_{slug}"[:120],
            body=neuron_body,
            neuron_type=giga_type,
            selector_nl=f"pocket action item {payload['title'][:100]}",
            priority=1 if (payload["priority"] or "").lower() in ("critical", "high") else 0,
        )
        if nid:
            log(f"giga neuron {nid[:8]}.. created for action {item_id[:8]}")


# ── Main run ────────────────────────────────────────────────────────────────
def main() -> int:
    write_health("running", "starting")
    log(f"start (dry_run={DRY_RUN})")
    STATE_DIR.mkdir(parents=True, exist_ok=True)

    api_key = resolve_api_key()
    cursor = load_cursor()
    run_started = now_iso()

    client = MCPClient(MCP_URL, api_key)
    if not client.initialize():
        write_health("error", "MCP initialize failed")
        return 2

    giga: GigaClient | None = None
    if GIGA_SYNC:
        giga = GigaClient(GIGA_MCP_URL, GIGA_MIND)
        if giga.initialize():
            log(f"giga sync active (mind={GIGA_MIND})")
        else:
            log("giga sync disabled (init failed)")
            giga = None

    with pocket_state_lock():
        seen = load_seen()
        log(f"cursor={cursor} seen={len(seen)}")

    # 1) Pull recordings since cursor (MCP + Haiku outside pocket_state_lock so
    # webhook ingest can make progress; seen/pending updates are short critical
    # sections below).
    new_memories = 0
    new_recordings: list[str] = []
    recordings_page_cap_hit = False
    next_before: str | None = load_recordings_pagination_resume(cursor)
    if next_before:
        log("resuming pocket recordings pagination (nextRecordingDateBeforeExclusive set)")
    page = 0
    infer_calls = 0  # Haiku calls made this run; capped by MAX_INFER_PER_RUN
    cap_hit = False  # set when MAX_INFER_PER_RUN reached — breaks page loop too
    while True:
        page += 1
        args = {"recordingDateAfter": cursor}
        if next_before:
            args["recordingDateBeforeExclusive"] = next_before
        result, err = client.call_tool("search_pocket_conversations_timerange", args, timeout=30)
        if err:
            log(f"recordings page {page} error: {err}")
            # Distinguish "Pocket search backend is down" from other errors
            # so we can fire a recovery alert when it comes back. Only mark
            # outage on the first page (later pages may fail mid-pagination
            # for unrelated reasons and shouldn't trigger the global flag).
            if page == 1 and _is_search_unavailable(err):
                _on_search_outage_detected(err)
            break
        # Successful call — if we had a recorded outage, fire recovery
        # notification (one-shot, marker is cleared inside the helper).
        if page == 1:
            _on_search_outage_resolved()
        data = (result or {}).get("data", result or {})
        recordings = data.get("results") or data.get("recordings") or data.get("conversations") or []
        meta = data.get("meta") or {}
        if not recordings:
            clear_recordings_pagination_resume()
            break
        for rec in recordings:
            rid = rec.get("id") or rec.get("recordingId") or ""
            would_infer = False
            wh_infer = ""
            infer_done_elsewhere = False
            run_infer = False

            with pocket_state_lock():
                seen = load_seen()
                if not rid or rid in seen:
                    continue
                # Skip very short, transcript-less recordings (likely noise)
                duration = rec.get("durationSec") or rec.get("duration") or 0
                transcript = rec.get("transcript") or ""
                segs = rec.get("transcriptSegments") or []
                has_content = bool(transcript or segs)
                if duration and duration < 20 and not has_content:
                    log(f"skip noise recording {rid} (dur={duration}s, no transcript)")
                    _seen_add(seen, rid)
                    save_seen(seen)
                    continue

                # Money-leak guard: if a Haiku inference would fire for THIS
                # recording and we've already hit the per-run cap, STOP the loop
                # entirely — do NOT write_memory and do NOT mark seen, so the
                # recording rolls over to the next run untouched. We pre-check
                # the same gating logic infer_tasks_from_recording uses so we
                # don't artificially skip recordings that wouldn't trigger Haiku
                # anyway (too-short, INFER_TASKS=0, etc).
                gate_transcript = _transcript_for_infer_length_gate(rec)
                would_infer = (
                    INFER_TASKS
                    and (not duration or duration >= INFER_MIN_SECS)
                    and len(gate_transcript) >= 200
                )
                wh_infer = f"wh-infer:{rid}"
                infer_done_elsewhere = wh_infer in seen
                if (
                    MAX_INFER_PER_RUN > 0
                    and would_infer
                    and infer_calls >= MAX_INFER_PER_RUN
                ):
                    log(
                        f"infer cap hit: {infer_calls}/{MAX_INFER_PER_RUN} Haiku "
                        f"calls this run — deferring recording {rid} to next run"
                    )
                    cap_hit = True
                    break

                if would_infer and not infer_done_elsewhere:
                    _seen_add(seen, wh_infer)
                    save_seen(seen)
                    run_infer = True

            write_memory(rec, giga=giga)

            if infer_done_elsewhere:
                inferred: list[dict] = []
                infer_api_ok = True
            else:
                inferred, infer_api_ok = infer_tasks_from_recording(rec)
            if would_infer and not infer_done_elsewhere and run_infer:
                infer_calls += 1

            with pocket_state_lock():
                seen = load_seen()
                if run_infer and not infer_api_ok:
                    seen.pop(wh_infer, None)
                if rid not in seen:
                    _seen_add(seen, rid)
                    new_memories += 1
                    new_recordings.append(rid)
                for idx, t in enumerate(inferred):
                    inferred_id = f"inferred-{rid[:12]}-{idx}"
                    if inferred_id in seen:
                        continue
                    payload = {
                        "id": inferred_id,
                        "kind": "inferred",
                        "title": t["title"],
                        "context": t["context"],
                        "priority": t["priority"],
                        "due": None,
                        "recording_id": rid,
                        "source": "pocket-haiku-inferred",
                        "confidence": t["confidence"],
                        "captured_at": now_iso(),
                    }
                    if DRY_RUN:
                        log(f"(dry-run) would queue inferred task for triage: {t['title'][:60]} (conf={t['confidence']:.2f})")
                    else:
                        # Inferred tasks go to pending-triage.jsonl, NOT directly to
                        # the live tasks.jsonl. The Opus triage agent must classify
                        # them (ACT / DRAFT / DROP / ASK) before any can reach the
                        # supervisor. This is the mandated safety guardrail:
                        # no autonomous work without a verdict.
                        PENDING_TRIAGE.parent.mkdir(parents=True, exist_ok=True)
                        with PENDING_TRIAGE.open("a") as f:
                            f.write(json.dumps(payload) + "\n")
                        log(f"queued for triage: {t['title'][:60]} (conf={t['confidence']:.2f})")
                    _seen_add(seen, inferred_id)
                save_seen(seen)

        if cap_hit:
            break
        if meta.get("hasMore") and meta.get("nextRecordingDateBeforeExclusive"):
            next_before = meta["nextRecordingDateBeforeExclusive"]
            if page >= 10:
                log("hit page cap (10) — leaving cursor unchanged; saved pagination resume for next run")
                save_recordings_pagination_resume(cursor, next_before)
                recordings_page_cap_hit = True
                break
        else:
            clear_recordings_pagination_resume()
            break

    # 2) Pull action items since cursor (TODO only)
    new_tasks = 0
    result, err = client.call_tool("search_pocket_actionitems", {
        "status": "TODO",
        "recordingDateFrom": cursor,
    }, timeout=30)
    if err:
        log(f"actionitems error: {err}")
    else:
        data = (result or {}).get("data", result or {})
        items = data.get("results") or data.get("items") or data.get("actionItems") or []
        for item in items:
            iid = item.get("id") or item.get("actionItemId")
            if not iid:
                continue
            seen_key = f"action:{iid}"
            rec_id = str(item.get("recordingId") or item.get("recording_id") or "").strip()
            title = (item.get("title") or item.get("label") or "").strip()
            webhook_triage_key = actionitem_webhook_triage_dedupe_key(rec_id, title)
            with pocket_state_lock():
                seen = load_seen()
                if seen_key in seen:
                    continue
                if webhook_triage_key and webhook_triage_key in seen:
                    continue
            route_actionitem(item, giga=giga)
            with pocket_state_lock():
                seen = load_seen()
                if seen_key in seen:
                    continue
                new_tasks += 1
                _seen_add(seen, seen_key)
                save_seen(seen)

    # 3) Optional consolidate pass (Giga merges adjacent neurons)
    if giga and giga.ok and GIGA_CONSOLIDATE and (new_memories + new_tasks) > 0:
        giga.consolidate()

    # 3.5) Flush buffered Giga neurons via claude -p subprocess (uses Claude Code auth)
    giga_flush_ok = True
    if giga and giga.ok:
        giga_flush_ok = giga.flush()

    # 4) Advance cursor & persist.
    # Do not advance if either the Haiku-inference cap or pagination cap was hit —
    # both mean there are deferred recordings that need the same window next run.
    with pocket_state_lock():
        if cap_hit:
            log(f"cap hit: holding cursor at {cursor} (not advancing to {run_started})")
        elif not recordings_page_cap_hit:
            save_cursor(run_started)

    if giga and giga.ok and not giga_flush_ok:
        giga_status = "flush_failed"
    elif giga and giga.ok:
        giga_status = "ok"
    elif not GIGA_SYNC:
        giga_status = "disabled"
    else:
        giga_status = "failed"
    summary = f"recordings={new_memories} tasks={new_tasks} giga={giga_status}"
    pocket_search_state = "outage" if SEARCH_OUTAGE_MARKER.exists() else "ok"
    # Overall watcher status reflects upstream Pocket search availability.
    # When Pocket's search backend is down, the watcher itself is fine, but
    # the pipeline is effectively blocked — dashboards/alerts should treat
    # this as degraded, not green. `degraded` is intentionally distinct from
    # `error` (which is reserved for watcher-internal failures like an MCP
    # init crash or unrecoverable exception).
    overall_status = "degraded" if pocket_search_state == "outage" else "ok"
    overall_msg = (
        f"{summary} (upstream Pocket search unavailable)"
        if pocket_search_state == "outage"
        else summary
    )
    write_health(overall_status, overall_msg, extra={
        "new_memories": new_memories,
        "new_tasks": new_tasks,
        "cursor": run_started if not cap_hit and not recordings_page_cap_hit else cursor,
        "giga_sync": giga_status,
        "pocket_search": pocket_search_state,
    })
    log(f"done {summary}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        write_health("error", f"{type(e).__name__}: {e}")
        sys.exit(1)
