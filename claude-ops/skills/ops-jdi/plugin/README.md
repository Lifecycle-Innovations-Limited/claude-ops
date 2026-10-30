# Just Do It

An opt-in continuation plugin. Native Python command hooks maintain a session cache; the module shows that cache and offers pause, resume, maintenance and an advisory audit. Linear remains the work record. This cache never grants permission.

## Evidence and delivery

For action requests declare outcomes with DoD, owner and a real issue identifier. Successful receipts, explicit inspection and typed transcript/file pointers form an evidence index. Metadata receipts cannot prove an outcome. Dependency checks are transitive. Changed files, evidence or generation require reinspection.

`deliver` records the exact proposed final text and outcome ids. Stop compares its hash against the actual final assistant message and checks every delivery-relevant outcome. Missing, empty, mismatched or incomplete delivery remains open. Matching evidence and delivery produce `delivered; semantic review pending`.

**No current route certifies independent semantic completion.** `audit-record` is callable by the implementing agent, so its verdict, provenance fields and even text starting with `ADEQUAAT` cannot establish independence. `/just-do-it audit` calls the host's documented `model.fork` once and records advisory telemetry only. HIATEN, ONZEKER, empty/error and positive advisory replies all leave semantic verification pending. Hashes bind bytes; they do not establish correctness. No accepted/verified label is emitted by the current completion path.

Bridge commands use `python3 -I <plugin>/hooks/bridge.py ACTION --session SESSION_ID`. JSON actions read stdin; use current generation. Omit revision unless deliberately using optimistic concurrency.

- `contract`: `{"generation":1,"issue":"TEAM-1","outcomes":[{"id":"result","owner":"session","dod":"Required effect","dependencies":[]}]}`.
- `evidence`: `{"generation":1,"id":"result","receipt":"actual-id","pointer":{"type":"transcript","tool":"Bash","tool_use_id":"actual-id","outputHash":"actual-hash"},"inspection":"What the output establishes"}`. File pointers require an actual Read receipt and current file hash.
- `deliver`: `{"generation":1,"text":"Exact final text","outcomes":["result"]}`.
- `reconcile`: `{"generation":2,"items":[{"id":"result","disposition":"retain"}]}`. Cover every unresolved `needsReconciliation` outcome in one batch, even when its generation is current. `contract` only declares new outcomes or repeats an identical existing contract without changing its generation; changes to an existing contract require authorized `reconcile`. Pending lists retain owned work requiring reconciliation. A question ending in `?` can receive an answer while that work remains visible in `next` and pending. Supported dispositions are `retain`, `amend`, `add`, `pause`, `cancel`, `supersede`. Every entry binds to the observed UserPromptSubmit generation and full prompt hash; scope changes also require an exact quote within the retained first 2,000 prompt characters. Unknown legacy prompt provenance cannot authorize reconciliation. `amend` requires the new `dod`; `add` requires a new id, `dod`, `owner` and a top-level `issue` matching `[A-Z][A-Z0-9]+-\d+` (the same syntax validator as `contract`), or top-level `inheritIssueFrom` naming an existing outcome whose issue passes that validator. Example: `{"generation":2,"inheritIssueFrom":"result","items":[{"id":"result","disposition":"retain"},{"id":"extra","disposition":"add","quote":"add extra","dod":"Extra effect","owner":"session"}]}`. Issue and inheritance cannot be combined; null and arbitrary identifiers are refused atomically. Syntax validation does not verify the issue against Linear.  `supersede` requires a different existing or batch-added `replacement`. Existing ownership, receipts, contract and disposition history survive. Pause/cancel/supersede suspend the old outcome without declaring completion. Quotes link sources; semantic interpretation still needs review. Contract and reconciliation cache edits validate transactionally before committing.
- Optional contract `criteria`: `[{"id":"bytes","kind":"file-sha256","path":"/absolute/result","sha256":"<64 lowercase hex characters>"}]`. `check-outcome` with generation/id records each criterion against the current criteria hash and generation. Stop rechecks exact bytes through a bounded no-follow directory walk. `{"id":"meaning","kind":"semantic"}` explicitly remains pending. Unknown kinds, including commands, are refused. These checks require ordinary inspected evidence too; byte matches never certify semantic acceptance. Outcomes without criteria remain evidence-only and semantically pending.
- `wait`/`release-wait`: concrete observed prerequisite pointers, current generation and collection/id. Waiting propagates to dependents; independent work continues. Release never grants authority.

