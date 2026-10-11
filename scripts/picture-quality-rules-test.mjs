// PICTURE QUALITY — the scoring card, tested offline. FREE: no model, no network.
//
//   node scripts/picture-quality-rules-test.mjs            # card cases + replay
//   VERBOSE=1 node scripts/picture-quality-rules-test.mjs  # every replayed listing's findings
//
// Two halves (Ethan, 2026-10-08: "don't spend any more money on this until we
// feel a new test of 10 random ones from OVL might work 100%"):
//
//  1. THE CARD. One case per line of the scoring card he signed off on
//     2026-10-11, built by hand, run through rules.ts — the same file the edge
//     function deploys. A failing case fails the run (exit 1).
//  2. THE REPLAY. The reports the paid 2026-10-08 calibration already bought
//     (scripts/fixtures/pq-replay-2026-10-08.json) re-decided under today's
//     rules, scored against Ethan's answer key in picture-quality-calibrate.mjs.
//     Reported, not asserted: those reports predate fields the card now reads
//     (needed_missing, units, setups), so they show what the RULES change, and
//     the next paid run shows what the MODEL sees.
//
// Node 24 strips the types from rules.ts on import.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide, agree, pictureScore, PASS_BAR, PAYMORE_TEMPLATES, splitSentences, isStandardSentence } from "../supabase/functions/picture-quality/rules.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const t = (name, fn) => {
  let r; try { r = fn(); } catch (e) { r = "threw: " + (e && e.stack || e); }
  if (r === true) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + " -> " + r); }
};

// --- builders --------------------------------------------------------------------
const PHONE = { slug: "android-phones", shots: [
  { label: "Home/Lock Screen", cond: null }, { label: "Everything Included", cond: "Everything Included" },
  { label: "About Phone", cond: null }, { label: "Storage Information", cond: null },
  { label: "Software Information", cond: null }, { label: "LCD Flaws", cond: "LCD flaws" },
  { label: "Screen Off", cond: null }, { label: "Back of Phone", cond: null },
  { label: "Side of Phone", cond: null }, { label: "Opposite Side of Phone", cond: null },
  { label: "Top Side of Phone", cond: null }, { label: "Bottom Side of Phone", cond: null },
  { label: "Cosmetic Flaws", cond: "Cosmetic flaws" }, { label: "Extra Accessories", cond: "Extra accessories" }] };
const PAD = { slug: "game-controllers", shots: [
  { label: "Front of Controller", cond: null }, { label: "Everything Included", cond: "Everything Included" },
  { label: "Back of Controller", cond: null }, { label: "Top of Controller", cond: null },
  { label: "Bottom of Controller", cond: null }, { label: "Side of Controller", cond: null },
  { label: "Opposite Side of Controller", cond: null }, { label: "Closeup of Serial/Model Info", cond: null },
  { label: "Cosmetic Flaws", cond: "Cosmetic flaws" }] };
const listing = (o = {}) => ({ title: "Unlocked Samsung Galaxy S26", cosmetic: "", functional: "", included: "", price: 50,
  photos: Array.from({ length: o.n || 10 }, () => ({ width: 1080, height: 1080 })), unitCosmetic: [], ...o });
const photo = (n, o = {}) => ({ n, shots: ["Extra"], whole_item: true, repeats: null, framing: "matches",
  framing_problems: [], issues: [], ...o });
const report = (o = {}) => ({ photos: Array.from({ length: o.n || 10 }, (_, i) => photo(i + 1)),
  missing_shots: [], needed_missing: [], flaw_views: [], units_claimed: null, all_units_shown: true, units_together: true,
  main_flaw: { stated: null, source: "none", shown: "not_applicable", photo: null }, serial: "shown", lead_ok: true,
  setups: [], setup_difference: "", suggested_order: Array.from({ length: o.n || 10 }, (_, i) => i + 1), ...o });
const issue = (type) => ({ type, severity: "major" });
const run = (lo, sh, ro) => decide(listing(lo), sh, report(ro));
const flagged = d => d.verdict === "fix" || d.verdict === "retake";
const say = d => `${d.verdict} ${d.pictureScore} [${d.findings.map(f => f.code + (f.tier ? ":" + f.tier : "")).join(", ")}]`;

