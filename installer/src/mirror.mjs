// mirror.mjs — apply the actual symlink plan. Errors as data; no silent swallowing.

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
  fs.mkdirSync(targetDir, { recursive: true });

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
        if (!force) {
          actions.push({
            op: "refuse",
            skill: name,
            from,
            to,
            reason: "target is a real file/dir; pass --force to overwrite",
          });
          errors.push({
            agent: targetDir,
            path: to,
            op: "symlink",
            error: "target is real (refused without --force)",
          });
          continue;
        }
        actions.push({
          op: "symlink",
          skill: name,
          from,
          to,
          reason: "overwrite real file/dir (--force)",
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
      // Remove existing real file/dir if present and not a symlink.
      let st = null;
      try {
        st = fs.lstatSync(a.to);
      } catch (_e) {}
      if (st) {
        if (st.isSymbolicLink() || st.isFile())
          fs.rmSync(a.to, { force: true });
        else if (st.isDirectory())
          fs.rmSync(a.to, { recursive: true, force: true });
      }
      fs.symlinkSync(a.from, a.to);
      if (typeof onApply === "function") onApply(a.to, a.from);
      results.push({ ...a, status: "applied" });
    } catch (e) {
      results.push({ ...a, status: "failed", error: e.message });
    }
  }
  return results;
}
