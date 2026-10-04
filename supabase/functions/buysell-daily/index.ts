import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// Day-by-day buying and selling for one month, for the Daily Breakdown popout.
//
// TWO SOURCES, one shape. The month the stores are trading in comes from
// app_cache/buy_sell_hub — the same 10-minute cache the Live Dashboard and the
// Buying & Selling widget read, so the popout can never show a different figure
// from the card that opened it. Finished months come from daily_buysell, the
// hourly capture of that same cache (capture_daily_buysell), which is the only
// place a day survives the sheet rolling over.
//
// NAMING. The sheet's two money columns read backwards from what they are
// called everywhere in this codebase, and getting them the wrong way round is a
// silent 2x error:
//   sheet "Sell" column = resale value of what was bought -> `resale`
//                                        (hub wkBuy / daily_buysell.buy)
//   sheet "Buy" column  = cash actually paid out          -> `paid`
//                                        (resale * (1 - buyMargin))
// Verified against the live sheet for OVL August 2026: resale sums to 50,550.00
// and paid to 24,051.60, which are that store's Sell and Buy totals to the cent.
// The API deliberately says `resale`/`paid` rather than buy/sell so no caller
// has to remember which convention it is holding.

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];

// The picker never offers a month it cannot fill. June 2026 exists in
// daily_buysell as a single backfilled day (the 30th, reconstructed when the
// cross-month retention gap was closed) and would render as a month where every
// store did nothing for 29 days — worse than not offering June at all.
const MIN_DAYS_FOR_A_MONTH = 5;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// The edge runtime is UTC, so a bare new Date() names the wrong month for the
// first six hours of the 1st — Central is still in the old month while UTC has
// already turned over, and the popout would open on an empty August while the
// stores were still finishing July. en-CA formats as YYYY-MM-DD.
function centralToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

type Day = {
  day: number;
  sales: number | null;
  cost: number | null;
  gp: number | null;
  resale: number | null;
  paid: number | null;
  buyMargin: number | null;
  // Net Profit and what it costs to get there, from daily_np (the mirror of the
  // workbook's Net Profit tab). All null on a day the tab does not have yet —
  // today, and every month before September 2026.
  np?: number | null;
  ebayFee?: number | null;
  shipping?: number | null;
  ccFee?: number | null;
  royalty?: number | null;
  // false while the day's shipping can still move (it lands on the next day's
  // 2pm pass): the NP is then higher than it will end up.
  shipFinal?: boolean | null;
};

// From October 2026 stores are graded on NET profit, and the month's goal is an
// NP goal (gp-goals, monthly_np_goals). Earlier months keep the GP goal they
// were given. Same rule, same constant, as gp-goals.
const NP_FROM = "2026-10";

