// Round 16 of the phone review.
//
//   1. the Multi-Store Manager's Live Dashboard deck is BAL/MPL/Both and opens on
//      Both — never the five-store district deck a DM gets
//   2. the Listing Goals date is centred in its pill — measured on a REAL render,
//      not on a hand-set textContent (round 15 measured the latter and passed)
//   3. the MSM checklist's add row is the same CONTROL as a single-store
//      manager's — same field chrome, same button, same tab strip
//   4. the employee Listing Goals "i" and the stats page chrome are gone on a phone
//
// NODE_PATH must point at a node_modules with puppeteer-core.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const OUT = process.env.LV_SHOT_DIR || null;
const F = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/lv-month-fixture.json'), 'utf8'));
const ORDER = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
const NAMES = { OVL: 'Overland Park', LEE: 'Lees Summit', WSP: 'Westport', MPL: 'Maplewood', BAL: 'Ballwin' };

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };

const store = (code, i) => ({
    code, name: NAMES[code],
    netToday: 2000 + i * 500, cogsToday: 900 + i * 200, gpToday: 1100 + i * 300,
    ordersToday: 10 + i, returnsToday: 0, marginToday: 50 + i, aov: 150,
    mtdNet: F.prevs[code].mtdNet, mtdCogs: F.prevs[code].mtdCogs, mtdGp: F.prevs[code].mtdGp,
    mtdOrders: F.prevs[code].mtdOrders, mtdReturns: F.prevs[code].mtdReturns,
    mtdMargin: F.prevs[code].mtdMargin, goal: F.goals[code],
    pctOfGoal: F.prevs[code].pctOfGoal, paceIndex: F.prevs[code].paceIndex,
    prev: F.prevs[code], cmp: F.cmp[code], lastOrderAt: null,
});
// The payload every signed-in user gets today: the whole district (see scopeFor
// in shopify-live). Narrowing it to the MSM's pair is a CLIENT decision, which is
// exactly what test 1 is for.
const PAYLOAD = {
    asOfCentral: F.asOfCentral, open: F.open, month: F.month, prev: F.prev,
    cmpThrough: F.cmpThrough,
    scope: { role: 'manager', store: 'BAL', district: true },
    district: {
        netToday: 14995.39, cogsToday: 6919.61, gpToday: 8075.78, ordersToday: 79,
        returnsToday: 0, marginToday: 53.86, aov: 189.82,
        mtdNet: 330887.70, mtdGp: 183047.35, mtdReturns: 0, mtdMargin: 55.32,
        goal: F.distGoal, pctOfGoal: 55.13, prev: F.distPrev,
    },
    stores: ORDER.map(store),
};

// The shape renderDocs() consumes, in roughly the proportions the real sheet has
// — enough categories that the chip rail wrapped to four rows at 390px, which is
// what test 6 is about. Every category's first doc is also pinned, so the
// synthesized Pinned group exists.
const DOC_CATS = [
    ['Store Operations', 14], ['Customer Experience', 8], ['Company Policy', 5],
    ['E-Commerce & Shipping', 5], ['HR & Employee Guidelines', 5],
    ['Tech & Contingency', 2], ['Purchasing & B2B', 1],
];
const DOCS = [];
DOC_CATS.forEach(([cat, n]) => {
    for (let i = 1; i <= n; i++) {
        DOCS.push({
            title: cat.split(' ')[0] + ' Document ' + i,
            desc: 'How we handle ' + cat.toLowerCase() + ', step by step.',
            link: '#', icon: '', category: (i === 1 && n > 4) ? cat + ', pinned' : cat,
        });
    }
});

// Three recycle requests, one carrying a DM note — the paragraph plus a note
// thread in a 360px column is what made the old My Requests table unreadable.
const RECYCLE_ROWS = [
    { id: 'r1', store: 'WSP', sku: 'MO02-4395A-E6', quantity: 1, cost: 120,
      description: "Josiah bought this, it is a fake S25 Ultra, I have educated him on how to spot these things so this shouldn't happen again.",
      created_at: '2026-07-30T12:00:00Z', created_by: 'Eli Kushnir', review_verdict: 'against',
      dm_note: "Let's be very cautious with these things", dm_note_by: 'Ethan Kushnir', dm_note_at: '2026-07-30T13:00:00Z' },
    { id: 'r2', store: 'WSP', sku: 'MO02-3571A-E4', quantity: 2, cost: 40,
      description: 'This is a honeywell barcode scanner that does not power on.',
      created_at: '2026-07-22T12:00:00Z', created_by: 'Eli Kushnir', review_verdict: 'against' },
    { id: 'r3', store: 'WSP', sku: 'MO02-1180B-C2', quantity: 1, cost: 15,
      description: 'Cracked screen, not worth repairing.',
      created_at: '2026-07-14T12:00:00Z', created_by: 'Eli Kushnir' },
];

