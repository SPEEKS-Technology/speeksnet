import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// CASH REPORT — one table, every morning at 7:00am Central.
// ----------------------------------------------------------------------------
// Closing cash for all five stores: the drawer, the safe, and the two added up.
// The figures come off the same Day End Report that already feeds buying and
// Google reviews; the Apps Script parses them and `sales-ingest` writes them to
// `store_cash`. This function only reads that table and mails it.
//
// It is CALLED BY sales-ingest at the end of its 7am run rather than by a cron
// job of its own, which is the only way "7:00am" can be honest: a second cron at
// the same minute would race the import that produces the data. Standalone use
// is still supported for re-sends and testing (?day=, ?dryRun=1, ?force=1).
//
// The day reported is the day the report COVERS — normally yesterday. Cash
// balances are a closing position, so the morning email is last night's count.
//
// SUNDAY IS CLOSED, so the week runs:
//   Tue–Sat  yesterday, as normal
//   Sunday   nothing sent at all
//   Monday   SATURDAY's close, skipping over the shut day
// Retargeting Sunday's send at Saturday instead of suppressing it would look
// equivalent and is not: both Sunday and Monday would then report Saturday, the
// send record is keyed on the day reported, and Monday's run would hit the
// already-sent guard and go silent. A missing Monday email is a worse failure
// than a missing Sunday one, because Monday is the day somebody is looking.
// ============================================================================

const SECRET = 'sp33ks-sync-k3y-2026-x9mq';
const GMAIL_RELAY = Deno.env.get('GMAIL_RELAY_URL') ||
  'https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec';
const LIST_KEY = 'cash_report';
const FALLBACK_TO = ['paul.kushnir@pikinvestments.com'];

const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
// The long store names are deliberately not shown. The codes are what everyone
// reading this already uses, and the colour badge carries the identification —
// spelling "Overland Park" out beside OVL only pushed the money columns right.
const STORE_COLOR: Record<string, string> = {
  OVL: '#7c3aed', LEE: '#2563eb', WSP: '#16a34a', MPL: '#ea580c', BAL: '#dc2626',
};
const STORE_TINT: Record<string, string> = {
  OVL: '#f1ebfd', LEE: '#e8f0fb', WSP: '#e8f7ee', MPL: '#fdf0e7', BAL: '#fcecec',
};
const STORE_RING: Record<string, string> = {
  OVL: '#ddd0fb', LEE: '#cfe0f7', WSP: '#c6ecd6', MPL: '#f8dcc7', BAL: '#f6d5d5',
};

// The same V4 airy palette the weekly and usage reports use, so the three read
// as one family in an inbox.
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

