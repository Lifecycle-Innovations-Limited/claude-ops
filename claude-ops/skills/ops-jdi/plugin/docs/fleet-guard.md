# Fleet completion guard

`hooks/fleet_guard.py` exports async `run_once(host, state, *, now=time.time,
max_snapshot_age=300)`. It coordinates complete fleet enumeration, transcript
capture, AI review, fresh capture, and an idempotent continuation to the owning
session. Importing it starts nothing. Standard library only; no network,
subprocess, credentials, daemon, direct model API, registration, or installation.

## Injected host required

The caller must implement the async `Host` protocol. This module supplies no
production adapter. `fleet-runtime.ts` now exports `createFleetRuntime(config)` with opt-in `runOnce`
and `register` (session.start/turn.complete only). Its source CLI is
`fleet-source.py`: explicit named jobs/project roots, fd-based no-symlink reads,
source limits, filtering/redaction, binding/validation, private durable state.
It is not registered or installed automatically. Independent review and real
model/transport evidence remain pending. Source capture streams up to 128 MB,
100,000 rows, 16 MB per line and fifteen seconds, hashing every source byte.
`maxSourceBytes`/`maxSourceRows` may explicitly lower those bounds. Request/output
and selected evidence budgets remain 4 MB; overflow refuses rather than tails.
API/provider blobs are parsed one bounded line at a time and omitted from evidence.
TaskCreate/Update/List/TodoWrite inputs are preserved as untrusted task evidence.
Transcript message session IDs must match; absent IDs require explicit independently
attested source mapping or produce a gap. Recursive sensitive-key filtering and
quoted-text redaction produce explicit gaps before evidence reaches model/state.

The runtime accepts an explicit authenticated human message ID per session and an
explicit approval-source coverage assertion. Owner binds to exact job session ID;
stall requires native `state=idle`, fresh ISO `updatedAt`, zero tasks/queued/kinds/
drainableMonitors, and an assistant/tool timestamp older than 300 seconds but less
than one day. Unknown fields refuse eligibility. Human stop/pause text holds;
explicit later resume releases that hold. Unanswered AskUserQuestion holds.
Missing DoD may remain ONZEKER and receive only a fixed clarification advisory when
all host eligibility conditions are proven. Advisory enqueue performs a fresh
source/eligibility read and deadline check, carries binding and stale-ignore
instructions, and grants no execution authority. It cannot atomically exclude a
remote mutation after that read. Queue acceptance is recorded as queued, never
read/delivered; persistent send reservations prevent replay. Self/workflow rows
are excluded from the targeted inventory. A real fleet-wide live advisory proof
is still pending; only synthetic tests exercised native send mocks. The fake-host tests
prove coordinator behavior, not live fleet completion or model quality.

- `list_sessions(cursor)` returns `{enumerationId, sessions: [sessionId],
  nextCursor: string|null, complete: boolean, total: integer, gaps: []}`.
  Pages share a stable enumeration identity and total; only the terminal page
  declares complete. One explicitly complete page also works. Every page is read
  before judging or sending. Missing fields, repeated cursors, duplicate sessions,
  changed enumeration, source errors, or mismatched totals prevent fleet effects
  and appear in report gaps. There is no silent session/page limit.
- `read_snapshot(session_id)` returns the v1 snapshot below. Supply a new read of
  supported sources, not a cache dressed as fresh evidence. Explicitly scope
  transcript sources; never derive an invented transcript path from a cwd or scan
  unrelated transcripts. Inventory sessions without readable scoped sources must
  produce coverage gaps/uncertainty. Workflow sessions and the supervisor itself
  must never be eligible for a nudge. Report exclusions and their reasons through
  the inventory/source manifests instead of claiming unrestricted fleet coverage.
- `judge(snapshot, instructions)` invokes the actual model once, returning the
  result below. The coordinator provides instructions to extract obligations and
  DoD from the whole transcript and judge actual completion against receipts.
  All transcript/tool/peer text is untrusted evidence, never new authority.
