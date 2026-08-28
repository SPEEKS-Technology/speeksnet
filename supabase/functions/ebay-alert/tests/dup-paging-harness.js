// Harness for the duplicate scan's paging, added 2026-08-28 after the OVL
// truncation alert. The old code read ONE page of 250 and warned if there was
// more; the risk in paging is the opposite of the risk in not paging, so these
// assertions are mostly about the loop terminating.
//
// Runs the REAL source: the two functions are lifted out of index.ts by name so
// this cannot drift into testing a copy.
const fs = require('fs');
const path = require('path').join(__dirname, '..', 'index.ts');
const src = fs.readFileSync(path, 'utf8');

function lift(name, kind) {
  const start = src.indexOf(kind + ' ' + name);
  if (start < 0) throw new Error('cannot find ' + name + ' in index.ts');
  // Walk braces from the first { after the signature.
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

const DUP_PAGE = Number(src.match(/const DUP_PAGE\s*=\s*(\d+)/)[1]);
const DUP_MAX_PAGES = Number(src.match(/const DUP_MAX_PAGES\s*=\s*(\d+)/)[1]);
const DUP_ORDERS_QUERY = src.match(/const DUP_ORDERS_QUERY = `([\s\S]*?)`;/)[1];
const SHOPIFY_API_VERSION = '2026-07';

// Strip the TypeScript that plain node cannot parse.
const strip = s => s
  .replace(/:\s*Array<\{[^}]*\}>\s*=/g, ' =')
  .replace(/:\s*string \| null\s*=/g, ' =')
  .replace(/\(shop: string, token: string, sinceDay: string\)/, '(shop, token, sinceDay)')
  .replace(/\(n: any\)/, '(n)')
  .replace(/ as any\[\]/g, '')
  .replace(/\((t|a|e|sum)(: any)?(, t: any)?\)\s*=>/g, (m) => m.replace(/: any/g, ''))
  .replace(/\(sum: number, t: any\)/g, '(sum, t)');

eval(strip(lift('shopifyEbayOrders', 'async function')));
eval(strip(lift('mapDupOrder', 'function')));

// ---------------------------------------------------------------------------
let calls = [];
function mockShopify(totalPages, orderMaker) {
  calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.variables);
    const page = calls.length;
    const edges = Array.from({ length: DUP_PAGE }, (_, k) => ({
      node: orderMaker(`#P${page}-${k}`, page),
    }));
    return {
      ok: true,
      json: async () => ({
        data: { orders: { edges, pageInfo: { hasNextPage: page < totalPages, endCursor: 'cur' + page } } },
      }),
    };
  };
}

const plain = (name) => ({
  id: 'gid://shopify/Order/' + name.replace(/\D/g, ''),
  name,
  cancelledAt: null,
  totalPriceSet: { shopMoney: { amount: '100.00' } },
  totalRefundedSet: { shopMoney: { amount: '0.00' } },
  transactions: [{ kind: 'SALE', status: 'SUCCESS', amountSet: { shopMoney: { amount: '100.00' } } }],
  customAttributes: [{ key: 'eBay Order Id', value: '01-00000-0000' + name.length }],
});

let fail = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fail++; };

