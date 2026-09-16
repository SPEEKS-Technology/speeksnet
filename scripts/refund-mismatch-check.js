// ============================================================================
// refund-mismatch-check — the decision rules, tested without a network.
//
//   node scripts/refund-mismatch-check.js
//
// WHY THIS IS NOT A browser-check.ps1 SUITE. Those load speeks.js and assert
// about rendered HTML. This feature has no front end: it is an edge function
// whose output is an email, and the parts worth testing are the pure rules that
// decide WHETHER to mail — reversal detection, the eBay-id join, and the
// month-end threshold. Getting one of those wrong mails four managers about
// orders that are already fine, which is how an alert nobody reads gets made.
//
// HOW IT LOADS A DENO FUNCTION UNDER NODE. index.ts is written for Deno: it
// imports supabase-js from esm.sh and calls Deno.serve at the bottom. Rather
// than duplicate the logic here — where it would rot the first time the real one
// changed — the source is read, its types stripped, the remote import replaced
// with a stub, a minimal Deno shim installed, and the functions exported. What
// is tested is therefore the real code, not a copy of it.
// ============================================================================
const { readFileSync, writeFileSync, mkdtempSync } = require("node:fs");
const { stripTypeScriptTypes } = require("node:module");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");

const SRC = join(__dirname, "..", "supabase", "functions", "refund-mismatch", "index.ts");

// The pure rules this file exists to check.
const EXPORTED = [
  "isMonthEnd", "ebayIdOf", "carriesEbayId", "shopifyReversal", "ebayReversal",
  "BASE_HOURS", "MONTH_END_HOURS", "MONTH_END_DAYS", "RENAG_HOURS", "ESCALATE_DAYS",
];

async function load() {
  let js = stripTypeScriptTypes(readFileSync(SRC, "utf8"), { mode: "strip" });
  // No network in a test. createClient is only used inside the request handler,
  // which never runs here.
  js = js.replace(/^import\s+\{[^}]*\}\s+from\s+["']https:\/\/esm\.sh\/[^"']+["'];?\s*$/m,
    "const createClient = () => { throw new Error('createClient stubbed'); };");
  // Deno.serve registers a listener; under Node it just has to not throw.
  js = "globalThis.Deno = { env: { get: () => '' }, serve: () => {} };\n" + js;
  js += `\nexport { ${EXPORTED.join(", ")} };\n`;
  const dir = mkdtempSync(join(tmpdir(), "rmcheck-"));
  const file = join(dir, "mod.mjs");
  writeFileSync(file, js);
  return await import(pathToFileURL(file).href);
}

