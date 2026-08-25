// Round 7 of the phone review, measured on the real index.html rather than read
// off the stylesheet — three of the last six rounds' "obviously correct" rules
// turned out to match nothing or to be silently outranked, and only the DOM knows.
//
//   1. the Live card fills the panel instead of floating in a 530px white box
//   2. "Last Change ..." sits on the open/final line, not a row of its own
//   3. the day toggle is smaller and left-aligned with that pill
//   4. no Settings button in the top bar
//   5. no grab handle above a modal title
//   6. Tools and the Checklist hang off the nav instead of covering it
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

// A store-scoped payload wide enough to fill every figure on the card.
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
const payload = role => ({
    asOfCentral: F.asOfCentral, open: F.open, month: F.month, prev: F.prev,
    cmpThrough: F.cmpThrough, scope: { role, store: 'LEE', district: true },
    district: {
        netToday: 14995.39, cogsToday: 6919.61, gpToday: 8075.78, ordersToday: 79,
        returnsToday: 0, marginToday: 53.86, aov: 189.82, mtdNet: 330887.70,
        mtdGp: 183047.35, mtdReturns: 0, mtdMargin: 55.32,
        goal: F.distGoal, pctOfGoal: 55.13, prev: F.distPrev,
    },
    stores: ORDER.map(st),
});

