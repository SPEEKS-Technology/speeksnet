// WHEN A RECYCLE REPLY CARD IS ALLOWED TO STAY UP.
//
// The DM's feed card for "a manager replied to your note" blocks nobody — it is
// information, so a glance is the right thing to clear it. Opening the tool
// POSTs mark_seen, which stamps dm_seen_at on the row SERVER-SIDE.
//
// ⚠️ THE BUG THIS EXISTS FOR: the filter read only a localStorage high-water
// mark, so the card cleared on the machine that read it and stayed up on every
// other one. Ethan, as DM: "there was a recycle reply and I viewed it, but the
// alert didn't go away." His dm_seen_at was 22:54 against a 21:46 reply.
//
// ⚠️ AND THE ONE THIS MUST NOT CAUSE: dm_seen_at must never gate needsReview or
// pendingDelete. A "seen on open" model for those let a glance silence work a
// manager was still blocked on, which is why it was taken off them.
//
// Offline. Lifts the shipped filter out of speeks.js — no browser, no PIN.
// Run: node scripts/recycle-reply-seen-check.js
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'speeks.js');
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

let fails = 0;
const ok = (c, label, got) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + label + (got === undefined ? '' : '   ' + got));
    if (!c) fails++;
};

// --- lift the shipped predicates --------------------------------------------
const grab = (from, to) => {
    const i = src.indexOf(from), j = src.indexOf(to, i);
    if (i < 0 || j < 0) throw new Error('could not slice ' + from.slice(0, 40));
    return src.slice(i, j);
};
const block = grab('            const awaitingMgrReply = r =>', '            if (!needsReview.length');
const make = new Function('rows', 'localMark', `
    const getT = v => (v ? new Date(v).getTime() : 0);
    const localStorage = { getItem: () => String(localMark) };
    const _recycleSeenKey = n => n;
${block}
    return { needsReview, pendingDelete, freshRep };`);

const T = s => s;                                   // readable fixtures
const REPLY = '2026-09-03T21:46:23.379Z';
const SEEN_AFTER = '2026-09-03T22:54:08.687Z';      // the real dm_seen_at
const SEEN_BEFORE = '2026-09-03T20:58:00.000Z';

// =============================================================================
console.log('\n1. THE REAL ROW THAT WOULD NOT CLEAR');
// OVL KS01-7153J-QTY2-E3, verbatim: reviewed, DM noted, manager replied, DM saw
// it an hour later on another device whose localStorage mark was still 0.
const real = [{ store: 'OVL', sku: 'KS01-7153J-QTY2-E3',
    reviewed_at: '2026-09-03T20:58:05.570Z', delete_requested_at: null,
    dm_note_at: '2026-09-03T20:58:16.213Z', mgr_reply_at: T(REPLY),
    dm_seen_at: T(SEEN_AFTER) }];
let r = make(real, 0);
ok(r.freshRep.length === 0, 'a reply the SERVER says was seen is not fresh, whatever this device thinks');
ok(r.needsReview.length === 0 && r.pendingDelete.length === 0,
   'and nothing else is outstanding, so the card comes down');

// =============================================================================
console.log('\n2. A REPLY THAT GENUINELY HAS NOT BEEN READ');
r = make([{ ...real[0], dm_seen_at: T(SEEN_BEFORE) }], 0);
ok(r.freshRep.length === 1, 'dm_seen_at older than the reply still surfaces');
r = make([{ ...real[0], dm_seen_at: null }], 0);
ok(r.freshRep.length === 1, 'never seen at all still surfaces');

// =============================================================================
console.log('\n3. THE LOCAL MARK IS STILL THE SAME-DEVICE FAST PATH');
// It is written the moment the card renders, so the card cannot flicker back in
// the seconds before the mark_seen round trip lands.
r = make([{ ...real[0], dm_seen_at: T(SEEN_BEFORE) }], new Date(REPLY).getTime());
ok(r.freshRep.length === 0, 'a local mark at the reply time suppresses it too');

// =============================================================================
console.log('\n4. ⚠️ SEEN MUST NOT SILENCE WORK A MANAGER IS BLOCKED ON');
const unreviewed = { store: 'BAL', sku: 'X', reviewed_at: null, delete_requested_at: null,
    dm_note_at: null, mgr_reply_at: null, dm_seen_at: T(SEEN_AFTER) };
r = make([unreviewed], Date.now());
ok(r.needsReview.length === 1, 'an unreviewed line stays in needsReview however recently it was seen');
const del = { store: 'BAL', sku: 'Y', reviewed_at: null,
    delete_requested_at: '2026-09-03T10:00:00.000Z',
    dm_note_at: null, mgr_reply_at: null, dm_seen_at: T(SEEN_AFTER) };
r = make([del], Date.now());
ok(r.pendingDelete.length === 1, 'a delete request stays pending however recently it was seen');

// =============================================================================
console.log('\n5. THE PARKED RULE IS UNCHANGED');
// A line whose latest DM note is still awaiting the manager is the store's ball.
const parked = { store: 'LEE', sku: 'Z', reviewed_at: null, delete_requested_at: null,
    dm_note_at: '2026-09-03T12:00:00.000Z', mgr_reply_at: '2026-09-03T11:00:00.000Z',
    dm_seen_at: null };
r = make([parked], Date.now());
ok(r.needsReview.length === 0, 'a line waiting on the store does not nag the DM for review');

// =============================================================================
console.log('\n6. THE SOURCE STILL SAYS WHY');
ok(/const replySeenOnServer = r => getT\(r\.dm_seen_at\) >= getT\(r\.mgr_reply_at\);/.test(src),
   'the server stamp is consulted by name');
ok(!/needsReview\s+=\s+rows\.filter\([^)]*dm_seen_at/.test(src),
   'and it is nowhere near needsReview');

console.log('\n' + (fails ? fails + ' FAILED' : 'all passed'));
process.exit(fails ? 1 : 0);