// A day is only a row if the sheet actually carries something for it. Null, not
// zero: a day nobody has keyed yet and a day the store genuinely bought nothing
// are different facts, and rendering the first as $0 turns "not entered" into a
// reported zero. The frontend dashes nulls.
function makeDay(
  day: number,
  sales: unknown,
  gp: unknown,
  resale: unknown,
  margin: unknown,
): Day {
  const s = num(sales), g = num(gp), r = num(resale);
  const sold = s !== 0 || g !== 0;
  const bought = r !== 0;
  return {
    day,
    sales: sold ? s : null,
    cost: sold ? s - g : null,
    gp: sold ? g : null,
    resale: bought ? r : null,
    // Cash paid is derived per DAY and summed by the caller, never taken off a
    // mean of the margins: margins cannot be averaged across days of different
    // size. Same rule the Live Dashboard's _lvBuyFor follows.
    paid: bought ? r * (1 - num(margin)) : null,
    buyMargin: bought ? num(margin) : null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const url = new URL(req.url);
    const today = centralToday();
    const thisMonth = today.slice(0, 7);

    const asked = String(url.searchParams.get("month") || "").trim();
    const month = /^\d{4}-\d{2}$/.test(asked) ? asked : thisMonth;
    const isCurrent = month === thisMonth;

    const [y, m] = month.split("-").map(Number);
    // Day 0 of the NEXT month is the last day of this one. UTC throughout: this
    // is arithmetic on a calendar, not a moment in time, so no zone applies.
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

    // Which months the picker may offer. Built from the history table rather
    // than from a hardcoded start date, so it grows by itself and can never
    // offer a month that turns out to be empty.
    const { data: histRows, error: histErr } = await supabase
      .from("daily_buysell")
      .select("date")
      .order("date", { ascending: false });
    if (histErr) throw histErr;

    const dayCount = new Map<string, Set<string>>();
    for (const r of histRows || []) {
      const ym = String(r.date).slice(0, 7);
      if (!dayCount.has(ym)) dayCount.set(ym, new Set());
      dayCount.get(ym)!.add(String(r.date));
    }
    const months = [...dayCount.entries()]
      .filter(([, days]) => days.size >= MIN_DAYS_FOR_A_MONTH)
      .map(([ym]) => ym);
    // The current month is always offered even before the hourly capture has
    // put five days in the history table — on the 2nd it is served from the
    // cache, which does not depend on that table at all.
    if (!months.includes(thisMonth)) months.push(thisMonth);
    months.sort().reverse();

    const stores: Record<string, { goal: number | null; days: Day[] }> = {};
    let source = "history";

    if (isCurrent) {
      // ---- the month in progress: straight off the shared cache ----
      const { data: cache, error: cacheErr } = await supabase
        .from("app_cache")
        .select("payload, synced_at")
        .eq("key", "buy_sell_hub")
        .maybeSingle();
      if (cacheErr) throw cacheErr;

      const p = (cache?.payload || {}) as Record<string, unknown>;
      const arr = (key: string, code: string): unknown[] => {
        const byStore = p[key] as Record<string, unknown> | undefined;
        const a = byStore && byStore[code];
        return Array.isArray(a) ? a : [];
      };
      source = "cache";

      for (const code of STORES) {
        const sell = arr("wkSell", code);
        const gp = arr("wkGP", code);
        const resale = arr("wkBuy", code);
        const margin = arr("wkBuyMarginPct", code);
        const days: Day[] = [];
        for (let d = 1; d <= daysInMonth; d++) {
          days.push(makeDay(d, sell[d - 1], gp[d - 1], resale[d - 1], margin[d - 1]));
        }
        const goalKey = code.toLowerCase() + "Goal";
        stores[code] = {
          // The GP goal is only known for the month the sheet is currently on.
          // Nothing stores a historical goal, so a finished month shows what it
          // did without claiming what it was asked to do.
          goal: p[goalKey] == null ? null : num(p[goalKey]),
          days,
        };
      }
    } else {
      // ---- a finished month: the hourly capture ----
      const last = month + "-" + String(daysInMonth).padStart(2, "0");
      const { data: rows, error } = await supabase
        .from("daily_buysell")
        .select("date, store, buy, sell, gp, buy_margin_pct")
        .gte("date", month + "-01")
        .lte("date", last);
      if (error) throw error;

      const byStore = new Map<string, Map<number, Record<string, unknown>>>();
      for (const r of rows || []) {
        const code = String(r.store || "").toUpperCase();
        if (!byStore.has(code)) byStore.set(code, new Map());
        byStore.get(code)!.set(Number(String(r.date).slice(8, 10)), r);
      }
      for (const code of STORES) {
        const mine = byStore.get(code) || new Map();
        const days: Day[] = [];
        for (let d = 1; d <= daysInMonth; d++) {
          const r = mine.get(d);
          days.push(makeDay(d, r?.sell, r?.gp, r?.buy, r?.buy_margin_pct));
        }
        stores[code] = { goal: null, days };
      }
    }

    // ---- Net Profit, from the mirror of the NP tab -----------------------
    // WHERE THE TAB HAS A DAY, ITS SALES / COST / GP WIN TOO. The NP tab and the
    // Sales tab carry identical sales and GP (September 2026 checked: every store
    // to the cent), but only the NP tab will outlive the Sales Summary import,
    // and taking all of a day from one source is what guarantees that
    //   GP − eBay − shipping − card − royalty = NP
    // holds on every row of the table rather than nearly holding.
    const { data: npRows, error: npErr } = await supabase
      .from("daily_np")
      .select("date, store, sales, cost, gp, ebay_fee, shipping_cost, cc_fee, royalty, np, shipping_final")
      .gte("date", month + "-01")
      .lte("date", month + "-" + String(daysInMonth).padStart(2, "0"));
    if (npErr) throw npErr;
    const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    let npDays = 0;
    for (const r of npRows || []) {
      const code = String(r.store || "").toUpperCase();
      const d = stores[code]?.days[Number(String(r.date).slice(8, 10)) - 1];
      if (!d) continue;
      npDays++;
      if (r.sales !== null) { d.sales = nn(r.sales); d.cost = nn(r.cost); d.gp = nn(r.gp); }
      d.np = nn(r.np);
      d.ebayFee = nn(r.ebay_fee);
      d.shipping = nn(r.shipping_cost);
      d.ccFee = nn(r.cc_fee);
      d.royalty = nn(r.royalty);
      d.shipFinal = !!r.shipping_final;
    }

    // ---- eBay: what the fee is made of, and the standing behind it -------
    // ebay_fee_month (ebay-fee-mix, 0132): the month's fees by kind, net of
    // refund credits — the final value fee as a share of eBay sales, and the
    // "very high item not as described" fee eBay adds in a category whose INAD
    // rate is very high against peers. ebay_metrics: the store's service metrics
    // as last entered in Performance Metrics, which decide Top Rated (and its
    // final-value-fee discount). Together they say WHY a store's eBay fee is what
    // it is. Missing rows are simply absent; the popout shows what there is.
    const [{ data: feeRows }, { data: metRows }] = await Promise.all([
      supabase.from("ebay_fee_month").select("store, ebay_sales, sale_lines, fvf, fvf_fixed, inad, inad_lines, intl, other, total, synced_at").eq("ym", month),
      supabase.from("ebay_metrics").select("store, transaction_defect, late_shipment, cases_without_resolution, tracking_on_time, current_high, current_very_high, projected_high, projected_very_high, updated_at"),
    ]);
    const ebay: Record<string, unknown> = {};
    for (const code of STORES) {
      const fee = (feeRows || []).find((r: Record<string, unknown>) => String(r.store).toUpperCase() === code) || null;
      const met = (metRows || []).find((r: Record<string, unknown>) => String(r.store).toUpperCase() === code) || null;
      if (fee || met) ebay[code] = { fees: fee, metrics: met };
    }

    // ---- the goal this month is carrying --------------------------------
    // monthly_gp_goals is the record, not the sheet: the goal is entered on
    // SPEEKS and pushed into the workbook from there. The cache only ever knew
    // the month in progress, so every finished month showed a goal bar with
    // nothing to measure against; now a month keeps the goal it was given.
    // The cached figure stays as the fallback for the current month, so nothing
    // regresses on a month whose goals predate this table.
    //
    // From NP_FROM the goal is a Net Profit goal. The cached hub figure is a GP
    // goal (the Sales tab's), so for an NP month it is dropped rather than left
    // as a fallback: a GP number in an NP goal bar would read as a store miles
    // ahead of plan.
    const goalKind = month >= NP_FROM ? "np" : "gp";
    if (goalKind === "np") for (const code of STORES) stores[code].goal = null;
    const { data: goalRows, error: goalErr } = await supabase
      .from(goalKind === "np" ? "monthly_np_goals" : "monthly_gp_goals")
      .select(goalKind === "np" ? "store, np_goal" : "store, gp_goal")
      .eq("ym", month);
    if (goalErr) throw goalErr;
    for (const r of (goalRows || []) as Record<string, unknown>[]) {
      const code = String(r.store || "").toUpperCase();
      if (stores[code]) stores[code].goal = Number(goalKind === "np" ? r.np_goal : r.gp_goal);
    }

    // ---- the same month a year ago -------------------------------------
    // daily_buysell starts at 2026-01, so there is no day-level history to
    // compare a year against. buysell_monthly_history carries the month TOTALS
    // for 2025, lifted from the Sales Summary workbook, which is all a
    // year-over-year line needs. A month with no rows simply comes back empty
    // and the frontend renders nothing — MPL and BAL did not exist in 2025, and
    // inventing a zero for them would read as a collapse rather than as a store
    // that had not opened.
    const prevYm = String(Number(month.slice(0, 4)) - 1) + month.slice(4);
    const { data: pyRows, error: pyErr } = await supabase
      .from("buysell_monthly_history")
      .select("store, sales, cost, gp, resale, paid")
      .eq("ym", prevYm);
    if (pyErr) throw pyErr;

    const prevYearStores: Record<string, Record<string, number | null>> = {};
    for (const r of pyRows || []) {
      const code = String(r.store || "").toUpperCase();
      if (!STORES.includes(code)) continue;
      // null, not 0: a month whose buying was never captured is not a month
      // that bought nothing, and the tile has to be able to tell them apart.
      const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
      prevYearStores[code] = {
        sales: n(r.sales), cost: n(r.cost), gp: n(r.gp),
        resale: n(r.resale), paid: n(r.paid),
      };
    }

    return json({
      month,
      isCurrent,
      prevYear: { ym: prevYm, stores: prevYearStores },
      months,
      daysInMonth,
      source,
      // 'np' from October 2026: the goal is Net Profit and the headline is NP.
      goalKind,
      // How many store-days carry NP. 0 means the month predates the NP tab (or
      // it is the 1st, before the first pass), and the popout says so instead
      // of showing an NP of nothing.
      npDays,
      ebay,
      // Which day the month has reached, so the table can stop at today rather
      // than printing a fortnight of empty rows for days that have not happened.
      today: isCurrent ? Number(today.slice(8, 10)) : null,
      stores,
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
