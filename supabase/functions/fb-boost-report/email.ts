// fb-boost-report — the email itself. No imports, on purpose: this file is
// rendered by index.ts in production AND by a plain Node script for previews
// (Node 24 runs .ts directly), so the design can be checked without a deploy.
//
// The V4 airy family (processed-report, cash, weekly, usage, records): same
// palette, dark header with the bar tile, 3px sage rule, soft footer. Copied
// rather than shared because every report function carries its own copy.

export type BoostRow = {
  store: string;
  sku: string;
  title: string;
  price: number | null;
  boostedAt: string;   // ISO
  endsAt: string;      // ISO
  days: number;
  budget: number;
  boostedBy: string | null;
  doneAt: string | null;
};

export type BoostReport = {
  weekStart: string;   // YYYY-MM-DD (Monday)
  weekEnd: string;     // YYYY-MM-DD (Sunday)
  now: string;         // ISO, when the report was built
  started: BoostRow[]; // boosts started in the week
  running: BoostRow[]; // still running when built
};

const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
const STORE_COLOR: Record<string, string> = { OVL: '#7c3aed', LEE: '#2563eb', WSP: '#16a34a', MPL: '#ea580c', BAL: '#dc2626' };
const STORE_TINT: Record<string, string> = { OVL: '#f1ebfd', LEE: '#e8f0fb', WSP: '#e8f7ee', MPL: '#fdf0e7', BAL: '#fcecec' };
const STORE_RING: Record<string, string> = { OVL: '#ddd0fb', LEE: '#cfe0f7', WSP: '#c6ecd6', MPL: '#f8dcc7', BAL: '#f6d5d5' };
const C = {
  sage: '#1f9d57', charcoal: '#1a1c1e', app: '#f1f5f2', card: '#ffffff',
  soft: '#f7faf8', line: '#eaefeb', line2: '#f4f8f5',
  muted: '#64707c', faint: '#9aa6ad', red: '#d64545', footBg: '#f7faf8',
};

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const usd = (n: number) => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
const ymd = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

const heroTile = () => {
  const bar = (h: number) =>
    `<td width="4" valign="bottom" style="padding:0 2px;"><div style="width:4px;height:${h}px;background:#6ee7a7;border-radius:2px;font-size:0;line-height:0;">&nbsp;</div></td>`;
  return `<table role="presentation" width="40" height="40" cellpadding="0" cellspacing="0" style="background:rgba(31,157,87,.20);border-radius:12px;"><tr><td align="center" valign="middle" height="40">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>${bar(10)}${bar(18)}${bar(13)}</tr></table>
  </td></tr></table>`;
};
const badge = (s: string) =>
  `<span style="display:inline-block;background:${STORE_TINT[s] || '#f1f5f9'};color:${STORE_COLOR[s] || C.muted};border:1px solid ${STORE_RING[s] || C.line};font-size:11px;font-weight:800;padding:2px 8px;border-radius:6px;letter-spacing:.5px;">${esc(s)}</span>`;
const th = (t: string, align = 'center', w = '') =>
  `<th${w ? ` width="${w}"` : ''} align="${align}" style="font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:${C.faint};background:${C.soft};padding:10px 6px;text-align:${align};border-bottom:1px solid ${C.line};">${t}</th>`;
const sub = (t: string, color: string = C.faint) =>
  `<div style="font-size:10.5px;font-weight:700;color:${color};margin-top:2px;line-height:1.35;">${t}</div>`;
const heading = (t: string, note = '') =>
  `<div style="margin:22px 2px 8px;font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${C.faint};">${t}${note ? ` <span style="text-transform:none;letter-spacing:0;font-weight:600;">&middot; ${note}</span>` : ''}</div>`;
