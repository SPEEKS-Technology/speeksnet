// LIVE DASHBOARD activity chips — the item-title header.
//
//   powershell -File scripts/browser-check.ps1 lv-chip-check.js
//
// Two halves. The markup half asserts about what _lvChipHtml / _lvChipTip return.
// The layout half mounts real chips with the real stylesheet and MEASURES, because
// the one promise the header makes — it never makes a chip wider than it was —
// is invisible to a string assertion.

var LONG = 'Apple iPhone 13 Pro Max 256GB Unlocked - Graphite - Good Condition - '
    + 'Includes Original Box, Charger and Case';
var SALE = { id: 'x1', kind: 'sale', code: 'OVL', amount: 812.4, at: '2026-10-14T19:14:00Z' };
function sale(items) { return Object.assign({}, SALE, { items: items }); }
function frag(html) { var d = document.createElement('div'); d.innerHTML = html; return d; }

// ---- markup ---------------------------------------------------------------

t('the line is Sale · store · amount · time; the dot comes after the text', function () {
    var d = frag(_lvChipHtml(sale([])));
    if (d.querySelector('.lv-ahead')) return 'header rendered with no items';
    var line = d.querySelector('.lv-abody .lv-aline');
    if (!line) return 'no .lv-aline in the body';
    if (line.querySelector('.lv-adot')) return 'dot is inside the line';
    var last = d.lastElementChild;
    if (!last || !last.classList.contains('lv-adot')) return 'dot is not the last thing in the chip';
    return /^Sale · OVL · \$812\.40 · /.test(line.textContent) || 'line text: ' + line.textContent;
});

t('refund chip says Refund in the line', function () {
    var e = sale([]); e.kind = 'refund';
    var line = frag(_lvChipHtml(e)).querySelector('.lv-aline');
    return /^Refund · OVL/.test(line.textContent) || 'line text: ' + line.textContent;
});

t('payload from before titles (no items key) renders without a header', function () {
    var e = Object.assign({}, SALE); delete e.items;
    return !frag(_lvChipHtml(e)).querySelector('.lv-ahead') || 'header rendered';
});

t('one item: title, no "+N more"', function () {
    var d = frag(_lvChipHtml(sale([{ title: 'AirPods Pro', qty: 1 }])));
    var name = d.querySelector('.lv-ahead .lv-aname');
    if (!name || name.textContent !== 'AirPods Pro') return 'name: ' + (name && name.textContent);
    return !d.querySelector('.lv-amore') || '"+N more" on a one-item order';
});

t('three items: first title and "+2 more"', function () {
    var d = frag(_lvChipHtml(sale([{ title: 'A', qty: 1 }, { title: 'B', qty: 1 }, { title: 'C', qty: 2 }])));
    if (d.querySelector('.lv-aname').textContent !== 'A') return 'wrong first title';
    var more = d.querySelector('.lv-amore');
    return (more && more.textContent === '+2 more') || 'more: ' + (more && more.textContent);
});

