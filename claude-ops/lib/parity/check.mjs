#!/usr/bin/env node
// check.mjs — read-only skill parity check across the CLIs that load OPS.
//
// One reference release (a local plugin root) is compared byte-for-byte with
// what each host actually loads: Claude Code, Codex, Grok, Cursor and Hermes,
// plus the installer's flat agents as inventory. Nothing here writes, fetches,
// clones, locks or repairs: lstat, readlink, realpath and streamed hashing only.
// The installer and ops-update share this file (the installer ships a
// byte-checked copy under installer/src/parity/).
//
//   reference root ──► hash skills/ + plugin.json ─┐
//   per host: consumer from the host's own state ──┼─► compare ─► record
//   identity snapshot before ... after ────────────┘     (STALE_SCAN on change)
//
// Status names and exit codes come from status.json; docs anchors live in
// docs/skill-parity.md. Public repo: no machine-specific values here (Rule 0).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STATUS_TABLE = JSON.parse(fs.readFileSync(path.join(HERE, 'status.json'), 'utf8'));
export const STATUSES = Object.keys(STATUS_TABLE.statuses);
// Same set the apply side excludes from its copies (sync-companion-clis.sh).
export const EXCLUDES = new Set(['.git', '__pycache__', '.ops-manifest']);
export const DOCS_PAGE = 'docs/skill-parity.md';
export const PRIMARY_HOSTS = ['claude', 'codex', 'grok', 'cursor', 'hermes'];
export const INVENTORY_HOSTS = ['hermes-skills', 'gemini', 'openclaw', 'opencode'];
export const ALL_HOSTS = [...PRIMARY_HOSTS, ...INVENTORY_HOSTS];

export function docsAnchor(status) {
  return `${DOCS_PAGE}#status-${status.toLowerCase().replace(/_/g, '-')}`;
}

export function classOf(status) {
  const s = STATUS_TABLE.statuses[status];
  if (!s) throw new Error(`unknown status ${status}`);
  return s.class;
}

export function exitCodeFor(cls) {
  const c = STATUS_TABLE.exit_codes[cls];
  if (c === undefined) throw new Error(`unknown exit class ${cls}`);
  return c;
}

// Highest severity wins: locked > partial > gap > drift > clean.
export function aggregateClass(records) {
  const order = STATUS_TABLE.severity;
  let worst = 0;
  for (const r of records) worst = Math.max(worst, order.indexOf(r.class));
  return order[worst];
}

// ── environment ────────────────────────────────────────────────────────────
export function envPaths(env = process.env) {
  const home = env.HOME || os.homedir();
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return {
    home,
    claudeDir,
    hermesHome: env.HERMES_HOME || path.join(home, '.hermes'),
    codexSkills: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills'),
    grokRegistry: path.join(home, '.grok', 'installed-plugins', 'registry.json'),
    cursorCache: path.join(home, '.cursor', 'plugins', 'cache', 'ops-marketplace', 'ops'),
    lockBase: env.XDG_STATE_HOME
      ? path.join(env.XDG_STATE_HOME, 'claude-ops', 'locks')
      : path.join(home, '.local', 'state', 'claude-ops', 'locks'),
    configPath: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'claude-ops', 'parity.json'),
    flat: {
      gemini: path.join(home, '.gemini', 'skills'),
      openclaw: path.join(home, '.openclaw', 'skills'),
      opencode: path.join(home, '.config', 'opencode', 'skills'),
    },
  };
}

// Shared with bash (sync-companion-clis.sh lock_key): any char outside
// [A-Za-z0-9._-] becomes "_".
export function lockKey(root) {
  return path.resolve(root).replace(/[^A-Za-z0-9._-]/g, '_');
}

export function lockState(root, lockBase) {
  const dir = path.join(lockBase, `${lockKey(root)}.lock`);
  try {
    fs.lstatSync(dir);
  } catch (_e) {
    return { locked: false, dir };
  }
  let pid = null;
  try {
    pid = fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim() || null;
  } catch (_e) {
    /* lock without pid file: still a lock */
  }
  return { locked: true, dir, pid };
}

