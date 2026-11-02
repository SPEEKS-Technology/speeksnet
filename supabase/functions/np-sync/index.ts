import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// np-sync — mirror the workbook's "Net Profit {Mon} {YY}" tab into daily_np.
//
// WHY A MIRROR (2026-10-02). From October the company is graded on Net Profit.
// The tab is the number Paul and Ethan read, it was proven against the P&L
// through September, and Ethan corrects cells on it by hand when the P&L lands.
// So the site reads THE TAB rather than computing NP a second time — a second
// computation could only ever disagree with it. See 0129_daily_np_and_np_goals.
//
// It reads through gviz (the workbook is link-readable), which takes no Apps
// Script lock: nothing here can collide with the 6:05 import / 6:10 NP passes.
//
//   GET|POST ?secret=…                 the current Central month, plus last
//                                      month on days 1–10 (it is still being
//                                      written until the close on the 7th, or
//                                      the 8th/9th when that is a Sunday)
//            &months=2026-09,2026-10   explicit months (back-fill)
//            &dry=1                    parse and report, write nothing
//
// ⚠️ gviz answers HTTP 200 for a tab that DOES NOT EXIST — it quietly serves the
// workbook's first sheet instead. Every block is therefore checked against the
// month stamp and store code on its own row 2 before a single cell is trusted.
//
// A FINISHED MONTH THAT HAS NOT LOCKED (Ethan, 2026-11-02 — see 0162). From the
// 1st to the 10th, last month is diffed against daily_np BEFORE it is
// overwritten, and then the rest of the site is made to follow it:
//   · the Monthly Breakdown's net_profit / ebay_fees rows (and their two %
//     rows), for any store whose month has been started in the Breakdown. The
//     sheet always wins, even over a hand-typed figure — Ethan's call: a wrong
//     sheet gets fixed on the sheet, and this then follows the fix.
//   · a Monthly Net Profit Record that this month holds is re-derived, down as
//     well as up; if the month no longer beats the old record, the old record
//     comes back. A NEW record beaten by a figure that rose is left to
//     records-watch's ratchet the next morning, so its congratulations email
//     still goes out.
//   · every change goes to np_month_changes and out in ONE email per batch
//     (any change at all, not the in-month alert's $150).
// Daily_np itself needs nothing more: every page reading it already follows.
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SECRET = Deno.env.get("SYNC_SECRET") || "sp33ks-sync-k3y-2026-x9mq";
const SHEET_ID = Deno.env.get("NP_SHEET_ID") || "1i_oV37lZXq8s91f9ymzwQlrM8WY2UlQQQ0qsRP3xLJ8";

