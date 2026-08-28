#!/usr/bin/env node
/* ops-social-planner core (ESM). See SPEC.md. Invoked via bin/ops-social-planner shim. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const PREFS_PATH =
  process.env.PREFS_PATH || path.join(HOME, '.claude/plugins/data/ops-ops-marketplace/preferences.json');
const OPS_DATA_DIR = process.env.OPS_DATA_DIR || path.join(HOME, '.claude/plugins/data/ops-ops-marketplace');
const UI_DIR = path.join(__dirname, '..', 'ui');
const OUT_DIR = path.join(OPS_DATA_DIR, 'social-planner');
const args = process.argv.slice(2);
const collectOnly = args.includes('--collect-only');
const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'all';
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] || true : d;
};
const PORT = Number(flag('--port', process.env.OPS_PLANNER_PORT || 7937));
const OUT = flag('--out', path.join(OUT_DIR, 'state.json'));

/* ---------- helpers ---------- */
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const log = (...a) => console.error('[planner]', ...a);
function resolveTypefullySocialSetId(p, prefs) {
  if (p.typefully_social_set_id != null && String(p.typefully_social_set_id).trim() !== '')
    return String(p.typefully_social_set_id);
  const fromPrefs = prefs.typefully && prefs.typefully.default_social_set_id;
  if (fromPrefs != null && String(fromPrefs).trim() !== '') return String(fromPrefs);
  const cfgPath = path.join(HOME, '.config/typefully/config.json');
  if (!fs.existsSync(cfgPath)) return null;
  try {
    const j = readJSON(cfgPath);
    const d = j.default_social_set ?? j.defaultSocialSet;
    if (d != null && String(d).trim() !== '') return String(d);
  } catch {
    /* ignore */
  }
  return null;
}
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
      return (
        execSync(`doppler secrets get ${name} --project ${project} --config ${config} --plain`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || null
      );
    } catch {
      return process.env[name] || null;
    }
  }
  return process.env[ref] || ref; // raw env name or literal
}

const GRAPH = 'https://graph.facebook.com/v21.0';
const GADS_API = 'https://googleads.googleapis.com/v24';

async function graphGet(url, timeoutMs = 20000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try {
        msg = (await r.json()).error?.message || msg;
      } catch {}
      return { ok: false, reason: msg };
    }
    return { ok: true, json: await r.json() };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function graphAuth(token, proof) {
  const q = new URLSearchParams({ access_token: token });
  if (proof) q.set('appsecret_proof', proof);
  return q;
}

function creativeVideoIds(cr) {
  const oss = cr.object_story_spec || {};
  return oss.video_data && oss.video_data.video_id ? [String(oss.video_data.video_id)] : [];
}

function isVideoCreative(cr) {
  if (creativeVideoIds(cr).length) return true;
  if (cr.video_id) return true;
  return ((cr.asset_feed_spec && cr.asset_feed_spec.videos) || []).length > 0;
}

function creativeImageHashes(cr) {
  const hashes = [];
  if (cr.image_hash) hashes.push(cr.image_hash);
  const oss = cr.object_story_spec || {};
  if (oss.video_data && oss.video_data.image_hash) hashes.push(oss.video_data.image_hash);
  if (oss.photo_data && oss.photo_data.image_hash) hashes.push(oss.photo_data.image_hash);
  if (oss.link_data && oss.link_data.image_hash) hashes.push(oss.link_data.image_hash);
  for (const im of (cr.asset_feed_spec && cr.asset_feed_spec.images) || []) {
    if (im.hash) hashes.push(im.hash);
  }
  for (const v of (cr.asset_feed_spec && cr.asset_feed_spec.videos) || []) {
    if (v.thumbnail_hash) hashes.push(v.thumbnail_hash);
  }
  return [...new Set(hashes)];
}

function hiResFromVideo(meta) {
  if (!meta || meta.error) return null;
  const thumbs = (meta.thumbnails && meta.thumbnails.data) || [];
  const ranked = thumbs.slice().sort((a, b) => {
    const pref = (b.is_preferred ? 1 : 0) - (a.is_preferred ? 1 : 0);
    if (pref) return pref;
    return (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0);
  });
  if (ranked[0] && ranked[0].uri) return ranked[0].uri;
  const fmts = (meta.format || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0));
  return (fmts[0] && fmts[0].picture) || meta.picture || null;
}

