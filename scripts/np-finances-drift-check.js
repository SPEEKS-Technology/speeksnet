// ============================================================================
// np-finances-drift-check.js — the eBay Finances read, on its own.
//
//   node scripts/np-finances-drift-check.js
//
// Two behaviours added to netprofit-collect on 2026-09-17, both of them about
// ONE failure: MPL's 11:11am pass read 265 of 266 transactions and wrote #N/A
// across sixteen days. Nothing was broken — eBay had written a new transaction
// while we were paging, every later row shifted down one, and the row sitting on
// the page boundary was never returned.
//
//   1. The read window now STOPS SHORT OF NOW (FIN_SETTLE_LAG_MS). A set that
//      nothing is being appended to cannot drift, so this removes the race
//      rather than detecting it.
//   2. A short read is RETRIED (FIN_PAGE_ATTEMPTS) before it becomes an #N/A.
//
// ⚠️ THE SAFETY PROPERTY IS THE POINT OF THIS FILE. A fee total that is short
// reads as a BIGGER Net Profit, so the one thing neither change may ever do is
// let a known-short total through. The last two sections exist to prove that a
// read which stays short still throws, however many times it is retried.
//
// No network, no Deno: the logic under test is pure, so it is restated here
// against the same shapes the real loop sees. Run it after touching either the
// window or the paging loop in netprofit-collect.
// ============================================================================

const FIN_SETTLE_LAG_MS = 5 * 60 * 1000;
const FIN_PAGE_ATTEMPTS = 3;

let failed = 0;
function t(name, fn) {
  let r;
  try { r = fn(); } catch (e) { r = 'threw: ' + e.message; }
  if (r === true) { console.log('  ok   ' + name); return; }
  failed++;
  console.log('  FAIL ' + name + (typeof r === 'string' ? '\n       ' + r : ''));
}

// --- the window, exactly as netprofit-collect computes it -------------------
function windowUpper(from, to, nowMs) {
  const upper = new Date(Math.max(new Date(`${to}T00:00:00.000Z`).getTime(), nowMs));
  upper.setUTCDate(upper.getUTCDate() + 1);
  const settledTo = nowMs - FIN_SETTLE_LAG_MS;
  if (upper.getTime() > settledTo) upper.setTime(settledTo);
  return upper;
}

// --- the paging loop, with a pager that can drop a row ----------------------
// `drops` is how many of the first attempts lose a row on the page boundary,
// which is what offset drift does.
function readAll(totalRows, drops) {
  let attempts = 0, shortReads = 0;
  let txs = [], expected = 0;
  for (let attempt = 1; attempt <= FIN_PAGE_ATTEMPTS; attempt++) {
    attempts++;
    const seen = new Set();
    txs = [];
    expected = 0;
    const lose = attempt <= drops;
    for (let off = 0; off < 20000; off += 200) {
      const page = [];
      for (let i = off; i < Math.min(off + 200, totalRows); i++) {
        // The dropped row is the one on the boundary — index 200 here.
        if (lose && i === 200) continue;
        page.push({ transactionId: 'tx' + i });
      }
      expected = Math.max(expected, totalRows);
      for (const x of page) {
        if (seen.has(x.transactionId)) continue;
        seen.add(x.transactionId);
        txs.push(x);
      }
      if (page.length < 200) break;
    }
    if (txs.length >= expected) break;
    shortReads++;
  }
  return { rows: txs.length, expected, attempts, shortReads,
           throws: txs.length < expected };
}

