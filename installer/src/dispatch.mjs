// dispatch.mjs — top-level subcommand handlers. Glues config + detect + source + mirror + bin + verify + doctor + manifest.

import fs from "node:fs";
import path from "node:path";
import { loadConfig, filterAgents, expandHome } from "./config.mjs";
import { detectAll, AGENT_DEFS } from "./detect.mjs";
import { ensureSource, listSourceSkills, listSourceBin } from "./source.mjs";
import { planMirror, applyActions } from "./mirror.mjs";
import { planBinLinks, applyBinLinks } from "./bin.mjs";
import { verifyAgent, verifyNativePlugin } from "./verify.mjs";
import { runDoctor as runDoctorChecks } from "./doctor.mjs";
import {
  loadManifest,
  saveManifest,
  newManifest,
  addSymlink,
  MANIFEST_PATH,
} from "./manifest.mjs";

function pickAgents(cfg, onlyNames) {
  // Build the agents map by combining config + detection.
  const filtered = filterAgents(cfg, onlyNames);
  const detected = detectAll(Object.keys(filtered));
  const byName = Object.fromEntries(detected.map((d) => [d.name, d]));
  const out = {};
  for (const [name, conf] of Object.entries(filtered)) {
    const det = byName[name] || {};
    // Prefer config path if set, else detection.
    const skillsPath = conf.path || conf.flat || det.skillsPath || null;
    out[name] = {
      ...conf,
      cliPath: det.cliPath,
      installed: det.installed,
      skillsPath,
      nested: conf.nested || null,
      pluginPath: conf.plugin || null,
    };
  }
  return out;
}

export function planAll({
  cfg,
  srcDir,
  agents,
  force,
  dryRun,
  skipUndetected = false,
}) {
  const skillNames = listSourceSkills(srcDir);
  const binNames = listSourceBin(srcDir);
  const plan = { agents: {}, bin: null, errors: [] };
  for (const [name, a] of Object.entries(agents)) {
    if (skipUndetected && !a.installed) {
      plan.agents[name] = { skipped: true, reason: "not detected" };
      continue;
    }
    // A native plugin path stands on its own: an agent can take the plugin
    // without mirroring skills, so this must not sit behind the skillsPath gate.
    let entry;
    if (a.skillsPath) {
      entry = planMirror({
        srcDir,
        targetDir: a.skillsPath,
        skillNames,
        force,
        dryRun,
      });
      if (entry.errors.length) plan.errors.push(...entry.errors);
    } else {
      entry = { skipped: true, reason: "no skillsPath" };
    }
    plan.agents[name] = entry;
    if (a.pluginPath) {
      const pluginPlan = planNativePlugin({
        srcDir,
        pluginPath: a.pluginPath,
        force,
      });
      entry.plugin = pluginPlan;
      if (pluginPlan.errors) plan.errors.push(...pluginPlan.errors);
    }
  }
  if (cfg.bin && cfg.bin.path) {
    plan.bin = planBinLinks({
      srcDir,
      binPath: cfg.bin.path,
      binNames,
      force,
    });
    if (plan.bin.refused.length) plan.errors.push(...plan.bin.refused);
    if (plan.bin.errors.length) plan.errors.push(...plan.bin.errors);
  }
  return plan;
}

export function planNativePlugin({ srcDir, pluginPath, force }) {
  const from = path.join(srcDir, "hermes-plugin");
  const to = pluginPath;
  const errors = [];
  if (!pluginPath) {
    return { skipped: true, reason: "no plugin path", errors };
  }
  if (!fs.existsSync(path.join(from, "plugin.yaml"))) {
    return { skipped: true, reason: "hermes-plugin missing", errors };
  }
  let existing = null;
  try {
    existing = fs.lstatSync(to);
  } catch (_e) {
    /* absent */
  }
  if (existing) {
    if (existing.isSymbolicLink()) {
      const cur = fs.readlinkSync(to);
      if (cur === from || cur === from + "/") {
        return {
          skipped: false,
          action: {
            op: "skip",
            from,
            to,
            reason: "already correct",
          },
          errors,
        };
      }
      return {
        skipped: false,
        action: {
          op: "symlink",
          from,
          to,
          reason: "replace existing symlink",
        },
        errors,
      };
    }
    if (!force) {
      errors.push({
        path: to,
        op: "symlink",
        error: "target is real (refused without --force)",
      });
      return {
        skipped: false,
        action: {
          op: "refuse",
          from,
          to,
          reason: "target is a real file/dir; pass --force to overwrite",
        },
        errors,
      };
    }
  }
  return {
    skipped: false,
    action: { op: "symlink", from, to },
    errors,
  };
}