function isBrowserDeadUrl(url) {
  return !url || url.includes('facebook.com/ads/image');
}

function pickCreativeMedia(cr, videoById, imageByHash) {
  const oss = cr.object_story_spec || {};
  const feed = cr.asset_feed_spec || {};
  const videoIds = creativeVideoIds(cr);
  let url = null;
  for (const id of videoIds) {
    url = hiResFromVideo(videoById[id]);
    if (url) break;
  }
  if (!url) url = cr.image_url;
  if (!url && oss.photo_data) url = oss.photo_data.url;
  if (!url && oss.link_data) url = oss.link_data.picture;
  if (!url) {
    const im = ((feed.images || []).find((x) => x.url) || {}).url;
    if (im) url = im;
  }
  if (!url) {
    for (const h of creativeImageHashes(cr)) {
      if (imageByHash[h]) {
        url = imageByHash[h];
        break;
      }
    }
  }
  if (isBrowserDeadUrl(url)) url = null;
  if (!url) url = cr.thumbnail_url;
  if (!url) return [];
  return [{ type: isVideoCreative(cr) ? 'video' : 'image', url, thumb: cr.thumbnail_url || url }];
}

/* ---------- rationale (deterministic heuristic) ---------- */
function deriveRationale(channel, copy, scheduledAt) {
  const hour = new Date(scheduledAt).getUTCHours();
  const slot =
    hour < 9
      ? 'Morning authority slot — high feed reach before the workday (EU midday / US-east pre-open).'
      : hour < 12
        ? 'Late-morning build-in-public slot — steady weekday browsing.'
        : hour < 14
          ? 'Midday window — peak US-morning engagement.'
          : hour < 17
            ? 'Afternoon professional window — best for LinkedIn long-form.'
            : 'Evening casual window — conversational/Threads-friendly.';
  const norm =
    {
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
  const seq = /(almost here|this week|coming|👀|something worth)/.test(t)
    ? 'Pre-launch teaser — builds anticipation ahead of the drop.'
    : /(it'?s here|is here|is live|now live|download|link in bio|on the app store)/.test(t)
      ? 'Launch beat — conversion-focused, drives the install.'
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
  const list = await fetch(`${base}/social-sets/${setId}/drafts?status=scheduled&limit=50&order_by=scheduled_date`, {
    headers: H,
  });
  if (!list.ok) return { ok: false, reason: `HTTP ${list.status}`, items: [] };
  const drafts = (await list.json()).results || [];
  const items = [];
  for (const d of drafts) {
    let full = d;
    try {
      const r = await fetch(`${base}/social-sets/${setId}/drafts/${d.id}?exclude_comment_markers=true`, { headers: H });
      if (r.ok) full = await r.json();
    } catch {}
    const plats = full.platforms || {};
    for (const [channel, p] of Object.entries(plats)) {
      if (!p || !p.enabled) continue;
      const posts = (p.posts || []).map((x) => x.text).filter(Boolean);
      if (!posts.length) continue;
      const copy = posts.join('\n\n———\n\n');
      items.push({
        id: `tf-${d.id}-${channel}`,
        channel,
        kind: 'post',
        type: posts.length > 1 ? 'thread' : 'text',
        scheduled_at: d.scheduled_date,
        copy,
        thread: posts.length > 1 ? posts : undefined,
        rationale: deriveRationale(channel, copy, d.scheduled_date),
        media: [],
        links: extractLinks(copy),
        char_count: copy.length,
        title: d.draft_title || null,
        source: { engine: 'typefully', ref: String(d.id), edit_url: d.private_url || null },
      });
    }
  }
  return { ok: true, count: items.length, items };
}

async function fetchUploadPost(profile, key) {
  if (!key) return { ok: false, reason: 'no api key', items: [] };
  const r = await fetch('https://api.upload-post.com/api/uploadposts/schedule', {
    headers: { Authorization: `Apikey ${key}` },
  });
  if (!r.ok) return { ok: false, reason: `HTTP ${r.status}`, items: [] };
  const data = await r.json();
  const posts = (data.scheduled_posts || []).filter((p) => !profile || p.profile_username === profile);
  const items = posts.flatMap((p) =>
    (p.platforms || []).map((channel) => {
      const pc = (p.platform_content || {})[channel] || {};
      const copy = [pc.title || p.title, pc.caption || p.caption, pc.description || p.description]
        .filter(Boolean)
        .join('\n\n');
      const isVid = p.post_type === 'video';
      return {
        id: `up-${p.job_id}-${channel}`,
        channel,
        kind: 'post',
        type: p.post_type || 'photo',
        scheduled_at: p.original_scheduled_str || p.scheduled_date,
        copy,
        rationale: deriveRationale(channel, copy, p.original_scheduled_str || p.scheduled_date),
        media: p.preview_url
          ? [
              {
                type: isVid ? 'video' : 'image',
                url: p.preview_url,
                thumb: p.thumbnail_url || (isVid ? null : p.preview_url),
              },
            ]
          : [],
        links: extractLinks(copy),
        char_count: copy.length,
        title: null,
        source: { engine: 'upload-post', ref: p.job_id },
      };
    }),
  );
  return { ok: true, count: items.length, items };
}

/* ---------- ad fetchers (real; honest empty when no creds / no campaigns) ---------- */
async function fetchMetaAds(cfg) {
  const m = cfg.meta || {};
  const adAccountId = resolveSecret(m.ad_account_id);
  if (!adAccountId) return { ok: false, reason: 'no ad account', items: [] };
  const token = resolveSecret(m.access_token);
  if (!token) return { ok: false, reason: 'no token', items: [] };
  const secret = resolveSecret(m.app_secret);
  const proof = secret ? crypto.createHmac('sha256', secret).update(token).digest('hex') : null;
  const auth = graphAuth(token, proof);
  const adsUrl = new URL(GRAPH + '/' + adAccountId + '/ads');
  adsUrl.search = auth.toString();
  adsUrl.searchParams.set(
    'fields',
    'name,effective_status,created_time,creative{title,body,thumbnail_url,image_url,image_hash,video_id,object_story_spec{link_data{picture,image_hash},video_data{video_id,image_url,image_hash},photo_data{url,image_hash}},asset_feed_spec{images{hash,url},videos{video_id,thumbnail_url,thumbnail_hash}}},adset{daily_budget,targeting{publisher_platforms}}',
  );
  adsUrl.searchParams.set('limit', '50');
  const adsRes = await graphGet(adsUrl, 20000);
  if (!adsRes.ok) return { ok: false, reason: adsRes.reason, items: [] };
  const ads = (adsRes.json && adsRes.json.data) || [];

  const videoIds = [...new Set(ads.flatMap((a) => creativeVideoIds(a.creative || {})))];
  const videoById = {};
  if (videoIds.length) {
    const vUrl = new URL(GRAPH + '/');
    vUrl.search = auth.toString();
    vUrl.searchParams.set('ids', videoIds.join(','));
    vUrl.searchParams.set('fields', 'picture,format,thumbnails.limit(8){uri,height,width,is_preferred}');
    const vRes = await graphGet(vUrl, 20000);
    if (vRes.ok && vRes.json) Object.assign(videoById, vRes.json);
  }

  const hashes = [
    ...new Set(
      ads.flatMap((a) => {
        const cr = a.creative || {};
        if (cr.image_url) return [];
        if (creativeVideoIds(cr).some((id) => hiResFromVideo(videoById[id]))) return [];
        return creativeImageHashes(cr);
      }),
    ),
  ];
  const imageByHash = {};
  for (let i = 0; i < hashes.length; i += 8) {
    const chunk = hashes.slice(i, i + 8);
    const iUrl = new URL(GRAPH + '/' + adAccountId + '/adimages');
    iUrl.search = auth.toString();
    iUrl.searchParams.set('hashes', JSON.stringify(chunk));
    iUrl.searchParams.set('fields', 'hash,url,permalink_url,original_width,original_height');
    const iRes = await graphGet(iUrl, 15000);
    for (const im of (iRes.ok && iRes.json && iRes.json.data) || []) {
      if (im.hash && im.url) imageByHash[im.hash] = im.url;
    }
  }

  const items = ads.map((a) => {
    const cr = a.creative || {};
    const pp = a.adset?.targeting?.publisher_platforms || [];
    let channel = pp.includes('instagram') && !pp.includes('facebook') ? 'instagram' : pp[0] || 'facebook';
    if (channel === 'audience_network' || channel === 'messenger') channel = 'meta';
    const budget = a.adset?.daily_budget ? ' · $' + (a.adset.daily_budget / 100).toFixed(0) + '/day' : '';
    const copy = [cr.title, cr.body].filter(Boolean).join('\n\n') || a.name;
    const media = pickCreativeMedia(cr, videoById, imageByHash);
    return {
      id: 'meta-' + a.id,
      channel,
      kind: 'ad',
      type: media[0] && media[0].type === 'video' ? 'video' : 'ad',
      scheduled_at: a.created_time || null,
      ad_status: a.effective_status,
      copy,
      rationale: 'Meta ad · ' + a.effective_status + budget + ' · placement: ' + (pp.join(', ') || 'auto') + '.',
      media,
      links: [],
      char_count: copy.length,
      title: a.name,
      source: { engine: 'meta-ads', ref: a.id },
    };
  });
  return { ok: true, count: items.length, items };
}
async function fetchGoogleAds(cfg) {
  const g = cfg.google_ads || {};
  const customerId = resolveSecret(g.customer_id);
  if (!customerId) return { ok: false, reason: 'not configured', items: [] };
  const devToken = resolveSecret(g.developer_token),
    cid = resolveSecret(g.client_id),
    csec = resolveSecret(g.client_secret),
    refresh = resolveSecret(g.refresh_token);
  if (!devToken || !cid || !csec || !refresh) return { ok: false, reason: 'missing oauth creds', items: [] };
  let access;
  try {
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cid,
        client_secret: csec,
        refresh_token: refresh,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!tr.ok) return { ok: false, reason: 'oauth HTTP ' + tr.status, items: [] };
    access = (await tr.json()).access_token;
  } catch (e) {
    return { ok: false, reason: e.message, items: [] };
  }
  const cust = String(customerId).replace(/-/g, '');
  const headers = {
    Authorization: 'Bearer ' + access,
    'developer-token': devToken,
    'Content-Type': 'application/json',
  };
  const loginCustomerId = g.login_customer_id ? resolveSecret(g.login_customer_id) : null;
  if (loginCustomerId) headers['login-customer-id'] = String(loginCustomerId).replace(/-/g, '');
  const query =
    "SELECT campaign.name, campaign.status, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.final_urls FROM ad_group_ad WHERE campaign.status != 'REMOVED' LIMIT 50";
  let rows = [];
  try {
    const r = await fetch(GADS_API + '/customers/' + cust + '/googleAds:search', {
      method: 'POST',
      headers,
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try {
        const j = await r.json();
        msg = (j.error?.message || JSON.stringify(j)).slice(0, 160);
      } catch {}
      return { ok: false, reason: msg, items: [] };
    }
    const data = await r.json();
    rows = (Array.isArray(data) ? data : [data]).flatMap((b) => b.results || []);
  } catch (e) {
    return { ok: false, reason: e.message, items: [] };
  }
  const items = rows.map((row, i) => {
    const ad = row.adGroupAd?.ad || {};
    const heads = (ad.responsiveSearchAd?.headlines || []).map((h) => h.text).filter(Boolean);
    const copy = heads.join(' · ') || row.campaign?.name || 'ad';
    return {
      id: 'gads-' + i,
      channel: 'google-search',
      kind: 'ad',
      type: 'ad',
      scheduled_at: null,
      ad_status: row.campaign?.status,
      copy,
      rationale: 'Google Ads · "' + (row.campaign?.name || '') + '" · ' + (row.campaign?.status || '') + '.',
      media: [],
      links: ad.finalUrls || [],
      char_count: copy.length,
      title: row.campaign?.name,
      source: { engine: 'google-ads', ref: String(i) },
    };
  });
  return { ok: true, count: items.length, items };
}

/* ---------- collect ---------- */
async function collect() {
  const prefs = readJSON(PREFS_PATH);
  const mk = prefs.marketing || {};
  const engineStatus = {};
  const identities = [];
  const note = (eng, res) => {
    const s = engineStatus[eng] || { ok: false, count: 0 };
    s.ok = s.ok || res.ok;
    s.count += res.count || 0;
    if (res.reason) s.reason = res.reason;
    engineStatus[eng] = s;
  };

  // personal identities
  for (const [id, p] of Object.entries((mk.social_identities && mk.social_identities.personal) || {})) {
    let res = { ok: false, items: [] };
    const engine = p.engine || 'typefully';
    if (engine === 'typefully') {
      const setId = resolveTypefullySocialSetId(p, prefs);
      if (setId) res = await fetchTypefully(setId);
    }
    const engKey = engine === 'typefully' ? 'typefully' : engine;
    note(engKey, res);
    identities.push({
      id,
      label: (p.aka && p.aka.join(' / ')) || id,
      kind: 'personal',
      engine,
      status: res.ok ? 'ok' : res.reason || 'error',
      channels: [...new Set(res.items.map((i) => i.channel))].sort(),
      items: res.items,
    });
  }

  // project brands — organic posts (social.engine) + paid ads (meta/google, independent of organic engine)
  for (const [proj, cfg] of Object.entries(mk.projects || {})) {
    const s = cfg.social || {};
    const eng = (s.engine && s.engine.primary) || null;
    let postRes = { ok: false, items: [], status: s.engine && s.engine.status };
    if (eng === 'upload-post') {
      const up = s.engine.upload_post || {};
      postRes = await fetchUploadPost(up.user || proj, resolveSecret(up.api_key_ref));
    } else if (eng === 'typefully' && s.typefully_social_set_id) {
      postRes = await fetchTypefully(s.typefully_social_set_id);
    }
    if (eng) note(eng, postRes);
    const meta = await fetchMetaAds(cfg);
    if (cfg.meta && cfg.meta.ad_account_id) note('meta-ads', meta);
    const gads = await fetchGoogleAds(cfg);
    if (cfg.google_ads && cfg.google_ads.customer_id) note('google-ads', gads);
    const items = [...postRes.items, ...meta.items, ...gads.items];
    identities.push({
      id: proj,
      label: proj,
      kind: 'project',
      engine: eng,
      status: eng ? (postRes.ok ? 'ok' : postRes.status || postRes.reason || 'error') : 'unprovisioned',
      ad_status: {
        'meta-ads': meta.ok ? String(meta.count) : meta.reason || '-',
        'google-ads': gads.ok ? String(gads.count) : gads.reason || '-',
      },
      channels: [...new Set(items.map((i) => i.channel))].sort(),
      items,
    });
  }

  const state = {
    generated_at: new Date().toISOString(),
    timezone: prefs.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    engine_status: engineStatus,
    identities,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(state, null, 2));
  const total = identities.reduce((n, i) => n + i.items.length, 0);
  log(`collected ${total} items across ${identities.length} identities → ${OUT}`);
  return state;
}

/* ---------- serve ---------- */
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};
function serve() {
  const srv = http.createServer((req, res) => {
    let url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/' || url === '') url = '/index.html';
    let file;
    if (url === '/state.json') {
      file = fs.existsSync(OUT) ? OUT : path.join(UI_DIR, 'state.sample.json');
    } else {
      const rel = path
        .normalize(url)
        .replace(/^(\.\.[/\\])+/, '')
        .replace(/^[/\\]+/, '');
      file = path.join(UI_DIR, rel);
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
  srv.listen(PORT, '127.0.0.1', () => {
    const u = `http://127.0.0.1:${PORT}/`;
    log(`serving ${u}`);
    console.log(u);
    if (cmd !== 'serve' && flag('--no-open', false) === false) {
      try {
        spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [u], { stdio: 'ignore', detached: true }).unref();
      } catch {}
    }
  });
}

(async () => {
  try {
    if (cmd === 'collect' || cmd === 'all' || collectOnly) await collect();
    if (!collectOnly && (cmd === 'serve' || cmd === 'open' || cmd === 'all')) serve();
    else if (!collectOnly) process.exit(0);
  } catch (e) {
    log('ERROR', e.message);
    process.exit(1);
  }
})();
