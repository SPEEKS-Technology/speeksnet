// Mobile layout harness.
//
//   npm i puppeteer-core          (once, anywhere on the path; no repo package.json)
//   node scripts/mobile-check.js <page.html> [width] [--fake=role-manager] [--pin=1234] [--shot=out.png]
//
// Screenshots at phone width AND lists every element wider than the viewport —
// the thing a screenshot alone can never tell you, since an overflowing element
// looks identical to a correctly clipped one.
//
// Two traps this script exists to avoid, both of which produced confident wrong
// answers before it was written:
//   1. A narrow desktop window is NOT a phone. Without mobile emulation Chrome
//      ignores the viewport meta tag and reports overflow that does not exist.
//   2. speeks.js bounces every non-index page back to index.html when there is
//      no session, so measuring operations/workspace/docs/stats without a seeded
//      session silently measures index.html five times. --fake seeds it, and the
//      script shouts if it still lands somewhere else.
const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';

const args = process.argv.slice(2);
const page_ = args[0] || 'index.html';
const width = parseInt(args.find(a => /^\d+$/.test(a)) || '390', 10);
const pin = (args.find(a => a.startsWith('--pin=')) || '').split('=')[1];
const shot = (args.find(a => a.startsWith('--shot=')) || '').split('=')[1]
    || `${path.basename(page_, '.html')}-${width}.png`;

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    // isMobile:true already flips hover/pointer via touch emulation.

    page.on('console', m => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 160)); });

    // speeks.js:20611 bounces any non-index page back to index.html when there is
    // no session, so a fake session must exist BEFORE the document runs — not
    // after load. Without this every shell silently measures index.html instead.
    const fakeRole = (args.find(a => a.startsWith('--fake=')) || '').split('=')[1];
    if (fakeRole) {
        const role = fakeRole.replace(/^role-/, '').replace(/-/g, ' ');
        await page.evaluateOnNewDocument((role) => {
            sessionStorage.setItem('speeksUnlocked', 'true');
            sessionStorage.setItem('speeksUserName', 'Layout Harness');
            sessionStorage.setItem('speeksUserRole', role);
            sessionStorage.setItem('speeksUserStore', 'LEE');
        }, role);
    }

    await page.goto(`file:///${REPO}/${page_}`, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

    const landed = page.url().split('/').pop().split('#')[0];
    if (landed && landed !== page_) {
        console.log(`\n!! redirected: asked for ${page_}, landed on ${landed} — measurement below is NOT ${page_}`);
    }

    // Render the authenticated CHROME (nav, tab bar, panels) without credentials.
    // Layout only — widgets stay empty because no data was fetched. Use --pin=
    // for the real thing.
    const fake = fakeRole;
    if (fake) {
        await page.evaluate((roleClass) => {
            const ov = document.getElementById('authOverlay');
            if (ov) ov.style.display = 'none';
            document.documentElement.classList.remove('no-scroll');
            document.body.classList.remove('no-scroll', 'preload');
            document.body.classList.add('is-authenticated');
            document.body.style.overflow = '';
            document.body.style.position = '';
            document.querySelectorAll('.dynamic-module-flex, .dynamic-module-block, .dynamic-module')
                .forEach(m => {
                    const cls = Array.from(m.classList);
                    const roles = cls.filter(c => c.startsWith('role-'));
                    const ok = roles.length === 0 || roles.includes(roleClass);
                    const type = m.classList.contains('dynamic-module-flex') ? 'flex' : 'block';
                    m.style.setProperty('display', ok ? type : 'none', 'important');
                });
        }, fake);
        await new Promise(r => setTimeout(r, 800));
    }

    if (pin) {
        await page.waitForSelector('#pinInput', { timeout: 5000 }).catch(() => {});
        await page.type('#pinInput', pin, { delay: 40 });
        await page.keyboard.press('Enter');
        // give auth + the dashboard fetches a beat to land
        await new Promise(r => setTimeout(r, 6000));
    }

    const report = await page.evaluate((vw) => {
        const docW = document.documentElement.scrollWidth;
        const offenders = [];
        document.querySelectorAll('body *').forEach(el => {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return;
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return;
            const over = Math.round(r.right - vw);
            // Off-canvas panels (transform: translateX(105%)) sit entirely to the
            // right of the viewport by design — that is not overflow.
            if (r.left >= vw - 1) return;
            // Inside a deliberate horizontal scroller (tab strips, wide tables),
            // sticking out is the design, not a bug.
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
                const ox = getComputedStyle(p).overflowX;
                if (ox === 'auto' || ox === 'scroll') return;
            }
            // Genuinely too wide, or partially on screen and spilling past the edge.
            if (r.width > vw + 1 || over > 1) {
                offenders.push({
                    sel: el.tagName.toLowerCase()
                        + (el.id ? '#' + el.id : '')
                        + (el.className && typeof el.className === 'string'
                            ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''),
                    w: Math.round(r.width),
                    right: Math.round(r.right),
                    over,
                    minW: cs.minWidth,
                    maxW: cs.maxWidth,
                });
            }
        });
        // Keep the widest 25, deepest-first is noisy — sort by overflow
        offenders.sort((a, b) => b.over - a.over);
        return { docW, vw, count: offenders.length, top: offenders.slice(0, 25) };
    }, width);

    console.log(`\n=== ${page_} @ ${width}px ===`);
    console.log(`document scrollWidth: ${report.docW}  (viewport ${report.vw})`);
    console.log(`elements overflowing: ${report.count}`);
    for (const o of report.top) {
        console.log(`  +${String(o.over).padStart(4)}px  w=${String(o.w).padStart(4)}  ${o.sel}`
            + (o.minW !== '0px' ? `  min-width:${o.minW}` : '')
            + (o.maxW !== 'none' ? `  max-width:${o.maxW}` : ''));
    }

    await page.screenshot({ path: shot, fullPage: false });
    console.log(`\nscreenshot -> ${shot}`);
    await browser.close();
})();
