import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// SPEEKS CONNECT — ERROR WATCH
//
// Runs every 15 minutes and mails ONLY when something is wrong. A healthy pass
// sends nothing: an alerter that mails "all clear" 96 times a day is an alerter
// nobody reads, and the whole point of this one is that a mail from it means
// something needs fixing today.
//
// Every check answers "is the integration failing", not "is the business doing
// well". eBay's own seller metrics (defect rate, late shipment) already live on
// the dashboard and move for reasons no code change can fix; they are not errors
// and are deliberately not in here.
//
// DEDUPE. Each problem gets a stable issue_key describing the PROBLEM, never the
// time it was noticed, so the same fault recognises itself on the next pass and
// is not re-sent. A problem still unfixed after RENAG_HOURS is raised once more,
// so nothing rots quietly. When it stops being detected its row is deleted, and
// if it ever comes back it reads as new — which it is.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const SECRET = Deno.env.get("SYNC_SECRET") || "sp33ks-sync-k3y-2026-x9mq";
const GMAIL_RELAY = Deno.env.get("GMAIL_RELAY_URL") ||
  "https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec";

const RECIPIENT_LIST = "connect_alerts";
const TO_DEFAULT = ["ethan.kushnir@speekstechnology.com"];

const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";
// shopify_stores.store_code is NULL on all five rows, so the shop domain is the
// only thing that identifies a store there. Same map the other functions carry.
const SHOP_TO_CODE: Record<string, string> = {
  "paymore-overland-park.myshopify.com": "OVL",
  "paymore-lees-summit.myshopify.com": "LEE",
  "paymore-westport.myshopify.com": "WSP",
  "paymore-maplewood.myshopify.com": "MPL",
  "paymore-ballwin.myshopify.com": "BAL",
};

// Thresholds. Each is deliberately looser than the thing it watches, so a single
// slow run never pages anybody.
const RENAG_HOURS         = 24;  // an unfixed problem is raised again after this
const SWEEP_STALE_MIN     = 90;  // live sweep runs every 20 min per store
// How far back the duplicate scan reads Shopify. This bounds only the SECOND
// copy's creation date, never ours — our side comes from the ebay_orders ledger,
// which has no window at all. Five days because Shopify caps a page at 250 and
// the busiest store books ~37 eBay orders a day.
const DUP_WINDOW_DAYS     = 5;
const DUP_PAGE            = 250; // orders read per store per duplicate scan
const DUP_LEDGER_DAYS     = 90;  // how much of our own import history to load
const CRON_STALE_MIN      = 30;  // order poll runs every 2 min per store
const LISTING_STUCK_MIN   = 60;  // pending longer than this is not "in flight"
const TRACKING_STUCK_MIN  = 60;  // tracking known but never pushed back to eBay
const TOKEN_WARN_DAYS     = 30;  // refresh token; access token renews itself

// WHO CAN ACTUALLY FIX IT, on every single line. Asked for directly on
// 2026-08-21 after an "order.lineItems: Line items Unable to reserve inventory"
// mail that was, in plain English, "the shelf and Shopify disagree" — a
// thirty-second job for the store, indistinguishable in that wording from a
// broken integration. Every alert now says whose job it is, so nobody has to
// decode a Shopify error string to find out whether to act or to forward it.
//
//   "store"  — the shop floor fixes it: count something, cancel something,
//              correct a listing. No code involved.
//   "ethan"  — a decision or a reconnect only the DM/CEO can make.
//   "claude" — the tool itself is broken. Forward it; nobody on the floor can
//              do anything about it.
type Fixer = "store" | "ethan" | "claude";

type Issue = {
  key: string; store: string | null; severity: "critical" | "warning";
  title: string; detail: string; fix: Fixer;
};

