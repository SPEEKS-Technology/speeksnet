// CONFIRM SHOTS — the gold set's shot-label screen (2026-10-16).
//
//   powershell -File scripts/browser-check.ps1 pq-confirm-check.js
//
// One key per photo is the whole point: Enter keeps the grade's label and moves
// on, a shot key replaces it (and moves on), Shift+shot adds a second one, and
// Shift+Enter saves a listing that is right throughout. DM/CEO only. The photos
// shown are Shopify CDN / object URLs — never a Supabase /render/image/
// transform (100 a cycle on Pro).

// Stubbed ONCE, before anything runs: a save goes through _pqPost, and a
// per-test stub would be gone by the time an awaited call reached it.
var pqcPosts = [];
_pqPost = function (payload) { pqcPosts.push(payload); return Promise.resolve({ ok: true, status: 200, body: { ok: true } }); };
_pqFetch = function () { return Promise.resolve(pqcData()); };

function pqcData() {
    return {
        target: 40, total: 3, sheet: 'video-games', misaligned: ['gid://shopify/Product/9'], flags: [],
        sheets: [{ slug: 'video-games', name: 'Video Games', graded: 106, confirmed: 3, left: 50, need: 37 },
                 { slug: 'lenses', name: 'Lenses', graded: 16, confirmed: 0, left: 16, need: 16 }],
        guide: {
            'video-games': { name: 'Video Games', shots: [
                { label: 'Front of Game', cond: null, img: 'https://x.supabase.co/storage/v1/object/public/picture-guide/a.jpg' },
                { label: 'Back of Game', cond: null, img: null },
                { label: 'Opened Case', cond: null, img: null }] },
            'lenses': { name: 'Lenses', shots: [{ label: 'Front of Lens', cond: null, img: null }] },
        },
        listings: [{ store: 'OVL', productId: 'gid://shopify/Product/1', sku: 'SKU-1', title: 'Game One', sheet: 'video-games',
                     model: 'claude-opus-5-5', stamp: 'pq-v18:abc',
                     photos: [1, 2, 3].map(function (n) {
                         return { n: n, src: 'https://cdn.shopify.com/s/files/1/p' + n + '.jpg', img: 'https://cdn.shopify.com/s/files/1/p' + n + '.jpg?width=1200',
                                  w: 1080, h: 1080, said: [['Front of Game'], ['Back of Game'], ['Extra']][n - 1] };
                     }) }],
    };
}
function pqcKey(key, shift) {
    var code = /^[0-9]$/.test(key) ? 'Digit' + key : /^[a-z]$/i.test(key) ? 'Key' + key.toUpperCase() : key;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: shift && /^[0-9]$/.test(key) ? '!' : key, code: code, shiftKey: !!shift, bubbles: true }));
}
function pqcAs(role) { sessionStorage.setItem('speeksUserRole', role); }

t('a store manager gets no entry and no screen', function () {
    pqcAs('manager');
    if (_pqcMayUse()) return 'manager may use it';
    pqConfirmOpen();
    var el = document.getElementById('pqConfirmOverlay');
    pqConfirmClose();
    return !el || 'overlay opened for a manager';
});

t('Main Flaw Shown: asked for a unit flaw line or a broken title, never for functional notes alone', function () {
    function L(o) { return Object.assign({ title: 'Some Game', pickedSheet: 'video-games', notes: [], flip: new Set(), functional: '' }, o); }
    if (_pqcAsks(L({ functional: 'The console powers on and off properly and reads discs.' })).flaw) return 'asked for functional notes alone';
    if (!_pqcAsks(L({ title: 'Broken Unlocked Apple iPhone SE 64GB' })).flaw) return 'not asked for a Broken title';
    if (!_pqcAsks(L({ notes: [{ text: 'A dent on the back corner.', unit: true }] })).flaw) return 'not asked for a unit flaw line';
    if (_pqcAsks(L({ notes: [{ text: 'Good pre-owned condition.', unit: false }] })).flaw) return 'asked for template wording';
    return true;
});

