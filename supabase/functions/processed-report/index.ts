import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// PROCESSED REPORT — one table, every morning at 8:10am Central.
// ----------------------------------------------------------------------------
// The Processed Stats section of each store's Day End Report, all five stores
// side by side: who listed what yesterday, and what it was worth.
//
// WHERE THE FIGURES COME FROM
// `day_end_facts`, written by `day-end-ingest` at 7:05am off the same Day End
// Report email that already feeds buying, cash and Google reviews. Nothing here
// is recomputed or re-fetched — this function only reads that table and mails
// it, exactly like `cash-report` does for `store_cash`.
//
//   listed     day_end_facts.devices_processed  ("Devices Processed")
//   value      day_end_facts.processed_value    ("Total Value")
//
// DELIBERATELY THREE COLUMNS, AND DELIBERATELY NO BENCHMARK.
// The first build (2026-09-18) also carried each store's trailing six-open-day
// average under Listed, and an In Queue column showing the backlog in days of
// work. Ethan cut both the same day: this is a glance email, and a second figure
// tucked under the first is one more thing to read before the two that matter.
// `queue_count` is still in `day_end_facts` and still free to read, so if a
// backlog view is ever wanted it should be its own thing rather than a sub-line
// here.
//
// WHY THERE IS NO % OF GOAL COLUMN EITHER
// Worth recording, because it is the column a future reader is most likely to
// try to add. Listed ÷ the store's daily listing goal would be wrong twice over:
//
//  1. The two feeds disagree. The DM's Store Efficiency board scores the
//     manager-filed WEEKLY KPI (`kpi_entries.listed_count`); this report has
//     only the Day End Report's own Devices Processed. Over the week of
//     Sep 8–13 they differed by 15–30% at every store (BAL 104 vs 149, LEE 115
//     vs 163, WSP 207 vs 233). Printing a percentage off the smaller number
//     beside a board showing the larger one gives leadership two "efficiency"
//     figures that contradict each other and no way to tell which is wrong.
//  2. The goals were mid-rework when this shipped. `store-targets` and the front
//     end were held until Mon 2026-09-21 while the DB already carried the new
//     capacity model, so a daily goal read then was a number that moved a week
//     later.
//
// SUNDAY IS CLOSED, so the week runs Tue–Sat yesterday, nothing on Sunday, and
// Monday reports SATURDAY — the same rule and the same reasoning as cash-report:
// retargeting Sunday's send at Saturday would make Monday's run hit the
// already-sent guard and go silent, and a missing Monday is the worse failure.
//
// TIMING — 8:10, NOT 8:00. Ethan asked for 8:00 with the rest of the morning
// mail. The morning sales import runs at :00 and Net Profit at :05, and both
// share an Apps Script lock with the Gmail relay this mails through (see 0089,
// which moved refund-mismatch to :20 for exactly that reason). :10 is clear of
// both, ahead of refund-mismatch, and still inside the 8 o'clock read.
//
// Auth: verify_jwt=false, ?secret= only. There is no browser path — nothing in
// speeks.js calls this, and the secret must stay out of the frontend.
// ============================================================================

const SECRET = 'sp33ks-sync-k3y-2026-x9mq';
const GMAIL_RELAY = Deno.env.get('GMAIL_RELAY_URL') ||
  'https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec';
const LIST_KEY = 'processed_report';
// Ethan and Paul, the two people this was built for. Only ever reached while the
// list is empty — the moment one address is added in Email Recipients this is
// unreachable, the same contract as cash-report's.
const FALLBACK_TO = ['ethan.kushnir@speekstechnology.com', 'paul.kushnir@pikinvestments.com'];

const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];

const STORE_COLOR: Record<string, string> = {
  OVL: '#7c3aed', LEE: '#2563eb', WSP: '#16a34a', MPL: '#ea580c', BAL: '#dc2626',
};
const STORE_TINT: Record<string, string> = {
  OVL: '#f1ebfd', LEE: '#e8f0fb', WSP: '#e8f7ee', MPL: '#fdf0e7', BAL: '#fcecec',
};
const STORE_RING: Record<string, string> = {
  OVL: '#ddd0fb', LEE: '#cfe0f7', WSP: '#c6ecd6', MPL: '#f8dcc7', BAL: '#f6d5d5',
};

