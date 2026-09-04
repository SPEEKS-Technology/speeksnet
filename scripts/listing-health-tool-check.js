// THE SPEEKS TOOL CALLED LISTING HEALTH — the popup the deck card opens.
//
// ⚠️ WHAT THIS EXISTS TO STOP HAPPENING AGAIN. The card shipped pointing at
// operations.html#categories. That is the right PAGE, and the reviewer arrived
// on it with nothing to press: the notes it was about live in a shut <details>
// three sections down. Ethan, 2026-09-04: "The notification I got only took me
// to Listing Health on Operations tab and did not show me anything to copy."
// A card that names a job has to open the job, and the job has to be the first
// thing in it.
//
// What this asserts, in the real page:
//    1. the card's action opens the TOOL, and never navigates to a page
//    2. the tool is reachable from the Tools panel in every shell that has one
//    3. opening it shows the Copy button ABOVE the evidence, not under it
//    4. the notes are grouped by rule and each one carries the listing's own
//       field where there is one
//    5. Copy stamps the notes read SERVER-side (action:"triaged") and only
//       after the clipboard actually took it
//    6. a failed read draws an error, never the all-clear — a request that
//       never answered is not "no notes"
//    7. the button says Copy and never promises to send
//
// Run: node scripts/listing-health-tool-check.js
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};

// The real shape ?view=feedback returns, with the three real denials in it.
const FB = {
    days: 30, stores: ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'], total: 3, settled: 3,
    keys: [{ store: 'LEE', productId: 'gid://p/2' }, { store: 'LEE', productId: 'gid://p/3' },
           { store: 'WSP', productId: 'gid://p/1' }],
    groups: [
        { code: 'name-wrong', n: 2, rows: [
            { store: 'LEE', sku: 'MO01-5126C2-F1R1', productId: 'gid://p/2',
              current: 'Call of Duty: Black Ops II (Microsoft Xbox One, 2018)',
              suggested: 'Call of Duty: Black Ops II (Microsoft Xbox 360, 2012)',
              note: 'This is an Xbox One version of the game', by: 'Ethan Kushnir',
              saysItself: { field: 'Platform', value: 'Microsoft Xbox One', matched: 'one' } },
            { store: 'LEE', sku: 'MO01-5435C-F1R1', productId: 'gid://p/3',
              current: 'SanDisk Extreme 2TB microSD Card 4K SDSSDE61-2T00-G25',
              suggested: 'SanDisk Extreme 2TB Portable SSD 4K SDSSDE61-2T00-G25',
              note: 'This is a MicroSD card.', by: 'Ethan Kushnir',
              saysItself: { field: 'Type', value: 'microSD Card', matched: 'microsd card' } },
        ] },
        { code: 'name-garbled', n: 1, rows: [
            { store: 'WSP', sku: 'MO02-4097A-R11R4', productId: 'gid://p/1',
              current: 'Lenovo 34" T43WD-40 WQHD VA Business Monitor',
              suggested: 'Lenovo 34" T34w-40 WQHD VA Business Monitor',
              note: 'I think T43WD-40 is an actual model.', by: 'Ethan Kushnir',
              // The one with nothing to settle it, so the "unsettled" branch renders.
              saysItself: null },
        ] },
    ],
    ask: 'SPEEKS Listing Titles — rule feedback from the review queue\nA. THE RULE IS WRONG',
};

// --- 1 & 2: the wiring, read straight out of the shipped files ---------------
console.log('\n== The card opens the tool, not a page ==');
{
    const js = fs.readFileSync(REPO + '/speeks.js', 'utf8');
    const i = js.indexOf("key: 'titleNoteAlert'");
    const card = i < 0 ? '' : js.slice(i, i + 700);
    ok(i > -1, 'the feed card is registered');
    ok(/action: "openListingHealthTool\(\)"/.test(card),
       'and its action opens the tool');
    // ⚠️ THE REGRESSION. A navigation here is the exact shape of the bug: the
    // right page, nothing to press.
    ok(!/action: "window\.location/.test(card),
       'and never navigates to a page the reviewer then has to search');
}

