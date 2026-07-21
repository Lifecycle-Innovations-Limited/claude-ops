// verify.mjs — read-only check: does each agent's skills dir mirror upstream correctly?

import fs from "node:fs";
import path from "node:path";
import { listSourceSkills } from "./source.mjs";

export function verifyAgent({ srcDir, agentName, targetDir }) {
  const skillNames = listSourceSkills(srcDir);
  const drifts = [];
  const ok = [];
  const missing = [];
  for (const name of skillNames) {
    const from = path.join(srcDir, "skills", name);
    const to = path.join(targetDir, name);
    let st = null;
    try {
      st = fs.lstatSync(to);
    } catch (_e) {}
    if (!st) {
      missing.push({ name, from, to });
      continue;
    }
    if (!st.isSymbolicLink()) {
      drifts.push({ name, from, to, reason: "target is not a symlink" });
      continue;
    }
    const cur = fs.readlinkSync(to);
    const want = from;
    if (cur !== want && cur !== want + "/") {
      drifts.push({
        name,
        from,
        to,
        reason: `symlink points at ${cur}, expected ${want}`,
      });
      continue;
    }
    ok.push({ name, to });
  }
  return { agent: agentName, targetDir, ok: ok.length, missing, drifts };
}
