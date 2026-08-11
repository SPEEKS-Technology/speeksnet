import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// UNLISTED BACKLOG — Monday 9:00am Central, covering the week that just ended.
//
// One question: how long until each store's unlisted pile reaches zero?
//
// Everything here is measured, not modelled. The pile comes from the weekly
// sales summary; how fast it moves is the difference between two readings of it;
// what a store lists is the 4-week running average off the Weekly KPI. Only
// INTAKE is derived, and deliberately so:
//
//     taking in = 4-week average listed + weekly pile growth
//
// Deriving it that way means the arithmetic can never disagree with the measured
// pile — which matters, because the KPI device count DOES disagree with it (BAL's
// pile grew 20 in a week the device count said should shrink 8). Whatever that
// discrepancy turns out to be, this report is insulated from it.
//
// Verdicts are measured against each store's own BEST ACTUAL WEEK, not against
// the modelled capacity ceiling. Stores beat that ceiling in 7 of 30 store-weeks
// over the calibration window, so "impossible, over capacity" was a claim the
// numbers could not support. "You have done this once; the task is doing it every
// week" is one they can.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };

const SECRET = Deno.env.get("SYNC_SECRET") || "sp33ks-sync-k3y-2026-x9mq";
const GMAIL_RELAY = Deno.env.get("GMAIL_RELAY_URL") ||
  "https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec";

const TO_DEFAULT = ["ethan.kushnir@speekstechnology.com"];
const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];
const SEND_HOUR_CENTRAL = 9;   // the pg_cron pair covers CDT and CST; this picks the right one
const AVG_WEEKS = 4;           // the running average the site already shows
const BEST_WEEKS = 6;          // how far back "best week" looks
const MIN_READING_GAP_DAYS = 5; // two pile readings closer than this are the same week re-ingested

type Row = Record<string, any>;
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const r0 = (x: number) => Math.round(x);
const money = (x: number) => x.toLocaleString("en-US");

function centralNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
}
// The Sunday that just finished, in Central. Monday's report is about last week.
function lastSundayCentral(): Date {
  const d = centralNow();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 1); // back to the previous Sunday
  d.setHours(0, 0, 0, 0);
  return d;
}
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const fmtMD = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// gather
// ---------------------------------------------------------------------------
async function gather(sb: any, weekEnd: Date) {
  const weekStart = new Date(weekEnd); weekStart.setDate(weekStart.getDate() - 6);
  const weekEndStr = ymd(weekEnd);
  const weekStartStr = ymd(weekStart);

  // --- the pile, and how fast it is moving --------------------------------
  // Ordered by synced_at, NOT week_label: the labels mix two conventions
  // ("August 2-8" vs "August wk1") and at least one pair is duplicated, so they
  // cannot be sorted or joined on. synced_at is a real timestamp.
  const { data: sales } = await sb.from("store_weekly_sales")
    .select("store, week_label, inventory_line_items, synced_at")
    .in("store", STORES)
    .order("synced_at", { ascending: false })
    .limit(200);

  const batches: string[] = [];
  for (const row of (sales || [])) {
    if (!batches.includes(row.synced_at)) batches.push(row.synced_at);
  }
  // The previous reading has to be a different WEEK, not just a different sync.
  // The same week gets re-ingested under a second label ("August 2-8" and
  // "August wk1" landed seven hours apart on Aug 10 with identical counts), and
  // taking batches[1] blindly compared a week against itself — every store came
  // out at exactly 0 change, which is how this was caught.
  const latestAt = batches[0] || null;
  let priorAt: string | null = null;
  if (latestAt) {
    const lt = new Date(latestAt).getTime();
    priorAt = batches.find((b) =>
      (lt - new Date(b).getTime()) / 86400000 >= MIN_READING_GAP_DAYS) || null;
  }
  const pileAt = (stamp: string | null, store: string) => {
    if (!stamp) return null;
    const hit = (sales || []).find((x: Row) => x.synced_at === stamp && x.store === store);
    return hit ? n(hit.inventory_line_items) : null;
  };
  // Real elapsed weeks between the two readings — the gap is not always 7 days
  // (the week of Jul 27 is missing entirely), and dividing by a assumed 1 would
  // overstate the growth rate.
  let weeksBetween = 1;
  if (latestAt && priorAt) {
    const days = (new Date(latestAt).getTime() - new Date(priorAt).getTime()) / 86400000;
    if (days > 0) weeksBetween = days / 7;
  }

  // --- listed, per store per week (Weekly KPI) -----------------------------
  const histStart = new Date(weekEnd);
  histStart.setDate(histStart.getDate() - BEST_WEEKS * 7 + 1);
  const { data: kpi } = await sb.from("kpi_entries")
    .select("store, period_end_date, listed_count")
    .eq("period_type", "weekly")
    .gte("period_end_date", ymd(histStart))
    .lte("period_end_date", weekEndStr);

  const listedByWeek: Record<string, Record<string, number>> = {};
  for (const row of (kpi || [])) {
    const s = String(row.store || "").toUpperCase();
    const w = String(row.period_end_date);
    (listedByWeek[s] = listedByWeek[s] || {});
    listedByWeek[s][w] = (listedByWeek[s][w] || 0) + n(row.listed_count);
  }

  // --- the goal that was in force for the week just ended ------------------
  const { data: goals } = await sb.from("listing_goal_weeks")
    .select("store, week_start, target")
    .eq("week_start", weekStartStr);
  const goalFor: Record<string, number | null> = {};
  for (const g of (goals || [])) goalFor[String(g.store).toUpperCase()] = n(g.target);

  const rows = STORES.map((store) => {
    const weeks = listedByWeek[store] || {};
    const ordered = Object.keys(weeks).sort();                    // oldest → newest
    const totals = ordered.map((w) => weeks[w]);
    const lastWeekListed = weeks[weekEndStr] ?? null;
    const recent = totals.slice(-AVG_WEEKS);
    const avgListed = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
    const bestWeek = totals.length ? Math.max(...totals) : 0;

    const pile = pileAt(latestAt, store);
    const prior = pileAt(priorAt, store);
    const changePerWeek = (pile != null && prior != null) ? (pile - prior) / weeksBetween : null;

    // Derived so it always reconciles with the measured pile (see the header).
    const intake = changePerWeek == null ? null : avgListed + changePerWeek;
    // The weekly listing rate that would hold the pile flat.
    const breakEven = intake;
    const gap = (breakEven == null || !bestWeek) ? null : (breakEven - bestWeek) / bestWeek * 100;

    return {
      store, pile, prior, changePerWeek, avgListed, bestWeek, breakEven, gap,
      lastWeekListed, goal: goalFor[store] ?? null,
    };
  });

  const totalPile = rows.reduce((a, x) => a + (x.pile ?? 0), 0);
  const totalChange = rows.reduce((a, x) => a + (x.changePerWeek ?? 0), 0);

  return {
    weekStart, weekEnd, rows, totalPile, totalChange,
    latestAt, priorAt, weeksBetween,
    readings: batches.filter((b, i) => i === 0 || (new Date(batches[i - 1]).getTime() - new Date(b).getTime()) / 86400000 >= MIN_READING_GAP_DAYS).length,
  };
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
const C = {
  ink: "#17201b", soft: "#4a574f", faint: "#7b8880", rule: "#dbe2dc", ruleSoft: "#e9eeea",
  emerald: "#2f5a44", sage: "#4d8c6a", sageWash: "#eaf2ec",
  bad: "#a83b26", badBg: "#fbeae6", warn: "#8a6410", warnBg: "#fbf3df", good: "#1c6340", goodBg: "#e4f2e9",
};
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

const th = (t: string, sub = "", align = "center") =>
  `<th style="text-align:${align};font:700 10px/1.35 -apple-system,Segoe UI,Roboto,Arial,sans-serif;` +
  `letter-spacing:.08em;text-transform:uppercase;color:${C.faint};padding:9px 6px;` +
  `border-bottom:1px solid ${C.rule};vertical-align:bottom;">${t}` +
  (sub ? `<div style="font-weight:400;text-transform:none;letter-spacing:0;font-size:11px;">${sub}</div>` : "") +
  `</th>`;
const td = (c: string, extra = "") =>
  `<td style="padding:9px 6px;border-bottom:1px solid ${C.ruleSoft};text-align:center;` +
  `font:400 13px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:${C.ink};${extra}">${c}</td>`;
const pill = (t: string, fg: string, bg: string) =>
  `<span style="display:inline-block;font:700 11px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif;` +
  `color:${fg};background:${bg};padding:3px 9px;border-radius:2px;">${t}</span>`;
const h4 = (t: string) =>
  `<div style="font:700 11px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif;letter-spacing:.12em;` +
  `text-transform:uppercase;color:${C.sage};margin:26px 0 4px;padding-bottom:6px;border-bottom:1px solid ${C.ruleSoft};">${t}</div>`;
const note = (t: string) =>
  `<div style="font:400 12px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:${C.faint};margin:7px 0 0;">${t}</div>`;
const table = (inner: string) =>
  `<table role="presentation" width="100%" style="border-collapse:collapse;table-layout:fixed;margin-top:12px;">${inner}</table>`;

const signed = (x: number) => (x > 0 ? "+" : "") + r0(x);
const clr = (x: number) => (x > 0 ? C.bad : C.good);

function build(d: any) {
  const rangeLabel = `${fmtMD(d.weekStart)}–${fmtMD(d.weekEnd)}`;

  // Best runway first: shrinking piles, then the slowest-growing.
  const stands = d.rows.slice().sort((a: Row, b: Row) => (a.changePerWeek ?? 0) - (b.changePerWeek ?? 0));

  const standsRows = stands.map((x: Row) => `<tr>
    ${td(`<b>${x.store}</b>`, "letter-spacing:.04em;")}
    ${td(x.pile == null ? "—" : money(x.pile))}
    ${td(x.changePerWeek == null ? "—" :
      `<span style="color:${clr(x.changePerWeek)};font-weight:700;">${signed(x.changePerWeek)}</span>`)}
    ${td(x.lastWeekListed == null ? "—" : String(x.lastWeekListed))}
    ${td(x.goal == null ? "—" : String(x.goal))}
  </tr>`).join("");

  // Closest to their own best first — the ones with the shortest reach.
  const clearRows = d.rows.slice()
    .sort((a: Row, b: Row) => (a.gap ?? 999) - (b.gap ?? 999))
    .map((x: Row) => {
      let verdict = pill("No reading yet", C.faint, "#f1f5f9");
      if (x.gap != null) {
        verdict = x.gap <= 0 ? pill("Beaten once", C.good, C.goodBg)
          : x.gap <= 2 ? pill(`Within ${Math.max(1, r0(x.gap))}%`, C.good, C.goodBg)
          : x.gap <= 15 ? pill(`Needs +${r0(x.gap)}%`, C.warn, C.warnBg)
          : pill(`Needs +${r0(x.gap)}%`, C.bad, C.badBg);
      }
      return `<tr>
        ${td(`<b>${x.store}</b>`, "letter-spacing:.04em;")}
        ${td(x.breakEven == null ? "—" : String(r0(x.breakEven)))}
        ${td(!x.bestWeek ? "—" :
          `<span style="${x.gap != null && x.gap <= 0 ? `color:${C.good};font-weight:700;` : ""}">${x.bestWeek}</span>`)}
        ${td(verdict)}
      </tr>`;
    }).join("");

  // Roll-call. A two-cell table row per store rather than a text list, so the
  // store code and the first word of every sentence line up in every mail client.
  const roll = d.rows.slice()
    .sort((a: Row, b: Row) => (b.changePerWeek ?? 0) - (a.changePerWeek ?? 0))
    .map((x: Row) => {
      const bits: string[] = [];
      if (x.lastWeekListed != null && x.goal != null) {
        const diff = x.lastWeekListed - x.goal;
        bits.push(diff >= 0
          ? `Listed ${x.lastWeekListed}, beat goal by ${diff}.`
          : `Listed ${x.lastWeekListed} against a goal of ${x.goal}.`);
      } else if (x.lastWeekListed != null) {
        bits.push(`Listed ${x.lastWeekListed}.`);
      } else {
        bits.push("No weekly KPI filed.");
      }
      if (x.changePerWeek != null && x.pile != null) {
        bits.push(x.changePerWeek > 0
          ? `Pile up to ${money(x.pile)}, growing ${r0(x.changePerWeek)} a week.`
          : `Pile down to ${money(x.pile)}, shrinking ${Math.abs(r0(x.changePerWeek))} a week.`);
      }
      return `<tr>
        <td style="padding:5px 12px 5px 0;vertical-align:baseline;white-space:nowrap;
            font:700 13px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;letter-spacing:.04em;color:${C.ink};">${x.store}</td>
        <td style="padding:5px 0;vertical-align:baseline;
            font:400 13px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:${C.soft};">${esc(bits.join(" "))}</td>
      </tr>`;
    }).join("");

  const growing = d.rows.filter((x: Row) => (x.changePerWeek ?? 0) > 0).length;
  const beaten = d.rows.filter((x: Row) => x.gap != null && x.gap <= 0).map((x: Row) => x.store);
  const headline = d.totalChange > 0
    ? `${money(d.totalPile)} unlisted · +${r0(d.totalChange)} a week`
    : `${money(d.totalPile)} unlisted · ${r0(d.totalChange)} a week`;
  const caption = growing === 0
    ? "Every store's pile is shrinking."
    : `${growing} of ${d.rows.length} store${d.rows.length === 1 ? "" : "s"} grew again this week.` +
      (beaten.length
        ? ` <b>${beaten.join(", ")}</b> ${beaten.length === 1 ? "has" : "have"} already listed above the rate needed to clear — the problem is repeating it, not reaching it.`
        : "");

  return `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f2f5f2;">
<table role="presentation" width="100%" style="max-width:640px;margin:0 auto;background:#fff;border:1px solid ${C.rule};border-collapse:collapse;">
<tr><td style="padding:22px 22px 26px;">

  <div style="font:700 19px/1.25 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:${C.ink};">Unlisted Backlog</div>
  <div style="font:400 13px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:${C.faint};margin-top:3px;">Week of ${rangeLabel}</div>

  <div style="background:${C.sageWash};padding:14px 16px;margin-top:16px;">
    <div style="font:800 21px/1.2 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:${C.emerald};">${headline}</div>
    <div style="font:400 13px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:${C.soft};margin-top:5px;">${caption}</div>
  </div>

  ${h4("Where each store stands")}
  ${note("Unlisted line items, and how last week went.")}
  ${table(`<thead><tr>${th("Store", "", "center")}${th("Unlisted", "now")}${th("Change", "per week")}${th("Listed", "last week")}${th("Goal", "last week")}</tr></thead>
    <tbody>${standsRows}</tbody>
    <tfoot><tr>
      ${td(`<b>District</b>`, `border-top:1px solid ${C.rule};background:${C.ruleSoft};font-weight:700;`)}
      ${td(`<b>${money(d.totalPile)}</b>`, `border-top:1px solid ${C.rule};background:${C.ruleSoft};`)}
      ${td(`<b style="color:${clr(d.totalChange)};">${signed(d.totalChange)}</b>`, `border-top:1px solid ${C.rule};background:${C.ruleSoft};`)}
      ${td("", `border-top:1px solid ${C.rule};background:${C.ruleSoft};`)}
      ${td("", `border-top:1px solid ${C.rule};background:${C.ruleSoft};`)}
    </tr></tfoot>`)}

  ${h4("What it would take to clear")}
  ${table(`<thead><tr>${th("Store")}${th("Break-even", "per week")}${th("Best week", `last ${BEST_WEEKS}`)}${th("Verdict")}</tr></thead>
    <tbody>${clearRows}</tbody>`)}
  ${note(`Break-even is the weekly listing rate that holds the pile flat. Measured against each store's own best week, not a modelled ceiling.`)}

  ${h4("Last week by store")}
  <table role="presentation" style="border-collapse:collapse;margin-top:10px;">${roll}</table>

  <div style="border-top:1px solid ${C.ruleSoft};margin-top:26px;padding-top:12px;
      font:400 11px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:${C.faint};">
    Unlisted counts from the weekly sales summary${d.priorAt ? ` (change measured over ${d.weeksBetween.toFixed(1)} week${d.weeksBetween === 1 ? "" : "s"} between readings)` : ""}.
    Listed counts from the weekly Store KPIs; goals from the capacity model.
    Break-even is derived from the pile so it always reconciles with it:
    ${AVG_WEEKS}-week average listed + weekly pile growth.
    ${d.readings < 3 ? "<br><b>Only " + d.readings + " pile reading" + (d.readings === 1 ? "" : "s") + " exist so far — the rates firm up as weeks accumulate.</b>" : ""}
  </div>

</td></tr></table></body></html>`;
}

// ---------------------------------------------------------------------------
async function sendEmail(to: string[], subject: string, html: string) {
  const res = await fetch(GMAIL_RELAY, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: SECRET, to: to.join(","), subject, html }),
  });
  const txt = await res.text();
  return { ok: res.ok, status: res.status, body: txt.slice(0, 300) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const q = (k: string) => url.searchParams.get(k);
  if (q("secret") !== SECRET) return jsonRes({ error: "Unauthorized" }, 401);

  try {
    // The pg_cron pair fires for both CDT and CST so the job survives the clock
    // change; this is what keeps the wrong one from sending an hour early or
    // late. weekly-report has no such guard and does send twice — worth fixing
    // there separately. ?force=1 bypasses it for a manual run.
    if (q("trigger") === "cron" && q("force") !== "1") {
      const h = centralNow().getHours();
      if (h !== SEND_HOUR_CENTRAL) {
        return jsonRes({ ok: true, skipped: `central hour ${h}, waiting for ${SEND_HOUR_CENTRAL}` });
      }
    }

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const weekEnd = q("weekEnd") ? new Date(q("weekEnd") + "T00:00:00") : lastSundayCentral();
    const d = await gather(sb, weekEnd);
    const html = build(d);

    if (q("dryRun") === "1") return new Response(html, { headers: { "Content-Type": "text/html" } });

    const to = q("to") ? [q("to")!] : TO_DEFAULT;
    const rangeLabel = `${fmtMD(d.weekStart)}–${fmtMD(d.weekEnd)}`;
    const sent = await sendEmail(to, `Unlisted Backlog — Week of ${rangeLabel}`, html);
    return jsonRes({ ok: true, weekEnd: ymd(d.weekEnd), to, readings: d.readings, sent });
  } catch (err: any) {
    return jsonRes({ ok: false, error: String(err?.message ?? err), stack: String(err?.stack ?? "").slice(0, 400) }, 500);
  }
});
