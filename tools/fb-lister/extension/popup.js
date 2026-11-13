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
  const saved = (await chrome.storage.local.get('store')).store;
  $('store').value = saved || who.store || 'OVL';
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
  if (b.dataset.tab === 'listed') renderListed();
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

let lastStatus = {};

async function countListed() {
  const { listed = [] } = await chrome.storage.local.get('listed');
  $('listedCount').textContent = listed.length ? `(${listed.length})` : '';
}

async function renderListed() {
  const { listed = [] } = await chrome.storage.local.get('listed');
  countListed();
  if (!listed.length) { $('listed').innerHTML = ''; return say('listedMsg', 'Nothing filled from this computer yet.'); }
  const sold = listed.filter((l) => lastStatus[l.sku]?.status === 'sold').length;
  say('listedMsg', Object.keys(lastStatus).length
    ? (sold ? `${sold} sold — mark ${sold === 1 ? 'it' : 'them'} sold on Facebook, then remove from this list.` : 'Nothing here has sold.')
    : `${listed.length} filled from this computer. Check them against Shopify to catch anything that sold in store, online or on eBay.`);
  // Sold first, so the ones to act on are at the top.
  const rank = (l) => ({ sold: 0, unknown: 1, instock: 2 }[lastStatus[l.sku]?.status] ?? 3);
  const rows = [...listed].sort((a, b) => rank(a) - rank(b));
  $('listed').innerHTML = rows.map((l, n) => {
    const s = lastStatus[l.sku];
    return `<div class="item" data-n="${n}" title="${esc(s?.reason || '')}">
      <div class="t"><b>${esc(l.title)}</b><span>${esc(l.sku)} · ${new Date(l.at).toLocaleDateString()}${l.by ? ' · ' + esc(l.by) : ''}</span></div>
      ${s ? `<span class="pill ${s.status}">${s.status === 'instock' ? 'in stock' : s.status}</span>` : `<span class="p">${money(l.price)}</span>`}
      <button class="link" data-forget="${n}" title="Remove from this list">remove</button>
    </div>`;
  }).join('');
  $('listed').querySelectorAll('[data-forget]').forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    const l = rows[Number(b.dataset.forget)];
    await send({ type: 'forget', sku: l.sku, product_id: l.product_id });
    renderListed();
  });
}

$('check').onclick = async () => {
  const { listed = [] } = await chrome.storage.local.get('listed');
  if (!listed.length) return;
  $('check').disabled = true;
  say('listedMsg', 'Checking Shopify…');
  const skus = [...new Set(listed.map((l) => l.sku))];
  const out = {};
  for (let i = 0; i < skus.length; i += 200) {
    const r = await send({ type: 'status', skus: skus.slice(i, i + 200) });
    if (!r.ok) { $('check').disabled = false; return say('listedMsg', r.error, true); }
    Object.assign(out, r.results);
  }
  lastStatus = out;
  $('check').disabled = false;
  renderListed();
};

show();
