// ============================================================================
// netprofit-summary.gs — the summary strip on the NET PROFIT tab.
//
//   npSummaryPreview()   logs every cell it would touch. Writes NOTHING.
//   npSummaryApply()     the same run, for real.
//
// Four things the day-grid writer deliberately does not touch:
//   1. Days this month / Days Thru month   (the two #DIV/0! sources)
//   2. green / red on the % of goal cell
//   3. last month's Revenue, GP and Net Profit
//   4. YoY revenue, where a prior year actually exists
//
// GEOMETRY — measured by npProbeSummary and npProbeGrid on 2026-08-27, never
// assumed. Offsets are relative to each block's day-number column.
//
//   ROW 1   +3 "% of GP Goal"   +4 the percentage        <- coloured here
//   ROW 2   +1 month date  +2 store code  +3 "NP Goal"  +4 the goal value
//   ROW 38  +1 "Last month"  +2 REVENUE   +5 GP     (+7 or +6 = the "GP" text)
//   ROW 39                                +5 NET PROFIT
//   ROW 40  +1 "Days this month"  +2 value
//   ROW 41  +1 "Days Thru month"  +2 value   +4 "YoY"  +5 "Revenue"
//   ROW 42  +1 "Net GP MTD"       +2 =NP TTL +4 "Last"     +5 last year
//   ROW 43  +1 "Net GP Tracking"  +2 formula +4 "Current"  +5 this year
//   ROW 44  +1 "Net GP MoM"       +2 formula +4 "Inc/Dec"  +5 formula
//   Rows are LOCATED by their label text, never counted to.
//
// ⚠️ THE LABELS ON THIS TAB DO NOT SIT NEXT TO THE VALUES THEY NAME.
// "GP" and "Net Profit" are written at +7 in four blocks and +6 in the other
// two, but every one of the six MoM formulas reads +5:
//     OVL =(C43/F39)-1   LEE =(U43/X39)-1   WSP =(AM43/AP39)-1
//     MPL =(BE43/BH39)-1 BAL =(BW43/BZ39)-1 TTL =(CO43/CR39)-1
// Six for six. The FORMULAS are the authority on where a value is read from;
// the text is decoration that was pasted a column or two off. Writing next to
// the label would put last month's Net Profit in a cell nothing reads, and
// leave the MoM denominator empty — which shows as #DIV/0!, not as an error
// anyone would trace back to here.
//
// ⚠️ AND LAST MONTH'S REVENUE IS NOT NEXT TO ITS LABEL EITHER. Every day row
// carries  =(D5/C$38)-1  in the MOM column, so C38 (+2) is last month's
// REVENUE. Its only label is "Last month" at +1.
//
// Prefixed NPX_/_npx: one Apps Script project is one global scope.
// ============================================================================

// --- offsets, relative to a block's day column ------------------------------
var NPX_OFF_LABEL    = 1;   // B — "Last month", "Days this month", ...
var NPX_OFF_VAL_L    = 2;   // C — those values, and last-month REVENUE
var NPX_OFF_YOY_LBL  = 4;   // E — "YoY" / "Last" / "Current" / "Inc/Dec"
var NPX_OFF_VAL_R    = 5;   // F — last-month GP + Net Profit, and the YoY values
// ⚠️ THE LAST-MONTH STRIP WAS RELAID BY HAND ON 2026-08-31 AND THESE ARE THE
// MEASURED ADDRESSES, not the old ones. Ethan replaced the single "Last month"
// label with three named ones and moved Net Profit up onto the same row:
//
//   BEFORE            B38 "Last month"   C38 revenue   F38 GP   F39 Net Profit
//   NOW               B38 "Last Month Revenue"  C38 revenue
//                     E38 "Last Month GP"       F38 GP
//                     I38 "Last Month NP"       J38 net profit
//
// ⚠️ THE RENAME ALONE BROKE THE WHOLE SYNC, SILENTLY. _npxFindRow matches the
// label EXACTLY, so "Last Month Revenue" did not equal "Last month", the row
// came back -1, and _npxSync logged one line and RETURNED — no last-month
// figures, no Days Thru, no YoY, no goal percentage, and no failure email
// either, because returning is not throwing. The grid above kept filling, so
// nothing looked wrong. That is why the anchor label is a named constant now.
//
// Verified identical in all six blocks by npProbeSummary (2026-08-31): the
// labels sit at +1 / +4 / +8 and the values one column right of each, at
// +2 / +5 / +9, in OVL, LEE, WSP, MPL, BAL and TTL alike.
var NPX_LM_LABEL     = 'Last Month Revenue';   // the anchor _npxFindRow looks for
var NPX_OFF_LM_GPLBL = 4;   // E — "Last Month GP"
var NPX_OFF_LM_NPLBL = 8;   // I — "Last Month NP"
var NPX_OFF_LM_NP    = 9;   // J — the net profit VALUE, now on the same row as
                            //     revenue and GP rather than the row below
// Row 39: the month-over-month percentages, written by _npxSync so all six
// blocks stay identical and survive the October roll. See _npxMomFormula.
var NPX_MOM_ROW_OFF  = 1;   // one row under the last-month strip

var NPX_OFF_GOAL_LBL = 3;   // D — "% of GP Goal" (row 1), "NP Goal" (row 2)
var NPX_OFF_GOAL_VAL = 4;   // E — the percentage (row 1), the goal (row 2)
var NPX_OFF_REVTRACK = 3;   // D — Rev Tracking, the source of YoY "Current"
// H — GP Tracking. Same shape as the other two: (cumulative / days so far) *
// days in month, so each cell is a projection of the whole month.
var NPX_OFF_GPTRACK  = 7;
var NPX_OFF_NP       = 12;  // M — NP, the tab's own net profit (TTL row = the month)
var NPX_OFF_NPTOTAL  = 13;  // N — NP Total, cumulative net profit banked
var NPX_OFF_NPTRACK  = 14;  // O — NP Tracking, the projected full month

// ---------------------------------------------------------------------------
// 2025 revenue, for YoY. Bare numbers on purpose: history does not change, and
// a constant here is auditable without a database round trip on every run.
//
// ⚠️ WSP'S 2025-06 IS A STUB AND IS DELIBERATELY ABSENT. WSP opened mid-June
// 2025 and booked 8,700.89 that month against ~50k in July. A full June 2026
// against half a June 2025 prints about +500% and reads as a record month.
// June is the one month WSP has no honest YoY for.
//
// MPL and BAL have NO 2025 AT ALL, so they get no YoY block rather than a row
// of blanks that looks broken. They become comparable in 2027.
// ---------------------------------------------------------------------------
var NPX_YOY_2025 = {
  OVL: { '01': 73350.54, '02': 80845.20, '03': 78859.65, '04': 88166.34,
         '05': 109923.94, '06': 115570.36, '07': 132120.44, '08': 105622.08,
         '09': 92304.08, '10': 112487.46, '11': 108405.81, '12': 131765.92 },
  LEE: { '01': 35302.98, '02': 48500.14, '03': 58572.74, '04': 50221.01,
         '05': 54412.59, '06': 43937.87, '07': 55144.21, '08': 52224.24,
         '09': 72414.06, '10': 69750.14, '11': 83665.17, '12': 75034.04 },
  WSP: { '07': 49968.06, '08': 61892.07, '09': 69307.11,
         '10': 81737.06, '11': 89628.63, '12': 77261.43 }
};

// The company YoY is same-store or it is fiction: "Current" already spans five
// stores and "Last" can only ever span three.
var NPX_SAME_STORE = ['OVL', 'LEE', 'WSP'];

