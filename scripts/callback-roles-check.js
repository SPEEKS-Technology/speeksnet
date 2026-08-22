// Customer Call Backs — the round of changes on 21 Aug, driven with canned rows
// so it runs without a credential.
//
//   1. THE DM SEES GREEN. _cbMatchScope returns null for corp, so every match
//      landed in `theirs` and came out grey — the district view was the one place
//      you could not see at a glance that a store had something to act on.
//   2. EVERY ROLE AT THE HOLDING STORE sees green, not just management. An
//      employee can ring a customer; only a manager records the answer.
//   3. the Open pill says it is clickable, and gives that slot up to the
//      attribution line the moment somebody acts
//   4. Completed is a TAB, and the open list stops carrying finished rows
//   5. NOTES ARE ABOVE THE MATCHES. "Needs it by the 12th" under nine consoles
//      was off the bottom of the screen.
//   6. management deletes, everybody else asks — and the ask is a note, so the
//      row survives until somebody who may destroy it says so
//   7. no unstyled-select flash when the panel re-renders
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const SHOT = process.env.SHOT_DIR || REPO + '/scripts';

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };
const IGNORE = /calendar\.google\.com|toDataURL|[Tt]ainted canvas|Failed to fetch|net::ERR|401/;

// Two rows: a WSP customer wanting a PS5 that LEE holds, and a completed one.
const ROWS = [
    {
        id: 'r1', store: 'WSP', customer_name: 'test customer', phone: '1111111111',
        item: 'PS5', status: 'open', date_of_call: '2026-08-21', archived_at: null,
        category: 'video-game-systems', any_model: true,
        notes: [{ text: "needs it by the 12'th", user: 'Ethan Kushnir', store: 'WSP', at: '2026-08-21' }],
        matches: [
            { id: 1, store_code: 'LEE', state: 'suggested', title: 'Sony PlayStation 5 Slim Disc PS5 1TB', price: 439.99, sku: 'MO04-1674A-E10', online_published: true, product_handle: 'ps5-slim' },
            { id: 2, store_code: 'LEE', state: 'suggested', title: 'Sony PlayStation 5 Pro Digital 2TB', price: 809.99, sku: 'MO03-2227A-R3R2', online_published: false, product_handle: null },
        ],
    },
    {
        id: 'r2', store: 'WSP', customer_name: 'done already', phone: '2222222222',
        item: 'N64', status: 'completed', status_by: 'A Manager', status_store: 'WSP',
        date_of_call: '2026-08-20', archived_at: null, notes: [], matches: [],
    },
];

async function asRole(browser, role, store) {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => { const m = String(e.message || e); if (!IGNORE.test(m)) errs.push(m); });
    await page.setViewport({ width: 1600, height: 1000 });
    await page.evaluateOnNewDocument(([r, s]) => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Test ' + r);
        sessionStorage.setItem('speeksUserRole', r);
        sessionStorage.setItem('speeksUserStore', s);
    }, [role, store]);
    await page.goto('file:///' + REPO + '/operations.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await new Promise(r => setTimeout(r, 2400));
    await page.evaluate(rows => {
        document.querySelectorAll('.ws-pane').forEach(p => p.classList.remove('active'));
        document.getElementById('ops-pane-callbacks').classList.add('active');
        _cbCache = JSON.parse(JSON.stringify(rows));
        _cbView = 'all';
        _cbExpandedId = null;
        cbRender();
    }, ROWS);
    return { page, errs };
}

