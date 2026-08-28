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
var NPX_OFF_GOAL_LBL = 3;   // D — "% of GP Goal" (row 1), "NP Goal" (row 2)
var NPX_OFF_GOAL_VAL = 4;   // E — the percentage (row 1), the goal (row 2)
var NPX_OFF_REVTRACK = 3;   // D — Rev Tracking, the source of YoY "Current"
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

var NPX_LASTMONTH_KEY = 'NPX_LAST_MONTH_FOR';
var NPX_FORCE_LAST_MONTH = false;   // set true for one run to redo last month

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
  var ss = SpreadsheetApp.openById(NP_SHEET_ID);
  var sh = ss.getSheetByName(NP_TAB);
  if (!sh) { Logger.log('!! no tab named "%s"', NP_TAB); return; }

  var ym = _npxGridMonth();
  var prevYm = _npxPrevYm(ym);
  var daysIn = _npxDaysIn(ym);
  var mm = ym.slice(5, 7);

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
  var rowLastMonth = _npxFindRow(values, NP_BASES.OVL + NPX_OFF_LABEL, 'Last month');
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
  var lmProps = PropertiesService.getScriptProperties();
  var lmDone = lmProps.getProperty(NPX_LASTMONTH_KEY) === ym;
  var lmCell = values[rowLastMonth][NP_BASES.OVL + NPX_OFF_VAL_L];
  var lmSkip = lmDone && typeof lmCell === 'number' && !NPX_FORCE_LAST_MONTH;
  if (lmSkip) {
    Logger.log('\n--- last month (%s): already written for %s (OVL reads %s) — not refetching. '
      + 'Set NPX_FORCE_LAST_MONTH = true to redo it. ---', prevYm, ym, lmCell);
  }
  Logger.log(lmSkip ? '' : '\n--- last month (%s) ---', prevYm);
  var lmOk = [];
  for (var li = 0; li < NP_ORDER.length && !lmSkip; li++) {
    var store = NP_ORDER[li], sb = NP_BASES[store], tot;
    try {
      tot = _npxMonthTotals(_npxFetchMonth(store, prevYm));
    } catch (e) {
      Logger.log('  %s: SKIPPED — %s', store, e.message);
      skips.push(store + ' last month: ' + e.message);
      continue;
    }
    Logger.log('  %s: %s days | Revenue %s | GP %s | NP %s%s', store, tot.days,
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
    if (tot.npTrustworthy) {
      plan(sb + NPX_OFF_VAL_R, rowLastMonth + 1, store + ' last-month Net Profit', tot.np, NPX_MONEY);
      lmOk.push(store);
    }
  }
  // TTL as SUM formulas rather than a written total: if one store is ever
  // restated the company figure follows instead of quietly disagreeing.
  var tb = NP_TTL_BASE;
  var sumOf = function (off, row0) {
    var parts = [];
    for (var q = 0; q < NP_ORDER.length; q++) parts.push(_npxA1(NP_BASES[NP_ORDER[q]] + off, row0));
    return '=' + parts.join('+');
  };
  if (!lmSkip) {
    plan(tb + NPX_OFF_VAL_L, rowLastMonth, 'TTL last-month Revenue',
         sumOf(NPX_OFF_VAL_L, rowLastMonth), NPX_MONEY);
    plan(tb + NPX_OFF_VAL_R, rowLastMonth, 'TTL last-month GP',
         sumOf(NPX_OFF_VAL_R, rowLastMonth), NPX_MONEY);
    if (lmOk.length === NP_ORDER.length) {
      plan(tb + NPX_OFF_VAL_R, rowLastMonth + 1, 'TTL last-month Net Profit',
           sumOf(NPX_OFF_VAL_R, rowLastMonth + 1), NPX_MONEY);
    } else {
      Logger.log('  TTL Net Profit NOT written: only %s of %s stores have a trustworthy NP. '
        + 'A company total built from a partial set still reads as a real figure.',
        lmOk.length, NP_ORDER.length);
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
  if (!lmSkip && lmOk.length === NP_ORDER.length) {
    lmProps.setProperty(NPX_LASTMONTH_KEY, ym);
    Logger.log('Last month (%s) recorded for grid month %s; it will not be refetched.',
      prevYm, ym);
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