// Whole dollars. These are cash counts — nobody reads the cents off a drawer
// total, and dropping them keeps five figures on one line on a phone.
const usd = (n: number | null | undefined) =>
  (n === null || n === undefined) ? '—'
    : '$' + Math.round(Number(n)).toLocaleString('en-US');

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
// some timezone's opinion of it — the same reason every other date helper here
// parses at T12:00:00Z rather than bare.
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
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>${bar(8)}${bar(16)}${bar(12)}</tr></table>
  </td></tr></table>`;
};

const badge = (s: string) =>
  `<span style="display:inline-block;background:${STORE_TINT[s]};color:${STORE_COLOR[s]};border:1px solid ${STORE_RING[s]};font-size:11px;font-weight:800;padding:2px 8px;border-radius:6px;letter-spacing:.5px;">${s}</span>`;

// The width attribute matters as much as the style here: Outlook renders mail
// through Word, which ignores table-layout but honours width=.
const th = (t: string, align = 'center', w = '') =>
  `<th${w ? ` width="${w}"` : ''} align="${align}" style="font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:${C.faint};background:${C.soft};padding:10px 8px;text-align:${align};border-bottom:1px solid ${C.line};">${t}</th>`;

function buildEmail(day: string, rows: Record<string, any>, missing: string[], carried = false) {
  const sum = (k: string) => STORES.reduce((a, s) =>
    rows[s] && rows[s][k] !== null && rows[s][k] !== undefined ? a + Number(rows[s][k]) : a, 0);
  const anyData = STORES.some(s => rows[s]);

  // Centred rather than right-aligned. Right-alignment earns its keep when a
  // column is long enough that the eye needs the decimal point to line up; with
  // five rows of whole dollars it just left a ragged gutter under each heading.
  const td = `padding:12px 8px;border-bottom:1px solid ${C.line2};font-size:15px;font-weight:800;color:${C.charcoal};text-align:center;white-space:nowrap;`;

  const body = STORES.map(s => {
    const r = rows[s];
    return `<tr>
      <td align="center" style="padding:12px 8px;border-bottom:1px solid ${C.line2};text-align:center;white-space:nowrap;">${badge(s)}</td>
      <td align="center" style="${td}${r ? '' : `color:${C.faint};`}">${usd(r ? r.drawer : null)}</td>
      <td align="center" style="${td}${r ? '' : `color:${C.faint};`}">${usd(r ? r.safe : null)}</td>
      <td align="center" style="${td}${r ? '' : `color:${C.faint};`}">${usd(r ? r.total : null)}</td>
    </tr>`;
  }).join('');

  // The district line only adds up the stores that actually reported. Summing a
  // partial morning as if it were the whole company is the one number in this
  // email that could be quietly, badly wrong — so when anything is missing the
  // total says how many stores it covers.
  const totalRow = `<tr>
    <td align="center" style="padding:13px 8px;background:${C.soft};text-align:center;white-space:nowrap;">
      <span style="font-size:12.5px;font-weight:800;color:${C.charcoal};">All Stores</span>
      ${missing.length ? `<div style="font-size:10.5px;font-weight:700;color:${C.red};margin-top:2px;">${STORES.length - missing.length} of ${STORES.length} reporting</div>` : ''}
    </td>
    <td align="center" style="${td}background:${C.soft};border-bottom:0;">${usd(sum('drawer'))}</td>
    <td align="center" style="${td}background:${C.soft};border-bottom:0;">${usd(sum('safe'))}</td>
    <td align="center" style="${td}background:${C.soft};border-bottom:0;font-size:16px;">${usd(sum('total'))}</td>
  </tr>`;

  const note = !anyData
    ? `<div style="margin:18px 2px 0;padding:14px;border:1px solid ${C.line};border-radius:12px;background:${C.soft};font-size:12.5px;font-weight:600;color:${C.red};">No Day End Report figures reached us for this date. Nothing was counted — this is a reporting gap, not an empty till.</div>`
    : missing.length
      ? `<div style="margin:18px 2px 0;padding:12px 14px;border:1px solid ${C.line};border-radius:12px;background:${C.soft};font-size:12px;font-weight:600;color:${C.muted};">No Day End Report figures for ${missing.map(s => esc(s)).join(', ')}. Those rows read “—” and are left out of the All Stores line.</div>`
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
        <div style="font-size:20px;font-weight:800;letter-spacing:-.02em;color:#ffffff;margin-top:2px;">Cash On Hand</div>
        <div style="font-size:12.5px;font-weight:600;color:rgba(255,255,255,.66);margin-top:2px;">Close of ${prettyDay(day)}${carried ? ' &middot; stores closed Sunday' : ''}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="height:3px;background:${C.sage};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:22px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:14px;overflow:hidden;">
      <tr>${th('Store', 'center', '19%')}${th('Cash Drawer', 'center', '27%')}${th('Safe', 'center', '27%')}${th('Total On Hand', 'center', '27%')}</tr>
      ${body}${totalRow}
    </table>
    ${note}
  </td></tr>
  <tr><td style="padding:16px;text-align:center;color:${C.faint};font-size:10.5px;border-top:1px solid ${C.line};background:${C.footBg};">Generated automatically by Speeks &middot; counted at close on ${prettyDay(day)}, read from each store's Day End Report.</td></tr>
</table></td></tr></table></body></html>`;
}

