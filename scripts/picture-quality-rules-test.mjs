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
import { decide, agree, needsSecondLook, pictureScore, PASS_BAR, PAYMORE_TEMPLATES, splitSentences, isStandardSentence } from "../supabase/functions/picture-quality/rules.ts";

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
const shotsAre = (labels, o = {}) => labels.map((s, i) => photo(i + 1, { shots: [s], ...(o[i + 1] || {}) }));

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

t("crooked / off-centre / too small from the review are PAUSED — no finding, no points (Ethan, 10-11)", () => {
  const r = report(); r.photos[0] = photo(1, { framing: "off", framing_problems: ["crooked", "off_center", "too_small"] });
  const d = decide(listing({}), PHONE, r);
  return (d.verdict === "pass" && !d.findings.some(f => f.code === "framing")) || say(d); });
t("lead photo framing is an automatic flag; another photo's costs 30 ÷ photos", () => {
  const lead = report(); lead.photos[0] = photo(1, { framing: "off", framing_problems: ["cut_off"] });
  const d1 = run({}, PHONE, lead);
  const other = report(); other.photos[5] = photo(6, { framing: "off", framing_problems: ["cut_off"] });
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
t("flat retail packaging on New In Box: only front, back and label are asked for (WSP SanDisk, 10-11)", () => {
  const NIB = { slug: "new-in-box", shots: ["Front of Box", "Back of Box", "Top of Box", "Bottom of Box", "Side of Box", "Opposite Side of Box", "Closeup of Model/Serial Info"].map(label => ({ label, cond: null })) };
  const miss = ["Top of Box", "Bottom of Box", "Side of Box", "Opposite Side of Box"];
  const flat = run({ title: "New SanDisk 512GB microSDXC" }, NIB, { missing_shots: miss, flat_package: true, serial: "shown" });
  const box = run({ title: "New SanDisk 512GB microSDXC" }, NIB, { missing_shots: miss, flat_package: false, serial: "shown" });
  return (flat.verdict === "pass" && box.verdict === "retake") || `${say(flat)} | ${say(box)}`; });
t("different spot: the FIRST (stand) group wins a mix, and closeups are never odd (WSP AirPods, OVL Loupedeck)", () => {
  const ps = report().photos; ps[7] = photo(8, { whole_item: false });
  const d = run({}, PHONE, { photos: ps, setups: [[1, 2, 4], [3, 5, 6, 7, 8, 9, 10]] });
  const f = d.findings.find(x => x.code === "mixed_setups");
  const odd = f ? f.photos.join() : "";
  return odd === "3,5,6,7,9,10" || `odd: ${odd}`; });
t("a repeat in the odd spot is the one deleted, whichever came first (LEE Sony A7 III)", () => {
  const ps = report({ n: 5 }).photos; ps[3] = photo(4, { repeats: 3 });
  const d = run({}, PHONE, { n: 5, photos: ps, setups: [[3], [1, 2, 4, 5]] });
  // …but never the lead photo (LEE Insta360 X3).
  const qs = report({ n: 5 }).photos; qs[1] = photo(2, { repeats: 1 });
  const e = run({}, PHONE, { n: 5, photos: qs, setups: [[1], [2, 3, 4, 5]] });
  return (d.deletion?.photos.join() === "3" && d.deletion?.of.join() === "4" && !d.findings.some(f => f.code === "mixed_setups")
    && e.deletion?.photos.join() === "2") || say(d) + " " + JSON.stringify(d.deletion) + " | " + JSON.stringify(e.deletion); });
t("two lit screens are not repeats (LEE Insta360 X3 photos 3 and 4)", () => {
  const ps = shotsAre(["Front of Device", "Screen On", "Screen On"]); ps[2].repeats = 2;
  const d = decide(listing({ n: 3 }), PHONE, report({ n: 3, photos: ps }));
  return !d.deletion || say(d); });
t("a game has one front: a second is a repeat, unless the back is nowhere (LEE Zelda BOTW)", () => {
  const CART = { slug: "video-games-disk-cartridge-only", shots: [{ label: "Front of Game", cond: null }, { label: "Back of Game", cond: null }] };
  const a = decide(listing({ n: 3, title: "Zelda Breath of the Wild" }), CART, report({ n: 3, photos: shotsAre(["Front of Game", "Back of Game", "Front of Game"]) }));
  const b = decide(listing({ n: 2, title: "Zelda Breath of the Wild" }), CART, report({ n: 2, photos: shotsAre(["Front of Game", "Front of Game"]) }));
  return (a.deletion?.photos.join() === "3" && a.deletion?.of.join() === "1" && !b.deletion) || say(a) + " | " + say(b); });
t("a steelbook keeps its two fronts and backs, in the store's order (LEE Red Dead Redemption 2)", () => {
  const GAME = { slug: "video-games", shots: ["Front of Game", "Back of Game", "Opened Case With Disk"].map(label => ({ label, cond: null })) };
  const d = decide(listing({ n: 5, title: "Red Dead Redemption 2 [Steelbook Edition]" }), GAME,
    report({ n: 5, photos: shotsAre(["Front of Game", "Back of Game", "Front of Game", "Back of Game", "Opened Case With Disk"]) }));
  return (!d.deletion && !d.reorder) || say(d) + " " + d.reorder?.suggested; });
t("a QTY listing: the same view of the next unit is a repeat, chains point at the one kept (LEE Wii Remote QTY3)", () => {
  const ps = shotsAre(["Front of Controller", "Back of Controller", "Side of Controller", "Side of Controller", "Side of Controller", "Opposite Side of Controller"]);
  ps[4].repeats = 4;
  const d = decide(listing({ n: 6, sku: "MO01-5679C-QTY3-E4" }), PAD, report({ n: 6, photos: ps }));
  return (d.deletion?.photos.join() === "4,5" && d.deletion?.of.join() === "3,3") || say(d) + " " + JSON.stringify(d.deletion); });
t("a second photo of a shot already taken goes with the extras (LEE Beats Studio Pro)", () => {
  const HP = { slug: "headphones-over-ear", shots: ["Front of Headphones", "Side of Headphones", "Back of Headphones", "Top of Headphones", "Inside of Cushion", "Inside of Opposite Cushion"]
    .map(label => ({ label, cond: null })) };
  const ps = shotsAre(["Front of Headphones", "Top of Headphones", "Back of Headphones", "Inside of Cushion", "Inside of Opposite Cushion", "Front of Headphones", "Inside of Cushion"]);
  ps[6].whole_item = false;
  const d = decide(listing({ n: 7 }), HP, report({ n: 7, photos: ps }));
  return d.reorder?.suggested.join() === "1,3,2,4,5,6,7" || say(d) + " " + d.reorder?.suggested; });
t("a spec screen the sheet has no shot for stays with the screens (LEE HP Envy 'CPU')", () => {
  const DESK = { slug: "windows-desktop", shots: ["Front of Desktop", "Settings About Page", "Storage Information", "Back of Desktop", "Closeup of Serial/Model Info"].map(label => ({ label, cond: null })) };
  const ps = shotsAre(["Front of Desktop", "Back of Desktop", "CPU", "RAM", "Storage Information", "Closeup of Serial/Model Info"]);
  [2, 3, 4, 5].forEach(i => { ps[i].whole_item = false; });
  const d = decide(listing({ n: 6 }), DESK, report({ n: 6, photos: ps }));
  return d.reorder?.suggested.join() === "1,3,4,5,2,6" || say(d) + " " + d.reorder?.suggested; });
t("missing Cosmetic Flaws says what the listing says; a shrink-wrap sentence asks for nothing (LEE Payday 2)", () => {
  const d = run({ unitCosmetic: ["The label is torn on the front."] }, PHONE, { needed_missing: ["Cosmetic Flaws"] });
  const f = d.findings.find(x => x.shot === "Cosmetic Flaws");
  return (f?.said === "The label is torn on the front." && isStandardSentence("It is missing the plastic due to heavy wear.")
    && !isStandardSentence("It is missing the plastic and the case is cracked.")) || say(d); });
t("the listing says brand new, the photos say used: an automatic flag (LEE Payday 2)", () => {
  const a = run({ cosmetic: "This game is BRAND NEW! It has never been used." }, PHONE, { new_claim_wrong: true });
  const b = run({ cosmetic: "Light wear from use." }, PHONE, { new_claim_wrong: true });
  return (a.findings.some(f => f.code === "new_claim") && flagged(a) && b.verdict === "pass") || say(a) + " | " + say(b); });
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
t("loose cords: −5 a photo, never an automatic flag (Ethan, 10-11, OVL ADC)", () => {
  const one = report().photos; one[0].issues = [issue("loose_cord")];
  const three = report().photos; [0, 1, 2].forEach(i => { three[i].issues = [issue("loose_cord")]; });
  const a = run({}, PHONE, { photos: one }), b = run({}, PHONE, { photos: three });
  return (a.pictureScore === 95 && a.verdict === "pass" && b.pictureScore === 85 && b.verdict === "fix") || `${say(a)} | ${say(b)}`; });
t("a video game off the stand is an automatic flag — on game sheets only (OVL Wii Fit, 10-11)", () => {
  const GAME = { slug: "video-games", shots: [{ label: "Front of Case", cond: null }, { label: "Back of Case", cond: null }, { label: "Opened Case With Disk", cond: null }] };
  const ps = report({ n: 3 }).photos; ps[2].issues = [issue("not_on_stand")];
  const g = run({ photos: [{}, {}, {}] }, GAME, { n: 3, photos: ps });
  const other = run({}, PHONE, { photos: (() => { const q = report().photos; q[2].issues = [issue("not_on_stand")]; return q; })() });
  return (flagged(g) && g.findings.some(f => f.code === "not_on_stand") && other.verdict === "pass") || `${say(g)} | ${say(other)}`; });
t("a lot's group shots flat and singles on the stand are not different spots (OVL Micron lot, 10-11)", () => {
  const ps = report().photos; ps[0].shots = ["Top of Lot"]; ps[1].shots = ["Bottom of Lot"];
  const lot = run({}, PHONE, { photos: ps, setups: [[1, 2], [3, 4, 5, 6, 7, 8, 9, 10]] });
  const one = run({}, PHONE, { setups: [[1, 2], [3, 4, 5, 6, 7, 8, 9, 10]] });
  return (!lot.findings.some(f => f.code === "mixed_setups") && one.findings.some(f => f.code === "mixed_setups")) || `${say(lot)} | ${say(one)}`; });
t("reflections: 3 / 6 / 9 by price, on Screen Off too (LEE Lenovo 13w, 10-15 — reversed 10-08)", () => {
  const ps = report().photos; ps[1].issues = [issue("reflection")];
  const s = [50, 150, 300].map(price => run({ price }, PHONE, { photos: ps }).pictureScore);
  const off = report().photos; off[2] = photo(3, { shots: ["Screen Off"], issues: [issue("reflection")] });
  const d = run({}, PHONE, { photos: off });
  return (s.join() === "97,94,91" && d.pictureScore === 97) || `${s.join()} | ${say(d)}`; });
t("the stand wins a mix; a landslide (4×) wins over it (LEE Insta360 6:3, Sony 7:1)", () => {
  const mix = run({}, PHONE, { n: 9, photos: report({ n: 9 }).photos, setups: [[1, 3, 4], [2, 5, 6, 7, 8, 9]] });
  const slide = run({}, PHONE, { n: 9, photos: report({ n: 9 }).photos, setups: [[3], [1, 2, 4, 5, 6, 7, 8, 9]] });
  const a = mix.findings.find(f => f.code === "mixed_setups")?.photos.join(), b = slide.findings.find(f => f.code === "mixed_setups")?.photos.join();
  return (a === "2,5,6,7,8,9" && b === "3") || `${a} | ${b}`; });
t("a second opened case is not a repeat (LEE Suikoden Tactics, two discs)", () => {
  const GAME = { slug: "video-games", shots: ["Front of Game", "Back of Game", "Opened Case With Disk"].map(label => ({ label, cond: null })) };
  const d = decide(listing({ n: 4, title: "Suikoden Tactics" }), GAME, report({ n: 4, photos: shotsAre(["Front of Game", "Back of Game", "Opened Case With Disk", "Opened Case With Disk"]) }));
  return !d.deletion || say(d); });
t("a device's two sides named a repeat stay a repeat; front/back still flip (LEE Elenva ring)", () => {
  const MISC = { slug: "small-medium-misc-items", shots: ["Front of Device", "Back of Device", "Side of Device", "Opposite Side of Device"].map(label => ({ label, cond: null })) };
  const ps = shotsAre(["Front of Device", "Back of Device", "Side of Device", "Side of Device"]); ps[3].repeats = 3;
  const d = decide(listing({ n: 4 }), MISC, report({ n: 4, photos: ps }));
  return d.deletion?.photos.join() === "4" || say(d); });
t("a view an earlier photo only also covers still gets its slot (LEE pink Beats Studio Pro)", () => {
  const HP = { slug: "headphones-over-ear", shots: ["Front of Headphones", "Side of Headphones", "Back of Headphones", "Opposite Side of Headphones", "Top of Headphones", "Bottom of Headphones", "Inside of Cushion", "Inside of Opposite Cushion"]
    .map(label => ({ label, cond: null })) };
  const ps = [photo(1, { shots: ["Front of Headphones", "Side of Headphones"] }), photo(2, { shots: ["Back of Headphones", "Opposite Side of Headphones"] }),
    photo(3, { shots: ["Top of Headphones"] }), photo(4, { shots: ["Inside of Cushion"], whole_item: false }), photo(5, { shots: ["Bottom of Headphones"] }),
    photo(6, { shots: ["Side of Headphones"] }), photo(7, { shots: ["Inside of Opposite Cushion"], whole_item: false })];
  const d = decide(listing({ n: 7 }), HP, report({ n: 7, photos: ps }));
  return d.reorder?.suggested.join() === "1,6,2,3,5,4,7" || say(d) + " " + d.reorder?.suggested; });
t("detail closeups keep the store's order beside the label closeup (LEE NES controller)", () => {
  const ps = shotsAre(["Front of Controller", "Back of Controller", "Extra", "Extra", "Extra", "Closeup of Serial/Model Info"], { 3: { whole_item: false }, 4: { whole_item: false }, 5: { whole_item: false }, 6: { whole_item: false } });
  const d = decide(listing({ n: 6 }), PAD, report({ n: 6, photos: ps }));
  return !d.reorder || say(d) + " " + d.reorder?.suggested; });
t("a kit: box first stays, no side/top/bottom shots owed (LEE Wii Extreme Sports Kit)", () => {
  const MISC = { slug: "small-medium-misc-items", shots: ["Front of Device", "Back of Device", "Side of Device", "Opposite Side of Device", "Top of Device", "Bottom of Device"].map(label => ({ label, cond: null })) };
  const d = decide(listing({ n: 5, title: "Nintendo Wii Extreme Sports Kit White" }), MISC,
    report({ n: 5, photos: shotsAre(["Box", "Box", "Front of Device", "Back of Device", "Extra"]), missing_shots: ["Side of Device", "Opposite Side of Device", "Top of Device", "Bottom of Device"] }));
  return (d.verdict === "pass" && !d.reorder) || say(d) + " " + d.reorder?.suggested; });
t("different spots: −5, short wording, and framing stacks on top", () => {
  const ps = report().photos; ps[7] = photo(8, { framing: "off", framing_problems: ["cut_off"] });
  const d = run({}, PHONE, { photos: ps, setups: [[1, 2, 3, 4, 5, 6, 7], [8, 9]], setup_difference: "brighter backdrop" });
  const f = d.findings.find(x => x.code === "mixed_setups");
  return (d.pictureScore === 92 && /Photos 8 and 9 were taken in a different spot/.test(f.text) && /retake so every photo is shot the same way/.test(f.text)
    && d.findings.some(x => x.code === "framing" && x.photo === 8)) || say(d); });

t("a flagged listing lists EVERY finding, the small ones too", () => {
  const ps = report().photos; ps[1].issues = [issue("reflection")];
  const d = run({}, PHONE, { photos: ps, missing_shots: ["About Phone", "Software Information"] });
  const codes = d.findings.map(f => f.code + ":" + (f.tier || ""));
  return (flagged(d) && codes.includes("reflection:") && codes.includes("missing_shot:minor") && codes.includes("missing_shot:core")) || say(d); });
t("the pass line is 90", () => PASS_BAR === 90 || String(PASS_BAR));
t("pictureScore never goes below zero", () => pictureScore([{ code: "retake", text: "" }, { code: "not_square", text: "" }], 5, 50).score === 0 || "below zero");

t("second look only when the flag is close to the line (cost cut, 10-11)", () => {
  const one = report().photos; one[0].issues = [issue("clutter")];
  const single = needsSecondLook(listing({}), PHONE, report({ photos: one }));          // one auto-flag: borderline
  const two = report().photos; two[0].issues = [issue("clutter")]; two[1].issues = [issue("stock_photo")];
  const sure = needsSecondLook(listing({}), PHONE, report({ photos: two }));             // two independent flags
  const passing = needsSecondLook(listing({}), PHONE, report());                          // nothing wrong
  const L = listing({}); L.photos = L.photos.map((p, i) => i === 0 ? { ...p, width: 1080, height: 1350 } : p);
  const measured = needsSecondLook(L, PHONE, report({ photos: one }));                   // not square is measured
  return (single && !sure && !passing && !measured) || [single, sure, passing, measured].join(); });
t("a suggested deletion ALWAYS gets a second look (WSP watches, 10-11)", () => {
  const ps = report().photos; ps[4] = photo(5, { repeats: 2 });
  return needsSecondLook(listing({}), PHONE, report({ photos: ps })) || "no second look for a repeat"; });
t("look-alike faces: a 'repeat' of the front is the back when the sheet asks for both (WSP Beats, 10-11)", () => {
  const ps = report().photos; ps[0] = photo(1, { shots: ["Front of Controller"] }); ps[1] = photo(2, { shots: ["Front of Controller"], repeats: 1 });
  const d = run({}, PAD, { photos: ps, missing_shots: ["Back of Controller"] });
  return (!d.deletion && !d.findings.some(f => f.code === "repeat" || f.shot === "Back of Controller")) || say(d); });
t("look-alike faces: with the back shown elsewhere, a second front IS a repeat (OVL PS3s, 10-08)", () => {
  const ps = report().photos; ps[0] = photo(1, { shots: ["Front of Controller"] }); ps[3] = photo(4, { shots: ["Front of Controller"], repeats: 1 });
  ps[6] = photo(7, { shots: ["Back of Controller"] });
  const d = run({}, PAD, { photos: ps });
  return (d.deletion && d.deletion.photos[0] === 4) || say(d); });
t("look-alike faces: top ↔ bottom is NOT excused — a real repeat still deletes (WSP TeamGroup RAM)", () => {
  const ps = report().photos; ps[0] = photo(1, { shots: ["Top of Controller"] }); ps[2] = photo(3, { shots: ["Top of Controller"], repeats: 1 });
  const d = run({}, PAD, { photos: ps });
  return (d.deletion && d.deletion.photos[0] === 3) || say(d); });
t("turned is an automatic flag, even on an Extra photo (WSP TeamGroup RAM photo 2)", () => {
  const ps = report().photos; ps[1] = photo(2, { framing: "off", framing_problems: ["turned"] });
  const d = run({}, PHONE, { photos: ps });
  return (flagged(d) && d.findings.some(f => f.code === "turned" && f.photo === 2)) || say(d); });
t("a closeup of a label is never a repeat of its face (OVL Intel SSD, 10-13)", () => {
  const ps = report().photos; ps[0] = photo(1, { shots: ["Top of Controller"] });
  ps[1] = photo(2, { shots: ["Closeup of Serial/Model Info"], whole_item: false, repeats: 1 });
  const d = run({}, PAD, { photos: ps });
  return !d.deletion || say(d); });
t("a repeat off the standard setup is deleted, not also retaken (OVL Ryzen 2700X, 10-13)", () => {
  const ps = report().photos; ps[4] = photo(5, { repeats: 1 }); ps[5] = photo(6, { repeats: 2 });
  const d = run({}, PHONE, { photos: ps, setups: [[1, 2, 3, 4, 7, 8, 9, 10], [5, 6]] });
  return (d.deletion && d.deletion.photos.join() === "5,6" && !d.findings.some(f => f.code === "mixed_setups")) || say(d); });
t("turned never counts on a side shot (OVL Toshiba HDD photos 3-4, 10-13)", () => {
  const ps = report().photos; ps[2] = photo(3, { shots: ["Side of Phone"], framing: "off", framing_problems: ["turned"] });
  const d = run({}, PHONE, { photos: ps });
  return !d.findings.some(f => f.code === "turned") || say(d); });
t("a flagged listing hears about order; a passing one gets a Quick Fix reorder (OVL HP Stream, 10-13)", () => {
  const lab = () => { const ps = report().photos; ps[0] = photo(1, { shots: ["Home/Lock Screen"] }); ps[1] = photo(2, { shots: ["Back of Phone"] }); ps[2] = photo(3, { shots: ["About Phone"] }); return ps; };
  const ps = lab(); ps[3].issues = [issue("stock_photo")];
  const bad = run({}, PHONE, { photos: ps });
  const good = run({}, PHONE, { photos: lab() });
  return (bad.findings.some(f => f.code === "order") && good.verdict === "reorder" && !good.findings.some(f => f.code === "order")) || say(bad) + " | " + say(good); });
t("missing Everything Included carries what the listing says comes with it (OVL GTX 1660)", () => {
  const d = run({ included: "Charger, box" }, PHONE, { needed_missing: ["Everything Included"] });
  const f = d.findings.find(x => x.shot === "Everything Included");
  return (f && f.included === "Charger, box") || say(d); });
t("the 'repeat' of a photo that also holds the closeup IS the closeup (OVL Intel SSD, 10-13)", () => {
  const ps = report().photos; ps[0] = photo(1, { shots: ["Top of Controller", "Closeup of Serial/Model Info"] });
  ps[1] = photo(2, { shots: ["Top of Controller"], repeats: 1 });
  const d = run({}, PAD, { photos: ps });
  return !d.deletion || say(d); });
t("a photo being deleted is not also sent back for a retake (OVL Evercade, 10-13 A/B)", () => {
  const GAME = { slug: "video-games", shots: [{ label: "Front of Game", cond: null }, { label: "Back of Game", cond: null }] };
  const ps = report({ n: 6 }).photos;
  ps[0] = photo(1, { shots: ["Front of Game"] }); ps[1] = photo(2, { shots: ["Back of Game"] });
  ps[3] = photo(4, { shots: ["Front of Game"], repeats: 1, issues: [issue("not_on_stand")] });
  ps[5] = photo(6, { shots: ["Back of Game"], repeats: 2, issues: [issue("not_on_stand"), issue("reflection")] });
  const d = decide(listing({ n: 6 }), GAME, report({ n: 6, photos: ps }));
  return (d.verdict === "reorder" && !d.findings.some(f => f.code === "not_on_stand" || f.code === "reflection")) || say(d); });
t("PayMore's Acceptable game-case line is standard; a real rip is not (BAL Gears 5, 10-14)", () => {
  const std = "The case/box is in acceptable condition with a good amount of noticeable scratches, small stains, small rips, major creases, and other wear.";
  const unit = "The case has a large rip across the back cover.";
  return (isStandardSentence(std) && !isStandardSentence(unit)) || `${isStandardSentence(std)} ${isStandardSentence(unit)}`; });
t("a passing listing gets a reorder for a small move (BAL Takumar photo 7, 10-14)", () => {
  const ps = report().photos; ps[0] = photo(1, { shots: ["Home/Lock Screen"] }); ps[1] = photo(2, { shots: ["Back of Phone"] }); ps[2] = photo(3, { shots: ["About Phone"] });
  const d = run({}, PHONE, { photos: ps });
  return (d.verdict === "reorder" && d.reorder.suggested.join() === "1,3,2,4,5,6,7,8,9,10") || say(d) + " " + (d.reorder && d.reorder.suggested); });
t("spec screens and side/corner shots keep the store's order (BAL MacBook Air, MPL Tab A11, 10-14)", () => {
  const ps = report().photos; ps[1] = photo(2, { shots: ["Storage Information"] }); ps[2] = photo(3, { shots: ["About Phone"] });
  ps[3] = photo(4, { shots: ["Screen Off"] }); ps[4] = photo(5, { shots: ["Opposite Side of Phone"] }); ps[5] = photo(6, { shots: ["Side of Phone"] });
  const d = run({}, PHONE, { photos: ps });
  return !d.reorder || say(d) + " " + d.reorder.suggested; });
t("accessories always last; a device extra goes before them (MPL Xbox Series S, 10-14)", () => {
  const ps = report({ n: 6 }).photos;
  ps[0] = photo(1, { shots: ["Home/Lock Screen"] }); ps[1] = photo(2, { shots: ["Extra Accessories"] });
  ps[2] = photo(3, { shots: ["Back of Phone"] }); ps[3] = photo(4, { shots: ["Extra"] });
  ps[4] = photo(5, { shots: ["Extra Accessories"] }); ps[5] = photo(6, { shots: ["Screen Off"] });
  const d = decide(listing({ n: 6 }), PHONE, report({ n: 6, photos: ps }));
  return (d.reorder && d.reorder.suggested.join() === "1,6,3,4,2,5") || say(d) + " " + (d.reorder && d.reorder.suggested); });
t("the guide's first shot leads: a back-first iPhone gets a reorder (OVL iPhone 17 Pro, 10-14)", () => {
  const ps = report().photos; ps[0] = photo(1, { shots: ["Back of Phone"] }); ps[1] = photo(2, { shots: ["Home/Lock Screen"] });
  const d = run({}, PHONE, { photos: ps });
  return (d.verdict === "reorder" && d.reorder.suggested[0] === 2) || say(d); });
t("a pass with nothing to approve stays a pass and keeps its notes (Ethan, 10-15, WSP SanDisk)", () => {
  const free = run({}, PHONE, { missing_shots: ["Back of Phone"] });
  const clean = run({}, PHONE, {});
  return (free.verdict === "pass" && free.findings.length > 0 && free.pictureScore === 100 && clean.verdict === "pass") || say(free) + " | " + say(clean); });
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
// --- Ethan's OVL review on Opus, 10-14 ---
const BOARD = { slug: "motherboards", shots: ["Top of Board", "Everything Included", "Front Side of Board", "Back Side of Board",
  "Closeup of I/O Panel", "Side of Board", "Opposite Side of Board", "Closeup of RAM Sockets", "Closeup of CPU Socket",
  "Bottom of Board"].map(label => ({ label, cond: label === "Everything Included" ? "x" : null })) };
const GPU = { slug: "graphics-cards", shots: ["Front of GPU", "Everything Included", "Back of GPU", "Top Side of GPU",
  "Bottom Side of GPU", "Side of GPU (Not Pins)", "Side of GPU (Pin Side)", "Closeup of Pins", "Closeup of Serial/Model Info"]
  .map(label => ({ label, cond: label === "Everything Included" ? "x" : null })) };
t("closeups go after the sides (OVL MSI Z790)", () => {
  const ps = shotsAre(["Top of Board", "Closeup of I/O Panel", "Closeup of RAM Sockets", "Side of Board", "Front Side of Board",
    "Opposite Side of Board", "Bottom of Board"], { 2: { whole_item: false }, 3: { whole_item: false } });
  const d = decide(listing({ n: 7 }), BOARD, report({ n: 7, photos: ps }));
  return d.reorder?.suggested.join() === "1,4,5,6,2,3,7" || say(d) + " " + d.reorder?.suggested; });
t("top and bottom sides go in the guide's order (OVL GTX 1080)", () => {
  const ps = shotsAre(["Front of GPU", "Top Side of GPU", "Side of GPU (Not Pins)", "Bottom Side of GPU", "Back of GPU"]);
  const d = decide(listing({ n: 5 }), GPU, report({ n: 5, photos: ps }));
  return d.reorder?.suggested.join() === "1,5,2,4,3" || say(d) + " " + d.reorder?.suggested; });
t("Everything Included is photo 2 even beside a second front (OVL Canon SX740)", () => {
  const ps = shotsAre(["Home/Lock Screen", "Back of Phone", "Home/Lock Screen", "Everything Included"]);
  const d = decide(listing({ n: 4 }), PHONE, report({ n: 4, photos: ps }));
  return d.reorder?.suggested.join() === "1,4,3,2" || say(d) + " " + d.reorder?.suggested; });
t("an unlabelled screen closeup stays with the screens (OVL Galaxy S26 Ultra photo 6)", () => {
  const ps = shotsAre(["Home/Lock Screen", "Back of Phone", "Extra", "About Phone", "Storage Information"], { 3: { whole_item: false } });
  const d = decide(listing({ n: 5 }), PHONE, report({ n: 5, photos: ps }));
  return d.reorder?.suggested.join() === "1,3,4,5,2" || say(d) + " " + d.reorder?.suggested; });
t("a figure lot has no back of lot; a collector's set no opened case, stand or spot (OVL Skylanders, FX Unit Yuki)", () => {
  const LOT = { slug: "item-lots", shots: [{ label: "Front of Lot", cond: null }, { label: "Back of Lot", cond: null }] };
  const GAME = { slug: "video-games", shots: [{ label: "Front of Game", cond: null }, { label: "Back of Game", cond: null }, { label: "Opened Case With Disk", cond: null }] };
  const a = decide(listing({ n: 2, title: "LOT OF 36x SKYLANDERS FIGURES" }), LOT, report({ n: 2, missing_shots: ["Back of Lot"] }));
  const ps = shotsAre(["Front of Game", "Back of Game", "Extra"], { 3: { issues: [issue("not_on_stand")] } });
  const b = decide(listing({ n: 3, title: "FX Unit Yuki - SG Memorial Box - Limited Edition Collectors Box" }), GAME,
    report({ n: 3, photos: ps, missing_shots: ["Opened Case With Disk"], setups: [[1, 2], [3]] }));
  return (a.verdict === "pass" && b.verdict === "pass") || say(a) + " | " + say(b); });
t("a loose cord counts in an accessories photo; a dirty table there does not (WSP XP-PEN, 2024 iMac)", () => {
  const ps = shotsAre(["Home/Lock Screen", "Back of Phone", "Extra Accessories"],
    { 3: { issues: [issue("loose_cord"), issue("dirty_backdrop")] } });
  const d = decide(listing({ n: 3 }), PHONE, report({ n: 3, photos: ps }));
  return (d.findings.some(f => f.code === "loose_cords") && !d.findings.some(f => f.code === "dirty_backdrop")) || say(d); });
// --- Ethan's WSP review on Opus, 10-15 ---
t("cosmetic flaws, then the earbuds, close the device's photos (WSP Galaxy Watch6, AirPods 5th Gen)", () => {
  const ps = shotsAre(["Home/Lock Screen", "Back of Phone", "Cosmetic Flaws", "Extra", "Extra Accessories"]);
  const a = decide(listing({ n: 5 }), PHONE, report({ n: 5, photos: ps }));
  const BUDS = { slug: "earbuds", shots: ["Front of Case", "Back of Case", "Case Opened (Empty)", "Top of Earbuds"].map(label => ({ label, cond: null })) };
  const bs = shotsAre(["Front of Case", "Back of Case", "Top of Earbuds", "Case Opened (Empty)", "Extra"]);
  const b = decide(listing({ n: 5 }), BUDS, report({ n: 5, photos: bs }));
  return (a.reorder?.suggested.join() === "1,2,4,3,5" && b.reorder?.suggested.join() === "1,2,4,5,3") || a.reorder?.suggested + " | " + b.reorder?.suggested; });
t("no different spot on a game or a bottom shot — but a bottom SIDE counts (WSP Hitman 3, Epson; LEE Samsung 860 Evo)", () => {
  const GAME = { slug: "video-games", shots: [{ label: "Front of Game", cond: null }, { label: "Back of Game", cond: null }] };
  const a = decide(listing({ n: 2 }), GAME, report({ n: 2, photos: shotsAre(["Front of Game", "Back of Game"]), setups: [[2], [1]] }));
  const b = run({}, PHONE, { photos: shotsAre(["Home/Lock Screen", "Back of Phone", "Bottom of Projector"]), setups: [[1, 2], [3]], n: 3 });
  const c = run({}, PHONE, { photos: shotsAre(["Home/Lock Screen", "Back of Phone", "Bottom Side of Phone", "Top Side of Phone"]), setups: [[1, 2], [3, 4]], n: 4 });
  const odd = c.findings.find(f => f.code === "mixed_setups");
  return (!a.findings.some(f => f.code === "mixed_setups") && !b.findings.some(f => f.code === "mixed_setups") && odd?.photos.join() === "3,4") || say(a) + " | " + say(b) + " | " + say(c); });
t("units apart in single-unit shots are fine when a lot shot shows them together (WSP TeamGroup RAM)", () => {
  const RAM = { slug: "ram", shots: [{ label: "Top of Lot", cond: null }, { label: "Top of RAM", cond: null }] };
  const d = decide(listing({ n: 2 }), RAM, report({ n: 2, photos: shotsAre(["Top of Lot", "Top of RAM"]), units_claimed: 2, units_together: false }));
  return !d.findings.some(f => f.code === "lot_not_shown") || say(d); });
t("a cushion closeup covers a flaw on the cushion, not one on the band (WSP Beats Solo4)", () => {
  const HP = { slug: "headphones-over-ear", shots: ["Front of Headphones", "Side of Headphones", "Back of Headphones", "Inside of Cushion", "Cosmetic Flaws"]
    .map(label => ({ label, cond: label === "Cosmetic Flaws" ? "Cosmetic flaws" : null })) };
  const ps = shotsAre(["Front of Headphones", "Inside of Cushion"]);
  const go = (txt) => decide(listing({ n: 2, unitCosmetic: [txt] }), HP, report({ n: 2, photos: ps, needed_missing: ["Cosmetic Flaws"] }));
  const a = go("The left cushion has a small tear."), b = go("The headphones have a scratch on the band.");
  return (!a.findings.some(f => f.shot === "Cosmetic Flaws") && b.findings.some(f => f.shot === "Cosmetic Flaws")) || say(a) + " | " + say(b); });
t("an item with its own screen never shown on is missing Screen On (WSP XP-PEN)", () => {
  const MISC = { slug: "small-medium-misc-items", shots: [{ label: "Front of Device", cond: null }] };
  const d = decide(listing({ n: 1 }), MISC, report({ n: 1, photos: shotsAre(["Front of Device"]), screen_never_on: true }));
  return d.findings.some(f => /Screen On/.test(f.shot || "")) || say(d); });

// --- 2. THE REPLAY ----------------------------------------------------------------------
const fx = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "pq-replay-2026-10-08.json"), "utf8"));
const KEY = Object.fromEntries(fs.readFileSync(path.join(here, "picture-quality-calibrate.mjs"), "utf8").split("\n")
  .map(l => /\["(WSP|OVL)", "(\d+)", "([^"]+)", "(flag|pass|\?)"/.exec(l)).filter(Boolean).map(m => [m[2], [m[3], m[4]]]));
const sheets = new Map(fx.sheets.map(s => [s.slug, s]));
let agreeN = 0, scored = 0, notPass = 0, seconds = 0;
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
  if (d.verdict !== "pass") { notPass++; if (needsSecondLook(l, sheet, r.report)) seconds++; }
  const got = flagged(d) ? "flag" : "pass";
  scored++; if (got === k[1]) agreeN++;
  console.log(`${got === k[1] ? "✓" : "✗"} ${r.store} ${k[0].padEnd(28)} Ethan ${k[1]}  now ${d.verdict.padEnd(7)} ${String(d.pictureScore).padStart(3)}  (then ${r.verdict_then})`);
  if (got !== k[1] || process.env.VERBOSE) for (const f of d.findings) console.log(`      ${f.text}`);
}
console.log(`\nCosmetic sentences read as about THE UNIT (not PayMore's wording) — ${unitNotes.length}:`);
for (const x of unitNotes) console.log("  " + x);
console.log(`
replay: ${agreeN}/${scored} agree with Ethan · second look on ${seconds} of ${notPass} not-pass (was all ${notPass}) · card: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
