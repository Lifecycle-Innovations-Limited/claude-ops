#!/usr/bin/env node
// parity.mjs — installer contract tests for the skill-parity work.
//
// Runs itself in a child process with HOME pointed at a throwaway dir, because
// CACHE_ROOT and the manifest resolve from os.homedir() at import time. Nothing
// here may read or write the real home.
//
// Covered:
//   - the bundled src/parity/ is byte-identical to claude-ops/lib/parity/
//   - check/verify/doctor never fetch, clone or create the cache (snapshot)
//   - a dry-run plan creates no directory
//   - --force on a real dir is OWNERSHIP_CONFLICT and the dir survives apply
//   - the cache key is the resolved SHA; a moved ref is STALE_SOURCE; a failed
//     fetch keeps the cache and names the error class
//   - one writer per target root (LOCKED), stale lock reclaimed
//   - the packed npm artifact works without a sibling checkout: help, check
//     --source, and a clear environment error when dependencies are missing
//   - README exit-code table == status.json

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, "..");
const PLUGIN = path.join(PKG, "..", "claude-ops");

if (!process.env.OPS_INSTALLER_TEST_ISOLATED) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "installer-parity-home-"));
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: path.join(home, ".local", "state"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      OPS_INSTALLER_TEST_ISOLATED: "1",
      OPS_INSTALLER_PARENT_HOME: os.homedir(),
    },
  });
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}

const HOME = os.homedir();
const { planMirror, applyActions } = await import("../src/mirror.mjs");
const { planAll } = await import("../src/dispatch.mjs");
const src = await import("../src/source.mjs");
const { acquireLock } = await import("../src/lock.mjs");
const { STATUS_TABLE } = await import("../src/parity/check.mjs");

let failures = 0;
function assert(cond, msg, detail) {
  if (cond) process.stdout.write(`OK   ${msg}\n`);
  else {
    process.stdout.write(`FAIL ${msg}${detail ? `\n     ${detail}` : ""}\n`);
    failures++;
  }
}

function snapshot(root) {
  const out = [];
  const walk = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (_e) {
      return;
    }
    const extra = st.isSymbolicLink()
      ? fs.readlinkSync(p)
      : st.isFile()
        ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")
        : "";
    out.push(`${path.relative(root, p)}|${st.size}|${st.mtimeMs}|${extra}`);
    if (st.isDirectory())
      for (const c of fs.readdirSync(p).sort()) walk(path.join(p, c));
  };
  walk(root);
  return out.join("\n");
}

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe", ...opts }).trim();
const gitq = (args, cwd) =>
  sh(
    "git",
    [
      "-c",
      "init.defaultBranch=main",
      "-c",
      "user.email=ops-test",
      "-c",
      "user.name=t",
      ...args,
    ],
    { cwd },
  );
const BIN = path.join(PKG, "bin", "claude-ops-installer.mjs");
const runBin = (args, extraEnv = {}, binPath = BIN) =>
  spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });

const work = fs.mkdtempSync(path.join(os.tmpdir(), "installer-parity-"));

