// Deny, after 2026-09-01: one button that meant two opposite things, a note
// nothing read, and a decision the next cron undid.
//
// What this asserts, in the real page:
//   1. a drift row offers "Ours Is Fine", not "Deny" — that row is not a claim
//      the title is wrong, and asking "why is this title fine?" on it is the
//      wrong question about the wrong system
//   2. an ordinary finding still offers "Deny"
//   3. each sends the right `as` to the server, because that is the whole
//      difference between "our rule is wrong" and "Marketplace Connect is behind"
//   4. the Dismissed drawer renders, is SHUT by default, and its rows carry the
//      who / when / why that used to be written and never read
//   5. the rule tally only counts not-a-problem dismissals — counting the
//      eBay-stale ones would make title-drift look like our worst rule exactly
//      when it was doing its job
//   6. Undo posts a reopen
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};

const DATA = {
    scope: { name: 'Ethan Kushnir', role: 'district manager', stores: ['OVL'], corp: true },
    store: 'OVL',
    ebayScope: { active: true, lastSeen: new Date().toISOString(), hours: 1, maxAgeHours: 36 },
    counts: { OVL: 3 },
    queue: [
        { productId: 'gid://shopify/Product/1', sku: 'KS01-A', severity: 3,
          current: 'GoPro Hero11 Black 27MP 360 Action Camera CHDHX-111',
          suggested: 'GoPro Hero11 Black 27MP Action Camera CHDHX-111',
          findings: [{ code: 'name-wrong', severity: 3,
                       says: 'Hero11 Black is not a 360 camera.',
                       warn: 'Checked against outside product knowledge.' }],
          basis: 'rules', confidence: 'high', comps: [], price: 199, quantity: 1,
          shop: 'paymore-overland-park.myshopify.com' },
        { productId: 'gid://shopify/Product/2', sku: 'KS01-B', severity: 3,
          current: '3DR Solo S110A 4K Quadcopter Camera Drone', suggested: null,
          ebayTitle: '3DR 3DR Solo S110A 4K Quadcopter Camera Drone',
          findings: [{ code: 'title-drift', severity: 3,
                       says: 'eBay is showing a different title.' }],
          basis: 'rules', confidence: 'high', comps: [], price: 299, quantity: 1,
          shop: 'paymore-overland-park.myshopify.com' },
        { productId: 'gid://shopify/Product/3', sku: 'KS01-C', severity: 3,
          current: 'Canon EOS Rebel T2i 18.0MP DSLR Camera', suggested: null,
          ebayTitle: 'Canon EOS Rebel T2i 18.0MP Digital SLR DSLR Camera',
          findings: [{ code: 'ebay-not-synced', severity: 3,
                       says: 'We corrected this on Aug 28 and eBay has not picked it up.' }],
          basis: 'rules', confidence: 'high', comps: [], price: 249, quantity: 1,
          shop: 'paymore-overland-park.myshopify.com' },
    ],
    denied: {
        rows: [
            { productId: 'gid://shopify/Product/9', sku: 'KS01-Z',
              current: 'Sigma 150mm 1:2.8 EF For Canon EF Mount',
              findings: [{ code: 'repeated-phrase' }], severity: 1,
              by: 'Ethan Kushnir', at: '2026-09-01T20:23:00Z',
              as: 'not-a-problem', note: 'the model name really does repeat on the barrel' },
            { productId: 'gid://shopify/Product/8', sku: 'KS01-Y',
              current: 'Nikon Z 6 24.5MP Mirrorless Camera',
              ebayTitle: 'Nikon Z 6 24.5MP Digital SLR DSLR Camera',
              findings: [{ code: 'title-drift' }], severity: 3,
              by: 'Nick Hettinger', at: '2026-08-31T18:00:00Z',
              as: 'ebay-stale', note: null },
        ],
        tally: [{ code: 'repeated-phrase', n: 4 }, { code: 'missing-screen-size', n: 1 }],
    },
};