Pause, interruption, approval refusal and native loop ceilings win. Repeated unchanged work requests diagnosis and an actual transcript-bound incomplete handoff. No recursive Claude process, timer, daemon or cron is created. Plain questions need no artificial contract. Suspended outcomes remain unresolved rather than silently complete.

## Native prompt provenance

The local 2.1.312 types document the native envelope as BaseHookInput plus `hook_event_name: UserPromptSubmit`, `prompt: string`, optional `source: user|sdk|system|loop_wakeup|schedule_wakeup|poll_event`, and optional `session_title`. They describe `source=user` as the interactive composer. This serialized field does not authenticate an arbitrary bridge CLI invocation. All serialized prompt callbacks now preserve intent, generation, evidence and waits, including callbacks claiming `source=user`, `origin=composer` or `authenticated=true`. `lastPromptSource.authenticated` is always false. `reconcile` refuses even legacy cached user provenance because no protected module-to-Python authority transport has been established.

Every unbound native `UserPromptSubmit` advances a separate `observationRevision` and sets `promptBindingPending`, regardless of missing/unknown/system/peer/user claims. This is an observation barrier, not new Sam authority: intent, generation, owned contracts, evidence/history, receipt inspection records and valid waits survive. Evidence inspection and mechanical checks are revision-bound, so old verification is stale; audit telemetry is marked stale and delivery candidates from older observations cannot be recognized. New CLI inspection/check/delivery records use the current observation revision but cannot clear the unresolved binding. No CLI authority flag or reset action is exposed; pause/resume does not clear it. A supported protected host transport remains required before completion recognition can resume. Stop can still yield for valid prerequisite/background waits, ordinary conversation and status questions; those yields never assert delivery. A status answer preserves pending owned work. Other unbound work yields incomplete through the existing loop ceiling or transcript handoff. Repeated observations, including identical text without a host event id, each create a barrier; existing event-id deduplication remains unchanged. Legacy caches migrate additively with revision zero and no new binding claim.

The module observes documented `prompt.submit` only, retaining engine-pinned `origin` and `isMeta` in its session atom. Its observation binds session, current cached generation, local sequence, SHA-256 of exact text and optional running turn id. The host supplies no message id on PromptSubmitInput; `observationId` is explicitly a local binding, not a host message id. Only non-meta composer origin is classified human locally. No observation is serialized to the CLI as authority. It always calls `next(e)` unchanged; the types state that next runs lower module hooks, then native UserPromptSubmit settings hooks, then enters the prompt. A policy that skips this hook leaves no observation; no alternate event is used to evade it. Observation/hash failures still forward the prompt unchanged. This is host-local observation, not completed native authorization wiring. Explicit existing module pause/resume controls remain separate. Full human intent updates and scope reconciliation remain unavailable through Python pending a supported protected handoff.

## Incident provenance

Every new failed tool callback creates an incident linked to its exact receipt id, generation, inputHash and outputHash. Identical duplicate callbacks are no-ops across the success/failure callback names. Conflicting callback payloads preserve the original receipt and open a provenance-conflict incident. Each distinct call keeps its own incident even when command/output bytes repeat.