t('whole listing: your grade beats the model on framing, the model fills the rest, and where each answer started is saved', function () {
    var l = { title: 'Game', sheet: 'video-games', pickedSheet: 'video-games', accepted: null, notes: [], flip: new Set(),
              modelSays: { photos: [{ n: 1, flags: ['crooked', 'reflection', 'closeup'], repeatOf: null }, { n: 2, flags: ['off_center'], repeatOf: 1 }],
                           facts: { lead_unclear: true, main_flaw_shown: 'not_applicable' } },
              photos: [{ n: 1, said: ['Front of Game'], framing: { label: 'problem', problems: ['too_small'] } },
                       { n: 2, said: ['Back of Game'], framing: null }] };
    _pqcPrefill(l);
    var p1 = l.photos[0], p2 = l.photos[1];
    // Photo 1: his grade says too small and nothing else of the framing kinds, so
    // the model's "crooked" and "reflection" are dropped; "closeup" isn't framing, so it stays.
    var f1 = Array.from(p1.flags).sort().join();
    if (f1 !== 'closeup,too_small') return 'photo 1 flags ' + f1;
    if (p1.flagFrom.too_small !== 'earlier' || p1.flagFrom.closeup !== 'model') return 'photo 1 sources ' + JSON.stringify(p1.flagFrom);
    if (Array.from(p2.flags).join() !== 'off_center' || p2.flagFrom.off_center !== 'model' || p2.repeatOf !== 1) return 'photo 2 prefill';
    if (l.facts.lead_unclear !== true || l.facts.main_flaw_shown !== 'not_applicable') return 'facts prefill ' + JSON.stringify(l.facts);
    _pqc = { data: { listings: [l], guide: { 'video-games': { name: 'Video Games', shots: [{ label: 'Front of Game', cond: null, img: null }, { label: 'Back of Game', cond: null, img: null }] } } },
             li: 0, pi: 0, busy: false, grid: true, zoom: null };
    pqConfirmFlag('off_center', 1);            // he removes the model's guess
    pqConfirmFlag('blurry', 0);                // and adds one himself
    pqConfirmSetShot(1, 0, 'Front of Game');   // and fixes a label
    pqConfirmFact('lead_unclear');
    var pv = _pqcProvenance(l);
    _pqc = null;
    var e1 = pv.photos[0], e2 = pv.photos[1];
    if (e1.added.join() !== 'blurry' || e1.removed.length || e1.flags.too_small !== 'earlier') return 'photo 1 provenance ' + JSON.stringify(e1);
    if (e2.removed.join() !== 'off_center' || !e2.shotsChanged || e2.shots !== 'model') return 'photo 2 provenance ' + JSON.stringify(e2);
    if (pv.facts.changed.join() !== 'lead_unclear') return 'facts provenance ' + JSON.stringify(pv.facts);
    return true;
});

t('More For Training asks the server for the reopened queue; plain Confirm Shots does not', function () {
    pqcAs('district manager');
    var paths = [], real = _pqFetch;
    _pqFetch = function (p) { paths.push(p); return new Promise(function () {}); };   // never settles: only the request is checked
    pqConfirmOpen('', true);
    var trainNote = (document.getElementById('pqConfirmOverlay') || {}).innerHTML || '';
    pqConfirmClose();
    pqConfirmOpen();
    pqConfirmClose();
    _pqFetch = real;
    if (paths.length !== 2) return paths.length + ' requests';
    if (paths[0].indexOf('&more=1') < 0) return 'More For Training sent ' + paths[0];
    if (paths[1].indexOf('more=') >= 0) return 'plain Confirm Shots sent ' + paths[1];
    return /More For Training/.test(trainNote) || 'no More For Training heading';
});

