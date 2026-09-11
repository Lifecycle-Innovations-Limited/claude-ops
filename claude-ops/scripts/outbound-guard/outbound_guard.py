#!/usr/bin/env python3
"""Eén kaartjesbureau voor alle uitgaande berichten, ongeacht welke CLI het vraagt.

Waarom dit bestaat. Er waren twee onafhankelijke wachters met elk hun eigen kaartje:
de PreToolUse-hook van Claude Code (/tmp/.claude-send-ok) en de mcp-proxy
(/tmp/.claude-send-ok-all). Eén bericht passeerde ze allebei, dus `ok` moest twee
bestanden schrijven en de tellingen liepen uiteen. Codex en Grok gaan langs dezelfde
proxy en hadden weer een ander beeld.

SECURITY FIX 2026-09-02, after a near-miss on a real deal thread. Two defects in the old
design:

1. Approval was a bearer credit ("remaining: N"), not a signature on a specific
   message. `mint(count, ttl)` set a count with no idea what it was for, and
   `consume(recipient, body)` would debit that count for ANY recipient and ANY
   body. Session A's approved draft could be spent by session B on a different
   message to a different person. Fixed: `mint()` now takes the exact set of
   fingerprints Sam is approving — sha256(recipient|normalized body) — and
   `consume()` only allows a send whose fingerprint is in that approved set.
2. A sent message became free to resend. The old "spent" dict let a second
   guard see the same fingerprint and pass for free, correctly avoiding a
   double-charge when ONE message crosses two layers (this Python hook and the
   Node mcp-proxy in outbound-guard.mjs) for the SAME PreToolUse cycle. But it
   never distinguished that from an unrelated session replaying the identical
   text later — a byte-identical resend inside the window went through free
   even with zero approval remaining. Fixed: split into two mechanisms.
     a. A short-lived in-flight set keyed on fingerprint + tool name (still
        120s, per Sam's instruction to keep the existing TTL) — this is the
        "two guards, one call" free pass, nothing more.
     b. A PERMANENT append-only ledger at ~/.claude/state/outbound-sent.jsonl.
        Once a fingerprint is in the ledger, every future consume() for it is
        refused, forever — not TTL'd. This is what stops a retry (or a second
        session) from silently duplicating a message whose actual delivery
        outcome was never confirmed. Since the two-phase commit below, the row
        is written by commit() rather than by consume(), and an abandoned
        reservation is COMMITTED on expiry — so an ambiguous outcome still
        leaves a paper trail that blocks a silent duplicate rather than a
        transparent one.

Normalisation stays conservative on purpose: strip trailing whitespace per
line and the trailing newline, nothing else. The old code collapsed all
whitespace AND truncated to 400 characters before hashing, which meant two
materially different messages sharing the same first 400 normalised
characters got the identical fingerprint — an approval for one could satisfy
the other. Fixed by hashing the full (lightly normalised) body.

    /tmp/.claude-outbound-guard.json
    {"minted": 1786732800, "ttl": 900,
     "approved": {"<fp>": {"ts": 1786732800, "recipient": "...", "preview": "..."}},
     "inflight": {"<fp>|<tool>": 1786732801},
     "reservations": {"<fp>": {"at": 1786732801, "recipient": "...", "tool": "...",
                               "session_id": "...", "meta": {...}}}}

`reservations` is phase one of the two-phase commit added 2026-09-11; see
RESERVATION_TTL_SEC below for why the approval is no longer spent on the
attempt.

Compatibility note: `ok` and the Node twin were on the OLD count-based shape
(`mint <n> <ttl>`, `{"remaining":..., "spent":...}`) when this file was first
written, and both have since been migrated. `ok` mints a SET of fingerprints
read from the pending queue; the Node twin no longer keeps a store at all and
delegates every decision here. The CLI below still refuses the old 2-int-arg
`mint` call loudly instead of silently doing nothing (or blocking on stdin), so
any caller left on the retired shape fails fast rather than hanging a shell.

Het Node-equivalent staat naast dit bestand als outbound-guard.mjs en, geinstalleerd,
op ~/.claude/mcp-proxy/outbound-guard.mjs. Het draagt een
`// outbound-guard-schema:` marker en sync-installed-copy.sh weigert een
installatie terug te zetten naar een ouder schema. Beide kanten hier houden
dezelfde fingerprint aan; de testsuite toetst dat eerst.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import time

# Overridable via env for the regression test suite only; production paths are
# the defaults below and unaffected when the env vars are unset.
STATE = os.environ.get("OUTBOUND_GUARD_STATE") or "/tmp/.claude-outbound-guard.json"
LOCK_FILE = os.environ.get("OUTBOUND_GUARD_LOCK") or "/tmp/.claude-outbound-guard.lock"
# Ledger of fingerprints that have actually been granted approval-to-send.
# Permanent, never pruned by TTL: "sent is sent forever."
LEDGER = os.environ.get("OUTBOUND_GUARD_LEDGER") or os.path.expanduser("~/.claude/state/outbound-sent.jsonl")

# Same single call crossing two guards (this Python PreToolUse hook and the
# Node mcp-proxy layer) for the SAME not-yet-dispatched message. Kept at the
# value Sam asked to preserve. This is intentionally narrow: it forgives a
# second GUARD checking the identical (fingerprint, tool) pair, not a second
# SEND. Once the ledger has the fingerprint, a request outside this window —
# including from a different tool, a different session, or after the window
# lapses — is refused outright regardless of this set.
INFLIGHT_TTL_SEC = 120

# TWO-PHASE COMMIT (2026-09-11, task 53). consume() used to spend the approval
# on the ATTEMPT: it deleted the fingerprint from `approved`, appended the
# ledger and drained the pending queue before the tool had run. That is correct
# only if this hook is the last gate. It is not. The MCP outbound guard
# (~/.claude/mcp-proxy/outbound-guard-proxy.mjs) runs AFTER every PreToolUse
# hook and independently demands a per-call owner approval id. When it refuses,
# nothing is sent -- but Sam's approval is already burnt and the draft is gone
# from the queue, so the retry needs a fresh `ok`, which is burnt the same way.
# An unbreakable loop. Live on 2026-09-11: fp 1d3023ffa1b26deb731bde199aef6c41
# is AUTHORIZED and ledgered at 07:21:30Z for a WhatsApp message that never
# left, and the ledger now refuses that exact body forever.
#
# So consume() now RESERVES. The approval leaves `approved`, so nothing else
# can spend it, but it is not ledgered and the queue is not drained until a
# PostToolUse step says the tool actually ran (commit) or reports an error or a
# downstream block (release). Nothing about WHAT is approved changed: the
# fingerprint check, the ledger check, the per-approval clock and the refusal
# of anything unapproved are byte-for-byte the same.
#
# A reservation is short-lived on purpose. If no PostToolUse outcome arrives
# within RESERVATION_TTL_SEC the reservation is COMMITTED, not released: an
# attempt whose outcome nobody reported may well have gone out, and the whole
# point of the permanent ledger is that an ambiguous outcome must block a
# silent duplicate rather than invite one. So an abandoned reservation leaves a
# spent approval and a ledger row, never a live approval lying around.
RESERVATION_TTL_SEC = int(os.environ.get("OUTBOUND_RESERVATION_TTL") or 180)

# Oude bestanden. Blijven werken zolang niet elke CLI over is, maar de canonieke
# toestand hierboven wint als die er is. Dit pad blijft ONGEWIJZIGD: Sam's eigen
# `! ok` (touch /tmp/.claude-send-ok, buiten het model om) is de noodrem en mag
# niet worden aangeraakt.
LEGACY_SINGLE = "/tmp/.claude-send-ok"
LEGACY_SINGLE_TTL = 120


def _normalize_body(body: str) -> str:
    """Strip trailing whitespace per line, collapse the trailing newline. Nothing
    else. The old normaliser collapsed ALL whitespace (spaces, newlines) into
    single spaces and truncated to 400 characters, which let two different
    messages that merely start the same way hash identically. Over-normalising
    is exactly what lets a materially different body match; this stays narrow
    on purpose."""
    lines = (body or "").split("\n")
    lines = [ln.rstrip() for ln in lines]
    return "\n".join(lines).rstrip("\n")


def canonical_recipients(*groups: str) -> str:
    """Eén sleutel voor de hele ontvangersgroep van één bericht.

    Tot 8 september 2026 weigerde de poort elke send met een cc, een bcc of een
    komma in --to: één afdruk dekte één adres. Dat maakte een mail aan twee
    mensen onverzendbaar in plaats van apart goed te keuren, en dat is precies
    het soort poort waar mensen omheen gaan werken. Nu telt de hele groep als de
    identiteit van het bericht.

    De sleutel is genormaliseerd zodat --to 'a,b' en --to a --cc b hetzelfde
    bericht zijn: adressen worden gesplitst op komma's, getrimd, verkleind,
    ontdubbeld en gesorteerd. Sorteren is nodig omdat de volgorde waarin iemand
    de adressen typt niets over het bericht zegt.

    De veiligheidseigenschap blijft ongewijzigd: een goedkeuring hangt aan
    precies deze groep. Er een adres bij zetten of er een af halen verandert de
    sleutel en dus de afdruk, en de send wordt geweigerd. Voor één ontvanger is
    de uitkomst identiek aan de oude berekening, dus bestaande stempels en
    wachtrijen blijven geldig.
    """
    seen = []
    for group in groups:
        for part in (group or "").split(","):
            addr = part.strip().lower()
            if addr and addr not in seen:
                seen.append(addr)
    return ",".join(sorted(seen))


def fingerprint(recipient: str, body: str) -> str:
    """Identiteit van een bericht: aan wie, met welke tekst.

    Kanaal bewust niet meegenomen: dezelfde mail die via de hook en via de proxy komt
    moet dezelfde afdruk krijgen, ook als de twee lagen het kanaal anders benoemen.
    The full normalised body is hashed (not truncated) so two messages sharing a
    long common prefix do not collide."""
    r = (recipient or "").strip().lower()
    b = _normalize_body(body)
    return hashlib.sha256(f"{r}|{b}".encode("utf-8")).hexdigest()[:32]


# Key order is load-bearing, not cosmetic. These two tuples ARE the definition of
# "who is this to" and "what does it say" for a structured tool call, and they
# were duplicated: block-outbound-comms.py:_identify() had this list, while the
# Node proxy's approvalInput() in outbound-policy.mjs had a DIFFERENT one
# (recipient/chat_jid only; text before message; no `payload`). Two lists means
# two fingerprints for one message, and a fingerprint the other side has never
# seen can never be matched -- which is precisely how the proxy came to demand
# its own second approval for a message Sam had already approved. One list, one
# derivation, both gates.
IDENT_RECIPIENT_KEYS = ("recipient", "jid", "chat_jid", "chat_id", "to", "channel_id")
IDENT_BODY_KEYS = ("message", "text", "body", "payload", "content")


def identify_args(tool_input: dict) -> tuple[str, str]:
    """(recipient, body) of a structured tool call, or ('', '') if it is neither.

    Extracted verbatim from block-outbound-comms.py:_identify() so the two gates
    share one derivation instead of two that agree by coincidence. The caller
    decides what an empty answer means: the PreToolUse hook falls back to
    parsing a Bash command, the proxy falls back to refusing.
    """
    if not isinstance(tool_input, dict) or not tool_input:
        return ("", "")
    rcpt = ""
    for k in IDENT_RECIPIENT_KEYS:
        v = tool_input.get(k)
        if isinstance(v, str) and v.strip():
            rcpt = v.strip()
            break
        if isinstance(v, list) and v:
            rcpt = str(v[0]).strip()
            break
    body = ""
    for k in IDENT_BODY_KEYS:
        v = tool_input.get(k)
        if isinstance(v, str) and v.strip():
            body = v
            break
    return (rcpt, body)


def _lock():
    os.makedirs(os.path.dirname(LOCK_FILE), exist_ok=True) if os.path.dirname(LOCK_FILE) else None
    fh = open(LOCK_FILE, "a+")
    fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
    return fh


def _unlock(fh) -> None:
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
    finally:
        fh.close()


def _read() -> dict | None:
    try:
        with open(STATE) as f:
            d = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    if not isinstance(d, dict):
        return None
    return d


def _write(d: dict) -> None:
    tmp = STATE + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(d, f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, STATE)
    except OSError:
        pass


def _clear() -> None:
    for p in (STATE, STATE + ".tmp"):
        try:
            os.remove(p)
        except OSError:
            pass


def _ledger_has(fp: str) -> bool:
    try:
        with open(LEDGER) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if row.get("fp") == fp:
                    return True
    except (FileNotFoundError, OSError):
        return False
    return False


def _consent_audit(event: str, **kw) -> None:
    """Best-effort. The audit must never be able to block or break a send."""
    try:
        import os as _os
        import sys as _sys
        _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
        import consent_audit
        consent_audit.record(event, **kw)
    except Exception:
        pass


def _ledger_append(fp: str, recipient: str, tool: str, session_id: str) -> None:
    os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
    row = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "fp": fp,
        "recipient": (recipient or "")[:200],
        "tool": (tool or "")[:120],
        "session_id": (session_id or "")[:120],
    }
    try:
        with open(LEDGER, "a") as f:
            f.write(json.dumps(row) + "\n")
        os.chmod(LEDGER, 0o600)
    except OSError:
        pass


PENDING_DIR = os.environ.get("OUTBOUND_PENDING_DIR") or os.path.expanduser(
    "~/.claude/state/outbound-pending"
)


def _drain_pending(fp: str) -> None:
    """Remove a delivered fingerprint from every session's pending queue.

    WHY (2026-09-09): a send is spent in three places and until today only two
    of them were written. consume() removed the fingerprint from `approved` and
    appended it to the ledger, but the DRAFT stayed in
    ~/.claude/state/outbound-pending/<session>.json as though it still had to
    go. Sam's next approval word re-derived that record, found it valid, and
    minted a fresh approval for a body that was already in the recipient's inbox.
    The ledger check in consume() then refused the second send -- so nothing
    duplicated -- but Sam had been shown an armed approval for delivered text,
    which is a lie about the state of the world and exactly the kind of thing
    that makes him stop trusting the gate.

    Best-effort by design: a queue that cannot be rewritten must never be able
    to stop a send that is already authorised. The ledger remains the hard
    guarantee against a duplicate; this only keeps the queue honest.
    """
    if not fp:
        return
    try:
        names = os.listdir(PENDING_DIR)
    except OSError:
        return
    for name in names:
        if not name.endswith(".json"):
            continue
        path = os.path.join(PENDING_DIR, name)
        try:
            with open(path) as f:
                queue = json.load(f)
            if not isinstance(queue, list):
                continue
            kept = [r for r in queue
                    if not (isinstance(r, dict) and r.get("fp") == fp)]
            if len(kept) == len(queue):
                continue
            tmp = path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(kept, f)
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except (OSError, ValueError):
            continue


def _expire_due(d: dict, now: float) -> list:
    """Split `reservations` into live and expired. Mutates d in place.

    A malformed entry is dropped and reported as expired: an unreadable
    reservation is a state this code cannot reason about, and the refusing
    direction is to treat the approval as spent, never to hand it back.
    """
    res = d.get("reservations")
    if not isinstance(res, dict):
        d["reservations"] = {}
        return []
    live, dead = {}, []
    for fp, rec in res.items():
        if not isinstance(rec, dict):
            dead.append((fp, {}))
            continue
        try:
            at = float(rec.get("at", 0))
        except (TypeError, ValueError):
            at = 0.0
        if now - at > RESERVATION_TTL_SEC:
            dead.append((fp, rec))
        else:
            live[fp] = rec
    d["reservations"] = live
    for fp, _rec in dead:
        _drop_inflight(d, fp)
    return dead


def _finalise_expired(dead: list) -> None:
    """Ledger every reservation that ran out of time. See RESERVATION_TTL_SEC."""
    for fp, rec in dead:
        if not fp or _ledger_has(fp):
            continue
        _ledger_append(fp, rec.get("recipient", ""), rec.get("tool", ""),
                       rec.get("session_id", ""))
        _drain_pending(fp)
        meta = rec.get("meta") if isinstance(rec.get("meta"), dict) else {}
        _consent_audit(
            "RESERVATION_EXPIRED",
            recipient=rec.get("recipient", ""),
            fp=fp,
            body_sha256=rec.get("body_sha256", ""),
            body_chars=rec.get("body_chars", 0),
            shown_at=meta.get("shown_at", ""),
            approved_at=meta.get("ts", ""),
            approval_route=meta.get("route", "") or "word",
            channel=meta.get("channel", ""),
            session_id=rec.get("session_id", ""),
            tool=rec.get("tool", ""),
            send_result="unknown",
            reason=f"no PostToolUse outcome within {RESERVATION_TTL_SEC}s; "
                   f"ledgered so a retry cannot silently duplicate",
        )


def _drop_inflight(d: dict, fp: str) -> None:
    """End the "two guards, one call" free pass for this fingerprint.

    That window (INFLIGHT_TTL_SEC) exists for one reason: a second guard
    inspecting the SAME not-yet-dispatched call must not be charged twice. The
    moment the call is finished -- committed, released or expired -- there is no
    such call left to forgive, and leaving the key would let a byte-identical
    resend on the same tool sail past both the ledger and the approved set for
    the rest of the window. Dropping it here is what makes "one approval, one
    successful send" true for a retry inside 120 seconds as well.
    """
    d["inflight"] = {k: v for k, v in (d.get("inflight") or {}).items()
                     if not str(k).startswith(fp + "|")}


def _persist(d: dict) -> None:
    """Write, or clear the file when there is genuinely nothing left to keep."""
    if d.get("approved") or d.get("inflight") or d.get("reservations"):
        _write(d)
    else:
        _clear()


def reservations_for(session_id: str = "", tool: str = "") -> list:
    """Live reservations this session made with this tool, newest last.

    The PostToolUse hook has the same session_id and tool_name the PreToolUse
    gate had, and a reservation only exists between those two moments, so this
    pairing identifies the call without the hook having to re-derive the body
    from the tool input (and risk deriving it differently).

    Reaps expired reservations as a side effect, so the TTL applies even in a
    session that never sends again.
    """
    lockfh = _lock()
    try:
        d = _read()
        if d is None:
            return []
        dead = _expire_due(d, time.time())
        rows = [
            dict(rec, fp=fp)
            for fp, rec in (d.get("reservations") or {}).items()
            if (not session_id or rec.get("session_id") == session_id)
            and (not tool or rec.get("tool") == tool)
        ]
        _persist(d)
    finally:
        _unlock(lockfh)
    _finalise_expired(dead)
    rows.sort(key=lambda r: r.get("at", 0))
    return rows


def claim_reservation(recipient: str = "", body: str = "", guard: str = "",
                      session_id: str = "", tool: str = "") -> bool:
    """May a SECOND guard let this exact message through on the approval that
    gate 1 already spent for it? True only if gate 1 holds a live reservation
    for this exact (recipient, body) and this guard has not ridden it before.

    WHY THIS EXISTS (Sam, 2026-09-11). Sam's outbound gate is the primary lock.
    The MCP outbound guard used to be a second, independent lock demanding its
    own per-call owner approval id, and after the two-phase commit landed the
    two locks deadlocked: gate 1's consume() RESERVES the fingerprint, and
    consume() refuses a fingerprint that is already reserved (it is a second
    send of an approval still being spent). The proxy calls consume() under a
    different tool label, so it misses the "two guards, one call" in-flight
    window keyed on fp|tool, lands on the reservation branch, and mints a fresh
    approval id for a message Sam had already approved. Reproduced in a sandbox:
    mint, gate-1 reserve, then the proxy answers outbound_guard_approval_required.

    This does NOT grant anything. It reports that gate 1 already granted, and it
    cannot be the thing that turns an unapproved message into an approved one:

      * No live reservation for this fingerprint -> False. That covers an
        unapproved body, a one-byte-different body, the same body to a
        different recipient (all different fingerprints) and an approval that
        was never spent by gate 1 at all.
      * A reservation whose clock ran out is reaped by _expire_due() before the
        lookup, so it is ledgered as an unknown outcome and NOT claimable.
      * One claim per reservation per guard, recorded in the reservation itself
        under `guard_claims`. So the proxy rides a reservation once, not once
        per call for as long as the reservation lives, and "one approval, one
        send" survives unchanged.
      * The ledger still wins: a fingerprint that has already been sent is
        refused even if a reservation somehow lingers.

    commit() and release() both pop the whole reservation, so `guard_claims`
    dies with it. A retry after a downstream block therefore gets a fresh
    reservation off Sam's restored approval and a fresh claim, which is what
    makes one `ok` cover the retry.

    Nothing here is written to ~/.claude/state/outbound-approvals.json, and no
    approval is minted on any path.
    """
    if not guard:
        # An unnamed guard cannot be held to one claim, so it gets none.
        return False
    fp = fingerprint(recipient, body)
    if not fp:
        return False

    claimed = False
    rec = None
    lockfh = _lock()
    try:
        d = _read()
        if d is None:
            return False
        now = time.time()
        dead = _expire_due(d, now)
        res = (d.get("reservations") or {}).get(fp)
        if isinstance(res, dict) and not _ledger_has(fp):
            claims = res.get("guard_claims")
            if not isinstance(claims, dict):
                claims = {}
            if guard not in claims:
                claims[guard] = now
                res["guard_claims"] = claims
                d["reservations"][fp] = res
                claimed = True
                rec = res
        _persist(d)
    finally:
        _unlock(lockfh)
    _finalise_expired(dead)

    if claimed:
        meta = rec.get("meta") if isinstance(rec.get("meta"), dict) else {}
        _consent_audit(
            "RESERVATION_CLAIMED",
            recipient=rec.get("recipient", ""),
            fp=fp,
            body_sha256=rec.get("body_sha256", ""),
            body_chars=rec.get("body_chars", 0),
            shown_at=meta.get("shown_at", ""),
            approved_at=meta.get("ts", ""),
            approval_route=meta.get("route", "") or "word",
            channel=meta.get("channel", ""),
            session_id=rec.get("session_id", "") or session_id,
            tool=rec.get("tool", "") or tool,
            send_result="pending",
            reason=f"second guard {guard} rode the reservation gate 1 already "
                   f"spent for this exact (recipient, body); no new approval minted",
        )
    return claimed


def commit(fp: str, session_id: str = "", tool: str = "", result: str = "ok") -> bool:
    """Phase two, success: the tool ran, so the approval is really spent.

    This is where the ledger row, the queue drain and the AUTHORIZED evidence
    line now happen -- everything consume() used to do on the attempt. True
    when a live reservation was found and closed; False when there was none
    (already committed, released, or expired), and False is never an error: it
    only means this outcome has nothing left to close.
    """
    if not fp:
        return False
    lockfh = _lock()
    try:
        d = _read()
        if d is None:
            return False
        dead = _expire_due(d, time.time())
        rec = (d.get("reservations") or {}).pop(fp, None)
        if isinstance(rec, dict):
            _drop_inflight(d, fp)
        _persist(d)
    finally:
        _unlock(lockfh)
    _finalise_expired(dead)
    if not isinstance(rec, dict):
        return False
    meta = rec.get("meta") if isinstance(rec.get("meta"), dict) else {}
    recipient = rec.get("recipient", "")
    if not _ledger_has(fp):
        _ledger_append(fp, recipient, rec.get("tool", "") or tool,
                       rec.get("session_id", "") or session_id)
    _drain_pending(fp)
    _consent_audit(
        "AUTHORIZED",
        recipient=recipient,
        fp=fp,
        body_sha256=rec.get("body_sha256", ""),
        body_chars=rec.get("body_chars", 0),
        shown_at=meta.get("shown_at", ""),
        approved_at=meta.get("ts", ""),
        approval_route=meta.get("route", "") or "word",
        channel=meta.get("channel", ""),
        session_id=rec.get("session_id", "") or session_id,
        tool=rec.get("tool", "") or tool,
        send_result=result or "ok",
        reason="post-tool outcome: the send ran",
    )
    return True


def release(fp: str, session_id: str = "", tool: str = "", reason: str = "") -> bool:
    """Phase two, failure: nothing went out, so Sam's approval stands.

    The approval goes back into `approved` with its ORIGINAL timestamp and TTL.
    A release is not a re-approval and must not extend his clock: if the window
    has already passed, the restored entry is dead on arrival and consume()
    refuses it exactly as it would have.

    The in-flight free pass for this fingerprint is dropped at the same time.
    Leaving it would let the retry sail past the approved-set check on the
    120-second window instead of properly spending the restored approval, which
    would put the approval right back in the state this fix exists to prevent:
    live, unspent, with a send already gone.
    """
    if not fp:
        return False
    lockfh = _lock()
    try:
        d = _read()
        if d is None:
            return False
        now = time.time()
        dead = _expire_due(d, now)
        rec = (d.get("reservations") or {}).pop(fp, None)
        restored = False
        if isinstance(rec, dict) and not _ledger_has(fp):
            meta = rec.get("meta") if isinstance(rec.get("meta"), dict) else None
            if isinstance(meta, dict):
                approved = dict(d.get("approved") or {})
                approved[fp] = meta
                d["approved"] = approved
                _drop_inflight(d, fp)
                restored = True
        _persist(d)
    finally:
        _unlock(lockfh)
    _finalise_expired(dead)
    if not isinstance(rec, dict):
        return False
    meta = rec.get("meta") if isinstance(rec.get("meta"), dict) else {}
    _consent_audit(
        "RELEASED",
        recipient=rec.get("recipient", ""),
        fp=fp,
        body_sha256=rec.get("body_sha256", ""),
        body_chars=rec.get("body_chars", 0),
        shown_at=meta.get("shown_at", ""),
        approved_at=meta.get("ts", ""),
        approval_route=meta.get("route", "") or "word",
        channel=meta.get("channel", ""),
        session_id=rec.get("session_id", "") or session_id,
        tool=rec.get("tool", "") or tool,
        send_result="blocked",
        reason=(reason or "post-tool outcome: the send did not happen")[:200],
    )
    return restored


def mint(fingerprints: dict[str, dict] | list[str] | set[str], ttl: int) -> dict:
    """Door `ok` (of de nieuwe wrapper eromheen) aangeroepen. Vervangt de hele
    goedgekeurde set — niet optellen bij wat er stond, zelfde semantiek als de
    oude count-based mint.

    `fingerprints` is either a dict {fp: meta} (meta may carry a human-readable
    "recipient"/"preview" for the confirmation Sam sees) or a plain iterable of
    fingerprints, in which case meta is empty. Returns the approved dict that
    was written, so a caller can print it back to Sam for a last visual check
    against what he read."""
    if isinstance(fingerprints, dict):
        approved = {
            fp: {
                "ts": int(time.time()),
                "recipient": (meta or {}).get("recipient", ""),
                "preview": (meta or {}).get("preview", ""),
                # Consent evidence, carried through to the audit line at spend
                # time. `shown_at` is when the body was written to the pending
                # queue, which is before it was printed to Sam, so it dates the
                # moment he was shown this exact text. `route` is how he said
                # yes. Neither is used to decide anything -- the fingerprint
                # does that -- they exist so the send can be PROVEN afterwards.
                "shown_at": (meta or {}).get("shown_at", ""),
                "route": (meta or {}).get("route", ""),
                "channel": (meta or {}).get("channel", ""),
            }
            for fp, meta in fingerprints.items()
        }
    else:
        approved = {
            fp: {"ts": int(time.time()), "recipient": "", "preview": ""}
            for fp in fingerprints
        }
    # Each approval carries its own clock. Before 2026-09-05 this wrote the
    # approved set wholesale and consume() judged everything against one batch
    # clock, so on a machine running many sessions at once (11 pending queues is
    # normal here) one session's `ok` silently erased another's approvals. Sam
    # approved three emails and a parallel session's WhatsApp approval wiped all
    # three seconds later; consume() then refused them with no explanation. A
    # gate that says no to the approved case is the kind operators route around.
    # Merging is not a loosening: every entry is still bound to one exact
    # (recipient, body), still spent once, still ledgered forever.
    now = int(time.time())
    for meta in approved.values():
        meta["ttl"] = int(ttl)
    lockfh = _lock()
    try:
        d = _read() or {}
        kept = {}
        for fp, meta in (d.get("approved") or {}).items():
            if not isinstance(meta, dict):
                continue
            age = now - int(meta.get("ts", 0))
            if age <= int(meta.get("ttl", d.get("ttl", 0))):
                kept[fp] = meta
        kept.update(approved)
        # `reservations` is carried across verbatim. A mint replaces the
        # APPROVED set; it has no business finishing or forgetting a send that
        # is in flight, and dropping the key here would silently un-spend one.
        _write({
            "minted": now,
            "ttl": int(ttl),
            "approved": kept,
            "inflight": d.get("inflight") or {},
            "reservations": d.get("reservations") if isinstance(d.get("reservations"), dict) else {},
        })
    finally:
        _unlock(lockfh)
    # Only what THIS call approved: `ok` asserts the returned set equals the
    # fingerprints it selected, and must not see a sibling session's entries.
    return approved


def peek() -> tuple[int, int]:
    """(aantal goedgekeurde berichten, seconden geldig). (0, 0) als er niets is."""
    d = _read()
    if not d:
        return (0, 0)
    now = time.time()
    live = []
    for meta in (d.get("approved") or {}).values():
        if not isinstance(meta, dict):
            continue
        left = int(meta.get("ttl", d.get("ttl", 0))) - int(now - int(meta.get("ts", 0)))
        if left > 0:
            live.append(left)
    if not live:
        return (0, 0)
    return (len(live), max(live))


def consume(recipient: str = "", body: str = "", session_id: str = "", tool: str = "") -> bool:
    """True als DIT specifieke bericht (deze ontvanger, deze tekst) mag.

    Volgorde, met een bestandslock zodat twee echte gelijktijdige processen niet
    allebei kunnen winnen:
      1. In-flight venster (fingerprint + tool, 120s): dezelfde nog-niet-verzonden
         oproep die een tweede wachter ziet, gratis door.
      2. Permanent ledger: dit exacte bericht is ooit al goedgekeurd om te
         verzenden. Geweigerd, punt uit — ook binnen het in-flight venster als tool
         of sessie afwijkt, en altijd buiten dat venster. Zo laat een onduidelijke
         verzenduitkomst een retry weigeren in plaats van stilzwijgend dupliceren.
      2b. Lopende reservering: deze afdruk wordt op dit moment al verzonden door
         een andere tool of een andere sessie. Geweigerd; het in-flight venster
         hierboven heeft de "twee wachters, één aanroep"-uitzondering al gehad.
      3. Goedgekeurde set uit mint(): bestaat de fingerprint daar en is de batch
         nog niet verlopen, dan wint deze aanroep — de fingerprint wordt verwijderd
         (eenmalig), als RESERVERING vastgelegd, en het in-flight venster wordt
         gezet zodat een tweede wachter op DEZELFDE aanroep gratis door mag.

    Sinds 11 september 2026 schrijft deze functie NIET meer naar de ledger en
    leegt zij de wachtrij niet. Dat gebeurt in commit(), na de tool-call, omdat
    alleen daar bekend is of er echt iets is verstuurd. Wat hier wordt
    goedgekeurd is onveranderd.
    """
    fp = fingerprint(recipient, body)
    key = f"{fp}|{tool or ''}"

    lockfh = _lock()
    try:
        d = _read()
        if d is None:
            # Geen canonieke toestand: val terug op het losse eenmalige kaartje,
            # ONGEWIJZIGD — Sam's `! ok` noodrem buiten het model om.
            try:
                st = os.stat(LEGACY_SINGLE)
            except OSError:
                return False
            if time.time() - st.st_mtime > LEGACY_SINGLE_TTL:
                return False
            try:
                os.remove(LEGACY_SINGLE)
            except OSError:
                pass
            # Recorded as its own route precisely because it is WEAKER evidence:
            # the bare token binds to nothing -- not to this recipient and not
            # to this text -- so a line with approval_route=legacy-token proves
            # only that someone with shell access allowed *a* send within 120s.
            # It is kept for sends that cannot go through a humanizer pass, and
            # it is auditable as the exception it is.
            _consent_audit(
                "AUTHORIZED",
                recipient=recipient,
                body=body,
                fp=fp,
                approval_route="legacy-token",
                session_id=session_id,
                tool=tool,
                send_result="authorized",
                reason="no canonical guard state; bare token path",
            )
            return True

        now = time.time()
        # Finalised while the lock is held: none of these touch this lock, and
        # consume() returns from a dozen places, so deferring them past the
        # unlock would mean a reap that silently never happens on most paths.
        _finalise_expired(_expire_due(d, now))
        inflight = {k: v for k, v in (d.get("inflight") or {}).items()
                    if now - v < INFLIGHT_TTL_SEC}

        if key in inflight:
            d["inflight"] = inflight
            _write(d)
            return True

        if _ledger_has(fp):
            # Verzonden is verzonden. Geen vers "approved" item redt dit meer.
            d["inflight"] = inflight
            _write(d)
            return False

        if fp in (d.get("reservations") or {}):
            # Reserved by another tool or another guard in this same cycle, and
            # the in-flight test above already gave the same-call case its free
            # pass. Anything else asking for a reserved fingerprint is a second
            # send of an approval that is still being spent. Refuse.
            d["inflight"] = inflight
            _write(d)
            return False

        approved = dict(d.get("approved") or {})
        meta = approved.get(fp)
        if not isinstance(meta, dict):
            d["inflight"] = inflight
            _write(d)
            return False

        # This approval's own clock, not the batch's. A later mint by another
        # session refreshes "minted" and must not extend or expire this entry.
        if now - int(meta.get("ts", 0)) > int(meta.get("ttl", d.get("ttl", 0))):
            del approved[fp]
            d["approved"] = approved
            d["inflight"] = inflight
            _write(d)
            return False

        # Winnaar: eenmalig RESERVEREN, in-flight zetten voor de tweede wachter
        # op dezelfde aanroep. De ledger-regel, het legen van de wachtrij en de
        # AUTHORIZED-bewijsregel verhuizen naar commit(), want die weet pas of
        # de send echt is gebeurd. Zie RESERVATION_TTL_SEC bovenaan.
        del approved[fp]
        inflight[key] = now
        reservations = dict(d.get("reservations") or {})
        reservations[fp] = {
            "at": now,
            "recipient": (recipient or "")[:200],
            "tool": (tool or "")[:120],
            "session_id": (session_id or "")[:120],
            # Which text this was, without keeping the text. The AUTHORIZED
            # line used to carry body_sha256 because consume() had the body in
            # hand; commit() does not, so the digest is carried instead. A hash
            # is the evidence; the body on disk would only be a second copy of
            # something already queued and already approved.
            "body_sha256": hashlib.sha256((body or "").encode("utf-8", "replace")).hexdigest(),
            "body_chars": len(body or ""),
            "meta": meta,
        }
        d["approved"] = approved
        d["inflight"] = inflight
        d["reservations"] = reservations
        # 2026-09-09: used to _clear() the whole state file whenever `approved`
        # emptied out here, which also discarded the `inflight` entry just set
        # above for THIS message -- the exact record the mcp-proxy twin (Node
        # outbound-guard.mjs) needs to read within its own consume() to grant
        # the same approval for the same PreToolUse cycle. That silently made
        # every proxied send (Slack/WhatsApp/etc via mcp-proxy) fail closed
        # whenever this was the last outstanding approval. Clear only when
        # there is truly nothing left to preserve.
        _persist(d)
        # THE EVIDENCE LINE for phase one. This is still the single choke point
        # where a body-bound approval leaves the approved set, so it is the only
        # place that can honestly assert "Sam saw this exact body and approved
        # this send". What it no longer asserts is that the send happened --
        # that claim belongs to commit(), which is the only thing that can know
        # it. RESERVED, AUTHORIZED and RELEASED on one fingerprint therefore
        # read as the true story of one attempt.
        _consent_audit(
            "RESERVED",
            recipient=recipient,
            body=body,
            fp=fp,
            shown_at=meta.get("shown_at", ""),
            approved_at=meta.get("ts", ""),
            approval_route=meta.get("route", "") or "word",
            channel=meta.get("channel", ""),
            session_id=session_id,
            tool=tool,
            send_result="reserved",
            reason=f"pre-tool reservation, {RESERVATION_TTL_SEC}s to a post-tool outcome",
        )
        return True
    finally:
        _unlock(lockfh)


if __name__ == "__main__":
    import sys

    cmd = sys.argv[1] if len(sys.argv) > 1 else "peek"

    if cmd == "mint":
        # New shape: `mint <ttl>`, JSON list of {"recipient":..., "body":...} on
        # stdin. Deliberately NOT the old `mint <n> <ttl>` shape: that call
        # cannot express which message is being approved, which is the whole
        # defect this rewrite closes. Detect and refuse the old shape loudly and
        # immediately (no stdin read attempted) so a stale caller (the current
        # ~/.local/bin/ok) fails fast instead of hanging on a JSON read that
        # will never come from an interactive shell.
        if len(sys.argv) == 4 and sys.argv[2].isdigit() and sys.argv[3].isdigit():
            sys.stderr.write(
                "outbound_guard mint: the old `mint <n> <ttl>` count-based call is "
                "retired. Approval must now be bound to the exact (recipient, body) "
                "being sent. Update the caller to:\n"
                "  mint <ttl_seconds>   with a JSON list on stdin:\n"
                '  [{"recipient": "...", "body": "..."}]\n'
                "~/.local/bin/ok and ~/.claude/mcp-proxy/outbound-guard.mjs still use "
                "the old shape and need a companion update before this file is "
                "installed.\n"
            )
            sys.exit(2)
        if len(sys.argv) < 3:
            sys.stderr.write("usage: outbound_guard.py mint <ttl_seconds>  (JSON list on stdin)\n")
            sys.exit(2)
        ttl = int(sys.argv[2])
        try:
            pairs = json.load(sys.stdin)
        except json.JSONDecodeError as e:
            sys.stderr.write(f"outbound_guard mint: invalid JSON on stdin: {e}\n")
            sys.exit(2)
        if not isinstance(pairs, list) or not pairs:
            sys.stderr.write("outbound_guard mint: expected a non-empty JSON list on stdin\n")
            sys.exit(2)
        fps = {}
        for p in pairs:
            if not isinstance(p, dict):
                continue
            r = p.get("recipient", "")
            b = p.get("body", "")
            fp = fingerprint(r, b)
            fps[fp] = {"recipient": str(r)[:200], "preview": str(b)[:200]}
        approved = mint(fps, ttl)
        print(f"minted {len(approved)} fingerprint(s) ttl={ttl}s")
        for fp, meta in approved.items():
            print(f"  {fp} -> to={meta['recipient']!r} body[:60]={meta['preview'][:60]!r}")
    elif cmd == "consume":
        recipient = sys.argv[2] if len(sys.argv) > 2 else ""
        body = sys.argv[3] if len(sys.argv) > 3 else ""
        tool = sys.argv[4] if len(sys.argv) > 4 else ""
        session_id = sys.argv[5] if len(sys.argv) > 5 else (os.environ.get("CLAUDE_CODE_SESSION_ID") or "")
        ok = consume(recipient, body, session_id=session_id, tool=tool)
        print("allow" if ok else "deny", *peek())
        sys.exit(0 if ok else 1)
    elif cmd in ("commit", "release"):
        # Phase two. `fp` first so a caller that already knows the fingerprint
        # never has to hand the body to another process.
        fp = sys.argv[2] if len(sys.argv) > 2 else ""
        tool = sys.argv[3] if len(sys.argv) > 3 else ""
        session_id = sys.argv[4] if len(sys.argv) > 4 else (os.environ.get("CLAUDE_CODE_SESSION_ID") or "")
        reason = sys.argv[5] if len(sys.argv) > 5 else ""
        if cmd == "commit":
            done = commit(fp, session_id=session_id, tool=tool)
        else:
            done = release(fp, session_id=session_id, tool=tool, reason=reason)
        print(f"{cmd} {'done' if done else 'nothing-to-do'} {fp}")
        sys.exit(0 if done else 1)
    elif cmd == "reservations":
        tool = sys.argv[2] if len(sys.argv) > 2 else ""
        session_id = sys.argv[3] if len(sys.argv) > 3 else ""
        for row in reservations_for(session_id=session_id, tool=tool):
            print(json.dumps({k: v for k, v in row.items() if k != "meta"}))
    else:
        r, t = peek()
        print(f"approved={r} valid_for={t}s")
