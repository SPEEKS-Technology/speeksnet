// The Net Profit health alerts — what a pass decides is worth an email.
//
// Exists because of 2026-09-15, when two things broke the tab in one morning and
// neither sent a word: MPL's eBay login was revoked (the collector answered 200
// with null fees, the writer put #N/A down the month), and Marketplace Connect
// stalled over Sep 11-13 so 46 eBay orders landed on the wrong days. Both were
// DETECTED — a warning, a null — and written to a log nobody reads.
//
// The failure this guards against is the quiet one in both directions: a check
// that never fires is indistinguishable from a healthy sheet, and a check that
// fires on real days (a cash-only Sunday) trains everyone to delete the email.
// Fixtures are the real response shapes from that day, trimmed.
const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const grab = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
const grabVar = (src, name) => {
    const m = src.match(new RegExp('^var ' + name + '\\s*=\\s*[^;]+;', 'm'));
    if (!m) throw new Error('missing var ' + name);
    return m[0];
};
const sheet = read('netprofit-sheet.gs');
const alerts = read('netprofit-alerts.gs');
const sched = read('netprofit-schedule.gs');
eval([
    grabVar(sheet, 'NP_SECRET'), grabVar(sheet, 'NP_EBAY_CONSENT'),
    grabVar(sheet, 'NP_SHIP_SETTLE_DAYS'), grabVar(sheet, 'NP_SHIP_MIN_EBAY'),
    grab(sheet, '_npDaysBetween'), grab(sheet, '_npHealthCheck'),
    grab(alerts, '_npaHealthToSend'),
    grabVar(sched, 'NPS_WATCH_HOURS'), grab(sched, '_npsOverdue'), grab(sched, '_npsWatchAction'),
    grab(sched, '_npsTailAction'), grab(sheet, '_npIsTransient')
].join('\n'));

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};
const TODAY = '2026-09-15';
// A settled, ordinary day as the NEW collector reports it.
const day = (d, over) => Object.assign({ day: d, net_sales: 4000, cost: 1800, cc_fee: 40,
    card_orders: 6, ebay_fee: 300, ebay_sale_fees: 320, shipping_cost: 200,
    orders: 30, ebay_orders: 20 }, over || {});
const kinds = issues => issues.map(i => i.level + ':' + i.kind).sort().join(',');

console.log('\n1. MPL, 2026-09-15 — revoked eBay login, OLD collector (no health block)');
{
    const mpl = {
        warnings: ['eBay fee unavailable: Error: token refresh failed for MPL: 400 '
            + '{"error":"invalid_grant","error_description":"the provided authorization '
            + 'refresh token is invalid or was issued to another client"}'],
        days: []
    };
    const recs = ['2026-09-12', '2026-09-13', '2026-09-14'].map(d =>
        ({ day: d, net_sales: 2239.42, cost: 955, cc_fee: 24.07, ebay_fee: null,
           shipping_cost: null, orders: 8, ebay_orders: 2 }));
    const out = _npHealthCheck('MPL', mpl, recs, TODAY);
    ok(out.length === 1 && out[0].level === 'broken' && out[0].kind === 'ebay-na',
        'one BROKEN entry, not one per day', kinds(out));
    ok(/3 day\(s\)/.test(out[0].what), 'says how many days are #N/A', out[0].what);
    ok(out[0].fix.indexOf('ebay-oauth?store=MPL&secret=') >= 0,
        'the fix is the consent link for THIS store');
    ok(!out.some(i => i.kind === 'ship-zero'),
        'a null shipping is the #N/A entry, not a "no labels" check');
}

console.log('\n2. eBay failed for a reason that is NOT the login');
{
    const out = _npHealthCheck('OVL', { health: { ebay_error: 'Error: finances HTTP 500: upstream' } },
        [day('2026-09-10', { ebay_fee: null, ebay_sale_fees: null, shipping_cost: null })], TODAY);
    ok(out.length === 1 && out[0].kind === 'ebay-na', 'still BROKEN', kinds(out));
    ok(/^Claude/.test(out[0].fix) && out[0].fix.indexOf('ebay-oauth') < 0,
        'and is not sent to the store as a login problem', out[0].fix.slice(0, 40));
}