t('a finished sheet shows ticked off in the Done row, not hidden in More Sheets', function () {
    var sheets = [{ slug: 'item-lots', name: 'Item Lots', graded: 3, confirmed: 3, judged: 0, left: 0, need: 0 }];
    for (var i = 0; i < 9; i++) sheets.push({ slug: 's' + i, name: 'Sheet ' + i, graded: 20, confirmed: 1, judged: 0, left: 19, need: 19 });
    _pqc = { sheet: 's0', data: { target: 40, total: 3, sheets: sheets, guide: {}, listings: [] }, li: 0, pi: 0, busy: false, forTraining: true, started: Date.now(), saved: 0 };
    var h = _pqcHtml();
    _pqc = null;
    var d = document.createElement('div'); d.innerHTML = h;
    var done = d.querySelector('.pqc-done');
    if (!done || done.textContent.indexOf('Item Lots 3/3') < 0) return 'no Done row with Item Lots 3/3';
    var hidden = d.querySelector('.pqc-more');
    if (hidden && hidden.textContent.indexOf('Item Lots') >= 0) return 'Item Lots still in More Sheets';
    // A sheet with nothing left to confirm is done even one short (a dismissed listing, or photos changed since the grade).
    _pqc = { sheet: 's0', data: { target: 40, total: 3, sheets: [{ slug: 'camcorders', name: 'Camcorders', graded: 2, confirmed: 1, judged: 0, left: 0, need: 1 }], guide: {}, listings: [] },
             li: 0, pi: 0, busy: false, forTraining: true, started: Date.now(), saved: 0 };
    var h2 = _pqcHtml(); _pqc = null;
    return h2.replace(/<[^>]+>/g, '').indexOf('Camcorders 1/2 (rest can’t be confirmed)') >= 0 || 'camcorders 1/2 not shown as done';
});

t('the DM and the CEO may use it', function () {
    pqcAs('District Manager'); var dm = _pqcMayUse();
    pqcAs('CEO'); var ceo = _pqcMayUse();
    return (dm && ceo) || 'dm ' + dm + ', ceo ' + ceo;
});

// Measured with the real stylesheet: on a phone, nothing in the box may be
// wider than the box (long sheet names, a long title, twelve thumbnails).
t('at 390px nothing in the Confirm Shots box runs past its edge', function () {
    var d = pqcData();
    d.sheets = d.sheets.concat([1, 2, 3, 4, 5, 6, 7, 8].map(function (i) {
        return { slug: 's' + i, name: 'Small/Medium Miscellaneous Items Sheet ' + i, graded: 20, confirmed: 2, left: 18, need: 18 };
    }));
    var l = d.listings[0];
    l.title = 'Sony PlayStation 5 Slim Digital Edition 1TB Console With Two DualSense Controllers And Every Cable In The Box';
    l.photos = [];
    for (var n = 1; n <= 12; n++) l.photos.push({ n: n, src: 'https://cdn.shopify.com/p' + n + '.jpg', img: '', w: 1080, h: 1080, said: ['Opposite Side Of The Console Lying Down'] });
    l.pickedSheet = l.sheet;
    // The listing panel at its fullest: long notes, every question asked.
    l.title = 'New Lot Of 2 ' + l.title;
    l.unitNotes = ['There is a long deep scratch running across the entire back panel of the console, visible in photos 4 through 9 and under the stand.'];
    l.functional = 'The left controller drifts slightly to the left when the stick is released, tested in the system menu.';
    l.included = 'Console, 2 controllers, HDMI cable, power cable, charging dock, 3 games';
    l.notes = [{ text: l.unitNotes[0], unit: true },
               { text: 'This console is in good pre-owned condition, showing light to moderate signs of use such as small scuffs, scratches, or dings across the top panel.', unit: false }];
    l.flip = new Set([1]);
    l.facts = { lead_unclear: true, serial_hidden: false, new_claim_wrong: true, units_apart: false, flat_package: false, main_flaw_shown: 'partly', needed: [] };
    l.photos.forEach(function (p) { p.shots = p.said.slice(); p.flags = new Set(['reflection', 'off_center']); p.flagFrom = { reflection: 'model', off_center: 'earlier' };
                                    p.repeatOf = null; p.seen = false; p.pre = { shots: p.shots.slice(), flags: {}, repeatOf: null }; });
    l.youSaid = [{ at: '2026-10-15', said: 'Photos 3 to 7 are the console itself (its sides and top), not the box, and photo 12 repeats photo 3 from a slightly different angle.' }];
    var bad = [];
    [false, true].forEach(function (grid) {
    _pqc = { sheet: d.sheet, data: d, li: 0, pi: 0, busy: false, err: null, skip: new Set(), saved: 0, started: Date.now(), grid: grid, zoom: grid ? 0 : null };
    var host = document.createElement('div');
    host.style.cssText = 'width:390px;position:absolute;left:0;top:0;';
    host.innerHTML = '<div class="pqt-box" style="width:100%;box-sizing:border-box">' + _pqcHtml() + '</div>';
    document.body.appendChild(host);
    var box = host.firstChild.getBoundingClientRect();
    host.querySelectorAll('*').forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.width && (r.right > box.right + 1 || r.left < box.left - 1)) bad.push((grid ? 'grid ' : 'one ') + (el.className || el.tagName) + ' ' + Math.round(r.width) + 'px');
    });
    host.remove();
    });
    _pqc = null;
    return !bad.length || 'past the edge: ' + bad.slice(0, 5).join(', ');
});

