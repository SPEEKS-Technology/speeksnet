import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// UNLISTED INVENTORY WEEKLY UPDATE — Monday 9:00am Central, covering the week
// that just ended. (Function slug stays `unlisted-backlog`; the pg_cron jobs
// point at it by name.)
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

// The name on the hero and in the subject line. The function SLUG stays
// `unlisted-backlog` — renaming it would orphan the two pg_cron jobs.
const REPORT_NAME = "Unlisted Inventory Weekly Update";
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
// This report wears the SAME shell as weekly-report — Airy V4 palette, dark
// hero with the three-bar tile, sage accent rule, 680px card, section labels,
// glance tiles, store chips. They arrive in the same inbox on the same morning,
// so anything else reads as a different product. Everything from here down to
// build() is deliberately copied from weekly-report; if that shell changes,
// change it here too.
const STORE_COLOR: Record<string, string> = {
  OVL: "#7c3aed", LEE: "#2563eb", WSP: "#16a34a", MPL: "#ea580c", BAL: "#dc2626",
};
const STORE_TINT: Record<string, string> = {
  OVL: "#f1ebfd", LEE: "#e8f0fb", WSP: "#e8f7ee", MPL: "#fdf0e7", BAL: "#fcecec",
};
const STORE_RING: Record<string, string> = {
  OVL: "#ddd0fb", LEE: "#cfe0f7", WSP: "#c6ecd6", MPL: "#f8dcc7", BAL: "#f6d5d5",
};

const C = {
  sage: "#1f9d57", sageDeep: "#178048", tint: "#e8f7ee",
  charcoal: "#1a1c1e", app: "#f1f5f2", card: "#ffffff", soft: "#f7faf8",
  green: "#1f9d57", amber: "#c07f0c", red: "#d64545",
  line: "#eaefeb", line2: "#f4f8f5",
  muted: "#64707c", faint: "#9aa6ad",
  flagBorder: "#f0dcb6", flagHead: "#fdf3e1", flagInk: "#8a5a06",
  footBg: "#f7faf8",
  rCard: 18, rBox: 14,
};
const FONT = "Inter,Arial,Helvetica,sans-serif";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

// Three bars built from table cells rather than an SVG or a remote PNG, so it
// renders identically in Outlook, Gmail and Apple Mail.
const heroTile = () => {
  const bar = (h: number) =>
    `<td width="4" valign="bottom" style="padding:0 2px;"><div style="width:4px;height:${h}px;background:#6ee7a7;border-radius:2px;font-size:0;line-height:0;">&nbsp;</div></td>`;
  return `<table role="presentation" width="40" height="40" cellpadding="0" cellspacing="0" style="background:rgba(31,157,87,.20);border-radius:12px;"><tr><td align="center" valign="middle" height="40">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>${bar(8)}${bar(16)}${bar(12)}</tr></table>
  </td></tr></table>`;
};