const FIX_LABEL: Record<Fixer, string> = {
  store: "Store Can Fix",
  ethan: "You Can Fix",
  claude: "Needs Claude",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const esc = (s: unknown) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const minsAgo = (t: string | null) => t ? Math.round((Date.now() - new Date(t).getTime()) / 60000) : null;
// The first WORD of a detail line is capitalised, whether it opens the sentence
// or follows a count: "6 listings failed" reads as "6 Listings failed". Applied
// here at render rather than at each message, because half these strings arrive
// from Postgres or eBay already lowercased and cannot be written any other way.
// A word that already carries a capital is left alone, so eBay never becomes EBay.
const capFirst = (s: string) => {
  const w = s.split(" ");
  for (let i = 0; i < w.length; i++) {
    if (!w[i] || !/[A-Za-z]/.test(w[i])) continue;   // a bare count — keep looking
    if (w[i] !== w[i].toLowerCase()) break;          // already capitalised somewhere
    w[i] = w[i].charAt(0).toUpperCase() + w[i].slice(1);
    break;
  }
  return w.join(" ");
};

const short = (s: unknown, n = 180) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// WHOSE PROBLEM IS IT. A listing eBay rejects for a missing item specific, a bad
// category or a title it does not allow is a DATA problem: the store already sees
// it in SPEEKS Connect and fixes it themselves, and mailing about it buries the
// alerts that mean the tool is actually broken. What survives this filter is the
// class of failure a store can do nothing about -- the connection, the shared
// rate limit, and eBay itself being down.
//
// Deliberately matched on HTTP status and transport words rather than on eBay's
// errorId list: the id list changes without notice, and a new data-validation id
// failing OPEN here would put us straight back to mailing about item specifics.
// An unrecognised error is treated as the store's, which is the quiet failure --
// the loud one would be nagging about work already being done.
const SYSTEMIC = /HTTP *(401|403|429|5[0-9][0-9])|"statusCode" *: *(401|403|429|5[0-9][0-9])|unauthor|invalid_grant|invalid_token|token (has )?expired|expired token|refresh token|rate limit|call limit|quota|throttl|internal error|service unavailable|temporarily unavailable|timed out|time out|ECONNRESET|network error/i;

// The duplicate scan's one Shopify call per store. The eBay order id lives in a
// custom attribute, not a tag, and Shopify cannot search attributes — so the
// query narrows to eBay-tagged orders in the window and the grouping happens
// here. Both importers stamp the attribute, which is what makes the check
// source-blind.
async function shopifyEbayOrders(shop: string, token: string, sinceDay: string) {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({
      query: `{
        orders(first: ${DUP_PAGE}, query: "tag:eBay created_at:>=${sinceDay}", sortKey: CREATED_AT, reverse: true) {
          edges { node {
            id name cancelledAt
            totalPriceSet { shopMoney { amount } }
            totalRefundedSet { shopMoney { amount } }
            transactions { kind status amountSet { shopMoney { amount } } }
            customAttributes { key value }
          } }
          pageInfo { hasNextPage }
        }
      }`,
    }),
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}`);
  const body = await res.json();
  // A GraphQL error arrives as a 200 with an errors array, which is exactly how
  // a broken query would otherwise read as "this store has no duplicates".
  if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 200));
  const conn = body?.data?.orders;
  const orders = ((conn?.edges || []) as any[]).map((e) => {
    const n = e.node || {};
    const total = Number(n.totalPriceSet?.shopMoney?.amount ?? 0);
    const refunded = Number(n.totalRefundedSet?.shopMoney?.amount ?? 0);
    // ⚠️ A COPY IS CLEANED UP WHEN THE PAYMENT IS REVERSED, NOT WHEN THE
    // REFUND REACHES THE ORDER TOTAL. PayMore’s new Marketplace Connect writes
    // orders whose total includes tax with NO payment transaction behind it
    // (455.79 total against 429.99 paid). Shopify REFUSES to refund more than the
    // payment, so refunded can never reach total on those orders — and the
    // total-based test therefore reported 15 fully-reversed MPL duplicates as
    // still double-counted, permanently, while the books were provably correct.
    // A watchdog that cannot go quiet after a correct cleanup is a watchdog that
    // hides the next real one.
    //
    // net_sales tracks the PAYMENT, so the payment is also what has to come back
    // out. Falls back to the total when no payment transaction is visible, which
    // keeps the behaviour unchanged for every ordinary order.
    const paid = ((n.transactions ?? []) as any[])
      .filter((t) => t?.status === "SUCCESS" && (t.kind === "SALE" || t.kind === "CAPTURE"))
      .reduce((sum: number, t: any) => sum + Number(t?.amountSet?.shopMoney?.amount ?? 0), 0);
    const owed = paid > 0 ? Math.min(total, paid) : total;
    return {
      // ebay_orders.shopify_order_id holds the bare numeric id, not the gid, so
      // the prefix comes off here rather than at every comparison.
      id: String(n.id ?? "").replace("gid://shopify/Order/", ""),
      name: String(n.name ?? ""),
      cancelled: !!n.cancelledAt,
      // Fully refunded IS the cleaned-up state. Compared with a half-cent of
      // slack so rounding cannot keep a cleaned copy in the count forever.
      refunded: owed > 0 && refunded >= owed - 0.005,
      ebayId: ((n.customAttributes || []) as any[])
        .find((a) => a?.key === "eBay Order Id")?.value ?? null,
    };
  });
  return { orders, truncated: !!conn?.pageInfo?.hasNextPage };
}

// The state of specific orders by id. Needed because a duplicate is only a
// duplicate while BOTH copies are live: on one pair in the 2026-08-20 burst it
// was OUR copy that got reversed and the foreign one kept, which leaves correct
// books and would otherwise be reported as a duplicate forever. Our copy is
// usually older than the scan window, so its state cannot come from the same
// read — hence one extra call, and only when there are suspects at all.
async function shopifyOrderStates(shop: string, token: string, ids: string[]) {
  const gids = ids.map((i) => `"gid://shopify/Order/${i}"`).join(", ");
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({
      query: `{ nodes(ids: [${gids}]) { ... on Order {
        id cancelledAt
        totalPriceSet { shopMoney { amount } }
        totalRefundedSet { shopMoney { amount } }
      } } }`,
    }),
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 200));
  const live: Record<string, boolean> = {};
  for (const n of (body?.data?.nodes || []) as any[]) {
    if (!n?.id) continue;
    const total = Number(n.totalPriceSet?.shopMoney?.amount ?? 0);
    const refunded = Number(n.totalRefundedSet?.shopMoney?.amount ?? 0);
    live[String(n.id).replace("gid://shopify/Order/", "")] =
      !n.cancelledAt && !(total > 0 && refunded >= total - 0.005);
  }
  return live;
}

// ---------------------------------------------------------------------------
async function collect(sb: any): Promise<{ issues: Issue[]; counts: Record<string, number> }> {
  const out: Issue[] = [];
  const counts: Record<string, number> = {};
  const push = (i: Issue) => out.push(i);

  // THE FAILURE MODE THIS EXISTS TO PREVENT. Every read below used to discard
  // its error and carry on with undefined data, which for an alerter is the
  // worst possible behaviour: one malformed filter and it reports "all clear"
  // forever, indistinguishably from a healthy system. A read that fails is now
  // itself a critical alert, and the row counts are returned so a dry run can
  // show the watchdog is actually seeing data rather than an empty table.
  const read = async (name: string, qb: any): Promise<any[]> => {
    const { data, error } = await qb;
    if (error) {
      push({
        key: `watchdog_read:${name}`, store: null, severity: "critical",
        title: `This error check is partly blind`,
        detail: `We cannot read ${name}, so any problem in it goes unreported — meaning a quiet `
          + `inbox no longer proves everything is fine. Our end, and it is the most important one `
          + `on this list. The error: ${short(error.message, 110)}`,
        fix: "claude",
      });
      counts[name] = -1;
      return [];
    }
    counts[name] = (data || []).length;
    return data || [];
  };

  // --- 1. listings that failed, errored, or never left pending ---------------
  // Only rows that could BE a problem. Pulling the whole table works today at a
  // few hundred rows and quietly stops working at a thousand.
  const listings = await read("ebay_listings", sb.from("ebay_listings")
    .select("store_code, sku, status, last_error, attempts, last_attempt_at, title")
    .or("status.eq.failed,status.eq.pending,last_error.not.is.null")
        // A row someone deliberately gave up on must stop nagging. status is no
        // longer "failed" once dismissed, but last_error is kept on purpose — and
        // the not-null arm of the OR above would otherwise keep matching it.
        .neq("status", "dismissed"));
  for (const l of listings) {
    const st = String(l.status || "");
    const systemic = SYSTEMIC.test(String(l.last_error || ""));
    if (st === "failed" && systemic) {
      push({
        key: `listing_blocked:${l.store_code}:${l.sku}`, store: l.store_code, severity: "critical",
        title: `Can't list on eBay — ${l.sku}`,
        detail: `eBay is turning this listing away for a reason the store cannot change `
          + `(the connection, a rate limit, or eBay itself). ${l.sku}`
          + `${l.title ? ` — ${short(l.title, 60)}` : ""} is not on eBay and won't get there `
          + `without a fix at our end. eBay's words: ${short(l.last_error, 110)}`,
        fix: "claude",
      });
    } else if (st === "pending") {
      const m = minsAgo(l.last_attempt_at);
      if (m !== null && m > LISTING_STUCK_MIN) {
        push({
          key: `listing_stuck:${l.store_code}:${l.sku}`, store: l.store_code, severity: "critical",
          title: `Listing stuck halfway — ${l.sku}`,
          detail: `We started putting ${l.sku} on eBay ${m} minutes ago and it never finished`
            + `${l.attempts ? `, after ${l.attempts} tries` : ""}. It is not live and not `
            + `failed either, so nothing will retry it on its own.`,
          fix: "claude",
        });
      }
    }
  }

  // --- 2. orders: errors, tracking never pushed, and long-unshipped ----------
  // Tracking captured but not pushed is the worst of these: the customer has
  // been shipped, eBay has not been told, and the clock on a late-shipment
  // defect is running against a store that actually did its job.
  // Same reasoning as the listings read. The 90-day floor keeps this bounded as
  // orders accumulate; an error older than that is history, not an alert.
  const orderFloor = new Date(Date.now() - 90 * 86400000).toISOString();
  const orders = await read("ebay_orders", sb.from("ebay_orders")
    .select("store_code, ebay_order_id, shopify_order_name, status, last_error, tracking_number, tracking_pushed_at, sold_at, updated_at")
    .gte("sold_at", orderFloor)
    .or("last_error.not.is.null,status.eq.imported,and(tracking_number.not.is.null,tracking_pushed_at.is.null)"));
  for (const o of orders) {
    const label = o.shopify_order_name || o.ebay_order_id;
    if (o.last_error) {
      // THE COMMON ONE, AND IT IS NOT A TOOL FAULT. Shopify says
      // "Unable to reserve inventory" when it holds zero of the thing eBay just
      // sold, so the sale cannot be written down. That is the shelf and Shopify
      // disagreeing, which only somebody standing in the store can settle —
      // and the raw Shopify wording gives no hint of that. Named explicitly so
      // it reads as a job rather than a breakage.
      const noStock = /unable to reserve inventory|insufficient inventory/i.test(String(o.last_error));
      if (noStock) {
        push({
          key: `order_error:${o.store_code}:${o.ebay_order_id}`, store: o.store_code, severity: "critical",
          title: `Sold on eBay but Shopify says we have none — ${label}`,
          detail: `eBay sold this and took the customer's money, but Shopify has zero in stock, `
            + `so the sale cannot be recorded and nothing will ship. Go and look for it: `
            + `if it IS on the shelf, set its Shopify quantity to 1 and this fixes itself within `
            + `a couple of minutes. If it is NOT, cancel the order on eBay and refund the buyer, `
            + `then tell Claude so the listing comes down.`,
          fix: "store",
        });
      } else {
        push({
          key: `order_error:${o.store_code}:${o.ebay_order_id}`, store: o.store_code, severity: "critical",
          title: `An eBay sale did not reach Shopify — ${label}`,
          detail: `The sale is real and paid on eBay, but writing it into Shopify keeps failing, `
            + `so it is missing from sales, stock and the day's numbers. Nothing the floor can do. `
            + `The error: ${short(o.last_error, 120)}`,
          fix: "claude",
        });
      }
    }
    if (o.tracking_number && !o.tracking_pushed_at) {
      const m = minsAgo(o.updated_at);
      if (m !== null && m > TRACKING_STUCK_MIN) {
        push({
          key: `tracking_unpushed:${o.store_code}:${o.ebay_order_id}`, store: o.store_code, severity: "critical",
          title: `eBay has not been told this shipped — ${label}`,
          detail: `The store did its job ${m} minutes ago: it is packed and tracking `
            + `${o.tracking_number} is on the order. We have not passed that to eBay, so the buyer `
            + `sees no tracking and eBay's late-shipment clock is still running against the store. `
            + `That is our end, not theirs.`,
          fix: "claude",
        });
      }
    }
    // An order the store simply has not packed yet is store behaviour, not a
    // broken tool, so it is not alerted here. Tracking that EXISTS and was never
    // pushed stays above: that one is the tool failing on a store that did its job.
  }

  // --- 3. the sweeps: did they error, and are they still running at all ------
  const since = new Date(Date.now() - 6 * 3600_000).toISOString();
  const sweeps: Array<[string, string]> = [["ebay_live_runs", "live sweep"], ["ebay_catalog_runs", "catalog sweep"]];
  for (const [tbl, name] of sweeps) {
    const runs = await read(tbl, sb.from(tbl)
      .select("store_code, started_at, error").gte("started_at", since).not("error", "is", null));
    // Keyed per store+sweep, not per run: a sweep erroring every 20 minutes is
    // ONE broken thing, and should read as one line rather than eighteen.
    const seen = new Set<string>();
    for (const r of runs) {
      const k = `sweep_error:${tbl}:${r.store_code}`;
      if (seen.has(k)) continue;
      seen.add(k);
      push({
        key: k, store: r.store_code, severity: "critical",
        title: `${r.store_code}: the ${name} keeps erroring`,
        detail: `The job that keeps ${r.store_code}'s eBay listings and stock in step with Shopify `
          + `is failing every time it runs, so what eBay shows for ${r.store_code} is drifting out `
          + `of date. Nothing the floor can do. The error: ${short(r.error, 120)}`,
        fix: "claude",
      });
    }
  }

  // Via a view, NOT a plain select on ebay_live. That table is one row per live
  // listing (~1,900 across five stores) and PostgREST caps a select at 1,000, so
  // reading it whole silently drops whichever stores fall past the cap. The first
  // dry run of this alerter duly reported that WSP and OVL had never listed
  // anything, while both had hundreds.
  const fresh = await read("ebay_live_freshness", sb.from("ebay_live_freshness").select("store_code, last_seen"));
  const freshest: Record<string, string> = {};
  for (const r of fresh) freshest[r.store_code] = r.last_seen;

  // --- 4. stores: config, tokens, and a sweep that has gone quiet ------------
  const stores = await read("ebay_stores", sb.from("ebay_stores")
    .select("store_code, merchant_location_key, payment_policy_id, return_policy_id, fulfillment_policy_id, refresh_token_expires_at, channel_mode"));
  for (const s of stores) {
    const missing = [
      !s.merchant_location_key ? "location" : null,
      !s.payment_policy_id ? "payment policy" : null,
      !s.return_policy_id ? "return policy" : null,
      !s.fulfillment_policy_id ? "shipping policy" : null,
    ].filter(Boolean);
    if (missing.length) {
      push({
        key: `store_config:${s.store_code}`, store: s.store_code, severity: "critical",
        title: `${s.store_code} cannot list anything on eBay yet`,
        detail: `eBay will not accept a listing from ${s.store_code} until these are chosen: `
          + `${missing.join(", ")}. Set them on the SPEEKS Connect tab and listing starts working. `
          + `Nothing else is wrong.`,
        fix: "ethan",
      });
    }
    if (s.refresh_token_expires_at) {
      const days = (new Date(s.refresh_token_expires_at).getTime() - Date.now()) / 86400000;
      if (days < TOKEN_WARN_DAYS) {
        push({
          key: `token_expiring:${s.store_code}`, store: s.store_code,
          severity: days < 7 ? "critical" : "warning",
          title: `${s.store_code}'s eBay connection expires in ${Math.floor(days)} days`,
          detail: `Reconnect ${s.store_code} on the SPEEKS Connect tab — it takes a minute and only `
            + `you can do it. If the day passes, everything eBay stops at that store: no new `
            + `listings, no orders coming in, no tracking going out.`,
          fix: "ethan",
        });
      }
    }
    // A PARKED STORE IS NOT BEING SWEPT ON PURPOSE. Marketplace Connect owns its
    // listings, our own rows sit at `disabled`, and nothing reads ebay_live for it:
    // auto-listing is off, reconcile and reprice act on published/ended only. The
    // sweep was costing 432 eBay calls a day across MPL+BAL+LEE for data no code
    // consumes, so those crons are off — and a check that shouts about that every
    // 15 minutes is how this email stops being read.
    //
    // The token warning above is deliberately NOT skipped: break-glass is the whole
    // reason the channel still exists, and it needs a live connection to work.
    if (String((s as any).channel_mode || "active") === "standby") continue;

    const m = minsAgo(freshest[s.store_code] || null);
    if (m === null) {
      push({
        key: `sweep_never:${s.store_code}`, store: s.store_code, severity: "warning",
        title: `We cannot see what ${s.store_code} has live on eBay`,
        detail: `We have never managed to read ${s.store_code}'s live eBay listings, so we cannot `
          + `tell whether a sold item is still up for sale there. Our end.`,
        fix: "claude",
      });
    } else if (m > SWEEP_STALE_MIN) {
      push({
        key: `sweep_stale:${s.store_code}`, store: s.store_code, severity: "critical",
        title: `${s.store_code}'s eBay listings are not being checked`,
        detail: `The check that pulls sold-out items off eBay last worked ${m} minutes ago and it `
          + `should run every 20. Until it does, ${s.store_code} can sell something it no longer `
          + `has, and eBay counts that cancellation against the store. Our end.`,
        fix: "claude",
      });
    }
  }

  // --- 5. the same SKU live twice -------------------------------------------
  // One physical unit, two buyable listings. Whoever loses the race gets
  // cancelled, and the cancellation is a defect against the store.
  // Grouped in the database for the same reason as the freshness view, and here
  // the row cap would be actively dangerous: truncation turns the most important
  // check in this file into a silent false negative that gets worse as the
  // catalogue grows. The view returns a handful of rows or none.
  const dups = await read("ebay_live_duplicates", sb.from("ebay_live_duplicates")
    .select("store_code, sku, item_id_count, item_ids"));
  for (const d of dups) {
    push({
      key: `dup_live:${d.store_code}:${d.sku}`, store: d.store_code, severity: "critical",
      title: `One item is for sale twice on eBay — ${d.sku}`,
      detail: `${d.sku} has ${d.item_ids} listed at the same time and there is only one of it. `
        + `Whoever buys second gets cancelled, and eBay counts that against the store. `
        + `End all but one of those listings on eBay.`,
      fix: "store",
    });
  }

  // --- 6. have the cron jobs themselves stopped? ----------------------------
  // Everything above measures what the jobs PRODUCED. This measures the jobs.
  // A poll that stops finding orders looks identical to a poll that stopped
  // running, and only one of those is an emergency.
  //
  // THE THRESHOLD IS PER JOB. CRON_STALE_MIN is right for an order poll that
  // runs every two minutes and nonsense for anything slower, and the view used
  // to pick up jobs by matching `command ILIKE '%ebay%'` — the SQL text, not
  // ownership. So when the Call Back jobs were added on 2026-08-21 and two of
  // them called ebay-catalog three times a day, this watchdog adopted them on
  // creation and mailed "Scheduled job stopped" fifteen minutes later. They were
  // not stopped; they had not reached their first fire.
  //
  // `cron_expectations` carries an allowance per job. `watching_since` is what
  // stops a brand-new job being called dead in the gap between being scheduled
  // and running for the first time. Migration 0044 also filters healthy slow
  // jobs out of the view — belt and braces, and the two agree by construction.
  const crons = await read("ebay_cron_health",
    sb.from("ebay_cron_health").select("jobname, last_run, failures_1h, stale_after_min, watching_since"));
  for (const c of crons) {
    const limit = Number(c.stale_after_min) > 0 ? Number(c.stale_after_min) : CRON_STALE_MIN;
    const ran = minsAgo(c.last_run);
    const m = ran ?? minsAgo(c.watching_since);
    if (m === null || m > limit) {
      const hrs = (n: number) => n >= 120 ? `${Math.floor(n / 60)} hours` : `${n} minutes`;
      push({
        key: `cron_stale:${c.jobname}`, store: null, severity: "critical",
        title: `An automatic job has stopped running — ${c.jobname}`,
        // Two different facts, and the old copy told the second as the first: a
        // job that has never run does not have a "last ran".
        detail: ran !== null
          ? `It last ran ${hrs(ran)} ago and should run at least every ${hrs(limit)}. `
            + `Whatever it keeps up to date is now going stale. Our end.`
          : m === null
            ? `It has never run since it was set up, so whatever it was meant to do has never `
              + `happened. Our end.`
            : `It has not run once in the ${hrs(m)} since it was set up. Our end.`,
        fix: "claude",
      });
    } else if (Number(c.failures_1h) > 0) {
      push({
        key: `cron_failing:${c.jobname}`, store: null, severity: "critical",
        title: `An automatic job keeps erroring — ${c.jobname}`,
        detail: `It failed ${c.failures_1h} time(s) in the last hour. It is still running, it is `
          + `just not working. Our end.`,
        fix: "claude",
      });
    }
  }

  // --- 7. the same eBay order imported into Shopify twice -------------------
  // On 2026-08-20 Marketplace Connect back-filled four days of eBay sales that
  // SPEEKS Connect had already imported: 76 duplicate Shopify orders across BAL
  // and MPL, $16.7k of revenue counted twice, and every affected unit
  // decremented twice, which put 72 variants on negative stock. It ran from
  // 1:41pm unnoticed, because every other check in this file reads OUR tables
  // and the duplicate only ever existed in Shopify.
  //
  // WHY THIS IS NOT JUST A DATE WINDOW OVER SHOPIFY. A back-fill runs BACKWARDS
  // in time: the second copy is created today against a sale that landed days
  // ago. Grouping a single N-day window of Shopify orders therefore drops our
  // own copy of the oldest pairs and undercounts the burst — measured at 23 and
  // 18 against a true 26 and 31 on the day this was written.
  //
  // So the two halves are bounded differently. The FOREIGN copy has to be
  // recent, because that is the thing we want to hear about quickly. OUR copy
  // comes from the ebay_orders ledger, which records the one Shopify order we
  // created for each eBay sale and needs no window at all.
  //
  // Identity, not tags: a copy counts as foreign when its eBay order id is one
  // we already imported and its Shopify order id is not the one we created.
  // That catches a second copy whoever made it, which a rule keyed on
  // Marketplace Connect's own tags would not.
  //
  // ONE ISSUE PER STORE, not per order — a burst is forty orders, and forty
  // mails is zero mails read. The count stays OUT of the issue key on purpose:
  // a cleanup in progress walks 26 -> 25 -> 24, and a key carrying the count
  // would mail again on every single decrement.
  const shops = await read("shopify_stores", sb.from("shopify_stores").select("shop, access_token"));
  const ledgerFloor = new Date(Date.now() - DUP_LEDGER_DAYS * 86400_000).toISOString();
  const ledger = await read("ebay_orders_ledger", sb.from("ebay_orders")
    .select("store_code, ebay_order_id, shopify_order_id, shopify_order_name")
    .not("shopify_order_id", "is", null)
    .gte("sold_at", ledgerFloor));
  const ours: Record<string, { id: string; name: string }> = {};
  for (const r of ledger) {
    ours[`${r.store_code}:${r.ebay_order_id}`] =
      { id: String(r.shopify_order_id), name: String(r.shopify_order_name || "") };
  }

  const dupSince = new Date(Date.now() - DUP_WINDOW_DAYS * 86400_000).toISOString().slice(0, 10);
  for (const s of shops) {
    const code = SHOP_TO_CODE[String(s.shop)] || String(s.shop);
    let recent: Array<{ id: string; name: string; cancelled: boolean; refunded: boolean; ebayId: string | null }>;
    let truncated = false;
    try {
      const r = await shopifyEbayOrders(String(s.shop), String(s.access_token), dupSince);
      recent = r.orders;
      truncated = r.truncated;
    } catch (err) {
      // A Shopify call that fails must not read as "no duplicates" — that is
      // the same silent false negative the read() wrapper above exists to stop.
      push({
        key: `dup_scan_failed:${code}`, store: code, severity: "warning",
        title: `Cannot check ${code} for double-counted sales`,
        detail: `Shopify would not answer, so if a sale got imported twice at ${code} today we `
          + `would not have spotted it. Our end. The error: ${short(err, 110)}`,
        fix: "claude",
      });
      continue;
    }
    counts[`shopify_ebay_orders_${code}`] = recent.length;

    // A cancelled or fully-refunded copy is a cleaned-up copy, and counting it
    // would keep the alert lit forever after the cleanup is done.
    const live = recent.filter((o) => !o.cancelled && !o.refunded && o.ebayId);
    const extras: Record<string, Set<string>> = {};
    const note = (ebayId: string, name: string) => (extras[ebayId] ||= new Set()).add(name);

    // Suspects first, then one call to ask whether OUR copy of each is still
    // live. Reversing either copy fixes the books, so a pair where ours is the
    // one that went is not a duplicate and must not be reported as one.
    const suspects = live
      .map((o) => ({ o, mine: ours[`${code}:${o.ebayId}`] }))
      .filter((x) => x.mine && x.mine.id !== x.o.id);
    if (suspects.length) {
      let mineLive: Record<string, boolean> = {};
      try {
        mineLive = await shopifyOrderStates(String(s.shop), String(s.access_token),
          [...new Set(suspects.map((x) => x.mine!.id))]);
      } catch (err) {
        // Unverifiable is not the same as clean. Report the suspects and say so,
        // rather than going quiet on the exact condition this check exists for.
        push({
          key: `dup_verify_failed:${code}`, store: code, severity: "warning",
          title: `Could not double-check ${code}'s suspected duplicates`,
          detail: `${suspects.length} sale(s) at ${code} look double-counted, but Shopify would not `
            + `confirm it, so treat the line below as unconfirmed rather than certain. Our end. `
            + `The error: ${short(err, 100)}`,
          fix: "claude",
        });
        mineLive = Object.fromEntries(suspects.map((x) => [x.mine!.id, true]));
      }
      for (const x of suspects) {
        if (mineLive[x.mine!.id] !== false) note(x.o.ebayId!, x.o.name);
      }
    }
    // And the case the ledger cannot see: the same eBay sale imported twice by
    // somebody who is not us at all.
    const seen: Record<string, string> = {};
    for (const o of live) {
      const prev = seen[o.ebayId!];
      if (prev && prev !== o.name) { note(o.ebayId!, o.name); note(o.ebayId!, prev); }
      else seen[o.ebayId!] = o.name;
    }

    const ids = Object.keys(extras);
    if (ids.length) {
      const worst = ids.slice(0, 3)
        .map((id) => `${id} on ${[...extras[id]].join(" and ")}`).join("; ");
      push({
        key: `dup_orders:${code}`, store: code, severity: "critical",
        title: `${code} is counting ${ids.length} sale(s) twice`,
        detail: `${ids.length} eBay sale(s) at ${code} landed in Shopify as two orders instead of `
          + `one, so ${code}'s revenue, gross profit and % to goal are all overstated and the stock `
          + `is double-decremented. This is the Marketplace Connect problem from 20 Aug. `
          + `Do not cancel anything by hand — send this to Claude, who reverses the extra copy `
          + `without touching the real one. Affected: ${worst}${ids.length > 3 ? ", and more" : ""}.`,
        fix: "claude",
      });
    }
    if (truncated) {
      push({
        key: `dup_scan_truncated:${code}`, store: code, severity: "warning",
        title: `${code} sold too much for the duplicate check to read it all`,
        detail: `${code} booked more than ${DUP_PAGE} eBay orders in ${DUP_WINDOW_DAYS} days — good `
          + `news in itself — but the check only read the newest of them, so an older double-counted `
          + `sale could be hiding behind that. Our end: the limit needs raising.`,
        fix: "claude",
      });
    }
  }

  return { issues: out, counts };
}

