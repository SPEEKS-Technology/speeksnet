// ============================================================================
// unrestocked-returns — an item came back and never went back into stock.
//
//   ?secret=<ops>                     every store, yesterday (what cron calls)
//     &store=OVL                      one store
//     &day=YYYY-MM-DD                 treat this Chicago day as "yesterday"
//     &lookback=N                     days to look back (default 3; a one-off catch-up)
//     &dryRun=1                       judge everything, send nothing, write nothing
//     &html=1                         with dryRun, render the mail instead of JSON
//     &to=addr                        send the mail to one address instead
//     &sample=1&html=1                render the mail from invented rows
//
// WHY THIS EXISTS. Ethan, 2026-10-22: a store refunds a whole item — a return
// at the counter, an eBay or web return, or an order cancelled before it
// shipped — and the item is not put back in stock. Either it walked out the
// door with someone, or it is sitting on a shelf at quantity 0 where nobody
// can sell it, for months. Both look identical from the books, and both are
// found the same way.
//
// ONE SOURCE, BOTH CHANNELS. eBay orders reach Shopify through the PayMore app
// (sourceName "ebay") and an eBay return is refunded on that Shopify copy, so
// the inventory question is answered in Shopify for both. An eBay refund that
// never reached Shopify at all is a different hole, and refund-mismatch /
// Claims & Disputes already chase it.
//
// ⚠️ READ ONLY AGAINST SHOPIFY. shopifyQuery refuses any document containing
// `mutation`, the same guard refund-mismatch uses. This never restocks, never
// adjusts inventory and never touches eBay. The only thing it writes is its own
// unrestocked_returns table.
//
// ----------------------------------------------------------------------------
// WHAT COUNTS. A refund LINE ITEM (Shopify only creates those when the staff
// member picks the item to return) with restocked = false, on an order where
// the money paid back covers what was returned. That is the "full return, not
// partial refund" Ethan asked for:
//   - a money-only refund ("missing power cord", $10) has no line items and is
//     never looked at;
//   - an item picked but paid back short ("damaged in shipping, customer
//     keeps it", $550 of $599.99) fails the money test and is left alone.
// The money is summed across ALL the order's refunds, because a cancel can
// refund the money on one refund and record the line on a second $0 one
// (#KS01-15686, 2026-10-17).
//
// NOT RESTOCKED ON THE REFUND IS NOT YET "NOT IN STOCK". A store can untick
// Restock and add the unit back by hand. So before anything is reported:
//   on hand now >= 1                  -> it is back; say nothing
//   sold again since the refund       -> it was back, and sold; say nothing
//   neither                           -> report it
// ⚠️ The on-hand test is only proof for one-off used items (quantity 1), which
// is nearly everything here. For a multi-unit SKU (a QTY8 lot, the 842 bin
// games) other units keep on-hand above 0 whatever happened to the returned
// one, so a missing restock on those cannot be seen this way.
//
// An eBay refund for ITEM NOT RECEIVED (an INR inquiry, or a case escalated
// from one, in ebay_cases) is skipped: the parcel never came back to us, so
// there is nothing to restock. A RETURN case is not skipped.
//
// A deleted listing is reported, not skipped: the item came back and there is
// no listing for it to go back to, which is the same item on the same shelf.
// An untracked item (no inventory at all) cannot be judged and only appears in
// `problems`.
//
// ----------------------------------------------------------------------------
// TIMING. Ethan: "if one happened today, I would want to be notified about it
// tomorrow, not same day" — so the store has the rest of the day to restock it,
// and a refund is only ever looked at once its Chicago day is over. The 7:35am
// run looks at the three days ending yesterday, so a missed morning is caught up
// on the next one; a refund already in the table is never mailed as new twice.
//
// EVERY MORNING ANYTHING IS OPEN. Every row still open is re-checked each
// morning and the mail goes out whenever there is anything at all to list —
// new or old. Ethan, 2026-10-22: "the only times this doesn't send out is when
// there is nothing to report. I want to know if my managers did not do this
// correctly or just did not do it at all." The first build mailed only on a
// morning with something new, so an item a manager ignored went quiet after
// one mention. last_mailed_at stops a manual re-run mailing twice in a day.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";
const GMAIL_RELAY = Deno.env.get("GMAIL_RELAY_URL") ||
  "https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec";