const box = (inner: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:14px;overflow:hidden;">${inner}</table>`;
const td = (inner: string, align = 'left', extra = '') =>
  `<td align="${align}" style="padding:11px 6px;border-bottom:1px solid ${C.line2};font-size:13px;color:${C.charcoal};text-align:${align};vertical-align:top;${extra}">${inner}</td>`;

function tile(label: string, value: string, note = '', color: string = C.charcoal) {
  return `<td width="33%" align="center" style="padding:14px 6px;background:${C.soft};border:1px solid ${C.line};border-radius:12px;">
    <div style="font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:${C.faint};">${label}</div>
    <div style="font-size:20px;font-weight:800;color:${color};margin-top:4px;">${value}</div>
    ${note ? sub(note) : ''}
  </td>`;
}



export function buildBoostEmail(rep: BoostReport): string {
  const nowMs = Date.parse(rep.now);
  const boostedWeek = rep.started.reduce((a, r) => a + (r.budget || 0), 0);
  const endingSoon = rep.running.filter((r) => Math.ceil((Date.parse(r.endsAt) - nowMs) / 864e5) <= 3).length;

  // BY STORE = what each store has open right now and how much is boosted on
  // it (Ethan, 11-13: "however many boosts a store has open and boosted
  // amount"). The item lists and sold counts were taken out at his word.
  const byStore = STORES.map((s) => {
    const rows = rep.running.filter((r) => r.store === s);
    return { s, n: rows.length, amt: rows.reduce((a, r) => a + r.budget, 0) };
  });
  const big = 'font-size:15px;font-weight:800;';
  const none = (t: string) => `<span style="color:${C.faint};">${t}</span>`;
  const storeRows = byStore.map((x) => `<tr>
      ${td(badge(x.s), 'center')}
      ${td(x.n ? String(x.n) : none('0'), 'center', big)}
      ${td(x.n ? usd(x.amt) : none('—'), 'center', big)}
    </tr>`).join('');
  const openAmt = byStore.reduce((a, x) => a + x.amt, 0);
  const foot = (t: string, size = '15px') => `<td align="center" style="padding:12px 6px;background:${C.soft};font-size:${size};font-weight:800;color:${C.charcoal};text-align:center;">${t}</td>`;
  const total = `<tr>${foot('All Stores', '12.5px')}${foot(String(rep.running.length))}${foot(rep.running.length ? usd(openAmt) : none('—'))}</tr>`;

  const nothing = !rep.started.length && !rep.running.length;
  const empty = (t: string) => `<div style="padding:14px;border:1px solid ${C.line};border-radius:12px;background:${C.soft};font-size:12.5px;font-weight:600;color:${C.muted};">${t}</div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.app};font-family:Inter,Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.app};padding:20px 10px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${C.card};border:1px solid ${C.line};border-radius:18px;overflow:hidden;">
  <tr><td style="background:#13181a;padding:20px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="40" valign="top">${heroTile()}</td>
      <td valign="middle" style="padding-left:13px;">
        <div style="font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#6ee7a7;">Speeks Technology</div>
        <div style="font-size:20px;font-weight:800;letter-spacing:-.02em;color:#ffffff;margin-top:2px;">Facebook Boosts</div>
        <div style="font-size:12.5px;font-weight:600;color:rgba(255,255,255,.66);margin-top:2px;">Week of ${ymd(rep.weekStart)} &ndash; ${ymd(rep.weekEnd)}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="height:3px;background:${C.sage};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:14px 12px;">
    ${nothing ? empty('No boosts were recorded this week, and none are running.') : `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="border-collapse:separate;"><tr>
      ${tile('Boosted This Week', usd(boostedWeek))}
      ${tile('Boosts Started', String(rep.started.length))}
      ${tile('Running Now', String(rep.running.length), endingSoon ? `${endingSoon} Ending in 3 Days` : '')}
    </tr></table>

    ${heading('By Store', 'boosts open now')}
    ${box(`<tr>${th('Store', 'center', '30%')}${th('Open Boosts', 'center', '30%')}${th('Boosted Amount', 'center', '40%')}</tr>${storeRows}${total}`)}
    `}
  </td></tr>
  <tr><td style="padding:16px;text-align:center;color:${C.faint};font-size:10.5px;border-top:1px solid ${C.line};background:${C.footBg};">Generated automatically by Speeks &middot; Boosts are recorded by staff with <b>Mark Boosted</b> in the Marketplace Lister&rsquo;s Listed tab &mdash; Facebook doesn&rsquo;t report them to us. Boosted amount is the total each boost was set to, not what Facebook has charged so far.</td></tr>
</table></td></tr></table></body></html>`;
}