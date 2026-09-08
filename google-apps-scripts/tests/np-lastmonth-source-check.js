// Where last month's Revenue, GP and Net Profit come from.
//
// Shopify is not the business's answer for a closed month. Measured 2026-09-02,
// August:
//
//              sheet        ShopifyQL     diff
//     OVL   169,257.97     226,479.25   +57,221.28
//     LEE   117,131.40     110,535.59    -6,595.81
//     WSP   146,737.30     143,812.42    -2,924.88
//     MPL   123,108.61     121,478.72    -1,629.89
//
// OVL is the outlier because it carries the Marketplace Connect duplicates from
// the Aug 20 back-fill. They were deleted; ShopifyQL still reports them. The
// sheet is right because the sheet was restated by hand.
//
// So revenue and cost come off the Sales Summary's own month tab and only the
// FEES come from Shopify, because there is nowhere else to get them. This
// harness pins the arithmetic that joins the two, and the reader that finds the
// tab — both of which decide a number a bonus is paid on.
const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const summary = read('netprofit-summary.gs');
const sheetSrc = read('netprofit-sheet.gs');

const grab = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
const constOf = (src, name) => {
    const m = src.match(new RegExp('var ' + name + '\\s*=\\s*([^;]*);'));
    if (!m) throw new Error('constant not found: ' + name);
    return '(' + m[1] + ')';
};

global.NP_ORDER       = eval(constOf(sheetSrc, 'NP_ORDER'));
global.NP_HEADER_ROWS = eval(constOf(sheetSrc, 'NP_HEADER_ROWS'));
global.NP_MON_ABBR    = eval((sheetSrc.match(/var NP_MON_ABBR = (\[[\s\S]*?\]);/) || [])[1]);
['NPX_SALES_PREFIX', 'NPX_SALES_BASES', 'NPX_SALES_SALES', 'NPX_SALES_COST']
    .forEach(n => { global[n] = eval(constOf(summary, n)); });

let log = [];
global.Logger = {
    log: (fmt, ...a) => { let i = 0; log.push(String(fmt).replace(/%s/g, () => String(a[i++]))); }
};
eval(grab(summary, 'r2c'));
eval(grab(summary, '_npxSalesTabTotals'));

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};
const near = (a, b) => Math.abs(a - b) < 0.02;

// A Sales tab: 4 header rows, 31 day rows, then TTL. Five blocks on stride 11,
// sales at +1 and cost at +4 from each block's day column.
function salesTab(name, totals) {
    const W = 60, rows = [];
    for (let r = 0; r < 4 + 31 + 1; r++) rows.push(new Array(W).fill(''));
    for (let d = 1; d <= 31; d++) {
        Object.keys(NPX_SALES_BASES).forEach(st => { rows[4 + (d - 1)][NPX_SALES_BASES[st]] = d; });
    }
    const ttl = rows[4 + 31];
    ttl[0] = 'TTL';
    Object.keys(totals || {}).forEach(st => {
        const b = NPX_SALES_BASES[st];
        ttl[b + NPX_SALES_SALES] = totals[st][0];
        ttl[b + NPX_SALES_COST] = totals[st][1];
    });
    return {
        getName: () => name,
        getLastRow: () => rows.length,
        getLastColumn: () => W,
        getRange: () => ({ getValues: () => rows })
    };
}
const wb = tabs => ({ getSheets: () => tabs });
const run = (tabs, prev) => { log = []; return _npxSalesTabTotals(wb(tabs), prev || '2026-08'); };

// August as the sheet actually holds it, from store_daily_sales.
const AUG = {
    OVL: [169257.97, 169257.97 - 89486.21],
    LEE: [117131.40, 117131.40 - 63755.94],
    WSP: [146737.30, 146737.30 - 84652.59],
    MPL: [123108.61, 123108.61 - 69700.53],
    BAL: [100156.58, 100156.58 - 57978.30]
};

console.log('== It finds the month tab and reads the TTL row ==');
{
    const got = run([salesTab('Sales Sep 26', AUG), salesTab('Sales Aug 26', AUG)]);
    ok(got && got._tab === 'Sales Aug 26', 'the exact name wins', got && got._tab);
    ok(got && near(got.OVL.revenue, 169257.97), 'OVL revenue off the sheet', got && got.OVL.revenue);
    ok(got && near(got.OVL.revenue - got.OVL.cost, 89486.21), 'and its GP falls out of sales - cost',
       got && r2c(got.OVL.revenue - got.OVL.cost));
    ok(got && got._stores.length === 5, 'all five stores', got && got._stores.join(','));
}

