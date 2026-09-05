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

// The Hermes native plugin is installed as a symlink at ~/.hermes/plugins/ops
// pointing at <src>/hermes-plugin. `verify` used to check skills only, so a
// plugin that had drifted into a real directory — a stale copy pinned at an old
// version, with its own edits — reported clean. That is the one file the agent
// actually loads, so a silent copy there means the box runs old plugin code
// while every skill looks in sync.
export function verifyNativePlugin({ srcDir, agentName, pluginPath }) {
  const from = path.join(srcDir, "hermes-plugin");
  const drifts = [];
  if (!pluginPath) return { agent: agentName, pluginPath: null, skipped: true };
  if (!fs.existsSync(path.join(from, "plugin.yaml"))) {
    return { agent: agentName, pluginPath, skipped: true };
  }
  let st = null;
  try {
    st = fs.lstatSync(pluginPath);
  } catch (_e) {}
  if (!st) {
    return {
      agent: agentName,
      pluginPath,
      ok: 0,
      missing: [{ name: "hermes-plugin", from, to: pluginPath }],
      drifts,
    };
  }
  if (!st.isSymbolicLink()) {
    drifts.push({
      name: "hermes-plugin",
      from,
      to: pluginPath,
      reason: "target is not a symlink (stale copy shadows the source tree)",
    });
    return { agent: agentName, pluginPath, ok: 0, missing: [], drifts };
  }
  const cur = fs.readlinkSync(pluginPath);
  if (cur !== from && cur !== from + "/") {
    drifts.push({
      name: "hermes-plugin",
      from,
      to: pluginPath,
      reason: `symlink points at ${cur}, expected ${from}`,
    });
    return { agent: agentName, pluginPath, ok: 0, missing: [], drifts };
  }
  return { agent: agentName, pluginPath, ok: 1, missing: [], drifts };
}
