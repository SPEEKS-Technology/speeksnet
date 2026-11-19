// LISTING HEALTH, DM TITLE NOTES — "What They Saw" (2026-11-19).
//
// Ethan: "improve the DM view in listing health so I can see exactly what you
// show them and then provide me links to their shopify listing." Each denied
// note now carries the store row's own Now / Suggested lines and the same
// _ltWhy bullets (reason, red caution line, evidence photo), from the findings
// stored when it was denied — plus an Open In Shopify link.
//
// Asserts against the real renderListingHealthTool:
//   1. the store's sentence, caution line and evidence photo all render
//   2. Now / Suggested use the store's diff marks, not plain text
//   3. Open In Shopify uses the server's admin link
//   4. a payload from before the change (said[] + photos[] only) still renders
//
// Run: powershell -File scripts/browser-check.ps1 listing-health-saw-check.js

function _sawRender(fb) {
    var host = document.getElementById('listingHealthToolBody');
    if (!host) {
        host = document.createElement('div');
        host.id = 'listingHealthToolBody';
        document.body.appendChild(host);
    }
    _lhToolFb = fb;
    _lhToolPq = null;
    renderListingHealthTool();
    return host;
}

var SAW_ROW = {
    store: 'LEE', sku: 'MO01-6285UV-QTY2-R3R4', productId: 'gid://shopify/Product/15450407305389',
    link: 'https://admin.shopify.com/store/paymore-lees-summit/products/15450407305389',
    current: 'HP ProDesk 600 G5 Mini 85M81UC Core i5-9500T',
    suggested: 'HP ProDesk 600 G5 Mini 8TM81UC Core i5-9500T',
    note: '#ABA Is not needed for model number', by: 'Jurell Guild', at: '2026-11-17T15:00:00Z',
    codes: ['name-wrong'], said: ['The title says "85M81UC"; it should be "8TM81UC".'],
    photos: [{ n: 6, url: 'https://cdn.shopify.com/x/6.jpg' }],
    findings: [{ code: 'name-wrong', says: 'The title says "85M81UC"; it should be "8TM81UC".',
                 warn: 'Settled by photo 6 of this listing, not by outside knowledge.',
                 photo: { n: 6, url: 'https://cdn.shopify.com/x/6.jpg' } }],
    was: '85M81UC', now: '8TM81UC', specs: { MPN: '85M81UC' },
    saysItself: { field: 'MPN', value: '85M81UC' },
};
var SAW_FB = { days: 30, stores: ['LEE'], total: 1, settled: 1, keys: [], done: [], ask: 'x',
    groups: [{ code: 'name-wrong', n: 1, rows: [SAW_ROW] }] };

t('the store\'s own sentence renders under What ... Saw', function () {
    var h = _sawRender(SAW_FB);
    var saw = h.querySelector('.lh-tool-saw');
    if (!saw) return 'no .lh-tool-saw block';
    if (!/What Jurell Saw/.test(saw.textContent)) return 'header: ' + saw.querySelector('.lh-tool-saw-h').textContent;
    if (!/it should be "8TM81UC"/.test(saw.textContent)) return 'sentence missing';
    return true;
});

t('the caution line renders as the store sees it', function () {
    var c = _sawRender(SAW_FB).querySelector('.lh-tool-saw .lt-caution');
    return c && /Settled by photo 6/.test(c.textContent) ? true : 'no .lt-caution';
});

t('the evidence photo renders', function () {
    var img = _sawRender(SAW_FB).querySelector('.lh-tool-saw .lt-evidence img');
    return img && img.getAttribute('src') === 'https://cdn.shopify.com/x/6.jpg' ? true : 'no photo';
});

t('Now / Suggested use the store row\'s diff, not plain text', function () {
    var saw = _sawRender(SAW_FB).querySelector('.lh-tool-saw');
    var sug = saw.querySelector('.lt-new .lt-sug');
    if (!sug) return 'no .lt-sug';
    if (sug.innerHTML === sug.textContent) return 'suggested has no change marks';
    return /8TM81UC/.test(sug.textContent) ? true : sug.textContent;
});

t('Open In Shopify uses the server admin link', function () {
    var a = _sawRender(SAW_FB).querySelector('.lh-tool-meta a.ec-pill-shopify');
    if (!a) return 'no Shopify link';
    if (a.getAttribute('href') !== SAW_ROW.link) return a.getAttribute('href');
    return /Open In Shopify/.test(a.textContent) ? true : a.textContent;
});

t('an old payload (said + photos only) still shows sentence and photo', function () {
    var old = JSON.parse(JSON.stringify(SAW_ROW));
    delete old.findings;
    var fb = JSON.parse(JSON.stringify(SAW_FB));
    fb.groups[0].rows = [old];
    var saw = _sawRender(fb).querySelector('.lh-tool-saw');
    if (!/it should be "8TM81UC"/.test(saw.textContent)) return 'sentence missing';
    return saw.querySelector('.lt-evidence img') ? true : 'photo missing';
});

t('a row with no suggestion says so instead of an empty line', function () {
    var r = JSON.parse(JSON.stringify(SAW_ROW));
    r.suggested = null;
    var fb = JSON.parse(JSON.stringify(SAW_FB));
    fb.groups[0].rows = [r];
    var n = _sawRender(fb).querySelector('.lh-tool-saw .lt-nosug');
    return n ? true : 'no .lt-nosug';
});

// Ethan, 2026-11-19: "I clicked on an image in listing health and got stuck."
// The evidence photo was a bare target=_blank link; in the desktop app's pane it
// replaced the page with the JPG and no way back. It opens the in-app viewer.
t('clicking the evidence photo opens the viewer and stays on the page', function () {
    var a = _sawRender(SAW_FB).querySelector('.lh-tool-saw .lt-evidence a');
    if (!a) return 'no evidence link';
    var before = location.href;
    a.click();
    var lb = document.getElementById('auditPhotoLightbox');
    if (location.href !== before) return 'navigated away';
    if (!lb || lb.style.display !== 'flex') return 'viewer did not open';
    lb.querySelector('.au-lb-close').click();
    if (lb.style.display !== 'none') return 'the X did not close it';
    a.click(); lb.click();
    return lb.style.display === 'none' ? true : 'backdrop click did not close it';
});
