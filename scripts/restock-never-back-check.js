// NEVER CAME BACK on the Restocked Under Another SKU card (2026-11-06).
//
//   powershell -File scripts/browser-check.ps1 restock-never-back-check.js -Html index.html
//
// A manager marks a line Never Came Back; the DM confirms or denies it on the
// same card. These render the card for each state and check who sees what.

function _rnbCard(nb) {
    return {
        key: 'WSP:1:2', store: 'WSP', storeName: 'Westport', order: '#MO02-6752', orderUrl: '#',
        channel: 'eBay', kind: 'return', refundDay: '2026-10-08', sku: 'MO02-4672A-E10',
        title: 'Lenovo ThinkPad X9', amount: 899.99, closed: false, attempts: [],
        nb: Object.assign({ pending: false }, nb || {}),
    };
}
function _rnbHtml(j, st) {
    var body = document.getElementById('restockSkuBody');
    if (!body) return null;
    _restockRender(j, st || {});
    return body.innerHTML;
}

t('the card sits in index.html', function () {
    return document.getElementById('restockSkuBody') ? true : '#restockSkuBody missing from index.html';
});

t('manager, nothing pending: reason box + Send To DM', function () {
    var h = _rnbHtml({ card: _rnbCard(), canClose: true, canDecide: false });
    if (h.indexOf('restockNbReason') < 0) return 'no reason box';
    if (h.indexOf('Send To DM To Confirm') < 0) return 'no Send To DM button';
    if (h.indexOf('restockNbYes') >= 0) return 'manager sees Confirm';
    return true;
});

t('DM, nothing pending: closes directly', function () {
    var h = _rnbHtml({ card: _rnbCard(), canClose: true, canDecide: true });
    return h.indexOf('Close As Never Came Back') >= 0 ? true : 'DM button missing';
});

t('pending, DM: Confirm and Deny, no new-request box', function () {
    var h = _rnbHtml({ card: _rnbCard({ pending: true, by: 'Eli', at: '2026-11-06T20:00:00Z', reason: 'buyer kept it' }), canClose: true, canDecide: true });
    if (h.indexOf('restockNbYes') < 0 || h.indexOf('restockNbNo') < 0) return 'Confirm/Deny missing';
    if (h.indexOf('buyer kept it') < 0) return 'reason not shown';
    if (h.indexOf('restockNbReason') >= 0) return 'a second request box shows while one is pending';
    return true;
});

t('pending, manager: waiting, no Confirm', function () {
    var h = _rnbHtml({ card: _rnbCard({ pending: true, by: 'Eli', at: '2026-11-06T20:00:00Z', reason: 'buyer kept it' }), canClose: true, canDecide: false });
    if (h.indexOf('restockNbYes') >= 0) return 'manager can confirm their own request';
    return h.indexOf('Waiting On DM') >= 0 ? true : 'no waiting note';
});

t('denied: the reason shows in red, and they can ask again', function () {
    var h = _rnbHtml({ card: _rnbCard({ deniedAt: '2026-11-06T21:00:00Z', deniedBy: 'Ethan', deniedNote: 'show me the case' }), canClose: true, canDecide: false });
    if (h.indexOf('show me the case') < 0) return 'denial not shown';
    return h.indexOf('restockNbReason') >= 0 ? true : 'cannot ask again';
});

t('a never-came-back close does not claim it is listed under Closed By A Manager', function () {
    var c = _rnbCard(); c.closed = true; c.closedHow = 'never came back — buyer kept it — marked by Eli, confirmed by Ethan';
    var h = _rnbHtml({ card: c, canClose: true }, { justClosed: true });
    return h.indexOf('Closed By A Manager') < 0 ? true : 'says Closed By A Manager';
});