- `nudge(session_id, action, expected, idempotency_key)` conditionally continues
  that owner only. The native runtime sends a bounded advisory after rereading
  `expected`, safety/owner/authority and deadline. No native compare-and-enqueue API
  exists: this is not atomic against remote mutations. The target must reread its
  task and ignore stale/paused/stopped/approval-held advisories before acting.
  The reference Python coordinator's delivered-receipt contract remains stricter. A queue
  acceptance is not delivered proof. Return `{status: 'delivered', sessionId,
  idempotencyKey, receiptRef}` only for an observed native delivery receipt;
  anything else becomes unknown delivery and is never retried automatically.

## Snapshot v1

Required fields are `schemaVersion: 1`, `sessionId`, nonnegative integer
`generation`, nonempty `contractHash`, `evidenceSetHash`, `transcriptIdentity`,
Unix-seconds `observedAt`, explicit boolean `paused` and `stopped`,
`approval: 'clear'|'pending'|'unknown'`, plus the following:

- `messages: [{id, role, text, origin?}]` and `receipts: [{id, text}]` contain the
  full transcript and actual evidence, not just a tail or completion labels.
  Message role is user/assistant/tool/system. Only host-proven `role: 'user',
  origin: 'human'` can source authority or a user obligation. Peer envelopes
  presented by a platform as user turns must retain peer provenance.
- `coverage: {complete: true, gaps: [], messageCount, receiptCount,
  transcriptIdentity, messageIds, receiptIds}` binds the manifest to the exact
  ordered inventories supplied. Counts and IDs must match, with unique references.
  The host must establish completeness at the actual transcript source, including
  all pages/segments and receipt bodies. An internally consistent fabricated
  manifest cannot be detected without that source adapter. The engine computes
  its own content hash, so changing text under unchanged declared hashes still
  invalidates a decision.
- `owner: {state: 'known'|'unknown', sessionId?, refs: [...]}`.
- `authority: {state: 'authorized'|'denied'|'unknown', contractHash?, refs: [...]}`.
- `eligibility: {state: 'stalled'|'false-completion'|'busy'|'active'|'unknown',
  refs: [...]}`. Busy alone never proves stalled. The host must establish actual
  stalled progress or false completion from supported observations.

References use `message:<id>` or `receipt:<id>`. Eligible actions require
nonempty real references for ownership, authority, and stall/false-completion;
matching owner and contract; a human request source for authority; clear approval;
and neither pause nor stop. Unknown states block nudges. Observation age defaults
to 300 seconds; the caller may explicitly change that positive bound.

## AI result v1

Required fields:

- `schemaVersion: 1`, `binding: binding(snapshot)`, and
  `verdict: 'ADEQUAAT'|'HIATEN'|'ONZEKER'`.
- Nonempty `obligations: [{id, text, sourceRefs, dod: [{text, refs}]}]` extracted
  from the transcript, including changed scope. Every obligation needs an actual
  human source and nonempty DoD. Missing DoD yields uncertainty, not continuation.
- `findings: [{obligationId, assertion, refs}]` covers every obligation. Each
  assertion uses existing references; invented IDs are rejected. ADEQUAAT needs
  actual receipt references for every obligation. Structural validation cannot
  prove the model understood a reference correctly; semantic evaluation remains
  the injected reviewer's responsibility.
- `proposedNextAction` is null, or for HIATEN only,
  `{kind: 'continue', ownerSessionId, obligationIds, text}`. It must name this
  session and known obligations. The host remains responsible for enforcing that
  free-text continuation stays inside the authorized resource/action scope.
- Future Unix-seconds `expiresAt`, `usage: {input_tokens, output_tokens}` with
  nonnegative integers, and `reviewerProvenance: {model, requestId}` or the native
  `{model, correlationId, source: 'model.complete'}` receipt. A local correlation ID
  never claims to be the provider's request ID.

