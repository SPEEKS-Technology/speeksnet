// Picture Quality — score the live function against Ethan's hand-graded answer
// key (ten WSP listings, graded 2026-09-24/25). DRY RUN: nothing is saved, no
// listing is touched; it costs a few cents of model time per run.
//
//   node scripts/picture-quality-calibrate.mjs                     # Sonnet 5, low
//   node scripts/picture-quality-calibrate.mjs claude-opus-5 low   # compare
//
// The bar to ship on is 9 of 10. A miss is printed with the function's reasons
// next to Ethan's, which is the whole point: every disagreement is either a
// prompt fix or a rule we have not written down yet.

const FN = "https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/picture-quality";
const SECRET = "sp33ks-sync-k3y-2026-x9mq";
const [model = "claude-sonnet-5", effort = "low"] = process.argv.slice(2);

// flag = retake | fix | reorder — a reorder is an action a manager approves,
// and Ethan kept the Surface's out-of-place Everything Included as a flag.
const KEY = [
  ["15272410677414", "iPhone 11 (Broken)", "flag", "photo 9 not square"],
  ["15803392819366", "PS5 Slim", "pass", "good enough"],
  ["15626324279462", "Surface Laptop Go 3", "flag", "Everything Included out of place; no Screen Off"],
  ["15319498064038", "AirPods Max", "pass", "fine"],
  ["15788162154662", "Canon EF-S lens", "pass", "closeups are deliberate; lead shows the lens"],
  ["15283852869798", "Super Mario Party", "pass", "cartridge only, 2 closeups is right (title: add Cartridge Only)"],
  ["15286757884070", "Apple Watch SE", "flag", "retake — too many missing"],
  ["15210666066086", "Pyle speaker pair", "flag", "pair shots must show both; reorder; title PDWR52BTBK Bluetooth"],
  ["15236885184678", "Acer Aspire (Broken)", "flag", "retake following the guide"],
  ["15220477886630", "Epson projector", "flag", "photo 5 looks fake; opposite side, lens closed, top missing"],
];

const asFlag = v => ["retake", "fix", "reorder"].includes(v) ? "flag" : v;

const results = [];
for (let i = 0; i < KEY.length; i += 5) {           // two calls: the edge wall is 150s
  const ids = KEY.slice(i, i + 5).map(k => k[0]).join(",");
  const r = await fetch(`${FN}?secret=${SECRET}&store=WSP&ids=${ids}&model=${model}&effort=${effort}`);
  const body = await r.json();
  if (!r.ok) { console.error("function error:", body); process.exit(1); }
  results.push(...body.results);
  console.log(`batch ${i / 5 + 1}: $${body.cost_usd}  ${JSON.stringify(body.verdicts)}`);
}

let agree = 0, cost = 0;
console.log(`\n${model} @ ${effort}\n`);
for (const [id, name, want, why] of KEY) {
  const r = results.find(x => x.product_id.endsWith("/" + id));
  const got = r ? asFlag(r.verdict) : "missing";
  const ok = got === want;
  if (ok) agree++;
  cost += Number(r?.cost_usd || 0);
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(22)} Ethan: ${want.padEnd(4)}  tool: ${String(r?.verdict).padEnd(8)} [${r?.sheet_name || "-"}]`);
  if (!ok || process.env.VERBOSE) {
    console.log(`    Ethan: ${why}`);
    for (const f of r?.findings || []) console.log(`    tool:  ${f.text}`);
    if (r?.reorder) console.log(`    tool:  reorder ${r.reorder.current.join(",")} → ${r.reorder.suggested.join(",")} (order ${r.reorder.score})`);
    for (const t of r?.title_notes || []) console.log(`    title: ${t.issue} → ${t.suggestion}`);
    const ca = r?.report?.cache || {};
    console.log(`    cost:  ${r?.cost_usd} · in ${r?.input_tokens} (cache read ${ca.read || 0}, wrote ${ca.wrote || 0}) · out ${r?.output_tokens} · ${r?.photo_count} photos${r?.report?.reSheeted ? ' · re-sheeted' : ''}`);
  }
}
console.log(`\n${agree}/10 agree with Ethan · model cost $${cost.toFixed(4)} (ship bar: 9/10)`);
