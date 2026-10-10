// lock.mjs — one writer per target root, shared with sync-companion-clis.sh.
//
// The lock is a directory (mkdir is atomic) under
// $XDG_STATE_HOME/claude-ops/locks (default ~/.local/state/...), named with
// the same key function as the bash side and the read-only check, so a check
// can report LOCKED while an apply is running. A lock whose pid is gone is
// reclaimed; a live one is never broken.

import fs from "node:fs";
import path from "node:path";
import { envPaths, lockKey } from "./parity/check.mjs";

function alive(pid) {
  if (!/^\d+$/.test(String(pid || ""))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export function acquireLock(root, env = process.env) {
  const base = envPaths(env).lockBase;
  const dir = path.join(base, `${lockKey(root)}.lock`);
  fs.mkdirSync(base, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "pid"), `${process.pid}\n`);
      return {
        locked: false,
        dir,
        release: () => fs.rmSync(dir, { recursive: true, force: true }),
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let pid = null;
      try {
        pid = fs.readFileSync(path.join(dir, "pid"), "utf8").trim();
      } catch (_e) {
        /* no pid yet: treat as held */
        return { locked: true, dir, pid: null };
      }
      if (alive(pid)) return { locked: true, dir, pid };
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return { locked: true, dir, pid: null };
}
