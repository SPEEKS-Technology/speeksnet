// Round 14 of the phone review.
//
//   1. the feed's filter row holds ONE line for every filter, at every width
//   2. the filter control is sized for a phone, not by a desktop min-width
//   3. Add a document is gone from the phone (and still there on the desktop)
//   4. Quick Messages: title and X on one line, tabs on the next, No Deals cut
//
// The filter row is the interesting one: it only broke for SOME filter values,
// which is exactly the kind of thing a single screenshot misses. Every option is
// selected in turn, at four widths.
//
// NODE_PATH must point at a node_modules with puppeteer-core.
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const OUT = process.env.LV_SHOT_DIR || null;

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };

const boot = async (page, pg, w, role) => {
    await page.setViewport({ width: w, height: 800, isMobile: w <= 900, hasTouch: w <= 900, deviceScaleFactor: 2 });
    await page.evaluateOnNewDocument((r) => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Layout Harness');
        sessionStorage.setItem('speeksUserRole', r);
        sessionStorage.setItem('speeksUserStore', 'LEE');
    }, role || 'manager');
    await page.goto('file:///' + REPO + '/' + pg, { waitUntil: 'networkidle2' }).catch(() => {});
    await page.evaluate(() => {
        const o = document.getElementById('authOverlay'); if (o) o.style.display = 'none';
        document.body.classList.add('is-authenticated');
        document.body.classList.remove('preload', 'no-scroll');
        if (typeof applyRoleBasedUI === 'function') { try { applyRoleBasedUI(); } catch (e) {} }
    });
    // Modals scale and slide in; measuring during that reads interpolated values.
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
    await new Promise(r => setTimeout(r, 800));
};

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });

    // ------------------------------------------------ 1/2. the filter row
    console.log('\n### the feed filter row, every filter, every width');
    for (const w of [320, 360, 390, 430]) {
        const page = await browser.newPage();
        await boot(page, 'index.html', w);
        const r = await page.evaluate(() => {
            const modal = document.getElementById('notifDropdown');
            modal.classList.add('show'); modal.style.display = 'flex';
            const sel = document.getElementById('hubFilter');
            const host = sel.closest('.dd-host');
            const row = document.querySelector('#notifDropdown .hub-filter');
            const docs = document.querySelector('.hub-docs-btn');
            const count = document.getElementById('hubCount');
            const out = { rows: [], face: null };
            Array.from(sel.options).forEach(o => {
                // Through the face, the way a person changes it — this also
                // exercises _ddSync/_ddFit, which is what keeps the width stable.
                sel.value = o.value;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                const rr = row.getBoundingClientRect();
                const br = host._ddBtn.getBoundingClientRect();
                const dr = docs.getBoundingClientRect();
                out.rows.push({
                    label: o.text,
                    // One line: every child's top is the row's top.
                    oneLine: Math.abs(dr.top - br.top) < 2,
                    // And Documents is fully inside the row.
                    docsIn: dr.right <= rr.right + 1 && dr.left >= rr.left - 1,
                    btnW: Math.round(br.width),
                    count: count.textContent.trim(),
                    rowH: Math.round(rr.height),
                });
            });
            const br = host._ddBtn.getBoundingClientRect();
            out.face = { w: Math.round(br.width), h: Math.round(br.height),
                         f: parseFloat(getComputedStyle(host._ddBtn).fontSize) };
            return out;
        });
        const wrapped = r.rows.filter(x => !x.oneLine || !x.docsIn);
        // The control must not change width as the filter changes, or the row
        // reflows under your finger every time you use it.
        const widths = [...new Set(r.rows.map(x => x.btnW))];
        ok(wrapped.length === 0 && widths.length === 1,
            '@' + w + ': ' + r.rows.length + ' filters, one line each',
            wrapped.length ? 'WRAPS: ' + wrapped.map(x => x.label).join(', ')
                : 'control ' + widths[0] + 'px throughout, row ' + r.rows[0].rowH + 'px'
                  + ', count reads "' + r.rows[0].count + '" / "'
                  + r.rows.find(x => /Announce/.test(x.label)).count + '"');
        if (w === 390) ok(r.face.w <= 150 && r.face.h <= 36 && r.face.f <= 12,
            'and the control itself is phone-sized, not the 200px desktop floor',
            r.face.w + 'x' + r.face.h + ' at ' + r.face.f + 'px');
        await page.close();
    }
    // The desktop keeps its 200px.
    {
        const page = await browser.newPage();
        await boot(page, 'index.html', 1400);
        const d = await page.evaluate(() => {
            const m = document.getElementById('notifDropdown');
            m.classList.add('show'); m.style.display = 'flex';
            const h = document.getElementById('hubFilter').closest('.dd-host');
            const b = h._ddBtn.getBoundingClientRect();
            return { w: Math.round(b.width), noun: !!document.querySelector('.hub-count-w'),
                     nounShown: getComputedStyle(document.querySelector('.hub-count-w') || document.body).display };
        });
        ok(d.w === 200, 'the desktop control keeps its 200px', d.w + 'px');
        await page.close();
    }

    // ------------------------------------------------ 3. Add a document
    console.log('\n### Add a document');
    for (const [w, want] of [[390, 'none'], [1400, 'block']]) {
        const page = await browser.newPage();
        await boot(page, 'index.html', w);
        const r = await page.evaluate(() => {
            const host = document.getElementById('annDocsAdd');
            // The host collapses when empty, so it has to be filled to mean
            // anything — an empty box is display:none on the desktop too.
            host.innerHTML = '<button type="button" class="ann-doc-add-btn">+ Add a document</button>';
            document.getElementById('annDocsModal').classList.add('show');
            return { d: getComputedStyle(host).display,
                     h: Math.round(host.getBoundingClientRect().height) };
        });
        ok(r.d === want, '@' + w + ': ' + (want === 'none' ? 'gone' : 'still there'),
            'display: ' + r.d + ', ' + r.h + 'px tall');
        await page.close();
    }

    // ------------------------------------------------ 4. Quick Messages
    console.log('\n### Quick Messages');
    for (const w of [320, 390]) {
        const page = await browser.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(String(e).slice(0, 160)));
        await boot(page, 'index.html', w, 'district manager');
        const r = await page.evaluate(() => {
            const m = document.getElementById('quickMsgDropdown');
            m.classList.add('show'); m.style.display = 'flex';
            document.getElementById('qmContent').innerHTML = `
              <div class="qm-category-wrapper">
                <div class="qm-category open"><span> 🗂️ FACEBOOK MARKETPLACE</span><span class="qm-caret">▼</span></div>
                <div class="qm-category-items open">
                  <div class="qm-item"><div class="qm-item-header">
                    <div class="qm-item-name">Is this still available?</div>
                    <button class="qm-copy-btn">Copy</button></div>
                    <div class="qm-item-message open">Yes, it is still available.</div></div>
                </div>
              </div>`;
            const head = document.querySelector('#quickMsgDropdown > .modal-header');
            const h3 = head.querySelector('h3');
            const x = head.querySelector('.modal-close-btn');
            const tabs = head.querySelector('.notif-tabs');
            const btns = Array.from(tabs.querySelectorAll('.tab-btn'))
                .filter(b => b.getBoundingClientRect().width > 0);
            const hr = h3.getBoundingClientRect(), xr = x.getBoundingClientRect(),
                  tr = tabs.getBoundingClientRect(), mr = m.getBoundingClientRect();
            const tw = btns.map(b => Math.round(b.getBoundingClientRect().width));
            return {
                sameLine: Math.abs(hr.top - xr.top) < hr.height,
                tabsBelow: tr.top >= xr.bottom - 1,
                xOnScreen: xr.right <= innerWidth + 1 && xr.left >= -1 && xr.width > 0,
                titleLines: Math.round(hr.height / parseFloat(getComputedStyle(h3).lineHeight || 20)),
                titleH: Math.round(hr.height),
                noDeals: (() => { const b = document.getElementById('qm-tab-nodeals');
                    return getComputedStyle(b).display; })(),
                labels: btns.map(b => b.textContent.trim()),
                tabW: tw, tabH: Math.round(btns[0].getBoundingClientRect().height),
                tabsFit: tr.right <= mr.right + 1 && tabs.scrollWidth <= tabs.clientWidth + 1,
                bodyOver: (() => { const b = document.getElementById('qmContent');
                    return b.scrollWidth > b.clientWidth + 1; })(),
                oneCol: getComputedStyle(document.querySelector('.qm-category-items')).gridTemplateColumns,
                cat: Math.round(document.querySelector('.qm-category').getBoundingClientRect().height),
                copy: Math.round(document.querySelector('.qm-copy-btn').getBoundingClientRect().height),
            };
        });
        ok(r.sameLine && r.xOnScreen, '@' + w + ': the title and the X share the first line',
            'X ' + (r.xOnScreen ? 'on screen' : 'OFF SCREEN') + ', title ' + r.titleH + 'px tall');
        ok(r.tabsBelow && r.tabsFit, '@' + w + ': the tab strip has the second line to itself',
            r.labels.join(' | ') + '  widths [' + r.tabW.join(', ') + '] at ' + r.tabH + 'px');
        ok(r.noDeals === 'none' && !r.labels.includes('No Deals'), '@' + w + ': No Deals is cut',
            'display: ' + r.noDeals);
        ok(!r.bodyOver && r.oneCol.split(' ').length === 1,
            '@' + w + ': the body does not run off the side',
            'columns: ' + r.oneCol + ', category ' + r.cat + 'px, Copy ' + r.copy + 'px');
        ok(errs.length === 0, '@' + w + ': no page errors', errs.join(' | ') || 'none');
        if (OUT && w === 390) await page.screenshot({ path: OUT + '/r14-qm.png' });
        await page.close();
    }

    if (OUT) {
        const page = await browser.newPage();
        await boot(page, 'index.html', 390);
        await page.evaluate(() => {
            const m = document.getElementById('notifDropdown');
            m.classList.add('show'); m.style.display = 'flex';
            const s = document.getElementById('hubFilter');
            s.value = 'ann'; s.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.screenshot({ path: OUT + '/r14-filter.png' });
        await page.close();
    }

    await browser.close();
    console.log('\n' + (fails ? fails + ' FAILED' : 'round 14 is where it should be'));
    process.exit(fails ? 1 : 0);
})();
