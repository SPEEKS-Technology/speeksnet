// ============================================================================
// refund-mismatch — an order reversed on ONE marketplace and not the other.
//
//   ?secret=<ops>&store=ALL          every store (what cron calls)
//   ?secret=<ops>&store=OVL          one store
//     &dryRun=1                      evaluate everything, send nothing
//     &html=1                        with dryRun, render the mail instead of JSON
//     &to=addr                       send every mail to one address instead
//     &days=N                        override the discovery window
//     &sample=1                      render the mail from invented rows
//     &oversight=1                   with sample or dryRun+html, the leadership version
//
// WHY THIS EXISTS. Every month the CFO mails a list of order numbers refunded or
// cancelled on eBay but not Shopify, or the reverse. Each is a hole in the books:
// one system says we kept the money, the other says we gave it back. By the time
// the list arrives the period is closed. This finds the same thing in three days
// instead of thirty, and tells the manager who can fix it.
//
// ----------------------------------------------------------------------------
// ⚠️ THIS FUNCTION NEVER ISSUES A REFUND, AND THAT IS ENFORCED, NOT INTENDED.
//
// The business constraint, set 2026-09-16: the tool alerts, a human refunds —
// on both sites, by hand. The reasons it is enforced structurally rather than
// left to good behaviour are specific to this repo:
//
//   1. `refund-apply` in this same project DOES issue real Shopify refunds. This
//      function does not call it, import from it, or share a code path with it.
//   2. eBay's refund endpoint is a SIBLING of the order read:
//        read   GET  /sell/fulfillment/v1/order/{id}
//        refund POST /sell/fulfillment/v1/order/{id}/issue_refund
//      Same API, same path prefix, one verb away. So `ebayGet` below checks the
//      URL against anchored patterns that no extra path segment can ride along
//      on, AND hard-codes method GET as an independent second guard. Same
//      discipline as ebay-refund-reprobe and dupe-order-trace.
//   3. Shopify reads are GraphQL, which is POST even to read — so "GET only"
//      proves nothing there. Instead `shopifyQuery` refuses any document
//      containing `mutation`. refundCreate/orderCancel cannot be expressed
//      without it.
//
// The only thing this writes anywhere is its own refund_mismatch_state table.
//
// ----------------------------------------------------------------------------
// AN UNKNOWN IS REPORTED AS AN UNKNOWN, NEVER AS "NOT REFUNDED".
//
// The whole alert is a claim that one side is NOT reversed. If a token mint
// fails or a search errors, the honest answer is "we could not tell" — and
// treating that as "not reversed" would mail a manager about an order that is
// already fine, which is the fastest way to teach four people to ignore this
// sender. Every failed read lands in `problems` in the JSON response and stops
// that order being judged at all. The first live run proved the point: 27 orders
// could not be read, and not one of them reached a manager.
//
// ----------------------------------------------------------------------------
// HOW THE TWO SIDES ARE JOINED, AND WHY NOT THROUGH ebay_orders.
//
// `ebay_orders` looks like the obvious join table and is a trap: all five stores
// went channel_mode='standby' at the Marketplace Connect cutover, the
// ebay-orders-poll crons are disabled, and the table stopped taking rows on
// 2026-08-25. It is a frozen historical ledger. Joining through it would quietly
// check nothing at all.
//
// So the link is read off Shopify itself, in the three forms that exist in the
// data (the set dupe-open-pairs documents):
//   SPEEKS Connect (historical) -> tag "ebay-<id>", customAttribute, sourceIdentifier NULL
//   Marketplace Connect (live)  -> sourceIdentifier = <id>, customAttribute
// Shopify's order search is fuzzy, so a hit is confirmed against those three
// forms before it is believed.
//
// ----------------------------------------------------------------------------
// ONE EBAY ORDER CAN HAVE SEVERAL SHOPIFY COPIES, AND ONE OF THEM IS A GHOST.
//
// The August duplicate incident left pairs where the PHANTOM copy was refunded
// and the REAL order was not. "Any copy is refunded, so Shopify is settled"
// would read exactly those orders as healthy — the precise case the CFO is
// mailing about. Copies named in `dup_order_cleanup` are therefore excluded by
// name before the question is asked, the same way refund-plan excludes them.
//
// ----------------------------------------------------------------------------
// TIMING, AND WHY MONTH END IS DIFFERENT. (Revised 2026-09-17, as asked.)
//
// EVERY MORNING, EVERYTHING THAT QUALIFIES. The mail is a daily to-do list: each
// open mismatch at least 3 days old is on it every morning until both sites
// agree. The first version mailed an order once and then only every 72 hours,
// which with a once-a-day run meant a manager saw an order on day 3 and then not
// again until day 6 or 7 -- a list that was never the whole list.
//
// AGE IS COUNTED IN CHICAGO CALENDAR DAYS, NOT HOURS. Reversed on the 14th ->
// on the list the morning of the 17th, whatever time of day it happened. Hours
// against a fixed 8:20 run made "3 days" really mean 3 or 4, depending on
// whether the refund landed before or after 8:20.
//
// THE LAST 4 DAYS OF THE MONTH, THE BAR DROPS TO 1 DAY. A flat 3-day rule cannot
// catch what the CFO's list is made of: a refund on the 29th would first be
// mailed on the 2nd, after the books close. With calendar days, the last
// morning's mail carries everything reversed up to the day before.
//
// ----------------------------------------------------------------------------
// THE LEADERSHIP DIGEST IS ABOUT PEOPLE, NOT AGE.
//
// The DM and CEO get a separate mail on the mornings the managers are emailed.
// It lists every open order a manager has been told about and, on each row, HOW
// MANY TIMES -- which, now that the list goes out daily, is how many mornings
// that order has sat on a manager's list. A 1st notice is new today; a 5th is an
// order that has been in front of someone all week.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";
const GMAIL_RELAY = Deno.env.get("GMAIL_RELAY_URL") ||
  "https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec";

