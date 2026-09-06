// ============================================================================
// sales-yoy.gs — the YoY "Last" figure on the SALES tabs, advanced by month.
//
//   salesYoyPreview([ym])   log every write, change nothing
//   salesYoyApply([ym])     write them
//   salesYoyAudit()         READ-ONLY sweep of every Sales tab in the workbook
//
// ⚠️ THE BUG THIS EXISTS TO END. September 2026's Sales tab compared itself
// against AUGUST 2025:
//
//   OVL  YoY Last  $105,622.08   <- August 2025
//        should be  $92,304.08   <- September 2025
//   LEE  YoY Last   $52,224.24   ->  $72,414.06
//   WSP  YoY Last   $61,892.07   ->  $69,307.11
//
// Nothing wrote those wrong numbers. They are AUGUST'S OWN CORRECT FIGURES,
// carried into September by the rollover — month-rollover.gs copies the tab with
// copyTo() so every formula and format survives, which is the whole point of it,
// and a typed constant in the footer survives exactly the same way. MR_FOOTER
// advances the goal, the day counts and "Last month"; the YoY block was never in
// that list, so it has been rolling forward untouched.
//
// It is the worst shape a wrong number can take: right to the cent, in the right
// place, formatted correctly, and describing a different month. On the Sales Sep
// 26 tab it printed OVL as -1.40% year over year when the store is actually
// +12.8% on September 2025.
//
// ⚠️ THE NET PROFIT TAB WAS NEVER WRONG. npSummaryApply writes its YoY block
// every day from NPX_YOY_2025, keyed to the month the grid actually holds, so it
// corrected itself on the 1st. Only the Sales tabs — which no script owned below
// the day grid — carried the stale figure. That is why the two tabs disagreed
// about the same store's YoY on 2026-09-03, and it is the same "two sheets, one
// truth" hazard sep-fix.gs was written around.
//
// ---------------------------------------------------------------------------
// WHY THIS LIVES IN THE NET PROFIT PROJECT AND NOT THE ROLLOVER'S
//
// The natural home is month-rollover.gs — it owns the Sales tabs and it is the
// job that carries the stale cell forward. But the 2025 figures live in
// NPX_YOY_2025 in netprofit-summary.gs, and month-rollover is deployed as its
// own standalone project. Putting this there means a SECOND COPY of twelve
// months of history for three stores, in a different project, with nothing to
// keep the two in step — and a YoY table that disagrees with itself is worse
// than one that is a month behind, because at least a month-behind figure is
// wrong in a way somebody eventually notices.
//
// So: paste this file into the NET PROFIT project (the one holding
// netprofit-sheet.gs / netprofit-summary.gs / netprofit-schedule.gs), where the
// map already is. _syoyMap() refuses to run if it cannot see it, rather than
// writing blanks over a year of history.
//
// ⚠️ AND IT RUNS DAILY, NOT MONTHLY. npsDailyRefresh calls _syoySync(false)
// after the summary strip. A monthly hook fires once and, if it fails that
// morning, is wrong for a month; the daily one repairs the tab the next time it
// runs. It writes only cells that differ, so on every day but the 1st it finds
// the figures already right and writes nothing.
//
// ---------------------------------------------------------------------------
// WHAT IT WRITES, AND WHAT IT REFUSES TO
//
// A YoY block on a Sales tab is four labelled rows in one column pair, sitting
// under the day grid beside the "Net GP" strip. As measured on the live Sales
// Sep 26 tab (65 columns, blocks at 0/11/22/33/44 and the TTL at 55):
//
//   E40 "YoY"      F40 "Revenue"
//   E41 "Last"     F41  last year's full month     <- THE ONLY CELL WRITTEN
//   E42 "Current"  F42  =INDEX(FILTER(Rev Tracking...))
//   E43 "Inc/Dec"  F43  =(F42/F41)-1
//
// ⚠️ AND THOSE ROW NUMBERS ARE NOT A CONTRACT. The March 2026 tab has the same
// block one row lower — the footer above it is taller by a row — which is why
// nothing here counts rows and everything reads labels.
//
// The block is LOCATED BY ITS LABELS, never by arithmetic off a row number: it
// sits four rows under a footer whose height changes with the month, the tab is
// 11 columns per store where the Net Profit tab is 18, and the same workbook
// keeps a second copy of the block ("Same Store") lower down and further right.
// Anything that is not a "YoY" with a "Last" under it is not touched at all.
//
// ⚠️ ONLY "Last" IS OURS. "Current" reads the store's own Rev Tracking column
// and "Inc/Dec" divides the two — both are the tab's own work and both are
// correct. This writes one cell per block and leaves the other three alone.
//
// ⚠️ A LETTER-BEARING FORMULA IS SOMEBODY'S WORK. Same rule as sep-fix.gs: only
// a blank, a plain number, or a bare-number formula may be replaced. If a "Last"
// cell has grown a real formula — an IMPORTRANGE against the 2025 workbook, say
// — this logs it and leaves it, because a formula there means somebody decided
// the figure should come from somewhere else and this script is not the place to
// overrule that silently.
//
// ⚠️ A STORE WITH NO COMPARABLE 2025 IS CLEARED, NOT LEFT. MPL and BAL have no
// 2025 at all and WSP has no honest June (it opened mid-month), so those blocks
// have nothing to compare against. A carried-forward number there is the exact
// bug above with nobody able to spot it, so an uncomparable "Last" is emptied —
// an empty cell reads as "no comparison", which is the truth. Set
// SYOY_CLEAR_UNCOMPARABLE = false to leave them exactly as found.
//
// ---------------------------------------------------------------------------
// THE TOTAL BLOCKS, AND THE TWO-AGAINST-THREE FICTION
//
// The tab carries a TTL block after the five stores and a separate "Same Store"
// block below it. Their "Last" is the sum of the stores that HAVE a comparable
// year, so it is written as a plus-chain over the store cells this run just
// wrote — '=F42+Q42+AB42' — which keeps it in step the next time a store figure
// is corrected instead of freezing today's sum.
//
// ⚠️ THE TTL BLOCK'S "Current" SPANS MORE STORES THAN ITS "Last" CAN. On the
// March 2026 tab, TTL Last was OVL+LEE ($137,432.39) while TTL Current was
// OVL+LEE+WSP ($299,724.82) — printing +118% year over year, which is one whole
// store's revenue counted as growth. netprofit-summary.gs hit the same thing on
// the Net Profit tab and answered it by making the company YoY same-store only.
// September 2026 has it too, measured on the live tab: TTL "Current" is
// '=F42+Q42+Z35+AK35+AV35' — five stores, MPL and BAL included — over a "Last"
// that can only ever be three. By default this script logs that formula beside
// the sum it writes and changes nothing on that row; SYOY_SAME_STORE_CURRENT
// makes it same-store, and the paragraph on that switch is the case for and
// against. The workbook's other answer, where a tab has one, is the separate
// "Same Store" block, which compares the same stores on both rows.
// ============================================================================

