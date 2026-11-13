// SPEEKS Marketplace Lister — the toolbar popup.
// Sign in → pick a store → search → open an item → "Fill on Facebook".
// The "Listed" tab is everything filled from this computer, with a check
// against Shopify so a sold item can be marked sold on Facebook.

const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false, error: chrome.runtime.lastError?.message || 'No answer.' })));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const SKU_RE = /^(KS01|MO0[1-4])-\S+$/i;

let catalog = { store: null, items: [] };
let who = null;

function say(id, text, bad) { const el = $(id); el.textContent = text || ''; el.className = 'msg' + (bad ? ' bad' : ''); }

async function show() {
  const r = await send({ type: 'me' });
  who = r.who || null;
  $('signin').hidden = !!who;
  $('app').hidden = !who;
  $('who').textContent = who ? who.name : '';
  if (!who) { if (r.error) say('signinMsg', r.error, true); $('pin').focus(); return; }
  if (r.offline) say('listMsg', 'SPEEKSNET is not answering: ' + r.offline, true);
  // Only the stores SPEEKSNET says this person may see (one, for anyone at a
  // store). The server enforces the same list; this just doesn't offer the rest.
  const stores = (who.stores && who.stores.length) ? who.stores : [who.store].filter(Boolean);
  $('store').innerHTML = stores.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  storePicker.host.hidden = stores.length < 2;
  $('who').textContent = who.name + (stores.length === 1 ? ' · ' + stores[0] : '');
  const saved = (await chrome.storage.local.get('store')).store;
  $('store').value = stores.includes(saved) ? saved : (stores.includes(who.store) ? who.store : stores[0]);
  storePicker.sync();
  loadCatalog();
  countListed();
}

$('signinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  say('signinMsg', 'Signing in…');
  const r = await send({ type: 'login', pin: $('pin').value });
  $('pin').value = '';
  if (!r.ok) return say('signinMsg', r.error, true);
  say('signinMsg', '');
  show();
});

$('logout').onclick = async () => { await send({ type: 'logout' }); show(); };

document.querySelectorAll('.tab').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === b));
  $('tab-list').hidden = b.dataset.tab !== 'list';
  $('tab-listed').hidden = b.dataset.tab !== 'listed';
  $('tab-groups').hidden = b.dataset.tab !== 'groups';
  if (b.dataset.tab === 'listed') renderListed();
  if (b.dataset.tab === 'groups') renderGroups();
});

