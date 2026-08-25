// Round 9 of the phone review.
//
//   1. the card's "% to Goal" is the SAME number the desktop table shows
//   2. switching stores moves nothing on the page
//   3. one size for every close button
//   4. the Tools search box is smaller again (and still 16px inside)
//   5. the Checklist tab strip and its footer came down a size
//   6. the Listing Goals modal is sized for a phone
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
        // WSP buys nothing, so its card has one figure fewer than the others —
        // the ragged case that made the card change height between stores.
        b.push(c === 'WSP' ? 0 : (d <= 16 && !sun ? 2000 + i * 200 : 0));
        s.push(d <= 16 ? 3000 + i * 150 : 0);
        m.push(0.55);
    }
    F.hub.wkBuy[c] = b; F.hub.wkSell[c] = s; F.hub.wkBuyMarginPct[c] = m;
});
const st = (code, i) => {
    const row = {
        code, netToday: 2000 + i * 500, cogsToday: 900 + i * 200, gpToday: 1100 + i * 300,
        ordersToday: 10 + i, returnsToday: 0, marginToday: 50 + i, aov: 150,
        mtdNet: F.prevs[code].mtdNet, mtdCogs: F.prevs[code].mtdCogs, mtdGp: F.prevs[code].mtdGp,
        mtdOrders: F.prevs[code].mtdOrders, mtdReturns: F.prevs[code].mtdReturns,
        mtdMargin: F.prevs[code].mtdMargin, goal: F.goals[code],
        pctOfGoal: F.prevs[code].pctOfGoal, paceIndex: F.prevs[code].paceIndex,
        prev: F.prevs[code], cmp: F.cmp[code], lastOrderAt: null,
    };
    // OVL has no goal at all: the card that used to grow a "no goal set" row.
    if (code === 'OVL') {
        row.goal = 0; row.pctOfGoal = null; row.paceIndex = null;
        row.prev = Object.assign({}, row.prev, { goal: 0, pctOfGoal: null, paceIndex: null });
    }
    return row;
};
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

async function boot(browser, width, height, role) {
    const page = await browser.newPage();
    const mobile = width <= 900;
    await page.setViewport({ width, height: height || 850, deviceScaleFactor: 2,
        isMobile: mobile, hasTouch: mobile });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 160)));
    await page.evaluateOnNewDocument(r => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Layout Harness');
        sessionStorage.setItem('speeksUserRole', r);
        sessionStorage.setItem('speeksUserStore', 'LEE');
    }, role || 'district manager');
    await page.goto('file:///' + REPO + '/index.html', { waitUntil: 'networkidle2' }).catch(() => {});
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

// The roster markup renderManagerGoals() emits, so the modal can be measured
// without a backend. Kept in step with speeks.js by shape, not by import.
const ROSTER = ['Dan Ohanesian', 'Kaden Lamothe', 'Nathan Zuklin'].map((n, i) => `
    <div class="goals-mgr-row">
        <div class="goals-mgr-emp">
            <span class="goals-roster-name">${n}</span>
            <div class="goals-edit-roles">${['B1','B2','L1','L2','L3','L4'].map(r =>
                `<button type="button" class="role-dot ${r === 'B2' && i === 0 ? 'active' : ''}" data-role="${r}">${r}</button>`).join('')}
                <button type="button" class="role-dot role-off" data-role="OFF">Off</button></div>
        </div>
        <div class="goal-auto-display goal-auto-set">6</div>
        <div class="goals-mgr-week">24</div>
    </div>`).join('');