var SYOY_SHEET_ID = '1i_oV37lZXq8s91f9ymzwQlrM8WY2UlQQQ0qsRP3xLJ8';  // Sales Summary 2026

// Same width unit as month-rollover.gs and buysell-history.gs, and used the same
// way: as a WIDTH ONLY. Each store's real column is read off the tab's own
// header rows, because MPL and BAL opened in April 2026 and in earlier tabs the
// TTL block sits exactly where MPL's does now.
var SYOY_SALES_WIDTH = 11;
var SYOY_HEADER_ROWS = 4;
var SYOY_STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];

var SYOY_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
                    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
var SYOY_MON_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                     'August', 'September', 'October', 'November', 'December'];

var SYOY_TZ = 'America/Chicago';
var SYOY_MONEY = '$#,##0.00';

// An uncomparable "Last" is emptied rather than left holding another month's
// figure. See the header block for why.
var SYOY_CLEAR_UNCOMPARABLE = true;

// Whether the TTL / Same Store "Last" cells are kept in step. Only ever
// replaces a blank, a plain number or a plus-chain of cell references — never a
// SUM range, an IMPORTRANGE or any other formula.
var SYOY_WRITE_TOTALS = true;

// ⚠️ THE COMPANY YoY ON THE SALES TAB IS THREE STORES AGAINST FIVE, AND THIS IS
// THE SWITCH THAT ENDS IT. Measured on the September 2026 tab, 2026-09-03:
//
//   BI41  "Last"     three stores  (OVL + LEE + WSP 2025 — all the 2025 there is)
//   BI42  "Current"  =F42+Q42+Z35+AK35+AV35   five stores, MPL and BAL included
//
// So the company row divides five stores of 2026 by three stores of 2025 and
// prints the difference as growth. MPL and BAL opened in April 2026; their
// entire revenue lands in that percentage.
//
// The Net Profit tab does not do this. netprofit-summary.gs writes BOTH of its
// company YoY rows over the same three blocks (`refs(rowYoY + 1)` and
// `refs(rowYoY + 2)`), so its company YoY is same-store on both sides. Leaving
// this off means the two tabs print DIFFERENT company YoY figures for the same
// month — the disagreement this file was written to end, one row lower.
//
// Turning it on rewrites "Current" to the same three stores' cells. That is a
// change to what the cell MEANS, not a correction of a stale figure, which is
// why it is a switch and not the default: the all-store month total still lives
// in the TTL block's own Rev Tracking cell, but anyone reading this one as "the
// district's revenue" would find it smaller. Store rows are untouched either way.
var SYOY_SAME_STORE_CURRENT = false;

