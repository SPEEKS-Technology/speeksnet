// Round 17 of the phone review — the three DM-only tools nobody had looked at.
//
//   1. Feature Access: an 8-column role matrix in a 390px sheet. The chips were
//      claiming 304 of the row's 330px, so the feature label got a 0px column and
//      its text ran straight through them. The row now breaks in two.
//   2. Manager Checklist (the DM's admin half): equal store bubbles at BOTH
//      widths, a Required Task field the same height as the Time Period picker,
//      and a square edit/delete pair.
//   3. Box Order's DM half: the Order / Manage Items switch and the catalog
//      editor behind it, down to the sizes the order flow already sits at.
//   4. (added 20 Aug) "Units per bundle" and the "Unit word" picker beside it are
//      one control pair, at one size AND on one baseline — and the DM's Expense
//      Report opens with Month and Person on the same line, the mileage rate and
//      Manage on the next, and a categories panel sized like every other tool.
//   5. (added 20 Aug) Month Setup, whose two cards were still at desktop scale.
//
// Every assertion at 1400 is a LEAK GUARD, not a requirement — the numbers are
// what desktop measured before this round, recorded so a phone rule that escapes
// its media query shows up here rather than in a screenshot next month.
//
// NODE_PATH must point at a node_modules with puppeteer-core.
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const OUT = process.env.LV_SHOT_DIR || null;

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };
const same = arr => arr.length > 0 && arr.every(v => v === arr[0]);

const boot = async (page, w, role) => {
    await page.setViewport({ width: w, height: 1000, isMobile: w <= 900, hasTouch: w <= 900, deviceScaleFactor: 2 });
    await page.evaluateOnNewDocument((r) => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Layout Harness');
        sessionStorage.setItem('speeksUserPin', '0000');
        sessionStorage.setItem('speeksUserRole', r);
        sessionStorage.setItem('speeksUserStore', 'ALL');
    }, role);
    await page.goto('file:///' + REPO + '/index.html', { waitUntil: 'networkidle2' }).catch(() => {});
    await page.evaluate(() => {
        const o = document.getElementById('authOverlay'); if (o) o.style.display = 'none';
        document.body.classList.add('is-authenticated');
        document.body.classList.remove('preload', 'no-scroll');
        if (typeof applyRoleBasedUI === 'function') { try { applyRoleBasedUI(); } catch (e) {} }
    });
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
    await new Promise(r => setTimeout(r, 600));
};

