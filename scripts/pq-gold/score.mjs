// ============================================================================
// Picture Quality GOLD SET — step 3: grade any model's output against gold.json.
//
//   node scripts/pq-gold/score.mjs <model-output.json>
//   node scripts/pq-gold/score.mjs scripts/pq-gold/baseline-graded.json   # today's saved grades
//   TIER=explicit node scripts/pq-gold/score.mjs out.json                 # only Ethan's exact calls
//   STALE=1 …     # also score labels whose photos changed since (normally skipped)
//   DECIDE=1 …    # verdict by rules.ts decide() even when the output carries one
//   JSON=1 …      # machine-readable result on stdout
//
// FREE and offline: reads two files, calls nothing.
//
// MODEL OUTPUT = the review shape the picture-quality function already uses
// ("the model reports, the code decides"), so Opus, Haiku and a local model
// are graded on the same thing. Any of:
//   [{ product_id, report: { photos: [{ n, shots, repeats, framing_problems, issues }], missing_shots, … },
//      verdict?, sheet? }]
//   { "<product_id>": report, … }
// product_id may be the gid or the bare number. Photo n is today's position.
//
// VERDICT: when a row carries one, it is used; when it does not (a bare model
// report — what a local model would produce), rules.ts decide() turns the
// report into one, exactly as the live function does. ⚠️ APPROXIMATE there:
// the database keeps only the cosmetic sentences, so decide() runs without the
// functional / included / condition notes, and an If-Needed shot the listing
// calls for (Everything Included, LCD Flaws) can go unasked. Scored as flag =
// retake | fix, pass = pass | reorder (a Quick Fix), as the calibration does.
//
// Reported by SHEET and by TIER (explicit = Ethan's exact call; accepted = a
// Quick Fix he approved). Accepted labels came from a saved grade, so scoring
// that same grade against them is circular — warned below, by stamp.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [outPath, goldArg] = process.argv.slice(2);
if (!outPath) { console.error("usage: node scripts/pq-gold/score.mjs <model-output.json> [gold.json]"); process.exit(1); }
const goldFile = JSON.parse(fs.readFileSync(goldArg || path.join(here, "gold.json"), "utf8"));
const TIER = process.env.TIER || "all";
const STALE = !!process.env.STALE;
const tail = id => String(id).split("/").pop();
const norm = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const tierOk = t => TIER === "all" || t === TIER;

// --- the model's output ------------------------------------------------------------
const rawOut = JSON.parse(fs.readFileSync(outPath, "utf8"));
const outRows = Array.isArray(rawOut) ? rawOut
  : Object.entries(rawOut).map(([product_id, v]) => v && v.report ? { product_id, ...v } : { product_id, report: v });
const out = new Map(outRows.filter(r => r && r.product_id && r.report).map(r => [tail(r.product_id), r]));

let decide = null, isStandardSentence = null;
async function verdictOf(g, o) {
  if (o.verdict && !process.env.DECIDE) return { v: o.verdict, how: "given" };
  const slug = o.sheet || g.sheet;
  const guide = goldFile.guides?.[slug] || (slug === g.sheet ? g.guide : null);
  if (!guide) return { v: null, how: `no guide for ${slug}` };
  if (!decide) ({ decide, isStandardSentence } = await import("../../supabase/functions/picture-quality/rules.ts"));
  const sheet = { slug, shots: guide.map(s => ({ label: s.label, cond: s.cond })) };
  const unit = (g.notes || []).map(x => x.replace(/^\[(unit|standard)\]\s*/, "")).filter(x => !isStandardSentence(x));
  const l = { title: g.title || "", cosmetic: "", functional: "", included: "", price: g.price || 0, sku: g.sku || "",
              photos: g.photos.map(p => ({ width: p.width || 1080, height: p.height || 1080 })), unitCosmetic: unit };
  const report = { needed_missing: [], flaw_views: [], setups: [], suggested_order: [], lead_ok: true, serial: "shown",
                   main_flaw: { stated: null, source: "none", shown: "not_applicable", photo: null }, ...o.report };
  return { v: decide(l, sheet, report).verdict, how: "decided" };
}
const asFlag = v => v == null ? null : ["retake", "fix"].includes(v) ? "flag" : ["pass", "reorder"].includes(v) ? "pass" : v;