console.log('\n== It is in the Tools panel of every shell that has one ==');
{
    // tv.html is deliberately excluded: the store TV board has no tools panel
    // at all, and giving it one would put a DM tool on a screen in the lobby.
    for (const f of ['index.html', 'operations.html', 'workspace.html', 'stats.html', 'docs.html']) {
        const h = fs.readFileSync(REPO + '/' + f, 'utf8');
        const m = h.match(/<a[^>]*data-feature="tool-listing-health"[^>]*>/);
        ok(!!m, 'the link is in ' + f);
        if (m) {
            ok(/openListingHealthTool\(\)/.test(m[0]), '  and it opens the tool — ' + f);
            // ⚠️ button == panel == link roles, or the tool half-exists.
            // See [[tools-panel-role-sync]] for what drift here costs.
            ok(/role-district-manager/.test(m[0]) && /role-ceo/.test(m[0]),
               '  and carries the DM+CEO roles the catalogue gives it — ' + f);
        }
    }
    const tv = fs.readFileSync(REPO + '/tv.html', 'utf8');
    ok(!/tool-listing-health/.test(tv), 'and is NOT on the store TV board');
    const js = fs.readFileSync(REPO + '/speeks.js', 'utf8');
    ok(/key: 'tool-listing-health'[\s\S]{0,200}def: \['district-manager', 'ceo'\]/.test(js),
       'the feature switch matches those roles');
}

