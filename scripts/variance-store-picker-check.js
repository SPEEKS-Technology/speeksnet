// Variance Replies: only a district manager may see the STORE picker.
//
// Everyone below DM is scoped to their own store already — _vrStores() returns
// _vrMyStores() and the fetch asks for those stores only — but the picker itself
// was still on screen for them (Ethan, 2026-09-01). A control that cannot change
// anything is worse than clutter: it reads as permission to look at other stores.
//
// ⚠️ THIS CHECK MEASURES .dd-btn AND .dd-host, NEVER THE SELECT. Every select on
// the site is wrapped by the custom dropdown: the native one is moved into a
// .dd-host and covered by a .dd-btn face, and getComputedStyle(select).display
// reads 'none' whether or not the control is on screen. An assertion on the
// select is a false green — the same false green that let this bug, the Call
// Backs filter and the SPEEKS Connect picker all survive. See
// scripts/connect-store-picker-check.js.
//
// ⚠️ AND IT TESTS BOTH INIT ORDERS, because that is the actual hazard. _ddScan
// runs off a MutationObserver, so the face can be built either before or after
// applyRoleBasedUI runs. Before: the sweep must mirror the gate onto the host.
// After: the new face must inherit the verdict already written on the select.
// Fixing one order and not the other leaves a bug that only shows up on a slow
// machine, which is the worst kind.
//
//   NODE_PATH=$(npm root -g) node scripts/variance-store-picker-check.js
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';

let fails = 0;
const ok = (c, label, got) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + label + (got === undefined ? '' : '   ' + got));
    if (!c) fails++;
};

// role, store, and whether the store picker should be on screen
const CASES = [
    { role: 'district manager',    store: 'CORP', pickers: true  },
    { role: 'manager',             store: 'LEE',  pickers: false },
    { role: 'assistant manager',   store: 'LEE',  pickers: false },
    { role: 'employee',            store: 'LEE',  pickers: false },
];

async function probe(browser, kase, order) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument((role, store) => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Layout Harness');
        sessionStorage.setItem('speeksUserRole', role);
        sessionStorage.setItem('speeksUserStore', store);
    }, kase.role, kase.store);
    await page.goto('file:///' + REPO + '/workspace.html', { waitUntil: 'networkidle2' }).catch(() => {});

    const out = await page.evaluate(async (order) => {
        const ov = document.getElementById('authOverlay'); if (ov) ov.style.display = 'none';
        document.documentElement.classList.remove('no-scroll');
        document.body.classList.remove('no-scroll', 'preload');
        document.body.classList.add('is-authenticated');
        const openTab = t => { try { if (typeof switchWorkspaceTab === 'function') switchWorkspaceTab(t); } catch (e) {} };
        openTab('vreplies');

        const sweep = () => { try { applyRoleBasedUI(); } catch (e) {} };
        const scan = () => { try { _ddScan(); } catch (e) {} };

        // Strip the face back off so each order starts from raw markup.
        const sel0 = document.getElementById('vr-store-select');
        if (sel0) {
            const h = sel0.closest('.dd-host');
            if (h && h.parentNode) { h.parentNode.insertBefore(sel0, h); h.remove(); }
            sel0.classList.remove('dd-native');
            delete sel0._ddDone;
            sel0.style.removeProperty('display');
        }
        if (order === 'scan-then-sweep') { scan(); sweep(); }
        else { sweep(); scan(); }
        await new Promise(r => setTimeout(r, 250));

        const read = id => {
            const sel = document.getElementById(id);
            if (!sel) return { missing: true };
            const host = sel.closest('.dd-host');
            const btn = host ? host.querySelector('.dd-btn') : null;
            const r = btn ? btn.getBoundingClientRect() : null;
            return {
                wrapped: !!host,
                selDisplay: getComputedStyle(sel).display,
                hostDisplay: host ? getComputedStyle(host).display : null,
                faceClasses: btn ? btn.className : null,
                // the only thing that matters: can a person see and click it
                faceVisible: !!btn && btn.getClientRects().length > 0
                    && getComputedStyle(btn).visibility !== 'hidden'
                    && getComputedStyle(btn).display !== 'none',
                faceBox: r ? [Math.round(r.width), Math.round(r.height)] : null,
            };
        };
        openTab('vreplies');
        const vr = read('vr-store-select');
        openTab('aging');
        await new Promise(r => setTimeout(r, 120));
        const ag = read('ag-store-select');
        openTab('vreplies');
        return { vr: vr, ag: ag };
    }, order);

    await page.close();
    return out;
}

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });

    for (const order of ['sweep-then-scan', 'scan-then-sweep']) {
        console.log('\n=== init order: ' + order + ' ===');
        for (const kase of CASES) {
            const p = await probe(browser, kase, order);
            const tag = kase.role + ' @ ' + kase.store;
            console.log('\n--- ' + tag + ' ---');
            if (p.vr.missing) { ok(false, 'vr-store-select exists'); continue; }
            ok(p.vr.wrapped, 'wrapped in .dd-host, so .dd-btn is what to measure');
            ok(p.vr.faceVisible === kase.pickers,
               'Variance store picker ' + (kase.pickers ? 'IS shown' : 'is GONE'),
               'face=' + p.vr.faceVisible + ' host=' + p.vr.hostDisplay + ' box=' + JSON.stringify(p.vr.faceBox));
            if (!p.ag.missing) {
                ok(p.ag.faceVisible === kase.pickers,
                   'Aging Inventory picker ' + (kase.pickers ? 'IS shown' : 'is GONE'),
                   'face=' + p.ag.faceVisible + ' host=' + p.ag.hostDisplay);
            }
            // The face must not carry gating classes: applyRoleBasedUI matches
            // .dynamic-module-* and would write display:block over a flex control.
            if (p.vr.faceClasses !== null) {
                ok(!/dynamic-module|role-|store-/.test(p.vr.faceClasses),
                   'face carries layout classes only', '"' + p.vr.faceClasses + '"');
            }
        }
    }

    console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
    process.exitCode = fails ? 1 : 0;
    await browser.close();
})();
