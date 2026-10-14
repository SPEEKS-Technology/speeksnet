// LIVE DASHBOARD activity cards — sale and refund, with what sold.
//
//   powershell -File scripts/browser-check.ps1 lv-chip-check.js
//
// Two halves. The markup half asserts about what _lvChipHtml / _lvChipTip return.
// The layout half mounts real cards with the real stylesheet and MEASURES, because
// the promises the strip makes — one row of even cards, never wrapped, never
// scrolled, the overflow simply not shown — are invisible to a string assertion.

var LONG = 'Apple iPhone 13 Pro Max 256GB Unlocked - Graphite - Good Condition - '
    + 'Includes Original Box, Charger and Case';
var SALE = { id: 'x1', kind: 'sale', code: 'OVL', amount: 812.4, at: '2026-10-14T19:14:00Z' };
function sale(items) { return Object.assign({}, SALE, { items: items }); }
function refund(items) { return Object.assign(sale(items), { kind: 'refund' }); }
function frag(html) { var d = document.createElement('div'); d.innerHTML = html; return d; }

// ---- markup ---------------------------------------------------------------

t('dot first; line 1 is title + amount, line 2 is Sale · store · time', function () {
    var d = frag(_lvChipHtml(sale([{ title: 'AirPods Pro', qty: 1 }])));
    var first = d.firstElementChild;
    if (!first || !first.classList.contains('lv-adot')) return 'dot is not the first thing in the card';
    var top = d.querySelector('.lv-abody .lv-atop');
    if (!top) return 'no top line';
    if (top.querySelector('.lv-aname').textContent !== 'AirPods Pro') return 'name: ' + top.textContent;
    var amt = top.querySelector('.lv-aamt');
    if (!amt || amt.textContent !== '$812.40') return 'amount: ' + (amt && amt.textContent);
    var meta = d.querySelector('.lv-abody .lv-ameta');
    return /^Sale · OVL · /.test(meta && meta.textContent) || 'meta: ' + (meta && meta.textContent);
});

t('refund: Refund in the meta line, amount reads as money out', function () {
    var d = frag(_lvChipHtml(refund([{ title: 'Returned thing', qty: 1 }])));
    var meta = d.querySelector('.lv-ameta').textContent;
    if (!/^Refund · OVL/.test(meta)) return 'meta: ' + meta;
    var amt = d.querySelector('.lv-aamt').textContent;
    return amt === '−$812.40' || 'amount: ' + amt;
});

t('no items: the word Sale stands in for the title', function () {
    var d = frag(_lvChipHtml(sale([])));
    return d.querySelector('.lv-aname').textContent === 'Sale' || 'name: ' + d.querySelector('.lv-aname').textContent;
});

t('payload from before titles (no items key) still renders a whole card', function () {
    var e = Object.assign({}, SALE); delete e.items;
    var d = frag(_lvChipHtml(e));
    return (d.querySelector('.lv-aname').textContent === 'Sale' && !!d.querySelector('.lv-aamt')) || d.innerHTML;
});

t('no amount: no empty amount slot', function () {
    var e = sale([{ title: 'A', qty: 1 }]); e.amount = 0;
    return !frag(_lvChipHtml(e)).querySelector('.lv-aamt') || 'amount rendered for zero';
});

t('one item: title, no "+N more"', function () {
    var d = frag(_lvChipHtml(sale([{ title: 'AirPods Pro', qty: 1 }])));
    return !d.querySelector('.lv-amore') || '"+N more" on a one-item order';
});

t('three items: first title and "+2 more"', function () {
    var d = frag(_lvChipHtml(sale([{ title: 'A', qty: 1 }, { title: 'B', qty: 1 }, { title: 'C', qty: 2 }])));
    if (d.querySelector('.lv-aname').textContent !== 'A') return 'wrong first title';
    var more = d.querySelector('.lv-amore');
    return (more && more.textContent === '+2 more') || 'more: ' + (more && more.textContent);
});

t('refund with items: titled, and the tooltip says Refund', function () {
    var e = refund([{ title: 'A', qty: 1 }, { title: 'B', qty: 1 }]);
    if (frag(_lvChipHtml(e)).querySelector('.lv-aname').textContent !== 'A') return 'refund title missing';
    return /^Refund at .* · 2 items/.test(frag(_lvChipTip(e) || '').innerText) || 'tip: ' + _lvChipTip(e);
});