// ── hashing ────────────────────────────────────────────────────────────────
export function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.allocUnsafe(65536);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

// Bounded walk of one owned root. Symlinks inside the tree are recorded by
// their link text and never followed, so a link cannot pull the walk outside
// the root (no HOME sweep, no cycles).
export function hashTree(root, { excludes = EXCLUDES, prefix = '' } = {}) {
  const out = new Map();
  const walk = (dir, rel) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (excludes.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out.set(prefix + r, `symlink:${fs.readlinkSync(abs)}`);
      else if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) out.set(prefix + r, `sha256:${sha256File(abs)}`);
      else out.set(prefix + r, 'special');
    }
  };
  walk(root, '');
  return out;
}

export function compareMaps(ref, tgt) {
  const missing = [];
  const extra = [];
  const changed = [];
  for (const [k, v] of ref) {
    if (!tgt.has(k)) missing.push(k);
    else if (tgt.get(k) !== v) changed.push(k);
  }
  for (const k of tgt.keys()) if (!ref.has(k)) extra.push(k);
  return { compared: ref.size, missing, extra, changed };
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (_e) {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_e) {
    return false;
  }
}

// Read-only git HEAD lookup: parses .git files, never spawns git. Bounded to
// the start dir and two parents (plugin root -> repo root), so an unrelated
// repository higher up (a dotfiles repo around the whole config dir) is never
// mistaken for the plugin's source.
export function gitTop(start, maxUp = 2) {
  let dir = path.resolve(start);
  for (let i = 0; i <= maxUp; i++) {
    if (exists(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

export function gitHead(top) {
  try {
    let gitDir = path.join(top, '.git');
    // Read first and let EISDIR mark a normal checkout: a stat-then-read pair
    // can see a different file than the one it checked.
    let gitFile = null;
    try {
      gitFile = fs.readFileSync(gitDir, 'utf8');
    } catch (e) {
      if (e.code !== 'EISDIR') throw e;
    }
    if (gitFile !== null) {
      const m = /gitdir:\s*(.+)/.exec(gitFile);
      if (!m) return null;
      gitDir = path.resolve(top, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (!ref) return null;
    // Worktrees keep refs in the common dir.
    let common = gitDir;
    try {
      common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
    } catch (_e) {
      /* not a worktree */
    }
    for (const base of [gitDir, common]) {
      try {
        const v = fs.readFileSync(path.join(base, ref), 'utf8').trim();
        if (/^[0-9a-f]{40}$/.test(v)) return v;
      } catch (_e) {
        /* try packed-refs */
      }
      try {
        const packed = fs.readFileSync(path.join(base, 'packed-refs'), 'utf8');
        const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
        if (line) return line.split(' ')[0];
      } catch (_e) {
        /* none */
      }
    }
  } catch (_e) {
    /* unreadable */
  }
  return null;
}

// ── identity snapshots (STALE_SCAN) ────────────────────────────────────────
function statId(p) {
  try {
    const st = fs.lstatSync(p);
    return `${st.ino}:${st.mtimeMs}:${st.isSymbolicLink() ? fs.readlinkSync(p) : ''}`;
  } catch (_e) {
    return 'absent';
  }
}

function fileId(p) {
  try {
    return sha256File(p);
  } catch (_e) {
    return 'absent';
  }
}

// ── config ─────────────────────────────────────────────────────────────────
export function loadParityConfig(configPath) {
  if (!configPath || !exists(configPath)) return { required: null, exceptions: [] };
  const cfg = readJson(configPath);
  return {
    required: Array.isArray(cfg.required) ? cfg.required : null,
    exceptions: Array.isArray(cfg.exceptions) ? cfg.exceptions : [],
  };
}

function validException(e) {
  return (
    e &&
    typeof e.host === 'string' &&
    typeof e.path === 'string' &&
    ['reason', 'owner', 'compatibility'].every((k) => typeof e[k] === 'string' && e[k].trim() !== '')
  );
}

// ── reference ──────────────────────────────────────────────────────────────
export function claudeConsumer(paths) {
  const f = path.join(paths.claudeDir, 'plugins', 'installed_plugins.json');
  if (!exists(f)) return { found: false, file: f };
  const j = readJson(f);
  const list = j?.plugins?.['ops@ops-marketplace'];
  const entry = Array.isArray(list) ? list[0] : null;
  if (!entry?.installPath) return { found: false, file: f };
  return {
    found: true,
    file: f,
    root: entry.installPath,
    version: entry.version || null,
    sha: entry.gitCommitSha || null,
  };
}

export function resolveReference({ source, paths }) {
  let root = source;
  let via = '--source';
  if (!root) {
    let c;
    try {
      c = claudeConsumer(paths);
    } catch (e) {
      return { ok: false, status: 'UNREADABLE', cause: e.message };
    }
    if (!c.found)
      return {
        ok: false,
        status: 'MISSING_REFERENCE',
        cause: 'no --source given and Claude Code has no installed ops plugin',
      };
    root = c.root;
    via = 'claude-installed';
  }
  let real;
  let installedSha = null;
  if (via === 'claude-installed') {
    try {
      installedSha = claudeConsumer(paths).sha;
    } catch (_e) {
      /* already read above */
    }
  }
  try {
    real = fs.realpathSync(root);
  } catch (_e) {
    return { ok: false, status: 'MISSING_REFERENCE', cause: `${root} does not exist` };
  }
  const skills = path.join(real, 'skills');
  if (!isDir(skills)) return { ok: false, status: 'MISSING_REFERENCE', cause: `${real} has no skills/` };
  let version = null;
  try {
    version = readJson(path.join(real, '.claude-plugin', 'plugin.json')).version || null;
  } catch (_e) {
    /* unknown */
  }
  const top = gitTop(real);
  const sha = installedSha || (top ? gitHead(top) : null);
  const kind = real.includes(`${path.sep}plugins${path.sep}cache${path.sep}`)
    ? 'release-cache'
    : top
      ? 'checkout'
      : 'directory';
  return { ok: true, root: real, via, version, sha, kind };
}

function referenceMaps(ref) {
  const skills = hashTree(path.join(ref.root, 'skills'), { prefix: 'skills/' });
  const pluginJson = path.join(ref.root, '.claude-plugin', 'plugin.json');
  const plugin = new Map(skills);
  if (exists(pluginJson)) plugin.set('.claude-plugin/plugin.json', `sha256:${sha256File(pluginJson)}`);
  const hermesDir = path.join(ref.root, 'hermes-plugin');
  const hermes = isDir(hermesDir) ? hashTree(hermesDir) : null;
  const hermesBundle = hermes ? new Map([...hermes, ...skills]) : null;
  const skillNames = fs
    .readdirSync(path.join(ref.root, 'skills'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return { skills, plugin, hermes, hermesBundle, skillNames };
}

function referenceId(ref) {
  return [
    fileId(path.join(ref.root, '.claude-plugin', 'plugin.json')),
    statId(path.join(ref.root, 'skills')),
    statId(ref.root),
  ].join('|');
}

// ── host adapters (read-only) ──────────────────────────────────────────────
// Each returns { configured, root, kind, consumerProof, compare(), id() } or
// { configured:false } or { error:{status,cause} }.

function fullPluginTarget(root, kind, proof, extra = {}) {
  return {
    configured: true,
    root,
    kind,
    consumerProof: proof,
    ...extra,
    compare: (maps) => {
      const tgt = new Map();
      const skillsDir = path.join(root, 'skills');
      if (isDir(skillsDir)) for (const [k, v] of hashTree(skillsDir, { prefix: 'skills/' })) tgt.set(k, v);
      const pj = path.join(root, '.claude-plugin', 'plugin.json');
      if (exists(pj)) tgt.set('.claude-plugin/plugin.json', `sha256:${sha256File(pj)}`);
      return compareMaps(maps.plugin, tgt);
    },
    scope: 'skills/ + .claude-plugin/plugin.json',
    id: () => statId(root) + '|' + statId(path.join(root, 'skills')),
  };
}

const ADAPTERS = {
  claude(paths) {
    const c = claudeConsumer(paths);
    if (!c.found) return { configured: false, probe: c.file };
    return fullPluginTarget(c.root, 'native', 'installed_plugins.json', {
      registry: c.file,
      registryId: () => fileId(c.file),
    });
  },

  grok(paths) {
    if (!exists(paths.grokRegistry)) return { configured: false, probe: paths.grokRegistry };
    const reg = readJson(paths.grokRegistry);
    const repos = Object.values(reg?.repos || {}).filter((r) => r?.plugins?.ops);
    if (repos.length === 0) return { configured: false, probe: paths.grokRegistry };
    if (repos.length > 1)
      return {
        error: {
          status: 'AMBIGUOUS_CONSUMER',
          cause: `${repos.length} registry entries provide plugin "ops"`,
        },
        root: paths.grokRegistry,
      };
    return fullPluginTarget(repos[0].path, 'native', 'grok registry.json', {
      registry: paths.grokRegistry,
      registryId: () => fileId(paths.grokRegistry),
    });
  },

  cursor(paths) {
    if (!isDir(paths.cursorCache)) return { configured: false, probe: paths.cursorCache };
    const dirs = fs
      .readdirSync(paths.cursorCache, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
    if (dirs.length === 0) return { configured: false, probe: paths.cursorCache };
    if (dirs.length > 1)
      return {
        error: {
          status: 'AMBIGUOUS_CONSUMER',
          cause: `${dirs.length} cache dirs (${dirs.join(', ')}); Cursor's own state does not name the one it loads`,
        },
        root: paths.cursorCache,
      };
    // Cursor exposes no commit for the loaded plugin (marketplace list gives a
    // branch ref only), so a single cache dir is the strongest proof we have.
    return fullPluginTarget(
      path.join(paths.cursorCache, dirs[0]),
      'native',
      'single cache dir (Cursor state names no commit)',
      { registryId: () => statId(paths.cursorCache) },
    );
  },

  hermes(paths, maps, ref) {
    const p = path.join(paths.hermesHome, 'plugins', 'ops');
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (_e) {
      return { configured: false, probe: p };
    }
    if (st.isSymbolicLink()) {
      let real;
      try {
        real = fs.realpathSync(p);
      } catch (_e) {
        return { error: { status: 'UNREADABLE', cause: `broken symlink ${p}` }, root: p };
      }
      const refHermes = ref.root ? path.join(ref.root, 'hermes-plugin') : null;
      let refReal = null;
      try {
        refReal = refHermes ? fs.realpathSync(refHermes) : null;
      } catch (_e) {
        /* reference has no hermes-plugin */
      }
      if (real !== refReal) {
        const top = gitTop(real);
        if (top)
          return {
            configured: true,
            root: p,
            kind: 'symlink',
            devSource: { path: real, sha: gitHead(top) },
            id: () => statId(p),
          };
      }
      return {
        configured: true,
        root: p,
        kind: 'symlink',
        consumerProof: 'plugins/ops link',
        scope: 'hermes-plugin/',
        compare: (m) => compareMaps(m.hermes || new Map(), hashTree(real)),
        id: () => statId(p),
      };
    }
    if (!st.isDirectory()) return { error: { status: 'UNREADABLE', cause: `${p} is not a directory` }, root: p };
    return {
      configured: true,
      root: p,
      kind: 'copy',
      consumerProof: 'plugins/ops directory',
      scope: 'hermes-plugin/ + bundled skills/',
      compare: (m) => {
        const r = compareMaps(m.hermesBundle || new Map(), hashTree(p));
        if (!isDir(path.join(p, 'skills')))
          r.cause = 'copy install has no bundled skills/; the native plugin registers 0 ops skills';
        return r;
      },
      id: () => statId(p) + '|' + fileId(path.join(p, '.ops-manifest')),
    };
  },
};

// Flat skill dirs: one entry per skill, either a symlink or a real copy.
function flatAdapter(root) {
  return (paths, maps) => {
    if (!isDir(root)) return { configured: false, probe: root };
    const names = new Set(fs.readdirSync(root));
    const known = maps.skillNames.filter((n) => names.has(n));
    if (known.length === 0) return { configured: false, probe: root };
    return {
      configured: true,
      root,
      kind: 'flat',
      consumerProof: 'skills directory entries',
      scope: 'skills/<name>/ for every reference skill',
      compare: (m) => {
        const tgt = new Map();
        const broken = [];
        for (const name of m.skillNames) {
          const entry = path.join(root, name);
          if (!exists(entry)) continue;
          let real;
          try {
            real = fs.realpathSync(entry);
          } catch (_e) {
            broken.push(`skills/${name}`);
            continue;
          }
          if (!isDir(real)) {
            broken.push(`skills/${name}`);
            continue;
          }
          for (const [k, v] of hashTree(real, { prefix: `skills/${name}/` })) tgt.set(k, v);
        }
        const r = compareMaps(m.skills, tgt);
        // Old OPS skills that are no longer shipped: links into an OPS plugin's
        // skills/ dir that the reference does not have.
        for (const n of names) {
          if (m.skillNames.includes(n)) continue;
          const entry = path.join(root, n);
          try {
            if (!fs.lstatSync(entry).isSymbolicLink()) continue;
            const real = fs.realpathSync(entry);
            const pj = path.join(path.dirname(path.dirname(real)), '.claude-plugin', 'plugin.json');
            if (readJson(pj).name === 'ops') r.extra.push(`skills/${n}/`);
          } catch (_e) {
            /* not an OPS link */
          }
        }
        r.changed.push(...broken);
        return r;
      },
      id: () => statId(root),
    };
  };
}

function adapterFor(host, paths) {
  if (ADAPTERS[host]) return ADAPTERS[host];
  if (host === 'codex') return flatAdapter(paths.codexSkills);
  if (host === 'hermes-skills') return flatAdapter(path.join(paths.hermesHome, 'skills'));
  if (paths.flat[host]) return flatAdapter(paths.flat[host]);
  return null;
}

// ── records ────────────────────────────────────────────────────────────────
const NEXT = {
  claude: 'run `ops-update` to install the release into Claude Code',
  grok: 'run `ops-update` (it calls `grok plugin update ops` and re-verifies)',
  cursor: 'follow the Cursor operator procedure in docs/skill-parity.md#cursor-operator-procedure',
  hermes: 'run `ops-update` (it copies the release into the Hermes plugin dir, staged)',
  codex: 'run `claude-ops-installer install --agents codex`',
  'hermes-skills': 'run `claude-ops-installer install --agents hermes`',
};

function nextStep(host, status) {
  switch (status) {
    case 'MISSING_REQUIRED':
      return `install OPS for ${host} (docs/skill-parity.md#hosts), or drop ${host} from "required" in your parity.json`;
    case 'MISSING_REFERENCE':
      return 'pass --source <plugin-root>, or fetch a release first: `claude-ops-installer fetch --ref <tag>`';
    case 'DEV_SOURCE':
      return 'intended for development; to move to the release, follow docs/skill-parity.md#migration-and-rollback';
    case 'STALE_SCAN':
      return 'something changed during the scan; rerun the check when no update is running';
    case 'STALE_SOURCE':
      return 'fetch the current ref: `claude-ops-installer fetch --ref <ref>`, then rerun';
    case 'LOCKED':
      return 'another OPS run is applying to this target; rerun when it finishes';
    case 'AMBIGUOUS_CONSUMER':
      return "remove the install you do not use, or reinstall through the host's own plugin command";
    case 'NOT_CHECKED':
      return 'rerun without --host to cover the full required set';
    case 'UNREADABLE':
      return 'fix the permissions or the broken file named in basis, then rerun';
    default:
      return NEXT[host] || `run \`claude-ops-installer install --agents ${host}\``;
  }
}

export function makeRecord(host, status, fields = {}) {
  const rec = {
    target: host,
    status,
    class: classOf(status),
    required: !!fields.required,
    ...fields,
    docs: docsAnchor(status),
  };
  if (rec.class !== 'clean') {
    rec.error = {
      problem: fields.problem || STATUS_TABLE.statuses[status].summary,
      basis: fields.basis || 'unknown',
      cause: fields.cause || 'unknown',
      next: fields.next || nextStep(host, status),
      docs: rec.docs,
    };
  }
  delete rec.problem;
  delete rec.basis;
  delete rec.cause;
  delete rec.next;
  return rec;
}

function applyExceptions(host, diff, exceptions) {
  const used = [];
  const invalid = [];
  const mine = exceptions.filter((e) => e && e.host === host);
  const valid = mine.filter((e) => {
    if (validException(e)) return true;
    invalid.push(e);
    return false;
  });
  const covered = (p) => valid.find((e) => p === e.path || p.startsWith(`${e.path.replace(/\/$/, '')}/`));
  for (const key of ['missing', 'extra', 'changed']) {
    diff[key] = diff[key].filter((p) => {
      const e = covered(p);
      if (!e) return true;
      used.push({ path: p, kind: key, exception: e });
      return false;
    });
  }
  return { used, invalid };
}

// ── main entry ─────────────────────────────────────────────────────────────
export function checkTargets({ source, hosts, required, env = process.env, configPath, midScanHook } = {}) {
  const paths = envPaths(env);
  const cfg = loadParityConfig(configPath === undefined ? paths.configPath : configPath);
  const ref = resolveReference({ source, paths });
  const requiredSet = new Set((required && required.length ? required : cfg.required) || []);
  const selected = hosts && hosts.length ? hosts : ALL_HOSTS;
  const records = [];
  const report = { reference: ref, selection: hosts && hosts.length ? hosts : null, records };

  if (!ref.ok) {
    records.push(
      makeRecord('reference', ref.status, {
        required: true,
        basis: source ? `--source ${source}` : 'Claude Code installed_plugins.json',
        cause: ref.cause,
      }),
    );
    report.aggregate = finish(records);
    return report;
  }

  const refIdBefore = referenceId(ref);
  const maps = referenceMaps(ref);
  const pending = [];

  for (const host of ALL_HOSTS) {
    const isRequired = requiredSet.has(host);
    if (!selected.includes(host)) {
      if (isRequired)
        records.push(
          makeRecord(host, 'NOT_CHECKED', {
            required: true,
            basis: `--host ${selected.join(',')}`,
            cause: 'left out by a diagnostic host selection',
          }),
        );
      continue;
    }
    const adapter = adapterFor(host, paths);
    let t;
    try {
      t = adapter(paths, maps, ref);
    } catch (e) {
      records.push(makeRecord(host, 'UNREADABLE', { required: isRequired, basis: 'host state', cause: e.message }));
      continue;
    }
    if (t.error) {
      records.push(
        makeRecord(host, t.error.status, {
          required: isRequired,
          observed: { path: t.root },
          basis: t.root,
          cause: t.error.cause,
        }),
      );
      continue;
    }
    if (!t.configured) {
      records.push(
        makeRecord(host, isRequired ? 'MISSING_REQUIRED' : 'NOT_CONFIGURED', {
          required: isRequired,
          observed: { probe: t.probe },
          basis: `no OPS install found at ${t.probe}`,
        }),
      );
      continue;
    }
    const lock = lockState(t.root, paths.lockBase);
    if (lock.locked) {
      records.push(
        makeRecord(host, 'LOCKED', {
          required: isRequired,
          observed: { path: t.root },
          basis: lock.dir,
          cause: lock.pid ? `held by pid ${lock.pid}` : 'lock dir present',
        }),
      );
      continue;
    }
    pending.push({ host, t, isRequired, idBefore: t.id() + '|' + (t.registryId?.() || '') });
  }

  const expected = { version: ref.version, sha: ref.sha, root: ref.root };
  const results = [];
  for (const p of pending) {
    const { host, t, isRequired } = p;
    if (t.devSource) {
      results.push({
        p,
        rec: makeRecord(host, 'DEV_SOURCE', {
          required: isRequired,
          kind: t.kind,
          expected,
          observed: { path: t.root, resolves_to: t.devSource.path, sha: t.devSource.sha },
          basis: `${t.root} -> ${t.devSource.path}`,
          cause: 'symlink into a git checkout that is not the reference release',
        }),
      });
      continue;
    }
    let diff;
    try {
      diff = t.compare(maps);
    } catch (e) {
      results.push({
        p,
        rec: makeRecord(host, 'UNREADABLE', {
          required: isRequired,
          observed: { path: t.root },
          basis: t.root,
          cause: e.message,
        }),
      });
      continue;
    }
    const ex = applyExceptions(host, diff, cfg.exceptions);
    const differs = diff.missing.length + diff.extra.length + diff.changed.length;
    const status = differs ? 'DRIFT' : ex.used.length ? 'EXCEPTION' : 'MATCH';
    results.push({
      p,
      rec: makeRecord(host, status, {
        required: isRequired,
        kind: t.kind,
        expected,
        observed: { path: t.root, consumer_proof: t.consumerProof },
        coverage: {
          scope: t.scope,
          compared: diff.compared,
          missing: diff.missing,
          extra: diff.extra,
          changed: diff.changed,
        },
        exceptions: ex.used,
        invalid_exceptions: ex.invalid,
        basis: `byte comparison of ${t.scope} at ${t.root} against ${ref.version || '?'}${ref.sha ? ` (${ref.sha.slice(0, 7)})` : ''}`,
        cause: diff.cause,
        problem: differs
          ? `${diff.missing.length} missing, ${diff.extra.length} extra, ${diff.changed.length} changed of ${diff.compared} compared files`
          : undefined,
      }),
    });
  }

  if (typeof midScanHook === 'function') midScanHook();

  const refChanged = referenceId(ref) !== refIdBefore;
  for (const { p, rec } of results) {
    const idAfter = p.t.id() + '|' + (p.t.registryId?.() || '');
    if (refChanged || idAfter !== p.idBefore) {
      records.push(
        makeRecord(p.host, 'STALE_SCAN', {
          required: p.isRequired,
          observed: rec.observed,
          basis: refChanged ? `reference ${ref.root}` : `target ${p.t.root}`,
          cause: 'identity changed between the start and the end of the scan',
        }),
      );
    } else records.push(rec);
  }
  records.sort((a, b) => ALL_HOSTS.indexOf(a.target) - ALL_HOSTS.indexOf(b.target));
  report.aggregate = finish(records);
  return report;
}

export function finish(records) {
  const cls = aggregateClass(records);
  return { class: cls, exit_code: exitCodeFor(cls) };
}

// ── CLI ────────────────────────────────────────────────────────────────────
const HELP = `ops parity check — read-only byte comparison of OPS skills across CLIs

Usage: check.mjs [--source <plugin-root>] [--host a,b] [--require a,b]
                 [--config <parity.json>] [--json] [--paths] [--report <file>]

  --source   reference release root (default: the version Claude Code has installed)
  --host     diagnostic selection; required hosts left out report NOT_CHECKED
  --require  required hosts (default: "required" in parity.json, else none)
  --json     full machine-readable report on stdout
  --paths    list every missing/extra/changed path
  --report   also write the full JSON report to <file>

Hosts: ${ALL_HOSTS.join(', ')}
Exit codes: ${Object.entries(STATUS_TABLE.exit_codes)
  .map(([k, v]) => `${v}=${k}`)
  .join(' ')}
Docs: ${DOCS_PAGE}
Never writes, fetches, locks or repairs anything.
`;

export function parseArgs(argv) {
  const o = { hosts: null, required: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw usage(`${a} needs a value`);
      return v;
    };
    if (a === '--source') o.source = val();
    else if (a === '--host')
      o.hosts = val()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === '--require')
      o.required = val()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === '--config') o.configPath = val();
    else if (a === '--report') o.report = val();
    else if (a === '--json') o.json = true;
    else if (a === '--paths') o.paths = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw usage(`unknown argument ${a}`);
  }
  for (const h of [...(o.hosts || []), ...(o.required || [])])
    if (!ALL_HOSTS.includes(h)) throw usage(`unknown host "${h}" (known: ${ALL_HOSTS.join(', ')})`);
  return o;
}

function usage(msg) {
  const e = new Error(msg);
  e.exitClass = 'usage';
  return e;
}

function tilde(p, home) {
  return typeof p === 'string' && home ? p.split(home).join('~') : p;
}

export function formatText(report, { paths: listPaths = false, home } = {}) {
  const lines = [];
  const ref = report.reference;
  lines.push(
    ref.ok
      ? `OPS skill parity — reference ${ref.version || '?'}${ref.sha ? ` @ ${ref.sha.slice(0, 7)}` : ''} (${ref.kind}, ${ref.via}) ${tilde(ref.root, home)}`
      : 'OPS skill parity — no reference',
  );
  for (const r of report.records) {
    let detail = '';
    if (r.coverage)
      detail =
        r.class === 'clean'
          ? `${r.coverage.compared} files byte-identical${r.exceptions?.length ? `, ${r.exceptions.length} documented exceptions` : ''}`
          : r.error.problem;
    else if (r.error) detail = r.error.problem;
    else if (r.status === 'NOT_CONFIGURED') detail = 'no OPS install (not required)';
    lines.push(`  ${r.target.padEnd(14)} ${r.status.padEnd(22)} ${detail}`);
    if (r.observed?.path)
      lines.push(
        `  ${''.padEnd(14)} at ${tilde(r.observed.path, home)}${r.observed.consumer_proof ? ` (consumer: ${r.observed.consumer_proof})` : ''}`,
      );
    if (r.status === 'DEV_SOURCE')
      lines.push(
        `  ${''.padEnd(14)} -> ${tilde(r.observed.resolves_to, home)} @ ${(r.observed.sha || 'unknown').slice(0, 12)}`,
      );
    if (r.error) {
      lines.push(`  ${''.padEnd(14)} basis: ${tilde(r.error.basis, home)}`);
      lines.push(`  ${''.padEnd(14)} cause: ${r.error.cause}`);
      lines.push(`  ${''.padEnd(14)} next:  ${r.error.next}`);
      lines.push(`  ${''.padEnd(14)} docs:  ${r.error.docs}`);
    }
    if (listPaths && r.coverage) {
      for (const k of ['missing', 'extra', 'changed'])
        for (const p of r.coverage[k]) lines.push(`  ${''.padEnd(14)} ${k}: ${p}`);
      for (const e of r.exceptions || []) lines.push(`  ${''.padEnd(14)} exception: ${e.path} (${e.exception.reason})`);
    }
  }
  if (report.selection) lines.push(`  selection: ${report.selection.join(',')} (diagnostic; not a full parity result)`);
  lines.push(`Result: ${report.aggregate.class} (exit ${report.aggregate.exit_code})`);
  return lines.join('\n') + '\n';
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`ops parity: ${e.message}\n\n${HELP}`);
    return exitCodeFor(e.exitClass || 'usage');
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  let report;
  try {
    report = checkTargets({ ...opts, env });
  } catch (e) {
    process.stderr.write(
      `ops parity: environment error\n  problem: ${e.message}\n  cause: unknown\n  next: rerun with --json and read the record; check file permissions\n  docs: ${DOCS_PAGE}#exit-codes\n`,
    );
    return exitCodeFor('environment');
  }
  if (opts.report) fs.writeFileSync(opts.report, JSON.stringify(report, null, 2) + '\n');
  if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else process.stdout.write(formatText(report, { paths: opts.paths, home: envPaths(env).home }));
  return report.aggregate.exit_code;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
