// ============================================================================
// Picture Quality GOLD SET — step 2: turn gold.sql's rows into the eval file.
//
//   node scripts/pq-gold/export.mjs                       # gold-raw.json → gold.json + baseline-graded.json
//   node scripts/pq-gold/export.mjs my-raw.json           # another raw file
//   OFFLINE=1 node scripts/pq-gold/export.mjs             # no storefront reads (photos left unresolved)
//
// FREE. No model call, no Supabase call, nothing written anywhere but the two
// files beside this script. The only network is the PUBLIC storefront
// (`https://<shop>/products/<handle>.json`), read once per gold listing, for
// today's photo URLs and sizes. Those are Shopify CDN object URLs — never a
// Supabase /render/image/ transform (100 a cycle on Pro).
//
// WHY THE PHOTOS ARE READ LIVE. A review row stores no photo addresses, only a
// stamp (a hash of them). So a label is only good if today's photos are the
// ones it was about. Checked three ways, and a label that fails is kept but
// marked, so the scorer skips it by default instead of grading a model on
// photos the judgement never saw:
//   - review labels (shots, missing): today's photo count = the graded count.
//     After an approved order or deletion the saved report was renumbered to
//     the new Shopify order (renumberRow), so n lines up with position.
//   - framing labels: matched by the photo's own CDN address, so a reorder
//     since does not matter; a retaken photo simply no longer matches.
//   - Ethan's calibration verdicts: today's count = the count in the 10-08
//     replay fixture, the last run he scored. A store that fixed a flagged
//     listing since has changed the question.
//
// TIERS (every label says which):
//   explicit — Ethan made this exact call: his calibration key, a dismissal,
//              a framing label, KEY_FACTS below.
//   accepted — he approved a Quick Fix built from the model's report (the
//              order, a deletion) without objecting to it. Proof he accepted
//              the shot labels and the missing-shot notes as a whole, not that
//              he checked each one. ⚠️ CIRCULAR for the model that wrote them:
//              the scorer warns when it is fed the very grade they came from.
// See gold.sql's header for what is and is not human in the database.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.dirname(here);
const rawPath = process.argv[2] || path.join(here, "gold-raw.json");
const outDir = process.env.OUT_DIR || here;   // OUT_DIR=… writes the two files elsewhere (a trial run)
const OUT = path.join(outDir, "gold.json");
const BASELINE = path.join(outDir, "baseline-graded.json");
const OFFLINE = !!process.env.OFFLINE;

const SHOP = {
  OVL: "paymore-overland-park.myshopify.com", LEE: "paymore-lees-summit.myshopify.com",
  WSP: "paymore-westport.myshopify.com", MPL: "paymore-maplewood.myshopify.com", BAL: "paymore-ballwin.myshopify.com",
};
const tail = id => String(id).split("/").pop();