function salesYoyPreview(ym) { return _syoySync(true, ym); }
function salesYoyApply(ym)   { return _syoySync(false, ym); }

// ---- small helpers ---------------------------------------------------------

function _syoyColLetter(i0) {
  var n = i0 + 1, s = '';
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - r) / 26); }
  return s;
}

function _syoyA1(col0, row0) { return _syoyColLetter(col0) + (row0 + 1); }

function _syoyTxt(v) {
  return String(v === null || v === undefined ? '' : v).trim().toLowerCase();
}

function _syoyPad(n) { return n < 10 ? '0' + n : '' + n; }

function _syoyCentralMonth() {
  return Utilities.formatDate(new Date(), SYOY_TZ, 'yyyy-MM');
}

// ⚠️ THE MAP IS THE ONE COPY OF 2025 AND THIS FILE DOES NOT OWN IT. Pasted into
// the wrong project it would find no map, and "no figure for this month" is
// indistinguishable from "this store has no 2025" — which would empty three
// stores' YoY instead of correcting it. So it throws instead.
function _syoyMap() {
  if (typeof NPX_YOY_2025 === 'undefined' || !NPX_YOY_2025) {
    throw new Error('NPX_YOY_2025 is not in scope. sales-yoy.gs belongs in the NET PROFIT '
      + 'Apps Script project, beside netprofit-summary.gs which owns the 2025 figures. '
      + 'Nothing was read or written.');
  }
  return NPX_YOY_2025;
}

// The lock idiom this workbook already uses: a formula with no letters in it.
// Ours or the sheet's own, either may be replaced.
function _syoyIsBareNumber(f) {
  if (!f) return false;
  var body = String(f).replace(/^=/, '').trim();
  if (!body || /[A-Za-z]/.test(body)) return false;
  var ALLOWED = '0123456789 .,+-*/()';
  for (var i = 0; i < body.length; i++) if (ALLOWED.indexOf(body.charAt(i)) < 0) return false;
  return true;
}

// A plus-chain of plain cell references and nothing else: '=F42+Q42+AB42'. The
// only formula shape a total cell may be overwritten with, because it is the
// only one that is unambiguously the same construction this script writes.
function _syoyIsPlusChain(f) {
  if (!f) return false;
  return /^=\s*\$?[A-Z]{1,3}\$?\d+(\s*\+\s*\$?[A-Z]{1,3}\$?\d+)*\s*$/.test(String(f).trim().toUpperCase());
}

function _syoySameFormula(a, b) {
  return String(a || '').replace(/\s+/g, '').toUpperCase() === String(b || '').replace(/\s+/g, '').toUpperCase();
}

