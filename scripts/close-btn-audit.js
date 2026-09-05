// Audit EVERY close ("X") control on the phone, as rendered.
//
// The report was "three different X buttons on mobile" (25 Aug), and a control
// that looks different has different numbers — so this measures instead of
// eyeballing. It found 10 distinct designs across 228 controls. The mobile layer
// had already forced the GEOMETRY to 30px, but its own comment said "Colours and
// hovers are left to those rules", and those rules are per-modal ID selectors —
// so the sizes matched and nothing else did.
//
// ⚠️ The decisive find was the GLYPH, not the CSS: Tools, Submit an Idea and the
// CRM modal drew a TEXT x where the other 220 drew a 15px SVG. Identical 30px
// boxes still read as three different buttons, and no stylesheet can fix that.
//
// ⚠️ Measures the rendered box (offsetWidth / getBoundingClientRect), never a
// stylesheet rule — same reason the dropdown harness asserts on .dd-btn and not
// on the <select> it covers.
//
//   NODE_PATH=$(npm root -g) node scripts/close-btn-audit.js [--width=390]
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const WIDTH = Number((process.argv.find(a => a.startsWith('--width=')) || '').split('=')[1]) || 390;
const PAGES = ['index.html', 'operations.html', 'workspace.html', 'stats.html', 'docs.html'];

