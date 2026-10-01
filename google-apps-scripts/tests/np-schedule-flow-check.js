// The Net Profit pass, run end to end against stubbed Apps Script services.
//
//   node google-apps-scripts/tests/np-schedule-flow-check.js
//
// np-health-check.js tests the DECISIONS — pure functions lifted out one at a
// time. This tests the WIRING: the real netprofit-sheet.gs and netprofit-schedule
// .gs loaded whole, npsDailyRefresh / npsWatchdog / npsTailRecovery actually
// called, and the stamps, run-log rows and triggers they leave behind checked.
//
// Exists because of 2026-09-17. The watchdog's completion stamp had been placed
// where no pass ever reached it, and nothing short of production could show that:
// every pure function was right and the pass as a whole never finished. A mistyped
// variable inside npsDailyRefresh would likewise pass every unit test and fail at
// 8:05 the next morning, silently, at the point it runs.
//
// What is real: everything in the two files. What is stubbed: Google's services
// (properties, triggers, UrlFetchApp, the clock) and the four steps that touch the
// workbook or other files (_npWrite's sheet I/O, the summary strip, the report,
// the YoY pass), each of which a scenario can make succeed or throw.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};

// A Central wall-clock time, as the instant it is. September is CDT (UTC-5).
const central = (ymd, hh, mm) => Date.parse(`${ymd}T${String(hh).padStart(2, '0')}:${String(mm || 0).padStart(2, '0')}:00-05:00`);

function world() {
    const props = new Map();
    const w = {
        props, now: central('2026-09-17', 8, 5), posts: [], triggers: [], emails: [],
        steps: { write: 'ok', summary: 'ok', report: 'ok', yoy: 'ok' },
    };
    const RealDate = Date;
    class FakeDate extends RealDate {
        constructor(...a) { super(...(a.length ? a : [w.now])); }
        static now() { return w.now; }
    }
    const fmt = (d, tz, pattern) => {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
        }).formatToParts(new RealDate(d.getTime())).map(p => [p.type, p.value]));
        if (pattern === 'yyyy-MM-dd') return `${parts.year}-${parts.month}-${parts.day}`;
        if (pattern === 'H') return String(Number(parts.hour));
        if (pattern === 'h:mma') { const h = Number(parts.hour); return `${h % 12 || 12}:${parts.minute}${h < 12 ? 'AM' : 'PM'}`; }
        return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
    };
    const trig = name => {
        const t = { name, uid: 'uid' + (w.triggers.length + 1) };
        const b = { timeBased: () => b, after: () => b, atHour: () => b, nearMinute: () => b,
            everyDays: () => b, inTimezone: () => b, create: () => { w.triggers.push(t); return { getUniqueId: () => t.uid }; } };
        return b;
    };
    const ctx = {
        Date: FakeDate, Intl, JSON, Math, String, Number, Object, Array, RegExp, Error,
        console,
        Logger: { log: () => {} },
        PropertiesService: { getScriptProperties: () => ({
            getProperty: k => (props.has(k) ? props.get(k) : null),
            setProperty: (k, v) => { props.set(k, String(v)); },
            deleteProperty: k => { props.delete(k); },
        }) },
        Utilities: { formatDate: fmt, sleep: ms => { w.now += ms; } },
        UrlFetchApp: {
            fetch: (url, opts) => {
                if (/netprofit-runlog/.test(url)) w.posts.push(JSON.parse(opts.payload));
                return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' };
            },
        },
        ScriptApp: { newTrigger: trig, getProjectTriggers: () => [], deleteTrigger: () => {} },
        LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    };
    vm.createContext(ctx);
    vm.runInContext(read('netprofit-sheet.gs'), ctx, { filename: 'netprofit-sheet.gs' });
    vm.runInContext(read('netprofit-schedule.gs'), ctx, { filename: 'netprofit-schedule.gs' });
    // The workbook-touching steps and the other files' functions. Each advances
    // the clock the way the real one roughly does, and obeys w.steps.
    ctx.__w = w;
    vm.runInContext(`
        var NPX_BUDGET_MS = 210000;
        var NP_HEALTH = [];
        function _npsEnsureTab() { return true; }
        function _npaSnapshot() { return {}; }
        function _npWrite() {
            __w.now += 60000;
            NP_LAST_FETCH = { OVL: { ok: true, collector_ms: 34000 } };
            if (__w.steps.write !== 'ok') throw new Error('write: ' + __w.steps.write);
        }
        function _npaSendHealth() {}
        function _npxSync() { __w.now += 20000; if (__w.steps.summary !== 'ok') throw new Error('summary: ' + __w.steps.summary); }
        function _npaReport() { if (__w.steps.report !== 'ok') throw new Error('report: ' + __w.steps.report); }
        function _syoySync() { if (__w.steps.yoy !== 'ok') throw new Error('yoy: ' + __w.steps.yoy); }
        function _npaSendFailure(where, detail) { __w.emails.push({ kind: 'failure', where: where, detail: detail }); }
        function _npaSendRestarted(where, detail) { __w.emails.push({ kind: 'restarted', where: where, detail: detail }); }
    `, ctx);
    w.ctx = ctx;
    w.phases = () => w.posts.map(p => p.phase);
    return w;
}
const run = (w, fn, e) => { try { w.ctx[fn](e); return null; } catch (err) { return err; } };