// The cells a plus-chain adds up, as a sorted list — or nothing, if it is not a
// plus-chain.
//
// ⚠️ TERM ORDER IS NOT A DIFFERENCE. September's TTL cell held '=Q41+F41+AB41'
// and this script writes '=F41+Q41+AB41' — the same three cells, the same
// figure, listed LEE-first because somebody typed it that way. Comparing the
// strings made that a "change" and the first preview offered to rewrite a
// correct formula, which is churn on a financial sheet and, worse, buries the
// cells that are actually wrong in a list of cells that are not.
function _syoyChainRefs(f) {
  if (!_syoyIsPlusChain(f)) return null;
  return String(f).trim().toUpperCase().replace(/^=/, '').split('+')
    .map(function (s) { return s.replace(/\$/g, '').trim(); }).sort();
}

function _syoySameChain(a, b) {
  var ra = _syoyChainRefs(a), rb = _syoyChainRefs(b);
  return !!ra && !!rb && ra.join(',') === rb.join(',');
}

// 'Sales Sep 26' / 'Sales Sept 25' / 'Sales September 2026' -> '2026-09'.
function _syoyTabMonth(name) {
  var m = /^Sales\s+([A-Za-z]+)\.?\s*'?(\d{2}|\d{4})\s*$/i.exec(String(name || '').trim());
  if (!m) return null;
  var mo = SYOY_MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mo) return null;
  var yr = m[2].length === 2 ? 2000 + parseInt(m[2], 10) : parseInt(m[2], 10);
  return yr + '-' + _syoyPad(mo);
}

// ⚠️ REFUSES TO GUESS. Two tabs claiming the same month means one is a copy or a
// preview left behind by the rollover, and writing into the wrong one leaves the
// live tab wrong with a corrected twin beside it.
function _syoyFindSalesTab(ss, ym) {
  var hits = ss.getSheets().filter(function (sh) { return _syoyTabMonth(sh.getName()) === ym; });
  if (hits.length === 1) return hits[0];
  if (!hits.length) {
    Logger.log('!! no Sales tab for %s. Tabs present: %s', ym,
      ss.getSheets().map(function (s) { return s.getName(); }).join(' | '));
    return null;
  }
  Logger.log('!! %s tabs claim %s (%s) — refusing to guess which one is live.',
    hits.length, ym, hits.map(function (s) { return s.getName(); }).join(' | '));
  return null;
}

// Which column block belongs to which store, for THIS tab, read from its own
// header rows — lifted from month-rollover.gs's _mrBases for the same reason it
// exists there. A store with no header cell is absent, which is the right answer
// for a month before it opened and is what stops the TTL block being taken for
// BAL.
function _syoyBases(values) {
  var bases = {};
  var rows = Math.min(SYOY_HEADER_ROWS, values.length);
  for (var r = 0; r < rows; r++) {
    var row = values[r] || [];
    for (var c = 0; c < row.length; c++) {
      var txt = String(row[c] === null || row[c] === undefined ? '' : row[c]).toUpperCase();
      if (!txt) continue;
      for (var i = 0; i < SYOY_STORES.length; i++) {
        var code = SYOY_STORES[i];
        if (bases[code] !== undefined) continue;
        if (new RegExp('(^|[^A-Z])' + code + '([^A-Z]|$)').test(txt)) {
          bases[code] = Math.floor(c / SYOY_SALES_WIDTH) * SYOY_SALES_WIDTH;
        }
      }
    }
  }
  return bases;
}

// Which store's block a column falls in — or nothing, for the TTL and Same Store
// blocks that sit past the last store. ⚠️ The width bound is load-bearing; an
// unbounded version hands the company columns to the last store, which this
// workbook has punished three times (see _mrBlockOf).
function _syoyBlockOf(bases, col) {
  var best = null;
  Object.keys(bases).forEach(function (code) {
    var b = bases[code];
    if (b <= col && col < b + SYOY_SALES_WIDTH && (best === null || b > bases[best])) best = code;
  });
  return best;
}