t('refund with items gets a header and a "refunded" tooltip', function () {
    var e = sale([{ title: 'A', qty: 1 }, { title: 'B', qty: 1 }]); e.kind = 'refund';
    var name = frag(_lvChipHtml(e)).querySelector('.lv-ahead .lv-aname');
    if (!name || name.textContent !== 'A') return 'refund header: ' + (name && name.textContent);
    return /2 items refunded/.test(_lvChipTip(e) || '') || 'tip: ' + _lvChipTip(e);
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

t('titles are escaped in the chip', function () {
    var d = frag(_lvChipHtml(sale([{ title: '<img src=x onerror=alert(1)>', qty: 1 }])));
    if (d.querySelector('img')) return 'title injected an element';
    return d.querySelector('.lv-aname').textContent === '<img src=x onerror=alert(1)>' || 'text mangled';
});

t('titles are escaped in the tooltip HTML', function () {
    var tip = _lvChipTip(sale([{ title: '<b onmouseover=x>Hi</b>', qty: 1 }]));
    return frag(tip).querySelector('b') === null || 'tooltip injected an element: ' + tip;
});

t('tooltip: one item is the bare title', function () {
    var tip = _lvChipTip(sale([{ title: 'AirPods Pro', qty: 1 }]));
    return tip === 'AirPods Pro' || tip;
});

t('tooltip: several items are counted and listed, with quantities', function () {
    var tip = _lvChipTip(sale([{ title: 'Cable', qty: 3 }, { title: 'Phone', qty: 1 }]));
    var txt = frag(tip).innerText;
    if (!/^2 items/.test(txt)) return 'no count: ' + txt;
    if (!/3 × Cable/.test(txt)) return 'no qty: ' + txt;
    return /Phone/.test(txt) || 'missing item: ' + txt;
});

t('tooltip: none without items', function () {
    return _lvChipTip(sale([])) === null || 'tooltip on an itemless chip';
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

t('_lvSyncActivity tags the chip and sets its tooltip', function () {
    var host = document.createElement('div');
    host.innerHTML = '<div class="lv-activity-row"></div>';
    document.body.appendChild(host);
    var saved = { ev: _lvEvents, data: _lvData };
    try {
        _lvData = null;   // no scope -> ticker mode, no seeding
        _lvEvents = [Object.assign(sale([{ title: 'A', qty: 1 }, { title: 'B', qty: 1 }]), { ts: Date.now() })];
        _lvSyncActivity();
        var chip = host.querySelector('.lv-activity');
        if (!chip) return 'no chip rendered';
        if (!chip.classList.contains('has-items')) return 'no has-items class';
        return /2 items/.test(chip.getAttribute('data-tip') || '') || 'data-tip: ' + chip.getAttribute('data-tip');
    } finally {
        if (_lvActTimer) { clearTimeout(_lvActTimer); _lvActTimer = null; }
        _lvEvents = saved.ev; _lvData = saved.data;
        host.remove();
    }
});

// ---- layout ---------------------------------------------------------------

// A row of chips at a known width. offsetWidth, not getBoundingClientRect: the
// chip's entrance animation scales it, and a transform must not count as width.
function chips(width, events) {
    var host = document.getElementById('lv-host');
    if (!host) { host = document.createElement('div'); host.id = 'lv-host'; document.body.appendChild(host); }
    host.style.cssText = 'width:' + width + 'px;';
    host.innerHTML = '<div class="lv-activity-row">' + events.map(function (e) {
        return '<div class="lv-activity' + (e.kind === 'refund' ? ' refund' : '')
            + (_lvChipTip(e) ? ' has-items' : '') + '" style="animation:none">'
            + _lvChipHtml(e) + '</div>';
    }).join('') + '</div>';
    void host.offsetHeight;
    return Array.prototype.slice.call(host.querySelectorAll('.lv-activity'));
}

[390, 820, 1440].forEach(function (w) {
    t('@' + w + ': a long title does not widen the chip', function () {
        var c = chips(w, [sale([]), sale([{ title: LONG, qty: 1 }, { title: 'B', qty: 1 }, { title: 'C', qty: 1 }])]);
        var bare = c[0].offsetWidth, titled = c[1].offsetWidth;
        return Math.abs(bare - titled) <= 1 || 'bare ' + bare + 'px, titled ' + titled + 'px';
    });

    t('@' + w + ': the title is cut off, "+2 more" is whole and inside the chip', function () {
        var c = chips(w, [sale([{ title: LONG, qty: 1 }, { title: 'B', qty: 1 }, { title: 'C', qty: 1 }])])[0];
        var name = c.querySelector('.lv-aname'), more = c.querySelector('.lv-amore');
        if (!(name.scrollWidth > name.clientWidth)) return 'title not truncated';
        // Faded, not "…": an ellipsis on nearly every chip read as clutter.
        var cs = getComputedStyle(name);
        if (cs.textOverflow === 'ellipsis') return 'ellipsis is back';
        if (!/gradient/.test(cs.webkitMaskImage || cs.maskImage || '')) return 'no fade mask';
        if (more.scrollWidth > more.clientWidth) return '"+2 more" clipped';
        var cr = c.getBoundingClientRect(), mr = more.getBoundingClientRect();
        return mr.right <= cr.right + 0.5 || '"+2 more" overflows the chip by ' + (mr.right - cr.right) + 'px';
    });
});

t('the title starts where "Sale" does', function () {
    var c = chips(1440, [sale([{ title: 'AirPods Pro', qty: 1 }])])[0];
    var name = c.querySelector('.lv-aname').getBoundingClientRect().left;
    var line = c.querySelector('.lv-aline').getBoundingClientRect().left;
    return Math.abs(name - line) <= 1 || 'title at ' + name + ', Sale at ' + line;
});

t('the dot sits centred on the right of a two-line chip', function () {
    var c = chips(1440, [sale([{ title: 'AirPods Pro', qty: 1 }])])[0];
    var cr = c.getBoundingClientRect(), dr = c.querySelector('.lv-adot').getBoundingClientRect();
    var br = c.querySelector('.lv-abody').getBoundingClientRect();
    if (!(dr.left >= br.right)) return 'dot is not right of the text';
    if (cr.right - dr.right > 14) return 'dot is ' + (cr.right - dr.right) + 'px from the right edge';
    var mid = (cr.top + cr.bottom) / 2, dmid = (dr.top + dr.bottom) / 2;
    return Math.abs(mid - dmid) <= 1.5 || 'dot centre ' + dmid + ' vs chip centre ' + mid;
});

t('a refund chip with items is the same height as a sale chip', function () {
    var r = sale([{ title: 'Returned thing', qty: 1 }]); r.kind = 'refund';
    var c = chips(1440, [sale([{ title: 'AirPods Pro', qty: 1 }]), r]);
    return c[0].offsetHeight === c[1].offsetHeight || c[0].offsetHeight + ' vs ' + c[1].offsetHeight;
});

t('a short title is not faded', function () {
    var c = chips(1440, [sale([{ title: 'iPad', qty: 1 }])])[0];
    var name = c.querySelector('.lv-aname');
    var r = document.createRange(); r.selectNodeContents(name);
    var textRight = r.getBoundingClientRect().right, boxRight = name.getBoundingClientRect().right;
    return boxRight - textRight >= 16 || 'text ends ' + (boxRight - textRight) + 'px from the fade edge';
});

t('the Sale lines share a bottom edge in a mixed row', function () {
    var c = chips(1440, [sale([]), sale([{ title: 'AirPods Pro', qty: 1 }])]);
    var a = c[0].getBoundingClientRect().bottom, b = c[1].getBoundingClientRect().bottom;
    if (!(c[1].offsetHeight > c[0].offsetHeight)) return 'titled chip is not taller';
    return Math.abs(a - b) <= 1 || 'bottoms ' + a + ' vs ' + b;
});