// One geometry reader, shared by every section.
const GEO = `(sel, root) => {
    const e = (root || document).querySelector(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect(), c = getComputedStyle(e);
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left),
             top: Math.round(r.top), fs: parseFloat(c.fontSize) };
}`;

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });

    for (const w of [390, 1400]) {
        const phone = w <= 900;

        // ── 1. FEATURE ACCESS — the role matrix ───────────────────────────────
        console.log('\n== Feature Access @' + w + ' ==');
        let page = await browser.newPage();
        await boot(page, w, 'district manager');
        const fa = await page.evaluate((gsrc) => {
            const g = eval(gsrc);
            const m = document.getElementById('featureAccessModal');
            m.classList.add('show'); m.style.display = 'flex';
            _faTab = 'tools';
            renderFaBody();
            const tabs = document.querySelector('.fa-tabs');
            const btns = [...document.querySelectorAll('.fa-tabs .tab-btn')];
            const row = document.querySelector('.fa-group .fa-row:not(.fa-row-head)');
            const head = document.querySelector('.fa-row-head');
            const chips = [...row.querySelectorAll('.fa-chip')];
            const heads = [...head.querySelectorAll('.fa-col-head')];
            const lbl = row.querySelector('.fa-feat-label');
            const body = document.getElementById('fa-body');
            return {
                tabW: Math.round(tabs.getBoundingClientRect().width), tabSW: tabs.scrollWidth,
                tabRows: new Set(btns.map(b => Math.round(b.getBoundingClientRect().top))).size,
                nTabs: btns.length,
                // the label of a REAL row, not the head row's empty cell (which is the
                // first .fa-feat-label in the document and is display:none on a phone)
                label: { w: Math.round(lbl.getBoundingClientRect().width), h: Math.round(lbl.getBoundingClientRect().height) },
                labelLines: Math.round(lbl.getBoundingClientRect().height / parseFloat(getComputedStyle(lbl).lineHeight)),
                rowW: Math.round(row.getBoundingClientRect().width),
                nChips: chips.length,
                chipsW: Math.round(chips.reduce((s, c) => s + c.getBoundingClientRect().width, 0)),
                chip: g('.fa-chip'),
                // chips and their column heads have to stay in register
                register: chips.map((c, i) => Math.abs(Math.round(c.getBoundingClientRect().left) - Math.round(heads[i].getBoundingClientRect().left))),
                headLabelShown: getComputedStyle(head.querySelector('.fa-feat-label')).display !== 'none',
                bodyOver: body.scrollWidth - Math.round(body.getBoundingClientRect().width),
                docW: document.documentElement.scrollWidth,
            };
        }, GEO);
        if (OUT) await page.screenshot({ path: OUT + '/r17-fa-' + w + '.png' });

        ok(fa.nTabs === 5 && fa.tabSW <= fa.tabW + 1, '@' + w + ': every tab is inside the strip — none clipped',
            fa.tabSW + ' of ' + fa.tabW);
        ok(fa.tabRows === (phone ? 2 : 1), '@' + w + ': the tab strip is ' + (phone ? 'two rows of a 3-up grid' : 'one row'),
            fa.tabRows + ' row(s)');
        // THE bug: a 0px label column with 60px of text wrapped inside it.
        ok(fa.label.w > 200, '@' + w + ': the feature label has a column to live in', fa.label.w + 'px wide');
        ok(fa.labelLines === 1, '@' + w + ': and its text fits one line', fa.label.h + 'px tall');
        ok(fa.nChips === 8, '@' + w + ': all eight roles still have a chip', String(fa.nChips));
        ok(fa.chipsW <= fa.rowW, '@' + w + ': the chips fit the row', fa.chipsW + ' of ' + fa.rowW);
        ok(fa.register.every(d => d <= 1), '@' + w + ': every chip sits under its column head',
            'max ' + Math.max(...fa.register) + 'px off');
        ok(fa.chip.h === (phone ? 30 : 28), '@' + w + ': chip height', fa.chip.h + 'px');
        ok(fa.headLabelShown === !phone, '@' + w + ': the head row\'s empty label cell is ' + (phone ? 'out of the way' : 'in place'),
            String(fa.headLabelShown));
        ok(fa.bodyOver <= 0, '@' + w + ': the matrix does not overflow its sheet', String(fa.bodyOver));
        if (phone) ok(fa.docW <= w, '@' + w + ': no sideways scroll', String(fa.docW));

        // the two tabs behind it, which share the row shape
        const fa2 = await page.evaluate((gsrc) => {
            const g = eval(gsrc);
            _faUsers = [{ name: 'Nick Smith', role: 'Manager', store: 'OVL' }];
            _faUser = 'nick smith'; _faTab = 'user';
            renderFaBody();
            const grp = document.querySelector('.fa-ugroup'); if (grp) grp.classList.remove('collapsed');
            const body = document.getElementById('fa-body');
            const user = {
                over: body.scrollWidth - Math.round(body.getBoundingClientRect().width),
                seg: g('.fa-seg'), label: g('.fa-urow-label'),
            };
            _faTab = 'coverage'; renderFaBody();
            return {
                user,
                cover: {
                    over: body.scrollWidth - Math.round(body.getBoundingClientRect().width),
                    pick: g('.fa-cover-pick'),
                },
            };
        }, GEO);
        ok(fa2.user.over <= 0, '@' + w + ': Per-User rows stay inside the sheet', String(fa2.user.over));
        // 26 since round 18 ("smaller in size") — the size itself is asserted there.
        ok(fa2.user.seg.h === (phone ? 26 : 27), '@' + w + ': the Default/On/Off switch is ' + (phone ? '26px' : 'desktop size'),
            fa2.user.seg.h + 'px');
        ok(fa2.cover.over <= 0, '@' + w + ': Delegation stays inside the sheet', String(fa2.cover.over));
        // inline-styled pills — an author !important is the only thing that reaches them
        ok(fa2.cover.pick.fs === (phone ? 11.5 : 12.5), '@' + w + ': the delegate pills are ' + (phone ? '11.5px' : '12.5px'),
            fa2.cover.pick.fs + 'px');
        await page.close();

        // ── 2. MANAGER CHECKLIST — the DM's admin half ────────────────────────
        console.log('\n== Manager Checklist @' + w + ' ==');
        page = await browser.newPage();
        await boot(page, w, 'district manager');
        const mcl = await page.evaluate((gsrc) => {
            const g = eval(gsrc);
            const m = document.getElementById('managerChecklistDropdown');
            m.classList.add('show'); m.style.display = 'flex';
            document.getElementById('mcl-list').innerHTML = `
              <div class="mcl-group-label">Daily</div>
              <div class="mcl-row" data-id="1">
                <div class="mcl-row-main">
                  <span class="mcl-row-text">Listing Goals</span>
                  <div class="mcl-row-badges">
                    <span class="mcl-badge">OVL</span><span class="mcl-badge">LEE</span>
                    <span class="mcl-badge">BAL</span><span class="mcl-badge">WSP</span>
                    <span class="mcl-badge">Corp</span></div>
                </div>
                <div class="mcl-row-actions">
                  <button class="mcl-edit-btn">\u270e</button>
                  <button class="mcl-del-btn">\u2716</button>
                </div>
              </div>`;
            return {
                pills: [...document.querySelectorAll('#mcl-stores label')].map(l => Math.round(l.getBoundingClientRect().width)),
                badges: [...document.querySelectorAll('.mcl-badge')].map(l => Math.round(l.getBoundingClientRect().width)),
                text: g('#mcl-text'), dd: g('.mcl-field-period .dd-btn'),
                edit: g('.mcl-edit-btn'), del: g('.mcl-del-btn'),
                docW: document.documentElement.scrollWidth,
            };
        }, GEO);
        if (OUT) await page.screenshot({ path: OUT + '/r17-mcl-' + w + '.png' });

        ok(mcl.pills.length === 6 && same(mcl.pills), '@' + w + ': all six store bubbles are one size',
            mcl.pills.join('/'));
        ok(same(mcl.badges), '@' + w + ': and so are the store badges on a task', mcl.badges.join('/'));
        // The dropdown face is drawn by _ddEnhance over the native <select>.
        ok(mcl.dd !== null, '@' + w + ': the Time Period picker was enhanced', mcl.dd ? mcl.dd.h + 'px' : 'no .dd-btn');
        ok(Math.abs(mcl.text.h - mcl.dd.h) <= 1, '@' + w + ': Required Task is the height of the Time Period picker',
            mcl.text.h + ' vs ' + mcl.dd.h);
        ok(mcl.edit.w === mcl.edit.h && mcl.del.w === mcl.del.h, '@' + w + ': the edit/delete pair is square, not an oval',
            mcl.edit.w + 'x' + mcl.edit.h + ' / ' + mcl.del.w + 'x' + mcl.del.h);
        ok(mcl.edit.w === (phone ? 32 : 26) && mcl.del.w === mcl.edit.w,
            '@' + w + ': at ' + (phone ? '32px, the Expense Report\'s phone size' : '26px, the desktop size'), String(mcl.edit.w));
        if (phone) ok(mcl.docW <= w, '@' + w + ': no sideways scroll', String(mcl.docW));
        await page.close();

        // ── 3. BOX ORDER — the DM's half ──────────────────────────────────────
        console.log('\n== Box Order (DM) @' + w + ' ==');
        page = await browser.newPage();
        await boot(page, w, 'district manager');
        const bo = await page.evaluate((gsrc) => {
            const g = eval(gsrc);
            const m = document.getElementById('boxOrderModal');
            m.classList.add('show'); m.style.display = 'flex';
            document.getElementById('boxOrderTabs').style.display = 'flex';
            _boxOrderAllItems = [
                { id: '1', name: 'Packing Paper', category: 'Shipping Supplies', bundle_size: 1, unit_label: 'Roll', order_name: '24" 40# 900\' Kraft Paper', stores: '' },
                { id: '2', name: '9x6x3', category: 'Small Box', bundle_size: 25, unit_label: 'Box', order_name: '9 x 6 x 3 in', stores: 'OVL,LEE,WSP' },
            ];
            boxOrderSwitchTab('manage');
            return {
                tab: g('.box-order-tab'),
                inlineStyled: document.querySelectorAll('#boxAdminItemsList [style]').length,
                cat: g('.bai-cat'), name: g('.bai-name'), meta: g('.bai-meta'),
                del: g('.bai-del'),
                field: g('#boxAdminName'),
                // the pair that sits in one row: a bare input and a dropdown face
                bundle: g('#boxAdminBundle'),
                unit: (() => { const sel = document.getElementById('boxAdminUnit');
                    const h = sel && sel.closest('.dd-host');
                    const btn = h && h.querySelector('.dd-btn');
                    if (!btn) return null;
                    const r = btn.getBoundingClientRect();
                    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left),
                             top: Math.round(r.top) }; })(),
                docW: document.documentElement.scrollWidth,
            };
        }, GEO);
        if (OUT) await page.screenshot({ path: OUT + '/r17-bo-' + w + '.png' });

        ok(bo.tab.h === (phone ? 34 : 38), '@' + w + ': the Order / Manage Items switch is ' + (phone ? '34px' : 'desktop size'),
            bo.tab.h + 'px');
        // The switch sits outside .manage-content, so it had no side padding at all.
        // Phone only. On a desktop modal the switch has always run the full width,
        // 22px proud of the field column either side — pre-existing, and not this
        // round's business.
        if (phone) ok(Math.abs(bo.tab.x - bo.field.x) <= 1, '@' + w + ': the switch lines up with the fields under it',
            bo.tab.x + ' vs ' + bo.field.x);
        // The class move is what let the mobile layer reach these rows at all.
        ok(bo.inlineStyled === 0, '@' + w + ': no inline styles left in the catalog list', String(bo.inlineStyled));
        ok(bo.name.fs === (phone ? 12 : 13) && bo.meta.fs === (phone ? 10 : 11),
            '@' + w + ': catalog row type', bo.name.fs + '/' + bo.meta.fs + 'px');
        ok(bo.del.w === bo.del.h, '@' + w + ': the remove button is square, not an oval', bo.del.w + 'x' + bo.del.h);
        ok(bo.del.w === (phone ? 30 : 32), '@' + w + ': at ' + (phone ? '30px' : '32px'), String(bo.del.w));
        if (phone) ok(bo.docW <= w, '@' + w + ': no sideways scroll', String(bo.docW));
        ok(bo.unit !== null, '@' + w + ': the Unit word picker was enhanced', bo.unit ? 'yes' : 'no .dd-btn');
        ok(bo.bundle.w === bo.unit.w, '@' + w + ': Units per bundle and Unit word are the same width',
            bo.bundle.w + ' vs ' + bo.unit.w);
        // A bare .form-input-lg is 38 on a phone and a dropdown face is 34, so the
        // pair read as two different kinds of control until the form came down.
        ok(bo.bundle.h === bo.unit.h, '@' + w + ': ...and the same height',
            bo.bundle.h + ' vs ' + bo.unit.h);
        // The input is an inline-block so its top margin does NOT collapse with the
        // label's bottom margin; the dropdown's face is a block inside .dd-host, so
        // the same two margins DO. That is what set them 4px (phone) / 6px (desktop)
        // apart at identical heights.
        ok(bo.bundle.top === bo.unit.top, '@' + w + ': ...on the same baseline',
            bo.bundle.top + ' vs ' + bo.unit.top);
        await page.close();
    }

    // ── 4. EXPENSE REPORT — the control row, as a DM ──────────────────────────
    // Month and Person are the two things a DM changes constantly; on a phone they
    // were one per line with a caps label eating 85px of a 360px row.
    for (const w of [390, 1400]) {
        const phone = w <= 900;
        console.log('\n== Expense Report controls @' + w + ' ==');
        const page = await browser.newPage();
        await boot(page, w, 'district manager');
        await page.evaluate(() => {
            const m = document.getElementById('expensesModal');
            m.classList.add('show'); m.style.display = 'flex';
            _expData = { me: 'Ethan Kushnir', isReviewer: true, canEditOthers: true, rate: 0.72,
                months: ['2026-08', '2026-07', '2026-09'],
                // the longest real name on the roster — the picker sizes to it
                people: ['Ethan Kushnir', 'Nick Vandenberghe', 'Josiah Smith'],
                categories: [], entries: [] };
            _expMonth = '2026-08'; _expPerson = 'Ethan Kushnir'; _expTab = 'mileage';
            renderExpenses();
        });
        await new Promise(r => setTimeout(r, 350));   // _ddScan is debounced
        const r = await page.evaluate(() => {
            const row = document.querySelector('.exp-controls');
            const ctl = [...row.querySelectorAll(':scope > .exp-ctl')];
            const box = e => { const q = e.getBoundingClientRect(); return { top: Math.round(q.top), w: Math.round(q.width) }; };
            const dd = e => { const b = e.querySelector('.dd-btn'); return b ? Math.round(b.getBoundingClientRect().width) : null; };
            return {
                month: box(ctl[0]), person: box(ctl[1]),
                monthDd: dd(ctl[0]), personDd: dd(ctl[1]),
                rowW: Math.round(row.getBoundingClientRect().width),
                labelsShown: ctl.slice(0, 2).map(c => getComputedStyle(c.querySelector('span')).display !== 'none'),
                // nothing may be clipped: the whole point of dropping the labels
                clipped: [...row.querySelectorAll('.dd-cur')].filter(c => c.scrollWidth > c.clientWidth + 1).length,
                docW: document.documentElement.scrollWidth,
            };
        });
        ok(r.month.top === r.person.top, '@' + w + ': Month and Person share a line',
            r.month.top + ' vs ' + r.person.top);
        ok(r.month.w + r.person.w + 10 <= r.rowW, '@' + w + ': ...with room to spare',
            (r.month.w + r.person.w + 10) + ' of ' + r.rowW);
        ok(r.clipped === 0, '@' + w + ': neither picker clips its value', r.clipped + ' clipped');
        // Desktop keeps its labels; the phone spends that width on the pickers.
        ok(r.labelsShown.every(v => v === !phone), '@' + w + ': the caps labels are ' + (phone ? 'off' : 'on'),
            r.labelsShown.join('/'));
        if (phone) ok(r.docW <= w, '@' + w + ': no sideways scroll', String(r.docW));

        // the rate row: MILEAGE RATE + its field + Save + Manage, one line
        const rate = await page.evaluate(() => {
            const row = document.querySelector('.exp-controls');
            const shown = [...row.children].filter(e => getComputedStyle(e).display !== 'none');
            const manage = shown.find(e => (e.textContent || '').trim() === 'Manage');
            const rateCtl = shown.find(e => /Mileage rate/i.test(e.textContent || ''));
            const box = e => { const q = e.getBoundingClientRect(); return { top: Math.round(q.top), w: Math.round(q.width), h: Math.round(q.height) }; };
            const f = document.getElementById('exp-rate');
            return {
                manageFound: !!manage,
                manage: manage ? box(manage) : null, rateCtl: rateCtl ? box(rateCtl) : null,
                field: f ? box(f) : null,
                btnH: [...row.querySelectorAll('.exp-btn-sm')].map(x => Math.round(x.getBoundingClientRect().height)),
                // zero-height children (the flex spacer) have no line of their own,
                // and items on one line differ by a pixel or two because the row is
                // centre-aligned and they are not all the same height.
                lines: (() => { const tops = shown
                    .filter(e => e.getBoundingClientRect().height > 0)
                    .map(e => Math.round(e.getBoundingClientRect().top))
                    .sort((a, b) => a - b);
                    let n = 0, last = -99;
                    tops.forEach(t => { if (t - last > 8) { n++; last = t; } });
                    return n; })(),
            };
        });
        // "Manage categories" was the widest thing in a row that has to hold three
        // controls; the panel it opens says what it is.
        ok(rate.manageFound, '@' + w + ': the button reads just "Manage"', rate.manageFound ? 'yes' : 'still "Manage categories"');
        ok(Math.abs(rate.manage.top - rate.rateCtl.top) <= 2, '@' + w + ': it shares the line with the mileage rate',
            rate.manage.top + ' vs ' + rate.rateCtl.top);
        ok(rate.field.w === (phone ? 62 : 86), '@' + w + ': the rate field is ' + (phone ? '62px' : 'its desktop 86px'),
            rate.field.w + 'px');
        ok(rate.btnH.every(h => h === 32), '@' + w + ': the small buttons are 32px', rate.btnH.join('/'));
        // Wider than its own text: it carries a whole panel behind it. The line has
        // to still hold, which the line count below is what checks.
        ok(rate.manage.w >= (phone ? 85 : 75), '@' + w + ': Manage is wider than its label needs', rate.manage.w + 'px');
        ok(rate.lines === (phone ? 3 : 1), '@' + w + ': the control row is ' + (phone ? 'three lines' : 'one line'),
            rate.lines + ' line(s)');

        // the categories panel behind Manage
        const cats = await page.evaluate(() => {
            _expCatsOpen = true; renderExpenses();
            const g = s2 => { const e = document.querySelector(s2); if (!e) return null;
                const r2 = e.getBoundingClientRect(), c = getComputedStyle(e);
                return { h: Math.round(r2.height), fs: parseFloat(c.fontSize) }; };
            return {
                head: document.querySelector('.exp-view-h').textContent,
                input: g('.exp-cat-row .exp-input'), save: g('.exp-cat-row .exp-btn-sm'),
                sub: g('.exp-cats-sub'),
                docW: document.documentElement.scrollWidth,
            };
        });
        ok(cats.head === 'Expense Categories', '@' + w + ': the heading is Title Case', cats.head);
        // 34/12.5 is the phone field in every other tool; this one had kept 38/16.
        ok(cats.input.h === (phone ? 34 : 36) && cats.input.fs === 12.5,
            '@' + w + ': the category fields match the other tools\' fields',
            cats.input.h + 'px / ' + cats.input.fs + 'px');
        ok(cats.save.h === 32, '@' + w + ': Save and Delete are the small button', cats.save.h + 'px');
        ok(cats.sub.fs === (phone ? 10.5 : 11), '@' + w + ': the explainer is ' + (phone ? '10.5px' : '11px'), cats.sub.fs + 'px');
        if (phone) ok(cats.docW <= w, '@' + w + ': no sideways scroll with the panel open', String(cats.docW));
        await page.close();
    }

    // ── 5. MONTH SETUP ────────────────────────────────────────────────────────
    for (const w of [390, 1400]) {
        const phone = w <= 900;
        console.log('\n== Month Setup @' + w + ' ==');
        const page = await browser.newPage();
        await boot(page, w, 'district manager');
        const gp = await page.evaluate((gsrc) => {
            const g = eval(gsrc);
            const m = document.getElementById('gpGoalsModal');
            m.classList.add('show'); m.style.display = 'flex';
            _gpGoals = { month: '2026-08', goals: { OVL: 77000, LEE: 62000, WSP: 80000, MPL: 60000, BAL: 53000 },
                         closed: [{ day: 27, label: 'Thanksgiving' }], setBy: 'seeded from the sheet', canEdit: true };
            _gpClosed = [{ day: 27, label: 'Thanksgiving' }];
            renderGpGoals();
            const add = [...document.querySelectorAll('.gp-add > *')];
            return {
                intro: g('#gpGoalsModal .manage-content > p'),
                row: g('.gp-goal-row'), input: g('.gp-goal-field .mg-input'),
                bdFig: g('.gp-bd-num b'), calc: g('.gp-bd-calc'),
                chip: g('.gp-chip'), save: g('.gp-save .btn-primary'),
                sec: g('.gp-sec'),
                addH: add.map(e => Math.round(e.getBoundingClientRect().height)),
                addLines: (() => { const tops = add.map(e => Math.round(e.getBoundingClientRect().top)).sort((a, b) => a - b);
                    let n = 0, last = -99;
                    tops.forEach(t => { if (t - last > 8) { n++; last = t; } });
                    return n; })(),
                bodyOver: (() => { const e = document.getElementById('gpGoalsBody');
                    return e.scrollWidth - Math.round(e.getBoundingClientRect().width); })(),
                docW: document.documentElement.scrollWidth,
            };
        }, GEO);
        if (OUT) await page.screenshot({ path: OUT + '/r17-gp-' + w + '.png' });

        ok(gp.input.h === (phone ? 34 : 44), '@' + w + ': the goal fields are ' + (phone ? 'the phone\'s 34px' : 'desktop size'),
            gp.input.h + 'px');
        ok(gp.bdFig.fs === (phone ? 24 : 30), '@' + w + ': the buying-days figure is still the biggest thing on its card',
            gp.bdFig.fs + 'px');
        ok(gp.chip.fs === (phone ? 10.5 : 12), '@' + w + ': the closure chips', gp.chip.fs + 'px');
        // date input, text input, Add — one row, one height. A date input's content
        // box is taller than a text input's at the same padding, hence the explicit
        // height on .gp-add-date.
        // Same bucketing point as the expense row: a centre-aligned row of items of
        // different heights has several different tops on ONE line.
        ok(gp.addLines <= 1, '@' + w + ': the closures form is one row', gp.addLines + ' distinct top(s)');
        ok(new Set(gp.addH).size === 1, '@' + w + ': ...at one height', gp.addH.join('/'));
        // Every other tool's primary action is full width on a phone.
        ok(phone ? gp.save.w >= 330 : gp.save.w < 200, '@' + w + ': Save Month is ' + (phone ? 'full width' : 'its own width'),
            gp.save.w + 'px');
        ok(gp.bodyOver <= 0, '@' + w + ': nothing overflows the sheet', String(gp.bodyOver));
        if (phone) ok(gp.docW <= w, '@' + w + ': no sideways scroll', String(gp.docW));
        await page.close();
    }

    await browser.close();
    console.log('\n' + (fails ? fails + ' FAILED' : 'all green'));
    process.exit(fails ? 1 : 0);
})();