// --- thresholds -------------------------------------------------------------
// Ages are whole Chicago calendar days (see daysOpen). There is no re-nag
// interval any more: everything at or past the bar is on every morning's mail.
const BASE_DAYS       = 3;   // normal age, in days, before a mismatch is mailed
const MONTH_END_MIN_DAYS = 1; // ...and during the last MONTH_END_DAYS of a month
const MONTH_END_DAYS  = 4;
const ESCALATE_DAYS   = 10;  // an item older than this is coloured red in the mail
const WINDOW_DAYS     = 60;  // how far back NEW mismatches are discovered

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];
const STORE_NAME: Record<string, string> = {
  OVL: "Overland Park", LEE: "Lee's Summit", WSP: "Westport",
  MPL: "Maplewood", BAL: "Ballwin",
};
// shopify_stores.store_code is NULL on all five rows, so the shop domain is the
// only thing identifying a store there. Same map the other functions carry.
const SHOP_BY_STORE: Record<string, string> = {
  OVL: "paymore-overland-park.myshopify.com",
  LEE: "paymore-lees-summit.myshopify.com",
  WSP: "paymore-westport.myshopify.com",
  MPL: "paymore-maplewood.myshopify.com",
  BAL: "paymore-ballwin.myshopify.com",
};
const STORE_BY_SHOP: Record<string, string> = Object.fromEntries(
  Object.entries(SHOP_BY_STORE).map(([c, s]) => [s, c]),
);

const EBAY_HOSTS: Record<string, string> = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};

// EBAY_APPS arrives as a hand-pasted JSON secret and has carried literal line
// breaks before now, so it is parsed defensively rather than trusted.
let EBAY_APPS: Record<string, any> = {};
{
  const raw = (Deno.env.get("EBAY_APPS") || "").trim();
  for (const attempt of [raw, raw.replace(/[\r\n\t]/g, "")]) {
    if (!attempt) continue;
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === "object") { EBAY_APPS = parsed; break; }
    } catch { /* try the next form */ }
  }
}

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

function authed(url: URL) {
  const g = url.searchParams.get("secret") || "";
  if (g.length !== OPS_SECRET.length) return false;
  let d = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) d |= g.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  return d === 0;
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

// ---------------------------------------------------------------------------
// MONTH END, IN THE STORE'S OWN CALENDAR.
// A run at 8:20am Chicago on the 31st is already the 1st in UTC during part of
// the year, and dating this in UTC would apply the tightened threshold on the
// wrong day — the same class of bug as the refund-dating one np-returns-probe
// documents.
// ---------------------------------------------------------------------------
const CHI_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
});
function chicagoParts(d = new Date()) {
  const [y, m, day] = CHI_DAY.format(d).split("-").map(Number);
  return { y, m, d: day };
}
// Takes the date rather than reading the clock so the rule can be tested at a
// month boundary without waiting for one.
function isMonthEnd(now = new Date()): boolean {
  const { y, m, d } = chicagoParts(now);
  // Day 0 of the next month is the last day of this one — which is also how
  // February and leap years come out right without a special case.
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return (lastDay - d) <= (MONTH_END_DAYS - 1);
}

// WHOLE CALENDAR DAYS BETWEEN TWO MOMENTS, BOTH READ IN CHICAGO. A refund at
// 11pm on the 14th and one at 1am on the 14th are both "3 days" on the 17th --
// which is how a manager counts, and it keeps the answer independent of what
// time the cron happens to fire. Date.UTC on the Chicago y/m/d is only used as a
// day counter here, so DST cannot shift it.
function daysOpen(reversedAt: string | Date, now = new Date()): number {
  const a = chicagoParts(new Date(reversedAt)), b = chicagoParts(now);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}
function chicagoDay(d: string | Date): string { return CHI_DAY.format(new Date(d)); }

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

// ===========================================================================
// THE ONLY DOOR TO EBAY, AND IT ONLY OPENS OUTWARD.
//
// Two shapes allowed, both read-only, both anchored so nothing can ride along
// on the end of the path:
//   .../order?<query>        the list sweep
//   .../order/{id}           one order
// The refund endpoint is .../order/{id}/issue_refund — a second path segment,
// which the single-order pattern rejects by construction. Method is hard-coded
// to GET as an independent guard, so a mistake has to get past both.
// ===========================================================================
const EBAY_LIST_RE =
  /^https:\/\/api(?:\.sandbox)?\.ebay\.com\/sell\/fulfillment\/v1\/order\?[^#]*$/;
const EBAY_ONE_RE =
  /^https:\/\/api(?:\.sandbox)?\.ebay\.com\/sell\/fulfillment\/v1\/order\/[^/?#]+$/;

async function ebayGet(url: string, token: string): Promise<any> {
  if (!EBAY_LIST_RE.test(url) && !EBAY_ONE_RE.test(url)) {
    throw new Error(`refused: not a read-only eBay order URL -> ${url.slice(0, 120)}`);
  }
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`eBay ${res.status}: ${JSON.stringify(body ?? "").slice(0, 160)}`);
  }
  return body;
}