// Block layout, from netprofit-sheet.gs: six blocks 18 columns apart, the sixth
// (TTL) pure formulas and never mirrored — the site sums the five itself.
const BLOCKS: Record<string, number> = { OVL: 0, LEE: 18, WSP: 36, MPL: 54, BAL: 72 };
const OFF = { day: 0, sales: 1, cost: 4, gp: 5, ebay: 9, ship: 10, cc: 11, np: 12, goal: 4 };
const FULL = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function tabName(ym: string) {
  return `Net Profit ${MON[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
}

// The edge runtime is UTC; every date here is a Central one.
function central() {
  const now = new Date();
  const d = now.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const h = Number(now.toLocaleString("en-US", { timeZone: "America/Chicago", hour: "2-digit", hour12: false }));
  return { date: d, ym: d.slice(0, 7), day: Number(d.slice(8, 10)), hour: h % 24 };
}
function prevYm(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
// Never ym + "-31": Postgres rejects 2026-09-31 outright.
function nextMonthStart(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}
function addDays(iso: string, n: number) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Last month is still being written until its close (the 7th, slipping past a
// Sunday to the 8th or 9th at the latest). Days 1–10 cover that with the close
// night's 7pm write and a day to spare.
const OPEN_THROUGH_DAY = 10;

const STORES = Object.keys(BLOCKS);
const NP_RECORD = "Monthly Net Profit Record";
const ALERT_FALLBACK = ["ethan.kushnir@speekstechnology.com"];
const GMAIL_RELAY = Deno.env.get("GMAIL_RELAY_URL") ||
  "https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec";
// One email per batch: a pass writes the tab over ~5 minutes and a 15-minute
// sync can land mid-write, so the mail waits for a sync that finds nothing new.
const SETTLE_MS = 14 * 60 * 1000;

const r2 = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number | null | undefined) => n === null || n === undefined ? "—"
  : (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const lastDayOf = (ym: string) => addDays(nextMonthStart(ym), -1);
const monthText = (ym: string) => `${FULL[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// The columns a store-day is compared on, with the label the email shows.
const DIFF_COLS: [keyof Row, string][] = [
  ["np", "Net Profit"], ["sales", "Sales"], ["cost", "Cost"], ["ebay_fee", "eBay Fee"],
  ["shipping_cost", "Shipping"], ["cc_fee", "Credit Card Fee"],
];
const differs = (a: unknown, b: unknown) => {
  const x = a === null || a === undefined ? null : Number(a);
  const y = b === null || b === undefined ? null : Number(b);
  if (x === null || y === null) return x !== y;
  return Math.abs(x - y) >= 0.005;
};

type Change = {
  ym: string; store: string; kind: "day" | "total" | "brief" | "record"; what: string;
  day?: string | null; was?: number | null; now?: number | null; was_text?: string | null; now_text?: string | null;
};

type Cell = { v?: unknown; f?: string } | null;

async function gviz(ym: string, range: string): Promise<Cell[][]> {
  const u = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&headers=0` +
    `&sheet=${encodeURIComponent(tabName(ym))}&range=${range}`;
  const res = await fetch(u);
  const t = await res.text();
  if (!res.ok) throw new Error(`gviz HTTP ${res.status}`);
  const j = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
  if (j.status === "error") throw new Error("gviz: " + JSON.stringify(j.errors || []).slice(0, 200));
  return (j.table?.rows || []).map((r: { c: Cell[] }) => r.c || []);
}

// A number or null. An =NA() cell (the collector's "eBay pass failed") and a
// blank cell both come back without a number, and both are NULL here — never
// a zero, which would read as "no fees" rather than "not known".
//
// ⚠️ gviz types each COLUMN by majority. Early in a month most of a column is
// blank text, so the whole column turns "string" and the money arrives only as
// its formatted text (" $ 7,464.77 ", accounting " $ - " for zero, "(12.00)"
// for negative). Late in the month the same column is "number". Both are read.
function num(c: Cell): number | null {
  const v = c?.v;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  if (typeof v !== "string") return null;
  let t = v.trim();
  if (!t || t.startsWith("#")) return null;
  if (t.endsWith("%")) return null;
  const neg = /^\(.*\)$/.test(t) || /^-\s*\$/.test(t) || /^\$\s*\(/.test(t) || /^\$\s*-\s*\d/.test(t);
  t = t.replace(/[()$,\s]/g, "");
  if (t === "-") return 0;
  t = t.replace(/^-/, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Math.round(Number(t) * 100) / 100;
  return neg ? -n : n;
}

type Row = {
  date: string; store: string; sales: number | null; cost: number | null; gp: number | null;
  ebay_fee: number | null; shipping_cost: number | null; cc_fee: number | null;
  royalty: number | null; np: number | null; shipping_final: boolean; source_tab: string; synced_at: string;
};

async function readMonth(ym: string, now: ReturnType<typeof central>) {
  // Row 2 alone, so its strings survive: gviz types each column by majority,
  // and in the full grid every column is "number", which nulls the labels.
  const head = (await gviz(ym, "A2:DF2"))[0] || [];
  const [y, m] = ym.split("-").map(Number);
  // A date cell reads Date(y,m0,1) when the row types as dates, or its display
  // text ("October 2026") when it types as text. Either names the month.
  const stamps = [`Date(${y},${m - 1},1)`, `${FULL[m - 1]} ${y}`];
  const bad: string[] = [];
  for (const [code, b] of Object.entries(BLOCKS)) {
    const s = head[b + 1]?.v, c = head[b + 2]?.v;
    if (!stamps.includes(String(s)) || String(c).trim() !== code) bad.push(`${code}: found ${String(s)} / ${String(c)}`);
  }
  if (bad.length) {
    return { ym, tab: tabName(ym), ok: false, error: "tab missing or layout moved — " + bad.join("; "), rows: [] as Row[], goals: {} };
  }

  const grid = await gviz(ym, "A1:DF45");
  const yesterday = addDays(now.date, -1);
  const rows: Row[] = [];
  const goals: Record<string, number> = {};
  const stampAt = new Date().toISOString();
  const lastDay = new Date(y, m, 0).getDate();

  for (const [code, b] of Object.entries(BLOCKS)) {
    const g = num(head[b + OFF.goal]);
    if (g !== null && g > 0) goals[code] = g;
    const seen = new Set<number>();
    for (const r of grid) {
      // Rows are found by their Day number, never by position: gviz drops the
      // all-text header row, so positions shift by one between reads.
      const d = num(r[b + OFF.day]);
      if (d === null || !Number.isInteger(d) || d < 1 || d > lastDay || seen.has(d)) continue;
      seen.add(d);
      const sales = num(r[b + OFF.sales]);
      // A day the pass has not written has no Sales. Its GP Total / NP Total
      // columns still carry the running figure down, so those are not a test.
      if (sales === null) continue;
      const date = `${ym}-${String(d).padStart(2, "0")}`;
      const gp = num(r[b + OFF.gp]), ebay = num(r[b + OFF.ebay]);
      const ship = num(r[b + OFF.ship]), cc = num(r[b + OFF.cc]), np = num(r[b + OFF.np]);
      const royalty = gp !== null && np !== null
        ? Math.round((gp - (ebay ?? 0) - (ship ?? 0) - (cc ?? 0) - np) * 100) / 100
        : null;
      // Shipping for a day lands on the 2:05pm pass the NEXT day. Before that the
      // cell is blank (NULL) — or, for yesterday before 2pm, not yet final.
      const shipFinal = ship !== null && !(date === yesterday && now.hour < 14) && date < now.date;
      rows.push({
        date, store: code, sales, cost: num(r[b + OFF.cost]), gp, ebay_fee: ebay,
        shipping_cost: ship, cc_fee: cc, royalty, np, shipping_final: shipFinal,
        source_tab: tabName(ym), synced_at: stampAt,
      });
    }
  }
  return { ym, tab: tabName(ym), ok: true, rows, goals };
}

// --- the finished month: what moved, and the site following it -------------

// The tab against what daily_np held before this sync. Whole days appearing or
// going are reported too: on the 1st the last day arrives, and a day the tab
// clears is as much a change as one that moves.
// deno-lint-ignore no-explicit-any
function diffMonth(ym: string, before: any[], rows: Row[]): Change[] {
  const out: Change[] = [];
  const old = new Map(before.map((b) => [`${b.store}|${b.date}`, b]));
  const seen = new Set<string>();
  const tot: Record<string, { was: number; now: number; moved: boolean }> = {};
  const t = (s: string) => tot[s] ||= { was: 0, now: 0, moved: false };
  for (const b of before) t(b.store).was += Number(b.np) || 0;
  for (const r of rows) {
    const k = `${r.store}|${r.date}`;
    seen.add(k);
    t(r.store).now += r.np || 0;
    const o = old.get(k);
    if (!o) {
      out.push({ ym, store: r.store, kind: "day", what: "added", day: r.date, was: null, now: r.np });
      t(r.store).moved = true;
      continue;
    }
    for (const [col, label] of DIFF_COLS) {
      if (!differs(o[col], r[col])) continue;
      out.push({ ym, store: r.store, kind: "day", what: label, day: r.date,
        was: o[col] === null ? null : Number(o[col]), now: r[col] as number | null });
      t(r.store).moved = true;
    }
  }
  for (const b of before) {
    if (seen.has(`${b.store}|${b.date}`)) continue;
    out.push({ ym, store: b.store, kind: "day", what: "removed", day: b.date, was: b.np === null ? null : Number(b.np), now: null });
    t(b.store).moved = true;
  }
  for (const [s, v] of Object.entries(tot)) {
    if (v.moved && differs(r2(v.was), r2(v.now))) {
      out.push({ ym, store: s, kind: "total", what: "Net Profit", was: r2(v.was), now: r2(v.now) });
    }
  }
  return out;
}

// The Monthly Breakdown's NP rows follow the tab — only for a store whose month
// has been started in the Breakdown ("where we have reported that"), so this
// never creates a half-filled month on its own. A total with an unknown day in
// it (an =NA() eBay cell, a refused collector) is not written: half a month
// would read as fact.
// deno-lint-ignore no-explicit-any
async function followBrief(sb: any, ym: string, rows: Row[]): Promise<Change[]> {
  const pe = lastDayOf(ym);
  const { data, error } = await sb.from("monthly_brief").select("store, metric_key, value").eq("period_end_date", pe);
  if (error) throw new Error("monthly_brief read: " + error.message);
  const have: Record<string, Record<string, number | null>> = {};
  for (const b of data || []) (have[b.store] ||= {})[b.metric_key] = b.value === null ? null : Number(b.value);
  const out: Change[] = [];
  const write: unknown[] = [];
  const at = new Date().toISOString();
  for (const s of STORES) {
    const mine = rows.filter((r) => r.store === s);
    if (!have[s] || !mine.length) continue;
    const ns = have[s].net_sales;
    const want: Record<string, number> = {};
    if (mine.every((r) => r.np !== null)) want.net_profit = r2(mine.reduce((a, r) => a + (r.np || 0), 0));
    if (mine.every((r) => r.ebay_fee !== null)) want.ebay_fees = r2(mine.reduce((a, r) => a + (r.ebay_fee || 0), 0));
    // The same formulas as _MB_DERIVED in speeks.js, so a follow and a save in
    // the editor agree to the cent.
    if (want.net_profit !== undefined && ns && ns > 0) want.net_profit_pct = r2(want.net_profit / ns * 100);
    if (want.ebay_fees !== undefined && ns && ns > 0) want.ebay_fee_pct_sales = r2(want.ebay_fees / ns * 100);
    for (const [k, v] of Object.entries(want)) {
      const cur = have[s][k];
      if (cur !== undefined && !differs(cur, v)) continue;
      write.push({ store: s, period_end_date: pe, month: Number(ym.slice(5, 7)), year: Number(ym.slice(0, 4)),
        metric_key: k, value: v, updated_by: "Net Profit tab", updated_at: at });
      out.push({ ym, store: s, kind: "brief", what: k, was: cur ?? null, now: v });
    }
  }
  if (write.length) {
    const { error: e2 } = await sb.from("monthly_brief").upsert(write, { onConflict: "store,period_end_date,metric_key" });
    if (e2) throw new Error("monthly_brief write: " + e2.message);
  }
  return out;
}

// A Net Profit record THIS month holds is re-derived from the Breakdown, the
// same way records-watch picks one (largest positive; a tie goes to the earlier
// month; 2026 onward; the company only for months all five stores have).
// Down as well as up: a record set on a figure that fell is corrected, and if
// the month no longer beats the old one, the old one comes back.
// deno-lint-ignore no-explicit-any
async function fixRecords(sb: any, ym: string): Promise<Change[]> {
  const mo = `${ym}-01`, when = monthText(ym);
  const [recRes, npRes] = await Promise.all([
    sb.from("records").select("id, store, value, period, value_num, record_on").eq("label", NP_RECORD).is("person", null),
    sb.from("monthly_brief").select("store, year, month, value").eq("metric_key", "net_profit").gte("year", 2026),
  ]);
  if (recRes.error) throw new Error("records read: " + recRes.error.message);
  if (npRes.error) throw new Error("net_profit read: " + npRes.error.message);
  const byMo: Record<string, Record<string, number>> = {};
  for (const r of npRes.data || []) {
    if (r.value === null || !STORES.includes(r.store)) continue;
    (byMo[`${r.year}-${String(r.month).padStart(2, "0")}-01`] ||= {})[r.store] = Number(r.value);
  }
  const bestOf = (val: (m: Record<string, number>) => number | null) => {
    let top: { mo: string; v: number } | null = null;
    for (const m of Object.keys(byMo).sort()) {
      const v = val(byMo[m]);
      if (v === null || !(v > 0)) continue;
      if (!top || v > top.v) top = { mo: m, v };
    }
    return top;
  };
  const out: Change[] = [];
  for (const rec of recRes.data || []) {
    const held = String(rec.record_on || "") === mo || String(rec.period || "").trim().toLowerCase() === when.toLowerCase();
    if (!held) continue;
    const top = rec.store === "Company"
      ? bestOf((m) => STORES.every((s) => s in m) ? r2(STORES.reduce((a, s) => a + m[s], 0)) : null)
      : STORES.includes(rec.store) ? bestOf((m) => rec.store in m ? m[rec.store] : null) : null;
    if (!top) continue;
    const text = usd0(top.v), period = monthText(top.mo.slice(0, 7));
    if (!differs(rec.value_num, top.v) && String(rec.record_on || "") === top.mo) continue;
    const was = rec.value_num === null ? null : Number(rec.value_num), wasText = `${rec.value} (${rec.period})`;
    const { error } = await sb.from("records").update({
      value: text, period, value_num: top.v, record_on: top.mo, updated_at: new Date().toISOString(),
    }).eq("id", rec.id);
    if (error) throw new Error(`records ${rec.store}: ${error.message}`);
    out.push({ ym, store: rec.store, kind: "record", what: NP_RECORD, was, now: top.v,
      was_text: wasText, now_text: `${text} (${period})` });
  }
  return out;
}

async function relay(to: string[], subject: string, html: string): Promise<string> {
  // redirect: 'manual' — the relay answers doPost with a 302 to an echo URL that
  // can 404 AFTER the mail went. A 3xx is a send; following it is how a
  // delivered mail gets reported as failed and then sent twice.
  const res = await fetch(GMAIL_RELAY, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ secret: SECRET, to: to.join(","), subject, html }),
  });
  if (res.status >= 300 && res.status < 400) return `sent (${res.status})`;
  const text = await res.text();
  if (!res.ok) throw new Error(`relay ${res.status}: ${text.slice(0, 200)}`);
  return text.slice(0, 200);
}

const BRIEF_LABEL: Record<string, string> = {
  net_profit: "Net Profit", ebay_fees: "eBay Fees", net_profit_pct: "Net Profit %", ebay_fee_pct_sales: "eBay Fees % of Sales",
};

// deno-lint-ignore no-explicit-any
function buildChangesEmail(rows: any[]): { subject: string; html: string } {
  const months = [...new Set(rows.map((r) => String(r.ym)))].sort();
  const td = "padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;";
  const th = "padding:6px 10px;border-bottom:2px solid #d1d5db;font-size:12px;text-align:left;color:#6b7280;";
  const num = (v: unknown) => v === null || v === undefined ? null : Number(v);
  const delta = (was: number | null, now: number | null) => {
    if (was === null || now === null) return "";
    const d = r2(now - was);
    return `<span style="color:${d < 0 ? "#b91c1c" : "#047857"};font-weight:600;">${d < 0 ? "−" : "+"}${usd(Math.abs(d))}</span>`;
  };
  const fmtBrief = (k: string, v: number | null) => v === null ? "blank" : (k.endsWith("_pct") || k.endsWith("_sales") ? v.toFixed(2) + "%" : usd(v));
  let html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:720px;">`;
  const subj: string[] = [];
  for (const ym of months) {
    // deno-lint-ignore no-explicit-any
    const mine = rows.filter((r: any) => r.ym === ym);
    // A store's total across the batch: its first "was" and its last "now".
    const totals: Record<string, { was: number; now: number }> = {};
    for (const r of mine.filter((r) => r.kind === "total")) {
      const t = totals[r.store] ||= { was: Number(r.was), now: Number(r.now) };
      t.now = Number(r.now);
    }
    const tStores = STORES.filter((s) => totals[s]);
    if (tStores.length) {
      subj.push(tStores.map((s) => {
        const d = r2(totals[s].now - totals[s].was);
        return `${s} ${d < 0 ? "−" : "+"}${usd0(Math.abs(d))}`;
      }).join(", "));
    }
    html += `<h2 style="font-size:18px;margin:18px 0 4px;">Net Profit — ${monthText(ym)} Changed</h2>`
      + `<p style="font-size:13px;color:#4b5563;margin:0 0 10px;">${monthText(ym)} is finished but not locked yet, so its figures can still move. `
      + `It locks at 7pm on the 7th (the next open day if that is a Sunday). Everything below is already updated on SPEEKSNET.</p>`;
    if (tStores.length) {
      html += `<table style="border-collapse:collapse;width:100%;margin-bottom:12px;"><tr><th style="${th}">Store</th><th style="${th}">Month Net Profit Was</th><th style="${th}">Now</th><th style="${th}text-align:right;">Change</th></tr>`;
      for (const s of tStores) {
        html += `<tr><td style="${td}font-weight:600;">${s}</td><td style="${td}">${usd(totals[s].was)}</td><td style="${td}">${usd(totals[s].now)}</td><td style="${td}text-align:right;">${delta(totals[s].was, totals[s].now)}</td></tr>`;
      }
      html += `</table>`;
    }
    const site = mine.filter((r) => r.kind === "brief" || r.kind === "record");
    if (site.length) {
      html += `<h3 style="font-size:14px;margin:14px 0 4px;">Corrected On The Site</h3><table style="border-collapse:collapse;width:100%;margin-bottom:12px;">`
        + `<tr><th style="${th}">Store</th><th style="${th}">Where</th><th style="${th}">Was</th><th style="${th}">Now</th></tr>`;
      for (const r of site) {
        const where = r.kind === "brief" ? `Monthly Breakdown · ${BRIEF_LABEL[r.what] || r.what}` : "Records · Monthly Net Profit Record";
        const was = r.kind === "brief" ? fmtBrief(r.what, num(r.was)) : esc(String(r.was_text || "—"));
        const now = r.kind === "brief" ? fmtBrief(r.what, num(r.now)) : esc(String(r.now_text || "—"));
        html += `<tr><td style="${td}font-weight:600;">${esc(r.store)}</td><td style="${td}">${where}</td><td style="${td}">${was}</td><td style="${td}">${now}</td></tr>`;
      }
      html += `</table>`;
    }
    const days = mine.filter((r) => r.kind === "day")
      .sort((a, b) => STORES.indexOf(a.store) - STORES.indexOf(b.store) || String(a.day).localeCompare(String(b.day)) || a.id - b.id);
    if (days.length) {
      html += `<h3 style="font-size:14px;margin:14px 0 4px;">What Moved On The Net Profit Tab</h3><table style="border-collapse:collapse;width:100%;">`
        + `<tr><th style="${th}">Store</th><th style="${th}">Day</th><th style="${th}">Column</th><th style="${th}">Was</th><th style="${th}">Now</th><th style="${th}text-align:right;">Change</th></tr>`;
      for (const r of days) {
        const what = r.what === "added" ? "Day Added (Net Profit)" : r.what === "removed" ? "Day Cleared (Net Profit)" : r.what;
        const was = num(r.was), now = num(r.now);
        html += `<tr><td style="${td}">${esc(r.store)}</td><td style="${td}">${String(r.day).slice(5)}</td><td style="${td}">${esc(what)}</td>`
          + `<td style="${td}">${usd(was)}</td><td style="${td}">${usd(now)}</td><td style="${td}text-align:right;">${delta(was, now)}</td></tr>`;
      }
      html += `</table>`;
    }
  }
  html += `<p style="font-size:12px;color:#6b7280;margin-top:16px;">Anything already sent out with the old figure (an announcement, an email, a message) still says it. Those are the only places this cannot correct.</p></div>`;
  const subject = `Net Profit ${months.map(monthText).join(", ")} changed` + (subj.length ? ` — ${subj.join("; ")}` : "");
  return { subject, html };
}

// One email for everything pending, once the batch has settled (SETTLE_MS). A
// failed send leaves the rows pending and the next sync tries again.
// deno-lint-ignore no-explicit-any
async function sendPending(sb: any, foundNew: boolean, to: string[] | null): Promise<unknown> {
  if (foundNew && !to) return "waiting — this sync found changes; mails once a sync finds none";
  const { data, error } = await sb.from("np_month_changes").select("*").is("emailed_at", null).order("id").limit(1000);
  if (error) return "read failed: " + error.message;
  if (!data?.length) return "nothing pending";
  // deno-lint-ignore no-explicit-any
  const newest = Math.max(...data.map((r: any) => Date.parse(r.seen_at)));
  if (!to && Date.now() - newest < SETTLE_MS) return "waiting — newest change is under 14 minutes old";
  const { data: recips } = await sb.from("email_recipients").select("email").eq("list_key", "np_month_changes");
  // deno-lint-ignore no-explicit-any
  const listed = [...new Set((recips || []).map((r: any) => String(r.email).toLowerCase()))] as string[];
  const list = to || (listed.length ? listed : ALERT_FALLBACK);
  const { subject, html } = buildChangesEmail(data);
  try {
    const r = await relay(list, subject, html);
    if (!to) {
      // deno-lint-ignore no-explicit-any
      const ids = data.map((x: any) => x.id);
      const { error: ue } = await sb.from("np_month_changes").update({ emailed_at: new Date().toISOString(), relay: r }).in("id", ids);
      if (ue) return { sent: data.length, to: list, relay: r, markError: ue.message };
    }
    return { sent: data.length, to: list, relay: r, subject };
  } catch (e) {
    return { error: String((e as Error)?.message || e), to: list };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  if (url.searchParams.get("secret") !== SECRET) return json({ error: "unauthorized" }, 401);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const now = central();
  const dry = url.searchParams.get("dry") === "1";
  const asked = String(url.searchParams.get("months") || "").split(",").map((s) => s.trim())
    .filter((s) => /^\d{4}-\d{2}$/.test(s));
  const months = asked.length ? asked : (now.day <= OPEN_THROUGH_DAY ? [prevYm(now.ym), now.ym] : [now.ym]);
  // The one month whose changes are tracked and followed: last month, while it
  // can still move. A back-fill of anything older only mirrors.
  const openYm = now.day <= OPEN_THROUGH_DAY ? prevYm(now.ym) : null;
  // ?mailto=a@b sends whatever is pending there now, without marking it sent.
  const mailto = String(url.searchParams.get("mailto") || "").split(",").map((s) => s.trim()).filter(Boolean);
  let foundNew = false;

  const out: unknown[] = [];
  try {
    for (const ym of months) {
      const got = await readMonth(ym, now);
      const report: Record<string, unknown> = { ym, tab: got.tab, ok: got.ok, days: got.rows.length };
      if (!got.ok) { report.error = got.error; out.push(report); continue; }

      // Totals per store, so a run's response can be held against the tab's own
      // month row by eye.
      const tot: Record<string, { sales: number; gp: number; np: number; days: number }> = {};
      for (const r of got.rows) {
        const t = tot[r.store] ||= { sales: 0, gp: 0, np: 0, days: 0 };
        t.sales += r.sales || 0; t.gp += r.gp || 0; t.np += r.np || 0; t.days++;
      }
      for (const t of Object.values(tot)) {
        t.sales = Math.round(t.sales * 100) / 100; t.gp = Math.round(t.gp * 100) / 100; t.np = Math.round(t.np * 100) / 100;
      }
      report.totals = tot;
      report.provisionalShipping = got.rows.filter((r) => !r.shipping_final).map((r) => `${r.store} ${r.date}`);

      // Goals: the site is where a goal is decided (gp-goals). A goal typed
      // straight onto the tab is adopted only where the site has none — so
      // September's, typed on the tab before this existed, came across — and a
      // disagreement is REPORTED, never settled here.
      const { data: have } = await supabase.from("monthly_np_goals").select("store, np_goal").eq("ym", ym);
      const site = Object.fromEntries((have || []).map((g) => [g.store, Number(g.np_goal)]));
      const adopt = Object.entries(got.goals).filter(([s]) => !(s in site))
        .map(([store, np_goal]) => ({ store, ym, np_goal, set_by: "sheet" }));
      // A goal set on the site that never reached the tab counts too: that is the
      // usual failure (month-rollover.gs pasted but not published as a new
      // version, 2026-10-02), and "sheet blank" is not agreement.
      report.goalMismatch = Object.entries(site)
        .filter(([s, v]) => !(s in got.goals) || Math.abs(got.goals[s] - v) > 0.5)
        .map(([s, v]) => `${s}: site ${v} / sheet ${s in got.goals ? got.goals[s] : "blank"}`);

      // SELF-HEAL. gp-goals pushes a goal to the tab once, on save; if that push
      // fails (an unpublished month-rollover.gs, a Google blip) the tab stays
      // blank and nothing retries. So a mismatch is re-pushed here, through the
      // same month-rollover `goals` action, and the script's own answer is put in
      // the report — which is the only way to see WHY a write did not land.
      if (report.goalMismatch.length && Object.keys(site).length && (!dry || url.searchParams.get("push") === "1")) {
        const ru = Deno.env.get("MONTH_ROLLOVER_URL");
        if (!ru) report.goalPush = "MONTH_ROLLOVER_URL not set";
        else {
          try {
            const res = await fetch(ru, {
              method: "POST", headers: { "Content-Type": "application/json" }, redirect: "follow",
              body: JSON.stringify({ action: "goals", secret: SECRET, month: ym, goals: {}, npGoals: site, buyDays: null }),
            });
            report.goalPush = `HTTP ${res.status} ` + (await res.text()).slice(0, 600);
          } catch (e) {
            report.goalPush = "failed: " + String((e as Error)?.message || e);
          }
        }
      }

      // Before the overwrite: what daily_np holds now, to diff the tab against.
      // deno-lint-ignore no-explicit-any
      let before: any[] | null = null;
      if (ym === openYm) {
        const { data: b, error: be } = await supabase.from("daily_np")
          .select("date, store, sales, cost, ebay_fee, shipping_cost, cc_fee, np")
          .gte("date", `${ym}-01`).lt("date", nextMonthStart(ym));
        if (be) throw be;
        before = b || [];
        report.changes = diffMonth(ym, before, got.rows).length;
      }

      if (!dry) {
        if (got.rows.length) {
          const { error } = await supabase.from("daily_np").upsert(got.rows, { onConflict: "date,store" });
          if (error) throw error;
        }
        // The tab clears a day the collector can no longer stand behind (today,
        // and anything it refuses to write). The mirror follows it: a row that
        // the tab no longer has is removed, so the two never disagree on a day.
        const keep = new Set(got.rows.map((r) => `${r.store}|${r.date}`));
        const { data: existing } = await supabase.from("daily_np").select("date, store")
          .gte("date", `${ym}-01`).lt("date", nextMonthStart(ym));
        const drop = (existing || []).filter((e) => !keep.has(`${e.store}|${e.date}`));
        for (const e of drop) {
          await supabase.from("daily_np").delete().eq("date", e.date).eq("store", e.store);
        }
        report.removed = drop.length;
        if (adopt.length) {
          const { error } = await supabase.from("monthly_np_goals").upsert(adopt, { onConflict: "store,ym" });
          if (error) throw error;
        }
      }
      report.goalsAdopted = adopt.map((g) => g.store);

      // The finished month: log what moved, then make the site follow it. Each
      // step in its own try, so a Breakdown or records failure is reported and
      // never undoes the mirror that already landed.
      if (!dry && before) {
        const changes = diffMonth(ym, before, got.rows);
        try {
          const brief = await followBrief(supabase, ym, got.rows);
          changes.push(...brief);
          if (brief.some((c) => c.what === "net_profit")) changes.push(...await fixRecords(supabase, ym));
        } catch (e) {
          report.followError = String((e as Error)?.message || e);
        }
        if (changes.length) {
          const { error } = await supabase.from("np_month_changes").insert(changes);
          if (error) report.logError = error.message;
          else foundNew = true;
        }
        report.logged = changes.length;
      }
      out.push(report);
    }
    const mail = dry && !mailto.length ? "dry run" : await sendPending(supabase, foundNew, mailto.length ? mailto : null);
    return json({ ok: true, dry, at: new Date().toISOString(), central: now, months: out, mail });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e), months: out }, 500);
  }
});
