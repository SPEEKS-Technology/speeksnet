// Where the dropdown lists actually LAND, and what the faces look like.
//
// dropdown-check.js proves the plumbing — value round-trips, one change event —
// and passed happily through two separate visual breakages:
//
//   1. a class-less <select> got raw browser button chrome, because the skin
//      deliberately set no looks of its own;
//   2. every list inside a modal opened 121px right and 91px low, because
//      position:fixed resolves against the nearest TRANSFORMED ancestor and
//      .modal-menu is transform: translate(-50%,-50%) scale(.95).
//
// So this one measures pixels. Modals are forced open so the controls inside
// them are real, which is where most of the site's selects live.
//
// NODE_PATH must point at the scratchpad's node_modules (puppeteer-core).
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const PAGES = ['index.html', 'operations.html', 'workspace.html', 'docs.html', 'stats.html'];

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });
    let total = 0;

    for (const pg of PAGES) {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 950 });
        const errs = [];
        page.on('pageerror', e => errs.push(String(e).slice(0, 140)));
        await page.evaluateOnNewDocument(() => {
            sessionStorage.setItem('speeksUnlocked', 'true');
            sessionStorage.setItem('speeksUserName', 'Layout Harness');
            sessionStorage.setItem('speeksUserRole', 'district manager');
            sessionStorage.setItem('speeksUserStore', 'LEE');
        });
        await page.goto('file:///' + REPO + '/' + pg, { waitUntil: 'networkidle2' }).catch(() => {});
        await page.evaluate(() => {
            const o = document.getElementById('authOverlay'); if (o) o.style.display = 'none';
            document.body.classList.add('is-authenticated');
            document.body.classList.remove('preload', 'no-scroll');
            if (typeof applyRoleBasedUI === 'function') { try { applyRoleBasedUI(); } catch (e) {} }
        });
        await new Promise(r => setTimeout(r, 1000));

        const rows = await page.evaluate(() => {
            const out = [];
            document.querySelectorAll('.dd-host').forEach(h => {
                if (!h._ddBtn) return;
                // Open the modal this control lives in, if any — otherwise most of
                // the site's selects measure 0 and the test proves nothing.
                const modal = h.closest('.modal-menu, .tools-side-panel, .checklist-side-panel');
                let restore = null;
                if (modal && !modal.classList.contains('show') && !modal.classList.contains('open')) {
                    restore = modal.style.display;
                    modal.classList.add(modal.classList.contains('modal-menu') ? 'show' : 'open');
                    if (modal.classList.contains('modal-menu')) modal.style.display = 'flex';
                }
                const br0 = h._ddBtn.getBoundingClientRect();
                if (!br0.width) {
                    if (modal && restore !== null) { modal.classList.remove('show', 'open'); modal.style.display = restore; }
                    return;
                }
                // A button below the fold cannot be clicked without scrolling
                // first, and placement happens on open against the viewport as it
                // is THEN — so an off-screen list here says nothing. Scroll it
                // into view and measure the case a person can actually reach.
                h._ddBtn.scrollIntoView({ block: 'center' });
                const br = h._ddBtn.getBoundingClientRect();
                h._ddBtn.click();
                const lr = h._ddList.getBoundingClientRect();
                const f = getComputedStyle(h._ddBtn);
                const flipped = lr.top < br.top;
                out.push({
                    id: h._ddSel.id || '(anon)',
                    dx: Math.round(lr.left - br.left),
                    dy: flipped ? Math.round(br.top - lr.bottom) : Math.round(lr.top - br.bottom),
                    flipped,
                    parked: h._ddList.parentElement === document.body,
                    onscreen: lr.right <= innerWidth + 1 && lr.left >= -1
                        && lr.bottom <= innerHeight + 1 && lr.top >= -1,
                    // The list IS the control, continued: same width, to the pixel.
                    widthGap: Math.round(lr.width - br.width),
                    // And what that costs. An option wider than the button it hangs
                    // off now ellipsises, so this counts the labels that no longer
                    // read in full — the number to look at before deciding the
                    // trade was worth it, per dropdown.
                    clipped: Array.from(h._ddList.children)
                        .filter(o => o.scrollWidth > o.clientWidth + 1)
                        .map(o => o.textContent),
                    font: parseFloat(f.fontSize),
                    weight: parseInt(f.fontWeight, 10),
                    inModal: !!h.closest('.modal-menu'),
                    // How many arrows are painted OVER the control. Several selects
                    // on this site were dressed by hand before the skin existed —
                    // a chevron drawn as a sibling (#notifDropdown .hub-chev) —
                    // and the face adds its own, so two showed a few pixels apart.
                    // Counted by overlap with the button, not by being in the same
                    // wrapper: a Documents paperclip at the far end of the same row
                    // is not a second arrow.
                    arrows: (function () {
                        const scope = h.parentElement || document.body;
                        return Array.from(scope.querySelectorAll('svg')).filter(sv => {
                            const q = sv.getBoundingClientRect();
                            return q.width > 0 && q.right > br.left && q.left < br.right
                                && q.bottom > br.top && q.top < br.bottom;
                        }).length;
                    })(),
                    // And the option labels must sit under the button's own label.
                    textAlign: (function () {
                        const cur = h.querySelector('.dd-cur');
                        const opt = h._ddList.querySelector('.dd-opt');
                        if (!cur || !opt) return 0;
                        const o = opt.getBoundingClientRect();
                        return Math.round(o.left + parseFloat(getComputedStyle(opt).paddingLeft)
                                          - cur.getBoundingClientRect().left);
                    })(),
                });
                h._ddBtn.click();
                out[out.length - 1].backHome = h._ddList.parentElement === h;
                if (modal && restore !== null) { modal.classList.remove('show', 'open'); modal.style.display = restore; }
            });
            return out;
        });

        console.log('\n### ' + pg + '  (' + rows.length + ' measurable, '
            + rows.filter(r => r.inModal).length + ' inside a transformed modal)');
        total += rows.length;
        const bad = f => rows.filter(f).map(r => r.id).join(', ');
        ok(!rows.some(r => Math.abs(r.dx) > 1), 'every list is left-aligned with its button', bad(r => Math.abs(r.dx) > 1) || 'all dx=0');
        ok(!rows.some(r => Math.abs(r.dy - 5) > 2), 'and sits 5px off it', bad(r => Math.abs(r.dy - 5) > 2) || 'all dy=5');
        ok(!rows.some(r => !r.onscreen), 'none opens off-screen', bad(r => !r.onscreen) || 'all inside the viewport');
        ok(!rows.some(r => !r.parked), 'each portals to <body> while open', bad(r => !r.parked) || 'all');
        ok(!rows.some(r => !r.backHome), 'and goes back to its host on close', bad(r => !r.backHome) || 'all');
        ok(!rows.some(r => Math.abs(r.widthGap) > 1), 'every list is exactly as wide as its button',
            rows.filter(r => Math.abs(r.widthGap) > 1).map(r => r.id + ' ' + (r.widthGap > 0 ? '+' : '') + r.widthGap + 'px').join(', ')
            || 'all match');
        // Reported, not asserted. Truncation is the price of matching widths and
        // the question is whether any REAL label is losing meaning, which is a
        // judgement — so the harness prints them rather than deciding.
        const clip = rows.filter(r => r.clipped.length);
        if (clip.length) console.log('       note: labels clipped to the button width — '
            + clip.map(r => r.id + ': ' + r.clipped.join(' / ')).join('  |  '));
        // The house control type. 16px/400 was the tell that a face had fallen
        // back to whatever block it happened to sit in.
        ok(!rows.some(r => r.font > 14.5 || r.weight < 500), 'every face uses control type, not body type',
            rows.filter(r => r.font > 14.5 || r.weight < 500).map(r => r.id + ' ' + r.font + '/' + r.weight).join(', ')
            || 'all <= 14.5px and >= 500 weight');
        ok(!rows.some(r => r.arrows !== 1), 'exactly one arrow is drawn on each control',
            rows.filter(r => r.arrows !== 1).map(r => r.id + ' has ' + r.arrows).join(', ') || 'all single');
        ok(!rows.some(r => Math.abs(r.textAlign) > 1), 'option labels line up with the button label',
            rows.filter(r => Math.abs(r.textAlign) > 1).map(r => r.id + ' off by ' + r.textAlign).join(', ') || 'all flush');
        ok(errs.length === 0, 'no page errors', errs.join(' | ') || 'none');
        await page.close();
    }

    await browser.close();
    console.log('\n' + total + ' dropdowns measured across 5 shells');
    console.log(fails ? fails + ' FAILED' : 'every dropdown lands where it should and looks like the site');
    process.exit(fails ? 1 : 0);
})();
