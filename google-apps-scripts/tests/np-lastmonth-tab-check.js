// Finding the tab that holds LAST MONTH.
//
// It used to look for one name — "Net Profit Aug 26" — and August does not have
// that name. August is the single pre-rollover tab (NP_TAB_LEGACY), because the
// rollover COPIED it to make September instead of renaming it. The lookup
// missed, the code fell through to Shopify, and September's MoM denominator was
// re-derived live.
//
// That is not a slower route to the same number. August's tab carries our
// restatements — the Marketplace Connect duplicates, the mirror-back refunds,
// every pinned cell — and Shopify knows about none of them, so the two answers
// differ by real money. Ethan caught it on OVL.
//
// It now narrows by NAME and decides by the tab's OWN row-2 month header. This
// harness is here because both halves matter: dropping the name filter would let
// a Sales tab win, and dropping the header check would put an arbitrary month in
// as the bonus denominator.
const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const summary = read('netprofit-summary.gs');
const sheet = read('netprofit-sheet.gs');

const grab = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
// ⚠️ THE DECLARATIONS ARE COLUMN-ALIGNED in these files — `var NP_BASES    =` —
// so the separator has to be \s*=\s*. Matching a single space returned undefined
// for exactly the constants that are aligned; the function under test then threw
// into its own try/catch and reported "no month header" for every tab, and three
// assertions failed for a reason that had nothing to do with the code. A harness
// that fails open is worse than no harness, so this throws instead.
const constOf = (src, name) => {
    const m = src.match(new RegExp('var ' + name + '\\s*=\\s*([^;]*);'));
    if (!m) throw new Error('constant not found: ' + name);
    // Parenthesised: an object literal at the start of an eval is a BLOCK, not
    // a value, and `{ OVL: 0 }` is a syntax error rather than the map it looks
    // like.
    return '(' + m[1] + ')';
};

// Constants read from the files rather than retyped — a harness carrying its own
// copy stops testing the moment one of them moves.
global.NP_TAB_PREFIX = eval(constOf(sheet, 'NP_TAB_PREFIX'));
global.NP_TAB_LEGACY = eval(constOf(sheet, 'NP_TAB_LEGACY'));
global.NP_BASES      = eval(constOf(sheet, 'NP_BASES'));
global.NPX_OFF_LABEL = eval(constOf(summary, 'NPX_OFF_LABEL'));
global.NPX_TZ        = eval(constOf(summary, 'NPX_TZ'));
eval(grab(sheet, '_npTabName'));
global.NP_MON_ABBR = eval((sheet.match(/var NP_MON_ABBR = (\[[\s\S]*?\]);/) || [])[1]);

let log = [];
// Substitutes %s the way Apps Script does, so an assertion on the log reads what
// a person would actually see in the execution log.
global.Logger = {
    log: (fmt, ...a) => { let i = 0; log.push(String(fmt).replace(/%s/g, () => String(a[i++]))); }
};
global.Utilities = {
    // Only ever asked for 'yyyy-MM' here, and the tabs are built in local time.
    formatDate: (d) => d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2)
};
eval(grab(summary, '_npxLastMonthTabFor'));

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};

// A workbook: [name, header month or null]. The header lives at row 2 in the
// OVL block's label column (B), and is a real Date.
const wb = tabs => ({
    getSheets: () => tabs.map(([name, ym]) => ({
        getName: () => name,
        getRange: (row, col) => ({
            getValue: () => {
                if (row !== 2 || col !== NP_BASES.OVL + NPX_OFF_LABEL + 1) return '';
                if (!ym) return '';
                return new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1);
            }
        })
    }))
});
const find = (tabs, prev) => { log = []; return _npxLastMonthTabFor(wb(tabs), prev || '2026-08'); };

console.log('== The name, when the name is right ==');
{
    const got = find([['Net Profit Sep 26', '2026-09'], ['Net Profit Aug 26', '2026-08']]);
    ok(got && got.name === 'Net Profit Aug 26', 'the conventional name wins outright', got && got.name);
    ok(got && got.how === 'by name', 'and says so', got && got.how);
}

console.log('== September\'s actual position: August is the legacy tab ==');
{
    const got = find([['Net Profit Sep 26', '2026-09'], ['NET PROFIT TEMPLATE', '2026-08']]);
    ok(got && got.name === 'NET PROFIT TEMPLATE', 'the legacy tab is found by its month header',
       got && got.name);
    ok(got && /header/.test(got.how), 'and says how it was found', got && got.how);
}
{
    // The bug exactly as it was: this returned null and the run went to Shopify.
    const got = find([['Net Profit Sep 26', '2026-09'], ['NET PROFIT TEMPLATE', '2026-08']]);
    ok(got !== null, 'which is the case that used to fall through to Shopify');
}

console.log('== A Sales tab is never a candidate ==');
{
    // Sales tabs stride 11, not 18. Reading a TTL row off one at Net Profit's
    // offsets lands inside another store's block and returns numbers that look
    // perfectly real — so they must not be considered at all.
    const got = find([['Sales Aug 26', '2026-08'], ['Sales Sep 26', '2026-09'],
                      ['Net Profit Sep 26', '2026-09']]);
    ok(got === null, 'a Sales tab holding August is not last month', got && got.name);
    ok(!log.join(' ').includes('Sales Aug 26'), 'it is not even listed as a candidate');
}

console.log('== It refuses rather than guessing ==');
{
    const got = find([['Net Profit Sep 26', '2026-09'],
                      ['NET PROFIT TEMPLATE', '2026-08'], ['Net Profit copy', '2026-08']]);
    ok(got === null, 'two tabs claiming August -> null, not a coin toss');
    ok(/refusing to guess/.test(log.join(' ')), 'and the log says why');
}
{
    const got = find([['Net Profit Sep 26', '2026-09'], ['NET PROFIT TEMPLATE', null]]);
    ok(got === null, 'a tab with no month header is not assumed to be last month');
}
{
    const got = find([['Net Profit Sep 26', '2026-09'], ['NET PROFIT TEMPLATE', '2026-07']]);
    ok(got === null, 'a tab holding JULY is not last month either');
}
{
    const got = find([['Net Profit Sep 26', '2026-09']]);
    ok(got === null, 'nothing but the current month -> null (Shopify, correctly)');
}
{
    const got = find([]);
    ok(got === null, 'an empty workbook -> null, not a throw');
}

console.log('== The log is the diagnosis ==');
{
    find([['Net Profit Sep 26', '2026-09'], ['NET PROFIT TEMPLATE', null]]);
    const line = log.find(l => l.includes('Net Profit tabs on the workbook'));
    ok(!!line, 'every candidate is listed');
    ok(line.includes('Net Profit Sep 26 [2026-09]'), 'with the month it claims', line);
    ok(line.includes('NET PROFIT TEMPLATE [no month header]'), 'and says when it claims none', line);
}

console.log('== Named months resolve the way the workbook names them ==');
ok(_npTabName('2026-08') === 'Net Profit Aug 26', 'August', _npTabName('2026-08'));
ok(_npTabName('2026-09') === 'Net Profit Sep 26', 'September', _npTabName('2026-09'));
ok(_npTabName('2026-12') === 'Net Profit Dec 26', 'December', _npTabName('2026-12'));

console.log(fails ? '\n' + fails + ' FAILED' : '\nall pass');
process.exit(fails ? 1 : 0);
