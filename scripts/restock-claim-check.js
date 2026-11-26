// ON A CLAIM on the Returned But Not Back In Stock card (2026-11-23).
//
//   powershell -File scripts/browser-check.ps1 restock-claim-check.js -Html index.html
//
// A line lost in shipping and filed in Shopify Claims is linked to that claim
// from the #restock card and closes. These render the card for each state.

var _rcPosted = [];
_restockPost = function (body) {          // stub once, at the top (see CLAUDE.md)
    _rcPosted.push(body);
    if (body.action === 'link_claim' && body.claimId === 'good') {
        return Promise.resolve({ ok: true, card: Object.assign(_rcCard(), { closed: true, closedHow: 'on claim SHPLI-1 — closed by Eli' }) });
    }
    return Promise.resolve({ ok: false, why: 'That claim is for SKU X, not KS01-8025B-R6R2.', card: _rcCard() });
};

function _rcCard(extra) {
    return Object.assign({
        key: 'OVL:1:2', store: 'OVL', storeName: 'Overland Park', order: '#KS01-15437', orderUrl: '#',
        channel: 'eBay', kind: 'return', refundDay: '2026-11-20', sku: 'KS01-8025B-R6R2',
        title: 'MacBook Air M1', amount: 349.99, closed: false, attempts: [], nb: { pending: false },
    }, extra || {});
}
var _rcClaim = { id: 'good', caseNumber: 'SHPLI-111926173701', status: 'in_progress', reason: 'Shopify Claim — Loss', price: 349.99, createdAt: '2026-11-19T17:00:00Z' };
function _rcHtml(j, st) {
    _restockRender(j, st || {});
    return document.getElementById('restockSkuBody').innerHTML;
}

t('a matching claim is offered at the top, before the SKU picks', function () {
    var h = _rcHtml({ card: _rcCard(), canClose: true, claims: [_rcClaim], suggestions: [{ sku: 'KS01-1', title: 'x', onHand: 1 }] });
    var a = h.indexOf('SHPLI-111926173701'), b = h.indexOf('KS01-1<');
    if (a < 0) return 'claim not shown';
    if (b >= 0 && b < a) return 'claim sits below the SKU picks';
    if (h.indexOf('In Progress') < 0) return 'status not shown';
    if (h.indexOf('On A Claim?') >= 0) return 'shows the no-claim note too';
    return true;
});

t('no matching claim: says to file it with this SKU', function () {
    var h = _rcHtml({ card: _rcCard(), canClose: true, claims: [] });
    if (h.indexOf('On A Claim?') < 0) return 'no note';
    return h.indexOf('KS01-8025B-R6R2') >= 0 ? true : 'SKU not named';
});

t('no SKU: says it cannot be linked', function () {
    var h = _rcHtml({ card: _rcCard({ sku: '' }), canClose: true, claims: [] });
    return /can.t be linked/.test(h) ? true : 'no no-SKU message';
});

t('a deleted claim says why the line is back', function () {
    var h = _rcHtml({ card: _rcCard({ claimDead: 'SHPLI-9' }), canClose: true, claims: [] });
    return h.indexOf('SHPLI-9 was deleted') >= 0 ? true : 'no deleted note';
});

t('not allowed to close: no claim picks', function () {
    var h = _rcHtml({ card: _rcCard(), canClose: false, denied: 'Only OVL\'s manager', claims: [_rcClaim] });
    return h.indexOf('SHPLI-111926173701') < 0 ? true : 'claim offered to someone who cannot close';
});

// One async test for both taps: t() runs bodies back to back, so a second
// async test would re-render the card before the first one's .then ran.
t('tap: a good claim closes it; a refused one keeps the card and says why', function () {
    _rcHtml({ card: _rcCard(), canClose: true, claims: [_rcClaim] });
    return _restockLinkClaim('good').then(function () {
        var last = _rcPosted[_rcPosted.length - 1];
        if (!last || last.action !== 'link_claim' || last.claimId !== 'good') return 'wrong post: ' + JSON.stringify(last);
        var h = document.getElementById('restockSkuBody').innerHTML;
        if (h.indexOf('Closed.') < 0) return 'not shown closed';
        if (h.indexOf('Closed By A Manager') < 0) return 'does not say the DM sees it';
        _rcHtml({ card: _rcCard(), canClose: true, claims: [Object.assign({}, _rcClaim, { id: 'bad' })] });
        return _restockLinkClaim('bad').then(function () {
            var h2 = document.getElementById('restockSkuBody').innerHTML;
            if (h2.indexOf('not KS01-8025B-R6R2') < 0) return 'reason not shown';
            return h2.indexOf('SHPLI-111926173701') >= 0 ? true : 'claim list lost after a refusal';
        });
    });
});
