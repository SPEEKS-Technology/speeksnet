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
  $('store').hidden = stores.length < 2;
  $('who').textContent = who.name + (stores.length === 1 ? ' · ' + stores[0] : '');
  const saved = (await chrome.storage.local.get('store')).store;
  $('store').value = stores.includes(saved) ? saved : (stores.includes(who.store) ? who.store : stores[0]);
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
  catalog = { store, items: r.items || [] };
  renderResults();
}

function renderResults() {
  $('detail').hidden = true; $('results').hidden = false;
  const q = $('q').value.trim().toLowerCase();
  const hits = catalog.items.filter((i) => !q || `${i.title} ${i.sku}`.toLowerCase().includes(q));
  const shown = hits.slice(0, 150);
  say('listMsg', `${hits.length.toLocaleString()} in stock${q ? ' matching' : ''} at ${catalog.store}${hits.length > shown.length ? ` — showing ${shown.length}, search to narrow` : ''}.`);
  $('results').innerHTML = shown.map((i, n) => `
    <div class="item" data-n="${n}">
      <div class="t"><b title="${esc(i.title)}">${esc(i.title)}</b><span>${esc(i.sku)} · ${esc(i.condition || 'no condition')} · ${i.photos || 0} photo${i.photos === 1 ? '' : 's'}</span></div>
      <div class="p">${money(i.price)}</div>
    </div>`).join('')
    + (!hits.length && SKU_RE.test($('q').value.trim())
      ? `<div class="note">Not in the in-stock list. <button id="bySku">Look up ${esc($('q').value.trim())} in Shopify</button></div>` : '');
  $('results').querySelectorAll('.item').forEach((el) => el.onclick = () => {
    const i = shown[Number(el.dataset.n)];
    openItem(i.sku, i.product_id);
  });
  const by = $('bySku'); if (by) by.onclick = () => openItem($('q').value.trim(), null);
}

async function openItem(sku, productId) {
  $('results').hidden = true;
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
  d.innerHTML = `
    <div class="photos">${fb.photos.map((u) => `<img src="${esc(u + (u.includes('?') ? '&' : '?') + 'width=128')}" loading="lazy" alt="">`).join('') || '<span class="msg">No photos</span>'}</div>
    ${(warnings || []).map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
    <div class="kv">
      <span>Title</span><span>${esc(fb.title)}</span>
      <span>Price</span><span>${money(fb.price)}${Math.round(item.price) !== item.price ? ` <span class="msg">(Shopify ${money(item.price)} — Facebook takes whole dollars)</span>` : ''}</span>
      <span>Condition</span><span>${esc(fb.condition || '—')}${item.condition ? ` <span class="msg">(ours: ${esc(item.condition)})</span>` : ''}</span>
      <span>SKU</span><span>${esc(item.sku)} · ${esc(item.store)} · ${item.quantity} in stock</span>
    </div>
    <div class="desc">${esc(fb.description) || '<i>No description on Shopify.</i>'}</div>
    <div class="note">Opens Facebook Marketplace and fills this in. You pick the category, check it, and click Publish yourself.</div>
    <div class="acts"><button id="back">Back</button><button id="go" class="primary">Fill on Facebook</button></div>`;
  $('back').onclick = renderResults;
  $('go').onclick = async () => {
    $('go').disabled = true; $('go').textContent = 'Opening Facebook…';
    const s = await send({ type: 'start', sku: item.sku, product_id: item.product_id });
    if (!s.ok) { $('go').disabled = false; $('go').textContent = 'Fill on Facebook'; d.insertAdjacentHTML('afterbegin', `<div class="warn">${esc(s.error)}</div>`); }
  };
}

// ── Listed ───────────────────────────────────────────────────────────────────
// The background worker re-checks these against Shopify every 30 minutes and
// keeps the last answer in soldStatus, so this tab opens already knowing.

async function countListed() {
  const { listed = [] } = await chrome.storage.local.get('listed');
  $('listedCount').textContent = listed.length ? `(${listed.length})` : '';
}

