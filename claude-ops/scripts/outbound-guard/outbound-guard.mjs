// Node side of the shared approval store.
//
// Until 2026-09-10 this file kept its OWN copy of the store logic and read two
// fields -- `remaining` (a count) and `spent` (a fingerprint map) -- that the
// Python side stopped writing on 2026-09-02. `mint()` writes
// {minted, ttl, approved, inflight}. So `Number(d.remaining ?? 0)` was 0 and
// `spent` was {} on every single call, and this guard refused EVERY message Sam
// had actually approved. The only sends that got through did so because
// read() returned null and the legacy /tmp/.claude-send-ok fallback fired.
//
// The fingerprint had drifted too: this file collapsed all whitespace and
// truncated the body to 400 chars, while outbound_guard.py hashes the full body
// with a narrow per-line rstrip. Two normalisers means two different messages,
// so a match was impossible even with the right field names.
//
// Rather than re-implement the store a third time and wait for the next drift,
// the decision is now DELEGATED to outbound_guard.py itself. That module owns
// the lock, the approved set, the in-flight window, the permanent ledger and the
// consent audit line. One implementation, one answer, no twin to keep in sync.
//
// The payload goes over stdin, never argv, so a body containing quotes or
// newlines cannot alter the command.
// SCHEMA MARKER. sync-installed-copy.sh reads this line out of both the repo
// source and the installed copy and refuses to overwrite a copy whose schema it
// cannot place. Bump it whenever the contract with outbound_guard.py changes.
// outbound-guard-schema: reservation-v2
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

export const SCHEMA = 'reservation-v2';
export const STATE = process.env.OUTBOUND_GUARD_STATE || '/tmp/.claude-outbound-guard.json';
export const SPENT_WINDOW_SEC = 120;
const LEGACY_SINGLE = '/tmp/.claude-send-ok';
const LEGACY_SINGLE_TTL_SEC = 120;

const GUARD_PY =
  process.env.OUTBOUND_GUARD_PY || `${os.homedir()}/.claude/scripts/hooks/outbound_guard.py`;
const PYTHON = process.env.OUTBOUND_GUARD_PYTHON || 'python3';

// Same computation as outbound_guard.py:fingerprint(). Kept here only so callers
// can label a message; the allow/deny decision uses the Python one, so the two
// can no longer disagree about which message is which.
export function fingerprint(recipient, body) {
  const r = String(recipient ?? '')
    .trim()
    .toLowerCase();
  const b = String(body ?? '')
    .split('\n')
    .map((ln) => ln.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
  return crypto.createHash('sha256').update(`${r}|${b}`).digest('hex').slice(0, 32);
}

const BRIDGE = `
import json, sys, importlib.util
path, fn = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("outbound_guard", path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
payload = json.load(sys.stdin)
if fn == "consume":
    out = {"ok": bool(mod.consume(payload.get("recipient", ""), payload.get("body", ""),
                                  payload.get("session_id", ""), payload.get("tool", "")))}
elif fn == "peek":
    n, left = mod.peek()
    out = {"remaining": int(n), "validForSec": int(left)}
elif fn == "claim":
    # The (recipient, body) is derived HERE, by the same function the PreToolUse
    # gate uses, from the same arguments object. Deriving it on the Node side
    # would be a second implementation of the one thing that must not differ.
    r = payload.get("recipient", "")
    b = payload.get("body", "")
    args = payload.get("args")
    if isinstance(args, dict) and args:
        r2, b2 = mod.identify_args(args)
        if r2 or b2:
            r, b = r2, b2
    out = {"ok": bool(mod.claim_reservation(r, b, payload.get("guard", ""),
                                            payload.get("session_id", ""),
                                            payload.get("tool", "")))}
else:
    raise SystemExit(2)
sys.stdout.write(json.dumps(out))
`;

// Null means "could not reach the guard at all" -- distinct from a guard that
// answered "no". Only the first case may fall back to anything.
function callGuard(fn, payload) {
  try {
    if (!fs.existsSync(GUARD_PY)) return null;
    const r = spawnSync(PYTHON, ['-c', BRIDGE, GUARD_PY, fn], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 15000
    });
    if (r.error || r.status !== 0) return null;
    const parsed = JSON.parse(r.stdout);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function peek() {
  const out = callGuard('peek', {});
  if (!out) return { remaining: 0, validForSec: 0 };
  return {
    remaining: Number(out.remaining ?? 0),
    validForSec: Math.max(0, Number(out.validForSec ?? 0))
  };
}

// True when Sam's own outbound gate ALREADY approved this exact message and is
// holding a live reservation for it -- i.e. this guard is the second lock on one
// call, not the first lock on a new one. Nothing is minted and nothing is spent
// here; the reservation is still committed or released by the PostToolUse step.
//
// Fails closed on every uncertainty. If the Python guard cannot be reached at
// all we return false, with NO legacy-token fallback: consume() may fall back
// because a bare token is Sam's deliberate escape hatch for a send, but "gate 1
// already approved this" is a claim about state, and a claim about state we
// cannot read is not a claim we may make.
export function claimReservation({ args, recipient = '', body = '', guard = '', sessionId = '', tool = '' } = {}) {
  if (!guard) return false;
  const out = callGuard('claim', {
    args: args && typeof args === 'object' ? args : null,
    recipient: String(recipient ?? ''),
    body: String(body ?? ''),
    guard: String(guard),
    session_id: String(sessionId ?? process.env.CLAUDE_SESSION_ID ?? ''),
    tool: String(tool ?? '')
  });
  return out ? out.ok === true : false;
}

// True when this message may go. The Python guard decides: it checks the
// in-flight window, then the permanent ledger, then the approved set minted for
// this exact (recipient, body), spends the approval once and writes the audit
// line. `tool` reaches the ledger so a retry from a different tool is refused.
export function consume(recipient = '', body = '', opts = {}) {
  const out = callGuard('consume', {
    recipient: String(recipient ?? ''),
    body: String(body ?? ''),
    session_id: String(opts.sessionId ?? process.env.CLAUDE_SESSION_ID ?? ''),
    tool: String(opts.tool ?? '')
  });
  if (out) return out.ok === true;

  // The guard itself was unreachable (no python3, module gone, crash). Only then
  // does the old single-use token still count, and otherwise this fails closed.
  try {
    const st = fs.statSync(LEGACY_SINGLE);
    if (Date.now() / 1000 - st.mtimeMs / 1000 > LEGACY_SINGLE_TTL_SEC) return false;
    try {
      fs.unlinkSync(LEGACY_SINGLE);
    } catch {
      /* best effort */
    }
    return true;
  } catch {
    return false;
  }
}
