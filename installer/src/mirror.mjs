// mirror.mjs — plan and apply the skill symlinks. Errors as data.
//
// planMirror is pure: it never creates the target dir (a dry run used to
// mkdir it). The installer only ever owns SYMLINKS it created; a real file or
// directory at a target path belongs to someone else, so it is reported as
// OWNERSHIP_CONFLICT and never removed — not even with --force.

import fs from "node:fs";
import path from "node:path";

export function planMirror({
  srcDir,
  targetDir,
  skillNames,
  force,
  dryRun,
  mode = "flat",
}) {
  // mode = 'flat' for normal agents, 'hybrid' for Hermes (which may also write into nested).
  // Returns: { actions: [{op: 'symlink'|'skip'|'refuse'|'error', skill, from, to, reason?}], errors: [] }
  const actions = [];
  const errors = [];

  for (const name of skillNames) {
    const from = path.join(srcDir, "skills", name);
    const to = path.join(targetDir, name);
    if (!fs.existsSync(from)) {
      const a = {
        op: "error",
        skill: name,
        from,
        to,
        reason: "source skill missing",
      };
      actions.push(a);
      errors.push({
        agent: targetDir,
        path: from,
        op: "read",
        error: "source skill missing",
      });
      continue;
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
        const want = from;
        if (cur === want || cur === want + "/") {
          actions.push({
            op: "skip",
            skill: name,
            from,
            to,
            reason: "already correct",
          });
          continue;
        }
        actions.push({
          op: "symlink",
          skill: name,
          from,
          to,
          reason: "replace existing symlink",
        });
        continue;
      }
      if (existing.isDirectory() || existing.isFile()) {
        actions.push({
          op: "refuse",
          skill: name,
          from,
          to,
          status_code: "OWNERSHIP_CONFLICT",
          reason: force
            ? "target is a real file/dir not created by the installer; --force never deletes it (OWNERSHIP_CONFLICT)"
            : "target is a real file/dir not created by the installer (OWNERSHIP_CONFLICT)",
        });
        errors.push({
          agent: targetDir,
          path: to,
          op: "symlink",
          status: "OWNERSHIP_CONFLICT",
          error:
            "target is real; move it aside yourself if OPS should own this path",
        });
        continue;
      }
    }
    actions.push({ op: "symlink", skill: name, from, to });
  }
  return { actions, errors };
}

export function applyActions(actions, { dryRun, onApply }) {
  const results = [];
  for (const a of actions) {
    if (a.op === "skip") {
      results.push({ ...a, status: "skipped" });
      continue;
    }
    if (a.op === "refuse") {
      results.push({ ...a, status: "refused" });
      continue;
    }
    if (a.op === "error") {
      results.push({ ...a, status: "error" });
      continue;
    }
    if (a.op !== "symlink") {
      results.push({ ...a, status: "noop" });
      continue;
    }
    if (dryRun) {
      results.push({ ...a, status: "planned" });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(a.to), { recursive: true });
      // Only a symlink may be replaced. Anything else appeared after
      // planning and is not ours: refuse instead of deleting it.
      let st = null;
      try {
        st = fs.lstatSync(a.to);
      } catch (_e) {}
      if (st && !st.isSymbolicLink()) {
        results.push({
          ...a,
          status: "refused",
          status_code: "OWNERSHIP_CONFLICT",
        });
        continue;
      }
      if (st) fs.unlinkSync(a.to);
      fs.symlinkSync(a.from, a.to);
      if (typeof onApply === "function") onApply(a.to, a.from);
      results.push({ ...a, status: "applied" });
    } catch (e) {
      results.push({ ...a, status: "failed", error: e.message });
    }
  }
  return results;
}