Empty failure output and timeouts start with `effect: unknown`. Inspect the source and read back actual effects before retrying a write or requesting waiver. `waive-incident` requires the existing inspected local evidence, an allowed classification, substantive note, exact pointer and explicit effect (`not-started`, `confirmed-no-effect`, or `effect-confirmed`). These are agent assertions with evidence linkage, not independently verified semantic facts. `resolve-incident` additionally requires owned plugin source/backup hashes, current Read receipts, validation and rollback records.

Legacy unresolved tool incidents without an exact sourceReceipt remain unchanged and cannot be waived or resolved through fabricated reconstruction. Their source gap is an open diagnostic obligation. Closed history is preserved.

## Maintenance

SessionStart runs a deterministic own-plugin adapter. Successful Write/Edit callbacks to the named own scripts, manifest, hooks config, module and state types trigger rechecking; failed Read/Write/Edit callbacks to those exact paths also trigger diagnosis. Other failures cannot grant repair authority. Hash/mode signatures include missing files; failure fingerprints exclude callback ids, so repeated identical failures deduplicate. A 30-second minimum interval queues work for the next relevant event or prompt; unchanged checks deduplicate for five minutes. There is no timer or daemon, so queued work waits for another event. Pause/interruption wins. Automatic diagnosis checks an explicit allowlist before every declaration-target filesystem access: the three own scripts, manifest, hooks config, `hooks/register.tsx` and `types/index.d.ts`. Absolute/traversal/unknown or malformed declarations produce findings without target probes. Every automatic configuration read, including signatures, manifest checks, SessionStart probes, diagnosis, validation and repair preflight, uses the existing directory-fd no-follow reader, rejecting custom symlink ancestors and leaves. Automatic script repair pins source and archive descriptors and uses descriptor chmod; its validation rollback uses the same bounded reader. Manual repair and general evidence hashing retain their separate behavior. Automatic diagnosis does not search PATH; manual broader diagnosis retains its documented settings/install-path/PATH scope. Diagnosis is limited to named plugin files; repair requires a `just-do-it` manifest and performs at most three owner-execute-bit repairs on the named own scripts. Each repair reuses `apply_fix`, backup/hash validation and conflict-aware rollback. No HOME/config/secret scan runs automatically. State archiving remains a manual maintenance operation because age alone cannot prove an outcome is finished.

`/just-do-it maintain` reads named plugin files and the hook/install-path portions of the existing settings and installed-plugin records. `maintain record` records high/medium findings; `maintain fix` applies only existing explicitly safe own-plugin repairs. Unknown options remain read-only. External settings/hook/plugin findings are proposals only. Guards, permissions, routing, other plugins, auth and credentials are never changed.

External diagnostic adapters remain pending. The installed `hook-doctor` skill documents a read-only `node <hook-doctor>/bin/doctor.mjs <project> --json` diagnostic (no network or writes), but it also reads user settings and referenced scripts. It is not invoked automatically: the bridge's closed local-only import/process contract permits no subprocess path, and an external adapter needs a separately bounded host-side integration. No broad repair authority is inferred from its findings. Failures before the Python hook starts, Bash-based config writes, changes outside the exact named files and external edits without a later matching event are not automatically observed. The `maintenance.coverage` field makes this limited adapter scope explicit. Ownership is checked locally by manifest and file ownership; this is not a fleet lease or exclusive-writer proof. Run installation and maintenance with other plugin writers idle.

## Panel

The pane reads authoritative bridge state at session start, turn completion, commands and manual refresh. It lists individual outcome criteria/evidence counts, phase, next action and the last successful refresh. A failed read explicitly marks the retained snapshot stale. It does not poll; changes made externally remain visible at the next refresh. Counts never establish coverage or completion.

## Installer safety

`../install.sh install|update|uninstall` uses the native user-scoped plugin CLI. Existing marketplaces without `.ops-jdi-owner.json` are refused; do not manufacture a marker for a legacy installation. Unknown files/runtime remain preserved, with collision checks, private backups and conflict-aware rollback. `rollback <backup>` requires the matching owned installation. No live installer was run for this candidate.

