import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Pulls per-day buying and selling out of the Sales Summary workbook (one tab
// per month) and stores it in public.daily_buysell, so the site can show any
// month the workbook still has rather than only the one in progress.
//
// This is the fix for two separate holes, both caused by the same thing — the
// hub cache only ever carries the CURRENT month:
//
//  1. Every month END was stored as zeros. capture_daily_buysell() writes
//     "days 1..today of today's month", and a month's last day is only in that
//     window while it is still today — but it is not keyed until the following
//     morning, by which time the cache has rolled over. Verified: 2026-07-31 is
//     zero for all five stores, and the sheet's own July totals run about one
//     day higher than the captured sum (OVL 130,482.88 vs 125,430.81).
//  2. Nothing before 2026-07 existed at all.
//
// Running this on a schedule (previous month + current month) closes hole 1
// permanently: once the manager keys the last day, the next run picks it up.
// Running it once with ?all=1 closes hole 2 for as far back as the workbook goes.
//
// ⚠️ Secret-guarded only — no pin path. It writes historical figures that the
// weekly report and the Daily Breakdown both read, and it is only ever called by
// cron or by hand. The secret must never appear in speeks.js.

// The Apps Script web app's /exec URL (buysell-history.gs). Baked in as the
// default with an env override, matching sales-ingest. Empty until the script is
// deployed — the function says so plainly rather than failing on a fetch to "".
const DEFAULT_HISTORY_URL =
  "https://script.google.com/macros/s/AKfycbwtO_YxCtoVkDfJHADDBWMNtXYvZe9j_ggCD6h22h-clPfZG7gjtM5jZbtsaEjT86WH/exec";

// Same shape as unlisted-backlog and sales-ingest: env first, the shared sync
// secret as the fallback so a fresh deploy is not silently unauthorised.
const SECRET = Deno.env.get("SYNC_SECRET") || "sp33ks-sync-k3y-2026-x9mq";

const STORES = new Set(["OVL", "LEE", "WSP", "MPL", "BAL"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const num = (v: unknown) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// The edge runtime is UTC; month boundaries have to be Central or a run in the
// small hours of the 1st would sync the wrong two months.
function centralToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function prevMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, "0")}`;
}

type SheetDay = {
  d: number;
  sales?: number | null;
  cost?: number | null;
  gp?: number | null;
  paid?: number | null;
  resale?: number | null;
  gm?: number | null;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const secret = url.searchParams.get("secret") || "";
  if (!secret || secret !== SECRET) return json({ error: "unauthorized" }, 401);

  const endpoint = Deno.env.get("BUYSELL_HISTORY_URL") || DEFAULT_HISTORY_URL;
  if (!endpoint) {
    return json({
      error: "BUYSELL_HISTORY_URL is not set. Deploy google-apps-scripts/" +
        "buysell-history.gs as a web app and set its /exec URL as a secret.",
    }, 500);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // What to pull. Default is the current month plus the one before it: the
    // second is what makes a month end fill itself in a day or two after the
    // sheet is keyed, without ever re-reading the whole workbook.
    const all = url.searchParams.get("all") === "1";
    const dry = url.searchParams.get("dry") === "1";
    const asked = String(url.searchParams.get("month") || "").trim();
    const today = centralToday();
    const thisMonth = today.slice(0, 7);

    let query: string;
    let wanted: string[] | null;
    if (all) {
      query = "?action=all";
      wanted = null;
    } else if (/^\d{4}-\d{2}$/.test(asked)) {
      query = "?action=month&month=" + encodeURIComponent(asked);
      wanted = [asked];
    } else {
      query = "?action=all";
      wanted = [thisMonth, prevMonth(thisMonth)];
    }

    const res = await fetch(endpoint + query, { redirect: "follow" });
    if (!res.ok) throw new Error("Apps Script HTTP " + res.status);
    const payload = await res.json();
    if (!payload || payload.ok !== true) {
      throw new Error("Apps Script: " + (payload?.error || "unexpected response"));
    }

    const data = (payload.data || {}) as Record<string, Record<string, SheetDay[]>>;
    const months = Object.keys(data).filter((m) => !wanted || wanted.includes(m));

    const rows: Record<string, unknown>[] = [];
    const skipped: string[] = [];
    const totals: Record<string, Record<string, number>> = {};

    for (const ym of months) {
      const [y, mo] = ym.split("-").map(Number);
      const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      // The Buy tabs carry pre-filled "$ -" rows on Sundays that have not
      // happened yet — August was offering days 16, 23 and 30 on the 11th. Those
      // are template, not data, and storing them would record a zero for a day
      // the stores have not traded. The month in progress is therefore cut at
      // today; finished months keep every day.
      const cutoff = ym === thisMonth ? Number(today.slice(8, 10)) : daysInMonth;
      totals[ym] = {};
      for (const [code, days] of Object.entries(data[ym] || {})) {
        if (!STORES.has(code)) { skipped.push(`${ym}/${code}: unknown store`); continue; }
        for (const d of days || []) {
          const day = Number(d?.d);
          // A day number the workbook offered that this month cannot have is a
          // geometry problem, not a value to store. Never clamped or guessed at:
          // one bad row would land on a real date and overwrite a good figure.
          if (!Number.isInteger(day) || day < 1 || day > daysInMonth) {
            skipped.push(`${ym}/${code}: day ${d?.d}`);
            continue;
          }
          if (day > cutoff) continue;   // a day that has not happened yet
          const sales = num(d.sales);
          const gp = num(d.gp);
          const resale = num(d.resale);
          const paid = num(d.paid);
          // Nothing on either side of the day: not a row. Writing zeros here is
          // exactly the bug this function exists to undo.
          if (sales === null && gp === null && resale === null && paid === null) continue;

          // The column names invert here on purpose — see buysell-history.gs.
          // daily_buysell.buy is the RESALE VALUE (the sheet's "Sell"), and the
          // cash paid is carried as a margin against it, which is the shape the
          // hourly capture and every existing reader already use.
          let margin = num(d.gm);
          if (margin === null && resale && paid !== null) margin = (resale - paid) / resale;

          totals[ym][code] = (totals[ym][code] || 0) + (sales ?? 0);

          rows.push({
            date: `${ym}-${String(day).padStart(2, "0")}`,
            store: code,
            buy: resale ?? 0,
            sell: sales ?? 0,
            gp: gp ?? 0,
            buy_margin_pct: margin ?? 0,
          });
        }
      }
    }

    // Last line of defence against a shifted column block: a store whose month
    // sales equal the sum of the other stores' is the TTL column wearing that
    // store's name. This is exactly what the Jan–Mar tabs do, because MPL and
    // BAL had not opened and TTL sat in MPL's future position. Refuse the whole
    // run rather than write it — a tripled store history is very hard to spot
    // once it is in, and re-running after a fix costs nothing.
    for (const [ym, byStore] of Object.entries(totals)) {
      for (const [code, v] of Object.entries(byStore)) {
        if (!v) continue;
        let others = 0;
        for (const [o, ov] of Object.entries(byStore)) if (o !== code) others += ov;
        if (others > 0 && Math.abs(v - others) < 0.02) {
          return json({
            error: `refusing to write: in ${ym}, ${code} equals the sum of the ` +
              `other stores (${v.toFixed(2)}) — that block is the TTL column, not ` +
              `${code}. Redeploy buysell-history.gs with the header-row block ` +
              `detection before importing.`,
          }, 409);
        }
      }
    }

    if (dry) {
      return json({
        ok: true, dryRun: true, monthsWritten: months.sort(),
        wouldWrite: rows.length, totals, skipped: skipped.slice(0, 40),
        sheetWarnings: payload.warnings || [],
      });
    }

    if (!rows.length) {
      return json({ ok: true, months, written: 0, skipped, note: "nothing to write" });
    }

    // Chunked: a whole-workbook pull is thousands of rows and one oversized
    // statement would fail as a unit, leaving it ambiguous how much landed.
    let written = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await supabase
        .from("daily_buysell")
        .upsert(chunk, { onConflict: "date,store" });
      if (error) throw error;
      written += chunk.length;
    }

    return json({
      ok: true,
      monthsAvailable: payload.months || [],
      monthsWritten: months.sort(),
      written,
      skipped: skipped.slice(0, 40),
      sheetWarnings: payload.warnings || [],
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