const LOOKBACK_DAYS = 3;     // yesterday and the two before, so a missed run catches up
const FULL_REFUND_SHARE = 0.98;   // money back >= 98% of the returned lines' subtotal

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

// The store's own calendar — a 7pm Central refund is 1am UTC tomorrow, and
// dating it in UTC would file it on the wrong day. [[edge-fn-utc-timezone]]
const CHI_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
});
const chicagoDay = (d: string | Date) => CHI_DAY.format(new Date(d));
// Calendar arithmetic on a YYYY-MM-DD string. Date.UTC is only a day counter
// here, so DST cannot shift it.
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const daysBetween = (a: string, b: string) => {
  const [ay, am, ad] = a.split("-").map(Number), [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
};

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

// ===========================================================================
// THE ONLY DOOR TO SHOPIFY. GraphQL reads are POSTs, so the method proves
// nothing — the DOCUMENT is what is checked. inventoryAdjustQuantities,
// refundCreate and every other write require `mutation`, which this refuses.
// ===========================================================================
async function shopifyQuery(shop: string, token: string, query: string, variables: any) {
  if (/\bmutation\b/i.test(query)) {
    throw new Error("refused: this function issues Shopify reads only");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    const b = await res.json().catch(() => null);
    if (!b) throw new Error(`shopify ${res.status}: no body`);
    const throttled = (b.errors || []).some((e: any) => e?.extensions?.code === "THROTTLED");
    if (throttled) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
    if (b.errors?.length) throw new Error(`shopify: ${JSON.stringify(b.errors).slice(0, 200)}`);
    return b.data;
  }
  throw new Error("shopify: throttled three times");
}

const ORDER_FIELDS = `
  id name createdAt cancelledAt sourceName sourceIdentifier tags app { name }
  customAttributes { key value }
  totalRefundedSet { shopMoney { amount } }
  refunds(first: 10) {
    id createdAt note
    refundLineItems(first: 20) { nodes {
      id quantity restockType restocked
      subtotalSet { shopMoney { amount } }
      lineItem { id name sku quantity
        variant { id sku
          inventoryItem { tracked
            inventoryLevels(first: 5) { nodes { quantities(names: ["on_hand"]) { name quantity } } } } } }
    } }
  }
`;

const SEARCH_Q = `query($q: String!, $after: String) {
  orders(first: 25, query: $q, after: $after, sortKey: UPDATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ORDER_FIELDS} }
  }
}`;

const ONE_Q = `query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`;

const RESOLD_Q = `query($q: String!) {
  orders(first: 15, query: $q) { nodes { id name createdAt cancelledAt displayFinancialStatus lineItems(first: 20) { nodes { sku } } } }
}`;

// Where the sale came from, in the words a manager uses.
function channelOf(o: any): string {
  const s = String(o?.sourceName || "").toLowerCase();
  if (s.startsWith("ebay") || ebayIdOf(o)) return "eBay";
  if (s === "pos") return "In store";
  if (s === "web") return "Online";
  return o?.app?.name || o?.sourceName || "Shopify";
}

// The eBay order id on a Shopify copy, in whichever of the three forms its
// importer used (the set refund-mismatch documents). sourceIdentifier is not an
// eBay field, so the shape is checked before it is believed.
const EBAY_ORDER_ID_RE = /^\d{2}-\d{5}-\d{5}$/;
function ebayIdOf(o: any): string {
  const attr = (o?.customAttributes || []).find((a: any) => /ebay\s*order\s*id/i.test(String(a?.key || "")));
  const fromAttr = String(attr?.value ?? "").trim();
  if (EBAY_ORDER_ID_RE.test(fromAttr)) return fromAttr;
  const fromSource = String(o?.sourceIdentifier ?? "").trim();
  if (EBAY_ORDER_ID_RE.test(fromSource)) return fromSource;
  const tag = (o?.tags || []).map(String).find((t: string) => /^ebay-/i.test(t.trim()));
  const fromTag = tag ? tag.trim().slice(5) : "";
  return EBAY_ORDER_ID_RE.test(fromTag) ? fromTag : "";
}

type Candidate = {
  key: string; store: string;
  orderId: string; orderName: string; orderCreatedAt: string; channel: string; ebayOrderId: string;
  kind: "return" | "cancel";
  refundAt: string; refundDay: string; refundNote: string;
  sku: string; title: string; amount: number;
  variantId: string | null;
};

type Verdict =
  | { state: "flag"; flag: "not_restocked" | "listing_deleted" }
  | { state: "ok"; how: string }
  | { state: "unknown"; why: string };

// Every refund line on this order that went back WITHOUT a restock, on an order
// whose money back covers the returned lines. `inDays` limits which refunds are
// new discoveries; pass null to take them all (the re-check of an open row).
function candidatesOf(store: string, o: any, inDays: Set<string> | null): Candidate[] {
  const refunds = o?.refunds || [];
  const allLines = refunds.flatMap((r: any) => r?.refundLineItems?.nodes || []);
  const returnedSubtotal = allLines.reduce((a: number, l: any) => a + num(l?.subtotalSet?.shopMoney?.amount), 0);
  const refunded = num(o?.totalRefundedSet?.shopMoney?.amount);
  // Partial refund: the item was picked but the buyer was paid back short —
  // they kept it, and there is nothing to restock.
  if (returnedSubtotal <= 0 || refunded < returnedSubtotal * FULL_REFUND_SHARE) return [];

  const out: Candidate[] = [];
  for (const r of refunds) {
    const day = chicagoDay(r.createdAt);
    if (inDays && !inDays.has(day)) continue;
    for (const l of (r?.refundLineItems?.nodes || [])) {
      if (l?.restocked) continue;
      const li = l?.lineItem || {};
      out.push({
        key: `${store}:${String(r.id).split("/").pop()}:${String(li.id || l.id).split("/").pop()}`,
        store,
        orderId: String(o.id).split("/").pop() || "",
        orderName: o.name,
        orderCreatedAt: o.createdAt,
        channel: channelOf(o),
        ebayOrderId: ebayIdOf(o),
        kind: o.cancelledAt || l.restockType === "CANCEL" ? "cancel" : "return",
        refundAt: r.createdAt, refundDay: day, refundNote: String(r.note || "").trim(),
        sku: String(li.sku || li.variant?.sku || "").trim(),
        title: String(li.name || "").trim(),
        amount: r2(num(l?.subtotalSet?.shopMoney?.amount)),
        variantId: li.variant?.id || null,
      });
    }
  }
  return out;
}

// Is the item back on the shelf by some other route than the refund's Restock box?
async function judge(shop: string, token: string, o: any, c: Candidate, lost: Set<string>): Promise<Verdict> {
  // ITEM NOT RECEIVED. eBay refunded a buyer whose parcel never arrived; there
  // is nothing on our shelf to restock. Read off ebay_cases (Claims & Disputes'
  // sync), so this is only as fresh as that sweep.
  if (c.ebayOrderId && lost.has(c.ebayOrderId)) return { state: "ok", how: "eBay item-not-received refund" };

  const line = (o.refunds || []).flatMap((r: any) => r?.refundLineItems?.nodes || [])
    .find((l: any) => String(l?.lineItem?.id || "").split("/").pop() === c.key.split(":")[2]);
  // Restocked on a LATER refund of the same line — a store that fixed it by
  // re-doing the refund rather than adjusting stock.
  const anyRestock = (o.refunds || []).flatMap((r: any) => r?.refundLineItems?.nodes || [])
    .some((l: any) => l?.restocked && String(l?.lineItem?.id || "") === String(line?.lineItem?.id || "-"));
  if (anyRestock) return { state: "ok", how: "restocked on a later refund" };

  const variant = line?.lineItem?.variant;
  if (!variant) return { state: "flag", flag: "listing_deleted" };
  const inv = variant.inventoryItem;
  if (inv && inv.tracked === false) return { state: "unknown", why: "inventory not tracked" };
  const onHand = (inv?.inventoryLevels?.nodes || []).reduce((a: number, lv: any) =>
    a + num((lv?.quantities || []).find((q: any) => q?.name === "on_hand")?.quantity), 0);
  if (onHand >= 1) return { state: "ok", how: `on hand ${onHand}` };

  // On hand 0 is also what "restocked by hand, then sold again" looks like:
  // another, uncancelled order carrying the same SKU means the unit was back.
  // For a RETURN that order must come after the refund. For a CANCEL it may
  // come before it too — "oversold" is an item that sold in the store while
  // the eBay order was open, and that cancel is right not to restock
  // (#MO03-3844 → sold again on #MO03-3865, 2026-10-08). A week of slack covers
  // an in-store sale the eBay order arrived after.
  // Shopify's search is fuzzy, so the hit is only believed if the SKU really
  // is on one of its lines.
  if (c.sku) {
    const from = c.kind === "cancel" ? addDays(chicagoDay(c.orderCreatedAt), -7) : chicagoDay(c.refundAt);
    const sku = c.sku.replace(/"/g, "");
    const data: any = await shopifyQuery(shop, token, RESOLD_Q,
      { q: `sku:"${sku}" AND created_at:>=${from}` });
    const again = (data?.orders?.nodes || []).find((x: any) =>
      String(x.id).split("/").pop() !== c.orderId && !x.cancelledAt &&
      x.displayFinancialStatus !== "REFUNDED" &&
      (c.kind === "cancel" || x.createdAt > c.refundAt) &&
      (x.lineItems?.nodes || []).some((l: any) => String(l?.sku || "").trim() === c.sku));
    if (again) return { state: "ok", how: `sold again on ${again.name}` };
  }
  return { state: "flag", flag: "not_restocked" };
}

// ---------------------------------------------------------------------------
async function collect(wantStores: string[], days: string[], openRows: any[]) {
  const problems: string[] = [];
  const blind = new Set<string>();
  const found: Array<Candidate & { flag: string }> = [];
  const cleared: Array<{ key: string; how: string }> = [];
  const stats: Record<string, any> = {};
  const inDays = new Set(days);

  // Phantom copies from the August duplicate incident — refunded with no
  // restock on purpose, because the real order shipped. Excluded by name, the
  // way refund-mismatch and refund-plan exclude them.
  let phantoms = new Set<string>();
  try {
    const rows = await sbGet(`dup_order_cleanup?select=order_name`);
    phantoms = new Set((rows || []).map((r: any) =>
      String(r.order_name || "").trim().replace(/^#/, "").toUpperCase()).filter(Boolean));
  } catch (e) {
    problems.push(`could not read dup_order_cleanup (phantoms not excluded): ${String(e).slice(0, 120)}`);
  }
  const isPhantom = (o: any) =>
    phantoms.has(String(o?.name || "").trim().replace(/^#/, "").toUpperCase());

  const shopRows = await sbGet(`shopify_stores?select=shop,store_code,access_token`);

  // eBay orders refunded because the parcel never arrived — an INR inquiry, or
  // a case escalated from one. A return case is NOT in here: that item is
  // coming back, and should be restocked when it does.
  let lost = new Set<string>();
  try {
    const rows = await sbGet(
      `ebay_cases?select=order_id&or=(kind.eq.inquiry,case_type.eq.ITEM_NOT_RECEIVED)&order_id=not.is.null`);
    lost = new Set((rows || []).map((r: any) => String(r.order_id).trim()));
  } catch (e) {
    problems.push(`could not read ebay_cases (item-not-received refunds not excluded): ${String(e).slice(0, 120)}`);
  }

  for (const store of wantStores) {
    const shopRow = shopRows.find((s: any) => (s.store_code || STORE_BY_SHOP[s.shop]) === store);
    if (!shopRow?.access_token) { problems.push(`${store}: no Shopify token`); blind.add(store); continue; }
    const shop = shopRow.shop, token = shopRow.access_token;
    const st = { orders_read: 0, unrestocked_lines: 0, back_by_hand: 0, flagged: 0, rechecked: 0 };
    stats[store] = st;

    // --- 1. refunds on the days being looked at -----------------------------
    // A refund moves the order's updated_at, so this finds old orders refunded
    // recently. One day of slack each side covers UTC vs Chicago; the exact day
    // is decided per refund below.
    const q = `updated_at:>=${addDays(days[0], -1)} AND `
      + `(financial_status:refunded OR financial_status:partially_refunded)`;
    const orders: any[] = [];
    try {
      let after: string | null = null;
      for (let page = 0; page < 40; page++) {
        const data: any = await shopifyQuery(shop, token, SEARCH_Q, { q, after });
        orders.push(...(data?.orders?.nodes || []));
        if (!data?.orders?.pageInfo?.hasNextPage) break;
        after = data.orders.pageInfo.endCursor;
      }
    } catch (e) {
      problems.push(`${store}: refund sweep — ${String(e).slice(0, 160)}`);
      blind.add(store);
      continue;
    }
    st.orders_read = orders.length;
    const byId = new Map(orders.map((o) => [String(o.id).split("/").pop(), o]));

    const seen = new Set<string>();
    for (const o of orders) {
      if (isPhantom(o)) continue;
      for (const c of candidatesOf(store, o, inDays)) {
        st.unrestocked_lines++;
        seen.add(c.key);
        try {
          const v = await judge(shop, token, o, c, lost);
          if (v.state === "flag") { found.push({ ...c, flag: v.flag }); st.flagged++; }
          else if (v.state === "ok") st.back_by_hand++;
          else problems.push(`${store} ${c.orderName} ${c.sku}: ${v.why}`);
        } catch (e) {
          problems.push(`${store} ${c.orderName}: ${String(e).slice(0, 120)}`);
        }
      }
    }

    // --- 2. re-check every row still open from earlier mornings -------------
    for (const row of openRows.filter((r) => r.store_code === store && !seen.has(r.issue_key))) {
      st.rechecked++;
      try {
        let o = byId.get(String(row.order_id));
        if (!o) {
          const data: any = await shopifyQuery(shop, token, ONE_Q, { id: `gid://shopify/Order/${row.order_id}` });
          o = data?.order;
        }
        if (!o) { problems.push(`${store} ${row.order_name}: order not found`); continue; }
        const c = candidatesOf(store, o, null).find((x) => x.key === row.issue_key);
        // The line is no longer an unrestocked full return — restocked on a
        // later refund, or the order changed under it.
        if (!c) { cleared.push({ key: row.issue_key, how: "no longer an unrestocked return" }); continue; }
        const v = await judge(shop, token, o, c, lost);
        if (v.state === "ok") cleared.push({ key: row.issue_key, how: v.how });
        else if (v.state === "flag") found.push({ ...c, flag: v.flag });
      } catch (e) {
        problems.push(`${store} ${row.order_name}: re-check — ${String(e).slice(0, 120)}`);
      }
    }
  }
  return { found, cleared, problems, blind, stats };
}

// ---------------------------------------------------------------------------
const C = {
  ink: "#12241c", faint: "#6d8579", line: "#dde7e1",
  bad: "#b3261e", warn: "#8a5a00", chip: "#eef5f1",
};

type Row = Candidate & { flag: string; ageDays: number };

const money = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// "Oct 17" — the year is never in doubt on a next-morning mail.
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (day: string) => { const [, m, d] = day.split("-").map(Number); return `${MON[m - 1]} ${d}`; };

// Kept short on purpose (Ethan, 2026-10-22: "a very simple report, no need to
// over explain"). Labels and headings are Title Case; values stay as written.
function rowHtml(r: Row) {
  const shopUrl = `https://${SHOP_BY_STORE[r.store]}/admin/orders/${r.orderId}`;
  const what = r.kind === "cancel" ? "Cancelled" : "Returned";
  const status = r.flag === "listing_deleted" ? "Listing Deleted" : "Not Restocked";
  const age = r.ageDays <= 1 ? "" :
    ` <span style="color:${r.ageDays >= 7 ? C.bad : C.warn};font-weight:700;">· ${r.ageDays} Days</span>`;
  return `
    <tr><td style="padding:14px;border-top:1px solid ${C.line};">
      <div style="font-size:12px;color:${C.faint};">
        ${esc(STORE_NAME[r.store] || r.store)} · ${esc(r.channel)} · ${esc(shortDay(r.refundDay))}${age}
      </div>
      <div style="font-size:15px;font-weight:700;color:${C.ink};margin:4px 0 6px;">
        ${esc(what)}, ${esc(status)} — ${money(r.amount)}
      </div>
      <div style="font-size:13px;color:${C.ink};line-height:1.6;">
        ${esc(r.title)}<br>
        <b>${esc(r.orderName)}</b>${r.sku ? ` &nbsp;·&nbsp; SKU <b>${esc(r.sku)}</b>` : ""}
        ${r.refundNote ? `<br><span style="color:${C.faint};">Note: “${esc(r.refundNote)}”</span>` : ""}
      </div>
      <div style="margin-top:8px;font-size:12px;">
        <a href="${shopUrl}" style="color:#1c6b47;">Open In Shopify</a>
      </div>
    </td></tr>`;
}

function build(fresh: Row[], older: Row[], blind: string[], days: string[]) {
  const span = !days.length ? "" : days.length === 1 ? shortDay(days[0])
    : `${shortDay(days[0])} – ${shortDay(days[days.length - 1])}`;
  const section = (label: string) => `
    <tr><td style="padding:10px 14px;border-top:1px solid ${C.line};background:#f7faf8;
      font-size:12px;font-weight:800;color:${C.faint};">${esc(label)}</td></tr>`;
  const total = (rows: Row[]) => rows.reduce((a, r) => a + r.amount, 0);
  // Three equal, centred cells — the first build pushed the total hard right
  // and left the counts hugging the left edge.
  const stat = (value: string, label: string, color: string) =>
    `<td width="33%" align="center" style="font-size:12px;color:${C.faint};text-align:center;">
       <b style="color:${color};font-size:20px;">${value}</b><br>${esc(label)}</td>`;
  // The card is width 100% capped at 600, not a fixed 600: on a phone a fixed
  // 600 overflowed, the mail app shrank it to fit, and the grey page behind it
  // stopped short of the card's right edge (Ethan's phone, 2026-10-23).
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:10px;background:#f4f7f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#fff;border:1px solid ${C.line};border-radius:12px;overflow:hidden;">
  <tr><td style="padding:16px 14px;background:${C.chip};">
    <div style="font-size:17px;font-weight:800;color:${C.ink};">Returned But Not Back In Stock</div>
    <div style="font-size:12.5px;color:${C.faint};margin-top:5px;line-height:1.6;">
      Items fully refunded or cancelled that were never put back in stock.${span ? `<br>Refunds From ${esc(span)}` : ""}
    </div>
  </td></tr>
  <tr><td style="padding:14px;border-top:1px solid ${C.line};">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      ${stat(String(fresh.length), "New", fresh.length ? C.bad : C.ink)}
      ${stat(String(older.length), "Still Open", older.length ? C.warn : C.ink)}
      ${stat(money(total([...fresh, ...older])), "Refunded", C.ink)}
    </tr></table>
  </td></tr>
  ${fresh.length ? section("New") + fresh.map(rowHtml).join("") : ""}
  ${older.length ? section("Still Not Back In Stock") + older.map(rowHtml).join("") : ""}
  <tr><td style="padding:12px 14px;text-align:center;color:${C.faint};font-size:11px;line-height:1.6;border-top:1px solid ${C.line};background:#f7faf8;">
    Sent every morning while anything is open. Items stay on until they are back in stock or sold.
    Partial refunds are not included.
    ${blind.length ? `<br><b style="color:${C.bad};">Could not check today: ${esc(blind.join(", "))}.</b>` : ""}
  </td></tr>
</table></td></tr></table></body></html>`;
}

// ⚠️ A 404 FROM THE RELAY DOES NOT MEAN THE MAIL WAS NOT SENT — see the same
// function in refund-mismatch. The redirect is not followed; a 302 is proof
// doPost ran. Only a non-2xx/3xx from /exec itself is retried.
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

  // PREVIEW. Silent on a clean morning, so without this a layout change could
  // not be seen until a real one turned up. Reads and writes nothing.
  if (q("sample") === "1") {
    const base = { orderId: "1", orderCreatedAt: "", ebayOrderId: "", variantId: null, refundAt: "", refundNote: "" };
    const html = build([
      { ...base, key: "s1", store: "MPL", orderName: "#MO03-4043", channel: "eBay", kind: "cancel",
        refundDay: "2026-10-21", sku: "MO03-2696A-E10", title: "Apple iPad Pro 11in 256GB", amount: 709.99,
        flag: "not_restocked", ageDays: 1 },
      { ...base, key: "s2", store: "OVL", orderName: "#KS01-15686", channel: "In store", kind: "return",
        refundDay: "2026-10-21", sku: "", title: "Nintendo Switch OLED", amount: 54.99, refundNote: "changed mind",
        flag: "listing_deleted", ageDays: 1 },
    ], [
      { ...base, key: "s3", store: "MPL", orderName: "#MO03-3460", channel: "In store", kind: "return",
        refundDay: "2026-10-15", sku: "MO03-2368D-R7R1", title: "Xbox Wireless Controller", amount: 64.99,
        refundNote: "right trigger is inconsistent", flag: "not_restocked", ageDays: 7 },
    ], [], ["2026-10-19", "2026-10-21"]);
    if (q("html") === "1") return new Response(html, { headers: { "Content-Type": "text/html" } });
    const to = q("to");
    if (!to) return json({ error: "sample needs &to=addr, or &html=1 to just render it" }, 400);
    return json({ sample: true, to, ...(await relay(to, "[SAMPLE] Returned but not back in stock", html)) });
  }

  const want = (q("store") || "ALL").toUpperCase().trim();
  const wantStores = want === "ALL" ? STORES : [want];
  if (wantStores.some((s) => !STORES.includes(s))) return json({ error: `unknown store ${want}` }, 400);

  const today = chicagoDay(new Date());
  const yesterday = /^\d{4}-\d{2}-\d{2}$/.test(q("day") || "") ? q("day")! : addDays(today, -1);
  // Never today: the store still has the rest of today to restock it.
  if (yesterday >= today) return json({ error: "day must be before today (Chicago)" }, 400);
  // &lookback=N widens the window for a one-off catch-up (first used 2026-10-22
  // to mail Oct 7–18, before this existed). Cron never passes it.
  const lookback = Math.max(1, Math.min(31, Number(q("lookback")) || LOOKBACK_DAYS));
  const days = Array.from({ length: lookback }, (_, i) => addDays(yesterday, i - lookback + 1));

  try {
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: prior } = await sb.from("unrestocked_returns").select("*");
    const priorBy: Record<string, any> = {};
    for (const r of (prior || [])) priorBy[r.issue_key] = r;
    const openRows = (prior || []).filter((r: any) => !r.resolved_at);

    const { found, cleared, problems, blind, stats } = await collect(wantStores, days, openRows);

    // One row per line however it was reached (sweep and re-check can both see it).
    const uniq = new Map(found.map((f) => [f.key, f]));
    const rows: Row[] = [...uniq.values()].map((f) => ({ ...f, ageDays: daysBetween(f.refundDay, today) }));
    // NEW = never mailed before. Anything already mailed and still not back in
    // stock is "still open", and goes on every morning's mail until it is.
    const fresh = rows.filter((r) => !priorBy[r.key]?.mailed_at)
      .sort((a, b) => a.store.localeCompare(b.store) || b.amount - a.amount);
    const older = rows.filter((r) => priorBy[r.key]?.mailed_at)
      .sort((a, b) => b.ageDays - a.ageDays);

    if (q("dryRun") === "1") {
      if (q("html") === "1" && rows.length) {
        return new Response(build(fresh, older, [...blind], days), { headers: { "Content-Type": "text/html" } });
      }
      return json({
        ok: true, dryRun: true, days, new: fresh.length, stillOpen: older.length,
        wouldClear: cleared, blindStores: [...blind], stats, problems,
        rows: rows.map((r) => ({
          store: r.store, order: r.orderName, channel: r.channel, kind: r.kind, day: r.refundDay,
          sku: r.sku, title: r.title, amount: r.amount, flag: r.flag, new: fresh.includes(r),
        })),
      });
    }

    const nowIso = new Date().toISOString();
    const sent: any[] = [];
    let mailed = false;
    // Once per Chicago day, whatever triggered the run. &to= is a test send and
    // ignores the guard; &force=1 overrides it for a deliberate second send.
    const mailedToday = (prior || []).some((r: any) => r.last_mailed_at && chicagoDay(r.last_mailed_at) === today);
    if (rows.length && mailedToday && !q("to") && q("force") !== "1") {
      sent.push({ skipped: "already mailed today" });
    } else if (rows.length) {
      const to = q("to") || (await listFor(sb, "unrestocked_returns", "claims_disputes_dm")).join(",");
      if (!to) problems.push("nobody on unrestocked_returns or claims_disputes_dm");
      else {
        const parts = [fresh.length ? `${fresh.length} new` : "", older.length ? `${older.length} still open` : ""];
        const r = await relay(to,
          `Returned but not back in stock — ${parts.filter(Boolean).join(", ")}`,
          build(fresh, older, [...blind], days));
        // A test send (&to=) records nothing, so the real mail still goes out.
        mailed = r.ok && !q("to");
        sent.push({ to, new: fresh.length, stillOpen: older.length, ...r });
      }
    }

    // --- record ------------------------------------------------------------
    for (const r of rows) {
      const p = priorBy[r.key];
      await sb.from("unrestocked_returns").upsert({
        issue_key: r.key, store_code: r.store, order_id: r.orderId, order_name: r.orderName,
        channel: r.channel, kind: r.kind, flag: r.flag,
        refund_at: r.refundAt, refund_note: r.refundNote || null,
        sku: r.sku || null, title: r.title || null, amount: r.amount,
        first_seen: p?.first_seen || nowIso, last_checked: nowIso,
        // A failed send leaves it un-mailed, so tomorrow it is still "new".
        mailed_at: p?.mailed_at || (mailed ? nowIso : null),
        last_mailed_at: mailed ? nowIso : (p?.last_mailed_at ?? null),
        times_mailed: (p?.times_mailed || 0) + (mailed ? 1 : 0),
        resolved_at: null, resolved_how: null,
      }, { onConflict: "issue_key" });
    }
    // Back on hand or sold again: resolved, not deleted, so "how many and how
    // fast" stays answerable.
    for (const c of cleared) {
      await sb.from("unrestocked_returns")
        .update({ resolved_at: nowIso, resolved_how: c.how, last_checked: nowIso })
        .eq("issue_key", c.key);
    }

    return json({
      ok: true, days, new: fresh.length, stillOpen: older.length, cleared: cleared.length,
      sent, blindStores: [...blind], stats, problems,
    });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message ?? err),
                  stack: String(err?.stack ?? "").slice(0, 400) }, 500);
  }
});
