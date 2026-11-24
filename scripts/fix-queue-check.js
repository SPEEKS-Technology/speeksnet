// LISTING FIXES — the list-and-detail queue and the DM's Today page
// (listing-review, 2026-11-18).
//
//   powershell -File scripts/browser-check.ps1 fix-queue-check.js
//
// Ethan picked two drawings from the Listing Review Redesign canvas: "Manager ·
// List And Detail" and "DM · Today". What these pin down:
//   - NO TABS for whoever holds the queue: managers and ASMs get the list, the
//     DM gets Today; the old tool tabs are only behind Today's "Tool Views"
//   - a listing's fixes from every tool sit in one detail, each with its own
//     button to the tool that owns it, and a "Not Wrong…" that asks why
//   - I Fixed It is only offered for what a person has to fix, and is held back
//     while a title or category fix is still open
//   - Spot Check and Confirm Fixes are one listing at a time, never one list

function fqAs(role) { sessionStorage.setItem('speeksUserRole', role); }

var FQ_PHOTO = { kind: 'photos', verdict: 'fix', sheet: 'Windows Laptops',
    findings: [{ code: 'missing_shot', shot: 'Closeup of Serial/Model Info', text: 'Missing: Closeup of Serial/Model Info.' }],
    reorder: { suggested: [2, 1], current: [1, 2] }, deletion: null };
var FQ_TITLE = { kind: 'title', severity: 3, current: 'Dell Latitude 5420 i5-1135G7', suggested: 'Dell Latitude 5420 i5-1145G7',
    findings: [{ code: 'name-wrong', says: 'The label in photo 9 says 1145G7.' }] };
var FQ_CAT = { kind: 'category', mode: 'other', to: 'laptops', toTitle: 'Laptops', from: ['Other'], title: 'Dell Latitude' };

function fqCard(id, price, lines, card) {
    return { productId: 'gid://shopify/Product/' + id, sku: 'MO02-' + id, title: 'Listing ' + id, price: price,
             handle: 'h' + id, createdAt: '2026-11-17T15:00:00Z', lister: 'Jon Rodriguez',
             photos: [{ thumb: 'a.jpg', url: 'a.jpg' }, { thumb: 'b.jpg', url: 'b.jpg' }],
             lines: lines, card: card || null };
}
function fqSetup(open, waiting, noPhotos) {
    _ecStore = 'WSP'; _fqErr = null; _fqSel = null; _fqFilter = 'all'; _fqWaitView = false; _lrMode = 'today';
    _fqData = { store: 'WSP', shop: 'paymore-westport.myshopify.com', regradeOn: false, fixedToday: 4,
                noPhotos: noPhotos || [], open: open || [], waiting: waiting || [],
                scope: { stores: ['WSP'], corp: false } };
}
function tdSetup() {
    _spErr = null; _tdNotes = 4;
    _tdData = { day: '2026-11-18', spotLeft: 1, confirm: 1, spotNotes: 2,
        stores: [{ store: 'WSP', toFix: 13, fixedToday: 4, sentBack: 1, spotLeft: 1, spotTotal: 1 }],
        listers: [{ week: '2026-11-16', store: 'WSP', lister: 'Josiah Dixon', listed: 17, checkerFlags: 14, ethanSendBacks: 0, rate: 82 }],
        checkers: { photos: { checked: 22, misses: 1 } } };
    _spData = { stores: { WSP: { day: '2026-11-18', items: [{ id: 7, productId: 'gid://shopify/Product/2', sku: 'MO02-2',
        title: 'KanDao Meeting Pro', price: 299.99, rank: 1, result: 'pending', lister: 'Jon Rodriguez', photos: [],
        shots: ['Front', 'Back', 'Serial'], sheet: 'Small Items' }] } }, shops: { WSP: 'x' } };
    _cfData = { items: [{ store: 'WSP', productId: 'gid://shopify/Product/3', sku: 'MO02-3', title: 'Confirm Me', photos: [] }], shops: {} };
    _spSkipped.clear(); _cfSkipped.clear(); _spForm.clear();
}

t('both feature keys are in the catalog with the agreed defaults', function () {
    var fix = FEATURE_CATALOG.find(function (f) { return f.key === 'ec-view-fix-queue'; });
    var spot = FEATURE_CATALOG.find(function (f) { return f.key === 'ec-view-spot-check'; });
    if (!fix || !spot) return 'missing a key';
    var want = ['district-manager', 'ceo', 'manager', 'owner-manager', 'assistant-manager'];
    if (want.some(function (r) { return fix.def.indexOf(r) < 0; })) return 'fix-queue def is ' + fix.def.join(',');
    return spot.def.join(',') === 'district-manager,ceo' || 'spot-check def is ' + spot.def.join(',');
});

t('an ASM gets the list, with no tabs', function () {
    fqAs('Assistant Manager'); fqSetup([fqCard(1, 100, [FQ_PHOTO])]);
    var h = _lhHtml();
    if (h.indexOf('lr-split') < 0) return 'not the list';
    return h.indexOf('lh-tabs') < 0 || 'a tab strip is drawn';
});

t('a manager gets the list, with no tabs', function () {
    fqAs('Manager'); fqSetup([fqCard(1, 100, [FQ_PHOTO])]);
    var h = _lhHtml();
    return (h.indexOf('lr-split') >= 0 && h.indexOf('lh-tabs') < 0) || 'manager page wrong';
});