// Minted per call, never written back to ebay_stores.
async function mintToken(row: any): Promise<string> {
  const creds = EBAY_APPS[row.store_code];
  if (!creds) throw new Error(`no EBAY_APPS entry for ${row.store_code}`);
  const host = EBAY_HOSTS[row.environment as string] || EBAY_HOSTS.production;
  const res = await fetch(`${host}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: row.refresh_token,
      scope: row.scopes || "",
    }),
  });
  const b = await res.json().catch(() => null);
  if (!res.ok || !b?.access_token) {
    throw new Error(`token ${res.status}: ${JSON.stringify(b).slice(0, 160)}`);
  }
  return b.access_token as string;
}

// ===========================================================================
// THE ONLY DOOR TO SHOPIFY. GraphQL reads are POSTs, so the method proves
// nothing — the DOCUMENT is what is checked. refundCreate, orderCancel and
// every other write require the `mutation` keyword, which this refuses.
// ===========================================================================
async function shopifyQuery(shop: string, token: string, query: string, variables: any) {
  if (/\bmutation\b/i.test(query)) {
    throw new Error("refused: this function issues Shopify reads only");
  }
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const b = await res.json().catch(() => null);
  if (!b) throw new Error(`shopify ${res.status}: no body`);
  if (b.errors?.length) throw new Error(`shopify: ${JSON.stringify(b.errors).slice(0, 200)}`);
  return b.data;
}

const ORDER_FIELDS = `
  id name createdAt cancelledAt cancelReason
  displayFinancialStatus displayFulfillmentStatus
  sourceIdentifier tags
  app { name }
  totalPriceSet { shopMoney { amount } }
  totalRefundedSet { shopMoney { amount } }
  customAttributes { key value }
  refunds(first: 20) { createdAt totalRefundedSet { shopMoney { amount } } }
`;

const SEARCH_Q = `query($q: String!, $after: String) {
  orders(first: 100, query: $q, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node { ${ORDER_FIELDS} } }
  }
}`;

const LOOKUP_Q = `query($q: String!) {
  orders(first: 25, query: $q) { edges { node { ${ORDER_FIELDS} } } }
}`;

// ⚠️ sourceIdentifier IS NOT AN EBAY FIELD. It is Shopify's generic "this order's
// id in whatever channel it came from", so every other marketplace the store
// sells through fills it in too. Trusting it blindly on the first live run sent
// 27 ids of the shape 66390589542-3-2815 to eBay's order API, which rejected
// every one with "Invalid Order Id" — a different channel's numbering, read as
// eBay's. Nothing was mis-alerted, because an unreadable order is never judged,
// but 27 dead lookups per store per day is how a real problem gets buried.
//
// So the SHAPE is checked before an id is believed. eBay order ids are
// NN-NNNNN-NNNNN, as every genuine one in this data is: 08-15066-00533,
// 13-15066-46687, 05-14978-78547.
const EBAY_ORDER_ID_RE = /^\d{2}-\d{5}-\d{5}$/;

// The eBay order id carried on a Shopify order, in whichever of the three forms
// that store's importer used. Returns "" when this is not an eBay-linked order —
// an in-store sale, a web-only sale, or another marketplace's order. None of
// those has an eBay twin, so none of them can mismatch.
function ebayIdOf(o: any): string {
  const attr = (o.customAttributes || [])
    .find((a: any) => /ebay\s*order\s*id/i.test(String(a?.key || "")));
  const fromAttr = String(attr?.value ?? "").trim();
  if (EBAY_ORDER_ID_RE.test(fromAttr)) return fromAttr;

  const fromSource = String(o.sourceIdentifier ?? "").trim();
  if (EBAY_ORDER_ID_RE.test(fromSource)) return fromSource;

  const tag = (o.tags || []).map(String).find((t: string) => /^ebay-/i.test(t.trim()));
  const fromTag = tag ? tag.trim().slice(5) : "";
  if (EBAY_ORDER_ID_RE.test(fromTag)) return fromTag;

  return "";
}

// Shopify's search is fuzzy, so a hit is only believed if the id really is on
// the order in one of the three forms.
function carriesEbayId(o: any, eid: string): boolean {
  const tagForId = ("ebay-" + eid).toLowerCase();
  const byAttr = (o.customAttributes || []).some((a: any) =>
    /ebay\s*order\s*id/i.test(String(a?.key || "")) && String(a.value).trim() === eid);
  const bySource = String(o.sourceIdentifier || "").trim() === eid;
  const byTag = (o.tags || []).some((t: any) => String(t).trim().toLowerCase() === tagForId);
  return byAttr || bySource || byTag;
}

type Reversal = { reversed: boolean; at: string | null; kind: string | null; amount: number };

// A Shopify order counts as reversed if money went back OR the order was
// cancelled. Cancellation matters as much as a refund here: a cancelled Shopify
// order and a live eBay sale is the same hole in the books, pointing the other
// way.
function shopifyReversal(o: any): Reversal {
  const refunded = num(o.totalRefundedSet?.shopMoney?.amount);
  if (refunded > 0) {
    const dates = (o.refunds || []).map((r: any) => r?.createdAt).filter(Boolean).sort();
    return { reversed: true, at: dates[0] || o.cancelledAt || o.createdAt, kind: "refund", amount: r2(refunded) };
  }
  if (o.cancelledAt) {
    return { reversed: true, at: o.cancelledAt, kind: "cancel", amount: num(o.totalPriceSet?.shopMoney?.amount) };
  }
  return { reversed: false, at: null, kind: null, amount: 0 };
}

function ebayReversal(o: any): Reversal {
  const refunds = o?.paymentSummary?.refunds || [];
  let total = 0, earliest: string | null = null;
  for (const rf of refunds) {
    total += num(rf?.amount?.value);
    if (rf?.refundDate && (!earliest || rf.refundDate < earliest)) earliest = rf.refundDate;
  }
  if (total > 0) {
    return { reversed: true, at: earliest || o?.creationDate || null, kind: "refund", amount: r2(total) };
  }
  // CANCELLED, NOT "CANCEL REQUESTED". A buyer asking to cancel is not a
  // reversal — the seller may still refuse it, and nagging a manager to refund
  // Shopify against a request that was declined would create the very mismatch
  // this is meant to prevent.
  const state = String(o?.cancelStatus?.cancelState || "").toUpperCase();
  if (state === "CANCELED" || state === "CANCELLED") {
    const when = (o?.cancelStatus?.cancelRequests || [])
      .map((c: any) => c?.cancelRequestedDate).filter(Boolean).sort()[0];
    return {
      reversed: true, at: when || o?.creationDate || null, kind: "cancel",
      amount: num(o?.pricingSummary?.total?.value),
    };
  }
  return { reversed: false, at: null, kind: null, amount: 0 };
}

type Mismatch = {
  key: string; store: string; ebayOrderId: string;
  direction: "ebay_only" | "shopify_only";
  shopifyOrderName: string | null; shopifyOrderId: string | null;
  reversedAt: string; reversalKind: string | null; amount: number;
};

// ---------------------------------------------------------------------------
async function collect(sb: any, wantStores: string[], windowDays: number) {
  const problems: string[] = [];
  const found: Mismatch[] = [];
  const stats: Record<string, any> = {};
  // WHAT WE COULD NOT JUDGE, tracked separately from what we judged as fine.
  // An order missing from `found` means "both sides agree" — which is how a row
  // gets marked resolved. A read that FAILED also leaves the order out of
  // `found`, and treating that as agreement would close an open mismatch on a
  // timeout. These two sets are what keep the difference.
  const brokeStores = new Set<string>();       // nothing from this store is conclusive
  const unjudged = new Set<string>();          // "<store>:<ebay id>" we could not settle

  const sinceIso = new Date(Date.now() - windowDays * 86400_000).toISOString();
  const sinceDay = sinceIso.slice(0, 10);

  // Phantom copies from the August duplicate incident. Excluded BY NAME before
  // any question is asked of a Shopify copy — see the header.
  let phantoms = new Set<string>();
  try {
    const rows = await sbGet(`dup_order_cleanup?select=order_name`);
    phantoms = new Set((rows || []).map((r: any) =>
      String(r.order_name || "").trim().replace(/^#/, "").toUpperCase()).filter(Boolean));
  } catch (e) {
    // Not fatal, but it does mean a phantom could mask a real mismatch, so say so.
    problems.push(`could not read dup_order_cleanup (phantoms not excluded): ${String(e).slice(0, 120)}`);
  }
  const isPhantom = (o: any) =>
    phantoms.has(String(o?.name || "").trim().replace(/^#/, "").toUpperCase());

  const shopRows = await sbGet(`shopify_stores?select=shop,store_code,access_token`);
  const ebayRows = await sbGet(`ebay_stores?select=store_code,refresh_token,scopes,environment`);

  // Rows already open from earlier runs. These are re-checked every pass no
  // matter how old, so nothing falls out of the discovery window and stops
  // being chased at the point it has become most serious.
  const openRows = await sbGet(
    `refund_mismatch_state?select=issue_key,store_code,ebay_order_id,direction&resolved_at=is.null`);

  for (const store of wantStores) {
    const shopRow = shopRows.find((s: any) =>
      (s.store_code || STORE_BY_SHOP[s.shop]) === store);
    const ebayRow = ebayRows.find((e: any) => e.store_code === store);
    if (!shopRow?.access_token) {
      problems.push(`${store}: no Shopify token`); brokeStores.add(store); continue;
    }
    if (!ebayRow?.refresh_token) {
      problems.push(`${store}: no eBay credentials`); brokeStores.add(store); continue;
    }
    const shop = shopRow.shop;

    let token: string;
    try { token = await mintToken(ebayRow); }
    catch (e) {
      problems.push(`${store}: eBay token — ${String(e).slice(0, 160)}`);
      brokeStores.add(store); continue;
    }
    const host = EBAY_HOSTS[ebayRow.environment] || EBAY_HOSTS.production;

    // --- 1. every eBay order in the window, with its reversal state ---------
    const ebayById = new Map<string, any>();
    try {
      let offset = 0;
      for (let page = 0; page < 20; page++) {
        const filter = encodeURIComponent(`creationdate:[${sinceIso}..]`);
        const body = await ebayGet(
          `${host}/sell/fulfillment/v1/order?filter=${filter}&limit=200&offset=${offset}`, token);
        const orders = body?.orders || [];
        for (const o of orders) if (o?.orderId) ebayById.set(String(o.orderId), o);
        if (orders.length < 200) break;
        offset += 200;
      }
    } catch (e) {
      problems.push(`${store}: eBay order sweep — ${String(e).slice(0, 160)}`);
      brokeStores.add(store);
      continue;   // without eBay state nothing here can be judged
    }

    // --- 2. Shopify orders in the window that are REVERSED ------------------
    // Only the reversed ones, the dupe-open-pairs trick: asking Shopify for the
    // small set it can filter itself is far cheaper than reading every order and
    // comparing refunds, and it cannot produce a false positive from a stale
    // refund total. Two searches rather than one OR-group, because `status` and
    // `financial_status` are different filters and a malformed group silently
    // returns everything.
    const shopReversed = new Map<string, any>();   // eBay id -> Shopify order
    let shopSweepOk = true;
    for (const q of [
      `created_at:>=${sinceDay} AND (financial_status:refunded OR financial_status:partially_refunded)`,
      `created_at:>=${sinceDay} AND status:cancelled`,
    ]) {
      try {
        let after: string | null = null;
        for (let page = 0; page < 40; page++) {
          const data: any = await shopifyQuery(shop, shopRow.access_token, SEARCH_Q, { q, after });
          for (const e of (data?.orders?.edges || [])) {
            const o = e.node;
            if (isPhantom(o)) continue;
            const eid = ebayIdOf(o);
            if (!eid) continue;                       // no eBay twin, out of scope
            if (!shopifyReversal(o).reversed) continue;
            shopReversed.set(eid, o);
          }
          if (!data?.orders?.pageInfo?.hasNextPage) break;
          after = data.orders.pageInfo.endCursor;
        }
      } catch (e) {
        // A failed sweep means shopify_only mismatches may be missing from this
        // pass entirely, so nothing at this store can be called settled either.
        shopSweepOk = false;
        brokeStores.add(store);
        problems.push(`${store}: Shopify reversed sweep — ${String(e).slice(0, 160)}`);
      }
    }

    // --- 3. candidates ------------------------------------------------------
    const candidates = new Set<string>();
    for (const [eid, o] of ebayById) if (ebayReversal(o).reversed) candidates.add(eid);
    if (shopSweepOk) for (const eid of shopReversed.keys()) candidates.add(eid);
    for (const r of openRows) if (r.store_code === store) candidates.add(String(r.ebay_order_id));
    // Belt and braces after the sourceIdentifier lesson above: ids reaching here
    // from the state table were written by an older build of this function, so
    // the shape is re-checked rather than assumed. Ids from ebayById came from
    // eBay itself and are valid by construction.
    for (const eid of candidates) if (!EBAY_ORDER_ID_RE.test(eid)) candidates.delete(eid);

    stats[store] = {
      ebay_orders_in_window: ebayById.size,
      ebay_reversed: [...ebayById.values()].filter((o) => ebayReversal(o).reversed).length,
      shopify_reversed_with_ebay_twin: shopReversed.size,
      candidates: candidates.size,
    };

    // --- 4. judge each candidate on both sides ------------------------------
    for (const eid of candidates) {
      // eBay side. Outside the sweep window we ask for the one order directly.
      let eOrder = ebayById.get(eid) || null;
      if (!eOrder) {
        try { eOrder = await ebayGet(`${host}/sell/fulfillment/v1/order/${encodeURIComponent(eid)}`, token); }
        catch (e) {
          problems.push(`${store} ${eid}: eBay read — ${String(e).slice(0, 120)}`);
          unjudged.add(`${store}:${eid}`); continue;
        }
      }
      const eRev = ebayReversal(eOrder);

      // Shopify side. THE SWEEP IS EVIDENCE ONLY WHEN IT HITS. It holds reversed
      // orders, so finding one proves Shopify is reversed; NOT finding one
      // proves nothing, because the order may simply have been created before
      // the window opened. A hit is therefore free and a miss costs a targeted
      // lookup — which is what keeps the run inside its time budget. The first
      // live pass on OVL had 323 candidates, 321 of them already answered by the
      // sweep; looking every one up regardless made five stores in one run a
      // real risk of hitting the wall clock.
      let copies: any[];
      const sweepHit = shopReversed.get(eid);
      if (sweepHit) {
        copies = [sweepHit];
      } else {
        try {
          const data: any = await shopifyQuery(shop, shopRow.access_token, LOOKUP_Q, { q: eid });
          copies = (data?.orders?.edges || []).map((e: any) => e.node)
            .filter((o: any) => carriesEbayId(o, eid) && !isPhantom(o));
        } catch (e) {
          problems.push(`${store} ${eid}: Shopify lookup — ${String(e).slice(0, 120)}`);
          unjudged.add(`${store}:${eid}`); continue;
        }
      }

      // No Shopify counterpart at all. Real, but a DIFFERENT problem — the sale
      // never reached the books rather than a half-done reversal — and mixing
      // the two would send managers hunting for an order that does not exist.
      // Reported, never mailed.
      if (!copies.length) {
        if (eRev.reversed) problems.push(`${store} ${eid}: reversed on eBay, no Shopify order found`);
        // Not judged either way: "we found no Shopify order" is not "Shopify
        // agrees". An open row must survive this rather than read as fixed.
        unjudged.add(`${store}:${eid}`);
        continue;
      }

      const reversals = copies.map(shopifyReversal);
      const sIdx = reversals.findIndex((r) => r.reversed);
      const sRev = sIdx >= 0 ? reversals[sIdx] : { reversed: false, at: null, kind: null, amount: 0 };
      // Report against the copy that still reads as a live sale where there is
      // one — that is the order the manager has to open and act on.
      const liveIdx = reversals.findIndex((r) => !r.reversed);
      const subject = copies[liveIdx >= 0 ? liveIdx : 0];

      if (eRev.reversed === sRev.reversed) continue;      // agreed, nothing to say

      const direction = eRev.reversed ? "ebay_only" : "shopify_only";
      const side = eRev.reversed ? eRev : sRev;
      const target = eRev.reversed ? subject : copies[sIdx];
      found.push({
        key: `${store}:${eid}:${direction}`,
        store, ebayOrderId: eid, direction,
        shopifyOrderName: target?.name || subject?.name || null,
        shopifyOrderId: String(target?.id || subject?.id || "").split("/").pop() || null,
        reversedAt: side.at || new Date().toISOString(),
        reversalKind: side.kind,
        amount: side.amount,
      });
    }
  }

  return { found, problems, stats, brokeStores, unjudged };
}

// ---------------------------------------------------------------------------
const C = {
  ink: "#12241c", faint: "#6d8579", line: "#dde7e1",
  bad: "#b3261e", warn: "#8a5a00", chip: "#eef5f1",
};

function ageText(days: number) {
  return days === 1 ? `1 day` : `${days} days`;
}

// 1st, 2nd, 3rd, 4th... The leadership digest is built around this number, so it
// is spelled out rather than printed as "x3" — "3rd notice" reads as a fact
// about a person's follow-through, which is what it is.
const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

function build(
  rows: Array<Mismatch & { hours: number; days: number; notice?: number }>,
  opts: { oversight?: boolean } = {},
) {
  const money = (n: number) => n > 0 ? `$${n.toFixed(2)}` : "—";
  const body = rows.map((r) => {
    const done = r.direction === "ebay_only" ? "eBay" : "Shopify";
    const todo = r.direction === "ebay_only" ? "Shopify" : "eBay";
    const old = r.days >= ESCALATE_DAYS;
    // THE NUMBER THE DM AND CEO ACTUALLY READ: how many mornings this order has
    // been on a manager's list and is still not done. It is the whole reason
    // this digest exists, so it is the loudest thing on the row.
    const repeat = opts.oversight && (r.notice || 0) >= 2;
    const badge = opts.oversight && r.notice
      ? `<span style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:9px;`
        + `background:${repeat ? C.bad : C.chip};color:${repeat ? "#fff" : C.faint};`
        + `font-weight:700;font-size:10px;">${esc(ordinal(r.notice))} notice</span>`
      : "";
    const shopUrl = r.shopifyOrderId
      ? `https://${SHOP_BY_STORE[r.store]}/admin/orders/${r.shopifyOrderId}` : null;
    const ebayUrl = `https://www.ebay.com/sh/ord/details?orderid=${encodeURIComponent(r.ebayOrderId)}`;
    return `
    <tr><td style="padding:14px;border-top:1px solid ${C.line};">
      <div style="font-size:11px;color:${C.faint};letter-spacing:.04em;text-transform:uppercase;">
        ${esc(STORE_NAME[r.store] || r.store)}
        <span style="color:${old ? C.bad : C.warn};font-weight:700;"> · ${esc(ageText(r.days))} old</span>${badge}
      </div>
      <div style="font-size:15px;font-weight:700;color:${C.ink};margin:4px 0 6px;">
        ${esc(r.reversalKind === "cancel" ? "Cancelled" : "Refunded")} on ${done}, but not on ${todo}
      </div>
      <div style="font-size:13px;color:${C.ink};line-height:1.6;">
        eBay order <b>${esc(r.ebayOrderId)}</b>${r.shopifyOrderName
          ? ` &nbsp;·&nbsp; Shopify <b>${esc(r.shopifyOrderName)}</b>` : ""}
        &nbsp;·&nbsp; ${money(r.amount)}<br>
        <span style="color:${C.faint};">
          ${todo} still shows this as a completed sale. Until both sides match, our books
          say we were paid for something we refunded.
        </span>
      </div>
      <div style="margin-top:8px;font-size:12px;">
        <a href="${ebayUrl}" style="color:#1c6b47;">Open on eBay</a>
        ${shopUrl ? ` &nbsp;·&nbsp; <a href="${shopUrl}" style="color:#1c6b47;">Open in Shopify</a>` : ""}
      </div>
    </td></tr>`;
  }).join("");

  const title = opts.oversight
    ? `Refund mismatches — what the managers have been told`
    : `Refunded on one site, not the other`;
  const lead = opts.oversight
    ? `Every order the store managers have been emailed about and have not yet cleared. `
      + `The notice count is the thing to read: it is how many mornings the order has been `
      + `on a manager's list. A 1st notice is new today; anything higher is still waiting.`
    : `Each of these was refunded or cancelled on one marketplace and is still a live sale on the other. Push the same reversal on the other site and this stops appearing.`;

  // The counts the digest is FOR, on the line above the detail, so the question
  // "is anyone actually doing these?" is answered without reading every row.
  const repeats = rows.filter((r) => (r.notice || 0) >= 2);
  const summary = opts.oversight
    ? `<tr><td style="padding:12px 14px;border-top:1px solid ${C.line};background:#fff;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size:12px;color:${C.faint};">
            <b style="color:${C.ink};font-size:19px;">${rows.length}</b><br>open
          </td>
          <td style="font-size:12px;color:${C.faint};">
            <b style="color:${repeats.length ? C.bad : C.ink};font-size:19px;">${repeats.length}</b><br>told more than once
          </td>
          <td style="font-size:12px;color:${C.faint};text-align:right;">
            <b style="color:${C.ink};font-size:19px;">${money(rows.reduce((a, r) => a + r.amount, 0))}</b><br>at stake
          </td>
        </tr></table>
      </td></tr>`
    : "";

  return `<!doctype html><html><body style="margin:0;padding:18px;background:#f4f7f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid ${C.line};border-radius:12px;overflow:hidden;">
  <tr><td style="padding:16px 14px;background:${C.chip};">
    <div style="font-size:17px;font-weight:800;color:${C.ink};">${esc(title)}</div>
    <div style="font-size:12.5px;color:${C.faint};margin-top:5px;line-height:1.6;">${esc(lead)}</div>
  </td></tr>
  ${summary}
  ${body}
  <tr><td style="padding:12px 14px;text-align:center;color:${C.faint};font-size:10.5px;line-height:1.6;border-top:1px solid ${C.line};background:#f7faf8;">
    ${opts.oversight
      ? `Sent on the mornings the managers are emailed, so this is what went out to them today. `
        + `The notice count is how many mornings an order has been on a manager's list.`
      : `Checked every morning. You only get this mail when something needs doing, and each
         order stays on it every morning until both sites agree.`}<br>
    Normally listed once ${BASE_DAYS} days old; in the last ${MONTH_END_DAYS} days of the month, once ${MONTH_END_MIN_DAYS} day old, so it lands before the books close.
  </td></tr>
