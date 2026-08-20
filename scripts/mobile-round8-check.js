// Round 8 of the phone review. Measured on the real pages.
//
//   1. the store dropdown is no longer sheared off by .cc-widget's overflow
//   2. feed pills and the Snooze button came down a size
//   3. no tooltip on a tap
//   4. Tools / Checklist leave the same gap under the nav as a sheet modal
//   5. the Tools search box and every close button came down a size
//   6. byline and "Read full" share one line
//   7. the goal figure says what it is a percentage of
//   8. a card whose destination is cut on mobile is not a button
//   9. SPEEKS Connect is gone from Operations
//
// NODE_PATH must point at the scratchpad's node_modules (puppeteer-core).
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const OUT = process.env.LV_SHOT_DIR || null;

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };

const F = JSON.parse(fs.readFileSync(REPO + '/scripts/lv-month-fixture.json', 'utf8'));
const ORDER = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
F.hub.wkBuy = {}; F.hub.wkSell = {}; F.hub.wkBuyMarginPct = {};
ORDER.forEach((c, i) => {
    const b = [], s = [], m = [];
    for (let d = 1; d <= 31; d++) {
        const sun = [3, 10, 17, 24, 31].includes(d);
        b.push(d <= 16 && !sun ? 2000 + i * 200 : 0);
        s.push(d <= 16 ? 3000 + i * 150 : 0);
        m.push(0.55);
    }
    F.hub.wkBuy[c] = b; F.hub.wkSell[c] = s; F.hub.wkBuyMarginPct[c] = m;
});
const st = (code, i) => ({
    code, netToday: 2000 + i * 500, cogsToday: 900 + i * 200, gpToday: 1100 + i * 300,
    ordersToday: 10 + i, returnsToday: 0, marginToday: 50 + i, aov: 150,
    mtdNet: F.prevs[code].mtdNet, mtdCogs: F.prevs[code].mtdCogs, mtdGp: F.prevs[code].mtdGp,
    mtdOrders: F.prevs[code].mtdOrders, mtdReturns: F.prevs[code].mtdReturns,
    mtdMargin: F.prevs[code].mtdMargin, goal: F.goals[code],
    pctOfGoal: F.prevs[code].pctOfGoal, paceIndex: F.prevs[code].paceIndex,
    prev: F.prevs[code], cmp: F.cmp[code], lastOrderAt: null,
});
const payload = {
    asOfCentral: F.asOfCentral, open: F.open, month: F.month, prev: F.prev,
    cmpThrough: F.cmpThrough, scope: { role: 'district manager', store: 'LEE', district: true },
    district: {
        netToday: 14995.39, cogsToday: 6919.61, gpToday: 8075.78, ordersToday: 79,
        returnsToday: 0, marginToday: 53.86, aov: 189.82, mtdNet: 330887.70,
        mtdGp: 183047.35, mtdReturns: 0, mtdMargin: 55.32,
        goal: F.distGoal, pctOfGoal: 55.13, prev: F.distPrev,
    },
    stores: ORDER.map(st),
};

