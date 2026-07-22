# PII audit — public claude-ops repo (2026-07-22)

Owner rule: no owner-specific data in this public repo. This tracks what was found, what
this branch scrubbed, and what remains for a dedicated follow-up pass.

## Scrubbed on this branch (`chore/scrub-pii-to-local-prefs`)

Highest-sensitivity: real people + real phone + a real WhatsApp JID, all in
`skills/ops-inbox/SKILL.md` example / standing-rule prose (illustrative only — safe to
genericize, no logic depends on the literals):

- Real contact names in dedup examples (Robert, Brittany, Twan, Dennis, JD) → generic
  `<contact>` / `<contact-A>` / `<contact-B>`.
- Real phone number `31642218102` → `<number>`.
- Real deal/issue references (Betaalronde, Centurion, Ian comp, `AUR-880`, `AUR-696`,
  `AUR-1004`, `AUR-920`, `SFB-172`) in the Paperclip SSOT example → generic wording
  ("resolve counterparty→issue mappings from your local prefs/board").
- LID format example `218030407741450@lid` in `scripts/whatsapp/apply-patches.py`
  docstring → `100000000000000@lid`.

Mechanism added:
- `~/.claude/ops-prefs.json` (OUTSIDE the repo, gitignored by location) — central prefs
  holding the real owner/company/issue-prefix/channel values.
- `.gitignore` now blocks `ops.local.json`, `*.local.json`, `.ops-prefs.json`.
- `docs/LOCAL-PREFS.md` documents the pattern.

## Remaining — follow-up pass (NOT done here; needs care/review)

Raw grep counts (many are already example placeholders like `a[at]x[.]com`,
`123[at]s.whatsapp[.]net`, `<...>` — real count is much lower):

| Category | Raw hits | Real (est.) | Notes |
|---|---|---|---|
| `Healify` company name | 149 | ~load-bearing | Integration target across Slack scoping, dashboards, skills. Genericizing to a config-driven company key is a real refactor — do not blind-scrub. |
| Emails | 155 | ~4 real | `info[at]lifecycleinnovations[.]limited` ×5, `support[at]healify[.]ai` ×3, `deeksha[at]browserstack[.]com` ×1; rest are examples. |
| WhatsApp JIDs | 79 | ~0 real left | Overwhelmingly format examples. |
| Issue keys AUR/HEA/SFB/HFT | 15 | ~11 | `HEA-4045/4047/4049/4246`, `SFB-172`, `AUR-*` — traceability comments in credit-rotation code + CHANGELOG. Low-harm, numerous. |
| Phone E.164 | 7 | 1 (scrubbed) | Rest are `123456…` examples. |
| `Aurora` | 4 | 0 | All AWS RDS **Aurora**, not the company — false positive. |
| `Vinites` | 1 | scrubbed | — |

### Recommended follow-up
1. **Issue keys** (`HEA-####`, `SFB-172`, `AUR-*`) in code comments + CHANGELOG →
   drop the ticket refs or replace with `<ISSUE>`; mechanical, low-risk, ~11 spots.
2. **Real emails** (`info[at]lifecycleinnovations[.]limited`, `support[at]healify[.]ai`,
   `deeksha[at]browserstack[.]com`) → placeholders / read from prefs; ~9 spots.
3. **`Healify` (×149)** → a real refactor: introduce a company-key indirection
   (`<company>` in prose; runtime value from `~/.claude/ops-prefs.json`), keeping the
   Healify-specific Slack/dashboard integration working. Do as its own reviewed PR.

Nothing here is pushed. Branch: `chore/scrub-pii-to-local-prefs`.