`install.py` exposes read-only `runtime_manifest(root)` and `compare_runtime(source,target)`: only the explicitly named manifest, hooks, bridge/module and plugin state types enter the runtime hash map. Generated host declarations, tests, runtime and unknown files stay outside it. Comparison does not adopt ownership or authorize synchronization. Existing installer mutation behavior remains separate.

## Optional fleet inspection

The manifest declares optional `userConfig.fleetConfigPath` (file, empty default).
The native modules list appends `fleet-entry.ts` after the core module and retains
every command hook. An absent or empty path disables fleet inspection. An explicit
absolute private config must also enable inspection and supply a nonzero durable
judge allowance before a session-owned 60-second timer starts. Enabled inspection
may call the host model; no model calls were made for this offline integration.
Session end and invalid/disabled config cancel the timer. See
[the fleet contract](docs/fleet-guard.md) for source bounds and config fields.

Fleet judgments are advisory. A queued advisory is not execution, receipt of an
effect, authorization, or completion. Native source safety gaps currently prevent
advisory sending. The protected host-to-native origin transport remains unresolved:
local human transcript observations never clear `promptBindingPending`, authorize
bridge reconciliation or establish independent bridge acceptance. There is no
universal completion guarantee or live runtime acceptance claim.

The runtime hash manifest includes `fleet_guard.py`, `fleet.ts`, `fleet-source.py`,
`fleet-runtime.ts` and `fleet-entry.ts` alongside the core files. Existing installer
backup, collision, ownership, runtime and unknown-file preservation rules remain
applicable; the current unowned marketplace must still be refused.

## Checks and limits

Run through the existing resource-admission route after `rb status`:

```
python3 -I -m unittest discover -s <plugin> -p 'test*.py'
python3 -I -m unittest discover -s <skill> -p 'test_install.py' -v
python3 -I -m unittest discover -s <skill> -p 'test_manifest.py' -v
tsc -p <plugin> --noEmit
claude plugin test <plugin>
claude plugin validate <plugin>
python3 -I <plugin>/repair_fixture.py
```

Transcript-message scans require POSIX directory-fd `open`/`stat`, no-follow `stat`, and `O_DIRECTORY`, `O_NOFOLLOW`, `O_NONBLOCK`; unsupported platforms fail closed with handoff pending. Every directory is opened relative to a held parent descriptor without following links. Leaf ownership/type and before/after identity, plus the directory edges, are checked before acceptance. On macOS only the exact root-owned system links `/var -> private/var`, `/tmp -> private/tmp`, `/etc -> private/etc` are expanded and rechecked; their `/private/...` targets still undergo the same no-follow walk. Custom symlink ancestors and leaves are rejected. Concurrent mutation observed during scanning remains pending; this is an observation-time check, not a filesystem lock or semantic certification. Limits remain 128 MB total, 1 MB per record, five seconds; general file evidence still has its separate 16 MB limit.

Tests use temporary fixtures and host mocks, not a live installed session. The local Stop script contains no network/model/subprocess path. Timing checks measure local latency, not billing. `/just-do-it audit` is the only explicit model call; ordinary Stop makes none. No paid proof is authorized by these commands.

`smoke.py` requires both `--run-paid-smoke` and a concrete `--max-budget-usd`; without explicit opt-in it spends nothing. Its structural expectation is delivery with semantic review pending, never independent acceptance. Do not execute paid smoke without a newly approved budget.

NOT DONE: authentic independent semantic review provenance, complete typed per-DoD semantic validation beyond exact file bytes, external maintenance adapters and host hook-start failure observation, live panel/native-session/installation acceptance and paid runtime cost proofs. Cache transactions do not make filesystem repairs atomic; existing repair rollback handles those separately. Prompt hashes establish observed callback linkage, not host-authenticated user identity. Automatic source completeness and actual user meaning remain review obligations. Offline tests do not close these requirements. Final candidate needs separate independent review.
