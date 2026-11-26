// credential-expiry — the email itself. No imports, on purpose: rendered by
// index.ts in production AND by a plain Node script for previews (Node 24 runs
// .ts directly), so the design can be checked without a deploy.
//
// The V4 airy family (processed-report, cash, weekly, usage, records,
// fb-boost-report): same palette, dark header with the bar tile, 3px sage rule,
// soft footer. Copied rather than shared because every report function carries
// its own copy. Ethan, 2026-11-21: "designed like all of our other Speeks email
// reports" — then: just the token(s) expiring this week, no how-to-renew (he
// asks Claude for that), so no summary tiles or renew cards either.

export type CredRow = {
  key: string;
  name: string;
  what: string;
  used_by: string;
  renew_steps: string;
  expires_at: string;  // ISO
  left: number;        // calendar days left in Central time; <= 0 = expired
};

const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
const STORE_COLOR: Record<string, string> = { OVL: '#7c3aed', LEE: '#2563eb', WSP: '#16a34a', MPL: '#ea580c', BAL: '#dc2626' };
const STORE_TINT: Record<string, string> = { OVL: '#f1ebfd', LEE: '#e8f0fb', WSP: '#e8f7ee', MPL: '#fdf0e7', BAL: '#fcecec' };
const STORE_RING: Record<string, string> = { OVL: '#ddd0fb', LEE: '#cfe0f7', WSP: '#c6ecd6', MPL: '#f8dcc7', BAL: '#f6d5d5' };
const C = {
  sage: '#1f9d57', charcoal: '#1a1c1e', app: '#f1f5f2', card: '#ffffff',
  soft: '#f7faf8', line: '#eaefeb', line2: '#f4f8f5',
  muted: '#64707c', faint: '#9aa6ad', red: '#d64545', amber: '#c27803', footBg: '#f7faf8',
};

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

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
  `<th${w ? ` width="${w}"` : ''} align="${align}" style="font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:${C.faint};background:${C.soft};padding:10px 8px;text-align:${align};border-bottom:1px solid ${C.line};">${t}</th>`;
const sub = (t: string, color: string = C.faint) =>
  `<div style="font-size:10.5px;font-weight:700;color:${color};margin-top:2px;line-height:1.35;">${t}</div>`;
const heading = (t: string, note = '') =>
  `<div style="margin:22px 2px 8px;font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${C.faint};">${t}${note ? ` <span style="text-transform:none;letter-spacing:0;font-weight:600;">&middot; ${note}</span>` : ''}</div>`;
const box = (inner: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:14px;overflow:hidden;">${inner}</table>`;
const td = (inner: string, align = 'left', extra = '') =>
  `<td align="${align}" style="padding:11px 8px;border-bottom:1px solid ${C.line2};font-size:13px;color:${C.charcoal};text-align:${align};vertical-align:top;${extra}">${inner}</td>`;

// Red once expired or a week out, amber inside 30 days, plain beyond.
const toneOf = (left: number) => (left <= 7 ? C.red : left <= 30 ? C.amber : C.charcoal);
const leftText = (left: number) =>
  left < 0 ? `Expired${sub(`${plural(-left, 'Day')} Ago`, C.red)}` : left === 0 ? `Expired${sub('Today', C.red)}` : plural(left, 'Day');

// eBay rows carry the store as their last word ("eBay refresh token — OVL"):
// show the store badge the other reports use instead of the bare code.
function nameCell(r: CredRow) {
  const m = r.key.match(/^ebay_refresh_([A-Z]{3})$/);
  if (m && STORES.includes(m[1])) {
    return `${badge(m[1])} <span style="font-weight:700;">eBay Connection</span>${sub('Refresh token for the store\'s eBay account')}`;
  }
  return `<span style="font-weight:700;">${esc(r.name)}</span>${r.used_by ? sub(esc(r.used_by)) : ''}`;
}

export function buildCredentialEmail(rows: CredRow[], undated: string[], todayYmd: string, test = false) {
  const due = rows.slice().sort((a, b) => a.left - b.left);
  const expired = due.filter((r) => r.left <= 0);
  const soonest = due[0];

  const subject = (test ? '[TEST] ' : '') + (expired.length
    ? `Expired: ${expired.length === 1 ? expired[0].name : plural(expired.length, 'credential')} — renew now`
    : `${due.length === 1 ? due[0].name : plural(due.length, 'credential')} expire${due.length === 1 ? 's' : ''} in ${plural(soonest.left, 'day')}`);

  const tableRows = due.map((r) => `<tr>
      ${td(nameCell(r))}
      ${td(esc(fmtDate(r.expires_at)), 'center', 'white-space:nowrap;')}
      ${td(leftText(r.left), 'center', `font-size:15px;font-weight:800;color:${toneOf(r.left)};white-space:nowrap;`)}
    </tr>`).join('');

  const undatedHtml = undated.length
    ? `${heading('No Date On File', 'Can Expire, Date Not Entered')}
       ${box(undated.map((n) => `<tr>${td(esc(n))}</tr>`).join(''))}`
    : '';

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.app};font-family:Inter,Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.app};padding:20px 10px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${C.card};border:1px solid ${C.line};border-radius:18px;overflow:hidden;">
  <tr><td style="background:#13181a;padding:20px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="40" valign="top">${heroTile()}</td>
      <td valign="middle" style="padding-left:13px;">
        <div style="font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#6ee7a7;">Speeks Technology${test ? ' &middot; Test Send' : ''}</div>
        <div style="font-size:20px;font-weight:800;letter-spacing:-.02em;color:#ffffff;margin-top:2px;">Expiring Credentials</div>
        <div style="font-size:12.5px;font-weight:600;color:rgba(255,255,255,.66);margin-top:2px;">${esc(fmtDate(todayYmd + 'T18:00:00Z'))} &middot; Renew within the week</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="height:3px;background:${C.sage};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:14px 12px;">
    ${heading('Expiring This Week')}
    ${box(`<tr>${th('Credential', 'left', '52%')}${th('Expires', 'center', '24%')}${th('Days Left', 'center', '24%')}</tr>${tableRows}`)}

    ${undatedHtml}
  </td></tr>
  <tr><td style="padding:16px;text-align:center;color:${C.faint};font-size:10.5px;border-top:1px solid ${C.line};background:${C.footBg};">Generated automatically by Speeks &middot; Sent once, a week before a key, secret or token the site uses expires. Change who gets it in Email Recipients &rarr; System Alerts &rarr; Expiring Credentials.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html };
}