async function renderListed() {
  const { listed = [], soldStatus } = await chrome.storage.local.get(['listed', 'soldStatus']);
  const st = soldStatus?.results || {};
  countListed();
  $('markAll').hidden = true;
  if (!listed.length) { $('listed').innerHTML = ''; return say('listedMsg', 'Nothing filled from this computer yet.'); }
  const sold = listed.filter((l) => st[l.sku]?.status === 'sold');
  const when = soldStatus?.at ? ` Checked ${new Date(soldStatus.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : '';
  say('listedMsg', soldStatus
    ? (sold.length ? `${sold.length} sold in Shopify — mark ${sold.length === 1 ? 'it' : 'them'} sold on Facebook, then press Done.${when}` : `Nothing here has sold.${when} Checked again every 30 minutes while Chrome is open.`)
    : `${listed.length} filled from this computer. Checked against Shopify every 30 minutes while Chrome is open.`);
  $('markAll').hidden = sold.length < 1;
  $('markAll').textContent = sold.length > 1 ? `Mark ${sold.length} sold on Facebook` : 'Mark sold on Facebook';
  // Sold first, so the ones to act on are at the top.
  const rank = (l) => ({ sold: 0, unknown: 1, instock: 2 }[st[l.sku]?.status] ?? 3);
  const rows = [...listed].sort((a, b) => rank(a) - rank(b));
  $('listed').innerHTML = rows.map((l, n) => {
    const s = st[l.sku];
    return `<div class="item" title="${esc(s?.reason || '')}">
      <div class="t"><b>${esc(l.title)}</b><span>${esc(l.sku)} · ${new Date(l.at).toLocaleDateString()}${l.by ? ' · ' + esc(l.by) : ''}</span></div>
      ${s ? `<span class="pill ${s.status}">${s.status === 'instock' ? 'in stock' : s.status}</span>` : `<span class="p">${money(l.price)}</span>`}
      ${s?.status === 'sold' ? `<button class="small" data-find="${n}" title="Open Facebook Selling with this listing outlined">Find</button>` : ''}
      <button class="small" data-forget="${n}" title="${s?.status === 'sold' ? 'Marked sold on Facebook — take it off this list' : 'Take it off this list'}">Done</button>
    </div>`;
  }).join('');
  $('listed').querySelectorAll('[data-forget]').forEach((b) => b.onclick = async () => {
    const l = rows[Number(b.dataset.forget)];
    await send({ type: 'forget', sku: l.sku, product_id: l.product_id });
    renderListed();
  });
  $('listed').querySelectorAll('[data-find]').forEach((b) => b.onclick = () => send({ type: 'openSold', items: [rows[Number(b.dataset.find)]] }));
}

$('markAll').onclick = () => send({ type: 'openSold', items: [] });

$('check').onclick = async () => {
  $('check').disabled = true;
  say('listedMsg', 'Checking Shopify…');
  const r = await send({ type: 'checkSold' });
  $('check').disabled = false;
  if (!r.ok) return say('listedMsg', r.error, true);
  renderListed();
};

// ── Groups ───────────────────────────────────────────────────────────────────
// Rules are kept on this computer (chrome.storage.local), because the groups
// are the person's own: each Facebook account is in different ones. content.js
// reads them on the "list in more places" step.

const FIND = {
  KC: ['Kansas City buy sell trade', 'Kansas City electronics', 'Kansas City video games', 'Kansas City phones', 'Johnson County buy sell', 'Overland Park buy sell', "Lee's Summit buy sell", 'Westport Midtown KC buy sell'],
  STL: ['St Louis buy sell trade', 'St Louis electronics', 'St Louis video games', 'St Louis phones', 'West County STL buy sell', 'Ballwin buy sell', 'Maplewood buy sell', 'Chesterfield buy sell'],
};
const METRO = { OVL: 'KC', LEE: 'KC', WSP: 'KC', MPL: 'STL', BAL: 'STL' };
const MODE = { all: 'every item', match: 'items with', never: 'never' };

$('gMode').onchange = () => { $('gKw').hidden = $('gMode').value !== 'match'; };
$('gAuto').onchange = () => chrome.storage.local.set({ groupAuto: $('gAuto').checked });
$('gAdd').onclick = async () => {
  const name = $('gName').value.trim();
  const mode = $('gMode').value;
  const keywords = $('gKw').value.trim();
  if (!name) return $('gName').focus();
  if (mode === 'match' && !keywords) return $('gKw').focus();
  const { groupRules = [] } = await chrome.storage.local.get('groupRules');
  groupRules.push({ name, mode, keywords: mode === 'match' ? keywords : '' });
  await chrome.storage.local.set({ groupRules });
  $('gName').value = ''; $('gKw').value = '';
  renderGroups();
};

async function renderGroups() {
  const { groupRules = [], groupAuto = true } = await chrome.storage.local.get(['groupRules', 'groupAuto']);
  $('gAuto').checked = groupAuto;
  $('gRules').innerHTML = groupRules.map((r, n) => `<div class="rule">
      <span class="n" title="${esc(r.name)}">“${esc(r.name)}”</span>
      <span class="m">${esc(MODE[r.mode] || r.mode)}${r.mode === 'match' ? ': ' + esc(r.keywords) : ''}</span>
      <button class="link" data-del="${n}">remove</button>
    </div>`).join('') || '<p class="hint">None yet. Example: “KC Gamers” → items with: nintendo, playstation, xbox.</p>';
  $('gRules').querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    groupRules.splice(Number(b.dataset.del), 1);
    await chrome.storage.local.set({ groupRules });
    renderGroups();
  });
  const metros = [...new Set(((who && who.stores) || []).map((s) => METRO[s]).filter(Boolean))];
  $('gFind').innerHTML = (metros.length ? metros : ['KC', 'STL']).flatMap((m) => FIND[m])
    .map((q) => `<button data-q="${esc(q)}">${esc(q)}</button>`).join('');
  $('gFind').querySelectorAll('[data-q]').forEach((b) => b.onclick = () =>
    chrome.tabs.create({ url: 'https://www.facebook.com/groups/search/groups/?q=' + encodeURIComponent(b.dataset.q) }));
}

show();
