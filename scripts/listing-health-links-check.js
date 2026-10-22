// LISTING HEALTH NOTES: THE READER CAN GO AND LOOK (2026-10-22).
//
// Ethan: "add links to the Shopify listing so I can check things out too", and
// "tell the user to look at pictures when the pictures give the correct answer
// so they can see your evidence". Two pieces of markup, asserted in the real
// stylesheet:
//    1. every note row in the DM tool links to that listing in Shopify admin —
//       any of the five stores, and nothing when the id is not a number
//    2. a name finding a photo settled shows the photo beside its sentence,
//       capped so a portrait shot cannot push a phone row off the screen
//
// Run: powershell -File scripts/browser-check.ps1 listing-health-links-check.js

function stage(width, html) {
    var host = document.getElementById('layout-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'layout-host';
        document.body.appendChild(host);
    }
    host.style.cssText = 'width:' + width + 'px;overflow:hidden;';
    host.innerHTML = html;
    void host.offsetHeight;
    return host;
}

// A 600x900 portrait "photo", inline so nothing touches the network.
var TALL = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#888"/></svg>');

t('a title note links to its listing in Shopify admin', function () {
    var a = _lhShopifyLink({ store: 'LEE', productId: 'gid://shopify/Product/8123456789' });
    return /href="https:\/\/admin\.shopify\.com\/store\/paymore-lees-summit\/products\/8123456789"/.test(a)
        && /target="_blank"/.test(a) ? true : 'got: ' + a;
});

t('every store resolves, not only the reader\'s own', function () {
    var missing = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'].filter(function (s) {
        return !_lhShopifyLink({ store: s, productId: '42' });
    });
    return missing.length ? 'no link for ' + missing.join(', ') : true;
});

t('no link rather than a broken one', function () {
    var bad = [
        _lhShopifyLink({ store: 'CORP', productId: '42' }),
        _lhShopifyLink({ store: 'LEE', productId: 'gid://shopify/Product/' }),
        _lhShopifyLink({ store: 'LEE' }),
        _lhShopifyLink(null),
    ].filter(Boolean);
    return bad.length ? 'linked anyway: ' + bad[0] : true;
});

t('a photo-settled finding shows the photo, linked full size', function () {
    var html = _ltWhy([{ code: 'name-wrong', says: 'Look at photo 7: the label reads SONY PSP-1001.',
        warn: 'Settled by photo 7 of this listing', photo: { n: 7, url: TALL } }]);
    var host = stage(1440, '<ul class="lt-why">' + html + '</ul>');
    var img = host.querySelector('li.lt-evidence a[target="_blank"] img');
    if (!img) return 'no photo rendered: ' + html.slice(0, 200);
    return /Photo 7/.test(host.textContent) ? true : 'the photo is not numbered';
});

t('a finding with no photo URL renders no empty frame', function () {
    var html = _ltWhy([{ code: 'name-wrong', says: 'x', photo: { n: 3, url: null } },
                       { code: 'missing-noun', says: 'y' }]);
    return /lt-evidence/.test(html) ? 'an evidence row with nothing in it' : true;
});

t('a portrait photo stays inside a phone row', function () {
    var html = _ltWhy([{ code: 'name-wrong', says: 'x', photo: { n: 1, url: TALL } }]);
    var host = stage(390, '<ul class="lt-why">' + html + '</ul>');
    // ⚠️ THE CAPS, NOT THE BOX. Even a data: image decodes after t() returns,
    // so a measured box is the 2px border of an image not drawn yet. What keeps
    // a portrait shot in a phone row is these computed values, so assert them.
    var img = host.querySelector('.lt-evidence img');
    var cs = getComputedStyle(img), a = getComputedStyle(img.parentElement);
    if (cs.maxHeight !== '200px') return 'max-height is ' + cs.maxHeight;
    if (!/260px|100%/.test(cs.maxWidth)) return 'max-width is ' + cs.maxWidth;
    if (a.maxWidth !== '100%') return 'the link can outgrow the row: max-width ' + a.maxWidth;
    if (cs.objectFit !== 'contain') return 'the photo is cropped: object-fit ' + cs.objectFit;
    var r = img.parentElement.getBoundingClientRect(), h = host.getBoundingClientRect();
    if (r.right > h.right + 1) return 'past the row edge by ' + Math.round(r.right - h.right) + 'px';
    return true;
});
