// SPEEKS Marketplace Lister — runs on facebook.com.
//
// It does nothing unless background.js opened THIS tab for a job (it asks;
// ordinary Facebook browsing has none). Two kinds of job:
//
//   list — on Marketplace's "create item" form: types in the title, price,
//          condition and description, attaches the photos, and shows a panel
//          saying what it filled and what is left. When the person clicks Next
//          and Facebook shows the "list in more places" step, it ticks the
//          groups that fit the item (rules from the popup's Groups tab plus
//          automatic local-group picks) and says which and why.
//   sold — on Marketplace → Selling: finds the listings whose item has sold in
//          Shopify, outlines each one and points at its "Mark as sold" button.
//
// IT NEVER CLICKS PUBLISH, POST OR MARK AS SOLD. Facebook does not allow
// automated posting or account actions, and a listing is a public statement in
// the store's name under someone's personal account — a person makes every
// final click.
//
// NEXT IS THE ONE EXCEPTION, and only on the person's own click (Ethan,
// 2026-11-13, after the first real test): Location and Public meetup live on
// Facebook's SECOND page, so the panel has a "Confirm & Next" button. Pressing
// it is the person confirming page one; the extension then clicks Facebook's
// Next for them, once, and fills page two. It never clicks Next by itself,
// and Publish stays theirs. Category is left to the person too: Facebook's category picker
// is a search box with suggestions that change, and a wrong guess is worse
// than an empty field Facebook refuses to publish without. Ticking a group box
// is a form choice like any other field, made before the person posts.
//
// FACEBOOK'S MARKUP IS NOT OURS AND IT CHANGES. Class names are generated, so
// nothing here uses them. Fields are found by their visible label or
// aria-label, and every step reports success or failure on the panel, so a
// Facebook change shows up as "couldn't find Price — type it in" rather than
// as a silently half-filled listing.

