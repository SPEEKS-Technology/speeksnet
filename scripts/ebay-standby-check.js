// SPEEKS Connect standby — the break-glass state.
//
// PayMore's new Marketplace Connect adopts every live eBay listing during setup,
// ours included. The moment it does, one physical unit is managed by two systems
// that both believe they own it:
//
//   - both import the same eBay sale  -> two Shopify orders, double revenue,
//     stock decremented twice, the variant driven negative. This is the
//     2026-08-20 incident (77 duplicates, $13,820.44 phantom) as a steady state
//     at five stores instead of a one-off back-fill at two.
//   - our reconcile() republishes on restock -> a second live listing for one
//     item, and whichever sells second is an oversell.
//
// Standby stops SPEEKS Connect writing to eBay WITHOUT removing any of it: the
// tab, the panel and every manual route stay. That is the requirement — keep it
// as break-glass — so this file checks both halves: that the automatic paths are
// gated, and that nothing was taken away.
//
// PART 1 (static) — every write path reads channel_mode. The gate is worthless
//   if one of four callers skips it; ebay-sync's own ownership guard carries a
//   comment about exactly that mistake, made once already.
// PART 2 (rendered) — the panel explains itself before a store scans a SKU and
//   gets a 409 they read as a bug, and only the DM/CEO are offered the switch.
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };
const IGNORE = /calendar\.google\.com|toDataURL|[Tt]ainted canvas|Failed to fetch|net::ERR|401|403/;
const read = p => fs.readFileSync(REPO + '/' + p, 'utf8');

