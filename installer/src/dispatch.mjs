// dispatch.mjs — top-level subcommand handlers. Glues config + detect + source + mirror + bin + verify + doctor + manifest.

import fs from "node:fs";
import path from "node:path";
import { loadConfig, filterAgents, expandHome } from "./config.mjs";
import { detectAll, AGENT_DEFS } from "./detect.mjs";
import {
  ensureSource,
  findCachedSource,
  remoteSha,
  isSha,
  listSourceSkills,
  listSourceBin,
} from "./source.mjs";
import { acquireLock } from "./lock.mjs";
import {
  checkTargets,
  formatText,
  makeRecord,
  finish,
  exitCodeFor,
  envPaths,
} from "./parity/check.mjs";
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
    errors.push({
      path: to,
      op: "symlink",
      status: "OWNERSHIP_CONFLICT",
      error: "target is a real file/dir not created by the installer",
    });
    return {
      skipped: false,
      action: {
        op: "refuse",
        from,
        to,
        status_code: "OWNERSHIP_CONFLICT",
        reason: force
          ? "target is a real file/dir; --force never deletes it (OWNERSHIP_CONFLICT)"
          : "target is a real file/dir not created by the installer (OWNERSHIP_CONFLICT)",
      },
      errors,
    };
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
  let st = null;
  try {
    st = fs.lstatSync(a.to);
  } catch (_e) {
    /* absent */
  }
  if (st && !st.isSymbolicLink()) {
    a.status = "refused";
    a.status_code = "OWNERSHIP_CONFLICT";
    return;
  }
  if (st) fs.unlinkSync(a.to);
  fs.symlinkSync(a.from, a.to);
  a.status = "applied";
  if (onApply) onApply(a.to, a.from);
}

