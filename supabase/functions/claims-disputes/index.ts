// ============================================================================
// claims-disputes — the manager side of "our money is held or not lining up".
//
//   GET  ?stores=OVL,LEE                 what the tool shows for those stores
//   POST {action:'sync', stores:[...]}   re-read eBay cases (throttled per store)
//   POST {action:'review', item_type, item_key, status, note, by_name}
//          status 'still_open'  check-in; hides it for its timeframe. Note optional.
//          status 'resolved'    settled, and WHY. Note required (>= 10 chars).
//   POST {action:'reopen', item_type, item_key, by_name}
//          drops the review, so the item is due again at once
//   POST {action:'open_claim', item_type, item_key, reason_type, case_number, ...}
//          a refunded item-not-received, or a mismatch, gets its carrier /
//          Shopify claim (case_key alone still works, and means an eBay case)
//   POST {action:'link_claim', item_type, item_key, claim_id, by_name}
//          ...or is pointed at a claim that was already opened
//
//   ops (secret) — for the store-by-store data checks, any store:
//   GET  ?action=sync&stores=OVL&secret=<ops>[&force=1]
//   GET  ?action=detail&store=OVL&kind=inquiry|case|return&id=<n>&secret=<ops>
//   GET  ?stores=LEE&preview=1&secret=<ops>   list a store not yet rolled out,
//                                             including the not-yet-due items
//
// WHAT THIS IS FOR. refund-mismatch emails a manager every morning about orders
// reversed on one marketplace and not the other, but it cannot hear back. A
// mismatch can be completely fine — OVL refunded an eBay buyer, claimed the
// damage on Shopify insurance instead of refunding Shopify, and won — and only
// a person knows that. This is where the person says so. See 0102 / 0103.
//
// ----------------------------------------------------------------------------
// ONE RULE FOR WHEN AN ITEM SHOWS UP, FOR EVERY KIND OF ITEM (Ethan, 2026-09-22)
//
// "Mismatches are checked every day but only show up if one has been open for 3
// days or more unless marked as open. That would also be when it shows up in the
// tool. That needs to be consistent for all of the items."
//
//   1. Checked every day.
//   2. Invisible until it has been open THRESHOLD_DAYS[type] whole Chicago
//      calendar days — the same count refund-mismatch uses, so the tool and the
//      email agree about the same order on the same morning.
//   3. From then on it is "Check-in due" every day until it is settled by the
//      marketplace or resolved (with a reason) by a manager.
//   4. "Still open" takes it off the list for THRESHOLD_DAYS[type] days, then
//      it is due again.
//
// `stateOf` is the only place that rule is written. The combined morning email,
// when it is built, must call it rather than re-deriving it — two copies of this
// rule is how the tool and the email would come to disagree.
//
// Step 2 is SUSPENDED while IGNORE_TIMEFRAMES is on — see that constant.
//
// The other exception is a plain return, which is listed and never worked: see
// `keep` in `list`. Nothing is asked of a manager there, so nothing is held back.
//
// Mismatches keep the detector's month-end tightening (1 day in the last 4 days
// of a month) because that is what the existing email does. Other types do not
// have it yet: it was written for the CFO's month-end list, which is about
// mismatches. Revisit with the email.
//
// ----------------------------------------------------------------------------
// ANSWER EBAY FIRST (0107, narrowed by 0108 — Ethan 2026-09-22). eBay stamps
// every history entry BUYER / SELLER / SYSTEM, so `awaitingReply` knows whose
// move it is without anyone being asked. While it is ours the item is
// `needs_reply`: due every day, and it CANNOT BE CHECKED IN — the server refuses
// that, it is not merely hidden. Snoozing something eBay is waiting on is the
// one move this exists to prevent.
//
// Nobody can assert their way past it either. 0107 had an "I responded on eBay"
// button; Ethan tried it and cut it the same afternoon ("I want to make sure
// that they can't mark it responded if it hasn't been"). The only thing that
// clears the state is a SELLER entry in eBay's own history, which every sweep
// reads. What a manager may still do is mark it RESOLVED with a reason, and eBay
// closing the case settles it — both are outcomes, not claims about having
// pressed send. Payment disputes and chargebacks join this gate when their
// scopes arrive.
//
// ----------------------------------------------------------------------------
// A REFUNDED ITEM-NOT-RECEIVED NEEDS A CLAIM. INRs sit with the returns and
// cases, but if the buyer was refunded the money only comes back through a
// carrier or Shopify claim. So a refunded INR shows at once — the refund has
// already happened, there is nothing to wait for — as "Refunded — needs a
// claim", and cannot be resolved by a note: only by opening or linking a claim.
// While that claim is In Progress the INR is covered (the claim has its own
// 7-day check-in in the Claims tab); once the claim is Recovered or Denied, the
// INR is settled. How "refunded" is detected: see 0103 and `readOutcome`.
//
// The same is true of a MISMATCH with a claim (0105). A mismatch stays open for
// exactly one reason — an insurance claim is being filed for it — so the tool
// opens the claim from the mismatch, links the two, and the claim's own check-in
// takes over from there. Nothing is written until the claim is actually saved.
//
// ----------------------------------------------------------------------------
// ROLLED OUT ONE STORE AT A TIME. ROLLOUT_STORES is who sees the data. OVL
// first: build, check the data against Seller Hub and Shopify, tune the design,
// then add the next store. The ops `preview` read exists so the next store's
// data can be checked BEFORE its manager sees it. The tabs themselves are always
// in the page; a store that is not switched on yet is told so.
//
// ----------------------------------------------------------------------------
// ⚠️ READ-ONLY AGAINST EBAY, ENFORCED THE SAME WAY refund-mismatch DOES IT.
//
// The Post-Order API that lists cases is the same API that RESPONDS to them:
//   read    GET  /post-order/v2/return/search,  /inquiry/{id}
//   refund  POST /post-order/v2/return/{id}/issue_refund
// so `ebayGet` accepts only the anchored search and single-object URLs below and
// hard-codes GET as a second, independent guard. Nothing here responds to,
// refunds or closes anything on eBay; a manager does that on eBay, by hand.
// Writes go only to this feature's own tables, plus a new shopify_claims row
// when a manager opens a claim from here (the same row submit_claim writes).
// refund_mismatch_state is READ here, never written — it belongs to the detector.
//
// AN UNKNOWN STAYS AN UNKNOWN. A failed sweep leaves rows as the last good one
// left them, and says so in ebay_case_sync. A closed INR whose outcome could not
// be read is shown as due, not as settled — it may be a refund nobody claimed.
//
// ----------------------------------------------------------------------------
// PAYMENT DISPUTES AND CHARGEBACKS (0112, 2026-09-23). A buyer went past us to
// their bank or to eBay. Same card for both sites, because to a manager they are
// the same object: our money is held, there is a HARD deadline, and either we
// answered it or we did not.
//
// They are the strongest case for this whole tool. The first read found SEVEN
// open disputes worth $2,168.36 across four stores and NOT ONE had evidence
// submitted; two were due that afternoon. OVL #KS01-13765 ($102) had been lost
// outright the day before without a response — the only one of twelve losses
// with no evidence sent, against ten of ten wins WITH it.
//
// A DISPUTE IS NEVER "TOO NEW TO SHOW". Every other type waits its timeframe
// because acting on day one is pointless. A dispute arrives with a deadline
// attached, so that rule is off for it — see `stateOf`.
//
// THE SITE'S WORD, NEVER OURS (the 0108 principle again). Shopify stamps
// `evidenceSentOn` and moves the status off NEEDS_RESPONSE; eBay moves a dispute
// off ACTION_NEEDED. Both are read. There is no "I answered it" button, for the
// same reason there is no longer one on eBay cases.
//
// Two traps that cost an afternoon on 2026-09-23, both worth knowing before
// touching this:
//   - eBay's payment-dispute endpoints answer on apiz.ebay.com, NOT api.ebay.com,
//     although they are part of the same Fulfillment API whose order/ resource is
//     on api. The wrong gateway returns 404 with a ZERO-LENGTH body and no
//     content-type, which reads exactly like a missing scope and is not.
//   - Shopify needed no new scope at all. read_shopify_payments_accounts, which
//     the app already had, reaches shopifyPaymentsAccount.disputes with full
//     detail. The re-install everyone expected was never necessary.
// eBay's sell.payment.dispute IS needed, and is per-store consent — until Ethan
// signs in, that half reports itself as not connected rather than as broken.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];
// Who sees the Mismatches / eBay Cases tabs. Add a store only after its data
// has been checked with ?preview=1 (see header). All five since 2026-09-22:
// Ethan wants every store populated with what is open now while this is built.
const ROLLOUT_STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];

// ⚠️ BUILD MODE, NOT THE FINISHED BEHAVIOUR (Ethan, 2026-09-22: "let's populate
// them as they show now ignoring the timeframe rules. upon launch ... we can
// have the timeframes going correctly"). While this is true, an item does NOT
// wait THRESHOLD_DAYS before it shows — everything open shows at once, so each
// store's list can be compared against Seller Hub today. A manager's own "Still
// open" check-in still hides an item for its timeframe; only the "too new to
// show yet" part is suspended. FLIP THIS TO false AT LAUNCH.
const IGNORE_TIMEFRAMES = true;

// Item-not-received cases older than this are dropped from the tool entirely
// (Ethan, 2026-09-22: "Any INR from before August we can just ignore now") —
// they are past the carriers' claim windows, so there is nothing to recover and
// listing them only buries the ones that can still be claimed.
const INR_FROM = "2026-08-01";

