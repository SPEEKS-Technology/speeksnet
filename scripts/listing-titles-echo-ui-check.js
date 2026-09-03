// THE APPROVE QUESTION, AS A DESIGNED BOX RATHER THAN A BROWSER ALERT.
//
// Approving a title no longer changes one field: the same words are carried into
// the description's spec table and into every metafield that states them. A
// person clicking Approve is agreeing to several edits at once, so the box has
// to name them — and it has to look like something worth answering rather than
// an OS interruption headed "127.0.0.1:5501 says".
//
// What this asserts, in the real page:
//   1. Approve opens the box IMMEDIATELY, with both titles already drawn
//   2. …and asks the server for a preview while it is up, the button refused
//      and saying "Checking…" until the answer lands
//   3. the changed words are marked the same way the row marks them
//   4. it names each field, old value, new value, and where else it lives
//   5. it names what will be LEFT saying the old thing
//   6. Cancel and Escape post nothing
//   7. confirming posts the approve with the same title
//   8. a preview that fails does not block the fix
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

const wait = ms => new Promise(r => setTimeout(r, ms));

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
    await wait(2400);

    // The preview is deliberately SLOW here (250ms). Its arrival is a state the
    // reviewer sees, and a stub that answered instantly would assert nothing
    // about the second they spend looking at the box.
    const arm = (preview) => page.evaluate((d, preview) => {
        window.__posts = [];
        window.__native = [];
        window.confirm = (t) => { window.__native.push('confirm:' + t); return true; };
        window.prompt = (t) => { window.__native.push('prompt:' + t); return ''; };
        window.alert = (t) => { window.__native.push('alert:' + t); };
        window._ltPost = async (b) => {
            window.__posts.push(b);
            if (b.action === 'preview') {
                await new Promise(r => setTimeout(r, 250));
                return preview ? { ok: true, body: preview } : { ok: false, status: 500, body: {} };
            }
            return { ok: true, body: { ok: true, title: b.title } };
        };
        window._ltFetch = async () => d;
        _ecView = 'titles'; _ecStore = 'MPL';
        _ecScope = { allStores: false, stores: ['MPL'] };
        _ltData = d; _ltErr = null; _ltTier = 0;
        ecRender();
    }, DATA, preview);

    const box = () => page.evaluate(() => {
        const ov = document.getElementById('ltAskOverlay');
        if (!ov || !ov.classList.contains('open')) return null;
        const q = s => ov.querySelector(s);
        return {
            eyebrow: (q('.lt-ask-eyebrow') || {}).textContent || '',
            title: (q('.lt-ask-title') || {}).textContent || '',
            now: (q('.lt-now .lt-cur') || {}).innerHTML || '',
            saving: (q('.lt-new .lt-sug') || {}).innerHTML || '',
            waiting: !!q('.lt-ask-wait'),
            go: (q('.lt-ask-go') || {}).textContent || '',
            goOff: !!(q('.lt-ask-go') || {}).disabled,
            secs: [...ov.querySelectorAll('.lt-ask-sec-h')].map(x => x.textContent.trim()),
            fields: [...ov.querySelectorAll('.lt-ask-fields li')].map(x => x.textContent.replace(/\s+/g, ' ').trim()),
            note: !!q('#ltAskNote'),
            body: (q('.lt-ask-body') || {}).textContent.replace(/\s+/g, ' ').trim(),
        };
    });

    console.log('== It opens at once, and says it is still reading ==');
    await arm(PREVIEW);
    await wait(250);
    page.evaluate(() => ltApprove('gid://shopify/Product/1'));   // not awaited
    await wait(90);
    let b = await box();
    ok(!!b, 'the box is up before the server has answered');
    if (b) {
        ok(b.eyebrow === 'Approve Title' && /Change this listing/.test(b.title),
           'it says what it is', b.eyebrow + ' / ' + b.title);
        ok(/lt-cut/.test(b.now) && /L-Mount/.test(b.now),
           'the words being lost are marked on the Now line');
        ok(/lt-add/.test(b.saving) && /E-Mount/.test(b.saving),
           'and the words being saved are marked on the Saving line');
        ok(b.waiting && b.goOff && /Checking/.test(b.go),
           'the button is refused while it reads', b.go);
    }

    console.log('== Then it fills in what else changes ==');
    await wait(400);
    b = await box();
    ok(b && !b.waiting && !b.goOff && b.go.trim() === 'Change The Title',
       'the button opens up and names the action', b && b.go.trim());
    ok(b && b.secs.some(s => /Also Updated/i.test(s)), 'there is an Also Updated section',
       b && b.secs.join(' | '));
    ok(b && b.fields.some(f => /Mount Type/.test(f) && /L-Mount/.test(f) && /E-Mount/.test(f)),
       'naming the field, the old value and the new one',
       b && (b.fields[0] || ''));
    ok(b && b.fields.some(f => /spec table/.test(f) && /title_attributes/.test(f)),
       'and every place it is written down');
    ok(b && b.secs.some(s => /Left As It Is/i.test(s))
       && b.fields.some(f => /Display Type/.test(f) && /IPS with LED/.test(f)),
       'and what will be left saying the old thing');
    ok(b && /online store/.test(b.body) && /eBay/.test(b.body),
       'it still says where the change lands');
    const native = await page.evaluate(() => window.__native);
    ok(native.length === 0, 'and no browser dialog was used at all', native[0] || 'none');

    console.log('== Cancel posts nothing ==');
    await page.evaluate(() => document.querySelector('.lt-ask-cancel').click());
    await wait(150);
    let posts = await page.evaluate(() => window.__posts);
    ok(!(await box()), 'the box is gone');
    ok(posts.length === 1 && posts[0].action === 'preview',
       'only the preview was ever sent', posts.map(p => p.action).join(','));

    console.log('== Escape posts nothing either, and leaves the panel up ==');
    await arm(PREVIEW);
    await wait(250);
    page.evaluate(() => ltApprove('gid://shopify/Product/1'));
    await wait(400);
    await page.keyboard.press('Escape');
    await wait(200);
    ok(!(await box()), 'the box is gone');
    posts = await page.evaluate(() => window.__posts);
    ok(posts.filter(p => p.action === 'approve').length === 0, 'nothing was approved');
    ok(await page.evaluate(() => !!document.querySelector('.lt-row')),
       'and Escape did not take the queue down with it');

    console.log('== Confirming saves the title it showed ==');
    await arm(PREVIEW);
    await wait(250);
    page.evaluate(() => ltApprove('gid://shopify/Product/1'));
    await wait(400);
    await page.evaluate(() => document.querySelector('.lt-ask-go').click());
    await wait(300);
    posts = await page.evaluate(() => window.__posts);
    ok(posts.length === 2 && posts[1].action === 'approve', 'the approve is sent',
       posts.map(p => p.action).join(','));
    ok(posts[1] && posts[1].title === DATA.queue[0].suggested,
       'with exactly the title the box drew');

    console.log('== A preview that fails does not block the fix ==');
    await arm(null);
    await wait(250);
    page.evaluate(() => ltApprove('gid://shopify/Product/1'));
    await wait(400);
    b = await box();
    ok(b && !b.goOff && b.go.trim() === 'Change The Title',
       'the box still offers the change', b && b.go.trim());
    ok(b && b.secs.length === 0, 'it just has nothing extra to say', String(b && b.secs.length));
    await page.evaluate(() => document.querySelector('.lt-ask-go').click());
    await wait(300);
    posts = await page.evaluate(() => window.__posts);
    ok(posts.length === 2 && posts[1].action === 'approve', 'and the approve goes through');

    console.log('== And it fits a phone ==');
    // ⚠️ MEASURED, NOT EYEBALLED. The tap-target block sets min-height:44px on
    // every button under 900px, which ovals any small square one it is not told
    // about — the close-button standard exists because of that rule.
    await page.setViewport({ width: 390, height: 844 });
    await arm(PREVIEW);
    await wait(250);
    page.evaluate(() => ltApprove('gid://shopify/Product/1'));
    await wait(500);
    const size = await page.evaluate(() => {
        const ov = document.getElementById('ltAskOverlay');
        const r = s => { const e = ov.querySelector(s); const b = e && e.getBoundingClientRect();
                         return b ? { w: Math.round(b.width), h: Math.round(b.height) } : null; };
        const card = ov.querySelector('.lt-ask-card').getBoundingClientRect();
        return { close: r('.lt-ask-close'), go: r('.lt-ask-go'),
                 card: { w: Math.round(card.width), h: Math.round(card.height) },
                 fits: card.right <= window.innerWidth + 1 && card.left >= -1,
                 scrollX: document.documentElement.scrollWidth > window.innerWidth };
    });
    ok(size.close && size.close.w === 30 && size.close.h === 30,
       'the X stays 30x30 — the blanket 44px rule does not oval it',
       size.close && `${size.close.w}x${size.close.h}`);
    ok(size.go && size.go.h >= 44, 'the action button DOES take the 44px tap target',
       size.go && String(size.go.h));
    ok(size.fits && !size.scrollX, 'the card fits the screen and nothing scrolls sideways',
       `card ${size.card.w}w`);
    await page.evaluate(() => document.querySelector('.lt-ask-cancel').click());

    ok(errs.length === 0, 'no page errors', errs[0] || 'none');
    await page.screenshot({ path: REPO + '/scripts/listing-titles-ask.png' }).catch(() => {});
    await browser.close();
    console.log(fails ? `\n*** ${fails} FAILED ***\n` : '\nall pass\n');
    process.exit(fails ? 1 : 0);
})();
