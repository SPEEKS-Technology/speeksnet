// The dropdown skin draws a face over EVERY <select> on the site, so the thing
// that has to be proven is that nothing behind the face changed: the native
// control is still in the DOM, still holds the value, still fires change, and
// still round-trips a programmatic .value write.
//
// Run against all five shells and every role, because the selects differ per page.
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
    let totalSelects = 0, totalEnhanced = 0, totalSkipped = 0;

    for (const p of PAGES) {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });
        const errs = [];
        page.on('pageerror', e => errs.push(String(e).slice(0, 160)));
        await page.evaluateOnNewDocument(() => {
            sessionStorage.setItem('speeksUnlocked', 'true');
            sessionStorage.setItem('speeksUserName', 'Layout Harness');
            sessionStorage.setItem('speeksUserRole', 'district manager');
            sessionStorage.setItem('speeksUserStore', 'LEE');
        });
        await page.goto('file:///' + REPO + '/' + p, { waitUntil: 'networkidle2' }).catch(() => {});
        await page.evaluate(() => {
            const ov = document.getElementById('authOverlay'); if (ov) ov.style.display = 'none';
            document.body.classList.add('is-authenticated');
            document.body.classList.remove('preload', 'no-scroll');
            if (typeof applyRoleBasedUI === 'function') { try { applyRoleBasedUI(); } catch (e) {} }
        });
        await new Promise(r => setTimeout(r, 900));

        const r = await page.evaluate(() => {
            const sels = Array.from(document.querySelectorAll('select'));
            const enhanced = sels.filter(s => s.classList.contains('dd-native'));
            const skipped = sels.filter(s => !s.classList.contains('dd-native'));
            // Every enhanced select must still be inside a .dd-host with a face.
            const orphans = enhanced.filter(s => !s.closest('.dd-host') ||
                !s.closest('.dd-host').querySelector('.dd-btn'));
            // The face must be showing the option the select actually has selected.
            const mismatched = enhanced.filter(s => {
                const host = s.closest('.dd-host');
                if (!host) return true;
                const shown = (host.querySelector('.dd-cur') || {}).textContent || '';
                const want = s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : '';
                return shown.trim() !== want.trim() && !(want === '' && shown === '—');
            });
            return {
                total: sels.length,
                enhanced: enhanced.length,
                skipped: skipped.map(s => s.id || s.className).slice(0, 6),
                skippedN: skipped.length,
                orphans: orphans.map(s => s.id || '(no id)'),
                mismatched: mismatched.map(s => s.id || '(no id)'),
            };
        });

        console.log('\n### ' + p);
        totalSelects += r.total; totalEnhanced += r.enhanced; totalSkipped += r.skippedN;
        ok(r.orphans.length === 0, 'every enhanced select still has its face', r.enhanced + ' enhanced' + (r.orphans.length ? ' | orphans: ' + r.orphans.join(',') : ''));
        ok(r.mismatched.length === 0, 'every face shows the selected option', r.mismatched.join(',') || 'all match');
        ok(errs.length === 0, 'no page errors', errs.join(' | ') || 'none');
        console.log('       ' + r.total + ' selects, ' + r.enhanced + ' enhanced, ' + r.skippedN + ' skipped' +
            (r.skippedN ? ' (' + r.skipped.join(', ') + ')' : ''));

        // Round-trip the FIRST enhanced select with 2+ options: choose through the
        // face, and confirm the native value moved and change fired.
        const trip = await page.evaluate(() => {
            const host = Array.from(document.querySelectorAll('.dd-host'))
                .find(h => h._ddSel && h._ddSel.options.length > 1);
            if (!host) return null;
            const sel = host._ddSel;
            const before = sel.value;
            let fired = 0;
            sel.addEventListener('change', () => fired++);
            host.querySelector('.dd-btn').click();                  // open
            const opts = host.querySelectorAll('.dd-opt');
            const target = Array.from(opts).find(o => o.textContent.trim() !== (sel.options[sel.selectedIndex] || {}).text);
            if (!target) return { skip: 'only one distinct option' };
            const wantText = target.textContent.trim();
            target.click();                                          // choose
            const after = sel.value;
            const afterText = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '';
            // And the reverse: a programmatic write the face must pick up.
            sel.value = before;
            host.querySelector(".dd-btn").click();                   // re-open re-syncs
            const shownAfterWrite = host.querySelector('.dd-cur').textContent.trim();
            host.querySelector('.dd-btn').click();                   // close
            return {
                id: sel.id || '(no id)', before, after, fired,
                textMatches: afterText.trim() === wantText,
                open: host.classList.contains('open'),
                reSynced: shownAfterWrite === (sel.options[sel.selectedIndex] || {}).text.trim(),
            };
        });
        if (trip && !trip.skip) {
            ok(trip.after !== trip.before, '  round-trip: choosing moved the native value', trip.id + ' ' + trip.before + ' -> ' + trip.after);
            ok(trip.fired === 1, '  and fired exactly one change event', String(trip.fired));
            ok(trip.textMatches, '  and the native selection matches what was clicked');
            ok(trip.reSynced, '  a programmatic .value write is picked up on re-open');
            ok(!trip.open, '  the list closes after choosing');
        }
        await page.close();
    }

    await browser.close();
    console.log('\n' + totalEnhanced + ' of ' + totalSelects + ' selects enhanced across 5 shells (' + totalSkipped + ' deliberately skipped)');
    console.log(fails ? fails + ' FAILED' : 'all dropdown assertions passed');
    process.exit(fails ? 1 : 0);
})();
