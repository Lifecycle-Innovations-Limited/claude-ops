// bin.mjs — symlink upstream bin/ entries into the user's bin/ directory.
// Two functions:
//   planBinLinks — read-only planner (returns "to apply" records; safe to run repeatedly)
//   applyBinLinks — apply phase (mutates fs)
// Errors as data; no silent swallowing.

import fs from "node:fs";
import path from "node:path";

export function planBinLinks({ srcDir, binPath, binNames, force }) {
  const planned = [];
  const refused = [];
  const errors = [];
  for (const name of binNames) {
    const from = path.join(srcDir, "bin", name);
    const to = path.join(binPath, name);
    let st = null;
    try {
      st = fs.lstatSync(to);
    } catch (_e) {}
    if (!fs.existsSync(from)) {
      errors.push({ name, from, to, reason: "bin entry missing in source" });
      continue;
    }
    if (st) {
      if (st.isSymbolicLink()) {
        const cur = fs.readlinkSync(to);
        if (
          cur === from ||
          cur === from + "/" ||
          cur === from.replace(/\/$/, "")
        ) {
          planned.push({
            op: "skip",
            name,
            from,
            to,
            status: "skipped",
            reason: "already correct",
          });
          continue;
        }
        planned.push({
          op: "symlink",
          name,
          from,
          to,
          status: "planned",
          reason: "replace existing symlink",
        });
        continue;
      }
      if (st.isDirectory() || st.isFile()) {
        // Same rule as skill and plugin links: --force is compatibility-only.
        // A real file or directory is never deleted, even when force is set.
        refused.push({
          name,
          from,
          to,
          status: "OWNERSHIP_CONFLICT",
          status_code: "OWNERSHIP_CONFLICT",
          reason: force
            ? "target is a real file/dir; --force never deletes it (OWNERSHIP_CONFLICT)"
            : "target is a real file/dir not created by the installer (OWNERSHIP_CONFLICT)",
        });
        continue;
      }
    }
    planned.push({ op: "symlink", name, from, to, status: "planned" });
  }
  return { planned, refused, errors };
}

export function applyBinLinks({ binPath, plan, onApply, dryRun }) {
  const results = [];
  // Creating binPath is itself a mutation — on a fresh host this is what brings
  // ~/bin into existence, so it has to sit behind the dryRun guard too.
  if (!dryRun) fs.mkdirSync(binPath, { recursive: true });
  for (const r of plan.planned) {
    if (r.status !== "planned") {
      results.push(r);
      continue;
    }
    if (dryRun) {
      results.push(r);
      continue;
    }
    try {
      let st = null;
      try {
        st = fs.lstatSync(r.to);
      } catch (_e) {}
      if (st && !st.isSymbolicLink()) {
        r.status = "refused";
        r.status_code = "OWNERSHIP_CONFLICT";
        r.error = "target is a real file/dir; refusing to delete it";
        results.push(r);
        continue;
      }
      if (st) fs.unlinkSync(r.to);
      fs.symlinkSync(r.from, r.to);
      if (typeof onApply === "function") onApply(r.to, r.from);
      r.status = "applied";
      results.push(r);
    } catch (e) {
      r.status = "failed";
      r.error = e.message;
      results.push(r);
    }
  }
  return results;
}