// ---------------------------------------------------------------------------
const C = {
  sage: "#1f9d57", charcoal: "#1a1c1e", app: "#f1f5f2", card: "#ffffff",
  line: "#eaefeb", muted: "#64707c", faint: "#9aa6ad", red: "#b23636",
  redBg: "#fcecec", redRing: "#f6d5d5",
  amberBg: "#fdf3e1", amberRing: "#f0dcb6", amberInk: "#8a5a06",
};

function build(issues: Issue[], firstSeen: Record<string, string>) {
  const crit = issues.filter((i) => i.severity === "critical");
  const warn = issues.filter((i) => i.severity === "warning");

  // WHOSE JOB IT IS, as a badge on the card rather than something to infer from
  // the wording. Green for the two anybody can act on, grey for the ones only a
  // code change clears — so the mail can be triaged without reading it closely.
  const fixBadge = (f: Fixer) => {
    const mine = f === "claude";
    return `<span style="display:inline-block;background:${mine ? "#eceff1" : "#e8f7ee"};`
      + `color:${mine ? C.muted : "#178048"};border-radius:5px;padding:2px 7px;`
      + `font-size:10px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;`
      + `white-space:nowrap;">${esc(FIX_LABEL[f])}</span>`;
  };

  const card = (i: Issue) => {
    const bad = i.severity === "critical";
    const since = firstSeen[i.key];
    const age = since ? Math.round((Date.now() - new Date(since).getTime()) / 60000) : 0;
    const ageTxt = age >= 1440 ? `${Math.floor(age / 1440)}d` : age >= 60 ? `${Math.floor(age / 60)}h` : `${age}m`;
    return `<tr><td style="padding:0 0 10px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
        style="background:${bad ? C.redBg : C.amberBg};border:1px solid ${bad ? C.redRing : C.amberRing};border-radius:12px;">
        <tr><td style="padding:12px 14px;">
          <div style="font-size:13.5px;font-weight:800;color:${bad ? C.red : C.amberInk};">
            ${i.store ? `<span style="display:inline-block;background:#ffffff;border:1px solid ${bad ? C.redRing : C.amberRing};border-radius:5px;padding:1px 6px;font-size:10.5px;margin-right:7px;">${esc(i.store)}</span>` : ""}${esc(i.title)}
          </div>
          <div style="font-size:12.5px;line-height:1.5;color:${C.muted};margin-top:4px;">${esc(capFirst(i.detail))}</div>
          <div style="margin-top:7px;">${fixBadge(i.fix)}${age > 0 ? `<span style="font-size:10.5px;color:${C.faint};margin-left:8px;">Open for ${ageTxt}</span>` : ""}</div>
        </td></tr>
      </table></td></tr>`;
  };

  const section = (label: string, list: Issue[]) => !list.length ? "" :
    `<div style="margin:18px 2px 10px;border-left:2px solid ${C.sage};padding-left:11px;
       font-size:14.5px;font-weight:800;color:${C.charcoal};">${label} (${list.length})</div>
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${list.map(card).join("")}</table>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.app};font-family:Inter,Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.app};padding:20px 10px;"><tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:${C.card};border:1px solid ${C.line};border-radius:18px;overflow:hidden;">
  <tr><td style="background:#13181a;padding:18px 22px;">
    <div style="font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#6ee7a7;">Speeks Technology</div>
    <div style="font-size:19px;font-weight:800;color:#ffffff;margin-top:2px;">SPEEKS Connect — Errors</div>
    <div style="font-size:12.5px;font-weight:600;color:rgba(255,255,255,.66);margin-top:2px;">
      ${crit.length} Needing Attention${warn.length ? `, ${warn.length} To Watch` : ""}</div>
  </td></tr>
  <tr><td style="height:3px;background:${C.sage};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:14px 20px 20px;">
    ${section("Fix Now", crit)}
    ${section("Worth A Look", warn)}
  </td></tr>
  <tr><td style="padding:12px 20px;border-top:1px solid ${C.line};background:#f7faf8;color:${C.muted};font-size:11px;line-height:1.7;">
    <b style="color:${C.charcoal};">The tag on each one says who can fix it.</b><br>
    <b>Store Can Fix</b> — the shop floor sorts it out: count something, cancel something,
    correct a listing. No code needed.<br>
    <b>You Can Fix</b> — a setting or a reconnect only you can do, and the mail says where.<br>
    <b>Needs Claude</b> — the tool itself is broken. Nobody on the floor can help; forward it.
  </td></tr>
  <tr><td style="padding:12px 14px;text-align:center;color:${C.faint};font-size:10.5px;line-height:1.6;border-top:1px solid ${C.line};background:#f7faf8;">
    Checked every 15 minutes. You only get this mail when something is wrong, and
    each problem is reported once until it is fixed.
  </td></tr>
</table></td></tr></table></body></html>`;
}

