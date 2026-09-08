// Which store Monthly Breakdown's Store View is looking at.
//
// This was decided in three places that disagreed. The fetch asked whether the
// picker was LAID OUT (`sel.offsetParent === null`) and treated "not laid out"
// as "this person has no picker, use their own store" — but a District
// Manager's own store is "ALL", and the picker's .dd-host was stuck hidden
// because the select is born style="display:none" in workspace.html and only
// the native control was ever un-hidden. So the DM fetched store=ALL and got
// "No data available", while the subtitle beside it read "OVL · Store View"
// because IT read sel.value directly. Store managers were unaffected, which is
// what made it look like a permissions problem.
//
// _mbStore() decides by ROLE. These assertions are the reason it can be trusted
// not to drift back: they cover every role, and a session with no usable store.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'speeks.js'), 'utf8');
const grab = name => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    return src.slice(i, src.indexOf('\n}\n', i) + 2);
};

// The five stores, read from the file rather than retyped — a harness that
// carries its own copy of a constant stops testing the moment one of them moves.
global.MB_STORES = eval((src.match(/const MB_STORES = (\[[^\]]*\]);/) || [])[1]);
const STORES = global.MB_STORES;

let role = '', own = '', selValue = 'OVL', selPresent = true;
global.sessionStorage = {
    getItem: k => (k === 'speeksUserRole' ? role : k === 'speeksUserStore' ? own : null)
};
global.document = {
    getElementById: id => (id === 'mbStoreSelect' && selPresent ? { value: selValue } : null)
};
eval(grab('_mbStore'));

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};
const at = (r, o, v) => { role = r; own = o; selValue = v === undefined ? 'OVL' : v; return _mbStore(); };

console.log('== The roles that pick ==');
ok(at('District Manager', 'ALL', 'LEE') === 'LEE', 'a DM gets the picker\'s store', at('District Manager', 'ALL', 'LEE'));
ok(at('CEO', 'ALL', 'BAL') === 'BAL', 'so does the CEO', at('CEO', 'ALL', 'BAL'));
ok(at('district manager', 'ALL', 'OVL') === 'OVL', 'case does not matter', at('district manager', 'ALL', 'OVL'));
ok(at('  District Manager ', 'ALL', 'MPL') === 'MPL', 'nor does whitespace', at('  District Manager ', 'ALL', 'MPL'));

console.log('== The bug this replaced ==');
// The DM's own store IS "ALL", so anything that falls back to it fetches a
// store that does not exist. That is precisely what produced "No data
// available." on a panel whose subtitle said OVL.
ok(at('District Manager', 'ALL', 'OVL') !== 'ALL', 'a DM is never sent to store "ALL"',
   at('District Manager', 'ALL', 'OVL'));
ok(STORES.indexOf(at('District Manager', 'ALL', 'OVL')) >= 0,
   'and always to one of the five', at('District Manager', 'ALL', 'OVL'));

console.log('== The roles that do NOT pick ==');
// The picker is on the page for everyone — it is only HIDDEN for these roles —
// so its value is "OVL" whatever store they are at. Reading it would have sent
// a LEE owner-manager's saved figures into OVL.
ok(at('Owner Manager', 'LEE', 'OVL') === 'LEE', 'an owner-manager at LEE gets LEE, not the picker\'s OVL',
   at('Owner Manager', 'LEE', 'OVL'));
ok(at('Manager', 'BAL', 'OVL') === 'BAL', 'a manager gets their own store', at('Manager', 'BAL', 'OVL'));
ok(at('Assistant Manager', 'MPL', 'WSP') === 'MPL', 'so does an ASM, whatever the hidden picker says',
   at('Assistant Manager', 'MPL', 'WSP'));
ok(at('employee', 'wsp', 'OVL') === 'WSP', 'a lowercase store still matches', at('employee', 'wsp', 'OVL'));

console.log('== A session with nothing usable ==');
ok(at('Manager', '', 'OVL') === STORES[0], 'no store on the session -> the first store, not blank',
   at('Manager', '', 'OVL'));
ok(at('Manager', 'ALL', 'OVL') === STORES[0], '"ALL" is not a store -> the first store',
   at('Manager', 'ALL', 'OVL'));
ok(at('', '', 'OVL') === STORES[0], 'no role either -> still a real store', at('', '', 'OVL'));
{
    // The panel exists on one page; on any other the select is simply absent.
    selPresent = false;
    ok(at('District Manager', 'ALL', 'OVL') === STORES[0], 'no picker in the DOM -> the first store',
       at('District Manager', 'ALL', 'OVL'));
    ok(at('Manager', 'LEE', 'OVL') === 'LEE', 'and a manager still gets their own', at('Manager', 'LEE', 'OVL'));
    selPresent = true;
}

console.log('== A picker holding something that is not a store ==');
ok(at('District Manager', 'ALL', '') === STORES[0], 'an empty picker falls through, it does not fetch ""',
   at('District Manager', 'ALL', ''));
ok(at('District Manager', 'LEE', 'ZZZ') === 'LEE', 'a junk value falls through to the DM\'s own store if it is real',
   at('District Manager', 'LEE', 'ZZZ'));

console.log('== The fetch, the save and the subtitle all ask the same function ==');
// The three call sites, asserted in the source. Three copies of this decision
// is how they came to disagree in the first place.
const store = src.slice(src.indexOf('async function fetchMonthlyBriefStore('));
ok(/const store = _mbStore\(\);/.test(store.slice(0, 900)), 'fetchMonthlyBriefStore uses it');
const save = src.slice(src.indexOf('async function mbSaveBriefStore('));
ok(/const store = _mbStore\(\);/.test(save.slice(0, 400)), 'mbSaveBriefStore uses it');
ok(/_mbStore\(\) \+ ' · Store View'/.test(src), 'and so does the subtitle');
ok(!/sel\.offsetParent === null \) \{ store =/.test(src) && !/offsetParent === null\) \{ store =/.test(src),
   'nothing decides the store from whether a control is laid out any more');

console.log('== The picker is actually shown ==');
// Fixing the decision without fixing the control would leave a DM correct and
// still unable to change stores.
ok(/_ddMirrorGate\(sel, show\);/.test(src), 'the store picker mirrors its gate onto the .dd-host');
ok((src.match(/_ddMirrorGate\(sel, (true|false)\);/g) || []).length >= 3,
   'and so does the Overview month picker, born hidden the same way',
   String((src.match(/_ddMirrorGate\(sel, (true|false)\);/g) || []).length));

console.log(fails ? '\n' + fails + ' FAILED' : '\nall pass');
process.exit(fails ? 1 : 0);