// --- the timeframe per type, in whole Chicago days ---------------------------
// How old an item must be before it shows, AND how long "Still open" hides it.
// One number per type on purpose: Ethan asked for the two to be the same.
//   mismatch    3  the detector's own bar (1 in the last 4 days of a month)
//   ebay_case   2  eBay gives a seller ~3 business days before it steps in
//   dispute     3  only ever used by a "Still open" check-in, which a dispute
//                  can barely reach: while the site waits on evidence it cannot
//                  be checked in at all, and once we have answered there is
//                  nothing due from us. It is NOT a "hide it for 3 days" bar —
//                  a dispute shows the moment it exists (see stateOf).
const THRESHOLD_DAYS: Record<string, number> = { mismatch: 3, ebay_case: 2, dispute: 3 };
// How long a manager has to put right a "resolved" the site disagrees with
// before it goes to the DM (Ethan, 2026-09-23: "if someone falsely resolves it
// and doesn't un-resolve it after 2 days, it escalates to me"). The item is
// never hidden during those two days — it stays due and says who called it
// resolved; the grace is only on who gets told.
const RESOLUTION_GRACE_DAYS = 2;

// CLAIMS KEEP THE RULE THEY ALREADY HAVE (Ethan, 2026-09-23: "I believe we have
// timing set already for open claims, reminders, etc. I think we keep those?").
// The Claims tab calls a claim aging when it is in_progress and its last
// check-in — or its creation, if it has never been checked — is over 7 days old
// (_isClaimAging / _claimEffectiveDate in speeks.js). Mirrored here rather than
// re-invented so the email cannot chase a claim the tab thinks is fine, and
// deliberately NOT routed through stateOf: a claim is not on the one-visibility
// rule, it has its own, and Ethan asked for that one to stay.
const CLAIM_AGE_DAYS = 7;
const claimAging = (c: any) =>
  c?.status === "in_progress" &&
  Date.parse(c.last_checked_at || c.created_at) < Date.now() - CLAIM_AGE_DAYS * 86_400_000;
const MISMATCH_MONTH_END_DAYS = 1;
const MONTH_END_WINDOW = 4;
const ITEM_TYPES = Object.keys(THRESHOLD_DAYS);
const MIN_REASON = 10;

const SWEEP_DAYS = 120;        // how far back each sweep asks eBay
const SYNC_MIN_MINUTES = 20;   // how often the tool may trigger a sweep, per store
const RECENT_DAYS = 30;        // settled / resolved items stay listed this long
const DETAIL_PER_SWEEP = 60;   // cap on single-object reads per store per sweep

const EBAY_HOSTS: Record<string, string> = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};
// eBay's payment-dispute resources live on a DIFFERENT host to the rest of the
// Fulfillment API. See the header — the wrong one 404s with an empty body.
const ebayZ = (host: string) => host.replace("//api.", "//apiz.");

// shopify_stores.store_code is NULL on all five rows, so the shop domain is the
// only thing identifying a store there. Same map the other functions carry.
const SHOP_BY_STORE: Record<string, string> = {
  OVL: "paymore-overland-park.myshopify.com",
  LEE: "paymore-lees-summit.myshopify.com",
  WSP: "paymore-westport.myshopify.com",
  MPL: "paymore-maplewood.myshopify.com",
  BAL: "paymore-ballwin.myshopify.com",
};
const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";

// Parsed defensively — see refund-mismatch for why.
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

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

function secretOk(g: string) {
  if (g.length !== OPS_SECRET.length) return false;
  let d = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) d |= g.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  return d === 0;
}

function parseStores(v: unknown): string[] {
  const list = Array.isArray(v) ? v : String(v || "").split(",");
  const up = list.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  if (up.includes("ALL")) return [...STORES];
  return [...new Set(up.filter((s) => STORES.includes(s)))];
}
const rolledOut = (stores: string[]) => stores.filter((s) => ROLLOUT_STORES.includes(s));

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const daysAgoIso = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

// --- Chicago calendar days (same arithmetic as refund-mismatch) --------------
const CHI_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
});
const chicagoDay = (d: string | Date) => CHI_DAY.format(new Date(d));   // YYYY-MM-DD
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function isMonthEnd(now = new Date()): boolean {
  const [y, m, d] = chicagoDay(now).split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return (lastDay - d) <= (MONTH_END_WINDOW - 1);
}

