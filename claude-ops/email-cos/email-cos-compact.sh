#!/usr/bin/env bash
# email-cos-compact.sh — weekly log/ledger compaction to keep state files small.
set -euo pipefail
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$_SCRIPT_DIR/lib/config.sh"

SD="$EMAIL_COS_STATE_DIR"
PS="$EMAIL_COS_POCKET_STATE_DIR"

python3 - <<PY
import json, pathlib, collections
SD = pathlib.Path("$SD")
PS = pathlib.Path("$PS")

# Cap line-ledgers to last 2000 lines.
for f in ("seen_sweep.txt", "approve-seen.txt", "metrics.jsonl"):
    p = SD / f
    if p.exists():
        lines = p.read_text().splitlines()
        if len(lines) > 2000:
            p.write_text("\n".join(lines[-2000:]) + "\n")

# Dedup sent.ledger.
sl = SD / "sent.ledger"
if sl.exists():
    sl.write_text("\n".join(sorted(set(sl.read_text().split()))) + "\n")

# Drop resolved ASKs from review.jsonl (resolved are terminal).
rv = PS / "review.jsonl"
rs = PS / "approval-resolved.jsonl"
if rv.exists() and rs.exists():
    resolved = {json.loads(l)["id"] for l in rs.read_text().splitlines() if l.strip()}
    keep = [l for l in rv.read_text().splitlines()
            if l.strip() and (json.loads(l).get("id") not in resolved)]
    rv.write_text("\n".join(keep) + ("\n" if keep else ""))
    print("review kept", len(keep))
PY
