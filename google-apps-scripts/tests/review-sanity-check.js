// _reviewSanity — what the importer will and will not write into the Google
// Reviews block.
//
// THE FAILURE THIS RECORDS. September 2026: the Sept 1 Day End Reports carried a
// month-to-date review figure that was still August's (OVL 45, against a goal of
// 40 for the whole month). The column was empty, and the guard's rule was that an
// empty column has no baseline and so goes in on trust. 45 landed on day 1.
//
// From then on the guard worked exactly as designed and that was the problem:
// every genuine September count was smaller than 45, so "month-to-date reviews
// went DOWN" refused all five stores every single day. Six days later the sheet
// still held August's finals, the TTL row (a MAX over the column) reported them
// as the month to date, and the Live Dashboard told all five stores they had
// already met a review goal they had not started — in a month where reviews are
// half the bonus.
//
// Two things are asserted here:
//   1. An empty column is a baseline of ZERO, so REVIEW_MAX_JUMP guards the first
//      write of the month too and an all-time-shaped total is refused on day 1.
//   2. The checks that already worked still work, including the one from the
//      earlier fix: the walk up the column must stop at the top of the day block
//      so the GOAL row is never mistaken for yesterday's count.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'sales-email-import.gs');
// ⚠️ NORMALISE THE LINE ENDINGS FIRST. This file is CRLF, so the "\n}\n" that
// finds the end of a function never matched and grab() returned the empty string
// — which evals cleanly, defines nothing, and fails later as "_reviewSanity is
// not defined" rather than as a bad read. The other harnesses in here read
// LF files and never hit it.
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

const grab = (name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
// _num is what the guard reads cells through, so the real one is used rather than
// a stand-in that might be more forgiving than the sheet.
eval(grab('_num'));
eval(grab('_reviewSanity'));

// Lifted from the source rather than restated, so raising the ceiling in the
// importer moves this harness with it instead of silently disagreeing.
const JUMP_DECL = src.match(/var REVIEW_MAX_JUMP\s*=\s*\d+\s*;/);
if (!JUMP_DECL) throw new Error('missing REVIEW_MAX_JUMP');
eval(JUMP_DECL[0]);
const MAX_JUMP = REVIEW_MAX_JUMP;

const DAY1_DECL = src.match(/var REVIEW_MAX_FIRST_DAY\s*=\s*\d+\s*;/);
if (!DAY1_DECL) throw new Error('missing REVIEW_MAX_FIRST_DAY');
eval(DAY1_DECL[0]);
const MAX_DAY1 = REVIEW_MAX_FIRST_DAY;

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};
const refused = (r) => typeof r === 'string' && r.length > 0;

// The reviews mini-table as it actually sits on a Buy tab: title, goal row,
// header row, then the day rows. Column 0 is the tab's own Date column and
// column 1 is the store's count — the shape _reviewSanity walks.
//   row 0  "Google Reviews"
//   row 1  Goal          <- 40. A plausible whole number directly above the data.
//   row 2  "Date"/"OVL"  <- header
//   rows 3+ days 1..30
const RCOL = 1;
const DAY1 = 3;
function grid(counts) {
    const g = [['Google Reviews', ''], ['Goal', 40], ['Date', 'OVL']];
    for (let d = 1; d <= 30; d++) {
        const v = counts[d];
        g.push([d, v === undefined ? '' : v]);
    }
    return g;
}
const rowOf = (day) => DAY1 + (day - 1);

console.log('REVIEW_MAX_JUMP = ' + MAX_JUMP);

console.log('\nthe September 2026 failure');
{
    // 1. The exact value that poisoned the month, arriving on the exact day.
    const empty = grid({});
    const r = _reviewSanity(empty, RCOL, rowOf(1), 45);
    ok(refused(r), 'day 1 of an empty month refuses 45 (August\'s final, goal is 40)', r || '(written!)');
    // The message has to name the real cause, because it is what someone reads in
    // the log at 7am. "Probably an all-time total" was the old guess; the five
    // September reports proved it is specifically a month-boundary carryover, and
    // the day-1 rule says so.
    ok(refused(r) && /LAST month/.test(r), '...and names the carryover as the cause', r);

    // 2. Once it is in, everything after it is refused. This is what actually
    //    happened for six days, and it is correct behaviour on a poisoned
    //    column — which is why the day-1 check is the one that matters.
    const poisoned = grid({ 1: 45 });
    const r2 = _reviewSanity(poisoned, RCOL, rowOf(2), 5);
    ok(refused(r2) && /went DOWN/.test(r2), 'a poisoned column refuses the genuine count behind it', r2);
}

