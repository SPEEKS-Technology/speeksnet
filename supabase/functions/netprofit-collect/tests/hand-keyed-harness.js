// findHandKeyed — pairing an eBay sale that never reached Shopify with the
// draft-order invoice the store recovered it through. Added 2026-09-18.
//
// WHY THIS EXISTS. Marketplace Connect imports orders only for listings IT
// created, so a sale on one of our own SPEEKS Connect listings never crosses
// into Shopify at all. The `not_yet_imported` alert read that as a stalled
// connector and mailed "go and check Marketplace Connect" on every pass, twice
// a day, forever — four times about OVL 18-15155-99419 before anyone looked.
//
// The risk in the FIX is the opposite of the risk in the bug: a matcher that
// pairs the wrong draft moves real money onto the wrong day and silences the
// alert that would have said so. So most of what is asserted here is the
// matcher REFUSING — the coincidence, the second claimant, the draft dated
// before the sale. sep-fix.gs records why that matters: this same $349.99 is
// also the total of three unrelated refunded OVL orders.
//
// Runs the REAL source: findHandKeyed is lifted out of index.ts by name, the
// same way dup-paging-harness.js does, so this cannot drift into testing a copy.
// The drafts are OVL's genuine September ones, read from orders-peek on
// 2026-09-18 and trimmed to the fields the query asks for.
//
//   node supabase/functions/netprofit-collect/tests/hand-keyed-harness.js
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'index.ts'), 'utf8');

const sig = '    async function findHandKeyed(';
const start = src.indexOf(sig);
if (start < 0) throw new Error('cannot find findHandKeyed in index.ts');
let body = (() => {
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces after findHandKeyed');
})();
body = require('module').stripTypeScriptTypes(body, { mode: 'strip' });

// ── the scope findHandKeyed closes over, with the real semantics ────────────
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago',
  year: 'numeric', month: '2-digit', day: '2-digit' });
const chicagoDay = iso => DAY.format(new Date(iso));
const ebayIdsOf = (o) => {
  const ids = [];
  for (const ca of o.customAttributes || []) {
    if (String(ca.key).trim().toLowerCase() !== 'ebay order id') continue;
    const id = String(ca.value || '').trim();
    if (id) ids.push(id);
  }
  const srcId = String(o.sourceIdentifier || '').trim();
  if (/^\d{2}-\d{5}-\d{5}$/.test(srcId)) ids.push(srcId);
  return ids;
};
const scanTo = '2026-10-01';
// Read out of the source too, so the window the test assumes is the window that
// ships even if someone retunes it.
const HAND_KEYED_DAYS = Number(src.match(/const HAND_KEYED_DAYS = (\d+);/)[1]);
let EBAY_ACCOUNTED = {};
const store = 'OVL';

// OVL's real draft orders, 2026-09-01 to 2026-09-17.
const draft = (name, created, subtotal, total) => ({
  name, createdAt: created, processedAt: created,
  sourceIdentifier: null, customAttributes: [],
  currentSubtotalPriceSet: { shopMoney: { amount: String(subtotal) } },
  totalPriceSet: { shopMoney: { amount: String(total === undefined ? subtotal : total) } },
});
const REAL_DRAFTS = [
  draft('#KS01-14526', '2026-09-01T14:37:47Z', 129.99),
  draft('#KS01-14545', '2026-09-01T21:37:43Z', 36.99),
  draft('#KS01-14562', '2026-09-02T15:32:50Z', 0),
  draft('#KS01-14564', '2026-09-02T16:09:01Z', 229.99),
  draft('#KS01-14575', '2026-09-02T19:44:12Z', 199.99),
  draft('#KS01-14581', '2026-09-02T21:10:33Z', 29.99),
  draft('#KS01-14625', '2026-09-04T15:21:09Z', 64.99),
  draft('#KS01-14628', '2026-09-04T16:44:55Z', 44.99),
  draft('#KS01-14631', '2026-09-04T18:02:41Z', 224.99),
  draft('#KS01-14695', '2026-09-07T17:55:30Z', 219.99),
  // The MacBook Pro — the recovery of eBay 18-15155-99419, sold Sep 15.
  draft('#KS01-14917', '2026-09-16T15:37:32Z', 349.99),
  // The projector, discounted off a 2,999.99 line.
  draft('#KS01-14919', '2026-09-16T16:48:39Z', 2749.99),
];

let served = REAL_DRAFTS;
const gql = async () => ({ data: { orders: {
  pageInfo: { hasNextPage: false, endCursor: null },
  edges: served.map(node => ({ node })),
} } });

const findHandKeyed = eval('(async function (list) {'
  + body.slice(body.indexOf('{') + 1, body.lastIndexOf('}')) + '})');

let fails = 0;
const ok = (c, l, g) => {
  console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
  if (!c) fails++;
};

