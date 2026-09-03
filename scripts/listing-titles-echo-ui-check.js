// THE CONFIRM BOX NAMES WHAT ELSE THE APPROVE WILL REWRITE.
//
// Approving a title no longer changes one field: the same words are carried into
// the description's spec table and into every metafield that states them. A
// person clicking Approve is therefore agreeing to several edits at once, and
// the box has to say so — an approve that quietly rewrites four fields is the
// same class of problem as an approve that quietly rewrote none (the &amp; bug).
//
// What this asserts, in the real page:
//   1. Approve asks the server for a PREVIEW before it asks the person
//   2. the confirm names each field, old value and new value
//   3. it also names what will be LEFT saying the old thing
//   4. saying no to the box posts nothing
//   5. saying yes posts the approve, with the same title
//   6. a preview that fails does not block the fix — the box falls back to the
//      title-only wording
//   7. the button says "Checking…" while it reads, not "Saving…"
//
// Run: node scripts/listing-titles-echo-ui-check.js
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};

const DATA = {
    scope: { name: 'Ethan Kushnir', role: 'district manager', stores: ['MPL'], corp: true },
    store: 'MPL',
    ebayScope: { active: true, lastSeen: new Date().toISOString(), hours: 1, maxAgeHours: 36 },
    counts: { MPL: 1 },
    queue: [
        { productId: 'gid://shopify/Product/1', sku: 'MO03-1478A-E9', severity: 3,
          current: 'Sony Alpha ZV-E10 6233727 24.2MP L-Mount Digital Camera',
          suggested: 'Sony Alpha ZV-E10 6233727 24.2MP E-Mount Digital Camera',
          findings: [{ code: 'name-wrong', severity: 3,
                       says: 'The Sony ZV-E10 uses Sony E-mount, not L-mount.' }],
          basis: 'rules', confidence: 'high', comps: [], price: 549, quantity: 1,
          shop: 'paymore-maple-grove.myshopify.com' },
    ],
    denied: { rows: [], tally: [] },
};

// What the server says when asked what else the change touches — the shape the
// live function returns for this exact listing.
const PREVIEW = {
    ok: true, preview: true, specRows: 1, metafields: 3,
    alsoUpdated: [{ field: 'Mount Type', was: 'L-Mount', now: 'E-Mount',
                    where: ['spec table', 'mount_type', 'title_attributes'] }],
    stillSays: [{ field: 'Display Type', value: 'IPS with LED', where: 'spec table' }],
};

(async () => {
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errs = [];
    const IGNORE = /calendar\.google\.com|toDataURL|[Tt]ainted canvas|Failed to fetch|net::ERR/;
    page.on('pageerror', e => { const m = String(e.message || e); if (!IGNORE.test(m)) errs.push(m); });
    await page.setViewport({ width: 1500, height: 1100 });
    await page.evaluateOnNewDocument(() => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Ethan Kushnir');
        sessionStorage.setItem('speeksUserRole', 'district manager');
        sessionStorage.setItem('speeksUserStore', 'CORP');
    });
    await page.goto('file:///' + REPO + '/operations.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await new Promise(r => setTimeout(r, 2400));

    const arm = (d, preview, sayYes) => page.evaluate((d, preview, sayYes) => {
        window.__posts = [];
        window.__asked = [];
        window.__labels = [];
        window._ltPost = async (b) => {
            window.__posts.push(b);
            // Whatever the button says at the moment of the read is what a
            // reviewer is looking at while they wait for it.
            window.__labels.push((document.querySelector('.lt-ok') || {}).textContent || '');
            if (b.action === 'preview') {
                return preview ? { ok: true, body: preview } : { ok: false, status: 500, body: {} };
            }
            return { ok: true, body: { ok: true, title: b.title } };
        };
        window._ltFetch = async () => d;
        window.confirm = (t) => { window.__asked.push(t); return sayYes; };
        _ecView = 'titles'; _ecStore = 'MPL';
        _ecScope = { allStores: false, stores: ['MPL'] };
        _ltData = d; _ltErr = null; _ltTier = 0;
        ecRender();
    }, d, preview, sayYes);

    console.log('== It reads before it asks ==');
    await arm(DATA, PREVIEW, false);
    await new Promise(r => setTimeout(r, 250));
    await page.evaluate(() => ltApprove('gid://shopify/Product/1'));
    await new Promise(r => setTimeout(r, 400));
    let out = await page.evaluate(() => ({ posts: window.__posts, asked: window.__asked, labels: window.__labels }));
    ok(out.posts.length === 1 && out.posts[0].action === 'preview',
       'the first thing sent is a preview, not a write',
       JSON.stringify((out.posts[0] || {}).action));
    ok(out.posts[0] && out.posts[0].title === DATA.queue[0].suggested,
       'and it asks about the title that would actually be saved');
    ok(out.asked.length === 1, 'the person is asked once');
    const box = out.asked[0] || '';
    ok(/It also updates these/.test(box), 'the box says there are other fields');
    ok(/Mount Type: L-Mount → E-Mount/.test(box), 'and names the field, from and to',
       (box.match(/Mount Type[^\n]*/) || [''])[0]);
    ok(/Display Type still says "IPS with LED"/.test(box),
       'and names what will be left saying the old thing',
       (box.match(/Display Type[^\n]*/) || [''])[0]);
    ok(/From: Sony Alpha ZV-E10 6233727 24\.2MP L-Mount/.test(box) && /To: {3}Sony/.test(box),
       'the two titles are still the top of the box');
    ok(out.posts.length === 1, 'saying no writes nothing', String(out.posts.length));

    console.log('== Saying yes writes, with the same title ==');
    await arm(DATA, PREVIEW, true);
    await new Promise(r => setTimeout(r, 250));
    await page.evaluate(() => ltApprove('gid://shopify/Product/1'));
    await new Promise(r => setTimeout(r, 500));
    out = await page.evaluate(() => ({ posts: window.__posts, labels: window.__labels }));
    ok(out.posts.length === 2, 'two calls: the preview and the approve', String(out.posts.length));
    ok(out.posts[1] && out.posts[1].action === 'approve', 'the second is the approve');
    ok(out.posts[1] && out.posts[1].title === DATA.queue[0].suggested,
       'and it saves exactly the title it previewed');
    ok(out.labels[0] === 'Checking…', 'the button said Checking… while it read', out.labels[0]);
    ok(out.labels[1] === 'Saving…', 'and Saving… while it wrote', out.labels[1]);

    console.log('== A preview that fails does not block the fix ==');
    await arm(DATA, null, true);
    await new Promise(r => setTimeout(r, 250));
    await page.evaluate(() => ltApprove('gid://shopify/Product/1'));
    await new Promise(r => setTimeout(r, 500));
    out = await page.evaluate(() => ({ posts: window.__posts, asked: window.__asked }));
    ok(out.asked.length === 1 && !/It also updates/.test(out.asked[0]),
       'the question falls back to the title-only wording');
    ok(out.posts.length === 2 && out.posts[1].action === 'approve',
       'and the approve still goes through');

    ok(errs.length === 0, 'no page errors', errs[0] || 'none');
    await browser.close();
    console.log(fails ? `\n*** ${fails} FAILED ***\n` : '\nall pass\n');
    process.exit(fails ? 1 : 0);
})();