const LEVELUP = `<div class="lu-head"><span class="lu-title">Last 4 Weeks</span></div>
    <div class="lu-weeks">${[203, 49, 78, 132].map(v =>
        `<div class="lu-week red"><span class="lu-week-num">${v}</span></div>`).join('')}</div>`;

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });

    // ---- 1: the card figure agrees with the table ---------------------------
    console.log('\n### "% to Goal" against the desktop table @1400');
    const wide = await boot(browser, 1400, 900);
    for (const mode of ['today', 'prev', 'mtd']) {
        const r = await wide.evaluate((p, h, m) => {
            hubDataCache = h; _lvData = p; _lvMode = m;
            renderLiveDashboard();
            const tbl = document.querySelector('.lv-dist-detail .lv-tbl');
            const heads = Array.from(tbl.querySelectorAll('thead th')).map(e => e.textContent.trim().toLowerCase());
            const gi = heads.indexOf('% to goal');
            const table = {};
            tbl.querySelectorAll('tbody tr, tfoot tr').forEach(tr => {
                const tds = tr.querySelectorAll('td');
                if (!tds.length) return;
                table[tds[0].textContent.trim().replace(/\s.*$/, '')] = tds[gi] ? tds[gi].textContent.trim() : '?';
            });
            const cards = {};
            Array.from(document.querySelectorAll('.lv-dist-detail .lv-pickopt'))
                .map(e => e.textContent.trim())
                .forEach(k => {
                    setLiveCard(k === 'District' ? '_roll' : k);
                    const g = document.querySelector('.lv-dist-detail .lvc-goal');
                    cards[k] = g ? g.textContent.replace('% to Goal', '').trim() : '(none)';
                });
            setLiveCard('_roll');
            return { table, cards };
        }, payload, F.hub, mode);
        const bad = Object.keys(r.cards).filter(k => r.table[k] !== undefined && r.table[k] !== r.cards[k]);
        // OVL has no goal in this fixture: the table prints an em dash, the card
        // says "No Goal". Different words for the same fact, so it is excluded.
        const real = bad.filter(k => !(r.table[k] === '—' && r.cards[k] === 'No Goal'));
        ok(real.length === 0, mode + ': every card matches its table row',
            real.length ? real.map(k => k + ' table=' + r.table[k] + ' card=' + r.cards[k]).join(', ')
                        : Object.keys(r.cards).map(k => k + ' ' + r.cards[k]).join('  '));
    }
    ok(wide._errs.length === 0, 'no page errors', wide._errs.join(' | ') || 'none');
    await wide.close();

    // ---- 2: switching a store moves nothing ---------------------------------
    console.log('\n### switching stores @390');
    const page = await boot(browser, 390);
    await page.evaluate((p, h) => { hubDataCache = h; _lvData = p; _lvMode = 'prev'; renderLiveDashboard(); }, payload, F.hub);
    await new Promise(r => setTimeout(r, 400));
    const sw = await page.evaluate(() => {
        const keys = Array.from(document.querySelectorAll('.lv-dist-detail .lv-pickopt')).map(e => e.textContent.trim());
        const shot = () => {
            const g = sel => { const e = document.querySelector(sel);
                if (!e) return null; const r = e.getBoundingClientRect();
                return { top: Math.round(r.top), h: Math.round(r.height) }; };
            return {
                head: g('#dc-panel-live .lv-head'),
                modes: g('#dc-panel-live .lv-modes'),
                pick: g('.lv-dist-detail .lv-pickbtn'),
                card: g('.lv-dist-detail .lvc'),
                figs: document.querySelectorAll('.lv-dist-detail .lvc-f').length,
                goal: (document.querySelector('.lv-dist-detail .lvc-goal') || {}).textContent || '',
            };
        };
        const rows = keys.map(k => { setLiveCard(k === 'District' ? '_roll' : k); return { k, s: shot() }; });
        return rows;
    });
    const base = sw[0].s;
    const moved = sw.filter(r => r.s.head.top !== base.head.top || r.s.head.h !== base.head.h
        || r.s.pick.top !== base.pick.top || r.s.card.top !== base.card.top);
    const grew = sw.filter(r => r.s.card.h !== base.card.h);
    sw.forEach(r => console.log('       ' + r.k.padEnd(9) + ' head=' + r.s.head.top + '/' + r.s.head.h
        + ' pick=' + r.s.pick.top + ' cardTop=' + r.s.card.top + ' cardH=' + r.s.card.h
        + ' figs=' + r.s.figs + ' ' + JSON.stringify(r.s.goal)));
    ok(moved.length === 0, 'the head, the picker and the card stay put', moved.map(r => r.k).join(', ') || 'nothing moved');
    ok(grew.length === 0, 'and the card is the same height for every store', grew.map(r => r.k + '=' + r.s.card.h).join(', ') || 'all ' + base.card.h + 'px');
    // The whole point of the partial re-render: the day toggle must not be rebuilt.
    const kept = await page.evaluate(() => {
        window.__zb = document.querySelectorAll('.lv-cardzone').length;
        const before = document.querySelector('#dc-panel-live .lv-modes');
        before.dataset.harnessMark = '1';
        setLiveCard('LEE');
        const after = document.querySelector('#dc-panel-live .lv-modes');
        return { same: after === before, marked: after.dataset.harnessMark === '1',
                 zone: document.querySelectorAll('.lv-cardzone').length,
                 zoneBefore: window.__zb };
    });
    ok(kept.same && kept.marked, 'switching does not rebuild the day toggle', 'same node: ' + kept.same);
    // A DM page carries both mounts - the district card and the (hidden) store
    // Command Center - so two zones is right. What must not change is the count.
    ok(kept.zone === kept.zoneBefore, '  and the zone is replaced, not duplicated', kept.zoneBefore + ' -> ' + kept.zone);

    // ---- 3 + 4 + 5: chrome ---------------------------------------------------
    console.log('\n### close buttons / search / checklist @390');
    const chrome = await page.evaluate(() => {
        const box = e => { if (!e) return null; const r = e.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height) }; };
        document.getElementById('toolsSidePanel').classList.add('open');
        document.getElementById('checklistSidePanel').classList.add('open');
        const idea = document.getElementById('ideaModal') || document.querySelector('.modal-menu');
        if (idea) { idea.classList.add('show'); idea.style.display = 'flex'; }
        const closes = [
            ['tools', document.querySelector('.tools-side-panel .tools-panel-close')],
            ['checklist', document.querySelector('#checklistSidePanel .cl-close')],
            ['modal', idea ? idea.querySelector('.modal-close-btn') : null],
        ].filter(p => p[1]).map(p => [p[0], box(p[1])]);
        const search = document.querySelector('.tools-search');
        const sIn = search.querySelector('input');
        const tabs = Array.from(document.querySelectorAll('#checklistSidePanel .notif-tabs .tab-btn'))
            .filter(e => getComputedStyle(e).display !== 'none');
        const clearBtn = document.querySelector('#checklistSidePanel .cl-clear-btn');
        const clInput = document.querySelector('#checklistSidePanel .cl-input-area input');
        const addBtn = document.querySelector('#checklistSidePanel .cl-add-btn');
        const r = {
            closes,
            searchH: box(search).h,
            searchFont: parseFloat(getComputedStyle(sIn).fontSize),
            tabH: tabs.length ? box(tabs[0]).h : null,
            tabFont: tabs.length ? parseFloat(getComputedStyle(tabs[0]).fontSize) : null,
            tabsAllSame: tabs.every(t => box(t).h === box(tabs[0]).h),
            clearH: box(clearBtn) ? box(clearBtn).h : null,
            inputH: box(clInput) ? box(clInput).h : null,
            addH: box(addBtn) ? box(addBtn).h : null,
            // #dc-panel-live, not the first .lv-mode on the page: a DM also has a
            // hidden store Command Center whose toggle measures zero.
            modeH: Math.round(document.querySelector('#dc-panel-live .lv-mode').getBoundingClientRect().height),
        };
        document.getElementById('toolsSidePanel').classList.remove('open');
        document.getElementById('checklistSidePanel').classList.remove('open');
        if (idea) { idea.classList.remove('show'); idea.style.display = ''; }
        return r;
    });
    const sizes = chrome.closes.map(c => c[0] + ' ' + c[1].w + 'x' + c[1].h);
    const allSame = chrome.closes.every(c => c[1].w === chrome.closes[0][1].w && c[1].h === chrome.closes[0][1].h);
    ok(allSame, 'every close button is the same size', sizes.join('  |  '));
    ok(chrome.closes[0][1].w <= 30, '  and down a step again', chrome.closes[0][1].w + 'px');
    ok(chrome.searchH <= 36, 'the Tools search box came down again', chrome.searchH + 'px tall');
    ok(chrome.searchFont >= 16, '  and its text is still 16px', chrome.searchFont + 'px');
    ok(chrome.tabH <= 30 && chrome.tabsAllSame, 'the Checklist tab strip is smaller and even', chrome.tabH + 'px x' + chrome.closes.length);
    ok(chrome.tabH === chrome.modeH, '  and matches the Live Dashboard day toggle', chrome.tabH + ' vs ' + chrome.modeH);
    ok(chrome.clearH <= 30, 'Reset came down a size', chrome.clearH + 'px');
    ok(chrome.inputH <= 36 && chrome.addH <= 36, '  and so did the personal-task row', 'input ' + chrome.inputH + ', Add ' + chrome.addH);

    ok(page._errs.length === 0, 'no page errors', page._errs.join(' | ') || 'none');
    await page.close();

    // ---- 6: Listing Goals -----------------------------------------------------
    // As a MANAGER. The card carries role-manager / role-owner-manager, so on a
    // DM page applyRoleBasedUI hides it and every height measures 0 — which every
    // "is it smaller now" assertion passes without noticing.
    console.log('\n### Listing Goals @390 (manager)');
    const mgr = await boot(browser, 390, 850, 'manager');
    const lg = await mgr.evaluate((roster, levelup) => {
        const m = document.getElementById('listingGoalsModal');
        m.classList.add('show');
        m.style.display = 'flex';
        document.getElementById('goals-manager-body').innerHTML = roster;
        document.getElementById('goals-levelup').innerHTML = levelup;
        document.getElementById('goals-store-target').textContent = 'Goal: 151 Listings';
        document.getElementById('goals-date-display').textContent = 'Wednesday, Aug 19';
        const f = e => e ? parseFloat(getComputedStyle(e).fontSize) : null;
        const h = e => e ? Math.round(e.getBoundingClientRect().height) : null;
        const q = sel => m.querySelector(sel);
        const r = {
            target: f(q('#goals-store-target')),
            date: f(q('#goals-date-display')),
            name: f(q('.goals-roster-name')),
            dotH: h(q('.role-dot')), dotFont: f(q('.role-dot')),
            rowH: h(q('.goals-mgr-row')),
            num: f(q('.goal-auto-display')),
            totalVal: f(q('.goals-total-val')),
            weekNum: f(q('.lu-week-num')),
            weekH: h(q('.lu-week')),
            headerH: h(q('.district-kpi-header')),
            contentH: h(q('.manage-content')),
            // Nothing may spill sideways out of the sheet.
            over: Array.from(m.querySelectorAll('*')).filter(e => {
                if (e.offsetParent === null) return false;
                const b = e.getBoundingClientRect();
                return b.width && b.right > window.innerWidth + 1;
            }).map(e => String(e.className).split(' ')[0]).slice(0, 4),
        };
        return r;
    }, ROSTER, LEVELUP);
    ok(lg.target <= 15, 'the goal headline came down', lg.target + 'px (was 19)');
    ok(lg.name <= 12, 'roster names came down', lg.name + 'px (was 13.5)');
    ok(lg.dotH <= 18 && lg.dotFont <= 9, 'role pills came down', lg.dotH + 'px tall, ' + lg.dotFont + 'px text (was 22/10)');
    ok(lg.num <= 12 && lg.totalVal <= 13, 'the number tiles came down', 'row ' + lg.num + 'px, total ' + lg.totalVal + 'px');
    ok(lg.weekNum <= 15 && lg.weekH <= 40, 'the Last 4 Weeks chips came down', lg.weekNum + 'px in a ' + lg.weekH + 'px chip (was 21 in ~53)');
    ok(lg.over.length === 0, 'and nothing spills out of the sheet', lg.over.join(', ') || 'clean');
    // The trap this section fell into once: a role-gated card measures 0 and every
    // "is it smaller" assertion passes on a modal nobody can see.
    ok(lg.dotH > 0 && lg.weekH > 0 && lg.rowH > 0, 'the modal was actually rendered',
        'dot ' + lg.dotH + ', week ' + lg.weekH + ', row ' + lg.rowH);
    console.log('       whole modal body: ' + lg.contentH + 'px for 3 employees');

    ok(mgr._errs.length === 0, 'no page errors', mgr._errs.join(' | ') || 'none');
    if (OUT) {
        await mgr.evaluate((roster, levelup) => {
            const m = document.getElementById('listingGoalsModal');
            m.classList.add('show'); m.style.display = 'flex';
            document.getElementById('goals-manager-body').innerHTML = roster;
            document.getElementById('goals-levelup').innerHTML = levelup;
            document.getElementById('goals-store-target').textContent = 'Goal: 151 Listings';
            document.getElementById('goals-date-display').textContent = 'Wednesday, Aug 19';
        }, ROSTER, LEVELUP);
        await new Promise(r => setTimeout(r, 300));
        await mgr.screenshot({ path: path.join(OUT, 'r9-goals.png') });
    }
    await mgr.close();

    await browser.close();
    console.log('\n' + (fails ? fails + ' FAILED' : 'all round-9 assertions verified on the real pages'));
    process.exit(fails ? 1 : 0);
})();