// --- Ethan's calibration key -------------------------------------------------
// Read out of picture-quality-calibrate.mjs the same way the rules test does,
// so there is one copy of it. "?" rows are unscored and skipped.
const KEY = Object.fromEntries(fs.readFileSync(path.join(scripts, "picture-quality-calibrate.mjs"), "utf8").split("\n")
  .map(l => /\["(WSP|OVL)", "(\d+)", "([^"]+)", "(flag|pass|\?)", "([^"]*)"/.exec(l)).filter(Boolean)
  .filter(m => m[4] !== "?").map(m => [m[2], { name: m[3], want: m[4], why: m[5] }]));
const replay = JSON.parse(fs.readFileSync(path.join(scripts, "fixtures", "pq-replay-2026-10-08.json"), "utf8"));
const COUNT_THEN = Object.fromEntries(replay.results.map(r => [tail(r.product_id), r.photo_count]));

// What the key's REASONS say about shots, in the sheet's own labels. Only what
// he said in so many words: `missing` is the whole list (he called it
// "perfect"), `includes` must be among the missing, `not` must not be.
const KEY_FACTS = {
  "15228968894566": { missing: ["Storage Information", "Software Information"] },    // Galaxy S26 Cobalt: "missing Storage and Software Information — perfect"
  // Galaxy S26 Ultra: "settings screen and top side are both there". He did not
  // say WHICH settings screen (the sheet has About, Storage and Software), so
  // only the top side is gold; today's grade calls Software Information missing.
  "8212164968550":  { not: ["Top Side of Phone"] },
  "15220477886630": { includes: ["Opposite Side of Projector", "Front of Projector (Lens Closed)", "Top of Projector"] }, // Epson: "opposite side, lens closed, top missing"
  "15228973383782": { includes: ["Top of Box", "Bottom of Box"] },                    // HP 902XL: "use them for top and bottom of box"
  "15228971024486": { includes: ["Top of Box", "Bottom of Box"] },                    // HP 952XL: same
  "8106562322534":  { sheet: "video-games", missing: [] },                            // Death Stranding 2 sealed: "front + back is fine"
  "8211779977318":  { sheet: "point-and-shoot-cameras" },                             // Sony A7 IV: "should use Point and Shoot"
};

// --- read the raw rows ---------------------------------------------------------
const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
const rows = (Array.isArray(raw) ? raw : raw.rows || raw.result || [])
  .map(r => r && r.g !== undefined ? r.g : r).map(r => typeof r === "string" ? JSON.parse(r) : r).filter(Boolean);
if (!rows.length) { console.error(`no rows in ${rawPath} — expected gold.sql's output (an array of {g: {...}})`); process.exit(1); }

async function storefront(store, handle) {
  if (OFFLINE || !handle || !SHOP[store]) return null;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`https://${SHOP[store]}/products/${encodeURIComponent(handle)}.json`);
      if (r.status === 404) return { gone: true };
      if (r.status === 429) { await new Promise(s => setTimeout(s, 2000 * (a + 1))); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const p = (await r.json()).product;
      return { price: Number(p.variants?.[0]?.price || 0), photos: (p.images || []).sort((x, y) => x.position - y.position)
        .map(i => ({ url: i.src, src: String(i.src).split("?")[0], width: i.width, height: i.height })) };
    } catch (e) { if (a === 2) return { error: String(e.message || e) }; await new Promise(s => setTimeout(s, 600)); }
  }
  return { error: "throttled" };
}

// A label in the CDN form pq_photo_labels keeps (no query string) vs the
// storefront's: the storefront serves the same file under cdn.shopify.com
// /s/files/… while the Admin API (what the trainer read) says the same path —
// compare the file name and its folder, which both forms share.
const fileKey = u => String(u || "").split("?")[0].split("/").slice(-2).join("/").toLowerCase();