const SEL = [
    '.modal-close-btn', '.tools-panel-close', '.cl-close', '.ex-close',
    '.lv-fs-close', '.bd-close', '.daily-bubble-close', '.goals-close-btn',
    '.award-video-close-btn', '.modal-header .close-btn',
].join(',');

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });
    const rows = [];
    for (const file of PAGES) {
        const page = await browser.newPage();
        await page.setViewport({ width: WIDTH, height: 900, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        await page.evaluateOnNewDocument(() => {
            sessionStorage.setItem('speeksUnlocked', 'true');
            sessionStorage.setItem('speeksUserName', 'Layout Harness');
            sessionStorage.setItem('speeksUserRole', 'district manager');
            sessionStorage.setItem('speeksUserStore', 'CORP');
        });
        await page.goto('file:///' + REPO + '/' + file, { waitUntil: 'networkidle2' }).catch(() => {});
        await page.evaluate(() => {
            const ov = document.getElementById('authOverlay'); if (ov) ov.style.display = 'none';
            document.documentElement.classList.remove('no-scroll');
            document.body.classList.remove('no-scroll', 'preload');
            document.body.classList.add('is-authenticated');
            if (typeof applyRoleBasedUI === 'function') { try { applyRoleBasedUI(); } catch (e) {} }
        });
        await new Promise(r => setTimeout(r, 700));

        const found = await page.evaluate((SEL) => {
            const out = [];
            // Force each control's hidden ancestors visible just long enough to get a
            // real box, then put every touched style back exactly as it was.
            document.querySelectorAll(SEL).forEach((el) => {
                const touched = [];
                for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
                    const cs = getComputedStyle(n);
                    if (cs.display === 'none' || cs.visibility === 'hidden') {
                        touched.push([n, n.style.display, n.style.visibility]);
                        n.style.display = (n.tagName === 'BUTTON' || n.tagName === 'SPAN') ? 'inline-flex' : 'block';
                        n.style.visibility = 'visible';
                    }
                }
                const cs = getComputedStyle(el);
                const svg = el.querySelector('svg');
                const scs = svg ? getComputedStyle(svg) : null;
                let owner = '';
                for (let n = el; n && n !== document.body; n = n.parentElement) {
                    if (n.id) { owner = '#' + n.id; break; }
                }
                out.push({
                    owner: owner || '(no id ancestor)',
                    cls: el.className && el.className.toString ? el.className.toString().slice(0, 46) : '',
                    w: Math.round(el.offsetWidth), h: Math.round(el.offsetHeight),
                    radius: cs.borderRadius,
                    bg: cs.backgroundColor,
                    color: cs.color,
                    border: cs.borderTopWidth === '0px' ? 'none' : (cs.borderTopWidth + ' ' + cs.borderTopColor),
                    glyph: svg ? ('svg ' + Math.round(parseFloat(scs.width)) + 'x' + Math.round(parseFloat(scs.height)))
                               : ('TEXT ' + cs.fontSize),
                });
                for (let i = touched.length - 1; i >= 0; i--) {
                    touched[i][0].style.display = touched[i][1];
                    touched[i][0].style.visibility = touched[i][2];
                }
            });
            return out;
        }, SEL);
        found.forEach(f => rows.push(Object.assign({ page: file }, f)));
        await page.close();
    }
    await browser.close();

    // Three buckets, because "one design" is not "one rule for every X".
    //   notRendered - data-mobile="hide" curates whole panels off the phone
    //                 (goalsSidePanel, auditSidePanel), so their X has no box at
    //                 all. Not a bug — but counted as a "design" it made the
    //                 verdict meaningless, which is why it is split out.
    //   dark        - the alert-bubble and over-video X keep white ink on purpose:
    //                 a pale grey chip on a coloured bubble, or over arbitrary
    //                 video, would clash or vanish. They must still agree with the
    //                 standard on BOX and GLYPH, and that IS asserted.
    //   standard    - everything else must be pixel-identical.
    const isDark = r => /daily-bubble-close|award-video-close-btn/.test(r.cls);
    const notRendered = rows.filter(r => r.w === 0 || r.h === 0);
    const dark = rows.filter(r => r.w && r.h && isDark(r));
    const std = rows.filter(r => r.w && r.h && !isDark(r));

    const sig = r => [r.w + 'x' + r.h, r.radius, r.bg, r.color, r.border, r.glyph].join(' | ');
    const box = r => [r.w + 'x' + r.h, r.radius, r.glyph].join(' | ');
    const uniq = (list, f) => [...new Set(list.map(f))];

    const show = (name, list, f) => {
        const g = uniq(list, f);
        console.log('\n' + name + ' — ' + list.length + ' control(s), ' + g.length + ' variant(s)');
        g.forEach(k => {
            const hit = list.filter(r => f(r) === k);
            console.log('   x' + String(hit.length).padStart(4) + '  ' + k);
            if (g.length > 1) {
                uniq(hit, r => r.page + '  ' + r.owner).slice(0, 6)
                    .forEach(w => console.log('          ' + w));
            }
        });
        return g;
    };

    console.log('\n=== close controls @' + WIDTH + 'px — ' + rows.length + ' found ===');
    const stdSigs = show('STANDARD', std, sig);
    const darkBox = show('DARK SURFACE (ink differs by design; box must match)', dark, box);
    show('NOT RENDERED ON PHONE (curated off; no box expected)', notRendered, r => r.owner);

    let bad = 0;
    if (stdSigs.length !== 1) {
        console.log('\nFAIL  ' + stdSigs.length + ' standard designs, expected 1');
        bad++;
    }
    const stdBox = std.length ? box(std[0]) : null;
    if (darkBox.length > 1) {
        console.log('\nFAIL  the dark-surface X-es disagree with each other on box/glyph');
        bad++;
    } else if (stdBox && darkBox.length === 1 && darkBox[0] !== stdBox) {
        console.log('\nFAIL  dark-surface box ' + darkBox[0] + '  !=  standard ' + stdBox);
        bad++;
    }
    if (std.some(r => r.glyph.startsWith('TEXT'))) {
        console.log('\nFAIL  a close control is drawing a TEXT glyph again — it will never '
            + 'match the SVG ones at the same box size');
        bad++;
    }
    console.log('\nVERDICT: ' + (bad ? 'FAIL' : 'PASS — one design, ' + stdBox));
    process.exitCode = bad ? 1 : 0;
})();
