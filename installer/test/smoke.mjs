#!/usr/bin/env node
// Smoke test: verifies the installer's core invariants without touching the user's box.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { listSourceSkills, listSourceBin } from "../src/source.mjs";
import { planBinLinks, applyBinLinks } from "../src/bin.mjs";
import { planMirror } from "../src/mirror.mjs";
import { planAll, planNativePlugin } from "../src/dispatch.mjs";
import { verifyNativePlugin } from "../src/verify.mjs";
import {
  loadManifest,
  saveManifest,
  addSymlink,
  newManifest,
} from "../src/manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "..", "claude-ops"); // installer/../claude-ops

let failures = 0;
function assert(cond, msg) {
  if (cond) process.stdout.write(`OK   ${msg}\n`);
  else {
    process.stdout.write(`FAIL ${msg}\n`);
    failures++;
  }
}

// 1. Default config loads with all 6 agents
const cfg = loadConfig();
assert(cfg && cfg.version === 1, "config loads with version=1");
assert(
  Object.keys(cfg.agents).length === 6,
  `config has 6 agents (got ${Object.keys(cfg.agents).length})`,
);
// Shape, not a literal: pinning the exact tag here means every release breaks
// this test.
assert(
  /^v\d+\.\d+\.\d+$/.test(cfg.source.ref),
  `default source ref is a release tag (got ${cfg.source.ref})`,
);
assert(cfg.agents.gemini.enabled, "gemini enabled by default");

// 2. Source listing — skills dir present
const skills = listSourceSkills(SRC);
const bins = listSourceBin(SRC);
assert(skills.length > 0, `source has ${skills.length} skills`);
assert(bins.length > 0, `source has ${bins.length} bin entries`);
assert(skills.includes("ops-inbox"), "source includes ops-inbox");
assert(bins.includes("ops-inbox-scan"), "source includes ops-inbox-scan");

