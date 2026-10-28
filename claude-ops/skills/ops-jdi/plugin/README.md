# Just Do It

Local hybrid plugin for JDI-1. Native command hooks maintain an atomic session cache and gate explicit unfinished work. The module displays that same cache, provides pause/resume and an on-demand semantic audit. It does not intercept `classic.Stop`, inject a large prompt, start timers, or run recursive Claude subprocesses.

## Cost model: no model calls except an explicit audit

- The Stop gate is **deterministic**: `hooks/bridge.py` is a plain command hook (no network, no model, no subprocess). Healthy idle conversations and every ordinary Stop make **zero model calls**.
- The earlier `type: "agent"` Stop hook was **removed because of measured cost**: it spawned a subagent on every Stop (documented up to 50 tool-use turns), and a paid smoke of that exact shape ended `error_max_budget_usd` at a reported $1.021233 for a trivial 9-turn task. A `type: "prompt"` Stop hook was deliberately not added either: it cannot see this plugin's session state, so it cannot judge scope or DoD.
- The **only** model call is `/just-do-it audit`, requested by the human or by the main agent. It uses `$.model.fork` (one tool-less completion over the session transcript, see `ModelForkRequest`/`ModelForkResult`). The pane shows `audits op verzoek: N` and the audit result prints the token usage, so the cost is visible.

## Acceptance: verified AND delivered

A contract is accepted at Stop only when all hold:

1. Every required (non-suspended) outcome has current-generation, inspected, typed evidence and its dependencies are ready (unchanged rules below).
2. A **delivery record** exists whose `messageHash` equals the digest of the *actual* `last_assistant_message` in the current Stop payload.
3. That record references **every** delivery-relevant outcome (all non-suspended outcomes of the contract).

Delivery record: the agent runs `python3 -I <modroot>/hooks/bridge.py deliver --session <id>` with stdin `{"generation":G,"text":"<exact final message>","outcomes":["id",...]}` (or `"messageHash"` instead of `text`: the bridge digest, which is sha256 of the JSON-encoded string; prefer `text`). It then ends the turn with exactly that text. The record is only an announcement: the bridge compares it with the real Stop payload and never accepts the assertion alone.

| Situation at Stop | Result |
|---|---|
| Evidence complete, no delivery record | block once with `record delivery for outcome X ...`; repeats escalate through the existing no-progress diagnosis, never to acceptance |
| Record exists, hash differs from actual final message | block with `delivery mismatch ...` |
| Record matches but omits an outcome | block with `delivery omits outcome X ...` |
| Empty final message | block |
| Record references an unknown outcome | `deliver` itself is rejected |
| Record from an older generation | cleared on every new generation (prompt, pause, resume, interrupt); `deliver` with an old generation is rejected as stale |
| Record matches, all outcomes referenced | accepted; phase `accepted; verified and delivered; ...` |

Phases carry `semantic audit advised` while no audit has been recorded for the current generation (`semantic audit recorded` after one). The blocking Stop reason then tells the main agent to run `/just-do-it audit` itself. The audit is advice: acceptance never depends on it.

## Semantic audit (on demand)

`/just-do-it audit` reads the cached contract through the bridge, asks `$.model.fork` for a verdict (`ADEQUAAT`, `HIATEN` or `ONZEKER` plus short points), and records only telemetry through the bridge action `audit-record` (request counter, truncated advisory verdict, usage, `acceptance: "none"`). It never touches outcomes, evidence, deliveries, waits or phase logic, and never claims completion. Safe failure modes: no contract, unreadable bridge, `nothing-to-fork`, API error, empty reply or a throwing fork all produce a "geen verdict" report; without a contract or bridge no model call is made at all. New evidence or a new generation marks the last audit stale; the counter survives.

## Admission and acceptance

Official documentation distinguishes native plugin command hooks from function module hooks:
https://code.claude.com/docs/en/hooks
https://code.claude.com/docs/en/settings


**Still unproven (no completion claim):**