async function sendEmail(to: string[], subject: string, html: string) {
  const res = await fetch(GMAIL_RELAY, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
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
  // and this runs the following morning — except on Monday, when yesterday was
  // a shut Sunday and Saturday's close is the real last count.
  const today = centralToday();
  const asked = url.searchParams.get('day');
  const day = asked || lastOpenDay(today);
  const dryRun = url.searchParams.get('dryRun') === '1';
  const force = url.searchParams.get('force') === '1';
  // True only when we stepped over a closed Sunday, i.e. Monday's email. Says so
  // in the email, so a Saturday date landing on a Monday reads as intended
  // rather than as a report that failed to refresh.
  const carried = !asked && day !== addDays(today, -1);

  // Sunday: send nothing. Saturday's count goes out tomorrow instead. dryRun and
  // force still render/send, so this is testable and re-sendable on any day.
  if (!dryRun && !force && !asked && dowOf(today) === 0) {
    return new Response(JSON.stringify({
      ok: true, skipped: 'sunday — stores closed; Saturday goes out Monday', today, day,
    }, null, 2), { headers: cors });
  }

  try {
    // Already sent for this day? The 8am retry runs the same chain, and a merely
    // late first pass must not cost a duplicate email.
    if (!dryRun && !force) {
      const { data: prev } = await sb.from('cash_report_sends').select('day, sent_at').eq('day', day).maybeSingle();
      if (prev) {
        return new Response(JSON.stringify({ ok: true, skipped: 'already sent', day, sentAt: prev.sent_at }, null, 2), { headers: cors });
      }
    }

    const { data: cash, error } = await sb.from('store_cash')
      .select('store, drawer, safe, total').eq('day', day);
    if (error) throw new Error(error.message);

    const rows: Record<string, any> = {};
    (cash || []).forEach((r: any) => {
      const s = String(r.store || '').toUpperCase();
      if (STORES.includes(s)) rows[s] = r;
    });
    const missing = STORES.filter(s => !rows[s]);

    const html = buildEmail(day, rows, missing, carried);
    if (dryRun) return new Response(html, { headers: { ...cors, 'Content-Type': 'text/html' } });

    // Nothing at all reached us. Still send — a silent morning is
    // indistinguishable from "no news is good news", and the whole point of a
    // daily number is noticing the day it stops arriving.
    // ?to= sends this run somewhere else and touches nothing about the real
    // list. Without it the only way to prove the relay works is to mail the
    // actual recipient, which makes every test a live send — the reason the
    // weekly report and b2b-outreach both carry the same override.
    const override = (url.searchParams.get('to') || '').split(',').map(s => s.trim()).filter(Boolean);
    const { data: recips } = await sb.from('email_recipients').select('email').eq('list_key', LIST_KEY);
    const to = (recips || []).map((r: any) => r.email).filter(Boolean);
    const sendTo = override.length ? override : (to.length ? to : FALLBACK_TO);

    const total = STORES.reduce((a, s) => (rows[s] && rows[s].total != null) ? a + Number(rows[s].total) : a, 0);
    const subject = missing.length === STORES.length
      ? `Cash on hand — ${prettyDay(day)} — no figures received`
      : `Cash on hand — ${prettyDay(day)} — ${usd(total)}`;

    const relay = await sendEmail(sendTo, subject, html);
    // A ?to= test must NOT be recorded as the day's send. Recording it would
    // make the real 7am run see the day as already handled and stay silent —
    // testing the email would be the thing that stopped it arriving.
    if (!override.length) {
      await sb.from('cash_report_sends').upsert({
        day, sent_at: new Date().toISOString(), recipients: sendTo, stores: STORES.length - missing.length,
      }, { onConflict: 'day' });
    }

    return new Response(JSON.stringify({
      ok: true, day, carried, to: sendTo, test: override.length > 0,
      stores: STORES.length - missing.length, missing, relay,
    }, null, 2), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, day, error: String((e as Error)?.message || e) }, null, 2),
      { status: 500, headers: cors });
  }
});
