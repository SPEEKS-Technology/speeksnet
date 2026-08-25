// Round 15 of the phone review.
//
//   1. the feed settles once instead of jumping per arriving notification
//   2. the Listing Goals date is centred in its pill — the GLYPHS, not the box
//   3. the employee Listing Goals popup is phone-sized and lays out side by side
//   4. the Quick Messages review-SOP banner fits
//   5. the bottom tab reads Quick Portal, on one line, at 320
//   6. the MSM store toggle matches the rest of the nav row
//
// NODE_PATH must point at a node_modules with puppeteer-core.
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const OUT = process.env.LV_SHOT_DIR || null;

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };

const boot = async (page, pg, w, role, freeze) => {
    await page.setViewport({ width: w, height: 840, isMobile: w <= 900, hasTouch: w <= 900, deviceScaleFactor: 2 });
    await page.evaluateOnNewDocument((r) => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Ethan Kushnir');
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
    // Off by default: the point of test 1 is the animation timing.
    if (freeze !== false) await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
    await new Promise(r => setTimeout(r, 900));
};

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });

    // -------------------------------------------------- 1. the feed settling
    console.log('\n### the feed, while five notifications arrive');
    {
        const page = await browser.newPage();
        await boot(page, 'index.html', 390, 'manager');
        const r = await page.evaluate(async () => {
            const feed = document.getElementById('samFeed');
            const deck = document.querySelector('.speeks-action-menu');
            if (!feed) return { err: 'no #samFeed' };
            // Re-open the settle window: booting the harness already used it up.
            // Re-open the settle window. It is on window precisely so this works —
            // as a top-level `let` it was invisible from out here, and the test
            // silently measured the post-settle rAF path instead.
            window._samSettleUntil = Date.now() + 2500;
            let paints = 0;
            const realNow = window._samRenderFeedNow;
            // Count what actually reaches the DOM, not what was requested.
            window._samRenderFeedNow = function () { paints++; return realNow.apply(this, arguments); };

            // Every distinct deck height the page passes through. That is what
            // "jumping around" is: each one is content moving under a thumb.
            const seen = [];
            const sample = () => {
                const h = Math.round(deck.getBoundingClientRect().height);
                if (seen[seen.length - 1] !== h) seen.push(h);
            };
            const tick = setInterval(sample, 40);

            window._samAnnData = [];
            window._samAnnHidden = new Set();
            // Alternating short and tall cards, because the two-row cap is
            // measured off whichever two are on top — a mix is what made the
            // deck resize rather than just grow.
            const mk = (i, long) => ({
                rowId: 'r' + i, author: 'Paul Kushnir',
                date: new Date(Date.now() - i * 3600000).toISOString(),
                text: '<strong>Notification ' + i + '</strong>'
                    + (long ? 'A longer body that wraps onto three or four lines on a phone, '
                            + 'the way a real store message or a patch note does.' : 'Short.'),
            });
            const delays = [0, 250, 600, 950, 1400];
            for (let i = 0; i < delays.length; i++) {
                await new Promise(r => setTimeout(r, i ? delays[i] - delays[i - 1] : 0));
                // unshift: newest first, so each arrival lands ON TOP and changes
                // which two rows the cap is measured from. The bad case.
                window._samAnnData.unshift(mk(i + 1, i % 2 === 0));
                renderActionFeed();
            }
            await new Promise(r => setTimeout(r, 900));
            clearInterval(tick);
            sample();
            window._samRenderFeedNow = realNow;
            return { paints, heights: seen, cards: feed.children.length };
        });
        // Five staggered arrivals used to be five paints and a height change on
        // most of them. One or two settles is the target; three is still fine.
        ok(r.paints <= 3, 'five staggered arrivals collapse into a couple of paints',
            r.paints + ' paints for 5 arrivals');
        ok(r.heights.length <= 3, 'and the deck settles instead of resizing on each',
            r.heights.length + ' distinct heights: ' + r.heights.join(' → '));
        await page.close();
    }

    // ------------------------------------------------ 2. the date pill
    console.log('\n### the Listing Goals date pill');
    for (const w of [390, 1400]) {
        const page = await browser.newPage();
        await boot(page, 'index.html', w, 'manager');
        const r = await page.evaluate(() => {
            const m = document.getElementById('listingGoalsModal');
            m.classList.add('show'); m.style.display = 'flex';
            const d = document.getElementById('goals-date-display');
            d.textContent = 'WEDNESDAY, AUG 19';
            const pill = m.querySelector('.goals-title-wrapper');
            const pr = pill.getBoundingClientRect();
            // The GLYPHS, not the element box. The box can be centred while the
            // ink is not — an empty sibling and a stray margin were doing exactly
            // that, and an element-box measurement said it was fine.
            const rg = document.createRange();
            rg.selectNodeContents(d);
            const tr = rg.getBoundingClientRect();
            return {
                left: Math.round((tr.left - pr.left) * 10) / 10,
                right: Math.round((pr.right - tr.right) * 10) / 10,
                pill: Math.round(pr.width), text: Math.round(tr.width),
            };
        });
        ok(Math.abs(r.left - r.right) <= 1.5, '@' + w + ': the date sits in the middle of its pill',
            r.left + 'px left of the ink, ' + r.right + 'px right (pill ' + r.pill + ', text ' + r.text + ')');
        await page.close();
    }

    // ------------------------------------- 3. the employee goals popup
    console.log('\n### the employee Listing Goals popup');
    for (const w of [320, 390]) {
        const page = await browser.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(String(e).slice(0, 160)));
        await boot(page, 'index.html', w, 'employee');
        const r = await page.evaluate(() => {
            const m = document.getElementById('empGoalsModal');
            m.classList.add('show'); m.style.display = 'flex';
            // The body is rendered from network data; seed the airy markup so the
            // sizes below mean something. (Round 9: a role-gated card measured 0
            // and passed every "is it smaller" assertion in silence.)
            document.getElementById('employee-goals-widget-body').innerHTML = `
              <div class="emp-goals-top-row">
                <div class="emp-goal-col"><span class="emp-goal-label">Today's Target</span>
                  <span class="emp-goal-value">3</span></div>
                <div class="emp-goal-col"><span class="emp-goal-label">My Role</span>
                  <span class="emp-goal-value">Buyer 1</span></div>
              </div>
              <div class="emp-role-description">You're the lead buyer — first up for every customer
                who walks through the door.</div>
              <div class="emp-week-section"><div class="emp-week-head">
                <span class="emp-goal-label">This Week's Goals</span>
                <span class="emp-week-total">39</span></div>
                <div class="emp-pill-container">${['Mon: 18','Tue: 18','Wed: 3','Thu','Fri','Sat','Sun']
                  .map((d,i)=>'<div class="emp-daily-pill'+(i<3?' pill-goal':' pill-future')+'">'+d+'</div>').join('')}</div>
              </div>
              <div class="goals-levelup"><div class="lu-head"><span class="lu-title">Last 4 Weeks</span></div>
                <div class="lu-weeks">${[137,144,104,106].map(n=>'<div class="lu-week red">'
                  +'<span class="lu-week-num">'+n+'</span></div>').join('')}</div></div>`;
            document.getElementById('emp-goals-date').textContent = 'WED, AUG 19';
            document.getElementById('emp-goals-store-target').textContent = '181 Listings';
            const px = s => { const e = m.querySelector(s); if (!e) return null;
                const b = e.getBoundingClientRect();
                return { w: Math.round(b.width), h: Math.round(b.height),
                         f: parseFloat(getComputedStyle(e).fontSize) }; };
            const cols = Array.from(m.querySelectorAll('.emp-goal-col'))
                .map(e => e.getBoundingClientRect());
            const body = m.querySelector('.manage-content');
            return {
                sideBySide: cols.length === 2 && Math.abs(cols[0].top - cols[1].top) < 2,
                colW: cols.map(c => Math.round(c.width)),
                dir: getComputedStyle(m.querySelector('.emp-goals-top-row')).flexDirection,
                h3: px('.modal-header h3'), goal: px('.emp-goals-banner-goal'),
                val: px('.emp-goal-value'), lu: px('.lu-week'), luN: px('.lu-week-num'),
                pill: px('.emp-daily-pill'),
                over: body.scrollWidth > body.clientWidth + 1,
            };
        });
        ok(r.sideBySide && r.dir === 'row', '@' + w + ': the two stat cards share a row',
            r.dir + ', ' + r.colW.join('px + ') + 'px');
        const want = [['title', r.h3.f, 15], ['goal', r.goal.f, 14], ['stat value', r.val.f, 15],
                      ['week block', r.lu.h, 34], ['week number', r.luN.f, 13], ['day pill', r.pill.f, 8.5]];
        const off = want.filter(([, g, x]) => Math.abs(g - x) > 0.6);
        ok(off.length === 0 && !r.over, '@' + w + ': and everything came down a size',
            off.length ? off.map(([n, g, x]) => n + ' ' + g + ' (want ' + x + ')').join(', ')
                       : want.map(([n, g]) => n + ' ' + g).join(', '));
        ok(errs.length === 0, '@' + w + ': no page errors', errs.join(' | ') || 'none');
        if (OUT && w === 390) await page.screenshot({ path: OUT + '/r15-empgoals.png' });
        await page.close();
    }

    // ----------------------------------- 4/5/6. banner, tab label, MSM
    console.log('\n### the SOP banner, the tab label and the store toggle');
    for (const w of [320, 390]) {
        const page = await browser.newPage();
        await boot(page, 'index.html', w, 'manager');
        const r = await page.evaluate(() => {
            // --- the Reviews SOP banner
            const m = document.getElementById('quickMsgDropdown');
            m.classList.add('show'); m.style.display = 'flex';
            document.getElementById('qmContent').innerHTML = `
              <div class="qm-sop-banner" style="margin-bottom:15px;background:#fffbeb;border:1px solid #fde68a;padding:15px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;">
                <div class="qm-sop-copy" style="display:flex;flex-direction:column;gap:4px;">
                  <span class="qm-sop-t" style="font-size:13px;font-weight:900;color:#92400e;">Handling a Sub-5-Star Review?</span>
                  <span class="qm-sop-s" style="font-size:11px;font-weight:700;color:#b45309;">Follow the SOP for mixed or negative feedback before replying.</span></div>
                <a class="mini-action-btn qm-sop-cta" style="background:white;border-color:#fde68a;color:#92400e;">View Process ↗</a></div>`;
            const ban = document.querySelector('.qm-sop-banner');
            const cta = document.querySelector('.qm-sop-cta');
            const copy = document.querySelector('.qm-sop-copy');
            const br = ban.getBoundingClientRect(), cr = cta.getBoundingClientRect(),
                  yr = copy.getBoundingClientRect();
            const ccs = getComputedStyle(cta);
            const ctaLine = parseFloat(ccs.lineHeight) || 16;
            const ctaBox = parseFloat(ccs.paddingTop) + parseFloat(ccs.paddingBottom)
                         + parseFloat(ccs.borderTopWidth) + parseFloat(ccs.borderBottomWidth);
            m.classList.remove('show'); m.style.display = '';

            // --- the bottom tab bar
            const home = document.querySelector('.nav-bar .nav-link[data-m]');
            const hr = home.getBoundingClientRect();
            const cs = getComputedStyle(home, '::after');
            // Measure the label's own ink: ::after content cannot be ranged, so
            // the same string is drawn on canvas at the same type.
            const ctx = document.createElement('canvas').getContext('2d');
            ctx.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + getComputedStyle(home).fontFamily;
            const label = home.getAttribute('data-m');
            const tabs = Array.from(document.querySelectorAll('.nav-bar .nav-link'))
                .filter(a => a.getBoundingClientRect().width > 0);

            // --- the MSM toggle. Only rendered for a multi-store manager, so it
            // is forced here rather than faking the role: the question is the
            // SIZE of the control, not who gets it.
            const sw = document.querySelector('.msm-store-switch');
            sw.innerHTML = '<button class="msm-seg active">BAL</button><button class="msm-seg">MPL</button>';
            sw.style.display = 'flex';
            const segs = Array.from(sw.querySelectorAll('.msm-seg')).map(b => b.getBoundingClientRect());
            const other = document.querySelector('.top-nav .user-profile-nav .action-btn');
            const or_ = other.getBoundingClientRect();

            return {
                banStacked: cr.top >= yr.bottom - 1,
                ctaFull: cr.width >= br.width - 26,
                // One line means one line-height plus the button's own box — not a
            // guessed multiple of the line height, which called a 36px button
            // with 16px of padding "two lines".
            ctaOneLine: cr.height <= ctaLine + ctaBox + 1,
                banW: Math.round(br.width), ctaW: Math.round(cr.width),
                label, tabCount: tabs.length, tabW: Math.round(hr.width),
                labelW: Math.round(ctx.measureText(label).width),
                labelFits: ctx.measureText(label).width <= hr.width - 8,
                swH: Math.round(sw.getBoundingClientRect().height),
                segH: Math.round(segs[0].height), segW: Math.round(segs[0].width),
                otherH: Math.round(or_.height),
                swMr: getComputedStyle(sw).marginRight,
            };
        });
        ok(r.banStacked && r.ctaFull && r.ctaOneLine,
            '@' + w + ': the SOP banner stacks and its button is full width on one line',
            'banner ' + r.banW + ', button ' + r.ctaW);
        ok(r.labelFits, '@' + w + ': "' + r.label + '" fits its tab on one line',
            r.labelW + 'px of label in a ' + r.tabW + 'px tab (' + r.tabCount + ' tabs)');
        ok(Math.abs(r.swH - r.otherH) <= 1 && r.swMr === '0px',
            '@' + w + ': the store toggle is the same height as the nav buttons beside it',
            r.swH + 'px vs ' + r.otherH + 'px, segments ' + r.segW + 'x' + r.segH);
        await page.close();
    }

    await browser.close();
    console.log('\n' + (fails ? fails + ' FAILED' : 'round 15 is where it should be'));
    process.exit(fails ? 1 : 0);
})();