(async () => {
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errs = [];
    const IGNORE = /calendar\.google\.com|toDataURL|[Tt]ainted canvas|Failed to fetch|net::ERR/;
    page.on('pageerror', e => { if (!IGNORE.test(e.message)) errs.push(e.message); });
    await page.setViewport({ width: 1500, height: 1200 });
    await page.evaluateOnNewDocument(() => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Ethan Kushnir');
        sessionStorage.setItem('speeksUserRole', 'district manager');
        sessionStorage.setItem('speeksUserStore', 'CORP');
    });
    await page.goto('file:///' + REPO + '/index.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await new Promise(r => setTimeout(r, 2400));

    // Capture what the page WOULD post, and hand it the feedback payload.
    await page.evaluate(fb => {
        window.__posts = [];
        window.__copied = null;
        window._ltPost = async (b) => { window.__posts.push(b); return { ok: true, body: { ok: true } }; };
        window._ltFetch = async () => fb;
        // The real clipboard is unavailable to a headless file:// page, and a
        // rejected write is a DIFFERENT path (the "could not reach the
        // clipboard" branch). Stub the success so the stamping half is what is
        // under test here.
        // ⚠️ defineProperty, NOT ASSIGNMENT. navigator.clipboard is a read-only
        // accessor: `navigator.clipboard = {...}` is silently ignored, the real
        // API answers instead, and the assertion on what was copied fails while
        // every other assertion passes — which reads as a bug in the tool.
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: async t => { window.__copied = t; } },
        });
    }, FB);

    console.log('\n== Opening it shows the thing to copy ==');
    await page.evaluate(() => openListingHealthTool());
    await new Promise(r => setTimeout(r, 400));
    const view = await page.evaluate(() => {
        const m = document.getElementById('listingHealthToolModal');
        if (!m) return null;
        const bar = m.querySelector('.lt-ask-bar');
        const btn = m.querySelector('.lt-ask-btn');
        const grp = m.querySelector('.lh-tool-grp');
        return {
            shown: m.classList.contains('show'),
            title: (m.querySelector('.tool-head-title') || {}).textContent || '',
            eyebrow: (m.querySelector('.tool-head-eyebrow') || {}).textContent || '',
            bar: bar ? bar.textContent.replace(/\s+/g, ' ').trim() : '',
            btn: btn ? btn.textContent.trim() : '',
            // ⚠️ THE ORDER IS THE WHOLE POINT. Evidence above the action is the
            // same bug one level down from the card that started this.
            btnAboveEvidence: (bar && grp)
                ? !!(bar.compareDocumentPosition(grp) & Node.DOCUMENT_POSITION_FOLLOWING) : null,
            groups: [...m.querySelectorAll('.lh-tool-grp-h')].map(g => g.textContent.replace(/\s+/g, ' ').trim()),
            notes: [...m.querySelectorAll('.lh-tool-note')].map(n => n.textContent.trim()),
            says: [...m.querySelectorAll('.lh-tool-says')].map(n => n.textContent.replace(/\s+/g, ' ').trim()),
            unsettled: m.querySelectorAll('.lh-tool-unsettled').length,
            raw: (m.querySelector('.lt-ask-pre') || {}).textContent || '',
        };
    });
    ok(!!view, 'the tool rendered');
    if (view) {
        ok(view.shown, 'and it is actually open');
        ok(view.title.trim() === 'Listing Health', 'it is called Listing Health', view.title.trim());
        ok(/SPEEKS Tools/.test(view.eyebrow), 'and reads as a SPEEKS Tool', view.eyebrow.trim());
        ok(/3 dismissals explained a rule was wrong/.test(view.bar),
           'the bar says how many notes are waiting', view.bar);
        ok(/Copy The Ask For Claude/.test(view.btn), 'the Copy button is there', view.btn);
        // ⚠️ "Copy", NOT "Send". Nothing reaches Claude on its own.
        ok(!/\bSend\b/.test(view.btn), 'and it never promises to send', view.btn);
        ok(view.btnAboveEvidence === true,
           'the button sits ABOVE the evidence, not under a scroll of it',
           String(view.btnAboveEvidence));
        ok(view.groups.length === 2, 'the notes are grouped by rule', view.groups.join(' | '));
        ok(/Name checked against outside knowledge/.test(view.groups[0] || ''),
           'and the rule is named in English', view.groups[0]);
        ok(view.notes.length === 3, 'all three notes are shown', String(view.notes.length));
        ok(view.notes.some(n => /Xbox One version/.test(n)), 'the note is quoted');
        ok(view.says.length === 2, 'the two settled rows name the listing\'s own field',
           String(view.says.length));
        ok(/Platform = Microsoft Xbox One/.test(view.says[0] || ''),
           'and print the field and its value', view.says[0]);
        // The row nothing settles must SAY nothing settles it. Silence there
        // reads as agreement with the rule.
        ok(view.unsettled === 1, 'the row nothing settles says so', String(view.unsettled));
        ok(/SPEEKS Listing Titles/.test(view.raw), 'the exact text is available to read');
    }

    console.log('\n== Copy stamps the notes read, server-side ==');
    await page.evaluate(() => lhToolCopy());
    await new Promise(r => setTimeout(r, 300));
    const after = await page.evaluate(() => ({
        copied: window.__copied,
        posts: window.__posts,
        body: (document.getElementById('listingHealthToolBody') || {}).textContent || '',
    }));
    ok(/SPEEKS Listing Titles/.test(after.copied || ''), 'the ask reached the clipboard');
    ok(after.posts.length === 1, 'exactly one post', String(after.posts.length));
    ok((after.posts[0] || {}).action === 'triaged', 'and it is the triaged stamp',
       (after.posts[0] || {}).action);
    // ⚠️ SERVER-SIDE, KEYED ON THE ROWS THAT WERE SHOWN. A localStorage
    // high-water mark is what made the recycle reply card clear on one machine
    // and stay up on every other (fixed 2026-09-04, 9cd1e46).
    ok(((after.posts[0] || {}).keys || []).length === 3,
       'stamping exactly the three rows the ask carried',
       String(((after.posts[0] || {}).keys || []).length));
    ok(/marked as read/.test(after.body), 'and the tool says the notes are read now');

    console.log('\n== A failed read is not an all clear ==');
    await page.evaluate(() => {
        window.__posts = [];
        window._ltFetch = async () => { throw new Error('Request failed (503)'); };
    });
    await page.evaluate(() => openListingHealthTool());
    await new Promise(r => setTimeout(r, 300));
    const err = await page.evaluate(() => ({
        body: (document.getElementById('listingHealthToolBody') || {}).textContent || '',
        isErr: !!document.querySelector('.lh-tool-err'),
        isClear: !!document.querySelector('.lh-tool-clear'),
    }));
    ok(err.isErr, 'a failed read draws the error state');
    ok(!err.isClear, 'and never the all-clear');
    ok(/503/.test(err.body), 'and says what went wrong', err.body.replace(/\s+/g, ' ').slice(0, 60));

    console.log('\n== Nothing to answer ==');
    await page.evaluate(() => {
        window._ltFetch = async () => ({ days: 30, stores: ['OVL'], total: 0, groups: [], keys: [], ask: '' });
    });
    await page.evaluate(() => openListingHealthTool());
    await new Promise(r => setTimeout(r, 300));
    const clear = await page.evaluate(() => ({
        isClear: !!document.querySelector('.lh-tool-clear'),
        btn: !!document.querySelector('#listingHealthToolModal .lt-ask-btn'),
    }));
    ok(clear.isClear, 'an empty pile draws the all-clear');
    ok(!clear.btn, 'and offers no button to copy nothing');

    ok(errs.length === 0, 'no page errors', errs.join(' | '));
    await browser.close();
    console.log('\n' + (fails ? '*** ' + fails + ' FAILED ***' : 'all pass') + '\n');
    process.exit(fails ? 1 : 0);
})();