t('meta line says how long ago, from a timestamp it carries', function () {
    var e = sale([{ title: 'A', qty: 1 }]); e.at = new Date(Date.now() - 4 * 60000 - 5000).toISOString();
    var ago = frag(_lvChipHtml(e)).querySelector('.lv-ameta .lv-ago');
    if (!ago) return 'no .lv-ago';
    if (ago.getAttribute('data-at') !== e.at) return 'data-at: ' + ago.getAttribute('data-at');
    return ago.textContent === '4m ago' || 'ago: ' + ago.textContent;
});

t('_lvAgo: just now, minutes, hours and minutes, then whole hours', function () {
    var now = Date.parse('2026-10-14T20:00:00Z');
    var at = function (min) { return new Date(now - min * 60000).toISOString(); };
    var got = [_lvAgo(at(0.5), now), _lvAgo(at(-2), now), _lvAgo(at(4), now), _lvAgo(at(59), now),
               _lvAgo(at(72), now), _lvAgo(at(9 * 60 + 59), now), _lvAgo(at(11 * 60 + 5), now), _lvAgo('nope', now)];
    var want = ['just now', 'just now', '4m ago', '59m ago', '1h 12m ago', '9h 59m ago', '11h ago', ''];
    return JSON.stringify(got) === JSON.stringify(want) || JSON.stringify(got);
});

t('_lvRefreshAgo rewrites an aged card in place', function () {
    var host = document.createElement('div');
    host.innerHTML = '<span class="lv-ago" data-at="' + new Date(Date.now() - 125 * 60000).toISOString() + '">just now</span>';
    document.body.appendChild(host);
    try {
        _lvRefreshAgo();
        var txt = host.querySelector('.lv-ago').textContent;
        return txt === '2h 5m ago' || 'after refresh: ' + txt;
    } finally { host.remove(); }
});

t('header: Recent activity on the Selling caption, outside the row', function () {
    var d = frag(_lvActivity());
    var wrap = d.querySelector('.lv-activity-wrap');
    if (!wrap) return 'no wrap';
    var h = wrap.querySelector('.lv-split.lv-act-h .lv-split-l');
    if (!h || h.textContent !== 'Recent activity') return 'label: ' + (h && h.textContent);
    if (!wrap.querySelector('.lv-act-h .lv-live')) return 'no LIVE badge';
    var row = wrap.querySelector('.lv-activity-row');
    if (!row || row.children.length) return 'row missing or not empty';
    return !row.contains(wrap.querySelector('.lv-act-h')) || 'header is inside the row, which _lvSyncActivity empties';
});

t('_lvNewRefund hands out the newest unseen refund once', function () {
    var m = { recentRefunds: [{ at: 'T-new-9', amount: 5, items: [{ title: 'X', qty: 1 }] },
                              { at: 'T-old-9', amount: 3, items: [] }] };
    var a = _lvNewRefund(m), b = _lvNewRefund(m), c = _lvNewRefund(m);
    _lvRefundsShown.delete('T-new-9'); _lvRefundsShown.delete('T-old-9');
    if (!a || a.at !== 'T-new-9') return 'first: ' + (a && a.at);
    if (!b || b.at !== 'T-old-9') return 'second: ' + (b && b.at);
    return c === null || 'third should be null, got ' + c.at;
});

t('seeding a store dashboard includes today\'s refunds, with titles', function () {
    var saved = _lvEvents;
    try {
        _lvSeedEvents({ scope: { role: 'manager', store: 'OVL' }, stores: [{ code: 'OVL',
            recentOrders: [{ at: '2026-10-14T18:00:00Z', amount: 10, items: [{ title: 'S', qty: 1 }] }],
            recentRefunds: [{ at: '2026-10-14T18:30:00Z', amount: 4, items: [{ title: 'R', qty: 1 }] }] }] });
        var r = _lvEvents.find(function (e) { return e.kind === 'refund'; });
        if (!r) return 'no refund seeded';
        if (_lvEvents[0] !== r) return 'refund (newer) is not first';
        if (!_lvRefundsShown.has('2026-10-14T18:30:00Z')) return 'seeded refund not marked shown';
        return (r.items[0] && r.items[0].title === 'R') || 'refund items: ' + JSON.stringify(r.items);
    } finally {
        _lvEvents = saved; _lvRefundsShown.delete('2026-10-14T18:30:00Z');
    }
});

t('titles are escaped in the card', function () {
    var d = frag(_lvChipHtml(sale([{ title: '<img src=x onerror=alert(1)>', qty: 1 }])));
    if (d.querySelector('img')) return 'title injected an element';
    return d.querySelector('.lv-aname').textContent === '<img src=x onerror=alert(1)>' || 'text mangled';
});