console.log('\n1. A normal 8:05 pass: every phase logged, both stamps set');
{
    const w = world();
    const err = run(w, 'npsDailyRefresh', { triggerUid: 'cron1' });
    ok(!err, 'ran without throwing', err && err.message);
    ok(w.phases().join(',') === 'start,snapshot,grid-written,health-sent,summary-done,report-done,yoy-done,done',
        'phases in order', w.phases().join(','));
    ok(w.props.get('NPS_LAST_OK_MORNING') === '2026-09-17', 'grid stamp set');
    ok(w.props.get('NPS_LAST_TAIL_MORNING') === '2026-09-17', 'tail stamp set');
    const g = w.posts.find(p => p.phase === 'grid-written');
    ok(g && g.detail && g.detail.fetch && g.detail.fetch.OVL, 'grid-written carries the per-store fetch result');
    ok(w.posts.every(p => p.run_id === w.posts[0].run_id && p.pass === 'morning' && p.trigger === 'cron'),
        'one run id, morning pass, labelled cron', w.posts[0] && w.posts[0].trigger);
    ok(w.posts[w.posts.length - 1].elapsed_ms >= 80000, 'elapsed time is carried', w.posts[w.posts.length - 1].elapsed_ms);
}

console.log('\n2. Sep 17 replayed: grid written, then the tail dies — NO restart, tail recovery instead');
{
    const w = world();
    w.steps.summary = 'killed';
    run(w, 'npsDailyRefresh', { triggerUid: 'cron1' });
    ok(w.props.get('NPS_LAST_OK_MORNING') === '2026-09-17', 'the grid stamp survived the tail failing');
    ok(!w.props.get('NPS_LAST_TAIL_MORNING'), 'the tail stamp did not');
    ok(w.phases().includes('failed'), 'the failure is in the run log', w.phases().join(','));

    w.now = central('2026-09-17', 9, 34); w.emails = []; w.triggers = [];
    w.steps.summary = 'ok';
    run(w, 'npsWatchdog', {});
    ok(!w.triggers.some(t => t.name === 'npsDailyRefresh'), 'the refresh is NOT restarted', w.triggers.map(t => t.name).join(','));
    ok(w.triggers.some(t => t.name === 'npsTailRecovery'), 'npsTailRecovery is scheduled');
    ok(w.emails.length === 0, 'and nobody is emailed about it', JSON.stringify(w.emails));

    w.posts = [];
    run(w, 'npsTailRecovery', { triggerUid: 'uid1' });
    ok(w.props.get('NPS_LAST_TAIL_MORNING') === '2026-09-17', 'the recovery sets the tail stamp');
    ok(w.posts.every(p => p.trigger === 'tail-recovery') && w.phases().join(',') === 'start,summary-done,yoy-done,done',
        'recovery phases logged under its own trigger', w.phases().join(','));

    w.now = central('2026-09-17', 9, 55); w.triggers = [];
    run(w, 'npsWatchdog', {});
    ok(w.triggers.length === 0 && w.emails.length === 0, 'the follow-up check finds it finished: quiet');
}