(() => {
  if (window.__speeksLister) return;
  window.__speeksLister = true;

  const onCreatePage = () => /^\/marketplace\/create\/item/.test(location.pathname);
  const onSellingPage = () => /^\/marketplace\/you(\/selling)?\/?$/.test(location.pathname);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false, error: chrome.runtime.lastError?.message })));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ── finding fields ─────────────────────────────────────────────────────────

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // The control that belongs to a label: by aria-label first, then a <label>
  // whose aria-label or own text is the word, then aria-labelledby.
  function field(word, kinds = 'input, textarea') {
    const w = norm(word);
    for (const el of document.querySelectorAll(kinds)) {
      if (norm(el.getAttribute('aria-label')) === w && visible(el)) return el;
    }
    for (const lab of document.querySelectorAll('label')) {
      const own = norm(lab.getAttribute('aria-label'));
      const spans = Array.from(lab.querySelectorAll('span')).map((s) => norm(s.textContent));
      if (own === w || spans.includes(w)) {
        const el = lab.querySelector(kinds) || (lab.htmlFor && document.getElementById(lab.htmlFor));
        if (el && visible(el)) return el;
      }
    }
    for (const el of document.querySelectorAll(kinds)) {
      const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
      if (ids.some((id) => norm(document.getElementById(id)?.textContent) === w) && visible(el)) return el;
    }
    return null;
  }

  // A dropdown (Condition) is a clickable label/combobox, not an input.
  function combo(word) {
    const w = norm(word);
    for (const el of document.querySelectorAll('[role="combobox"], label, [aria-haspopup="listbox"]')) {
      if (!visible(el)) continue;
      const own = norm(el.getAttribute('aria-label'));
      const spans = Array.from(el.querySelectorAll('span')).map((s) => norm(s.textContent));
      if (own === w || spans[0] === w || spans.includes(w)) {
        if (el.querySelector('input, textarea')) continue; // that's a text field
        return el;
      }
    }
    return null;
  }

  // ── setting values so React notices ────────────────────────────────────────
  // Facebook's form is React. Setting .value directly is overwritten on the
  // next render; insertText goes through the browser's own editing path, which
  // React hears. The native-setter route is the fallback.
  function setValue(el, value) {
    el.focus();
    try { el.select(); } catch (_) {}
    let ok = false;
    try { ok = document.execCommand('insertText', false, value); } catch (_) {}
    if (!ok || el.value !== value) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    return el.value === value;
  }

  async function pickOption(word, choice) {
    const box = combo(word);
    if (!box) return false;
    box.click();
    const want = norm(choice);
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      const opts = Array.from(document.querySelectorAll('[role="option"], [role="menuitemradio"], [role="menuitem"]')).filter(visible);
      const hit = opts.find((o) => norm(o.textContent) === want) || opts.find((o) => norm(o.textContent).startsWith(want));
      if (hit) { hit.click(); await sleep(200); return true; }
    }
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  }

  // ── CATEGORY, LEARNED (Ethan, 2026-11-13) ──────────────────────────────────
  // Facebook's category box is a search-as-you-type picker whose wording we
  // don't control, so nothing here guesses. The name typed is one a person at
  // SPEEKS already picked for this kind of item (read back at Confirm & Next),
  // and it only counts if Facebook offers that exact name.
  async function pickCategory(name) {
    const box = combo('Category') || field('Category');
    if (!box) return false;
    box.click();
    await sleep(300);
    const typeIn = (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) ? document.activeElement
      : (box.tagName === 'INPUT' ? box : null);
    if (typeIn) { typeIn.focus(); try { document.execCommand('insertText', false, name); } catch (_) {} }
    const want = norm(name);
    for (let i = 0; i < 20; i++) {
      await sleep(200);
      const opts = Array.from(document.querySelectorAll('[role="option"], [role="menuitemradio"], [role="menuitem"], [role="radio"]')).filter(visible);
      const hit = opts.find((o) => norm(o.textContent) === want || norm(o.getAttribute('aria-label')) === want);
      if (hit) { hit.click(); await sleep(300); return norm(categoryValue()) === want || !categoryValue(); }
    }
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  }

  // What the Category box shows now: its text minus the word "Category".
  function categoryValue() {
    const box = combo('Category') || field('Category');
    if (!box) return '';
    if (box.tagName === 'INPUT') return box.value.trim();
    return (box.innerText || '').split('\n').map((s) => s.trim()).filter((s) => s && norm(s) !== 'category')[0] || '';
  }

  // The category the person ended up with (picked by them, or by us and kept)
  // is saved, so the next listing of this kind picks it for them. Read on
  // page one only: page two has no Category box. (Optional "More details"
  // fields like Storage and Color are deliberately left alone, Ethan 11-13:
  // the whole listing is in the description.)
  // lastCategory: the page watcher's latest reading of the box, for when the
  // person clicks Facebook's own Next and page one is gone before we look.
  let categorySaved = false, lastCategory = '';
  function saveCategory() {
    if (categorySaved) return;
    const cat = (onPage2() ? '' : categoryValue()) || lastCategory;
    if (!cat) return;
    categorySaved = true;
    const s = view.steps.find((x) => x.key === 'category');
    if (s) { s.state = 'ok'; s.text = cat; }
    send({ type: 'category', sku: job.item.sku, product_id: job.item.product_id, category: cat });
  }

  // ── PUBLIC MEETUP, AT THE STORE (Ethan, 2026-11-13) ────────────────────────
  // Marketplace buyers come into the store to buy. Every listing is set to
  // Public meetup (Door pickup / Door drop-off switched off — nobody goes to a
  // home), and its location is set to the store's own city, so the listing
  // shows up for people near the store rather than near wherever the person
  // listing it lives.
  const STORE_AREA = {
    OVL: 'Overland Park, Kansas', LEE: "Lee's Summit, Missouri", WSP: 'Kansas City, Missouri',
    MPL: 'Maplewood, Missouri', BAL: 'Ballwin, Missouri',
  };

  async function setLocation(place) {
    const el = field('Location');
    if (!el) return null;
    const city = place.split(',')[0];
    setValue(el, city);
    el.focus();
    // A typeahead: the value only counts once a suggestion is picked.
    for (let i = 0; i < 25; i++) {
      await sleep(200);
      const opts = Array.from(document.querySelectorAll('[role="option"], [role="listbox"] li')).filter(visible);
      const hit = opts.find((o) => sameCity(o.textContent, place))
        || opts.find((o) => letters(o.textContent).startsWith(letters(city)));
      if (hit) { const t = hit.textContent.trim(); hit.click(); await sleep(300); return t; }
    }
    return null;
  }

  // A meetup-preference checkbox by its label: set it on or off. Returns the
  // state it ended in, or null if there's no such box on this layout.
  async function setBox(word, on) {
    // Letters only: Facebook says "Door dropoff", older layouts "Door drop-off".
    const w = norm(word).replace(/[^a-z0-9]/g, '');
    for (const cb of document.querySelectorAll('[role="checkbox"], [role="switch"], input[type="checkbox"]')) {
      // Only the row's FIRST line counts: walking up far enough reaches the
      // block holding all three options, and "Door pickup" in there must not
      // be read as the Public meetup box's name.
      let name = norm(cb.getAttribute('aria-label'));
      if (!name) {
        let el = cb;
        for (let i = 0; i < 5 && el && !name; i++) { el = el.parentElement; name = norm((el?.innerText || '').split('\n')[0]); }
      }
      if (!name.replace(/[^a-z0-9]/g, '').startsWith(w)) continue;
      const state = () => cb.tagName === 'INPUT' ? cb.checked : cb.getAttribute('aria-checked') === 'true';
      if (state() !== on) { cb.click(); await sleep(200); }
      return state();
    }
    return null;
  }

  async function attachPhotos(files) {
    const input = Array.from(document.querySelectorAll('input[type="file"]'))
      .find((i) => /image/.test(i.accept || '') || i.multiple);
    if (!input) return 0;
    const dt = new DataTransfer();
    for (const f of files) {
      const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return dt.files.length;
  }

  async function waitFor(fn, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(300); }
    return null;
  }

  // ── the panel ──────────────────────────────────────────────────────────────

  let host = null, root = null, job = null, busy = false;
  // page: 1 = the first form page (shows Confirm & Next), 2 = after Next.
  // (A Boost checkbox lived here in 1.5.0–1.5.4; removed at Ethan's word,
  // 11-13. Facebook's own boost switch is left however the person sets it.)
  const view = { head: '', sub: '', steps: [], note: '', extra: '', buttons: true, page: 1 };

  function panel() {
    if (host) return root;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    root = host.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(host);
    return root;
  }
  function closePanel() { if (host) host.remove(); host = root = null; }

  function render() {
    const r = panel();
    const mark = { ok: '✓', todo: '!', bad: '×', run: '', wait: '2' };
    // Three columns — mark, field, what happened — so every row lines up
    // (Ethan, 11-13). Texts are written "— like this" for the old one-line
    // layout; the dash goes now that the column does the separating.
    const rows = view.steps.map((s) => `<li class="${s.state}"><span class="ic">${mark[s.state] || ''}</span><b>${esc(s.label)}</b><span class="tx">${esc(String(s.text || '').replace(/^—\s*/, ''))}</span></li>`).join('');
    const warn = (job?.warnings || []).map((w) => `<div class="warn">${esc(w)}</div>`).join('');
    let logo = '';
    try { logo = chrome.runtime.getURL('logo-white.png'); } catch (_) {}
    // SPEEKSNET's look (see popup.css for where each colour comes from): the
    // dark top nav, emerald actions, B2B lines, and the --qs-* status palette.
    r.innerHTML = `
      <style>
        :host{all:initial}
        .box{width:340px;font:13px/1.45 Inter,'Segoe UI',-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#334155;background:#fff;
             border:1px solid #e6ebf1;border-radius:14px;box-shadow:0 12px 32px rgba(15,23,42,.18),0 2px 6px rgba(15,23,42,.06);overflow:hidden}
        .hd{display:flex;align-items:center;gap:9px;padding:10px 12px;background:#181b20;color:#fff}
        .hd img{width:20px;height:21px;flex:none}
        .hd .br{flex:1;display:flex;flex-direction:column;line-height:1.1}
        .hd .ey{font-size:9px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#94a3b8}
        .hd .ti{font-size:13.5px;font-weight:800;letter-spacing:-.01em}
        .hd button{width:28px;height:28px;border-radius:8px;border:0;background:rgba(255,255,255,.08);color:#cbd5e1;font-size:16px;cursor:pointer;line-height:1}
        .hd button:hover{background:#fcecec;color:#c43d3d}
        .bd{padding:12px;max-height:62vh;overflow:auto}
        .it{color:#0f172a;font-weight:750;font-size:13.5px;line-height:1.3;margin-bottom:3px}
        .sku{color:#8a94a3;font-size:11.5px;font-weight:600;margin-bottom:10px}
        ul{list-style:none;margin:0 0 4px;padding:0;border:1px solid #eef2f6;border-radius:10px;overflow:hidden}
        li{display:grid;grid-template-columns:18px 104px minmax(0,1fr);gap:9px;align-items:start;padding:7px 10px;border-bottom:1px solid #eef2f6}
        li .tx{overflow-wrap:anywhere}
        li:last-child{border-bottom:0}
        li b{color:#0f172a;font-weight:650}.tx{color:#647082}
        .ic{width:18px;height:18px;border-radius:50%;flex:none;display:grid;place-items:center;font-size:11px;font-weight:800;margin-top:1px;
            background:#f1f5f9;color:#94a3b8;box-shadow:inset 0 0 0 1px #e6ebf1}
        li.ok .ic{background:#f2faf5;color:#146c3c;box-shadow:inset 0 0 0 1px #dcefe3}
        li.todo .ic{background:#fdf7ec;color:#a5660f;box-shadow:inset 0 0 0 1px #f5e3c2}
        li.bad .ic{background:#fdf2f2;color:#c43d3d;box-shadow:inset 0 0 0 1px #f6d4d4}
        li.run .ic{background:#e8f7ee;box-shadow:inset 0 0 0 2px #1f9d57;animation:p 1s ease-in-out infinite}
        @keyframes p{50%{opacity:.4}}
        .warn{background:#fdf7ec;border:1px solid #f5e3c2;color:#a5660f;font-weight:600;border-radius:9px;padding:7px 10px;margin:0 0 8px;font-size:12px}
        .next{background:#e8f7ee;border:1px solid #cfeada;color:#14532d;border-radius:10px;padding:9px 11px;font-size:12px;margin-top:10px;line-height:1.5}
        .next b{color:#0f3d22}
        .grp{margin-top:12px;font-size:12px}
        .grp b{display:block;margin:0 0 6px;padding-bottom:6px;border-bottom:1px solid #eef2f6;font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#8a94a3}
        .grp div{padding:2px 0;color:#0f172a}.grp .why{color:#8a94a3}
        .ft{display:flex;gap:6px;padding:0 12px 12px}
        .ft button{flex:1;height:36px;border-radius:9px;border:1px solid #e6ebf1;background:#fff;color:#647082;cursor:pointer;font:inherit;font-size:12.5px;font-weight:750;transition:border-color .16s,color .16s}
        .ft button:hover:not(:disabled){border-color:#5a8d3b;color:#178048}
        .ft button:disabled{opacity:.45;cursor:not-allowed}
        .ft.go{padding-bottom:6px}
        .ft button.pri{background:#178048;border-color:#178048;color:#fff}
        .ft button.pri:hover:not(:disabled){background:#106438;border-color:#106438;color:#fff}
      </style>
      <div class="box">
        <div class="hd">${logo ? `<img src="${logo}" alt="">` : ''}<div class="br"><span class="ey">SPEEKSNET</span><span class="ti">Marketplace Lister</span></div><button id="x" title="Close this panel">×</button></div>
        <div class="bd">
          <div class="it">${esc(view.head)}</div>
          <div class="sku">${esc(view.sub)}</div>
          ${warn}
          <ul>${rows}</ul>
          ${view.extra}
          ${view.note ? `<div class="next">${view.note}</div>` : ''}
        </div>
        ${view.buttons && view.page === 1 ? `<div class="ft go"><button id="go" class="pri" ${busy ? 'disabled' : ''}>Confirm &amp; Next</button></div>` : ''}
        ${view.buttons ? `<div class="ft">
          <button id="again" ${busy ? 'disabled' : ''}>Fill Again</button>
          <button id="copy">Copy Description</button>
        </div>` : ''}
      </div>`;
    r.getElementById('x').onclick = () => { closePanel(); send({ type: 'done' }); };
    // Fill Again fills the page you're ON (page two has no Title box).
    const again = r.getElementById('again'); if (again) again.onclick = () => (onPage2() ? fillPage2() : fill());
    const go = r.getElementById('go'); if (go) go.onclick = () => confirmNext();
    const copy = r.getElementById('copy');
    if (copy) copy.onclick = async (e) => {
      try { await navigator.clipboard.writeText(job.fb.description); e.target.textContent = 'Copied'; }
      catch (_) { e.target.textContent = 'Copy blocked'; }
    };
  }

  // ── fill the form ──────────────────────────────────────────────────────────

  async function fill() {
    if (busy || !job) return;
    busy = true;
    const fb = job.fb;
    view.head = job.item.title;
    view.sub = `${job.item.sku} · ${job.item.store} · $${fb.price}`;
    view.extra = ''; view.buttons = true; view.page = 1;
    view.steps = [
      { key: 'photos', label: 'Photos', state: 'run', text: `fetching ${fb.photos.length}…` },
      { key: 'title', label: 'Title', state: 'run' },
      { key: 'price', label: 'Price', state: 'run' },
      { key: 'category', label: 'Category', state: 'run' },
      { key: 'condition', label: 'Condition', state: 'run' },
      { key: 'description', label: 'Description', state: 'run' },
      { key: 'sku', label: 'SKU', state: 'run' },
      { key: 'location', label: 'Location', state: 'wait', text: '— on the next page' },
      { key: 'meetup', label: 'Public Meetup', state: 'wait', text: '— on the next page' },
    ];
    view.note = '';
    const set = (key, state, text) => { const s = view.steps.find((x) => x.key === key); s.state = state; s.text = text || ''; render(); };
    render();
    startPageWatch();

    // Already past page one (the panel came back on page two): page one's
    // rows are history, so fill this page instead of waiting for a Title box.
    if (onPage2()) {
      view.steps.forEach((s) => { if (s.state === 'run') { s.state = 'ok'; s.text = 'page one'; } });
      busy = false;
      return fillPage2();
    }

    const ready = await waitFor(() => field('Title'));
    if (!ready) {
      view.steps.forEach((s) => { if (s.state === 'run') { s.state = 'bad'; s.text = '— form not found'; } });
      busy = false;
      view.note = "Couldn't find Facebook's listing form. Make sure you're signed in to Facebook and on <b>Marketplace → Create new listing → Item for sale</b>, then press <b>Fill again</b>.";
      render();
      return;
    }

    // Photos first: Facebook re-lays-out the form once photos land, and a field
    // typed before that can lose focus mid-render.
    if (fb.photos.length) {
      const got = await send({ type: 'photos', urls: fb.photos });
      const n = got.ok ? await attachPhotos(got.files) : 0;
      if (n) set('photos', got.failed?.length ? 'todo' : 'ok', got.failed?.length ? `— ${n} added, ${got.failed.length} failed to download` : `— ${n} added`);
      else set('photos', 'bad', '— couldn\'t attach; add them yourself');
      await sleep(1200);
    } else set('photos', 'todo', '— none on Shopify; add some');

    const t = field('Title');
    set('title', t && setValue(t, fb.title) ? 'ok' : 'bad', t ? '' : '— not found, type it in');
    // Facebook reformats the price as it's typed ("$500", "1,049"), so the box
    // never reads back exactly "500" — compare the digits, not the string.
    // (First real test, 11-13: the price went in but the panel said ×.)
    const p = field('Price');
    if (p) setValue(p, String(fb.price));
    const priceIn = p && p.value.replace(/\D/g, '') === String(fb.price);
    set('price', priceIn ? 'ok' : 'bad', !p ? '— not found, type it in' : priceIn ? `— $${fb.price}` : `— check it says $${fb.price}`);

    // Category: the one people at SPEEKS picked most for this kind of item
    // (fb-lister learns it from fb_listings). None learned yet → the person
    // picks, and that pick teaches the next listing.
    if (fb.category) {
      const ok = await pickCategory(fb.category);
      set('category', ok ? 'ok' : 'todo', ok ? fb.category : `Pick It Yourself (try “${fb.category}”)`);
    } else set('category', 'todo', 'Pick It Yourself');

    if (fb.condition) {
      const ok = await pickOption('Condition', fb.condition);
      set('condition', ok ? 'ok' : 'todo', ok ? `— ${fb.condition}` : `— pick “${fb.condition}”`);
    } else set('condition', 'todo', '— none on file, pick it');

    // Description sits under "More details" on some layouts; open it if shut.
    let d = field('Description');
    if (!d) {
      const more = moreDetails();
      if (more && more.getAttribute('aria-expanded') !== 'true') { more.click(); d = await waitFor(() => field('Description'), 3000); }
    }
    set('description', d && setValue(d, fb.description) ? 'ok' : 'bad', d ? '' : '— not found; use Copy description');

    // SKU, under "More details" ("Optional. Only visible to you"). Ours goes
    // in, so whoever reads their Selling page can match a listing to the shelf.
    let s = field('SKU');
    if (!s) {
      const more = moreDetails();
      if (more && more.getAttribute('aria-expanded') !== 'true') { more.click(); s = await waitFor(() => field('SKU'), 3000); }
    }
    set('sku', s && setValue(s, job.item.sku) ? 'ok' : 'bad', s ? `— ${job.item.sku}` : `— not found; type ${job.item.sku} under More details`);

    busy = false;
    view.note = '<b>Your turn:</b> Pick the category and read every field and photo, then press <b>Confirm &amp; Next</b>. On the next page it sets the location and Public meetup and ticks the groups that fit. You click <b>Publish</b> yourself — this tool never posts.';
    render();
    watchForGroups();
  }

  // The "More details" toggle. Its text carries a subtitle ("Attract more
  // interest…"), so match the start. Callers check aria-expanded first —
  // clicking an open one folds the SKU box away.
  function moreDetails() {
    return Array.from(document.querySelectorAll('[role="button"], div[tabindex]'))
      .filter((b) => norm(b.textContent).startsWith('more details') && norm(b.textContent).length < 120)
      .sort((a, b) => a.textContent.length - b.textContent.length)[0] || null;
  }

  // Facebook's own Next button on page one.
  function nextButton() {
    return Array.from(document.querySelectorAll('[role="button"], button')).find((b) =>
      visible(b) && (norm(b.getAttribute('aria-label')) === 'next' || norm(b.textContent) === 'next'));
  }

  // Only ever run from the panel's "Confirm & Next" — the person's click.
  async function confirmNext() {
    if (busy || !job) return;
    busy = true;
    const set = (key, state, text) => { const s = view.steps.find((x) => x.key === key); if (s) { s.state = state; s.text = text || ''; } render(); };

    saveCategory();


    const btn = nextButton();
    if (!btn || btn.getAttribute('aria-disabled') === 'true') {
      busy = false;
      view.note = '<b>Facebook\'s Next isn\'t ready.</b> Usually the category is still empty, or a field is flagged in red. Fix it, then press <b>Confirm &amp; Next</b> again.';
      render();
      return;
    }
    btn.click();
    view.page = 2;
    view.note = 'Moving to the next page…';
    render();
    busy = false;
    const ready = await waitFor(onPage2, 15000);
    if (ready) await fillPage2();
    else {
      const area = STORE_AREA[job.item.store];
      set('location', 'bad', area ? `set it to ${area} yourself` : 'set it yourself');
      set('meetup', 'bad', 'tick Public meetup yourself (and leave door pickup off)');
    }
  }

  // ── PAGE TWO: "Delivery method" ────────────────────────────────────────────
  // Location, and Meetup preferences (Public meetup / Door pickup / Door
  // dropoff). Filled however the person got here — the panel's Confirm & Next,
  // or Facebook's own Next (the 11-13 test did that, and nothing filled) — and
  // again by Fill Again while on this page. Fill Again used to restart page
  // one and sit waiting for a Title box that page two doesn't have.
  // Notices page two however it was reached (Facebook's own Next included)
  // and fills it once.
  let pageTimer = null;
  function startPageWatch() {
    clearInterval(pageTimer);
    pageTimer = setInterval(() => {
      if (!job || !onCreatePage()) { clearInterval(pageTimer); return; }
      if (view.page !== 1) return;
      if (!onPage2()) { const c = categoryValue(); if (c) lastCategory = c; return; }
      if (!busy) { saveCategory(); fillPage2(); }
    }, 1000);
  }

  function onPage2() {
    if (field('Title')) return false;
    return !!(field('Location') || /meetup preferences|delivery method/i.test(document.body.innerText.slice(0, 20000)));
  }

  async function fillPage2() {
    if (busy || !job) return;
    busy = true;
    view.page = 2;
    const set = (key, state, text) => { const s = view.steps.find((x) => x.key === key); if (s) { s.state = state; s.text = text || ''; } render(); };
    set('location', 'run', ''); set('meetup', 'run', '');
    view.note = '';

    const area = STORE_AREA[job.item.store];
    if (area) {
      const now = locationValue();
      if (now && sameCity(now, area)) set('location', 'ok', now);
      else {
        const got = await setLocation(area);
        set('location', got ? 'ok' : 'bad', got || `set it to ${area} yourself`);
      }
    } else set('location', 'todo', 'set it to the store\'s city');

    const meet = await setBox('Public meetup', true);
    const doorP = await setBox('Door pickup', false);
    const doorD = await setBox('Door dropoff', false);
    if (meet === true) set('meetup', 'ok', (doorP || doorD) ? 'turn door pickup and dropoff off' : '');
    else set('meetup', 'bad', 'tick Public meetup yourself (and leave door pickup off)');

    busy = false;
    view.note = decided.size
      ? '<b>Your turn:</b> Check the location and groups — untick any that don\'t fit — then click <b>Publish</b> yourself.'
      : '<b>Your turn:</b> Check the location, click <b>Next</b>, check the groups, then click <b>Publish</b> yourself.';
    render();
  }

  // Facebook writes "Lees Summit" without the apostrophe; compare letters only.
  const letters = (s) => norm(s).replace(/[^a-z0-9]/g, '');
  function sameCity(shown, area) {
    const [city, state] = area.split(',').map((x) => x.trim());
    return letters(shown).startsWith(letters(city)) && (!state || letters(shown).includes(letters(state)));
  }
  function locationValue() {
    const el = field('Location');
    if (el) return (el.value || '').trim();
    // Some layouts show it as a box of text, "Location" over the place.
    for (const n of document.querySelectorAll('span, div')) {
      if (n.children.length || norm(n.textContent) !== 'location') continue;
      const box = n.parentElement?.parentElement;
      const lines = (box?.innerText || '').split('\n').map((s) => s.trim()).filter((s) => s && norm(s) !== 'location');
      if (lines[0]) return lines[0];
    }
    return '';
  }

  // ── groups: the "list in more places" step ─────────────────────────────────
  //
  // HOW A GROUP GETS TICKED (first match wins):
  //   1. A rule from the popup's Groups tab whose name-text is in the group's
  //      name: "never" skips it; "all items" ticks it; "keywords" ticks it when
  //      any keyword is in the item's title or collections.
  //   2. Automatic (on unless switched off in the Groups tab): a LOCAL group —
  //      the store's own metro area in the name — that is about buying and
  //      selling or about this kind of item, and isn't about something we
  //      don't sell (cars, rentals, pets, furniture…). A national group is
  //      never ticked automatically: Marketplace items are local pickup, and
  //      plenty of hobby groups ban sales posts.
  // It only ever TICKS, once per group per listing, and never unticks: a box
  // the person changed stays the way they left it.

  const LOCAL = {
    KC: /kansas city|\bkc\b|\bkck\b|kcmo|overland park|olathe|lenexa|shawnee|merriam|mission|leawood|prairie village|johnson county|\bjo ?co\b|lee'?s summit|blue springs|independence|raytown|grandview|belton|westport|midtown|liberty|gladstone|north kc|northland|lawrence/,
    STL: /st\.? ?louis|saint louis|\bstl\b|ballwin|maplewood|chesterfield|kirkwood|webster groves|manchester|wildwood|ellisville|creve coeur|st\.? ?charles|o'?fallon|brentwood|richmond heights|south county|west county|north county|fenton|arnold|florissant/,
  };
  const METRO = { OVL: 'KC', LEE: 'KC', WSP: 'KC', MPL: 'STL', BAL: 'STL' };
  const BUYSELL = /buy|sell|swap|trade|for sale|marketplace|yard sale|garage sale|classified|b\/s\/t|\bbst\b|deals?\b/;
  const UNRELATED = /furniture|\bcars?\b|\bauto\b|truck|vehicle|motorcycle|\bboats?\b|\brv\b|real estate|\brent|housing|apartment|\bjobs?\b|\bpets?\b|\bdogs?\b|\bcats?\b|pupp|kitten|horse|livestock|\bbaby\b|kids clothes|clothing|clothes|fashion|shoes|plants?\b|garden|\bfarm|church|free stuff|freecycle|\bfree\b|lost and found|crime|news|events/;
  const TOPICS = {
    games: /video ?games?|gaming|gamers?|nintendo|\bswitch\b|playstation|\bps[1-5]\b|xbox|sega|retro games?|\b3ds\b|\bds\b|\bwii\b|game ?boy|game ?cube|steam deck/,
    phones: /phones?\b|iphone|android|galaxy|pixel|cell/,
    computers: /laptops?|computers?|\bpcs?\b|macbook|\bmac\b|imac|chromebook|desktop|gpu|graphics card|monitor/,
    tablets: /tablets?|ipad|kindle|e-?reader/,
    audio: /audio|headphones?|earbuds?|airpods|speakers?|stereo|turntable|vinyl|record player|receiver|guitars?|music|instruments?|\bdj\b/,
    cameras: /cameras?|lens|gopro|drones?|photography/,
    tv: /\btvs?\b|television|projector|home theater/,
    tools: /\btools?\b|drill|dewalt|milwaukee|makita|ryobi/,
    watches: /watch(es)?\b|smartwatch|garmin|fitbit/,
    collectibles: /pokemon|trading cards?|\btcg\b|collectibles?|lego|funko/,
    electronics: /electronics?|\btech\b|gadgets?/,
  };
  const topicsOf = (s) => Object.keys(TOPICS).filter((k) => TOPICS[k].test(s));

  function itemText() {
    return norm(`${job.item.title} ${(job.item.collections || []).join(' ').replace(/-/g, ' ')}`);
  }

  function decide(groupName, rules, auto) {
    const g = norm(groupName);
    for (const r of rules) {
      const needle = norm(r.name);
      if (!needle || !g.includes(needle)) continue;
      if (r.mode === 'never') return { pick: false, why: 'your rule: never' };
      if (r.mode === 'all') return { pick: true, why: 'your rule: every item' };
      const kws = String(r.keywords || '').split(',').map(norm).filter(Boolean);
      const hit = kws.find((k) => itemText().includes(k));
      return hit ? { pick: true, why: `your rule: “${hit}”` } : { pick: false, why: 'your rule: no keyword matched' };
    }
    if (!auto) return { pick: false, why: '' };
    const metro = METRO[job.item.store];
    if (!metro || !LOCAL[metro].test(g)) return { pick: false, why: 'not local' };
    if (UNRELATED.test(g)) return { pick: false, why: 'not our kind of item' };
    const gt = topicsOf(g).filter((t) => t !== 'electronics');
    const it = topicsOf(itemText());
    if (gt.length) {
      const both = gt.filter((t) => it.includes(t));
      return both.length ? { pick: true, why: `local, ${both[0]}` } : { pick: false, why: `local, but about ${gt[0]}` };
    }
    if (BUYSELL.test(g) || TOPICS.electronics.test(g)) return { pick: true, why: 'local buy/sell' };
    return { pick: false, why: 'local, but not a selling group' };
  }

  // Group rows on the "more places" step: a checkbox whose row text is the
  // group name. The first step's own checkboxes (hide from friends, pickup
  // options) are left alone by name.
  const NOT_A_GROUP = /hide from friends|pickup|pick up|drop ?off|delivery|shipping|boost|public meetup|door/;
  function groupRows() {
    const out = [];
    for (const cb of document.querySelectorAll('[role="checkbox"], input[type="checkbox"]')) {
      if (!visible(cb) && !(cb.tagName === 'INPUT' && visible(cb.parentElement))) continue;
      let name = cb.getAttribute('aria-label') || '';
      if (!name) {
        let el = cb;
        for (let i = 0; i < 6 && el && !name; i++) {
          el = el.parentElement;
          const t = (el?.innerText || '').trim();
          if (t && t.length < 160) name = t.split('\n')[0];
        }
      }
      name = name.trim();
      if (!name || NOT_A_GROUP.test(norm(name)) || /^marketplace$/i.test(name)) continue;
      const checked = cb.tagName === 'INPUT' ? cb.checked : cb.getAttribute('aria-checked') === 'true';
      out.push({ cb, name, checked });
    }
    return out;
  }
  function onGroupsStep() {
    const t = norm(document.body.innerText.slice(0, 20000));
    return /list in more places|more places|suggested groups|your groups/.test(t) && groupRows().length > 0;
  }

  let groupTimer = null;
  const decided = new Map(); // group name → {pick, why, ticked}
  function watchForGroups() {
    clearInterval(groupTimer);
    decided.clear();
    groupTimer = setInterval(async () => {
      if (!job || !onCreatePage()) { clearInterval(groupTimer); return; }
      if (!onGroupsStep()) return;
      // Group rules are parked (Ethan, 11-13: "get rid of the your rules for
      // now"); the popup no longer edits them, so none saved earlier apply
      // unseen. To bring them back, read groupRules here again and restore
      // the Your Rules block in popup.html/popup.js (git history, v1.3.0).
      const { groupAuto = true } = await chrome.storage.local.get('groupAuto');
      const groupRules = [];
      let changed = false;
      for (const row of groupRows()) {
        if (decided.has(row.name)) continue;
        const d = decide(row.name, groupRules, groupAuto);
        let ticked = false;
        if (d.pick && !row.checked) { row.cb.click(); ticked = true; await sleep(150); }
        decided.set(row.name, { ...d, ticked: ticked || (d.pick && row.checked) });
        changed = true;
      }
      if (changed) showGroups();
    }, 1000);
  }
  function showGroups() {
    // Only what was ticked, and no reasons (Ethan, 11-13: the unticked list
    // and "(local buy/sell)" were noise). decide() still works out the why.
    const picked = [...decided.entries()].filter(([, d]) => d.ticked);
    view.extra = `<div class="grp"><b>Groups Ticked: ${picked.length}</b>
      ${picked.map(([n]) => `<div>✓ ${esc(n)}</div>`).join('') || '<div class="why">None fit this item. Tick any you want yourself — or join more local buy/sell groups (the extension\'s Groups tab has search buttons); it can only use groups you\'re in.</div>'}
    </div>`;
    view.note = '<b>Your turn:</b> Check the location and groups — untick any that don\'t fit — then click <b>Publish</b> yourself.';
    render();
  }

  // ── sold: point at the listings to mark sold ───────────────────────────────

  async function markSoldMode() {
    view.head = 'Sold in Shopify';
    view.sub = `${job.sold.length} listing${job.sold.length === 1 ? '' : 's'} to mark sold`;
    view.buttons = false; view.extra = '';
    view.steps = job.sold.map((s) => ({ key: s.sku, label: s.title, state: 'run', text: '— looking…' }));
    view.note = '';
    render();
    const end = Date.now() + 25000;
    const found = new Set();
    while (Date.now() < end && found.size < job.sold.length) {
      for (const s of job.sold) {
        if (found.has(s.sku)) continue;
        const card = findCard(s.title);
        if (!card) continue;
        found.add(s.sku);
        card.style.outline = '3px solid #c62828';
        card.style.outlineOffset = '2px';
        card.style.borderRadius = '8px';
        const btn = Array.from(card.querySelectorAll('[role="button"], button, a')).find((b) => /mark as sold/i.test(b.textContent || b.getAttribute('aria-label') || ''));
        if (btn) { btn.style.outline = '3px solid #ed6c02'; btn.style.outlineOffset = '2px'; }
        if (found.size === 1) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const st = view.steps.find((x) => x.key === s.sku);
        st.state = 'ok'; st.text = btn ? '— outlined; click its Mark as sold' : '— outlined; use its ⋯ menu → Mark as sold';
        render();
      }
      if (found.size < job.sold.length) { window.scrollBy(0, 600); await sleep(900); }
    }
    for (const st of view.steps) if (st.state === 'run') { st.state = 'todo'; st.text = '— not found here; it may already be marked sold or deleted'; }
    view.note = 'Click <b>Mark as sold</b> on each outlined listing. Then press <b>Marked Sold</b> next to it in the extension\'s <b>Listed</b> tab.';
    render();
  }

  // The listing card for a title: the smallest element whose text starts with
  // the title (Facebook may cut a long title short), walked up to the block
  // that holds the listing's buttons.
  function findCard(title) {
    const want = norm(title).slice(0, 40);
    for (const el of document.querySelectorAll('span, a, div[dir="auto"]')) {
      if (el.children.length > 2) continue;
      const t = norm(el.textContent);
      if (!t || t.length > 200 || !(t.startsWith(want) || want.startsWith(t.replace(/…$/, '')) && t.length > 20)) continue;
      let card = el;
      for (let i = 0; i < 14 && card; i++) {
        card = card.parentElement;
        if (card && card.querySelector('[role="button"], button') && card.getBoundingClientRect().height > 80) return card;
      }
    }
    return null;
  }

  // ── boot ───────────────────────────────────────────────────────────────────

  async function boot() {
    if (!onCreatePage() && !onSellingPage()) return;
    const got = await send({ type: 'job' });
    if (!got.ok || !got.job) return;
    job = got.job;
    if (job.sold && onSellingPage()) markSoldMode();
    else if (job.fb && onCreatePage()) fill();
  }

  // ── PUBLISHED? (Ethan, 2026-11-13) ─────────────────────────────────────────
  // The store's Listed list is only for listings that actually went up — a
  // form the tool opened and nobody published isn't one. This only WATCHES:
  // it notes the person's own click on Facebook's Publish, and counts it once
  // Facebook leaves the create form (or says the listing is published) within
  // two minutes. A Publish Facebook refused leaves you on the form, so it
  // doesn't count.
  let publishAt = 0, reported = false;
  document.addEventListener('click', (e) => {
    if (!job?.fb || !onCreatePage()) return;
    const b = e.target.closest && e.target.closest('[role="button"], button');
    if (b && (norm(b.getAttribute('aria-label')) === 'publish' || norm(b.textContent) === 'publish')) publishAt = Date.now();
  }, true);
  function reportPublished() {
    if (reported || !job?.fb) return;
    reported = true;
    send({ type: 'published', item: job.item, fb: job.fb });
  }
  setInterval(() => {
    if (!publishAt || reported || Date.now() - publishAt > 120000) return;
    if (!onCreatePage() || /your listing (is|has been) published|listing published/i.test(document.body.innerText.slice(0, 5000))) reportPublished();
  }, 700);

  boot();
  // Facebook is a single-page app: leaving the form doesn't reload the page,
  // so watch the path and take the panel down when the page it was for is gone.
  let last = location.pathname;
  setInterval(() => {
    if (location.pathname === last) return;
    last = location.pathname;
    if (publishAt && !reported && Date.now() - publishAt < 120000 && !onCreatePage()) reportPublished();
    const here = (job?.fb && onCreatePage()) || (job?.sold && onSellingPage());
    if (!here && host) { closePanel(); clearInterval(groupTimer); }
    else if (!host) boot();
  }, 800);
})();