(async () => {
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });

    // --- 1 + 2: who sees green ---------------------------------------------
    console.log('== The green chip ==');
    for (const [role, store, want, why] of [
        ['district manager', 'CORP', true,  'the DM sees green so they can check LEE acted'],
        ['ceo',              'CORP', true,  'and so does the CEO'],
        ['manager',          'LEE',  true,  "LEE's manager sees green — it is their stock"],
        ['assistant manager', 'LEE', true,  "LEE's ASM too"],
        ['employee',         'LEE',  true,  "and LEE's employee, who can ring the customer"],
        ['training',         'LEE',  true,  'and somebody still in training'],
        ['manager',          'WSP',  false, 'WSP, who asked, sees the neutral chip instead'],
        ['employee',         'OVL',  false, 'and a store with nothing to do sees neutral'],
    ]) {
        const { page } = await asRole(browser, role, store);
        // The MATCH chip specifically. `.cb-tag` also covers Any Model and Needs
        // Detail, and Any Model comes first in the cell — which is what this
        // harness read on its first run, reporting every role identically.
        const chip = await page.evaluate(() => {
            const c = document.querySelector('.cb-row .cb-tag-hasit, .cb-row .cb-tag-elsewhere');
            return c ? { cls: c.className, text: c.textContent.trim() } : null;
        });
        const green = !!chip && /cb-tag-hasit/.test(chip.cls);
        ok(green === want, why, chip ? chip.text + '  [' + chip.cls.replace('cb-tag ', '') + ']' : '(no chip)');
        await page.close();
    }

    // --- 3 + 4 + 5 + 6, as LEE's manager -----------------------------------
    const { page, errs } = await asRole(browser, 'manager', 'LEE');

    console.log('');
    console.log('== The Open pill says it is clickable ==');
    const pills = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.cb-row')];
        return rows.map(tr => ({
            status: (tr.querySelector('.cb-chip') || {}).textContent,
            under: ((tr.querySelector('.cb-status-by') || {}).textContent || '').trim(),
            hint: !!tr.querySelector('.cb-status-hint'),
        }));
    });
    ok(pills[0] && pills[0].hint, 'an open row says "click to change" under the pill', pills[0] && pills[0].under);

    console.log('');
    console.log('== Completed is its own tab ==');
    // Scoped to the Call Backs panel: .cb-view-toggle is shared with SPEEKS
    // Connect's own toggle further down the page.
    const tabs = await page.$$eval('#ops-pane-callbacks .cb-view-toggle .mb-view-btn',
        bs => bs.map(b => b.textContent.trim()));
    ok(tabs.length === 4 && tabs.includes('Completed'), 'there are four views', tabs.join(' | '));
    const box = await page.$('#cbShowCompleted');
    ok(!box, 'and the tick box is gone');
    const openList = await page.$$eval('.cb-row', rs => rs.map(r => (r.querySelector('.cb-chip') || {}).textContent));
    ok(openList.length === 1 && openList[0] === 'Open', 'the open list carries only open rows', openList.join(', '));
    const completed = await page.evaluate(() => {
        _cbView = 'completed'; cbRender();
        return {
            rows: [...document.querySelectorAll('.cb-row')].map(r => (r.querySelector('.cb-chip') || {}).textContent),
            quickAdd: !!document.querySelector('.cb-quick-add, #cbAddCategory'),
            sub: (document.getElementById('cbSubtitle') || {}).textContent,
        };
    });
    ok(completed.rows.length === 1 && completed.rows[0] === 'Completed', 'the Completed tab shows the completed one', completed.rows.join(', '));
    ok(!completed.quickAdd, 'and no quick-add on a list of finished work');
    ok(/1 completed/.test(completed.sub || ''), 'the header counts them', completed.sub);

    console.log('');
    console.log('== Notes sit above the matches ==');
    const order = await page.evaluate(() => {
        _cbView = 'all'; _cbExpandedId = 'r1'; cbRender();
        const cell = document.querySelector('.cb-row-detail td');
        const kids = [...cell.children].map(c => c.className.split(' ')[0]);
        const notes = cell.querySelector('.cb-notes-thread');
        const panel = cell.querySelector('.cb-match-panel');
        return { kids, notesFirst: !!notes && !!panel
            && (notes.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING) > 0,
            noteText: notes ? notes.textContent.trim().slice(0, 30) : '' };
    });
    ok(order.notesFirst, 'the note thread comes before the match list', order.kids.join(' > '));
    ok(/needs it by/.test(order.noteText), 'and it is the reason for the call', order.noteText);

    console.log('');
    console.log('== Management deletes, everybody else asks ==');
    // LEE gets NO action buttons on a WSP row, which is the older rule and still
    // right: the holding store answers the match, the OWNING store edits the
    // entry. Asserted here so the delete matrix below is not read as covering it.
    const lee = await page.evaluate(() => {
        _cbExpandedId = null; cbRender();
        return [...document.querySelectorAll('.cb-row .cb-col-actions button')]
            .map(b => b.getAttribute('data-cb-tip'));
    });
    ok(lee.length === 0, "LEE gets no Edit or Delete on WSP's entry", lee.join(' | ') || 'none');
    await page.close();

    for (const [role, store, canDelete] of [
        ['assistant manager', 'WSP', false],
        ['employee', 'WSP', false],
        ['manager', 'WSP', true],
        ['owner (manager)', 'WSP', true],
        ['district manager', 'CORP', true],
        ['mocd', 'CORP', true],
    ]) {
        const { page: p } = await asRole(browser, role, store);
        const tips = await p.evaluate(() =>
            [...document.querySelectorAll('.cb-row .cb-col-actions button')]
                .map(b => b.getAttribute('data-cb-tip')));
        const hasDelete = tips.includes('Delete');
        const hasAsk = tips.some(t => /Ask a manager/.test(t || ''));
        ok(hasDelete === canDelete && hasAsk === !canDelete,
            (canDelete ? 'deletes: ' : 'must ask: ') + role + ' at ' + store, tips.join(' | '));
        await p.close();
    }

    // The request must not destroy the row — that is the whole point.
    console.log('');
    console.log('== The request leaves the row alone ==');
    const { page: asm } = await asRole(browser, 'assistant manager', 'WSP');
    const req = await asm.evaluate(() => {
        window.prompt = () => 'duplicate';
        window.cbPost = () => Promise.resolve({});   // no live write from a harness
        cbRequestDelete('r1');
        return {
            stillThere: !!_cbCache.find(e => e.id === 'r1'),
            rows: document.querySelectorAll('.cb-row').length,
            tag: (document.querySelector('.cb-note-del .cb-note-tag') || {}).textContent,
            text: (document.querySelector('.cb-note-del') || {}).textContent || '',
        };
    });
    ok(req.stillThere, 'the row survives the request');
    ok(/Delete requested/.test(req.tag || ''), 'the note is flagged', req.tag);
    ok(/duplicate/.test(req.text) && /Test assistant manager/.test(req.text),
        'with the reason and who asked', req.text.replace(/\s+/g, ' ').slice(0, 70));
    await asm.close();

    console.log('');
    console.log('== No unstyled-select flash on re-render ==');
    const { page: fl } = await asRole(browser, 'manager', 'LEE');
    // A native <select> outside a .dd-host is one the face has not reached yet.
    // Measured immediately after a render, in the same frame — which is exactly
    // where the 60ms debounce used to leave three of them visible.
    const flash = await fl.evaluate(() => new Promise(resolve => {
        const bare = () => [...document.querySelectorAll('#cbBody select')]
            .filter(s => !s.closest('.dd-host')).length;
        _cbView = 'all';
        cbRender();
        // Synchronously after the write they ARE bare — that is unavoidable, the
        // markup has to exist before it can be dressed. What matters is whether
        // the browser PAINTS them that way. The MutationObserver callback is a
        // microtask, so it runs before the rendering steps and its rAF lands in
        // the same frame: by the first animation frame the faces are on, and the
        // first paint never shows a native control. The old 60ms timeout missed
        // that frame by three or four.
        const sync = bare();
        requestAnimationFrame(() => resolve({
            sync, framed: bare(),
            total: document.querySelectorAll('#cbBody select').length,
        }));
    }));
    ok(flash.total > 0, 'the quick-add has selects to enhance', String(flash.total));
    ok(flash.framed === 0, 'and none is still bare by the first frame — so none is painted bare',
        flash.sync + ' bare on write, ' + flash.framed + ' a frame later');
    await fl.screenshot({ path: SHOT + '/cb-roles.png' });
    await fl.close();

    ok(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' | ') || 'clean');
    await browser.close();
    console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall checks passed');
    process.exit(fails ? 1 : 0);
})();
