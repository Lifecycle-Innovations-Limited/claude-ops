#!/usr/bin/env bash
#
# gog-reply.sh — account-safe Gmail reply helper for the `gog` CLI.
#
# THE BUG THIS PREVENTS
# ---------------------
# A Gmail reply via `gog gmail send --reply-to-message-id <ID>` 404s when the
# message-ID was scanned from one account (e.g. user@example.com) but the
# send defaults to a DIFFERENT account (e.g. user@example.com): the same thread
# carries different message/thread IDs per account.
#
# Worse: EVERY `gog gmail send` attempt — even one that 404s or trips a bad flag
# combo — fires the outbound-comms approval hook and CONSUMES the single-use
# /tmp/.claude-send-ok token, forcing the user to re-approve on each failure.
#
# This helper RESOLVES the correct account + reply-to message-id with read-only
# calls FIRST, and only ever issues EXACTLY ONE `gog gmail send` — after
# resolution succeeds — so a token is never wasted on a doomed send. It also
# never passes both --reply-to-message-id and --thread-id (gog rejects that).
#
# USAGE
# -----
#   gog-reply.sh --to <email> --body <text> [--subject <subj>]
#                [--match-from <email>] [--match-subject <text>]
#                [--account <acct>] [--dry-run]
#
# EXIT CODES
# ----------
#   0  sent (or printed in --dry-run)
#   2  bad/missing arguments
#   3  no matching thread resolvable (NO send attempted — token-saving invariant)
#   4  ambiguous match across multiple accounts (pin with --account; NO send)
#   5  the single send call failed
#
set -euo pipefail

PROG="$(basename "$0")"

err() { printf '%s: %s\n' "$PROG" "$*" >&2; }

usage() {
  cat >&2 <<EOF
$PROG — account-safe Gmail reply via gog (resolves account + reply-to id first,
then issues EXACTLY ONE send so a doomed attempt never burns the approval token).

Usage:
  $PROG --to <email> --body <text> [--subject <subj>]
        [--match-from <email>] [--match-subject <text>]
        [--account <acct>] [--dry-run]

Flags:
  --to <email>            Recipient (required).
  --body <text>          Reply body, plain text (required).
  --subject <subj>       Subject. If omitted, derived as "Re: <original subject>".
  --match-from <email>   From-address used to find the thread. Defaults to --to.
  --match-subject <text> Substring to disambiguate the thread (optional).
  --account <acct>       Pin a gog account. If omitted, auto-discover.
  --dry-run              Resolve and print account/thread/msg-id/to/subject/body;
                         exit 0 without sending.
  -h, --help             This help.

Exit codes: 0 ok · 2 bad args · 3 no match (no send) · 4 ambiguous (no send) · 5 send failed
EOF
}

# ---- arg parsing -----------------------------------------------------------
TO="" BODY="" SUBJECT="" MATCH_FROM="" MATCH_SUBJECT="" ACCOUNT="" DRY=0
SUBJECT_SET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --to)            TO="${2:-}"; shift 2 ;;
    --body)          BODY="${2:-}"; shift 2 ;;
    --subject)       SUBJECT="${2:-}"; SUBJECT_SET=1; shift 2 ;;
    --match-from)    MATCH_FROM="${2:-}"; shift 2 ;;
    --match-subject) MATCH_SUBJECT="${2:-}"; shift 2 ;;
    --account)       ACCOUNT="${2:-}"; shift 2 ;;
    --dry-run|-n)    DRY=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) err "unknown argument: $1"; usage; exit 2 ;;
  esac
done

[ -n "$TO" ]   || { err "--to is required";   usage; exit 2; }
[ -n "$BODY" ] || { err "--body is required"; usage; exit 2; }
[ -n "$MATCH_FROM" ] || MATCH_FROM="$TO"

command -v gog >/dev/null 2>&1     || { err "gog not found on PATH"; exit 2; }
command -v python3 >/dev/null 2>&1 || { err "python3 not found on PATH"; exit 2; }

# ---- candidate accounts ----------------------------------------------------
# Auto-discover gmail-capable oauth accounts from `gog auth list -j`, always
# also probing the two known mailboxes for this box. If --account is pinned we
# use only that one.
discover_accounts() {
  if [ -n "$ACCOUNT" ]; then
    printf '%s\n' "$ACCOUNT"
    return 0
  fi
  gog auth list -j 2>/dev/null | python3 -c '
import sys, json
seen, out = set(), []
try:
    d = json.load(sys.stdin)
    for a in (d.get("accounts") or []):
        email = a.get("email")
        if not email:
            continue
        svcs = a.get("services") or []
        # Only oauth mailboxes can read/send Gmail; skip pure service-accounts.
        if a.get("auth") == "oauth" or "gmail" in svcs:
            if email not in seen:
                seen.add(email); out.append(email)
except Exception:
    pass
# Always try the two known mailboxes on this box.
for e in ("user@example.com", "user@example.com"):
    if e not in seen:
        seen.add(e); out.append(e)
print("\n".join(out))
' 2>/dev/null
}