// The same V4 airy palette the cash, weekly and usage reports use, so all four
// read as one family in an inbox.
const C = {
  sage: '#1f9d57', charcoal: '#1a1c1e', app: '#f1f5f2', card: '#ffffff',
  soft: '#f7faf8', line: '#eaefeb', line2: '#f4f8f5',
  muted: '#64707c', faint: '#9aa6ad', red: '#d64545', footBg: '#f7faf8',
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v: unknown) => (v === null || v === undefined || v === '') ? null : Number(v);

// Whole dollars throughout. Processed Value is a valuation, not a till count —
// nobody reads the cents off it, and dropping them keeps five rows on one line
// on a phone.
const usd = (n: number | null | undefined) =>
  (n === null || n === undefined || !Number.isFinite(Number(n))) ? '—'
    : '$' + Math.round(Number(n)).toLocaleString('en-US');
const int = (n: number | null | undefined) =>
  (n === null || n === undefined || !Number.isFinite(Number(n))) ? '—'
    : Math.round(Number(n)).toLocaleString('en-US');

function centralToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}
const addDays = (day: string, n: number) => {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const prettyDay = (day: string) =>
  new Date(day + 'T12:00:00Z').toLocaleDateString('en-US',
    { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });

// 0 = Sunday. Read at noon UTC so this is the calendar day's own weekday and not
// some timezone's opinion of it — the same reason every date helper here parses
// at T12:00:00Z rather than bare.
const dowOf = (day: string) => new Date(day + 'T12:00:00Z').getUTCDay();

// The last day the stores were actually open before `today`. Only Sunday is
// closed, so this steps back one extra day exactly once, on Mondays.
function lastOpenDay(today: string): string {
  let d = addDays(today, -1);
  while (dowOf(d) === 0) d = addDays(d, -1);
  return d;
}

const heroTile = () => {
  const bar = (h: number) =>
    `<td width="4" valign="bottom" style="padding:0 2px;"><div style="width:4px;height:${h}px;background:#6ee7a7;border-radius:2px;font-size:0;line-height:0;">&nbsp;</div></td>`;
  return `<table role="presentation" width="40" height="40" cellpadding="0" cellspacing="0" style="background:rgba(31,157,87,.20);border-radius:12px;"><tr><td align="center" valign="middle" height="40">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>${bar(10)}${bar(18)}${bar(13)}</tr></table>
  </td></tr></table>`;
};

const badge = (s: string) =>
  `<span style="display:inline-block;background:${STORE_TINT[s]};color:${STORE_COLOR[s]};border:1px solid ${STORE_RING[s]};font-size:11px;font-weight:800;padding:2px 8px;border-radius:6px;letter-spacing:.5px;">${s}</span>`;

// The width attribute matters as much as the style here: Outlook renders mail
// through Word, which ignores table-layout but honours width=.
const th = (t: string, align = 'center', w = '') =>
  `<th${w ? ` width="${w}"` : ''} align="${align}" style="font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:${C.faint};background:${C.soft};padding:10px 6px;text-align:${align};border-bottom:1px solid ${C.line};">${t}</th>`;

// The one small line left in the table, under Processed Value. It is allowed to
// wrap; the figure above it is not. Holding a sub-line on one line is what set
// the earlier four-column build's min-content width past a phone and pushed its
// In Queue column off-screen with no scrollbar to say so.
//
// At three columns the table clears every width measured — 320, 360, 375 and 390
// all render with zero horizontal overflow, full and empty. That headroom is
// what a fourth column would spend, so re-measure before adding one rather than
// assuming it still fits.
const sub = (t: string, color: string) =>
  `<div style="font-size:10.5px;font-weight:700;color:${color};margin-top:2px;line-height:1.35;">${t}</div>`;

// A row's whole reading, derived once so the table cells and the district line
// cannot drift apart.
type Read = {
  store: string;
  listed: number | null;
  value: number | null;
  perUnit: number | null;  // value / listed
};

function readFor(store: string, today: any): Read {
  const listed = today ? num(today.devices_processed) : null;
  const value  = today ? num(today.processed_value)   : null;
  return {
    store, listed, value,
    // Guard the divisor, and treat a zero-count day as having no per-unit figure
    // rather than an infinite one.
    perUnit: (value !== null && listed !== null && listed > 0) ? value / listed : null,
  };
}

function buildEmail(day: string, reads: Read[], missing: string[], carried = false) {
  const have = reads.filter((r) => r.listed !== null || r.value !== null);
  const anyData = have.length > 0;
  const sum = (pick: (r: Read) => number | null) =>
    have.reduce((a, r) => { const v = pick(r); return v === null ? a : a + v; }, 0);

  const cell = `padding:13px 6px;border-bottom:1px solid ${C.line2};font-size:16px;font-weight:800;color:${C.charcoal};text-align:center;white-space:nowrap;`;

  const body = STORES.map((s) => {
    const r = reads.find((x) => x.store === s) as Read;
    const dim = r.listed === null ? `color:${C.faint};` : '';
    return `<tr>
      <td align="center" style="padding:13px 6px;border-bottom:1px solid ${C.line2};text-align:center;">${badge(s)}</td>
      <td align="center" style="${cell}${dim}">${int(r.listed)}</td>
      <td align="center" style="${cell}${dim}">${usd(r.value)}${sub(r.perUnit === null ? '&nbsp;' : `${usd(r.perUnit)}/unit`, C.faint)}</td>
    </tr>`;
  }).join('');

  // The district line only adds up the stores that actually reported, and says
  // how many that is whenever it is not all five. Summing a partial morning as
  // if it were the whole company is the one number here that could be quietly,
  // badly wrong.
  const dListed = sum((r) => r.listed);
  const dValue  = sum((r) => r.value);
  const dPer    = dListed > 0 ? dValue / dListed : null;

  const totalCell = `padding:14px 6px;background:${C.soft};border-bottom:0;font-size:16px;font-weight:800;color:${C.charcoal};text-align:center;white-space:nowrap;`;
  const totalRow = `<tr>
    <td align="center" style="padding:14px 6px;background:${C.soft};text-align:center;">
      <span style="font-size:12.5px;font-weight:800;color:${C.charcoal};">All Stores</span>
      ${missing.length ? `<div style="font-size:10.5px;font-weight:700;color:${C.red};margin-top:2px;">${have.length} of ${STORES.length} reporting</div>` : ''}
    </td>
    <td align="center" style="${totalCell}">${int(dListed)}</td>
    <td align="center" style="${totalCell}">${usd(dValue)}${sub(dPer === null ? '&nbsp;' : `${usd(dPer)}/unit`, C.faint)}</td>
  </tr>`;

  const note = !anyData
    ? `<div style="margin:18px 2px 0;padding:14px;border:1px solid ${C.line};border-radius:12px;background:${C.soft};font-size:12.5px;font-weight:600;color:${C.red};">No Day End Report figures reached us for this date. Nothing was listed as far as this report can tell — which is a reporting gap, not a day of no work.</div>`
    : missing.length
      ? `<div style="margin:18px 2px 0;padding:12px 14px;border:1px solid ${C.line};border-radius:12px;background:${C.soft};font-size:12px;font-weight:600;color:${C.muted};">No Day End Report figures for ${missing.map((s) => esc(s)).join(', ')}. Those rows read &ldquo;&mdash;&rdquo; and are left out of the All Stores line.</div>`
      : '';

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.app};font-family:Inter,Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.app};padding:20px 10px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${C.card};border:1px solid ${C.line};border-radius:18px;overflow:hidden;">
  <tr><td style="background:#13181a;padding:20px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="40" valign="top">${heroTile()}</td>
      <td valign="middle" style="padding-left:13px;">
        <div style="font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#6ee7a7;">Speeks Technology</div>
        <div style="font-size:20px;font-weight:800;letter-spacing:-.02em;color:#ffffff;margin-top:2px;">Processed Stats</div>
        <div style="font-size:12.5px;font-weight:600;color:rgba(255,255,255,.66);margin-top:2px;">${prettyDay(day)}${carried ? ' &middot; stores closed Sunday' : ''}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="height:3px;background:${C.sage};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:18px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:14px;overflow:hidden;">
      <tr>${th('Store', 'center', '24%')}${th('Listed', 'center', '30%')}${th('Processed Value', 'center', '46%')}</tr>
      ${body}${totalRow}
    </table>
    ${note}
  </td></tr>
  <tr><td style="padding:16px;text-align:center;color:${C.faint};font-size:10.5px;border-top:1px solid ${C.line};background:${C.footBg};">Generated automatically by Speeks &middot; Devices Processed and Total Value, read from each store&rsquo;s Day End Report for ${prettyDay(day)}.</td></tr>
