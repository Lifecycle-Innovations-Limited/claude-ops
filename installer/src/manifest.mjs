// manifest.mjs — record every symlink WE created so uninstall is surgical.
// Stored at ~/.cache/claude-ops-installer/manifest.json.

import fs from "node:fs";
import path from "node:path";
import { CACHE_ROOT } from "./source.mjs";

const MANIFEST_PATH = path.join(CACHE_ROOT, "manifest.json");

function empty() {
  return { version: 1, created_at: new Date().toISOString(), symlinks: [] };
}

export function loadManifest() {
  try {
    const txt = fs.readFileSync(MANIFEST_PATH, "utf8");
    const m = JSON.parse(txt);
    if (m && Array.isArray(m.symlinks)) return m;
    return empty();
  } catch (_e) {
    return empty();
  }
}

export function saveManifest(m) {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + "\n");
}

export function addSymlink(m, to, fromRef) {
  if (!m.symlinks.find((s) => s.to === to)) {
    m.symlinks.push({ to, from: fromRef, at: new Date().toISOString() });
  }
  return m;
}

// Convenience wrapper for the rest of the installer.
export function newManifest() {
  return empty();
}

export { MANIFEST_PATH };
