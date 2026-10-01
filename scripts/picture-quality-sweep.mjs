// Grade a store's live listings for Picture Quality and SAVE them, a batch at a
// time, until the store is done or the spend cap is reached.
//
//   node scripts/picture-quality-sweep.mjs OVL            # default cap $5
//   node scripts/picture-quality-sweep.mjs OVL 40         # cap $40
//
// Only listings never graded, or whose photos / notes / guide sheet changed
// since, are paid for (see sweepCandidates in the function). Safe to stop and
// re-run: every finished batch is already saved. Nothing on a listing changes.
const FN = "https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/picture-quality";
const SECRET = "sp33ks-sync-k3y-2026-x9mq";
const [store, capArg] = process.argv.slice(2);
if (!store) { console.error("usage: node scripts/picture-quality-sweep.mjs <STORE> [cap $]"); process.exit(1); }
const cap = Number(capArg || 5);
const BATCH = 4;   // four listings per call: two looks each stays well inside the wall

let spent = 0, graded = 0;
const tally = {};
for (let round = 1; spent < cap; round++) {
  const r = await fetch(`${FN}?secret=${SECRET}&store=${store}&sweep=${BATCH}`);
  const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || body.error) {
    console.error(`round ${round} failed:`, JSON.stringify(body).slice(0, 300));
    if (/THROTTLED/.test(JSON.stringify(body))) { await new Promise(res => setTimeout(res, 8000)); continue; }
    break;
  }
  if (body.done || !body.reviewed) { console.log(`${store}: nothing left to grade (${body.live} live).`); break; }
  spent += Number(body.cost_usd || 0);
  graded += body.reviewed;
  for (const [k, v] of Object.entries(body.verdicts || {})) tally[k] = (tally[k] || 0) + v;
  console.log(`round ${round}: ${body.reviewed} graded ${JSON.stringify(body.verdicts)} · $${Number(body.cost_usd).toFixed(2)}`
    + ` · never graded left: ${body.remaining} of ${body.live}`);
}
console.log(`\n${store}: ${graded} graded, $${spent.toFixed(2)} · ${JSON.stringify(tally)}`);
