// Call Back × Shopify matching — does the front end actually work?
//
// Mostly not a layout check (leg 10 is the exception). This drives the real
// Operations tab against the LIVE edge
// functions and asserts the things that would be silently wrong:
//
//   1. the quick-add gets its Category vocabulary, and Type stays disabled
//      until a category is chosen (choosing one populates it in place)
//   2. the green "You Have It" row goes to the store that HOLDS the stock —
//      checked at WSP, which holds the Anker match for its own customer, and
//      at LEE, which holds five PS5s for its own PS5 want
//   3. a store that holds nothing sees the neutral "N Has It" chip instead
//   4. expanding a row renders the match panel; the public Listing link is
//      offered ONLY for a genuinely published unit (114 in-stock ones are not),
//      while the Shopify ADMIN link is offered for a store's OWN stock whether
//      it is published or not -- an unpublished unit has no public page, and is
//      exactly the one somebody needs to go and edit
//   5. every match carries its CONDITION in a pill, and "Not This" for a manager
//      of the holding store and nobody else. "That's It" is gone for good; the
//      reject is what makes it safe to OFFER a broken unit rather than hide it
//   6. the feed card lights for the holding store and stays dark for a DM
//   7. the tabs: matched rows sort ABOVE unmatched on All Stores regardless of
//      time left, the Matches tab holds exactly the rows THIS STORE can answer
//      (never another store's), History shows Completed and Archived as two
//      sections with at most one open, and a tab clicked while the first fetch is
//      still in the air is not thrown away
//   8. "Add Another Item For Mark": a second want for the same customer becomes
//      its OWN call back, and the name and number do not have to be retyped
//  10. no tip on the sheet is cropped by the tooltip box -- the panel leans on
//      hover text to explain who rings the customer, and a sentence that stops
//      mid-word explains nothing
//   9. no console errors anywhere in the above
//
// NODE_PATH must point at a node_modules with puppeteer-core.
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const OUT = process.env.LV_SHOT_DIR || null;

let fails = 0;
// The 4xx that Operations produces no matter what, none of it Call Backs:
//   calendar.google.com  the embed, with no Google session in headless
//   ebay-channel         correctly refuses the harness's fake 0000 PIN
//   shopify-recat        same -- it resolves the PIN to a user and finds none
//   expenses             same, and only loads for a corp role
//   daily-brief          same
// All four functions are behaving correctly; the harness has no real PIN to give
// them. Anything NOT on this list is the leg's problem and fails it.
const IGNORE = /calendar[.]google[.]com|ebay-channel|shopify-recat|expenses|daily-brief/;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };

async function openOps(browser, who) {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e.message || e)));
    // The 401s listed at IGNORE have nothing to do with Call Backs and always
    // fire here. Everything else is the leg's problem.
    //
    // A BAD RESPONSE IS CAUGHT AT THE RESPONSE, NOT AT THE CONSOLE. Chrome reports
    // a failed subresource as a console error with no location of its own -- just
    // "Failed to load resource: ... 401" -- so IGNORE saw an empty URL and let it
    // through, and the leg failed with no way to tell WHICH resource. It only bit
    // on whichever leg stayed open long enough for the calendar iframe to give up,
    // which made it read as a flake rather than a hole in the check.
    //
    // Watching responses instead is order-independent (console and response events
    // have no guaranteed order between them, so anything correlating the two is a
    // race) and strictly stronger: an unexpected 4xx is now reported WITH its URL.
    // The generic console line is then dropped as the duplicate it always was.
    page.on('response', r => {
        if (r.status() >= 400 && !IGNORE.test(r.url())) errs.push('HTTP ' + r.status() + ' ' + r.url());
    });
    page.on('console', m => {
        if (m.type() !== 'error') return;
        if (IGNORE.test(((m.location() || {}).url || '') + ' ' + m.text())) return;
        if (/Failed to load resource/.test(m.text())) return;   // the response listener owns this
        errs.push(m.text());
    });
    await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(w => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', w.name);
        sessionStorage.setItem('speeksUserRole', w.role);
        sessionStorage.setItem('speeksUserStore', w.store);
        sessionStorage.setItem('speeksUserPin', '0000');
    }, who);
    await page.goto('file:///' + REPO + '/operations.html', { waitUntil: 'networkidle2' }).catch(() => {});
    await page.evaluate(() => {
        const o = document.getElementById('authOverlay'); if (o) o.style.display = 'none';
        document.body.classList.add('is-authenticated');
        document.body.classList.remove('preload', 'no-scroll');
        if (typeof applyRoleBasedUI === 'function') { try { applyRoleBasedUI(); } catch (e) {} }
    });
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
    // The tab hook is what loads the pane, so call it rather than clicking: the
    // button carries data-feature and may be gated for the role under test.
    await page.evaluate(() => switchOperationsTab('callbacks'));
    // Two live fetches (rows + vocab) against the edge function.
    // .cb-table is in this list because the pane no longer lands on a view that
    // has a quick-add: Matches has none, and waiting for one waits for ever.
    await page.waitForFunction(() => !!document.querySelector('.cb-quickadd, .cb-empty, .cb-table'), { timeout: 25000 });
    await new Promise(r => setTimeout(r, 1200));
    return { page, errs };
}