// The rest drive the real screen end to end, in order, inside one promise:
// promise checks start together, so separate ones would share _pqc.
t('Enter keeps, a key replaces, Shift adds, the last photo saves the listing', function () {
    pqcAs('district manager');
    pqcPosts = [];
    return pqConfirmOpen().then(function () {
        if (_pqc.grid !== false) return 'one photo at a time is not the default';
        var el = document.getElementById('pqConfirmOverlay');
        if (!el) return 'no overlay';
        var html = el.innerHTML;
        if (/render\/image/.test(html)) return 'a Supabase transform URL is on the page';
        if (html.indexOf('Video Games') < 0 || html.indexOf('3/40') < 0) return 'sheet progress missing';
        if (_pqc.skip.has('gid://shopify/Product/9') !== true) return 'misaligned listing not skipped';
        var on = el.querySelector('.pqc-chip-on');
        if (!on || on.textContent.indexOf('Front of Game') < 0) return 'photo 1 not prefilled with the grade';
        pqcKey('Enter');                       // photo 1: keep
        if (_pqc.pi !== 1) return 'Enter did not move on (pi ' + _pqc.pi + ')';
        pqcKey('3');                           // photo 2: Back of Game → Opened Case
        var p2 = _pqc.data.listings[0].photos[1];
        if (p2.shots.join() !== 'Opened Case') return 'key 3 gave ' + p2.shots.join();
        if (_pqc.pi !== 2) return 'a shot key did not move on';
        pqcKey('1', true);                     // photo 3: Extra + Front of Game
        var p3 = _pqc.data.listings[0].photos[2];
        if (p3.shots.join() !== 'Extra,Front of Game') return 'Shift+1 gave ' + p3.shots.join();
        if (_pqc.pi !== 2) return 'Shift+key moved on';
        pqConfirmFlag('label_legible');
        pqConfirmFlag('reflection');
        pqConfirmRepeat('1');                  // photo 3 repeats photo 1
        pqConfirmRepeat('3');                  // not an earlier photo: refused
        if (p3.repeatOf !== null) return 'a repeat of a later photo was kept (' + p3.repeatOf + ')';
        pqConfirmRepeat('1');
        pqConfirmFact('lead_unclear');
        if (document.getElementById('pqConfirmOverlay').innerHTML.indexOf('✎') < 0) return 'changed label has no pencil';
        pqcKey('Enter');                       // last photo → save
        return new Promise(function (r) { setTimeout(r, 0); }).then(function () {
            if (pqcPosts.length !== 1) return pqcPosts.length + ' saves';
            var b = pqcPosts[0];
            if (b.action !== 'confirm-shots' || b.store !== 'OVL' || b.sheet !== 'video-games') return 'payload head ' + JSON.stringify(b).slice(0, 120);
            var got = b.photos.map(function (p) { return p.shots.join('+'); }).join('|');
            if (got !== 'Front of Game|Opened Case|Extra+Front of Game') return 'saved ' + got;
            if (b.photos[2].flags.join() !== 'label_legible,reflection') return 'flags ' + b.photos[2].flags.join();
            if (b.photos[2].repeatOf !== 1 || b.photos[0].repeatOf !== null) return 'repeatOf ' + b.photos.map(function (p) { return p.repeatOf; }).join();
            // Answered photos: blank flags mean NO.
            if (b.checked !== true) return 'checked not sent';
            if (!b.listing || b.listing.lead_unclear !== true || b.listing.serial_hidden !== false) return 'listing facts ' + JSON.stringify(b.listing);
            // Not asked on a used, single, boxed-in-a-case game: sent as the rule's default.
            if (b.listing.new_claim_wrong !== false || b.listing.flat_package !== false || b.listing.main_flaw_shown !== 'not_applicable') return 'unasked facts ' + JSON.stringify(b.listing);
            if (b.photos[1].said.join() !== 'Back of Game') return 'model label not sent';
            if (b.photos.some(function (p) { return /\?/.test(p.src); })) return 'src kept its query string';
            return true;
        });
    }).then(function (r) {
        if (r !== true) { pqConfirmClose(); return r; }
        // The save emptied the queue, so it reloaded the next lot (the stub
        // returns the same listing): Shift+Enter now saves it whole.
        pqcPosts = [];
        // The notes name a flaw on this unit, so "Main Flaw Shown" must be
        // answered: Shift+Enter refuses until it is.
        var L2 = _pqc.data.listings[0];
        L2.notes = [{ text: 'There is a deep scratch across the back of the case.', unit: true },
                    { text: 'The case shows light wear from normal use.', unit: false }];
        pqcKey('Enter', true);
        if (pqcPosts.length) { pqConfirmClose(); return 'saved without a Main Flaw answer'; }
        if (!/Main Flaw Shown/.test(_pqc.err || '')) { pqConfirmClose(); return 'no error asking for Main Flaw Shown'; }
        if (document.getElementById('pqConfirmOverlay').innerHTML.indexOf('deep scratch') < 0) { pqConfirmClose(); return 'the unit note is not shown'; }
        // The system was wrong both ways: the "flaw" is template wording, and
        // the faded line is the real flaw. Overruling the first alone drops the
        // question; overruling the second brings it back.
        pqConfirmFact('flip', 0);
        if (_pqcAsks(L2).flaw) { pqConfirmClose(); return 'Main Flaw still asked after its only flaw line was marked standard'; }
        pqConfirmFact('flip', 1);
        if (!_pqcAsks(L2).flaw) { pqConfirmClose(); return 'a line marked Real Flaw did not bring the question back'; }
        if (document.getElementById('pqConfirmOverlay').innerHTML.indexOf('No Real Flaw') < 0) { pqConfirmClose(); return 'no "No Real Flaw" answer'; }
        pqConfirmFact('main_flaw_shown', 'not_applicable');
        pqcKey('Enter', true);
        return new Promise(function (res) { setTimeout(res, 0); }).then(function () {
            var b2 = pqcPosts[0];
            if (pqcPosts.length !== 1 || b2.listing.main_flaw_shown !== 'not_applicable') { pqConfirmClose(); return 'No Real Flaw not saved'; }
            var sent = (b2.listing.sentences || []).map(function (x) { return (x.system ? 'S' : 's') + (x.real ? 'R' : 'r'); }).join();
            if (sent !== 'Sr,sR') { pqConfirmClose(); return 'sentences saved as ' + sent; }
            var ok = pqcPosts.length === 1 && pqcPosts[0].photos.map(function (p) { return p.shots.join(); }).join('|') === 'Front of Game|Back of Game|Extra';
            // A changed sheet changes the offered shots.
            pqConfirmSheet('lenses');
            var lens = document.getElementById('pqConfirmOverlay').innerHTML.indexOf('Front of Lens') >= 0;
            pqConfirmClose();
            if (!ok) return 'Shift+Enter saved ' + JSON.stringify(pqcPosts.map(function (b) { return b.photos.map(function (p) { return p.shots; }); }));
            return lens || 'sheet change did not change the chips';
        });
    });
});