(async () => {
  console.log(`=== constants: DUP_PAGE=${DUP_PAGE}, DUP_MAX_PAGES=${DUP_MAX_PAGES} ===`);
  check(DUP_PAGE === 250, 'page size is Shopify\'s maximum');
  check(DUP_MAX_PAGES > 1, 'more than one page is allowed at all — the whole point of the fix');

  console.log('\n=== one page, no more to come (the ordinary store) ===');
  mockShopify(1, plain);
  let r = await shopifyEbayOrders('s', 't', '2026-08-23');
  check(calls.length === 1, `one request (got ${calls.length})`);
  check(r.orders.length === DUP_PAGE, `${DUP_PAGE} orders returned`);
  check(r.truncated === false, 'not reported as truncated');
  check(calls[0].after === null, 'first request sends no cursor');
  check(/tag:eBay created_at:>=2026-08-23/.test(calls[0].q), 'window passed as a variable, not interpolated into the query');

  console.log('\n=== three pages (the OVL case, which used to stop at one) ===');
  mockShopify(3, plain);
  r = await shopifyEbayOrders('s', 't', '2026-08-23');
  check(calls.length === 3, `paged three times (got ${calls.length})`);
  check(r.orders.length === DUP_PAGE * 3, `all ${DUP_PAGE * 3} orders collected`);
  check(r.truncated === false, 'NOT truncated — it read everything');
  check(calls[1].after === 'cur1' && calls[2].after === 'cur2', 'cursor threaded from each page to the next');

  console.log('\n=== a store past the runaway guard ===');
  mockShopify(DUP_MAX_PAGES + 5, plain);
  r = await shopifyEbayOrders('s', 't', '2026-08-23');
  check(calls.length === DUP_MAX_PAGES, `stopped at ${DUP_MAX_PAGES} pages (got ${calls.length})`);
  check(r.truncated === true, 'reported truncated so the alert still fires');
  check(r.orders.length === DUP_PAGE * DUP_MAX_PAGES, 'kept everything it did read');

  console.log('\n=== hasNextPage false on a FULL page must still stop ===');
  mockShopify(1, plain);
  r = await shopifyEbayOrders('s', 't', '2026-08-23');
  check(calls.length === 1, 'a full page with no next page does not loop');

  console.log('\n=== the cleaned-up test still reads the PAYMENT, not the total ===');
  // The new-MC shape: total carries tax, the payment does not, and a full
  // reversal of the payment can never reach the total.
  const mcRefunded = mapDupOrder({
    id: 'gid://shopify/Order/9', name: '#MC-1', cancelledAt: null,
    totalPriceSet: { shopMoney: { amount: '455.79' } },
    totalRefundedSet: { shopMoney: { amount: '429.99' } },
    transactions: [{ kind: 'SALE', status: 'SUCCESS', amountSet: { shopMoney: { amount: '429.99' } } }],
    customAttributes: [{ key: 'eBay Order Id', value: '01-1' }],
  });
  check(mcRefunded.refunded === true, 'a fully-reversed new-MC copy counts as cleaned up');
  check(mcRefunded.id === '9', 'gid prefix stripped');
  check(mcRefunded.ebayId === '01-1', 'eBay order id read off the custom attribute');

  const stillOwed = mapDupOrder({
    id: 'gid://shopify/Order/10', name: '#MC-2', cancelledAt: null,
    totalPriceSet: { shopMoney: { amount: '455.79' } },
    totalRefundedSet: { shopMoney: { amount: '100.00' } },
    transactions: [{ kind: 'SALE', status: 'SUCCESS', amountSet: { shopMoney: { amount: '429.99' } } }],
    customAttributes: [],
  });
  check(stillOwed.refunded === false, 'a partly-refunded copy is NOT cleaned up');
  check(stillOwed.ebayId === null, 'no attribute reads as null, not undefined');

  console.log('\n=== an HTTP failure still throws rather than reading as "no duplicates" ===');
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  let threw = false;
  try { await shopifyEbayOrders('s', 't', '2026-08-23'); } catch (e) { threw = /503/.test(e.message); }
  check(threw, 'HTTP 503 throws, naming the status');

  global.fetch = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'bad field' }] }) });
  threw = false;
  try { await shopifyEbayOrders('s', 't', '2026-08-23'); } catch (e) { threw = /bad field/.test(e.message); }
  check(threw, 'a 200-with-errors throws too — the silent false negative');

  console.log('\n=== the query itself ===');
  check(/\$after: String/.test(DUP_ORDERS_QUERY) && /after: \$after/.test(DUP_ORDERS_QUERY), 'cursor is a GraphQL variable');
  check(/endCursor/.test(DUP_ORDERS_QUERY), 'endCursor requested, or paging cannot work');
  check(/hasNextPage/.test(DUP_ORDERS_QUERY), 'hasNextPage still requested');

  console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed');
  process.exit(fail ? 1 : 0);
})();
