// One configuration boundary for collection and control. Environment overrides preferences.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function configuredRemoteHosts() {
  let hosts = (process.env.AGENT_DASH_REMOTE_HOSTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!hosts.length) {
    const dataDir =
      process.env.CLAUDE_PLUGIN_DATA_DIR ||
      process.env.OPS_DATA_DIR ||
      join(homedir(), '.claude', 'plugins', 'data', 'ops-ops-marketplace');
    try {
      const prefs = JSON.parse(readFileSync(join(dataDir, 'preferences.json'), 'utf8'));
      hosts = Array.isArray(prefs?.agent_dash?.remote_hosts) ? prefs.agent_dash.remote_hosts : [];
    } catch {
      hosts = [];
    }
  }
  return [
    ...new Set(
      hosts
        .filter((h) => typeof h === 'string')
        .map((h) => h.trim())
        .filter((h) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(h)),
    ),
  ];
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
