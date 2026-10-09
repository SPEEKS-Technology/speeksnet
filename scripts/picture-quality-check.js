// PICTURE QUALITY — the Listing Health section renders, and fits.
//
//   powershell -File scripts/browser-check.ps1 picture-quality-check.js
//
// Behaviour and layout together, because this section is mostly photos: the
// thing most likely to break is a 15-photo strip pushing a row wider than the
// page, which only a measurement can see. The strips are MEANT to scroll inside
// themselves (.pq-strip overflow-x:auto); the page must never grow.

function ph(n) {
    var out = [];
    for (var i = 1; i <= n; i++) out.push({ thumb: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', full: '#', w: 1080, h: 1080 });
    return out;
}
var GUIDE = { 'windows-laptops': { name: 'Windows Laptops', shots: [
    { label: 'Front (Screen On)', cond: null, img: null },
    { label: 'Everything Included', cond: 'items are included', img: null },
    { label: 'Back', cond: null, img: null }] } };
function data(queue) {
    return { scope: { name: 'T', role: 'district manager', stores: ['WSP'], corp: true },
             store: 'WSP', shop: 'paymore-westport.myshopify.com', guide: GUIDE, queue: queue };
}
var RETAKE = { productId: 'gid://shopify/Product/1', sku: 'MO02-1', title: 'Acer Aspire (Broken)', handle: 'acer',
    sheet: 'windows-laptops', sheetName: 'Windows Laptops', verdict: 'retake', reviewedAt: new Date().toISOString(),
    findings: [{ code: 'retake', text: 'Retake following the guide — 6 of 14 required shots are missing.' }],
    stale: false, photos: ph(6), titleNotes: [] };
var FIX = { productId: 'gid://shopify/Product/2', sku: 'MO02-2', title: 'iPhone 11 <Broken> & "Cracked"', handle: 'iph',
    sheet: 'windows-laptops', sheetName: 'Apple iPhones', verdict: 'fix', reviewedAt: new Date().toISOString(),
    findings: [{ code: 'not_square', photo: 9, text: "Photo 9 isn't square (1080×1350)." }],
    stale: true, photos: ph(15), titleNotes: [{ issue: 'Model differs', suggestion: 'PDWR52BTBK' }] };
var REORDER = { productId: 'gid://shopify/Product/3', sku: 'MO02-3', title: 'Surface Laptop Go 3', handle: 'sfc',
    sheet: 'windows-laptops', sheetName: 'Windows Laptops', verdict: 'reorder', reviewedAt: new Date().toISOString(),
    findings: [], reorder: { current: [1, 2, 3, 4, 5, 6], suggested: [1, 6, 2, 3, 4, 5], why: ['Everything Included is not in the first three'] },
    stale: false, photos: ph(6), titleNotes: [] };

// Picture Quality only, unless a test says otherwise: the No Photos tab has its
// own switch (ec-view-photos), read off _lhScope.
_lhScope = { mayPhotos: false, mayCats: false };
_lhPhotos = null;

t('picture quality: the section draws its three tabs with counts', function () {
    _pqData = data([RETAKE, FIX, REORDER]); _pqErr = null; _pqTier = 'retake'; _ecStore = 'WSP';
    var h = _pqHtml();
    if (h.indexOf('Picture Quality') < 0) return 'no section title';
    if (h.indexOf('Retake') < 0 || h.indexOf('Fix These Photos') < 0 || h.indexOf('Reorder') < 0) return 'a tab is missing';
    return h.indexOf('Acer Aspire') >= 0 || 'the retake row is not on the Retake tab';
});

t('picture quality: an empty queue says all clear, a failed read never does', function () {
    _pqData = data([]); _pqErr = null;
    if (_pqHtml().indexOf('All Clear') < 0) return 'empty queue did not say all clear';
    _pqErr = 'HTTP 500'; var h = _pqHtml(); _pqErr = null;
    if (h.indexOf('All Clear') >= 0) return 'a failed read claimed all clear';
    return h.indexOf('not an all clear') >= 0 || 'the failure line is missing';
});

t('picture quality: titles are escaped', function () {
    _pqData = data([FIX]); _pqTier = 'fix';
    var h = _pqHtml();
    if (h.indexOf('<Broken>') >= 0) return 'raw < > in a title reached the page';
    return h.indexOf('&lt;Broken&gt;') >= 0 || 'title not rendered';
});

t('picture quality: the photo a finding names is outlined, and a stale row says so', function () {
    _pqData = data([FIX]); _pqTier = 'fix';
    var d = document.createElement('div'); d.innerHTML = _pqHtml();
    var flagged = d.querySelectorAll('.pq-ph-flag');
    if (flagged.length !== 1) return flagged.length + ' outlined photos, expected 1';
    if ((flagged[0].getAttribute('title') || '') !== 'Photo 9') return 'outlined the wrong photo: ' + flagged[0].getAttribute('title');
    if (!d.querySelector('.pq-stale')) return 'a changed listing did not say it changed';
    return !!d.querySelector('button[onclick^="pqRecheck"]') || 'no Check Again on a fix row';
});

t('picture quality: reorder shows now, suggested and the guide, and can be approved', function () {
    _pqData = data([REORDER]); _pqTier = 'reorder';
    var d = document.createElement('div'); d.innerHTML = _pqHtml();
    var rows = d.querySelectorAll('.pq-ro-row');
    if (rows.length !== 3) return rows.length + ' comparison rows, expected Now / Suggested / Guide';
    var sug = [].map.call(rows[1].querySelectorAll('.pq-n'), function (e) { return e.textContent; }).join(',');
    if (sug !== '1,6,2,3,4,5') return 'suggested strip is in the wrong order: ' + sug;
    if (rows[2].querySelectorAll('.pq-glab').length !== 3) return 'guide strip does not show the sheet shots';
    return !!d.querySelector('button[onclick^="pqReorder"]') || 'no Approve Order button';
});

t('picture quality: a stale reorder cannot be approved', function () {
    var s = JSON.parse(JSON.stringify(REORDER)); s.stale = true;
    _pqData = data([s]); _pqTier = 'reorder';
    var d = document.createElement('div'); d.innerHTML = _pqHtml();
    return !d.querySelector('button[onclick^="pqReorder"]') || 'Approve Order offered on photos that changed';
});

t('picture quality: No Photos is the first tab for a reader who holds it, and leads when it has rows', function () {
    _lhScope = { mayPhotos: true, mayCats: false };
    _lhPhotos = { store: 'WSP', queue: [{ productId: 'gid://shopify/Product/9', sku: 'MO02-9', title: 'Empty Square',
                                          price: 10, quantity: 1, listedAt: new Date().toISOString(), shop: 's', handle: 'h' }] };
    _pqData = data([RETAKE]); _pqTier = null;   // nobody has picked a tab yet
    var d = document.createElement('div'); d.innerHTML = _pqHtml();
    var tabs =[].map.call(d.querySelectorAll('.rc-mode'), function (b) { return b.textContent.trim().split(/\s+/)[0]; });
    _lhScope = { mayPhotos: false, mayCats: false }; _lhPhotos = null;
    if (tabs[0] !== 'No') return 'first tab is ' + tabs[0];
    if (tabs.length !== 4) return tabs.length + ' tabs, expected 4';
    return d.textContent.indexOf('Empty Square') >= 0 || 'the no-photo listing is not on the opening tab';
});

t('picture quality: a manager without Picture Quality sees only No Photos', function () {
    _lhScope = { mayPhotos: true, mayCats: false };
    _lhPhotos = { store: 'WSP', queue: [] };
    var saved = _pqData; _pqData = null;
    var real = window._jumpFeatureVisible;
    window._jumpFeatureVisible = function (k) { return k !== 'ec-view-picture-quality'; };
    var h;
    try { h = _pqHtml(); } finally { window._jumpFeatureVisible = real; _pqData = saved; _lhScope = { mayPhotos: false, mayCats: false }; _lhPhotos = null; }
    if (h.indexOf('Retake') >= 0) return 'Picture Quality tabs shown without the switch';
    return h.indexOf('All Clear') >= 0 || 'the no-photos all clear is missing';
});

t('picture quality: guide slots say Missing, If Needed, or No Example Photo', function () {
    var r = JSON.parse(JSON.stringify(RETAKE));
    r.findings = [{ code: 'retake', shots: ['Back'], text: 'Retake following the guide — 1 of 2 required shots are missing: Back.' }];
    _pqData = data([r]); _pqTier = 'retake';
    var d = document.createElement('div'); d.innerHTML = _pqHtml();
    if (d.querySelector('details .pq-guide')) return 'the guide is in a drawer — it should always show';
    if (!d.querySelector('.pq-cmp .pq-guide')) return 'no guide strip under the photos';
    if (d.querySelector('.lh-alarm')) return 'the retake tab still has the red alarm bar';
    if (d.textContent.indexOf("They're Fine") >= 0 || !/Dismiss/.test(d.querySelector('.pq-acts').textContent)) return 'the button is not called Dismiss';
    var miss = d.querySelectorAll('.pq-gph-miss');
    if (miss.length !== 1 || miss[0].textContent.indexOf('Back') < 0) return 'Back is not marked missing';
    if (d.querySelectorAll('.pq-tag-miss').length !== 1) return 'no Missing tag in the box';
    if (d.textContent.indexOf('If Needed') < 0) return 'the conditional shot is not labelled';
    return d.textContent.indexOf('No Example Photo') >= 0 || 'an empty slot says nothing';
});

t('picture quality: old rows without shot labels still mark from the sentence', function () {
    var r = JSON.parse(JSON.stringify(FIX));
    r.findings = [{ code: 'missing_shot', text: 'Missing: Back.' }];
    r.verdict = 'fix';
    _pqData = data([r]); _pqTier = 'fix';
    var d = document.createElement('div'); d.innerHTML = _pqHtml();
    return d.querySelectorAll('.pq-gph-miss').length === 1 || 'fallback from the sentence did not mark Back';
});

t('picture quality: a dismissed row stays on ITS tab, under Dismissed with Undo — even when the tab is empty', function () {
    var dd = data([FIX]);
    dd.dismissed = [{ productId: 'gid://shopify/Product/7', sku: 'MO02-7', title: 'Kept Order Listing', as: 'reorder', verdict: 'reorder',
                      note: 'box first is deliberate', by: 'Ethan', at: new Date().toISOString(), triaged: false }];
    _pqData = dd; _pqTier = 'fix';
    var f = document.createElement('div'); f.innerHTML = _pqHtml();
    if (f.querySelector('details.lt-denied')) return 'a dismissed reorder shows on the Fix tab';
    _pqTier = 'reorder'; _pqPicked = true;   // as pqSetTier: clicked, so it must stay although Reorder has no open rows
    var d = document.createElement('div'); d.innerHTML = _pqHtml();
    var stayed = _pqTier === 'reorder';
    _pqPicked = false;
    if (!stayed) return 'clicking the empty Reorder tab bounced to ' + _pqTier;
    var box = d.querySelector('details.lt-denied');
    if (!box) return 'no Dismissed drawer';
    if (box.hasAttribute('open')) return 'the drawer opens by default';
    if (box.textContent.indexOf('Order Is Fine') < 0) return 'a dismissed reorder does not say so';
    if (!box.querySelector('button[onclick^="pqReopen"]')) return 'no Undo';
    return !!box.querySelector('button[onclick^="openListingHealthTool"]') || 'no route to the notes';
});

t('picture quality: buttons are sized to their words', function () {
    _pqData = data([REORDER]); _pqTier = 'reorder';
    var host = document.getElementById('pq-host2');
    if (!host) { host = document.createElement('div'); host.id = 'pq-host2'; document.body.appendChild(host); }
    host.style.cssText = 'width:1440px;';
    host.innerHTML = '<div class="cb-panel">' + _pqHtml() + '</div>';
    var b = host.querySelectorAll('.pq-acts button');
    if (b.length !== 2) return b.length + ' buttons';
    // ⚠️ 44px IS ALLOWED, WRAPPING IS NOT. The site's tap-target block gives
    // every button min-height:44px on touch and narrow screens, deliberately,
    // and this harness can land inside that query. What made the first version
    // chunky was "Approve Order" wrapping to two lines inside a squeezed
    // flex:1 button — so the test is: one line, and no taller than a tap target.
    for (var i = 0; i < b.length; i++) {
        var r = b[i].getBoundingClientRect();
        if (getComputedStyle(b[i]).whiteSpace !== 'nowrap') return '"' + b[i].textContent.trim() + '" can wrap';
        if (r.height > 46) return '"' + b[i].textContent.trim() + '" is ' + Math.round(r.height) + 'px tall';
        if (b[i].scrollWidth > b[i].clientWidth + 1) return '"' + b[i].textContent.trim() + '" is cut off';
    }
    return true;
});

t('listing health notes: picture notes render with their own copy and clear', function () {
    _lhToolPq = { total: 1, keys: [{ store: 'WSP', productId: 'x' }], done: [], ask: 'ASK',
        groups: [{ code: 'missing_shot', label: 'Said a guide shot was missing', n: 1,
                   rows: [{ store: 'WSP', sku: 'MO02-1', title: 'Xbox controller', note: 'serial is under the cover', by: 'E',
                            findings: ['Missing: Serial Number.'] }] }] };
    var h = _lhToolPqHtml(); _lhToolPq = null;
    if (h.indexOf('serial is under the cover') < 0) return 'the note is not shown';
    if (h.indexOf('lhToolPqCopy') < 0) return 'no copy button';
    return h.indexOf('lhToolPqDone') >= 0 || 'no clear button';
});

// --- Listing Health as tabs (2026-09-30) ----------------------------------
function withAllHalves(fn) {
    var real = window._jumpFeatureVisible;
    window._jumpFeatureVisible = function () { return true; };
    _lhScope = { mayPhotos: true, mayCats: true };
    try { return fn(); }
    finally { window._jumpFeatureVisible = real; _lhScope = { mayPhotos: false, mayCats: false }; _lhPhotos = null; _lhTab = null; }
}

t('listing health: three tabs in the order Title Quality, Picture Quality, Categories', function () {
    return withAllHalves(function () {
        _ltData = { queue: [], scope: {} }; _ltErr = null; _rcData = { counts: { other: 3 }, queue: [] };
        _pqData = data([FIX]); _lhPhotos = { queue: [] }; _lhTab = null;
        var d = document.createElement('div'); d.innerHTML = _lhHtml();
        var labels = [].map.call(d.querySelectorAll('.lh-tab'), function (b) { return b.childNodes[0].textContent.trim(); });
        if (labels.join('|') !== 'Title Quality|Picture Quality|Categories') return 'order is ' + labels.join('|');
        if (!d.querySelector('.lh-tab-on') || d.querySelector('.lh-tab-on').textContent.indexOf('Title Quality') < 0) return 'Title Quality is not open first';
        return d.textContent.indexOf('Picture Quality') >= 0 && !d.querySelector('.pq-row') || 'more than one tool drawn at once';
    });
});

t('listing health: a listing with no photo opens Picture Quality and turns its chip red', function () {
    return withAllHalves(function () {
        _ltData = { queue: [], scope: {} }; _rcData = { counts: {}, queue: [] }; _pqData = data([]);
        _lhPhotos = { queue: [{ productId: 'p', sku: 'S', title: 'Empty Square', price: 1, quantity: 1, listedAt: new Date().toISOString(), shop: 's' }] };
        _lhTab = null;
        var d = document.createElement('div'); d.innerHTML = _lhHtml();
        var on = d.querySelector('.lh-tab-on');
        if (!on || on.textContent.indexOf('Picture Quality') < 0) return 'did not open on Picture Quality';
        if (!d.querySelector('.lh-tab-bad')) return 'the alarm chip is not red';
        // …and stays red from another tab.
        _lhTab = 'titles'; d.innerHTML = _lhHtml();
        return !!d.querySelector('.lh-tab-bad') || 'the alarm vanished once another tab was open';
    });
});

t('listing health: the chosen tab sticks across a re-render', function () {
    return withAllHalves(function () {
        _ltData = { queue: [], scope: {} }; _rcData = { counts: { other: 1 }, queue: [] }; _pqData = data([]); _lhPhotos = { queue: [] };
        lhSetTab('cats');
        var d = document.createElement('div'); d.innerHTML = _lhHtml();
        return d.querySelector('.lh-tab-on').textContent.indexOf('Categories') >= 0 || 'lost the chosen tab';
    });
});

t('listing health: the three tabs are the same width', function () {
    return withAllHalves(function () {
        _ltData = { queue: [], scope: {} }; _rcData = { counts: { other: 13 }, queue: [] }; _pqData = data([FIX]); _lhPhotos = { queue: [] };
        var host = document.getElementById('pq-host3');
        if (!host) { host = document.createElement('div'); host.id = 'pq-host3'; document.body.appendChild(host); }
        host.style.cssText = 'width:1440px;';
        host.innerHTML = '<div class="cb-panel">' + _lhHtml() + '</div>';
        var w = [].map.call(host.querySelectorAll('.lh-tab'), function (b) { return Math.round(b.getBoundingClientRect().width); });
        if (w.length !== 3) return w.length + ' tabs';
        if (w[0] !== w[1] || w[1] !== w[2]) return 'widths differ: ' + w.join(', ');
        var cut = [].filter.call(host.querySelectorAll('.lh-tab'), function (b) { return b.scrollWidth > b.clientWidth + 1; });
        return !cut.length || 'a tab label is cut off';
    });
});

t('all stores card: Title, Picture (with No Photos first) and Category drawers with totals', function () {
    var savedRc = _rcCounts, savedPq = _pqCounts;
    _rcCounts = { photos: { OVL: 2 }, titles: { OVL: 10 }, titlesWrong: { OVL: 0 },
                  other: { OVL: 8 }, unmatched: { OVL: 3 }, misfiled: { OVL: 2 } };
    _pqCounts = { counts: { OVL: { retake: 1, fix: 10, reorder: 1 } } };
    var d = document.createElement('div'); d.innerHTML = _ecHealthCats('OVL');
    _rcCounts = savedRc; _pqCounts = savedPq;
    if (d.querySelector(':scope > .ec-hrow')) return 'a row is still on the face of the card';
    var pqRows = d.querySelectorAll('details.ec-hgrp')[1].querySelectorAll('.ec-hrow');
    if (!pqRows.length || pqRows[0].textContent.indexOf('No Photos') < 0) return 'No Photos is not first in Picture Quality';
    var heads = [].map.call(d.querySelectorAll('details.ec-hgrp > summary'), function (s) {
        return [].map.call(s.children, function (c) { return c.textContent.trim(); }).join(' ');
    });
    if (heads.join(' | ') !== 'Title Quality 10 | Picture Quality 14 | Categories 13') return 'drawers: ' + heads.join(' | ');
    // A retake is red on the shut drawer, because it is wrong in front of a buyer.
    var pqN = d.querySelectorAll('.ec-hgrp-n')[1];
    if (!pqN.classList.contains('ec-bad')) return 'Picture Quality total is not red with a retake in it';
    return d.querySelectorAll('details.ec-hgrp[open]').length === 0 || 'a drawer opens by default';
});

// Without the Picture Quality switch the drawer still holds No Photos (the same
// as the tab, where such a reader sees No Photos only) — and nothing else.
t('all stores card: without Picture Quality counts the drawer holds No Photos only', function () {
    var savedRc = _rcCounts, savedPq = _pqCounts;
    _rcCounts = { photos: { OVL: 0 }, other: { OVL: 1 }, unmatched: { OVL: 0 }, misfiled: { OVL: 0 } };
    _pqCounts = null;
    var h = _ecHealthCats('OVL');
    _rcCounts = { other: { OVL: 1 }, unmatched: { OVL: 0 }, misfiled: { OVL: 0 } };
    var none = _ecHealthCats('OVL');
    _rcCounts = savedRc; _pqCounts = savedPq;
    if (h.indexOf('Retake') >= 0) return 'drew Retake rows for a reader without Picture Quality';
    if (h.indexOf('No Photos') < 0) return 'No Photos is missing';
    return none.indexOf('Picture Quality') < 0 || 'drew a Picture Quality drawer for a reader with neither half';
});

t('listing health notes: both halves are headed, and the empty lines name their tool', function () {
    var h = _lhToolPqHtml.call(null);   // nothing loaded → nothing
    if (h) return 'drew a picture half with no data';
    _lhToolPq = { total: 0, groups: [], done: [] };
    h = _lhToolPqHtml(); _lhToolPq = null;
    if (h.indexOf('No Picture Notes Waiting.') < 0) return 'picture empty line is wrong';
    return h.indexOf('lh-tool-h">Picture Quality') >= 0 || 'no Picture Quality header';
});

// --- layout ---------------------------------------------------------------
[390, 820, 1440].forEach(function (w) {
    t('picture quality @' + w + 'px: a 15-photo row does not widen the page', function () {
        _pqData = data([FIX, REORDER]); _pqTier = 'fix';
        var host = document.getElementById('pq-host');
        if (!host) { host = document.createElement('div'); host.id = 'pq-host'; document.body.appendChild(host); }
        host.style.cssText = 'width:' + w + 'px;overflow:hidden;';
        host.innerHTML = '<div class="cb-panel" style="width:100%">' + _pqHtml() + '</div>';
        void host.offsetHeight;
        var limit = host.clientWidth, bad = [];
        host.querySelectorAll('*').forEach(function (el) {
            var cs = getComputedStyle(el);
            if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return;
            if (el.closest('.pq-strip') || el.closest('.pq-ro')) return;   // inside a strip, or the reorder block, that scrolls itself
            if (el.getBoundingClientRect().width > limit + 1) bad.push((el.className || el.tagName) + ' ' + Math.round(el.getBoundingClientRect().width));
        });
        if (bad.length) return 'wider than ' + limit + 'px: ' + bad.slice(0, 4).join(' | ');
        var strip = host.querySelector('.pq-strip');
        if (!strip || strip.getBoundingClientRect().height < 60) return 'photo strip has no height';
        var btn = host.querySelector('.lt-acts button');
        return (btn && btn.getBoundingClientRect().width > 40) || 'action button collapsed';
    });
    t('picture quality @' + w + 'px: both buttons are one size, and every row\'s side block is one width', function () {
        var a = JSON.parse(JSON.stringify(FIX)), b = JSON.parse(JSON.stringify(FIX));
        a.productId += '1'; a.sku = 'KS01-7086A3-E5'; b.productId += '2'; b.sku = 'X1'; b.handle = '';
        _pqData = data([a, b]); _pqTier = 'fix';
        var host = document.getElementById('pq-host');
        host.style.cssText = 'width:' + w + 'px;overflow:hidden;';
        host.innerHTML = '<div class="cb-panel" style="width:100%">' + _pqHtml() + '</div>';
        void host.offsetHeight;
        var rows = host.querySelectorAll('.pq-row');
        if (rows.length !== 2) return rows.length + ' rows';
        var widths = [];
        for (var i = 0; i < rows.length; i++) {
            var bs = rows[i].querySelectorAll('.pq-acts button');
            var w0 = Math.round(bs[0].getBoundingClientRect().width), w1 = Math.round(bs[1].getBoundingClientRect().width);
            if (Math.abs(w0 - w1) > 1) return 'buttons differ: ' + w0 + ' vs ' + w1;
            widths.push(Math.round(rows[i].querySelector('.pq-acts').getBoundingClientRect().width));
        }
        return Math.abs(widths[0] - widths[1]) <= 1 || 'button rows differ between listings: ' + widths.join(' vs ');
    });
});
t('picture quality: retake sentence sits in the row above the photos, and the sheet line carries the date', function () {
    _pqData = data([RETAKE]); _pqTier = 'retake';
    var d = document.createElement('div'); d.innerHTML = _pqHtml();
    if (d.querySelector('.lt-said')) return 'there is still a line above the listings';
    var first = d.querySelector('.pq-row .lt-why li');
    if (!first || first.textContent.indexOf('Retake it following the guide') < 0) return 'the first line of the row is not the retake sentence';
    if (first.textContent.indexOf('6 of 14 required shots are missing') < 0) return 'the missing count was dropped';
    if (d.textContent.indexOf('Retake following the guide —') >= 0) return 'the old retake line is still there';
    var sheet = d.querySelector('.pq-sheet').textContent.replace(/\s+/g, ' ').trim();
    return /^Checked [A-Z][a-z]{2} \d{1,2} Against: Windows Laptops$/.test(sheet) || 'sheet line: ' + sheet;
});

t('picture quality: the photo count sits centred over the Store pill', function () {
    _pqData = data([FIX]); _pqTier = 'fix';
    var host = document.getElementById('pq-host');
    host.style.cssText = 'width:1440px;';
    host.innerHTML = '<div class="cb-panel" style="width:100%">' + _pqHtml() + '</div>';
    var n = host.querySelector('.lt-meta .lt-price').getBoundingClientRect();
    var st = host.querySelector('.ec-pill-store').getBoundingClientRect();
    var dx = Math.abs((n.left + n.width / 2) - (st.left + st.width / 2));
    return dx <= 2 || 'off centre by ' + Math.round(dx) + 'px';
});

t('picture quality: who listed it — a name, or Unknown, on its own line under the links', function () {
    var host = document.getElementById('pq-host');
    host.style.cssText = 'width:1440px;';
    _pqData = data([Object.assign({}, FIX, { lister: 'Calvin Meadows' })]); _pqTier = 'fix';
    host.innerHTML = '<div class="cb-panel" style="width:100%">' + _pqHtml() + '</div>';
    var pill = host.querySelector('.pq-lister .lt-lister');
    if (!pill || pill.textContent.trim() !== 'Calvin Meadows') return 'no name pill: ' + (pill && pill.textContent);
    if (host.querySelector('.rc-links .lt-lister')) return 'the pill sits among the links';
    _pqData = data([Object.assign({}, FIX, { lister: null })]);
    host.innerHTML = '<div class="cb-panel" style="width:100%">' + _pqHtml() + '</div>';
    var un = host.querySelector('.pq-lister .lt-lister-unknown');
    return (un && un.textContent.trim() === 'Unknown') || 'no Unknown pill when no tag matched';
});

t('dismiss notes are required: the button waits for words, in both tools', function () {
    var p = _ltAsk({ kind: 'warn', title: 'T', note: { label: 'Why?', required: true }, go: 'Dismiss It' });
    var go = document.querySelector('#ltAskOverlay .lt-ask-go'), box = document.getElementById('ltAskNote');
    if (!go.disabled) { _ltAskClose(null); return 'the button is live with an empty note'; }
    box.value = '   '; box.dispatchEvent(new Event('input'));
    if (!go.disabled) { _ltAskClose(null); return 'spaces counted as a note'; }
    box.value = 'serial is under the cover'; box.dispatchEvent(new Event('input'));
    var live = !go.disabled;
    _ltAskClose(null);
    if (!live) return 'the button stayed off after typing';
    var src = String(pqDismiss) + String(ltDeny);
    return (src.match(/required: true/g) || []).length === 2 || 'pqDismiss / ltDeny do not both ask for a required note';
});

t('title quality: a dismissed title stays on its tab, and the tabs stay when nothing else is open', function () {
    var saved = _ltData, savedT = _ltTier, savedP = _ltPicked;
    _ltData = { queue: [], ebayScope: null,
                denied: { rows: [{ productId: 'gid://shopify/Product/9', sku: 'X9', current: 'Some Title', severity: 3,
                                   as: 'not-a-problem', note: 'it is right', by: 'E', at: new Date().toISOString() }], tally: [] } };
    try {
        _ltTier = 3; _ltPicked = false;
        var a = document.createElement('div'); a.innerHTML = _ltHtml();
        if (!a.querySelector('.lt-modes')) return 'the tabs vanished, so the dismissed row cannot be reached';
        var box = a.querySelector('details.lt-denied');
        if (!box || box.textContent.indexOf('Some Title') < 0) return 'the dismissed row is not under Wrong';
        if (!box.querySelector('button[onclick^="ltReopen"]')) return 'no Undo';
        _ltTier = 2; _ltPicked = true;
        var b = document.createElement('div'); b.innerHTML = _ltHtml();
        if (_ltTier !== 2) return 'the clicked tab bounced';
        return !b.querySelector('details.lt-denied') || 'a Wrong dismissal shows on Hard To Find';
    } finally { _ltData = saved; _ltTier = savedT; _ltPicked = savedP; }
});

// The drawers hold only notes still waiting to be sent, so drawer totals equal
// Listing Health Notes. Cleared (triaged) rows and "Ours Is Fine" rows are out.
t('dismissed drawers: only waiting notes, one name, one wording', function () {
    var saved = _ltData, savedT = _ltTier, savedP = _ltPicked;
    var now = new Date().toISOString();
    _ltData = { queue: [], ebayScope: null, denied: { tally: [], rows: [
        { productId: 'a', sku: 'A', current: 'Waiting', severity: 3, as: 'not-a-problem', note: 'why', at: now, findings: [{ code: 'x' }] },
        { productId: 'b', sku: 'B', current: 'Cleared', severity: 3, as: 'not-a-problem', note: 'why', at: now, triagedAt: now },
        { productId: 'c', sku: 'C', current: 'Stale eBay', severity: 3, as: 'ebay-stale', note: null, at: now }] } };
    try {
        _ltTier = 3; _ltPicked = true;
        var d = document.createElement('div'); d.innerHTML = _ltHtml();
        var box = d.querySelector('details.lt-denied');
        if (!box) return 'no title drawer';
        var s = box.querySelector('summary').textContent.trim();
        if (s !== '1 Dismissed') return 'title summary: ' + s;
        if (box.textContent.indexOf('Cleared') >= 0 || box.textContent.indexOf('Stale eBay') >= 0) return 'a cleared or Ours Is Fine row is in the drawer';
        if (box.textContent.indexOf('1 Note Explained The Check Was Wrong') < 0) return 'bar wording: ' + (box.querySelector('.lt-ask-n') || {}).textContent;
        // Only cleared / eBay rows left → plain all clear, no tabs.
        _ltData.denied.rows.shift();
        var e = document.createElement('div'); e.innerHTML = _ltHtml();
        if (e.querySelector('.lt-modes')) return 'tabs drawn with nothing waiting';
    } finally { _ltData = saved; _ltTier = savedT; _ltPicked = savedP; }
    var dd = data([]);
    dd.dismissed = [{ productId: 'p1', title: 'Waiting Pic', verdict: 'fix', note: 'why', triaged: false },
                    { productId: 'p2', title: 'Cleared Pic', verdict: 'fix', note: 'why', triaged: true }];
    _pqData = dd; _pqTier = 'fix'; _pqPicked = true;
    var p = document.createElement('div'); p.innerHTML = _pqHtml();
    _pqPicked = false;
    var pb = p.querySelector('details.lt-denied');
    if (!pb || pb.querySelector('summary').textContent.trim() !== '1 Dismissed') return 'picture drawer: ' + (pb ? pb.querySelector('summary').textContent : 'none');
    if (pb.textContent.indexOf('Cleared Pic') >= 0) return 'a cleared picture row is in the drawer';
    if (p.querySelector('.lt-scope')) return 'the sentence under All Clear is back';
    return p.textContent.indexOf('Keep Order') < 0 || 'Keep Order is still a button';
});

t('no tab sentence above the rows, on any tab of either tool', function () {
    var bad = [];
    [['retake', RETAKE], ['fix', FIX], ['reorder', REORDER]].forEach(function (p) {
        _pqData = data([p[1]]); _pqTier = p[0];
        var d = document.createElement('div'); d.innerHTML = _pqHtml();
        if (d.querySelector('.lt-said, .lh-alarm')) bad.push('picture ' + p[0]);
    });
    if (typeof _ltHtml === 'function' && typeof _LT_TIERS !== 'undefined') {
        var src = String(_ltHtml);
        if (/_ltTierSaid|lt-said|lh-alarm/.test(src)) bad.push('title tool still draws a tier line');
    }
    return !bad.length || bad.join(', ');
});

t('reorder: one scroll for all three rows, one box size, moved photos marked and counted', function () {
    _pqData = data([REORDER]); _pqTier = 'reorder';
    var host = document.getElementById('pq-host');
    host.style.cssText = 'width:600px;overflow:hidden;';
    host.innerHTML = '<div class="cb-panel" style="width:100%">' + _pqHtml() + '</div>';
    var ro = host.querySelector('.pq-ro');
    if (!ro) return 'no shared reorder block';
    if (getComputedStyle(ro).overflowX !== 'auto') return 'the block does not scroll';
    var strips = ro.querySelectorAll('.pq-strip');
    if (strips.length !== 3) return strips.length + ' strips';
    for (var i = 0; i < 3; i++) if (getComputedStyle(strips[i]).overflowX !== 'visible') return 'strip ' + (i + 1) + ' still scrolls on its own';
    var ph = ro.querySelector('.pq-strip .pq-ph').getBoundingClientRect();
    var g = ro.querySelector('.pq-guide .pq-gph').getBoundingClientRect();
    if (Math.abs(ph.width - g.width) > 1 || Math.abs(ph.left - g.left) > 1) return 'guide box ' + g.width + '@' + g.left + ' vs photo ' + ph.width + '@' + ph.left;
    // suggested [1,6,2,3,4,5]: positions 2-6 all move
    var moved = strips[1].querySelectorAll('.pq-ph-moved').length;
    if (moved !== 5) return moved + ' marked as moved, expected 5';
    if (strips[0].querySelector('.pq-ph-moved')) return 'Now marks moves';
    if (ro.textContent.indexOf('5 Moved') < 0) return 'no Moved count on the label';
    ro.scrollLeft = 200;
    var lab = ro.querySelector('.pq-ro-row > .lt-lab').getBoundingClientRect();
    return Math.abs(lab.left - ro.getBoundingClientRect().left) <= 1 || 'the label scrolled away';
});

t('question box: the two buttons are one width', function () {
    var p = _ltAsk({ kind: 'warn', title: 'T', go: 'Dismiss It', cancel: 'Cancel' });
    var go = document.querySelector('#ltAskOverlay .lt-ask-go').getBoundingClientRect();
    var c = document.querySelector('#ltAskOverlay .lt-ask-cancel').getBoundingClientRect();
    _ltAskClose(null);
    return Math.abs(go.width - c.width) <= 1 || 'Dismiss It ' + go.width + ' vs Cancel ' + c.width;
});

t('findings: one line per problem, square says 1×1, photos open in the viewer', function () {
    var r = JSON.parse(JSON.stringify(FIX));
    r.photos = ph(5);
    r.findings = [
        { code: 'not_square', photo: 3, text: "Photo 3 isn't square (1125×1500)." },
        { code: 'not_square', photo: 1, text: "Photo 1 isn't square (1500×1125)." },
        { code: 'framing', photo: 2, text: "Photo 2 isn't to the guide's standard: taken from the wrong angle." },
        { code: 'framing', photo: 4, text: "Photo 4 isn't to the guide's standard: taken from the wrong angle, too small in the frame." },
        { code: 'blurry', photo: 2, text: 'Photo 2 is blurry.' },
        { code: 'blurry', photo: 4, text: 'Photo 4 is blurry.' },
        { code: 'missing_shot', shot: 'Back', text: 'Missing: Back.' },
        { code: 'flaw_not_shown', text: "The main flaw isn't shown: cracked screen." }];
    _pqData = data([r]); _pqTier = 'fix';
    var d = document.createElement('div'); d.innerHTML = _pqHtml();
    var lines = [].map.call(d.querySelectorAll('.pq-row .lt-why li'), function (li) { return li.textContent.replace(/\s+/g, ' ').trim(); });
    var want = ['Missing — Back', 'Not Square (Should Be 1×1) — Photos 1, 3', 'Taken From The Wrong Angle — Photos 2, 4',
                'Too Small In The Frame — Photo 4', 'Blurry — Photos 2, 4', "The main flaw isn't shown: cracked screen."];
    if (lines.join(' | ') !== want.join(' | ')) return 'lines: ' + lines.join(' | ');
    if (d.textContent.indexOf('1125×1500') >= 0) return 'the photo size is still shown';
    var a = d.querySelector('.pq-strip a.pq-ph');
    if (!/openAuditPhotoLightbox/.test(a.getAttribute('onclick') || '')) return 'a photo click does not open the viewer';
    var gi = d.querySelector('.pq-guide img');
    return !gi || /openAuditPhotoLightbox/.test(gi.getAttribute('onclick') || '') || 'a guide photo does not open the viewer';
});

t('notes tool: "Note" is capitalised in both halves, and the problem labels are red', function () {
    var src = String(_lhToolPqHtml) + String(openListingHealthTool);
    if (/note\$\{n === 1/.test(src) || /dismissal\$\{n === 1/.test(src)) return 'a lower-case "note" / "dismissal" count is still drawn';
    var host = document.getElementById('pq-host');
    _pqData = data([FIX]); _pqTier = 'fix';
    host.innerHTML = '<div class="cb-panel">' + _pqHtml() + '</div>';
    var b = host.querySelector('.pq-row .lt-why b');
    return (b && getComputedStyle(b).color === 'rgb(179, 50, 42)') || 'label colour ' + (b && getComputedStyle(b).color);
});

t('reorder confirm: no PayMore sentence', function () {
    return String(pqReorder).indexOf("PayMore's tool") < 0 || 'still mentions PayMore\'s tool';
});

t('patch notes: Add New and Edit Previous are the same width', function () {
    var host = document.createElement('div');
    host.innerHTML = '<div class="notif-tabs" style="display:inline-flex;"><button id="pnmTab-add" class="tab-btn active">Add New</button><button id="pnmTab-edit" class="tab-btn">Edit Previous</button></div>';
    document.body.appendChild(host);
    var a = document.getElementById('pnmTab-add').getBoundingClientRect().width;
    var e = document.getElementById('pnmTab-edit').getBoundingClientRect().width;
    host.remove();
    return Math.abs(a - e) <= 1 || 'widths ' + a + ' vs ' + e;
});

// --- Train The Checker -------------------------------------------------------
// Built up by hand rather than through pqTrainOpen, because the open fetches
// and these assertions are synchronous. _pqPost is invoked before pqTrainLabel's
// first await, so a recorder sees the payload in the same tick.
function trainState() {
    var img = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    return { store: 'OVL', i: 0, picks: new Set(), busy: false, err: null, skipped: 0, total: 3, done: 0, left: 3,
             queue: [1, 2, 3].map(function (n) {
                 return { productId: 'gid://shopify/Product/9', sku: 'KS01-1', title: 'PS3 Controller', n: n, of: 3,
                          src: 'https://cdn/x' + n + '.jpg', img: img, w: 1080, h: 1080, sheet: 'game-controllers',
                          sheetName: 'Game Controllers', shot: n === 3 ? null : 'Front of Controller', said: [],
                          example: n === 1 ? img : null };
             }) };
}

t('train: the entry button sits under the Picture Quality section', function () {
    _pqData = data([FIX]); _pqTier = 'fix';
    var host = document.getElementById('pq-host');
    host.innerHTML = '<div class="cb-panel">' + _pqHtml() + '</div>';
    return !!host.querySelector('.pqt-entry button[onclick="pqTrainOpen()"]') || 'no Train The Checker button';
});

t('train: photo beside its guide example, answers with their keys', function () {
    _pqTrain = trainState(); _pqTrainRender();
    var el = document.getElementById('pqTrainOverlay');
    try {
        var figs = el.querySelectorAll('.pqt-fig');
        if (figs.length !== 2) return 'expected photo + example, got ' + figs.length;
        if (!figs[1].querySelector('img')) return 'the guide example is not shown';
        if (!/Front of Controller/.test(figs[1].textContent)) return 'the shot is not named';
        var keys = [].map.call(el.querySelectorAll('.pqt-acts kbd'), function (k) { return k.textContent; }).join(',');
        return keys === '1,2,3,4,5,6,7,8,9,Enter,0' || 'keys: ' + keys;
    } finally { pqTrainClose(); }
});

t('train: Save Problems needs a pick, and sends exactly the picks for this photo', function () {
    var sent = [], real = _pqPost;
    _pqPost = function (p) { sent.push(p); return new Promise(function () {}); };   // never settles: no network
    try {
        _pqTrain = trainState(); _pqTrainRender();
        document.addEventListener('keydown', _pqTrainKey);
        var key = function (k) { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); };
        key('Enter');
        if (sent.length) return 'Save Problems sent with nothing picked';
        key('2'); key('3'); key('3');   // off-centre on, crooked on then off again
        if ([..._pqTrain.picks].join() !== 'off_center') return 'picks: ' + [..._pqTrain.picks].join();
        key('Enter');
        var p = sent[0];
        if (!p || p.action !== 'label' || p.label !== 'problem' || p.problems.join() !== 'off_center') return 'sent: ' + JSON.stringify(p);
        if (p.src !== 'https://cdn/x1.jpg' || p.shot !== 'Front of Controller' || p.store !== 'OVL') return 'wrong photo: ' + JSON.stringify(p);
        return true;
    } finally { _pqPost = real; pqTrainClose(); }
});

t('train: a photo with no matched shot says so instead of showing a wrong example', function () {
    _pqTrain = trainState(); _pqTrain.i = 2; _pqTrainRender();
    try {
        var f = document.querySelectorAll('#pqTrainOverlay .pqt-fig')[1];
        return (!f.querySelector('img') && /Not matched to a guide shot/.test(f.textContent)) || 'shown: ' + f.textContent.trim();
    } finally { pqTrainClose(); }
});

t('train @390px: the trainer fits a phone, and the photo frame is square', function () {
    // The overlay is position:fixed, so it is the overlay that gets narrowed —
    // the body's width does not reach it.
    _pqTrain = trainState(); _pqTrainRender();
    var ov = document.getElementById('pqTrainOverlay');
    ov.style.width = '390px'; ov.style.right = 'auto';
    try {
        var box = document.querySelector('#pqTrainOverlay .pqt-box').getBoundingClientRect();
        if (box.right > 390 + 1) return 'box ends at ' + Math.round(box.right) + 'px';
        var fr = document.querySelector('#pqTrainOverlay .pqt-frame').getBoundingClientRect();
        return Math.abs(fr.width - fr.height) <= 2 || 'frame ' + Math.round(fr.width) + '×' + Math.round(fr.height);
    } finally { pqTrainClose(); }
});

t('a dirty table is one line for the listing, and outlines every photo it names', function () {
    var row = Object.assign({}, FIX, { stale: false, findings: [{ code: 'dirty_backdrop', photos: [1, 2],
        text: 'The table or backdrop is dirty in photos 1, 2 — clean it, then retake.' }] });
    _pqData = data([row]); _pqTier = 'fix';
    var host = document.getElementById('pq-host');
    host.innerHTML = '<div class="cb-panel">' + _pqHtml() + '</div>';
    var lines = host.querySelectorAll('.lt-why li');
    if (lines.length !== 1 || !/dirty in photos 1, 2/.test(lines[0].textContent)) return 'lines: ' + [].map.call(lines, function (l) { return l.textContent; }).join(' | ');
    var marked = host.querySelectorAll('.pq-ph-flag').length;
    return marked >= 2 || 'only ' + marked + ' photos outlined';
});

t('a flagged row never shows its score — every fix is listed, not enough to pass', function () {
    // Ethan, 2026-10-08: "the user should make all required fixes, not just enough
    // to bring them above 90 … we probably shouldn't show the score".
    var row = Object.assign({}, FIX, { stale: false, pictureScore: 84, findings: [
        { code: 'reflection', photos: [2, 3], text: 'A reflection shows on the item in photos 2, 3 — angle the item or the light, then retake.' },
        { code: 'framing', photo: 5, text: "Photo 5 isn't to the guide's standard: not centred." }] });
    _pqData = data([row]); _pqTier = 'fix';
    var host = document.getElementById('pq-host');
    host.innerHTML = '<div class="cb-panel">' + _pqHtml() + '</div>';
    var txt = host.querySelector('.pq-row').textContent;
    if (/\b84\b|score/i.test(txt)) return 'the score is on the row';
    return host.querySelectorAll('.lt-why li').length === 2 || 'not every finding is listed';
});
