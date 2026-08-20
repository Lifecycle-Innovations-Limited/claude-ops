/**
 * Isolate openai-compatibility providers that cannot serve (billing-dead,
 * region-blocked) so they are not advertised on /v1/models.
 *
 * Pure splice of CLIProxy config.yaml list items. Does not parse secrets.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
 * /^\s*- name: / — YAML permits the sequence indented under the key, not
 * only at column 0. The indentation of the FIRST such line under the key
 * sets the expected depth for every subsequent item boundary in this list,
 * so a nested list (e.g. `models:` / `api-key-entries:` inside an item) at a
 * deeper indent is never mistaken for a new top-level item.
 */
export function splitCompatItems(yamlText) {
  const lines = String(yamlText).split('\n');
  const start = lines.findIndex((l) => l.trim() === 'openai-compatibility:');
  if (start < 0) return { before: yamlText, items: [], after: '', start: -1 };

  let itemIndent = null;
  for (let j = start + 1; j < lines.length; j += 1) {
    const line = lines[j];
    // Blank lines and comment-only lines carry no indentation signal for the
    // list itself — valid YAML permits a `#`-only line (at any indent)
    // between the `openai-compatibility:` key and its first item, or between
    // any two items. Skip both while locating the first `- name:` line.
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const m = line.match(/^(\s*)-\s*name:/);
    if (m) itemIndent = m[1].length;
    break;
  }

  const items = [];
  let i = start + 1;
  if (itemIndent != null) {
    const itemStartRe = new RegExp(`^\\s{${itemIndent}}-\\s*name:`);
    // Comment-only lines seen while looking for the next item start (either
    // before the first item, or between two same-depth items) are buffered
    // here and prepended to whichever item follows, so they survive
    // reassembly attached to that item. If the list ends without another
    // item (trailing comments after the last one), the buffer is discarded —
    // there is no item left to attach it to, and `after` already captures
    // everything past the list.
    let pendingComments = [];
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') {
        i += 1;
        continue;
      }
      if (line.trim().startsWith('#')) {
        // Valid YAML permits a comment-only line, at any indent, between
        // the header and the first item or between two items — it does not
        // end the list.
        pendingComments.push(line);
        i += 1;
        continue;
      }
      if (itemStartRe.test(line)) {
        const name = line.slice(line.indexOf('name:') + 'name:'.length).trim();
        const begin = i;
        i += 1;
        while (i < lines.length) {
          const l = lines[i];
          if (l.trim() === '') {
            i += 1;
            continue;
          }
          if (itemStartRe.test(l)) break;
          const lineIndent = l.match(/^(\s*)/)[1].length;
          if (l.trim().startsWith('#') && lineIndent <= itemIndent) {
            // A comment at or above this item's own indent belongs to the
            // gap before the *next* item, not to this item's nested block —
            // stop here and let the outer loop buffer it.
            break;
          }
          if (lineIndent <= itemIndent) break;
          i += 1;
        }
        items.push({ name, lines: [...pendingComments, ...lines.slice(begin, i)] });
        pendingComments = [];
        continue;
      }
      // Not another item at this depth, not blank, not a comment — the list ended.
      break;
    }
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