// A tiny upstream repo shaped like claude-ops.
function makeUpstream(dir) {
  const files = {
    "claude-ops/.claude-plugin/plugin.json":
      '{"name":"ops","version":"9.9.9"}\n',
    "claude-ops/skills/ops-inbox/SKILL.md": "inbox\n",
    "claude-ops/skills/ops/SKILL.md": "router\n",
    "claude-ops/bin/ops-inbox-scan": "#!/bin/sh\n",
    "claude-ops/hermes-plugin/plugin.yaml": 'name: ops\nversion: "9.9.9"\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  gitq(["init", "-q"], dir);
  gitq(["add", "-A"], dir);
  gitq(["commit", "-q", "-m", "v1"], dir);
  return dir;
}

try {
  // 0. Class fix for the 2026-10-08 incident (smoke.mjs overwrote the real
  // installer manifest). Neither installer test may write under the HOME it
  // was started with: run smoke.mjs with a sentinel HOME standing in for the
  // real one and require that sentinel to be byte-identical afterwards.
  assert(
    process.env.OPS_INSTALLER_PARENT_HOME &&
      HOME !== process.env.OPS_INSTALLER_PARENT_HOME,
    "parity.mjs itself runs under an isolated HOME, not the caller's",
  );
  const sentinel = fs.mkdtempSync(
    path.join(os.tmpdir(), "installer-real-home-"),
  );
  fs.mkdirSync(path.join(sentinel, ".cache", "claude-ops-installer"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(sentinel, ".cache", "claude-ops-installer", "manifest.json"),
    '{"version":1,"symlinks":[]}\n',
  );
  const sentinelBefore = snapshot(sentinel);
  const smokeEnv = { ...process.env, HOME: sentinel };
  delete smokeEnv.OPS_INSTALLER_TEST_ISOLATED;
  delete smokeEnv.XDG_STATE_HOME;
  delete smokeEnv.XDG_CONFIG_HOME;
  const smokeRun = spawnSync(process.execPath, [path.join(HERE, "smoke.mjs")], {
    encoding: "utf8",
    env: smokeEnv,
  });
  assert(
    smokeRun.status === 0,
    "smoke.mjs passes when started from a sentinel HOME",
    smokeRun.stdout.slice(-400),
  );
  assert(
    snapshot(sentinel) === sentinelBefore,
    "smoke.mjs writes nothing under the HOME it was started with (manifest untouched)",
  );
  fs.rmSync(sentinel, { recursive: true, force: true });

  // 1. Bundled parity core is the canonical one.
  if (fs.existsSync(path.join(PLUGIN, "lib", "parity", "check.mjs"))) {
    for (const f of ["check.mjs", "status.json"]) {
      const a = fs.readFileSync(path.join(PKG, "src", "parity", f));
      const b = fs.readFileSync(path.join(PLUGIN, "lib", "parity", f));
      assert(
        a.equals(b),
        `src/parity/${f} is byte-identical to claude-ops/lib/parity/${f} (run npm run sync-parity)`,
      );
    }
  } else {
    process.stdout.write(
      "NOTE sibling claude-ops/ absent; bundle equality checked in the repo only\n",
    );
  }

  // 2. Read-only commands never fetch or create the cache.
  const cfgDir = path.join(work, "cfg");
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgFile = path.join(cfgDir, "config.yaml");
  fs.writeFileSync(
    cfgFile,
    `version: 1\nsource:\n  type: git\n  url: ${path.join(work, "does-not-exist")}\n  ref: ${"a".repeat(40)}\nagents:\n  codex: { enabled: true, type: flat, path: ${path.join(work, "codex-skills")} }\n`,
  );
  const before = snapshot(HOME);
  for (const sub of ["check", "verify", "doctor"]) {
    const r = runBin([sub, "--config", cfgFile, "--offline"]);
    assert(
      r.status === 2 && /MISSING_REFERENCE/.test(r.stdout + r.stderr),
      `${sub} without a cached source is MISSING_REFERENCE (exit 2) and names the fetch step`,
      `status=${r.status} ${r.stdout}${r.stderr}`,
    );
  }
  assert(
    snapshot(HOME) === before,
    "check/verify/doctor leave HOME byte-identical (no cache dir, no clone)",
  );
  const dsrc = fs.readFileSync(path.join(PKG, "src", "dispatch.mjs"), "utf8");
  for (const fn of ["runVerify", "runDoctor", "runCheck"]) {
    const body = dsrc.slice(
      dsrc.indexOf(`export async function ${fn}(`),
      dsrc.indexOf(
        "\nexport async function",
        dsrc.indexOf(`export async function ${fn}(`) + 10,
      ),
    );
    assert(!/ensureSource\(/.test(body), `${fn} never calls ensureSource`);
  }

  // 3. Dry-run planning creates nothing.
  const upstream = makeUpstream(path.join(work, "upstream"));
  const SRC = path.join(upstream, "claude-ops");
  const target = path.join(work, "agent", "skills");
  const plan = planMirror({
    srcDir: SRC,
    targetDir: target,
    skillNames: ["ops", "ops-inbox"],
    force: false,
    dryRun: true,
  });
  applyActions(plan.actions, { dryRun: true });
  assert(
    !fs.existsSync(path.join(work, "agent")),
    "a dry-run plan + apply creates no directory",
  );
  const all = planAll({
    cfg: { bin: null },
    srcDir: SRC,
    agents: { codex: { installed: true, skillsPath: target } },
    force: false,
    dryRun: true,
  });
  assert(
    all.agents.codex.actions.length === 2 && !fs.existsSync(target),
    "planAll dry-run creates nothing",
  );

  // 4. --force never deletes a real dir.
  fs.mkdirSync(path.join(target, "ops-inbox"), { recursive: true });
  fs.writeFileSync(path.join(target, "ops-inbox", "mine.md"), "user edit\n");
  const forced = planMirror({
    srcDir: SRC,
    targetDir: target,
    skillNames: ["ops", "ops-inbox"],
    force: true,
  });
  const act = forced.actions.find((a) => a.skill === "ops-inbox");
  assert(
    act.op === "refuse" && act.status_code === "OWNERSHIP_CONFLICT",
    "--force on a real dir plans OWNERSHIP_CONFLICT",
  );
  const res = applyActions(forced.actions, { dryRun: false });
  assert(
    fs.readFileSync(path.join(target, "ops-inbox", "mine.md"), "utf8") ===
      "user edit\n",
    "the user-owned dir survives the apply",
  );
  assert(
    res.find((r) => r.skill === "ops").status === "applied",
    "other skills still apply",
  );

  // 5. SHA-keyed cache, moving ref, failed fetch keeps cache.
  const cfg = { source: { url: upstream, ref: "main" } };
  const first = src.ensureSource(cfg);
  const sha1 = gitq(["rev-parse", "HEAD"], upstream);
  assert(
    first.ref === sha1 && first.dir.includes(sha1),
    "cache dir is keyed by the resolved SHA, not the ref name",
  );
  assert(
    src.findCachedSource(cfg).status === "ok",
    "findCachedSource finds the SHA dir through the ref pointer",
  );
  fs.writeFileSync(
    path.join(upstream, "claude-ops", "skills", "ops", "SKILL.md"),
    "router v2\n",
  );
  gitq(["commit", "-qam", "v2"], upstream);
  const sha2 = gitq(["rev-parse", "HEAD"], upstream);
  const stale = src.findCachedSource(cfg, {
    remote: src.remoteSha(upstream, "main"),
  });
  assert(
    stale.status === "STALE_SOURCE" && stale.cause.includes(sha2.slice(0, 12)),
    "a cache for a ref that moved is STALE_SOURCE",
  );
  const second = src.ensureSource(cfg);
  assert(
    second.ref === sha2 && fs.existsSync(first.dir),
    "a new SHA gets its own dir; the old cache is not deleted",
  );
  fs.renameSync(upstream, `${upstream}.gone`);
  const offline = src.ensureSource(cfg);
  assert(
    offline.dir === second.dir &&
      /REMOTE_UNREACHABLE/.test(offline.warning || ""),
    "an unreachable remote keeps the cache and names the error class",
    JSON.stringify(offline),
  );
  fs.renameSync(`${upstream}.gone`, upstream);

  // 6. Locks.
  const root = path.join(work, "locked-root");
  const l1 = acquireLock(root);
  const l2 = acquireLock(root);
  assert(
    !l1.locked && l2.locked,
    "a second writer on the same target root is LOCKED",
  );
  l1.release();
  assert(!acquireLock(root).locked, "the lock is free after release");
  const l3dir = acquireLock(root).dir; // held by us; fake a dead pid
  fs.writeFileSync(path.join(l3dir, "pid"), "999999\n");
  const l4 = acquireLock(root);
  assert(!l4.locked, "a lock whose pid is gone is reclaimed");
  l4.release();

  // 7. Packed artifact works without a sibling checkout.
  const packDir = path.join(work, "pack");
  fs.mkdirSync(packDir);
  const packed = JSON.parse(
    sh("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: PKG }),
  );
  const files = packed[0].files.map((f) => f.path);
  assert(
    files.includes("src/parity/check.mjs") &&
      files.includes("src/parity/status.json"),
    "the npm artifact ships the parity core",
  );
  const unpack = path.join(work, "unpacked");
  fs.mkdirSync(unpack);
  sh("tar", ["-xzf", path.join(packDir, packed[0].filename), "-C", unpack]);
  const pkgBin = path.join(
    unpack,
    "package",
    "bin",
    "claude-ops-installer.mjs",
  );
  assert(
    !fs.existsSync(path.join(unpack, "claude-ops")),
    "no sibling claude-ops/ next to the unpacked artifact",
  );
  const help = runBin(["--help"], {}, pkgBin);
  assert(
    help.status === 0 && /check\s+Read-only/.test(help.stdout),
    "packed --help exits 0 without node_modules",
  );
  const chk = runBin(
    ["check", "--source", SRC, "--json", "--host", "codex"],
    {},
    pkgBin,
  );
  let parsed = null;
  try {
    parsed = JSON.parse(chk.stdout);
  } catch (_e) {
    /* reported below */
  }
  assert(
    parsed &&
      parsed.reference.ok &&
      typeof parsed.aggregate.exit_code === "number" &&
      chk.status === parsed.aggregate.exit_code,
    "packed check --source runs without node_modules and exits with its aggregate code",
    `status=${chk.status} ${chk.stderr}`,
  );
  const env = runBin(["verify"], {}, pkgBin);
  assert(
    env.status === 5 &&
      /environment problem/.test(env.stderr) &&
      /js-yaml/.test(env.stderr),
    "packed verify without dependencies is an environment error (exit 5) naming the module",
    `status=${env.status} ${env.stderr}`,
  );

  // 8. CLI usage codes.
  assert(runBin([]).status === 4, "no subcommand is a usage error (exit 4)");
  assert(
    runBin(["--nope"]).status === 4,
    "an unknown flag is a usage error (exit 4)",
  );
  assert(runBin(["help"]).status === 0, "help exits 0");

  // 9. README exit table matches status.json.
  const readme = fs.readFileSync(path.join(PKG, "README.md"), "utf8");
  const rows = [...readme.matchAll(/^\|\s*(\d)\s*\|\s*`([a-z]+)`\s*\|/gm)].map(
    (m) => [m[2], Number(m[1])],
  );
  assert(
    JSON.stringify(Object.fromEntries(rows)) ===
      JSON.stringify(STATUS_TABLE.exit_codes),
    "installer README exit-code table equals status.json",
    JSON.stringify(rows),
  );
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

process.stdout.write(
  `\n${failures === 0 ? "all green" : failures + " failed"}\n`,
);
process.exit(failures === 0 ? 0 : 1);