// --- 1. THE CARD -----------------------------------------------------------------------
t("a clean listing passes at 100", () => { const d = run({}, PHONE, {}); return (d.verdict === "pass" && d.pictureScore === 100) || say(d); });

for (const [type, label] of [["stock_photo", "stock photo"], ["fake_or_edited", "fake / AI"], ["wrong_item", "wrong item"], ["personal_info", "personal info"]]) {
  t(`automatic flag: ${label}`, () => { const ps = report().photos; ps[3].issues = [issue(type)];
    const d = run({}, PHONE, { photos: ps }); return flagged(d) || say(d); });
}
t("automatic flag: a photo not square", () => {
  const l = listing(); l.photos[4] = { width: 1080, height: 1350 };
  const d = decide(l, PHONE, report()); return flagged(d) || say(d); });
t("automatic flag: the main flaw not shown", () => { const d = run({}, PHONE, { main_flaw: { stated: "cracked back glass", source: "unit", shown: "no", photo: null } }); return flagged(d) || say(d); });
t("automatic flag: retake at 40% and 3+ of the required shots", () => {
  const d = run({}, PHONE, { missing_shots: ["Back of Phone", "Side of Phone", "Opposite Side of Phone", "Top Side of Phone", "Bottom Side of Phone"] });
  return d.verdict === "retake" || say(d); });

t("lead photo framing is an automatic flag; another photo's costs 30 ÷ photos", () => {
  const lead = report(); lead.photos[0] = photo(1, { framing: "off", framing_problems: ["off_center"] });
  const d1 = run({}, PHONE, lead);
  const other = report(); other.photos[5] = photo(6, { framing: "off", framing_problems: ["crooked"] });
  const d2 = run({}, PHONE, other);
  return (flagged(d1) && d2.verdict === "pass" && d2.pictureScore === 97) || `${say(d1)} | ${say(d2)}`; });
