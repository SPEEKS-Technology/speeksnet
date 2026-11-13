// SPEEKS Marketplace Lister — runs on facebook.com.
//
// It does nothing unless background.js opened THIS tab for a listing (it asks
// for a job; ordinary Facebook browsing has none). With a job, on the
// Marketplace "create item" form, it types in the title, price, condition and
// description, attaches the photos, and shows a small panel saying what it
// filled and what is left for the person to do.
//
// IT NEVER CLICKS NEXT OR PUBLISH. Facebook does not allow automated posting,
// and a listing is a public statement in the store's name — a person reads it
// and posts it. Category is left to the person too: Facebook's category picker
// is a search box with suggestions that change, and a wrong guess is worse than
// an empty field that Facebook refuses to publish without.
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false, error: chrome.runtime.lastError?.message })));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

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

  function panel() {
    if (host) return root;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    root = host.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(host);
    return root;
  }

  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function render(steps, note) {
    const r = panel();
    const rows = steps.map((s) => `<li class="${s.state}"><span class="dot"></span><b>${esc(s.label)}</b> ${esc(s.text || '')}</li>`).join('');
    const warn = (job?.warnings || []).map((w) => `<div class="warn">${esc(w)}</div>`).join('');
    r.innerHTML = `
      <style>
        .box{width:320px;font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;color:#1c1e21;background:#fff;
             border:1px solid #d0d4d9;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);overflow:hidden}
        .hd{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0b1f3a;color:#fff}
        .hd b{flex:1;font-size:13px}.hd button{background:none;border:0;color:#fff;font-size:18px;cursor:pointer;line-height:1}
        .bd{padding:10px 12px;max-height:60vh;overflow:auto}
        .it{font-weight:600;margin-bottom:2px}.sku{color:#65676b;font-size:12px;margin-bottom:8px}
        ul{list-style:none;margin:0 0 8px;padding:0}li{display:flex;gap:6px;align-items:baseline;padding:3px 0}
        .dot{width:8px;height:8px;border-radius:50%;flex:none;background:#bcc0c4;transform:translateY(-1px)}
        li.ok .dot{background:#2e7d32}li.todo .dot{background:#ed6c02}li.bad .dot{background:#c62828}li.run .dot{background:#1877f2}
        .warn{background:#fff4e5;color:#663c00;border-radius:6px;padding:6px 8px;margin:0 0 6px;font-size:12px}
        .next{background:#e7f3ff;border-radius:6px;padding:8px;font-size:12px;margin-top:6px}
        .ft{display:flex;gap:6px;padding:0 12px 12px}
        .ft button{flex:1;padding:7px;border-radius:6px;border:1px solid #d0d4d9;background:#f0f2f5;cursor:pointer;font:inherit}
        .ft button:disabled{opacity:.5;cursor:default}
      </style>
      <div class="box">
        <div class="hd"><b>SPEEKS Lister</b><button id="x" title="Close this panel">×</button></div>
        <div class="bd">
          <div class="it">${esc(job?.item?.title)}</div>
          <div class="sku">${esc(job?.item?.sku)} · ${esc(job?.item?.store)} · $${esc(job?.fb?.price)}</div>
          ${warn}
          <ul>${rows}</ul>
          ${note ? `<div class="next">${note}</div>` : ''}
        </div>
        <div class="ft">
          <button id="again" ${busy ? 'disabled' : ''}>Fill again</button>
          <button id="copy">Copy description</button>
        </div>
      </div>`;
    r.getElementById('x').onclick = () => { host.remove(); host = root = null; send({ type: 'done' }); };
    r.getElementById('again').onclick = () => fill();
    r.getElementById('copy').onclick = async (e) => {
      try { await navigator.clipboard.writeText(job.fb.description); e.target.textContent = 'Copied'; }
      catch (_) { e.target.textContent = 'Copy blocked'; }
    };
  }

  // ── fill ───────────────────────────────────────────────────────────────────

  async function fill() {
    if (busy || !job) return;
    busy = true;
    const fb = job.fb;
    const steps = [
      { key: 'photos', label: 'Photos', state: 'run', text: `fetching ${fb.photos.length}…` },
      { key: 'title', label: 'Title', state: 'run' },
      { key: 'price', label: 'Price', state: 'run' },
      { key: 'category', label: 'Category', state: 'todo', text: '— pick it yourself' },
      { key: 'condition', label: 'Condition', state: 'run' },
      { key: 'description', label: 'Description', state: 'run' },
    ];
    const set = (key, state, text) => { const s = steps.find((x) => x.key === key); s.state = state; s.text = text || ''; render(steps); };
    render(steps);

    const ready = await waitFor(() => field('Title'));
    if (!ready) {
      steps.forEach((s) => { if (s.state === 'run') { s.state = 'bad'; s.text = '— form not found'; } });
      busy = false;
      render(steps, "Couldn't find Facebook's listing form. Make sure you're signed in to Facebook and on <b>Marketplace → Create new listing → Item for sale</b>, then press <b>Fill again</b>.");
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
    const p = field('Price');
    set('price', p && setValue(p, String(fb.price)) ? 'ok' : 'bad', p ? `— $${fb.price}` : '— not found, type it in');

    if (fb.condition) {
      const ok = await pickOption('Condition', fb.condition);
      set('condition', ok ? 'ok' : 'todo', ok ? `— ${fb.condition}` : `— pick “${fb.condition}”`);
    } else set('condition', 'todo', '— none on file, pick it');

    // Description sits under "More details" on some layouts; open it if shut.
    let d = field('Description');
    if (!d) {
      const more = Array.from(document.querySelectorAll('[role="button"], div[tabindex]')).find((b) => norm(b.textContent) === 'more details');
      if (more) { more.click(); d = await waitFor(() => field('Description'), 3000); }
    }
    set('description', d && setValue(d, fb.description) ? 'ok' : 'bad', d ? '' : '— not found; use Copy description');

    busy = false;
    render(steps, '<b>Your turn:</b> pick the category, read every field and the photos, then click <b>Next</b> and <b>Publish</b> yourself. This tool never posts for you.');
  }

  async function boot() {
    if (!onCreatePage()) return;
    const got = await send({ type: 'job' });
    if (!got.ok || !got.job) return;
    job = got.job;
    fill();
  }

  boot();
  // Facebook is a single-page app: leaving the create form doesn't reload the
  // page, so watch the path and take the panel down when the form is gone.
  let last = location.pathname;
  setInterval(() => {
    if (location.pathname === last) return;
    last = location.pathname;
    if (!onCreatePage() && host) { host.remove(); host = root = null; }
    else if (onCreatePage() && !host) boot();
  }, 800);
})();
