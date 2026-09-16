// Pull _pgAdminEditHtml out of the bundle and render both shapes.
const fs = require('fs');
const src = fs.readFileSync('speeks.js', 'utf8');
const cut = (name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('not found: ' + name);
    const e = src.indexOf('\n}\n', i);
    return src.slice(i, e + 3);
};
const _pgEsc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
eval(cut('_pgAdminEditHtml'));

let fails = 0;
const has = (html, needle, want, label) => {
    const got = html.includes(needle);
    const ok = got === want;
    if (!ok) fails++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
};

const req = _pgAdminEditHtml({ id: 1, label: 'Home/Lock Screen', cond: null, rep: false, note: '', img: null });
const opt = _pgAdminEditHtml({ id: 2, label: 'Carrier Unlock Status', cond: 'the tablet is a cellular model',
                               rep: true, note: 'Settings Screen Showing Carrier Unlocked', img: null });

console.log('REQUIRED shows one field');
has(req, 'data-mode="req"', true,  'form opens in required mode');
has(req, 'id="pg-f-opt" hidden', true, 'the optional half is hidden');
has(req, 'Photo Name', true,       'the name field is there');
has(req, '>Required</button>', true, 'both toggle halves render');
has(req, 'pg-eseg-b on"', true,    'Required is the selected half');

console.log('\nOPTIONAL shows two fields plus the checkbox');
has(opt, 'data-mode="opt"', true,  'form opens in optional mode');
has(opt, 'id="pg-f-opt" hidden', false, 'the optional half is visible');
has(opt, 'the tablet is a cellular model', true, 'the description is loaded');
has(opt, 'id="pg-f-rep" checked', true, 'repeatable survives the round trip');
has(opt, 'class="pg-erow pg-erow-edit cond"', true, 'the row keeps its red treatment');

console.log('\nthe slot wording is preserved, not shown');
has(opt, 'type="hidden" id="pg-f-note" value="Settings Screen Showing Carrier Unlocked"', true,
    'carried through so Save cannot erase it');
has(opt, 'Words on the Slot', false, 'and is no longer a visible field');

console.log('\nnothing goes through unescaped');
const evil = _pgAdminEditHtml({ id: 3, label: '"><script>x</script>', cond: 'a & b', rep: false, note: '', img: null });
has(evil, '<script>', false, 'a name cannot break out of the attribute');
has(evil, 'a &amp; b', true,  'and the ampersand is escaped');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