// ── Store picker (CORP only — everyone else has one store) ──────────────────
// SPEEKSNET's own dropdown, not the native <select> (Ethan, 11-13): Chrome
// draws a select's open list itself, square and blue, and no stylesheet can
// reach it. Same idea as _ddEnhance in speeks.js: the <select> stays as the
// value everything reads, hidden, and a button + list is drawn in its place.
// Classes and colours are copied from styles.css (.dd-btn/.dd-list/.dd-opt).
const storePicker = (() => {
  const sel = $('store');
  sel.classList.add('dd-native');
  const host = document.createElement('div');
  host.className = 'dd-host';
  host.innerHTML = '<button type="button" class="dd-btn" aria-haspopup="listbox" aria-expanded="false"><span class="dd-cur"></span>'
    + '<svg class="dd-chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>'
    + '<div class="dd-list" role="listbox"></div>';
  sel.after(host);
  const btn = host.querySelector('.dd-btn'), list = host.querySelector('.dd-list');
  const close = () => { host.classList.remove('open'); list.classList.remove('dd-open'); btn.setAttribute('aria-expanded', 'false'); };
  const sync = () => { host.querySelector('.dd-cur').textContent = sel.value || ''; };
  btn.onclick = () => {
    if (host.classList.contains('open')) return close();
    list.innerHTML = [...sel.options].map((o) =>
      `<button type="button" class="dd-opt${o.value === sel.value ? ' on' : ''}" role="option" data-v="${esc(o.value)}">${esc(o.textContent)}</button>`).join('');
    list.querySelectorAll('.dd-opt').forEach((b) => b.onclick = () => {
      close();
      if (sel.value === b.dataset.v) return;
      sel.value = b.dataset.v; sync();
      sel.dispatchEvent(new Event('change'));
    });
    // Fixed, under the face: the tab pane scrolls, and an absolute list would
    // be clipped by it.
    const r = btn.getBoundingClientRect();
    list.style.left = r.left + 'px'; list.style.top = (r.bottom + 4) + 'px'; list.style.minWidth = r.width + 'px';
    host.classList.add('open'); list.classList.add('dd-open'); btn.setAttribute('aria-expanded', 'true');
    (list.querySelector('.dd-opt.on') || list.querySelector('.dd-opt'))?.focus();
  };
  document.addEventListener('mousedown', (e) => { if (!host.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => {
    if (!host.classList.contains('open')) return;
    if (e.key === 'Escape') { close(); btn.focus(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const opts = [...list.querySelectorAll('.dd-opt')], i = opts.indexOf(document.activeElement);
      opts[(i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length]?.focus();
    }
  });
  return { host, sync };
})();

// ── List an item ─────────────────────────────────────────────────────────────

$('store').onchange = () => { chrome.storage.local.set({ store: $('store').value }); loadCatalog(); };
let qTimer = null;
$('q').oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(renderResults, 120); };

async function loadCatalog() {
  const store = $('store').value;
  $('detail').hidden = true; $('results').hidden = false;
  $('results').innerHTML = '';
  say('listMsg', `Loading ${store}'s in-stock items…`);
  const r = await send({ type: 'catalog', store });
  if (!r.ok) { if (r.status === 401) return show(); return say('listMsg', r.error, true); }
  // Newest listed first (Ethan, 11-13). The function already orders by the
  // Shopify product's created date; sorting here too keeps it true if that
  // query ever changes.
  const t = (i) => Date.parse(i.added || '') || 0;
  catalog = { store, items: (r.items || []).sort((a, b) => t(b) - t(a)), refreshed: r.refreshed, next: r.next_refresh };
  renderResults();
}

// Lead photos: ebay_catalog has no image URL, so ask the function for the
// rows on screen and remember them for the popup's life. No photo, no harm —
// the row shows a blank tile.
const thumbs = {};
async function loadThumbs(store, items) {
  const want = items.map((i) => i.product_id).filter((id) => id && !(id in thumbs));
  paintThumbs();
  if (!want.length) return;
  for (const id of want) thumbs[id] = '';   // asked for — don't ask again while typing
  const r = await send({ type: 'thumbs', store, product_ids: want });
  if (!r.ok) return;
  for (const id of want) thumbs[id] = (r.thumbs || {})[id] || '';
  if (catalog.store !== store) return;
  // Sold since the hourly refresh: Shopify (live) says it's gone, so it leaves
  // the list now rather than at the next refresh (Ethan, 11-13).
  if ((r.gone || []).length) { dropSold(r.gone); renderResults(); return; }
  paintThumbs();
}
function dropSold(ids) {
  const gone = new Set(ids);
  catalog.items = catalog.items.filter((i) => !gone.has(i.product_id));
}
function paintThumbs() {
  $('results').querySelectorAll('.thumb[data-pid]').forEach((el) => {
    const u = thumbs[el.dataset.pid];
    if (u && !el.firstChild) el.innerHTML = `<img src="${esc(u + (u.includes('?') ? '&' : '?') + 'width=96')}" alt="" loading="lazy">`;
  });
}

const shortDate = (s) => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
// "12:28 PM", or "Nov 12, 3:28 PM" when it isn't today.
const when = (s) => {
  const d = new Date(s); if (!s || isNaN(d)) return '';
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${shortDate(s)}, ${time}`;
};
function renderRefresh() {
  const el = $('refresh');
  const last = when(catalog.refreshed), next = when(catalog.next);
  el.textContent = last || next ? `List Updated ${last || '—'}${next ? ` · Next ${next}` : ''}` : '';
}

function renderResults() {
  $('detail').hidden = true; $('results').hidden = false;
  const q = $('q').value.trim().toLowerCase();
  const hits = catalog.items.filter((i) => !q || `${i.title} ${i.sku}`.toLowerCase().includes(q));
  const shown = hits.slice(0, 150);
  // Just the count (Ethan, 11-13). Only the newest 150 are drawn; search
  // reaches the rest.
  say('listMsg', `${hits.length.toLocaleString()} ${q ? 'Matching' : 'In Stock'} At ${catalog.store}`);
  $('listBar').hidden = false;
  $('results').innerHTML = shown.map((i, n) => `
    <div class="item" data-n="${n}">
      <span class="thumb" data-pid="${esc(i.product_id || '')}"></span>
      <div class="t"><b title="${esc(i.title)}">${esc(i.title)}</b><span class="meta"><span class="sku" title="${esc(i.sku)}">${esc(i.sku)}</span><span class="cond">${esc(i.condition || '—')}</span><span class="dt">${esc(shortDate(i.added))}</span></span></div>
      <div class="p">${money(i.price)}</div>
    </div>`).join('')
    + (!hits.length && SKU_RE.test($('q').value.trim())
      ? `<div class="note">Not in the in-stock list. <button id="bySku">Look up ${esc($('q').value.trim())} in Shopify</button></div>` : '');
  $('results').querySelectorAll('.item').forEach((el) => el.onclick = () => {
    const i = shown[Number(el.dataset.n)];
    openItem(i.sku, i.product_id);
  });
  const by = $('bySku'); if (by) by.onclick = () => openItem($('q').value.trim(), null);
  renderRefresh();
  loadThumbs(catalog.store, shown);
}

async function openItem(sku, productId) {
  $('results').hidden = true;
  $('listBar').hidden = true;   // no search bar inside an item (Ethan, 11-13)
  const d = $('detail'); d.hidden = false;
  d.innerHTML = '<div class="msg">Reading it from Shopify…</div>';
  say('listMsg', '');
  const r = await send({ type: 'item', sku, product_id: productId });
  if (!r.ok) { d.innerHTML = `<div class="msg bad">${esc(r.error)}</div><div class="acts"><button id="back">Back</button></div>`; $('back').onclick = renderResults; return; }

  if (r.choose) {
    // BAL reuses SKUs across products — the person picks which one.
    d.innerHTML = `<div class="note">${esc(sku)} is on ${r.choose.length} Shopify products. Which one?</div>`
      + r.choose.map((c, n) => `<div class="item" data-n="${n}"><div class="t"><b>${esc(c.title)}</b><span>${c.quantity} in stock · ${esc(String(c.status).toLowerCase())}</span></div><div class="p">${money(c.price)}</div></div>`).join('')
      + '<div class="acts"><button id="back">Back</button></div>';
    d.querySelectorAll('.item').forEach((el) => el.onclick = () => openItem(sku, r.choose[Number(el.dataset.n)].product_id));
    $('back').onclick = renderResults;
    return;
  }

  const { item, fb, warnings } = r;
  // Sold: nothing to list. Take it off the list and say so, instead of
  // offering to fill a listing for something we don't have.
  if (Number(item.quantity) <= 0) {
    catalog.items = catalog.items.filter((i) => !(i.sku === item.sku && String(i.product_id || '').endsWith('/' + item.product_id)));
    d.innerHTML = `<div class="note">${esc(item.title)} has sold — Shopify shows 0 in stock. It's off the list.</div><div class="acts"><button id="back">Back</button></div>`;
    $('back').onclick = renderResults;
    return;
  }
  d.innerHTML = `
    <div class="photos">${fb.photos.map((u) => `<img src="${esc(u + (u.includes('?') ? '&' : '?') + 'width=128')}" loading="lazy" alt="">`).join('') || '<span class="msg">No photos</span>'}</div>
    ${(warnings || []).map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
    <div class="kv">
      <span>Title</span><span>${esc(fb.title)}</span>
      <span>Price</span><span>${money(fb.price)}</span>
      <span>Condition</span><span>${esc(fb.condition || '—')}</span>
      <span>SKU</span><span>${esc(item.sku)} · ${esc(item.store)} · ${item.quantity} in stock</span>
    </div>
    <div class="desc">${esc(fb.description) || '<i>No description on Shopify.</i>'}</div>
    <div class="note">Opens Facebook Marketplace and fills this in. You pick the category, check it, and click Publish yourself.</div>
    <div class="acts"><button id="back">Back</button><button id="go" class="primary">Fill On Facebook</button></div>`;
  $('back').onclick = renderResults;
  $('go').onclick = async () => {
    $('go').disabled = true; $('go').textContent = 'Opening Facebook…';
    const s = await send({ type: 'start', sku: item.sku, product_id: item.product_id });
    if (!s.ok) { $('go').disabled = false; $('go').textContent = 'Fill On Facebook'; d.insertAdjacentHTML('afterbegin', `<div class="warn">${esc(s.error)}</div>`); }
  };
}

// ── Listed ───────────────────────────────────────────────────────────────────
// The background worker re-checks these against Shopify once a day and
// keeps the last answer in soldStatus, so this tab opens already knowing.

async function countListed() {
  const { listed = [] } = await chrome.storage.local.get('listed');
  // Just the number: the bubble is the bracket (Ethan, 11-13).
  $('listedCount').textContent = listed.length ? String(listed.length) : '';
}

// The list is the STORE's (fb_listings in SPEEKSNET), shared by everyone at
// it. Draws the cached copy at once, then asks the worker for the current one
// and draws again.
async function renderListed(synced) {
  if (!synced) {
    renderListed(true);  // the cached copy, straight away
    const r = await send({ type: 'listed' });
    if (!r.ok) return say('listedMsg', r.error, true);
  }
  const { listed = [], soldStatus } = await chrome.storage.local.get(['listed', 'soldStatus']);
  const st = soldStatus?.results || {};
  countListed();
  $('markAll').hidden = true;
  const where = (who?.stores?.length === 1) ? who.stores[0] : 'your stores';
  if (!listed.length) { $('listed').innerHTML = ''; return say('listedMsg', `Nothing listed on Facebook for ${where} yet.`); }
  const sold = listed.filter((l) => st[l.sku]?.status === 'sold');
  const when = soldStatus?.at ? ` Checked ${new Date(soldStatus.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : '';
  say('listedMsg', soldStatus
    ? (sold.length ? `${sold.length} Sold in Shopify —mark ${sold.length === 1 ? 'it' : 'them'} sold on Facebook, then press Marked Sold.${when}` : `${listed.length} Listed For ${where}, None Sold.${when}`)
    : `${listed.length} Listed For ${where}. Checked against Shopify once a day.`);
  $('markAll').hidden = sold.length < 1;
  // "Open", not "Mark": it opens Facebook's Selling page with the sold ones
  // outlined; the person still clicks Mark as sold there (Ethan, 11-13).
  $('markAllText').textContent = sold.length > 1 ? `Open ${sold.length} Sold On Facebook` : 'Open Sold On Facebook';
  // Sold first, so the ones to act on are at the top.
  const rank = (l) => ({ sold: 0, unknown: 1, instock: 2 }[st[l.sku]?.status] ?? 3);
  const rows = [...listed].sort((a, b) => rank(a) - rank(b));
  $('listed').innerHTML = rows.map((l, n) => {
    const s = st[l.sku];
    const isSold = s?.status === 'sold';
    return `<div class="item lrow" data-n="${n}" title="${esc(s?.reason || '')}">
      <div class="t"><b>${esc(l.title)}</b><span>${esc(l.sku)} · ${esc(shortDate(l.at))}${l.by ? ' · ' + esc(l.by) : ''}</span>${boostTag(l)}</div>
      ${/* Price on every row; a pill only for Sold, the one to act on. An
           "In Stock" pill used to replace the price, but only on rows the
           daily check had already seen, so rows listed since then showed a
           price instead and the list looked inconsistent (Ethan, 11-13). */
        isSold ? `<span class="pill sold">Sold</span>` : `<span class="p">${money(l.price)}</span>`}
      <div class="racts">
        ${isSold ? `<button class="small" data-find="${n}" title="Open Facebook Selling with this listing outlined">Find</button>` : `<button class="small" data-boost="${n}">${l.boosted_at ? 'Edit Boost' : 'Mark Boosted'}</button>`}
        <button class="small" data-forget="${n}">${isSold ? 'Marked Sold' : 'Remove'}</button>
      </div>
      <div class="rform" hidden></div>
    </div>`;
  }).join('');

  // REMOVE ASKS FIRST (Ethan, 11-13): it takes the row off the STORE's list,
  // for everyone, so say what it's for before doing it.
  $('listed').querySelectorAll('[data-forget]').forEach((b) => b.onclick = () => {
    const n = Number(b.dataset.forget), l = rows[n], isSold = st[l.sku]?.status === 'sold';
    openForm(n, `
      <div class="q"><b>Remove from ${esc(l.store)}'s list?</b>
        ${isSold
          ? `Only after you've marked it sold on Facebook.`
          : `Only once it's deleted or marked sold on Facebook.`}
        Everyone at ${esc(l.store)} will stop seeing it.</div>
      <div class="fa"><button class="small" data-x>Cancel</button><button class="small primary" data-ok>${isSold ? 'Marked Sold' : 'Remove'}</button></div>`,
      async (f) => {
        f.querySelector('[data-ok]').disabled = true;
        await send({ type: 'forget', id: l.id, sku: l.sku, product_id: l.product_id });
        renderListed(true);
      });
  });

  // MARK BOOSTED (Ethan, 11-13). Facebook doesn't tell us about a boost —
  // it's paid on the person's own account — so the person records it here:
  // days and total budget, as Facebook showed them. Feeds the weekly boost
  // email and the tag on the row.
  $('listed').querySelectorAll('[data-boost]').forEach((b) => b.onclick = () => {
    const n = Number(b.dataset.boost), l = rows[n];
    openForm(n, `
      <div class="q"><b>Record a boost</b> — the days and total budget you set on Facebook.</div>
      <div class="bf">
        <label>Days<input type="number" min="1" max="60" step="1" data-days value="${esc(l.boost_days || '')}" placeholder="7"></label>
        <label>Total Budget<input type="number" min="1" step="0.01" data-budget value="${esc(l.boost_budget || '')}" placeholder="20"></label>
      </div>
      <div class="fa"><button class="small" data-x>Cancel</button><button class="small primary" data-ok>Save Boost</button></div>`,
      async (f) => {
        const days = Number(f.querySelector('[data-days]').value), budget = Number(f.querySelector('[data-budget]').value);
        if (!(days >= 1 && days <= 60)) return f.querySelector('[data-days]').focus();
        if (!(budget > 0)) return f.querySelector('[data-budget]').focus();
        f.querySelector('[data-ok]').disabled = true;
        const r = await send({ type: 'boost', id: l.id, days, budget });
        if (!r.ok) { f.querySelector('.q').innerHTML = `<span class="bad">${esc(r.error)}</span>`; f.querySelector('[data-ok]').disabled = false; return; }
        renderListed();
      });
  });
  $('listed').querySelectorAll('[data-find]').forEach((b) => b.onclick = () => send({ type: 'openSold', items: [rows[Number(b.dataset.find)]] }));
}

// One small form under a Listed row at a time (confirm Remove, record a boost).
function openForm(n, html, onOk) {
  document.querySelectorAll('#listed .rform').forEach((f) => { f.hidden = true; f.innerHTML = ''; });
  const f = document.querySelector(`#listed .lrow[data-n="${n}"] .rform`);
  f.innerHTML = html; f.hidden = false;
  f.querySelector('[data-x]').onclick = () => { f.hidden = true; f.innerHTML = ''; };
  f.querySelector('[data-ok]').onclick = () => onOk(f);
  (f.querySelector('input') || f.querySelector('[data-ok]')).focus();
  f.scrollIntoView({ block: 'nearest' });
}

// "Boosted · 3 Days Left · $20", or "Boost Ended Nov 20 · $20".
function boostTag(l) {
  if (!l.boosted_at || !l.boost_ends_at) return '';
  const end = new Date(l.boost_ends_at), left = Math.ceil((end - Date.now()) / 864e5);
  const money$ = l.boost_budget ? ` · ${money(l.boost_budget)}` : '';
  return left > 0
    ? `<span class="btag on">Boosted · ${left} Day${left === 1 ? '' : 's'} Left${money$}</span>`
    : `<span class="btag">Boost Ended ${esc(shortDate(l.boost_ends_at))}${money$}</span>`;
}

$('markAll').onclick = () => send({ type: 'openSold', items: [] });

$('check').onclick = async () => {
  $('check').disabled = true;
  say('listedMsg', 'Checking Shopify…');
  const r = await send({ type: 'checkSold' });
  $('check').disabled = false;
  if (!r.ok) return say('listedMsg', r.error, true);
  renderListed(true);   // checkSold already pulled the store's list
};

// ── Groups ───────────────────────────────────────────────────────────────────
// Only the automatic-picks switch (chrome.storage.local, per computer, because
// each Facebook account is in different groups) and the group-search buttons.
// "Your Rules" is parked (Ethan, 11-13) — see the note in content.js.

const FIND = {
  KC: ['Kansas City buy sell trade', 'Kansas City electronics', 'Kansas City video games', 'Kansas City phones', 'Johnson County buy sell', 'Overland Park buy sell', "Lee's Summit buy sell", 'Westport KC buy sell'],
  STL: ['St Louis buy sell trade', 'St Louis electronics', 'St Louis video games', 'St Louis phones', 'West County STL buy sell', 'Ballwin buy sell', 'Maplewood buy sell', 'Chesterfield buy sell'],
};
const METRO = { OVL: 'KC', LEE: 'KC', WSP: 'KC', MPL: 'STL', BAL: 'STL' };
$('gAuto').onchange = () => chrome.storage.local.set({ groupAuto: $('gAuto').checked });

async function renderGroups() {
  const { groupAuto = true } = await chrome.storage.local.get('groupAuto');
  $('gAuto').checked = groupAuto;
  const metros = [...new Set(((who && who.stores) || []).map((s) => METRO[s]).filter(Boolean))];
  $('gFind').innerHTML = (metros.length ? metros : ['KC', 'STL']).flatMap((m) => FIND[m])
    .map((q) => `<button data-q="${esc(q)}">${esc(q)}</button>`).join('');
  $('gFind').querySelectorAll('[data-q]').forEach((b) => b.onclick = () =>
    chrome.tabs.create({ url: 'https://www.facebook.com/groups/search/groups/?q=' + encodeURIComponent(b.dataset.q) }));
}

show();
