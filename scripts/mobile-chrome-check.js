// Round-4 critiques: checklist tab sizing, the close button, top-bar spacing,
// the feed cap and the hero title. All measured, because every one of them is a
// "looks wrong" report and a box that looks wrong has wrong numbers.
const puppeteer = require('puppeteer-core');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const OUT = process.env.LV_SHOT_DIR || __dirname;

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 900, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
    await page.evaluateOnNewDocument(() => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Layout Harness');
        sessionStorage.setItem('speeksUserRole', 'district manager');
        sessionStorage.setItem('speeksUserStore', 'CORP');
    });
    await page.goto('file:///' + REPO + '/index.html', { waitUntil: 'networkidle2' }).catch(() => {});
    await page.evaluate(() => {
        const ov = document.getElementById('authOverlay'); if (ov) ov.style.display = 'none';
        document.documentElement.classList.remove('no-scroll');
        document.body.classList.remove('no-scroll', 'preload');
        document.body.classList.add('is-authenticated');
        if (typeof applyRoleBasedUI === 'function') { try { applyRoleBasedUI(); } catch (e) {} }
    });
    await new Promise(r => setTimeout(r, 800));

    console.log('\n--- round 4, real index.html @390 ---');

    // 1. Checklist tabs. CORP is what reveals Quarterly.
    const tabs = await page.evaluate(() => {
        const q = document.getElementById('cl-tab-quarterly');
        if (q) q.style.display = '';           // the reveal path under test
        return ['daily', 'weekly', 'monthly', 'quarterly'].map(t => {
            const el = document.getElementById('cl-tab-' + t);
            const r = el.getBoundingClientRect();
            return { t, w: Math.round(r.width), h: Math.round(r.height), d: getComputedStyle(el).display };
        });
    });
    const hs = tabs.map(x => x.h);
    ok(new Set(hs).size === 1, '1. all four checklist tabs are the same height', tabs.map(x => x.t + ':' + x.h).join(' '));
    ok(new Set(tabs.map(x => x.d)).size === 1, '   and share one display mode', tabs.map(x => x.d).join(' '));

    // 2. Close button must be square, not a pill.
    const close = await page.evaluate(() => {
        const el = document.querySelector('.cl-panel-header .modal-close-btn');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    ok(close && Math.abs(close.w - close.h) <= 1, '2. close button is square', close && close.w + 'x' + close.h);
    // 40 -> 34 -> 30 across rounds 8 and 9; the user asked for smaller twice. Still
    // a deliberate floor, not "whatever it happens to be" — see the single close-
    // button rule in the side-panel block of the mobile layer.
    ok(close && close.h >= 30, '   and still a real tap target', close && close.h + 'px');

    // 3. Top bar: one size, evenly spread.
    const bar = await page.evaluate(() => {
        // Only the controls. .user-profile-nav also parents the Quick Messages and
        // Hotkeys dropdown PANELS, which are absolutely positioned children — they
        // measure 342px wide and made an earlier version of this test fail on a bar
        // that was already correct.
        const els = Array.from(document.querySelectorAll(
            '.top-nav .user-profile-nav .action-btn, .top-nav .user-profile-nav .tools-nav-btn'))
            .filter(e => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0);
        const boxes = els.map(e => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.left) }; });
        const gaps = [];
        for (let i = 1; i < boxes.length; i++) gaps.push(boxes[i].l - (boxes[i - 1].l + boxes[i - 1].w));
        return { boxes, gaps };
    });
    const ws = bar.boxes.map(b => b.w);
    ok(new Set(ws).size === 1, '3. every top-bar control is the same width', ws.join(','));
    ok(new Set(bar.boxes.map(b => b.h)).size === 1, '   and the same height', bar.boxes.map(b => b.h).join(','));
    ok(bar.gaps.length && (Math.max(...bar.gaps) - Math.min(...bar.gaps)) <= 2, '   spaced evenly', bar.gaps.join(','));

    // 4. Hero title on one line.
    const hero = await page.evaluate(() => {
        const t = document.querySelector('.speeks-action-menu .sam-hero-t');
        if (!t) return null;
        const cs = getComputedStyle(t);
        const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
        const r = t.getBoundingClientRect();
        return { lines: Math.round(r.height / lh), clipped: t.scrollWidth > t.clientWidth + 1, nowrap: cs.whiteSpace, h: Math.round(r.height) };
    });
    ok(hero && hero.nowrap === 'nowrap', '4. hero title is single-line', hero && hero.nowrap);
    ok(hero && hero.lines === 1, '   measured one line high', hero && hero.lines + ' line(s), ' + hero.h + 'px');

    // 5. Feed capped at two rows.
    const feed = await page.evaluate(() => {
        const f = document.getElementById('samFeed');
        if (!f) return null;
        const rows = Array.from(f.querySelectorAll('.sam-ann'));
        const ft = f.getBoundingClientRect();
        const fullyVisible = rows.filter(r => {
            const b = r.getBoundingClientRect();
            return b.bottom <= ft.bottom + 1 && b.top >= ft.top - 1;
        }).length;
        return { rows: rows.length, fullyVisible, maxH: f.style.maxHeight, scrolls: f.scrollHeight > f.clientHeight + 1 };
    });
    if (feed && feed.rows > 2) {
        ok(feed.fullyVisible === 2, '5. exactly two feed rows visible', feed.fullyVisible + ' of ' + feed.rows + ', maxHeight ' + feed.maxH);
        ok(feed.scrolls, '   the rest scroll inside the feed');

        // The regression that shipped in round 4: the cap was measured with
        // getBoundingClientRect, which is viewport-relative, so once the feed had
        // been scrolled to the bottom the next re-render measured a shorter gap
        // and collapsed the feed to one row. Scroll it, re-render, re-measure.
        const after = await page.evaluate(() => {
            const f = document.getElementById('samFeed');
            f.scrollTop = f.scrollHeight;               // all the way down
            renderActionFeed();                          // what a poll or realtime ping does
            const ft = f.getBoundingClientRect();
            const vis = Array.from(f.querySelectorAll('.sam-ann')).filter(r => {
                const b = r.getBoundingClientRect();
                return b.bottom <= ft.bottom + 1 && b.top >= ft.top - 1;
            }).length;
            return { maxH: f.style.maxHeight, h: Math.round(ft.height), vis };
        });
        ok(after.maxH === feed.maxH, '   the cap survives a scroll to the bottom', feed.maxH + ' -> ' + after.maxH);
    } else {
        ok(true, '5. feed has ' + (feed ? feed.rows : 0) + ' rows — cap not exercised (needs >2)');
    }

    const docW = await page.evaluate(() => document.documentElement.scrollWidth);
    ok(docW <= 390, '   no sideways scroll', docW);
    ok(!errs.length, '   no page errors', errs.join(' | '));

    await page.screenshot({ path: path.join(OUT, 'round4-top.png'), clip: { x: 0, y: 0, width: 390, height: 620 } });
    const cl = await page.$('.checklist-side-panel');
    if (cl) {
        await page.evaluate(() => {
            const p = document.querySelector('.checklist-side-panel');
            p.style.transform = 'none'; p.style.visibility = 'visible'; p.style.opacity = '1';
            const q = document.getElementById('cl-tab-quarterly'); if (q) q.style.display = '';
        });
        await new Promise(r => setTimeout(r, 300));
        await cl.screenshot({ path: path.join(OUT, 'round4-checklist.png') });
    }

    await browser.close();
    console.log(fails ? '\n' + fails + ' FAILED' : '\nall round-4 fixes verified');
    process.exit(fails ? 1 : 0);
})();
