// ops-social-planner UI — fetch normalized state, render per identity → channel → time.
// Zero deps. State lives in the URL hash so views are shareable.
const $ = (s, r = document) => r.querySelector(s);
const el = (t, p = {}, ...kids) => {
  const n = Object.assign(document.createElement(t), p);
  for (const k of kids) n.append(k?.nodeType ? k : document.createTextNode(k ?? ''));
  return n;
};
const CH_ICON = {
  x: '𝕏',
  twitter: '𝕏',
  linkedin: 'in',
  threads: '@',
  instagram: '◎',
  facebook: 'f',
  reddit: 'r/',
  youtube: '▶',
  google_business: '📍',
  tiktok: '♪',
  bluesky: '🦋',
  mastodon: '🐘',
};
const fmtDate = (iso, tz) => {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: tz }),
    rel: relTime(d),
  };
};
function relTime(d) {
  const s = (d - Date.now()) / 1000,
    a = Math.abs(s),
    f = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (a < 3600) return f.format(Math.round(s / 60), 'minute');
  if (a < 86400) return f.format(Math.round(s / 3600), 'hour');
  return f.format(Math.round(s / 86400), 'day');
}

const state = { data: null, id: null, view: 'posts', channel: null, q: '' };

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  state.id = h.get('id') || state.id;
  state.view = h.get('view') || state.view;
  state.channel = h.get('channel') || null;
  state.q = h.get('q') || '';
}
function writeHash() {
  const h = new URLSearchParams();
  if (state.id) h.set('id', state.id);
  h.set('view', state.view);
  if (state.channel) h.set('channel', state.channel);
  if (state.q) h.set('q', state.q);
  history.replaceState(null, '', `#${h}`);
}

async function load() {
  const r = await fetch('./state.json', { cache: 'no-store' });
  state.data = await r.json();
  const ids = state.data.identities || [];
  if (!state.id || !ids.find((i) => i.id === state.id)) state.id = (ids.find((i) => i.items.length) || ids[0] || {}).id;
  renderMeta();
  renderIdentities();
  renderChannels();
  render();
}

function curIdentity() {
  return (state.data.identities || []).find((i) => i.id === state.id) || { items: [] };
}
function visibleItems() {
  let it = (curIdentity().items || []).filter((i) => (i.kind || 'post') === (state.view === 'ads' ? 'ad' : 'post'));
  if (state.channel) it = it.filter((i) => i.channel === state.channel);
  if (state.q) {
    const q = state.q.toLowerCase();
    it = it.filter((i) => (i.copy || '').toLowerCase().includes(q) || (i.title || '').toLowerCase().includes(q));
  }
  return it.sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
}