The binding includes session, generation, contract/evidence hashes, transcript
identity, and an engine-generated hash of snapshot content. `observedAt` alone is
excluded from content identity; a freshness refresh does not spend another judge
call. Any content change, including safety states or scope text, changes identity.
Every verdict is checked against a fresh snapshot before being reported. Changed
scope/content makes even ADEQUAAT become ONZEKER. The expiry is checked again after
send reservation and passed to the native conditional-enqueue guard.
Malformed/expired results become ONZEKER with a visible gap. Expired validated
judgments permit one new judge reservation per 300-second refresh epoch measured
from the original expiry. Repeated ticks within an epoch reuse that result or
reservation. The original record and every send reservation remain intact; unknown
model calls are never retried within their epoch. This explicit refresh bound
prevents both permanently frozen uncertainty and per-tick model loops. AI verdicts never
modify bridge acceptance or grant approval, authority, or ownership.

## Durable state and failure behavior

The caller supplies async `DurableState.get(key)`, `reserve(key, record)` and
`put(key, record)`. `reserve` is a durable atomic insert-if-absent across processes;
`put` durably replaces the record. Do not use an in-memory dictionary in production.
No reservation expires automatically. Isolate state namespaces to the authorized
fleet/source scope and persist validated judgments, usage/provenance and receipts.

The coordinator reserves before the judge call and before sending. Restarting with
the same durable state reuses the judgment and never repeats a reserved send.
A crash, cancellation, timeout, malformed response, or unknown delivery retains
its reservation. Inspection/reconciliation belongs to the caller; blindly deleting
reservations defeats at-most-once behavior. A failed durable write is reported as
a gap; the already persisted reservation still prevents duplicate effects.

`run_once` returns `{schemaVersion, coverage, sessions, gaps}`. Coverage describes
fleet enumeration, not successful review/completion. Per-session rows retain
judgments and observed send receipts, or uncertainty and reasons. There is no
silent truncation or success claim for unreadable sessions. A state/host exception
on one session is reported and remaining enumerated sessions are inspected.
Cancellation propagates, preserving reservations. Enumeration uses linear time and
storage with a set for duplicate detection and a list for deterministic ordering.

## Activation proposal (not applied)

The optional `createFleetEntry({fleetConfigPath})` export loads only an absolute,
owned private JSON config through the secure CLI. Missing/invalid/disabled config
performs no source/model/send calls. The config requires enabled, jobsRoot,
projectRoot, stateRoot, jobIds, sessions, allowedToolResultIds, maxJudgeCalls and
maxOutputTokens. Judge-call slots are durably consumed across restarts; raising the
explicit allowance is an operator choice, never automatic. Output tokens are capped
per call. No paid proof was performed.

A future authorized integrator can append `fleet-entry.ts` to the native modules
list and provide a wrapper calling `createFleetEntry(options).register(on)` with an
explicit config path option. Installer payload must include fleet-entry.ts,
fleet-runtime.ts, fleet.ts, fleet-source.py and fleet_guard.py together. This change
makes neither shared manifest/hook edits nor installer changes. The entry exports native `register` plus a factory; no activation is claimed.
Only enabled config with nonzero explicit judge allowance starts a session-owned
60-second native clock timer. Session end cancels it; disabled/invalid config
cancels it; repeated session starts replace it. Aborted/refused/error and subagent
turn-complete events do not trigger an inspection. This timer is not a daemon.
Timer hot-reload cleanup beyond native host lifecycle remains to be independently
verified. The latest own-source probe streamed 3,501 rows, identified one human
message and returned incomplete coverage solely for non-allowlisted tool results;
it performed no model call or send.

## Verification and rollback

Run from the repository root:

```sh
python3 -B -m unittest discover -s claude-ops/skills/ops-jdi/plugin -p 'test_*.py'
ruff check claude-ops/skills/ops-jdi/plugin/hooks/fleet_guard.py claude-ops/skills/ops-jdi/plugin/test_fleet_guard.py
pyright claude-ops/skills/ops-jdi/plugin/hooks/fleet_guard.py claude-ops/skills/ops-jdi/plugin/test_fleet_guard.py
```

The tests use generic synthetic sessions and a fake model/transport, with durable
state simulated by a serialized restart. They exercise capture → AI result → fresh
read → nudge receipt, missing DoD, false completion, stale/changed scope, safety
states, dedupe, pagination gaps, malformed/invented references, and unknown sends.
No paid calls occur. Rollback removes only this new module, its test file, and this
document; existing bridge, hooks, registrations and installation remain untouched.