async function loadRecipients(sb: any): Promise<string[]> {
  const { data, error } = await sb.from("email_recipients").select("email").eq("list_key", RECIPIENT_LIST);
  if (error) return TO_DEFAULT;
  const list = (data || []).map((r: any) => String(r.email)).filter(Boolean);
  return list.length ? list : TO_DEFAULT;
}

// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const q = (k: string) => url.searchParams.get(k);
  if (q("secret") !== SECRET) return json({ error: "Unauthorized" }, 401);

  // PREVIEW MODE. Renders the mail with invented issues and sends it nowhere
  // near the real check: no table is read and no dedupe state is written. It
  // stays in the function on purpose — this alerter is silent when healthy, so
  // without a way to make it speak on demand there is no way to see what a
  // change to the layout actually did until something breaks for real.
  if (q("sample") === "1") {
    const t0 = Date.now();
    // One of each FIXER on purpose: the point of a preview is to see whether the
    // mail can be triaged at a glance, and that only shows with all three badges
    // side by side.
    const fake: Issue[] = [
      { key: "s1", store: "MPL", severity: "critical",
        title: "Sold on eBay but Shopify says we have none — 08-15063-71239",
        detail: "eBay sold this and took the customer's money, but Shopify has zero in stock, so the sale cannot be recorded and nothing will ship. Go and look for it: if it IS on the shelf, set its Shopify quantity to 1 and this fixes itself within a couple of minutes. If it is NOT, cancel the order on eBay and refund the buyer, then tell Claude so the listing comes down.",
        fix: "store" },
      { key: "s2", store: "LEE", severity: "critical",
        title: "LEE's eBay connection expires in 5 days",
        detail: "Reconnect LEE on the SPEEKS Connect tab — it takes a minute and only you can do it. If the day passes, everything eBay stops at that store: no new listings, no orders coming in, no tracking going out.",
        fix: "ethan" },
      { key: "s3", store: null, severity: "critical",
        title: "This error check is partly blind",
        detail: "We cannot read ebay_orders, so any problem in it goes unreported — meaning a quiet inbox no longer proves everything is fine. Our end, and it is the most important one on this list. The error: permission denied for relation ebay_orders",
        fix: "claude" },
      { key: "s4", store: "WSP", severity: "critical",
        title: "One item is for sale twice on eBay — MO02-4518A-E10",
        detail: "MO02-4518A-E10 has 2 listings at the same time and there is only one of it. Whoever buys second gets cancelled, and eBay counts that against the store. End all but one of those listings on eBay.",
        fix: "store" },
      { key: "s5", store: "OVL", severity: "warning",
        title: "OVL's eBay listings are not being checked",
        detail: "The check that pulls sold-out items off eBay last worked 161 minutes ago and it should run every 20. Until it does, OVL can sell something it no longer has, and eBay counts that cancellation against the store. Our end.",
        fix: "claude" },
    ];
    const fs2: Record<string, string> = {};
    const ages = [95, 192, 41, 1500, 168];
    fake.forEach((i, n) => { fs2[i.key] = new Date(t0 - ages[n] * 60000).toISOString(); });
    const h = build(fake, fs2);
    if (q("html") === "1") return new Response(h, { headers: { "Content-Type": "text/html" } });
    const to = q("to") || TO_DEFAULT.join(",");
    const nC = fake.filter((i) => i.severity === "critical").length;
    const subject = `[SAMPLE] SPEEKS Connect — ${fake.length} Issues (${nC} To Fix Now)`;
    const res = await fetch(GMAIL_RELAY, {
      method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ secret: SECRET, to, subject, html: h }),
    });
    return json({ ok: res.ok, status: res.status, to, sample: true });
  }

  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { issues, counts } = await collect(sb);
    const now = new Date().toISOString();

    const { data: prior } = await sb.from("ebay_alert_state").select("*");
    const priorBy: Record<string, any> = {};
    for (const r of (prior || [])) priorBy[r.issue_key] = r;

    // Alert on anything never alerted, or still open past the re-nag window.
    const renagBefore = new Date(Date.now() - RENAG_HOURS * 3600_000).toISOString();
    const toAlert = issues.filter((i) => {
      const p = priorBy[i.key];
      return !p || !p.last_alerted || p.last_alerted < renagBefore;
    });

    const firstSeen: Record<string, string> = {};
    for (const i of issues) firstSeen[i.key] = priorBy[i.key]?.first_seen || now;

    const html = toAlert.length ? build(toAlert, firstSeen) : "";
    if (q("dryRun") === "1") {
      return (q("html") === "1" && html)
        ? new Response(html, { headers: { "Content-Type": "text/html" } })
        : json({
            ok: true, open: issues.length, wouldAlert: toAlert.length,
            // rowsRead proves the watchdog is reading real data. All zeroes on a
            // busy system means the checks are blind, which looks identical to
            // "nothing is wrong" in the issue list alone. -1 means that read failed.
            rowsRead: counts,
            issues: issues.map((i) => ({ severity: i.severity, store: i.store, title: i.title, key: i.key })),
          });
    }

    let sent: any = null;
    if (toAlert.length) {
      const to = q("to") ? [q("to")!] : await loadRecipients(sb);
      const nCrit = toAlert.filter((i) => i.severity === "critical").length;
      const subject = `SPEEKS Connect — ${toAlert.length} Issue${toAlert.length === 1 ? "" : "s"}` +
        (nCrit ? ` (${nCrit} To Fix Now)` : "");
      const res = await fetch(GMAIL_RELAY, {
        method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ secret: SECRET, to: to.join(","), subject, html }),
      });
      sent = { ok: res.ok, status: res.status, to };
    }

    // Record what is open now. Anything not in this pass has been fixed, so its
    // row goes: if it ever returns it should read as new, because it is.
    for (const i of issues) {
      const p = priorBy[i.key];
      const alerted = toAlert.some((t) => t.key === i.key);
      await sb.from("ebay_alert_state").upsert({
        issue_key: i.key, store_code: i.store, severity: i.severity, summary: i.title,
        first_seen: p?.first_seen || now,
        last_seen: now,
        last_alerted: alerted ? now : (p?.last_alerted ?? null),
        times_alerted: (p?.times_alerted || 0) + (alerted ? 1 : 0),
      }, { onConflict: "issue_key" });
    }
    const openKeys = new Set(issues.map((i) => i.key));
    const goneKeys = (prior || []).map((r: any) => r.issue_key).filter((k: string) => !openKeys.has(k));
    if (goneKeys.length) await sb.from("ebay_alert_state").delete().in("issue_key", goneKeys);

    return json({ ok: true, open: issues.length, alerted: toAlert.length, resolved: goneKeys.length, sent });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message ?? err), stack: String(err?.stack ?? "").slice(0, 400) }, 500);
  }
});
