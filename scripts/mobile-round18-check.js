// Round 18 — Feature Access, second pass (behaviour this time, not just size).
//
//   1. switching tabs lands at the top of the new tab, at BOTH widths
//   2. the phone tab strip fills the bar, three per row
//   3. the strip scrolls away with the content instead of sitting frozen over it
//   4. no OS-blue tap flash on the Delegation picks (a <label> is a tap target)
//   5. scrolling a long dropdown no longer closes it — site-wide, not just here
//   6. the Default/On/Off switch is the size every phone switch on the site is
//
// NODE_PATH must point at a node_modules with puppeteer-core.
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const OUT = process.env.LV_SHOT_DIR || null;

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });

    for (const w of [390, 1400]) {
        const phone = w <= 900;
        console.log('\n== Feature Access @' + w + ' ==');
        const page = await browser.newPage();
        await page.setViewport({ width: w, height: 844, isMobile: phone, hasTouch: phone, deviceScaleFactor: 2 });
        // -webkit-tap-highlight-color only resolves under (hover: none), and
        // puppeteer's own emulateMediaFeatures rejects `hover` — so CDP directly.
        const cdp = await page.createCDPSession();
        await cdp.send('Emulation.setEmulatedMedia', {
            features: [{ name: 'hover', value: phone ? 'none' : 'hover' },
                       { name: 'any-hover', value: phone ? 'none' : 'hover' }],
        });
        await page.evaluateOnNewDocument(() => {
            sessionStorage.setItem('speeksUnlocked', 'true');
            sessionStorage.setItem('speeksUserName', 'Layout Harness');
            sessionStorage.setItem('speeksUserRole', 'district manager');
            sessionStorage.setItem('speeksUserStore', 'ALL');
            sessionStorage.setItem('speeksUserPin', '0000');
        });
        await page.goto('file:///' + REPO + '/index.html', { waitUntil: 'networkidle2' }).catch(() => {});
        await page.evaluate(() => {
            const o = document.getElementById('authOverlay'); if (o) o.style.display = 'none';
            document.body.classList.add('is-authenticated');
            document.body.classList.remove('preload', 'no-scroll');
            if (typeof applyRoleBasedUI === 'function') { try { applyRoleBasedUI(); } catch (e) {} }
        });
        await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
        await new Promise(r => setTimeout(r, 500));

        // ── the tab strip ─────────────────────────────────────────────────────
        const tabs = await page.evaluate(() => {
            const m = document.getElementById('featureAccessModal');
            m.classList.add('show'); m.style.display = 'flex';
            // 40 users, so the Per-User picker is a genuinely long list (test 5)
            _faUsers = Array.from({ length: 40 }, (_, i) => ({ name: 'User Number ' + (i + 1), role: 'Manager', store: 'OVL' }));
            _faTab = 'widgets'; renderFaBody();
            const strip = document.querySelector('.fa-tabs');
            const cs = getComputedStyle(strip);
            const rows = {};
            [...document.querySelectorAll('.fa-tabs .tab-btn')].forEach(b => {
                const r = b.getBoundingClientRect();
                (rows[Math.round(r.top)] = rows[Math.round(r.top)] || []).push(Math.round(r.width));
            });
            const inner = Math.round(strip.getBoundingClientRect().width)
                - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
            const gap = parseFloat(cs.gap) || 0;
            return {
                rows: Object.values(rows), inner: Math.round(inner), gap,
                perRow: Object.values(rows).map(r => r.length),
                filled: Object.values(rows).map(r =>
                    Math.round(r.reduce((s, x) => s + x, 0) + gap * (r.length - 1))),
            };
        });
        // Desktop keeps all five in one row — the cap is a phone rule.
        ok(phone ? Math.max(...tabs.perRow) <= 3 : tabs.perRow[0] === 5,
            '@' + w + ': ' + (phone ? 'at most three tabs to a row' : 'all five in one row'),
            tabs.perRow.join('+'));
        ok(tabs.perRow.length === (phone ? 2 : 1), '@' + w + ': ' + (phone ? 'two rows' : 'one row'),
            tabs.perRow.length + ' row(s)');
        // The complaint: row two was two thirds of a bar with a hole on the end.
        ok(tabs.filled.every(f => Math.abs(f - tabs.inner) <= 2), '@' + w + ': every row fills the bar',
            tabs.filled.join('/') + ' of ' + tabs.inner);

        // ── the strip travels with the content (phone) / stays put (desktop) ──
        const scroll = await page.evaluate(() => {
            const m = document.getElementById('featureAccessModal');
            const body = m.querySelector('.manage-content');
            _faTab = 'widgets'; renderFaBody();
            const sheetScrolls = m.scrollHeight > m.clientHeight + 2;
            const scroller = sheetScrolls ? m : body;
            const stripBefore = Math.round(document.querySelector('.fa-tabs').getBoundingClientRect().top);
            scroller.scrollTop = 400;
            const stripAfter = Math.round(document.querySelector('.fa-tabs').getBoundingClientRect().top);
            const headAfter = Math.round(document.querySelector('#featureAccessModal .modal-header').getBoundingClientRect().top);
            const sheetTop = Math.round(m.getBoundingClientRect().top);
            // then switch tabs from 400px down
            switchFaTab('user');
            return { sheetScrolls, moved: stripBefore - stripAfter, headStuck: Math.abs(headAfter - sheetTop) <= 1,
                     modalTop: m.scrollTop, bodyTop: body.scrollTop };
        });
        ok(scroll.sheetScrolls === phone, '@' + w + ': the ' + (phone ? 'sheet' : 'body') + ' is the scroll container',
            'sheet scrolls: ' + scroll.sheetScrolls);
        if (phone) {
            ok(scroll.moved >= 300, '@' + w + ': the tab strip scrolls away with the content',
                'travelled ' + scroll.moved + 'px');
            ok(scroll.headStuck, '@' + w + ': the header stays pinned, so Close is always reachable',
                String(scroll.headStuck));
        }
        // Both containers, because which one scrolls depends on the width.
        ok(scroll.modalTop === 0 && scroll.bodyTop === 0, '@' + w + ': a new tab starts at the top',
            'modal ' + scroll.modalTop + ', body ' + scroll.bodyTop);

        // ── the tap flash, and the switch size ────────────────────────────────
        const bits = await page.evaluate(() => {
            _faTab = 'user'; _faUser = 'user number 1'; renderFaBody();
            const g = document.querySelector('.fa-ugroup'); if (g) g.classList.remove('collapsed');
            const seg = document.querySelector('.fa-seg');
            // read it NOW: the coverage render below replaces the whole body
            const segBox = seg.getBoundingClientRect();
            const segFs = parseFloat(getComputedStyle(seg).fontSize);
            const rd = document.querySelector('.fa-role-def');
            const roleDef = rd ? rd.textContent.trim() : null;
            _faTab = 'coverage'; renderFaBody();
            const pick = document.querySelector('.fa-cover-pick');
            return {
                seg: { h: Math.round(segBox.height), fs: segFs },
                roleDef,
                ddSelect: (() => { const b = document.querySelector('.dd-btn');
                    return b ? getComputedStyle(b).userSelect : 'no dropdown'; })(),
                tapDd: (() => { const b = document.querySelector('.dd-btn');
                    return b ? getComputedStyle(b).webkitTapHighlightColor : 'no dropdown'; })(),
                tapPick: getComputedStyle(pick).webkitTapHighlightColor,
                tapBox: getComputedStyle(pick.querySelector('input')).webkitTapHighlightColor,
                btnFs: parseFloat(getComputedStyle(document.querySelector('#fa-body .btn-primary')).fontSize),
            };
        });
        // The site's phone three-way switch: 30px tall, 11.5px type (.exp-tab,
        // .notif-tabs .tab-btn, the Checklist's period strip).
        ok(bits.seg.h === (phone ? 26 : 27) && bits.seg.fs === (phone ? 10.5 : 11),
            '@' + w + ': the Default/On/Off switch matches the site\'s ' + (phone ? 'phone' : 'desktop') + ' switch',
            bits.seg.h + 'px / ' + bits.seg.fs + 'px');
        ok(bits.btnFs === (phone ? 12.5 : 13), '@' + w + ': its inline-styled buttons came down too', bits.btnFs + 'px');
        if (phone) {
            // transparent, not sage and certainly not the OS blue: nothing flashes.
            const none = 'rgba(0, 0, 0, 0)';
            ok(bits.tapPick === none && bits.tapBox === none && bits.tapDd === none,
                '@' + w + ': nothing flashes on tap — pick, checkbox or dropdown',
                [bits.tapPick, bits.tapBox, bits.tapDd].join(' / '));
        }
        // The desktop half of the same complaint: a dropdown is a control, so
        // click-dragging it must not paint a text selection over it.
        ok(bits.ddSelect === 'none', '@' + w + ': a dropdown face is not selectable text', bits.ddSelect);
        ok(bits.roleDef === null || /Role Default: (Visible|Hidden)/.test(bits.roleDef),
            '@' + w + ': the role-default note is Title Case', bits.roleDef || '(no inherited row)');

        // ── the dropdown that could not be scrolled ───────────────────────────
        const dd = await page.evaluate(async () => {
            _faTab = 'user'; _faUser = ''; renderFaBody();
            await new Promise(r => setTimeout(r, 250)); // _ddScan is debounced 60ms
            const host = document.querySelector('#fa-body .dd-host');
            if (!host) return { err: 'the user picker was never enhanced' };
            host._ddBtn.click();
            await new Promise(r => setTimeout(r, 60));
            const list = host._ddList;
            const open0 = list.classList.contains('dd-open');
            const scrollable = list.scrollHeight > list.clientHeight + 2;
            list.scrollTop = 120;
            list.dispatchEvent(new Event('scroll'));
            await new Promise(r => setTimeout(r, 40));
            const open1 = list.classList.contains('dd-open');
            const at = list.scrollTop;
            // and the reason the closer exists in the first place must still hold:
            // scrolling what is BEHIND the list still closes it, because a fixed
            // list does not travel with its button.
            const m = document.getElementById('featureAccessModal');
            const sc = m.scrollHeight > m.clientHeight + 2 ? m : m.querySelector('.manage-content');
            sc.scrollTop += 40;
            sc.dispatchEvent(new Event('scroll'));
            await new Promise(r => setTimeout(r, 40));
            return { open0, scrollable, open1, at, closedBehind: !list.classList.contains('dd-open') };
        });
        ok(!dd.err, '@' + w + ': the user picker is an enhanced dropdown', dd.err || 'yes');
        ok(dd.open0 && dd.scrollable, '@' + w + ': 40 users open a list long enough to scroll',
            'open ' + dd.open0 + ', scrollable ' + dd.scrollable);
        ok(dd.open1 && dd.at === 120, '@' + w + ': scrolling the list does NOT close it',
            'open ' + dd.open1 + ' at ' + dd.at + 'px');
        ok(dd.closedBehind, '@' + w + ': scrolling the sheet behind it still does', String(dd.closedBehind));

        if (OUT) await page.screenshot({ path: OUT + '/r18-fa-' + w + '.png' });
        await page.close();
    }

    // ── the same strip on the other four shells ───────────────────────────────
    // Feature Access is pasted into all five page shells and they drift (the four
    // non-index copies were still on a pre-redesign <div class="notif-tabs"
    // style="display:inline-flex"> with no .fa-tabs at all, so none of the phone
    // work above reached them). This is the guard.
    console.log(String.fromCharCode(10) + "== the strip on every shell @390 ==");
    for (const shell of ["index.html", "docs.html", "stats.html", "workspace.html", "operations.html"]) {
        const page = await browser.newPage();
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        await page.evaluateOnNewDocument(() => {
            sessionStorage.setItem("speeksUnlocked", "true");
            sessionStorage.setItem("speeksUserName", "Layout Harness");
            sessionStorage.setItem("speeksUserRole", "district manager");
            sessionStorage.setItem("speeksUserStore", "ALL");
            sessionStorage.setItem("speeksUserPin", "0000");
        });
        await page.goto("file:///" + REPO + "/" + shell, { waitUntil: "networkidle2" }).catch(() => {});
        const r = await page.evaluate(() => {
            const m = document.getElementById("featureAccessModal");
            if (!m) return { err: "no Feature Access modal" };
            m.classList.add("show"); m.style.display = "flex";
            const strip = m.querySelector(".fa-tabs");
            if (!strip) return { err: "the strip has no .fa-tabs class" };
            const wrap = m.querySelector(".fa-tabs-wrap");
            const cs = getComputedStyle(strip);
            const rows = {};
            [...strip.querySelectorAll(".tab-btn")].forEach(b => {
                const q = b.getBoundingClientRect();
                (rows[Math.round(q.top)] = rows[Math.round(q.top)] || []).push(Math.round(q.width));
            });
            const gap = parseFloat(cs.gap) || 0;
            const inner = Math.round(strip.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
            return {
                wrap: !!wrap, perRow: Object.values(rows).map(x => x.length), inner,
                filled: Object.values(rows).map(x => Math.round(x.reduce((t, y) => t + y, 0) + gap * (x.length - 1))),
                over: strip.scrollWidth - Math.round(strip.getBoundingClientRect().width),
            };
        });
        ok(!r.err && r.wrap, shell + ": the strip is the redesigned one", r.err || "yes");
        if (!r.err) {
            ok(r.perRow.join("+") === "3+2", shell + ": three then two", r.perRow.join("+"));
            ok(r.filled.every(f => Math.abs(f - r.inner) <= 2), shell + ": both rows fill the bar",
                r.filled.join("/") + " of " + r.inner);
            ok(r.over <= 0, shell + ": nothing clipped", String(r.over));
        }
        await page.close();
    }

    await browser.close();
    console.log('\n' + (fails ? fails + ' FAILED' : 'all green'));
    process.exit(fails ? 1 : 0);
})();
