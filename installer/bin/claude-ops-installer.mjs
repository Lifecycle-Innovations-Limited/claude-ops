#!/usr/bin/env node
// claude-ops-installer — cross-CLI install/verify/doctor for the upstream claude-ops plugin.
// See README.md for usage.
//
// Modules are imported lazily, after help and argument parsing, so `--help`
// and `check --source <dir>` work even when npm dependencies are missing, and
// a missing dependency is reported as an environment problem (exit 5) instead
// of a stack trace.

const USAGE = `claude-ops-installer — cross-CLI installer for the claude-ops plugin

Usage:
  claude-ops-installer <subcommand> [flags]

Subcommands:
  check        Read-only byte parity of OPS skills across Claude Code, Codex,
               Grok, Cursor and Hermes (writes, fetches and locks nothing)
  fetch        Download a release into the installer cache only
  install      Mirror upstream skills + binstubs into each enabled agent
  update       Refresh an existing mirror (alias for install)
  verify       Read-only — symlink layout of each agent's mirror (no fetch)
  doctor       verify + tool checks + env checks (no fetch)
  uninstall    Remove symlinks we created (uses ~/.cache/claude-ops-installer/manifest.json)
  agents       List supported agents and which are detected on this box
  help         This text

Common flags:
  --ref <ref>        Git ref (tag/branch/sha); default from config
  --agents a,b,c     Limit agents touched; default: all enabled
  --dry-run          Print plan, change nothing
  --force            Accepted for compatibility; never deletes a real file/dir
  --json             Emit machine-readable JSON
  --config <path>    Override config path

check flags:
  --source <dir>     Reference plugin root, or "claude-installed"
                     (default: the installer cache for --ref; never fetched)
  --host a,b         Diagnostic selection (required hosts left out: NOT_CHECKED)
  --require a,b      Required hosts (default: "required" in parity.json)
  --parity-config f  parity.json path (required set + exceptions)
  --paths            List every missing/extra/changed path
  --report <file>    Also write the full JSON report to <file>
  --offline          Skip the read-only ls-remote that detects a stale cache

Exit codes: 0 clean, 1 drift, 2 required gap or no reference, 3 partial apply,
            4 usage, 5 environment, 6 locked
Docs: docs/skill-parity.md (in the claude-ops plugin)
Central config: ~/.config/claude-ops-installer/config.yaml
Source of truth: https://github.com/Lifecycle-Innovations-Limited/claude-ops
`;

const VALUE_FLAGS = new Set([
  "--ref",
  "--agents",
  "--config",
  "--source",
  "--host",
  "--require",
  "--parity-config",
  "--report",
]);

function parseFlags(rest) {
  const out = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (VALUE_FLAGS.has(a)) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) {
        out.usageError = `${a} needs a value`;
        return out;
      }
      i++;
      const list = () =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      if (a === "--ref") out.ref = v;
      else if (a === "--agents") out.agents = list();
      else if (a === "--config") out.config = v;
      else if (a === "--source") out.source = v;
      else if (a === "--host") out.hosts = list();
      else if (a === "--require") out.require = list();
      else if (a === "--parity-config") out.parityConfig = v;
      else if (a === "--report") out.report = v;
    } else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--json") out.json = true;
    else if (a === "--paths") out.paths = true;
    else if (a === "--offline") out.offline = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a.startsWith("--")) {
      out.usageError = `unknown flag ${a}`;
      return out;
    } else if (!out.sub) out.sub = a;
    else out._.push(a);
  }
  return out;
}

function environmentError(problem, cause, next) {
  process.stderr.write(
    `claude-ops-installer: environment problem (not a drift, not an auth issue)\n` +
      `  problem: ${problem}\n  cause: ${cause}\n  next: ${next}\n` +
      `  docs: docs/skill-parity.md#exit-codes\n`,
  );
  return 5;
}

async function loadDispatch() {
  try {
    return await import("../src/dispatch.mjs");
  } catch (e) {
    if (e && e.code === "ERR_MODULE_NOT_FOUND") {
      const m = /Cannot find (?:package|module) '([^']+)'/.exec(e.message);
      return {
        envError: environmentError(
          "installer dependencies are not installed",
          `missing module ${m ? m[1] : "unknown"}`,
          "run `npm ci` (or `npm install`) in the installer directory, then rerun. `check --source <dir>` works without them.",
        ),
      };
    }
    throw e;
  }
}

async function main(argv) {
  const flags = parseFlags(argv);
  if (flags.help || flags.sub === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (flags.usageError || !flags.sub) {
    process.stderr.write(
      `${flags.usageError ? `claude-ops-installer: ${flags.usageError}\n\n` : ""}${USAGE}`,
    );
    return 4;
  }
  // check with an explicit source needs no npm dependency at all.
  if (
    flags.sub === "check" &&
    flags.source &&
    flags.source !== "claude-installed" &&
    !flags.ref
  ) {
    const core = await import("../src/parity/check.mjs");
    const args = ["--source", flags.source];
    if (flags.hosts) args.push("--host", flags.hosts.join(","));
    if (flags.require) args.push("--require", flags.require.join(","));
    if (flags.parityConfig) args.push("--config", flags.parityConfig);
    if (flags.report) args.push("--report", flags.report);
    if (flags.json) args.push("--json");
    if (flags.paths) args.push("--paths");
    return core.main(args);
  }
  const d = await loadDispatch();
  if (d.envError !== undefined) return d.envError;
  const table = {
    agents: d.runAgents,
    check: d.runCheck,
    fetch: d.runFetch,
    install: d.runInstall,
    update: d.runUpdate,
    verify: d.runVerify,
    doctor: d.runDoctor,
    uninstall: d.runUninstall,
  };
  const fn = table[flags.sub];
  if (!fn) {
    process.stderr.write(`unknown subcommand: ${flags.sub}\n\n${USAGE}`);
    return 4;
  }
  try {
    return await fn(flags);
  } catch (err) {
    if (err && err.code === "CONFIG_INVALID")
      return environmentError(
        "central config is invalid",
        err.message,
        "fix the YAML at the path named above",
      );
    return environmentError(
      `${flags.sub} failed`,
      err && err.message ? err.message : String(err),
      "rerun with --json; if it repeats, report the message",
    );
  }
}

process.exit(await main(process.argv.slice(2)));