// ⚠️ The "% of GP Goal" cell computes  last-non-empty(M5:M35) / $E$2  — the NP
// column, so it is an NP percentage carrying a GP label, and M is ONE DAY's net
// profit, not the month's. On the 14th it reads that one day against a whole
// month's goal and prints something like 3%. Repointed at NP Tracking (+14),
// the projected full month, which is the only version of this number that is
// meaningful to colour on a Tuesday. Set false to leave it exactly as found.
var NPX_FIX_GOAL_FORMULA = true;

// Which number is "% of goal"? Both are defensible and they read very
// differently on a Tuesday, so this is a choice, not a fact:
//   'tracking' — NP Tracking (+14), the projected full month. "On pace for 96%
//                of goal." Sits at roughly 100% all month when a store is on
//                track, so green/red means something every day.
//   'actual'   — NP Total (+13), what is actually banked so far. "We have 47%
//                of the month's goal in hand." Honest, but it is red for the
//                first three weeks of every month by arithmetic, and a light
//                that is always red is not a light.
// 'tracking' also matches the cell next door: YoY "Current" already reads the
// Rev TRACKING column, so the tab's own convention is to compare projections.
var NPX_GOAL_BASIS = 'tracking';

var NPX_GREEN_BG = '#d9ead3', NPX_GREEN_FG = '#274e13';
var NPX_RED_BG   = '#f4cccc', NPX_RED_FG   = '#990000';

var NPX_TZ = 'America/Chicago';
var NPX_SHOPIFY_WALL_DAYS = 60;   // Shopify hides orders older than this without read_all_orders

var NPX_LASTMONTH_KEY = 'NPX_LAST_MONTH_FOR';
var NPX_FORCE_LAST_MONTH = false;   // set true for one run to redo last month

// ⚠️ LAST MONTH COSTS 85 SECONDS A STORE AND APPS SCRIPT ALLOWS SIX MINUTES.
// Five stores is roughly seven, so on 2026-09-02 the run died inside BAL with
// "Exceeded maximum execution time" — and because every cell is written in one
// batch at the END, dying there wrote NOTHING. Not last month, not Days Thru,
// not the goal formulas. From the outside that reads as "it ran everything
// except the days thru the month", which is exactly how it was reported, and
// nothing in the log said the run had been killed rather than finished.
//
// Two changes, and they only matter together:
//   * a BUDGET. Stop starting new fetches once the time is nearly up, name the
//     stores that were left, and carry on to write everything else. A short
//     last month is a gap; a killed run is a blank sheet.
//   * a CACHE. Each store's month is banked the moment it lands, so a run that
//     gets three stores is three stores of progress and not a retry from cold.
//     Successive passes finish it — and there are two a day now.
//
// This is the same shape as the 60-day-wall guard above: refuse the part that
// cannot be done, do the rest, and say plainly what is missing.
var NPX_LM_CACHE_KEY = 'NPX_LAST_MONTH_CACHE';
// Overwritten by npsDailyRefresh with what is ACTUALLY left of its six minutes,
// because _npWrite has already spent some of them and its share grows through
// the month. The default suits a manual run of npSummaryPreview/Apply.
var NPX_BUDGET_MS = 210000;   // 3.5 minutes

var NPX_MONEY = '$#,##0.00';
var NPX_PCT   = '0.0%';

function npSummaryPreview() { _npxSync(true); }
function npSummaryApply()   { _npxSync(false); }

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function _npxLastDay(ym) {
  var y = Number(ym.slice(0, 4)), m0 = Number(ym.slice(5, 7)) - 1;
  return ym + '-' + ('0' + new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate()).slice(-2);
}

