// The stretch factor, per store.
//
// THE RULE. listing_config holds goal_factor as the district default and
// goal_factor_<STORE> as one store's override. A store with no row of its own
// runs the district number — which is what all five did before this existed, so
// nothing changes until a store is deliberately moved.
//
// WHY THIS HARNESS. The factor is resolved TWICE: once in the store-targets edge
// function, which computes the goal, and once in ListingGoalsEngine, which
// computes each person's daily goal in the browser. Those two disagreeing is the
// exact drift the codebase already warns about — see the note on the cfg payload
// in store-targets ("a duplicated constant is exactly how the old baseForSize
// ladder drifted out of step with its server twin"). So both real
// implementations are lifted out of their own files and checked against each
// other, rather than either being restated here.
//
// The third assertion is the one that is easy to get wrong by hand: when the
// DISTRICT default moves, the stores that have their own factor must NOT be
// re-frozen. Re-freezing them would jump their goal to the district number,
// which is the single thing a per-store dial exists to prevent.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const srvSrc = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'store-targets', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');
const cliSrc = fs.readFileSync(path.join(ROOT, 'speeks.js'), 'utf8').replace(/\r\n/g, '\n');

// --- the server's resolver, with its type annotations stripped ---------------
const SRV_SIG = 'function factorFor(store: string, cfg: Cfg): number {';
const si = srvSrc.indexOf(SRV_SIG);
if (si < 0) throw new Error('missing server factorFor');
const srvBody = srvSrc.slice(si + SRV_SIG.length, srvSrc.indexOf('\n}\n', si));
const srvFactorFor = new Function('store', 'cfg', srvBody);

// --- the engine's resolver, as a method on a stand-in --------------------------
const CLI_SIG = '    factorFor(store) {';
const ci = cliSrc.indexOf(CLI_SIG);
if (ci < 0) throw new Error('missing engine factorFor');
const cliBody = cliSrc.slice(ci + CLI_SIG.length, cliSrc.indexOf('\n    },', ci));
const cliRaw = new Function('store', cliBody);
// The engine keeps overrides in _factors (per store) and the district default in
// cfg.goal_factor, so a cfg map is translated into that shape rather than the
// engine being handed something it would never see.
const cliFactorFor = (store, cfg) => {
    const _factors = {};
    Object.keys(cfg).forEach((k) => {
        if (k.indexOf('goal_factor_') === 0) _factors[k.slice('goal_factor_'.length)] = cfg[k];
    });
    return cliRaw.call({ _factors, cfg: { goal_factor: cfg.goal_factor } }, store);
};

// --- the re-freeze rule, lifted as the statement it actually is ----------------
const TOUCHED = srvSrc.match(/const touched = target[\s\S]*?;\n/);
if (!TOUCHED) throw new Error('missing the touched statement');
const touchedFor = (target, cfg, STORES) =>
    new Function('target', 'cfg', 'STORES', TOUCHED[0] + ' return touched;')(target, cfg, STORES);

const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];

let fails = 0;
const is = (what, got, want) => {
    const ok = String(got) === String(want);
    if (!ok) fails++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}   got ${got}, want ${want}`);
};

// Ethan's own example (2026-09-07): "I want LEE at 0.78 and OVL at 0.75."
const CFG = {
    goal_factor: 0.78,
    goal_factor_OVL: 0.75,
};

console.log('resolving one store');
is('LEE follows the district default', srvFactorFor('LEE', CFG), 0.78);
is('OVL runs its own', srvFactorFor('OVL', CFG), 0.75);
is('a store with no row at all follows the default', srvFactorFor('BAL', CFG), 0.78);
is('lower case resolves the same', srvFactorFor('ovl', CFG), 0.75);

console.log('\nthe server and the browser agree');
{
    // Every store against a config where some are set and some are not. These
    // two resolvers live in different languages in different files; if they ever
    // disagree, a store's weekly goal and its people's daily goals stop adding
    // up, and nothing else in the app would say so.
    const mixed = { goal_factor: 0.7, goal_factor_OVL: 0.85, goal_factor_MPL: 0.6, goal_factor_LEE: 0.78 };
    let agree = true;
    STORES.forEach((s) => {
        const a = srvFactorFor(s, mixed);
        const b = cliFactorFor(s, mixed);
        if (a !== b) { agree = false; is(s + ': server vs browser', a, b); }
    });
    if (agree) is('all five resolve identically in both', 'true', 'true');
    is('...and an unset store gets the default in the browser too', cliFactorFor('BAL', mixed), 0.7);
}

console.log('\nmoving the district default');
{
    const cfg = { goal_factor: 0.8, goal_factor_OVL: 0.75, goal_factor_MPL: 0.6 };
    // No store named = the district default moved. Only the stores actually
    // following it may be re-frozen.
    const t = touchedFor(null, cfg, STORES);
    is('re-freezes only the stores on the default', t.slice().sort().join(','), 'BAL,LEE,WSP');
    is('...leaves OVL alone', t.includes('OVL'), false);
    is('...leaves MPL alone', t.includes('MPL'), false);
    // One store named = only that store, whether or not it had a row before.
    is('naming a store touches only it', touchedFor('LEE', cfg, STORES).join(','), 'LEE');
    is('...including one that already had its own', touchedFor('OVL', cfg, STORES).join(','), 'OVL');
    // Nobody overridden yet: the default still moves all five, which is the
    // behaviour this replaced and must not have broken.
    is('with no overrides the default still moves all five',
        touchedFor(null, { goal_factor: 0.75 }, STORES).join(','), STORES.join(','));
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