console.log('== The workbook has spelled a month two ways before ==');
{
    // store_daily_sales carries both "Jul 2026" and "July 2026". A lookup that
    // only accepts one spelling silently falls back to Shopify.
    const got = run([salesTab('Sales August 26', AUG)]);
    ok(got && got._tab === 'Sales August 26', 'a longer month name is still found', got && got._tab);
}
{
    const got = run([salesTab('Sales Aug 25', AUG)]);
    ok(got === null, 'but LAST YEAR\'s August is not this one');
}
{
    const got = run([salesTab('Sales Sep 26', AUG)]);
    ok(got === null, 'and neither is a different month');
}

console.log('== It refuses rather than writing a zero month ==');
{
    const got = run([salesTab('Sales Aug 26', {})]);
    ok(got === null, 'an empty TTL row -> null, not five zeros');
    ok(/TTL row is empty/.test(log.join(' ')), 'and says so');
}
{
    const partial = Object.assign({}, AUG);
    delete partial.BAL;
    const got = run([salesTab('Sales Aug 26', partial)]);
    ok(got && got._stores.length === 4, 'one store missing -> the other four still come back',
       got && got._stores.join(','));
    ok(got && !got.BAL, 'and that store is simply absent, not zero');
}
{
    ok(run([]) === null, 'no Sales tab at all -> null (Shopify, correctly)');
    ok(/no Sales tab for 2026-08/.test(log.join(' ')), 'and the log names what it looked for');
}

console.log('== The join: sheet revenue, Shopify fees, the tab\'s own NP formula ==');
{
    // What the collector returned for OVL August.
    const shop = { revenue: 226479.25, gp: 118404.29, np: 86252.77 };
    // The three fees are recoverable from those three numbers alone, which is
    // why a month already banked in the cache does not need refetching.
    const fees = r2c(shop.gp - shop.np - shop.revenue * 0.07);
    ok(near(fees, 16297.97), 'eBay fee + shipping + card fee recovered from the collector totals',
       String(fees));

    const sRev = AUG.OVL[0], sCost = AUG.OVL[1], sGp = r2c(sRev - sCost);
    const np = r2c(sGp - fees - sRev * 0.07);
    ok(near(sGp, 89486.21), 'GP from the sheet', String(sGp));
    ok(near(np, 61340.18), 'and NP rebuilt on it', String(np));
    ok(np < shop.np, 'which is LOWER than the Shopify answer, as an inflated revenue implies',
       r2c(shop.np - np) + ' lower');

    // The identity has to hold in reverse, or the recovery is not a recovery.
    const back = r2c(shop.gp - fees - shop.revenue * 0.07);
    ok(near(back, shop.np), 'and the same arithmetic reproduces Shopify\'s own NP exactly',
       String(back));
}

console.log('== Every store, so no block map is taken on trust ==');
{
    const got = run([salesTab('Sales Aug 26', AUG)]);
    const shop = {
        OVL: { revenue: 226479.25, gp: 118404.29, np: 86252.77 },
        LEE: { revenue: 110535.59, gp: 59971.01, np: 39954.14 },
        WSP: { revenue: 143812.42, gp: 83975.71, np: 57378.71 },
        MPL: { revenue: 121478.72, gp: 68695.27, np: 45166.99 }
    };
    Object.keys(shop).forEach(st => {
        const fees = r2c(shop[st].gp - shop[st].np - shop[st].revenue * 0.07);
        const sGp = r2c(got[st].revenue - got[st].cost);
        const np = r2c(sGp - fees - got[st].revenue * 0.07);
        ok(fees > 0, st + ': fees recover to a positive number', String(fees));
        ok(near(got[st].revenue, AUG[st][0]), st + ': revenue is the sheet\'s', String(got[st].revenue));
        ok(np > 0 && np < sGp, st + ': NP is below GP and above zero', String(np));
    });
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall pass');
process.exit(fails ? 1 : 0);