// ---- the plan --------------------------------------------------------------
// Pure: values + formulas in, a list of cell writes out. No sheet, no clock, no
// map lookup of its own — which is what lets tests/sales-yoy-check.js run the
// real thing against a built grid instead of a paraphrase of it.
//
// Every entry is { row, col, a1, what, why, from, to, formula, note, level }
// with level 'write' | 'clear' | 'already' | 'skip'.
function _syoyPlan(values, formulas, ym, map) {
  var mm = ym.slice(5, 7);
  var monthName = SYOY_MON_FULL[Number(mm) - 1] + ' ' + (Number(ym.slice(0, 4)) - 1);
  var bases = _syoyBases(values);
  var res = { ym: ym, mm: mm, bases: bases, plan: [], warnings: [], blocks: [] };

  var cellOf = function (r, c) { return (values[r] || [])[c]; };
  var formulaOf = function (r, c) { return String((formulas[r] || [])[c] || '').trim(); };

  // 1. every YoY block on the tab, found by its labels.
  var found = [];
  for (var r = 0; r + 1 < values.length; r++) {
    var row = values[r] || [];
    for (var c = 0; c < row.length; c++) {
      if (_syoyTxt(row[c]) !== 'yoy') continue;
      var under = _syoyTxt(cellOf(r + 1, c));
      if (under !== 'last') {
        res.warnings.push('"YoY" at ' + _syoyA1(c, r) + ' has "' + (under || '(blank)')
          + '" under it, not "Last" — not a YoY block, left alone');
        continue;
      }
      found.push({ labelRow: r, labelCol: c, row: r + 1, col: c + 1,
                   store: _syoyBlockOf(bases, c) });
    }
  }
  res.blocks = found;

  // 2. the store blocks first: the totals are written as a chain over their
  //    cells, so their addresses have to be known before the totals are planned.
  var chain = [];
  found.filter(function (b) { return b.store; })
       .sort(function (a, b) { return bases[a.store] - bases[b.store]; })
       .forEach(function (b) {
    var lastYear = map[b.store] && map[b.store][mm];
    var note;
    if (lastYear) {
      note = b.store + ' — ' + monthName + ' revenue, $' + lastYear.toFixed(2) + '. Written by '
        + 'salesYoyApply from the 2025 Sales Summary, keyed to the month this tab holds. '
        + 'If this ever names a different month than the tab does, the rollover carried it '
        + 'and this job did not run.';
      _syoyPlanNumber(res, values, formulas, b, lastYear, b.store + ' YoY "Last"', note);
      chain.push({ store: b.store, a1: _syoyA1(b.col, b.row),
                   currentA1: _syoyA1(b.col, b.row + 1) });
      return;
    }
    // No comparable year. See SYOY_CLEAR_UNCOMPARABLE in the header.
    var cur = cellOf(b.row, b.col), curF = formulaOf(b.row, b.col);
    var why = b.store + ' has no comparable ' + monthName;
    if (cur === '' || cur === null || cur === undefined) {
      res.plan.push({ row: b.row, col: b.col, a1: _syoyA1(b.col, b.row), level: 'already',
                      what: b.store + ' YoY "Last"', why: why + ' — already empty' });
      return;
    }
    if (curF && !_syoyIsBareNumber(curF)) {
      res.warnings.push(b.store + ' YoY "Last" @' + _syoyA1(b.col, b.row) + ': ' + why
        + ', but the cell holds the formula "' + curF + '" — left alone');
      res.plan.push({ row: b.row, col: b.col, a1: _syoyA1(b.col, b.row), level: 'skip',
                      what: b.store + ' YoY "Last"', why: 'live formula — left alone', from: curF });
      return;
    }
    if (!SYOY_CLEAR_UNCOMPARABLE) {
      res.warnings.push(b.store + ' YoY "Last" @' + _syoyA1(b.col, b.row) + ' holds ' + cur
        + ' and ' + why + ' — left as found because SYOY_CLEAR_UNCOMPARABLE is off. That '
        + 'figure is some other month.');
      res.plan.push({ row: b.row, col: b.col, a1: _syoyA1(b.col, b.row), level: 'skip',
                      what: b.store + ' YoY "Last"', why: why, from: cur });
      return;
    }
    res.plan.push({ row: b.row, col: b.col, a1: _syoyA1(b.col, b.row), level: 'clear',
                    what: b.store + ' YoY "Last"', why: why + ' — emptied so it cannot read '
                      + 'as one', from: cur, to: '',
                    note: b.store + ' has no comparable ' + monthName + ', so there is no '
                      + 'year-over-year figure for this month. Emptied by salesYoyApply: a '
                      + 'number here would be some other month\'s, formatted to look like '
                      + 'this one\'s.' });
  });

  // 3. the TTL and Same Store blocks: same-store by construction.
  var want = chain.length
    ? '=' + chain.map(function (x) { return x.a1; }).join('+')
    : null;
  found.filter(function (b) { return !b.store; }).forEach(function (b) {
    var a1 = _syoyA1(b.col, b.row);
    var cur = cellOf(b.row, b.col), curF = formulaOf(b.row, b.col);
    var label = 'total YoY "Last"';
    // What its "Current" reads, logged beside what we write. See the header's
    // two-against-three note: this script does not change Current, but the two
    // being out of step is the difference between +40% and +118%.
    var curRow = formulaOf(b.row + 1, b.col) || String(cellOf(b.row + 1, b.col) || '');
    if (!SYOY_WRITE_TOTALS) {
      res.plan.push({ row: b.row, col: b.col, a1: a1, level: 'skip', what: label,
                      why: 'SYOY_WRITE_TOTALS is off', from: curF || cur });
      return;
    }
    if (!want) {
      res.warnings.push(label + ': no store on this tab has a comparable ' + monthName
        + ', so there is no same-store total to write. Left as found: ' + (curF || cur));
      return;
    }
    if (curF && !_syoyIsBareNumber(curF) && !_syoyIsPlusChain(curF)) {
      res.warnings.push(label + ' holds "' + curF + '", which is neither a number nor a '
        + 'plus-chain of cells — left alone. It should be ' + want + ' ('
        + chain.map(function (x) { return x.store; }).join(' + ') + ').');
      res.plan.push({ row: b.row, col: b.col, a1: a1, level: 'skip', what: label,
                      why: 'formula this script will not overrule', from: curF });
      return;
    }
    if (_syoySameFormula(curF, want) || _syoySameChain(curF, want)) {
      res.plan.push({ row: b.row, col: b.col, a1: a1, level: 'already', what: label,
                      why: 'already sums ' + chain.map(function (x) { return x.store; }).join(' + ')
                        + (_syoySameFormula(curF, want) ? '' : ' (as "' + curF + '" — same cells, '
                          + 'listed in another order, left as typed)') });
      return;
    }
    res.plan.push({ row: b.row, col: b.col, a1: a1, level: 'write', what: label,
                    why: 'same-store: ' + chain.map(function (x) { return x.store; }).join(' + ')
                      + '. Its "Current" reads ' + (curRow || '(blank)'),
                    from: curF || cur, to: want, formula: true,
                    note: 'Same-store total: ' + chain.map(function (x) { return x.store; }).join(' + ')
                      + ' only, the stores with a comparable ' + monthName + '. Written as a sum of '
                      + 'their own cells by salesYoyApply so it stays in step when one is corrected.\n'
                      + '⚠️ "Current" on this block is not necessarily the same set of stores. '
                      + 'The workbook\'s same-store answer is the block below.' });
  });

  // 4. the total blocks' "Current", ONLY when asked. See SYOY_SAME_STORE_CURRENT.
  if (SYOY_SAME_STORE_CURRENT && chain.length) {
    var wantCur = '=' + chain.map(function (x) { return x.currentA1; }).join('+');
    var names = chain.map(function (x) { return x.store; }).join(' + ');
    found.filter(function (b) { return !b.store; }).forEach(function (b) {
      var row = b.row + 1, a1 = _syoyA1(b.col, row);
      var cur = cellOf(row, b.col), curF = formulaOf(row, b.col);
      var label = 'total YoY "Current"';
      if (_syoySameFormula(curF, wantCur) || _syoySameChain(curF, wantCur)) {
        res.plan.push({ row: row, col: b.col, a1: a1, level: 'already', what: label,
                        why: 'already same-store (' + names + ')' });
        return;
      }
      // ⚠️ ONLY A PLUS-CHAIN. The cell found on the September tab was
      // '=F42+Q42+Z35+AK35+AV35' — a plus-chain, so replaceable. Anything else
      // is a construction this script did not write and will not overrule.
      if (curF && !_syoyIsBareNumber(curF) && !_syoyIsPlusChain(curF)) {
        res.warnings.push(label + ' holds "' + curF + '", which this script will not '
          + 'overrule. Same-store would be ' + wantCur + ' (' + names + ').');
        res.plan.push({ row: row, col: b.col, a1: a1, level: 'skip', what: label,
                        why: 'formula this script will not overrule', from: curF });
        return;
      }
      res.plan.push({ row: row, col: b.col, a1: a1, level: 'write', what: label,
                      why: 'same-store: ' + names + ', to match the "Last" above it',
                      from: curF || cur, to: wantCur, formula: true,
                      note: 'Same-store: ' + names + ' only, so this compares the same stores '
                        + 'as the "Last" above it. It was ' + (curF || cur) + ' — every store, '
                        + 'including the ones with no ' + monthName + ' — which counted MPL and '
                        + 'BAL\'s whole revenue as year-over-year growth.\n'
                        + 'The all-store month total is the TTL block\'s own Rev Tracking cell; '
                        + 'this cell is the YoY comparison and nothing else.' });
    });
  }

  return res;
}

