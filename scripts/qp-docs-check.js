// PROCESSES & POLICIES widget checks — the search box and the pinned list.
//
//   powershell -File scripts/browser-check.ps1 qp-docs-check.js
//
// Ethan, 2026-10-25: option B without the category chips — "just have the
// search bar and the pinned ones". _qpDocRows draws what sits under the box.

_b2bSend = function () { return Promise.resolve({}); };
// A Customize page: only those are held to half a row (_qpMaxW, 2026-10-26),
// and this page has no Customize bar to look at.
_qpHeadlinesOn = function () { return true; };

var DOCS = [
    { category: 'Store Operations, Pinned', icon: '⚠️', title: 'Secret Shop Audit Checklist', desc: 'Grade a buyer against the 80% line', link: 'https://drive.google.com/a' },
    { category: 'Store Operations', icon: '✅', title: 'Quarterly Deep Cleaning Checklist', desc: 'Once a quarter, every store', link: 'https://drive.google.com/b' },
    { category: 'Tech & Contingency, Pinned', icon: '📶', title: 'Internet Loss Process', desc: 'When the internet goes down', link: 'https://drive.google.com/c' },
    { category: 'Customer Experience', icon: '💬', title: 'Returns & Refunding Policy', desc: 'What we take back', link: 'javascript:alert(1)' },
    { category: 'HR & Employee Guidelines', icon: '👥', title: 'Dress <Code>', desc: 'What to wear', link: 'https://drive.google.com/e' },
];
function rows(q) {
    var el = document.createElement('div');
    el.innerHTML = _qpDocRows(DOCS, q);
    return el;
}
function titles(el) { return Array.from(el.querySelectorAll('a.qp-doc')).map(function (a) { return a.textContent.trim(); }); }

t('nothing typed shows the pinned documents only', function () {
    var el = rows('');
    var got = titles(el).join(' | ');
    if (el.querySelector('.qp-hl-cap').textContent !== 'Pinned') return 'cap: ' + el.querySelector('.qp-hl-cap').textContent;
    return got === 'Secret Shop Audit Checklist | Internet Loss Process' ? true : got;
});

t('a search matches every word, across title, description and category', function () {
    var a = titles(rows('audit checklist')).join(' | ');
    if (a !== 'Secret Shop Audit Checklist') return 'audit checklist: ' + a;
    var b = titles(rows('CHECKLIST')).length;
    if (b !== 2) return 'CHECKLIST found ' + b;
    var c = titles(rows('customer')).join(' | ');
    if (c !== 'Returns & Refunding Policy') return 'by category: ' + c;
    var d = titles(rows('internet down')).join(' | ');
    return d === 'Internet Loss Process' ? true : 'by description: ' + d;
});

t('the cap counts matches, and says so when there are none', function () {
    if (rows('checklist').querySelector('.qp-hl-cap').textContent !== '2 Matches') return rows('checklist').querySelector('.qp-hl-cap').textContent;
    if (rows('wear').querySelector('.qp-hl-cap').textContent !== '1 Match') return rows('wear').querySelector('.qp-hl-cap').textContent;
    var el = rows('zzqq');
    return el.querySelector('.qp-hl-cap').textContent === 'No Matches' && /Try another word/.test(el.textContent) ? true : el.textContent;
});

t('past five rows it says how many more', function () {
    var many = [];
    for (var i = 0; i < 8; i++) many.push({ category: 'Store Operations, Pinned', title: 'Doc ' + i, link: 'https://x/' + i });
    var el = document.createElement('div');
    el.innerHTML = _qpDocRows(many, '');
    var n = el.querySelectorAll('a.qp-doc').length;
    var more = el.querySelector('.qp-doc-more');
    return n === 5 && more && more.textContent === '+3 More' ? true : n + ' rows, more: ' + (more && more.textContent);
});

t('titles are escaped and only http(s) links are followed', function () {
    var el = rows('dress');
    var a = el.querySelector('a.qp-doc');
    if (!a || a.textContent.trim() !== 'Dress <Code>' || el.querySelector('code')) return 'title not escaped: ' + (a && a.innerHTML);
    var r = rows('refunding').querySelector('a.qp-doc');
    if (r.getAttribute('href') !== '#') return 'javascript: link kept: ' + r.getAttribute('href');
    return a.getAttribute('target') === '_blank' ? true : 'not a new tab';
});

t('the widget is in the drawer for everyone, ⅓ or ½', function () {
    if (!QP_WIDGETS.docs || !QP_WIDGETS.docs.avail()) return 'not available';
    if (_QP_LIB_SECTIONS.indexOf(QP_WIDGETS.docs.section) === -1) return 'section missing from the drawer: ' + QP_WIDGETS.docs.section;
    return _qpMaxW('docs') === 0.5 ? true : 'max ' + _qpMaxW('docs');
});