- Live acceptance of this version in the protected runtime: premature stop, continuation, typed evidence, delivery record and accepted final answer have only been exercised by offline fixtures (`test_bridge.py`, `test_repairs.py`, module tests), not by a real session. `smoke.py` has been updated but not run.
- Measured audit cost: `/just-do-it audit` has never been run against a real model; token usage and cache behaviour of `$.model.fork` are unmeasured.
- Durable installation, restart/resume and restore of the previous version; independent review.
- Multi-outcome and human-wait cases, and real maintenance integration, in the protected runtime.
- `tsc -p` for this revision depends on machine resource admission (see Reproduce checks). `tsc` is not on PATH here; the existing TypeScript under `~/.local/share/gstack/node_modules/typescript/bin/tsc` (run with `node`) is the only compiler found.
- `/just-do-it maintain` and `apply-fix` are verified on temp fixtures, module mocks and one read-only run of `diagnose-config` against this machine. `apply-fix` has not been run on the real plugin tree, and no real fault in a live configuration has been repaired.

At `stop_hook_active` the command preserves the native loop ceiling and emits an explicit INCOMPLETE system message with missing work. Native termination can still occur without a handoff record; state remains incomplete. Pause/stop/cancel and approval waits stay authoritative.

No arbitrary cycle count means success. After two unchanged repeats, the command requests one diagnostic inspection and concrete blocker delivery. Record `handoff` with current generation, blocker and `pointer: {"type":"transcript-message","path":"actual native transcript_path","message_id":"actual assistant uuid","messageHash":"digest of actual delivered text"}`. The bridge reads back that assistant row and binds it to the Stop delivery hash and pending fingerprint. A new prompt invalidates the record. This verifies delivery identity, not semantic adequacy.

## Local integration

Start a fresh protected session explicitly with `claude --plugin-dir /absolute/path/to/just-do-it`. Keep existing security plugins and hooks enabled. Do not change policy, tiers or permissions. Local durable installation is separate acceptance work; no marketplace publication is needed or performed.

Commands: `/just-do-it`, `/just-do-it diagnose`, `/just-do-it pause`, `/just-do-it resume`, `/just-do-it audit`, `/just-do-it maintain` (see Maintain). Resume changes generation and invalidates prior evidence and delivery records; it does not start a prompt. The pane refresh button and turn completion read shared state without timers. Native command hooks capture SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure and Stop. Actual UI interruption writes paused state when `turn.complete` reports an abort. A direct CLI/UI request racing an already emitted native Stop decision cannot retract that decision. No queued plugin prompts exist.

State: `<modroot>/runtime/<session-id>.json`, mode 600, directory 700, same-session advisory file lock, atomic replace and fsync. No transcript contents or raw tool outputs are cached. Intent, tool output and delivery use hashes; evidence stores explicit short pointers and inspection hashes. Callers must never pass secrets in pointers. Corrupt/unsupported state stays byte-for-byte intact and reads as paused diagnosis. Schema 1 is the only accepted bridge schema; the additive `deliveries` field is created on first read of an older file without discarding open work or pause.

Linear remains the system of record. The cache requires an issue identifier for contracts, but does not perform Linear writes, invent assignees or synchronize conflicts. The agent must reconcile the actual user request with Linear. External tool text never authorizes work. A completed task label never proves an effect. Successful receipt plus explicit inspection is only an evidence index; adequacy still needs review (`/just-do-it audit` or a human).

## Agent helper contract

Use the fixed Python script, session ID from native context, current generation/revision from `status`. JSON actions read stdin. There is no shell evaluation inside the helper.

```
python3 -I <modroot>/hooks/bridge.py status --session <session-id>
python3 -I <modroot>/hooks/bridge.py contract --session <session-id>
python3 -I <modroot>/hooks/bridge.py evidence --session <session-id>
python3 -I <modroot>/hooks/bridge.py deliver --session <session-id>
```

