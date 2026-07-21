// config.mjs — load + validate the central config file.
// Default: ~/.config/claude-ops-installer/config.yaml (XDG).
// Fallback: ~/.claude-ops-installer.yaml.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

export const DEFAULT_CONFIG_PATHS = [
  path.join(os.homedir(), ".config", "claude-ops-installer", "config.yaml"),
  path.join(os.homedir(), ".claude-ops-installer.yaml"),
];

export const DEFAULT_CONFIG = {
  version: 1,
  source: {
    type: "git",
    url: "https://github.com/Lifecycle-Innovations-Limited/claude-ops.git",
    ref: "v2.43.0",
  },
  agents: {
    claude: { enabled: true, type: "marketplace" },
    codex: { enabled: true, type: "flat", path: "~/.codex/skills" },
    gemini: { enabled: false, type: "flat", path: "~/.gemini/skills" },
    openclaw: { enabled: true, type: "flat", path: "~/.openclaw/skills" },
    hermes: {
      enabled: true,
      type: "hybrid",
      flat: "~/.hermes/skills",
      nested: "~/.hermes/skills/ops",
    },
    opencode: {
      enabled: false,
      type: "flat",
      path: "~/.config/opencode/skills",
    },
  },
  bin: { path: "~/bin", strategy: "symlink" },
};

export function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function loadConfig(overridePath) {
  const candidates = overridePath ? [overridePath] : DEFAULT_CONFIG_PATHS;
  let raw = null;
  let usedPath = null;
  for (const p of candidates) {
    try {
      const txt = fs.readFileSync(expandHome(p), "utf8");
      raw = txt;
      usedPath = p;
      break;
    } catch (_e) {
      /* not present */
    }
  }
  let parsed = {};
  if (raw) {
    try {
      parsed = yaml.load(raw) || {};
    } catch (e) {
      const err = new Error(
        `failed to parse yaml at ${usedPath}: ${e.message}`,
      );
      err.code = "CONFIG_INVALID";
      throw err;
    }
  }
  const cfg = mergeDeep(structuredClone(DEFAULT_CONFIG), parsed);
  if (cfg.version !== 1) {
    const err = new Error(
      `unsupported config version: ${cfg.version} (expected 1)`,
    );
    err.code = "CONFIG_INVALID";
    throw err;
  }
  // Resolve ~ in agent paths and bin path.
  for (const a of Object.values(cfg.agents)) {
    if (a.path) a.path = expandHome(a.path);
    if (a.flat) a.flat = expandHome(a.flat);
    if (a.nested) a.nested = expandHome(a.nested);
  }
  if (cfg.bin && cfg.bin.path) cfg.bin.path = expandHome(cfg.bin.path);
  return cfg;
}

function mergeDeep(target, src) {
  if (!src || typeof src !== "object") return target;
  for (const [k, v] of Object.entries(src)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      target[k] &&
      typeof target[k] === "object"
    ) {
      target[k] = mergeDeep(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

export function filterAgents(cfg, onlyNames) {
  const all = Object.entries(cfg.agents);
  if (!onlyNames || onlyNames.length === 0)
    return Object.fromEntries(all.filter(([, v]) => v.enabled));
  const wanted = new Set(onlyNames);
  return Object.fromEntries(all.filter(([k, v]) => wanted.has(k)));
}