t("anything besides item + backdrop: automatic flag, with the Shopify AI background tip", () => {
  const ps = report().photos; ps[2].issues = [issue("clutter")]; ps[6].issues = [issue("clutter")];
  const d = run({}, PHONE, { photos: ps }); const f = d.findings.find(x => x.code === "clutter");
  return (flagged(d) && /photos 3 and 7/.test(f.text) && /Shopify's AI background tool/.test(f.text)) || say(d); });

t("missing plain views: the first is free (and listed), then −8 each", () => {
  const one = run({}, PHONE, { missing_shots: ["Back of Phone"] });
  const two = run({}, PHONE, { missing_shots: ["Back of Phone", "Top Side of Phone"] });
  return (one.pictureScore === 100 && one.findings.some(f => f.tier === "view_free") && two.pictureScore === 92 && two.verdict === "pass")
    || `${say(one)} | ${say(two)}`; });
t("a missing FIRST photo of the guide is an automatic flag (the Crucial tick is gone)", () => {
  const d = run({}, PHONE, { missing_shots: ["Home/Lock Screen"] });
  const side = run({}, PHONE, { missing_shots: ["Side of Phone"] });
  return (flagged(d) && side.verdict === "pass") || `${say(d)} | ${say(side)}`; });
t("a missing view the notes put a flaw on is crucial too", () => {
  const d = run({}, PHONE, { missing_shots: ["Back of Phone"], flaw_views: ["Back of Phone"] }); return flagged(d) || say(d); });

t("all four sides shown: no side or corner shot is missing, whatever the angle (OVL Galaxy Tab, 10-11)", () => {
  const miss = ["Side of Phone", "Top Side of Phone", "Back of Phone"];
  const d = run({}, PHONE, { missing_shots: miss, all_sides_shown: true });
  const n = run({}, PHONE, { missing_shots: miss, all_sides_shown: false });
  const left = d.findings.filter(f => f.code === "missing_shot").map(f => f.shot);
  return (left.join() === "Back of Phone" && n.findings.filter(f => f.code === "missing_shot").length === 3) || `${left.join()} | ${say(n)}`; });
t("Core info: −15 ONCE however many are missing, each one listed", () => {
  const d = run({}, PHONE, { missing_shots: ["About Phone", "Storage Information"] });
  const core = d.findings.filter(f => f.tier === "core").length;
  return (d.pictureScore === 85 && core === 2 && flagged(d)) || say(d); });
t("other settings screens: −3 each", () => {
  const d = run({}, PHONE, { missing_shots: ["Software Information"] }); return (d.pictureScore === 97 && d.verdict === "pass") || say(d); });
t("serial on a screen device: not shown anywhere is Core", () => {
  const d = run({}, PHONE, { serial: "not_shown" }); return (d.pictureScore === 85 && d.findings.some(f => f.tier === "core")) || say(d); });
t("serial on a no-screen item: −3, under a battery cover too", () => {
  const a = run({ title: "Xbox One Controller" }, PAD, { serial: "hidden_behind_cover" });
  const b = run({ title: "Xbox One Controller" }, PAD, { serial: "not_shown", missing_shots: ["Closeup of Serial/Model Info"] });
  return (a.pictureScore === 97 && b.pictureScore === 97) || `${say(a)} | ${say(b)}`; });

t("If Needed shot the listing calls for: automatic flag", () => {
  const d = run({ included: "Charger, Case" }, PHONE, { needed_missing: ["Everything Included"] }); return flagged(d) || say(d); });
t("…but not when the listing never says it (the model cannot invent the need)", () => {
  const a = run({ included: "" }, PHONE, { needed_missing: ["Everything Included"] });
  const b = run({ unitCosmetic: [] }, PHONE, { needed_missing: ["Cosmetic Flaws"] });
  const c = run({ functional: "Fully functional." }, PHONE, { needed_missing: ["LCD Flaws"] });
  return (a.verdict === "pass" && b.verdict === "pass" && c.verdict === "pass") || `${say(a)} | ${say(b)} | ${say(c)}`; });
t("…Cosmetic Flaws when a [unit] note describes a flaw, LCD Flaws when the notes describe the screen", () => {
  const a = run({ unitCosmetic: ["Deep scratch on the back camera ring."] }, PHONE, { needed_missing: ["Cosmetic Flaws"] });
  const b = run({ functional: "Faint lines across the display." }, PHONE, { needed_missing: ["LCD Flaws"] });
  return (flagged(a) && flagged(b)) || `${say(a)} | ${say(b)}`; });

t("pair / set / lot: all units shown, together — else an automatic flag", () => {
  const a = run({ title: "Lot of 6 Nintendo DS Games" }, PHONE, { units_claimed: 6, all_units_shown: false });
  const b = run({ title: "Pyle Speaker Pair" }, PHONE, { units_claimed: 2, units_together: false });
  const c = run({ title: "Pyle Speaker Pair" }, PHONE, { units_claimed: 2 });
  return (flagged(a) && /all 6/.test(a.findings[0].text) && flagged(b) && c.verdict === "pass") || `${say(a)} | ${say(b)} | ${say(c)}`; });

t("a repeat: −4, Approve Deletion, and a Quick Fix when nothing else is wrong", () => {
  const ps = report().photos; ps[4] = photo(5, { repeats: 1 });
  const d = run({}, PHONE, { photos: ps }); const f = d.findings.find(x => x.code === "repeat");
  return (d.pictureScore === 96 && d.verdict === "reorder" && d.deletion && d.deletion.photos[0] === 5
    && /Photo 5 is the same shot as photo 1\. Approve Deletion removes it/.test(f.text) && !/delete it yourself/i.test(f.text)) || say(d); });
t("…and names the missing shot to take instead", () => {
  const ps = report().photos; ps[5] = photo(6, { repeats: 2 });
  const d = run({}, PHONE, { photos: ps, missing_shots: ["About Phone"] });
  return /then take About Phone instead/.test(d.findings.find(x => x.code === "repeat").text) || say(d); });

t("dirty table: 5 / 10 / 15 by price", () => {
  const ps = report().photos; ps[0].issues = [issue("dirty_backdrop")];
  const s = [50, 150, 300].map(price => run({ price }, PHONE, { photos: ps }).pictureScore);
  return s.join() === "95,90,85" || s.join(); });
t("reflections: 3 / 6 / 9 by price, never on Screen Off", () => {
  const ps = report().photos; ps[1].issues = [issue("reflection")];
  const s = [50, 150, 300].map(price => run({ price }, PHONE, { photos: ps }).pictureScore);
  const off = report().photos; off[2] = photo(3, { shots: ["Screen Off"], issues: [issue("reflection")] });
  const d = run({}, PHONE, { photos: off });
  return (s.join() === "97,94,91" && d.pictureScore === 100) || `${s.join()} | ${say(d)}`; });
t("different spots: −5, re-position wording, and framing stacks on top", () => {
  const ps = report().photos; ps[7] = photo(8, { framing: "off", framing_problems: ["off_center"] });
  const d = run({}, PHONE, { photos: ps, setups: [[1, 2, 3, 4, 5, 6, 7], [8, 9]], setup_difference: "brighter backdrop" });
  const f = d.findings.find(x => x.code === "mixed_setups");
  return (d.pictureScore === 92 && /Photos 8 and 9 were taken in a different spot/.test(f.text) && /re-position the item/.test(f.text)
    && d.findings.some(x => x.code === "framing" && x.photo === 8)) || say(d); });

t("a flagged listing lists EVERY finding, the small ones too", () => {
  const ps = report().photos; ps[1].issues = [issue("reflection")];
  const d = run({}, PHONE, { photos: ps, missing_shots: ["About Phone", "Software Information"] });
  const codes = d.findings.map(f => f.code + ":" + (f.tier || ""));
  return (flagged(d) && codes.includes("reflection:") && codes.includes("missing_shot:minor") && codes.includes("missing_shot:core")) || say(d); });
t("the pass line is 90", () => PASS_BAR === 90 || String(PASS_BAR));
t("pictureScore never goes below zero", () => pictureScore([{ code: "retake", text: "" }, { code: "not_square", text: "" }], 5, 50).score === 0 || "below zero");

t("two looks: a flag must be seen by both; a pass from either", () => {
  const a = report({ needed_missing: ["Everything Included"], units_claimed: 2, units_together: false, missing_shots: ["Back of Phone"] });
  const b = report({ needed_missing: [], units_claimed: 2, units_together: true, missing_shots: ["Back of Phone"] });
  const m = agree(a, b);
  return (m.needed_missing.length === 0 && m.units_together === true && m.missing_shots.length === 1) || JSON.stringify(m).slice(0, 200); });

// --- PayMore's wording: what is template, what is about THIS unit -------------------------
t("every PayMore Good/Fair template sentence reads as standard", () => {
  const bad = Object.entries(PAYMORE_TEMPLATES).flatMap(([k, v]) => splitSentences(v).filter(x => !isStandardSentence(x)).map(x => k + ": " + x));
  return !bad.length || bad.join(" | "); });
t("…and so do small edits of one (another device's name, a dropped clause)", () => {
  const ok = ["This Samsung Galaxy Watch is in good cosmetic condition.",
    "The back glass is in fair cosmetic condition with some scuffs and scratches.",
    "The screen is in good cosmetic condition with minimal scuffs, scratches and wear.",
    "This console is in excellent cosmetic condition!"];
  const bad = ok.filter(x => !isStandardSentence(x)); return !bad.length || bad.join(" | "); });
t("what a lister writes about the unit is NOT standard", () => {
  const unit = ["Small crack in the bottom left corner of the screen.",
    "The screen is in good cosmetic condition but has a chip on the corner.",
    "Deep gouge on the lid near the left hinge.",
    "Heavy dent on the back corner of the case.",
    "There is a dead pixel near the center of the display.",
    "The back glass is shattered but the phone works."];
  const bad = unit.filter(x => isStandardSentence(x)); return !bad.length || bad.join(" | "); });
t("Good/Fair wear in OTHER words is standard too (real lines from the 10-08 listings)", () => {
  const ok = ["The console is in good pre-owned condition, showing a few noticeable scuffs, scratches, and signs of wear.",
    "The headband has scuffs, scratches and wear due to heavy use.",
    "There is some light to moderate wear from use including some small scuffs, scratches, or dings.",
    "The top remains in good shape with a few minor but noticeable marks, and the bottom is also in good shape with minor yet noticeable scuffing and wear.",
    "It is brand new and factory sealed.",
    "This controller is in excellent pre-owned condition, with little to no noticeable wear or damage."];
  const bad = ok.filter(x => !isStandardSentence(x)); return !bad.length || bad.join(" | "); });
t("…and the two real damage lines in those listings are not", () => {
  const unit = ["The back glass is cracked/damaged, see photos.", "The hinges function properly, but the housing is cracked/damaged."];
  const bad = unit.filter(x => isStandardSentence(x)); return !bad.length || bad.join(" | "); });
t("damage words in a negation or a hedged \"including some small…\" list are not a claim (random run 10-11)", () => {
  const std = ["The case/box is also in good condition with light to moderate wear, including some small stains, creases, or tears.",
    "The case/box is in good condition with some light to moderate wear from use including some small stains, creases, or tears.",
    "There are no major defects like deep creases, tears, or liquid damage.",
    "The case/box is also in good condition, with light to moderate wear that may include small stains, creases, or tears."];
  const unit = ["The case has a tear on the back cover, including some small stains.", "The manual is missing.",
    "No manual, and the case is cracked."];
  const a = std.filter(x => !isStandardSentence(x)), b = unit.filter(x => isStandardSentence(x));
  return (!a.length && !b.length) || `read as unit: ${a.join(" | ")} || read as standard: ${b.join(" | ")}`; });
t("template wording never makes Cosmetic Flaws required; a unit sentence does", () => {
  const tmpl = "The back glass is in fair cosmetic condition with some scuffs and scratches and wear.";
  const a = run({ unitCosmetic: [tmpl].filter(x => !isStandardSentence(x)) }, PHONE, { needed_missing: ["Cosmetic Flaws"] });
  const b = run({ unitCosmetic: ["Small crack in the bottom left corner of the screen."].filter(x => !isStandardSentence(x)) }, PHONE, { needed_missing: ["Cosmetic Flaws"] });
  return (a.verdict === "pass" && flagged(b)) || `${say(a)} | ${say(b)}`; });

// --- 2. THE REPLAY ----------------------------------------------------------------------
const fx = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "pq-replay-2026-10-08.json"), "utf8"));
const KEY = Object.fromEntries(fs.readFileSync(path.join(here, "picture-quality-calibrate.mjs"), "utf8").split("\n")
  .map(l => /\["(WSP|OVL)", "(\d+)", "([^"]+)", "(flag|pass|\?)"/.exec(l)).filter(Boolean).map(m => [m[2], [m[3], m[4]]]));
const sheets = new Map(fx.sheets.map(s => [s.slug, s]));
let agreeN = 0, scored = 0;
const unitNotes = [];
console.log("\nREPLAY — the 2026-10-08 reports under today's rules (reported, not asserted)");
for (const r of fx.results) {
  const k = KEY[r.product_id.split("/").pop()];
  const sheet = sheets.get(r.sheet_slug);
  if (!k || k[1] === "?" || !sheet) continue;
  // Sizes: square unless the old run said otherwise.
  const photos = Array.from({ length: r.photo_count }, () => ({ width: 1080, height: 1080 }));
  for (const f of r.findings_then || []) {
    const m = f.code === "not_square" && /\((\d+)×(\d+)\)/.exec(f.text);
    if (m && photos[f.photo - 1]) photos[f.photo - 1] = { width: +m[1], height: +m[2] };
  }
  const l = { title: r.title, cosmetic: "", functional: "", included: "", price: 0, photos,
    // Re-read with TODAY's test (PayMore's wording), not the tag the old run gave.
    unitCosmetic: (r.notes || []).map(x => x.replace(/^\[(unit|standard)\]\s*/, "")).filter(x => !isStandardSentence(x)) };
  unitNotes.push(...l.unitCosmetic.map(x => `${r.store} ${k[0]}: ${x}`));
  const d = decide(l, sheet, r.report);
  const got = flagged(d) ? "flag" : "pass";
  scored++; if (got === k[1]) agreeN++;
  console.log(`${got === k[1] ? "✓" : "✗"} ${r.store} ${k[0].padEnd(28)} Ethan ${k[1]}  now ${d.verdict.padEnd(7)} ${String(d.pictureScore).padStart(3)}  (then ${r.verdict_then})`);
  if (got !== k[1] || process.env.VERBOSE) for (const f of d.findings) console.log(`      ${f.text}`);
}
console.log(`\nCosmetic sentences read as about THE UNIT (not PayMore's wording) — ${unitNotes.length}:`);
for (const x of unitNotes) console.log("  " + x);
console.log(`\nreplay: ${agreeN}/${scored} agree with Ethan · card: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
