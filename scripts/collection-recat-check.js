// Filing the `other` pile — is the proposal set safe to write to Shopify?
//
// This is the check that runs BEFORE an apply, and the one to re-run after any
// edit to collection_rules. It drives the live functions and asserts the things
// that would be quietly wrong rather than loudly broken:
//
//   1. the dry run writes nothing (it reports `mode: dry-run` and moved: 0)
//   2. every shelf a proposal names is a REAL collection at that store — a
//      typo'd handle is otherwise a per-product userError at apply time, 300
//      products deep
//   3. `apply=1` without the secret is refused
//   4. NOTHING IS FILED ONTO A SHELF NOBODY CAN ASK FOR. This is the invariant
//      that joins the two halves: a unit moved to Networking is invisible to
//      the Call Back matcher until Networking has types, so a target shelf with
//      an empty type list means the move made the storefront tidier and the
//      matcher no better.
//   5. every category holding in-stock units has a type vocabulary, `other`
//      excepted — it is reachable by multi-word keyword only, by design
//   6. THE QUEUE ONLY SHOWS WHAT A SHOPPER CAN REACH. Both queues are scoped
//      to products live on the Online Store channel, and the storefront is
//      the oracle: an unpublished product 404s at /products/<handle> and a
//      published one 200s, measured both ways. So a sample of queue rows is
//      fetched from the real shop. It is the same URL as the View link on
//      every row, so this checks that too.
//   7. no shelf exists that PayMore does not have. Corp runs the storefront,
//      63 collections is what we get, and since 0056 a rule that targets
//      anything else is a foreign-key violation rather than a quiet misfile.
//   8. the matcher still answers, and still loads every type
//
// Read-only. It never passes apply=1 with a real secret.

const BASE = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1';
const PIN = process.env.SPEEKS_TEST_PIN || '';
const SECRET = process.env.SPEEKS_SYNC_SECRET || 'sp33ks-sync-k3y-2026-x9mq';
const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };
const get = async (u) => (await fetch(u)).json();