t('the DM gets Today, with no tabs and no Tool Views', function () {
    fqAs('District Manager'); fqSetup([fqCard(1, 100, [FQ_PHOTO])]); tdSetup();
    var h = _lhHtml();
    if (h.indexOf('lr-today') < 0) return 'not Today';
    if (h.indexOf('lh-tabs') >= 0) return 'a tab strip on Today';
    return h.indexOf('Tool Views') < 0 || 'Tool Views is still linked';
});

t('the DM page hides the view toggle and the store picker', function () {
    fqAs('District Manager');
    return _lrDmPage() === true || '_lrDmPage is false for the DM';
});

t('a store tile opens exactly what that store’s manager sees', function () {
    fqAs('District Manager'); fqSetup([fqCard(1, 100, [FQ_PHOTO])]); tdSetup();
    _lrMode = 'store';
    var dm = _dmHtml();
    fqAs('Manager');
    var mgr = _fqHtml(false);
    _lrMode = 'today';
    if (dm.indexOf('lr-back-btn') < 0) return 'no back button';
    if (dm.indexOf('What The Store Sees') >= 0) return 'the store view still has a heading';
    var strip = function (x) { return x.replace(/^<div class="lr-screen-h">[\s\S]*?<\/div>/, ''); };
    return strip(dm) === mgr || 'the DM’s store view differs from the manager’s';
});

