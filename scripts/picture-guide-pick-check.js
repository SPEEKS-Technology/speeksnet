// The type-ahead, lifted out of the keydown handler exactly as written.
const TAH_MS = 900;
const OPTS = [
    'On its own (no group)', 'Computer Parts', 'Gaming', 'Phones',
    'Smart Tablets', 'Smart Watches', 'Speakers', 'Wearables',
];
// A field, with the highlight starting on whatever is currently the answer.
const mk = (cur) => ({ buf: '', at: 0, hi: Math.max(0, OPTS.indexOf(cur)) });

const wrapIdx = (i, n) => ((i % n) + n) % n;
// The two branches of the real handler.
const typeKey = (st, ch, nowMs) => {
    st.buf = (nowMs - st.at > TAH_MS ? '' : st.buf) + ch.toLowerCase();
    st.at = nowMs;
    const buf = st.buf;
    let hit = OPTS.findIndex(o => o.trim().toLowerCase().startsWith(buf));
    if (hit < 0) hit = OPTS.findIndex(o => o.trim().toLowerCase().includes(buf));
    if (hit >= 0) st.hi = hit;
    return OPTS[st.hi];
};
const arrow = (st, d) => { st.hi = wrapIdx(st.hi + d, OPTS.length); return OPTS[st.hi]; };

let fails = 0;
const eq = (label, got, want) => {
    const ok = got === want; if (!ok) fails++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}\n       got  ${got}\n       want ${want}`);
};

console.log('typing walks the highlight, the list never shrinks');
let st = mk('Computer Parts');
eq('"s" jumps to the first S',        typeKey(st, 's', 1000), 'Smart Tablets');
eq('"sm" stays there',                typeKey(st, 'm', 1100), 'Smart Tablets');
eq('"sma" still',                     typeKey(st, 'a', 1200), 'Smart Tablets');
eq('"smart w" reaches Watches',       ['r','t',' ','w'].reduce((_, c, k) => typeKey(st, c, 1300 + k * 50), null), 'Smart Watches');

console.log('\nthe buffer starts over after a pause, like a native select');
st = mk('Computer Parts');
typeKey(st, 's', 1000);
eq('"s" then a long pause then "p"', typeKey(st, 'p', 1000 + TAH_MS + 1), 'Phones');
eq('...and the buffer really is just "p"', st.buf, 'p');

console.log('\ncontains is the fallback, so a middle word still works');
st = mk('Computer Parts');
eq('"wat" finds Smart Watches', ['w','a','t'].reduce((_, c, k) => typeKey(st, c, 2000 + k * 50), null), 'Smart Watches');
eq('"gam" finds Gaming',        (st = mk(''), ['g','a','m'].reduce((_, c, k) => typeKey(st, c, 3000 + k * 50), null)), 'Gaming');

console.log('\na miss leaves the highlight where it was');
st = mk('Gaming');
eq('"zzz" changes nothing', ['z','z','z'].reduce((_, c, k) => typeKey(st, c, 4000 + k * 50), null), 'Gaming');

console.log('\narrows move one row and wrap');
st = mk('On its own (no group)');
eq('up from the top wraps to the end', arrow(st, -1), 'Wearables');
eq('down wraps back to the top',       arrow(st, 1),  'On its own (no group)');
st = mk('Phones');
eq('down one', arrow(st, 1), 'Smart Tablets');
eq('up one',   arrow(st, -1), 'Phones');

console.log('\nthe list is opened on the current answer, not the top');
eq('a category in Smart Watches opens there', OPTS[mk('Smart Watches').hi], 'Smart Watches');
eq('an ungrouped one opens on the first row', OPTS[mk('').hi], 'On its own (no group)');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