// One store's "Last": a plain figure, and the reasons it may not be written.
//
// ⚠️ WRITTEN AS A VALUE, NOT AS A BARE-NUMBER FORMULA. sep-fix.gs pins day cells
// with '=949.33' because the daily sync would otherwise overwrite them — the
// formula IS the lock. Nothing syncs row 42: the importer writes day rows and
// the rollover writes the footer labels in MR_FOOTER, neither of which reaches
// here. A lock against a writer that does not exist would only make the cell
// look like a restatement.
function _syoyPlanNumber(res, values, formulas, b, want, what, note) {
  var a1 = _syoyA1(b.col, b.row);
  var cur = (values[b.row] || [])[b.col];
  var curF = String((formulas[b.row] || [])[b.col] || '').trim();
  if (curF && !_syoyIsBareNumber(curF)) {
    res.warnings.push(what + ' @' + a1 + ' holds the formula "' + curF + '" — left alone. '
      + 'It should be ' + want.toFixed(2) + '; a formula here means somebody wired this '
      + 'figure to a source on purpose.');
    res.plan.push({ row: b.row, col: b.col, a1: a1, level: 'skip', what: what,
                    why: 'live formula — left alone', from: curF, to: want });
    return;
  }
  if (Math.abs(Number(cur) - want) < 0.005) {
    res.plan.push({ row: b.row, col: b.col, a1: a1, level: 'already', what: what,
                    why: 'already ' + want.toFixed(2) });
    return;
  }
  res.plan.push({ row: b.row, col: b.col, a1: a1, level: 'write', what: what,
                  why: 'last year\'s full month, from the 2025 Sales Summary',
                  from: (cur === '' || cur === null || cur === undefined) ? '(blank)' : cur,
                  to: want, note: note });
}

