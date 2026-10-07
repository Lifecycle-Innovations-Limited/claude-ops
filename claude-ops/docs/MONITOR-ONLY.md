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

Existing invocations without `--monitor-only` retain their prior behavior. The
manager's `--dry-run` is still only a management preview, not this monitor mode.
Do not use manager install/upgrade to deploy this mode without checking that the
resulting service arguments retain `--monitor-only`.

Run the entrypoint safety tests with:

```sh
python3 tests/test-daemon-monitor-only.py
```

The tests run enabled hostile command fixtures, forbidden helper sentinels,
argument-order cases, invalid snapshots, existing-daemon and writer-lock guards,
symlink entrypoints, actual resident refresh and graceful shutdown.
