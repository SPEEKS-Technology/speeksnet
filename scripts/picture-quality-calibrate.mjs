// Picture Quality — score the live function against Ethan's hand-graded answer
// keys. DRY RUN: nothing is saved, no listing is touched; a full run costs about
// a dollar of model time.
//
//   node scripts/picture-quality-calibrate.mjs                     # Sonnet 5, medium
//   node scripts/picture-quality-calibrate.mjs claude-opus-5 low   # compare
//   STORE=OVL node scripts/picture-quality-calibrate.mjs           # one key only
//   VERBOSE=1 …                                                    # every listing's reasons
//
// The bar to ship on is 90%. A change counts only if it holds on BOTH keys: the
// OVL framing fix could easily have re-broken the WSP passes, which is exactly
// why both are scored together. A miss is printed with the function's reasons
// next to Ethan's — every disagreement is a prompt fix or an unwritten rule.

const FN = "https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/picture-quality";
const SECRET = "sp33ks-sync-k3y-2026-x9mq";
const [model = "claude-sonnet-5", effort = "medium"] = process.argv.slice(2);

// flag = retake | fix | reorder — a reorder is an action a manager approves,
// and Ethan kept the Surface's out-of-place Everything Included as a flag.
// [store, product id, name, Ethan's verdict ("?" = not scored yet), why]
const KEY = [
  // WSP, graded 2026-09-24/25.
  ["WSP", "15272410677414", "iPhone 11 (Broken)", "flag", "photo 9 not square"],
  ["WSP", "15803392819366", "PS5 Slim", "pass", "good enough"],
  ["WSP", "15626324279462", "Surface Laptop Go 3", "flag", "Everything Included out of place; no Screen Off"],
  ["WSP", "15319498064038", "AirPods Max", "pass", "fine"],
  ["WSP", "15788162154662", "Canon EF-S lens", "pass", "closeups are deliberate; lead shows the lens"],
  ["WSP", "15283852869798", "Super Mario Party", "pass", "cartridge only, 2 closeups is right (title: add Cartridge Only)"],
  ["WSP", "15286757884070", "Apple Watch SE", "flag", "retake — too many missing"],
  ["WSP", "15210666066086", "Pyle speaker pair", "flag", "pair shots must show both; reorder; title PDWR52BTBK Bluetooth"],
  ["WSP", "15236885184678", "Acer Aspire (Broken)", "flag", "retake following the guide"],
  ["WSP", "15220477886630", "Epson projector", "flag", "photo 5 looks fake; opposite side, lens closed, top missing"],
  // OVL, graded 2026-09-25 — chosen to cover sheets WSP did not.
  ["OVL", "8212164968550", "Galaxy S26 Ultra", "pass", "settings screen and top side are both there"],
  ["OVL", "8211779977318", "Sony Alpha 7 IV", "?", "should use Point and Shoot — verdict after re-grade"],
  ["OVL", "8015504113766", "Micron 4GB RAM", "flag", "photos 2 and 3 blurry"],
  ["OVL", "8172635422822", "Xbox One controller", "pass", "serial is under the battery cover — not needed"],
  ["OVL", "7699563577446", "Final Fantasy XV", "pass", "correct"],
  ["OVL", "8035957506150", "Yoshi's Island DS", "flag", "not square"],
  ["OVL", "8228554080358", "iPhone SE 2 (Broken)", "flag", "top/bottom not to standard; crooked, not centred"],
  ["OVL", "8166421790822", "Lot of 13 Dell WD15", "pass", "no box — box shots were only an example"],
  ["OVL", "9052414771302", "Synology DS224+", "pass", "correct"],
  ["OVL", "8168794882150", "Ray-Ban Meta (New)", "pass", "all box sides were shown"],
  ["OVL", "8106562322534", "Death Stranding 2 (sealed)", "pass", "sealed: front + back is fine — regressed 2026-10-01 on a Recheck graded on New In Box; gameSheetFor now forces the game sheet"],
  ["OVL", "8229239717990", "iPad 8th Gen", "flag", "not full frame at times, some crooked"],
];