console.log('\n3. OVL — Marketplace Connect stalled (Sep 12-13 sales with no Shopify order)');
{
    const orders = [];
    for (let i = 0; i < 6; i++) orders.push({ ebay_order_id: '11-1500' + i + '-00000', day: '2026-09-12' });
    for (let i = 0; i < 9; i++) orders.push({ ebay_order_id: '12-1500' + i + '-00000', day: '2026-09-13' });
    const out = _npHealthCheck('OVL', { health: { not_yet_imported: { n: 15, fee: 348.1, orders } } },
        [day('2026-09-12'), day('2026-09-13')], TODAY);
    const ni = out.find(i => i.kind === 'not-imported');
    ok(ni && ni.level === 'broken', 'BROKEN — the days are missing sales as well as fees');
    ok(ni && /2026-09-12 \(6\), 2026-09-13 \(9\)/.test(ni.detail), 'counted by the day they sold', ni && ni.detail.slice(0, 50));
    ok(ni && /Marketplace Connect/.test(ni.fix), 'and names what to go and look at');
}

console.log('\n4. Days that LOOK empty and are right — none of these may alert');
{
    const recs = [
        // WSP Sep 5: net eBay fee NEGATIVE — August credits posted that day. Sale fees were charged.
        day('2026-09-05', { ebay_fee: -57.04, ebay_sale_fees: 142.10, ebay_orders: 7 }),
        // LEE Sep 13 (a Sunday): every order was eBay — no card sale, so no card fee.
        day('2026-09-13', { cc_fee: 0, card_orders: 0, ebay_orders: 12 }),
        // WSP Sep 4: the one till sale was cash.
        day('2026-09-04', { cc_fee: 0, card_orders: 0 }),
        // Yesterday: shipping not bought yet — too young to judge.
        day('2026-09-14', { shipping_cost: 0, ebay_orders: 14 }),
        // Two eBay sales, both local pickup: nothing to ship.
        day('2026-09-02', { shipping_cost: 0, ebay_orders: 2 }),
        // A day with no eBay sales owes no eBay fee.
        day('2026-09-06', { ebay_fee: 0, ebay_sale_fees: 0, ebay_orders: 0 })
    ];
    const out = _npHealthCheck('WSP', { health: { not_yet_imported: { n: 0, fee: 0, orders: [] } } }, recs, TODAY);
    ok(out.length === 0, 'no entries', kinds(out) || '(none)');
}

console.log('\n5. OLD collector rows (no card_orders / ebay_sale_fees) — skip, never read as zero');
{
    // OVL Sep 12 as the pre-fix collector reported it: $0 eBay fee, eBay orders filed under Sep 14.
    const out = _npHealthCheck('OVL', { warnings: [] },
        [{ day: '2026-09-12', net_sales: 4899.88, cost: 2104.12, cc_fee: 0, ebay_fee: 0,
           shipping_cost: 64.43, orders: 7, ebay_orders: 0 }], TODAY);
    ok(out.length === 0, 'no entries from fields that do not exist', kinds(out) || '(none)');
}

console.log('\n6. Days that are empty and WRONG — each is a check');
{
    const out = _npHealthCheck('BAL', { health: {} }, [
        day('2026-09-08', { ebay_sale_fees: 0, ebay_fee: 0, ebay_orders: 6 }),
        day('2026-09-09', { shipping_cost: 0, ebay_orders: 13 }),
        day('2026-09-10', { cc_fee: 0, card_orders: 3 })
    ], TODAY);
    ok(kinds(out) === 'check:cc-zero,check:ebay-zero,check:ship-zero', 'one of each', kinds(out));
    ok(out.every(i => /^BAL:2026-09-\d\d:/.test(i.key)), 'keyed by store and day, so each is sent once',
        out.map(i => i.key).join(' '));
}

