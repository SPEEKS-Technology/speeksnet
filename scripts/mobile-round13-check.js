// Round 13 of the phone review.
//
//   1. the three nav-bar tools and Sign Out are evenly spaced
//   2. what the nav bar opens comes in from the side, like the panels do
//   3. the Feed and its Documents subview are sized for a phone
//   4. one back control, one close control
//   5. the emoji picker stays on screen
//
// The feed and the documents list are both fed from the network, so both are
// seeded with synthetic rows here — measuring an empty "Syncing your feed..."
// panel would pass every size assertion without rendering a single card, which
// is the trap the Listing Goals check fell into in round 9.
//
// NODE_PATH must point at a node_modules with puppeteer-core.
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const OUT = process.env.LV_SHOT_DIR || null;

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };

const boot = async (page, pg, w, role) => {
    await page.setViewport({ width: w, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
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
        if (typeof applyMobileCuration === 'function') { try { applyMobileCuration(); } catch (e) {} }
    });
    await new Promise(r => setTimeout(r, 800));
};

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });

    // ---------------------------------------------------------------- 1. nav
    console.log('\n### the nav bar, evenly spaced');
    for (const [pg, w] of [['index.html', 320], ['index.html', 390], ['operations.html', 320], ['operations.html', 430]]) {
        const page = await browser.newPage();
        await boot(page, pg, w);
        const r = await page.evaluate(() => {
            const nav = document.querySelector('.nav-right');
            const items = Array.from(nav.querySelectorAll('.user-profile-nav > *, .sign-out-mini'))
                .filter(el => {
                    const b = el.getBoundingClientRect(), c = getComputedStyle(el);
                    // The row carries two alert bubbles positioned OVER it
                    // (#dailyMessageBubble, #claimAlertBubble). They have a box
                    // but they are not part of the rhythm, and counting them
                    // reported a 156px negative gap.
                    if (c.position === 'absolute' || c.position === 'fixed') return false;
                    return b.width > 0 && b.height > 0 && c.visibility !== 'hidden';
                })
                .map(el => el.getBoundingClientRect()).sort((a, b) => a.left - b.left);
            const gaps = [];
            for (let i = 1; i < items.length; i++) gaps.push(Math.round(items[i].left - items[i - 1].right));
            return { gaps, n: items.length, over: Math.round(nav.getBoundingClientRect().right) > innerWidth };
        });
        // Sub-pixel: one clamp, evaluated once, so every gap is the same number
        // give or take rounding. A 16px stranded padding was what made the last
        // one three times the others.
        const spread = Math.max(...r.gaps) - Math.min(...r.gaps);
        ok(spread <= 2 && !r.over, pg + ' @' + w + ': ' + r.n + ' controls, one rhythm',
            '[' + r.gaps.join(', ') + '] spread ' + spread + 'px' + (r.over ? ' OVERFLOWS' : ''));
        await page.close();
    }

    // ------------------------------------------------- 2. the side entrance
    console.log('\n### what the top bar opens, and how it arrives');
    {
        const page = await browser.newPage();
        await boot(page, 'index.html', 390);
        const r = await page.evaluate(() => {
            const ids = ['ideaModal', 'quickMsgDropdown', 'notifDropdown', 'annDocsModal',
                         'hotkeysDropdown', 'calendarDropdown', 'settingsModal'];
            const out = {};
            // The declared animation, read BEFORE anything is frozen.
            out._anim = (() => { const c = getComputedStyle(document.getElementById('ideaModal'));
                return c.transitionProperty + ' / ' + c.transitionDuration + ' / '
                     + c.transitionTimingFunction; })();
            // Then freeze, because getComputedStyle during a transition returns
            // the interpolated value — every modal read as "still parked off to
            // the right" a millisecond after being told to open.
            const freeze = document.createElement('style');
            freeze.textContent = '*, *::before, *::after { transition: none !important; '
                               + 'animation: none !important; }';
            document.head.appendChild(freeze);
            ids.forEach(id => {
                const el = document.getElementById(id);
                if (!el) return (out[id] = 'missing');
                const shut = getComputedStyle(el).transform;
                el.classList.add('show');
                const open = getComputedStyle(el).transform;
                el.classList.remove('show');
                // matrix(a,b,c,d,tx,ty) — the closed state must be parked a full
                // width to the RIGHT (tx > 0, ty == 0) and open at rest.
                const m = s => (s.match(/matrix\(([^)]+)\)/) || [, ''])[1].split(',').map(Number);
                const a = m(shut), b = m(open);
                out[id] = { shutX: Math.round(a[4] || 0), shutY: Math.round(a[5] || 0),
                            openX: Math.round(b[4] || 0), openY: Math.round(b[5] || 0) };
            });
            // And one that is NOT opened from the nav: still a bottom sheet.
            const lg = document.getElementById('listingGoalsModal');
            if (lg) {
                const m = getComputedStyle(lg).transform.match(/matrix\(([^)]+)\)/);
                const v = m ? m[1].split(',').map(Number) : [];
                out._listingGoals = { shutX: Math.round(v[4] || 0), shutY: Math.round(v[5] || 0) };
            }
            return out;
        });
        const nav = Object.keys(r).filter(k => k[0] !== '_');
        const bad = nav.filter(k => !(r[k] && r[k].shutX > 100 && r[k].shutY === 0
                                      && r[k].openX === 0 && r[k].openY === 0));
        ok(bad.length === 0, 'every nav-bar surface slides in from the right',
            bad.length ? bad.map(k => k + ' ' + JSON.stringify(r[k])).join(', ')
                       : nav.length + ' surfaces, parked at +' + r[nav[0]].shutX + 'px');
        // Same curve and duration as .tools-side-panel, or it is a different
        // entrance that merely happens to come from the same direction.
        ok(/transform/.test(r._anim) && /0\.3s/.test(r._anim)
            && /cubic-bezier\(0\.25, 0\.46, 0\.45, 0\.94\)/.test(r._anim),
            'on the panels\' own curve and duration', r._anim);
        ok(r._listingGoals && r._listingGoals.shutX === 0 && r._listingGoals.shutY !== 0,
            'and a modal opened from the page still rises from the bottom',
            JSON.stringify(r._listingGoals));
        await page.close();
    }

    // ------------------------------------------ 3/4/5. the feed + documents
    console.log('\n### the Feed and Documents on a phone');
    {
        const page = await browser.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(String(e).slice(0, 160)));
        await boot(page, 'index.html', 390);
        // Same freeze, same reason: the sizes below are measured on surfaces
        // that are now mid-slide when they are first shown.
        await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; '
                                        + 'animation: none !important; }' });
        const r = await page.evaluate(() => {
            // Seed both surfaces. Neither renders anything without data, and a
            // panel showing "Syncing..." measures small enough to pass anything.
            const feed = document.getElementById('hubFeed');
            feed.innerHTML = `
              <div class="hub-item t-ann"><div class="hub-row">
                <div class="hub-tico"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg></div>
                <div class="hub-col">
                  <div class="hub-item-top"><span class="hub-item-title">Mission Statement</span>
                    <span class="hub-meta-r">August 17, 2026</span></div>
                  <div class="hub-kind-meta"><span class="hub-kind">Announcement</span> · Paul Kushnir</div>
                  <div class="hub-item-body">Team, wanted to take a minute and remind everyone of our
                    Mission Statement here at PayMore, and what it means day to day on the floor.</div>
                  <div class="hub-foot">
                    <div class="ann-reactions" id="reactions_x">
                      <button class="reaction-btn reacted" style="display:flex"><span>🔥</span> <span class="count">9</span></button>
                      <button class="reaction-btn" style="display:flex"><span>👍</span> <span class="count">4</span></button>
                      <button class="reaction-btn" style="display:flex"><span>🎉</span> <span class="count">2</span></button>
                      <button class="reaction-btn" style="display:flex"><span>👀</span> <span class="count">7</span></button>
                      <div class="reaction-picker-wrapper" style="position:relative">
                        <button class="add-reaction-btn" onclick="toggleReactionPicker('x')">
                          <svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="10"/></svg></button>
                        <div class="reaction-picker-popover" id="picker_x">
                          <button>👍</button><button>🎉</button><button>👀</button>
                          <button>🔥</button><button>🫡</button><button>💵</button>
                        </div>
                      </div>
                    </div>
                    <button class="hub-markread">Mark as read</button>
                  </div>
                </div></div></div>`;
            document.getElementById('notifDropdown').classList.add('show');

            const docs = document.getElementById('annDocsModal');
            docs.querySelector('#annDocsTabs').innerHTML =
                '<button class="ann-docs-tab active">Goals &amp; Bonuses <em>3</em></button>'
              + '<button class="ann-docs-tab">Other Documents <em>2</em></button>';
            docs.querySelector('#annDocsList').innerHTML = [1, 2, 3].map(i => `
              <div class="ann-doc-card">
                <div class="ann-doc-badge" style="background:#2b579a">DOCX</div>
                <div class="ann-doc-card-info">
                  <div class="ann-doc-card-name">August 2026 Team Goals and Bonus</div>
                  <div class="ann-doc-card-meta">August 2026 Team Goals and Bonus · Ethan Kushnir · August 1, 2026</div>
                </div>
                <a class="ann-doc-dl-btn" href="#">Download</a>
              </div>`).join('');
            docs.querySelector('.ann-docs-search').style.display = 'flex';

            const px = s => { const e = document.querySelector(s); if (!e) return null;
                const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height),
                    f: parseFloat(getComputedStyle(e).fontSize) }; };

            // the picker, opened from a button at the right-hand end of a card
            const btn = document.querySelector('#reactions_x .add-reaction-btn');
            toggleReactionPicker('x');
            const p = document.getElementById('picker_x');
            const pr = p.getBoundingClientRect();
            const card = document.querySelector('.hub-item').getBoundingClientRect();
            const pick = {
                onScreen: pr.left >= -1 && pr.right <= innerWidth + 1 && pr.top >= -1 && pr.bottom <= innerHeight + 1,
                parked: p.parentElement === document.body,
                escapesCard: pr.right > card.right - 1 || pr.left < card.left + 1 || pr.top < card.top,
                box: Math.round(pr.left) + ',' + Math.round(pr.top) + ' '
                   + Math.round(pr.width) + 'x' + Math.round(pr.height),
                cardBox: Math.round(card.left) + '-' + Math.round(card.right),
                emoji: p.querySelectorAll('button').length,
                btnLeft: Math.round(btn.getBoundingClientRect().left),
                naiveRight: Math.round(btn.getBoundingClientRect().left + pr.width),
                pulledBack: Math.round(btn.getBoundingClientRect().left + pr.width) > innerWidth
                    && pr.right <= innerWidth + 1 && pr.width > 200,
                allVisible: Array.from(p.querySelectorAll('button')).every(b2 => {
                    const q = b2.getBoundingClientRect();
                    return q.right <= pr.right + 1 && q.left >= pr.left - 1 && q.width > 8;
                }),
            };
            toggleReactionPicker('x');
            const home = document.getElementById('picker_x').parentElement.className;

            docs.classList.add('show');
            const out = {
                pick, home,
                hubHi: px('#notifDropdown .hub-hi'),
                hubH3: px('#notifDropdown .hub-title-wrap h3'),
                hubTico: px('#notifDropdown .hub-tico'),
                hubTitle: px('#notifDropdown .hub-item-title'),
                hubBody: px('#notifDropdown .hub-item-body'),
                docsBtn: px('.hub-docs-btn'),
                back: px('#annDocsModal .ann-docs-back-btn'),
                backSvg: !!document.querySelector('#annDocsModal .ann-docs-back-btn svg'),
                backText: document.querySelector('#annDocsModal .ann-docs-back-btn').textContent.trim(),
                tab: px('.ann-docs-tab'),
                badge: px('.ann-doc-badge'),
                docName: px('.ann-doc-card-name'),
                dl: px('.ann-doc-dl-btn'),
                searchInput: px('.ann-docs-search input'),
                tall: (function () {
                    const want = {
                        '#notifDropdown .dd-btn': 34, '#notifDropdown .reaction-btn': 26,
                        '#notifDropdown .add-reaction-btn': 26, '.hub-docs-btn': 30,
                        '#notifDropdown .hub-markread': 22, '.ann-docs-tab': 30,
                        '#annDocsModal .ann-docs-back-btn': 22, '.ann-docs-search input': 30,
                    };
                    const bad = [];
                    Object.keys(want).forEach(k => {
                        const e = document.querySelector(k);
                        if (!e) return bad.push(k + ' MISSING');
                        const h = Math.round(e.getBoundingClientRect().height);
                        // A ceiling, not an exact number: what matters is that
                        // none of them is still standing at 44.
                        if (h > want[k] + 4) bad.push(k.replace('#notifDropdown ', '') + ' ' + h + 'px');
                    });
                    return bad;
                })(),
                // Every close control on the phone, one geometry and one look.
                closes: Array.from(document.querySelectorAll(
                    '#notifDropdown .modal-close-btn, #annDocsModal .modal-close-btn'))
                    .map(e => { const b = e.getBoundingClientRect(); const c = getComputedStyle(e);
                        return Math.round(b.width) + 'x' + Math.round(b.height)
                             + ' ' + c.borderRadius + ' ' + c.backgroundColor; }),
            };
            return out;
        });

        ok(r.pick.parked && r.pick.onScreen && r.pick.allVisible,
            'the emoji picker stays on screen with the + at the right-hand end',
            r.pick.box + ' in a card at ' + r.pick.cardBox + ', ' + r.pick.emoji + ' emoji, all drawn');
        // The + is at the right-hand end of the footer, so a popover anchored to
        // it and left-aligned would have run past the card. It has to have been
        // pulled back rather than clipped: still full width, still inside.
        ok(r.pick.pulledBack, 'and was pulled back inside rather than cut off',
            'button at ' + r.pick.btnLeft + ', popover at ' + r.pick.box.split(',')[0]
            + ' (naive left edge would have ended at ' + r.pick.naiveRight + ')');
        ok(r.home === 'reaction-picker-wrapper', 'and goes home when it closes', r.home);
        ok(r.backSvg && r.backText === 'Back', 'the Documents back control is the house one (chevron, no glyph)',
            (r.backSvg ? 'svg + ' : 'NO SVG + ') + '"' + r.backText + '"');
        ok(new Set(r.closes).size === 1, 'the Feed X and the Documents X are the same control',
            r.closes.join('  vs  '));
        // Sizes: against the numbers the earlier rounds settled on elsewhere.
        const sized = [
            ['hub icon tile', r.hubHi.w, 28], ['feed title', r.hubH3.f, 15],
            ['card icon tile', r.hubTico.w, 28], ['card title', r.hubTitle.f, 13.5],
            ['card body', r.hubBody.f, 12.5], ['Documents button', r.docsBtn.f, 11.5],
            ['docs tab', r.tab.h, 30], ['file badge', r.badge.w, 30],
            ['file name', r.docName.f, 12.5], ['Download', r.dl.f, 11],
        ];
        const off = sized.filter(([, got, want]) => Math.abs(got - want) > 0.6);
        ok(off.length === 0, 'the Feed and Documents came down a size',
            off.length ? off.map(([n, g, w]) => n + ' ' + g + ' (want ' + w + ')').join(', ')
                       : sized.map(([n, g]) => n + ' ' + g).join(', '));
        ok(r.searchInput.f >= 16, 'and the search box keeps 16px text, so iOS does not zoom it',
            r.searchInput.f + 'px');
        ok(r.tall.length === 0, 'and nothing in either surface is still a 44px slab',
            r.tall.length ? r.tall.join(', ') : 'all 8 controls under their ceiling');
        ok(errs.length === 0, 'no page errors', errs.join(' | ') || 'none');

        if (OUT) {
            await page.evaluate(() => { document.getElementById('annDocsModal').classList.remove('show'); });
            await page.screenshot({ path: OUT + '/r13-feed.png' });
            await page.evaluate(() => {
                document.getElementById('notifDropdown').classList.remove('show');
                document.getElementById('annDocsModal').classList.add('show');
            });
            await page.screenshot({ path: OUT + '/r13-docs.png' });
        }
        await page.close();
    }

    await browser.close();
    console.log('\n' + (fails ? fails + ' FAILED' : 'round 13 is where it should be'));
    process.exit(fails ? 1 : 0);
})();
