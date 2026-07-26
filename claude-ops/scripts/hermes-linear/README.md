# Hermes Paperclip↔Linear bridge (tracked copy)

Runtime install path on the US-East dev box:

```
~/.hermes/scripts/linear_paperclip_delegate_bridge.py
~/.hermes/scripts/paperclip_linear_mirror.py
```

Cron:

- `linear-paperclip-full-sync` → delegate bridge (create + status + comments)
- `paperclip-linear-mirror` → status mirror for linked pairs

## 2026-07-26 create-guard + terminal skip

Problem: outbound Paperclip→Linear `issueCreate` minted a new Linear issue for every
unlinked Paperclip row, even when an open Linear sibling already covered the same
work (same `paperclip:{id}`, same `[Paperclip HEA-n]` title, or same cleaned title
fingerprint). Status mirror could also push open PC status onto Linear issues already
in Duplicate/Canceled/Production.

Guards (minimal):

1. **`find_open_linear_sibling`** in `linear_paperclip_delegate_bridge.py`
   - Before `issueCreate`, search open Linear issues on the target team.
   - Match order: `paperclip:{pc}` in description → `[Paperclip {pc}]` in title →
     cleaned title fingerprint (min length 20).
   - On hit: write `linear:` markers back to Paperclip, comment both sides, **skip create**.

2. **Terminal skip** in `paperclip_linear_mirror.py`
   - If Linear state type is completed/canceled/duplicate (or name Duplicate/Canceled/Production/Done),
     do not push open PC status onto it.

### Deploy

```bash
cp claude-ops/scripts/hermes-linear/linear_paperclip_delegate_bridge.py ~/.hermes/scripts/
cp claude-ops/scripts/hermes-linear/paperclip_linear_mirror.py ~/.hermes/scripts/
python3 -m py_compile ~/.hermes/scripts/linear_paperclip_delegate_bridge.py
python3 -m py_compile ~/.hermes/scripts/paperclip_linear_mirror.py
# dry-run once
python3 ~/.hermes/scripts/linear_paperclip_delegate_bridge.py --dry-run --max-create 5
```

Does not cancel intentional distinct mirrors with different semantics.
