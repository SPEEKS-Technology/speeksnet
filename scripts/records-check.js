// ===========================================================================
// RECORDS TAB — store headline, company-wide section, and the Records tool
//
//   powershell -File scripts/browser-check.ps1 records-check.js
//
// 0117 split the Company row's meaning. It used to copy the top store's number
// (and sat as the card headline with the holder looked up by value); it is now
// the whole company summed, kept by records-watch. So:
//   - the headline must be the top STORE, never the Company row
//   - Company rows render in their own section, and only once they hold a value
//   - the tool shows the Company column read-only and never posts it — the old
//     tool mirrored the top store into it on save, which would now overwrite the
//     district total
// The layout half measures the company tiles at phone, tablet and desktop
// content widths, because a row of six money figures is exactly what wraps or
// clips at 390px.
// ===========================================================================

if (typeof _b2bSend === 'function') { _b2bSend = function () { return Promise.resolve({}); }; }

var REC_FIXTURE = [
    { section: 'OVL', label: 'Daily Buy Record', value: '$21,950.00', subtext: 'March 13, 2026' },
    { section: 'LEE', label: 'Daily Buy Record', value: '$18,086.00', subtext: 'October 2025' },
    { section: 'MPL', label: 'Daily Buy Record', value: '$13,617.00', subtext: 'June 24, 2026' },
    { section: 'Company', label: 'Daily Buy Record', value: '$38,519.00', subtext: 'August 24, 2026' },
    // A tie: both stores are named on the headline.
    { section: 'MPL', label: 'Monthly Customer Conversion Record', value: '90%', subtext: 'August 2026' },
    { section: 'BAL', label: 'Monthly Customer Conversion Record', value: '90.00%', subtext: 'May 2026' },
    { section: 'LEE', label: 'Monthly Customer Conversion Record', value: '97.00%', subtext: 'December 2024' },
    // Not filled yet: must not render as a dash.
    { section: 'Company', label: 'Monthly Sell Margin Record', value: '', subtext: null },
];

function _recStage(html, width) {
    var host = document.getElementById('rec-stage');
    if (!host) {
        host = document.createElement('div');
        host.id = 'rec-stage';
        document.body.appendChild(host);
    }
    host.style.cssText = 'width:' + (width || 1200) + 'px;overflow:hidden;';
    host.innerHTML = html;
    return host;
}

function _recRender() {
    _recStage('<div id="recordsContainer"></div>');
    recordsCache = REC_FIXTURE.slice();
    renderRecords();
    return document.getElementById('recordsContainer');
}

t('headline is the top store, not the company-wide total', function () {
    var c = _recRender();
    var card = Array.from(c.querySelectorAll('.rec')).find(function (el) {
        return /Daily Buy Record/.test(el.querySelector('.rec-h').textContent);
    });
    if (!card) return 'no Daily Buy card';
    var cv = card.querySelector('.rec-champ .cv').textContent.trim();
    if (cv !== '$21,950.00') return 'headline reads ' + cv;
    var who = card.querySelector('.rec-champ .ch');
    if (!who || who.textContent.trim() !== 'OVL') return 'holder reads ' + (who && who.textContent);
    if (/38,519/.test(card.textContent)) return 'company total leaked into the store card';
    if (!/Store Record/.test(card.querySelector('.rec-champ .cc').textContent)) return 'kicker is not "Store Record"';
    return true;
});

t('a tie names both stores', function () {
    var c = _recRender();
    var card = Array.from(c.querySelectorAll('.rec')).find(function (el) {
        return /Conversion/.test(el.querySelector('.rec-h').textContent);
    });
    // LEE 97% is the top; make MPL and BAL the top by removing LEE.
    recordsCache = REC_FIXTURE.filter(function (r) { return !(r.section === 'LEE' && /Conversion/.test(r.label)); });
    renderRecords();
    card = Array.from(document.querySelectorAll('#recordsContainer .rec')).find(function (el) {
        return /Conversion/.test(el.querySelector('.rec-h').textContent);
    });
    var who = card.querySelector('.rec-champ .ch').textContent.replace(/\s+/g, ' ');
    return (/MPL/.test(who) && /BAL/.test(who)) || ('holder reads ' + who);
});

t('company-wide section shows filled totals only', function () {
    var c = _recRender();
    var sec = c.querySelector('.rec-co');
    if (!sec) return 'no company section';
    var tiles = sec.querySelectorAll('.rec-co-tile');
    if (tiles.length !== 1) return tiles.length + ' tiles (expected 1 — the empty margin row must be hidden)';
    if (!/38,519\.00/.test(tiles[0].textContent)) return 'tile reads ' + tiles[0].textContent;
    if (!/August 24, 2026/.test(tiles[0].textContent)) return 'date missing';
    if (/Record/.test(tiles[0].querySelector('.rec-co-l').textContent)) return 'label kept the word Record';
    // Above the store cards, and no explanation beside the header (Ethan).
    if (c.firstElementChild !== sec) return 'company section is not the first thing on the page';
    if (sec.querySelector('.rec-co-s')) return 'subtitle is back';
    return true;
});

t('no company rows at all → no section', function () {
    _recStage('<div id="recordsContainer"></div>');
    recordsCache = REC_FIXTURE.filter(function (r) { return r.section !== 'Company'; });
    renderRecords();
    return !document.querySelector('#recordsContainer .rec-co') || 'empty section rendered';
});