(async () => {
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errs = [];
    const IGNORE = /calendar\.google\.com|toDataURL|[Tt]ainted canvas|Failed to fetch|net::ERR/;
    page.on('pageerror', e => { const m = String(e.message || e); if (!IGNORE.test(m)) errs.push(m); });
    await page.setViewport({ width: 1500, height: 1200 });
    await page.evaluateOnNewDocument(() => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Ethan Kushnir');
        sessionStorage.setItem('speeksUserRole', 'district manager');
        sessionStorage.setItem('speeksUserStore', 'CORP');
    });
    await page.goto('file:///' + REPO + '/operations.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await new Promise(r => setTimeout(r, 2400));

    // Capture what the page WOULD post, instead of posting it.
    await page.evaluate(d => {
        window.__posts = [];
        window._ltPost = async (b) => { window.__posts.push(b); return { ok: true, body: { ok: true } }; };
        window._ltFetch = async () => d;
        _ecView = 'titles'; _ecStore = 'OVL';
        _ecScope = { allStores: false, stores: ['OVL'] };
        _ltData = d; _ltErr = null; _ltTier = 0;
        ecRender();
    }, DATA);
    await new Promise(r => setTimeout(r, 300));

    console.log('== The button matches the row ==');
    const btns = await page.evaluate(() => [...document.querySelectorAll('.lt-row')].map(row => ({
        title: (row.querySelector('.lt-cur') || {}).textContent || '',
        deny: (row.querySelector('.lt-no') || {}).textContent || '',
        hint: (row.querySelector('.lt-no') || {}).title || '',
        okLabel: (row.querySelector('.lt-ok') || {}).textContent || '',
        okOff: !!(row.querySelector('.lt-ok') || {}).disabled,
    })));
    ok(btns.length === 3, 'three rows rendered', 'got ' + btns.length);
    if (btns.length === 3) {
        ok(btns[0].deny.trim() === 'Deny', 'ordinary finding still says Deny', btns[0].deny.trim());
        ok(btns[1].deny.trim() === 'Ours Is Fine', 'drift row says Ours Is Fine', btns[1].deny.trim());
        ok(btns[2].deny.trim() === 'Ours Is Fine', 'not-synced row says Ours Is Fine', btns[2].deny.trim());
        ok(/eBay copy that needs correcting/i.test(btns[1].hint), 'drift hint names the right system');
        // A row with a suggestion offers to approve it; a row without one offers
        // the only thing it can, and says so while it is still greyed out.
        ok(btns[0].okLabel.trim() === 'Approve' && !btns[0].okOff,
           'a row with a suggestion offers Approve', btns[0].okLabel.trim());
        ok(btns[1].okLabel.trim() === 'Save My Title' && btns[1].okOff,
           'a row with no safe fix says Save My Title, greyed until one is typed',
           btns[1].okLabel.trim());
    }

    console.log('== And sends the right answer ==');
    await page.evaluate(() => { window.prompt = () => 'because I checked it'; });
    await page.evaluate(() => ltDeny('gid://shopify/Product/1'));
    await new Promise(r => setTimeout(r, 200));
    await page.evaluate(() => ltDeny('gid://shopify/Product/2'));
    await new Promise(r => setTimeout(r, 200));
    const posts = await page.evaluate(() => window.__posts);
    ok(posts.length === 2, 'two denials posted', 'got ' + posts.length);
    if (posts.length === 2) {
        ok(posts[0].as === 'not-a-problem', 'name row posts not-a-problem', posts[0].as);
        ok(posts[1].as === 'ebay-stale', 'drift row posts ebay-stale', posts[1].as);
        ok(posts[0].reason === 'because I checked it', 'the note is still sent', posts[0].reason);
    }

    console.log('== The dismissed drawer ==');
    const drawer = await page.evaluate(() => {
        const d = document.querySelector('.lt-denied');
        if (!d) return null;
        const rows = [...d.querySelectorAll('.lt-dn-row')].map(r => ({
            as: (r.querySelector('.lt-dn-as') || {}).textContent || '',
            note: (r.querySelector('.lt-dn-note') || {}).textContent || '',
            meta: (r.querySelector('.lt-dn-meta') || {}).textContent.replace(/\s+/g, ' ').trim(),
            undo: !!r.querySelector('.lt-dn-undo'),
        }));
        // A closed <details> must actually hide its children — Chrome 151 changed
        // how that works once already, which is why .lt-denied states it itself.
        const body = d.querySelector('.lt-dn-rows');
        return {
            open: d.hasAttribute('open'),
            summary: (d.querySelector('summary') || {}).textContent.trim(),
            bodyHidden: body ? getComputedStyle(body).display === 'none' : null,
            rows,
            tally: [...d.querySelectorAll('.lt-tally-row')].map(t => t.textContent.replace(/\s+/g, ' ').trim()),
        };
    });
    ok(!!drawer, 'the drawer rendered');
    if (drawer) {
        ok(drawer.open === false, 'shut by default — this is work already done');
        ok(drawer.bodyHidden === true, 'and its rows are genuinely hidden while shut');
        ok(/2 Dismissed/.test(drawer.summary), 'summary counts them', drawer.summary);
        ok(drawer.rows.length === 2, 'both dismissals listed');
        ok(drawer.rows[0].as.trim() === 'Not A Problem', 'first is labelled Not A Problem', drawer.rows[0].as.trim());
        ok(drawer.rows[1].as.trim() === 'Ours Is Fine', 'second is labelled Ours Is Fine', drawer.rows[1].as.trim());
        ok(/really does repeat/.test(drawer.rows[0].note), 'the note is finally shown', drawer.rows[0].note.slice(0, 40));
        ok(/Ethan Kushnir/.test(drawer.rows[0].meta), 'who dismissed it', drawer.rows[0].meta);
        ok(drawer.rows.every(r => r.undo), 'every row can be undone');
        ok(drawer.tally.length === 1, 'the tally shows only repeat offenders', drawer.tally.join(' | '));
        ok(/repeated/i.test(drawer.tally[0] || ''), 'and names the rule in English', drawer.tally[0]);
    }

    console.log('== Undo ==');
    await page.evaluate(() => { window.__posts = []; });
    await page.evaluate(() => ltReopen('gid://shopify/Product/9'));
    await new Promise(r => setTimeout(r, 200));
    const undo = await page.evaluate(() => window.__posts);
    ok(undo.length === 1 && undo[0].action === 'reopen', 'Undo posts a reopen',
       JSON.stringify(undo[0] || {}));

    if (process.env.SHOT) {
        await page.evaluate(() => { const d = document.querySelector(".lt-denied"); d.open = true; d.scrollIntoView(); });
        await new Promise(r => setTimeout(r, 300));
        const h = await page.$(".lt-denied");
        await h.screenshot({ path: REPO + "/scripts/lt-denied.png" });
        const rows = await page.$$(".lt-row");
        await rows[1].screenshot({ path: REPO + "/scripts/lt-drift-row.png" });
    }
    ok(errs.length === 0, 'no page errors', errs.slice(0, 2).join(' | '));
    await browser.close();
    console.log(fails ? '\n' + fails + ' FAILED' : '\nall pass');
    process.exit(fails ? 1 : 0);
})();
