// _pgCondNote — what a conditional card has left to say once its own name has
// said it.
//
// THE PROBLEM THIS FIXES. Every conditional card used to print "ONLY IF: <the
// condition>" in red capitals underneath its title. On the seeded sheets four of
// the six conditions ARE the title — "Cosmetic Flaws" over a condition of
// "Cosmetic flaws", "Extra Accessories" over "Extra accessories" — so those
// cards said the same phrase twice, the second time shouting. Five such cards in
// a grid of sixteen is most of what made the board feel loud, and none of it
// was information.
//
// So the rule: print the condition ONLY where it says something the label does
// not. "Setting Unlock Screen" genuinely needs "only if the unlock screen is
// set". "Cosmetic Flaws" needs nothing but the OPTIONAL tag.
//
// The real function is lifted out of speeks.js rather than restated, so a change
// to the rule moves this harness with it.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'speeks.js');
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

const grab = (name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
const constFn = (name) => {
    const i = src.indexOf('const ' + name + ' =');
    if (i < 0) throw new Error('missing ' + name);
    // End of STATEMENT, not first semicolon: _pgEsc's body is full of HTML
    // entities and the first ';' in it belongs to '&amp;'. Cutting there returned
    // a half-open string literal, which fails as a syntax error inside eval and
    // looks nothing like the bad read it actually is.
    const end = src.indexOf(';\n', i);
    if (end < 0) throw new Error('unterminated ' + name);
    return src.slice(i, end + 1).replace('const ', 'var ');
};
// _pgEsc is what the note escapes through, so the real one is used rather than a
// stand-in that might let markup past.
eval(constFn('_pgEsc'));
eval(constFn('_pgNorm'));
eval(grab('_pgCondNote'));

let fails = 0;
const is = (what, got, want) => {
    const ok = String(got) === String(want);
    if (!ok) fails++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
};

console.log('the seeded sheets: a condition that only repeats the label says nothing');
// Straight off the three printouts, exactly as migration 0080 seeds them.
is('Everything Included',  _pgCondNote({ label: 'Everything Included', cond: 'Everything Included' }), '');
is('LCD Flaws (repeatable)', _pgCondNote({ label: 'LCD Flaws', cond: 'LCD flaws', rep: true }), 'Take as many as you need');
is('Cosmetic Flaws (repeatable)', _pgCondNote({ label: 'Cosmetic Flaws', cond: 'Cosmetic flaws', rep: true }), 'Take as many as you need');
is('Extra Accessories (repeatable)', _pgCondNote({ label: 'Extra Accessories', cond: 'Extra accessories', rep: true }), 'Take as many as you need');

console.log('\n...and a condition that adds something still says it');
// Migration 0082. The condition is a sentence about the tablet in the lister's
// hand, not a second copy of the label, so "Only if <condition>" comes out as
// English. The old row said "Unlock screen set", which rendered as "Only if
// unlock screen set" and read as a PIN rather than a carrier unlock.
is('Carrier Unlock Status', _pgCondNote({ label: 'Carrier Unlock Status', cond: 'The tablet is a cellular model' }),
    'Only if the tablet is a cellular model');
is('Apple Warranty', _pgCondNote({ label: 'Apple Warranty', cond: 'Warranty still active' }),
    'Only if warranty still active');

console.log('\nthe sameness test');
{
    // Case and punctuation are not facts. Neither is a label that contains its
    // own condition, which is how a DM will naturally write one.
    is('case alone is not a difference', _pgCondNote({ label: 'Screen Off', cond: 'SCREEN OFF' }), '');
    is('punctuation alone is not a difference', _pgCondNote({ label: "Processor (CPU's)", cond: 'Processor CPUs' }), '');
    is('a label containing the condition says nothing new',
        _pgCondNote({ label: 'Box and Accessories Included', cond: 'Accessories Included' }), '');
    is('a condition containing the label says nothing new',
        _pgCondNote({ label: 'Warranty', cond: 'Warranty still active on the device' }), '');
    is('a genuinely different condition is kept',
        _pgCondNote({ label: 'Charging Port', cond: 'Port is damaged' }), 'Only if port is damaged');
}

console.log('\nboth halves together');
is('different condition AND repeatable',
    _pgCondNote({ label: 'Charging Port', cond: 'Port is damaged', rep: true }),
    'Only if port is damaged &middot; Take as many as you need');

console.log('\nnothing goes through unescaped');
{
    // The note is written into innerHTML, so a condition typed by a DM has to be
    // escaped on the way. A category name is DM-entered, not public, but the
    // board renders for every store and a stray < would silently eat the card.
    const out = _pgCondNote({ label: 'Port', cond: '<b>broken</b> & bent' });
    is('markup in a condition is escaped', /<b>/.test(out), false);
    is('...and the ampersand with it', /&amp;/.test(out), true);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
