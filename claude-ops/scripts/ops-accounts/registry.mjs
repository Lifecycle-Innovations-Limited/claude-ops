/**
 * Provider registry for /ops:accounts.
 * Loads adapters under ./providers/*.mjs (ESM).
 */
import { readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = join(__dirname, 'providers');

/** @typedef {{ providerId: string, displayName: string, listAccounts: Function, register?: Function, refresh?: Function, reauth?: Function, switchTo?: Function, utilization?: Function }} Provider */

/**
 * @returns {Promise<Provider[]>}
 */
export async function loadProviders() {
  const files = readdirSync(PROVIDERS_DIR)
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))
    .sort();
  const out = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(PROVIDERS_DIR, f)).href);
    if (!mod.providerId || typeof mod.listAccounts !== 'function') {
      continue;
    }
    out.push(mod);
  }
  return out;
}

export function makeCtx({ dryRun = false, log = console.log } = {}) {
  const pluginRoot =
    process.env.CLAUDE_PLUGIN_ROOT ||
    dirname(dirname(__dirname)); /* scripts/ops-accounts -> claude-ops root */
  return {
    pluginRoot,
    dataDir:
      process.env.CLAUDE_PLUGIN_DATA_DIR ||
      join(process.env.HOME || process.env.USERPROFILE || '', '.claude/plugins/data/ops-ops-marketplace'),
    log,
    dryRun,
    env: process.env,
    home: process.env.HOME || process.env.USERPROFILE || '',
  };
}