console.log('\n3. The tail fails twice: one email, naming where it stopped, and still no restart');
{
    const w = world();
    w.steps.summary = 'broken';
    run(w, 'npsDailyRefresh', { triggerUid: 'cron1' });
    w.now = central('2026-09-17', 9, 34); w.emails = [];
    run(w, 'npsWatchdog', {});
    run(w, 'npsTailRecovery', { triggerUid: 'uid1' });
    w.emails = []; w.triggers = [];
    w.now = central('2026-09-17', 9, 55);
    run(w, 'npsWatchdog', {});
    ok(w.emails.length === 1 && /summary strip/i.test(w.emails[0].where), 'one email about the summary strip',
        JSON.stringify(w.emails.map(e => e.where)));
    ok(w.emails[0] && /WERE written/.test(w.emails[0].detail), 'it says the grid figures are fine');
    ok(w.emails[0] && /Last step recorded: failed at \d+s \(tail-recovery\)\./.test(w.emails[0].detail),
        'and names the last step', w.emails[0] && w.emails[0].detail.slice(-80));
    ok(!w.triggers.some(t => t.name === 'npsDailyRefresh'), 'no restart of the refresh');
}

console.log('\n4. The grid itself fails: the old restart path, with where it stopped in the email');
{
    const w = world();
    w.steps.write = 'lock held';
    run(w, 'npsDailyRefresh', { triggerUid: 'cron1' });
    ok(!w.props.get('NPS_LAST_OK_MORNING'), 'no grid stamp');
    w.now = central('2026-09-17', 9, 34); w.emails = [];
    run(w, 'npsWatchdog', {});
    ok(w.triggers.some(t => t.name === 'npsDailyRefresh'), 'the refresh is restarted');
    const r = w.emails.find(e => e.kind === 'restarted');
    ok(r && /It got as far as: failed at \d+s \(cron\)/.test(r.detail), 'the email says where the pass got to', r && r.detail.slice(0, 160));
}

console.log('\n5. The pass never started at all: the email says so');
{
    const w = world();
    w.now = central('2026-09-17', 9, 34);
    run(w, 'npsWatchdog', {});
    const r = w.emails.find(e => e.kind === 'restarted');
    ok(r && /never started today/.test(r.detail), 'says it never started', r && r.detail.slice(0, 140));
}

console.log('\n6. A restarted pass is labelled a restart in the run log');
{
    const w = world();
    w.steps.write = 'x';
    run(w, 'npsDailyRefresh', { triggerUid: 'cron1' });
    w.now = central('2026-09-17', 9, 34);
    run(w, 'npsWatchdog', {});
    w.posts = []; w.steps.write = 'ok';
    run(w, 'npsDailyRefresh', { triggerUid: 'uid1' });
    ok(w.posts[0] && w.posts[0].trigger === 'restart', 'trigger = restart', w.posts[0] && w.posts[0].trigger);
}

console.log('\n7. A store that 504s is asked again once, inside the budget');
{
    const w = world();
    let calls = 0;
    w.ctx._npFetchAllStores = function (stores) {
        calls++;
        const out = {};
        stores.forEach(s => {
            out[s] = (s === 'OVL' && calls === 1)
                ? { err: 'OVL: collector returned HTTP 504 — {"code":"IDLE_TIMEOUT"}' }
                : { body: { days: [{}], timings_ms: { total: 30000 } } };
        });
        return out;
    };
    w.ctx.NP_PASS_T0 = w.now;
    const got = w.ctx._npFetchWithRetry(['OVL', 'LEE']);
    ok(calls === 2, 'fetched twice', calls);
    ok(!got.OVL.err && got.LEE.body, 'OVL recovered on the retry, LEE untouched');
    ok(w.ctx.NP_LAST_FETCH.OVL.retried === true && w.ctx.NP_LAST_FETCH.OVL.ok === true, 'and the run log will say so');

    calls = 0;
    w.ctx.NP_PASS_T0 = w.now - 200000;   // 200s already used
    const late = w.ctx._npFetchWithRetry(['OVL']);
    ok(calls === 1 && late.OVL.err, 'past the budget: not retried, the error stands', calls);

    calls = 0;
    w.ctx.NP_PASS_T0 = w.now;
    w.ctx._npFetchAllStores = function (stores) {
        calls++;
        const out = {}; stores.forEach(s => { out[s] = { err: s + ': collector returned HTTP 401 — unauthorised' }; });
        return out;
    };
    w.ctx._npFetchWithRetry(['OVL']);
    ok(calls === 1, 'a 401 is not retried', calls);
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
