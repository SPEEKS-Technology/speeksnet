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
//                                      month on days 1–5 (it is still being
//                                      written until the close on the 1st/2nd)
//            &months=2026-09,2026-10   explicit months (back-fill)
//            &dry=1                    parse and report, write nothing
//
// ⚠️ gviz answers HTTP 200 for a tab that DOES NOT EXIST — it quietly serves the
// workbook's first sheet instead. Every block is therefore checked against the
// month stamp and store code on its own row 2 before a single cell is trusted.
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  if (url.searchParams.get("secret") !== SECRET) return json({ error: "unauthorized" }, 401);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const now = central();
  const dry = url.searchParams.get("dry") === "1";
  const asked = String(url.searchParams.get("months") || "").split(",").map((s) => s.trim())
    .filter((s) => /^\d{4}-\d{2}$/.test(s));
  const months = asked.length ? asked : (now.day <= 5 ? [prevYm(now.ym), now.ym] : [now.ym]);

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
      out.push(report);
    }
    return json({ ok: true, dry, at: new Date().toISOString(), central: now, months: out });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e), months: out }, 500);
  }
});