console.log('\n7. Collector could not read something, so did not count it');
{
    const out = _npHealthCheck('LEE', { warnings: ['x'], health: {
        unknown_label_messages: 2, orders_with_truncated_events: 1, page_cap_hit: true,
        unhandled_ebay_types: { LOAN_REPAYMENT: 1 }, shopifyql_errors: ['Column Not Found'] } }, [], TODAY);
    ok(kinds(out) === 'broken:ebay-type,broken:events-cut,broken:label-shape,broken:page-cap,broken:shopifyql',
        'all five are BROKEN', kinds(out));
}

console.log('\n8. What goes out: BROKEN every pass, a check once a month');
{
    const b = { level: 'broken', key: 'MPL:-:ebay-na' };
    const c = { level: 'check', key: 'BAL:2026-09-10:cc-zero' };
    const p1 = _npaHealthToSend([b, c], []);
    ok(p1.broken.length === 1 && p1.fresh.length === 1, 'first pass: both');
    const p2 = _npaHealthToSend([b, c], p1.seen);
    ok(p2.broken.length === 1 && p2.fresh.length === 0, 'second pass: the broken one again, the check not');
    ok(p2.seen.length === 1, 'broken entries are never remembered', JSON.stringify(p2.seen));
    const p3 = _npaHealthToSend([], p1.seen);
    ok(p3.broken.length + p3.fresh.length === 0, 'nothing wrong: nothing to send');
}

console.log('\n9. The watchdog');
{
    const both = { morning: TODAY, afternoon: TODAY };
    ok(_npsOverdue(TODAY, 8, {}) === null, '8am: nothing is due yet');
    ok(_npsOverdue(TODAY, 9, both) === null, '9am, morning pass finished: quiet');
    const m = _npsOverdue(TODAY, 9, { morning: '2026-09-14', afternoon: '2026-09-14' });
    ok(m && /8am/.test(m.pass) && m.last === '2026-09-14', '9am, morning stamp is yesterday: overdue', m && m.pass);
    ok(_npsOverdue(TODAY, 15, { morning: TODAY }) !== null, '3pm, no 2pm stamp: overdue');
    ok(/2pm/.test(_npsOverdue(TODAY, 15, { morning: TODAY }).pass), 'and it names the 2pm pass');
    ok(_npsOverdue(TODAY, 15, { morning: '2026-09-14', afternoon: TODAY }) === null,
        '3pm checks the 2pm pass only — the morning was the 9am check\'s business');
}

console.log('\n10. The watchdog restarts a missed pass once, then gives up to email (2026-09-16)');
{
    const stale = { morning: '2026-09-14', afternoon: '2026-09-14' };
    ok(_npsWatchAction(TODAY, 9, { morning: TODAY }, {}) === null, 'finished: nothing to do');
    const a = _npsWatchAction(TODAY, 9, stale, {});
    ok(a && a.action === 'restart' && a.late.key === 'morning', 'first miss at 9: restart the morning pass');
    ok(_npsWatchAction(TODAY, 10, stale, { morning: TODAY }).action === 'give-up',
        'follow-up at 10, already restarted today and still unfinished: email');
    ok(_npsWatchAction(TODAY, 9, stale, { morning: '2026-09-14' }).action === 'restart',
        'a restart yesterday does not use up today\'s');
    ok(_npsWatchAction(TODAY, 15, { morning: TODAY }, { morning: TODAY }).action === 'restart',
        'the morning restart does not use up the 2pm one');
}