Contract stdin: `{"generation":1,"issue":"JDI-1","outcomes":[{"id":"result","owner":"session","dod":"Actual required result","dependencies":[]}]}`. Contracts preserve other open outcomes; a changed user prompt invalidates old evidence and marks old items needsReconciliation, never silently removes old work. Deterministic continuation ignores these suspended items until an explicit contract redeclares an outcome or TaskUpdate reactivates a task. There is no automatic scope retirement operation: reconcile with the user before abandoning outcomes.

Evidence stdin, action `evidence`: `{"generation":1,"collection":"outcomes","id":"result","receipt":"actual-tool-use-id","pointer":{"type":"transcript","tool":"Bash","tool_use_id":"actual-tool-use-id","outputHash":"recorded receipt outputHash"},"inspection":"What the actual output establishes"}`. This references exactly the recorded successful tool output. Alternatively `pointer: {"type":"file","path":"absolute existing owned file","sha256":"actual SHA256"}`: this requires a successful current-generation Read receipt for that exact path and hash. Changed files become pending again. Collections: outcomes/tasks/incidents. Cache stores hashes, output byte count and Read path/hash only. Never put secrets in pointers. Metadata receipts remain rejected. A successful Bash hello is only an index to hello, not proof of an arbitrary outcome. Dependency checks are transitive; missing prerequisites and cycles remain pending. Hashes prove byte identity only.

Deliver stdin, action `deliver`: see Acceptance above. Wait stdin, action `wait`: `{"generation":1,"id":"task-id","kind":"approval","pointer":"actual-approval-request"}`. Other kinds: prerequisite/background. Wait is generation-bound and applies transitively to that task's dependents. Outcomes also accept `collection: "outcomes"`, including transitive outcome dependencies. Independent work continues. An incident can wait using `collection: "incidents"`. `release-wait` requires collection/id/current generation and a concrete observed `pointer`; it clears the condition and evidence for reinspection, never grants approval. Old or legacy waits become reconciliation work when reactivated; a new prompt invalidates authorization, never grants it. Duplicate native tool callbacks use tool-use IDs; concurrent helper writes serialize; the `revision` field is optional and normally omitted: every tool call bumps the revision, so a value read earlier is already stale (measured: a live smoke failed twice on this). Effects are never executed by this controller.

Module-only action `audit-record` (generation required) stores audit telemetry as described above; agents should use `/just-do-it audit` instead of calling it.

## Maintenance boundaries

Actual PostToolUseFailure and structured error outputs create deduplicated incidents using source/category fingerprints; no raw error text is cached. Generic notifications and repeated policy notices never schedule work. An explicit `incident` action accepts only category `actual failure`; the agent must first verify the source.

Maintenance prescription for the owning agent: inspect actual failure and source; check current resource ownership/peers; discover the existing supported diagnostic tool; preserve a recoverable backup and source hash; make only an authorized smallest repair; rerun the original failing command and inspect output; record evidence and rollback hash. Before rollback compare the current file with the exact post-edit hash; on conflict preserve both and reconcile. Authentication/security changes, account recovery, password changes and new permissions are never automated. The controller never executes a repair. `resolve-incident` requires an inspected current successful local receipt, backup pointer, preHash/postHash SHA256, validation and rollback records, a `source` under this plugin's owned tree (outside runtime), an existing owned backup, matching bytes and current-generation Read receipts for both. Unresolved actual incidents prevent a clean stop except explicit current-generation waits, delivered incomplete handoff, native ceiling or pause. SessionStart parses only this integration's own manifests and checks its Python executable/script readability; it never scans HOME or reads secrets.

Run `python3 -I <modroot>/repair_fixture.py` offline. It reproduces a JSON parse failure in a new temporary fixture, backs up original bytes, repairs and validates, repeats idempotently, rejects a concurrent-edit rollback, then restores and verifies the original hash. This proves the local fixture cycle only.

## Maintain: self-maintenance of the Claude Code setup (JDI-1)

`/just-do-it maintain` calls bridge action `diagnose-config`. It makes no model call and inspects **only named files**, no HOME sweep:

- this plugin's `.claude-plugin/plugin.json` (parses; `types` file exists) and `hooks/hooks.json` (parses; module files exist; every script path in a hook command exists and is readable; `python3` resolves on PATH),
- the `runtime/*.json` state files of this plugin (age and parse only),
- `~/.claude/settings.json`: only the `hooks` tree is walked, and only the **absolute script paths** in each command are checked for existence. The `env` block, tokens, arguments and `KEY=value` prefixes are never read into a finding or printed,
- `~/.claude/plugins/installed_plugins.json`: entries whose `installPath` is missing.

Each finding is `{id, severity, source, evidence, proposedFix, autoFixable, patch}`. Findings outside this plugin carry the exact JSON-pointer `patch` that would fix them, as a proposal for Sam. Ids are deterministic (`exec-bit:hooks/bridge.py`, `settings-hook-missing:Stop/0/0`, `plugin-install-missing:name@market/0`, `runtime-stale:<file>.json` ...).

| Command | Effect |
|---|---|
| `/just-do-it maintain` | Read-only report. Nothing is written, no incident is recorded. Unknown arguments behave the same. |
| `/just-do-it maintain record` | Same report, and every `high`/`medium` finding becomes a bridge incident (`actual failure`, fingerprint over source, category and finding id), so the Stop gate sees it. `low` findings stay informational. Re-running creates no duplicates. |
| `/just-do-it maintain fix` | Sends the `autoFixable` finding ids to `apply-fix`. Nothing else. |

Direct bridge use: `diagnose-config` (stdin `{"generation":G,"record":true|false}`, default `record: true`), `apply-fix` (`{"generation":G,"ids":[...]}`), `rollback-fix` (`{"generation":G,"fixId":"..."}`).

**`apply-fix` limits.** It re-runs the diagnosis and only acts on ids that diagnosis reports as `autoFixable` inside this plugin's tree. The caller never supplies a path, so traversal ids and absolute paths find nothing. Two fix kinds exist: (1) a `runtime/*.json` state file that is corrupt or older than 7 days is moved to `runtime/archive/<fixId>/` (bytes preserved, mode 600; refused while its lock is held, for the active session, for symlinks, or if it changed since diagnosis); (2) a missing owner exec bit on `hooks/bridge.py`, `repair_fixture.py` or `smoke.py` is set (`chmod u+x`, a byte copy goes to the archive first). Each apply records backup path, `preHash`/`postHash`, a validation (the diagnosis is re-run and the finding must be gone, otherwise the change is reverted), and a rollback description in the state field `fixes`. The `resolution` object has exactly the fields the existing `resolve-incident` contract asks for (`source`, `backup`, `preHash`, `postHash`, `validation`, `rollback`); a test feeds it into `resolve-incident`. Only the exec-bit kind can satisfy that contract, because it needs a source outside `runtime`; `apply-fix` never closes an incident itself. Applying twice is a no-op.

**`rollback-fix`** restores a fix only if the current bytes and mode still equal what the fix produced. On any difference it returns `status: conflict`, records the reason, and changes nothing, so both the current file and the backup stay.

**Never applied, only proposed:** anything in `settings.json`, `installed_plugins.json`, other plugins, hooks of other plugins, managed settings, guards, permissions, credentials or auth. These findings are refused by `apply-fix` with their patch. A missing guard script is better restored than removed from settings.

**Not automated:** repairing a corrupt `plugin.json`/`hooks.json` (restore from backup; guessing content is not a fix), reinstalling plugins, resolving incidents (stays with `resolve-incident` and its receipts), recent corrupt state files (kept on purpose for diagnosis until 7 days old), and any scheduled or recurring run. `maintain` runs only when asked. A recorded incident for a finding outside this plugin has no automatic way to close; give it a `wait` with Sam's approval pointer, or fix the cause and resolve it by hand.

Tests: `test_maintain.py` (temp fixtures only: findings, secrets never in output, only named files opened, record/idempotence, apply/backup/hash/rollback/conflict, refusal outside the plugin, symlinks, lock, state migration) and `maintain.test.tsx` (command wiring, zero model calls).

## Cost evidence: a Stop makes no model call (free, local)