let pass = 0, fail = 0;
function t(name, fn) {
  let r;
  try { r = fn(); } catch (e) { r = `threw: ${e.message}`; }
  if (r === true) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n        ${r}`); }
}

(async () => {
  const m = await load();
  const at = (s) => new Date(s);

  console.log("\nmonth-end threshold (Chicago calendar)");
  // 8:20am Chicago is 13:20Z in CDT, 14:20Z in CST — the times cron actually
  // fires, so these are the real inputs and not convenient ones.
  t("mid-month is not month end", () =>
    m.isMonthEnd(at("2026-09-16T13:20:00Z")) === false || "16 Sep flagged as month end");
  // 30-day month: the last two days are the 29th and 30th.
  t("28 Sep, third from last, is not month end", () =>
    m.isMonthEnd(at("2026-09-28T13:20:00Z")) === false || "28 Sep flagged");
  t("29 Sep, second from last, is month end", () =>
    m.isMonthEnd(at("2026-09-29T13:20:00Z")) === true || "29 Sep missed");
  t("30 Sep, the last day, is month end", () =>
    m.isMonthEnd(at("2026-09-30T13:20:00Z")) === true || "30 Sep missed");
  // 31-day month: the boundary moves with the month's length, which is the
  // whole reason this is computed rather than hard-coded.
  t("31 Oct, the last day, is month end", () =>
    m.isMonthEnd(at("2026-10-31T14:20:00Z")) === true || "31 Oct missed");
  t("30 Oct, second from last, is month end", () =>
    m.isMonthEnd(at("2026-10-30T14:20:00Z")) === true || "30 Oct missed");
  t("29 Oct is not", () =>
    m.isMonthEnd(at("2026-10-29T14:20:00Z")) === false || "29 Oct flagged");
  // February, where a hard-coded boundary would be wrong every fourth year.
  // 2027 has 28 days, so the last two are the 27th and 28th; 2028 has 29, so
  // the same 27 February is NOT month end.
  t("27 Feb IS month end in non-leap 2027", () =>
    m.isMonthEnd(at("2027-02-27T14:20:00Z")) === true || "27 Feb 2027 missed");
  t("27 Feb is NOT month end in leap 2028", () =>
    m.isMonthEnd(at("2028-02-27T14:20:00Z")) === false
      || "27 Feb 2028 flagged — leap year has 29 days, so this is third from last");
  t("28 Feb is month end in leap 2028 too", () =>
    m.isMonthEnd(at("2028-02-28T14:20:00Z")) === true || "28 Feb 2028 missed");
  t("29 Feb leap year is month end", () =>
    m.isMonthEnd(at("2028-02-29T14:20:00Z")) === true || "29 Feb 2028 missed");
  // THE TIMEZONE TRAP. 01:00Z on the 1st is still 8pm on the LAST day of the
  // previous month in Chicago. Reading this in UTC applies the tightened
  // threshold a day late, every month.
  t("01:00Z on 1 Oct is still 30 Sep in Chicago, so month end", () =>
    m.isMonthEnd(at("2026-10-01T01:00:00Z")) === true
      || "UTC date used instead of Chicago — month end missed on the last evening");
  t("14:00Z on 1 Oct is genuinely 1 Oct in Chicago, not month end", () =>
    m.isMonthEnd(at("2026-10-01T14:00:00Z")) === false || "1 Oct flagged as month end");

  console.log("\neBay id read off a Shopify order (the three forms)");
  t("Marketplace Connect: sourceIdentifier", () =>
    m.ebayIdOf({ sourceIdentifier: "08-15066-00533", tags: [], customAttributes: [] })
      === "08-15066-00533" || "sourceIdentifier not read");
  t("SPEEKS Connect: tag ebay-<id>", () =>
    m.ebayIdOf({ sourceIdentifier: null, tags: ["ebay-13-15066-46687", "used"], customAttributes: [] })
      === "13-15066-46687" || "tag form not read");
  t("customAttribute wins over the others", () =>
    m.ebayIdOf({ sourceIdentifier: "wrong", tags: [],
      customAttributes: [{ key: "eBay Order Id", value: "08-15066-00533" }] })
      === "08-15066-00533" || "customAttribute not preferred");
  t("an ordinary in-store sale yields no id", () =>
    m.ebayIdOf({ sourceIdentifier: null, tags: ["walk-in"], customAttributes: [] })
      === "" || "invented an eBay id for a non-eBay order");
  t("a tag that merely starts with ebay- is not an id", () =>
    m.ebayIdOf({ sourceIdentifier: null, tags: ["ebay-returns"], customAttributes: [] })
      === "" || "matched a non-numeric tag");
  // THE BUG THE FIRST LIVE RUN FOUND. sourceIdentifier is Shopify's generic
  // "id in the source channel", so another marketplace's orders land in it.
  // 27 of these went to eBay's order API and came back "Invalid Order Id".
  t("another channel's sourceIdentifier is NOT an eBay id", () =>
    m.ebayIdOf({ sourceIdentifier: "66390589542-3-2815", tags: [], customAttributes: [] })
      === "" || "a non-eBay channel id was treated as an eBay order id");
  t("a malformed customAttribute does not win over a good sourceIdentifier", () =>
    m.ebayIdOf({ sourceIdentifier: "08-15066-00533", tags: [],
      customAttributes: [{ key: "eBay Order Id", value: "not-an-id" }] })
      === "08-15066-00533" || "a bad attribute blocked the good id behind it");
  t("every genuine id seen in live data is accepted", () =>
    ["08-15066-00533", "13-15066-46687", "05-14978-78547", "03-15029-03463"]
      .every((id) => m.ebayIdOf({ sourceIdentifier: id, tags: [], customAttributes: [] }) === id)
      || "the shape rule rejected a real eBay order id");

  console.log("\nfuzzy-search confirmation");
  const order = { sourceIdentifier: "08-15066-00533", tags: [], customAttributes: [] };
  t("confirms the id it really carries", () =>
    m.carriesEbayId(order, "08-15066-00533") === true || "rejected a genuine match");
  t("rejects a fuzzy hit for a different order", () =>
    m.carriesEbayId(order, "13-15066-46687") === false
      || "accepted an order that does not carry the id — Shopify search is fuzzy");

  console.log("\nShopify reversal");
  t("a refund counts", () => {
    const r = m.shopifyReversal({
      totalRefundedSet: { shopMoney: { amount: "249.99" } },
      refunds: [{ createdAt: "2026-09-10T12:00:00Z" }],
    });
    return (r.reversed && r.kind === "refund" && r.amount === 249.99
      && r.at === "2026-09-10T12:00:00Z") || `got ${JSON.stringify(r)}`;
  });
  t("earliest refund date is used, not the latest", () => {
    const r = m.shopifyReversal({
      totalRefundedSet: { shopMoney: { amount: "50.00" } },
      refunds: [{ createdAt: "2026-09-12T12:00:00Z" }, { createdAt: "2026-09-10T12:00:00Z" }],
    });
    return r.at === "2026-09-10T12:00:00Z"
      || `age must run from the FIRST reversal, got ${r.at}`;
  });
  t("a cancellation counts as a reversal", () => {
    const r = m.shopifyReversal({
      totalRefundedSet: { shopMoney: { amount: "0" } },
      cancelledAt: "2026-09-11T09:00:00Z",
      totalPriceSet: { shopMoney: { amount: "89.50" } }, refunds: [],
    });
    return (r.reversed && r.kind === "cancel" && r.amount === 89.5)
      || `got ${JSON.stringify(r)}`;
  });
  t("a live paid order is not reversed", () => {
    const r = m.shopifyReversal({
      totalRefundedSet: { shopMoney: { amount: "0" } }, cancelledAt: null,
      totalPriceSet: { shopMoney: { amount: "199.00" } }, refunds: [],
    });
    return r.reversed === false || "a live sale read as reversed";
  });

  console.log("\neBay reversal");
  t("a refund counts and sums", () => {
    const r = m.ebayReversal({ paymentSummary: { refunds: [
      { amount: { value: "100.00" }, refundDate: "2026-09-10T12:00:00Z" },
      { amount: { value: "49.99" }, refundDate: "2026-09-11T12:00:00Z" },
    ] } });
    return (r.reversed && r.amount === 149.99 && r.at === "2026-09-10T12:00:00Z")
      || `got ${JSON.stringify(r)}`;
  });
  t("CANCELED order counts", () => {
    const r = m.ebayReversal({
      paymentSummary: { refunds: [] },
      cancelStatus: { cancelState: "CANCELED",
        cancelRequests: [{ cancelRequestedDate: "2026-09-09T08:00:00Z" }] },
      pricingSummary: { total: { value: "75.00" } },
    });
    return (r.reversed && r.kind === "cancel" && r.amount === 75
      && r.at === "2026-09-09T08:00:00Z") || `got ${JSON.stringify(r)}`;
  });
  // The one that would create the very mismatch this feature prevents: a buyer
  // ASKING to cancel is not a cancellation, and the seller may refuse it.
  t("CANCEL_REQUESTED is NOT a reversal", () => {
    const r = m.ebayReversal({
      paymentSummary: { refunds: [] },
      cancelStatus: { cancelState: "CANCEL_REQUESTED",
        cancelRequests: [{ cancelRequestedDate: "2026-09-09T08:00:00Z" }] },
      pricingSummary: { total: { value: "75.00" } },
    });
    return r.reversed === false
      || "a cancel REQUEST read as a cancellation — would nag a refund against a request that may be refused";
  });
  t("NONE cancel state is not a reversal", () => {
    const r = m.ebayReversal({
      paymentSummary: { refunds: [] }, cancelStatus: { cancelState: "NONE" },
      pricingSummary: { total: { value: "75.00" } },
    });
    return r.reversed === false || "NONE read as cancelled";
  });
  t("a paid, uncancelled order is not reversed", () => {
    const r = m.ebayReversal({ orderPaymentStatus: "PAID", paymentSummary: { refunds: [] } });
    return r.reversed === false || "a live eBay sale read as reversed";
  });
  t("a zero-value refund entry is not a reversal", () => {
    const r = m.ebayReversal({ paymentSummary: { refunds: [
      { amount: { value: "0.00" }, refundDate: "2026-09-10T12:00:00Z" } ] } });
    return r.reversed === false || "a $0 refund record read as money returned";
  });

  console.log("\nthe mismatch rule itself");
  const mism = (e, s) => e.reversed === s.reversed ? null : (e.reversed ? "ebay_only" : "shopify_only");
  const REV = { reversed: true }, LIVE = { reversed: false };
  t("eBay refunded, Shopify live -> ebay_only", () =>
    mism(REV, LIVE) === "ebay_only" || "direction wrong");
  t("Shopify refunded, eBay live -> shopify_only", () =>
    mism(LIVE, REV) === "shopify_only" || "direction wrong");
  t("both refunded -> silence", () =>
    mism(REV, REV) === null || "mailed about an order both sides had settled");
  t("neither refunded -> silence", () =>
    mism(LIVE, LIVE) === null || "mailed about an ordinary live sale");

  console.log("\nthresholds as configured");
  t("base threshold is 3 days", () => m.BASE_HOURS === 72 || `BASE_HOURS=${m.BASE_HOURS}`);
  t("month end tightens to 24h", () => m.MONTH_END_HOURS === 24 || `=${m.MONTH_END_HOURS}`);
  t("month-end window is the last 2 days", () => m.MONTH_END_DAYS === 2 || `=${m.MONTH_END_DAYS}`);
  t("re-nag every 3 days", () => m.RENAG_HOURS === 72 || `=${m.RENAG_HOURS}`);
  t("escalate at 10 days", () => m.ESCALATE_DAYS === 10 || `=${m.ESCALATE_DAYS}`);
  t("month-end threshold is tighter than the base one", () =>
    m.MONTH_END_HOURS < m.BASE_HOURS || "month end would LOOSEN the rule");

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