t('the filters count each kind, and the list shows every listing', function () {
    fqAs('Manager');
    fqSetup([fqCard(1, 300, [FQ_PHOTO, FQ_TITLE]), fqCard(2, 200, [FQ_CAT]), fqCard(3, 100, [FQ_TITLE])]);
    var h = _fqHtml(false);
    if ((h.match(/<button type="button" class="lr-row/g) || []).length !== 3) return 'not three rows';
    if (h.indexOf('All 3') < 0 || h.indexOf('Photos 1') < 0 || h.indexOf('Title 2') < 0 || h.indexOf('Category 1') < 0) return 'filter counts wrong';
    fqFilter('title');
    var t2 = _fqHtml(false);
    _fqFilter = 'all';
    return (t2.match(/<button type="button" class="lr-row/g) || []).length === 2 || 'the Title filter does not narrow the list';
});

t('the first listing opens on the right with one fix box per tool', function () {
    fqAs('Manager'); fqSetup([fqCard(1, 300, [FQ_PHOTO, FQ_TITLE, FQ_CAT])]);
    var h = _fqHtml(false);
    if (h.indexOf('Fix The Order For Me') < 0) return 'no photo order button';
    if (h.indexOf('Use This Title') < 0) return 'no title button';
    if (h.indexOf('Move It') < 0) return 'no category button';
    if ((h.match(/Not Wrong…/g) || []).length !== 3) return 'not one Not Wrong per fix';
    return h.indexOf('Take 1 Missing Photo') >= 0 || 'the photo fix does not say what to take';
});

t('I Fixed It is held back while a title or category fix is open', function () {
    fqAs('Manager'); fqSetup([fqCard(1, 300, [FQ_PHOTO, FQ_TITLE])]);
    var h = _fqHtml(false);
    if (!/lr-btn lr-btn-main" disabled/.test(h)) return 'I Fixed It is pressable';
    return h.indexOf('Use or dismiss the title and category fixes first') >= 0 || 'no reason given';
});

t('a pure reorder has no I Fixed It — Fix The Order is the fix', function () {
    fqAs('Manager');
    fqSetup([fqCard(1, 300, [{ kind: 'photos', verdict: 'reorder', findings: [], reorder: { suggested: [2, 1] } }])]);
    return _fqHtml(false).indexOf('fqMarkFixed(') < 0 || 'I Fixed It offered on a reorder';
});

t('a listing Ethan sent back is marked in the list and says why on top', function () {
    fqAs('Manager');
    fqSetup([fqCard(1, 300, [{ kind: 'ethan', ticks: { missing: ['Ports Left'], order: true, title: false, category: false, fields: [] } }],
        { status: 'open', round: 0, returnedKind: 'spot', returnedNote: 'Photo 3 is the back, no port shot', returnedBy: 'Ethan Kushnir' })]);
    var h = _fqHtml(false);
    if (h.indexOf('lr-row-back') < 0) return 'row not marked';
    if (h.indexOf('Sent Back By Ethan') < 0 || h.indexOf('Photo 3 is the back, no port shot') < 0) return 'no banner or note';
    if (h.indexOf('Ports Left') < 0) return 'ticks not drawn';
    return h.indexOf('fqMarkFixed(') >= 0 || 'no I Fixed It on Ethan’s fixes';
});

t('no-photo listings ride in the same list', function () {
    fqAs('Manager');
    fqSetup([fqCard(1, 300, [FQ_TITLE])], [], [{ productId: 'gid://shopify/Product/9', sku: 'MO02-9', title: 'Bare Listing', price: 50 }]);
    var h = _fqHtml(false);
    return (h.indexOf('Bare Listing') >= 0 && h.indexOf('No Photos') >= 0) || 'no-photo listing missing';
});

t('marked-fixed listings wait behind the footer link, with Undo, and say the recheck is off', function () {
    fqAs('Manager');
    fqSetup([], [fqCard(1, 300, [FQ_PHOTO], { status: 'fixed', fixedBy: 'Test ASM', fixedAt: '2026-11-18T20:00:00Z' })]);
    var h = _fqHtml(false);
    if (h.indexOf('>Tonight’s Recheck<') < 0 || h.indexOf('Waiting On Tonight’s Recheck</button>') >= 0) return 'no Tonight’s Recheck button';
    fqWaiting();
    var w = _fqHtml(false);
    _fqWaitView = false;
    if (w.indexOf('fqUndoFixed(') < 0) return 'no Undo';
    return w.indexOf('not switched on yet') >= 0 || 'does not say the recheck is off';
});

t('an empty list is an all clear, a failed read is not', function () {
    fqAs('Manager'); fqSetup([]);
    var empty = _fqHtml(false);
    if (empty.indexOf('Nothing To Fix At WSP') < 0) return 'no all clear';
    if (empty.indexOf('Pick A Listing') >= 0 || empty.indexOf('All Clear — Nothing To Fix Here.') < 0) return 'the panel still asks for a pick';
    _fqErr = 'boom';
    return _fqHtml(false).indexOf('This is not an all clear') >= 0 || 'a failed read reads as clear';
});

t('Today has the two jobs, a tile per store, the listers and the notes', function () {
    fqAs('District Manager'); fqSetup([]); tdSetup();
    var h = _tdHtml();
    if (h.indexOf('1 Listing To Look At') < 0) return 'spot check job wrong';
    if (h.indexOf('1 Fix Passed The Recheck') < 0) return 'confirm job wrong';
    if (h.indexOf("lrOpenStore('WSP')") < 0) return 'no store tile';
    if (h.indexOf('Josiah Dixon') < 0) return 'no listers';
    if (h.indexOf('2 Spot Check Notes') < 0 || h.indexOf('openSpotNotes()') < 0) return 'no Spot Check Notes row';
    if (h.indexOf('4 Listing Health Notes') < 0 || h.indexOf('openListingHealthTool()') < 0) return 'no Listing Health Notes row';
    return h.indexOf('Passes You Disagreed With') < 0 || 'the checks count is back';
});

t('Spot Check is one listing at a time, and Send Back opens the ticks', function () {
    fqAs('District Manager'); tdSetup(); _lrMode = 'spot';
    var h = _dmHtml();
    if (h.indexOf('KanDao Meeting Pro') < 0) return 'the pick is not shown';
    if (h.indexOf('Confirm Me') >= 0) return 'a confirm item is in the spot check';
    if (h.indexOf('spAgree(7)') < 0) return 'no Agree';
    spOpen(7);
    var f = _dmHtml();
    if (f.indexOf('The Whole Listing') < 0 || f.indexOf('Send Back To WSP') < 0) return 'Send Back form not drawn';
    spTick(7, 'missing', true, 'Serial'); spTick(7, 'order', true);
    var held = _spForm.get(7);
    var ok = held.missing.has('Serial') && held.order && _dmHtml().indexOf('lr-tick lr-tick-on') >= 0;
    _spForm.clear(); _lrMode = 'today';
    return ok || 'ticks not held or not shown';
});

t('Confirm Fixes is its own screen', function () {
    fqAs('District Manager'); tdSetup(); _lrMode = 'confirm';
    var h = _dmHtml();
    _lrMode = 'today';
    if (h.indexOf('Confirm Me') < 0 || h.indexOf('KanDao') >= 0) return 'confirm screen wrong';
    return (h.indexOf('cfConfirm(') >= 0 && h.indexOf('cfSendBack(') >= 0) || 'no Confirm / Send Back';
});

t('All Listers opens on this week through yesterday, one card per store', function () {
    fqAs('District Manager');
    _flData = { through: '2026-11-17', rows: [
        { week: '2026-11-16', store: 'WSP', lister: 'Josiah Dixon', listed: 17, flagged: 14, checkerFlags: 14, ethanSendBacks: 1, dismissed: 0, rate: 82 },
        { week: '2026-11-16', store: 'WSP', lister: 'Unknown', listed: 3, flagged: 0, checkerFlags: 0, ethanSendBacks: 0, dismissed: 0, rate: 0 },
        { week: '2026-11-09', store: 'WSP', lister: 'Josiah Dixon', listed: 10, flagged: 2, checkerFlags: 2, ethanSendBacks: 0, dismissed: 0, rate: 20 }],
        checkers: { photos: { checked: 5, misses: 1 } } };
    _flWeek = null;
    var h = _flHtml();
    if (h.indexOf('This Week') < 0 || h.indexOf('Through Yesterday') < 0 || h.indexOf('Nov 17') < 0) return 'no through date';
    if (h.indexOf('82%') < 0) return 'this week not shown';
    if (h.indexOf('20%') >= 0) return 'two weeks on one page';
    if (/Send-Backs/.test(h)) return 'the send-backs column is back';
    if (h.indexOf('Unknown') >= 0) return 'Unknown is shown';
    if (/spot check|Listed =/.test(h)) return 'the explanation block is back';
    return (h.match(/class="fl-card"/g) || []).length === 1 || 'not one card per store';
});

t('All Listers steps back through the last weeks and no further', function () {
    fqAs('District Manager');
    flSetWeek('2026-11-09');
    var h = _flHtml();
    if (h.indexOf('20%') < 0 || h.indexOf('82%') >= 0) return 'the older week is not shown';
    flSetWeek('2026-10-26');
    var oldest = _flHtml();
    _flWeek = null;
    return /aria-label="Older week" disabled/.test(oldest) || 'can step past the last weeks';
});

t('Spot Check Notes is its own popup: grouped, with the ask and Clear', function () {
    fqAs('District Manager');
    _snEl();
    _snData = { total: 1, ask: 'ASK', done: [], items: [{ id: 5, store: 'WSP', productId: 'gid://shopify/Product/2', sku: 'MO02-2',
        title: 'KanDao Meeting Pro', price: 299.99, lister: 'Jon Rodriguez', note: 'No serial shot',
        ticks: { missing: ['Serial'], order: false, title: false, category: false, fields: [] }, missed: ['photos'], checkerSaid: [] }] };
    renderSpotNotes();
    var h = document.getElementById('spotNotesBody').innerHTML;
    if (h.indexOf('Photo Check Missed It') < 0) return 'not grouped by check';
    if (h.indexOf('No serial shot') < 0 || h.indexOf('Serial') < 0) return 'note or ticks missing';
    if (h.indexOf('spotNotesCopy(') < 0) return 'no copy';
    if (h.indexOf('Clear 1 Note') < 0) return 'no Clear';
    _snData = { total: 0, items: [], done: [] };
    renderSpotNotes();
    return document.getElementById('spotNotesBody').innerHTML.indexOf('No Spot Check Notes Waiting') >= 0 || 'no empty state';
});

t('the photo viewer steps through the strip it was opened from, greyed at the ends', function () {
    openAuditPhotoLightbox('b.jpg', ['a.jpg', 'b.jpg', 'c.jpg']);
    var lb = document.getElementById('auditPhotoLightbox');
    var img = function () { return lb.querySelector('img').getAttribute('src'); };
    if (img() !== 'b.jpg') return 'did not open on the clicked photo';
    if (lb.querySelector('.au-lb-count').textContent !== '2 / 3') return 'count wrong';
    auditPhotoStep(1); if (img() !== 'c.jpg') return 'next failed';
    if (!lb.querySelector('.au-lb-next').disabled) return 'next not greyed at the last photo';
    auditPhotoStep(1); if (img() !== 'c.jpg') return 'stepped past the last photo';
    auditPhotoStep(-2); if (!lb.querySelector('.au-lb-prev').disabled) return 'previous not greyed at the first photo';
    openAuditPhotoLightbox('x.jpg');
    var arrows = lb.querySelector('.au-lb-next').style.display;
    lb.style.display = 'none';
    return arrows === 'none' || 'a single photo still shows arrows';
});

t('the spot check shows the guide with its pictures, Shopify/Store pills, and Back', function () {
    fqAs('District Manager'); tdSetup(); _lrMode = 'spot';
    var it = _spData.stores.WSP.items[0];
    it.handle = 'kandao';
    it.guide = [{ label: 'Front', img: 'g1.jpg', cond: null }, { label: 'Everything Included', img: 'g2.jpg', cond: 'Everything Included' }];
    var h = _dmHtml();
    _lrMode = 'today';
    if (h.indexOf('pq-gimg') < 0 || h.indexOf('g2.jpg') < 0) return 'no guide pictures';
    if (h.indexOf('If Needed') < 0) return 'conditional shot not marked';
    if (h.indexOf('ec-pill-shopify') < 0 || h.indexOf('ec-pill-store') < 0) return 'links are not pills';
    return /lr-back-btn[^>]*>[\s\S]*?Back<\/button>/.test(h) || 'the back button does not say Back';
});

t('Send Back is pictures only: tap a photo to mark it, nothing but photo problems offered', function () {
    fqAs('District Manager'); tdSetup(); _lrMode = 'spot';
    _spData.stores.WSP.items[0].photos = [{ thumb: 'p1.jpg', url: 'p1.jpg' }, { thumb: 'p2.jpg', url: 'p2.jpg' }, { thumb: 'p3.jpg', url: 'p3.jpg' }];
    spOpen(7);
    var before = _dmHtml();
    if (before.indexOf('Tap a photo to mark what’s wrong with it') < 0) return 'no tap hint before a photo is picked';
    if (before.indexOf('spPickPhoto(7, 3)') < 0) return 'photos are not tappable in Send Back mode';
    spPickPhoto(7, 3);
    var h = _dmHtml();
    _lrMode = 'today'; _spForm.clear();
    if (h.indexOf('<b>Photo 3</b>') < 0) return 'the picked photo is not opened';
    if (['Angle', 'Framing', 'Dirty Table', 'Wrong Order'].some(function (x) { return h.indexOf('>' + x + '<') < 0; })) return 'a photo pill is missing';
    if (['Title', 'Category', 'Condition', 'Specs', 'Cosmetic Notes'].some(function (x) { return h.indexOf('>' + x + '<') >= 0; })) return 'a non-photo pill is still offered';
    if (h.indexOf('Listing Details') >= 0) return 'the listing details panel is back';
    if (h.indexOf('Passed The Photo Check') < 0) return 'still says Passed All Checks';
    if (h.indexOf('saves a rule note for Claude') >= 0) return 'the explanation line is back';
    if (h.indexOf('Did The Checks Get This Right?') < 0) return 'the question is not Title Case';
    return /class="lr-head-r"><span class="lr-price">/.test(h) || 'price and pills not on the right';
});

t('an eye-only send-back reads as Check By Eye', function () {
    var said = _fqTicksSaid({ missing: [], order: false, title: false, category: false, fields: [], eye: ['Angle', 'Dirty Table'] });
    return (said.length === 1 && said[0].indexOf('Check By Eye') >= 0 && said[0].indexOf('Dirty Table') >= 0) || 'not said as Check By Eye';
});

t('marks land on the photo they were made on, each with its own note', function () {
    fqAs('District Manager'); tdSetup(); _lrMode = 'spot';
    _spData.stores.WSP.items[0].photos = [{ thumb: 'p1.jpg', url: 'p1.jpg' }, { thumb: 'p2.jpg', url: 'p2.jpg' }, { thumb: 'p3.jpg', url: 'p3.jpg' }, { thumb: 'p4.jpg', url: 'p4.jpg' }];
    spOpen(7);
    spPickPhoto(7, 3); spPhotoTag(7, 3, 'Angle'); spPhotoTag(7, 3, 'Dirty Table'); spPhotoNote(7, 3, 'shoot it level');
    spPickPhoto(7, 4); spPhotoTag(7, 4, 'Dirty Table');
    var f = _spForm.get(7);
    var three = f.photos.get(3), four = f.photos.get(4);
    var h = _dmHtml();
    _lrMode = 'today'; _spForm.clear();
    if (!three || !three.tags.has('Angle') || !three.tags.has('Dirty Table') || three.note !== 'shoot it level') return 'photo 3 marks wrong';
    if (!four || four.tags.size !== 1 || !four.tags.has('Dirty Table') || four.note) return 'photo 4 marks wrong';
    if (h.indexOf('Marked So Far') < 0 || (h.match(/class="lr-mk/g) || []).length !== 2) return 'Marked So Far list wrong';
    return (h.match(/lr-ph-badge/g) || []).length === 2 || 'the strip does not badge the two marked photos';
});

t('a guide picture tapped in Send Back marks that shot missing', function () {
    fqAs('District Manager'); tdSetup(); _lrMode = 'spot';
    _spData.stores.WSP.items[0].guide = [{ label: 'Front', img: 'g1.jpg', cond: null }, { label: 'Serial', img: 'g2.jpg', cond: null }];
    spOpen(7);
    var h1 = _dmHtml();
    if (h1.indexOf("spTick(7,'missing',true,&quot;Serial&quot;)") < 0) return 'guide slot not tappable';
    spTick(7, 'missing', true, 'Serial');
    var h = _dmHtml();
    _lrMode = 'today'; _spForm.clear();
    return (h.indexOf('pq-gph-miss') >= 0 && h.indexOf('lr-mk lr-mk-miss') >= 0) || 'Serial not shown as missing';
});

t('the store reads each photo on its own line, with the photo', function () {
    var said = _fqTicksSaid({ missing: [], order: false, eye: ['Angle', 'Dirty Table'],
        photos: [{ n: 3, tags: ['Angle', 'Dirty Table'], note: 'shoot it level', thumb: 'p3.jpg' }, { n: 4, tags: ['Dirty Table'], note: '', thumb: 'p4.jpg' }] });
    if (said.length !== 2) return 'expected two lines, got ' + said.length;
    if (said[0].indexOf('Photo 3') < 0 || said[0].indexOf('shoot it level') < 0 || said[0].indexOf('p3.jpg') < 0) return 'photo 3 line wrong';
    return (said[1].indexOf('Photo 4') >= 0 && said[1].indexOf('Angle') < 0) || 'photo 4 line wrong';
});

t('the photo picked in Send Back shows big and zooms, and the strip has room for its outline', function () {
    fqAs('District Manager'); tdSetup(); _lrMode = 'spot';
    _spData.stores.WSP.items[0].photos = [{ thumb: 't1.jpg', url: 'big1.jpg' }, { thumb: 't2.jpg', url: 'big2.jpg' }];
    spOpen(7); spPickPhoto(7, 2);
    var h = _dmHtml();
    _lrMode = 'today'; _spForm.clear();
    if (h.indexOf('lr-photo-zoom') < 0 || h.indexOf('src="big2.jpg"') < 0) return 'the picked photo is not shown big';
    if (h.indexOf('openAuditPhotoLightbox(&quot;big2.jpg&quot;') < 0) return 'tapping it does not zoom';
    return h.indexOf('lr-strip lr-strip-tap') >= 0 || 'the strip has no room for the outline';
});

t('the spot check names the store and where it is in that store, and goes back to Today when done', function () {
    fqAs('District Manager'); tdSetup(); _lrMode = 'spot';
    var items = _spData.stores.WSP.items;
    items.push({ id: 8, productId: 'gid://shopify/Product/9', sku: 'MO02-9', title: 'Second Pick', price: 99, rank: 2, result: 'pending', photos: [], shots: [], guide: [] });
    var h = _dmHtml();
    if (h.indexOf('<b>WSP</b> · 1 Of 2') < 0) return 'store and position not shown';
    if (h.indexOf('All done') >= 0) return 'an all-done page is still drawn';
    items.forEach(function (i) { i.result = 'agree'; });
    var done = _dmHtml();
    _lrMode = 'today';
    // The hand-back to Today is a setTimeout (it cannot run inside a render);
    // what can be checked here is that no all-done page is drawn in its place.
    return (done.indexOf('lh-clear') < 0 && done.indexOf('status-message') >= 0) || 'an end page was drawn instead of going back';
});

t('Today greys the Spot Check card when there is nothing left', function () {
    fqAs('District Manager'); fqSetup([]); tdSetup();
    _tdData.spotLeft = 0;
    var h = _tdHtml();
    return (h.indexOf('lr-job lr-job-off') >= 0 && h.indexOf('All Caught Up') >= 0) || 'not greyed';
});

t('the viewer arrows are drawn, not typed, so they sit centred', function () {
    openAuditPhotoLightbox('a.jpg', ['a.jpg', 'b.jpg']);
    var lb = document.getElementById('auditPhotoLightbox');
    var ok = !!lb.querySelector('.au-lb-prev svg') && !!lb.querySelector('.au-lb-next svg');
    lb.style.display = 'none';
    return ok || 'arrows are text glyphs';
});

t('a notes row with nothing waiting is greyed out and cannot be opened', function () {
    fqAs('District Manager'); fqSetup([]); tdSetup();
    _tdData.spotNotes = 0; _tdNotes = 1;
    var h = _tdHtml();
    if (!/lr-notes lr-notes-off"><div><b>0 Spot Check Notes/.test(h)) return 'empty spot notes row not greyed';
    if (h.indexOf('disabled onclick="openSpotNotes()"') < 0) return 'empty spot notes still opens';
    return h.indexOf('disabled onclick="openListingHealthTool()"') < 0 || 'a row with a note was disabled';
});

t('a listing in Other says so plainly and can be moved right there', function () {
    fqAs('Manager');
    fqSetup([fqCard(1, 300, [{ kind: 'category', mode: 'unmatched', title: 'Altek TechChek 820', from: ['Other'] }])]);
    _fqData.shelves = [{ handle: 'test-equipment', title: 'Test Equipment' }, { handle: 'laptops', title: 'Laptops' }];
    _fqShelf.clear();
    var h = _fqHtml(false);
    if (h.indexOf('No rule knows') >= 0) return 'the old wording is back';
    if (h.indexOf('No Category Picked') < 0 || h.indexOf('Test Equipment') < 0) return 'no category picker';
    if (!/lr-btn lr-btn-go" disabled onclick="fqApproveCategory/.test(h)) return 'Move It pressable before a category is picked';
    fqPickShelf('gid://shopify/Product/1', 'test-equipment');
    var h2 = _fqHtml(false);
    _fqShelf.clear();
    return /value="test-equipment" selected/.test(h2) && !/lr-btn lr-btn-go" disabled onclick="fqApproveCategory/.test(h2) || 'picking a category does not arm Move It';
});

t('the category picker always opens downward, and the list says it is sorted', function () {
    fqAs('Manager');
    fqSetup([fqCard(1, 300, [{ kind: 'category', mode: 'unmatched', title: 'X', from: ['Other'] }])]);
    _fqData.shelves = [{ handle: 'a', title: 'A' }];
    var h = _fqHtml(false);
    if (h.indexOf('class="lr-shelf" data-dd-down') < 0) return 'picker not marked to open downward';
    return h.indexOf('Sorted By Price, Highest First') >= 0 || 'sort wording not changed';
});

t('missing tiles show the shot name with no +, and the whole guide sits underneath', function () {
    fqAs('Manager');
    var line = { kind: 'photos', verdict: 'fix', sheet: 'Smartwatch', findings: [
        { code: 'missing_shot', shot: 'Lock/Home Screen', text: 'Missing: Lock/Home Screen — the first photo the guide asks for.' },
        { code: 'missing_shot', shot: 'Settings Page', text: 'Missing: Settings Page.' }],
        guide: [{ label: 'Lock/Home Screen', img: 'g1.jpg', cond: null }, { label: 'Front', img: 'g2.jpg', cond: null }, { label: 'Settings Page', img: 'g3.jpg', cond: null }] };
    fqSetup([fqCard(1, 300, [line])]);
    var h = _fqHtml(false);
    if (h.indexOf('lr-ph-miss') < 0) return 'no missing tiles';
    if (/lr-ph-miss[^>]*><span class="lr-n">\+/.test(h)) return 'the + is still there';
    if (h.indexOf('the first photo the guide asks') >= 0) return 'a finding sentence leaked into a tile';
    if (h.indexOf('The Guide — Shoot It Like This') < 0 || h.indexOf('g2.jpg') < 0) return 'the whole guide is not underneath';
    return (h.match(/pq-gph-miss/g) || []).length === 2 || 'the guide does not mark the two missing shots';
});

t('a listing with no photos and a title problem is one row carrying both', function () {
    fqAs('Manager');
    fqSetup([fqCard(1, 524.99, [FQ_TITLE]), fqCard(2, 899.99, [FQ_TITLE])], [],
        [{ productId: 'gid://shopify/Product/1', sku: 'MO02-1', title: 'Listing 1', price: 524.99 }]);
    var h = _fqHtml(false);
    if ((h.match(/<button type="button" class="lr-row/g) || []).length !== 2) return 'the listing is on two rows';
    if (h.indexOf('All 2') < 0) return 'the count still counts it twice';
    var first = h.split('<button type="button" class="lr-row')[1];
    return (first.indexOf('No Photos') >= 0 && first.indexOf('>Title<') >= 0) || 'the merged row does not carry both tags';
});

t('while a store loads, the page shows Loading, never the old tabbed page', function () {
    fqAs('Manager'); fqSetup([]); _fqData = null; _fqErr = null;
    var h = _lhHtml();
    return (h.indexOf('lh-tabs') < 0 && h.indexOf('Loading') >= 0) || 'the old tabbed page flashed';
});

t('the sent-back box on the store card does not name Ethan', function () {
    fqAs('Manager');
    fqSetup([fqCard(1, 300, [{ kind: 'ethan', ticks: { missing: ['Front'], order: false, photos: [] } }],
        { status: 'open', round: 0, returnedKind: 'spot', returnedNote: 'n', returnedBy: 'Ethan Kushnir' })]);
    var h = _fqHtml(false);
    return (h.indexOf('What Ethan Found') < 0 && h.indexOf('What To Fix') >= 0) || 'the box still names Ethan';
});

t('a reorder shows the new order, and no Open In Shopify button sits beside the fixes', function () {
    fqAs('Manager');
    fqSetup([fqCard(1, 139.99, [{ kind: 'photos', verdict: 'reorder', findings: [], reorder: { suggested: [2, 1] } }])]);
    var h = _fqHtml(false);
    if (h.indexOf('New Order') < 0 || h.indexOf('pq-ph-moved') < 0) return 'the new order is not shown';
    return h.indexOf('Open In Shopify') < 0 || 'Open In Shopify is still there';
});

t('View Listing sits beside Shopify / Store on the store list, the spot check and Confirm Fixes', function () {
    fqAs('Manager'); fqSetup([fqCard(1, 300, [FQ_TITLE])]);
    var list = _fqHtml(false);
    if (list.indexOf("openListingView('WSP','gid://shopify/Product/1')") < 0) return 'no View Listing on the store list';
    fqAs('District Manager'); tdSetup();
    _spData.stores.WSP.items[0].handle = 'h'; _spData.shops = { WSP: 'paymore-westport.myshopify.com' };
    _lrMode = 'spot'; var sp = _dmHtml();
    _cfData.shops = { WSP: 'paymore-westport.myshopify.com' };
    _lrMode = 'confirm'; var cf = _dmHtml();
    _lrMode = 'today';
    if (sp.indexOf('openListingView(') < 0) return 'no View Listing on the spot check';
    return cf.indexOf('openListingView(') >= 0 || 'no View Listing on Confirm Fixes';
});

t('the listing description is shown through an allow-list, never raw', function () {
    var h = _lrCleanHtml('<p onclick="x()">Hi <b>there</b></p><scr' + 'ipt>alert(1)</scr' + 'ipt><img src=x onerror="y()"><a href="javascript:z()">link</a><table><tr><td colspan="2" style="color:red">c</td></tr></table>');
    if (/script|onerror|onclick|javascript|<img|style=/.test(h)) return 'unsafe markup survived: ' + h;
    return (h.indexOf('<p>Hi <b>there</b></p>') >= 0 && h.indexOf('<td colspan="2">c</td>') >= 0 && h.indexOf('link') >= 0) || 'allowed markup lost: ' + h;
});

t('Today shows Full Listing Review to the DM, and its screen flags parts', function () {
    fqAs('District Manager'); fqSetup([]); tdSetup();
    var h = _tdHtml();
    if (h.indexOf('Review Any Listing') < 0 || h.indexOf('frOpen()') < 0) return 'no Full Listing Review job';
    _frStore = 'LEE'; _frList = { items: [{ productId: 'gid://shopify/Product/5', sku: 'MO01-5', title: 'Lenovo Flex 3', price: 139.99, createdAt: '2026-11-18T12:00:00Z', lister: 'Colin Hamilton', thumb: null, reviewed: null, onList: false }] };
    _frSel = 'gid://shopify/Product/5'; _frReset();
    _frListing = { store: 'LEE', productId: 'gid://shopify/Product/5', title: 'Lenovo Flex 3', sku: 'MO01-5', price: 139.99, shop: 'paymore-lees-summit.myshopify.com', handle: 'h',
        photos: [{ thumb: 'a.jpg', url: 'a.jpg' }], category: ['Laptops'], condition: 'Good', cosmetic: 'c', functional: 'f', included: '', notIncluded: 'Device Only', descriptionHtml: '<p>Spec</p>' };
    _lrMode = 'full';
    frFlagPart('Not Included'); frPartNote('Device Only is not missing');
    var s = _dmHtml();
    _lrMode = 'today'; _frReset(); _frSel = null; _frListing = null;
    if (s.indexOf('lr-part lr-part-flagged') < 0) return 'the flagged part is not marked';
    if (s.indexOf('Send Back To LEE') < 0 || s.indexOf('Looks Good') < 0) return 'no Looks Good / Send Back';
    return s.indexOf('Flagged So Far') >= 0 || 'no Flagged So Far list';
});

t('a manager never sees Full Listing Review', function () {
    fqAs('Manager');
    return !_lrMayFull() || 'the manager holds Full Listing Review';
});

t('the store reads a full review as its own ribbon with one line per part', function () {
    fqAs('Manager');
    fqSetup([fqCard(1, 139.99, [{ kind: 'ethan', ticks: { missing: [], order: false, parts: [{ part: 'Not Included', note: 'Device Only is not missing' }], photos: [] } }],
        { status: 'open', round: 0, returnedKind: 'full', returnedNote: 'Tidy up the charger lines', returnedBy: 'Ethan Kushnir' })]);
    var h = _fqHtml(false);
    return (h.indexOf('Full Listing Review') >= 0 && h.indexOf('<b>Not Included</b>') >= 0 && h.indexOf('Device Only is not missing') >= 0) || 'full-review lines not shown';
});

// View Listing, 2026-11-23: the description replaces the field grid; arrows step the main photo; "No Photos".
t('view listing shows the description, not the field grid', function () {
    var h = _lrListingHtml({ photos: [], title: 'X', descriptionHtml: '<p>Items included in this sale: cable</p>', condition: 'Good', cosmetic: 'scuffs' }, null);
    if (h.indexOf('Items included in this sale') < 0) return 'the description HTML is missing';
    if (h.indexOf('>Listing Description<') >= 0 || h.indexOf('>Title<') >= 0 || h.indexOf('>Price<') >= 0) return 'view should be photos + the HTML only';
    if (h.indexOf('>Condition<') >= 0 || h.indexOf('>Cosmetic Notes<') >= 0) return 'the old field grid is back';
    if (h.indexOf('What’s Included') >= 0) return 'Included added although the description says it';
    if (h.indexOf('No Photos') < 0) return 'no "No Photos" when there are none';
    return true;
});
t('view listing arrows step the main photo and stop at the ends', function () {
    var ph = [{ url: 'a', thumb: 'a' }, { url: 'b', thumb: 'b' }, { url: 'c', thumb: 'c' }];
    _lrViewData = { photos: ph, title: 'X' }; _lvIdx = 0;
    var h0 = _lrListingHtml(_lrViewData, null);
    if (!/lr-lv-prev"[^>]*disabled/.test(h0)) return 'prev not disabled on photo 1';
    _lvIdx = 2;
    var h2 = _lrListingHtml(_lrViewData, null);
    if (!/lr-lv-next"[^>]*disabled/.test(h2) || h2.indexOf('3 of 3') < 0) return 'next not disabled on the last photo';
    _lvIdx = 0; _lrViewData = null;
    return true;
});

// Full review, 2026-11-23: a title the Title Check already flagged cannot be flagged again.
t('full review will not flag a title the Title Check already flagged', function () {
    var rv = { form: { parts: new Map(), photos: new Map() } };
    var h = _lrListingHtml({ photos: [], title: 'X', price: 10, already: { title: 'The Title Check already flagged this title.', photos: null } }, rv);
    if (!/lr-flag" disabled[^>]*>Already Flagged/.test(h)) return 'no disabled Already Flagged button on Title';
    if (h.indexOf('lr-already') < 0) return 'the reason is not shown';
    var h2 = _lrListingHtml({ photos: [], title: 'X', price: 10, already: { title: null, photos: null } }, rv);
    if (/Already Flagged/.test(h2)) return 'Already Flagged shown on a title nothing flagged';
    return true;
});

// Full review, 2026-11-23: a second click on Flagged unflags it; no Unflag button.
t('full review: Flag toggles off on a second click', function () {
    var saved = window._fqRender; window._fqRender = function () {};
    try {
        _frListing = { already: { title: null, photos: null } };
        _frForm.parts = new Map(); _frForm.selPart = null;
        frFlagPart('Price');
        if (!_frForm.parts.has('Price')) return 'first click did not flag';
        frFlagPart('Price');
        if (_frForm.parts.has('Price')) return 'second click did not unflag';
        if (_frForm.selPart === 'Price') return 'still selected after unflag';
        var rv = { form: { parts: new Map([['Price', 'too high']]), selPart: null } };
        var h = _lrListingHtml({ photos: [], title: 'X', price: 10, already: {} }, rv);
        if (h.indexOf('Add A Note') >= 0) return 'Add A Note still on the part';
        return true;
    } finally { window._fqRender = saved; }
});

// 0203: a Notes Only card reads as notes, offers Got It, and never I Fixed It.
t('notes-only card: Got It, no I Fixed It, blue Notes chip', function () {
    var c = { productId: 'p1', title: 'X', price: 10, photos: [], lines: [{ kind: 'ethan', ticks: { parts: [{ part: 'Price', note: 'fyi' }], photos: [] } }],
              card: { status: 'open', returnedKind: 'notes', returnedNote: 'just so you know' } };
    var h = _fqDetailHtml(c, 'OVL', false);
    if (h.indexOf('fqNotesSeen') < 0) return 'no Got It';
    if (h.indexOf('fqMarkFixed') >= 0) return 'I Fixed It shown on notes';
    if (h.indexOf('Notes From Ethan') < 0) return 'no notes heading';
    if (_fqRowHtml(c).indexOf('lr-c-notes') < 0) return 'row chip is not Notes';
    return true;
});

// 2026-11-23: a send-back and Notes Only read as the same "From Ethan" card.
t('send-back and notes-only share one From Ethan card, overall note first', function () {
    function card(kind) { return { productId: 'p', title: 'X', price: 1, photos: [], lines: [{ kind: 'ethan', ticks: { parts: [{ part: 'Price', note: 'n' }], photos: [] } }],
        card: { status: 'open', returnedKind: kind, returnedNote: 'overall' } }; }
    var a = _fqDetailHtml(card('full'), 'OVL', false), b = _fqDetailHtml(card('notes'), 'OVL', false);
    if (a.indexOf('lr-from-fix') < 0 || b.indexOf('lr-from-notes') < 0) return 'no From Ethan card';
    if (a.indexOf('class="lr-back') >= 0 || b.indexOf('class="lr-back') >= 0) return 'old banner still shown';
    if (a.indexOf('Overall') < 0 || a.indexOf('Overall') > a.indexOf('Price')) return 'overall note not first';
    if (a.indexOf('Send To Ethan') < 0) return 'eye-only card says Recheck Tonight';
    return true;
});