// ---- the run ---------------------------------------------------------------

function _syoySync(dryRun, ym) {
  var map = _syoyMap();
  ym = ym || _syoyCentralMonth();
  Logger.log(dryRun ? '=== PREVIEW — nothing will be written ===' : '=== APPLYING ===');
  var ss = SpreadsheetApp.openById(SYOY_SHEET_ID);
  var sh = _syoyFindSalesTab(ss, ym);
  if (!sh) {
    Logger.log('Nothing done. The YoY block on %s\'s Sales tab is whatever the rollover left '
      + 'there, which is last month\'s figure.', ym);
    return { wrote: 0, cleared: 0, already: 0, skipped: 0, tab: null };
  }

  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();
  var res = _syoyPlan(values, formulas, ym, map);

  Logger.log('tab "%s" (%s x %s) — month %s, store blocks %s',
    sh.getName(), lastRow, lastCol, ym, JSON.stringify(res.bases));
  Logger.log('%s YoY block(s) found: %s', res.blocks.length,
    res.blocks.map(function (b) {
      return (b.store || 'total') + '@' + _syoyA1(b.col, b.row);
    }).join(', ') || '(none)');

  // ⚠️ NO BLOCKS IS NOT A QUIET SUCCESS. A tab whose labels moved would find
  // nothing, write nothing and log a tidy "0 changes" — which is exactly what a
  // correct tab looks like.
  if (!res.blocks.length) {
    Logger.log('!! not one "YoY" label with a "Last" under it on this tab. Either the block '
      + 'was renamed or it is not there any more. NOTHING was written and the YoY figures '
      + 'on this tab are unverified — look at the tab before trusting them.');
    return { wrote: 0, cleared: 0, already: 0, skipped: 0, tab: sh.getName(), blocks: 0 };
  }

  var out = { wrote: 0, cleared: 0, already: 0, skipped: 0, tab: sh.getName(),
              blocks: res.blocks.length };
  res.plan.forEach(function (p) {
    if (p.level === 'already') {
      Logger.log('  %s @%s: %s', p.what, p.a1, p.why);
      out.already++;
      return;
    }
    if (p.level === 'skip') {
      Logger.log('  %s @%s: SKIPPED — %s', p.what, p.a1, p.why);
      out.skipped++;
      return;
    }
    Logger.log('  %s @%s: %s -> %s%s', p.what, p.a1,
      (p.from === '' || p.from === null || p.from === undefined) ? '(blank)' : p.from,
      p.level === 'clear' ? '(empty)' : p.to,
      p.why ? '   [' + p.why + ']' : '');
    if (!dryRun) {
      var rng = sh.getRange(p.row + 1, p.col + 1);
      if (p.level === 'clear') rng.clearContent();
      else if (p.formula) rng.setFormula(p.to);
      else { rng.setValue(p.to); rng.setNumberFormat(SYOY_MONEY); }
      if (p.note) rng.setNote(p.note);
    }
    if (p.level === 'clear') out.cleared++; else out.wrote++;
  });

  if (res.warnings.length) {
    Logger.log('');
    res.warnings.forEach(function (w) { Logger.log('  !! %s', w); });
  }

  Logger.log('');
  Logger.log('%s: %s written, %s cleared, %s already right, %s skipped, %s warning(s)',
    dryRun ? 'WOULD WRITE' : 'WROTE', out.wrote, out.cleared, out.already, out.skipped,
    res.warnings.length);
  if (dryRun) Logger.log('Nothing was written. Run salesYoyApply() to write it.');
  return out;
}