const asFlag = v => ["retake", "fix", "reorder"].includes(v) ? "flag" : v;

// ONE listing per call, THREE calls at a time. The edge wall is 150s of
// silence, and a flagged listing now gets two looks — two such listings in one
// call timed out. And all eleven calls at once got Shopify's THROTTLED: every
// call also reads the store's catalogue for the boilerplate count.
const only = process.env.STORE;
const onlyIds = (process.env.IDS || "").split(",").filter(Boolean);   // IDS=15210666066086,… re-runs just those
const keyed = KEY.filter(k => (!only || k[0] === only) && (!onlyIds.length || onlyIds.includes(k[1])));
const calls = keyed.map(k => [k[0], [k[1]]]);
const results = [];
const runOne = async ([st, ids], n) => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await fetch(`${FN}?secret=${SECRET}&store=${st}&ids=${ids.join(",")}&model=${model}&effort=${effort}`);
    const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    // The function streams keep-alive spaces, so a failure can arrive as a 200.
    if (r.ok && !body.error) {
      results.push(...body.results);
      console.log(`call ${n + 1} (${st}): $${body.cost_usd}  ${JSON.stringify(body.verdicts)}`);
      return;
    }
    console.error(`call ${n + 1} (${st}) attempt ${attempt} failed:`, JSON.stringify(body).slice(0, 200));
    if (!/THROTTLED/.test(JSON.stringify(body))) return;
    await new Promise(res => setTimeout(res, 5000));
  }
};
let next = 0;
await Promise.all([0, 1, 2].map(async () => { while (next < calls.length) { const n = next++; await runOne(calls[n], n); } }));

let agree = 0, scored = 0, cost = 0;
console.log(`\n${model} @ ${effort}\n`);
for (const [st, id, name, want, why] of keyed) {
  const r = results.find(x => x.product_id.endsWith("/" + id));
  const got = r ? asFlag(r.verdict) : "missing";
  const ok = want === "?" || got === want;
  if (want !== "?") { scored++; if (ok) agree++; }
  cost += Number(r?.cost_usd || 0);
  const mark = want === "?" ? "·" : ok ? "✓" : "✗";
  console.log(`${mark} ${st} ${name.padEnd(26)} Ethan: ${want.padEnd(4)}  tool: ${String(r?.verdict).padEnd(8)} [${r?.sheet_name || "-"}]`);
  if (!ok || want === "?" || process.env.VERBOSE) {
    console.log(`    Ethan: ${why}`);
    for (const f of r?.findings || []) console.log(`    tool:  ${f.text}`);
    if (r?.reorder) console.log(`    tool:  reorder ${r.reorder.current.join(",")} → ${r.reorder.suggested.join(",")} (${(r.reorder.why || []).join("; ")})`);
    if (r?.report?.secondLook) console.log(`    looks: 1st ${r.report.firstLook.verdict} (${r.report.firstLook.findings.join(" | ") || "-"}) · 2nd ${r.report.secondLook.verdict} (${r.report.secondLook.findings.join(" | ") || "-"})`);
    for (const t of r?.title_notes || []) console.log(`    title: ${t.issue} → ${t.suggestion}`);
    const ca = r?.report?.cache || {};
    console.log(`    cost:  $${r?.cost_usd} · in ${r?.input_tokens} (cache read ${ca.read || 0}) · out ${r?.output_tokens} · ${r?.photo_count} photos${r?.report?.reSheeted ? " · re-sheeted" : ""}`);
  }
}
console.log(`\n${agree}/${scored} agree with Ethan (${Math.round(agree / Math.max(scored, 1) * 100)}%) · model cost $${cost.toFixed(4)} · ship bar 90%`);
