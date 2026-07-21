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
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write(
  `\n${failures === 0 ? "all green" : failures + " failed"}\n`,
);
process.exit(failures === 0 ? 0 : 1);