`test_cost.py` proves, without any provider call, that the Stop hook is a local script: an AST check of `hooks/bridge.py` allows only a closed list of standard-library imports (no `subprocess`, `socket`, `ssl`, `http`, `urllib`, `asyncio`, `importlib`), forbids dynamic import/`eval`/`exec` and `os.system`/`popen`/`spawn*`/`exec*`, and rejects any string that launches a model CLI, names a provider or contains a URL. A Stop run in-process with sockets, `Popen` and `os.system` booby-trapped passes. Every registered hook must be the one `python3 -I bridge.py` command hook.

A timing test runs the real hook 50 times as a subprocess and prints one line, for example `STOP_TIMING runs=50 cpu_median_ms=98.9 ... wall_median_ms=505.7 ...`. It asserts median CPU time < 250 ms, and median wall time < 250 ms unless the machine is saturated (load average above the CPU count; the line says `wall_assert=skipped`). On a loaded machine wall time mostly measures the scheduler and Python start-up.

**This is not a billed measurement.** It shows that the hook is a local script that does no model work. It does not read an invoice, a token counter or a provider log, and it says nothing about what the surrounding session costs.

## Reproduce checks

```
python3 -I -m unittest discover -s <modroot> -p 'test*.py' -v
claude plugin test <modroot>
tsc -p <modroot>   # run through your own resource admission wrapper if you use one
claude plugin validate <modroot>
```

Use the existing resource-admission wrapper for `tsc`; do not bypass it. No global dependency installation. Module tests mock the documented process bridge and model entry points (including a counter proving zero model calls in ordinary operation); Python tests exercise real files and native payload fixtures. Neither proves live protected-runtime execution. Directory publication checks report missing license/icon/author; no publication is requested and no license is invented.

Independent opt-in live smoke (spends up to the budget you pass, at most $1): `python3 -I <modroot>/smoke.py --run-paid-smoke --max-budget-usd 0.50`. Both flags are required; without them the script exits 2 and spends nothing. It starts one fresh session with a unique ID in a scratch directory and walks: declare contract -> deliberately premature stop (`JDI_FIRST_PASS`) -> Stop-hook continuation -> harmless `echo JDI_SECOND_PASS` -> typed evidence from the status receipt -> `deliver` with text `JDI_SECOND_PASS` -> final answer exactly `JDI_SECOND_PASS`. Read independently: the printed `state_summary` and the state file (`stopInvocations >= 2`, `continuations >= 1`, `deliveries` holding the hash of `JDI_SECOND_PASS`, outcome `smoke` with one evidence item, `phase` starting `accepted; verified and delivered`, `audit` null), the Claude JSON output (`total_cost_usd`, `num_turns`, same session ID) and the transcript (the echo tool result, the block reason mentioning delivery, no agent-hook subagent). A zero exit alone is not acceptance. Do not run this script from unit tests.


## Known limitations (2026-10-27)

- **Stop uses `decision: block`**, not `additionalContext`. This is deliberate: it is the form proven live in smokes 3 to 6; `additionalContext` is documented only for SessionStart and UserPromptSubmit.
- **Cost per Stop is zero model calls by construction**, enforced by `test_every_hook_is_a_model_free_command` (all hooks are command hooks, `bridge.py` imports no network or subprocess module). The paid smokes (about $1.4 each) are dominated by the session's base context (about 95k cache-creation tokens), so their total says nothing about the plugin itself.
- **`/just-do-it audit` cost is unmeasured.** It is one `$.model.fork` completion; its usage is recorded in the audit telemetry on first use.
- **Real Claude Code maintenance** is proven on fixtures (`repair_fixture.py`, `test_repairs.py`: parse failure, repair, idempotence, concurrent rollback), not yet on a real fault in a live configuration. It never touches security policy.
- **Install rollback** is verified in an isolated `CLAUDE_CONFIG_DIR` (add marketplace, install, list, uninstall, remove marketplace). Updates take effect at the next session start or `/reload-plugins`.
- **State survives separate processes** (`test_state_survives_separate_processes`); resuming after a crash relies on that atomic cache.