// ============================================================================
// salesYoyAudit — every Sales tab in the workbook, checked against the map.
//
// READ-ONLY. Writes nothing.
//
// The September figures were wrong for as long as nobody compared two tabs, and
// the rollover has been copying that block forward since MPL and BAL opened —
// so "is any other month wrong too?" is a question with a real answer, and this
// is it. One run, one log, no writes.
// ============================================================================
function salesYoyAudit() {
  var map = _syoyMap();
  var ss = SpreadsheetApp.openById(SYOY_SHEET_ID);
  var tabs = ss.getSheets().filter(function (sh) { return !!_syoyTabMonth(sh.getName()); });
  Logger.log('=== YoY AUDIT — %s Sales tab(s), nothing will be written ===', tabs.length);
  var bad = 0;
  tabs.sort(function (a, b) {
    return _syoyTabMonth(a.getName()) < _syoyTabMonth(b.getName()) ? -1 : 1;
  }).forEach(function (sh) {
    var ym = _syoyTabMonth(sh.getName());
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
    var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();
    var res = _syoyPlan(values, formulas, ym, map);
    var wrong = res.plan.filter(function (p) { return p.level === 'write' || p.level === 'clear'; });
    Logger.log('');
    Logger.log('%s (%s): %s block(s), %s already right, %s WRONG', sh.getName(), ym,
      res.blocks.length, res.plan.filter(function (p) { return p.level === 'already'; }).length,
      wrong.length);
    wrong.forEach(function (p) {
      bad++;
      Logger.log('   %s @%s: holds %s, should be %s', p.what, p.a1,
        (p.from === '' || p.from === null || p.from === undefined) ? '(blank)' : p.from,
        p.level === 'clear' ? '(empty — no comparable year)' : p.to);
    });
    res.warnings.forEach(function (w) { Logger.log('   !! %s', w); });
  });
  Logger.log('');
  Logger.log(bad ? '%s cell(s) across the workbook do not match the month their tab holds. '
    + 'Run salesYoyApply("<yyyy-mm>") per tab to fix one, or salesYoyApply() for the current '
    + 'month.' : 'Every Sales tab compares itself against its own month a year earlier.', bad);
  return bad;
}