const gold = [];
const baseline = [];
let fetched = 0;
for (const r of rows) {
  const id = tail(r.product_id);
  const key = KEY[id];
  const facts = KEY_FACTS[id];
  const kind = r.decision?.kind || null;
  const accepted = kind === "approved_order" || kind === "approved_deletion";
  const framing = r.framing || [];
  const confirmed = r.confirmed || [];   // Confirm Shots (0148): the primary source
  if (r.graded?.report) baseline.push({ store: r.store, product_id: r.product_id, sheet: r.sheet, model: r.graded.model,
    stamp: r.graded.stamp, verdict: r.graded.verdict, report: r.graded.report });
  if (!key && !kind && !framing.length && !facts && !confirmed.length) continue;   // no human signal: not gold

  const warnings = [];
  const live = await storefront(r.store, r.handle);
  if (live && !live.gone && !live.error) fetched++;
  if (!r.handle) warnings.push("no handle in ebay_catalog (sold or unlisted) — photos from the labels' own addresses");
  if (live?.gone) warnings.push("storefront 404 — listing gone; photos from the labels' own addresses");
  if (live?.error) warnings.push(`storefront read failed: ${live.error}`);
  const livePhotos = live?.photos || null;
  // The report's own photo list, not photo_count: an approved deletion
  // renumbers the report but leaves photo_count at the old number (OVL Monopoly
  // N64: 3 counted, 2 in the report, 2 live).
  const gradedCount = r.graded?.report?.photos?.length ?? r.graded?.photo_count ?? null;
  const aligned = !!livePhotos && gradedCount != null && livePhotos.length === gradedCount;
  if (livePhotos && gradedCount != null && !aligned) warnings.push(`photos changed since the grade (${gradedCount} graded, ${livePhotos.length} live)`);

  // One entry per photo position today. With no live read, one per confirmed
  // photo (it knows its position when confirmed), else per framing label, at
  // the address it was labelled at.
  const photos = livePhotos
    ? livePhotos.map((p, i) => ({ n: i + 1, url: p.url, width: p.width, height: p.height }))
    : confirmed.length ? confirmed.map(c => ({ n: c.n, url: c.src, width: null, height: null }))
    : framing.map(f => ({ n: null, url: f.src, width: null, height: null }));

  // ACCEPTED shot labels: the graded report's, when he approved a fix built on them.
  if (accepted) {
    for (const g of r.graded.report.photos || []) {
      const p = aligned ? photos[g.n - 1] : null;
      if (!p) continue;
      p.shots = g.shots; p.shots_from = kind; p.shots_tier = "accepted";
      p.whole_item = g.whole_item;
    }
  }
  // EXPLICIT shot labels from Confirm Shots, by address — they replace any
  // accepted label on the same photo. A photo retaken since is simply unmatched.
  let unconfirmed = 0;
  for (const c of confirmed) {
    const p = livePhotos ? photos.find(x => fileKey(x.url) === fileKey(c.src)) : photos.find(x => x.url === c.src);
    if (!p) { unconfirmed++; continue; }
    // "cropped" is 0148's name for cut_off. flags_checked (0149): blank = NO.
    Object.assign(p, { shots: c.shots, shots_from: "confirmed", shots_tier: "explicit",
                       flags: (c.flags || []).map(x => x === "cropped" ? "cut_off" : x), flags_checked: !!c.checked,
                       repeat_of: c.repeat_of ?? null, model_shots_then: c.model_shots, confirmed_at: c.at });
  }
  if (unconfirmed) warnings.push(`${unconfirmed} confirmed label(s) match no live photo (retaken or deleted since)`);
  const allConfirmed = !!confirmed.length && photos.length > 0 && photos.every(p => p.shots_from === "confirmed");
  const cSheet = confirmed[0]?.sheet || null;
  // Listing-level facts (0149), the same on every row; only from a checked save.
  const lfacts = confirmed.find(c => c.checked && c.listing)?.listing || null;
  const guide = r.confirmed_guide || r.guide || null;

  // EXPLICIT framing labels, by address.
  let unmatched = 0;
  for (const f of framing) {
    const p = livePhotos ? photos.find(x => fileKey(x.url) === fileKey(f.src)) : photos.find(x => x.url === f.src);
    if (!p) { unmatched++; continue; }
    p.framing = { label: f.label, problems: f.problems || [], from: "framing_label", tier: "explicit", at: f.at };
    if (f.trainer_shot) p.trainer_shot = f.trainer_shot;   // context only — not Ethan's call (see gold.sql)
  }
  if (unmatched) warnings.push(`${unmatched} framing label(s) match no live photo (retaken or deleted since)`);

  // VERDICT — the newest explicit call wins; an approved Quick Fix scores as a
  // pass, the way picture-quality-calibrate.mjs scores "reorder".
  let verdict = null;
  if (key) {
    const then = COUNT_THEN[id];
    const stale = then != null && livePhotos && livePhotos.length !== then;
    verdict = { value: key.want, from: "calibration_key", tier: "explicit", why: key.why, at: "2026-10-08",
                ...(stale ? { stale: `photos changed since he scored it (${then} then, ${livePhotos.length} now)` } : {}),
                ...(then == null ? { unchecked: "not in the 10-08 replay fixture — photo count then unknown" } : {}) };
  }
  if (kind === "dismissed") verdict = { value: "pass", from: "dismissed", tier: "explicit", why: r.decision.note, at: r.decision.at };
  else if (accepted && (!verdict || verdict.tier !== "explicit"))
    verdict = { value: "pass", from: kind, tier: "accepted", why: r.decision.note, at: r.decision.at, ...(aligned ? {} : { stale: "photos changed since" }) };

  // MISSING SHOTS. When every photo of the listing is confirmed, the missing
  // list follows from his labels: the sheet's ALWAYS shots (no condition) that
  // no photo covers. scope "always" tells the scorer to compare only the
  // model's missing_shots, because an If-Needed shot depends on the listing
  // text, which a label can't say. Otherwise the key's facts are explicit and
  // an approved fix's notes are accepted.
  let missing = null;
  if (allConfirmed && guide) {
    const have = new Set(photos.flatMap(p => p.shots || []).map(x => x.toLowerCase()));
    missing = { exact: [...new Set(guide.filter(s => !s.cond).map(s => s.label))].filter(x => !have.has(x.toLowerCase())),
                scope: "always", from: "confirmed_shots", tier: "explicit",
                // If-Needed shots he said the listing calls for, that no photo covers.
                ...(lfacts ? { needed: (lfacts.needed || []).filter(x => !have.has(String(x).toLowerCase())) } : {}) };
  } else if (facts && (facts.missing || facts.includes || facts.not)) {
    missing = { ...(facts.missing ? { exact: facts.missing } : {}), ...(facts.includes ? { includes: facts.includes } : {}),
                ...(facts.not ? { not: facts.not } : {}), from: "calibration_key", tier: "explicit",
                ...(verdict?.stale ? { stale: verdict.stale } : {}) };
  } else if (accepted) {
    missing = { exact: r.graded.report.missing_shots || [], from: kind, tier: "accepted", ...(aligned ? {} : { stale: "photos changed since" }) };
  }

  const sheet = cSheet ? { value: cSheet, from: "confirmed", tier: "explicit" }
              : facts?.sheet ? { value: facts.sheet, from: "calibration_key", tier: "explicit" }
              : accepted ? { value: r.sheet, from: kind, tier: "accepted" } : null;

  gold.push({
    store: r.store, product_id: r.product_id, sku: r.sku, title: r.title || key?.name || null,
    sheet: sheet?.value || r.sheet, sheet_gold: sheet, guide,
    price: live?.price || Number(r.price) || 0,
    // What decide() needs besides the report, as far as the database knows it
    // (cosmetic sentences only — functional and included notes are not saved).
    notes: r.graded?.notes || [],
    graded: r.graded ? { model: r.graded.model, stamp: r.graded.stamp, reviewed_at: r.graded.reviewed_at,
                         photo_count: gradedCount, verdict: r.graded.verdict } : null,
    aligned, photos, verdict, missing, facts: lfacts, warnings,
  });
}