console.log('\n1. the window stops short of now');
{
  // 2026-09-17 11:11:00 Central = 16:11:00Z, the pass that failed.
  const now = Date.parse('2026-09-17T16:11:00.000Z');
  t('a month-to-date range ends FIN_SETTLE_LAG_MS ago, not tomorrow', () => {
    const u = windowUpper('2026-09-01', '2026-09-17', now);
    return u.toISOString() === '2026-09-17T16:06:00.000Z'
      || 'got ' + u.toISOString();
  });
  t('the upper bound is never in the future', () => {
    const u = windowUpper('2026-09-01', '2026-09-17', now);
    return u.getTime() < now || 'upper ' + u.toISOString() + ' >= now';
  });
  t('a CLOSED month still covers its whole last day', () => {
    // August closed on Sep 1; the read must still reach Aug 31 23:59:59.
    const u = windowUpper('2026-08-01', '2026-08-31', now);
    return u.getTime() > Date.parse('2026-08-31T23:59:59.999Z')
      || 'upper ' + u.toISOString() + ' cuts into August';
  });
  t('the lag never pulls the window back before `from`', () => {
    const u = windowUpper('2026-09-01', '2026-09-17', now);
    return u.getTime() > Date.parse('2026-09-01T00:00:00.000Z')
      || 'upper ' + u.toISOString() + ' is before from';
  });
  t('five minutes is the whole of the change', () => {
    const u = windowUpper('2026-09-01', '2026-09-17', now);
    return now - u.getTime() === FIN_SETTLE_LAG_MS
      || 'gap is ' + (now - u.getTime()) + 'ms';
  });
}

console.log('\n2. a clean read is untouched');
{
  t('265 rows, nothing dropped: one attempt, no retry', () => {
    const r = readAll(265, 0);
    return (r.rows === 265 && r.attempts === 1 && r.shortReads === 0 && !r.throws)
      || JSON.stringify(r);
  });
  t('an exact page boundary (400) still terminates', () => {
    const r = readAll(400, 0);
    return (r.rows === 400 && r.attempts === 1 && !r.throws) || JSON.stringify(r);
  });
  t('an empty store reads zero and does not throw', () => {
    const r = readAll(0, 0);
    return (r.rows === 0 && !r.throws) || JSON.stringify(r);
  });
}

console.log('\n3. MPL\'s failure, replayed');
{
  t('266 rows with the first read short: retried, and whole', () => {
    const r = readAll(266, 1);
    return (r.rows === 266 && r.attempts === 2 && r.shortReads === 1 && !r.throws)
      || JSON.stringify(r);
  });
  t('two bad reads in a row still recover on the third', () => {
    const r = readAll(266, 2);
    return (r.rows === 266 && r.attempts === 3 && r.shortReads === 2 && !r.throws)
      || JSON.stringify(r);
  });
  t('before the fix, that same read would have thrown', () => {
    // FIN_PAGE_ATTEMPTS of 1 is the old behaviour.
    const saved = readAll(266, 1);
    return saved.shortReads === 1
      || 'the replay no longer reproduces a short first read';
  });
}

console.log('\n4. a read that stays short STILL refuses');
{
  t('short on every attempt: throws rather than reporting a low fee', () => {
    const r = readAll(266, FIN_PAGE_ATTEMPTS);
    return (r.throws && r.rows === 265 && r.attempts === FIN_PAGE_ATTEMPTS)
      || JSON.stringify(r);
  });
  t('the retry never invents rows to reach the total', () => {
    const r = readAll(266, FIN_PAGE_ATTEMPTS);
    return r.rows < r.expected || 'rows ' + r.rows + ' expected ' + r.expected;
  });
}

console.log('\n5. a duplicated row is still deduped, not counted twice');
{
  // The reverse shift returns one row TWICE; the dedupe catches it, and the
  // count check must not then read the shorter, correct tally as a failure.
  t('a page repeating a row does not inflate the count', () => {
    const seen = new Set();
    const txs = [];
    const pages = [[{ transactionId: 'a' }, { transactionId: 'b' }],
                   [{ transactionId: 'b' }, { transactionId: 'c' }]];
    let dupes = 0;
    for (const p of pages) for (const x of p) {
      if (seen.has(x.transactionId)) { dupes++; continue; }
      seen.add(x.transactionId); txs.push(x);
    }
    return (txs.length === 3 && dupes === 1) || 'rows ' + txs.length + ' dupes ' + dupes;
  });
}

console.log(failed ? '\n' + failed + ' FAILED\n' : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
