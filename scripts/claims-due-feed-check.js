// THE 4PM "DUE TODAY" CLAIMS ALERT AS A FEED CARD (2026-10-08).
//
//   powershell -File scripts/browser-check.ps1 claims-due-feed-check.js -Html index.html
//
// -Html because the card's hidden state-carrier is created next to the real
// #claimAlertBubble, and the feed only lists what that element says is live.
// claims-disputes is stubbed: these checks are about what the front end does
// with `dueAlerts`, not about which items the server puts in it.

var _cdReply = { success: true, today: '2026-10-08', stores: ['BAL'], dueAlerts: [] };
var _cdAsked = [];
window.fetch = function (url) {
    _cdAsked.push(String(url));
    if (/claims-disputes\?action=alerts/.test(String(url))) {
        return Promise.resolve({ json: function () { return Promise.resolve(JSON.parse(JSON.stringify(_cdReply))); } });
    }
    return Promise.reject(new Error('network blocked in browser-check'));
};
function as(role, store) {
    sessionStorage.setItem('speeksUserRole', role);
    sessionStorage.setItem('speeksUserName', 'Check User');
    sessionStorage.setItem('speeksUserStore', store || 'ALL');
}
function card() { return _samGatherReminders().find(function (r) { return r.key === 'claimsDue'; }); }
var chargeback = { type: 'dispute', key: 'shopify:1', store_code: 'BAL', state: 'needs_reply', due: '2026-10-08',
    overdue: false, amount: 199.99, order: '#MO05-1', source: 'shopify', dispute_type: 'CHARGEBACK', nudged_on: '2026-10-08' };
var card2 = { type: 'payment', key: 'BAL:2', store_code: 'BAL', state: 'needs_reply', due: '2026-10-09',
    overdue: false, amount: 16.26, order: '#MO05-2', capturable: true, financial_status: 'AUTHORIZED', nudged_on: '2026-10-08' };

t('the card exists in the feed config and has no Snooze', function () {
    if (!document.getElementById('claimAlertBubble')) return 'run with -Html index.html';
    var c = _samReminderCfg().find(function (r) { return r.key === 'claimsDue'; });
    if (!c) return 'no claimsDue entry';
    return c.noSnooze === true || 'snoozeable';
});

t('manager: shows, stays through Snooze and Mark-all-read, clears when resolved', function () {
    as('Manager', 'BAL');
    try { localStorage.clear(); } catch (_) {}
    _cdReply.dueAlerts = [chargeback, card2];
    return checkClaimsDueAlerts().then(function () {
        if (!_cdAsked.some(function (u) { return /stores=BAL/.test(u); })) return 'did not ask for BAL';
        var c = card();
        if (!c) return 'card not in the feed';
        if (c.title !== 'Claims & Disputes Due Today') return 'title: ' + c.title;
        if (!/Chargeback \$199\.99 \(#MO05-1\) — due today/.test(c.snippet)) return 'snippet: ' + c.snippet;
        if (!/due tomorrow/.test(c.snippet)) return 'second item not named as tomorrow: ' + c.snippet;
        if (c.action !== "openClaimsTool('cases')") return 'action: ' + c.action;
        // The render path: no Snooze button on the card itself.
        if (c.noSnooze !== true) return 'gathered without noSnooze';
        // Snooze written straight into the map (an old entry, or any caller) is ignored...
        samSnoozeItem({ stopPropagation: function () {} }, 'claimsDue', 20);
        if (!card()) return 'a snooze hid it';
        // ...and Mark-all-read neither writes it nor hides it.
        samMarkAllRead();
        if (_samGetHidden().claimsDue && _samGetHidden().claimsDue.until > Date.now() && !card()) return 'Mark all read hid it';
        if (!card()) return 'gone after Mark all read';
        // One resolved: the card narrows to what is left.
        _cdReply.dueAlerts = [card2];
        return checkClaimsDueAlerts().then(function () {
            var c2 = card();
            if (!c2) return 'card vanished with one item left';
            if (/Chargeback/.test(c2.snippet)) return 'resolved item still listed';
            if (c2.action !== "openClaimsTool('payments')") return 'action should follow the item: ' + c2.action;
            // All resolved: gone.
            _cdReply.dueAlerts = [];
            return checkClaimsDueAlerts().then(function () {
                if (card()) return 'still in the feed with nothing left';
                // Past its deadline: Overdue, and still there.
                _cdReply.dueAlerts = [Object.assign({}, chargeback, { overdue: true, due: '2026-10-07' })];
                return checkClaimsDueAlerts().then(function () {
                    var d = card();
                    if (!d) return 'overdue item not shown';
                    if (d.title !== 'Claims & Disputes Overdue' || d.due !== 'Overdue') return 'title/badge: ' + d.title + ' / ' + d.due;
                    // Store managers only (Ethan, 2026-10-08): the DM works from
                    // the 4pm emails, and the CEO keeps the tool without alerts.
                    // Neither asks the server, and a card already up is cleared.
                    as('District Manager', 'ALL');
                    _cdAsked = [];
                    return checkClaimsDueAlerts().then(function () {
                        if (_cdAsked.length) return 'DM asked the server: ' + _cdAsked.join(' ');
                        if (card()) return 'DM got the card';
                        as('CEO', 'ALL');
                        return checkClaimsDueAlerts().then(function () { return !card() || 'CEO got the card'; });
                    });
                });
            });
        });
    });
});
