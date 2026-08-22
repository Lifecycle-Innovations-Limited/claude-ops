#!/usr/bin/env bash
# SessionStart: point Claude at ops-rules without dumping the full text.
set -euo pipefail
python3 - <<'PY'
import json
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": (
            "Follow the ops-rules skill for every ops command. "
            "Public repo: no personal data. Outbound: one draft, one approval, one send. "
            "If AskUserQuestion or Workflow are missing, use Rule 10 in ops-rules."
        ),
    },
    "suppressOutput": True,
}))
PY