function _npxDaysIn(ym) {
  var y = Number(ym.slice(0, 4)), m0 = Number(ym.slice(5, 7)) - 1;
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

function _npxPrevYm(ym) {
  var y = Number(ym.slice(0, 4)), m0 = Number(ym.slice(5, 7)) - 1;
  var py = m0 === 0 ? y - 1 : y, pm0 = (m0 + 11) % 12;
  return py + '-' + ('0' + (pm0 + 1)).slice(-2);
}

function _npxA1(col0, row0) { return _npColLetter(col0) + (row0 + 1); }

function _npxAbs(col0, row0) { return '$' + _npColLetter(col0) + '$' + (row0 + 1); }

// Find a row by the EXACT text in one column. Never count to a row: somebody
// inserting a line above the grid would otherwise shift every write silently.
function _npxFindRow(values, col, label) {
  for (var r = 0; r < values.length; r++) {
    if (String(values[r][col]).trim().toLowerCase() === label.toLowerCase()) return r;
  }
  return -1;
}

// The month the grid currently holds. NP_FROM is what the day-grid writer used,
// so it is the only thing guaranteed to agree with the numbers on the tab.
function _npxGridMonth() {
  if (typeof NP_FROM === 'string' && /^\d{4}-\d{2}/.test(NP_FROM)) return NP_FROM.slice(0, 7);
  throw new Error('NP_FROM is not a YYYY-MM-DD date; cannot tell which month the grid holds');
}

// Pull one whole month from the collector. Saves and restores NP_FROM/NP_TO —
// they are globals the day-grid writer also reads, and leaving them moved would
// silently retarget the next npWriteApply at the wrong month.
function _npxFetchMonth(store, ym) {
  var saveF = NP_FROM, saveT = NP_TO;
  NP_FROM = ym + '-01';
  NP_TO = _npxLastDay(ym);
  try { return _npFetchStore(store); }
  finally { NP_FROM = saveF; NP_TO = saveT; }
}

// ---------------------------------------------------------------------------
// LAST MONTH, READ OFF ITS OWN TAB.
//
// From 2026-09 every closed month keeps its tab, and that tab's TTL row already
// holds the three figures in the tab's own arithmetic — the same formulas the
// bonus is read from. Reading them beats refetching from Shopify twice over:
//
//   1. IT IS WALL-PROOF. A closed month drifts past the 60-day Shopify order
//      wall within weeks, after which a refetch silently loses the fees and
//      reports a Net Profit that is too high. The tab does not decay.
//   2. IT CANNOT DISAGREE WITH ITSELF. A refetch re-derives from live Shopify
//      data that has moved on — a late refund, a reweigh — so last month's
//      figure on the new tab would stop matching the closed tab it came from.
//      The month was closed on purpose; this reads the closed answer.
//
// Falls back to the collector only when NO tab holds that month.
//
// ⚠️ FOUND BY ITS MONTH HEADER, NOT BY ITS NAME. This looked for one name —
// "Net Profit Aug 26" — and August does not have that name: it is the single
// pre-rollover tab, NP_TAB_LEGACY, because the rollover COPIED it to make
// September rather than renaming it. So the lookup missed, the code fell
// through to Shopify, and September's MoM denominator was re-derived live.
//
// That is not a slower route to the same number, it is a DIFFERENT number.
// August's tab carries our restatements — the Marketplace Connect duplicates,
// the mirror-back refunds, every pinned cell — and Shopify knows about none of
// them. Ethan spotted it on OVL: the sheet and the refetch disagree, and the
// sheet is the one the bonus was paid from.
//
// So: narrow by NAME (only a Net Profit tab is a candidate at all), then decide
// by the tab's OWN row-2 month header, which is a real Date this script writes.
// Every candidate is logged with the month it claims, so a miss says why.
function _npxLastMonthTabFor(ss, prevYm) {
  var want = _npTabName(prevYm);
  var sheets = ss.getSheets();
  var candidates = [], byHeader = [];

  for (var i = 0; i < sheets.length; i++) {
    var nm = sheets[i].getName();
    // Only a Net Profit tab can be one. A Sales tab has a different stride, and
    // reading a TTL row off it at Net Profit's offsets would land inside
    // another store's block and return numbers that look perfectly real.
    if (nm.indexOf(NP_TAB_PREFIX) !== 0 && nm !== NP_TAB_LEGACY) continue;
    var hdr = '';
    try {
      var v = sheets[i].getRange(2, NP_BASES.OVL + NPX_OFF_LABEL + 1).getValue();
      if (v instanceof Date) hdr = Utilities.formatDate(v, NPX_TZ, 'yyyy-MM');
    } catch (e) { hdr = ''; }
    candidates.push(nm + ' [' + (hdr || 'no month header') + ']');
    if (nm === want) return { sh: sheets[i], name: nm, how: 'by name' };
    if (hdr === prevYm) byHeader.push(sheets[i]);
  }

  Logger.log('  Net Profit tabs on the workbook: %s',
    candidates.length ? candidates.join(' | ') : 'none');

  if (byHeader.length === 1) {
    return { sh: byHeader[0], name: byHeader[0].getName(), how: 'by its row-2 month header' };
  }
  if (byHeader.length > 1) {
    // ⚠️ REFUSE. Two tabs claiming the same month is a real possibility after a
    // rollover that was run twice, and picking one of them silently would put
    // an arbitrary month's figures in as the bonus denominator.
    Logger.log('  !! %s tabs claim %s (%s) — refusing to guess which is last month.',
      byHeader.length, prevYm,
      byHeader.map(function (x) { return x.getName(); }).join(', '));
  }
  return null;
}

function _npxLastMonthFromTab(ss, prevYm, found) {
  // The caller has usually located it already — the skip decision needs to know
  // whether a tab exists before it can be made — so scanning again would print
  // the candidate list twice and read like two different searches.
  found = found || _npxLastMonthTabFor(ss, prevYm);
  if (!found) return null;
  var sh = found.sh;
  Logger.log('  last month is on tab "%s" (found %s)', found.name, found.how);

  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var vals = sh.getRange(1, 1, lastRow, lastCol).getValues();

  var ttl = -1;
  for (var r = NP_HEADER_ROWS; r < lastRow; r++) {
    if (String(vals[r][NP_BASES.OVL]).trim().toUpperCase() === 'TTL') { ttl = r; break; }
  }
  if (ttl < 0) {
    Logger.log('  !! tab "%s" has no TTL row — falling back to the collector', found.name);
    return null;
  }

  var out = {}, missing = [];
  for (var i = 0; i < NP_ORDER.length; i++) {
    var st = NP_ORDER[i], b = NP_BASES[st];
    var rev = Number(vals[ttl][b + NP_OFF_SALES]);
    var gp  = Number(vals[ttl][b + NPX_OFF_VAL_R]);
    var np  = Number(vals[ttl][b + NPX_OFF_NP]);
    // An empty or #N/A TTL means that month was never finished. Refusing beats
    // reading a zero as a real month with no sales.
    if (!isFinite(rev) || !isFinite(gp) || !isFinite(np) || rev === 0) { missing.push(st); continue; }
    out[st] = { revenue: r2c(rev), gp: r2c(gp), np: r2c(np), source: 'tab' };
  }
  if (missing.length) {
    Logger.log('  !! tab "%s" has no usable TTL for %s — falling back to the collector for all five',
      found.name, missing.join(', '));
    return null;
  }
  return out;
}

// Last month's totals, banked per store as each one lands.
//
// ⚠️ KEYED BY THE MONTH, AND A DIFFERENT MONTH THROWS THE WHOLE THING AWAY.
// A cache that outlived its month would serve August's revenue as September's
// MoM denominator on the 1st of October, silently and forever — the marker
// would then mark it done. Cheaper to refetch than to be wrong.
function _npxLmCacheLoad(prevYm) {
  if (NPX_FORCE_LAST_MONTH) return {};
  var raw = PropertiesService.getScriptProperties().getProperty(NPX_LM_CACHE_KEY);
  if (!raw) return {};
  var c = null;
  try { c = JSON.parse(raw); } catch (e) { return {}; }
  return (c && c.ym === prevYm && c.stores) ? c.stores : {};
}

function _npxLmCacheSave(prevYm, store, tot) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(NPX_LM_CACHE_KEY), c = null;
  try { c = raw ? JSON.parse(raw) : null; } catch (e) { c = null; }
  if (!c || c.ym !== prevYm) c = { ym: prevYm, stores: {} };
  c.stores[store] = tot;
  props.setProperty(NPX_LM_CACHE_KEY, JSON.stringify(c));
}

function r2c(n) { return Math.round(n * 100) / 100; }

// Revenue / GP / Net Profit for a whole month in the tab's OWN terms:
//   NP = Sales - Cost - eBay Fee - Shipping - CC Fee - 7% of Sales
// which is M36 =B36-E36-J36-K36-L36-(B36*0.07), read off the sheet itself.
function _npxMonthTotals(data) {
  var s = 0, c = 0, e = 0, sh = 0, cc = 0, naE = 0, naS = 0, blind = 0, sellingDays = 0;
  for (var i = 0; i < data.days.length; i++) {
    var x = data.days[i];
    var sales = Number(x.net_sales) || 0;
    s += sales;
    c += Number(x.cost) || 0;
    cc += Number(x.cc_fee) || 0;
    if (x.ebay_fee === null || x.ebay_fee === undefined) naE++; else e += Number(x.ebay_fee);
    if (x.shipping_cost === null || x.shipping_cost === undefined) naS++; else sh += Number(x.shipping_cost);
    // ⚠️ THE 60-DAY SHOPIFY WALL. Sales and Cost come from ShopifyQL, which has
    // no age limit. Every fee comes from the ORDERS api, and without the
    // read_all_orders scope Shopify simply does not return orders older than 60
    // days — no error, no empty result, just orders that are not there. The fees
    // then arrive as 0 rather than null, so the =NA() guard never fires and Net
    // Profit comes out CONFIDENTLY TOO HIGH.
    // Measured 2026-08-27: OVL June had 27 of 30 days like this and reported
    // $62,700 of Net Profit on $1,198 of total fees. The first day with data was
    // June 28 — exactly 60 days back, to the day.
    // A real selling day with cost of goods and no card fee, no shipping and no
    // eBay fee has not happened; that shape means the data is missing.
    if (sales > 0) {
      sellingDays++;
      if (!Number(x.ebay_fee) && !Number(x.shipping_cost) && !Number(x.cc_fee)) blind++;
    }
  }
  var r2 = function (n) { return Math.round(n * 100) / 100; };
  return {
    revenue: r2(s),
    gp: r2(s - c),
    np: r2(s - c - e - sh - cc - (s * 0.07)),
    // A missing fee column does not make Net Profit unknown, it makes it too
    // HIGH — the formula subtracts those cells and a blank is arithmetic zero.
    // Revenue and GP are still sound, so they are written either way.
    npTrustworthy: naE === 0 && naS === 0 && blind <= Math.floor(sellingDays * 0.2),
    naEbay: naE, naShip: naS, blind: blind, sellingDays: sellingDays,
    days: data.days.length
  };
}

// ---------------------------------------------------------------------------
// the worker
// ---------------------------------------------------------------------------