async function boot(browser, page_, role, width, height) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: height || 850, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 160)));
    await page.evaluateOnNewDocument(r => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Layout Harness');
        sessionStorage.setItem('speeksUserRole', r);
        sessionStorage.setItem('speeksUserStore', 'LEE');
    }, role);
    await page.goto('file:///' + REPO + '/' + page_, { waitUntil: 'networkidle2' }).catch(() => {});
    await page.evaluate(() => {
        const ov = document.getElementById('authOverlay'); if (ov) ov.style.display = 'none';
        document.documentElement.classList.remove('no-scroll');
        document.body.classList.remove('no-scroll', 'preload');
        document.body.classList.add('is-authenticated');
        if (typeof applyRoleBasedUI === 'function') { try { applyRoleBasedUI(); } catch (e) {} }
    });
    await new Promise(r => setTimeout(r, 800));
    page._errs = errs;
    return page;
}

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });

    // ---- 1 + 7: the Live card ------------------------------------------------
    console.log('\n### store picker + goal label @390');
    const page = await boot(browser, 'index.html', 'district manager', 390);
    await page.evaluate((p, h) => { hubDataCache = h; _lvData = p; _lvMode = 'today'; renderLiveDashboard(); }, payload, F.hub);
    await new Promise(r => setTimeout(r, 400));

    const pick = await page.evaluate(() => {
        const btn = document.querySelector('.lv-dist-detail .lv-pickbtn');
        btn.click();
        const wrap = btn.closest('.lv-pickwrap');
        const list = wrap.querySelector('.lv-picklist');
        const lr = list.getBoundingClientRect();
        // Walk the ancestors for anything that clips, and check the list against
        // every clip rect it is inside of. This is the actual bug: .cc-widget is
        // overflow:hidden and the sixth option was sheared off at its edge.
        const clipped = [];
        let el = list.parentElement;
        while (el && el !== document.documentElement) {
            const c = getComputedStyle(el);
            if (c.overflow !== 'visible' || c.overflowX !== 'visible' || c.overflowY !== 'visible') {
                if (c.position !== 'fixed' && getComputedStyle(list).position !== 'fixed') {
                    const r = el.getBoundingClientRect();
                    if (lr.bottom > r.bottom + 1 || lr.right > r.right + 1 || lr.top < r.top - 1) {
                        clipped.push(String(el.className).split(' ').slice(0, 2).join('.'));
                    }
                }
            }
            el = el.parentElement;
        }
        const opts = Array.from(list.querySelectorAll('.lv-pickopt'));
        const last = opts[opts.length - 1].getBoundingClientRect();
        return {
            pos: getComputedStyle(list).position,
            clipped,
            n: opts.length,
            lastText: opts[opts.length - 1].textContent.trim(),
            lastFullyOnScreen: last.bottom <= window.innerHeight + 1 && last.top >= -1,
            listInViewport: lr.bottom <= window.innerHeight + 1,
            leftAligned: Math.abs(lr.left - btn.getBoundingClientRect().left) <= 1,
        };
    });
    ok(pick.pos === 'fixed', 'the list escapes .cc-widget (position: fixed)', pick.pos);
    ok(pick.clipped.length === 0, 'nothing clips it any more', pick.clipped.join(', ') || 'clear');
    ok(pick.lastFullyOnScreen, 'the last option is fully on screen', pick.n + ' options, last is ' + pick.lastText);
    ok(pick.leftAligned, 'and it still hangs off the button');

    const goal = await page.evaluate(() => {
        const g = document.querySelector('.lv-dist-detail .lvc-goal');
        const k = g.querySelector('.lvc-goal-k');
        return { text: g.textContent.trim(), label: k ? k.textContent.trim() : null,
                 oneLine: g.getBoundingClientRect().height < 30 };
    });
    ok(goal.label === '% to Goal', 'the goal figure is labelled', JSON.stringify(goal.text));
    ok(goal.oneLine, '  and still fits the header line');

    // ---- 3: no tooltip on a tap ---------------------------------------------
    console.log('### tooltip on tap');
    const tip = await page.evaluate(async () => {
        const btn = document.getElementById('toolsNavBtn');
        btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await new Promise(r => setTimeout(r, 60));
        const t = document.querySelector('.speeks-tooltip');
        return {
            found: !!t,
            shown: t ? t.classList.contains('show') : null,
            visible: t ? getComputedStyle(t).opacity !== '0' && getComputedStyle(t).display !== 'none' : null,
            coarse: matchMedia('(hover: none), (pointer: coarse)').matches,
        };
    });
    ok(tip.coarse, 'the harness really is a touch device', 'hover:none / pointer:coarse');
    ok(tip.found, 'the tooltip element exists to be suppressed');
    ok(tip.shown === false, 'hovering the Tools button shows no tooltip', 'show class: ' + tip.shown);

    // ---- 2 + 6 + 8: the feed -------------------------------------------------
    console.log('### feed rows');
    const feed = await page.evaluate(() => {
        // Two synthetic rows: one reminder pointing at a cut destination, one
        // announcement long enough to earn a "Read full".
        const f = document.getElementById('samFeed');
        f.innerHTML = '<div class="sam-ann rem"><span class="sam-adot urgent"></span>'
            + '<div class="sam-a-body"><div class="sam-a-top"><span class="sam-a-title">Aging Inventory Replies Overdue</span>'
            + '<span class="sam-r-due sam-due-red">Overdue</span></div>'
            + '<div class="sam-a-snip">The reply deadline has passed on the aging report - get your replies submitted as soon as possible, this line is long enough to need a third row on a phone.</div></div>'
            + '<button class="sam-markread-btn sam-snooze-btn"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>Snooze</button></div>'
            + '<div class="sam-ann" data-hub-target="ann-1" onclick="void 0"><span class="sam-adot"></span>'
            + '<div class="sam-a-body"><div class="sam-a-top"><span class="sam-a-title">Mission Statement</span></div>'
            + '<div class="sam-a-snip">Team, wanted to take a minute and remind everyone of why we do what we do here and how much it matters to every customer who walks in.</div>'
            + '<div class="sam-a-meta">Aug 17 &middot; Paul Kushnir</div></div>'
            + '<button class="sam-markread-btn"><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>Mark read</button></div>';
        _samAddReadFull();
        const px = e => e ? parseFloat(getComputedStyle(e).fontSize) : null;
        const due = document.querySelector('#samFeed .sam-r-due');
        const snz = document.querySelector('#samFeed .sam-snooze-btn');
        const foot = document.querySelector('#samFeed .sam-a-foot');
        const meta = foot && foot.querySelector('.sam-a-meta');
        const rf = foot && foot.querySelector('.sam-readfull');
        const rem = document.querySelector('#samFeed .sam-ann.rem');
        return {
            dueFont: px(due), dueH: due ? Math.round(due.getBoundingClientRect().height) : null,
            snzFont: px(snz), snzH: snz ? Math.round(snz.getBoundingClientRect().height) : null,
            footExists: !!foot,
            // Centres, not tops: the two are baseline-aligned at different font
            // sizes, so their top edges never match even on one line.
            sameRow: (meta && rf) ? (function(){ const a = meta.getBoundingClientRect(), b = rf.getBoundingClientRect();
                return Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 8; })() : false,
            metaLeftOfRf: (meta && rf) ? rf.getBoundingClientRect().left > meta.getBoundingClientRect().right - 1 : false,
            remH: rem ? Math.round(rem.getBoundingClientRect().height) : null,
            remParts: rem ? (function(){ const c = getComputedStyle(rem);
                const parts = ['pad=' + c.paddingTop + '/' + c.paddingBottom];
                rem.querySelectorAll('.sam-a-body, .sam-a-top, .sam-a-snip, .sam-a-title').forEach(e =>
                    parts.push(String(e.className).replace('speeks-action-menu ','').split(' ')[0]
                        + '=' + Math.round(e.getBoundingClientRect().height)));
                return parts.join(' '); })() : '',
            snipClamp: getComputedStyle(document.querySelector('#samFeed .rem .sam-a-snip')).webkitLineClamp,
        };
    });
    ok(feed.dueFont <= 9.5 && feed.dueH <= 20, 'the due pill came down a size', feed.dueFont + 'px text in a ' + feed.dueH + 'px pill');
    ok(feed.snzFont <= 10.5 && feed.snzH <= 20, 'the Snooze button came down a size', feed.snzFont + 'px text in a ' + feed.snzH + 'px button');
    ok(feed.snipClamp === '2', 'reminder snippets clamp to 2 lines on a phone', feed.snipClamp);
    // 114 -> 85. The floor is the title itself: it wraps to two lines at 390px
    // beside a badge and a button, and ellipsising it would cut off 'Overdue'.
    ok(feed.remH <= 86, '  so the overdue card is no longer the tallest row', feed.remH + 'px  (' + feed.remParts + ')');
    ok(feed.footExists, 'byline and Read full share a row');
    ok(feed.sameRow, '  measured on the same line');
    ok(feed.metaLeftOfRf, '  with the byline to the LEFT of the link');

    // Dead destinations. _samDestDead is the thing under test, called with the
    // literal actions the registry actually ships.
    const dead = await page.evaluate(() => ({
        aging:   _samDestDead("closeAgingAlertBubble(); window.location.href='workspace.html#aging'"),
        b2b:     _samDestDead("window.location.href='operations.html#b2b'"),
        margin:  _samDestDead("window.location.href='workspace.html#mreplies'"),
        kpi:     _samDestDead("sessionStorage.setItem('speeksKpiTab','weekly'); window.location.href='workspace.html#kpis'"),
        claims:  _samDestDead("openClaimsModal(); switchClaimsTab('view')"),
        recycle: _samDestDead("openRecycleFocused()"),
        goals:   _samDestDead("openGpGoals()"),
        empty:   _samDestDead(''),
    }));
    ok(dead.aging && dead.b2b && dead.margin && dead.kpi, 'Workspace / Operations cards are inert on mobile',
        'aging ' + dead.aging + ', b2b ' + dead.b2b + ', margin ' + dead.margin + ', kpi ' + dead.kpi);
    ok(dead.claims === true, 'a card opening a CUT tool is inert too', 'claims (tool-claims-store is data-mobile=hide)');
    ok(dead.recycle === false && dead.goals === false, 'cards opening KEPT tools still work',
        'recycle ' + dead.recycle + ', store goals ' + dead.goals);
    ok(dead.empty === false, 'an action-less card is not mistaken for a dead one');

    ok(page._errs.length === 0, 'no page errors', page._errs.join(' | ') || 'none');
    if (OUT) await page.screenshot({ path: path.join(OUT, 'r8-feed.png'), fullPage: true });
    await page.close();

    // ---- 4 + 5: the panels ---------------------------------------------------
    console.log('\n### side panels vs a sheet modal @390x780');
    const p2 = await boot(browser, 'index.html', 'district manager', 390, 780);
    const gaps = await p2.evaluate(() => {
        const navB = Math.round(document.querySelector('.top-nav').getBoundingClientRect().bottom);
        const out = { navBottom: navB };
        ['toolsSidePanel', 'checklistSidePanel'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) { out[id] = null; return; }
            el.classList.add('open');
            out[id] = Math.round(el.getBoundingClientRect().top) - navB;
            el.classList.remove('open');
        });
        // What a sheet modal leaves, for comparison. 92dvh off the bottom.
        out.modal = Math.round(window.innerHeight * 0.08) - navB;
        const close = document.querySelector('.tools-panel-close');
        const cr = close.getBoundingClientRect();
        const search = document.querySelector('.tools-search');
        const sIn = search.querySelector('input');
        return Object.assign(out, {
            closeW: Math.round(cr.width), closeH: Math.round(cr.height),
            searchH: Math.round(search.getBoundingClientRect().height),
            searchInputFont: parseFloat(getComputedStyle(sIn).fontSize),
        });
    });
    ok(gaps.toolsSidePanel >= 8 && gaps.toolsSidePanel <= 14, 'Tools leaves a gap under the nav', gaps.toolsSidePanel + 'px (a sheet modal leaves ~' + gaps.modal + ')');
    ok(gaps.checklistSidePanel === gaps.toolsSidePanel, '  and the Checklist leaves the same one', gaps.checklistSidePanel + 'px');
    ok(gaps.closeW <= 34 && gaps.closeH <= 34 && gaps.closeW === gaps.closeH, 'the close button came down a size and stayed square', gaps.closeW + 'x' + gaps.closeH);
    ok(gaps.searchH <= 46, 'the search box came down a size', gaps.searchH + 'px tall');
    ok(gaps.searchInputFont >= 16, '  but its text stays 16px (or iOS zooms on focus)', gaps.searchInputFont + 'px');
    ok(p2._errs.length === 0, 'no page errors', p2._errs.join(' | ') || 'none');
    if (OUT) {
        await p2.evaluate(() => document.getElementById('toolsSidePanel').classList.add('open'));
        await new Promise(r => setTimeout(r, 350));
        await p2.screenshot({ path: path.join(OUT, 'r8-tools.png') });
    }
    await p2.close();

    // ---- 9: SPEEKS Connect ---------------------------------------------------
    console.log('\n### Operations @390');
    const p3 = await boot(browser, 'operations.html', 'district manager', 390);
    const ops = await p3.evaluate(() => {
        const vis = e => e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0;
        return {
            ebayTab: vis(document.getElementById('ops-tab-ebay')),
            ebayPane: vis(document.getElementById('ops-pane-ebay')),
            anyTab: Array.from(document.querySelectorAll('.ws-subtabs .ws-tab')).filter(vis).map(e => e.textContent.trim()),
            anyPane: Array.from(document.querySelectorAll('.ws-panes .ws-pane')).filter(vis).map(e => e.id),
            note: (document.querySelector('.mobile-only-note') || {}).textContent || '(none)',
            noteShown: vis(document.querySelector('.mobile-only-note')),
        };
    });
    ok(ops.ebayTab === false, 'SPEEKS Connect tab is gone from the phone');
    ok(ops.ebayPane === false, '  and so is its pane', ops.anyPane.join(', ') || 'no pane rendering');
    ok(ops.anyTab.length === 0, '  leaving no Operations tab at all', ops.anyTab.join(', ') || 'none');
    ok(ops.noteShown, '  and a line saying so instead of a blank page', JSON.stringify(ops.note.trim()));
    ok(p3._errs.length === 0, 'no page errors', p3._errs.join(' | ') || 'none');
    await p3.close();

    // ---- desktop is untouched by the tooltip guard --------------------------
    console.log('\n### desktop @1400 - the tooltip still works');
    const p4 = await browser.newPage();
    await p4.setViewport({ width: 1400, height: 900 });   // no isMobile: a real pointer
    const derrs = [];
    p4.on('pageerror', e => derrs.push(String(e).slice(0, 160)));
    await p4.evaluateOnNewDocument(() => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Layout Harness');
        sessionStorage.setItem('speeksUserRole', 'district manager');
        sessionStorage.setItem('speeksUserStore', 'LEE');
    });
    await p4.goto('file:///' + REPO + '/index.html', { waitUntil: 'networkidle2' }).catch(() => {});
    await p4.evaluate(() => {
        const ov = document.getElementById('authOverlay'); if (ov) ov.style.display = 'none';
        document.body.classList.add('is-authenticated');
        document.body.classList.remove('preload', 'no-scroll');
        if (typeof applyRoleBasedUI === 'function') { try { applyRoleBasedUI(); } catch (e) {} }
    });
    await new Promise(r => setTimeout(r, 800));
    const dtip = await p4.evaluate(async () => {
        document.getElementById('toolsNavBtn').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await new Promise(r => setTimeout(r, 60));
        const t = document.querySelector('.speeks-tooltip');
        return { shown: t ? t.classList.contains('show') : null, text: t ? t.textContent.trim() : '' };
    });
    ok(dtip.shown === true, 'the tooltip still fires on a real pointer', JSON.stringify(dtip.text));
    ok(derrs.length === 0, 'no page errors', derrs.join(' | ') || 'none');
    await p4.close();

    await browser.close();
    console.log('\n' + (fails ? fails + ' FAILED' : 'all round-8 assertions verified on the real pages'));
    process.exit(fails ? 1 : 0);
})();