// The real thing. Five Day End Report sequences, Sept 1-5 2026, straight off
// diagnoseBuyingReviews. Every store reported its AUGUST total on the 1st and its
// true September count from the 2nd — so day 1 must be refused at all five and
// every day after must be written.
console.log('\nthe five real September 2026 sequences');
{
    const REAL = {
        OVL: [45, 2, 5, 6, 6],
        WSP: [42, 1, 3, 6, 6],
        MPL: [38, 1, 5, 9, 9],
        LEE: [37, 0, 0, 1, 1],
        BAL: [36, 1, 2, 2, 2],
    };
    Object.keys(REAL).forEach((store) => {
        const seq = REAL[store];
        // Day 1 first, against an empty column, exactly as it happened.
        const d1 = _reviewSanity(grid({}), RCOL, rowOf(1), seq[0]);
        ok(refused(d1), store + ' day 1 refuses ' + seq[0] + " (August's total)");

        // Then replay days 2..5 into a column whose day 1 stayed empty, which is
        // what the sheet looks like once the poison is cleared.
        const counts = {};
        let allWritten = true;
        for (let i = 1; i < seq.length; i++) {
            const day = i + 1;
            const why = _reviewSanity(grid(counts), RCOL, rowOf(day), seq[i]);
            if (why) { allWritten = false; ok(false, store + ' day ' + day + ' refused ' + seq[i], why); }
            counts[day] = seq[i];
        }
        if (allWritten) ok(true, store + ' days 2-5 all written (' + seq.slice(1).join(', ') + ')');
    });
}

console.log('\nan ordinary month still imports');
{
    const empty = grid({});
    ok(_reviewSanity(empty, RCOL, rowOf(1), 0) === null, 'day 1 accepts 0');
    ok(_reviewSanity(empty, RCOL, rowOf(1), 2) === null, 'day 1 accepts 2');
    ok(_reviewSanity(empty, RCOL, rowOf(1), MAX_DAY1) === null,
        'day 1 accepts exactly REVIEW_MAX_FIRST_DAY (' + MAX_DAY1 + ')');
    ok(refused(_reviewSanity(empty, RCOL, rowOf(1), MAX_DAY1 + 1)),
        'day 1 refuses one past it (' + (MAX_DAY1 + 1) + ')');
    // The hole REVIEW_MAX_FIRST_DAY exists to close: a carryover small enough to
    // clear REVIEW_MAX_JUMP. A store with a 15/month goal would do this.
    ok(refused(_reviewSanity(empty, RCOL, rowOf(1), 15)),
        'day 1 refuses a 15 carryover, which REVIEW_MAX_JUMP (' + MAX_JUMP + ') would have let in');
    // Mid-month the wider ceiling still applies: day 2 is not day 1.
    ok(_reviewSanity(grid({}), RCOL, rowOf(2), MAX_DAY1 + 1) === null,
        'day 2 is not held to the day-1 ceiling');

    const running = grid({ 1: 2, 2: 5, 3: 5, 4: 9 });
    ok(_reviewSanity(running, RCOL, rowOf(5), 11) === null, 'a normal climb is written');
    ok(_reviewSanity(running, RCOL, rowOf(5), 9) === null, 'a flat day is written (nobody reviewed)');
    ok(refused(_reviewSanity(running, RCOL, rowOf(5), 8)), 'a drop is refused');
    ok(refused(_reviewSanity(running, RCOL, rowOf(5), 9 + MAX_JUMP + 1)),
        'an implausible one-day jump is refused');
}

console.log('\ngaps in the column');
{
    // The guard walks UP for the last day that carries a count, so a store whose
    // report went missing for a few days is compared against its real last
    // figure, not against a blank.
    const gappy = grid({ 1: 3, 2: 6 });
    ok(_reviewSanity(gappy, RCOL, rowOf(6), 8) === null, 'skips blank days to find the last count');
    ok(refused(_reviewSanity(gappy, RCOL, rowOf(6), 4)), '...and still refuses a drop against it');
}

console.log('\nthe earlier fix: the Goal row is not yesterday');
{
    // Regression guard. Before the day-block stop, walking up from day 1 ran
    // straight into the Goal cell (40) and refused every store on the first real
    // run: "month-to-date reviews went DOWN (40 -> 5)". A legitimate small count
    // on day 1 must still be written.
    const empty = grid({});
    const r = _reviewSanity(empty, RCOL, rowOf(1), 5);
    ok(r === null, 'day 1 accepts 5 without reading the Goal row as a baseline', r || '(written)');
}

console.log('\nnonsense');
{
    ok(refused(_reviewSanity(grid({}), RCOL, rowOf(1), -1)), 'a negative count is refused');
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
