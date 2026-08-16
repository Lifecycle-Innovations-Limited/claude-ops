# PII audit — public claude-ops repo (2026-07-22)

Owner rule: no owner-specific data in this public repo. This tracks what was found, what
this branch scrubbed, and what remains for a dedicated follow-up pass.

## Scrubbed on this branch (`chore/scrub-pii-to-local-prefs`)

Highest-sensitivity: real people + a real phone number + a real WhatsApp JID, all in
`skills/ops-inbox/SKILL.md` example / standing-rule prose (illustrative only — safe to
genericize, no logic depended on the literals):

> **This section deliberately does not quote what it removed.** An audit that
> reprints the phone number, JID, and contact names it scrubbed leaves the repo
> exactly as exposed as before, just with the data moved to a different file.
> The original version of this document did precisely that; see "Round 3" below.
> Describe the *class* of value removed, never the value.

- Five real contact first names in dedup examples → generic `<contact>` /
  `<contact-A>` / `<contact-B>`.
- One real E.164 phone number → `<number>`.
- Real deal and issue references in the task-tracker example (four internal issue
  keys plus three counterparty/deal code names) → generic wording
  ("resolve counterparty→issue mappings from your local prefs/board").
- A real WhatsApp LID used as a format example in a script docstring → a
  synthetic all-zeros LID.

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
| Emails | 155 | ~4 real | The public maintainer contact ×5, a product support alias ×3, one vendor contact ×1; rest are examples. |
| WhatsApp JIDs | 79 | ~0 real left | Overwhelmingly format examples. |
| Issue keys | 15 | ~11 | Internal tracker keys in traceability comments in credit-rotation code + CHANGELOG. Low-harm, numerous. |
| Phone E.164 | 7 | 1 (scrubbed) | Rest are `123456…` examples. |
| `Aurora` | 4 | 0 | All AWS RDS **Aurora**, not the company — false positive. |
| One counterparty name | 1 | scrubbed | — |

### Recommended follow-up
1. **Issue keys** in code comments + CHANGELOG → drop the ticket refs or replace
   with `<ISSUE>`; mechanical, low-risk, ~11 spots.
2. **Real emails** (the maintainer contact, a support alias, one vendor address) →
   placeholders / read from prefs; ~9 spots.
3. **Company name (×149)** → a real refactor: introduce a company-key indirection
   (`<company>` in prose; runtime value from prefs), keeping the product-specific
   Slack/dashboard integration working. Do as its own reviewed PR.

Nothing here is pushed. Branch: `chore/scrub-pii-to-local-prefs`.

## Round 2 (2026-07-22) — mechanical scrub done

- Internal issue keys in code comments / tests / install scripts / plist templates /
  one runbook → removed or genericized (`<ISSUE>` / `<TEAM>-123`), plus the runbook
  `Owner:` line degenericized.
- A person's example email in `agents/memory-extractor.md` → `example.user@example[.]com`.

### Deliberately kept (NOT PII to scrub)
- The public maintainer contact address — intentional, published in
  `marketplace.json` / `SECURITY.md` and allowlisted in `tests/test-no-secrets.sh`.
- A product support alias — functional config default, overridable by env; left to
  avoid breaking the launch-gate default.

## Round 3 (2026-08-16) — this document was itself a leak

Two failures found by enabling the operator identity denylist, which had never been
configured and therefore reported PASS while checking nothing:

1. **This audit re-published what it scrubbed.** Rounds 1 and 2 quoted every removed
   literal verbatim: the phone number, the WhatsApp LID, contact first names, deal
   code names, and issue keys. One commit removed the phone number from a skill and
   added it to this file in the same change, so net exposure never dropped. All such
   literals are now described by class instead of quoted.
2. **Operator identifiers the earlier rounds missed** — real email addresses in
   script docstrings and a test assertion, hardcoded `/Users/<user>/…` paths, a
   username fallback, a Tailscale tailnet name, an EC2 instance id, a private
   Tailscale IP, a PEM filename, and account-pool labels naming the owner's brands.

Both are now guarded rather than merely documented: `tests/test-no-secrets.sh` gained
a tracked-preferences check and a prefs-write-target check, and the identity denylist
must be configured per machine (see `CLAUDE.md` Rule 0) or it verifies nothing.

**Scope limit, stated plainly:** everything above fixes the working tree only. Values
committed earlier remain readable in this repo's public git history, and the
maintainer identity is present in the author/committer trailers of most commits.
Neither is addressed by editing files. Treat any address or hostname that ever
appeared here as public.
