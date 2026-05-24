#!/usr/bin/env node
/* ops-social-planner core (ESM). See SPEC.md. Invoked via bin/ops-social-planner shim. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const PREFS_PATH = process.env.PREFS_PATH ||
  path.join(HOME, '.claude/plugins/data/ops-ops-marketplace/preferences.json');
const OPS_DATA_DIR = process.env.OPS_DATA_DIR ||
  path.join(HOME, '.claude/plugins/data/ops-ops-marketplace');
const UI_DIR = path.join(__dirname, '..', 'ui');
const OUT_DIR = path.join(OPS_DATA_DIR, 'social-planner');
const args = process.argv.slice(2);
const cmd = (args[0] && !args[0].startsWith('-')) ? args[0] : 'all';
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] || true) : d; };
const PORT = Number(flag('--port', process.env.OPS_PLANNER_PORT || 7937));
const OUT = flag('--out', path.join(OUT_DIR, 'state.json'));

/* ---------- helpers ---------- */
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const log = (...a) => console.error('[planner]', ...a);
const URL_RE = /(https?:\/\/[^\s)]+)/g;
const extractLinks = (t) => [...new Set((t || '').match(URL_RE) || [])];

function resolveSecret(ref) {
  if (!ref) return null;
  if (ref.startsWith('env:')) return process.env[ref.slice(4)] || null;
  if (ref.startsWith('doppler:')) {
    // doppler:project/config/SECRET
    const [project, config, ...rest] = ref.slice(8).split('/');
    const name = rest.join('/');
    try {
      return execSync(`doppler secrets get ${name} --project ${project} --config ${config} --plain`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch { return process.env[name] || null; }
  }
  return process.env[ref] || ref; // raw env name or literal
}

/* ---------- rationale (deterministic heuristic) ---------- */
function deriveRationale(channel, copy, scheduledAt) {
  const hour = new Date(scheduledAt).getUTCHours();
  const slot =
    hour < 9 ? 'Morning authority slot — high feed reach before the workday (EU midday / US-east pre-open).' :
    hour < 12 ? 'Late-morning build-in-public slot — steady weekday browsing.' :
    hour < 14 ? 'Midday window — peak US-morning engagement.' :
    hour < 17 ? 'Afternoon professional window — best for LinkedIn long-form.' :
    'Evening casual window — conversational/Threads-friendly.';
  const norm = {
    x: 'X: hook-first, thread if it earns it.',
    linkedin: 'LinkedIn: long-form authority + soft CTA.',
    threads: 'Threads: casual, conversational, low-polish.',
    instagram: 'Instagram: visual-first, link-in-bio CTA.',
    reddit: 'Reddit: value-first, no hard sell.',
    youtube: 'YouTube: SEO title + descriptive copy.',
    google_business: 'Google Business: local discovery, plain CTA.',
    facebook: 'Facebook: brand page, broad reach.',
  }[channel] || `${channel}: platform-native.`;
  const t = (copy || '').toLowerCase();
  const seq = /(almost here|this week|coming|👀|something worth)/.test(t) ? 'Pre-launch teaser — builds anticipation ahead of the drop.'
    : /(it'?s here|is here|is live|now live|download|link in bio|on the app store)/.test(t) ? 'Launch beat — conversion-focused, drives the install.'
    : 'Education/credibility beat — deepens trust between launch pushes.';
  return `${seq} ${slot} ${norm}`;
}

/* ---------- engine fetchers ---------- */
async function fetchTypefully(setId) {
  const cfgPath = path.join(HOME, '.config/typefully/config.json');
  if (!fs.existsSync(cfgPath)) return { ok: false, reason: 'no typefully config', items: [] };
  const key = readJSON(cfgPath).apiKey;
  const base = process.env.TYPEFULLY_API_BASE || 'https://api.typefully.com/v2';
  const H = { Authorization: `Bearer ${key}` };
  const list = await fetch(`${base}/social-sets/${setId}/drafts?status=scheduled&limit=50&order_by=scheduled_date`, { headers: H });
  if (!list.ok) return { ok: false, reason: `HTTP ${list.status}`, items: [] };
  const drafts = (await list.json()).results || [];
  const items = [];
  for (const d of drafts) {
    let full = d;
    try { const r = await fetch(`${base}/social-sets/${setId}/drafts/${d.id}?exclude_comment_markers=true`, { headers: H }); if (r.ok) full = await r.json(); } catch {}
    const plats = full.platforms || {};
    for (const [channel, p] of Object.entries(plats)) {
      if (!p || !p.enabled) continue;
      const posts = (p.posts || []).map(x => x.text).filter(Boolean);
      if (!posts.length) continue;
      const copy = posts.join('\n\n———\n\n');
      items.push({
        id: `tf-${d.id}-${channel}`, channel, kind: 'post',
        type: posts.length > 1 ? 'thread' : 'text',
        scheduled_at: d.scheduled_date, copy, thread: posts.length > 1 ? posts : undefined,
        rationale: deriveRationale(channel, copy, d.scheduled_date),
        media: [], links: extractLinks(copy), char_count: copy.length,
        title: d.draft_title || null,
        source: { engine: 'typefully', ref: String(d.id), edit_url: d.private_url || null },
      });
    }
  }
  return { ok: true, count: items.length, items };
}

async function fetchUploadPost(profile, key) {
  if (!key) return { ok: false, reason: 'no api key', items: [] };
  const r = await fetch('https://api.upload-post.com/api/uploadposts/schedule', { headers: { Authorization: `Apikey ${key}` } });
  if (!r.ok) return { ok: false, reason: `HTTP ${r.status}`, items: [] };
  const data = await r.json();
  const posts = (data.scheduled_posts || []).filter(p => !profile || p.profile_username === profile);
  const items = posts.flatMap(p => (p.platforms || []).map(channel => {
    const pc = (p.platform_content || {})[channel] || {};
    const copy = [pc.title || p.title, pc.caption || p.caption, pc.description || p.description].filter(Boolean).join('\n\n');
    const isVid = p.post_type === 'video';
    return {
      id: `up-${p.job_id}-${channel}`, channel, kind: 'post', type: p.post_type || 'photo',
      scheduled_at: p.original_scheduled_str || p.scheduled_date, copy,
      rationale: deriveRationale(channel, copy, p.original_scheduled_str || p.scheduled_date),
      media: p.preview_url ? [{ type: isVid ? 'video' : 'image', url: p.preview_url, thumb: p.thumbnail_url || (isVid ? null : p.preview_url) }] : [],
      links: extractLinks(copy), char_count: copy.length, title: null,
      source: { engine: 'upload-post', ref: p.job_id },
    };
  }));
  return { ok: true, count: items.length, items };
}

function adHook(engine) { return { ok: false, reason: 'hook-pending', status: 'hook-pending', items: [] }; }

/* ---------- collect ---------- */
async function collect() {
  const prefs = readJSON(PREFS_PATH);
  const mk = prefs.marketing || {};
  const engineStatus = {};
  const identities = [];
  const note = (eng, res) => { const s = engineStatus[eng] || { ok: false, count: 0 }; s.ok = s.ok || res.ok; s.count += res.count || 0; if (res.reason) s.reason = res.reason; engineStatus[eng] = s; };

  // personal identities
  for (const [id, p] of Object.entries((mk.social_identities && mk.social_identities.personal) || {})) {
    let res = { ok: false, items: [] };
    if (p.engine === 'typefully' && p.typefully_social_set_id) res = await fetchTypefully(p.typefully_social_set_id);
    note(p.engine || 'typefully', res);
    identities.push({ id, label: (p.aka && p.aka.join(' / ')) || id, kind: 'personal', engine: p.engine || 'typefully',
      status: res.ok ? 'ok' : (res.reason || 'error'), channels: [...new Set(res.items.map(i => i.channel))].sort(), items: res.items });
  }

  // project brands
  for (const [proj, cfg] of Object.entries(mk.projects || {})) {
    const s = cfg.social || {}; const eng = (s.engine && s.engine.primary) || null;
    let res = { ok: false, items: [], status: s.engine && s.engine.status };
    if (eng === 'upload-post') {
      const up = s.engine.upload_post || {};
      res = await fetchUploadPost(up.user || proj, resolveSecret(up.api_key_ref));
    } else if (eng === 'meta-graph' || eng === 'meta-ads' || eng === 'google-ads') {
      res = adHook(eng);
    }
    if (eng) note(eng, res);
    identities.push({ id: proj, label: proj, kind: 'project', engine: eng,
      status: eng ? (res.ok ? 'ok' : (res.status || res.reason || 'error')) : 'unprovisioned',
      channels: [...new Set(res.items.map(i => i.channel))].sort(), items: res.items });
  }

  const state = { generated_at: new Date().toISOString(), timezone: prefs.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    engine_status: engineStatus, identities };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(state, null, 2));
  const total = identities.reduce((n, i) => n + i.items.length, 0);
  log(`collected ${total} items across ${identities.length} identities → ${OUT}`);
  return state;
}

/* ---------- serve ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
function serve() {
  const srv = http.createServer((req, res) => {
    let url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/' || url === '') url = '/index.html';
    let file;
    if (url === '/state.json') {
      file = fs.existsSync(OUT) ? OUT : path.join(UI_DIR, 'state.sample.json');
    } else {
      const rel = path.normalize(url).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
      file = path.join(UI_DIR, rel);
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  srv.listen(PORT, '127.0.0.1', () => {
    const u = `http://127.0.0.1:${PORT}/`;
    log(`serving ${u}`);
    console.log(u);
    if (cmd !== 'serve' && flag('--no-open', false) === false) {
      try { spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [u], { stdio: 'ignore', detached: true }).unref(); } catch {}
    }
  });
}

(async () => {
  try {
    if (cmd === 'collect' || cmd === 'all') await collect();
    if (cmd === 'serve' || cmd === 'open' || cmd === 'all') serve();
    else process.exit(0);
  } catch (e) { log('ERROR', e.message); process.exit(1); }
})();