console.log('\n11. Yesterday\'s unimported eBay sales are late, not missing (2026-09-17)');
{
    // WSP, the morning of Sep 17: five Sep 16 sales not in Shopify at 9:35, all
    // imported by Marketplace Connect at 9:45. The alert fired twice for nothing.
    const TODAY17 = '2026-09-17';
    const wsp16 = ['08-15181-10732', '02-15192-35908', '09-15178-04506', '27-15144-63321', '01-15193-02451']
        .map(id => ({ ebay_order_id: id, day: '2026-09-16' }));
    let out = _npHealthCheck('WSP', { health: { not_yet_imported: { n: 5, fee: 104.66, orders: wsp16 } } },
        [day('2026-09-16')], TODAY17);
    ok(!out.some(i => i.kind === 'not-imported'), 'the real Sep 17 case: yesterday only, no email', kinds(out) || '(none)');

    const mixed = wsp16.slice(0, 2).concat([{ ebay_order_id: '11-15100-00001', day: '2026-09-15' }]);
    out = _npHealthCheck('WSP', { health: { not_yet_imported: { n: 3, fee: 60, orders: mixed } } },
        [day('2026-09-15'), day('2026-09-16')], TODAY17);
    let ni = out.find(i => i.kind === 'not-imported');
    ok(ni && /^1 eBay sale/.test(ni.what), 'mixed: only the day-before-yesterday sale counts', ni && ni.what.slice(0, 40));
    ok(ni && /2026-09-15 \(1\)/.test(ni.detail) && !/2026-09-16/.test(ni.detail),
        'and only its day is listed', ni && ni.detail.slice(0, 60));
    ok(ni && !/Fee not yet booked/.test(ni.detail),
        'the fee total covers all three, so it is not quoted against one', ni && ni.detail);

    const many = [];
    for (let i = 0; i < 25; i++) many.push({ ebay_order_id: '16-15200-' + String(10000 + i), day: '2026-09-16' });
    out = _npHealthCheck('OVL', { health: { not_yet_imported: { n: 40, fee: 900, orders: many } } },
        [day('2026-09-16')], TODAY17);
    ni = out.find(i => i.kind === 'not-imported');
    ok(ni && /^At least 25/.test(ni.what), 'a backlog too big to list is not routine lateness', ni && ni.what.slice(0, 30));
}

console.log('\n12. A store\'s collector failure is retried only when it is transient (2026-09-17)');
{
    ok(_npIsTransient('OVL: collector returned HTTP 504 — {"code":"IDLE_TIMEOUT"}'), 'the Sep 17 504');
    ok(_npIsTransient('OVL: collector returned HTTP 502 — {"error":"shopify orders query failed"}'), 'a 502');
    ok(_npIsTransient('collector batch failed — Exception: Address unavailable'), 'a dropped batch');
    ok(!_npIsTransient('OVL: collector returned HTTP 401 — {"error":"unauthorised"}'), 'a 401 is an answer, not a blip');
    ok(!_npIsTransient('OVL: collector returned no days'), '"no days" is an answer, not a blip');
}

console.log('\n13. The tail of a pass is repaired on its own, without re-running the refresh (2026-09-17)');
{
    const T = '2026-09-17';
    const gridDone = { morning: T };
    ok(_npsTailAction(T, 9, {}, {}, {}) === null, 'grid not written: not the tail\'s business (the restart path owns it)');
    ok(_npsTailAction(T, 9, gridDone, { morning: T }, {}) === null, 'grid and tail both done: quiet');
    const a = _npsTailAction(T, 9, gridDone, {}, {});
    ok(a && a.action === 'tail' && a.key === 'morning', 'grid done, tail missing: run the tail only', a && a.action);
    ok(_npsTailAction(T, 9, gridDone, {}, { morning: T }).action === 'give-up',
        'tail already retried today and still missing: email');
    ok(_npsTailAction(T, 8, gridDone, {}, {}) === null, 'before the watch hour: nothing is due');
    ok(_npsTailAction(T, 15, { morning: T, afternoon: T }, { morning: T }, {}).key === 'afternoon',
        'at 3pm it is the 2pm pass\'s tail that is checked');
    // The Sep 17 failure mode, end to end: grid written, tail killed. The old
    // watchdog restarted the whole refresh; the new one must not.
    ok(_npsWatchAction(T, 9, gridDone, {}) === null,
        'grid written means NO restart, even though the tail died');
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