// Read one row's state back out of the DOM by the item text it shows.
//
// EXACT FIRST, prefix second. This was prefix-only, and the day a "PS5 Slim" row
// was logged the probe for "PS5" started answering about it instead -- a check
// about Any Model failed because somebody logged a similarly-named call back.
// A probe that silently changes which row it is asking about is worse than one
// that finds nothing.
const rowProbe = item => {
    const rows = Array.from(document.querySelectorAll('tr.cb-row'));
    const text = r => (r.querySelector('.cb-item-text')?.textContent || '').trim();
    const tr = rows.find(r => text(r) === item) || rows.find(r => text(r).startsWith(item));
    if (!tr) return null;
    const bg = getComputedStyle(tr).backgroundColor;
    return {
        green: tr.classList.contains('cb-row-hasit'),
        // The class is not the claim -- the paint is. rgb(232, 247, 238) is
        // --cb-sage-tint, which is what an UNCLICKED matched row has to be.
        bg,
        painted: bg === 'rgb(232, 247, 238)',
        tags: Array.from(tr.querySelectorAll('.cb-tag')).map(t => t.textContent.trim()),
        cat: (tr.querySelector('.cb-cat')?.textContent || '').trim(),
        id: tr.getAttribute('data-id'),
    };
};

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });

    // ── 1 + 2 + 4 + 5: WSP, who holds the Anker its own customer asked for ──
    console.log('\n== Operations → Customer Call Backs, as a WSP manager ==');
    {
        const { page, errs } = await openOps(browser, { name: 'Match Harness', role: 'manager', store: 'WSP' });
        // WHERE THE PANE OPENS ITSELF, which is a decision now rather than a
        // constant: Matches when anybody has stock against a call back, All Stores
        // when nobody does. WSP holds the Anker, so it is the former.
        const landed = await page.evaluate(() => {
            const sel = document.getElementById('cbStoreFilter');
            // ⚠️ MEASURE WHAT A PERSON CAN SEE. The native select is hidden by the
            // custom dropdown either way and always reads display:none, so asserting
            // on it passes whether the control is on screen or not -- which is
            // exactly how the dropdown stayed visible while this check was green.
            // The .dd-btn face is the control.
            const face = (sel.closest('.dd-host') || sel).querySelector('.dd-btn') || sel;
            return {
                active: (document.querySelector('.cb-view-toggle .mb-view-btn.active') || {}).id,
                visible: !!(face.offsetWidth || face.offsetHeight || face.getClientRects().length),
            };
        });
        ok(landed.active === 'cbViewMatchesBtn', 'the pane lands on Matches when there are any', landed.active);
        // The store dropdown is a corp control. A store has My Store and All
        // Stores, which is the same question with one fewer thing to leave set wrong.
        ok(landed.visible === false, 'and a store manager sees no store dropdown', 'visible=' + landed.visible);

        // Matches carries no quick-add, so the vocabulary checks need a view that
        // has one.
        await page.evaluate(() => cbSetView('mine'));
        await new Promise(r => setTimeout(r, 1500));
        const vocab = await page.evaluate(() => {
            const c = document.getElementById('cbAddCategory');
            const t = document.getElementById('cbAddType');
            return { cats: c ? c.options.length : 0, typeDisabled: t ? t.disabled : null,
                     firstCat: c && c.options[1] ? c.options[1].textContent : '' };
        });
        ok(vocab.cats > 50, 'Category select is populated', vocab.cats + ' options, first = "' + vocab.firstCat + '"');
        ok(vocab.typeDisabled === true, 'Type select starts disabled');

        const picked = await page.evaluate(() => {
            const c = document.getElementById('cbAddCategory');
            c.value = 'video-game-systems';
            cbCategoryChanged('cbAddCategory', 'cbAddType');
            const t = document.getElementById('cbAddType');
            return { n: t.options.length, disabled: t.disabled, sample: t.options[1] ? t.options[1].textContent : '' };
        });
        ok(picked.n > 5 && !picked.disabled, 'Choosing a category fills Type in place',
            picked.n + ' options, e.g. "' + picked.sample + '"');

        const anker = await page.evaluate(rowProbe, 'Anker portable charger');
        ok(!!anker && anker.green, 'WSP\'s own Anker row is green (WSP holds it)');
        ok(!!anker && anker.tags.some(t => /You Have It/i.test(t)), 'and carries the You Have It chip',
            anker ? JSON.stringify(anker.tags) : 'row missing');
        ok(!!anker && /Charging & Power/.test(anker.cat), 'category + type shown under the item', anker && anker.cat);

        // Expand it: the panel, the absence of a PUBLIC link for an unpublished
        // unit, and the presence of the admin one because WSP owns this stock.
        const panel = await page.evaluate(id => {
            cbToggleRow(id);
            const d = document.querySelector('tr.cb-row-detail');
            const p = d && d.querySelector('.cb-match-panel');
            if (!p) return null;
            const m = p.querySelector('.cb-match');
            return {
                heads: Array.from(p.querySelectorAll('.cb-match-head')).map(h => h.textContent.trim()),
                store: m && m.querySelector('.cb-m-store')?.textContent.trim(),
                title: m && m.querySelector('.cb-m-title')?.textContent.trim(),
                meta: m && m.querySelector('.cb-m-meta')?.textContent.trim(),
                links: Array.from(p.querySelectorAll('a.cb-m-btn')).map(a => a.textContent.trim()),
                hrefs: Array.from(p.querySelectorAll('a.cb-m-btn')).map(a => a.getAttribute('href')),
                btns: Array.from(p.querySelectorAll('button.cb-m-btn')).map(b => b.textContent.trim()),
                conds: Array.from(p.querySelectorAll('.cb-match')).map(row => {
                    const c = row.querySelector('.cb-m-cond');
                    return c ? { text: c.textContent.trim(), cls: c.className } : null;
                }),
            };
        }, anker.id);
        ok(!!panel, 'expanding the row renders the match panel');
        ok(panel && /You Have This/i.test(panel.heads[0] || ''), 'ours is under its own heading', panel && panel.heads.join(' | '));
        ok(panel && panel.store === 'WSP', 'the holding store is stamped on the match', panel && panel.store);
        ok(panel && !/filed under/i.test(panel.meta || ''), 'the filed-under-Other admission is gone', panel && panel.meta);
        ok(panel && /Not Listed Online/.test(panel.meta || ''), 'and the unpublished note is title-cased', panel && panel.meta);
        ok(panel && !panel.links.includes('Listing'), 'no public Listing link for an unpublished unit', JSON.stringify(panel && panel.links));
        ok(panel && panel.links.includes('Shopify'), 'but WSP gets the admin link to its OWN unpublished unit', JSON.stringify(panel && panel.hrefs));
        ok(panel && /^https:[/][/]admin[.]shopify[.]com[/]store[/]paymore-westport[/]products[/][0-9]+$/
            .test((panel.hrefs || []).find(h => /admin[.]shopify/.test(h || '')) || ''),
            'and it is a real product URL, not a gid', (panel.hrefs || []).join(' '));
        // "NOT THIS" IS THE ONLY DECISION. It is what makes offering a broken unit
        // safe: one press and the pairing is never suggested to this customer again.
        ok(panel && panel.btns.includes('Not This'),
            'the holding store\'s manager is offered Not This', JSON.stringify(panel && panel.btns));
        ok(panel && !panel.btns.some(b => /That's It/i.test(b)),
            'and That\'s It is still gone', JSON.stringify(panel && panel.btns));
        // EVERY line carries a condition pill, including when nothing is known:
        // rendering no pill would read as "fine" on an ungraded unit.
        ok(panel && panel.conds.length > 0 && panel.conds.every(c => c && c.text),
            'every match line carries a condition pill', JSON.stringify(panel && panel.conds));
        ok(panel && panel.conds.every(c => /is-(new|good|fair|broken|unknown)/.test(c.cls)),
            'and each pill is toned', JSON.stringify(panel && panel.conds.map(c => c.cls)));
        // OUT OF STOCK IS NOT OFFERED. The server stopped shipping `sold` and the
        // panel stopped having a section for it, so neither half can bring it back.
        const gone = await page.evaluate(() => ({
            heads: Array.from(document.querySelectorAll('.cb-match-head')).map(h => h.textContent.trim()),
            states: Array.from(document.querySelectorAll('tr.cb-row-detail')).flatMap(d =>
                Array.from(d.querySelectorAll('.cb-match')).map(m => m.className)),
            soldStates: (window._cbCache || []).flatMap(e => (e.matches || []).map(m => m.state)),
        }));
        ok(!gone.heads.some(h => /No Longer In Stock/i.test(h)), 'no out-of-stock section on the panel', JSON.stringify(gone.heads));
        ok(!gone.soldStates.includes('sold'), 'and the server does not even send sold matches',
            JSON.stringify([...new Set(gone.soldStates)]));
        ok(anker && anker.painted, 'the matched row is painted the sage tint unclicked', anker && anker.bg);

        if (OUT) await page.screenshot({ path: OUT + '/cb-wsp.png', fullPage: false });
        ok(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' / ') || 'clean');
        await page.close();
    }

    // ── 2 + 4: LEE, five PS5s for its own PS5 want, and they ARE published ──
    console.log('\n== As a LEE manager (holds five PS5s) ==');
    {
        const { page, errs } = await openOps(browser, { name: 'Match Harness', role: 'manager', store: 'LEE' });
        // ALL STORES, not the default My Store. Which store LOGGED the PS5 want
        // moves with whoever last took the call — it was LEE's, it is OVL's now —
        // and this section is not about that. It is about the store that HOLDS
        // the stock seeing green on somebody else's row, which is the whole
        // direction of the feature and only visible from the cross-store list.
        await page.evaluate(() => cbSetView('all'));
        await page.waitForFunction(() => window._cbView === 'all' || true, { timeout: 5000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1400));
        const ps5 = await page.evaluate(rowProbe, 'PS5');
        ok(!!ps5 && ps5.green, 'LEE\'s PS5 row is green');
        ok(!!ps5 && ps5.tags.some(t => /You Have It · \d/.test(t)), 'the chip counts them', ps5 && JSON.stringify(ps5.tags));
        ok(!!ps5 && ps5.tags.some(t => /Any Model/i.test(t)), 'and the Any Model tag is shown');

        ok(ps5 && ps5.painted, 'and it is painted the sage tint unclicked', ps5 && ps5.bg);
        const links = await page.evaluate(id => {
            cbToggleRow(id);
            return Array.from(document.querySelectorAll('tr.cb-row-detail a.cb-m-btn'))
                .map(a => a.textContent.trim() + ' ' + a.getAttribute('href'));
        }, ps5.id);
        // A published unit LEE owns gets both: the public page you read to the
        // customer, and the admin page you go to when it needs changing.
        ok(links.some(l => /^Listing https:[/][/]paymore-[a-z-]+[.]myshopify[.]com[/]products[/]/.test(l)),
            'a published unit offers a real storefront link', links.join(' | ') || 'none');
        ok(links.some(l => /^Shopify https:[/][/]admin[.]shopify[.]com[/]store[/]paymore-lees-summit[/]products[/][0-9]+$/.test(l)),
            'and its own store also gets the admin link', links.join(' | ') || 'none');

        if (OUT) await page.screenshot({ path: OUT + '/cb-lee.png', fullPage: false });
        ok(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' / ') || 'clean');
        await page.close();
    }

    // ── 3 + 5: OVL holds one N64 for WSP's customer, but not the iPhone 15 ──
    console.log('\n== As an OVL employee (holds stock, may not decide) ==');
    {
        const { page, errs } = await openOps(browser, { name: 'Match Harness', role: 'employee', store: 'OVL' });
        await page.evaluate(() => cbSetView('all'));
        await new Promise(r => setTimeout(r, 1500));
        const n64 = await page.evaluate(rowProbe, 'Nintendo 64 full console');
        ok(!!n64 && n64.green, 'OVL sees WSP\'s N64 want as green (OVL holds one)');

        // NOT PINNED TO A NAMED ROW. This asked whether the iPhone 15 want was grey
        // at OVL, and on 2026-08-24 a sweep gave OVL an iPhone 15 — so a check about
        // the CHIP started failing because of the shop floor. The rule is what
        // matters: a row somebody else holds says who, and offers no admin link.
        // So the row is chosen from the list by that property instead of by name.
        const rows = await page.evaluate(() => Array.from(document.querySelectorAll('tr.cb-row')).map(r => ({
            item: ((r.querySelector('.cb-item-text') || {}).textContent || '').trim(),
            id: r.getAttribute('data-id'),
            mine: !!r.querySelector('.cb-tag-hasit'),
            elsewhere: !!r.querySelector('.cb-tag-elsewhere'),
            tags: Array.from(r.querySelectorAll('.cb-tag')).map(t => t.textContent.trim()),
        })));
        const theirs = rows.find(r => r.elsewhere && !r.mine);
        const none = rows.find(r => !r.elsewhere && !r.mine);
        ok(!!none, 'some row is green at nobody', none ? none.item : 'every row has stock somewhere');
        ok(!!theirs, 'and some row is held by another store', theirs ? theirs.item : 'none');
        ok(!theirs || theirs.tags.some(t => /[A-Z]{3} Has It|Stores Have It/.test(t)),
            'a row another store holds says WHICH store', theirs && JSON.stringify(theirs.tags));

        const btns = await page.evaluate(id => {
            cbToggleRow(id);
            const p = document.querySelector('tr.cb-row-detail .cb-match-panel');
            if (!p) return null;
            return { buttons: Array.from(p.querySelectorAll('button.cb-m-btn')).map(b => b.textContent.trim()),
                     links: Array.from(p.querySelectorAll('a.cb-m-btn')).map(a => a.textContent.trim()) };
        }, n64.id);
        // An employee sees the green row and rings the customer, but a permanent
        // veto on what the sweep offers is a manager's call — cbCanDecide mirrors
        // the server, so a button that would 403 is never drawn.
        ok(btns && btns.buttons.length === 0, 'an employee is offered no Not This', JSON.stringify(btns.buttons));
        // The admin link is not role-gated. It is a link, the store computer is
        // signed into that store's Shopify, and Shopify itself is the gate.
        ok(btns && btns.links.includes('Shopify'), 'OVL still gets the admin link to its own N64', JSON.stringify(btns));
        // The other half of the same rule: it is OWN-store only, so the LEE
        // iPhone OVL does not hold must not offer one.
        const foreign = theirs ? await page.evaluate(id => {
            cbToggleRow(id);
            const p = document.querySelector('tr.cb-row-detail .cb-match-panel');
            return p ? Array.from(p.querySelectorAll('a.cb-m-btn')).map(a => a.textContent.trim()) : null;
        }, theirs.id) : null;
        ok(foreign && !foreign.includes('Shopify'),
            'and no admin link for another store' + String.fromCharCode(39) + 's stock',
            (theirs ? theirs.item + ': ' : '') + JSON.stringify(foreign));

        ok(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' / ') || 'clean');
        await page.close();
    }

    // ── 7: the tabs ────────────────────────────────────────────────────────
    // A LEE manager on All Stores: the long cross-store list, which is the one
    // the ordering was asked for.
    console.log('\n== The tabs, as a LEE manager ==');
    {
        const { page, errs } = await openOps(browser, { name: 'Match Harness', role: 'manager', store: 'LEE' });
        await page.evaluate(() => cbSetView('all'));
        await new Promise(r => setTimeout(r, 1600));

        // MATCHES FIRST, and the proof has to be that an OLDER matched row beats a
        // NEWER unmatched one -- otherwise the date sort alone could produce the
        // same list and the check would pass on nothing.
        const order = await page.evaluate(() => Array.from(document.querySelectorAll('tr.cb-row')).map(r => ({
            item: (r.querySelector('.cb-item-text') || {}).textContent,
            matched: !!r.querySelector('.cb-tag-hasit, .cb-tag-elsewhere'),
            mine: !!r.querySelector('.cb-tag-hasit'),
            logged: (r.querySelector('.cb-logged-date') || {}).textContent,
        })));
        const lastMatched = order.map(r => r.matched).lastIndexOf(true);
        const firstUnmatched = order.map(r => r.matched).indexOf(false);
        ok(order.length > 4, 'All Stores lists the cross-store rows', order.length + ' rows');
        ok(firstUnmatched === -1 || lastMatched < firstUnmatched,
            'every matched row sits above every unmatched one',
            order.map(r => (r.matched ? '*' : '-') + (r.item || '').slice(0, 14)).join(' | '));
        // Own stock ahead of another store's inside the matched band.
        const mineIdx = order.filter(r => r.matched).map(r => r.mine);
        ok(mineIdx.lastIndexOf(true) < mineIdx.indexOf(false) || !mineIdx.includes(false),
            'and your own stock leads the matched band', JSON.stringify(mineIdx));

        // The Matches tab: exactly the matched rows, nothing else, and no quick-add.
        const m = await page.evaluate(async () => {
            cbSetView('matches');
            await new Promise(r => setTimeout(r, 1500));
            const rows = Array.from(document.querySelectorAll('tr.cb-row'));
            return {
                rows: rows.length,
                allMatched: rows.every(r => !!r.querySelector('.cb-tag-hasit, .cb-tag-elsewhere')),
                // The chip that means ANOTHER store holds it. None of these belong
                // on this tab for a store role: an OVL manager opened it onto a WSP
                // row they can do nothing about.
                elsewhere: rows.filter(r => !!r.querySelector('.cb-tag-elsewhere'))
                    .map(r => ((r.querySelector('.cb-item-text') || {}).textContent || '').trim()),
                quickAdd: !!document.querySelector('.cb-quickadd'),
                sub: (document.getElementById('cbSubtitle') || {}).textContent,
                active: (document.querySelector('.cb-view-toggle .mb-view-btn.active') || {}).id,
                firstTab: (document.querySelector('.cb-view-toggle .mb-view-btn') || {}).id,
            };
        });
        ok(m.firstTab === 'cbViewMatchesBtn', 'Matches is the FIRST tab', m.firstTab);
        ok(m.active === 'cbViewMatchesBtn', 'and clicking it makes it the active one', m.active);
        ok(m.rows > 0 && m.allMatched, 'the Matches tab holds only matched rows', m.rows + ' rows, allMatched=' + m.allMatched);
        // ONLY THIS STORE'S WORK. Both halves matter: nothing another store holds,
        // and everything this one does.
        ok(m.elsewhere.length === 0, 'and nothing another store holds', JSON.stringify(m.elsewhere));
        ok(m.rows === order.filter(r => r.mine).length,
            'and every row LEE can answer', m.rows + ' vs ' + order.filter(r => r.mine).length + ' green on All Stores');
        ok(!m.quickAdd, 'no quick-add on a worklist', 'quickAdd=' + m.quickAdd);
        ok(/you can answer/.test(m.sub || ''), 'the subtitle counts answerable work, not open rows', m.sub);

        // History: two sections, Completed open by default, strictly one at a time.
        const h = await page.evaluate(async () => {
            cbSetView('history');
            await new Promise(r => setTimeout(r, 2000));
            const read = () => Array.from(document.querySelectorAll('.cb-hist-head')).map(b => ({
                label: (b.querySelector('.cb-hist-label') || {}).textContent,
                open: b.classList.contains('is-open'),
                n: (b.querySelector('.cb-hist-n') || {}).textContent,
            }));
            const start = read();
            const bodies = document.querySelectorAll('.cb-hist-body').length;
            cbSetHistory('archived');
            const after = read();
            const afterBodies = document.querySelectorAll('.cb-hist-body').length;
            // COUNTED HERE, while Archived is the open section. Reading them at the
            // end counted whatever was open then, which after the collapse test is
            // Completed — 0 of 0, and the assertion passed on nothing.
            const archivedRows = document.querySelectorAll('tr.cb-row').length;
            const expired = document.querySelectorAll('.cb-chip-expired').length;
            // Clicking the open one COLLAPSES it: either section may be shut, and
            // both may be at once.
            cbSetHistory('archived');
            const again = read();
            const noneBodies = document.querySelectorAll('.cb-hist-body').length;
            cbSetHistory('completed');
            const done = read();
            return { start, bodies, after, afterBodies, again, noneBodies, done,
                     archivedRows, expired,
                     quickAdd: !!document.querySelector('.cb-quickadd'),
                     sub: (document.getElementById('cbSubtitle') || {}).textContent };
        });
        ok(h.start.length === 2 && h.start[0].label === 'Completed' && h.start[1].label === 'Archived',
            'History carries both lists as sections', JSON.stringify(h.start.map(x => x.label)));
        // DEFAULT DEPENDS ON THE DATA. Completed opens itself when it has rows; with
        // none, both start shut rather than leading the tab with an empty list.
        const anyDone = Number(h.start[0].n) > 0;
        ok(h.start[0].open === anyDone, anyDone
            ? 'Completed opens itself when it has rows'
            : 'both start shut when nothing is completed', JSON.stringify(h.start));
        ok(!h.start[1].open, 'Archived never opens itself', JSON.stringify(h.start));
        ok(h.bodies <= 1 && h.afterBodies === 1, 'never more than one section rendered', h.bodies + ' then ' + h.afterBodies);
        ok(!h.after[0].open && h.after[1].open, 'opening Archived closes Completed', JSON.stringify(h.after));
        ok(!h.again[0].open && !h.again[1].open && h.noneBodies === 0,
            'clicking the open one collapses it, leaving both shut', JSON.stringify(h.again));
        ok(h.done[0].open && !h.done[1].open, 'and Completed can be opened back up', JSON.stringify(h.done));
        ok(!h.quickAdd, 'no quick-add on History', 'quickAdd=' + h.quickAdd);
        ok(/completed .* archived/.test(h.sub || ''), 'the subtitle counts both', h.sub);
        // The archived rows really are archived: every one wears the Expired chip,
        // which is driven off the ROW now rather than off the view.
        ok(h.archivedRows > 0 && h.expired === h.archivedRows,
            'every archived row is stamped Expired', h.expired + ' of ' + h.archivedRows);

        ok(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' / ') || 'clean');
        await page.close();
    }

    // ── 7d: the condition pill says what the SERVER said ───────────────────
    // The tone is derived in the browser, but the WORD has to be the shelf's own.
    // A pill showing a grade the payload never carried would be a guess dressed up
    // as a fact, which on a broken unit is the whole failure mode.
    //
    // The payload is FETCHED rather than read out of the module: _cbCache is a
    // module-level `let`, not a property of window, so page.evaluate cannot see it
    // (the same reason an earlier probe for _cbView came back undefined). Fetching
    // the endpoint the app itself calls is a better test anyway — it compares the
    // rendered pill against the server's answer, not against another copy of the
    // browser's own state.
    console.log('\n== The condition pill vs the payload ==');
    {
        const { page, errs } = await openOps(browser, { name: 'Match Harness', role: 'manager', store: 'LEE' });
        const cmp = await page.evaluate(async () => {
            const res = await fetch('https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/customer-callbacks'
                                  + '?view=active&store=&v=' + Date.now());
            const payload = await res.json();
            const byId = {};
            for (const e of payload) {
                if ((e.matches || []).length) byId[e.id] = e.matches.map(m => m.condition || 'Unknown Condition');
            }
            cbSetView('all');
            await new Promise(r => setTimeout(r, 1600));
            const out = [];
            for (const r of Array.from(document.querySelectorAll('tr.cb-row'))) {
                const id = r.getAttribute('data-id');
                if (!byId[id]) continue;
                cbToggleRow(id);
                await new Promise(x => setTimeout(x, 120));
                out.push({
                    item: ((r.querySelector('.cb-item-text') || {}).textContent || '').trim(),
                    payload: byId[id],
                    pills: Array.from(document.querySelectorAll('tr.cb-row-detail .cb-m-cond')).map(p => p.textContent.trim()),
                });
                cbToggleRow(id);
                await new Promise(x => setTimeout(x, 80));
                if (out.length >= 3) break;
            }
            return out;
        });
        ok(cmp.length > 0, 'some expanded rows to compare', cmp.length + ' rows');
        // Set-compare, not order-compare: the panel deliberately sorts broken last.
        const same = cmp.every(r => [...r.payload].sort().join('|') === [...r.pills].sort().join('|'));
        ok(cmp.length > 0 && same, 'every pill is a word the payload actually carried',
            JSON.stringify(cmp.map(r => ({ item: r.item, payload: r.payload, pills: r.pills }))));

        // And the ordering rule: nothing broken above something sound.
        const order = await page.evaluate(async () => {
            const bad = (t) => /(broken|dead|bad|damag|crack|for parts)/i.test(t);
            for (const r of Array.from(document.querySelectorAll('tr.cb-row'))) {
                cbToggleRow(r.getAttribute('data-id'));
                await new Promise(x => setTimeout(x, 120));
                const pills = Array.from(document.querySelectorAll('tr.cb-row-detail .cb-m-cond'))
                    .map(p => bad(p.textContent) ? 'BAD' : 'ok');
                if (pills.includes('BAD') && pills.includes('ok')) return pills;
                cbToggleRow(r.getAttribute('data-id'));
                await new Promise(x => setTimeout(x, 80));
            }
            return null;
        });
        ok(order === null || order.lastIndexOf('ok') < order.indexOf('BAD'),
            'broken sorts below everything sound',
            order === null ? 'no row mixes broken with sound stock' : JSON.stringify(order));
        ok(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' / ') || 'clean');
        await page.close();
    }

    // ── 7c: a tab clicked while the first fetch is in the air ──────────────
    // THE PANEL LOOKED FROZEN. cbSetView sets the view then calls cbLoad, and a
    // bare `if (_cbLoading) return` threw the click away: nothing re-rendered, and
    // clicking the SAME tab again hit cbSetView's equality guard and did nothing at
    // all. Then the in-flight first load landed and overwrote the view with its own
    // default. Arriving from another Operations tab is what made it easy to hit.
    //
    // openOps is not used here on purpose: it waits for the pane to settle, which
    // is exactly the window this test needs to be inside.
    console.log('\n== A view clicked mid-fetch ==');
    for (const btn of ['cbViewMineBtn', 'cbViewHistoryBtn']) {
        const page = await browser.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(String(e.message || e)));
        page.on('response', r => { if (r.status() >= 400 && !IGNORE.test(r.url())) errs.push('HTTP ' + r.status() + ' ' + r.url()); });
        await page.setViewport({ width: 1500, height: 1000 });
        await page.evaluateOnNewDocument(() => {
            sessionStorage.setItem('speeksUnlocked', 'true');
            sessionStorage.setItem('speeksUserName', 'Match Harness');
            sessionStorage.setItem('speeksUserRole', 'manager');
            sessionStorage.setItem('speeksUserStore', 'LEE');
            sessionStorage.setItem('speeksUserPin', '0000');
        });
        await page.goto('file:///' + REPO + '/operations.html', { waitUntil: 'networkidle2' }).catch(() => {});
        await page.evaluate(() => {
            const o = document.getElementById('authOverlay'); if (o) o.style.display = 'none';
            document.body.classList.add('is-authenticated');
            document.body.classList.remove('preload', 'no-scroll');
            if (typeof applyRoleBasedUI === 'function') { try { applyRoleBasedUI(); } catch (e) {} }
        });
        await page.evaluate(() => switchOperationsTab('callbacks'));
        await new Promise(r => setTimeout(r, 150));   // inside the first fetch
        await page.evaluate(id => document.getElementById(id).click(), btn);
        await new Promise(r => setTimeout(r, 4000));  // let it land, and the requeue run
        const got = await page.evaluate(() => {
            const on = document.querySelector('.cb-view-toggle .mb-view-btn.active');
            return { active: on ? on.id : null,
                     hist: document.querySelectorAll('.cb-hist-head').length,
                     sub: (document.getElementById('cbSubtitle') || {}).textContent };
        });
        ok(got.active === btn, 'clicking ' + btn + ' mid-fetch still lands there', JSON.stringify(got));
        // History is the one that needs a SECOND fetch (the archived rows), so it
        // proves the requeue actually ran rather than the render just being lucky.
        if (btn === 'cbViewHistoryBtn') {
            ok(got.hist === 2 && /archived/.test(got.sub || ''),
                'and History got its archived rows from the requeued load', JSON.stringify(got));
        }
        ok(errs.length === 0, 'no errors', errs.slice(0, 2).join(' / ') || 'clean');
        await page.close();
    }

    // ── 8: one customer, several wants ─────────────────────────────────────
    // ⚠️ THIS LEG MUST NEVER WRITE. Every other check here reads live data; this
    // one exercises the add path, and a harness that logs test call backs into the
    // real sheet is a harness somebody turns off. cbPost is stubbed instead, which
    // is safe because it is a plain function declaration — assigning window.cbPost
    // replaces the global binding cbQuickAdd actually calls. Everything after the
    // POST is what we are testing anyway: the optimistic row, the remembered
    // customer, and the pre-filled form.
    console.log('\n== Add Another Item, as a WSP manager ==');
    {
        const { page, errs } = await openOps(browser, { name: 'Match Harness', role: 'manager', store: 'WSP' });
        const flow = await page.evaluate(async () => {
            window.cbPost = async () => ({ success: true });   // no network, no write
            window.alert = () => {};                            // a refusal must not block
            cbSetView('mine');
            await new Promise(r => setTimeout(r, 1200));
            const set = (id, v) => { const el = document.getElementById(id); el.value = v; return el; };
            const strip = () => {
                const s = document.querySelector('.cb-qa-for');
                return s ? { txt: s.textContent.replace(/\s+/g, ' ').trim(), done: s.classList.contains('is-done') } : null;
            };
            const before = strip();

            set('cbAddName', 'Harness Twowants');
            set('cbAddPhone', '9130000000');
            set('cbAddItem', 'Nintendo 64 full console');
            set('cbAddCategory', 'video-game-systems');
            cbCategoryChanged('cbAddCategory', 'cbAddType');
            document.getElementById('cbAddAnyModel').checked = true;
            await cbQuickAdd();
            const offered = strip();

            // The offer, taken.
            cbAddAnotherItem();
            await new Promise(r => setTimeout(r, 300));
            const pinned = strip();
            const filled = {
                name: document.getElementById('cbAddName').value,
                phone: document.getElementById('cbAddPhone').value,
                item: document.getElementById('cbAddItem').value,
                cat: document.getElementById('cbAddCategory').value,
                any: document.getElementById('cbAddAnyModel').checked,
                focused: (document.activeElement || {}).id,
            };

            // The second want, which must land as its OWN row.
            set('cbAddItem', 'PS4 complete');
            set('cbAddCategory', 'video-game-systems');
            cbCategoryChanged('cbAddCategory', 'cbAddType');
            document.getElementById('cbAddAnyModel').checked = true;
            await cbQuickAdd();
            await new Promise(r => setTimeout(r, 300));
            const rows = Array.from(document.querySelectorAll('tr.cb-row'))
                .map(r => ({
                    cust: ((r.querySelector('.cb-customer') || {}).textContent || '').trim(),
                    item: ((r.querySelector('.cb-item-text') || {}).textContent || '').trim(),
                    timer: ((r.querySelector('.cb-cell-timer') || {}).textContent || '').trim(),
                }))
                .filter(r => r.cust === 'Harness Twowants');

            cbAddForClear();
            await new Promise(r => setTimeout(r, 200));
            const cleared = { strip: strip(), name: document.getElementById('cbAddName').value };
            return { before, offered, pinned, filled, rows, cleared };
        });

        ok(flow.before === null, 'no strip before anything is logged', JSON.stringify(flow.before));
        ok(!!flow.offered && flow.offered.done === true && /Add Another Item For Harness Twowants/.test(flow.offered.txt),
            'a save offers to add another for the same customer', flow.offered && flow.offered.txt);
        ok(!!flow.pinned && flow.pinned.done === false && /Adding Another Item For Harness Twowants/.test(flow.pinned.txt),
            'taking the offer says so, with a way out', flow.pinned && flow.pinned.txt);
        ok(flow.filled.name === 'Harness Twowants' && /913/.test(flow.filled.phone),
            'the customer is pre-filled', JSON.stringify(flow.filled));
        // The point of pre-filling only the customer: the WANT must start blank, or
        // the second row is a copy of the first.
        ok(flow.filled.item === '' && flow.filled.cat === '' && flow.filled.any === false,
            'and the item, category and Any Model start empty', JSON.stringify(flow.filled));
        ok(flow.filled.focused === 'cbAddItem', 'with the cursor in the item field', flow.filled.focused);
        ok(flow.rows.length === 2, 'two wants become TWO call backs', JSON.stringify(flow.rows.map(r => r.item)));
        ok(flow.rows.length === 2 && flow.rows.every(r => /\d+d left/.test(r.timer)),
            'each with its own timer', JSON.stringify(flow.rows.map(r => r.timer)));
        ok(flow.cleared.strip === null && flow.cleared.name === '',
            'and Done clears both the strip and the fields', JSON.stringify(flow.cleared));
        ok(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' / ') || 'clean');
        await page.close();
    }

    // ── 7b: corp keeps the store dropdown ──────────────────────────────────
    console.log('\n== As a DM (corp) ==');
    {
        const { page, errs } = await openOps(browser, { name: 'Match Harness', role: 'district manager', store: 'ALL' });
        const dm = await page.evaluate(() => {
            const sel = document.getElementById('cbStoreFilter');
            const face = (sel.closest('.dd-host') || sel).querySelector('.dd-btn') || sel;
            return {
                visible: !!(face.offsetWidth || face.offsetHeight || face.getClientRects().length),
                mine: getComputedStyle(document.getElementById('cbViewMineBtn')).display,
                active: (document.querySelector('.cb-view-toggle .mb-view-btn.active') || {}).id,
            };
        });
        ok(dm.visible === true, 'a DM keeps the store dropdown', 'visible=' + dm.visible);
        ok(dm.mine === 'none', 'and still has no My Store view', dm.mine);
        ok(dm.active === 'cbViewMatchesBtn' || dm.active === 'cbViewAllBtn',
            'and lands on Matches or All Stores, never My Store', dm.active);
        ok(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' / ') || 'clean');
        await page.close();
    }

    // ── 6: the feed card ───────────────────────────────────────────────────
    console.log('\n== The action-feed card ==');
    for (const who of [{ name: 'Match Harness', role: 'manager', store: 'WSP', want: true },
                       { name: 'Match Harness', role: 'district manager', store: 'ALL', want: false }]) {
        const page = await browser.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(String(e.message || e)));
        await page.setViewport({ width: 1500, height: 1000 });
        await page.evaluateOnNewDocument(w => {
            sessionStorage.setItem('speeksUnlocked', 'true');
            sessionStorage.setItem('speeksUserName', w.name);
            sessionStorage.setItem('speeksUserRole', w.role);
            sessionStorage.setItem('speeksUserStore', w.store);
            sessionStorage.setItem('speeksUserPin', '0000');
        }, who);
        await page.goto('file:///' + REPO + '/index.html', { waitUntil: 'networkidle2' }).catch(() => {});
        await page.evaluate(() => {
            const o = document.getElementById('authOverlay'); if (o) o.style.display = 'none';
            document.body.classList.add('is-authenticated');
            document.body.classList.remove('preload', 'no-scroll');
            if (typeof applyRoleBasedUI === 'function') { try { applyRoleBasedUI(); } catch (e) {} }
        });
        const res = await page.evaluate(async () => {
            await checkCallbackMatchReminders();
            const b = document.getElementById('cbMatchAlertBubble');
            const t = document.getElementById('cbMatchAlertBubbleText');
            const card = (typeof _samGatherReminders === 'function'
                ? _samGatherReminders() : []).find(r => r.key === 'cbMatch');
            return {
                shown: !!b && getComputedStyle(b).display !== 'none',
                summary: t && t.dataset ? t.dataset.summary : null,
                stores: t && t.dataset ? t.dataset.stores : null,
                card: card ? { title: card.title, due: card.due, snippet: card.snippet } : null,
            };
        });
        const tag = who.store === 'ALL' ? 'DM' : who.store;
        ok(res.shown === who.want, `[${tag}] bubble ${who.want ? 'lights' : 'stays dark'}`, 'shown=' + res.shown);
        if (who.want) {
            ok(!!res.card, `[${tag}] the feed picks the card up`, res.card ? res.card.title + ' / ' + res.card.due : 'missing');
            ok(!!res.card && /call back/i.test(res.card.snippet || ''), `[${tag}] with a readable line`, res.card && res.card.snippet);
            ok(res.stores === 'WSP', `[${tag}] holding store stamped for MSM routing`, res.stores);
        }
        ok(errs.length === 0, `[${tag}] no console errors`, errs.slice(0, 2).join(' / ') || 'clean');
        await page.close();
    }

    // ── 10: no hover text is cropped ────────────────────────────────────────
    // The tooltip box is max-width:340px + overflow:hidden. A nowrap child
    // overflows it and is CROPPED -- with no scrollbar, no ellipsis and no
    // visible edge, so "4 Stores Have It" explained itself as far as "...and
    // should b" and simply stopped. Nothing on screen said it had been cut.
    //
    // Measured as scrollWidth vs clientWidth, which is the only way to see a
    // crop from script. And measured against EVERY tip string the module can
    // emit rather than whatever today's rows happen to offer: the live sheet
    // served a 69-char tip the day this was written and the broken one was 139,
    // so a check pinned to real data would have passed while the bug was on
    // screen. The strings are read out of speeks.js and hung on a real badge.
    console.log('\n== Hover text is never cut off ==');
    {
        const src = require('fs').readFileSync(REPO + '/speeks.js', 'utf8');
        const tips = [];
        for (const mm of src.matchAll(/data-cb-tip="([^"]{25,})"/g)) {
            const t = mm[1]
                .replace(/\$\{escapeHtml\(stores\.join\(', '\)\)\}/g, 'BAL, LEE, MPL, OVL')
                .replace(/\$\{[^}]*\}/g, 'have')
                .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
            if (!/\$\{/.test(t)) tips.push(t);
        }
        tips.sort((a, b) => b.length - a.length);

        const { page, errs } = await openOps(browser, { name: 'Match Harness', role: 'dm', store: 'ALL' });
        await page.evaluate(() => cbSetView('all'));
        await new Promise(r => setTimeout(r, 1800));
        const spot = await page.evaluate(() => {
            const t = document.querySelector('.cb-tag-hasit, .cb-tag-elsewhere');
            if (!t) return null;
            t.id = 'probeTag';
            const r = t.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        ok(!!spot && tips.length > 0, 'a badge to hang each tip on', tips.length + ' tip strings, longest ' + (tips[0] || '').length);
        let bad = [];
        if (spot) for (const tip of tips) {
            await page.evaluate(t => { document.getElementById('probeTag').dataset.cbTip = t; }, tip);
            // Away and back, so mouseover re-fires with the new text.
            await page.mouse.move(5, 5);
            await new Promise(r => setTimeout(r, 50));
            await page.mouse.move(spot.x, spot.y);
            await new Promise(r => setTimeout(r, 140));
            const m = await page.evaluate(() => {
                const t = document.querySelector('.speeks-tooltip');
                if (!t || !t.classList.contains('show')) return null;
                const r = t.getBoundingClientRect();
                return { shown: t.textContent, crop: t.scrollWidth - t.clientWidth,
                         left: r.left, right: r.right, top: r.top, bottom: r.bottom,
                         vw: window.innerWidth, vh: window.innerHeight };
            });
            if (!m) { bad.push(tip.length + ' chars: never showed'); continue; }
            if (m.crop > 1) bad.push(tip.length + ' chars: cropped ' + m.crop + 'px');
            else if (m.shown !== tip) bad.push(tip.length + ' chars: rendered ' + m.shown.length);
            else if (m.left < 0 || m.right > m.vw) bad.push(tip.length + ' chars: off screen sideways');
            else if (m.top < 0 || m.bottom > m.vh) bad.push(tip.length + ' chars: off screen vertically');
        }
        ok(bad.length === 0, 'every tip renders whole, inside the box and on screen',
            bad.length ? bad.slice(0, 3).join(' / ') : tips.length + ' tips clean');
        ok(errs.length === 0, '[tips] no console errors', errs.slice(0, 2).join(' / ') || 'clean');
        await page.close();
    }

    await browser.close();
    console.log('\n' + (fails ? fails + ' FAILED' : 'all checks passed'));
    process.exit(fails ? 1 : 0);
})();