t('titles are escaped in the tooltip HTML', function () {
    var tip = _lvChipTip(sale([{ title: '<b onmouseover=x>Hi</b>', qty: 1 }]));
    var d = frag(tip);
    if (d.querySelector('[onmouseover]')) return 'tooltip injected an element: ' + tip;
    return d.innerText.indexOf('<b onmouseover=x>Hi</b>') >= 0 || 'title text mangled: ' + d.innerText;
});

t('tooltip: one item is the exact time, then the title', function () {
    var e = sale([{ title: 'AirPods Pro', qty: 1 }]);
    var tip = _lvChipTip(e);
    return tip === '<b>Sale at ' + _lvOrderClock(e.at) + '</b><br>AirPods Pro' || tip;
});

t('tooltip: several items are counted and listed, with quantities', function () {
    var tip = _lvChipTip(sale([{ title: 'Cable', qty: 3 }, { title: 'Phone', qty: 1 }]));
    var txt = frag(tip).innerText;
    if (!/^Sale at .* · 2 items/.test(txt)) return 'no count: ' + txt;
    if (!/3 × Cable/.test(txt)) return 'no qty: ' + txt;
    return /Phone/.test(txt) || 'missing item: ' + txt;
});

t('tooltip: no items still gives the exact time; no time and no items gives none', function () {
    var a = _lvChipTip(sale([]));
    if (!a || !/^<b>Sale at /.test(a)) return 'itemless tip: ' + a;
    var e = sale([]); delete e.at;
    return _lvChipTip(e) === null || 'tip with nothing to say: ' + _lvChipTip(e);
});

t('_lvItems drops blanks and defaults qty', function () {
    var out = _lvItems({ items: [{ title: '' }, null, { title: 'X' }, { title: 'Y', qty: 2 }] });
    return JSON.stringify(out) === '[{"title":"X","qty":1},{"title":"Y","qty":2}]' || JSON.stringify(out);
});

t('_lvItems tolerates a missing order', function () {
    return _lvItems(null).length === 0 && _lvItems({}).length === 0 || 'threw or returned items';
});

t('_lvRecentOrder finds the order by its timestamp', function () {
    var m = { recentOrders: [{ at: 'a', amount: 1 }, { at: 'b', amount: 2, items: [] }] };
    var hit = _lvRecentOrder(m, 'b');
    if (!hit || hit.amount !== 2) return 'wrong hit';
    return _lvRecentOrder(m, 'zz') === null && _lvRecentOrder(null, 'b') === null || 'miss not null';
});

t('_lvSyncActivity tags the card and sets its tooltip', function () {
    var host = document.createElement('div');
    host.innerHTML = '<div class="lv-activity-row"></div>';
    document.body.appendChild(host);
    var saved = { ev: _lvEvents, data: _lvData };
    try {
        _lvData = null;   // no scope -> ticker mode, no seeding
        _lvEvents = [Object.assign(sale([{ title: 'A', qty: 1 }, { title: 'B', qty: 1 }]), { ts: Date.now() })];
        _lvSyncActivity();
        var card = host.querySelector('.lv-activity');
        if (!card) return 'no card rendered';
        if (!card.classList.contains('has-items')) return 'no has-items class';
        return /2 items/.test(card.getAttribute('data-tip') || '') || 'data-tip: ' + card.getAttribute('data-tip');
    } finally {
        if (_lvActTimer) { clearTimeout(_lvActTimer); _lvActTimer = null; }
        _lvEvents = saved.ev; _lvData = saved.data;
        host.remove();
    }
});

t('never more than 7 cards: seeding keeps 7, and the ticker draws at most 7', function () {
    var saved = { ev: _lvEvents, data: _lvData };
    var host = document.createElement('div');
    host.innerHTML = '<div class="lv-activity-row"></div>';
    document.body.appendChild(host);
    try {
        var orders = [];
        for (var i = 0; i < 9; i++) orders.push({ at: '2026-10-14T1' + i + ':00:00Z', amount: 10 + i, items: [{ title: 'T' + i, qty: 1 }] });
        _lvSeedEvents({ scope: { role: 'manager', store: 'OVL' }, stores: [{ code: 'OVL', recentOrders: orders }] });
        if (_lvEvents.length !== 7) return 'seeded ' + _lvEvents.length;
        _lvData = null;   // ticker mode
        _lvEvents = [];
        for (var j = 0; j < 9; j++) _lvPush(Object.assign(sale([{ title: 'P' + j, qty: 1 }]), { id: null }));
        _lvSyncActivity();
        var n = host.querySelectorAll('.lv-activity').length;
        return n === 7 || 'ticker drew ' + n;
    } finally {
        if (_lvActTimer) { clearTimeout(_lvActTimer); _lvActTimer = null; }
        _lvEvents = saved.ev; _lvData = saved.data;
        host.remove();
    }
});

