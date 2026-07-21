// doctor.mjs — verify + tool checks + env checks.

import { execSync } from "node:child_process";
import { verifyAgent } from "./verify.mjs";

function tryExec(cmd) {
  try {
    const out = execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { ok: true, out };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function runDoctor({ srcDir, agents }) {
  const checks = [];
  // 1. Each agent's mirror
  for (const [name, a] of Object.entries(agents)) {
    if (!a.skillsPath) {
      checks.push({ name, ok: false, msg: "no skillsPath" });
      continue;
    }
    const v = verifyAgent({ srcDir, agentName: name, targetDir: a.skillsPath });
    checks.push({
      name: `${name}:mirror`,
      ok: v.drifts.length === 0 && v.missing.length === 0,
      msg: `ok=${v.ok} drifts=${v.drifts.length} missing=${v.missing.length}`,
    });
  }
  // 2. ops-inbox-scan reachable on PATH
  const ois = tryExec("command -v ops-inbox-scan");
  checks.push({
    name: "ops-inbox-scan-on-PATH",
    ok: !!ois.out,
    msg: ois.out || "not on PATH",
  });
  // 3. wa-inbox-fresh.sh reachable
  const wai = tryExec("command -v wa-inbox-fresh.sh");
  checks.push({
    name: "wa-inbox-fresh-on-PATH",
    ok: !!wai.out,
    msg: wai.out || "not on PATH",
  });
  // 4. node version
  const node = tryExec("node --version");
  checks.push({
    name: "node",
    ok: /^v(1[8-9]|[2-9]\d|\d{3,})/.test(node.out || ""),
    msg: node.out || node.error,
  });
  // 5. upstream src has SKILL.md for ops-inbox (signal we got a real checkout)
  const fs = await import("node:fs");
  const path = await import("node:path");
  const want = path.join(srcDir, "skills", "ops-inbox", "SKILL.md");
  checks.push({
    name: "source:ops-inbox/SKILL.md",
    ok: fs.existsSync(want),
    msg: want,
  });
  // Summary
  const failed = checks.filter((c) => !c.ok);
  return { ok: failed.length === 0, checks, failed };
}