function _npxSync(preview) {
  var npxT0 = new Date().getTime();
  var ss = SpreadsheetApp.openById(NP_SHEET_ID);

  // The month decides the tab, so it has to be known first. `var` hoists but
  // the VALUE does not: resolving the tab above this line passed `undefined`
  // as the month and silently fell back to the legacy tab.
  var ym = _npxGridMonth();
  var prevYm = _npxPrevYm(ym);
  var daysIn = _npxDaysIn(ym);
  var mm = ym.slice(5, 7);

  var sh = _npTab(ss, ym);
  if (!sh) return;

  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();

  Logger.log('%s — grid holds %s (%s days); last month is %s',
    preview ? 'PREVIEW (nothing will be written)' : 'APPLY', ym, daysIn, prevYm);

  var writes = [];
  var skips  = [];

  // A formula already in a cell is the workbook's lock convention or somebody's
  // edit. Ours to replace only where we say so explicitly.
  function plan(col0, row0, what, value, fmt, note, replaceFormula) {
    var a1 = _npxA1(col0, row0);
    var existingF = String(formulas[row0][col0]).trim();
    var existingV = values[row0][col0];
    if (existingF !== '' && !replaceFormula) {
      skips.push(a1 + ' (' + what + ') — formula already there: ' + existingF);
      return;
    }
    // ⚠️ NEVER SILENTLY REPLACE SOMEBODY'S TEXT. Numbers and dates in these
    // cells are ours to maintain; a WORD in one is a label, and a label sitting
    // where this script expected a blank means the block is not shaped the way
    // the probe suggested. CP2 is the case that proved it: it holds "TTL", the
    // block's own name, exactly where the five store blocks hold "NP Goal".
    // Writing there would have erased the company block's title.
    // Deliberate relabels pass replaceFormula and are unaffected.
    if (typeof existingV === 'string' && existingV.trim() !== '' && !replaceFormula) {
      if (existingV.trim().toLowerCase() !== String(value).trim().toLowerCase()) {
        skips.push(a1 + ' (' + what + ') — text already there: "' + existingV + '"');
      }
      return;
    }
    // Rewriting a cell with what it already holds is noise in the log and churn
    // on the sheet, and it buries the handful of writes that DO change
    // something. Only report a real change. This matters most for the YoY
    // "Current" formulas: OVL and LEE already hold exactly the formula this
    // script generates, so without this every run would claim to have rewritten
    // them.
    if (existingF !== '' && existingF === String(value)) return;
    if (existingF === '' && String(existingV) === String(value)) return;
    writes.push({ a1: a1, what: what, value: value, old: (existingF || existingV),
                  isFormula: String(value).charAt(0) === '=', fmt: fmt, note: note });
  }

  var blocks = [];
  for (var i = 0; i < NP_ORDER.length; i++) blocks.push([NP_ORDER[i], NP_BASES[NP_ORDER[i]]]);
  blocks.push(['TTL', NP_TTL_BASE]);

  // --- locate every row we touch, by label ---------------------------------
  var rowTtl0      = _npxFindRow(values, NP_BASES.OVL, 'TTL');
  var rowLastMonth = _npxFindRow(values, NP_BASES.OVL + NPX_OFF_LABEL, NPX_LM_LABEL);
  var rowDaysIn    = _npxFindRow(values, NP_BASES.OVL + NPX_OFF_LABEL, 'Days this month');
  var rowDaysThru  = _npxFindRow(values, NP_BASES.OVL + NPX_OFF_LABEL, 'Days Thru month');
  var rowYoY       = _npxFindRow(values, NP_BASES.OVL + NPX_OFF_YOY_LBL, 'YoY');
  if (rowTtl0 < 0 || rowLastMonth < 0 || rowDaysIn < 0 || rowDaysThru < 0 || rowYoY < 0) {
    Logger.log('!! could not locate the summary rows by label (TTL=%s LastMonth=%s DaysIn=%s '
      + 'DaysThru=%s YoY=%s). The tab layout changed — re-run npProbeSummary.',
      rowTtl0 + 1, rowLastMonth + 1, rowDaysIn + 1, rowDaysThru + 1, rowYoY + 1);
    return;
  }

  // Day rows run from just under the header to just above TTL. Derived, so an
  // inserted row cannot silently pull the TTL row into a FILTER range and add
  // the month's own total to itself.
  var firstDay1 = NP_HEADER_ROWS + 1;
  var lastDay1  = (rowTtl0 - 1) + 1;
  Logger.log('rows located: days %s-%s, TTL=%s, Last month=%s, Days this month=%s, '
    + 'Days Thru=%s, YoY=%s',
    firstDay1, lastDay1, rowTtl0 + 1, rowLastMonth + 1, rowDaysIn + 1,
    rowDaysThru + 1, rowYoY + 1);

  // === 1. Days this month / Days Thru month =================================
  // Both are CHAINS: only OVL holds a real value and the other five read
  // =C40 / =C41 off it. The formula guard means we naturally write one cell.
  //
  // Days Thru is DERIVED from the data, never incremented — same rule as the
  // Sales Summary. A missed morning, a double run, or a re-run of a closed
  // month cannot drift it, because it is a measurement rather than a counter.
  var thru = 0;
  for (var b = 0; b < NP_ORDER.length; b++) {
    var sBase = NP_BASES[NP_ORDER[b]];
    for (var r = NP_HEADER_ROWS; r < rowTtl0; r++) {
      var dayNum = parseInt(values[r][sBase], 10);
      if (!dayNum) continue;
      var sales = values[r][sBase + NP_OFF_SALES];
      if (sales === '' || sales === null) continue;
      if (dayNum > thru) thru = dayNum;
    }
  }
  Logger.log('Days Thru month, derived from the last day carrying Sales: %s', thru);
  if (!thru) {
    Logger.log('  !! no day carries Sales yet — leaving Days Thru alone rather than writing 0, '
      + 'which is the value that produced the #DIV/0! in the first place');
  }

  for (var bi = 0; bi < blocks.length; bi++) {
    var bName = blocks[bi][0], bBase = blocks[bi][1];
    plan(bBase + NPX_OFF_VAL_L, rowDaysIn, bName + ' days this month', daysIn, '0');
    if (thru) plan(bBase + NPX_OFF_VAL_L, rowDaysThru, bName + ' days thru', thru, '0');
    // The tab's own record of which month it holds. Nothing computes from it,
    // but a row-2 header reading July over September's numbers is exactly how
    // a wrong month gets believed.
    //
    // It is a CHAIN like the two above it — T2 =B2, AL2 =T2, BD2 =AL2, BV2
    // =BD2 — so only OVL carries a real date. TTL was the one link never
    // joined up. Continue the chain rather than writing a sixth literal that
    // would sit unchanged if anyone edited B2 by hand.
    if (bi === 0) {
      plan(bBase + NPX_OFF_LABEL, 1, bName + ' month header',
           new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1), 'ddd mmm dd yyyy');
    } else {
      plan(bBase + NPX_OFF_LABEL, 1, bName + ' month header',
           '=' + _npxA1(blocks[bi - 1][1] + NPX_OFF_LABEL, 1), 'ddd mmm dd yyyy');
    }
  }

  // === 3. last month's Revenue, GP and Net Profit ============================
  // Last month does not change, so fetching five whole months from the
  // collector on every 2pm run would be five slow calls a day to re-derive a
  // number that was already right. Done once per month, and the guard is
  // BOTH the marker and the cell: a marker alone would skip forever if
  // somebody cleared the cells, which is the failure that looks like the
  // feature was never built.
  // ⚠️ THE WALL IS A DATE, SO CHECK THE DATE — do not wait to notice it in the
  // data. The blind-day test below catches a month that is wholly behind the
  // 60-day line, but every MONTH CLOSE lands on a month whose first day or two
  // has just crossed it: closing August on Oct 1 puts Aug 1 one day past. One
  // or two hidden days out of 31 is under any sensible blind-day threshold, so
  // the heuristic would pass it and write a Net Profit missing two days of fees.
  // Refusing is safe and self-heals: the very next 2pm refresh has the new month
  // in the grid, which makes the just-closed month "last month" at ~31 days old,
  // comfortably inside the wall, and writes it properly.
  var wallBack = new Date();
  wallBack.setDate(wallBack.getDate() - NPX_SHOPIFY_WALL_DAYS);
  var wallYmd = Utilities.formatDate(wallBack, NPX_TZ, 'yyyy-MM-dd');
  var behindWall = (prevYm + '-01') < wallYmd;

  // ⚠️ AND LAST MONTH MUST ACTUALLY BE OVER. Setting NP_FROM to September on
  // Aug 28 to prepare the new tab makes "last month" August — a month with
  // three days still to run. Writing it would put a PARTIAL August in as the
  // MoM denominator, and the once-per-month marker would then treat it as done
  // and never refetch, locking a part-month figure in for all of September.
  // Compared as months in the stores' own timezone: the script's clock is not
  // necessarily Central, and on the 1st that is a whole month of difference.
  var todayYm = Utilities.formatDate(new Date(), NPX_TZ, 'yyyy-MM');
  var monthUnfinished = prevYm >= todayYm;

  // ⚠️ THE MARKER RECORDS WHERE THE FIGURE CAME FROM, NOT JUST THAT IT EXISTS.
  // It used to hold the month alone, which meant "written" and "written from the
  // right place" were the same claim. They are not: on 2026-09-02 last month was
  // written from Shopify because the tab lookup could not find August, the run
  // marked it done, and the very next run — with the lookup FIXED — skipped it
  // and left the wrong number sitting there. From the outside the fix simply did
  // not work, and nothing said why.
  //
  // "2026-09|tab" or "2026-09|shopify". A bare month is a marker from before
  // this change and is read as shopify, which is what it was.
  var lmProps = PropertiesService.getScriptProperties();
  var lmMark = String(lmProps.getProperty(NPX_LASTMONTH_KEY) || '');
  var lmDone = lmMark === ym || lmMark.indexOf(ym + '|') === 0;
  var lmSrc  = lmMark.indexOf('|') >= 0 ? lmMark.split('|')[1] : 'shopify';
  var lmCell = values[rowLastMonth][NP_BASES.OVL + NPX_OFF_VAL_L];
  var lmSkip = lmDone && typeof lmCell === 'number' && !NPX_FORCE_LAST_MONTH;
  if (lmSkip) {
    Logger.log('\n--- last month (%s): already written for %s from %s (OVL reads %s) — not '
      + 'refetching. Set NPX_FORCE_LAST_MONTH = true to redo it. ---', prevYm, ym, lmSrc, lmCell);
  }
  if (behindWall && !lmSkip) {
    Logger.log('\n!! %s begins behind the %s-day Shopify order wall (oldest visible day is %s). '
      + 'Revenue and GP come from ShopifyQL and are still written; NET PROFIT IS NOT, because '
      + 'the hidden days contribute no fees and a short fee makes NP too HIGH. This is normal '
      + 'on a month-close night — the next daily refresh writes it properly, once the grid '
      + 'holds the new month and last month is only ~31 days old.',
      prevYm, NPX_SHOPIFY_WALL_DAYS, wallYmd);
  }
  Logger.log(lmSkip ? '' : '\n--- last month (%s) ---', prevYm);
  // The closed month's own tab first; Shopify only when there isn't one.
  if (monthUnfinished) {
    Logger.log('\n--- last month (%s) is NOT OVER YET (today is %s) — skipping it entirely. '
      + 'A part-month figure written here would become the MoM denominator AND be '
      + 'marked done, so it would never be refetched. It fills in on the 1st. ---',
      prevYm, todayYm);
  }
  // Located before the skip is final, because FINDING A TAB OVERRIDES THE SKIP.
  // The tab is the better source by a distance — it carries our restatements and
  // Shopify does not — so a month written from Shopify is redone the moment a
  // tab for it turns up. That is self-healing, and it is the only thing that
  // gets September's figures right without somebody remembering a flag.
  var lmTab = monthUnfinished ? null : _npxLastMonthTabFor(ss, prevYm);
  if (lmSkip && lmTab && lmSrc !== 'tab') {
    Logger.log('  ...but tab "%s" holds %s and what is written came from Shopify. '
      + 'Redoing it: the tab has the restatements, the refetch does not.', lmTab.name, prevYm);
    lmSkip = false;
  }
  var fromTab = (lmSkip || monthUnfinished) ? null : _npxLastMonthFromTab(ss, prevYm, lmTab);
  if (fromTab) {
    Logger.log('  reading last month off that tab — the closed figures, so the '
      + '60-day wall does not apply and this cannot drift away from what the '
      + 'month was closed at, restatements and all.');
    // ⚠️ AND THROW AWAY ANYTHING BANKED FROM SHOPIFY. A cache written on a run
    // that could not find the tab holds figures the tab disagrees with — that
    // is the whole point of preferring the tab — and leaving it would let a
    // later run quietly serve them again.
    PropertiesService.getScriptProperties().deleteProperty(NPX_LM_CACHE_KEY);
  } else if (!lmSkip && !monthUnfinished) {
    Logger.log('  !! NO TAB HOLDS %s, so last month is being re-derived from Shopify. '
      + 'That is correct for a month that never had a tab, and WRONG for one that '
      + 'was restated by hand — Shopify does not know about a pinned cell. If %s '
      + 'has a tab, check its row-2 month header.', prevYm, prevYm);
  }

  var lmCache = fromTab ? {} : _npxLmCacheLoad(prevYm);
  var lmCached = Object.keys(lmCache);
  if (lmCached.length) {
    Logger.log('  %s already banked from an earlier run: %s', lmCached.length, lmCached.join(', '));
  }
  var lmDeferred = [];

  var lmOk = [];
  for (var li = 0; li < NP_ORDER.length && !lmSkip && !monthUnfinished; li++) {
    var store = NP_ORDER[li], sb = NP_BASES[store], tot, howGot;
    try {
      if (fromTab) { tot = fromTab[store]; tot.npTrustworthy = true; howGot = 'from tab'; }
      else if (lmCache[store]) { tot = lmCache[store]; howGot = 'from cache'; }
      else {
        // ⚠️ CHECKED BEFORE THE FETCH, NEVER AFTER. A fetch started with twenty
        // seconds left does not fail politely — it takes the whole execution
        // down with it, including the batch write at the bottom that is the
        // only reason any of this ran.
        if (new Date().getTime() - npxT0 > NPX_BUDGET_MS) { lmDeferred.push(store); continue; }
        tot = _npxMonthTotals(_npxFetchMonth(store, prevYm));
        // Banked BEFORE anything else can go wrong with the run. 85 seconds of
        // Shopify paging is too expensive to spend twice for want of a write.
        _npxLmCacheSave(prevYm, store, tot);
        howGot = tot.days + ' days';
      }
    } catch (e) {
      Logger.log('  %s: SKIPPED — %s', store, e.message);
      skips.push(store + ' last month: ' + e.message);
      continue;
    }
    Logger.log('  %s: %s | Revenue %s | GP %s | NP %s%s', store, howGot,
      tot.revenue, tot.gp, tot.np,
      tot.npTrustworthy ? '' : '\n    !! NET PROFIT NOT WRITTEN. ' + tot.blind + ' of '
        + tot.sellingDays + ' selling days report ZERO eBay fee, shipping AND card fee'
        + (tot.naEbay || tot.naShip ? ' (plus ' + tot.naEbay + ' null eBay, ' + tot.naShip + ' null shipping)' : '')
        + '. That is the 60-day Shopify order wall, not a quiet month: Sales and Cost'
        + ' come from ShopifyQL and are fine, the fees come from the Orders API which'
        + ' returns nothing older than 60 days without the read_all_orders scope.'
        + ' Missing fees make Net Profit TOO HIGH, so Revenue and GP are written and NP is not.');
    plan(sb + NPX_OFF_VAL_L, rowLastMonth, store + ' last-month Revenue', tot.revenue, NPX_MONEY);
    plan(sb + NPX_OFF_VAL_R, rowLastMonth, store + ' last-month GP', tot.gp, NPX_MONEY);
    // The wall only governs a Shopify REFETCH. A figure read off the closed
    // month's own tab is already final and cannot decay.
    if (tot.npTrustworthy && (fromTab || !behindWall)) {
      plan(sb + NPX_OFF_LM_NP, rowLastMonth, store + ' last-month Net Profit', tot.np, NPX_MONEY);
      lmOk.push(store);
    } else {
      // ⚠️ CLEAR IT, DO NOT LEAVE IT. Refusing to write is not the same as
      // leaving whatever was there, because the cell beside it HAS just been
      // rewritten for a different month. Sept 1 is the case: the 2pm refresh
      // has the grid on September and writes August's Revenue, GP and NP; the
      // 7pm close puts the grid on August, which makes last month JULY, and
      // July is behind the wall. Revenue and GP become July's and the Net
      // Profit cell would still be holding August's. One row, two months, and
      // the MoM percentage underneath it reads as if that were a real
      // comparison. Blank says "not known"; a stale number says nothing at all.
      plan(sb + NPX_OFF_LM_NP, rowLastMonth, store + ' last-month Net Profit (cleared)',
           '', NPX_MONEY, null, true);
    }
  }
  if (lmDeferred.length) {
    Logger.log('\n  !! OUT OF TIME before %s (%s). Their last-month cells are left '
      + 'BLANK and the month is NOT marked done, so the next refresh picks up where '
      + 'this one stopped — the stores already fetched are banked and will not be '
      + 'refetched. Two refreshes a day means it completes on its own; run '
      + 'npSummaryApply by hand if you want it sooner.',
      lmDeferred.length === 1 ? 'one store' : lmDeferred.length + ' stores',
      lmDeferred.join(', '));
    skips.push('last month deferred for ' + lmDeferred.join(', ') + ' — ran out of time');
  }

  // TTL as SUM formulas rather than a written total: if one store is ever
  // restated the company figure follows instead of quietly disagreeing.
  var tb = NP_TTL_BASE;
  var sumOf = function (off, row0) {
    var parts = [];
    for (var q = 0; q < NP_ORDER.length; q++) parts.push(_npxA1(NP_BASES[NP_ORDER[q]] + off, row0));
    return '=' + parts.join('+');
  };
  if (!lmSkip && !monthUnfinished) {
    plan(tb + NPX_OFF_VAL_L, rowLastMonth, 'TTL last-month Revenue',
         sumOf(NPX_OFF_VAL_L, rowLastMonth), NPX_MONEY);
    plan(tb + NPX_OFF_VAL_R, rowLastMonth, 'TTL last-month GP',
         sumOf(NPX_OFF_VAL_R, rowLastMonth), NPX_MONEY);
    if (lmOk.length === NP_ORDER.length) {
      plan(tb + NPX_OFF_LM_NP, rowLastMonth, 'TTL last-month Net Profit',
           sumOf(NPX_OFF_LM_NP, rowLastMonth), NPX_MONEY);
    } else {
      // Cleared for the same reason as the stores above: a company total left
      // over from another month is worse than an empty cell, because it is the
      // one figure nobody re-derives by hand.
      plan(tb + NPX_OFF_LM_NP, rowLastMonth, 'TTL last-month Net Profit (cleared)',
           '', NPX_MONEY, null, true);
      Logger.log('  TTL Net Profit NOT written: only %s of %s stores have a trustworthy NP. '
        + 'A company total built from a partial set still reads as a real figure.',
        lmOk.length, NP_ORDER.length);
    }
  }

  // === 3b. Month-over-month, under each last-month figure ===================
  // Ethan, 2026-08-31: "a MoM percentage in the cell beneath the blue cell for
  // Last Month Revenue, Last Month GP, and Last Month NP relative to where we
  // are tracking for in those respective categories."
  //
  // ⚠️ "WHERE WE ARE TRACKING" IS THE LAST NON-EMPTY TRACKING CELL, NOT THE TTL
  // ROW. Rev/GP/NP Tracking are (cumulative / days so far) * days in month, so
  // each day's cell is already a projection of the WHOLE month — which is the
  // right thing to compare a whole last month against, with no prorating. The
  // TTL row is a sum of the days and would be month-to-date, so on the 3rd it
  // would read as a 90% collapse every month. Same reasoning, and deliberately
  // the same formula shape, as the YoY "Current" cell below.
  //
  // ⚠️ WRITTEN BY THE SCRIPT, NOT LEFT AS HAND FORMULAS. Six blocks by three
  // figures is eighteen cells to keep in step, and the October roll copies
  // whatever is there — a hand-typed one that drifted in one block would be
  // copied forward every month after. This also keeps them out of the cells the
  // last-month writer owns: NP used to live at F39, exactly where the GP
  // percentage now goes, so a hand-typed formula there would have been
  // overwritten with a dollar figure at 2pm.
  var momPairs = [
    ['Revenue', NPX_OFF_REVTRACK, NPX_OFF_VAL_L],
    ['GP',      NPX_OFF_GPTRACK,  NPX_OFF_VAL_R],
    ['NP',      NPX_OFF_NPTRACK,  NPX_OFF_LM_NP],
  ];
  var momRow = rowLastMonth + NPX_MOM_ROW_OFF;
  for (var mi = 0; mi < blocks.length; mi++) {
    var mName = blocks[mi][0], mBase = blocks[mi][1];
    for (var mj = 0; mj < momPairs.length; mj++) {
      var label = momPairs[mj][0], trackOff = momPairs[mj][1], lastOff = momPairs[mj][2];
      var tc = _npColLetter(mBase + trackOff);
      var rng = tc + firstDay1 + ':' + tc + lastDay1;
      var lastA1 = _npxA1(mBase + lastOff, rowLastMonth);
      // IFERROR, not a bare divide: last month is EMPTY for a store whose
      // previous month was never kept — August is exactly that — and a bare
      // formula would print #DIV/0! in eighteen cells on day one.
      plan(mBase + lastOff, momRow, mName + ' ' + label + ' MoM',
        '=IFERROR((INDEX(FILTER(' + rng + ', ' + rng + '<>""), COUNTA(FILTER('
        + rng + ', ' + rng + '<>"")))/' + lastA1 + ')-1,"")',
        NPX_PCT, null, true);
    }
  }

  // === 4. YoY revenue ========================================================
  // "Current" is already a FULL-MONTH PROJECTION, not month-to-date: it reads
  // the last Rev Tracking cell, and Rev Tracking is (cumulative / day) * days.
  // So last year's full month is the correct comparison with no prorating —
  // which is only knowable by having read the formula, not the label.
  Logger.log('\n--- YoY revenue (month %s) ---', mm);
  var yoyStores = [];
  for (var yi = 0; yi < NP_ORDER.length; yi++) {
    var st = NP_ORDER[yi], yb = NP_BASES[st];
    var lastYear = NPX_YOY_2025[st] && NPX_YOY_2025[st][mm];
    if (!lastYear) {
      Logger.log('  %s: no comparable %s 2025 — no YoY block (correct, not missing)', st, mm);
      continue;
    }
    yoyStores.push(st);
    var tCol = _npColLetter(yb + NPX_OFF_REVTRACK);
    var rng = tCol + firstDay1 + ':' + tCol + lastDay1;
    var curA1  = _npxA1(yb + NPX_OFF_VAL_R, rowYoY + 2);
    var lastA1 = _npxA1(yb + NPX_OFF_VAL_R, rowYoY + 1);
    Logger.log('  %s: last year %s, current projected from %s', st, lastYear, rng);

    plan(yb + NPX_OFF_YOY_LBL, rowYoY,     st + ' YoY label',     'YoY');
    plan(yb + NPX_OFF_VAL_R,   rowYoY,     st + ' YoY header',    'Revenue');
    plan(yb + NPX_OFF_YOY_LBL, rowYoY + 1, st + ' YoY "Last"',    'Last');
    plan(yb + NPX_OFF_VAL_R,   rowYoY + 1, st + ' YoY last year', lastYear, NPX_MONEY);
    plan(yb + NPX_OFF_YOY_LBL, rowYoY + 2, st + ' YoY "Current"', 'Current');
    plan(yb + NPX_OFF_VAL_R,   rowYoY + 2, st + ' YoY current',
      '=IFERROR(INDEX(FILTER(' + rng + ', ' + rng + '<>""), COUNTA(FILTER('
      + rng + ', ' + rng + '<>""))), "")', NPX_MONEY, null, true);
    plan(yb + NPX_OFF_YOY_LBL, rowYoY + 3, st + ' YoY "Inc/Dec"', 'Inc/Dec');
    // IFERROR added: the existing OVL and LEE formulas are a bare
    // =(F43/F42)-1 and show #DIV/0! for as long as "Last" is empty, which is
    // exactly the state this tab arrived in.
    plan(yb + NPX_OFF_VAL_R,   rowYoY + 3, st + ' YoY Inc/Dec',
      '=IFERROR((' + curA1 + '/' + lastA1 + ')-1,"")', NPX_PCT, null, true);
  }

  // The company YoY, same-store. As found, the tab had Last = OVL+LEE and
  // Current = OVL+LEE+WSP — two stores against three, which prints one store's
  // entire revenue as growth. It only escaped notice because the WSP term
  // pointed at AN36, a cell that happens to be empty.
  var ssBases = [], ssOk = true;
  for (var mi = 0; mi < NPX_SAME_STORE.length; mi++) {
    if (yoyStores.indexOf(NPX_SAME_STORE[mi]) < 0) { ssOk = false; break; }
    ssBases.push(NP_BASES[NPX_SAME_STORE[mi]]);
  }
  if (!ssOk) {
    Logger.log('  TTL YoY not written: %s does not have a comparable %s 2025',
      NPX_SAME_STORE.join('/'), mm);
  } else {
    var refs = function (row0) {
      var p = [];
      for (var z = 0; z < ssBases.length; z++) p.push(_npxA1(ssBases[z] + NPX_OFF_VAL_R, row0));
      return '=' + p.join('+');
    };
    var note = 'Same-store: ' + NPX_SAME_STORE.join(' + ') + ' only.\n'
      + 'MPL and BAL have no 2025 history. Including them would print their '
      + 'entire revenue as year-over-year growth.';
    // ⚠️ WRITE THE TTL LABELS TOO, FOR THE SAME REASON THE STORES' ARE WRITTEN.
    // This block wrote its VALUES at rowYoY+1..+3 and left the labels alone, so
    // it silently depended on somebody having typed them in the right four rows.
    // On 2026-08-31 they were a row lower than the stores', and the preview
    // showed the result: "YoY" beside a dollar figure, "Last" beside the CURRENT
    // total, and "Current" beside a percentage. Every number correct, every
    // label attached to the wrong one — the kind of wrong that gets read off a
    // screen and believed. Owning both halves is what makes the block align by
    // construction rather than by luck.
    // ⚠️ THESE PASS replaceFormula BECAUSE THEY ARE A DELIBERATE RELABEL, which
    // is exactly the case plan()'s text guard carves out. Without it the first
    // attempt wrote only the two cells that happened to be EMPTY and skipped the
    // four that needed correcting — "text already there: YoY " — which would
    // have left the tab with two YoY headers and the labels still off by one.
    // Worse than before, from a fix. The guard is right; it just has to be told
    // that moving a block is intentional.
    plan(tb + NPX_OFF_YOY_LBL, rowYoY,     'TTL YoY label',     'YoY',     null, null, true);
    plan(tb + NPX_OFF_VAL_R,   rowYoY,     'TTL YoY header',    'Revenue', null, null, true);
    plan(tb + NPX_OFF_YOY_LBL, rowYoY + 1, 'TTL YoY "Last"',    'Last',    null, null, true);
    plan(tb + NPX_OFF_YOY_LBL, rowYoY + 2, 'TTL YoY "Current"', 'Current', null, null, true);
    plan(tb + NPX_OFF_YOY_LBL, rowYoY + 3, 'TTL YoY "Inc/Dec"', 'Inc/Dec', null, null, true);
    // ⚠️ AND CLEAR THE ONE LEFT BEHIND. Moving a four-row block up by one row
    // leaves its last label orphaned a row below, with nothing beside it — an
    // "Inc/Dec" against an empty cell reads as a figure that failed to compute
    // rather than one that moved. Only cleared when it is actually the orphan.
    if (String(values[rowYoY + 4][tb + NPX_OFF_YOY_LBL]).trim() === 'Inc/Dec') {
      plan(tb + NPX_OFF_YOY_LBL, rowYoY + 4, 'TTL YoY stale label (cleared)',
           '', null, null, true);
      // ⚠️ AND THE FORMULA BESIDE IT, WHICH IS THE HALF THAT SHOWS A NUMBER.
      // Clearing only the label leaves =IFERROR((CR45/CR44)-1,"") in place with
      // its inputs now meaning different things — Inc/Dec divided by Current.
      // It reads blank while the month is empty, so it would have looked fine
      // today and become an unlabelled percentage on a financial sheet the
      // moment the first day landed. An orphaned label is untidy; an orphaned
      // FORMULA is a number somebody can read.
      plan(tb + NPX_OFF_VAL_R, rowYoY + 4, 'TTL YoY stale formula (cleared)',
           '', null, null, true);
    }

    plan(tb + NPX_OFF_VAL_R, rowYoY + 1, 'TTL YoY last year', refs(rowYoY + 1), NPX_MONEY, note, true);
    plan(tb + NPX_OFF_VAL_R, rowYoY + 2, 'TTL YoY current',   refs(rowYoY + 2), NPX_MONEY, note, true);
    plan(tb + NPX_OFF_VAL_R, rowYoY + 3, 'TTL YoY Inc/Dec',
      '=IFERROR((' + _npxA1(tb + NPX_OFF_VAL_R, rowYoY + 2) + '/'
      + _npxA1(tb + NPX_OFF_VAL_R, rowYoY + 1) + ')-1,"")', NPX_PCT, null, true);

    // The tab already carries a separate "Same Store" block lower down. Point
    // it at the block above rather than recomputing: two independent copies of
    // one number is two chances to disagree.
    var rowSS = _npxFindRow(values, tb + NPX_OFF_YOY_LBL, 'Same Store');
    if (rowSS >= 0) {
      Logger.log('  mirroring the "Same Store" block at row %s onto the TTL YoY block', rowSS + 1);
      plan(tb + NPX_OFF_VAL_R, rowSS + 2, 'Same Store last',
        '=' + _npxA1(tb + NPX_OFF_VAL_R, rowYoY + 1), NPX_MONEY, null, true);
      plan(tb + NPX_OFF_VAL_R, rowSS + 3, 'Same Store current',
        '=' + _npxA1(tb + NPX_OFF_VAL_R, rowYoY + 2), NPX_MONEY, null, true);
      plan(tb + NPX_OFF_VAL_R, rowSS + 4, 'Same Store Inc/Dec',
        '=' + _npxA1(tb + NPX_OFF_VAL_R, rowYoY + 3), NPX_PCT, null, true);
    }
  }

  // === 2. the % of goal cell =================================================
  Logger.log('\n--- percent of goal ---');
  var goalCells = [], goalBases = [];
  for (var gi = 0; gi < blocks.length; gi++) {
    var gName = blocks[gi][0], gb = blocks[gi][1];
    var lblRow = _npxFindRow(values, gb + NPX_OFF_GOAL_LBL, '% of GP Goal');
    if (lblRow < 0) lblRow = _npxFindRow(values, gb + NPX_OFF_GOAL_LBL, '% of NP Goal');
    if (lblRow < 0) { Logger.log('  %s: no percent-of-goal label — skipped', gName); continue; }

    var pctCol = gb + NPX_OFF_GOAL_VAL;
    var goalRow = lblRow + 1;
    goalCells.push({ store: gName, a1: _npxA1(pctCol, lblRow), abs: _npxAbs(pctCol, lblRow) });
    if (gName !== 'TTL') goalBases.push(gb);

    // TTL had the percentage label but never a goal of its own. Sum the five,
    // so the company row cannot be set to something that disagrees with them.
    if (gName === 'TTL') {
      plan(gb + NPX_OFF_GOAL_LBL, goalRow, 'TTL goal label', 'NP Goal');
      var gp = [];
      for (var gq = 0; gq < goalBases.length; gq++) {
        gp.push(_npxA1(goalBases[gq] + NPX_OFF_GOAL_VAL, goalRow));
      }
      if (gp.length === NP_ORDER.length) {
        plan(gb + NPX_OFF_GOAL_VAL, goalRow, 'TTL NP Goal', '=' + gp.join('+'), NPX_MONEY);
      }
    }

    var goalVal = values[goalRow][gb + NPX_OFF_GOAL_VAL];
    var goalF = String(formulas[goalRow][gb + NPX_OFF_GOAL_VAL]).trim();
    if ((goalVal === '' || goalVal === null) && goalF === '') {
      Logger.log('  %s: NP Goal at %s IS EMPTY — the percentage stays blank and no colour '
        + 'can fire until a goal is entered', gName, _npxA1(gb + NPX_OFF_GOAL_VAL, goalRow));
    }

    if (NPX_FIX_GOAL_FORMULA) {
      var nCol = _npColLetter(gb + (NPX_GOAL_BASIS === 'actual'
        ? NPX_OFF_NPTOTAL : NPX_OFF_NPTRACK));
      var nrng = nCol + firstDay1 + ':' + nCol + lastDay1;
      plan(pctCol, lblRow, gName + ' % of goal',
        '=IFERROR(INDEX(FILTER(' + nrng + ', ' + nrng + '<>""), COUNTA(FILTER('
        + nrng + ', ' + nrng + '<>"")))/' + _npxAbs(gb + NPX_OFF_GOAL_VAL, goalRow) + ',"")',
        NPX_PCT, null, true);
      // The label said GP; the formula divided by the NP Goal and read the NP
      // column. Fixing the number without fixing the word leaves the next
      // reader to discover the same contradiction.
      plan(gb + NPX_OFF_GOAL_LBL, lblRow, gName + ' goal label', '% of NP Goal', null, null, true);
    }
  }

  // --- report, then apply ---------------------------------------------------
  Logger.log('\n=== %s cell(s) to write, %s skipped ===', writes.length, skips.length);
  for (var w = 0; w < writes.length; w++) {
    var oldTxt = (writes[w].old === '' || writes[w].old === null) ? '(empty)' : writes[w].old;
    var newTxt = writes[w].value instanceof Date
      ? Utilities.formatDate(writes[w].value, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : writes[w].value;
    Logger.log('  %s  %s\n        %s  ->  %s', writes[w].a1, writes[w].what, oldTxt, newTxt);
  }
  for (var k = 0; k < skips.length; k++) Logger.log('  SKIP %s', skips[k]);

  if (preview) {
    _npxReportColour(goalCells, true);
    Logger.log('\nPREVIEW — nothing was written. Run npSummaryApply to apply.');
    return;
  }

  for (var a = 0; a < writes.length; a++) {
    var cell = sh.getRange(writes[a].a1);
    if (writes[a].isFormula) cell.setFormula(writes[a].value);
    else cell.setValue(writes[a].value);
    if (writes[a].fmt) cell.setNumberFormat(writes[a].fmt);
    if (writes[a].note) cell.setNote(writes[a].note);
  }
  Logger.log('\nWrote %s cell(s).', writes.length);
  // Marked only after the write succeeded. Marking before would leave the
  // marker claiming a month that a mid-run failure never finished writing.
  if (!lmSkip && !monthUnfinished && lmOk.length === NP_ORDER.length) {
    lmProps.setProperty(NPX_LASTMONTH_KEY, ym + '|' + (fromTab ? 'tab' : 'shopify'));
    Logger.log('Last month (%s) recorded for grid month %s, from %s. %s',
      prevYm, ym, fromTab ? 'its own tab' : 'Shopify',
      fromTab ? 'It will not be refetched.'
              : 'It will be REDONE automatically if a tab for it ever appears.');
  }
  _npxApplyColour(sh, goalCells);
}

