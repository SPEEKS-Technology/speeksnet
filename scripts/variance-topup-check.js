// _vrBuyerReplyLines — how many lines a singled-out buyer has to answer for.
//
// THE RULE. A buyer picked on their own is topped up to their twelve worst, so
// someone with four lines below -10% still gets an exercise worth doing. Two or
// more picked and the top-up stops: everyone picked answers for their lines at
// -10% and worse, and nothing else.
//
// WHY. MPL August 2026 had four people negative on team variance. All four were
// picked, all four were topped up to twelve, and the board came back with 30
// owed lines — most of them at -5.0%, which is both too small to explain and
// too numerous to start. Ethan: "anything more than that would be too much work
// and I would rather it be like it used to be when that occurs."
//
// The functions below are lifted out of speeks.js, not copied, so this fails if
// the rule moves.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'speeks.js');
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

const grab = (name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
// The constants come out of the source too — raising the floor or the buyer
// limit in speeks.js must move this harness with it, not silently disagree.
const constant = (name) => {
    const i = src.indexOf('const ' + name + ' =');
    if (i < 0) throw new Error('missing ' + name);
    // Handed back as a var: a const declared inside eval is block-scoped to
    // that eval and never reaches the harness, which fails later as "not
    // defined" rather than as a bad read.
    return src.slice(i, src.indexOf(';', i) + 1).replace('const ', 'var ');
};
eval(constant('_VR_VARIANCE_CUTOFF'));
eval(constant('_VR_BUYER_MIN_LINES'));
eval(constant('_VR_TOPUP_MAX_BUYERS'));
eval(grab('_vrBuyerSummary'));
eval(grab('_vrBuyerReplyLines'));

let fails = 0;
const is = (what, got, want) => {
    const ok = String(got) === String(want);
    if (!ok) fails++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}   got ${got}, want ${want}`);
};

// A parsed file, in the shape _vrParse produces: items are the lines at or
// below the cutoff, minor are the merely-negative ones held back as top-up.
function file(spec) {
    const items = [], minor = [];
    Object.keys(spec).forEach((buyer) => {
        spec[buyer].forEach((pct) => {
            const line = { buyer_name: buyer, variance_pct: pct, order_number: buyer + pct };
            (pct <= _VR_VARIANCE_CUTOFF ? items : minor).push(line);
        });
    });
    return { items, minor };
}
const owed = (parsed, picked) => {
    const topUp = picked.length <= _VR_TOPUP_MAX_BUYERS;
    const set = new Set();
    _vrBuyerSummary(parsed)
        .filter((b) => picked.includes(b.name))
        .forEach((b) => _vrBuyerReplyLines(b, topUp).forEach((l) => set.add(l)));
    return set.size;
};

// MPL August, as it went up: four buyers, each with a handful of real damage and
// a long tail of -5s. Numbers per buyer are invented; the SHAPE is the point.
const MPL = file({
    'Noah Webb':      [-50, -50, -22, -13, -5.7, -5, -5, -5, -5, -5, -5, -5, -5, -5],
    'Olivia Huxtable':[-50, -18, -12, -6.7, -5, -5, -5, -5, -5, -5, -5, -5, -5],
    'Joseph Ortega':  [-31, -14, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5],
    'Calvin Meadows': [-27, -11, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5],
});

console.log('the MPL August shape');
is('four picked: cutoff lines only', owed(MPL, ['Noah Webb', 'Olivia Huxtable', 'Joseph Ortega', 'Calvin Meadows']), 4 + 3 + 2 + 2);
is('three picked: still cutoff only', owed(MPL, ['Noah Webb', 'Olivia Huxtable', 'Joseph Ortega']), 4 + 3 + 2);
is('two picked: still cutoff only', owed(MPL, ['Noah Webb', 'Olivia Huxtable']), 4 + 3);
is('one picked: topped up to the floor', owed(MPL, ['Joseph Ortega']), _VR_BUYER_MIN_LINES);

console.log('\nthe floor, when it still applies');
{
    const light = file({ Solo: [-40, -30, -20, -11, -5, -5, -5, -5, -5, -5, -5, -5, -5] });
    is('a light buyer alone gets twelve', owed(light, ['Solo']), 12);
    // A FLOOR, not a cap: dropping genuinely bad lines to hit a round number
    // would be indefensible, so twenty at the cutoff stay twenty.
    const heavy = file({ Solo: Array.from({ length: 20 }, (_, i) => -11 - i).concat([-5, -5]) });
    is('a heavy buyer alone keeps all twenty', owed(heavy, ['Solo']), 20);
    // Nothing to top up FROM. Must not invent lines or throw.
    const clean = file({ Solo: [-14, -12] });
    is('alone with no minor tail stays at two', owed(clean, ['Solo']), 2);
}

console.log('\nno minor line survives a multi-pick');
{
    const both = ['Noah Webb', 'Olivia Huxtable'];
    const topUp = both.length <= _VR_TOPUP_MAX_BUYERS;
    const lines = [];
    _vrBuyerSummary(MPL).filter((b) => both.includes(b.name))
        .forEach((b) => _vrBuyerReplyLines(b, topUp).forEach((l) => lines.push(l)));
    is('worst line in the set is at the cutoff or below',
        lines.every((l) => l.variance_pct <= _VR_VARIANCE_CUTOFF), 'true');
    is('...so no -5 is owed', lines.filter((l) => l.variance_pct > _VR_VARIANCE_CUTOFF).length, 0);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
