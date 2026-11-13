// SPEEKS Marketplace Lister — background service worker.
//
// Everything that talks to the network lives here: SPEEKSNET's fb-lister
// function, and Shopify's CDN for the photos. The popup closes the moment a new
// tab opens, so it cannot be the one that does the work; and a content script
// on facebook.com fetches with facebook.com's CORS rules, which Shopify's CDN
// does not answer. The worker has host permissions for both, so it fetches and
// hands the bytes over.
//
// Nothing here ever clicks Next or Publish on Facebook, and neither does
// content.js. A person reviews the listing and posts it.

const API = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/fb-lister';
const FB_CREATE = 'https://www.facebook.com/marketplace/create/item';

// ── SIGN-IN LASTS ONE BROWSER SESSION (Ethan, 2026-11-13) ──────────────────
// Store computers are shared: closing Chrome must sign the person out, or the
// next person to open it lists under their name. So the token and who-am-I
// live in chrome.storage.session, which Chrome keeps in memory and drops when
// the browser quits. Up to 1.5.0 they were in storage.local and survived a
// restart; the cleanup below wipes those old copies. Everything that SHOULD
// survive stays in storage.local: what was listed from this computer, the
// last sold check, the store picked, the groups switch.
//
// Closing the LAST window also signs out, for when Chrome keeps running in
// the background after its windows are gone.
//
// The cost: the daily sold check needs a sign-in, so after a restart it waits
// until someone signs in. The toolbar shows "!" meanwhile when there are
// listings to check.
const SIGNIN = chrome.storage.session;
async function signedOutStart() {
  await chrome.storage.local.remove(['token', 'who']);
  const { token } = await SIGNIN.get('token');
  if (token) return;
  const { listed = [] } = await chrome.storage.local.get('listed');
  if (listed.length) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ed6c02' });
    chrome.action.setTitle({ title: 'SPEEKS Marketplace Lister — sign in to keep checking your listings for sales' });
  }
}
chrome.runtime.onStartup.addListener(signedOutStart);
chrome.runtime.onInstalled.addListener(signedOutStart);
chrome.windows.onRemoved.addListener(async () => {
  const left = await chrome.windows.getAll();
  if (!left.length) await SIGNIN.remove(['token', 'who']);
});