function applyPluginLink(pluginPlan, { dryRun, onApply }) {
  if (!pluginPlan || pluginPlan.skipped || !pluginPlan.action) return;
  const a = pluginPlan.action;
  if (a.op === "skip" || a.op === "refuse") {
    a.status = a.op === "skip" ? "skipped" : "refused";
    return;
  }
  if (a.op !== "symlink" || dryRun) {
    a.status = dryRun ? "planned" : "noop";
    return;
  }
  fs.mkdirSync(path.dirname(a.to), { recursive: true });
  try {
    fs.lstatSync(a.to);
    fs.rmSync(a.to, { recursive: true, force: true });
  } catch (_e) {
    /* absent */
  }
  fs.symlinkSync(a.from, a.to);
  a.status = "applied";
  if (onApply) onApply(a.to, a.from);
}

function applyAll({ plan, dryRun, cfg }) {
  let manifest = loadManifest();
  for (const [name, mirror] of Object.entries(plan.agents)) {
    if (!mirror.skipped) {
      applyActions(mirror.actions, {
        dryRun,
        onApply: (to, from) => addSymlink(manifest, to, from),
      });
    }
    if (mirror.plugin) {
      applyPluginLink(mirror.plugin, {
        dryRun,
        onApply: (to, from) => addSymlink(manifest, to, from),
      });
    }
    // Record every applied symlink in the manifest.
    if (!dryRun && mirror.actions) {
      for (const a of mirror.actions) {
        if (a.status === "applied") {
          try {
            const st = fs.lstatSync(a.to);
            if (st.isSymbolicLink())
              addSymlink(manifest, a.to, fs.readlinkSync(a.to));
          } catch (_e) {
            /* ignore */
          }
        }
      }
    }
  }
  // Apply bin links from plan.bin.planned (which contains from/to + status='planned').
  if (plan.bin && plan.bin.planned) {
    applyBinLinks({
      binPath: cfg.bin.path,
      plan: plan.bin,
      onApply: (to, from) => addSymlink(manifest, to, from),
    });
  }
  if (!dryRun) saveManifest(manifest);
}

function emit(plan, asJson) {
  if (asJson) process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
  else {
    for (const [name, m] of Object.entries(plan.agents)) {
      if (m.skipped) {
        process.stdout.write(`[${name}] skipped: ${m.reason}\n`);
        continue;
      }
      const counts = m.actions.reduce((acc, a) => {
        acc[a.op] = (acc[a.op] || 0) + 1;
        return acc;
      }, {});
      process.stdout.write(`[${name}] ${JSON.stringify(counts)}\n`);
      for (const a of m.actions) {
        const arrow = a.status ? `${a.op}->${a.status}` : a.op;
        process.stdout.write(`  ${arrow}  ${a.skill}\n`);
      }
      if (m.plugin) {
        if (m.plugin.skipped) {
          process.stdout.write(`  plugin skipped: ${m.plugin.reason}\n`);
        } else if (m.plugin.action) {
          const a = m.plugin.action;
          const arrow = a.status ? `${a.op}->${a.status}` : a.op;
          process.stdout.write(`  ${arrow}  plugin ${a.to}\n`);
        }
      }
    }
    if (plan.bin && plan.bin.planned) {
      const applied = plan.bin.planned.filter(
        (r) => r.status === "applied",
      ).length;
      const skipped = plan.bin.planned.filter(
        (r) => r.status === "skipped",
      ).length;
      const failed = plan.bin.planned.filter(
        (r) => r.status === "failed",
      ).length;
      process.stdout.write(
        `[bin] ${plan.bin.planned.length} entries (applied=${applied} skipped=${skipped} failed=${failed})\n`,
      );
      if (plan.bin.refused?.length)
        process.stdout.write(`[bin] refused: ${plan.bin.refused.length}\n`);
      if (plan.bin.errors?.length) {
        process.stdout.write(`[bin] errors:\n`);
        for (const e of plan.bin.errors)
          process.stdout.write(`  ${JSON.stringify(e)}\n`);
      }
    }
  }
}

export async function runAgents(flags) {
  const cfg = loadConfig(flags.config);
  const detected = detectAll();
  const asJson = !!flags.json;
  const rows = detected.map((d) => ({
    name: d.name,
    installed: d.installed,
    cli: d.cliPath || null,
    skills: d.skillsPath || null,
    enabled: !!cfg.agents[d.name]?.enabled,
  }));
  if (asJson) process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  else {
    process.stdout.write(
      "agent        installed  cli                          skills                                  enabled\n",
    );
    for (const r of rows) {
      process.stdout.write(
        `${r.name.padEnd(12)}  ${String(r.installed).padEnd(9)}  ${(r.cli || "-").padEnd(28)}  ${(r.skills || "-").padEnd(38)}  ${r.enabled}\n`,
      );
    }
  }
  return 0;
}