function renderMeta() {
  const d = state.data;
  $('#sub').textContent = `${(d.identities || []).length} accounts · ${d.timezone || ''}`;
  const gen = d.generated_at ? `updated ${relTime(new Date(d.generated_at))}` : '';
  const es = Object.entries(d.engine_status || {}).map(([k, v]) => {
    const cls = v.ok ? 'ok' : v.reason === 'hook-pending' ? 'idle' : 'bad';
    return el(
      'span',
      {},
      Object.assign(document.createElement('span'), { className: `dot ${cls}` }),
      `${k}${v.reason && !v.ok ? ` (${v.reason})` : ''}`,
    );
  });
  const m = $('#meta');
  m.innerHTML = '';
  es.forEach((x) => m.append(x));
  if (gen) m.append(el('span', {}, gen));
}
function renderIdentities() {
  const box = $('#identities');
  box.innerHTML = '';
  for (const i of state.data.identities || []) {
    const b = el('button', {
      onclick: () => {
        state.id = i.id;
        state.channel = null;
        writeHash();
        renderIdentities();
        renderChannels();
        render();
      },
    });
    b.setAttribute('aria-pressed', i.id === state.id);
    b.append(
      el('span', { className: `kind-tag kind-${i.kind || 'project'}` }, i.kind === 'personal' ? 'personal' : 'brand'),
      i.label,
    );
    b.append(el('span', { className: 'pill' }, String(i.items.length)));
    box.append(b);
  }
  const posts = (curIdentity().items || []).filter((i) => (i.kind || 'post') === 'post').length;
  const ads = (curIdentity().items || []).filter((i) => i.kind === 'ad').length;
  $('#n-posts').textContent = posts;
  $('#n-ads').textContent = ads;
}
function renderChannels() {
  const box = $('#channels');
  box.innerHTML = '';
  const items = (curIdentity().items || []).filter(
    (i) => (i.kind || 'post') === (state.view === 'ads' ? 'ad' : 'post'),
  );
  const counts = {};
  items.forEach((i) => (counts[i.channel] = (counts[i.channel] || 0) + 1));
  const all = el('button', {
    className: 'chip',
    onclick: () => {
      state.channel = null;
      writeHash();
      renderChannels();
      render();
    },
  });
  all.setAttribute('aria-pressed', !state.channel);
  all.append('All ', el('span', { className: 'n' }, String(items.length)));
  box.append(all);
  for (const ch of Object.keys(counts).sort()) {
    const c = el('button', {
      className: 'chip',
      onclick: () => {
        state.channel = ch;
        writeHash();
        renderChannels();
        render();
      },
    });
    c.setAttribute('aria-pressed', state.channel === ch);
    c.append(
      el('span', {}, CH_ICON[ch] || '•'),
      ' ',
      ch.replace('_', ' '),
      ' ',
      el('span', { className: 'n' }, String(counts[ch])),
    );
    box.append(c);
  }
}
function card(i, tz) {
  const c = el('div', { className: 'card' });
  const w = i.scheduled_at ? fmtDate(i.scheduled_at, tz) : null;
  const when = el(
    'div',
    { className: 'when' },
    el('span', { className: 'date' }, w ? w.date : i.ad_status || 'active'),
    el('span', { className: 'rel' }, w ? `${w.time} · ${w.rel}` : 'ongoing'),
    el(
      'span',
      { className: `badge ${i.kind === 'ad' ? 'video' : i.type || ''}` },
      i.kind === 'ad' ? i.ad_status || 'ad' : i.type || 'post',
    ),
  );
  c.append(when);
  if (i.title) c.append(el('div', { className: 'title' }, i.title));
  if (i.media && i.media.length) {
    const m = i.media[0];
    const md = el('div', { className: 'media' });
    if (m.thumb || m.url) md.append(el('img', { src: m.thumb || m.url, loading: 'lazy', alt: '' }));
    if (m.type === 'video') md.append(el('span', { className: 'vid-badge' }, '▶ video'));
    c.append(md);
  }
  const copy = el('div', { className: 'copy' }, i.copy || '');
  c.append(copy);
  requestAnimationFrame(() => {
    if (copy.scrollHeight > copy.clientHeight + 4) {
      copy.classList.add('clamped');
      const more = el('button', { className: 'more' }, 'Show more');
      more.onclick = () => {
        const e = copy.classList.toggle('expanded');
        more.textContent = e ? 'Show less' : 'Show more';
      };
      copy.after(more);
    }
  });
  if (i.rationale) c.append(el('div', { className: 'rationale' }, el('b', {}, 'Why this slot — '), i.rationale));
  if (i.links && i.links.length) {
    const lk = el('div', { className: 'links' });
    i.links.forEach((u) =>
      lk.append(
        el('a', { className: 'link-chip', href: u, target: '_blank', rel: 'noopener' }, u.replace(/^https?:\/\//, '')),
      ),
    );
    c.append(lk);
  }
  const src = (i.source && i.source.engine) || i.engine || '';
  const foot = el('div', { className: 'foot' }, el('span', { className: 'src' }, src));
  if (i.source && i.source.edit_url)
    foot.append(el('a', { href: i.source.edit_url, target: '_blank', rel: 'noopener' }, 'open'));
  foot.append(el('span', { className: 'cc' }, `${i.char_count || (i.copy || '').length} chars`));
  c.append(foot);
  return c;
}
function render() {
  writeHash();
  for (const b of $('#views').children) b.setAttribute('aria-pressed', b.dataset.view === state.view);
  const board = $('#board');
  board.innerHTML = '';
  const ident = curIdentity(),
    tz = state.data.timezone;
  if (state.view === 'ads') {
    if (ident.status === 'unprovisioned') {
      board.append(
        stateMsg(
          '🔒',
          'Fail-closed — no engine registered',
          `${ident.label} has no social publishing engine. It will not post until one is registered (own upload-post profile or first-party Meta Graph).`,
        ),
      );
      return;
    }
    const st = state.data.engine_status || {};
    const pend = ident.engine && (st[ident.engine] || {}).reason === 'hook-pending';
    const adsItems = visibleItems();
    if (!adsItems.length) {
      if (state.q || state.channel) {
        board.append(
          stateMsg('📣', 'Nothing here', state.q ? 'No ads match your search.' : 'No ads match this channel.'),
        );
        return;
      }
      board.append(
        stateMsg(
          '📣',
          ident.items.some((i) => i.kind === 'ad') ? '' : 'No ads collected',
          pend
            ? 'Ad collectors (Meta / Google Ads) are scaffolded — the live fetch hook is pending. Posts are fully wired today.'
            : 'No paid campaigns for this account.',
        ),
      );
      return;
    }
  }
  if (state.view !== 'ads' && ident.status === 'unprovisioned') {
    board.append(
      stateMsg(
        '🔒',
        'Fail-closed — no engine registered',
        `${ident.label} has no social publishing engine. It will not post until one is registered (own upload-post profile or first-party Meta Graph).`,
      ),
    );
    return;
  }
  const items = visibleItems();
  if (!items.length) {
    board.append(
      stateMsg(
        '🗓️',
        'Nothing scheduled here',
        state.q ? 'No posts match your search.' : 'No scheduled posts for this view.',
      ),
    );
    return;
  }
  const byCh = {};
  items.forEach((i) => (byCh[i.channel] = byCh[i.channel] || []).push(i));
  const order = state.channel ? [state.channel] : Object.keys(byCh).sort();
  for (const ch of order) {
    const col = el('div', { className: 'col' });
    col.append(
      el(
        'div',
        { className: 'col-head' },
        el('span', { className: 'ch-icon' }, CH_ICON[ch] || '•'),
        el('span', { className: 'ch-name' }, ch.replace('_', ' ')),
        el('span', { className: 'ch-count' }, `${byCh[ch].length}`),
      ),
    );
    const body = el('div', { className: 'col-body' });
    byCh[ch].forEach((i) => body.append(card(i, tz)));
    col.append(body);
    board.append(col);
  }
}
function stateMsg(big, h, p) {
  return el('div', { className: 'state-msg' }, el('div', { className: 'big' }, big), el('h2', {}, h), el('p', {}, p));
}

// theme
const themeKey = 'ops-planner-theme';
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(themeKey, t);
}
$('#theme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
applyTheme(localStorage.getItem(themeKey) || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
$('#refresh').onclick = () => load();
$('#search').oninput = (e) => {
  state.q = e.target.value;
  render();
};
for (const b of $('#views').children)
  b.onclick = () => {
    state.view = b.dataset.view;
    state.channel = null;
    renderIdentities();
    renderChannels();
    render();
  };

readHash();
$('#search').value = state.q;
addEventListener('hashchange', () => {
  const prev = state.q;
  readHash();
  if (state.q !== prev) $('#search').value = state.q;
  renderIdentities();
  renderChannels();
  render();
});
load().catch((e) => {
  $('#board').append(stateMsg('⚠️', 'Could not load state', String(e.message)));
});