async function boot(browser, role, width) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 850, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 160)));
    await page.evaluateOnNewDocument(r => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Layout Harness');
        sessionStorage.setItem('speeksUserRole', r);
        sessionStorage.setItem('speeksUserStore', 'LEE');
    }, role);
    await page.goto('file:///' + REPO + '/index.html', { waitUntil: 'networkidle2' }).catch(() => {});
    await page.evaluate(() => {
        const ov = document.getElementById('authOverlay'); if (ov) ov.style.display = 'none';
        document.documentElement.classList.remove('no-scroll');
        document.body.classList.remove('no-scroll', 'preload');
        document.body.classList.add('is-authenticated');
        if (typeof applyRoleBasedUI === 'function') { try { applyRoleBasedUI(); } catch (e) {} }
    });
    await new Promise(r => setTimeout(r, 700));
    page._errs = errs;
    return page;
}

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });

    for (const [role, mount] of [['district manager', '.lv-dist-detail'], ['manager', '.lv-detail']]) {
        const page = await boot(browser, role, 390);
        await page.evaluate((p, h) => { hubDataCache = h; _lvData = p; _lvMode = 'prev'; renderLiveDashboard(); },
            payload(role), F.hub);
        await new Promise(r => setTimeout(r, 400));

        console.log('\n### ' + role + ' @390 - Live card');
        const m = await page.evaluate(sel => {
            const box = e => e ? e.getBoundingClientRect() : null;
            const mount = document.querySelector(sel);
            const panel = mount.closest('.cc-widget');
            const card = document.querySelector(sel + ' .lvc');
            const body = mount.closest('.cc-body');
            const cards = document.querySelector(sel + ' .lv-cards');
            const pb = box(panel), cb = box(card), lb = box(cards);
            // Dead space = panel bottom minus the CARD's bottom. Measured off the
            // card and not off the lowest descendant box, because the wrappers'
            // own bottom padding was the dead space — 66px of it — and a box that
            // is nothing but padding still reports a bottom edge down there.
            const lowest = cb ? cb.bottom : pb.bottom;
            return {
                panelH: Math.round(pb.height),
                deadBelow: Math.round(pb.bottom - lowest),
                cardW: cb ? Math.round(cb.width) : 0,
                panelW: Math.round(pb.width),
                bodyPadL: body ? parseFloat(getComputedStyle(body).paddingLeft) : -1,
                cardsPadL: lb ? parseFloat(getComputedStyle(cards).paddingLeft) : -1,
                valSize: card ? parseFloat(getComputedStyle(card.querySelector('.lvc-v')).fontSize) : 0,
                // No value may wrap: a wrapped "$330,887.70" is why this was 15.5px.
                wrapped: Array.from(document.querySelectorAll(sel + ' .lvc-v'))
                    .filter(e => e.getBoundingClientRect().height > parseFloat(getComputedStyle(e).lineHeight) * 1.4)
                    .map(e => e.textContent),
                figs: Array.from(document.querySelectorAll(sel + ' .lvc-k')).map(e => e.textContent),
            };
        }, mount);
        ok(m.deadBelow <= 32, 'panel hugs the card - no held-open white box', m.deadBelow + 'px below the card (panel ' + m.panelH + 'px)');
        ok(m.panelW - m.cardW <= 30, 'card runs out to the panel edge', 'card ' + m.cardW + ' in panel ' + m.panelW);
        ok(m.valSize >= 18, 'figures grew into that width', m.valSize + 'px');
        ok(m.wrapped.length === 0, 'and nothing wrapped onto two lines', m.wrapped.join(' | ') || 'none');
        console.log('       figures: ' + m.figs.join(', '));

        console.log('### ' + role + ' @390 - head');
        const h = await page.evaluate(sel => {
            const head = document.querySelector(sel).closest('.lv-card, .cc-panel').querySelector('.lv-head');
            const r = e => e ? e.getBoundingClientRect() : null;
            const fr = r(head.querySelector('.lv-fresh'));
            const ar = r(head.querySelector('.lv-asof'));
            const mr = r(head.querySelector('.lv-modes'));
            const br = r(head.querySelector('.lv-mode'));
            const asof = head.querySelector('.lv-asof');
            return {
                asofText: asof ? asof.textContent.trim() : '(none)',
                sameRow: fr && ar ? Math.abs(fr.top - ar.top) < 8 : false,
                dx: fr && ar ? Math.round(ar.left - fr.left) : null,
                freshLeft: fr ? Math.round(fr.left) : null,
                modesLeft: mr ? Math.round(mr.left) : null,
                modeH: br ? Math.round(br.height) : null,
                modeFont: br ? parseFloat(getComputedStyle(head.querySelector('.lv-mode')).fontSize) : null,
                headRight: Math.round(head.getBoundingClientRect().right),
                modesRight: mr ? Math.round(mr.right) : null,
                // The store picker sits directly under the toggle, so the two being
                // different heights is a lot of what read as 'massive'.
                pickH: (function(){ var p = document.querySelector(sel + ' .lv-pickbtn');
                    return p ? Math.round(p.getBoundingClientRect().height) : null; })(),
            };
        }, mount);
        ok(h.sameRow, 'the date sits on the open/final line', h.asofText + ' (dx ' + h.dx + ')');
        ok(h.freshLeft === h.modesLeft, 'the toggle is flush left with that pill', 'pill ' + h.freshLeft + ' / toggle ' + h.modesLeft);
        // 44 -> 30. The floor is the tap-target block's blanket min-height:44px on
        // every button, which this rule has to beat explicitly; a bare height never did.
        ok(h.modeH <= 30 && h.modeFont <= 11, 'the toggle came down a size', h.modeH + 'px tall, ' + h.modeFont + 'px text');
        if (h.pickH !== null) ok(h.modeH === h.pickH, '  and matches the store picker under it', h.modeH + ' vs ' + h.pickH);
        ok(h.modesRight < h.headRight, 'and no longer runs the width of the card', 'toggle ends ' + h.modesRight + ' of ' + h.headRight);

        if (OUT) await page.screenshot({ path: path.join(OUT, 'r7-' + role.replace(/ /g, '') + '.png'), fullPage: true });
        ok(page._errs.length === 0, 'no page errors', page._errs.join(' | ') || 'none');
        await page.close();
    }

    // ---- top bar, grab handle and the two side panels -----------------------
    console.log('\n### top bar / modals / side panels @390');
    const page = await boot(browser, 'district manager', 390);

    const nav = await page.evaluate(() => {
        const gear = document.getElementById('notifySettingsBtn');
        return {
            gearShown: gear ? getComputedStyle(gear).display !== 'none' : null,
            shown: Array.from(document.querySelectorAll('.user-profile-nav > *'))
                .filter(e => e.offsetParent !== null && e.getBoundingClientRect().width > 0)
                .map(e => e.getAttribute('data-tip') || e.id || String(e.className).split(' ')[0]),
        };
    });
    ok(nav.gearShown === false, 'Settings is gone from the phone top bar');
    console.log('       still there: ' + nav.shown.join(', '));

    // The handle was a ::before on .modal-header - assert it draws nothing.
    const grab = await page.evaluate(() => {
        const h = document.querySelector('.modal-header');
        if (!h) return null;
        const cs = getComputedStyle(h, '::before');
        return { content: cs.content, w: cs.width, h: cs.height };
    });
    ok(grab && (grab.content === 'none' || grab.content === 'normal'), 'no grab handle above modal titles', grab ? grab.content : '(no .modal-header)');

    for (const [label, id] of [['SPEEKS Tools', 'toolsSidePanel'], ['Checklist', 'checklistSidePanel']]) {
        const r = await page.evaluate(pid => {
            const el = document.getElementById(pid);
            if (!el) return { missing: true };
            el.classList.add('open');
            const b = el.getBoundingClientRect();
            const navB = document.querySelector('.top-nav').getBoundingClientRect();
            const cs = getComputedStyle(el);
            return {
                top: Math.round(b.top), navBottom: Math.round(navB.bottom),
                bottom: Math.round(b.bottom), vh: window.innerHeight,
                radius: cs.borderTopLeftRadius, w: Math.round(b.width),
            };
        }, id);
        if (r.missing) { ok(false, label + ' panel present', '#' + id + ' not in the DOM'); continue; }
        ok(r.top >= r.navBottom - 1, label + ' opens BELOW the nav bar', 'panel top ' + r.top + ', nav bottom ' + r.navBottom);
        ok(r.bottom >= r.vh - 2, '  and still reaches the bottom of the screen', r.bottom + ' of ' + r.vh);
        ok(parseFloat(r.radius) > 0, '  with the rounded sheet top', r.radius);
        ok(r.w >= 380, '  at full width', r.w + 'px');
        await page.evaluate(pid => document.getElementById(pid).classList.remove('open'), id);
    }
    ok(page._errs.length === 0, 'no page errors', page._errs.join(' | ') || 'none');
    if (OUT) await page.screenshot({ path: path.join(OUT, 'r7-nav.png') });
    await page.close();

    // ---- 320px: the head is allowed to wrap, but nothing may overflow --------
    console.log('\n### 320px - the head may wrap, nothing may overflow');
    const narrow = await boot(browser, 'district manager', 320);
    await narrow.evaluate((p, h) => { hubDataCache = h; _lvData = p; _lvMode = 'today'; renderLiveDashboard(); }, payload('district manager'), F.hub);
    await new Promise(r => setTimeout(r, 400));
    const over = await narrow.evaluate(() => {
        const bad = [];
        document.querySelectorAll('.lv-dist-detail *, .lv-head *').forEach(e => {
            if (e.offsetParent === null) return;
            const r = e.getBoundingClientRect();
            if (r.width && r.right > window.innerWidth + 1) bad.push((String(e.className) || e.tagName) + ' -> ' + Math.round(r.right));
        });
        return { bad: bad.slice(0, 5), docW: document.documentElement.scrollWidth };
    });
    ok(over.bad.length === 0, 'nothing spills past 320px', over.bad.join(' | ') || 'clean');
    ok(over.docW <= 320, 'and the page does not scroll sideways', over.docW + 'px');
    ok(narrow._errs.length === 0, 'no page errors', narrow._errs.join(' | ') || 'none');
    await narrow.close();

    await browser.close();
    console.log('\n' + (fails ? fails + ' FAILED' : 'all round-7 assertions verified on the real page'));
    process.exit(fails ? 1 : 0);
})();