export async function runInstall(flags) {
  const cfg = loadConfig(flags.config);
  if (flags.ref) cfg.source.ref = flags.ref;
  const src = ensureSource(cfg);
  const agents = pickAgents(cfg, flags.agents);
  if (Object.keys(agents).length === 0) {
    process.stderr.write(
      "no agents enabled (run with --agents claude,codex,... to override)\n",
    );
    return 4;
  }
  const plan = planAll({
    cfg,
    srcDir: src.dir,
    agents,
    force: !!flags.force,
    dryRun: !!flags.dryRun,
    skipUndetected: !flags.agents || flags.agents.length === 0,
  });
  applyAll({ plan, dryRun: !!flags.dryRun, cfg });
  emit(plan, !!flags.json);
  const errs = plan.errors || [];
  if (errs.length) {
    process.stderr.write(`\n${errs.length} non-fatal error(s):\n`);
    for (const e of errs) process.stderr.write(`  ${JSON.stringify(e)}\n`);
    return 1;
  }
  return 0;
}

export async function runUpdate(flags) {
  // Same as install — re-mirror.
  return runInstall(flags);
}

export async function runVerify(flags) {
  const cfg = loadConfig(flags.config);
  if (flags.ref) cfg.source.ref = flags.ref;
  const src = ensureSource(cfg);
  const agents = pickAgents(cfg, flags.agents);
  const reports = [];
  for (const [name, a] of Object.entries(agents)) {
    if (a.pluginPath) {
      const p = verifyNativePlugin({
        srcDir: src.dir,
        agentName: `${name}:plugin`,
        pluginPath: a.pluginPath,
      });
      if (!p.skipped) reports.push(p);
    }
    if (!a.skillsPath) {
      reports.push({ name, skipped: true });
      continue;
    }
    reports.push(
      verifyAgent({
        srcDir: src.dir,
        agentName: name,
        targetDir: a.skillsPath,
      }),
    );
  }
  if (flags.json) process.stdout.write(JSON.stringify(reports, null, 2) + "\n");
  else {
    for (const r of reports) {
      if (r.skipped) {
        process.stdout.write(`[${r.name}] skipped\n`);
        continue;
      }
      process.stdout.write(
        `[${r.agent || r.name}] ok=${r.ok} drifts=${r.drifts.length} missing=${r.missing.length}\n`,
      );
      for (const d of r.drifts)
        process.stdout.write(`  drift: ${d.name} — ${d.reason}\n`);
      for (const d of r.missing) process.stdout.write(`  missing: ${d.name}\n`);
    }
  }
  const any = reports.some((r) => r.drifts?.length || r.missing?.length);
  return any ? 1 : 0;
}

export async function runDoctor(flags) {
  const cfg = loadConfig(flags.config);
  if (flags.ref) cfg.source.ref = flags.ref;
  const src = ensureSource(cfg);
  const agents = pickAgents(cfg, flags.agents);
  const out = await runDoctorChecks({ srcDir: src.dir, agents });
  if (flags.json) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  else {
    for (const c of out.checks)
      process.stdout.write(
        `${c.ok ? "OK  " : "FAIL"}  ${c.name.padEnd(28)}  ${c.msg}\n`,
      );
    process.stdout.write(
      `\n${out.failed.length === 0 ? "all green" : out.failed.length + " failed"}\n`,
    );
  }
  return out.ok ? 0 : 1;
}

export async function runUninstall(flags) {
  const m = loadManifest();
  let removed = 0;
  let kept = 0;
  const errors = [];
  for (const s of m.symlinks) {
    let st = null;
    try {
      st = fs.lstatSync(s.to);
    } catch (_e) {}
    if (!st) {
      kept++;
      continue;
    }
    if (!st.isSymbolicLink()) {
      kept++;
      continue;
    }
    try {
      fs.unlinkSync(s.to);
      removed++;
    } catch (e) {
      errors.push({ to: s.to, error: e.message });
    }
  }
  // Empty the manifest only if every entry succeeded.
  if (errors.length === 0) {
    saveManifest(newManifest());
  } else {
    // Keep the manifest with successful removals; drop them.
    const remaining = m.symlinks.filter(
      (s) => !errors.some((e) => e.to === s.to),
    );
    saveManifest({ ...m, symlinks: remaining });
  }
  if (flags.json)
    process.stdout.write(
      JSON.stringify({ removed, kept, errors }, null, 2) + "\n",
    );
  else {
    process.stdout.write(
      `removed: ${removed}\nkept: ${kept}\nerrors: ${errors.length}\n`,
    );
    for (const e of errors) process.stderr.write(`  ${JSON.stringify(e)}\n`);
  }
  return errors.length === 0 ? 0 : 1;
}

export async function runHelp() {
  process.stdout.write("See --help output above.\n");
  return 0;
}