# ---- resolution ------------------------------------------------------------
# For each candidate account, search for the most-recent matching thread.
# Echoes "account<TAB>threadId<TAB>origSubject" for the best match per account.
build_query() {
  local q="from:${MATCH_FROM}"
  if [ -n "$MATCH_SUBJECT" ]; then
    q="$q subject:(${MATCH_SUBJECT})"
  fi
  printf '%s' "$q"
}

search_account() {
  # $1 = account ; prints "threadId<TAB>subject" of most recent match, or nothing
  local acct="$1" query
  query="$(build_query)"
  gog gmail search -a "$acct" "$query" --max 5 -j --results-only --no-input 2>/dev/null \
    | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
# search --results-only returns a flat array of thread summaries.
rows = d if isinstance(d, list) else (d.get("results") or d.get("messages") or [])
if not isinstance(rows, list) or not rows:
    sys.exit(0)
# Most recent first; results already date-desc, but sort defensively by date.
def keyf(r): return r.get("date","") or ""
rows = sorted(rows, key=keyf, reverse=True)
top = rows[0]
tid = top.get("id") or top.get("threadId") or ""
subj = top.get("subject") or ""
if tid:
    sys.stdout.write(tid + "\t" + subj)
'
}

# Resolve the LAST message id + subject within a thread for the given account.
resolve_msg_id() {
  # $1 = account ; $2 = threadId ; prints "msgId<TAB>subject" or nothing
  local acct="$1" tid="$2"
  gog gmail thread get -a "$acct" "$tid" -j 2>/dev/null \
    | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
# thread get nests messages under .thread.messages[]; tolerate a flat shape too.
t = d.get("thread", d) if isinstance(d, dict) else d
msgs = t.get("messages") if isinstance(t, dict) else None
if not isinstance(msgs, list) or not msgs:
    sys.exit(0)
last = msgs[-1]
mid = last.get("id") or ""
subj = ""
payload = last.get("payload") or {}
for h in (payload.get("headers") or []):
    if str(h.get("name","")).lower() == "subject":
        subj = h.get("value","") or ""
        break
if mid:
    sys.stdout.write(mid + "\t" + subj)
'
}

MATCHES=()   # each entry: account<TAB>threadId<TAB>msgId<TAB>origSubject

while IFS= read -r acct; do
  [ -n "$acct" ] || continue
  res="$(search_account "$acct" || true)"
  [ -n "$res" ] || continue
  tid="${res%%$'\t'*}"
  [ -n "$tid" ] || continue
  mres="$(resolve_msg_id "$acct" "$tid" || true)"
  [ -n "$mres" ] || continue
  mid="${mres%%$'\t'*}"
  msubj="${mres#*$'\t'}"
  [ -n "$mid" ] || continue
  MATCHES+=("${acct}"$'\t'"${tid}"$'\t'"${mid}"$'\t'"${msubj}")
done < <(discover_accounts)

if [ "${#MATCHES[@]}" -eq 0 ]; then
  err "no matching thread found for from:${MATCH_FROM}${MATCH_SUBJECT:+ subject:(${MATCH_SUBJECT})} on any account — NOT sending (token preserved)"
  exit 3
fi

if [ "${#MATCHES[@]}" -gt 1 ] && [ -z "$ACCOUNT" ]; then
  err "ambiguous: thread matched on multiple accounts — pin one with --account. Candidates:"
  for m in "${MATCHES[@]}"; do
    a="${m%%$'\t'*}"; err "  - ${a}"
  done
  err "NOT sending (token preserved)"
  exit 4
fi

# Single resolved match.
SEL="${MATCHES[0]}"
R_ACCT="${SEL%%$'\t'*}"; rest="${SEL#*$'\t'}"
R_TID="${rest%%$'\t'*}"; rest="${rest#*$'\t'}"
R_MID="${rest%%$'\t'*}"
R_ORIG_SUBJ="${rest#*$'\t'}"

# Derive subject if not provided.
if [ "$SUBJECT_SET" -eq 0 ]; then
  base="$R_ORIG_SUBJ"
  case "$base" in
    [Rr][Ee]:*) SUBJECT="$base" ;;
    "")          SUBJECT="Re:" ;;
    *)           SUBJECT="Re: $base" ;;
  esac
fi

if [ "$DRY" -eq 1 ]; then
  cat <<EOF
[dry-run] resolved reply target (no send):
  account     : $R_ACCT
  threadId    : $R_TID
  reply-to-id : $R_MID
  to          : $TO
  subject     : $SUBJECT
  body        : $BODY
EOF
  exit 0
fi

# ---- the EXACTLY-ONE send call --------------------------------------------
# Never pass both --reply-to-message-id and --thread-id (gog rejects the combo).
if gog gmail send -a "$R_ACCT" \
     --to "$TO" \
     --subject "$SUBJECT" \
     --body "$BODY" \
     --reply-to-message-id "$R_MID" \
     --no-input -y; then
  err "sent via ${R_ACCT} (thread ${R_TID}, in-reply-to ${R_MID})"
  exit 0
else
  rc=$?
  err "send failed (gog exit $rc) via ${R_ACCT}"
  exit 5
fi
