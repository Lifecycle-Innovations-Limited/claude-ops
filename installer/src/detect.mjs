// detect.mjs — for each known agent, probe the host for the CLI binary + expected skill path.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { expandHome } from "./config.mjs";

function which(bin) {
  try {
    const r = execSync(`command -v ${bin} || true`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return r.trim() || null;
  } catch (_e) {
    return null;
  }
}

export const AGENT_DEFS = {
  claude: {
    cli: "claude",
    skillsPath: "~/.claude/plugins/cache/ops-marketplace/ops/current/skills",
    binPath: "~/.claude/plugins/cache/ops-marketplace/ops/current/bin",
  },
  codex: {
    cli: "codex",
    skillsPath: "~/.codex/skills",
    binPath: null,
  },
  gemini: {
    cli: "gemini",
    skillsPath: "~/.gemini/skills",
    binPath: null,
  },
  openclaw: {
    cli: "openclaw",
    skillsPath: "~/.openclaw/skills",
    binPath: null,
  },
  hermes: {
    cli: "hermes",
    skillsPath: "~/.hermes/skills",
    binPath: null,
  },
  opencode: {
    cli: "opencode",
    skillsPath: "~/.config/opencode/skills",
    binPath: null,
  },
};

export function detectAgent(name) {
  const def = AGENT_DEFS[name];
  if (!def)
    return {
      name,
      known: false,
      installed: false,
      cliPath: null,
      skillsPath: null,
      binPath: null,
    };
  const cliPath = def.cli ? which(def.cli) : null;
  const skillsPath = expandHome(def.skillsPath);
  const binPath = def.binPath ? expandHome(def.binPath) : null;
  // "Installed" = either CLI on PATH OR skills dir exists.
  const installed = !!cliPath || (skillsPath && fs.existsSync(skillsPath));
  return { name, known: true, installed, cliPath, skillsPath, binPath };
}

export function detectAll(names) {
  const list = names || Object.keys(AGENT_DEFS);
  return list.map(detectAgent);
}
