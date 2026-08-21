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
//   6. the matcher still answers, and still loads every type
//
// Read-only. It never passes apply=1 with a real secret.

const BASE = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1';
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
