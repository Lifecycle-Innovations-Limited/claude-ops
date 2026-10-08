# Monitor-only daemon

Use `scripts/ops-daemon.sh --monitor-only` for a passive, local monitor. Add
`--run-once` for one observation cycle. Invoke with Bash 4+ and Python 3 on
macOS or Linux. Keep `ops-daemon.sh` and `ops-daemon-monitor.py` together when
installing a stable copy; a symlink to the shell entrypoint is supported.

```sh
bash scripts/ops-daemon.sh --monitor-only --run-once
```

`OPS_DATA_DIR` selects the existing operator-owned data directory. Without it,
the default is `~/.claude/plugins/data/ops-ops-marketplace`. Do not point it at
the plugin source tree. The monitor reads only `daemon-services.json` and the
previous `daemon-health.json`. Every thirty seconds it atomically writes a
private `daemon-health.json` with:

- `mode: "monitor_only"` and `actions_enabled: false`;
- the monitor's actual PID, timestamp and uptime;
- enabled configured services as `not_started_monitor_only`;
- passive signal-zero liveness observations of previously reported PIDs;
- `identity_verified: false` and `last_health: "unknown"`, since a live PID
  alone does not establish its identity or a working integration;
- an explicit `config_error` when the services configuration is missing or
  invalid. A fresh file is not evidence that all services work.

This mode **does not start the configured services**. It never evaluates their
commands or health checks, schedules their cron jobs, sources legacy helpers,
warm-fetches data, invokes an agent, discovers credentials, sends notifications,
changes advertisements, restarts services or upgrades itself. Read-only vendor
checks and other jobs must be run separately under their existing authorization.

The mode is dispatched before legacy initialization and traps. Combining it
with install, uninstall, OS or other legacy flags fails closed regardless of
argument order. It refuses a symlinked health file or a previous health snapshot
whose daemon PID may still be alive. An exclusive local `.daemon-monitor.lock`
prevents concurrent monitor writers; the lock file is retained and the kernel
releases its lock on exit. SIGTERM/SIGINT stops the monitor without legacy
service cleanup. Only health snapshots, the lock file and temporary atomic-write
files are written locally. No settings, credentials or service definitions are
changed.

Existing invocations without `--monitor-only` retain their prior behavior,
unless the operator has installed the persistent contract below. The manager's
`--dry-run` is still only a management preview, not this monitor mode.

## Persistent macOS mode contract

Service managers and existing data-dir plist guards can repoint the entrypoint.
Do not rely on a launchd flag alone. After backing up the operator-owned wrapper,
install these files without changing the guard:

1. Keep reviewed `ops-daemon.sh` and `ops-daemon-monitor.py` under
   `$OPS_DATA_DIR/runtime/<reviewed-version>/`.
2. Copy `ops-daemon-monitor-selector.py` to `$OPS_DATA_DIR/bin/`.
3. Prepend the complete `ops-daemon-monitor-prefix.sh` to the backed-up
   `$OPS_DATA_DIR/bin/ops-daemon.sh`. Its unconditional selector dispatch must
   precede the entire legacy body; removing a manifest must not enable legacy.
4. Write a private `$OPS_DATA_DIR/daemon-monitor.json` with exactly `mode`
   (`monitor_only`), `runtime` (the absolute reviewed directory) and `sha256`
   (the actual SHA-256 of each of the two runtime files, keyed by filename).
   Never put a command, token or arbitrary executable in this file.
5. Use the updated manager implementation. It validates the contract before
   effects and produces `[bash, data-dir/bin/ops-daemon.sh, --monitor-only]`.
   `ensure-current` skips legacy migrations and preserves that contract;
   `restart` repairs a stale legacy plist before loading it. The unchanged guard
   recognizes the same data-dir wrapper path and leaves it alone.

Missing, malformed, out-of-directory, symlinked or hash-mismatched state is
rejected before legacy execution. The manager also byte-verifies the data-dir
selector against the release's selector and requires the wrapper to begin with
the exact reviewed prefix; an edited entry point is never enabled. An installed data-dir selector is also a
persistent mode marker: the updated manager refuses a missing manifest instead
of rebuilding legacy configuration. The prefix dispatches even without a
launchd mode flag. Reverting mode requires an explicit operator restoration of
both the backed-up wrapper and mode state, not automatic fallback.

The manager's persistent contract is tested only on macOS and fails closed on
other operating systems. Direct passive observations still work on macOS/Linux.
The version-agnostic launcher honors the contract before scanning plugin cache
versions; keep the selector alongside it if deploying that launcher separately.
Older manager or launcher binaries do not understand this contract. Promote the
updated implementation at the actual invoked paths before claiming upgrade
persistence; do not merely change a manifest while leaving older loaders active.

Run the entrypoint safety tests with:

```sh
python3 tests/test-daemon-monitor-only.py
```

The tests run enabled hostile command fixtures, forbidden helper sentinels,
argument-order cases, invalid snapshots, existing-daemon and writer-lock guards,
symlink entrypoints, actual resident refresh and graceful shutdown.