// ===========================================================================
// THE ONLY DOOR TO EBAY. Anchored search URLs, or one object by numeric id with
// nothing after it — so .../{id}/issue_refund, .../{id}/close and every other
// action path fail the anchor. GET is hard-coded as a second guard.
// ===========================================================================
const EBAY_SEARCH_RE =
  /^https:\/\/api(?:\.sandbox)?\.ebay\.com\/post-order\/v2\/(?:return|inquiry|casemanagement)\/search\?[^#/]*$/;
const EBAY_DETAIL_RE =
  /^https:\/\/api(?:\.sandbox)?\.ebay\.com\/post-order\/v2\/(?:return|inquiry|casemanagement)\/\d+$/;
// One order, by id, from the Fulfillment API — the only place the order number
// Seller Hub shows can be had for an inquiry or a case (0106). Reads only: that
// API's writes are POSTs to /order/{id}/shipping_fulfillment, which this anchor
// rejects, and ebayGet hard-codes GET anyway.
const EBAY_ORDER_RE =
  /^https:\/\/api(?:\.sandbox)?\.ebay\.com\/sell\/fulfillment\/v1\/order\/[\w-]+$/;
// Payment disputes, on the apiz gateway (0112). The summary search, or one
// dispute by numeric id with NOTHING after it — so /contest, /accept,
// /upload_evidence_file and /update_evidence, which are how a seller actually
// answers a dispute and are all POSTs to .../{id}/<verb>, fail the anchor.
// Answering is a person's job on eBay, exactly as with cases.
const EBAY_DISPUTE_RE =
  /^https:\/\/apiz(?:\.sandbox)?\.ebay\.com\/sell\/fulfillment\/v1\/payment_dispute(?:_summary\?[^#/]*|\/\d+)$/;

async function ebayGet(url: string, token: string): Promise<any> {
  if (!EBAY_SEARCH_RE.test(url) && !EBAY_DETAIL_RE.test(url)
      && !EBAY_ORDER_RE.test(url) && !EBAY_DISPUTE_RE.test(url)) {
    throw new Error(`refused: not a read-only eBay URL -> ${url.slice(0, 120)}`);
  }
  // Post-Order documents the OAuth user token under the "IAF" scheme. It is
  // what worked on 2026-09-22; Bearer is tried only on a 401.
  //
  // The apiz gateway is the exception and takes Bearer ONLY: it answers IAF with
  // a 400 errorId 1003 "Token type in the Authorization header is invalid:IAF",
  // and because that is not a 401 the fallback below would never fire. Worth
  // knowing that api.ebay.com's own Fulfillment order/ resource DOES accept IAF
  // — all 152 order numbers were read that way — so this is a property of the
  // gateway, not of the API. (2026-09-23)
  const schemes = /^https:\/\/apiz\./.test(url) ? ["Bearer"] : ["IAF", "Bearer"];
  let last = "";
  for (const scheme of schemes) {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `${scheme} ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      },
    });
    const text = await res.text();
    if (res.ok) {
      try { return text ? JSON.parse(text) : {}; }
      catch { throw new Error(`eBay ${res.status}: not JSON`); }
    }
    last = `eBay ${res.status}: ${text.slice(0, 200)}`;
    if (res.status !== 401) break;
  }
  throw new Error(last);
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
  if (!res.ok || !b?.access_token) throw new Error(`token ${res.status}: ${JSON.stringify(b).slice(0, 160)}`);
  return b.access_token as string;
}

// eBay wraps dates as { value } and amounts as { value, currency }.
const dateOf = (v: any): string | null => {
  const s = v?.value ?? v?.formattedValue ?? v;
  if (!s || typeof s !== "string") return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
};
const moneyOf = (...vs: any[]) => {
  for (const v of vs) {
    const n = num(v?.value ?? v?.amount);
    if (n != null) return { amount: n, currency: v?.currency ?? v?.currencyId ?? null };
  }
  return { amount: null, currency: null };
};
// Every Post-Order state vocabulary spells a finished case with CLOSED in it.
// Anything else is money still in question — the safe side to err on.
const isClosed = (...states: any[]) =>
  states.some((s) => typeof s === "string" && /CLOSED/i.test(s));

function mapReturn(m: any, store: string) {
  const ci = m.creationInfo || {};
  return {
    kind: "return", ebay_id: String(m.returnId ?? ""), store_code: store,
    order_id: m.orderId ?? null,
    item_id: ci.item?.itemId ?? m.itemId ?? null,
    item_title: ci.item?.itemTitle ?? null,
    buyer: m.buyerLoginName ?? null,
    // reasonType separates buyer remorse from not-as-described, which decides
    // who pays return shipping. Kept in front of the code.
    reason: [ci.reasonType, ci.reason ?? m.reason].filter(Boolean).join(" · ") || null,
    ebay_status: [m.state, m.status].filter(Boolean).join(" / ") || null,
    is_open: !isClosed(m.state, m.status),
    // What was actually refunded once it has been, the estimate until then. The
    // estimate alone overstated a partial refund: OVL return 5323625965 read
    // $1,379.99 estimated against $690.00 refunded (2026-09-22 check).
    ...moneyOf(m.sellerTotalRefund?.actualRefundAmount, m.sellerTotalRefund?.estimatedRefundAmount, m.buyerTotalRefund?.estimatedRefundAmount),
    opened_at: dateOf(ci.creationDate) ?? dateOf(m.creationDate),
    respond_by: dateOf(m.sellerResponseDue?.respondByDate),
    closed_hint: dateOf(m.lastModifiedDate) ?? dateOf(ci.creationDate),
    raw: m,
  };
}
// Inquiries and cases carry no orderId — only item + transaction, which is the
// legacy order id "<itemId>-<transactionId>". It is also how an inquiry and the
// case it escalated into are recognised as the same sale.
const legacyOrder = (m: any) =>
  m.orderId ?? (m.itemId && m.transactionId ? `${m.itemId}-${m.transactionId}` : null);
function mapInquiry(m: any, store: string) {
  return {
    kind: "inquiry", ebay_id: String(m.inquiryId ?? ""), store_code: store,
    order_id: legacyOrder(m),
    item_id: m.itemId != null ? String(m.itemId) : null, item_title: m.itemTitle ?? null,
    buyer: m.buyer ?? m.buyerLoginName ?? null,
    reason: "ITEM_NOT_RECEIVED",
    ebay_status: m.inquiryStatusEnum ?? m.status ?? null,
    is_open: !isClosed(m.inquiryStatusEnum, m.status),
    ...moneyOf(m.claimAmount),
    opened_at: dateOf(m.creationDate),
    respond_by: dateOf(m.respondByDate),
    closed_hint: dateOf(m.lastModifiedDate) ?? dateOf(m.creationDate),
    raw: m,
  };
}
function mapCase(m: any, store: string) {
  return {
    kind: "case", ebay_id: String(m.caseId ?? ""), store_code: store,
    order_id: legacyOrder(m),
    item_id: m.itemId != null ? String(m.itemId) : null, item_title: m.itemTitle ?? null,
    buyer: m.buyer ?? m.buyerLoginName ?? null,
    reason: m.caseType ?? null,
    ebay_status: m.caseStatusEnum ?? m.status ?? null,
    is_open: !isClosed(m.caseStatusEnum, m.status),
    ...moneyOf(m.claimAmount),
    opened_at: dateOf(m.creationDate),
    respond_by: dateOf(m.respondByDate),
    closed_hint: dateOf(m.lastModifiedDate) ?? dateOf(m.creationDate),
    raw: m,
  };
}

const ENDPOINTS = [
  { path: "return", list: (b: any) => b.members || [], map: mapReturn,
    qs: (from: string, pg: number) => `creation_date_range_from=${from}&limit=200&offset=${pg}` },
  { path: "inquiry", list: (b: any) => b.members || [], map: mapInquiry,
    qs: (from: string, pg: number) => `inquiry_creation_date_range_from=${from}&limit=200&offset=${pg}` },
  { path: "casemanagement", list: (b: any) => b.members || b.cases || [], map: mapCase,
    qs: (from: string, pg: number) => `case_creation_date_range_from=${from}&limit=200&offset=${pg}` },
];

// ---------------------------------------------------------------------------
// WHAT HAPPENED TO THE MONEY, from one inquiry's or case's full detail. The
// two signals that held up against all 34 OVL inquiries and cases (0103):
//   inquiry  a history action "... refund completed"   -> refunded
//   case     sellerOutcome LOSE                         -> refunded
// refundAmounts in the same payload read $0.00 even where money moved, so it is
// deliberately not used. Open items get no outcome — it can still change.
// ---------------------------------------------------------------------------
// The carrier's own word, from the same detail. DELIVERED on a refunded INR is
// the one that matters: eBay may hand the money back with no claim at all.
function readTracking(kind: string, d: any) {
  if (kind === "return") return {};
  const t = (d.inquiryHistoryDetails || d.caseHistoryDetails || {}).shipmentTrackingDetails;
  if (!t) return {};
  return {
    tracking_number: t.trackingNumber ?? null,
    tracking_carrier: t.carrier ?? null,
    tracking_status: t.currentStatus ?? null,
    tracking_at: new Date().toISOString(),
  };
}
const isDelivered = (it: any) => /DELIVERED/i.test(String(it.tracking_status || ""));

// WHOSE MOVE IS IT (0107). Every entry in a case or inquiry history is stamped
// BUYER, SELLER or SYSTEM, so the last word tells us whether eBay is waiting on
// us. SYSTEM entries ("Auto Dispose Approve the case") are eBay talking to
// itself and are ignored by both sides.
//
// The field is `actor`. It was first read as `author`, which is silently null on
// every entry — so every open case looked unanswered, including LEE inquiry
// 5386999585 where we had provided tracking two days earlier. Checked against
// the raw payload on 2026-09-22; author/userType are not in it at all.
function readParties(kind: string, d: any) {
  if (kind === "return") return {};
  const hist = ((d.inquiryHistoryDetails || d.caseHistoryDetails || {}).history || []) as any[];
  const latest = (who: string) => hist
    .filter((h) => String(h.actor ?? "").toUpperCase() === who)
    .map((h) => dateOf(h.date)).filter(Boolean).sort().pop() || null;
  return { seller_replied_at: latest("SELLER"), buyer_acted_at: latest("BUYER") };
}
// eBay is waiting on US: still open, and our last word is older than theirs (or
// we have never said anything at all).
const awaitingReply = (it: any) =>
  !!it.is_open && it.kind !== "return" &&
  (!it.seller_replied_at || (!!it.buyer_acted_at && it.seller_replied_at < it.buyer_acted_at));

// THE REPLY WINDOW HAS SHUT (Ethan, 2026-09-23: "I believe eBay doesn't do late
// replies. so when this happens, maybe move the pull to say Missed Reply
// Window?"). Once it has, "answer it on eBay and this clears itself" is false,
// and sending someone to argue a case eBay has stopped listening to wastes an
// afternoon. The money is already gone; what is left is recording why.
//
// SHOPIFY IS DELIBERATELY NOT INCLUDED. Shopify has been seen to take evidence
// after evidenceDueBy, and telling a manager not to bother on a chargeback that
// would still have been accepted is the expensive half of this mistake. A
// Shopify deadline that has passed stays actionable and simply reads as overdue.
// eBay says SELLER_RESPONSE_OVERDUE itself on a dispute; for a case there is no
// such flag, so a respond-by date in the past is the signal.
//
// AN INR IS NOT INCLUDED EITHER, and that is not an oversight. Ethan's "eBay
// doesn't do late replies" was answering a question about two escalated CASES.
// An item-not-received REQUEST past its date is a different animal: eBay steps
// in and usually finds for the buyer, but we can still refund, and refunding
// late is far better than eBay doing it for us. Telling a manager the window is
// shut on one they could still act on is the expensive direction to be wrong in,
// so an overdue INR stays due and simply reads as late.
const missedWindow = (type: string, it: any) =>
  type === "dispute"
    ? it.source === "ebay" && !!it.response_overdue
    : it.kind === "case" && !!it.respond_by && Date.parse(it.respond_by) < Date.now();

function readOutcome(kind: string, d: any) {
  // A return's money is the refund-mismatch detector's business, not this read's.
  if (kind === "return") return {};
  const hist = ((d.inquiryHistoryDetails || d.caseHistoryDetails || {}).history || []) as any[];
  const caseType = kind === "case" ? (d.caseType ?? null) : null;
  const open = kind === "inquiry" ? !isClosed(d.state, d.status) : !isClosed(d.status);
  if (open) return { case_type: caseType, outcome: null, outcome_detail: null };
  if (kind === "inquiry") {
    const hit = hist.find((h) => /refund completed/i.test(String(h.action || "")));
    return hit
      ? { case_type: null, outcome: "refunded", outcome_detail: `${hit.action} ${String(dateOf(hit.date) || "").slice(0, 10)}`.trim() }
      : { case_type: null, outcome: "no_refund", outcome_detail: String(hist[hist.length - 1]?.action || "closed") };
  }
  return d.sellerOutcome === "LOSE"
    ? { case_type: caseType, outcome: "refunded", outcome_detail: "eBay ruled for the buyer" }
    : { case_type: caseType, outcome: "no_refund", outcome_detail: `eBay outcome: ${d.sellerOutcome || "unknown"}` };
}

// ===========================================================================
// DISPUTES — the other door, and the Shopify one. See the header.
//
// Shopify's Admin API reads through POST /graphql.json, so "hard-code GET" is
// not available as a guard here the way it is for eBay. The guard instead is
// that the query is a CONSTANT in this file, never assembled from anything a
// caller sent, and `shopifyRead` refuses any text containing `mutation`. A
// chargeback is answered in the Shopify admin by a person, not from here.
// ===========================================================================
const SHOPIFY_DISPUTES_QL = `{
  shopifyPaymentsAccount {
    disputes(first: 100, reverse: true) {
      edges { node {
        id legacyResourceId status type
        amount { amount currencyCode }
        reasonDetails { reason networkReasonCode }
        evidenceDueBy evidenceSentOn finalizedOn initiatedAt
        order { id name }
      } }
    }
  }
}`;

async function shopifyRead(shop: string, token: string, query: string): Promise<any> {
  if (/\bmutation\b/i.test(query)) throw new Error("refused: not a read-only Shopify query");
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  if (body?.errors?.length) throw new Error(`Shopify: ${JSON.stringify(body.errors).slice(0, 200)}`);
  return body?.data;
}

// Shopify's DisputeStatus is the whole state machine, checked against all 29
// disputes the five stores have ever had (2026-09-23):
//   NEEDS_RESPONSE  open, waiting on US   — 0 of 7 had evidenceSentOn
//   UNDER_REVIEW    open, waiting on THEM — we have answered
//   WON / LOST / ACCEPTED / PREVENTED     — finished, finalizedOn set
// evidenceSentOn was set on 10 of 10 wins and absent on every NEEDS_RESPONSE,
// so it is trustworthy as "when we answered".
const SHOPIFY_OPEN = new Set(["NEEDS_RESPONSE", "UNDER_REVIEW"]);
function mapShopifyDispute(n: any, store: string) {
  const st = String(n.status ?? "").toUpperCase();
  const open = SHOPIFY_OPEN.has(st);
  return {
    dispute_key: `shopify:${n.legacyResourceId}`, source: "shopify",
    external_id: String(n.legacyResourceId ?? ""), store_code: store,
    order_no: n.order?.name ?? null, order_id: n.order?.id ?? null,
    item_title: null, buyer: null,
    amount: num(n.amount?.amount), currency: n.amount?.currencyCode ?? null,
    dispute_type: n.type ?? null,
    reason: n.reasonDetails?.reason ?? null,
    reason_code: n.reasonDetails?.networkReasonCode ?? null,
    status_raw: st, is_open: open,
    needs_response: st === "NEEDS_RESPONSE",
    responded_at: n.evidenceSentOn ?? null,
    opened_at: n.initiatedAt ?? null,
    respond_by: n.evidenceDueBy ?? null,
    closed_at: n.finalizedOn ?? null,
    outcome: open ? null : st.toLowerCase(),
    raw: n,
  };
}

// eBay's payment_dispute_summary is nearly content-free: every live dispute on
// 2026-09-23 read paymentDisputeStatus "OPEN" with no deadline and no sign of
// whether we had answered. The documented ACTION_NEEDED never appeared. So the
// summary only establishes that a dispute EXISTS and what it is worth; whether
// it needs us is settled by the detail pass below.
const mapEbayDispute = (m: any, store: string) => {
  const st = String(m.paymentDisputeStatus ?? m.disputeStatus ?? "").toUpperCase();
  const open = !/CLOSED|RESOLVED/.test(st);
  const money = moneyOf(m.amount);
  return {
    dispute_key: `ebay:${m.paymentDisputeId}`, source: "ebay",
    external_id: String(m.paymentDisputeId ?? ""), store_code: store,
    order_no: m.orderId ?? null, order_id: m.orderId ?? null,
    buyer: m.buyerUsername ?? null,
    amount: money.amount, currency: money.currency,
    dispute_type: "CHARGEBACK",
    reason: m.reason ?? null, reason_code: null,
    status_raw: st, is_open: open,
    // Assume it needs us until the detail says otherwise — an unread dispute
    // shown in red is an afternoon wasted; an unread dispute shown as answered
    // is the money.
    needs_response: open,
    opened_at: dateOf(m.openDate),
    closed_at: open ? null : dateOf(m.closedDate) ?? null,
    raw: m,
  };
};

// WHOSE MOVE IS IT, from one dispute's detail — eBay's answer to the `actor`
// question that 0107 settled for cases. Checked against all six open disputes
// on 2026-09-23:
//   sellerResponse absent           still ours, and we can still act
//   SELLER_CONTEST / SELLER_ACCEPT  answered; evidence[].providedDate says when
//   SELLER_RESPONSE_OVERDUE         never answered and the window has SHUT
// availableChoices lists what eBay will still accept from us; it is empty both
// when we have answered and when we are too late, so it cannot be read alone.
// The deadline lives on the evidence entry, not at the top level.
function readEbayDisputeDetail(d: any) {
  const resp = String(d.sellerResponse ?? "").toUpperCase();
  const ev = (d.evidence || [])[0] || {};
  const overdue = resp === "SELLER_RESPONSE_OVERDUE";
  const answered = !!resp && !overdue;
  return {
    seller_response: resp || null,
    response_overdue: overdue,
    // Overdue still counts as unanswered: the money is at risk and nobody dealt
    // with it. What changes is that it can no longer be fixed by responding, so
    // the card and the refusal say something different (see stateOf and the POST
    // gate).
    needs_response: !answered,
    responded_at: answered ? dateOf(ev.providedDate) : null,
    respond_by: dateOf(ev.respondByDate) ?? dateOf(d.respondByDate),
    detail_checked_at: new Date().toISOString(),
  };
}

// One store, both sites. Each source is recorded separately in dispute_sync, so
// "eBay is not connected yet" never reads as "chargebacks are broken".
async function sweepDisputes(sb: any, store: string, ebayRow: any, shopRow: any) {
  const nowIso = new Date().toISOString();
  const out: Record<string, any> = {};

  const save = async (source: string, rows: any[], ok: boolean, detail: string) => {
    if (rows.length) {
      const keys = rows.map((r) => r.dispute_key);
      const { data: prior } = await sb.from("payment_disputes").select("dispute_key,first_seen").in("dispute_key", keys);
      const seenBy: Record<string, string> = Object.fromEntries((prior || []).map((p: any) => [p.dispute_key, p.first_seen]));
      const up = rows.map((r) => ({ ...r, first_seen: seenBy[r.dispute_key] || nowIso, last_synced: nowIso }));
      const { error } = await sb.from("payment_disputes").upsert(up, { onConflict: "dispute_key" });
      if (error) { ok = false; detail = `save: ${error.message}`; }
    }
    await sb.from("dispute_sync").upsert(
      { store_code: store, source, synced_at: nowIso, ok, detail }, { onConflict: "store_code,source" });
    out[source] = { ok, count: rows.length, detail };
  };

  // --- Shopify chargebacks ---
  try {
    if (!shopRow?.access_token) throw new Error("no Shopify credentials");
    const d = await shopifyRead(shopRow.shop, shopRow.access_token, SHOPIFY_DISPUTES_QL);
    const edges = d?.shopifyPaymentsAccount?.disputes?.edges || [];
    const rows = edges.map((e: any) => mapShopifyDispute(e.node, store)).filter((r: any) => r.external_id);
    await save("shopify", rows, true, `${rows.length} read`);
  } catch (e) {
    await save("shopify", [], false, String((e as any)?.message ?? e).slice(0, 200));
  }

  // --- eBay payment disputes ---
  try {
    if (!ebayRow?.refresh_token) throw new Error("no eBay credentials");
    const host = ebayZ(EBAY_HOSTS[ebayRow.environment as string] || EBAY_HOSTS.production);
    const token = await mintToken(ebayRow);
    const rows: any[] = [];
    // open_disputes=true is the short list that matters; a second pass with no
    // filter brings in the ones that closed, for the recently-settled view.
    for (const qs of ["open_disputes=true&limit=200", "limit=200"]) {
      const b = await ebayGet(`${host}/sell/fulfillment/v1/payment_dispute_summary?${qs}`, token);
      for (const m of b?.paymentDisputeSummaries || []) {
        const r = mapEbayDispute(m, store);
        if (r.external_id && !rows.some((x) => x.dispute_key === r.dispute_key)) rows.push(r);
      }
    }
    await save("ebay", rows, true, `${rows.length} read`);

    // Detail pass — this is where "have we answered" actually comes from. Open
    // disputes are re-read every sweep (the answer changes); closed ones once,
    // so the settled list can say how each ended.
    const { data: want } = await sb.from("payment_disputes")
      .select("dispute_key,external_id,is_open")
      .eq("store_code", store).eq("source", "ebay")
      .or("is_open.eq.true,detail_checked_at.is.null")
      .order("opened_at", { ascending: false }).limit(DETAIL_PER_SWEEP);
    let bad = 0;
    for (const p of want || []) {
      try {
        const d = await ebayGet(`${host}/sell/fulfillment/v1/payment_dispute/${encodeURIComponent(p.external_id)}`, token);
        await sb.from("payment_disputes").update(readEbayDisputeDetail(d)).eq("dispute_key", p.dispute_key);
      } catch { bad++; }
    }
    if (bad) {
      out.ebay.ok = false;
      out.ebay.detail = `${rows.length} read, ${bad} of ${(want || []).length} details unread`;
      await sb.from("dispute_sync").upsert(
        { store_code: store, source: "ebay", synced_at: nowIso, ok: false, detail: out.ebay.detail },
        { onConflict: "store_code,source" });
    }
  } catch (e) {
    const msg = String((e as any)?.message ?? e);
    // 1100 is eBay's "insufficient permissions": the store has not consented to
    // sell.payment.dispute yet. That is a setup step, not a failure, and it is
    // worth saying so in the words the fix needs.
    const notConnected = /\b1100\b|Insufficient permissions|Access denied/i.test(msg);
    await save("ebay", [], false,
      notConnected ? "eBay payment disputes need a one-time sign-in for this store (sell.payment.dispute)" : msg.slice(0, 200));
  }
  return out;
}

async function sweepStore(sb: any, ebayRow: any) {
  const store = ebayRow.store_code;
  const host = EBAY_HOSTS[ebayRow.environment as string] || EBAY_HOSTS.production;
  const token = await mintToken(ebayRow);
  const from = daysAgoIso(SWEEP_DAYS);
  const rows: any[] = [];
  const notes: string[] = [];
  let failed = false;
  for (const ep of ENDPOINTS) {
    try {
      // Post-Order's offset is a PAGE number starting at 1.
      for (let page = 1; page <= 10; page++) {
        const body = await ebayGet(`${host}/post-order/v2/${ep.path}/search?${ep.qs(from, page)}`, token);
        const items = ep.list(body);
        for (const m of items) {
          const r = ep.map(m, store);
          if (r.ebay_id) rows.push(r);
        }
        const total = num(body?.paginationOutput?.totalEntries ?? body?.total) ?? 0;
        if (items.length < 200 || page * 200 >= total) break;
      }
      notes.push(`${ep.path} ok`);
    } catch (e) {
      failed = true;
      notes.push(`${ep.path}: ${String((e as any)?.message ?? e).slice(0, 160)}`);
    }
  }
  const nowIso = new Date().toISOString();
  if (rows.length) {
    // closed_at: stamped when a sweep sees an item go from open to closed. An
    // item ALREADY closed when first seen is dated from eBay's last-modified
    // date — stamping 120 days of history "closed today" once listed seven
    // hundred finished returns as having just settled.
    const keys = rows.map((r) => `${r.kind}:${r.ebay_id}`);
    const { data: prior } = await sb.from("ebay_cases").select("case_key,closed_at,first_seen,item_title").in("case_key", keys);
    const priorBy: Record<string, any> = Object.fromEntries((prior || []).map((p: any) => [p.case_key, p]));
    const up = rows.map(({ closed_hint, ...r }) => {
      const key = `${r.kind}:${r.ebay_id}`;
      const p = priorBy[key];
      return {
        case_key: key, ...r,
        closed_at: r.is_open ? null : (p?.closed_at || (p ? nowIso : (closed_hint || nowIso))),
        // The search carries no title; keep the one a detail read found, or
        // every sweep would blank it and read it again.
        item_title: r.item_title ?? p?.item_title ?? null,
        first_seen: p?.first_seen || nowIso,
        last_synced: nowIso,
      };
    });
    const { error } = await sb.from("ebay_cases").upsert(up, { onConflict: "case_key" });
    if (error) { failed = true; notes.push(`save: ${error.message}`); }
  }

  // Detail pass: every inquiry and case whose outcome is not settled yet — the
  // open ones (they can still turn into a refund) and closed ones not read yet.
  // Cases are read even when closed because the search summary does not say
  // whether a case is an escalated RETURN or an escalated INR; only the detail
  // does, and only an INR belongs with the INRs.
  // A refunded INR is read again every sweep until the parcel is delivered: a
  // late delivery is money back from eBay without a claim (0106).
  const { data: pending } = await sb.from("ebay_cases").select("case_key,kind,ebay_id")
    .eq("store_code", store).in("kind", ["inquiry", "case"])
    .or("is_open.eq.true,outcome.is.null,and(outcome.eq.refunded,tracking_status.is.null),and(outcome.eq.refunded,tracking_status.neq.DELIVERED)")
    .order("opened_at", { ascending: false }).limit(DETAIL_PER_SWEEP);
  // Titles. The search summaries carry none, and a list of bare item numbers is
  // not something a manager can check against Seller Hub — the 2026-09-22 OVL
  // comparison was done by item title. Read once per item (a title does not
  // change), then never again: the item_title filter stops the re-read.
  const { data: untitled } = await sb.from("ebay_cases").select("case_key,kind,ebay_id")
    .eq("store_code", store).eq("kind", "return").eq("is_open", true).is("item_title", null)
    .limit(DETAIL_PER_SWEEP);
  const { data: pending2 } = await sb.from("ebay_cases").select("case_key,kind,ebay_id")
    .eq("store_code", store).in("kind", ["inquiry", "case"]).is("item_title", null)
    .limit(DETAIL_PER_SWEEP);
  // The order number Seller Hub shows, once per inquiry or case (0106).
  const { data: noOrder } = await sb.from("ebay_cases").select("case_key,kind,ebay_id,order_id")
    .eq("store_code", store).in("kind", ["inquiry", "case"]).is("order_no", null)
    .limit(DETAIL_PER_SWEEP);
  for (const p of noOrder || []) {
    if (!p.order_id) { await sb.from("ebay_cases").update({ order_no: "" }).eq("case_key", p.case_key); continue; }
    try {
      const o = await ebayGet(`${host}/sell/fulfillment/v1/order/${encodeURIComponent(p.order_id)}`, token);
      await sb.from("ebay_cases").update({ order_no: String(o?.orderId || "") }).eq("case_key", p.case_key);
    } catch { await sb.from("ebay_cases").update({ order_no: "" }).eq("case_key", p.case_key); }
  }
  // Cases not yet linked to the return they escalated from (0104). Read once;
  // an INR case names no return and is stamped '' so it is not asked again.
  const { data: unlinked } = await sb.from("ebay_cases").select("case_key,kind,ebay_id")
    .eq("store_code", store).eq("kind", "case").is("return_id", null)
    .limit(DETAIL_PER_SWEEP);
  // Outcome reads first, since those decide what is due; titles after. A case
  // that borrows its title from a return read later in this same pass picks it
  // up on the next sweep instead.
  // Rows read FOR a title. One that has none to give (an escalated INR case
  // names no return) is stamped '' — "tried, none" — so it is not re-read
  // every sweep for a title that will never come.
  const wantTitle = new Set([...(pending2 || []), ...(untitled || [])].map((p: any) => p.case_key));
  const seen = new Set<string>();
  const reads = [...(pending || []), ...(pending2 || []), ...(untitled || []), ...(unlinked || [])]
    .filter((p: any) => !seen.has(p.case_key) && !!seen.add(p.case_key));
  let detailFail = 0;
  for (const p of reads) {
    const path = p.kind === "case" ? "casemanagement" : p.kind;
    try {
      const d = await ebayGet(`${host}/post-order/v2/${path}/${p.ebay_id}`, token);
      // An INR case answers returnId "-1" — no return behind it.
      const returnId = d?.returnId != null && /^\d+$/.test(String(d.returnId)) ? String(d.returnId) : "";
      let title = p.kind === "return" ? d?.detail?.itemDetail?.itemTitle
        : p.kind === "inquiry" ? d?.itemDetails?.itemTitle : null;
      // A case has no title of its own; an escalated return names the return
      // it came from, which does.
      if (!title && p.kind === "case" && returnId) {
        const { data: r } = await sb.from("ebay_cases").select("item_title")
          .eq("case_key", `return:${returnId}`).maybeSingle();
        title = r?.item_title ?? null;
        // A return that closed (escalated) before it was ever read has no
        // title either; read it once, for the case and for the return.
        if (!title) {
          try {
            const rd = await ebayGet(`${host}/post-order/v2/return/${returnId}`, token);
            title = rd?.detail?.itemDetail?.itemTitle ?? null;
            if (title) await sb.from("ebay_cases").update({ item_title: String(title) }).eq("case_key", `return:${returnId}`);
          } catch { /* the case keeps no title; not worth failing the read */ }
        }
      }
      await sb.from("ebay_cases").update({
        ...readOutcome(p.kind, d),
        ...readTracking(p.kind, d),
        ...readParties(p.kind, d),
        ...(p.kind === "case" ? { return_id: returnId } : {}),
        ...(title ? { item_title: String(title) } : wantTitle.has(p.case_key) ? { item_title: "" } : {}),
        detail_checked_at: nowIso,
      }).eq("case_key", p.case_key);
    } catch { detailFail++; }
  }
  if (detailFail) { failed = true; notes.push(`detail: ${detailFail} of ${reads.length} unread`); }
  else if (reads.length) notes.push(`detail ok (${reads.length})`);

  const detail = notes.join("; ");
  await sb.from("ebay_case_sync").upsert(
    { store_code: store, synced_at: nowIso, ok: !failed, detail }, { onConflict: "store_code" });
  return { ok: !failed, count: rows.length, detail };
}

async function sync(sb: any, stores: string[], force: boolean) {
  const cutoff = Date.now() - SYNC_MIN_MINUTES * 60_000;
  const isDue = (r: any) => force || !r || !r.ok || new Date(r.synced_at).getTime() < cutoff;

  const { data: last } = await sb.from("ebay_case_sync").select("*").in("store_code", stores);
  const lastBy: Record<string, any> = Object.fromEntries((last || []).map((r: any) => [r.store_code, r]));
  const due = stores.filter((s) => isDue(lastBy[s]));

  // Disputes keep their OWN throttle, per store and per source, so an eBay half
  // that is not consented yet (and so never reads ok) cannot drag the Shopify
  // half into re-reading on every single page load.
  const { data: lastD } = await sb.from("dispute_sync").select("*").in("store_code", stores);
  const dBy: Record<string, any> = {};
  for (const r of lastD || []) (dBy[r.store_code] ||= {})[r.source] = r;
  const dueD = stores.filter((s) => isDue(dBy[s]?.shopify) || isDue(dBy[s]?.ebay));

  const out: Record<string, any> = {};
  const touched = [...new Set([...due, ...dueD])];
  if (!touched.length) return { swept: out, skipped: stores };

  const { data: ebayRows } = await sb.from("ebay_stores")
    .select("store_code,refresh_token,scopes,environment").in("store_code", touched);
  // shopify_stores.store_code is null, so match on the shop domain (see the map).
  const { data: shopRows } = await sb.from("shopify_stores").select("shop,store_code,access_token");
  const shopFor = (s: string) => (shopRows || []).find((r: any) =>
    r.store_code === s || r.shop === SHOP_BY_STORE[s]) || null;

  await Promise.all(touched.map(async (s) => {
    const row = (ebayRows || []).find((r: any) => r.store_code === s);
    if (due.includes(s)) {
      try {
        if (!row?.refresh_token) throw new Error("no eBay credentials");
        out[s] = await sweepStore(sb, row);
      } catch (e) {
        const detail = String((e as any)?.message ?? e).slice(0, 200);
        await sb.from("ebay_case_sync").upsert(
          { store_code: s, synced_at: new Date().toISOString(), ok: false, detail }, { onConflict: "store_code" });
        out[s] = { ok: false, count: 0, detail };
      }
    }
    // A dispute sweep never fails the store's sweep: it records its own state
    // per source and each side reports itself.
    if (dueD.includes(s)) {
      try {
        out[s] = { ...(out[s] || {}), disputes: await sweepDisputes(sb, s, row, shopFor(s)) };
      } catch (e) {
        out[s] = { ...(out[s] || {}), disputes: { error: String((e as any)?.message ?? e).slice(0, 200) } };
      }
    }
  }));
  return { swept: out, skipped: stores.filter((s) => !touched.includes(s)) };
}

// ===========================================================================
// THE RULE. See the header — this is the one place it is written.
//
//   waiting      too new to show (hidden from managers)
//   due          check-in due: on the list every day until someone acts
//   checked      "Still open" was pressed; off the list until due_on
//   needs_reply  eBay is waiting on an answer from us — due at once, and it
//                cannot be checked in until eBay's history shows our reply
//                (0107/0108). Resolving it with a reason still works.
//   needs_claim  a refunded INR with no claim — due at once, resolved only by a claim
//   answered     a dispute we have answered — the card network decides now, and
//                nothing is due from us until it does (0112)
//   covered      its claim is In Progress — the claim does the reminding now
//   resolved     a manager said it is settled, and why
//   settled      the marketplaces settled it (sites agree / eBay closed it /
//                the INR's claim finished)
// ===========================================================================
const isInr = (it: any) => it.kind === "inquiry" || (it.kind === "case" && it.case_type === "ITEM_NOT_RECEIVED");

function stateOf(type: string, it: any, review: any, ctx: any): { state: string; due_on: string | null; note?: string } {
  const today = ctx.today;
  // A DISPUTE RUNS ON THE SITE'S CLOCK, NOT OURS (0112). It has a real deadline
  // from the moment it exists, so it never waits a timeframe and it never has a
  // claim — the whole question is whether we answered before the date. Ordering
  // matches the eBay-case gate: a written resolution still counts, but nothing
  // else gets past `needs_response`.
  if (type === "dispute") {
    const missed = missedWindow(type, it);
    // A RESOLUTION NEVER OUTRANKS THE SITE. Until this, a manager could take an
    // unanswered $899 chargeback, type ten characters, and it went quiet for
    // good — the exact thing Ethan said must not be possible ("I don't want them
    // to be able to resolve something that isn't actually resolved and then that
    // money could just get lost in the wind"). Now the site wins: while it still
    // wants evidence AND we could still give it, the item stays due and says who
    // called it resolved. The honest uses are unharmed and self-correct within a
    // day — refunding the buyer or accepting the dispute moves it off
    // NEEDS_RESPONSE on its own. Once the window has shut there is nothing left
    // to do but record what happened, so a resolution stands (below).
    if (it.is_open && it.needs_response && !missed && review?.status === "resolved") {
      return { state: "needs_reply", due_on: today, note: "resolution_disputed" };
    }
    if (review?.status === "resolved") return { state: "resolved", due_on: null };
    if (!it.is_open) return { state: "settled", due_on: null, note: it.outcome || undefined };
    // Overdue is still needs_reply — unanswered money nobody dealt with — but
    // it is flagged, because "respond on eBay and this clears" is no longer
    // true and telling a manager otherwise wastes their time.
    if (it.needs_response) {
      return { state: "needs_reply", due_on: today, note: missed ? "missed_window" : undefined };
    }
    return { state: "answered", due_on: null };
  }
  const claim = ctx.claimFor(type, it);
  if (type === "ebay_case" && isInr(it)) {
    if (claim) {
      if (claim.status === "in_progress") return { state: "covered", due_on: null };
      return { state: "settled", due_on: null, note: `claim ${claim.status}` };
    }
    if (it.outcome === "refunded") return { state: "needs_claim", due_on: today };
    if (!it.is_open && it.outcome == null) {
      // Closed, but we could not read whether the buyer was refunded. Could be
      // an unclaimed refund, so it is shown rather than settled.
      return { state: "due", due_on: today, note: "outcome unread" };
    }
  }
  // A closed case not read in detail yet might be an escalated INR that ended
  // in a refund — only the detail says which. Shown until it has been read.
  if (type === "ebay_case" && it.kind === "case" && !it.is_open && it.case_type == null) {
    return { state: "due", due_on: today, note: "outcome unread" };
  }
  if (type === "mismatch" ? !!it.resolved_at : !it.is_open) return { state: "settled", due_on: null };
  // ONCE A CLAIM EXISTS, THE CLAIM IS THE THING BEING CHASED (Ethan, 2026-09-22:
  // "if it is a claim that gets opened, then the current rules for reminding
  // about open claims is the norm for them. same with INR claims"). So the item
  // stops running its own check-in — the claim's 7-day one in the Claims tab
  // takes over — and it settles when the claim is Recovered or Denied.
  if (claim) {
    if (claim.status === "in_progress") return { state: "covered", due_on: null };
    return { state: "settled", due_on: null, note: `claim ${claim.status}` };
  }
  // Same honesty rule as a dispute: while eBay is still waiting on us AND can
  // still be answered, a manager's "resolved" does not silence it. It is
  // recorded, it is shown, and it escalates — see the dispute branch above for
  // the reasoning. Once the reply window has shut, a resolution stands, because
  // recording the outcome is the only move left.
  if (type === "ebay_case" && ctx.awaiting(it) && !missedWindow(type, it)
      && review?.status === "resolved") {
    return { state: "needs_reply", due_on: today, note: "resolution_disputed" };
  }
  // A manager saying it is settled, and why, still counts — including while eBay
  // waits on us (0108). That is a written, attributed claim about the outcome,
  // not a claim about having pressed send.
  if (review?.status === "resolved") return { state: "resolved", due_on: null };
  // ANSWER EBAY FIRST (0107/0108). While eBay is waiting on a reply from us the
  // item cannot be CHECKED IN — snoozing something eBay is waiting on is the one
  // move this layer exists to prevent. Nobody can assert their way out of it
  // either: the only thing that clears it is a SELLER entry in eBay's own
  // history, which the sweep reads. Resolving it (above) and eBay closing it
  // both still work.
  if (type === "ebay_case" && ctx.awaiting(it)) {
    return { state: "needs_reply", due_on: today, note: missedWindow(type, it) ? "missed_window" : undefined };
  }

  const days = type === "mismatch" && ctx.monthEnd ? MISMATCH_MONTH_END_DAYS : THRESHOLD_DAYS[type];
  const from = review?.status === "still_open"
    ? chicagoDay(review.updated_at)
    // An escalated return counts from when the RETURN opened: it was already on
    // the list, and escalating it must not hide it again for two days.
    : chicagoDay(type === "mismatch" ? it.reversed_at : (it.return?.opened_at || it.opened_at));
  const due_on = addDays(from, days);
  if (today >= due_on) return { state: "due", due_on };
  // A check-in the manager made is honoured either way; only "too new to show"
  // is suspended while IGNORE_TIMEFRAMES is on (see the constant).
  if (review?.status === "still_open") return { state: "checked", due_on };
  return IGNORE_TIMEFRAMES ? { state: "due", due_on } : { state: "waiting", due_on };
}

async function list(sb: any, stores: string[], opts: { includeWaiting?: boolean } = {}) {
  const recent = daysAgoIso(RECENT_DAYS);
  const [mm, cs, rv, ev, sy, ln, cl, dp, ds] = await Promise.all([
    sb.from("refund_mismatch_state").select("*").in("store_code", stores)
      .or(`resolved_at.is.null,resolved_at.gte.${recent}`),
    // A refunded INR stays in the read however old it is: until it has a claim
    // it is money we have not chased.
    sb.from("ebay_cases")
      .select("case_key,store_code,kind,case_type,return_id,ebay_id,order_id,order_no,item_id,item_title,buyer,reason,ebay_status,is_open,amount,currency,opened_at,respond_by,closed_at,outcome,outcome_detail,tracking_number,tracking_carrier,tracking_status,tracking_at,seller_replied_at,buyer_acted_at,first_seen,last_synced")
      .in("store_code", stores).or(`is_open.eq.true,closed_at.gte.${recent},outcome.eq.refunded`),
    sb.from("hold_reviews").select("*").in("store_code", stores),
    sb.from("hold_review_events").select("*").in("store_code", stores)
      .order("at", { ascending: false }).limit(1000),
    sb.from("ebay_case_sync").select("*").in("store_code", stores),
    sb.from("hold_claim_links").select("*").in("store_code", stores),
    // last_checked_at is what a claim ages FROM once someone has checked in on
    // it; without it every claim would age from creation and the email would
    // chase claims the Claims tab considers fine.
    sb.from("shopify_claims").select("id,store,case_number,item_sku,price,reason_type,status,created_at,resolved_at,parent_id,last_checked_at")
      .in("store", stores).order("created_at", { ascending: false }).limit(500),
    // Open disputes however old — an unanswered chargeback does not stop
    // mattering because it has been ignored for a month — plus recently closed
    // ones, which are where "we lost this without replying" shows up.
    sb.from("payment_disputes")
      .select("dispute_key,source,external_id,store_code,order_no,order_id,item_title,buyer,amount,currency,dispute_type,reason,reason_code,status_raw,is_open,needs_response,response_overdue,seller_response,responded_at,opened_at,respond_by,closed_at,outcome,first_seen,last_synced")
      .in("store_code", stores).or(`is_open.eq.true,closed_at.gte.${recent}`),
    sb.from("dispute_sync").select("*").in("store_code", stores),
  ]);
  for (const r of [mm, cs, rv, ev, sy, ln, cl, dp, ds]) if (r.error) throw new Error(r.error.message);

  const claimsById: Record<string, any> = Object.fromEntries((cl.data || []).map((c: any) => [c.id, c]));
  const caseByKey: Record<string, any> = Object.fromEntries((cs.data || []).map((c: any) => [c.case_key, c]));
  // A claim linked to the inquiry also covers the case it escalated into, and
  // the other way round — same sale, same legacy order id.
  const claimByItem: Record<string, any> = {};
  const claimByOrder: Record<string, any> = {};
  for (const l of ln.data || []) {
    const c = claimsById[l.claim_id];
    if (!c) continue;
    claimByItem[`${l.item_type}|${l.item_key}`] = c;
    const o = l.item_type === "ebay_case" ? caseByKey[l.item_key]?.order_id : null;
    if (o) claimByOrder[`${l.store_code}|${o}`] = c;
  }
  const ctx = {
    today: chicagoDay(new Date()),
    monthEnd: isMonthEnd(),
    awaiting: awaitingReply,
    claimFor: (type: string, it: any) =>
      claimByItem[`${type}|${type === "mismatch" ? it.issue_key : it.case_key}`]
      || (type === "ebay_case" && it.order_id ? claimByOrder[`${it.store_code}|${it.order_id}`] : null) || null,
  };

  const reviewBy: Record<string, any> = {};
  for (const r of rv.data || []) reviewBy[`${r.item_type}|${r.item_key}`] = r;
  const eventsBy: Record<string, any[]> = {};
  for (const e of ev.data || []) (eventsBy[`${e.item_type}|${e.item_key}`] ||= []).push(e);

  // A case has no title of its own. Borrow one from any return or inquiry on
  // the same eBay item — the same listing, whatever the order.
  const titleByItem: Record<string, string> = {};
  for (const c of cs.data || []) if (c.item_title && c.item_id) titleByItem[`${c.store_code}|${c.item_id}`] = c.item_title;
  for (const c of cs.data || []) if (!c.item_title && c.item_id) c.item_title = titleByItem[`${c.store_code}|${c.item_id}`] || null;

  // ONE CARD PER SALE (0104). An escalated return is the return plus the case
  // eBay opened for it — the same money. The case is the live stage, so it is
  // the card; the return's id, order number, title and amount fold into it and
  // the return is left out. The return is fetched even when it closed outside
  // the recent window: a case can outlive its return by weeks.
  const cols = "case_key,store_code,ebay_id,order_id,item_title,reason,amount,ebay_status,opened_at";
  const retById: Record<string, any> = {};
  for (const c of cs.data || []) if (c.kind === "return") retById[`${c.store_code}|${c.ebay_id}`] = c;
  const missing = (cs.data || []).filter((c: any) => c.kind === "case" && c.return_id && !retById[`${c.store_code}|${c.return_id}`])
    .map((c: any) => `return:${c.return_id}`);
  if (missing.length) {
    const { data: more, error } = await sb.from("ebay_cases").select(cols).in("case_key", missing);
    if (error) throw new Error(error.message);
    for (const r of more || []) retById[`${r.store_code}|${r.ebay_id}`] = r;
  }
  const folded = new Set<string>();
  for (const c of cs.data || []) {
    const r = c.kind === "case" && c.return_id ? retById[`${c.store_code}|${c.return_id}`] : null;
    if (!r) continue;
    folded.add(r.case_key);
    c.return = { case_key: r.case_key, ebay_id: r.ebay_id, order_id: r.order_id, amount: r.amount, ebay_status: r.ebay_status, opened_at: r.opened_at };
    if (!c.item_title) c.item_title = r.item_title;
    if (r.reason) c.reason = r.reason;
    // eBay's case amount read $0 on two OVL escalations whose returns said
    // $159.99 and $139.99. The case's own figure wins when it has one.
    if (!(Number(c.amount) > 0) && Number(r.amount) > 0) { c.amount = r.amount; c.currency = c.currency || "USD"; }
  }
  const caseRows = (cs.data || []).filter((c: any) => !folded.has(c.case_key));

  const waiting: Record<string, number> = { mismatch: 0, ebay_case: 0, dispute: 0 };
  const build = (type: string, it: any, key: string) => {
    // A check-in made on the return before it escalated carries onto the case
    // until someone acts on the case itself.
    const review = reviewBy[`${type}|${key}`] || (it.return ? reviewBy[`${type}|${it.return.case_key}`] : null) || null;
    const s = stateOf(type, it, review, ctx);
    const claim = ctx.claimFor(type, it);
    return { ...it, review, history: (eventsBy[`${type}|${key}`] || []).slice(0, 20),
             state: s.state, due_on: s.due_on, state_note: s.note || null, claim,
             // 0107: whose move eBay thinks it is
             awaiting_reply: type === "ebay_case" && ctx.awaiting(it),
             // The reply window has shut — nothing anyone presses brings it back.
             missed_window: s.note === "missed_window",
             // Someone called this resolved and the site still disagrees. The
             // date is when they said so, which is what the escalation counts
             // from — exposed rather than re-derived, so the email and the DM
             // digest cannot disagree with the card about who is late.
             resolution_disputed_since: s.note === "resolution_disputed" ? (review?.updated_at || null) : null };
  };
  // Resolved / settled stay listed RECENT_DAYS after they closed, then drop.
  const closedRecently = (x: any) => {
    if (x.state === "resolved") return (x.review?.updated_at || "") >= recent;
    if (x.state === "settled") {
      if (x.claim) return (x.claim.resolved_at || "") >= recent;
      return (x.resolved_at || x.closed_at || "") >= recent;
    }
    return true;
  };
  const keep = (type: string) => (x: any) => {
    if (x.state === "waiting") {
      waiting[type]++;
      // A RETURN IS LISTED, NOT WORKED (Ethan, 2026-09-22), so the "too new to
      // show" rule does not apply to it. That rule exists to stop a check-in
      // being demanded before anyone could act; returns ask for nothing, and
      // the tab is meant to match Seller Hub's open-returns list exactly — he
      // counted 8 open at LEE and the tab showed 7, the eighth being a day old.
      // Everything else (mismatches, INRs, cases) still waits its timeframe.
      return !!opts.includeWaiting || (type === "ebay_case" && x.kind === "return" && x.is_open);
    }
    return closedRecently(x);
  };

  const mismatches = (mm.data || []).map((m: any) => build("mismatch", m, m.issue_key)).filter(keep("mismatch"));
  // Soonest deadline first among the ones waiting on us, because that is the
  // only ordering a manager with two of these can act on. Answered and finished
  // ones fall in behind, newest first.
  const disputes = (dp.data || [])
    .map((d: any) => build("dispute", d, d.dispute_key)).filter(keep("dispute"))
    .sort((a: any, b: any) =>
      (b.needs_response ? 1 : 0) - (a.needs_response ? 1 : 0)
      || (a.needs_response
        ? String(a.respond_by || "9999").localeCompare(String(b.respond_by || "9999"))
        : String(b.opened_at || "").localeCompare(String(a.opened_at || ""))));
  const cases = caseRows
    .filter((c: any) => !(isInr(c) && String(c.opened_at || "") < INR_FROM))   // see INR_FROM
    .map((c: any) => build("ebay_case", c, c.case_key)).filter(keep("ebay_case"));

  // Claims a manager could point an INR at: any of this store's from the sweep
  // window, open or closed. Closed ones matter — the 2026-09-22 OVL check found
  // refunded INRs whose claims had been filed by hand and already recovered or
  // denied, and those need linking as much as an open one does.
  const since = daysAgoIso(SWEEP_DAYS);
  const linked = new Set((ln.data || []).map((l: any) => l.claim_id));
  const claims = (cl.data || []).filter((c: any) => (c.created_at || "") >= since || linked.has(c.id))
    // `aging` is the Claims tab's own rule, carried here so the daily email can
    // chase an open claim without a second definition of "behind".
    .map((c: any) => ({ ...c, aging: claimAging(c) }));

  return {
    rollout: ROLLOUT_STORES, stores, today: ctx.today, monthEnd: ctx.monthEnd,
    mismatches, cases, claims, disputes, waiting,
    sync: sy.data || [], disputeSync: ds.data || [],
    timers: THRESHOLD_DAYS, minReason: MIN_REASON,
    resolutionGraceDays: RESOLUTION_GRACE_DAYS, claimAgeDays: CLAIM_AGE_DAYS,
  };
}

async function itemStore(sb: any, type: string, key: string): Promise<string | null> {
  const [table, col] = type === "mismatch" ? ["refund_mismatch_state", "issue_key"]
    : type === "ebay_case" ? ["ebay_cases", "case_key"]
    : type === "dispute" ? ["payment_disputes", "dispute_key"] : ["", ""];
  if (!table) return null;
  const { data } = await sb.from(table).select("store_code").eq(col, key).maybeSingle();
  return data?.store_code ?? null;
}

// Tell open pages the claims list changed, the way shopify-claims does, so a
// claim opened from an INR shows up in the Claims tab without a reload.
async function broadcastClaims(store: string) {
  try {
    await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ messages: [{ topic: "speeks-notify", event: "changed", payload: { tool: "claims", store, ts: Date.now() } }] }),
    });
  } catch (_) { /* best-effort */ }
}

async function logEvent(sb: any, type: string, key: string, store: string, action: string, note: string | null, by: string | null) {
  const { error } = await sb.from("hold_review_events").insert({
    item_type: type, item_key: key, store_code: store, action, note, by_name: by, at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const ops = secretOk(url.searchParams.get("secret") || "");

  try {
    if (req.method === "GET") {
      const action = url.searchParams.get("action");
      if (action === "sync") {
        if (!ops) return json({ success: false, error: "unauthorised" }, 401);
        const stores = parseStores(url.searchParams.get("stores") || "ALL");
        return json({ success: true, ...(await sync(sb, stores, url.searchParams.get("force") === "1")) });
      }
      // One eBay object in full, for the data checks — the summaries omit
      // things (an INR's outcome) that decide whether a list is right.
      if (action === "detail") {
        if (!ops) return json({ success: false, error: "unauthorised" }, 401);
        const store = parseStores(url.searchParams.get("store"))[0];
        const kind = String(url.searchParams.get("kind") || "");
        const id = String(url.searchParams.get("id") || "");
        const path = ({ return: "return", inquiry: "inquiry", case: "casemanagement" } as Record<string, string>)[kind];
        if (!store || !path || !/^\d+$/.test(id)) return json({ success: false, error: "store, kind, numeric id" }, 400);
        const { data: row } = await sb.from("ebay_stores")
          .select("store_code,refresh_token,scopes,environment").eq("store_code", store).maybeSingle();
        if (!row?.refresh_token) return json({ success: false, error: "no eBay credentials" }, 400);
        const host = EBAY_HOSTS[row.environment as string] || EBAY_HOSTS.production;
        return json({ success: true, detail: await ebayGet(`${host}/post-order/v2/${path}/${id}`, await mintToken(row)) });
      }
      const asked = parseStores(url.searchParams.get("stores") || url.searchParams.get("store"));
      if (!asked.length) return json({ success: false, error: "pass ?stores=OVL,LEE" }, 400);
      const preview = ops && url.searchParams.get("preview") === "1";
      const stores = preview ? asked : rolledOut(asked);
      if (!stores.length) return json({ success: true, rollout: ROLLOUT_STORES, stores: [], mismatches: [], cases: [], claims: [], waiting: {}, sync: [] });
      return json({ success: true, preview, ...(await list(sb, stores, { includeWaiting: preview })) });
    }

    if (req.method !== "POST") return json({ success: false, error: "method" }, 405);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const by = String(body.by_name ?? "").trim().slice(0, 120) || null;

    if (action === "sync") {
      const stores = rolledOut(parseStores(body.stores));
      if (!stores.length) return json({ success: true, swept: {}, skipped: [] });
      // A manager may ask for a fresh read, but not bypass the throttle.
      return json({ success: true, ...(await sync(sb, stores, false)) });
    }

    if (action === "review" || action === "reopen") {
      const type = String(body.item_type || "");
      const key = String(body.item_key || "");
      if (!ITEM_TYPES.includes(type) || !key) return json({ success: false, error: "unknown item" }, 400);
      const store = await itemStore(sb, type, key);
      if (!store) return json({ success: false, error: "item not found" }, 404);
      const note = String(body.note ?? "").trim() || null;
      // THE GATE (0107, narrowed by 0108): an eBay case eBay is waiting on
      // cannot be CHECKED IN. Resolving it with a reason is still allowed, and
      // so is reopening — putting an item back on the list is never the thing
      // being guarded against. Only snoozing is.
      if (action === "review" && type === "ebay_case") {
        const { data: c } = await sb.from("ebay_cases")
          .select("is_open,kind,seller_replied_at,buyer_acted_at,respond_by").eq("case_key", key).maybeSingle();
        if (c && awaitingReply(c) && String(body.status || "") === "still_open") {
          return json({ success: false, error: "eBay is still waiting on a reply from us, so this one cannot be checked in. Answer it on eBay — the next read clears it by itself — or mark it resolved and say what happened." }, 400);
        }
      }
      // The same gate for disputes (0112). needs_response is the site's own
      // word, re-read every sweep, so answering it really is the only way out —
      // and a deadline nobody can snooze is the entire point of this one.
      if (action === "review" && type === "dispute" && String(body.status || "") === "still_open") {
        const { data: d } = await sb.from("payment_disputes")
          .select("needs_response,response_overdue,source,respond_by").eq("dispute_key", key).maybeSingle();
        if (d?.needs_response) {
          const where = d.source === "ebay" ? "eBay" : "Shopify";
          return json({ success: false, error: d.response_overdue
            ? `The window to respond to this one on ${where} has already closed, so it cannot be checked in. Mark it resolved and say what happened, so there is a record of it.`
            : `${where} is still waiting on our response to this dispute, so it cannot be checked in. Respond on ${where} — the next read clears it by itself — or mark it resolved and say what happened.` }, 400);
        }
      }
      // Reopen DELETES the review rather than writing "still open" over it.
      // Writing still_open hid it for another timeframe, so a reopened item did
      // not come back to Needs Attention — which is the whole point of reopening
      // it (Ethan, 2026-09-22). With no review it falls back to the plain rule,
      // and an item old enough to have been resolved is due at once.
      if (action === "reopen") {
        const { error } = await sb.from("hold_reviews").delete().eq("item_type", type).eq("item_key", key);
        if (error) return json({ success: false, error: error.message }, 400);
        await logEvent(sb, type, key, store, "reopened", note, by);
        return json({ success: true, status: "reopened" });
      }
      const status = String(body.status || "");
      if (status !== "still_open" && status !== "resolved") {
        return json({ success: false, error: "status must be still_open or resolved" }, 400);
      }
      if (status === "resolved" && (note || "").length < MIN_REASON) {
        return json({ success: false, error: `Say why it's resolved (at least ${MIN_REASON} characters).` }, 400);
      }
      // A refunded INR is settled by a claim, not by a note (see header).
      if (status === "resolved" && type === "ebay_case") {
        const { data: c } = await sb.from("ebay_cases").select("kind,case_type,outcome,tracking_status").eq("case_key", key).maybeSingle();
        // ...unless the parcel turned up after all: eBay gives that money back
        // itself, so there is nothing for a carrier claim to recover (0106).
        if (c && isInr(c) && c.outcome === "refunded" && !isDelivered(c)) {
          return json({ success: false, error: "The buyer was refunded — open or link a claim for this one instead." }, 400);
        }
      }
      const nowIso = new Date().toISOString();
      // next_checkin_at is informational; stateOf counts whole Chicago days
      // from updated_at, which is what decides when it is due again.
      const next = status === "still_open"
        ? new Date(Date.now() + THRESHOLD_DAYS[type] * 86_400_000).toISOString() : null;
      const { error } = await sb.from("hold_reviews").upsert({
        item_type: type, item_key: key, store_code: store, status, note,
        by_name: by, updated_at: nowIso, next_checkin_at: next,
      }, { onConflict: "item_type,item_key" });
      if (error) return json({ success: false, error: error.message }, 400);
      await logEvent(sb, type, key, store, status, note, by);
      return json({ success: true, status });
    }

    if (action === "open_claim" || action === "link_claim") {
      // A claim hangs off a refunded INR or off a mismatch (0105). case_key is
      // still accepted on its own, which is how the INR cards send it.
      const type = String(body.item_type || (body.case_key ? "ebay_case" : ""));
      const key = String(body.item_key || body.case_key || "");
      if (!key || (type !== "ebay_case" && type !== "mismatch")) {
        return json({ success: false, error: "claims are opened from an INR or a mismatch" }, 400);
      }
      let store: string | null = null;
      let what = "";                       // what the claim's detail line names
      if (type === "ebay_case") {
        const { data: c } = await sb.from("ebay_cases").select("case_key,store_code,kind,case_type,ebay_id").eq("case_key", key).maybeSingle();
        if (!c) return json({ success: false, error: "item not found" }, 404);
        if (!isInr(c)) return json({ success: false, error: "claims are opened from item-not-received cases" }, 400);
        store = c.store_code;
        what = `eBay ${c.kind === "case" ? "case" : "INR"} ${c.ebay_id}`;
      } else {
        const { data: m } = await sb.from("refund_mismatch_state")
          .select("issue_key,store_code,ebay_order_id,shopify_order_name").eq("issue_key", key).maybeSingle();
        if (!m) return json({ success: false, error: "item not found" }, 404);
        store = m.store_code;
        what = `Refund mismatch — eBay order ${m.ebay_order_id}${m.shopify_order_name ? ` / Shopify ${m.shopify_order_name}` : ""}`;
      }

      let claimId = String(body.claim_id || "");
      if (action === "open_claim") {
        const caseNumber = String(body.case_number || "").trim();
        if (!caseNumber) return json({ success: false, error: "Enter the claim number." }, 400);
        // The same row shopify-claims' submit_claim writes, so the Claims tab
        // and its 7-day check-in treat it exactly like one filed there.
        const { data: ins, error } = await sb.from("shopify_claims").insert({
          store,
          case_number: caseNumber,
          item_sku: body.item_sku ? String(body.item_sku).trim() : null,
          price: num(body.price), cost: num(body.cost),
          reason_type: body.reason_type ? String(body.reason_type).trim() : null,
          reason_detail: [what, body.reason_detail ? String(body.reason_detail).trim() : ""]
            .filter(Boolean).join(" — "),
          status: "in_progress", resolved_at: null, created_by: by,
        }).select("id").single();
        if (error) return json({ success: false, error: error.message }, 400);
        claimId = ins.id;
      } else {
        const { data: cl } = await sb.from("shopify_claims").select("id,store").eq("id", claimId).maybeSingle();
        if (!cl || cl.store !== store) return json({ success: false, error: "claim not found for this store" }, 404);
      }
      const { error: le } = await sb.from("hold_claim_links").upsert({
        item_type: type, item_key: key, case_key: type === "ebay_case" ? key : null,
        store_code: store, claim_id: claimId, linked_by: by, linked_at: new Date().toISOString(),
      }, { onConflict: "item_type,item_key" });
      if (le) return json({ success: false, error: le.message }, 400);
      await logEvent(sb, type, key, store!, "claim_linked",
        action === "open_claim" ? `Claim opened from this ${type === "mismatch" ? "mismatch" : "INR"}` : "Linked to an existing claim", by);
      if (action === "open_claim") await broadcastClaims(store!);
      return json({ success: true, claim_id: claimId });
    }

    return json({ success: false, error: `unknown action ${action}` }, 400);
  } catch (err: any) {
    return json({ success: false, error: String(err?.message ?? err) }, 500);
  }
});
