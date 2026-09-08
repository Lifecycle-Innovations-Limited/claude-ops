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
| The operator's primary company name | 149 | ~load-bearing | Integration target across Slack scoping, dashboards, skills. Genericizing to a config-driven company key is a real refactor — do not blind-scrub. |
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

## Round 4 (2026-09-08) — the gates were not running

Round 3 said the identity denylist "must be configured per machine ... or it
verifies nothing". That was true and it stayed unconfigured everywhere it
mattered. Three findings, each verified by running the thing rather than reading
it:

1. **`pii-gate` in CI passed while checking zero identity terms.** The job runs
   `tests/test-no-secrets.sh` on every PR, but no denylist exists on a CI runner,
   so `identity_denylist_check` took its "none configured" branch and counted it
   as PASS. Proven locally by running the suite with the denylist hidden: the
   summary read `27 passed, 0 failed`, identical to a run that really did check
   25 terms. Fixed: that branch now reports SKIP, the summary names the skip
   count, and `OPS_PII_DENYLIST_REQUIRED=1` turns it into a failure.
2. **`.githooks/pre-commit` was dead code.** Present and executable, but git only
   runs hooks from `core.hooksPath` or `.git/hooks`, and nothing set either — in
   the primary checkout or in any worktree. Every commit for the life of this repo
   bypassed it. Fixed: `bin/ops-install-git-hooks` wires it and warns when no
   denylist is configured. Verified by staging a line containing a real denylist
   term: the commit was refused and no commit object was created.
3. **`main` has no branch protection at all**, so `pii-gate` was advisory even
   when it did run. Not fixed here — that is a repository-settings change for the
   owner, not a code change.

**This document was still leaking.** Round 3 removed the quoted literals but left
the operator's primary company name in the follow-up table, in the row explaining
that it is load-bearing. It is now described by class, like every other entry.

**Working-tree state at this round:** 3 denylist matches across 930 tracked files.
One is a detector pattern inside a test (legitimate — the test must name what it
searches for). One was this document. One is a private hostname in a test comment.
Zero real secrets: every `sk_live_`/`ghp_`/`AKIA`/`xox*` hit is a detector pattern
or documentation, none with a credential-shaped tail. No tracked prefs-shaped
files. One hardcoded `/Users/<name>` path, and it is the literal word `username`
in a Rule 0 example. All phone numbers are reserved-range placeholders.

**History, stated plainly again.** 14 of 25 denylist terms appear somewhere in the
173-commit history, across 34 distinct paths. Round 3's conclusion stands and is
now stronger: this repo is public, has 21 forks and 187 stars, and forks were
created both before and after every scrub. A history rewrite would not reach the
forks, would break every open PR and clone, and cannot un-publish what was already
served. Treat every value that ever appeared here as public. Rotate anything
sensitive instead of rewriting; rewriting is theatre once a fork exists.


## Round 5 (2026-09-09) — third-party identifiers, and what the agent got wrong

Round 4 closed the gates. This round used them, and the first thing they found was
not the operator's own data but **other organisations' identifiers**, which is the
worse category: the operator can decide to publish his own name, and cannot decide
that for a client.

**Fixed.**

1. **Client organisation UUIDs in a Linear bridge.** `TEAM_TO_COMPANY` and
   `COMPANY_TO_TEAM` in `scripts/hermes-linear/linear_paperclip_delegate_bridge.py`
   held ten UUIDs belonging to six client organisations. One of the six was already
   read from the environment three lines above the hardcoded five, so the pattern
   existed and had simply not been finished. All six now come from
   `LINEAR_TEAM_MAP_JSON`; an absent map is valid and yields an empty mapping.
2. **A client's Linear team key**, hardcoded 43 times across six files including a
   filename. It is now `CLIENT_TEAM_KEY` from `LINEAR_CLIENT_TEAM_KEY`, defaulting
   to the neutral `TEAM`. `hea_linear_fix_all.py` is renamed `linear_fix_all.py`
   and its `HEA_LINEAR_FIX_ALL_*` environment variables to `LINEAR_FIX_ALL_*`.
3. **A client's real Linear issue ids** as fallback "thrash canon" dictionaries in
   two files. The canons already loaded from an out-of-repo `hea_thrash_canons`
   module; the fallbacks are now empty, which is the correct meaning for anyone who
   does not have that module.
4. **The operator's timezone**, hardcoded in ten places. The two functional sites
   read `OPS_TZ` and fall back to the host zone; the rest are documentation and now
   describe the host zone rather than one city.
5. **A brand name in a tracked filename** — an unreferenced logo under
   `assets/`, renamed to `ops-pixel-logo.svg`. Its contents were clean. The
   old name is not repeated here: the denylist would flag this document too,
   and correctly so.

**Two agent findings that were false, and the checks that falsified them.**

- *"Private MCP hostnames in `ops-mcp-reauth.py`, `ops-mcp-watchdog.py`,
  `ops-cron-pocket-watcher.py`."* No such hostname is in the tree. The only
  `.ts.net` string anywhere is `example.ts.net`, in two test files.
- *"A tailnet CGNAT IP in `local-failover/config.example.json`."* The value is
  `100.64.0.10` — the first host of the CGNAT block, the conventional example
  address, and the same value the sanitizer's own tests use as a placeholder.

Both were reported against **history**, where the terms do appear, and read as
working-tree findings. All 25 configured denylist terms now return zero hits in the
tree, which is why the agent's own numbers (49 hits, 228 hits) could not be
reproduced against it.

**Deliberately not changed: `paperclip`.** The deprecated task system's name appears
272 times, and `docs/public-template-contract.md` says to replace it with
`legacy task system`. It stays, because 45 of those occurrences are **wire format**
— `[Paperclip <id>]` title prefixes and `paperclip-export:` / `paperclip-comment:`
comment footers that this code writes into Linear and later parses back out. Renaming
the string in the reader without rewriting every marker already sitting in a live
Linear workspace would make the bridge silently stop recognising its own pairs, and
"silently stops pairing" is the exact failure these files carry the most defensive
code against. The name is a product name, not personal data, and no
`PAPERCLIP_*` variable is set in any environment file on this machine. Renaming it
is a protocol migration, and it needs its own change with a compatibility window
that reads both spellings — not a search-and-replace in a PII pass.

**Unchanged from Round 4:** history is not rewritten, and `main` still has no branch
protection. Both remain owner decisions.