(async () => {
    console.log('== shopify-recat, dry run ==');
    const dry = await get(`${BASE}/shopify-recat`);
    ok(dry.ok === true, 'the dry run answers', dry.error || '');
    ok(dry.mode === 'dry-run', 'and says so', dry.mode);
    ok(dry.moved === 0, 'having moved nothing', `moved=${dry.moved}`);
    ok(dry.proposed > 0, 'with something to propose', `${dry.proposed} products`);

    const shelves = new Set();
    for (const s of STORES) {
        const st = dry.stores?.[s];
        if (!st) { ok(false, `${s} is in the report`); continue; }
        Object.keys(st.by_shelf || {}).forEach(h => shelves.add(h));
    }
    ok(shelves.size > 0, 'the proposals name shelves', `${shelves.size} distinct`);
    ok(!shelves.has('other'), 'and never name `other` — that is what they leave');

    console.log('\n== the secret ==');
    const refused = await get(`${BASE}/shopify-recat?store=WSP&apply=1`);
    ok(!!refused.error, 'apply=1 without the secret is refused', refused.error || 'ALLOWED');
    ok(refused.moved === undefined, 'and moved nothing');

    console.log('\n== every shelf is real, and askable-for ==');
    const vocab = await get(`${BASE}/customer-callbacks?vocab=1`);
    const cats = vocab.categories || [];
    const known = new Map(cats.map(c => [c.handle, c]));
    ok(cats.length > 0, 'the quick-add vocabulary loads', `${cats.length} categories`);

    const unknown = [...shelves].filter(h => !known.has(h));
    ok(unknown.length === 0, 'every proposed shelf is a real collection', unknown.join(', ') || 'all known');

    const wordless = [...shelves].filter(h => (known.get(h)?.types || []).length === 0);
    ok(wordless.length === 0,
        'every proposed shelf has a type vocabulary',
        wordless.length ? `NOBODY CAN ASK FOR: ${wordless.join(', ')}` : `${shelves.size}/${shelves.size} askable`);

    // EVERY shelf a person can PICK, not just the ones a rule proposes. The No
    // Suggestion queue has no proposal on the row, so the picker offers all of
    // them — and the old assertion above was watching 26 of 62. Filing the Elan
    // AV controller onto a wordless shelf tidies the storefront and leaves the
    // matcher exactly as blind as it was.
    // `other` is the one deliberate exception: it is reachable by multi-word
    // keyword only, by design (fact 2 in the matcher's header).
    const noWords = cats.filter(c => c.handle !== 'other' && !(c.types || []).length);
    ok(noWords.length === 0,
        'and so does every shelf the picker offers',
        noWords.length ? `NOBODY CAN ASK FOR: ${noWords.map(c => c.handle).join(', ')}`
                       : `${cats.length - 1}/${cats.length - 1} askable`);

    // The panel's own API, if a corp PIN was supplied. Nothing here writes to
    // Shopify: a skip is ours to undo, and the two refusals are the point.
    if (PIN) {
        console.log('\n== the panel API ==');
        const post = async (body, pin = PIN) => {
            const r = await fetch(`${BASE}/shopify-recat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-pin': pin },
                body: JSON.stringify(body),
            });
            return { status: r.status, body: await r.json().catch(() => ({})) };
        };
        const review = async (store) => (await (await fetch(`${BASE}/shopify-recat?view=review&store=${store}`,
            { headers: { 'x-user-pin': PIN } })).json());

        const r0 = await review('OVL');
        // The two tab counts, and they are THIS STORE'S — the misfiled badge used
        // to carry the whole scope, so a DM on OVL read 17 above a list of one.
        ok(r0.counts && r0.counts.other === r0.queue.length,
            'the open tab count is the list it sits above', JSON.stringify(r0.counts));
        ok((r0.queue || []).every(q => q.toTitle && !/^[a-z-]+$/.test(q.toTitle)),
            'every row names its shelf in words, not handles');

        const noPin = await post({ action: 'apply', store: 'OVL', productIds: ['gid://shopify/Product/1'] }, '');
        ok(noPin.status === 401, 'apply with no PIN is refused', String(noPin.status));

        // THE ONE THAT MATTERS: a product id posted by a browser is a request to
        // file a PROPOSAL, not a licence to move any product in the catalogue.
        const bogus = await post({ action: 'apply', store: 'OVL', productIds: ['gid://shopify/Product/999999'] });
        ok(!!bogus.body.error, 'a product that is not in the queue cannot be filed', bogus.body.error);

        // The second queue: stock on a real shelf its own title disagrees with.
        const mis = await (await fetch(`${BASE}/shopify-recat?view=review&store=BAL&mode=misfiled`,
            { headers: { 'x-user-pin': PIN } })).json();
        ok(mis.mode === 'misfiled', 'the misfiled queue loads', `${mis.queue?.length} rows at BAL`);
        ok((mis.queue || []).every(q => (q.from || []).length && !q.from.includes('Other')),
            'and every row names the shelf it would COME OFF — never Other',
            (mis.queue || [])[0]?.from?.join(' + ') || 'empty');
        ok((mis.queue || []).every(q => q.to && !q.from.includes(q.toTitle)),
            'and never proposes a shelf it is already on');
        // The counts have to follow the mode, or "WSP 97" sits above a list of two.
        ok(mis.counts && mis.counts.misfiled === (mis.queue || []).length,
            'and it follows the mode', JSON.stringify(mis.counts));

        // The third queue: also in Other, but nothing matched — so there is no
        // shelf on the row and the server must refuse to file it blind. This is
        // the pile that had no screen at all before 0058.
        const none = await (await fetch(`${BASE}/shopify-recat?view=review&store=OVL&mode=unmatched`,
            { headers: { 'x-user-pin': PIN } })).json();
        ok(none.mode === 'unmatched', 'the No Suggestion queue loads', `${none.queue?.length} rows at OVL`);
        ok((none.queue || []).every(q => !q.to && q.rule === 'no match'),
            'and every row arrives with NO shelf on it — that is the whole point');
        ok(none.counts && none.counts.unmatched === (none.queue || []).length,
            'and its count follows the mode', JSON.stringify(none.counts));
        if ((none.queue || []).length) {
            // THE ONE THAT MATTERS HERE. A row with no category chosen is a
            // question, not an instruction, and filing it "somewhere" would put
            // stock on a shelf nobody picked.
            const blind = await post({ action: 'apply', store: 'OVL', mode: 'unmatched',
                items: [{ productId: none.queue[0].productId }] });
            ok(blind.status === 400 && /no category chosen/.test(blind.body.error || ''),
                'and it cannot be filed without one', blind.body.error || `HTTP ${blind.status}`);
        }

        const counts = await (await fetch(`${BASE}/shopify-recat?view=counts`,
            { headers: { 'x-user-pin': PIN } })).json();
        ok(Object.keys(counts.other || {}).length === 5 && Object.keys(counts.misfiled || {}).length === 5
            && Object.keys(counts.unmatched || {}).length === 5,
            'the district counts cover every store, in all three queues', JSON.stringify(counts.unmatched));
        // The All Stores card reads this, and a card is per store — one total
        // would put the same number on five different shops.
        ok(new Set(Object.values(counts.other || {})).size > 1,
            'per store, not one number repeated', JSON.stringify(counts.misfiled));

        // THE STOREFRONT IS THE ORACLE. Both queues promise to show only
        // stock a shopper can actually reach, and the only way to check that
        // from outside is to go and look: an unpublished product answers 404
        // at /products/<handle> (measured on two BAL units), a published one
        // 302s to the custom domain and 200s. This is also the exact URL
        // behind the View link on every row, so a pass means nobody is handed
        // a 404 mid-review.
        console.log("");
        console.log("== every queued row is live on the online store ==");
        const sample = [...(r0.queue || []).slice(0, 3), ...(mis.queue || []).slice(0, 2)]
            .filter(q => q.handle && q.shop);
        ok(sample.length > 0, "there are rows to check", String(sample.length));
        for (const q of sample) {
            const url = "https://" + q.shop + "/products/" + q.handle;
            const res = await fetch(url, { redirect: "follow" }).catch(() => null);
            ok(res?.status === 200, "on the storefront: " + q.title.slice(0, 46),
                res ? String(res.status) : "no answer");
        }

        const victim = r0.queue?.[0]?.productId;
        if (victim) {
            const sk = await post({ action: 'skip', store: 'OVL', productId: victim, reason: 'harness' });
            ok(sk.body.ok === true, 'a row can be skipped');
            const mid = await review('OVL');
            ok(mid.queue.length === r0.queue.length - 1, 'and leaves the queue', `${r0.queue.length} → ${mid.queue.length}`);
            const un = await post({ action: 'unskip', store: 'OVL', productId: victim });
            ok(un.body.ok === true, 'and the skip can be undone');
            const back = await review('OVL');
            ok(back.queue.length === r0.queue.length, 'which puts it back', `${back.queue.length}`);
        }
    } else {
        console.log('\n== the panel API ==\n  SKIPPED (set SPEEKS_TEST_PIN to a corp PIN)');
    }
    // A shelf we invent is a shelf no shopper can reach, no franchise report
    // knows about, and nobody but us can maintain. PayMore has 63; 62 can
    // hold filed stock, because `newly-listed-devices` is a smart collection
    // holding every product at every store rather than a category, and it is
    // the one shelf the picker and the matcher both leave out.
    console.log("\n== the shelves are the ones PayMore has ==");
    ok(cats.length === 62, 'the vocabulary offers exactly the shelves PayMore has, less the smart one',
        String(cats.length) + ' of 63');
    ok(!known.has('projectors'),
        'and no Projectors shelf — that one was ours, and it was deleted');


    console.log('\n== the matcher still answers ==');
    const sweep = await get(`${BASE}/callback-match?sweep=1&dryRun=1&secret=${SECRET}`);
    ok(sweep.ok === true, 'the dry sweep runs', sweep.error || '');
    ok(sweep.summary?.typesLoaded === cats.reduce((n, c) => n + (c.types || []).length, 0),
        'and loads exactly the vocabulary the quick-add offers',
        `${sweep.summary?.typesLoaded} types`);
    ok(sweep.summary?.skippedNoCategory === 0, 'no open row is missing its category gate');
    ok(sweep.summary?.itemsScanned > 0, 'stock was scanned', `${sweep.summary?.itemsScanned} units`);

    console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
    process.exit(fails ? 1 : 0);
})();