// --- tallies -------------------------------------------------------------------------
const FRAMING = ["off_center", "crooked", "too_small", "blurry", "cut_off", "dirty_backdrop", "clutter", "reflection"];
const blank = () => ({ listings: 0, scored: 0,
  shot: { photos: 0, exact: 0, first: 0, tp: 0, fp: 0, fn: 0 },
  miss: { listings: 0, tp: 0, fp: 0, fn: 0 },
  verdict: { n: 0, agree: 0, flagAsPass: 0, passAsFlag: 0, none: 0 },
  sheet: { n: 0, agree: 0 },
  framing: Object.fromEntries(FRAMING.map(k => [k, { tp: 0, fp: 0, fn: 0 }])) });
const tallies = new Map();
const bucket = (...keys) => keys.map(k => { if (!tallies.has(k)) tallies.set(k, blank()); return tallies.get(k); });
const misses = [];
let circular = 0, absent = 0;

for (const g of goldFile.listings) {
  const o = out.get(tail(g.product_id));
  const bs = bucket("ALL", `sheet:${g.sheet || "(no sheet)"}`);
  bs.forEach(b => b.listings++);
  if (!o) { absent++; continue; }
  bs.forEach(b => b.scored++);
  const hasAccepted = g.photos.some(p => p.shots_tier === "accepted") || [g.verdict, g.missing, g.sheet_gold].some(x => x?.tier === "accepted");
  if (hasAccepted && o.stamp && g.graded?.stamp && o.stamp === g.graded.stamp) circular++;
  const byN = new Map((o.report.photos || []).map(p => [p.n, p]));
  const usable = x => x && tierOk(x.tier) && (STALE || !x.stale);
  const tierB = t => bucket(`tier:${t}`)[0];

  // Shot labels, per photo: the set must match; "first" = the model's first
  // label is one of gold's. Label-level P/R counts each label as a positive.
  if (g.aligned || STALE) for (const p of g.photos) {
    if (!p.shots || !tierOk(p.shots_tier)) continue;
    const want = new Set(p.shots.map(norm));
    const got = (byN.get(p.n)?.shots || []).map(norm);
    const gotS = new Set(got);
    for (const b of [...bs, tierB(p.shots_tier)]) {
      b.shot.photos++;
      if (want.size === gotS.size && [...want].every(x => gotS.has(x))) b.shot.exact++;
      if (got.length && want.has(got[0])) b.shot.first++;
      for (const x of gotS) want.has(x) ? b.shot.tp++ : b.shot.fp++;
      for (const x of want) if (!gotS.has(x)) b.shot.fn++;
    }
    if (!(want.size === gotS.size && [...want].every(x => gotS.has(x))))
      misses.push(`shot   ${g.store} ${g.sku || tail(g.product_id)} photo ${p.n}: gold [${p.shots.join(", ")}] model [${(byN.get(p.n)?.shots || []).join(", ")}]`);
  }

  // Missing shots: an exact list scores both ways; `includes` only for misses,
  // `not` only for false alarms.
  if (usable(g.missing)) {
    // scope "always" (derived from confirmed labels) knows nothing of If-Needed shots.
    const got = new Set([...(o.report.missing_shots || []), ...(g.missing.scope === "always" ? [] : o.report.needed_missing || [])].map(norm));
    let tp = 0, fp = 0, fn = 0;
    if (g.missing.exact) { const w = new Set(g.missing.exact.map(norm)); for (const x of got) w.has(x) ? tp++ : fp++; for (const x of w) if (!got.has(x)) fn++; }
    for (const x of g.missing.includes || []) got.has(norm(x)) ? tp++ : fn++;
    for (const x of g.missing.not || []) if (got.has(norm(x))) fp++;
    for (const b of [...bs, tierB(g.missing.tier)]) { b.miss.listings++; b.miss.tp += tp; b.miss.fp += fp; b.miss.fn += fn; }
    if (fp || fn) misses.push(`missing ${g.store} ${g.sku || tail(g.product_id)}: gold ${JSON.stringify(g.missing.exact || { includes: g.missing.includes, not: g.missing.not })} model ${JSON.stringify(o.report.missing_shots || [])}`);
  }

  // Verdict.
  if (usable(g.verdict)) {
    const { v, how } = await verdictOf(g, o);
    const got = asFlag(v);
    for (const b of [...bs, tierB(g.verdict.tier)]) {
      b.verdict.n++;
      if (got == null || !["flag", "pass"].includes(got)) b.verdict.none++;
      else if (got === g.verdict.value) b.verdict.agree++;
      else if (g.verdict.value === "flag") b.verdict.flagAsPass++; else b.verdict.passAsFlag++;
    }
    if (got !== g.verdict.value) misses.push(`verdict ${g.store} ${g.title?.slice(0, 40)}: Ethan ${g.verdict.value} (${g.verdict.why}) · model ${v} [${how}]`);
  }

  if (usable(g.sheet_gold) && o.sheet !== undefined)
    for (const b of [...bs, tierB(g.sheet_gold.tier)]) { b.sheet.n++; if (o.sheet === g.sheet_gold.value) b.sheet.agree++; }

  // Framing (explicit, per photo): the model's framing_problems + issue types.
  for (const p of g.photos) {
    if (!p.framing || p.framing.label === "not_item" || !tierOk("explicit") || p.n == null) continue;
    const mp = byN.get(p.n);
    if (!mp) continue;
    const got = new Set([...(mp.framing_problems || []), ...(mp.issues || []).map(i => i.type)]);
    const want = new Set(p.framing.problems);
    for (const b of [...bs, tierB("explicit")]) for (const k of FRAMING) {
      if (got.has(k) && want.has(k)) b.framing[k].tp++; else if (got.has(k)) b.framing[k].fp++; else if (want.has(k)) b.framing[k].fn++;
    }
  }
}