</table></td></tr></table></body></html>`;
}

// ⚠️ A 404 FROM THE RELAY DOES NOT MEAN THE MAIL WAS NOT SENT.
// Apps Script runs doPost on the POST to /exec, THEN answers with a 302 to a
// one-time script.googleusercontent.com "echo" URL that carries the reply.
// fetch follows that redirect by default, and it is the echo fetch that can
// 404. On 2026-09-17 three of five sends "failed" with 404 -- and the leadership
// one was in Ethan's and Paul's inboxes. Retrying on that status would have
// mailed everyone twice.
//
// So the redirect is NOT followed. The 302 is itself the proof doPost ran to
// completion, and is treated as sent. Only a failure before the script ran (a
// non-2xx/3xx answer from /exec itself) is retried. A thrown network error is
// ambiguous -- the script may have run -- so it is reported, not retried.
async function relay(to: string, subject: string, html: string) {
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt * 4000));
    try {
      const res = await fetch(GMAIL_RELAY, {
        method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ secret: OPS_SECRET, to, subject, html }),
        redirect: "manual",
      });
      status = res.status;
      await res.body?.cancel().catch(() => {});
      if (res.ok || (status >= 300 && status < 400)) return { ok: true, status, attempts: attempt + 1 };
    } catch (e) {
      return { ok: false, status: 0, attempts: attempt + 1, error: String(e).slice(0, 120) };
    }
  }
  return { ok: false, status, attempts: 3 };
}

async function listFor(sb: any, key: string, fallbackKey: string): Promise<string[]> {
  for (const k of [key, fallbackKey]) {
    const { data } = await sb.from("email_recipients").select("email").eq("list_key", k);
    const list = (data || []).map((r: any) => String(r.email).trim()).filter(Boolean);
    if (list.length) return list;
  }
  return [];
}

// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const q = (k: string) => url.searchParams.get(k);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);

  // PREVIEW. This alerter is silent when everything is fine, so without a way to
  // make it speak there is no way to see what a layout change did until a real
  // mismatch appears. Reads nothing and writes nothing.
  if (q("sample") === "1") {
    const html = build([
      { key: "s1", store: "OVL", ebayOrderId: "08-15066-00533", direction: "ebay_only",
        shopifyOrderName: "#KS01-14010", shopifyOrderId: "1", reversedAt: "", reversalKind: "refund",
        amount: 249.99, hours: 74, days: 3, notice: 1 },
      { key: "s2", store: "BAL", ebayOrderId: "13-15066-46687", direction: "shopify_only",
        shopifyOrderName: "#MO04-2836", shopifyOrderId: "2", reversedAt: "", reversalKind: "cancel",
        amount: 89.5, hours: 268, days: 11, notice: 3 },
    ], { oversight: q("oversight") === "1" });
    if (q("html") === "1") return new Response(html, { headers: { "Content-Type": "text/html" } });
    const to = q("to");
    if (!to) return json({ error: "sample needs &to=addr, or &html=1 to just render it" }, 400);
    const res = await fetch(GMAIL_RELAY, {
      method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ secret: OPS_SECRET, to, subject: "[SAMPLE] Refunded on one site, not the other", html }),
    });
    return json({ ok: res.ok, sample: true, to });
  }

  const want = (q("store") || "").toUpperCase().trim();
  if (!want) return json({ error: "pass ?store=OVL or ?store=ALL" }, 400);
  const wantStores = want === "ALL" ? STORES : [want];
  if (wantStores.some((s) => !STORES.includes(s))) return json({ error: `unknown store ${want}` }, 400);
  const windowDays = Math.max(1, Math.min(365, Number(q("days")) || WINDOW_DAYS));

  try {
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const { found, problems, stats, brokeStores, unjudged } = await collect(sb, wantStores, windowDays);
    const now = new Date();
    const nowIso = now.toISOString();

    const { data: prior } = await sb.from("refund_mismatch_state").select("*");
    const priorBy: Record<string, any> = {};
    for (const r of (prior || [])) priorBy[r.issue_key] = r;

    // THE THRESHOLD, AND THE MONTH-END TIGHTENING.
    const thresholdDays = isMonthEnd(now) ? MONTH_END_MIN_DAYS : BASE_DAYS;
    const aged = found.map((m) => ({
      ...m,
      hours: (now.getTime() - new Date(m.reversedAt).getTime()) / 3600_000,
      days: daysOpen(m.reversedAt, now),
    }));

    // Everything old enough, every morning. The one exclusion is an order
    // already mailed TODAY (Chicago), so a manual re-run of the function cannot
    // send the list twice or count a second "notice" for the same morning.
    const today = chicagoDay(now);
    const due = aged.filter((m) => {
      if (m.days < thresholdDays) return false;           // too young to chase
      const p = priorBy[m.key];
      return !p?.last_alerted || chicagoDay(p.last_alerted) !== today;
    });
    // LEADERSHIP OVERSIGHT, NOT AGE-BASED ESCALATION.
    //
    // Asked for on 2026-09-16 and it is a better instrument than the age rule it
    // replaces. The DM and CEO do not need "this is old" — they need "the manager
    // was told and did nothing", and the notice count says exactly that. Since
    // 2026-09-17 the managers' list goes out daily, so the count is mornings on
    // the list: a 1st notice is new today, a 5th has been ignored all week.
    //
    // It covers everything still open that has EVER been mailed, not just what
    // went out this morning, so a quiet day does not hide an order the manager
    // was told about on Monday and still has not cleared.
    const notified = aged
      .map((m) => ({
        ...m,
        notice: (priorBy[m.key]?.times_alerted || 0) + (due.some((d) => d.key === m.key) ? 1 : 0),
      }))
      .filter((m) => m.notice > 0)
      // Worst follow-through first: most notices, then oldest.
      .sort((a, b) => (b.notice - a.notice) || (b.hours - a.hours));
    const repeats = notified.filter((m) => m.notice >= 2);

    // --- who gets what ------------------------------------------------------
    // Grouped by RECIPIENT, not by store: BAL and MPL share a manager, and two
    // separate mails to the same inbox on the same morning is how a useful alert
    // becomes a filtered one.
    const byRecipient = new Map<string, Array<typeof aged[number]>>();
    for (const store of wantStores) {
      const rows = due.filter((m) => m.store === store);
      if (!rows.length) continue;
      const to = await listFor(sb, `refund_mismatch_${store}`, `weekly_store_${store}`);
      if (!to.length) { problems.push(`${store}: nobody on refund_mismatch_${store}`); continue; }
      for (const addr of to) {
        if (!byRecipient.has(addr)) byRecipient.set(addr, []);
        byRecipient.get(addr)!.push(...rows);
      }
    }

    const plan = [...byRecipient.entries()].map(([to, rows]) => ({
      to, count: rows.length,
      rows: rows.sort((a, b) => b.hours - a.hours),
    }));

    if (q("dryRun") === "1") {
      if (q("html") === "1") {
        // Either mail can be previewed against real data without sending it.
        const preview = q("oversight") === "1"
          ? (notified.length ? build(notified, { oversight: true }) : "")
          : (plan.length ? build(plan[0].rows) : "");
        if (preview) return new Response(preview, { headers: { "Content-Type": "text/html" } });
      }
      return json({
        ok: true, dryRun: true, monthEnd: isMonthEnd(now), thresholdDays,
        open: aged.length, wouldMail: due.length,
        leadershipWouldSee: notified.length, onRepeatNotice: repeats.length,
        // Blind spots, stated rather than implied. All-zero findings with a
        // store listed here is "we could not look", which reads identically to
        // "nothing is wrong" if only the counts are printed.
        blindStores: [...brokeStores], unjudgedOrders: [...unjudged],
        stats, problems,
        mismatches: aged.map((m) => ({
          store: m.store, ebay: m.ebayOrderId, shopify: m.shopifyOrderName,
          direction: m.direction, kind: m.reversalKind,
          amount: m.amount, age_days: m.days, age_hours: Math.round(m.hours),
        })),
        plan: plan.map((p) => ({ to: p.to, count: p.count })),
      });
    }

    const sent: any[] = [];
    // DETECTION ON, MAIL OFF (?mail=0, 2026-09-23). Claims & Disputes now mails a
    // manager about their mismatches in the same list as their cases, disputes
    // and INRs, so a second mail from here is the same money told twice in two
    // different voices.
    //
    // ⚠️ THE CRON CANNOT SIMPLY BE SWITCHED OFF. This function is the DETECTOR:
    // refund_mismatch_state is written here and nowhere else, and the new tool
    // only ever reads it. Disabling the job would leave the tool showing the same
    // mismatches for ever and never noticing a new one. So the job keeps running
    // with mail=0, which does every bit of the work except the sending.
    //
    // dryRun=1 is NOT the same thing and is not a substitute: it returns before
    // the state is recorded, on purpose, so that a preview cannot mark orders as
    // told. This flag stops only the sending.
    const mailOff = q("mail") === "0";
    // Only orders whose mail actually reached at least one recipient count as
    // told. A failed send leaves the order un-mailed for today, so a re-run
    // picks it up and nobody already mailed gets a second copy. With mail off
    // nothing is told, so times_alerted correctly stops climbing.
    const mailedKeys = new Set<string>();
    for (const p of mailOff ? [] : plan) {
      const to = q("to") || p.to;
      const n = p.rows.length;
      const subject = `Refund not matched on both sites — ${n} order${n === 1 ? "" : "s"}`;
      const r = await relay(to, subject, build(p.rows));
      if (r.ok) for (const row of p.rows) mailedKeys.add(row.key);
      sent.push({ to, count: n, ...r });
    }
    // The digest's counts follow what was really sent, not what was planned.
    const told = aged
      .map((m) => ({ ...m, notice: (priorBy[m.key]?.times_alerted || 0) + (mailedKeys.has(m.key) ? 1 : 0) }))
      .filter((m) => m.notice > 0)
      .sort((a, b) => (b.notice - a.notice) || (b.hours - a.hours));
    const toldTwice = told.filter((m) => m.notice >= 2);

    // Sent only on the mornings the managers were actually emailed, so the digest
    // always answers "here is what just went out, and here is who has been told
    // before". On a silent morning leadership gets nothing, which is the point:
    // a mail from this means something needs chasing.
    if (!mailOff && mailedKeys.size && told.length) {
      const to = q("to") || (await listFor(sb, "refund_mismatch_escalation", "weekly_leadership")).join(",");
      if (to) {
        // The repeat count goes in the SUBJECT, because that is the number
        // worth opening the mail for.
        const r = await relay(to,
          `Refund mismatches — ${told.length} open`
            + (toldTwice.length ? `, ${toldTwice.length} told more than once` : ``),
          build(told, { oversight: true }));
        sent.push({ to, count: told.length, repeats: toldTwice.length, oversight: true, ...r });
      }
    }

    // --- record what is open now -------------------------------------------
    for (const m of aged) {
      const p = priorBy[m.key];
      const alerted = mailedKeys.has(m.key);
      // escalated_at now records the first time an order reached a SECOND notice
      // — the moment follow-through failed, rather than the moment it got old.
      const repeated = toldTwice.some((d) => d.key === m.key);
      await sb.from("refund_mismatch_state").upsert({
        issue_key: m.key, store_code: m.store, ebay_order_id: m.ebayOrderId,
        direction: m.direction,
        shopify_order_name: m.shopifyOrderName, shopify_order_id: m.shopifyOrderId,
        reversed_at: m.reversedAt, reversal_kind: m.reversalKind, amount: m.amount,
        first_seen: p?.first_seen || nowIso,
        last_seen: nowIso,
        last_alerted: alerted ? nowIso : (p?.last_alerted ?? null),
        times_alerted: (p?.times_alerted || 0) + (alerted ? 1 : 0),
        escalated_at: p?.escalated_at || (repeated ? nowIso : null),
        resolved_at: null,
      }, { onConflict: "issue_key" });
    }

    // Anything previously open and NOT found this pass has been settled — both
    // sites now agree. Resolved rather than deleted: "how many, how fast" is the
    // number that shows this replaced the month-end list.
    //
    // ⚠️ ONLY what was actually examined AND came back conclusive. Three ways an
    // open row can be absent from this pass, and only the first means fixed:
    //   both sides now agree                      -> resolve
    //   the store could not be read at all        -> leave open (brokeStores)
    //   that one order could not be read          -> leave open (unjudged)
    // A store skipped by ?store= was never looked at either. Closing any of the
    // others would silently drop a live mismatch on a timeout, and it would drop
    // it quietly — the row would simply stop appearing.
    const settled = (prior || []).filter((r: any) =>
      !r.resolved_at &&
      wantStores.includes(r.store_code) &&
      !brokeStores.has(r.store_code) &&
      !unjudged.has(`${r.store_code}:${r.ebay_order_id}`) &&
      !aged.some((m) => m.key === r.issue_key));
    if (settled.length) {
      await sb.from("refund_mismatch_state")
        .update({ resolved_at: nowIso, last_seen: nowIso })
        .in("issue_key", settled.map((r: any) => r.issue_key));
    }

    return json({
      ok: true, monthEnd: isMonthEnd(now), thresholdDays,
      open: aged.length, due: due.length, mailed: mailedKeys.size, onRepeatNotice: toldTwice.length,
      resolved: settled.length, sent,
      blindStores: [...brokeStores], unjudgedOrders: [...unjudged],
      stats, problems,
    });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message ?? err),
                  stack: String(err?.stack ?? "").slice(0, 400) }, 500);
  }
});