const boot = async (page, pg, w, sess) => {
    await page.setViewport({ width: w, height: 900, isMobile: w <= 900, hasTouch: w <= 900, deviceScaleFactor: 2 });
    await page.evaluateOnNewDocument((s) => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Layout Harness');
        sessionStorage.setItem('speeksUserPin', '0000');
        Object.keys(s).forEach(k => sessionStorage.setItem(k, s[k]));
    }, sess || {});
    await page.goto('file:///' + REPO + '/' + pg, { waitUntil: 'networkidle2' }).catch(() => {});
    await page.evaluate(() => {
        const o = document.getElementById('authOverlay'); if (o) o.style.display = 'none';
        document.body.classList.add('is-authenticated');
        document.body.classList.remove('preload', 'no-scroll');
        if (typeof applyRoleBasedUI === 'function') { try { applyRoleBasedUI(); } catch (e) {} }
    });
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
    await new Promise(r => setTimeout(r, 700));
};

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });

    // ------------------------------------------- 1. the MSM's live deck
    console.log('\n### the Live Dashboard deck, as a Multi-Store Manager');
    for (const home of ['BAL', 'MPL']) {
        const page = await browser.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
        await boot(page, 'index.html', 390, {
            // The EFFECTIVE role an MSM signs in with is 'manager' — the capability
            // rides on speeksMultiStore, not on the role string (see the login block).
            speeksUserRole: 'manager', speeksUserStore: home,
            speeksMultiStore: 'true',
        });
        const r = await page.evaluate((payload, hub) => {
            hubDataCache = hub; _lvData = payload; _lvMode = 'prev';
            _lvCardPick = null;                       // a fresh open, which is what defaults
            renderLiveDashboard();
            const host = document.querySelector('.lv-detail') || document.body;
            return {
                picks: Array.from(host.querySelectorAll('.lv-pickopt')).map(e => e.textContent.trim()),
                picked: (host.querySelector('.lv-pickcur') || {}).textContent || '',
                cards: Array.from(host.querySelectorAll('.lvc .lvc-h b')).map(e => e.textContent.trim()),
            };
        }, PAYLOAD, F.hub);
        ok(r.picks.join(',') === 'Both,MPL,BAL', 'on ' + home + ': the list offers only their pair + Both',
            '[' + r.picks.join(', ') + ']');
        // Both, not the home store: the pair total is the glance (20 Aug).
        ok(r.picked === 'Both', 'on ' + home + ': it opens on the pair total', r.picked);
        ok(!errs.length, 'on ' + home + ': no page errors', errs[0] || '');
        await page.close();
    }
    // The DM deck must be untouched by the same change.
    {
        const page = await browser.newPage();
        await boot(page, 'index.html', 390, { speeksUserRole: 'district manager', speeksUserStore: 'CORP' });
        const r = await page.evaluate((payload, hub) => {
            hubDataCache = hub; _lvData = payload; _lvMode = 'prev'; _lvCardPick = null;
            renderLiveDashboard();
            const host = document.querySelector('.lv-dist-detail') || document.body;
            return {
                picks: Array.from(host.querySelectorAll('.lv-pickopt')).map(e => e.textContent.trim()),
                picked: (host.querySelector('.lv-pickcur') || {}).textContent || '',
            };
        }, PAYLOAD, F.hub);
        ok(r.picks.length === 6 && r.picked === 'District', 'a DM still gets all five stores + District',
            '[' + r.picks.join(', ') + '] on ' + r.picked);
        await page.close();
    }

    // ------------------------------------- 2. the date pill, really rendered
    console.log('\n### the Listing Goals date pill, on a real render');
    for (const w of [390, 1400]) {
        const page = await browser.newPage();
        await boot(page, 'index.html', w, { speeksUserRole: 'manager', speeksUserStore: 'LEE' });
        const r = await page.evaluate(() => {
            const m = document.getElementById('listingGoalsModal');
            m.classList.add('show'); m.style.display = 'flex';
            // What the widget actually writes: a long day name.
            const d = document.getElementById('goals-date-display');
            d.textContent = 'WEDNESDAY, AUG 19';
            const pill = m.querySelector('.goals-title-wrapper');
            const pr = pill.getBoundingClientRect();
            // The GLYPHS, not the element box: an element box can be centred while
            // the ink is not, and that is the bug being chased.
            const rg = document.createRange();
            rg.selectNodeContents(d);
            const tr = rg.getBoundingClientRect();
            // Every child of the pill, with its box — which is how a hidden-but-
            // still-laid-out sibling gets found rather than guessed at.
            const kids = Array.from(pill.children).map(el => {
                const b = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                return el.className + '|' + Math.round(b.width) + 'x' + Math.round(b.height)
                    + '|' + cs.display + '|ml' + cs.marginLeft + '|mr' + cs.marginRight;
            });
            return {
                left: Math.round((tr.left - pr.left) * 10) / 10,
                right: Math.round((pr.right - tr.right) * 10) / 10,
                pill: Math.round(pr.width), text: Math.round(tr.width), kids,
            };
        });
        ok(Math.abs(r.left - r.right) <= 1.5, '@' + w + ': the date ink sits in the middle of its pill',
            r.left + 'px left, ' + r.right + 'px right (pill ' + r.pill + ', text ' + r.text + ')');
        console.log('     children: ' + r.kids.join('   '));
        await page.close();
    }

    // --------------------------- 3. the MSM checklist against a manager's
    console.log('\n### the checklist add row and tab strip, manager vs MSM');
    const clSizes = {};
    for (const who of ['manager', 'msm']) {
        const page = await browser.newPage();
        await boot(page, 'index.html', 390, who === 'msm'
            ? { speeksUserRole: 'manager', speeksUserStore: 'BAL', speeksMultiStore: 'true' }
            : { speeksUserRole: 'manager', speeksUserStore: 'LEE' });
        const r = await page.evaluate((isMs) => {
            const panel = document.getElementById('checklistSidePanel');
            panel.classList.add('open');
            // Rendered from a fixture, not from the network: the point is geometry.
            if (isMs) {
                checklistDataCacheMS = {
                    BAL: { daily: [{ id: 'a', text: 'eBay Messages', checked: false, isGlobal: true }] },
                    MPL: { daily: [{ id: 'b', text: 'Reprice Products', checked: false, isGlobal: true }] },
                };
                _setMSChecklistChrome(true);
                renderChecklistMS();
            } else {
                checklistDataCache = { daily: [{ id: 'a', text: 'eBay Messages', checked: false, isGlobal: true }] };
                _setMSChecklistChrome(false);
                renderChecklist();
            }
            const box = sel => {
                const el = panel.querySelector(sel);
                if (!el) return null;
                return Math.round(el.getBoundingClientRect().height * 10) / 10;
            };
            const row = isMs ? '.ms-add-row' : '.cl-input-area';
            // The FIELD and the BUTTON are what "looks the same" means — the row
            // around them is a footer in one case and a card's last child in the
            // other, so its own box is allowed to differ.
            const skin = sel => {
                const el = panel.querySelector(sel);
                if (!el) return null;
                const c = getComputedStyle(el);
                return [Math.round(el.getBoundingClientRect().height * 10) / 10,
                    c.backgroundColor, c.borderTopWidth + ' ' + c.borderTopColor,
                    c.borderRadius, c.fontSize, c.padding].join(' | ');
            };
            return {
                tab: box('.notif-tabs .tab-btn'), tabs: box('.notif-tabs'),
                row: box(row),
                input: skin(row + ' input'), add: skin(row + ' .cl-add-btn'),
            };
        }, who === 'msm');
        clSizes[who] = r;
        console.log('  ' + who + ': tab ' + r.tab + ' (strip ' + r.tabs + ')  row ' + r.row);
        console.log('      field ' + r.input);
        console.log('      add   ' + r.add);
        if (OUT) await page.screenshot({ path: path.join(OUT, 'r16-checklist-' + who + '.png') });
        await page.close();
    }
    ok(clSizes.manager.tab === clSizes.msm.tab, 'the tab strip is the same height for both', clSizes.manager.tab + ' vs ' + clSizes.msm.tab);
    // Compared as whole skins — height, fill, border, radius, type size, padding —
    // because "looks similar" is every one of those, not the height alone.
    ok(clSizes.manager.input === clSizes.msm.input, 'the task field is the same control in both');
    ok(clSizes.manager.add === clSizes.msm.add, 'the Add button is the same control in both');

    // ---------------------------------------- 4. the chrome that was cut
    console.log('\n### the "i" buttons and the stats blurb');
    {
        const page = await browser.newPage();
        await boot(page, 'index.html', 390, { speeksUserRole: 'employee', speeksUserStore: 'LEE' });
        const r = await page.evaluate(() => {
            const i = Array.from(document.querySelectorAll('.emp-week-head .goals-info-i'));
            return { n: i.length, shown: i.filter(e => getComputedStyle(e).display !== 'none').length };
        });
        ok(r.shown === 0, 'the employee weekly-goal "i" is hidden on a phone',
            r.n + ' in the DOM, ' + r.shown + ' shown');
        await page.close();
    }
    for (const w of [390, 1400]) {
        const page = await browser.newPage();
        await boot(page, 'stats.html', w, { speeksUserRole: 'manager', speeksUserStore: 'LEE' });
        const r = await page.evaluate(() => {
            const vis = el => !!el && getComputedStyle(el).display !== 'none';
            const eyebrows = Array.from(document.querySelectorAll('.champion-eyebrow .ce-t')).map(e => e.textContent.trim());
            return {
                eyebrows,
                buyerI: vis(document.querySelector('.champion-eyebrow .goals-info-i')),
                blurb: vis(document.querySelector('.page-header p')),
            };
        });
        const phone = w <= 900;
        ok(r.eyebrows.some(t => /^Review Champion$/.test(t)) && !r.eyebrows.some(t => /Google Review/.test(t)),
            '@' + w + ': the card reads "Review Champion"', '[' + r.eyebrows.join(' | ') + ']');
        ok(r.buyerI === !phone, '@' + w + ': the Buyer Champion "i" is ' + (phone ? 'hidden' : 'still there'), String(r.buyerI));
        ok(r.blurb === !phone, '@' + w + ': the page blurb is ' + (phone ? 'hidden' : 'still there'), String(r.blurb));
        await page.close();
    }

    // ------------------------------ 5. the stats header, with no blurb under it
    console.log('\n### the gap the stats blurb left behind');
    for (const w of [390, 1400]) {
        const page = await browser.newPage();
        await boot(page, 'stats.html', w, { speeksUserRole: 'manager', speeksUserStore: 'LEE' });
        const r = await page.evaluate(() => {
            const h2 = document.querySelector('.page-header h2').getBoundingClientRect();
            const sub = document.querySelector('.stats-subnav').getBoundingClientRect();
            return { gap: Math.round(sub.top - h2.bottom), h2: Math.round(h2.top) };
        });
        // 48px on the phone before this, all of it spacing for a paragraph that is
        // curated away. Desktop still shows the blurb and keeps its room.
        ok(w <= 900 ? r.gap <= 22 : r.gap >= 40, '@' + w + ': the title-to-tabs gap is right',
            r.gap + 'px (title at y=' + r.h2 + ')');
        await page.close();
    }

    // ------------------------ 6. Processes & Policies: chips out, accordion in
    console.log('\n### the docs page, chips out and categories collapsible');
    for (const w of [390, 1400]) {
        const page = await browser.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
        await boot(page, 'docs.html', w, { speeksUserRole: 'manager', speeksUserStore: 'LEE' });
        // Seeded, not fetched: over file:// the docs feed never lands and the page
        // would sit on "Syncing Data..." — measuring an empty state, not a layout.
        await page.evaluate((d) => { renderDocs(d); }, DOCS);
        await new Promise(r => setTimeout(r, 250));
        const shown = () => page.evaluate(() => {
            const secs = [...document.querySelectorAll('.category-section')];
            const nm = s => s.querySelector('.cat-name').textContent;
            const vis = s => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none'; };
            return {
                rail: vis('.dp-rail'),
                chev: vis('.category-title .cat-chev'),
                eyebrow: vis('.dp-header .dp-eyebrow'),
                blurb: vis('.dp-header p'),
                grids: secs.filter(s => getComputedStyle(s.querySelector('.docs-grid')).display !== 'none').map(nm),
                total: secs.length,
                gap: Math.round(document.querySelector('.category-title').getBoundingClientRect().top
                    - document.querySelector('.dp-header h2').getBoundingClientRect().bottom),
                docW: document.documentElement.scrollWidth,
            };
        });
        const r = await shown();
        const phone = w <= 900;
        ok(r.rail === !phone, '@' + w + ': the category chips are ' + (phone ? 'gone' : 'still there'), String(r.rail));
        ok(r.chev === phone, '@' + w + ': the chevrons are ' + (phone ? 'there' : 'absent'), String(r.chev));
        ok(r.eyebrow === !phone && r.blurb === !phone,
            '@' + w + ': the eyebrow and blurb are ' + (phone ? 'gone' : 'still there'),
            'eyebrow ' + r.eyebrow + ', blurb ' + r.blurb);
        ok(phone ? r.grids.length === 1 : r.grids.length === r.total,
            '@' + w + ': ' + (phone ? 'exactly one section is open' : 'every section is open'),
            r.grids.length + ' of ' + r.total + ' [' + r.grids.join(', ') + ']');
        if (phone) {
            ok(r.grids[0] === 'Pinned', '@' + w + ': it lands on Pinned', r.grids[0]);
            ok(r.docW <= w, '@' + w + ': no sideways scroll', String(r.docW));
            // Tapping a third bar must SHUT the first — one open at a time.
            await page.evaluate(() => document.querySelectorAll('.category-title')[2].click());
            const after = await shown();
            ok(after.grids.length === 1 && after.grids[0] !== 'Pinned',
                '@' + w + ': tapping another bar closes the one that was open',
                '[' + after.grids.join(', ') + ']');
            // A search must OPEN what it matched — collapsed bars hiding the results
            // you just asked for is not a search.
            await page.evaluate(() => {
                document.getElementById('docSearch').value = 'shipping';
                filterDocs();
            });
            const hits = await shown();
            ok(hits.grids.length >= 1 && hits.grids.every(g => /Shipping/i.test(g)),
                '@' + w + ': a search opens every section it matched', '[' + hits.grids.join(', ') + ']');
        }
        ok(!errs.length, '@' + w + ': no page errors', errs[0] || '');
        if (OUT) await page.screenshot({ path: path.join(OUT, 'r16-docs-' + w + '.png') });
        await page.close();
    }

    // ------------------------------ 7. the pin, the tab label, and the tools
    console.log('\n### the Pinned icon and the bottom tab label');
    for (const w of [390, 1400]) {
        const page = await browser.newPage();
        await boot(page, 'docs.html', w, { speeksUserRole: 'manager', speeksUserStore: 'LEE' });
        await page.evaluate((d) => { renderDocs(d); }, DOCS);
        await new Promise(r => setTimeout(r, 250));
        const r = await page.evaluate(() => {
            const svg = document.querySelector('.category-title .cat-ico svg');
            const cs = svg ? getComputedStyle(svg) : null;
            const tab = document.querySelector('.nav-link[href="docs.html"]');
            return {
                fill: cs && cs.fill, stroke: cs && cs.stroke,
                m: tab && tab.getAttribute('data-m'),
            };
        });
        // fill:none + a stroke is what makes it a line icon. Filled = the black
        // blob it was, because the DOC_ICONS paths default to fill:black.
        ok(r.fill === 'none' && /rgb/.test(r.stroke || ''), '@' + w + ': the pin is a stroked line icon',
            'fill ' + r.fill + ', stroke ' + r.stroke);
        ok(r.m === 'Processes', '@' + w + ': the bottom tab reads Processes', String(r.m));
        await page.close();
    }

    console.log('\n### SPEEKS Tools: the side entrance and the phone sizing');
    for (const w of [390, 1400]) {
        const page = await browser.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
        await boot(page, 'index.html', w, { speeksUserRole: 'manager', speeksUserStore: 'WSP' });
        const tag = await page.evaluate(() => ({
            tagged: document.querySelectorAll('.modal-menu.tool-modal').length,
            heads: document.querySelectorAll('.modal-menu > .modal-header.tool-head').length,
        }));
        ok(tag.tagged === tag.heads && tag.tagged > 20,
            '@' + w + ': every tool-head modal is tagged', tag.tagged + ' of ' + tag.heads);

        // Closed, it must sit a full width off to the RIGHT on a phone — that is
        // the side entrance. On desktop it stays the centred scale-in.
        const closed = await page.evaluate(() =>
            getComputedStyle(document.getElementById('recycleInvModal')).transform);
        const offRight = new RegExp('matrix\\(1, 0, 0, 1, ' + w + ', 0\\)').test(closed);
        ok(w <= 640 ? offRight : !offRight,
            '@' + w + ': a tool modal ' + (w <= 640 ? 'waits off the right edge' : 'keeps the centred entrance'),
            closed);

        // ...and the chrome inside it comes down to phone scale.
        await page.evaluate(() => {
            const m = document.getElementById('recycleInvModal');
            m.classList.add('show'); m.style.display = 'flex';
        });
        await new Promise(r => setTimeout(r, 200));
        const m = await page.evaluate(() => {
            const g = s => {
                const el = document.querySelector(s);
                if (!el) return null;
                const b = el.getBoundingClientRect(), c = getComputedStyle(el);
                return { h: Math.round(b.height), w: Math.round(b.width), fs: parseFloat(c.fontSize) };
            };
            return {
                head: g('#recycleInvModal .tool-head'),
                tab: g('#recycleInvModal .notif-tabs .tab-btn'),
                field: g('#recycleInvSku'),      // a real text field, not the narrow store select
                submit: g('#submitRecycleBtn'),
            };
        });
        // What the phone shrink is measured AGAINST is the blanket 44px tap floor
        // it used to inherit, not the desktop — desktop was already near these
        // numbers. So: exact phone values, and the recorded desktop baseline as a
        // guard that the phone block has not leaked upward.
        const want = w <= 900
            ? { tab: 30, head: 75, field: 38, submit: 38 }
            : { tab: 28, head: 90, field: 40, submit: 37 };
        for (const k of ['tab', 'head', 'field', 'submit']) {
            ok(Math.abs(m[k].h - want[k]) <= 1, '@' + w + ': ' + k + ' is ' + want[k] + 'px', m[k].h + 'px');
        }
        ok(!errs.length, '@' + w + ': no page errors', errs[0] || '');
        await page.close();
    }

    console.log('\n### Recycle: the request list, and Box Order\'s controls');
    for (const w of [390, 1400]) {
        const page = await browser.newPage();
        await boot(page, 'index.html', w, { speeksUserRole: 'manager', speeksUserStore: 'WSP' });
        const r = await page.evaluate((rows) => {
            const m = document.getElementById('recycleInvModal');
            m.classList.add('show'); m.style.display = 'flex';
            switchRecycleTab('view');
            _recycleMine = rows;                      // the cache renderMyRecycleTable() reads
            const sel = document.getElementById('recycle-month-filter');
            if (sel && !sel.options.length) sel.innerHTML = '<option value="2026-07">July 2026</option>';
            renderMyRecycleTable();
            const td = document.querySelector('.recycle-tbl td[data-label="Description"]');
            const first = document.querySelector('.recycle-tbl td');
            return {
                stacked: td ? getComputedStyle(td).display : 'no table',
                rowDisplay: first ? getComputedStyle(first.parentElement).display : '',
                labels: [...document.querySelectorAll('.recycle-tbl tbody tr:first-child td')]
                    .map(e => e.getAttribute('data-label')),
                wide: document.querySelector('#recycleInvModal .manage-content').scrollWidth,
                host: Math.round(document.querySelector('#recycleInvModal .manage-content').clientWidth),
            };
        }, RECYCLE_ROWS);
        const phone = w <= 640;
        ok(phone ? r.stacked === 'block' : r.stacked === 'table-cell',
            '@' + w + ': the request list is ' + (phone ? 'stacked cards' : 'a table'), r.stacked);
        ok(r.labels.join(',') === 'Status,Date,SKU,Description,Qty,Unit Cost,Total Cost,By,',
            '@' + w + ': every cell names its column', '[' + r.labels.join(', ') + ']');
        if (phone) ok(r.wide <= r.host + 1, '@' + w + ': and it does not scroll sideways', r.wide + ' in ' + r.host);
        await page.close();
    }
    {
        const page = await browser.newPage();
        await boot(page, 'index.html', 390, { speeksUserRole: 'manager', speeksUserStore: 'WSP' });
        await page.evaluate(() => { toggleBoxOrder(); });
        await new Promise(r => setTimeout(r, 900));
        await page.evaluate(() => {
            const c = document.querySelector('#boxOrderItemsContainer .box-order-collapsible');
            if (c) c.click();
        });
        await new Promise(r => setTimeout(r, 250));
        const step = await page.evaluate(() => {
            const el = document.querySelector('.box-stepper-btn');
            if (!el) return null;
            const b = el.getBoundingClientRect();
            return { w: Math.round(b.width), h: Math.round(b.height) };
        });
        ok(step && step.w === step.h, 'the stepper is a circle again, not a 28x44 oval',
            step ? step.w + 'x' + step.h : 'missing');
        // The email page: three buttons on ONE row, and no mailto "i".
        const foot = await page.evaluate(() => {
            document.getElementById('boxOrderPage1').style.display = 'none';
            document.getElementById('boxOrderPage2').style.display = '';
            document.getElementById('boxOrderFooter1').style.display = 'none';
            document.getElementById('boxOrderFooter2').style.display = '';
            boxOrderUpdatePreview();
            const f = document.getElementById('boxOrderFooter2');
            const i = f.querySelector('.goals-info-i');
            const btns = [...f.querySelectorAll('button')];
            return {
                rows: new Set(btns.map(b => Math.round(b.getBoundingClientRect().top))).size,
                h: Math.round(f.getBoundingClientRect().height),
                btnH: Math.round(btns[0].getBoundingClientRect().height),
                iShown: !!i && getComputedStyle(i).display !== 'none',
                notes: Math.round(document.getElementById('boxOrderNotes').getBoundingClientRect().height),
            };
        });
        ok(foot.rows === 1, 'Back / Copy / Send Email fit one row', foot.rows + ' row(s), footer ' + foot.h + 'px');
        ok(foot.btnH === 38, 'and they are 38px, not the 44px slab', foot.btnH + 'px');
        ok(!foot.iShown, 'the mailto "i" is gone from the email page', String(foot.iShown));
        ok(foot.notes <= 60, 'the Notes box came down too', foot.notes + 'px');
        await page.close();
    }

    // ------------------- 8. the dropdown that would not close, and the locked one
    console.log('\n### the custom dropdowns');
    for (const w of [1400, 390]) {
        const page = await browser.newPage();
        page.on('dialog', d => d.dismiss().catch(() => {}));
        await boot(page, 'index.html', w, { speeksUserRole: 'district manager', speeksUserStore: 'ALL' });
        await page.evaluate((rows) => {
            const m = document.getElementById('recycleInvModal');
            m.classList.add('show'); m.style.display = 'flex';
            switchRecycleTab('view');
            _recycleMine = rows;
            const sel = document.getElementById('recycle-month-filter');
            if (sel && !sel.options.length) sel.innerHTML = '<option value="2026-07">July 2026</option>';
            renderMyRecycleTable();
        }, RECYCLE_ROWS);
        // Wait for the DROPDOWNS module to enhance the fresh table rather than
        // guessing at a delay: its scan is debounced off a MutationObserver, and at
        // 1400 the first open raced it.
        await page.waitForFunction(
            () => !!document.querySelector('#recycle-table-wrap .dd-host .dd-btn'),
            { timeout: 5000 }).catch(() => {});
        const state = () => page.evaluate(() => ({
            hosts: document.querySelectorAll('.dd-host.open').length,
            lists: document.querySelectorAll('.dd-list.dd-open').length,
        }));
        const openOne = () => page.evaluate(() => {
            const b = document.querySelector('#recycle-table-wrap .dd-host .dd-btn');
            if (b) b.click();
            return !!b;
        });
        const away = () => page.mouse.click(w <= 900 ? 20 : 40, 760);

        ok(await openOne(), '@' + w + ': the Review dropdown opens');
        await new Promise(r => setTimeout(r, 120));
        await away();
        await new Promise(r => setTimeout(r, 180));
        ok((await state()).lists === 0, '@' + w + ': clicking away closes it');

        // THE BUG. The list is re-parented into <body> while open, so a re-render of
        // its container strands it there with no host left for _ddCloseAll to walk.
        // It could then only be dismissed by picking one of its own options, which
        // is exactly how it was reported.
        await openOne();
        await new Promise(r => setTimeout(r, 120));
        await page.evaluate(() => renderMyRecycleTable());
        await new Promise(r => setTimeout(r, 150));
        // Whether the list is stranded at this instant is NOT asserted: the sweep can
        // also fire off an unrelated event first, and pinning the old broken state
        // down would make a future fix at the source read as a regression. What must
        // hold is the outcome — after a re-render under it, nothing is left open once
        // you touch the page again.
        await away();
        await new Promise(r => setTimeout(r, 180));
        const after = await state();
        ok(after.lists === 0 && after.hosts === 0,
            '@' + w + ': a re-render under an open list leaves no orphan behind', JSON.stringify(after));

        // Picking an option must still write through to the native select.
        await openOne();
        await new Promise(r => setTimeout(r, 150));
        const chose = await page.evaluate(() => {
            const o = [...document.querySelectorAll('.dd-list.dd-open .dd-opt')]
                .find(x => /For Store/.test(x.textContent));
            if (!o) return 'no option';
            o.click();
            return document.querySelector('#recycle-table-wrap .dd-host select').value;
        });
        ok(chose === 'for', '@' + w + ': choosing an option still writes to the select', String(chose));

        // The pulsing "new" dot must sit BESIDE the control, not above it — a
        // .dd-host is display:block and pushed the inline dot onto its own line.
        const dot = await page.evaluate(() => {
            const cell = document.querySelector('.recycle-review-cell');
            if (!cell) return null;
            const d = document.createElement('span');
            d.className = 'recycle-new-dot';
            cell.insertBefore(d, cell.firstChild);
            const dr = d.getBoundingClientRect();
            const ctl = cell.querySelector('.dd-host') || cell.querySelector('span:not(.recycle-new-dot)');
            const cr = ctl.getBoundingClientRect();
            return { dTop: Math.round(dr.top), cTop: Math.round(cr.top), sameLine: dr.bottom > cr.top && dr.top < cr.bottom };
        });
        ok(dot && dot.sameLine, '@' + w + ': the pulsing dot sits on the control line',
            dot ? 'dot y=' + dot.dTop + ', control y=' + dot.cTop : 'no cell');
        await page.close();
    }

    console.log('\n### the single-store Store field, and the tool fields font');
    for (const [role, store, what] of [['manager', 'OVL', 'one store'], ['district manager', 'ALL', 'every store']]) {
        const page = await browser.newPage();
        await boot(page, 'index.html', 390, { speeksUserRole: role, speeksUserStore: store });
        await page.evaluate(() => { toggleRecycleInventory(); });
        await new Promise(r => setTimeout(r, 400));
        const r = await page.evaluate(() => {
            const host = document.querySelector('#recycle-store-row .dd-host');
            const chev = host && host.querySelector('.dd-chev');
            const fam = id => {
                const e = document.getElementById(id);
                return e ? getComputedStyle(e).fontFamily.split(',')[0].replace(/"/g, '') : '?';
            };
            return {
                locked: !!(host && host.classList.contains('dd-locked')),
                chev: !!(chev && getComputedStyle(chev).display !== 'none'),
                desc: fam('recycleInvDescription'), sku: fam('recycleInvSku'),
            };
        });
        const one = what === 'one store';
        ok(r.locked === one, what + ': the Store field is ' + (one ? 'locked' : 'a live dropdown'), String(r.locked));
        ok(r.chev === !one, what + ': the chevron is ' + (one ? 'gone' : 'there'), String(r.chev));
        // A <textarea> with no font-family falls back to MONOSPACE and a bare
        // <input> to Arial — both were rendering at 16px beside Inter, which is
        // what "they look massive" actually was.
        ok(r.desc === 'Inter' && r.sku === 'Inter', what + ': the fields are in the house font',
            'description ' + r.desc + ', sku ' + r.sku);
        await page.close();
    }

    console.log('\n### Expense Report on a phone');
    for (const w of [390, 1400]) {
        const page = await browser.newPage();
        await boot(page, 'index.html', w, { speeksUserRole: 'district manager', speeksUserStore: 'ALL' });
        const r = await page.evaluate(() => {
            const m = document.getElementById('expensesModal');
            m.classList.add('show'); m.style.display = 'flex';
            // openExpenses() fetches, and nothing lands over file://. Seed what it
            // would have been handed and render straight.
            _expData = {
                me: 'Ethan Kushnir', isReviewer: true, canEditOthers: true, rate: 0.72,
                months: ['2026-08'], people: ['Ethan Kushnir'],
                categories: [{ name: 'Fuel', active: true }],
                entries: [{ id: 'e1', kind: 'mileage', person: 'Ethan Kushnir', date: '2026-08-04',
                    purpose: 'Store visit', from_loc: 'OVL', to_loc: 'LEE', miles: 24.4,
                    amount: 17.57, month: '2026-08' }],
            };
            _expMonth = '2026-08'; _expPerson = 'Ethan Kushnir';
            renderExpenses();
            const g = s => {
                const el = document.querySelector(s);
                if (!el) return null;
                return { h: Math.round(el.getBoundingClientRect().height),
                         fs: parseFloat(getComputedStyle(el).fontSize) };
            };
            return { fig: g('.exp-cell-v'), tab: g('.exp-tab'), mail: g('.exp-btn-mail'), add: g('.exp-btn-sm') };
        });
        await new Promise(r => setTimeout(r, 200));
        const phone = w <= 900;
        // Desktop values are the recorded baseline: a change there means the phone
        // block has leaked upward.
        // add: 32 since round 17 — the small button came down so MILEAGE RATE, its
        // field, Save and Manage fit one line (asserted there too).
        const want = phone ? { fig: 16, tab: 30, mail: 38, add: 32 }
                           : { fig: 20, tab: 36, mail: 32, add: 32 };
        for (const k of ['fig', 'tab', 'mail', 'add']) {
            const got = r[k] ? (k === 'fig' ? r[k].fs : r[k].h) : -1;
            ok(Math.abs(got - want[k]) <= 1, '@' + w + ': ' + k + ' is ' + want[k], String(got));
        }
        await page.close();
    }

    // ------------- 11. field type size, one dropdown face, the expense edit card
    console.log('\n### tool fields, and the expense edit row');
    for (const w of [390, 1400]) {
        const page = await browser.newPage();
        await boot(page, 'index.html', w, { speeksUserRole: 'district manager', speeksUserStore: 'ALL' });
        const r = await page.evaluate(() => {
            const m = document.getElementById('recycleInvModal');
            m.classList.add('show'); m.style.display = 'flex';
            toggleRecycleInventory();
            const fs = s => {
                const e = document.querySelector(s);
                return e ? parseFloat(getComputedStyle(e).fontSize) : -1;
            };
            const h = s => {
                const e = document.querySelector(s);
                return e ? Math.round(e.getBoundingClientRect().height) : -1;
            };
            return {
                sku: fs('#recycleInvSku'), desc: fs('#recycleInvDescription'),
                disclaimer: fs('#recycleInvModal .box-order-disclaimer'),
                ddH: h('#recycleInvModal .dd-btn'), ddFs: fs('#recycleInvModal .dd-btn'),
            };
        });
        await new Promise(r => setTimeout(r, 200));
        const phone = w <= 900;
        // Asked for against the red disclaimer under the form: close to it, a step
        // bigger. 12.5 against 10.5 is that step. Desktop keeps its own 14.
        ok(r.sku === (phone ? 12.5 : 14) && r.desc === r.sku,
            '@' + w + ': the recycle fields are ' + (phone ? '12.5px' : '14px'),
            'sku ' + r.sku + ', description ' + r.desc + ', disclaimer ' + r.disclaimer);
        if (phone) ok(r.sku > r.disclaimer, '@' + w + ': ...and a step above the red disclaimer',
            r.sku + ' vs ' + r.disclaimer);
        // One dropdown face across the tools, whatever class each select carried.
        ok(phone ? r.ddH === 34 : r.ddH > 34, '@' + w + ': the tool dropdown face is ' + (phone ? '34px' : 'full size'),
            r.ddH + 'px @' + r.ddFs);
        await page.close();
    }
    {
        const page = await browser.newPage();
        await boot(page, 'index.html', 390, { speeksUserRole: 'district manager', speeksUserStore: 'ALL' });
        const r = await page.evaluate(() => {
            const m = document.getElementById('expensesModal');
            m.classList.add('show'); m.style.display = 'flex';
            _expData = { me: 'Ethan Kushnir', isReviewer: true, canEditOthers: true, rate: 0.72,
                months: ['2026-08'], people: ['Ethan Kushnir'], categories: [{ name: 'Fuel', active: true }],
                entries: [
                    { id: 'e1', kind: 'mileage', person: 'Ethan Kushnir', entry_date: '2026-08-04',
                      description: 'Store visit', from_loc: 'OVL', to_loc: 'LEE', miles: 24.4, rate: 0.72, amount: 17.57, month: '2026-08' },
                    { id: 'e2', kind: 'mileage', person: 'Ethan Kushnir', entry_date: '2026-08-11',
                      description: 'Bank run', from_loc: 'WSP', to_loc: 'OVL', miles: 12.1, rate: 0.72, amount: 8.71, month: '2026-08' }] };
            _expMonth = '2026-08'; _expPerson = 'Ethan Kushnir'; _expTab = 'mileage';
            renderExpenses();
            expStartEdit('e1');
            const wrap = document.querySelector('.exp-table-wrap');
            const tds = [...document.querySelectorAll('tr.exp-editing td')];
            const ins = [...document.querySelectorAll('tr.exp-editing .exp-input')];
            return {
                labels: tds.map(t => t.getAttribute('data-label')).filter(Boolean),
                widths: [...new Set(ins.map(i => Math.round(i.getBoundingClientRect().width)))],
                others: [...document.querySelectorAll('.exp-table tbody tr:not(.exp-editing)')]
                    .filter(t => getComputedStyle(t).display !== 'none').length,
                scroll: wrap.scrollWidth, host: Math.round(wrap.clientWidth),
            };
        });
        await new Promise(r => setTimeout(r, 200));
        // Eight fields across a 560px table on a 390px screen was 70px each.
        ok(r.labels.join(',') === 'Date,Purpose,From,To,Miles,Rate,Amount',
            'the edit card labels every field', '[' + r.labels.join(', ') + ']');
        ok(r.widths.length === 1 && r.widths[0] > 300,
            'and every input is full width', r.widths.join('/') + 'px');
        ok(r.others === 0, 'the other rows step aside while one is being edited', String(r.others));
        ok(r.scroll <= r.host + 1, 'and nothing scrolls sideways', r.scroll + ' in ' + r.host);
        await page.close();
    }

    // ------------------------------------------ 12. the announcement composer
    console.log('\n### the announcement composer');
    for (const w of [390, 1400]) {
        const page = await browser.newPage();
        await boot(page, 'index.html', w, { speeksUserRole: 'district manager', speeksUserStore: 'ALL' });
        const r = await page.evaluate(() => {
            const m = document.getElementById('manageAnnouncementsDropdown');
            m.classList.add('show'); m.style.display = 'flex';
            const box = s => {
                const e = document.querySelector(s);
                if (!e) return null;
                const b = e.getBoundingClientRect();
                return { w: Math.round(b.width), x: Math.round(b.left) };
            };
            const lab = document.querySelector('#manageAnnouncementsDropdown .checkbox-label');
            const cs = getComputedStyle(lab);
            const zone = document.querySelector('#manageAnnouncementsDropdown .ann-doc-dropzone');
            return {
                b: box('#btn-fmt-bold'), i: box('#btn-fmt-italic'), u: box('#btn-fmt-underline'),
                lines: Math.round(lab.getBoundingClientRect().height / parseFloat(cs.lineHeight)),
                fs: parseFloat(cs.fontSize),
                attach: zone ? getComputedStyle(zone.parentElement).display !== 'none' : null,
            };
        });
        await new Promise(r => setTimeout(r, 150));
        const phone = w <= 900;
        // Sized by their own glyph before this: a B is wider than an I, so three
        // buttons doing the same kind of thing were three different widths.
        const same = r.b.w === r.i.w && r.i.w === r.u.w;
        ok(phone ? same : true, '@' + w + ': B / I / U are the same width',
            [r.b.w, r.i.w, r.u.w].join(' / '));
        if (phone) {
            const g1 = r.i.x - (r.b.x + r.b.w), g2 = r.u.x - (r.i.x + r.i.w);
            ok(g1 === g2, '@' + w + ': ...and evenly spaced', g1 + 'px / ' + g2 + 'px');
        }
        ok(r.lines === 1, '@' + w + ': the High Priority label fits one line',
            r.lines + ' line(s) at ' + r.fs + 'px');
        // Only index.html carries the attach block at all; on the other four the
        // composer has never had one.
        if (r.attach !== null) {
            ok(r.attach === !phone, '@' + w + ': the attach-document block is ' + (phone ? 'gone' : 'there'),
                String(r.attach));
        }
        await page.close();
    }

    // ------------- 13. the expense controls row, and the Email Recipients tool
    console.log('\n### the expense controls row');
    for (const w of [390, 1400]) {
        const page = await browser.newPage();
        // A MANAGER, so the mileage rate is the read-only .exp-ctl-ro — a bare line
        // of text beside a 34px dropdown, which is what bottom-alignment exposed.
        await boot(page, 'index.html', w, { speeksUserRole: 'manager', speeksUserStore: 'OVL' });
        await page.evaluate(() => {
            const m = document.getElementById('expensesModal');
            m.classList.add('show'); m.style.display = 'flex';
            _expData = { me: 'Ethan Kushnir', isReviewer: false, canEditOthers: false, rate: 0.72,
                months: ['2026-07'], people: [], categories: [], entries: [] };
            _expMonth = '2026-07'; _expPerson = 'Ethan Kushnir'; _expTab = 'mileage';
            renderExpenses();
        });
        // The face is drawn by the DROPDOWNS module off a debounced scan, so wait
        // for it rather than measuring the native control it replaces.
        await page.waitForFunction(() => !!document.querySelector('.exp-controls .dd-btn'),
            { timeout: 5000 }).catch(() => {});
        const r = await page.evaluate(() => {
            const mid = e => { const b = e.getBoundingClientRect(); return Math.round(b.top + b.height / 2); };
            const month = document.querySelector('.exp-ctl');
            const rate = document.querySelector('.exp-ctl-ro');
            const dd = document.querySelector('.exp-controls .dd-btn');
            return {
                off: (month && rate) ? Math.abs(mid(month) - mid(rate)) : -1,
                ddH: dd ? Math.round(dd.getBoundingClientRect().height) : -1,
            };
        });
        ok(r.off === 0, '@' + w + ': Month and Mileage rate share a centre line', r.off + 'px apart');
        ok(r.ddH === 34, '@' + w + ': and the month face is the standard 34px', r.ddH + 'px');
        await page.close();
    }

    console.log('\n### Email Recipients');
    for (const w of [390, 1400]) {
        const page = await browser.newPage();
        await boot(page, 'index.html', w, { speeksUserRole: 'district manager', speeksUserStore: 'ALL' });
        const r = await page.evaluate(() => {
            const m = document.getElementById('emailRecipientsModal');
            m.classList.add('show'); m.style.display = 'flex';
            _emailLists = {
                weekly_leadership: ['ethan.kushnir@paymore.com', 'paul.kushnir@paymore.com'],
                weekly_store_OVL: ['ovl.manager@paymore.com'],
            };
            _erOpen = (EMAIL_LIST_GROUPS[0] || {}).title;
            renderEmailRecipients();
            const g = s => {
                const e = document.querySelector(s);
                if (!e) return null;
                const b = e.getBoundingClientRect();
                return { w: Math.round(b.width), h: Math.round(b.height),
                         fs: parseFloat(getComputedStyle(e).fontSize) };
            };
            return {
                chips: document.querySelectorAll('.er-chip').length,
                inline: document.querySelectorAll('#emailRecipientsBody [style]').length,
                chip: g('.er-chip'), x: g('.er-chip-x'), input: g('.er-add-input'), btn: g('.er-add-btn'),
                docW: document.documentElement.scrollWidth,
            };
        });
        await new Promise(r => setTimeout(r, 150));
        const phone = w <= 900;
        ok(r.chips === 3, '@' + w + ': the fixture rendered its pills', String(r.chips));
        // The whole point of the class move: nothing in here is styled inline any
        // more, so the mobile layer can reach it at all.
        ok(r.inline === 0, '@' + w + ': no inline styles left in the list', r.inline + ' found');
        ok(r.chip.fs === (phone ? 10.5 : 12), '@' + w + ': the address pills are ' + (phone ? '10.5px' : '12px'),
            r.chip.fs + 'px');
        // width:18 against the blanket 44px tap floor is what made the X an oval.
        ok(r.x.w === r.x.h, '@' + w + ': the remove button is round, not an oval',
            r.x.w + 'x' + r.x.h);
        ok(r.input.h === (phone ? 32 : 41), '@' + w + ': the add field is ' + (phone ? '32px' : 'full size'), r.input.h + 'px');
        ok(r.btn.h === (phone ? 32 : 41), '@' + w + ': the Add button matches it', r.btn.h + 'px');
        if (phone) ok(r.docW <= w, '@' + w + ': no sideways scroll', String(r.docW));
        await page.close();
    }

    await browser.close();
    console.log('\n' + (fails ? fails + ' FAILED' : 'all green'));
    process.exit(fails ? 1 : 0);
})();