</table></td></tr></table></body></html>`;
}

async function sendEmail(to: string[], subject: string, html: string) {
  const res = await fetch(GMAIL_RELAY, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ secret: SECRET, to: to.join(','), subject, html }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`relay ${res.status}: ${text.slice(0, 200)}`);
  return text.slice(0, 200);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  if (url.searchParams.get('secret') !== SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: cors });
  }

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // Default to the last OPEN day: the Day End Report covers the day it is sent,
  // and this runs the following morning — except on Monday, when yesterday was a
  // shut Sunday and Saturday is the real last trading day.
  const today  = centralToday();
  const asked  = url.searchParams.get('day');
  const day    = asked || lastOpenDay(today);
  const dryRun = url.searchParams.get('dryRun') === '1';
  const force  = url.searchParams.get('force') === '1';
  // True only when we stepped over a closed Sunday, i.e. Monday's email. Said in
  // the header, so a Saturday date landing on a Monday reads as intended rather
  // than as a report that failed to refresh.
  const carried = !asked && day !== addDays(today, -1);

  // Sunday: send nothing. Saturday's figures go out tomorrow instead. dryRun and
  // force still render and send, so this stays testable on any day.
  if (!dryRun && !force && !asked && dowOf(today) === 0) {
    return new Response(JSON.stringify({
      ok: true, skipped: 'sunday — stores closed; Saturday goes out Monday', today, day,
    }, null, 2), { headers: cors });
  }

  try {
    const { data, error } = await sb.from('day_end_facts')
      .select('store, date, devices_processed, processed_value')
      .eq('date', day);
    if (error) throw new Error(error.message);

    const byStore: Record<string, any> = {};
    (data || []).forEach((r: any) => {
      const s = String(r.store || '').toUpperCase();
      if (STORES.includes(s)) byStore[s] = r;
    });

    const reads = STORES.map((s) => readFor(s, byStore[s]));
    const missing = reads
      .filter((r) => r.listed === null && r.value === null)
      .map((r) => r.store);
    const have = STORES.length - missing.length;

    // Already sent for this day? Same rule as cash-report, and it exists for the
    // same reason: "already sent" means "already sent with AT LEAST THIS MUCH".
    // A send that covered fewer stores than we now hold is a gap being filled, so
    // it goes out again marked as an update; same or fewer is a true duplicate
    // and skips. A day-end feed that arrives late must not be able to lock the
    // morning shut behind an empty first send.
    let updating = false;
    if (!dryRun && !force) {
      const { data: prev } = await sb.from('processed_report_sends')
        .select('day, sent_at, stores').eq('day', day).maybeSingle();
      if (prev) {
        // A row with no count predates the column being read here; treat it as
        // complete rather than risk re-mailing a day that was fine.
        const prevStores = prev.stores ?? STORES.length;
        if (prevStores >= have) {
          return new Response(JSON.stringify({
            ok: true, skipped: 'already sent', day, sentAt: prev.sent_at, stores: prevStores,
          }, null, 2), { headers: cors });
        }
        updating = true;
      }
    }

    const html = buildEmail(day, reads, missing, carried);
    if (dryRun) return new Response(html, { headers: { ...cors, 'Content-Type': 'text/html' } });

    // ?to= sends this run somewhere else and touches nothing about the real list.
    // Without it the only way to prove the relay works is to mail the actual
    // recipients, which makes every test a live send — the reason cash-report,
    // weekly-report and b2b-outreach all carry the same override.
    const override = (url.searchParams.get('to') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const { data: recips } = await sb.from('email_recipients').select('email').eq('list_key', LIST_KEY);
    const to = (recips || []).map((r: any) => r.email).filter(Boolean);
    const sendTo = override.length ? override : (to.length ? to : FALLBACK_TO);

    const totalListed = reads.reduce((a, r) => r.listed === null ? a : a + r.listed, 0);
    // "Updated" so a second email reads as the correction to the first rather
    // than as a duplicate, and sorts beside it in the inbox.
    const subject = (updating ? 'Updated: ' : '') + (missing.length === STORES.length
      ? `Processed Stats — ${prettyDay(day)} — no figures received`
      : `Processed Stats — ${prettyDay(day)} — ${totalListed.toLocaleString('en-US')} listed`);

    const relay = await sendEmail(sendTo, subject, html);
    // A ?to= test must NOT be recorded as the day's send. Recording it would make
    // the real morning run see the day as handled and stay silent — testing the
    // email would be the thing that stopped it arriving.
    if (!override.length) {
      await sb.from('processed_report_sends').upsert({
        day, sent_at: new Date().toISOString(), recipients: sendTo, stores: have,
      }, { onConflict: 'day' });
    }

    return new Response(JSON.stringify({
      ok: true, day, carried, to: sendTo, test: override.length > 0, updating,
      stores: have, missing, listed: totalListed, relay,
    }, null, 2), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message || e) }, null, 2),
      { status: 500, headers: cors });
  }
});