// ---------------------------------------------------------------------------
// green / red on the % of goal cells
// ---------------------------------------------------------------------------

function _npxReportColour(cells, preview) {
  Logger.log('\n=== conditional formatting: %s cell(s) ===', cells.length);
  for (var i = 0; i < cells.length; i++) {
    Logger.log('  %s (%s): green at 100%% of goal or above, red below',
      cells[i].a1, cells[i].store);
  }
  if (preview) Logger.log('  (preview — no rules were changed)');
}

function _npxApplyColour(sh, cells) {
  _npxReportColour(cells, false);
  if (!cells.length) return;

  var targets = {};
  for (var i = 0; i < cells.length; i++) targets[cells[i].a1] = true;

  // Keep every rule that is not one of ours. A new rule stacked on an existing
  // one does NOT replace it — both apply and the earlier one wins, which is how
  // a cell ends up refusing to turn red. The tab had zero rules when this was
  // written; this survives that changing.
  var kept = [], existing = sh.getConditionalFormatRules(), dropped = 0;
  for (var e = 0; e < existing.length; e++) {
    var rngs = existing[e].getRanges(), mine = false;
    for (var q = 0; q < rngs.length; q++) {
      if (targets[rngs[q].getA1Notation()]) { mine = true; break; }
    }
    if (mine) dropped++; else kept.push(existing[e]);
  }
  if (dropped) Logger.log('  replaced %s existing rule(s) on these cells', dropped);

  for (var c = 0; c < cells.length; c++) {
    var rng = sh.getRange(cells[c].a1), ref = cells[c].abs;
    // ISNUMBER guards the blank case: an empty cell compares as 0, which would
    // paint every store red on the 1st of the month before any data lands, and
    // paint it red permanently at the four stores that have no goal entered.
    kept.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND(ISNUMBER(' + ref + '),' + ref + '>=1)')
      .setBackground(NPX_GREEN_BG).setFontColor(NPX_GREEN_FG)
      .setRanges([rng]).build());
    kept.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND(ISNUMBER(' + ref + '),' + ref + '<1)')
      .setBackground(NPX_RED_BG).setFontColor(NPX_RED_FG)
      .setRanges([rng]).build());
  }
  sh.setConditionalFormatRules(kept);
  Logger.log('  %s rule(s) now on the tab.', kept.length);
}
