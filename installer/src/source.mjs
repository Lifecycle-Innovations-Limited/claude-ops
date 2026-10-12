// source.mjs — resolve the upstream source into a local cache directory.
//
// The cache key is the RESOLVED commit SHA, never the ref name: a cache for
// "main" made last week is not the current "main". A small pointer file
// (refs/<ref>.json) remembers which SHA a ref resolved to, so read-only
// commands can find an existing cache without touching the network or disk.
//
//   ensureSource  — the only function that writes (fetch/clone); used by
//                   install/update/fetch. A failed fetch keeps any valid cache
//                   and reports the error class; it never deletes a cache.
//   findCachedSource — pure lookup for check/verify/doctor; never fetches.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const CACHE_ROOT = path.join(
  os.homedir(),
  ".cache",
  "claude-ops-installer",
);
const MARKER = path.join("claude-ops", "skills", "ops-inbox", "SKILL.md");
const FETCH_TIMEOUT_MS = 120000;

function git(args, opts = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: FETCH_TIMEOUT_MS,
    ...opts,
  }).trim();
}

export function resolveRef(srcDir) {
  try {
    return git(["-C", srcDir, "rev-parse", "HEAD"]);
  } catch (_e) {
    return null;
  }
}

export function isSha(ref) {
  return /^[0-9a-f]{40}$/.test(ref || "");
}

function safe(s) {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

function urlKey(url) {
  return safe(url);
}

export function shaDir(url, sha) {
  return path.join(CACHE_ROOT, `${urlKey(url)}__${sha}`);
}

function pointerPath(url, ref) {
  return path.join(CACHE_ROOT, "refs", `${urlKey(url)}__${safe(ref)}.json`);
}

function hasMarker(dir) {
  return fs.existsSync(path.join(dir, MARKER));
}

// Network read only (no disk write): what does <ref> point at upstream right now?
export function remoteSha(url, ref) {
  if (isSha(ref)) return { sha: ref };
  try {
    const out = git(["ls-remote", url, ref, `${ref}^{}`]);
    const lines = out.split("\n").filter(Boolean);
    // Annotated tags list the tag object first and the peeled commit as ^{}.
    const peeled = lines.find((l) => l.endsWith("^{}"));
    const line = peeled || lines[0];
    if (!line) return { sha: null, errorClass: "REF_NOT_FOUND" };
    return { sha: line.split(/\s+/)[0] };
  } catch (e) {
    return { sha: null, errorClass: "REMOTE_UNREACHABLE", error: e.message };
  }
}

// Pure lookup. Returns { dir, sha, ref, status } where status is one of
// "ok" | "MISSING_REFERENCE" | "STALE_SOURCE". `remote` (optional) is the
// result of remoteSha() — passing it lets the caller detect a moving ref
// without this function doing any I/O beyond reads.
export function findCachedSource(cfg, { remote } = {}) {
  const { url, ref } = cfg.source;
  let sha = isSha(ref) ? ref : null;
  if (!sha) {
    try {
      sha = JSON.parse(fs.readFileSync(pointerPath(url, ref), "utf8")).sha;
    } catch (_e) {
      return {
        status: "MISSING_REFERENCE",
        ref,
        cause: `no cached source for ${ref}`,
      };
    }
  }
  const dir = shaDir(url, sha);
  if (!hasMarker(dir))
    return {
      status: "MISSING_REFERENCE",
      ref,
      sha,
      cause: `cache dir for ${sha.slice(0, 12)} is missing or incomplete`,
    };
  const out = { status: "ok", dir: path.join(dir, "claude-ops"), sha, ref };
  if (remote && remote.sha && remote.sha !== sha) {
    out.status = "STALE_SOURCE";
    out.cause = `${ref} now resolves to ${remote.sha.slice(0, 12)}, cache holds ${sha.slice(0, 12)}`;
  }
  if (remote && !remote.sha) out.remoteError = remote.errorClass;
  return out;
}

export function ensureSource(cfg) {
  const { url, ref } = cfg.source;
  fs.mkdirSync(path.join(CACHE_ROOT, "refs"), { recursive: true });
  const remote = remoteSha(url, ref);
  if (!remote.sha) {
    // Offline or unknown ref: keep using what we have, but say so.
    const cached = findCachedSource(cfg);
    if (cached.status === "ok")
      return {
        dir: cached.dir,
        ref: cached.sha,
        fresh: false,
        warning: `${remote.errorClass}: using cached ${cached.sha.slice(0, 12)} for ${ref}`,
      };
    const e = new Error(
      `source: cannot resolve ${ref} (${remote.errorClass}) and no cache exists`,
    );
    e.code = "SOURCE_UNAVAILABLE";
    e.errorClass = remote.errorClass;
    throw e;
  }
  const writePointer = (sha) =>
    fs.writeFileSync(
      pointerPath(url, ref),
      JSON.stringify({ sha, resolved_at: new Date().toISOString() }) + "\n",
    );
  const known = shaDir(url, remote.sha);
  if (hasMarker(known)) {
    writePointer(remote.sha);
    return {
      dir: path.join(known, "claude-ops"),
      ref: remote.sha,
      fresh: false,
    };
  }
  // Fetch into a temp dir next to the cache and rename into place, so an
  // interrupted fetch never leaves a half-populated SHA dir behind. The final
  // key is the commit actually fetched (the ref may move after ls-remote).
  const tmp = fs.mkdtempSync(path.join(CACHE_ROOT, ".fetch-"));
  let fetched;
  try {
    git(["init", "-q", tmp]);
    git(["-C", tmp, "remote", "add", "origin", url]);
    git(["-C", tmp, "fetch", "-q", "--depth", "1", "--no-tags", "origin", ref]);
    git(["-C", tmp, "checkout", "-q", "FETCH_HEAD"]);
    fetched = git(["-C", tmp, "rev-parse", "HEAD"]);
    if (!hasMarker(tmp))
      throw new Error(`${MARKER} not found at ${fetched.slice(0, 12)}`);
    const dir = shaDir(url, fetched);
    if (hasMarker(dir)) fs.rmSync(tmp, { recursive: true, force: true });
    else fs.renameSync(tmp, dir);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const err = new Error(`source: failed to fetch ${ref}: ${e.message}`);
    err.code = "SOURCE_UNAVAILABLE";
    err.errorClass = "FETCH_FAILED";
    throw err;
  }
  writePointer(fetched);
  return {
    dir: path.join(shaDir(url, fetched), "claude-ops"),
    ref: fetched,
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
