// Enumerate the columns of a ShopifyQL dataset.
//
// ⚠️ THE BATCH-DIFF TRICK DOES NOT WORK, whatever an earlier note claimed.
// `SHOW a,b,c` does NOT report every invalid name — parseErrors carries exactly
// ONE entry, the first column it could not resolve:
//     ["Column Not Found: Column 'zzz_bogus_col' not found"]
// So every name after the first failure is simply unreached, and treating
// "not mentioned in the error" as "valid" marks real columns invalid and vice
// versa. Positive control caught it: shipping_price came back "invalid" in a
// batch sweep, having been queried successfully minutes earlier.
//
// One column per request. Valid iff parseErrors is empty AND tableData came
// back — that pair also separates a real answer from a throttled one, which
// returns neither.
const fs = require('fs');
const SP = process.env.SP;
const SECRET = 'sp33ks-sync-k3y-2026-x9mq';
const BASE = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/netprofit-probe';
const DATASET = process.argv[2] || 'shipping_labels';
const STORE = process.argv[3] || 'OVL';

const CANDIDATES = [
  // known-good positive controls — these MUST come back valid or the run is void
  'order_name', 'shipping_labels', 'shipping_price',
  // known-bad negative control
  'zzz_not_a_column',
  // what the built-in "Shipping labels by order" report would need
  'shipping_label_cost', 'label_cost', 'shipping_cost', 'cost', 'total_cost',
  'postage', 'postage_cost', 'postage_amount', 'shipping_label_price',
  'label_price', 'price', 'amount', 'total_amount', 'charged_amount',
  'shipping_label_amount', 'shipping_label_charge', 'purchase_price',
  'discounted_price', 'shipping_label_discounted_price', 'net_price',
  'insurance', 'insurance_cost', 'insurance_price', 'shipping_insurance',
  'net_cost', 'gross_cost', 'label_fee', 'shipping_fee', 'carrier_cost',
  'rate', 'shipping_rate', 'billed_amount', 'shipping_labels_cost',
  'shipping_label_total', 'label_total', 'refunded_amount', 'net_amount',
  'shipping_label_net_amount', 'shipping_label_gross_amount',
  // shape / dimensions
  'order_id', 'shipping_carrier', 'shipping_service', 'destination_country',
  'origin_country', 'package_type', 'day', 'week', 'month',
  'created_at', 'purchased_at', 'weight', 'billing_type', 'fulfillment_id',
  'voided', 'is_return', 'label_type', 'tracking_number', 'tracking_company',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ask(col) {
  const ql = `FROM ${DATASET} SHOW ${col} SINCE 2026-07-01 UNTIL 2026-07-31`;
  const url = `${BASE}?secret=${SECRET}&store=${STORE}&ql=${encodeURIComponent(ql)}`;
  const r = await fetch(url);
  const d = await r.json().catch(() => null);
  const q = d?.data?.shopifyqlQuery;
  return { errs: q?.parseErrors ?? null, table: !!q?.tableData, raw: d };
}

(async () => {
  const valid = [], invalid = [], unresolved = [];
  for (const c of CANDIDATES) {
    let got = null;
    for (let t = 1; t <= 4; t++) {
      const r = await ask(c);
      // A real reply is either "no errors AND a table" or "an error naming it".
      if (r.errs && r.errs.length) { got = { ok: false, why: r.errs[0] }; break; }
      if (r.errs && r.errs.length === 0 && r.table) { got = { ok: true }; break; }
      await sleep(2000 * t);
    }
    if (!got) { unresolved.push(c); process.stdout.write('?'); }
    else if (got.ok) { valid.push(c); process.stdout.write('+'); }
    else { invalid.push(c); process.stdout.write('.'); }
    await sleep(350);
  }
  console.log('\n\ndataset: ' + DATASET + '   store: ' + STORE);
  console.log('\nVALID (' + valid.length + '):');
  valid.forEach(v => console.log('   ' + v));
  if (unresolved.length) console.log('\nUNRESOLVED (throttled): ' + unresolved.join(', '));
  console.log('\ncontrols  order_name=' + valid.includes('order_name')
    + '  shipping_price=' + valid.includes('shipping_price')
    + '  zzz_not_a_column=' + invalid.includes('zzz_not_a_column')
    + (valid.includes('order_name') && valid.includes('shipping_price')
       && invalid.includes('zzz_not_a_column') ? '   -> RUN IS TRUSTWORTHY' : '   -> RUN IS VOID'));
  fs.writeFileSync(SP + '/cols-' + DATASET + '.json', JSON.stringify({ valid, invalid, unresolved }, null, 1));
})();
