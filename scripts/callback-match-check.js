// Call Back × Shopify matching — does the front end actually work?
//
// Not a layout check. This drives the real Operations tab against the LIVE edge
// functions and asserts the things that would be silently wrong:
//
//   1. the quick-add gets its Category vocabulary, and Type stays disabled
//      until a category is chosen (choosing one populates it in place)
//   2. the green "You Have It" row goes to the store that HOLDS the stock —
//      checked at WSP, which holds the Anker match for its own customer, and
//      at LEE, which holds five PS5s for its own PS5 want
//   3. a store that holds nothing sees the neutral "N Has It" chip instead
//   4. expanding a row renders the match panel, and a Listing link is offered
//      ONLY for a unit that is genuinely published (114 in-stock ones are not)
//   5. "That's It" / "Not It" appear for a manager of the holding store and for
//      nobody else
//   6. the feed card lights for the holding store and stays dark for a DM
//   7. no console errors anywhere in the above
//
// NODE_PATH must point at a node_modules with puppeteer-core.
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const OUT = process.env.LV_SHOT_DIR || null;

let fails = 0;
const IGNORE = /calendar.google.com|ebay-channel/;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };

async function openOps(browser, who) {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e.message || e)));
    // Two 401s on Operations have nothing to do with Call Backs and always fire
    // here: the Google Calendar embed (no Google session in headless) and
    // ebay-channel, which correctly refuses the harness's fake PIN.
    page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(((m.location() || {}).url || '') + ' ' + m.text())) errs.push(m.text()); });
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
    await page.waitForFunction(() => !!document.querySelector('.cb-quickadd, .cb-empty'), { timeout: 25000 });
    await new Promise(r => setTimeout(r, 1200));
    return { page, errs };
}

// Read one row's state back out of the DOM by the item text it shows.
const rowProbe = item => {
    const rows = Array.from(document.querySelectorAll('tr.cb-row'));
    const tr = rows.find(r => (r.querySelector('.cb-item-text')?.textContent || '').trim().startsWith(item));
    if (!tr) return null;
    return {
        green: tr.classList.contains('cb-row-hasit'),
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
        // The pane opens on "My Store" for a store role, which shows WSP's own
        // rows — including the Anker one. Widen to All Stores for the rest.
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

        // Expand it: the panel, the "filed under Other" admission, and the
        // absence of a Listing link for an unpublished unit.
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
                links: p.querySelectorAll('a.cb-m-btn').length,
                yes: Array.from(p.querySelectorAll('.cb-m-btn')).map(b => b.textContent.trim()),
            };
        }, anker.id);
        ok(!!panel, 'expanding the row renders the match panel');
        ok(panel && /You Have This/i.test(panel.heads[0] || ''), 'ours is under its own heading', panel && panel.heads.join(' | '));
        ok(panel && panel.store === 'WSP', 'the holding store is stamped on the match', panel && panel.store);
        ok(panel && /filed under Other/i.test(panel.meta || ''), 'says the unit is filed under Other', panel && panel.meta);
        ok(panel && panel.links === 0, 'no Listing link for an unpublished unit', 'links=' + (panel && panel.links));
        ok(panel && panel.yes.includes("That's It") && panel.yes.includes('Not It'),
            'the holding store\'s manager is offered both answers', panel && JSON.stringify(panel.yes));

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

        const link = await page.evaluate(id => {
            cbToggleRow(id);
            const a = document.querySelector('tr.cb-row-detail a.cb-m-btn');
            return a ? a.getAttribute('href') : null;
        }, ps5.id);
        ok(!!link && /^https:\/\/paymore-[a-z-]+\.myshopify\.com\/products\//.test(link),
            'a published unit offers a real storefront link', link || 'none');

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
        const iph = await page.evaluate(rowProbe, 'iPhone 15');
        ok(!!iph && !iph.green, 'the iPhone 15 want is NOT green at OVL');
        ok(!!iph && iph.tags.some(t => /LEE Has It/i.test(t)), 'it says which store does', iph && JSON.stringify(iph.tags));

        const btns = await page.evaluate(id => {
            cbToggleRow(id);
            const p = document.querySelector('tr.cb-row-detail .cb-match-panel');
            return p ? Array.from(p.querySelectorAll('.cb-m-btn')).map(b => b.textContent.trim()) : null;
        }, n64.id);
        ok(btns && !btns.includes("That's It"), 'an employee is not offered That\'s It', JSON.stringify(btns));

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

    await browser.close();
    console.log('\n' + (fails ? fails + ' FAILED' : 'all checks passed'));
    process.exit(fails ? 1 : 0);
})();
