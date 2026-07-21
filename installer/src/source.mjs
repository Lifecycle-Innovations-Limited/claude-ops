// source.mjs — resolve the upstream source into a local cache directory.
// Default strategy: git clone (shallow) of Lifecycle-Innovations-Limited/claude-ops at the
// pinned ref. Cache key = sha of the ref so re-runs are fast.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

export const CACHE_ROOT = path.join(
  os.homedir(),
  ".cache",
  "claude-ops-installer",
);

function sh(cmd, opts = {}) {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

export function resolveRef(srcDir) {
  try {
    return sh(`git -C "${srcDir}" rev-parse HEAD`);
  } catch (_e) {
    return null;
  }
}

function cacheKey(cfg) {
  const url = cfg.source.url;
  const ref = cfg.source.ref;
  // Hash-ish key from URL + ref. Keep stable across OSes.
  const safe = `${url.replace(/[^a-zA-Z0-9]/g, "_")}__${ref.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  return safe.slice(0, 200);
}

export function ensureSource(cfg) {
  const dir = path.join(CACHE_ROOT, cacheKey(cfg));
  // The marketplace repo nests the actual plugin at <repo>/claude-ops/. That's where skills/ and bin/ live.
  const skillsDir = path.join(dir, "claude-ops", "skills");
  const binDir = path.join(dir, "claude-ops", "bin");
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  if (fs.existsSync(path.join(skillsDir, "ops-inbox", "SKILL.md"))) {
    return {
      dir: path.join(dir, "claude-ops"),
      ref: resolveRef(dir),
      fresh: false,
    };
  }
  if (fs.existsSync(path.join(dir, ".git"))) {
    // Stale partial — try to update.
    try {
      sh(`git -C "${dir}" fetch --depth 1 origin ${cfg.source.ref}`);
      sh(`git -C "${dir}" reset --hard FETCH_HEAD`);
      if (fs.existsSync(path.join(skillsDir, "ops-inbox", "SKILL.md"))) {
        return {
          dir: path.join(dir, "claude-ops"),
          ref: resolveRef(dir),
          fresh: true,
        };
      }
    } catch (e) {
      // fall through to fresh clone
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  const url = cfg.source.url;
  const ref = cfg.source.ref;
  // Shallow clone, then checkout the ref.
  sh(`git clone --depth 1 --no-tags --filter=blob:none "${url}" "${dir}"`);
  try {
    sh(`git -C "${dir}" fetch --depth 1 origin ${ref}`);
    sh(`git -C "${dir}" checkout FETCH_HEAD`);
  } catch (e) {
    throw new Error(`source: failed to fetch ref ${ref}: ${e.message}`);
  }
  if (!fs.existsSync(path.join(skillsDir, "ops-inbox", "SKILL.md"))) {
    throw new Error(
      `source: claude-ops/skills/ops-inbox/SKILL.md not found after fetch at ${ref}`,
    );
  }
  return {
    dir: path.join(dir, "claude-ops"),
    ref: resolveRef(dir),
    fresh: true,
  };
}

export function listSourceSkills(srcDir) {
  const skillsDir = path.join(srcDir, "skills");
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function listSourceBin(srcDir) {
  const binDir = path.join(srcDir, "bin");
  if (!fs.existsSync(binDir)) return [];
  return fs.readdirSync(binDir).sort();
}