// 3. Plan + apply round-trip into a scratch dir
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "installer-smoke-"));
try {
  const mirror = planMirror({
    srcDir: SRC,
    targetDir: path.join(scratch, "skills"),
    skillNames: skills,
    force: false,
  });
  const binPlan = planBinLinks({
    srcDir: SRC,
    binPath: path.join(scratch, "bin"),
    binNames: bins,
    force: false,
  });
  assert(
    mirror.actions.length === skills.length,
    `mirror planned ${mirror.actions.length}/${skills.length} skills`,
  );
  assert(
    binPlan.planned.length === bins.length,
    `bin planned ${binPlan.planned.length}/${bins.length}`,
  );

  // Apply both
  const manifest = newManifest();
  const skillResults = [];
  for (const a of mirror.actions) {
    if (a.op === "symlink") {
      try {
        fs.symlinkSync(a.from, a.to);
        addSymlink(manifest, a.to, a.from);
        skillResults.push({ ...a, status: "applied" });
      } catch (e) {
        skillResults.push({ ...a, status: "failed", error: e.message });
      }
    } else {
      skillResults.push(a);
    }
  }
  applyBinLinks({
    binPath: path.join(scratch, "bin"),
    plan: binPlan,
    onApply: (to, from) => addSymlink(manifest, to, from),
  });
  saveManifest(manifest);

  assert(
    manifest.symlinks.length === skills.length + bins.length,
    `manifest recorded ${manifest.symlinks.length} (expected ${skills.length + bins.length})`,
  );
  assert(
    fs.existsSync(path.join(scratch, "skills", "ops-inbox", "SKILL.md")),
    "ops-inbox SKILL.md present in scratch",
  );
  assert(
    fs.existsSync(path.join(scratch, "bin", "ops-inbox-scan")),
    "ops-inbox-scan binstub present in scratch",
  );

  // 4. Detection-gated planning skips undetected agents by default.
  const detectedPath = path.join(scratch, "detected-agent");
  const undetectedPath = path.join(scratch, "undetected-agent");
  const installPlan = planAll({
    cfg: { bin: null },
    srcDir: SRC,
    agents: {
      codex: { installed: true, skillsPath: detectedPath },
      openclaw: { installed: false, skillsPath: undetectedPath },
    },
    force: false,
    dryRun: true,
    skipUndetected: true,
  });
  assert(
    installPlan.agents.openclaw?.skipped &&
      installPlan.agents.openclaw.reason === "not detected",
    "undetected agent is skipped during install planning",
  );
  assert(
    fs.existsSync(detectedPath),
    "detected agent target directory is prepared",
  );
  assert(
    !fs.existsSync(undetectedPath),
    "undetected agent target directory is not created",
  );

  // A plugin path must still be planned when the agent mirrors no skills.
  const pluginOnlyTo = path.join(scratch, "plugin-only", "ops");
  const pluginOnlyPlan = planAll({
    cfg: { bin: null },
    srcDir: SRC,
    agents: {
      hermes: { installed: true, pluginPath: pluginOnlyTo },
    },
    force: false,
    dryRun: true,
    skipUndetected: true,
  });
  assert(
    pluginOnlyPlan.agents.hermes?.skipped &&
      pluginOnlyPlan.agents.hermes.reason === "no skillsPath",
    "agent without skillsPath is still reported as skipped for skills",
  );
  assert(
    pluginOnlyPlan.agents.hermes?.plugin?.action?.op === "symlink",
    "native plugin is planned even when skillsPath is absent",
  );

  const pluginTo = path.join(scratch, "hermes-plugins", "ops");
  const pluginPlan = planNativePlugin({
    srcDir: SRC,
    pluginPath: pluginTo,
    force: false,
  });
  assert(
    !pluginPlan.skipped && pluginPlan.action?.op === "symlink",
    "hermes native plugin symlink is planned",
  );
  assert(
    pluginPlan.action.from.endsWith(`${path.sep}hermes-plugin`) ||
      pluginPlan.action.from.endsWith("/hermes-plugin"),
    "plugin symlink source is hermes-plugin/",
  );

  // 5. verify must catch a native plugin that drifted into a real directory.
  // Regression: verify/doctor checked skills only, so a box running a stale
  // COPY of hermes-plugin (old version, local edits) reported clean while the
  // agent loaded outdated plugin code. Found live 2026-09-05: one host sat on
  // plugin 3.10.1 with a hand-edited __init__.py; every skill verified green.
  const pluginLinked = path.join(scratch, "plugin-linked", "ops");
  fs.mkdirSync(path.dirname(pluginLinked), { recursive: true });
  fs.symlinkSync(path.join(SRC, "hermes-plugin"), pluginLinked);
  const linkedReport = verifyNativePlugin({
    srcDir: SRC,
    agentName: "hermes",
    pluginPath: pluginLinked,
  });
  assert(
    linkedReport.ok === 1 && linkedReport.drifts.length === 0,
    "verifyNativePlugin passes a correct symlink",
  );

  const pluginCopied = path.join(scratch, "plugin-copied", "ops");
  fs.mkdirSync(pluginCopied, { recursive: true });
  fs.writeFileSync(
    path.join(pluginCopied, "plugin.yaml"),
    'version: "0.0.1"\n',
  );
  const copiedReport = verifyNativePlugin({
    srcDir: SRC,
    agentName: "hermes",
    pluginPath: pluginCopied,
  });
  assert(
    copiedReport.drifts.length === 1 &&
      copiedReport.drifts[0].reason.includes("not a symlink"),
    "verifyNativePlugin flags a stale real-directory copy as drift",
  );

  const pluginAbsent = path.join(scratch, "plugin-absent", "ops");
  const absentReport = verifyNativePlugin({
    srcDir: SRC,
    agentName: "hermes",
    pluginPath: pluginAbsent,
  });
  assert(
    absentReport.missing.length === 1,
    "verifyNativePlugin reports an absent plugin link as missing",
  );

  assert(
    verifyNativePlugin({ srcDir: SRC, agentName: "codex", pluginPath: null })
      .skipped === true,
    "verifyNativePlugin skips agents with no plugin path",
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write(
  `\n${failures === 0 ? "all green" : failures + " failed"}\n`,
);
process.exit(failures === 0 ? 0 : 1);