// --- summary ---------------------------------------------------------------------
const by = new Map();
for (const g of gold) {
  const s = g.sheet || "(no sheet)";
  const b = by.get(s) || { listings: 0, aligned: 0, shotX: 0, shotPhotos: 0, framingPhotos: 0, framingProblems: 0, verdictX: 0, verdictA: 0, missingX: 0, missingA: 0 };
  b.listings++; if (g.aligned) b.aligned++;
  for (const p of g.photos) { if (p.shots) p.shots_tier === "explicit" ? b.shotX++ : b.shotPhotos++; if (p.framing) { b.framingPhotos++; if (p.framing.label !== "fine") b.framingProblems++; } }
  if (g.verdict && !g.verdict.stale) g.verdict.tier === "explicit" ? b.verdictX++ : b.verdictA++;
  if (g.missing && !g.missing.stale) g.missing.tier === "explicit" ? b.missingX++ : b.missingA++;
  by.set(s, b);
}
const counts = Object.fromEntries([...by].sort((a, b) => b[1].listings - a[1].listings));
// Every sheet's guide once, from whichever rows carry it — so the scorer can run
// decide() on the sheet a MODEL picked, not only the one the saved grade used.
const guides = {};
for (const r of rows) if (r.sheet && r.guide && !guides[r.sheet]) guides[r.sheet] = r.guide;
fs.writeFileSync(OUT, JSON.stringify({ made: new Date().toISOString(), from: path.basename(rawPath), counts, guides, listings: gold }, null, 1));
fs.writeFileSync(BASELINE, JSON.stringify(baseline));

console.log(`${gold.length} gold listings (of ${rows.length} rows) · storefront read ${fetched} · baseline ${baseline.length} graded rows`);
console.log("sheet".padEnd(34) + "list  algn  shot-ph x/a  frame-ph(prob)  verdict x/a  missing x/a");
for (const [s, b] of Object.entries(counts))
  console.log(`${s.padEnd(34)}${String(b.listings).padStart(4)}  ${String(b.aligned).padStart(4)}  ${String(b.shotX).padStart(6)}/${String(b.shotPhotos).padEnd(4)}  ${String(b.framingPhotos).padStart(8)}(${b.framingProblems})${" ".repeat(Math.max(1, 6 - String(b.framingProblems).length))}${String(b.verdictX).padStart(4)}/${b.verdictA}${" ".repeat(9)}${b.missingX}/${b.missingA}`);
console.log(`\n→ ${path.relative(process.cwd(), OUT)}\n→ ${path.relative(process.cwd(), BASELINE)}`);
