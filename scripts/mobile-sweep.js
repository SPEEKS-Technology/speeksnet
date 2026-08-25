// Width x page x role overflow sweep, ONE browser for the whole grid.
// scripts/mobile-check.js launches Chrome per invocation, which is ~6s a shot and
// times out long before a full grid finishes.
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';

const PAGES = ['index.html', 'operations.html', 'workspace.html', 'docs.html', 'stats.html'];
const WIDTHS = [320, 360, 375, 390, 414, 430];
const ROLES = process.argv.slice(2).length ? process.argv.slice(2)
    : ['district manager', 'manager', 'employee', 'ceo'];

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });
    let total = 0;
    for (const role of ROLES) {
        console.log('\n### ' + role);
        console.log('page'.padEnd(17) + WIDTHS.map(w => String(w).padStart(5)).join(''));
        for (const p of PAGES) {
            const row = [];
            for (const w of WIDTHS) {
                const page = await browser.newPage();
                await page.setViewport({ width: w, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
                await page.evaluateOnNewDocument((r) => {
                    sessionStorage.setItem('speeksUnlocked', 'true');
                    sessionStorage.setItem('speeksUserName', 'Layout Harness');
                    sessionStorage.setItem('speeksUserRole', r);
                    sessionStorage.setItem('speeksUserStore', 'LEE');
                }, role);
                await page.goto('file:///' + REPO + '/' + p, { waitUntil: 'domcontentloaded' }).catch(() => {});
                await page.evaluate(() => {
                    const ov = document.getElementById('authOverlay');
                    if (ov) ov.style.display = 'none';
                    document.documentElement.classList.remove('no-scroll');
                    document.body.classList.remove('no-scroll', 'preload');
                    document.body.classList.add('is-authenticated');
                    if (typeof applyRoleBasedUI === 'function') { try { applyRoleBasedUI(); } catch (e) {} }
                });
                await new Promise(r => setTimeout(r, 350));
                const n = await page.evaluate((vw) => {
                    const bad = [];
                    document.querySelectorAll('body *').forEach(el => {
                        const cs = getComputedStyle(el);
                        if (cs.display === 'none' || cs.visibility === 'hidden') return;
                        const r = el.getBoundingClientRect();
                        if (!r.width && !r.height) return;
                        if (r.left >= vw - 1) return;
                        for (let q = el.parentElement; q && q !== document.body; q = q.parentElement) {
                            const ox = getComputedStyle(q).overflowX;
                            if (ox === 'auto' || ox === 'scroll') return;
                        }
                        if (r.width > vw + 1 || r.right - vw > 1) {
                            bad.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '.' + String(el.className).trim().split(/\s+/)[0])
                                + ' +' + Math.round(r.right - vw) + 'px');
                        }
                    });
                    return bad;
                }, w);
                row.push(n.length);
                total += n.length;
                if (n.length) console.log('    ' + p + ' @' + w + ': ' + n.slice(0, 3).join(' | '));
                await page.close();
            }
            console.log(p.padEnd(17) + row.map(v => String(v).padStart(5)).join(''));
        }
    }
    await browser.close();
    console.log(total ? '\n' + total + ' OVERFLOWS TOTAL' : '\nclean across every page, width and role');
})();