(async () => {
    console.log('== Part 1: every automatic write path is gated ==');

    // ⚠️ POSITION, NOT PRESENCE. A file-wide grep for "channel_mode" and
    // "standby" passes on a gate that is present but wired up wrongly, or that
    // sits BELOW the write it is supposed to prevent — and the first cut of this
    // file did exactly that: deleting the order-poll gate left the words behind
    // in nearby comments and every assertion still passed.
    //
    // So each entry names the WRITE, and the assertion is that the gate returns
    // before that write is reachable.
    const GATED = [
        ['supabase/functions/ebay-orders/index.ts',
         'order import — the duplicate-Shopify-order path',
         // The POLL's order fetch specifically — everything that creates a
         // Shopify order is downstream of it. Not the bare path: helper calls
         // higher up the file share it and matching those made an intact gate
         // look mis-positioned.
         'const ordersRes = await api('],
        ['supabase/functions/ebay-inventory/index.ts',
         'stock withdraw / REPUBLISH and price+content push (both webhooks)',
         // The topic dispatch — both webhook paths branch off it.
         'topic === "products/update"'],
        ['supabase/functions/ebay-sync/index.ts',
         'publish — the choke point all four callers pass through',
         // The first eBay write in the publish path.
         'PUBLISHING SOMETHING WITH NO STOCK'],
        ['supabase/functions/ebay-autolist/index.ts',
         'auto-listing new stock onto an account MC now manages',
         // The loop that calls ebay-sync and then stamps status:'failed'.
         'const results: any[] = []'],
    ];
    GATED.forEach(([f, what, writeMarker]) => {
        const src = read(f);
        // The gate is the line that TESTS the column, not a mention of it.
        const m = src.match(/(String\(\s*(?:row|st|modeRow)[\w?.]*\.channel_mode[^\n]*===\s*"standby")/);
        const writeAt = src.indexOf(writeMarker);
        const gateAt = m ? src.indexOf(m[1]) : -1;
        ok(gateAt !== -1 && writeAt !== -1 && gateAt < writeAt,
            f.split('/')[2] + ' gates ' + what,
            gateAt === -1 ? 'NO channel_mode TEST — this path still writes to eBay'
              : writeAt === -1 ? 'could not locate the write marker; re-point this check'
              : 'gate at char ' + gateAt + ' precedes the write at ' + writeAt);
    });

    // The migration must not flip anything on by itself. Applying it during
    // trading hours has to be a no-op, or real eBay sales stop reaching Shopify
    // the moment it lands.
    const mig = read('supabase/migrations/0060_ebay_channel_standby.sql');
    ok(/channel_mode text not null default 'active'/.test(mig),
        'the migration defaults to active, so applying it changes nothing');
    ok(/enable row level security/.test(mig) && /revoke all/.test(mig),
        'the handover table follows the house RLS convention (on, no policies)');
    ok(/on_conflict|unique index/.test(mig),
        'and re-running a handover capture corrects rather than doubles it');

    // ⚠️ force=1 must NOT be a way out of standby. Stores already reach for it
    // to get past the MC collision guard, so if it also escaped standby it would
    // be the single flag most likely to create the duplicate.
    const sync = read('supabase/functions/ebay-sync/index.ts');
    const gate = sync.slice(sync.indexOf('step: "standby"') - 1400,
                           sync.indexOf('step: "standby"') + 200);
    ok(/!dry &&\s*String\(row\.channel_mode/.test(gate) && !/force/.test(
            gate.slice(gate.indexOf('if (!dry'), gate.indexOf('step: "standby"'))),
        'force=1 does NOT override standby in ebay-sync',
        'gate condition is dry-only');
    ok(/if \(!dry/.test(gate), 'but a dry run still inspects — it writes nothing');

    // The order poll must answer 200. A 4xx reads as a broken cron in the
    // watchdog, and the cron is behaving exactly as designed.
    const orders = read('supabase/functions/ebay-orders/index.ts');
    const oGate = orders.slice(orders.indexOf('standby: true') - 900,
                              orders.indexOf('standby: true') + 700);
    ok(/ok: true/.test(oGate) && !/\}, 4\d\d\)/.test(oGate),
        'the standby order poll returns 200, not an error the cron watchdog would flag');
    ok(/WRITES NO ebay_orders ROWS/.test(orders),
        'and writes no ebay_orders rows — a non-DONE status reads as a failed import');

    // Shopify retries a non-2xx webhook with the same body for 48 hours.
    const inv = read('supabase/functions/ebay-inventory/index.ts');
    const iGate = inv.slice(inv.indexOf('skipped: "standby"') - 200,
                            inv.indexOf('skipped: "standby"') + 400);
    ok(/\}, 202\)/.test(iGate),
        'the standby webhook answers 2xx, so Shopify does not retry for 48 hours');
    // The hand-repair routes are the break-glass tools and must survive.
    const gateAt = inv.indexOf('skipped: "standby"');
    ok(inv.indexOf('resync') < gateAt && inv.indexOf('end=1') !== -1
       && inv.indexOf('"end") === "1"') < gateAt,
        '?resync=1 and ?end=1 sit ABOVE the gate — manual repair still works');

    console.log('');
    console.log('== Part 2: the panel says so, and keeps working ==');

    const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => { const m = String(e.message || e); if (!IGNORE.test(m)) errs.push(m); });
    await page.setViewport({ width: 1500, height: 1000 });
    await page.evaluateOnNewDocument(() => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Ethan Kushnir');
        sessionStorage.setItem('speeksUserRole', 'district manager');
        sessionStorage.setItem('speeksUserStore', 'OVL');
        sessionStorage.setItem('speeksUserPin', '0000');
    });
    await page.goto('file:///' + REPO + '/operations.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await new Promise(r => setTimeout(r, 2500));

    // Drive ecRender directly with canned server state — no PIN, no network.
    const draw = (mode, role) => page.evaluate((mode, role) => {
        _ecStore = 'OVL';
        _ecView = 'feed';
        _ecFeed = [];
        _ecScope = { name: 'Ethan Kushnir', role, store: 'OVL', stores: ['OVL'],
                     corp: true, canList: true,
                     allStores: role === 'district manager' || role === 'ceo' };
        _ecData = { scope: _ecScope, store: 'OVL', items: [], summary: {
            store: 'OVL', connected: true, channelMode: mode,
            channelModeAt: '2026-08-24T15:00:00Z', channelModeBy: 'Ethan Kushnir',
            channelModeNote: 'MC v2 adoption complete',
            counts: { live: 12, ended: 3, disabled: 0, failed: 1, total: 16 },
            setup: {}, freshness: { liveMinutes: 4, liveError: null },
        } };
        ecRender();
        const b = document.getElementById('ecBody');
        const banner = b.querySelector('.ec-standby');
        return {
            banner: !!banner,
            title: banner ? banner.querySelector('.ec-standby-t').textContent.trim() : '',
            note: banner ? banner.querySelector('.ec-standby-n').textContent.replace(/\s+/g, ' ').trim() : '',
            takeOver: !!b.querySelector('.ec-btn-glass'),
            // Break-glass means the tool is still THERE.
            scanBox: !!b.querySelector('#ecSkuInput'),
            uploadBtn: [...b.querySelectorAll('button')].some(x => /Upload To eBay/.test(x.textContent)),
            failedBtn: [...b.querySelectorAll('button')].some(x => /Did Not Upload/.test(x.textContent)),
        };
    }, mode, role);

    const sb = await draw('standby', 'district manager');
    ok(sb.banner, 'standby draws the banner');
    ok(/Marketplace Connect Owns OVL/i.test(sb.title), 'naming who owns the channel', sb.title);
    ok(/twice/i.test(sb.note), 'and saying WHY, in terms of the actual consequence',
        sb.note.slice(0, 120) + '…');
    ok(/Parked Aug 24, 2026/.test(sb.note) && /Ethan Kushnir/.test(sb.note),
        'with when and who', 'parked-by line present');
    ok(/MC v2 adoption complete/.test(sb.note), 'and the note that was saved with it');

    console.log('');
    console.log('-- nothing was removed --');
    ok(sb.scanBox && sb.uploadBtn,
        'the scan box and Upload button are STILL THERE — this is break-glass, not a teardown');
    ok(sb.failedBtn, 'and a store can still open its own failed uploads');

    console.log('');
    console.log('-- who may break the glass --');
    ok(sb.takeOver, 'a DM is offered Take The Channel Back');
    const mgr = await draw('standby', 'manager');
    ok(mgr.banner && !mgr.takeOver,
        'a store manager sees the banner but is NOT offered the switch',
        'banner ' + mgr.banner + ', button ' + mgr.takeOver);
    ok(mgr.scanBox, 'and still has the whole panel');

    console.log('');
    console.log('-- active is unchanged --');
    const act = await draw('active', 'district manager');
    ok(!act.banner, 'an active store shows no banner at all');
    ok(act.scanBox && act.uploadBtn, 'and the panel is exactly as it was');
    const missing = await page.evaluate(() => {
        // A store on a build predating migration 0060 sends no channelMode.
        delete _ecData.summary.channelMode;
        ecRender();
        return { banner: !!document.querySelector('#ecBody .ec-standby'),
                 scanBox: !!document.getElementById('ecSkuInput') };
    });
    ok(!missing.banner && missing.scanBox,
        'and a summary with NO channelMode field behaves as active, not as parked');

    console.log('');
    ok(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' | ') || 'clean');
    await browser.close();
    console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall checks passed');
    process.exit(fails ? 1 : 0);
})();
