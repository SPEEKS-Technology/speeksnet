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
//   4. the Confirmed Correct drawer renders, is SHUT by default, and its rows
//      carry the who / when / why that used to be written and never read
//   5. the rule tally only counts not-a-problem dismissals — counting the
//      eBay-stale ones would make title-drift look like our worst rule exactly
//      when it was doing its job
//   6. Undo posts a reopen
//   7. a suggestion that DELETES a true fact says so in red before it is clicked
//   8. changing store puts the title tabs back on Wrong — a tab is a place in
//      ONE store's work, not a preference to carry to a store nobody has read
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
    counts: { OVL: 4 },
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
        // ⚠️ THE ONE SUGGESTION THAT DELETES A TRUE FACT. Real OVL data: the
        // CPU/motherboard combo whose title named neither part and had six
        // characters spare. The reviewer is approving a removal as well as an
        // addition, so the row has to SAY SO before they click.
        { productId: 'gid://shopify/Product/4', sku: 'KS01-D', severity: 2,
          current: 'Gigabyte B760M Aorus Elite LGA 1700 Intel Core I5-13600KF 3.50GHz microATX',
          suggested: 'Gigabyte B760M Aorus Elite LGA 1700 Intel Core I5-13600KF CPU Motherboard Combo',
          findings: [{ code: 'missing-noun', severity: 2,
                       trimmed: ['3.50GHz', 'microATX'],
                       says: 'The title never says what the item IS.' }],
          basis: 'rules', confidence: 'high', comps: [], price: 249.99, quantity: 1,
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
    ok(btns.length === 3, 'three rows on the Wrong tab', 'got ' + btns.length);
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

    console.log('== A suggestion that DELETES says so, in red ==');
    // ⚠️ THE ROW IS APPROVED IN A SKIM. Every other fix on this screen only adds
    // words or removes a mistake; this one spends a true fact (a clock speed, a
    // form factor) to buy room for the words that name the item. If a reviewer
    // can click Approve without meeting that, the screen is lying by omission.
    // ⚠️ IT LIVES ON THE HARD TO FIND TAB. missing-noun is severity 2, so the
    // row is not on the tab the rest of this harness reads — and a check that
    // silently found nothing would have passed while the line never rendered.
    await page.evaluate(() => ltSetTier(2));
    await new Promise(r => setTimeout(r, 120));
    const trim = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.lt-row')];
        const el = rows.map(r => r.querySelector('.lt-trim')).find(Boolean);
        if (!el) return null;
        const v = el.querySelector('.lt-trim-v');
        const cs = getComputedStyle(v);
        return {
            text: el.textContent.replace(/\s+/g, ' ').trim(),
            struck: [...v.querySelectorAll('s')].map(x => x.textContent),
            colour: cs.color,
            shown: !!el.getClientRects().length,
            onlyOne: rows.filter(r => r.querySelector('.lt-trim')).length,
        };
    });
    ok(!!trim, 'the trimmed row draws a Removed line');
    if (trim) {
        ok(trim.shown, 'and it is actually visible');
        ok(trim.onlyOne === 1, 'only the row that trims something draws one', trim.onlyOne);
        ok(trim.struck.join(' + ') === '3.50GHz + microATX',
           'it names every word that came out, struck through', trim.struck.join(' + '));
        // Red, not the sage of an ordinary edit. What is being approved is a LOSS.
        ok(/rgb\(163,\s*53,\s*44\)/.test(trim.colour), 'in the red this site uses for a loss', trim.colour);
        ok(/spec table still says them/.test(trim.text),
           'and says where the facts still live', trim.text);
    }
    // ⚠️ THE SUGGESTED LINE MUST STILL EQUAL THE EDIT BOX. The reviewer reads one
    // and approves the other, so a trim must not desynchronise them.
    const pair = await page.evaluate(() => {
        const row = [...document.querySelectorAll('.lt-row')].find(r => r.querySelector('.lt-trim'));
        return row ? { sug: row.querySelector('.lt-sug').textContent.replace(/\s+/g, ' ').trim(),
                       box: row.querySelector('.lt-input').value } : null;
    });
    ok(pair && pair.sug === pair.box,
       'the suggestion drawn equals the title in the box', pair && pair.box);
    ok(pair && pair.box.length <= 80, 'and it is inside eBay\'s 80', pair && pair.box.length);
    // A picture of the one row that deletes something, because "is it legible"
    // is not a thing an assertion can answer.
    const trimRow = await page.$('.lt-row');
    if (trimRow) await trimRow.screenshot({ path: REPO + "/scripts/lt-trim-row.png" });
    // Back to the tab the rest of this harness was written against.
    await page.evaluate(() => ltSetTier(3));
    await new Promise(r => setTimeout(r, 120));


    console.log('== And sends the right answer ==');
    // ⚠️ NO BROWSER DIALOGS. These questions are asked in the product now — a
    // designed box that can draw the titles it is asking about. The native
    // confirm/prompt are stubbed only so the harness FAILS LOUDLY if anything
    // here quietly falls back to one.
    await page.evaluate(() => {
        window.__native = [];
        window.prompt = (t) => { window.__native.push('prompt'); return ''; };
        window.confirm = (t) => { window.__native.push('confirm'); return true; };
        window.alert = (t) => { window.__native.push('alert'); };
    });
    const askBox = () => page.evaluate(() => {
        const ov = document.getElementById('ltAskOverlay');
        if (!ov || !ov.classList.contains('open')) return null;
        return {
            eyebrow: (ov.querySelector('.lt-ask-eyebrow') || {}).textContent || '',
            title: (ov.querySelector('.lt-ask-title') || {}).textContent || '',
            body: (ov.querySelector('.lt-ask-body') || {}).textContent.replace(/\s+/g, ' ').trim(),
            note: !!ov.querySelector('#ltAskNote'),
            hint: (ov.querySelector('.lt-ask-hint') || {}).textContent || '',
            go: (ov.querySelector('.lt-ask-go') || {}).textContent.trim(),
        };
    });

    page.evaluate(() => ltDeny('gid://shopify/Product/1'));
    await new Promise(r => setTimeout(r, 250));
    let ask = await askBox();
    ok(!!ask && ask.note, 'Deny asks in a box with a note field');
    ok(ask && /rule is wrong/.test(ask.hint),
       'and says what the note is for — it is the only signal a rule is misfiring');
    ok(ask && ask.go === 'Dismiss It', 'the button names the action', ask && ask.go);
    await page.evaluate(() => {
        document.getElementById('ltAskNote').value = 'because I checked it';
        document.querySelector('.lt-ask-go').click();
    });
    await new Promise(r => setTimeout(r, 250));

    page.evaluate(() => ltDeny('gid://shopify/Product/2'));
    await new Promise(r => setTimeout(r, 250));
    ask = await askBox();
    ok(!!ask && !ask.note,
       'Ours Is Fine has NO note field — there is no rule to report on that answer');
    ok(ask && /eBay listing/.test(ask.body) && /not counted against the rule/.test(ask.body),
       'it says what it records and what it does not');
    await page.evaluate(() => document.querySelector('.lt-ask-go').click());
    await new Promise(r => setTimeout(r, 250));

    const posts = await page.evaluate(() => window.__posts);
    ok(posts.length === 2, 'two denials posted', 'got ' + posts.length);
    if (posts.length === 2) {
        ok(posts[0].as === 'not-a-problem', 'name row posts not-a-problem', posts[0].as);
        ok(posts[1].as === 'ebay-stale', 'drift row posts ebay-stale', posts[1].as);
        ok(posts[0].reason === 'because I checked it', 'the note is still sent', posts[0].reason);
        ok(posts[1].reason === '', 'and the answer with no note sends none', JSON.stringify(posts[1].reason));
    }
    const native = await page.evaluate(() => window.__native);
    ok(native.length === 0, 'no browser dialog was used', native.join(',') || 'none');

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
            askBar: (d.querySelector('.lt-ask-n') || {}).textContent || '',
            askBtn: (d.querySelector('.lt-ask-btn') || {}).textContent || '',
            // The bar has to sit ABOVE the tally: the tally is the argument
            // ("3 dismissals of one rule") and the button is what to do about
            // it, and an argument with its conclusion below the fold is a
            // paragraph nobody acts on.
            askAboveTally: (() => {
                const bar = d.querySelector('.lt-ask-bar'), tal = d.querySelector('.lt-tally');
                if (!bar || !tal) return null;
                return !!(bar.compareDocumentPosition(tal) & Node.DOCUMENT_POSITION_FOLLOWING);
            })(),
        };
    });
    ok(!!drawer, 'the drawer rendered');
    if (drawer) {
        ok(drawer.open === false, 'shut by default — this is work already done');
        ok(drawer.bodyHidden === true, 'and its rows are genuinely hidden while shut');
        ok(/2 Confirmed Correct/.test(drawer.summary),
           'the drawer is named for what is IN it — titles a person read and kept',
           drawer.summary);
        ok(drawer.rows.length === 2, 'both dismissals listed');
        ok(drawer.rows[0].as.trim() === 'Not A Problem', 'first is labelled Not A Problem', drawer.rows[0].as.trim());
        ok(drawer.rows[1].as.trim() === 'Ours Is Fine', 'second is labelled Ours Is Fine', drawer.rows[1].as.trim());
        ok(/really does repeat/.test(drawer.rows[0].note), 'the note is finally shown', drawer.rows[0].note.slice(0, 40));
        ok(/Ethan Kushnir/.test(drawer.rows[0].meta), 'who dismissed it', drawer.rows[0].meta);
        ok(drawer.rows.every(r => r.undo), 'every row can be undone');
        ok(drawer.tally.length === 1, 'the tally shows only repeat offenders', drawer.tally.join(' | '));
        ok(/repeated/i.test(drawer.tally[0] || ''), 'and names the rule in English', drawer.tally[0]);

        // --- the ask that goes to Claude ------------------------------------
        // ⚠️ ONE of these two rows carries a note. The other is the "Ours Is
        // Fine" dismissal, which says the rule was RIGHT and the stale copy is
        // on eBay — not feedback about a rule, and counting it would send an ask
        // to go and change the one thing working. Same exclusion the tally makes.
        ok(/^1 dismissal /.test(drawer.askBar.trim()),
           'the bar counts only the dismissal that explained a rule was wrong',
           drawer.askBar.trim());
        ok(/explained a rule was wrong/.test(drawer.askBar),
           'and says what the note is FOR, not that a row was dismissed');
        // ⚠️ ONE PATH TO THE ASK. This drawer used to gather and copy the notes
        // itself, so the same job existed here AND in the Listing Health tool —
        // two dialogs, two copies of the wording, two things to keep in step.
        // The count stays, because it is what the tally beside it argues for;
        // the work is the tool.
        ok(/Open Listing Health Notes/.test(drawer.askBtn),
           'the button opens the tool that does the work', drawer.askBtn.trim());
        ok(!/\bSend\b|\bAsk Claude\b/.test(drawer.askBtn),
           'and never promises to send anything anywhere', drawer.askBtn.trim());
        ok(drawer.askAboveTally === true,
           'the bar sits above the tally it acts on', String(drawer.askAboveTally));
    }

    console.log('== Undo ==');
    await page.evaluate(() => { window.__posts = []; });
    await page.evaluate(() => ltReopen('gid://shopify/Product/9'));
    await new Promise(r => setTimeout(r, 200));
    const undo = await page.evaluate(() => window.__posts);
    ok(undo.length === 1 && undo[0].action === 'reopen', 'Undo posts a reopen',
       JSON.stringify(undo[0] || {}));

    console.log('== Switching store starts the titles on Wrong ==');
    // ⚠️ A TAB IS A PLACE IN ONE STORE'S WORK, NOT A PREFERENCE. Ethan, arriving
    // at WSP on the Opportunity tab because that is where he had been left on the
    // store before: "when switching from store to store, can you reset the
    // default for the titles to Wrong." Carried across, it opens a store nobody
    // has looked at on its least urgent pile while the broken titles sit unread.
    const tierAfterSwitch = await page.evaluate(() => {
        // Hard To Find, not Opportunity: this fixture has no severity-1 row, and
        // the tab strip correctly refuses to sit on an EMPTY tier — which would
        // have made this test pass for the wrong reason.
        ltSetTier(2);                       // the reviewer wanders off to another tab
        const before = _ltTier;
        // ecSetStore also calls ecLoad, which fetches. The fetch is stubbed to
        // reject in this harness, so the tier is read straight after the reset
        // rather than waiting for a render that will never come.
        try { ecSetStore('MPL'); } catch (e) {}
        return { before, after: _ltTier };
    });
    ok(tierAfterSwitch.before === 2, 'the reviewer really was on another tab', tierAfterSwitch.before);
    ok(tierAfterSwitch.after === 3, 'and a store change puts them back on Wrong', tierAfterSwitch.after);
    // ⚠️ ONLY ON A STORE CHANGE. Resetting on every reload would throw a reviewer
    // out of the tab they are working every single time they approved a row.
    const tierAfterRender = await page.evaluate(() => {
        ltSetTier(2);
        ecRender();
        return _ltTier;
    });
    ok(tierAfterRender === 2, 'a plain re-render leaves the tab alone', tierAfterRender);

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
