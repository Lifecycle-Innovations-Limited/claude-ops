/**
 * Isolate openai-compatibility providers that cannot serve (billing-dead,
 * region-blocked) so they are not advertised on /v1/models.
 *
 * Pure splice of CLIProxy config.yaml list items. Does not parse secrets.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function loadIsolateManifest(path) {
  if (!path || !existsSync(path)) return { providers: [], reasons: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const providers = (parsed.providers || []).map((p) => String(p).toLowerCase()).filter(Boolean);
    return { providers, reasons: parsed.reasons && typeof parsed.reasons === 'object' ? parsed.reasons : {} };
  } catch {
    return { providers: [], reasons: {} };
  }
}

/**
 * Split openai-compatibility list items. Each item starts at a line matching
 * /^- name: / at column 0 (the CLIProxy config shape).
 */
export function splitCompatItems(yamlText) {
  const lines = String(yamlText).split('\n');
  const start = lines.findIndex((l) => l.trim() === 'openai-compatibility:');
  if (start < 0) return { before: yamlText, items: [], after: '', start: -1 };
  const items = [];
  let i = start + 1;
  while (i < lines.length && (lines[i].startsWith(' ') || lines[i].startsWith('-') || lines[i].trim() === '')) {
    if (lines[i].startsWith('- name:')) {
      const name = lines[i].slice('- name:'.length).trim();
      const begin = i;
      i += 1;
      while (
        i < lines.length &&
        !lines[i].startsWith('- name:') &&
        (lines[i].startsWith(' ') || lines[i].startsWith('-') || lines[i].trim() === '')
      ) {
        i += 1;
      }
      items.push({ name, lines: lines.slice(begin, i) });
      continue;
    }
    // preamble under the key (should not happen)
    i += 1;
  }
  return {
    before: lines.slice(0, start).join('\n'),
    header: 'openai-compatibility:',
    items,
    after: lines.slice(i).join('\n'),
    start,
  };
}

export function isolateCompatYaml(yamlText, isolateNames) {
  const want = new Set((isolateNames || []).map((n) => String(n).toLowerCase()));
  const split = splitCompatItems(yamlText);
  if (split.start < 0 || want.size === 0) {
    return { yaml: yamlText, removed: [], kept: split.items?.map((it) => it.name) || [] };
  }
  const kept = [];
  const removed = [];
  for (const item of split.items) {
    if (want.has(String(item.name).toLowerCase())) removed.push(item);
    else kept.push(item);
  }
  const body = [split.header, ...kept.flatMap((it) => it.lines)].join('\n');
  const parts = [split.before, body];
  if (split.after) parts.push(split.after);
  let yaml = parts.join('\n');
  if (!yaml.endsWith('\n')) yaml += '\n';
  return { yaml, removed, kept: kept.map((it) => it.name) };
}

export function applyIsolateCompat({ configPath, isolateDir, manifestPath, names, dryRun = false } = {}) {
  if (!configPath || !existsSync(configPath)) {
    return { ok: false, reason: 'missing_config' };
  }
  const manifest = loadIsolateManifest(manifestPath);
  const isolateNames = names && names.length ? names : manifest.providers;
  if (!isolateNames.length) return { ok: true, removed: [], kept: [] };
  const original = readFileSync(configPath, 'utf8');
  const result = isolateCompatYaml(original, isolateNames);
  if (!result.removed.length) {
    return { ok: true, removed: [], kept: result.kept, unchanged: true };
  }
  if (!dryRun) {
    if (isolateDir) {
      mkdirSync(isolateDir, { recursive: true });
      for (const item of result.removed) {
        const dest = join(isolateDir, `${item.name}.yaml`);
        writeFileSync(dest, item.lines.join('\n') + '\n', { mode: 0o600 });
      }
    }
    const tmp = `${configPath}.tmp-isolate`;
    writeFileSync(tmp, result.yaml, { mode: 0o600 });
    renameSync(tmp, configPath);
  }
  return {
    ok: true,
    removed: result.removed.map((it) => it.name),
    kept: result.kept,
    unchanged: false,
  };
}