function applyAll({ plan, dryRun, cfg }) {
  let manifest = loadManifest();
  for (const [name, mirror] of Object.entries(plan.agents)) {
    // One writer per target root. Dry runs take no lock (they write nothing).
    const roots = [];
    if (!mirror.skipped && mirror.actions?.length)
      roots.push(path.dirname(mirror.actions[0].to));
    if (mirror.plugin?.action) roots.push(mirror.plugin.action.to);
    const held = [];
    let blocked = null;
    if (!dryRun) {
      for (const r of roots) {
        const l = acquireLock(r);
        if (l.locked) {
          blocked = l;
          break;
        }
        held.push(l);
      }
    }
    if (blocked) {
      for (const l of held) l.release();
      mirror.locked = { dir: blocked.dir, pid: blocked.pid };
      plan.errors.push({
        agent: name,
        status: "LOCKED",
        error: `another OPS run holds ${blocked.dir}`,
      });
      continue;
    }
    try {
      if (!mirror.skipped) {
        mirror.results = applyActions(mirror.actions, {
          dryRun,
          onApply: (to, from) => addSymlink(manifest, to, from),
        });
        for (const r of mirror.results)
          if (r.op === "symlink" && r.status === "refused")
            plan.errors.push({
              agent: name,
              path: r.to,
              status: r.status_code,
              error: "refused at apply time",
            });
      }
      if (mirror.plugin) {
        applyPluginLink(mirror.plugin, {
          dryRun,
          onApply: (to, from) => addSymlink(manifest, to, from),
        });
      }
    } finally {
      for (const l of held) l.release();
    }
  }
  // Apply bin links from plan.bin.planned (which contains from/to + status='planned').
  if (plan.bin && plan.bin.planned) {
    applyBinLinks({
      binPath: cfg.bin.path,
      plan: plan.bin,
      dryRun,
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
      const rows = m.results || m.actions;
      if (m.locked) process.stdout.write(`[${name}] LOCKED: ${m.locked.dir}\n`);
      const counts = rows.reduce((acc, a) => {
        acc[a.op] = (acc[a.op] || 0) + 1;
        return acc;
      }, {});
      process.stdout.write(`[${name}] ${JSON.stringify(counts)}\n`);
      for (const a of rows) {
        const arrow = a.status ? `${a.op}->${a.status}` : a.op;
        const code = a.status_code ? ` (${a.status_code})` : "";
        process.stdout.write(`  ${arrow}  ${a.skill}${code}\n`);
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

function sourceError(e) {
  const rec = makeRecord("reference", "MISSING_REFERENCE", {
    required: true,
    basis: "installer source fetch",
    cause: `${e.errorClass || "unknown"}: ${e.message}`,
    next: "check network access to the source URL, or pass --ref <tag>",
  });
  process.stderr.write(
    `source unavailable\n  problem: ${rec.error.problem}\n  cause: ${rec.error.cause}\n  next: ${rec.error.next}\n  docs: ${rec.docs}\n`,
  );
  return exitCodeFor("gap");
}

export async function runInstall(flags) {
  const cfg = loadConfig(flags.config);
  if (flags.ref) cfg.source.ref = flags.ref;
  let src;
  try {
    src = ensureSource(cfg);
  } catch (e) {
    if (e.code === "SOURCE_UNAVAILABLE") return sourceError(e);
    throw e;
  }
  if (src.warning) process.stderr.write(`warning: ${src.warning}\n`);
  const agents = pickAgents(cfg, flags.agents);
  if (Object.keys(agents).length === 0) {
    process.stderr.write(
      "no agents enabled (run with --agents claude,codex,... to override)\n",
    );
    return exitCodeFor("usage");
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
    process.stderr.write(`\n${errs.length} target(s) not applied:\n`);
    for (const e of errs) process.stderr.write(`  ${JSON.stringify(e)}\n`);
    process.stderr.write(
      "  docs: docs/skill-parity.md#status-ownership-conflict\n",
    );
    const onlyLocked = errs.every((e) => e.status === "LOCKED");
    return exitCodeFor(onlyLocked ? "locked" : "partial");
  }
  return 0;
}

export async function runUpdate(flags) {
  // Same as install — re-mirror.
  return runInstall(flags);
}

// Pure: resolves the cached source for the configured ref without fetching,
// cloning or creating anything. Missing cache -> MISSING_REFERENCE (exit 2).
function cachedSourceOrRecord(cfg, flags) {
  if (flags.source && flags.source !== "claude-installed")
    return { dir: flags.source };
  const remote =
    flags.offline || isSha(cfg.source.ref)
      ? null
      : remoteSha(cfg.source.url, cfg.source.ref);
  const c = findCachedSource(cfg, { remote });
  if (c.status === "MISSING_REFERENCE") {
    return {
      record: makeRecord("reference", "MISSING_REFERENCE", {
        required: true,
        basis: `installer cache for ${cfg.source.ref}`,
        cause: c.cause,
        next: `run \`claude-ops-installer fetch --ref ${cfg.source.ref}\` (writes only the installer cache), or pass --source <plugin-root>`,
      }),
    };
  }
  return c;
}

function printRecordAndExit(rec, asJson) {
  if (asJson)
    process.stdout.write(
      JSON.stringify({ records: [rec], aggregate: finish([rec]) }, null, 2) +
        "\n",
    );
  else
    process.stdout.write(
      `[${rec.target}] ${rec.status}\n  problem: ${rec.error.problem}\n  basis: ${rec.error.basis}\n  cause: ${rec.error.cause}\n  next: ${rec.error.next}\n  docs: ${rec.docs}\n`,
    );
  return finish([rec]).exit_code;
}

export async function runVerify(flags) {
  const cfg = loadConfig(flags.config);
  if (flags.ref) cfg.source.ref = flags.ref;
  const src = cachedSourceOrRecord(cfg, { ...flags, offline: true });
  if (src.record) return printRecordAndExit(src.record, flags.json);
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
    process.stdout.write(
      "(symlink layout only; for byte-level parity across every CLI run `claude-ops-installer check`)\n",
    );
  }
  const any = reports.some((r) => r.drifts?.length || r.missing?.length);
  return any ? exitCodeFor("drift") : 0;
}

export async function runDoctor(flags) {
  const cfg = loadConfig(flags.config);
  if (flags.ref) cfg.source.ref = flags.ref;
  const src = cachedSourceOrRecord(cfg, { ...flags, offline: true });
  if (src.record) return printRecordAndExit(src.record, flags.json);
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
  return out.ok ? 0 : exitCodeFor("drift");
}

// Byte-level parity across every CLI (shared check core). Never fetches or
// writes; a moving --ref only costs a read-only `git ls-remote` so a stale
// cache is reported as STALE_SOURCE (skip that with --offline).
export async function runCheck(flags) {
  const cfg = loadConfig(flags.config);
  if (flags.ref) cfg.source.ref = flags.ref;
  let source;
  const extra = [];
  if (flags.source === "claude-installed") source = undefined;
  else if (flags.source) source = flags.source;
  else {
    const c = cachedSourceOrRecord(cfg, flags);
    if (c.record) return printRecordAndExit(c.record, flags.json);
    source = c.dir;
    if (c.status === "STALE_SOURCE")
      extra.push(
        makeRecord("reference", "STALE_SOURCE", {
          required: true,
          basis: `installer cache for ${cfg.source.ref}`,
          cause: c.cause,
        }),
      );
  }
  const report = checkTargets({
    source,
    hosts: flags.hosts,
    required: flags.require,
    configPath: flags.parityConfig,
  });
  report.records.unshift(...extra);
  report.aggregate = finish(report.records);
  if (flags.report)
    fs.writeFileSync(flags.report, JSON.stringify(report, null, 2) + "\n");
  if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else
    process.stdout.write(
      formatText(report, { paths: flags.paths, home: envPaths().home }),
    );
  return report.aggregate.exit_code;
}

// The one explicit, named step that puts a release into the installer's own
// cache dir. Touches nothing else.
export async function runFetch(flags) {
  const cfg = loadConfig(flags.config);
  if (flags.ref) cfg.source.ref = flags.ref;
  let src;
  try {
    src = ensureSource(cfg);
  } catch (e) {
    if (e.code === "SOURCE_UNAVAILABLE") return sourceError(e);
    throw e;
  }
  if (src.warning) process.stderr.write(`warning: ${src.warning}\n`);
  const out = {
    ref: cfg.source.ref,
    sha: src.ref,
    dir: src.dir,
    fresh: src.fresh,
  };
  if (flags.json) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  else
    process.stdout.write(
      `fetched ${cfg.source.ref} -> ${src.ref}\n  ${src.dir}${src.fresh ? "" : " (already cached)"}\n`,
    );
  return 0;
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