t('tool: Company column is read-only and never saved', function () {
    _recStage('<button id="saveRecordsBtn">Save</button><div id="manageRecordsList"></div>');
    recordsCache = REC_FIXTURE.slice();
    populateRecordsModal();
    var comp = document.querySelectorAll('#manageRecordsList .cr-company input');
    if (!comp.length) return 'no company cells';
    if (Array.from(comp).some(function (i) { return !i.readOnly; })) return 'a company input is editable';
    var buyCo = document.querySelector('#manageRecordsList .cr-company[data-label="Daily Buy Record"] .r-val');
    if (!buyCo || buyCo.value !== '$38,519.00') return 'company cell reads ' + (buyCo && buyCo.value) + ' (was it re-mirrored from the top store?)';

    var posted = [];
    var realFetch = window.fetch;
    window.fetch = function (u, o) { posted.push(JSON.parse(o.body)); return Promise.resolve({ ok: true }); };
    try { saveManageRecords(); } finally { window.fetch = realFetch; }
    var cells = posted.find(Array.isArray) || [];
    if (!cells.length) return 'nothing posted';
    var co = cells.filter(function (r) { return String(r.store).toLowerCase() === 'company'; });
    return co.length === 0 || (co.length + ' company cells posted');
});

// --- layout -----------------------------------------------------------------

[358, 460, 620, 788, 1408].forEach(function (w) {
    t('company tiles fit at ' + w + 'px', function () {
        _recStage('<div id="recordsContainer"></div>', w);
        recordsCache = [
            { section: 'Company', label: 'Daily Buy Record', value: '$38,519.00', subtext: 'August 24, 2026' },
            { section: 'Company', label: 'Daily Sell Record', value: '$35,913.59', subtext: 'August 31, 2026' },
            { section: 'Company', label: 'Monthly Revenue Record', value: '$656,392', subtext: 'August 2026' },
            { section: 'Company', label: 'Monthly Net Profit Record', value: '$214,617', subtext: 'September 2026' },
            { section: 'Company', label: 'Monthly Gross Profit Record', value: '$365,574', subtext: 'August 2026' },
            { section: 'Company', label: 'Monthly Sell Margin Record', value: '56.71%', subtext: 'July 2026' },
            { section: 'Company', label: 'Monthly Customer Conversion Record', value: '88.35%', subtext: 'June 2026' },
            { section: 'OVL', label: 'Daily Buy Record', value: '$21,950.00', subtext: 'March 13, 2026' },
        ];
        renderRecords();
        var host = document.getElementById('rec-stage');
        var limit = host.getBoundingClientRect().right;
        var bad = [];
        host.querySelectorAll('.rec-co *').forEach(function (el) {
            var r = el.getBoundingClientRect();
            if (r.width && r.right > limit + 1) bad.push(el.className + ' ends at ' + Math.round(r.right));
        });
        host.querySelectorAll('.rec-co-v').forEach(function (el) {
            // A figure that wrapped onto two lines is a figure nobody can read at a glance.
            var lh = parseFloat(getComputedStyle(el).lineHeight) || 22;
            if (el.getBoundingClientRect().height > lh * 1.5) bad.push('"' + el.textContent + '" wrapped');
            if (el.scrollWidth > el.clientWidth + 1) bad.push('"' + el.textContent + '" clipped');
        });
        var tiles = Array.from(host.querySelectorAll('.rec-co-tile'));
        if (tiles.length !== 7) bad.push(tiles.length + ' tiles');
        // Every tile the same size, and the figures on one line across a row —
        // which only holds if the two-line label reserve is doing its job.
        var r0 = tiles[0].getBoundingClientRect();
        tiles.forEach(function (el) {
            var r = el.getBoundingClientRect();
            if (Math.abs(r.width - r0.width) > 1 || Math.abs(r.height - r0.height) > 1)
                bad.push(el.querySelector('.rec-co-l').textContent + ' is ' + Math.round(r.width) + 'x' + Math.round(r.height)
                    + ', not ' + Math.round(r0.width) + 'x' + Math.round(r0.height));
        });
        var rows = {};
        tiles.forEach(function (el) {
            var top = Math.round(el.getBoundingClientRect().top);
            (rows[top] = rows[top] || []).push(Math.round(el.querySelector('.rec-co-v').getBoundingClientRect().top));
        });
        Object.keys(rows).forEach(function (k) {
            var v = rows[k];
            if (Math.max.apply(null, v) - Math.min.apply(null, v) > 1) bad.push('figures uneven in a row: ' + v.join('/'));
        });
        var perRow = Object.keys(rows).map(function (k) { return rows[k].length; });
        // Every row full except the last, which may be short but never longer.
        if (perRow.slice(0, -1).some(function (x) { return x !== perRow[0]; }) || perRow[perRow.length - 1] > perRow[0])
            bad.push('rows not full: ' + perRow.join('+'));
        // Wide: four over three (Ethan 2026-10-02), not six and an orphan.
        if (w >= 788 && perRow.join('+') !== '4+3') bad.push('tablet/wide layout is ' + perRow.join('+') + ', want 4+3');
        return bad.length ? bad.slice(0, 4).join('; ') : true;
    });
});