const wrapEmail = (title: string, range: string, body: string, foot: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>@media only screen and (max-width:520px){.gtile{display:block!important;width:100%!important;padding:6px 0!important}}</style></head>
<body style="margin:0;padding:0;background:${C.app};font-family:${FONT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.app};padding:20px 10px;"><tr><td align="center">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:${C.card};border:1px solid ${C.line};border-radius:${C.rCard}px;overflow:hidden;">
  <tr><td style="background:#13181a;padding:20px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="40" valign="top">${heroTile()}</td>
      <td valign="middle" style="padding-left:13px;">
        <div style="font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#6ee7a7;">Speeks Technology</div>
        <div style="font-size:20px;font-weight:800;letter-spacing:-.02em;color:#ffffff;margin-top:2px;">${title}</div>
        <div style="font-size:12.5px;font-weight:600;color:rgba(255,255,255,.66);margin-top:2px;">${range}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="height:3px;background:${C.sage};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:22px;">${body}</td></tr>
  ${foot ? `<tr><td style="padding:16px;text-align:center;color:${C.faint};font-size:10.5px;line-height:1.6;border-top:1px solid ${C.line};background:${C.footBg};">${foot}</td></tr>` : ""}
</table></td></tr></table></body></html>`;

const sectionLabel = (t: string, note = "") =>
  `<div style="margin:26px 2px 12px;border-left:2px solid ${C.sage};padding-left:11px;">
     <div style="font-size:15.5px;font-weight:800;color:${C.charcoal};letter-spacing:-.015em;">${t}</div>
     ${note ? `<div style="font-size:11px;font-weight:600;color:${C.faint};margin-top:2px;">${note}</div>` : ""}
   </div>`;

const tile = (label: string, value: string, sub: string) =>
  `<td class="gtile" width="33%" valign="top" style="padding:6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.soft};border:1px solid ${C.line};border-radius:${C.rBox}px;"><tr><td style="padding:14px;">
    <div style="font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.5px;color:${C.faint};">${label}</div>
    <div style="font-size:23px;font-weight:900;color:${C.charcoal};margin-top:5px;text-align:center;">${value}</div>
    <div style="font-size:11px;font-weight:700;color:${C.muted};margin-top:3px;">${sub}</div>
  </td></tr></table></td>`;

const badge = (s: string) =>
  `<span style="display:inline-block;background:${STORE_TINT[s] || C.tint};color:${STORE_COLOR[s] || C.sageDeep};border:1px solid ${STORE_RING[s] || "#c6ecd6"};font-size:11px;font-weight:800;padding:2px 8px;border-radius:6px;letter-spacing:.5px;">${s}</span>`;

const chip = (text: string, kind: "bad" | "warn" | "ok") => {
  const m = {
    bad: ["#fcecec", "#b23636", "#f6d5d5"],
    warn: [C.flagHead, C.flagInk, C.flagBorder],
    ok: [C.tint, "#146c3c", "#c6ecd6"],
  }[kind];
  return `<span style="display:inline-block;font-size:11px;font-weight:800;padding:3px 9px;border-radius:99px;background:${m[0]};color:${m[1]};border:1px solid ${m[2]};">${text}</span>`;
};

const th = (t: string, sub = "") =>
  `<th style="font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:${C.faint};` +
  `background:${C.soft};padding:9px 7px;text-align:center;border-bottom:1px solid ${C.line};vertical-align:bottom;">${t}` +
  (sub ? `<div style="font-weight:700;text-transform:none;letter-spacing:0;font-size:9.5px;color:${C.faint};opacity:.85;">${sub}</div>` : "") +
  `</th>`;
const td = (c: string, extra = "") =>
  `<td style="padding:11px 7px;border-bottom:1px solid ${C.line2};text-align:center;` +
  `font-size:13px;color:${C.charcoal};${extra}">${c}</td>`;
// The card every table sits in — same rounded hairline box as weekly-report's.
const boxed = (inner: string, cols: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:${C.rBox}px;overflow:hidden;border-collapse:separate;table-layout:fixed;">
     <colgroup>${cols}</colgroup>${inner}</table>`;

const signed = (x: number) => (x > 0 ? "+" : "") + r0(x);
const clr = (x: number) => (x > 0 ? C.red : C.green);

function build(d: any) {
  const rangeLabel = `${fmtMD(d.weekStart)}–${fmtMD(d.weekEnd)}`;

  // Best runway first: shrinking piles, then the slowest-growing.
  const stands = d.rows.slice().sort((a: Row, b: Row) => (a.changePerWeek ?? 0) - (b.changePerWeek ?? 0));

  const standsRows = stands.map((x: Row) => `<tr>
    ${td(badge(x.store))}
    ${td(x.pile == null ? "—" : `<b style="font-weight:900;">${money(x.pile)}</b>`)}
    ${td(x.changePerWeek == null ? "—" :
      `<span style="color:${clr(x.changePerWeek)};font-weight:900;">${signed(x.changePerWeek)}</span>`)}
    ${td(x.lastWeekListed == null ? "—" : String(x.lastWeekListed))}
    ${td(x.goal == null ? "—" : `<span style="color:${C.muted};">${x.goal}</span>`)}
  </tr>`).join("");

  // Closest to their own best first — the ones with the shortest reach.
  const clearRows = d.rows.slice()
    .sort((a: Row, b: Row) => (a.gap ?? 999) - (b.gap ?? 999))
    .map((x: Row) => {
      let verdict = `<span style="font-size:11px;font-weight:700;color:${C.faint};">No reading yet</span>`;
      if (x.gap != null) {
        verdict = x.gap <= 0 ? chip("Beaten once", "ok")
          : x.gap <= 2 ? chip(`Within ${Math.max(1, r0(x.gap))}%`, "ok")
          : x.gap <= 15 ? chip(`Needs +${r0(x.gap)}%`, "warn")
          : chip(`Needs +${r0(x.gap)}%`, "bad");
      }
      return `<tr>
        ${td(badge(x.store))}
        ${td(x.breakEven == null ? "—" : `<b style="font-weight:900;">${r0(x.breakEven)}</b>`)}
        ${td(!x.bestWeek ? "—" :
          `<span style="${x.gap != null && x.gap <= 0 ? `color:${C.green};font-weight:900;` : ""}">${x.bestWeek}</span>`)}
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
        <td width="64" valign="top" style="padding:11px 0 11px 14px;border-bottom:1px solid ${C.line2};white-space:nowrap;">${badge(x.store)}</td>
        <td valign="top" style="padding:11px 14px;border-bottom:1px solid ${C.line2};
            font-size:13px;line-height:1.5;color:${C.muted};">${esc(bits.join(" "))}</td>
      </tr>`;
    }).join("");

  const growing = d.rows.filter((x: Row) => (x.changePerWeek ?? 0) > 0).length;
  const beaten = d.rows.filter((x: Row) => x.gap != null && x.gap <= 0).map((x: Row) => x.store);
  const caption = growing === 0
    ? "Every store's pile is shrinking."
    : `${growing} of ${d.rows.length} store${d.rows.length === 1 ? "" : "s"} grew again this week.` +
      (beaten.length
        ? ` <b>${beaten.join(", ")}</b> ${beaten.length === 1 ? "has" : "have"} already listed above the rate needed to clear — the problem is repeating it, not reaching it.`
        : "");

  // Totals for the glance tiles — the same three numbers the roll-call repeats
  // per store, so the top of the mail answers "how bad, which way" on its own.
  const totListed = d.rows.reduce((a: number, x: Row) => a + (x.lastWeekListed ?? 0), 0);
  const totGoal = d.rows.reduce((a: number, x: Row) => a + (x.goal ?? 0), 0);
  const goalPct = totGoal ? Math.round((totListed / totGoal) * 100) : 0;

  const glance = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    ${tile("Unlisted Now", money(d.totalPile), `Line items across ${d.rows.length} stores`)}
    ${tile("Weekly Change", signed(d.totalChange), `<b style="color:${clr(d.totalChange)}">${d.totalChange > 0 ? "Growing" : "Shrinking"}</b> · ${growing} of ${d.rows.length} grew`)}
    ${tile("Listed Last Week", money(totListed), `Against ${money(totGoal)} goal · <b style="color:${goalPct >= 100 ? C.green : C.amber}">${goalPct}%</b>`)}
  </tr></table>`;

  const body = `
  ${glance}

  <div style="margin-top:10px;background:${C.tint};border:1px solid #c6ecd6;border-radius:${C.rBox}px;padding:14px 16px;
      font-size:13px;line-height:1.55;color:#146c3c;font-weight:600;">${caption}</div>

  ${sectionLabel("Where each store stands", "Unlisted line items, and how last week went.")}
  ${boxed(
    `<thead><tr>${th("Store")}${th("Unlisted", "This Week")}${th("Change", "Per Week")}${th("Listed", "Last Week")}${th("Goal", "Last Week")}</tr></thead>
     <tbody>${standsRows}</tbody>
     <tfoot><tr>
       ${td(`<b style="font-weight:900;color:${C.charcoal};">District</b>`, `background:${C.soft};border-bottom:none;`)}
       ${td(`<b style="font-weight:900;">${money(d.totalPile)}</b>`, `background:${C.soft};border-bottom:none;`)}
       ${td(`<b style="font-weight:900;color:${clr(d.totalChange)};">${signed(d.totalChange)}</b>`, `background:${C.soft};border-bottom:none;`)}
       ${td(`<b style="font-weight:900;">${money(totListed)}</b>`, `background:${C.soft};border-bottom:none;`)}
       ${td(`<span style="color:${C.muted};font-weight:700;">${money(totGoal)}</span>`, `background:${C.soft};border-bottom:none;`)}
     </tr></tfoot>`,
    `<col style="width:16%"><col style="width:19%"><col style="width:21%"><col style="width:22%"><col style="width:22%">`,
  )}

  ${sectionLabel("What it would take to clear", "The weekly listing rate that holds the pile flat, against each store's own best week.")}
  ${boxed(
    `<thead><tr>${th("Store")}${th("Break-even", "Per Week")}${th("Best Week", `Last ${BEST_WEEKS}`)}${th("Verdict")}</tr></thead>
     <tbody>${clearRows}</tbody>`,
    `<col style="width:16%"><col style="width:26%"><col style="width:24%"><col style="width:34%">`,
  )}

  ${sectionLabel("Last week by store")}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:${C.rBox}px;overflow:hidden;border-collapse:separate;">${roll}</table>`;

  // The provenance note (where each number comes from) is gone at Ethan's
  // request — he knows the sources. What stays is the one line that changes how
  // you should READ the numbers: with only a couple of pile readings the rates
  // are noisy, and nothing else on the page says so. It renders no footer band
  // at all once there are enough readings, which is the normal case.
  const foot = d.readings < 3
    ? `<b style="color:${C.flagInk};">Only ${d.readings} pile reading${d.readings === 1 ? "" : "s"} exist so far — the rates firm up as weeks accumulate.</b>`
    : "";

  return wrapEmail(REPORT_NAME, `Week of ${rangeLabel}`, body, foot);
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
    const sent = await sendEmail(to, `${REPORT_NAME} — Week of ${rangeLabel}`, html);
    return jsonRes({ ok: true, weekEnd: ymd(d.weekEnd), to, readings: d.readings, sent });
  } catch (err: any) {
    return jsonRes({ ok: false, error: String(err?.message ?? err), stack: String(err?.stack ?? "").slice(0, 400) }, 500);
  }
});