// --- report ---------------------------------------------------------------------------
const pct = (a, n) => n ? `${Math.round(100 * a / n)}%` : "—";
const pr = ({ tp, fp, fn }) => `P ${pct(tp, tp + fp)} R ${pct(tp, tp + fn)}`;
const line = (name, b) => `${name.padEnd(36)}${b.listings ? `${String(b.scored).padStart(3)}/${String(b.listings).padEnd(4)}` : " ".repeat(8)}`
  + ` shots ${String(b.shot.photos).padStart(4)}: exact ${pct(b.shot.exact, b.shot.photos).padStart(4)} first ${pct(b.shot.first, b.shot.photos).padStart(4)}`
  + ` · missing ${String(b.miss.listings).padStart(3)}: ${pr(b.miss)}`
  + ` · verdict ${pct(b.verdict.agree, b.verdict.n).padStart(4)} of ${b.verdict.n}`;

if (process.env.JSON) { console.log(JSON.stringify(Object.fromEntries(tallies), null, 1)); process.exit(0); }
console.log(`gold ${goldArg || "scripts/pq-gold/gold.json"} (${goldFile.made?.slice(0, 10)}) · model output ${outPath} · tier ${TIER}${STALE ? " · incl. stale" : ""}`);
if (absent) console.log(`${absent} gold listing(s) absent from the model output (counted as listings, not scored)`);
if (circular) console.log(`⚠️  ${circular} listing(s) were scored with the SAME grade their accepted labels came from — accepted-tier numbers are circular for them; read TIER=explicit.`);
console.log("");
const all = tallies.get("ALL");
if (!all) { console.log("no gold listings"); process.exit(0); }
console.log(line("ALL", all));
for (const t of ["explicit", "accepted"]) if (tallies.has(`tier:${t}`)) console.log(line(`  tier ${t}`, tallies.get(`tier:${t}`)));
console.log(`  verdict misses: ${all.verdict.flagAsPass} flag→pass (missed), ${all.verdict.passAsFlag} pass→flag (too strict), ${all.verdict.none} no verdict`);
console.log(`  shot labels: ${pr(all.shot)}  · sheet ${pct(all.sheet.agree, all.sheet.n)} of ${all.sheet.n}`);
console.log(`  framing (explicit): ${FRAMING.map(k => `${k} ${pr(all.framing[k])} (${all.framing[k].tp + all.framing[k].fn} real)`).join(" · ")}`);
console.log("\nBY SHEET");
for (const [k, b] of [...tallies].filter(([k]) => k.startsWith("sheet:")).sort((a, b) => b[1].listings - a[1].listings))
  console.log(line(k.slice(6), b));
if (process.env.VERBOSE) { console.log("\nDISAGREEMENTS"); for (const m of misses) console.log("  " + m); }
else if (misses.length) console.log(`\n${misses.length} disagreements — VERBOSE=1 lists them`);