(async () => {
  console.log('\nfindHandKeyed, against OVL\'s real September draft orders');

  console.log('\n1. The case that found this — OVL 18-15155-99419');
  {
    // $349.99, sold on eBay Sep 15, invoiced as #KS01-14917 on Sep 16. Both
    // readings of the gross are offered exactly as the collector offers them.
    const r = await findHandKeyed([{ oid: '18-15155-99419', soldDay: '2026-09-15',
      fee: 23.55, gross: [349.99, 349.99] }]);
    const hit = r['18-15155-99419'];
    ok(hit && hit.name === '#KS01-14917', 'paired with the draft that recovered it',
      hit && hit.name);
    ok(hit && hit.day === '2026-09-16', 'and dated to the day the invoice was paid',
      hit && hit.day);
  }

  console.log('\n2. Either reading of the gross is enough');
  {
    const r = await findHandKeyed([{ oid: '18-15155-99419', soldDay: '2026-09-15',
      fee: 23.55, gross: [326.44, 349.99] }]);
    ok(r['18-15155-99419'], 'net-plus-fee finds it when the basis does not');
    const none = await findHandKeyed([{ oid: '18-15155-99419', soldDay: '2026-09-15',
      fee: 23.55, gross: [326.44, 300.00] }]);
    ok(!none['18-15155-99419'], 'and neither reading matching is simply no match');
  }

  console.log('\n3. The refusals — every one of these would move money if it fired');
  {
    // THE COINCIDENCE. sep-fix.gs: $349.99 equals three unrelated refunded OVL
    // totals. A second candidate is an unanswered question, not a coin toss.
    served = REAL_DRAFTS.concat([draft('#KS01-99999', '2026-09-16T18:00:00Z', 349.99)]);
    let r = await findHandKeyed([{ oid: '18-15155-99419', soldDay: '2026-09-15',
      fee: 23.55, gross: [349.99] }]);
    ok(!r['18-15155-99419'], 'two drafts for the same money: no match, it stays an alert');
    served = REAL_DRAFTS;

    r = await findHandKeyed([{ oid: '20-00000-00001', soldDay: '2026-09-01',
      fee: 1, gross: [2749.99] }]);
    ok(!r['20-00000-00001'], 'a draft ' + (HAND_KEYED_DAYS + 1)
      + '+ days after the sale is a different sale');

    r = await findHandKeyed([{ oid: '20-00000-00002', soldDay: '2026-09-17',
      fee: 1, gross: [349.99] }]);
    ok(!r['20-00000-00002'], 'a draft dated BEFORE the sale is never its recovery');

    // One draft, two claimants: the first takes it, the second stays an alert.
    r = await findHandKeyed([
      { oid: '20-00000-00003', soldDay: '2026-09-15', fee: 1, gross: [349.99] },
      { oid: '20-00000-00004', soldDay: '2026-09-15', fee: 1, gross: [349.99] }]);
    ok(Object.keys(r).length === 1, 'one draft is never claimed twice',
      'matched ' + Object.keys(r).length);

    // A draft carrying an eBay id joined through the ordinary path already.
    served = [Object.assign(draft('#KS01-14917', '2026-09-16T15:37:32Z', 349.99),
      { sourceIdentifier: '99-99999-99999' })];
    r = await findHandKeyed([{ oid: '18-15155-99419', soldDay: '2026-09-15',
      fee: 23.55, gross: [349.99] }]);
    ok(!r['18-15155-99419'], 'a draft with an eBay id on it is another order');
    served = REAL_DRAFTS;
  }

  console.log('\n4. The manual list overrides the matcher');
  {
    EBAY_ACCOUNTED = { OVL: { '18-15155-99419': { shopify_order: '#KS01-00001',
      booked_day: '2026-09-20', note: 'keyed at a different figure' } } };
    const r = await findHandKeyed([{ oid: '18-15155-99419', soldDay: '2026-09-15',
      fee: 23.55, gross: [349.99] }]);
    ok(r['18-15155-99419'] && r['18-15155-99419'].name === '#KS01-00001',
      'EBAY_ACCOUNTED wins — it exists for what the matcher cannot see',
      r['18-15155-99419'] && r['18-15155-99419'].name);
    ok(/EBAY_ACCOUNTED/.test(r['18-15155-99419'].how), 'and the reason travels with it',
      r['18-15155-99419'].how);
    EBAY_ACCOUNTED = {};
  }

  console.log('\n5. No orphans, no Shopify read');
  {
    // The ordinary pass — every eBay sale accounted for — must not pay a
    // Shopify call for this check, so the stub is rigged to fail if it is hit.
    let asked = false;
    served = new Proxy([], { get() { asked = true; return undefined; } });
    const r = await findHandKeyed([]);
    ok(Object.keys(r).length === 0 && !asked, 'an empty set costs nothing and matches nothing');
    served = REAL_DRAFTS;
  }

  console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