async function api(payload) {
  const { token } = await SIGNIN.get('token');
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, token }),
  });
  const out = await res.json().catch(() => ({}));
  if (res.status === 401) await SIGNIN.remove(['token', 'who']);
  if (!res.ok || out.success === false) {
    const err = new Error(out.error || `SPEEKSNET didn't answer (HTTP ${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return out;
}

async function photoAsData(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`photo HTTP ${r.status}`);
  const blob = await r.blob();
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  const name = (new URL(url).pathname.split('/').pop() || 'photo.jpg').replace(/[^\w.-]/g, '_');
  return { name, type: blob.type || 'image/jpeg', b64: btoa(bin) };
}

// ── THE LISTED LIST IS THE STORE'S (Ethan, 2026-11-13) ─────────────────────
// It lives in SPEEKSNET (fb_listings, through fb-lister), so everyone at a
// store sees the same list on any computer. storage.local 'listed' is now only
// a cache of it, refreshed on every read, so the badge and the popup can draw
// without waiting. Rows filled before 1.5.2 were only on this computer and
// have no id: the first sync sends them up, then drops the local copies.
async function syncListed() {
  const { listed = [] } = await chrome.storage.local.get('listed');
  for (const l of listed.filter((x) => !x.id)) {
    await api({ action: 'listed', sku: l.sku, product_id: l.product_id, title: l.title, price: l.price }).catch(() => {});
  }
  const out = await api({ action: 'listedList' });
  const rows = (out.listed || []).map((r) => ({ ...r, at: Date.parse(r.at) || Date.now() }));
  await chrome.storage.local.set({ listed: rows });
  return rows;
}

async function rememberListed(job) {
  await api({
    action: 'listed', sku: job.item.sku, product_id: job.item.product_id, title: job.item.title,
    price: job.fb.price, kind: job.item.kind || null,
  });
  await syncListed().catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg.type) {
      case 'login': {
        const out = await api({ action: 'login', pin: msg.pin });
        const who = { name: out.name, store: out.store, role: out.role, stores: out.stores || [] };
        await SIGNIN.set({ token: out.token, who });
        // Signed back in after a restart: clear the "!" and catch up on a
        // sold check that came due while nobody was signed in.
        chrome.action.setTitle({ title: 'SPEEKS Marketplace Lister' });
        chrome.action.setBadgeText({ text: '' });
        await refreshBadge();
        const { soldStatus } = await chrome.storage.local.get('soldStatus');
        if (!soldStatus?.at || Date.now() - soldStatus.at >= DAY) checkSold({ notify: true }).catch(() => {});
        return { who };
      }
      case 'logout':
        await SIGNIN.remove(['token', 'who']);
        await signedOutStart();
        return {};
      case 'me': {
        const { token, who } = await SIGNIN.get(['token', 'who']);
        if (!token) return { who: null };
        try { const out = await api({ action: 'me' }); return { who: { name: out.name, store: out.store, role: out.role, stores: out.stores || [] } }; }
        catch (e) { if (e.status === 401 || e.status === 403) return { who: null, error: e.message }; return { who, offline: e.message }; }
      }
      case 'catalog':
        return api({ action: 'catalog', store: msg.store, q: msg.q || '' });
      case 'item':
        return api({ action: 'item', sku: msg.sku, product_id: msg.product_id || null });
      case 'status':
        return api({ action: 'status', skus: msg.skus });
      case 'thumbs':
        return api({ action: 'thumbs', store: msg.store, product_ids: msg.product_ids || [] });
      case 'start': {
        // Re-read the item at the moment of listing, not whatever the popup had
        // cached: the price or stock may have moved since the list loaded.
        const out = await api({ action: 'item', sku: msg.sku, product_id: msg.product_id || null });
        if (out.choose) return out;
        if (Number(out.item.quantity) <= 0) throw new Error(`${out.item.sku} sold since you opened it — Shopify shows 0 in stock.`);
        const tab = await chrome.tabs.create({ url: FB_CREATE, active: true });
        await chrome.storage.session.set({ ['job:' + tab.id]: { item: out.item, fb: out.fb, warnings: out.warnings } });
        // NOT added to the Listed list here: opening the form isn't listing it
        // (Ethan, 11-13 — a fill he never published showed up as listed).
        // content.js says 'published' once the person's Publish went through.
        return { ok: true };
      }
      case 'job': {
        // Asked by content.js. Only the tab this extension opened gets a job —
        // browsing Marketplace normally never triggers a fill.
        const key = 'job:' + sender.tab?.id;
        const got = await chrome.storage.session.get(key);
        return { job: got[key] || null };
      }
      case 'photos': {
        const files = [];
        const failed = [];
        for (const url of msg.urls || []) {
          try { files.push(await photoAsData(url)); } catch (e) { failed.push(url); }
        }
        return { files, failed };
      }
      case 'done': {
        await chrome.storage.session.remove('job:' + sender.tab?.id);
        return {};
      }
      case 'forget': {
        if (msg.id) await api({ action: 'done', id: msg.id });
        await syncListed();
        await refreshBadge();
        return {};
      }
      case 'listed':
        return { listed: await syncListed() };
      case 'boost':
        await api({ action: 'boost', id: msg.id, days: msg.days, budget: msg.budget });
        return { listed: await syncListed() };
      case 'published':
        // From content.js, after the person clicked Facebook's Publish and
        // Facebook moved off the create form.
        await rememberListed({ item: msg.item, fb: msg.fb });
        await refreshBadge();
        return {};
      case 'category':
        // Read off Facebook's form at Confirm & Next; teaches the next listing.
        return api({ action: 'category', sku: msg.sku, product_id: msg.product_id || null, category: msg.category });
      case 'checkSold':
        return checkSold({ notify: false });
      case 'openSold':
        await openSold(msg.items || []);
        return {};
      default:
        throw new Error('Unknown request.');
    }
  })().then((r) => reply({ ok: true, ...r }), (e) => reply({ ok: false, error: e.message, status: e.status }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove('job:' + tabId); });

// ── SOLD WATCH ───────────────────────────────────────────────────────────────
// Facebook isn't connected to Shopify, so a listing stays up after the item
// sells in store, online or on eBay. Once a day, the store's Listed list is
// checked against Shopify (through
// fb-lister's status action). Anything sold puts a count on the toolbar icon
// and raises one notification per item; clicking it opens Marketplace →
// Selling with those listings outlined and their "Mark as sold" buttons
// pointed at. The person clicks Mark as sold — see content.js for why the
// extension never does.
//
// ONCE A DAY IS ENOUGH (Ethan, 2026-11-13): Marketplace buyers come into the
// store to buy, so a Facebook listing can't be sold out from under us online
// in the hours between checks. The alarm wakes hourly only so a computer that
// was off or asleep at check time still checks soon after it wakes; it does
// nothing unless the last check is 24 hours old. "Check what's sold" in the
// popup checks right away.

const SELLING = 'https://www.facebook.com/marketplace/you/selling';

async function checkSold({ notify }) {
  const { token } = await SIGNIN.get('token');
  if (!token) { await refreshBadge(); return { results: {} }; }
  const listed = await syncListed();
  if (!listed.length) { await refreshBadge(); return { results: {} }; }
  const skus = [...new Set(listed.map((l) => l.sku))];
  const results = {};
  try {
    for (let i = 0; i < skus.length; i += 200) {
      const r = await api({ action: 'status', skus: skus.slice(i, i + 200) });
      Object.assign(results, r.results);
    }
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#ed6c02' });
      chrome.action.setTitle({ title: 'SPEEKS Marketplace Lister — sign in again to keep checking for sales' });
    }
    throw e;
  }
  await chrome.storage.local.set({ soldStatus: { at: Date.now(), results } });
  await refreshBadge();

  if (notify) {
    const { notified = [] } = await chrome.storage.local.get('notified');
    const fresh = listed.filter((l) => results[l.sku]?.status === 'sold' && !notified.includes(l.sku));
    if (fresh.length) {
      chrome.notifications.create('sold', {
        type: 'basic', iconUrl: 'icon128.png', priority: 2, requireInteraction: true,
        title: fresh.length === 1 ? 'Sold in Shopify — still on Facebook' : `${fresh.length} items sold in Shopify — still on Facebook`,
        message: fresh.slice(0, 3).map((l) => l.title).join('\n') + (fresh.length > 3 ? `\n…and ${fresh.length - 3} more` : '') + '\nClick to mark them sold on Facebook.',
      });
      await chrome.storage.local.set({ notified: [...new Set([...notified, ...fresh.map((l) => l.sku)])].slice(-1000) });
    }
  }
  return { results };
}

async function soldListed() {
  const { listed = [], soldStatus } = await chrome.storage.local.get(['listed', 'soldStatus']);
  const res = soldStatus?.results || {};
  return listed.filter((l) => res[l.sku]?.status === 'sold');
}

async function refreshBadge() {
  const { token } = await SIGNIN.get('token');
  if (!token) return;
  const n = (await soldListed()).length;
  chrome.action.setBadgeText({ text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
  chrome.action.setTitle({ title: n ? `SPEEKS Marketplace Lister — ${n} sold, mark ${n === 1 ? 'it' : 'them'} sold on Facebook` : 'SPEEKS Marketplace Lister' });
}

async function openSold(items) {
  if (!items.length) items = await soldListed();
  if (!items.length) return;
  const tab = await chrome.tabs.create({ url: SELLING, active: true });
  await chrome.storage.session.set({ ['job:' + tab.id]: { sold: items.map((l) => ({ sku: l.sku, title: l.title })) } });
}

chrome.notifications.onClicked.addListener(async (id) => {
  if (id !== 'sold') return;
  chrome.notifications.clear(id);
  await openSold([]);
});

const DAY = 24 * 60 * 60 * 1000;
function ensureAlarm() { chrome.alarms.create('soldCheck', { periodInMinutes: 60, delayInMinutes: 1 }); }
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'soldCheck') return;
  const { soldStatus } = await chrome.storage.local.get('soldStatus');
  if (soldStatus?.at && Date.now() - soldStatus.at < DAY) return;
  checkSold({ notify: true }).catch(() => {});
});
