# Skill parity across CLIs

OPS ships one skill tree. Claude Code, Codex, Grok, Cursor and Hermes each load
their own copy of it. This page explains how to check that every CLI loads the
same bytes, what each result means, and how to fix it without losing local work.

- [Quickstart: check an existing setup](#quickstart)
- [Hosts and what is compared](#hosts)
- [Statuses](#statuses) and [exit codes](#exit-codes)
- [Update and retry](#update-and-retry), [partial failures](#partial-failures)
- [Local overlays and exceptions](#local-overlays-and-exceptions)
- [Migration and rollback](#migration-and-rollback)
- [Cursor operator procedure](#cursor-operator-procedure)
- [What you may change, what needs approval, what never changes](#overrides)
- [Research and audit](#research-and-audit)

<a id="quickstart"></a>

## Quickstart: check an existing setup

Needs Node 18 or newer. Nothing is written, fetched or locked.

```bash
ops-update --check
```

Or, from a clone of this repo without npm dependencies:

```bash
node claude-ops/lib/parity/check.mjs                 # reference = the release Claude Code has installed
node installer/bin/claude-ops-installer.mjs check --source claude-installed
```

A clean result looks like this (illustrative: counts and paths differ per machine):

```text
OPS skill parity — reference 3.10.28 @ 6a4340b (release-cache, claude-installed) ~/.claude/plugins/cache/ops-marketplace/ops/current
  claude         MATCH                  134 files byte-identical
  grok           MATCH                  134 files byte-identical
  cursor         MATCH                  134 files byte-identical
  hermes         MATCH                  203 files byte-identical
  codex          NOT_CONFIGURED         no OPS install (not required)
Result: clean (exit 0)
```

A required gap names the problem, what was measured, the cause (or `unknown`),
the smallest safe next step and a link to this page:

```text
  codex          MISSING_REQUIRED       A required host has no OPS install, or its consumer could not be found.
                 basis: no OPS install found at ~/.codex/skills
                 cause: unknown
                 next:  install OPS for codex (docs/skill-parity.md#hosts), or drop codex from "required" in your parity.json
                 docs:  docs/skill-parity.md#status-missing-required
Result: gap (exit 2)
```

Useful flags: `--paths` lists every missing, extra and changed file; `--json`
prints the full report; `--report FILE` also writes it to a file; `--host a,b`
narrows the run for diagnosis (see [NOT_CHECKED](#status-not-checked)).

`ops-update --dry-run` is a different thing: it really pulls the marketplace
catalogue (step 1) and then prints the update plan. Use `--check` when you want
a result that changes nothing.

### Which hosts are required

By default no host is required: a host without an OPS install is
`NOT_CONFIGURED` and does not fail the check. To require hosts, list them in
`~/.config/claude-ops/parity.json` (machine-local, never committed):

```json
{ "required": ["claude", "hermes", "grok", "cursor", "codex"] }
```

or pass `--require claude,hermes,...`. A required host that is missing is
`MISSING_REQUIRED`; it is never installed silently to make the check green.

<a id="hosts"></a>

## Hosts and what is compared

The reference is one plugin root (default: the version Claude Code has
installed, from `installed_plugins.json`; or `--source <dir>`). The check hashes
every file under `skills/` (SKILL.md, references, assets) plus
`.claude-plugin/plugin.json` and compares bytes. Size, mtime and version
strings are never used as proof. `.git`, `__pycache__` and `.ops-manifest` are
excluded on both sides, the same set the sync excludes.

| Host | Where the check looks | How the loaded copy is found | Kind |
|---|---|---|---|
| `claude` | the `installPath` of `ops@ops-marketplace` | Claude Code's `installed_plugins.json` | native |
| `grok` | the `path` of the registry entry that provides plugin `ops` | `~/.grok/installed-plugins/registry.json` | native |
| `cursor` | `~/.cursor/plugins/cache/ops-marketplace/ops/<commit>` | the only commit dir; Cursor's own state names no commit, so two or more dirs are `AMBIGUOUS_CONSUMER` | native |
| `codex` | `~/.codex/skills/<name>` for every shipped skill | each entry, symlink or copy | flat |
| `hermes` | `$HERMES_HOME/plugins/ops` (default `~/.hermes`) | a copy (with bundled `skills/`), a symlink to this release, or a developer checkout | copy / symlink |
| `hermes-skills`, `gemini`, `openclaw`, `opencode` | the installer's flat skill dirs | inventory only unless required | flat |

Install a missing host: Claude Code via the marketplace (`/plugin install
ops@ops-marketplace`); Grok via `grok plugin install`; Codex, Gemini, OpenClaw,
OpenCode and the Hermes skills dir via `claude-ops-installer install --agents
<name>`; the Hermes native plugin via `ops-update` (it copies the release into
`$HERMES_HOME/plugins/ops`).

The check never reads Hermes profile trees, other skill dirs, shell
configuration or secrets. Byte parity is not proof that a CLI actually uses the
skill at runtime; that needs a run of the skill in that CLI.

<a id="statuses"></a>

## Statuses

One table for the check, the installer and the companion sync:
`lib/parity/status.json`. Each status has one class, and the class sets the exit
code.

<a id="status-match"></a>

### MATCH (clean)

Every compared file is byte-identical to the reference. Nothing to do.

<a id="status-exception"></a>

### EXCEPTION (clean)

Every difference is covered by a complete exception record (see
[local overlays](#local-overlays-and-exceptions)). The covered paths are listed
separately from the match.

<a id="status-not-configured"></a>

### NOT_CONFIGURED (clean)

The host has no OPS install and is not required. Make it required if it should
have one.

<a id="status-applied"></a>

### APPLIED (clean)

An update step ran and the result was verified against the reference.

<a id="status-drift"></a>

### DRIFT (drift)

Files are missing, extra or have different bytes. Run with `--paths` to see
them. Fix: `ops-update` for Claude Code, Grok and Hermes; `claude-ops-installer
install --agents <name>` for flat hosts; the [Cursor procedure](#cursor-operator-procedure)
for Cursor. A Hermes copy without a bundled `skills/` dir is DRIFT with the
cause "registers 0 ops skills": the next `ops-update` fixes it.

<a id="status-dev-source"></a>

### DEV_SOURCE (drift)

The Hermes plugin is a symlink into a git checkout that is not the reference
release. It is reported with the checkout path and commit and is never touched.
To move to the release, see [migration](#migration-and-rollback).

<a id="status-missing-required"></a>

### MISSING_REQUIRED (gap)

A required host has no OPS install, or the check could not find what it loads.
Install it (see [hosts](#hosts)) or remove it from `required`.

<a id="status-missing-reference"></a>

### MISSING_REFERENCE (gap)

There is no local reference to compare against: no `--source`, no Claude Code
install, or no installer cache for the requested ref. Nothing is fetched
automatically. Fix: pass `--source <plugin-root>` (or `claude-installed`), or
run the one explicit download step `claude-ops-installer fetch --ref <tag>`,
which writes only the installer cache.

<a id="status-unreadable"></a>

### UNREADABLE (gap)

A target, registry file or symlink exists but could not be read or parsed. The
basis line names the path. Fix the permissions or the broken file.

<a id="status-stale-source"></a>

### STALE_SOURCE (gap)

The installer cache for a moving ref (a branch) holds an older commit than the
ref points at now. The installer keys its cache by commit, so this is detected
with a read-only `git ls-remote` (skip it with `--offline`). Fix:
`claude-ops-installer fetch --ref <ref>`.

<a id="status-stale-scan"></a>

### STALE_SCAN (gap)

The reference or a target changed while it was being compared, for example an
update swapped the directory mid-scan. The result would mix two versions, so it
is not reported as a match. Rerun when no update is running.

<a id="status-ambiguous-consumer"></a>

### AMBIGUOUS_CONSUMER (gap)

There is more than one candidate install (two Cursor commit dirs, two Grok
registry entries for `ops`) and the host's own state does not say which one it
loads. The check does not guess by name or date. Remove the install you do not
use, or reinstall through the host's own plugin command.

<a id="status-not-checked"></a>

### NOT_CHECKED (gap)

`--host` left a required host out of this run. A diagnostic selection never
shrinks the required set, so a narrowed run cannot report "clean" for the whole
machine. Rerun without `--host` for the full result.

<a id="status-missing-command"></a>

### MISSING_COMMAND (gap)

A command needed to verify a target is missing (usually `node`, or a sha256
tool for the Hermes sync). Install it and rerun. This is an environment
problem, not drift and not an auth problem.

<a id="status-unsupported-safe-apply"></a>

### UNSUPPORTED_SAFE_APPLY (gap)

There is no proven way to update this host automatically without risking its
working registration. The previous registration was kept. Today this applies to
Cursor; see the [Cursor procedure](#cursor-operator-procedure).

<a id="status-ownership-conflict"></a>

### OWNERSHIP_CONFLICT (partial)

Applying would overwrite or delete a file OPS does not own: a user file at a
path the release ships, a local edit of an OPS file, or a real file/dir where
the installer wants a symlink. Nothing was changed for that target, and
`--force` does not override it. Move your change to a local overlay outside the
target (see [overlays](#local-overlays-and-exceptions)) or delete it, then rerun.

<a id="status-apply-failed"></a>

### APPLY_FAILED (partial)

An update step failed (native update error, copy or rename failure, update that
did not land the release bytes). The previous registration was kept. The record
names the error; rerun after fixing it. Only that target is retried.

<a id="status-locked"></a>

### LOCKED (locked)

Another OPS run holds the lock for this target root. Locks live in
`${XDG_STATE_HOME:-~/.local/state}/claude-ops/locks`; a lock whose process is
gone is reclaimed automatically. Rerun when the other run finishes.

<a id="exit-codes"></a>

## Exit codes

| Code | Class | Meaning |
|---|---|---|
| 0 | `clean` | Everything matched, or applied and verified |
| 1 | `drift` | Bytes differ, or a target is a developer checkout |
| 2 | `gap` | A required target or the reference is missing, stale or unverifiable |
| 3 | `partial` | Some targets applied, others failed or were refused; failed ones kept their previous state |
| 4 | `usage` | Bad arguments |
| 5 | `environment` | Missing dependency (for example `npm install` not run, or no Node), invalid config, unexpected runtime error |
| 6 | `locked` | Another OPS run holds the target lock |

When several targets differ, the most severe class wins: locked, partial, gap,
drift, clean. `ops-update` keeps its own codes for the upgrade itself (1 fatal,
2 bad argument) and returns 3 when Claude Code was updated but a companion CLI
is not clean; `ops-update --check` returns the check's code.

<a id="update-and-retry"></a>

## Update and retry

`ops-update` updates Claude Code first. Step 10 then runs
`scripts/sync-companion-clis.sh` for Grok, Cursor, Codex and Hermes:

- Every selected target is processed, even after one fails.
- Each target gets one record: status, detail, cause, next step, docs link.
- A failed target keeps its previous registration; targets that succeeded keep
  their result.
- Hermes is copied through a staging dir and swapped in with a rename, after
  validation. Only files listed in the plugin's `.ops-manifest` (with their
  hashes) are ever replaced or removed.
- A repeat run on a target that already matches writes nothing.

To retry only what failed: `ops-update --host hermes` (or run
`scripts/sync-companion-clis.sh --host hermes`). Targets that already match are
not reinstalled.

<a id="partial-failures"></a>

## Partial failures

Example (illustrative): Claude Code updated, Grok updated, Hermes has a local edit.

```text
── 10/11 Sync companion CLIs
  ✓ grok    APPLIED                grok plugin update verified byte-identical
  ✓ cursor  MATCH                  already byte-identical to this release; nothing to apply
  ✓ codex   NOT_CONFIGURED         no ops skills under ~/.codex/skills
  ! hermes  OWNERSHIP_CONFLICT     not applied; files OPS does not own sit at release paths: plugin.yaml (edited);
            cause: a local edit or user file at a path the release ships
            next:  move your edits to a local overlay outside ~/.hermes/plugins/ops (or delete them), then rerun; nothing was changed
            docs:  docs/skill-parity.md#status-ownership-conflict
  companion sync: partial — 1 of 4 target(s) need attention (exit 3). See docs/skill-parity.md
── 11/11  Summary
  companion CLIs:
    grok     APPLIED
    cursor   MATCH
    codex    NOT_CONFIGURED
    hermes   OWNERSHIP_CONFLICT
! upgrade partial: Claude Code is on v3.10.28; companion CLI(s) need attention: hermes (sync exit 3).
```

The upgrade is not rolled back. Fix the named target and rerun.

An older `ops-update` that predates this contract ignores the sync's exit code;
the per-target lines and the `companion sync: partial` line above are still
printed, so the result stays visible.

<a id="local-overlays-and-exceptions"></a>

## Local overlays and exceptions

Machine-specific instructions (routers, private profiles, account names) belong
in your own overlay, not in the files OPS ships:

- Files you add next to OPS files in the Hermes plugin dir survive every sync
  (they are not in `.ops-manifest`).
- Editing a file OPS ships turns the next sync into `OWNERSHIP_CONFLICT` for
  that target. Keep the edit somewhere OPS does not ship to.
- Hermes profile trees and other skill dirs are never read or written by the
  check or the sync.

If a host must differ on purpose, record an exception in
`~/.config/claude-ops/parity.json`. Every field is required; an incomplete
record is ignored and reported as invalid:

```json
{
  "exceptions": [
    {
      "host": "hermes-skills",
      "path": "skills/ops",
      "reason": "local router overlay",
      "owner": "operator",
      "compatibility": "checked against 3.10.x"
    }
  ]
}
```

`path` matches the exact relative path or everything under it. Recheck an
exception whenever OPS, the host's skill discovery or a tool schema changes.

<a id="migration-and-rollback"></a>

## Migration and rollback

Moving a host from a developer checkout or an old layout to the release is a
deliberate step, never part of a check:

1. Back up exactly what will change, for example
   `cp -RP "$HERMES_HOME/plugins/ops" "$HERMES_HOME/plugins-ops.backup"` (a
   symlink is copied as a symlink) and any overlay files you keep inside it.
2. For a developer symlink, remove only the link (`rm "$HERMES_HOME/plugins/ops"`,
   never `rm -r` through it), then run `ops-update --host hermes`.
3. Run `ops-update --check` and confirm the host is `MATCH`.
4. Start the CLI and run one OPS skill to confirm it is actually loaded.

Rollback: restore the backup to the same path (the link or the directory), then
run the check again. Rollback restores only that target's registration; it does
not touch your developer checkout or other plugins. For hosts whose registration
lives in the host's own state (Grok's registry, Cursor's marketplace list), back
up that state file too; restoring the plugin dir alone is not proven to restore
the registration.

<a id="cursor-operator-procedure"></a>

## Cursor operator procedure

Cursor's CLI offers `marketplace add/remove/update` but no way to add a new
version before removing the old one, and its state does not name the commit it
loads. The old automatic remove-then-add could leave Cursor with no ops plugin
when the add failed, so the sync no longer does it (`UNSUPPORTED_SAFE_APPLY`).
To update Cursor yourself:

1. Back up `~/.cursor/plugins/cache/ops-marketplace` and
   `~/.cursor/plugins/marketplaces/github.com/lifecycle-innovations-limited/claude-ops`.
2. `cursor-agent plugin marketplace remove ops-marketplace`
3. `cursor-agent plugin marketplace add https://github.com/Lifecycle-Innovations-Limited/claude-ops`
   — if this fails, restore both backups before doing anything else.
4. Remove commit dirs you do not use from the cache so exactly one remains.
5. `ops-update --check --host cursor` must show `MATCH`.

<a id="overrides"></a>

## What you may change, what needs approval, what never changes

| Setting | Category |
|---|---|
| `required` hosts, `--host` selection for diagnosis, `--paths`/`--json`/`--report` output | safe to change |
| exception records in `parity.json` | safe to change, with all fields filled |
| moving a host from a developer checkout or old layout to the release; removing installs; Cursor re-registration | needs the owner's explicit decision and a backup (see [migration](#migration-and-rollback)) |
| byte comparison (never size/mtime/version); never deleting files OPS does not own; never fetching or writing during a check; one writer per target | never overridable — `--force` does not bypass them |

A diagnostic `--host` selection never reduces the required set.

<a id="research-and-audit"></a>

## Research and audit

The same release ships two research skills that share one contract:
`ops-research` (answer a question with sourced evidence) and
`ops-research-audit` (read-only audit of your search and MCP tooling). See
[ops-research.md](ops-research.md).