t('LIVE shows only while open on today\'s view; the header hides with an empty row', function () {
    var saved = { ev: _lvEvents, data: _lvData, mode: _lvMode };
    var host = document.createElement('div');
    host.innerHTML = _lvActivity();
    document.body.appendChild(host);
    var wrap = host.querySelector('.lv-activity-wrap');
    var live = function () { return getComputedStyle(wrap.querySelector('.lv-live')).display !== 'none'; };
    try {
        _lvEvents = [];
        _lvData = { open: true, stores: [] };
        _lvSyncActivity();
        if (getComputedStyle(wrap).display !== 'none') return 'header shows over an empty row';
        _lvEvents = [Object.assign(sale([{ title: 'A', qty: 1 }]), { ts: Date.now() })];
        _lvSyncActivity();
        if (getComputedStyle(wrap).display === 'none') return 'header hidden with a card in the row';
        if (!live()) return 'no LIVE while open';
        _lvData = { open: false, stores: [] };
        _lvSyncActivity();
        if (live()) return 'LIVE while closed';
        _lvData = { open: true, stores: [] }; _lvMode = 'prev';
        _lvSyncActivity();
        return !live() || 'LIVE on the Yesterday view';
    } finally {
        if (_lvActTimer) { clearTimeout(_lvActTimer); _lvActTimer = null; }
        _lvEvents = saved.ev; _lvData = saved.data; _lvMode = saved.mode;
        host.remove();
    }
});

// ---- layout ---------------------------------------------------------------

// A strip of cards at a known width, built the way _lvSyncActivity builds them.
// Animation off: it is opacity-only now, but a measurement should never depend
// on where a card is in its fade.
function cards(width, events) {
    var host = document.getElementById('lv-host');
    if (!host) { host = document.createElement('div'); host.id = 'lv-host'; document.body.appendChild(host); }
    host.style.cssText = 'width:' + width + 'px;';
    host.innerHTML = '<div class="lv-activity-row">' + events.map(function (e) {
        return '<div class="lv-activity' + (e.kind === 'refund' ? ' refund' : '')
            + (_lvChipTip(e) ? ' has-items' : '') + '" style="animation:none">'
            + _lvChipHtml(e) + '</div>';
    }).join('') + '</div>';
    void host.offsetHeight;
    var row = host.querySelector('.lv-activity-row');
    var all = Array.prototype.slice.call(row.children);
    var rb = row.getBoundingClientRect();
    // Shown = sits inside the row's box. A card clipped away by the row lands in
    // a zero-height implicit row, at or below the row's bottom edge.
    var shown = all.filter(function (c) { return c.getBoundingClientRect().top < rb.bottom - 1; });
    return { row: row, all: all, shown: shown };
}
function five() {
    return [sale([{ title: LONG, qty: 1 }, { title: 'B', qty: 1 }, { title: 'C', qty: 1 }]),
            refund([{ title: 'Returned graphics card', qty: 1 }]),
            sale([{ title: 'iPad', qty: 1 }]), sale([]), sale([{ title: 'Nintendo Switch OLED', qty: 1 }])];
}

