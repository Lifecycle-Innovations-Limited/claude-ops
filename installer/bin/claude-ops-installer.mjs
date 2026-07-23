#!/usr/bin/env node
// claude-ops-installer — cross-CLI install/verify/doctor for the upstream claude-ops plugin.
// See README.md for usage.

import {
  runHelp,
  runAgents,
  runInstall,
  runUpdate,
  runVerify,
  runDoctor,
  runUninstall,
} from "../src/dispatch.mjs";

const argv = process.argv.slice(2);
const sub = argv[0];

const USAGE = `claude-ops-installer — cross-CLI installer for the claude-ops plugin

Usage:
  claude-ops-installer <subcommand> [flags]

Subcommands:
  install      Mirror upstream skills + binstubs into each enabled agent
  update       Refresh an existing mirror (alias for install)
  verify       Read-only — report drift between upstream and each agent
  doctor       verify + tool checks + env checks
  uninstall    Remove symlinks we created (uses ~/.cache/claude-ops-installer/manifest.json)
  agents       List supported agents and which are detected on this box
  help         This text

Common flags:
  --ref <ref>        Git ref (tag/branch/sha); default from config
  --agents a,b,c     Limit agents touched; default: all enabled
  --dry-run          Print plan, change nothing
  --force            Overwrite a real file/dir at target with a symlink
  --json             Emit machine-readable JSON
  --config <path>    Override config path

Central config: ~/.config/claude-ops-installer/config.yaml
Source of truth: https://github.com/Lifecycle-Innovations-Limited/claude-ops
`;

function parseFlags(rest) {
  const out = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--json") out.json = true;
    else if (a === "--ref") out.ref = rest[++i];
    else if (a === "--agents")
      out.agents = rest[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === "--config") out.config = rest[++i];
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a.startsWith("--")) {
      out[a.slice(2)] = rest[++i];
    } else if (!out.sub) out.sub = a;
    else out._.push(a);
  }
  return out;
}

async function main() {
  // Greedy flag parse so flags can appear before OR after the subcommand.
  const flags = parseFlags(argv);
  if (flags.help || !flags.sub) {
    process.stdout.write(USAGE);
    return flags.sub ? 0 : 1;
  }
  const sub = flags.sub;
  try {
    switch (sub) {
      case "agents":
        return await runAgents(flags);
      case "install":
        return await runInstall(flags);
      case "update":
        return await runUpdate(flags);
      case "verify":
        return await runVerify(flags);
      case "doctor":
        return await runDoctor(flags);
      case "uninstall":
        return await runUninstall(flags);
      default:
        process.stderr.write(`unknown subcommand: ${sub}\n\n${USAGE}`);
        return 4;
    }
  } catch (err) {
    const e = err && err.stack ? err.stack : String(err);
    process.stderr.write(`fatal: ${e}\n`);
    return 1;
  }
}

process.exit(await main());