[390, 820, 1100, 1440].forEach(function (w) {
    t('@' + w + ': one row only — no wrap, no scroll', function () {
        var s = cards(w, five());
        if (!s.shown.length) return 'no card shown at all';
        var top = s.shown[0].getBoundingClientRect().top;
        var off = s.shown.filter(function (c) { return Math.abs(c.getBoundingClientRect().top - top) > 0.5; });
        if (off.length) return off.length + ' shown card(s) on another line';
        if (s.row.scrollWidth > s.row.clientWidth + 1) return 'row scrolls sideways: ' + s.row.scrollWidth + ' > ' + s.row.clientWidth;
        var h = s.row.getBoundingClientRect().height, ch = s.shown[0].getBoundingClientRect().height;
        return Math.abs(h - ch) <= 0.5 || 'row is ' + h + 'px tall for ' + ch + 'px cards: a second row is showing';
    });

    t('@' + w + ': what is shown is the newest, and every shown card is the same width', function () {
        var s = cards(w, five());
        for (var i = 0; i < s.shown.length; i++) if (s.shown[i] !== s.all[i]) return 'card ' + i + ' shown out of order';
        var widths = s.shown.map(function (c) { return c.offsetWidth; });
        var even = widths.every(function (x) { return Math.abs(x - widths[0]) <= 1; });
        return even || 'widths ' + widths.join(', ');
    });

    t('@' + w + ': a long title is cut with a fade; "+2 more" and the amount stay whole inside', function () {
        var c = cards(w, five()).shown[0];
        var name = c.querySelector('.lv-aname'), more = c.querySelector('.lv-amore'), amt = c.querySelector('.lv-aamt');
        if (!(name.scrollWidth > name.clientWidth)) return 'title not truncated';
        var cs = getComputedStyle(name);
        if (cs.textOverflow === 'ellipsis') return 'ellipsis is back';
        if (!/gradient/.test(cs.webkitMaskImage || cs.maskImage || '')) return 'no fade mask';
        if (more.scrollWidth > more.clientWidth) return '"+2 more" clipped';
        if (amt.scrollWidth > amt.clientWidth) return 'amount clipped';
        var cr = c.getBoundingClientRect(), ar = amt.getBoundingClientRect();
        return ar.right <= cr.right + 0.5 || 'amount overflows the card by ' + (ar.right - cr.right) + 'px';
    });
});

// The bug the first version shipped to a preview with: hidden cards squeezed to
// 14px spilled their centred content back up into the shown row. Asserts on the
// CONTENT of every hidden card, not its box — the box was below the edge all along.
[390, 820, 1100].forEach(function (w) {
    t('@' + w + ': nothing of a hidden card shows inside the row', function () {
        var s = cards(w, five());
        var rb = s.row.getBoundingClientRect();
        var leaks = [];
        s.all.filter(function (c) { return s.shown.indexOf(c) < 0; }).forEach(function (c, i) {
            Array.prototype.forEach.call(c.querySelectorAll('*'), function (el) {
                var r = el.getBoundingClientRect();
                if (r.height && r.top < rb.bottom - 0.5) leaks.push('hidden card ' + i + ' ' + el.className + ' at ' + r.top.toFixed(1));
            });
        });
        return !leaks.length || leaks.slice(0, 3).join('; ') + ' (row ends ' + rb.bottom.toFixed(1) + ')';
    });
});

t('@1440 all five fit; @820 the two oldest are not shown; @390 only the newest', function () {
    var a = cards(1440, five()).shown.length, b = cards(820, five()).shown.length, c = cards(390, five()).shown.length;
    return (a === 5 && b === 3 && c === 1) || 'shown: 1440=' + a + ' 820=' + b + ' 390=' + c;
});

t('two cards on a wide screen stay card-sized, not stretched across', function () {
    var s = cards(1440, [sale([{ title: 'A', qty: 1 }]), sale([{ title: 'B', qty: 1 }])]);
    return s.shown[0].offsetWidth < 300 || 'card is ' + s.shown[0].offsetWidth + 'px wide';
});

t('the dot sits centred on the left of the card', function () {
    var c = cards(1440, [sale([{ title: 'AirPods Pro', qty: 1 }])]).shown[0];
    var cr = c.getBoundingClientRect(), dr = c.querySelector('.lv-adot').getBoundingClientRect();
    var br = c.querySelector('.lv-abody').getBoundingClientRect();
    if (!(dr.right <= br.left)) return 'dot is not left of the text';
    if (dr.left - cr.left > 14) return 'dot is ' + (dr.left - cr.left) + 'px from the left edge';
    var mid = (cr.top + cr.bottom) / 2, dmid = (dr.top + dr.bottom) / 2;
    return Math.abs(mid - dmid) <= 1.5 || 'dot centre ' + dmid + ' vs card centre ' + mid;
});

t('sale, refund and untitled cards are all the same height', function () {
    var s = cards(1440, [sale([{ title: 'AirPods Pro', qty: 1 }]), refund([{ title: 'X', qty: 1 }]), sale([])]);
    var h = s.shown.map(function (c) { return c.offsetHeight; });
    return (h[0] === h[1] && h[1] === h[2]) || 'heights ' + h.join(', ');
});

t('a short title is not faded', function () {
    var c = cards(1440, [sale([{ title: 'iPad', qty: 1 }])]).shown[0];
    var name = c.querySelector('.lv-aname');
    var r = document.createRange(); r.selectNodeContents(name);
    var textRight = r.getBoundingClientRect().right, boxRight = name.getBoundingClientRect().right;
    return boxRight - textRight >= 16 || 'text ends ' + (boxRight - textRight) + 'px from the fade edge';
});
