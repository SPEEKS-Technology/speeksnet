// ============================================================================
// picture-quality/rules.ts — the scoring card, in code.
//
// ⚠️ PURE ON PURPOSE. No Deno, no npm, no model, no network: the model REPORTS
// (index.ts asks it), and everything here DECIDES. That split is what lets a
// rule be changed and re-scored against saved reports for free —
// `node --experimental-strip-types scripts/picture-quality-rules-test.mjs` —
// before any paid run (Ethan, 2026-10-08: "don't spend any more money on this
// until we feel a new test of 10 random ones from OVL might work 100%").
// Keep it that way: an import of anything with side effects here breaks the
// offline test without breaking the deploy, which is the worst way round.
//
// THE CARD (Ethan's sheet "Picture Tool Scoring", signed off 2026-10-11).
// Every listing starts at 100 and is flagged under PASS_BAR. A flagged row shows
// EVERY finding — the score decides whether, never what — and never the number.
//
//   AUTOMATIC FLAG                       POINTS
//   not square                           missing Core info (any number)   −15 once
//   stock photo                          missing other settings screen     −3 each
//   fake / AI / heavily edited           missing serial (no-screen items)  −3
//   wrong item                           missing view, not crucial         −8 each,
//   personal info on screen                                               first one free
//   main flaw not shown                  repeated photo                    −4 each
//   no photos                            other photo's framing             −30 ÷ photos
//   retake (40%+ of required, ≥3)        blurry / dark / glare on a shot   −8 each
//   pair / set / lot not all shown       dirty table or backdrop           −5/−10/−15 by price
//   lead photo not to standard           reflections on the item           −3/−6/−9 by price
//   anything besides item + backdrop     photos from different spots       −5
//   video game not on the stand          loose, sprawled cord              −5 a photo
//   missing the guide's FIRST photo      photo order                       0 (Quick Fixes)
//     (or a view the notes put a flaw on)
//   missing If Needed shot the listing calls for
//
// Price breaks are $100 and $250: under $100, $100–$250, over $250.
// ============================================================================

// ---------------------------------------------------------------------------
// PAYMORE'S CONDITION TEMPLATES (Ethan, 2026-10-11, pasted from PayMore's
// lister: the Good and Fair wording for each field, per kind of item).
//
// ⚠️ WHAT IT DECIDES. A cosmetic sentence that is one of these is the
// listing program's wording, not a claim about THIS unit, so it never makes a
// Cosmetic Flaws photo required and never becomes the main flaw. Anything
// else the lister typed — "small crack on the bottom left of the screen" — is
// about the unit: it makes Cosmetic Flaws required (an automatic flag when it
// is missing) and can be the main flaw. Ethan: "detect when we should be
// taking a picture of certain cosmetic flaws when the listing says stuff about
// more intense conditions than fair or good."
//
// It replaced counting (a sentence on 4+ of a store's listings was "standard"),
// which got it wrong both ways: a template line rare at one store read as a
// claim, and a lister who types the same custom line often enough had it
// waved through. See isStandardSentence for how the samples are used — as the
// line for "normal wear", not as the only words allowed.
// ---------------------------------------------------------------------------
export const PAYMORE_TEMPLATES: Record<string, string> = {
  laptops: `The top case is in fair condition due to scuffs, dents, scratches and wear. Some of these scratches are semi-deep and easily seen. The top is in good cosmetic condition with minimal wear. The bottom is in fair condition due to scuffs, dents, scratches and wear. Some of these scratches are semi-deep and easily seen. The bottom is in good cosmetic condition with minimal wear. The sides are in fair condition due to some deep scratches, dents and wear. All four sides are in good cosmetic condition with minimal wear. The ports are functional, but are in fair condition due to heavy use, dings and scratches. The screen is in fair condition due to scratches, scuffs and wear. The keyboard is in good condition with some minor wear and signs of use. The keyboard is in fair condition due to heavy usage, scratched, dents and wear. The screen is in good condition with some minor wear and scuffs. The hinges are in good condition, sturdy and functioning properly. The bezel is in good cosmetic condition with little to no wear. The bezel is in fair condition with signs of use as well as scuffs, dents and scratches. All of the ports are in good condition and clean.`,
  phones: `The screen is in good cosmetic condition with minimal scuffs, scratches and wear! The screen is in fair cosmetic condition with some scuffs and scratches and wear. Some scratches are semi deep, but there is no major cosmetic damage. The back glass is in fair cosmetic condition with some scuffs and scratches and wear. Some scratches are semi deep, but there is no major cosmetic damage. The back glass is in good shape with minor wear. The bezel is in good shape with minor wear. The bezel has some scuffs, scratches, wear and dings along the corner, see photos. The front and back cameras are in good shape with no major wear or damage.`,
  tablets: `The screen is in fair cosmetic condition with some scuffs and scratches and wear. Some scratches are semi deep, but there is no major cosmetic damage. The screen is in good cosmetic condition with minimal scuffs, scratches and wear! The back is in good cosmetic condition with some minor scuffs, scratches and wear, see photos. The back is in fair cosmetic condition with some scuffs and scratches and wear. Some scratches are semi deep, but there is no major cosmetic damage. The bezel is in good cosmetic condition with some minor scuffs, scratches and wear. The bezel has some scuffs, scratches, wear and dings along the corner, see photos.`,
  watches: `This Apple Watch is in good cosmetic condition. The face/glass have no major wear or scratches. The band is in good condition with some minor wear. This Apple Watch is in fair condition due to scuffs, scratches and wear. Some of these scratches are semi-deep and easily seen. Please view our close up photos, as these are taken of the actual item being offered for sale.`,
  misc: `This device is used but in like-new, excellent condition. There are very few, if any, scratches or scuffs. This device is used in good condition. There are some scratches or scuffs from everyday use. This device is used in fair condition. There are many visible scratches, scuffs, and/or visible dings from heavy use.`,
  cameras: `The camera body is in good cosmetic condition with some minimal wear. The LCD and mirror are in good condition with no major wear, scratches or scuffs. Please view our close up photos, as these are taken of the actual item being offered for sale. This camera body is in fair cosmetic condition due to some scuffs, scratches and wear. Some of the wear is easily seen. The mirror and LCD both have some visible scuffs and scratches, but the images come out clear. Please view our close up photos, as these are taken of the actual item being offered for sale. This camera body is in fair cosmetic condition due to some visible scuffs, scratches and wear. However, the mirror and LCD are both in good condition with little to no wear. Please view our close up photos, as these are taken of the actual item being offered for sale. This camera body and LCD are both in good condition with some minimal wear. The mirror however, has some visible scratches and wear. The camera still takes good clear images. Please view our close up photos, as these are taken of the actual item being offered for sale. This camera body is in good cosmetic condition with some minor wear. The mirror is also in good condition with no major wear or scratches. The LCD however, has some significant scratches and wear. Please view our close up photos, as these are taken of the actual item being offered for sale. This camera body is in good condition, but the mirror and LCD both have some heavy scratches and wear. The camera still takes clear photos. Please view our close up photos, as these are taken of the actual item being offered for sale. This camera body is in fair condition due to some visible scuffs, scratches and wear. The LCD also has some heavy scratches and wear that is easily seen. The mirror however, is in good condition with no major wear or scratches. Please view our close up photos, as these are taken of the actual item being offered for sale. The LCD is in good condition, but the camera body is fair due to some visible scuffs, scratches and wear. The mirror is also fair with some easily seen scratches and wear. The camera still takes clear photos. Please view our close up photos, as these are taken of the actual item being offered for sale.`,
  consoles: `This console is in excellent cosmetic condition. The top, bottom and sides all have minimal, if any, scuffs and wear. Please view our close up photos, as these are taken of the actual item being offered for sale. The bottom of the console is in good condition, but the top casing has some scuffs, scratches and wear. The vents have been cleaned and are in good condition. All crevices and vents have been cleaned of dust and debris. Please view our close up photos, as these are taken of the actual item being offered for sale. The top casing is in good condition with some minor wear, but the bottom has some heavy scuffs, scratches and wear. The vents have been cleaned and are in good condition. All crevices and vents have been cleaned of dust and debris. Please view our close up photos, as these are taken of the actual item being offered for sale. The top and bottom casing are both in good condition with some minor wear. The vents however, are fair with some scratches, dings and debris. The vents have been cleaned to the best of our ability. Please view our close up photos, as these are taken of the actual item being offered for sale. This console is in fair cosmetic condition. The top and bottom casings both have some heavy scuffs, scratches, dings and wear. The vents also have some dings, wear and debris. The vents have been cleaned to the best of our ability. Please view our close up photos, as these are taken of the actual item being offered for sale. The top and bottom casings are both in fair condition due to scuffs, scratches, dings and wear. The vents however, are in good condition and have been cleaned. All crevices and vents have been cleaned of dust and debris. Please view our close up photos, as these are taken of the actual item being offered for sale. The top casing is in good cosmetic condition with some minor wear. The bottom casing and vents are both in fair condition due to scuffs, scratches, dings and debris. The vents have been cleaned to the best of our ability. Please view our close up photos, as these are taken of the actual item being offered for sale. The bottom of this console is in good condition, but the top and vents are fair. The top casing and the vents are fair due to scuffs, scratches, dings and debris. The vents have been cleaned to the best of our ability. Please view our close up photos, as these are taken of the actual item being offered for sale. The console is in good pre-owned condition with a few noticeable scuffs, scratches, and wear.`,
  // Game case/box lines. The Acceptable one names stains, rips and major
  // creases and is STILL PayMore's wording — Ethan, 2026-10-14, BAL Gears 5:
  // "the cosmetic description is normal for fair for PayMore listings".
  games: `The case/box is in good condition with light to moderate wear, including some small stains, creases, or tears. The case/box is in acceptable condition with a good amount of noticeable scratches, small stains, small rips, major creases, and other wear. This disc game is in good pre-owned condition. There is some light wear on the top and light scratches on the bottom from use.`,
  pcs: `The case is in good cosmetic condition with minimal wear. The case is in fair condition due to scuffs, dents, scratches and wear. Some of these scratches are semi-deep and easily seen. The glass is in good condition with some minor wear and scuffs. The glass is in fair condition due to scratches, scuffs and wear. All sides are in good cosmetic condition with minimal wear. The sides are in fair condition due to some deep scratches, dents and wear. All of the ports are in good condition and clean. The ports are functional, but are in fair condition due to heavy use, dings and scratches.`,
};

// One splitter for notes and templates alike, so they are cut the same way.
export const splitSentences = (s: string) =>
  String(s || "").split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(x => x.length > 12);
const words = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);

// Damage the templates never describe. A sentence naming one is about the
// unit, however template-like the rest of it reads ("the screen is in good
// condition but has a crack in the corner").
export const SEVERE = /\b(crack|cracked|cracks|shatter|shattered|broken|break|missing|chip|chipped|chips|burn|burned|burnt|dead pixels?|bent|peel|peeling|stain|stained|hole|torn|tear|rips?|ripped|lines? on|spots? on|bruis|discolou?r|scorch|melt|bulg|swell|swollen|water damage)/i;

const TEMPLATE_WORDS: Set<string>[] = Object.values(PAYMORE_TEMPLATES)
  .flatMap(splitSentences).map(x => new Set(words(x)));
const SEVERE_TEMPLATE_WORDS: Set<string>[] = Object.values(PAYMORE_TEMPLATES)
  .flatMap(splitSentences).filter(x => SEVERE.test(x)).map(x => new Set(words(x)));
// ≥ 85% of a sentence's words inside ONE template sentence: the template with a
// device name swapped or a clause dropped still counts.
const TEMPLATE_SHARE = 0.85;

// ONE flaw, at ONE place — "a dent on the back corner", "a deep scratch across
// the screen", "a gouge on the lid" — is a claim about this unit; the plural,
// placeless "scuffs, scratches and wear" of every Good/Fair line is not.
const LOCATED = /\bgouge[ds]?\b|\b(dent|ding|scratch|scuff|mark|nick|scrape)\b[^.,;]{0,25}\b(on|near|along|across|at|by|in) (the|its|their)\b|\b(one|a|single)\s+(deep|large|big|long|noticeable|major|visible)\s+(scratch|dent|scuff|ding|mark|nick|scrape)\b/i;

// ⚠️ MEANING, NOT WORDS (2026-10-11). The first version matched Ethan's samples
// word for word, and the free replay showed what listings really say: 49
// cosmetic sentences across the 30 calibration listings, 47 of them ordinary
// Good/Fair wear in OTHER words ("The console is in good pre-owned condition,
// showing a few noticeable scuffs…") or for items the samples do not cover
// (games, controllers, headphones, lenses). Word-matching would have demanded a
// Cosmetic Flaws photo on nearly every listing. The two real ones were "The
// back glass is cracked/damaged" (WSP iPhone 11) and "the housing is cracked/
// damaged" (WSP Acer). So a sentence is about THE UNIT only when it says more
// than Good/Fair wear can: damage the templates never name (SEVERE), or one
// located flaw (LOCATED) that is not one of PayMore's own lines. Everything
// else — the templates, and any rewording of them — is standard.
// `seen` (the old store-wide count) is accepted and ignored, so a caller that
// still passes it changes nothing.
// Damage words that are NOT a claim (first random run, 2026-10-11): the game
// template "the case/box is in good condition with light to moderate wear,
// including some small stains, creases, or tears" flagged four games for a
// missing Cosmetic Flaws photo, and a card's "There are no major defects like
// deep creases, tears, or liquid damage" read as damage too. A damage word
// after a negation ("no", "without", "free of") or inside a hedged "including
// some small…" / "such as minor…" list says what MIGHT be there, so it is cut
// before SEVERE looks. A damage word outside such a clause still counts, and
// the clause ends at ", and" / ", but" — "No manual, and the case is cracked"
// is still a crack.
const NOT_A_CLAIM = /\b(no|not any|without|free of|free from|(may|might|could)\s+(include|have|show)|including\s+(some\s+)?(small|minor|light|slight|possible|occasional)|(such as|like)\s+(some\s+)?(small|minor|light|slight|possible|occasional))\b[^.;]*?(?=,\s*(and|but)\b|[.;]|$)/gi;
export function isStandardSentence(sentence: string, _seen = 0): boolean {
  const w = words(sentence);
  const fits = (ts: Set<string>[]) => w.length > 0 && ts.some(t => w.filter(x => t.has(x)).length / w.length >= TEMPLATE_SHARE);
  // A template that itself names damage (the Acceptable game case: "small
  // stains, small rips, major creases") is matched BEFORE the damage words —
  // only a sentence that IS that template, not one that borrows a word from it.
  if (fits(SEVERE_TEMPLATE_WORDS)) return true;
  if (SEVERE.test(sentence.replace(NOT_A_CLAIM, " "))) return false;
  if (fits(TEMPLATE_WORDS)) return true;
  return !LOCATED.test(sentence);
}

export const PASS_BAR = 90;
export const SQUARE_TOLERANCE = 0.01;
export const RETAKE_SHARE = 0.4;

export type Issue = { type: string; severity: "minor" | "major" };
export type PhotoR = {
  n: number; shots: string[]; whole_item: boolean; repeats: number | null;
  framing: "matches" | "close" | "off"; framing_problems: string[]; issues: Issue[]; note?: string;
};
export type ReportR = {
  photos: PhotoR[];
  missing_shots: string[];
  // If Needed shots the listing CALLS FOR (it says the thing the shot covers)
  // and no photo covers. Older reports lack these fields; every reader defaults.
  needed_missing?: string[];
  // Sheet views the [unit] notes put a flaw on — those views become crucial.
  flaw_views?: string[];
  units_claimed?: number | null;
  all_units_shown?: boolean;
  units_together?: boolean;
  // Do the photos, taken together, show every edge of the device? See decide().
  all_sides_shown?: boolean;
  // New In Box / Open Box: the packaging is flat (a blister or hanging card).
  flat_package?: boolean;
  main_flaw: { stated: string | null; source: string; shown: string; photo: number | null };
  serial: "shown" | "hidden_behind_cover" | "not_shown";
  lead_ok: boolean;
  setups?: number[][];
  setup_difference?: string;
  suggested_order: number[];
  [k: string]: unknown;
};
export type ShotR = { label: string; cond: string | null; crucial?: boolean };
export type SheetR = { slug: string; shots: ShotR[] };
export type ListingR = {
  title: string; cosmetic: string; functional: string; included: string; price: number;
  photos: { width: number; height: number }[];
  // The cosmetic sentences that are about THIS unit (not PayMore's template).
  unitCosmetic: string[];
};
export type Finding = {
  code: string; text: string; photo?: number; shot?: string; shots?: string[]; photos?: number[];
  // missing Everything Included only: what the listing says comes with it.
  included?: string;
  // missing_shot only: which line of the card it is costed on.
  tier?: "core" | "minor" | "serial" | "view" | "view_free" | "crucial" | "needed";
};

export const BOX_SHEETS = new Set(["new-in-box", "new-open-box"]);

// --- what kind of shot is this ------------------------------------------------
// From the guide's real labels (checked 2026-10-11 across all 53 sheets). Core is
// Ethan's list: Battery Health, the About / device page, Storage, and for
// computers CPU, RAM, GPU — "some laptops like MacBooks have different style
// pages to show those 4, so it may look different on each laptop, we just need
// to make sure it's there", which is the model's job (info counts as shown if ANY
// photo shows it legibly). Minor is every other info screen ("Software
// Information missing is like a −3"). Anything else required is a VIEW.
const CORE = /^(battery health|about\b|settings about page|settings page( 1)?$|model information|system information|storage information|cpu information|processor information|ram information|gpu information|graphics information)/i;
const MINOR = /^(software information|operating system)/i;
const SERIAL = /serial/i;
// Any spec / settings screenshot — for keeping the store's order among them.
const INFO_SHOT = /^(battery health|about\b|settings|model information|system information|storage information|cpu information|processor information|ram information|gpu information|graphics information|software information|operating system|parts|apple warranty)/i;
export function shotKind(label: string): "core" | "minor" | "serial" | "view" {
  const s = label.trim();
  if (SERIAL.test(s)) return "serial";
  if (CORE.test(s)) return "core";
  if (MINOR.test(s)) return "minor";
  return "view";
}
// A device with a screen: its sheet asks for an About / Settings / System page.
// Its serial matters ("on things like phones where the serial number is very
// important, as long as it shows in the settings picture the closeup not being
// there is fine") and counts as Core; anything else's serial is −3.
export const hasScreenInfo = (sheet: SheetR) =>
  sheet.shots.some(s => !s.cond && /^(about\b|settings|system information|model information)/i.test(s.label));

const priceStep = (price: number, low: number, mid: number, high: number) =>
  price > 250 ? high : price >= 100 ? mid : low;

// --- the score -------------------------------------------------------------------
export const ALWAYS_FLAG = new Set(["retake", "not_square", "stock_photo", "fake_or_edited", "wrong_item",
  "personal_info", "flaw_not_shown", "no_photos", "lot_not_shown", "clutter", "lead", "not_on_stand", "turned"]);

export function pictureScore(findings: Finding[], photoCount: number, price: number) {
  const n = Math.max(1, photoCount);
  let score = 100, coreTaken = false;
  const costs: { code: string; cost: number; photo?: number; shot?: string }[] = [];
  for (const f of findings) {
    let cost: number;
    if (ALWAYS_FLAG.has(f.code)) cost = 100;
    else if (f.code === "missing_shot") {
      cost = f.tier === "crucial" || f.tier === "needed" ? 100
        // "−15 total. Detail each one that's missing, but no need to dock them
        // −15 for each missing."
        : f.tier === "core" ? (coreTaken ? 0 : (coreTaken = true, 15))
        : f.tier === "minor" || f.tier === "serial" ? 3
        : f.tier === "view_free" ? 0
        : 8;
    }
    else if (f.code === "framing") cost = f.photo === 1 ? 100 : 30 / n;   // the lead photo is a flag
    else if (f.code === "repeat") cost = 4 * (f.photos?.length || 1);
    else if (f.code === "dirty_backdrop") cost = priceStep(price, 5, 10, 15);
    else if (f.code === "reflection") cost = priceStep(price, 3, 6, 9);
    else if (f.code === "mixed_setups") cost = 5;
    else if (f.code === "loose_cords") cost = 5 * (f.photos?.length || 1);
    else cost = 8;   // blurry, too dark or glare on a guide shot
    score -= cost;
    costs.push({ code: f.code, cost: Math.round(cost * 10) / 10, photo: f.photo, shot: f.shot });
  }
  return { score: Math.max(0, Math.round(score)), costs };
}

// Longest run of photos already in sheet order, as a share of the photos that
// map to a sheet shot. Box and extras do not count either way.
export function orderScore(photos: PhotoR[], sheet: SheetR): number {
  const ix = (label: string) => sheet.shots.findIndex(s => s.label.toLowerCase() === label.toLowerCase());
  const seq = photos.map(p => Math.min(...p.shots.map(ix).filter(i => i >= 0), Infinity))
    .filter(i => Number.isFinite(i));
  if (seq.length < 2) return 1;
  const tails: number[] = [];
  for (const v of seq) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tails[m] <= v) lo = m + 1; else hi = m; }
    tails[lo] = v;
  }
  return tails.length / seq.length;
}

const ISSUE_TEXT: Record<string, string> = {
  blurry: "is blurry", too_dark_or_glare: "is too dark or has glare",
  stock_photo: "is a stock photo", fake_or_edited: "looks fake or edited", personal_info: "shows personal information",
  wrong_item: "shows a different item",
};
const PROBLEM_TEXT: Record<string, string> = { crooked: "crooked", off_center: "not centred",
  too_small: "too small in the frame", cut_off: "cut off", wrong_angle: "taken from the wrong angle",
  // RAM sticks stood on end where photo 1 lies them lengthways (Ethan, 2026-10-11).
  turned: "turned a different way from the guide and the other photos" };
const plural = (ns: number[], one: string, many: string) => (ns.length > 1 ? many : one);
const list = (ns: (number | string)[]) => ns.length < 3 ? ns.join(" and ") : ns.slice(0, -1).join(", ") + " and " + ns[ns.length - 1];

// LOOK-ALIKE FACES ARE NOT REPEATS (Ethan, 2026-10-11, WSP Beats Studio3 and
// Solo4): over-ear headphones on the stand look the same from the front and
// the back, so the model labelled both "Front of Headphones", called the back a
// repeat of photo 1 and — on the Solo4 — the back missing. Same trouble as the
// sides of a plain box. When a repeat and its original are both labelled a shot
// whose OPPOSITE is also on the sheet (Front ↔ Back, X ↔ Opposite X), the later
// photo is that opposite face: no deletion, and the opposite is not missing —
// as long as no other photo already shows the opposite. When the model has
// pinned the back on some other photo (the Studio3's photo 9), only the
// prompt's front/back rule can catch it. A
// wrong deletion removes a good photo; a missed one leaves a spare. NOT top ↔
// bottom — the WSP TeamGroup RAM's photo 3 really was photo 1 again ("Top of
// Lot"), and Ethan deleted it.
function oppositeShot(label: string, sheet: SheetR): string | null {
  const t = label.trim();
  const cands = /^front\b/i.test(t) ? [t.replace(/^front/i, "Back")]
    : /^back\b/i.test(t) ? [t.replace(/^back/i, "Front")]
    : /^opposite\s+/i.test(t) ? [t.replace(/^opposite\s+/i, "")]
    : ["Opposite " + t];
  const hit = sheet.shots.find(s => cands.some(c => c.toLowerCase() === s.label.toLowerCase()));
  return hit ? hit.label : null;
}
export function lookAlikeFaces(r: ReportR, sheet: SheetR): ReportR {
  const byN = new Map(r.photos.map(p => [p.n, p]));
  const freed: string[] = [];
  let closeTaken = false;
  const photos = r.photos.map(p => {
    const q = p.repeats != null ? byN.get(p.repeats) : undefined;
    if (!q) return p;
    // THE CLOSEUP LOOKS LIKE THE FACE IT IS ON (Ethan, 2026-10-13, OVL Intel
    // SSD: "it just looks like the same photo because the closeup is going to be
    // on either the top or the bottom"). The model read the label off photo 1,
    // counted it as the Top AND the serial closeup, and called the real closeup
    // (photo 2) a repeat. When the original is the only photo holding the
    // sheet's closeup shot, the "repeat" is that closeup.
    const close = q.shots.find(s => /closeup|serial/i.test(s) && sheet.shots.some(x => x.label.toLowerCase() === s.toLowerCase()));
    if (close && !closeTaken && !r.photos.some(o => o !== q && o.shots.some(x => x.toLowerCase() === close.toLowerCase()))) {
      closeTaken = true;
      return { ...p, repeats: null, whole_item: false, shots: [close] };
    }
    const shared = p.shots.find(s => q.shots.some(x => x.toLowerCase() === s.toLowerCase()));
    const opp = shared ? oppositeShot(shared, sheet) : null;
    // Only while no OTHER photo shows that face: with the back already shown,
    // a second front is a real repeat (the OVL PS3 controllers, the Duke, the
    // HP 952XL box — Ethan flagged all four on 10-08).
    if (!opp || freed.includes(opp.toLowerCase())
      || r.photos.some(o => o !== p && o.shots.some(x => x.toLowerCase() === opp.toLowerCase()))) return p;
    freed.push(opp.toLowerCase());
    return { ...p, repeats: null, shots: [opp] };
  });
  if (!freed.length && !closeTaken) return r;
  return { ...r, photos, missing_shots: r.missing_shots.filter(m => !freed.includes(m.trim().toLowerCase())) };
}

// --- the verdict ---------------------------------------------------------------
export function decide(l: ListingR, sheet: SheetR, r0: ReportR, faults?: Map<number, string[]>) {
  const r = lookAlikeFaces(r0, sheet);
  // Repeats the code stands behind. A closeup of a label is never a repeat of
  // the face it sits on, nor a whole shot of a closeup (Ethan, 2026-10-13, OVL
  // Intel SSD: "the closeup is going to be on either the top or the bottom").
  const byNr = new Map(r.photos.map(p => [p.n, p]));
  const realRepeats = r.photos.filter(p => {
    const q = p.repeats != null && p.repeats >= 1 && p.repeats < p.n ? byNr.get(p.repeats) : undefined;
    return !!q && p.whole_item === q.whole_item && !p.shots.some(s => /closeup|serial/i.test(s));
  });
  const repeatSet = new Set(realRepeats.map(p => p.n));
  const findings: Finding[] = [];
  const n = l.photos.length;

  // Measured, not asked.
  l.photos.forEach((p, i) => {
    if (p.width && p.height && Math.abs(p.width - p.height) / Math.max(p.width, p.height) > SQUARE_TOLERANCE) {
      findings.push({ code: "not_square", photo: i + 1, text: `Photo ${i + 1} isn't square (${p.width}×${p.height}).` });
    }
  });

  // A game is shot as close as a game can be; empty space around a cartridge is
  // the cartridge being small, not a framing mistake.
  const gameSheet = /^video-games/.test(sheet.slug);
  // Box, everything-included and accessory photos are staged, not framed — the
  // PS5's controllers sit angled on purpose. NOT a bare "Extra": that waved
  // through the iPad's cropped screen closeup, a photo of the item itself.
  const staged = (p: PhotoR) => p.shots.length > 0
    && p.shots.every(s => /^(box|everything included|extra accessories)/i.test(s.trim()));
  // A photo that is not a sheet shot has no example to be at the wrong angle to
  // (OVL RAM edge-on extras, a PS3's upside-down extra — Ethan passed them).
  const extraOnly = (p: PhotoR) => p.shots.every(s => /^extra/i.test(s.trim()));
  // Crooked / off-centre / too small come from the framing look when it ran
  // (off by default — see index.ts FramingReport); otherwise the review's word.
  const ownLook = new Set(faults ? ["crooked", "off_center", "too_small"] : []);
  // ⚠️ PAUSED (Ethan, 2026-10-11): the review's own crooked / off-centre / too
  // small calls do not count — not shown, no points, never the lead-photo flag.
  // Scored against his 395 trainer labels they were nearly all false alarms
  // (crooked 1 right, 13 wrong), and a false "crooked" on the OVL Micron lot's
  // photo 1 flagged the listing by itself. Cut off and wrong angle still count.
  // TO REVISIT once everything else is settled ("I want to revisit it after you
  // believe we are good on everything else") — see picture-quality-lab.
  const PAUSED = new Set(["crooked", "off_center", "too_small"]);
  for (const p of r.photos) {
    if (staged(p)) continue;
    const said = p.framing !== "off" ? [] : p.framing_problems.filter(x => !ownLook.has(x) && !PAUSED.has(x)
      && !(x === "cut_off" && !p.whole_item) && !(x === "too_small" && gameSheet)
      && !(x === "wrong_angle" && extraOnly(p)));
    // Turned is its own automatic flag, not framing points (Ethan, 2026-10-11,
    // WSP TeamGroup RAM photo 2 stood on end: "I would also have flagged" it).
    // Never on a side / top / bottom / corner shot: turning the item to show an
    // edge is the point of it (OVL Toshiba HDD photos 3 and 4, Ethan 10-13).
    if (said.includes("turned") && !p.shots.some(s => /\b(side|top|bottom|corner|edge)\b/i.test(s))) findings.push({ code: "turned", photo: p.n,
      text: `Photo ${p.n} has the item turned a different way from the guide and the other photos — turn it to match, then retake.` });
    const probs = [...new Set([...(faults?.get(p.n) || []), ...said.filter(x => x !== "turned")])];
    if (probs.length) {
      findings.push({ code: "framing", photo: p.n,
        text: `Photo ${p.n} isn't to the guide's standard: ${probs.map(x => PROBLEM_TEXT[x] || x).join(", ")}.` });
    }
  }

  // ONE FINDING PER LISTING for what is the same in every shot: the table, what
  // else is in frame, reflections, and where the photos were taken.
  const withIssue = (type: string, skip?: (p: PhotoR) => boolean) => r.photos
    .filter(p => !(skip && skip(p)) && p.issues.some(it => it.type === type && it.severity === "major")).map(p => p.n);
  const dirty = withIssue("dirty_backdrop");
  if (dirty.length) findings.push({ code: "dirty_backdrop", photos: dirty,
    text: `The table or backdrop is dirty in ${plural(dirty, "photo", "photos")} ${list(dirty)} — clean it, then retake.` });
  // Anything besides the item, its stand and the white backdrop: an automatic
  // flag (Ethan, 2026-10-11: "Nothing else should be in frame"), with the tip he
  // gave for things too big for the lightbox.
  // LOOSE CORDS (Ethan, 2026-10-11): "For items that have cords, if they are not
  // tied or wrapped up and are just loose and sprawled out, we will want to
  // change that because it looks bad like that." First a flag in 3+ photos; the
  // same day, on the OVL ADC equalizer: "To make it easier as a rule just do
  // every picture is −5 points". The good example is the OVL Roland MA-8 pair.
  const corded = withIssue("loose_cord");
  if (corded.length) findings.push({ code: "loose_cords", photos: corded,
    text: `The cord is loose and sprawled out in ${plural(corded, "photo", "photos")} ${list(corded)} — tie or wrap it up, then retake.` });
  // VIDEO GAMES STAND ON THE STAND (Ethan, 2026-10-11, OVL Wii Fit: "If video
  // game are not on stands, it should be flagged"). An automatic flag, on the
  // game sheets only — the model is asked about it only there.
  const flat = gameSheet ? withIssue("not_on_stand") : [];
  if (flat.length) findings.push({ code: "not_on_stand", photos: flat,
    text: `${plural(flat, "Photo", "Photos")} ${list(flat)} ${plural(flat, "isn't", "aren't")} on the stand — a game is shot standing on the clear stand, like the guide's example. Retake ${plural(flat, "it", "them")} on the stand.` });
  const cluttered = withIssue("clutter");
  if (cluttered.length) findings.push({ code: "clutter", photos: cluttered,
    text: `Something besides the item and the white backdrop is in ${plural(cluttered, "photo", "photos")} ${list(cluttered)} — `
      + `clear it out of the frame and retake. For a large or long item, Shopify's AI background tool can make the background white.` });
  // The guide's Screen Off shot is photographed FOR its reflections.
  const reflected = withIssue("reflection", p => p.shots.some(x => /screen off/i.test(x)));
  if (reflected.length) findings.push({ code: "reflection", photos: reflected,
    text: `A reflection shows on the item in ${plural(reflected, "photo", "photos")} ${list(reflected)} — angle the item or the light, then retake.` });
  // One listing, one spot. The odd photos are everything outside the biggest
  // group; their own framing problems, if any, are separate findings above —
  // "if they also aren't centred then it can double up as that too".
  // A LOT is the exception (Ethan, 2026-10-11, OVL Micron RAM lot): the group
  // shots of the whole lot lie flat, and single units may go on the stand —
  // "They both look good." Different spots still count on a single item (the
  // OVL Sony lens: the same shots on and off the stand).
  const isLot = (r.units_claimed || 0) > 1 || r.photos.some(p => p.shots.some(s => /\bof lot\b/i.test(s)));
  // Closeups (a serial label) may be shot anywhere — the OVL Loupedeck's photo 8
  // was called "a different spot" for being a closeup (Ethan, 2026-10-11).
  const closeup = new Set(r.photos.filter(p => !p.whole_item).map(p => p.n));
  // A photo that REPEATS one in the standard setup is deleted, not retaken
  // (Ethan, 2026-10-13, OVL Ryzen 7 2700X: "5, 6 and 7 can just be deleted as
  // they are the same as 1 and 2"; the Oliver Twins game's 4 and 6) — so it is
  // left out of the different-spot line, which then names only what to retake.
  const setups = isLot ? [] : (r.setups || []).map(g => [...new Set(g)].filter(x => x >= 1 && x <= n && !closeup.has(x) && !repeatSet.has(x))).filter(g => g.length);
  if (setups.length > 1) {
    // The FIRST group is the store's standard setup (the prompt lists it first:
    // the stand photos when some are on the stand), not the biggest — the WSP
    // AirPods' stand photos were outnumbered by flat ones, and the flat case
    // shots were the ones to retake.
    const main = setups[0];
    const odd = setups.filter(g => g !== main).flat().sort((a, b) => a - b);
    findings.push({ code: "mixed_setups", photos: odd,
      // Short (Ethan, 10-13: "Too many words"), and either position will do as
      // long as every photo matches (his note on the OVL Sony lens).
      text: `${plural(odd, "Photo", "Photos")} ${list(odd)} ${plural(odd, "was", "were")} taken in a different spot from photo ${main[0]}`
        + ` — retake so every photo is shot the same way (all on the stand, or all off it).` });
  }

  for (const p of r.photos) {
    for (const it of p.issues) {
      // Only what the model stands behind as major costs a manager a reshoot.
      if (it.severity !== "major" || !(it.type in ISSUE_TEXT)) continue;
      // A soft EXTRA hides nothing the guide asks for (OVL Micron RAM).
      if (it.type === "blurry" && extraOnly(p)) continue;
      findings.push({ code: it.type, photo: p.n, text: `Photo ${p.n} ${ISSUE_TEXT[it.type]}.` });
    }
  }

  // A pair, a set, a lot: the photos must show everything the listing says it
  // has, together in the whole-item shots (Ethan, 2026-10-11: "a lot of 6 games
  // needs to show pictures of the 6 games"). General — it replaced the speaker-
  // pair-only rule.
  const units = Number(r.units_claimed || 0);
  if (units > 1 && (r.all_units_shown === false || r.units_together === false)) {
    findings.push({ code: "lot_not_shown",
      text: r.all_units_shown === false
        ? `The listing is for ${units} items, but the photos don't show all ${units} — retake the guide's shots with every item in them.`
        : `The listing is for ${units} items, but the guide's shots show them one at a time — retake those shots with all ${units} together (single-item photos can stay as extras).` });
  }

  // --- missing shots ---------------------------------------------------------------
  // Shots that cannot apply to some listings, decided here:
  //  - a SEALED game cannot be opened (OVL Death Stranding 2);
  //  - a LOT with no box has no box to photograph (the Dell WD15 lot).
  const sealed = /^new\b/i.test(l.title) || /\bsealed\b/i.test(l.cosmetic);
  const hasBox = /\bbox\b/i.test(l.included);
  const requiredShots = sheet.shots.filter(s => !s.cond)
    .filter(s => !(sealed && gameSheet && /opened case/i.test(s.label)))
    .filter(s => !(sheet.slug === "item-lots" && !hasBox && /\bbox\b/i.test(s.label)))
    // FLAT RETAIL PACKAGING (Ethan, 2026-10-11, WSP SanDisk microSD on its
    // card: "I wouldn't flag this one"): a blister or hanging card has no real
    // top, bottom or sides, so on a box sheet only its front, back and label
    // are asked for — the sealed-game reasoning, for everything else sold new.
    .filter(s => !(BOX_SHEETS.has(sheet.slug) && r.flat_package === true && /\b(top|bottom|side)\b/i.test(s.label)));
  const byLabel = new Map(sheet.shots.map(s => [s.label.toLowerCase(), s]));
  // SIDES AND CORNERS ARE FOR SHOWING THE SIDES (Ethan, 2026-10-11, OVL Galaxy
  // Tab A: "6,7,8,9 all do show the top, bottom, and the corners. It's okay if
  // it's not the identical angle as long as all 4 sides are shown" — the same
  // call he made on the Onyx Boox and the OVL Surface on 10-08). When the photos
  // together show every edge, no side or corner shot is missing, however few
  // photos or whatever angle did it. Not on a box: there every face is its own
  // shot, and a box's six faces are not "four sides".
  const sidesCovered = r.all_sides_shown === true && !BOX_SHEETS.has(sheet.slug);
  const missingRequired = [...new Set(r.missing_shots.map(m => m.trim()))]
    .filter(m => requiredShots.some(s => s.label.toLowerCase() === m.toLowerCase()))
    .filter(m => !(sidesCovered && /\b(side|corner)\b/i.test(m)));
  // 40%, and at least three: Ethan is testing this line (blue on the card).
  const retake = requiredShots.length > 0 && missingRequired.length >= 3
    && missingRequired.length / requiredShots.length >= RETAKE_SHARE;

  const screen = hasScreenInfo(sheet);
  const flawViews = new Set((r.flaw_views || []).map(v => v.trim().toLowerCase()));
  const missing: Finding[] = [];
  const core: string[] = [];
  let freeUsed = false;
  for (const m of missingRequired) {
    const kind = shotKind(m);
    if (kind === "serial") continue;   // the serial rule below decides
    if (kind === "core") { core.push(m); continue; }
    if (kind === "minor") { missing.push({ code: "missing_shot", tier: "minor", shot: m, text: `Missing: ${m}.` }); continue; }
    // CRUCIAL = the guide's FIRST photo, or a view the notes put a flaw on
    // (Ethan, 2026-10-11). The per-photo Crucial tick is gone: he found himself
    // ticking nearly every required photo, and "every required view flags" would
    // have flagged three listings he passed for one missing side each (WSP PS5
    // Slim, OVL Dell WD15 lot, OVL Synology). His line instead: "as long as the
    // missing photo is not the first one, the serial number, or any applicable
    // settings pages then it is just points". The serial and the settings pages
    // keep their own rules above and below.
    const first = requiredShots.find(s => shotKind(s.label) === "view");
    const isFirst = !!first && first.label.toLowerCase() === m.toLowerCase();
    if (isFirst || flawViews.has(m.toLowerCase())) {
      missing.push({ code: "missing_shot", tier: "crucial", shot: m,
        text: `Missing: ${m} — ${isFirst ? "the first photo the guide asks for" : "the listing puts a flaw on this view"}.` });
      continue;
    }
    // "One missing plain view on its own" is free — listed anyway, so a flagged
    // row still asks for every shot the guide wants.
    missing.push({ code: "missing_shot", tier: freeUsed ? "view" : "view_free", shot: m, text: `Missing: ${m}.` });
    freeUsed = true;
  }
  // The serial. A screen device must show it somewhere — the settings page or a
  // closeup — or it is Core. Anything else missing one is −3, even under a
  // battery cover (Ethan changed his mind on the Xbox controller, 2026-10-10).
  const serialShot = sheet.shots.find(s => !s.cond && shotKind(s.label) === "serial");
  if (r.serial !== "shown") {
    if (screen) core.push(serialShot ? serialShot.label : "Serial Number (in settings or a closeup)");
    else if (serialShot) missing.push({ code: "missing_shot", tier: "serial", shot: serialShot.label, text: `Missing: ${serialShot.label}.` });
  }
  for (const m of core) missing.push({ code: "missing_shot", tier: "core", shot: m, text: `Missing: ${m}.` });

  // If Needed shots the listing CALLS FOR — an automatic flag (Ethan,
  // 2026-10-10). The model says which; the code checks the listing really says
  // the thing, so a model that imagines a flaw cannot demand a photo of it.
  const unitCos = l.unitCosmetic.length > 0;
  const screenFault = /\b(screen|lcd|display|pixel|lines?|burn|touch|backlight|spot|bleed)\b/i.test(l.functional || "");
  const included = !!l.included && !/^\(?not listed\)?$/i.test(l.included.trim());
  for (const m of [...new Set((r.needed_missing || []).map(x => x.trim()))]) {
    const shot = byLabel.get(m.toLowerCase());
    if (!shot || !shot.cond) continue;
    if (/^everything included/i.test(m) && !included) continue;
    if (/^cosmetic flaws/i.test(m) && !unitCos) continue;
    if (/^lcd flaws/i.test(m) && !screenFault) continue;
    missing.push({ code: "missing_shot", tier: "needed", shot: shot.label,
      // What the listing says comes with it, for the row (Ethan, OVL GTX 1660).
      ...(/^everything included/i.test(m) ? { included: l.included.trim() } : {}),
      text: /^everything included/i.test(m)
        // "the listing says everything Included" read badly (WSP Galaxy Tab A9).
        ? `Missing: ${shot.label} — the listing lists what comes with it, so it needs one photo of the item with all of it together (photos of the accessories on their own don't count).`
        : `Missing: ${shot.label} — the listing says ${shot.cond.charAt(0).toLowerCase() + shot.cond.slice(1).replace(/\.$/, "")}, so it needs this photo.` });
  }

  // Repeats: −4 each for now, an automatic flag once the trainer shows the
  // signal holds. The fix is a click on the Quick Fixes tab, not a chore for
  // the store (Ethan: "say approve deletion. Don't imply that the user should
  // delete it themselves").
  const repeats = realRepeats;
  const deletion = repeats.length ? { photos: repeats.map(p => p.n), of: repeats.map(p => p.repeats as number) } : null;
  if (repeats.length) {
    const ns = deletion!.photos;
    const wanted = missing.filter(f => f.tier !== "view_free").map(f => f.shot!).slice(0, ns.length);
    findings.push({ code: "repeat", photos: ns,
      text: ns.map((x, i) => `Photo ${x} is the same shot as photo ${deletion!.of[i]}`).join("; ")
        + `. Approve Deletion removes ${plural(ns, "it", "them")}`
        + (wanted.length ? ` — then take ${list(wanted)} instead.` : ".") });
  }

  // The main flaw — only DAMAGE about THIS unit (template wording and general
  // wear never qualify; AirPods Max "hinges have scuffs" was passed).
  const damage = /\b(crack|cracked|dent|dented|broken|break|missing|chip|chipped|bent|hole|burn|burned|stain|stained|shatter|shattered|peel|peeling|torn|tear|damage|damaged|dead pixel|spot)/i;
  if (r.main_flaw.shown === "no" && r.main_flaw.stated && r.main_flaw.source !== "none" && damage.test(r.main_flaw.stated)) {
    findings.push({ code: "flaw_not_shown", text: `The main flaw isn't shown: ${r.main_flaw.stated}.` });
  }

  // Order — a suggestion for the BIG moves only (box before the item, Everything
  // Included buried, a lead photo that does not show the item).
  const oScore = orderScore(r.photos, sheet);
  const isBox = (p: PhotoR) => p.shots.some(s => /^box/i.test(s.trim()));
  const isEI = (p: PhotoR) => p.shots.some(s => /^everything included/i.test(s.trim()));
  const isItem = (p: PhotoR) => !isBox(p) && p.shots.some(s => !/^(box|extra|everything included)/i.test(s.trim()));
  const byN = [...r.photos].sort((a, b) => a.n - b.n);
  const firstBox = byN.findIndex(isBox), firstItem = byN.findIndex(isItem), firstEI = byN.findIndex(isEI);
  const boxFirst = firstBox >= 0 && firstItem >= 0 && firstBox < firstItem;
  // Everything Included is the guide's photo 2 (Ethan, 2026-10-14, BAL Canon
  // EOS 2000D: "everything included is 3 when it should be 2").
  const eiLate = firstEI > 1;
  let order = r.suggested_order.filter((x, i, a) => x >= 1 && x <= n && a.indexOf(x) === i);
  let leadMoved = false;
  if (order.length === n) {
    // THE GUIDE'S FIRST PHOTO LEADS (Ethan, 2026-10-14, OVL iPhone 17 Pro: the
    // back first "should've been flagged since lead photo is different than
    // guide"). When a photo covers that shot, it goes first. Only when none does
    // does a lead photo that shows the item stay put (rule 4, 2026-09-25).
    const firstShot = sheet.shots.find(s => !s.cond)?.label.toLowerCase();
    const lead = firstShot ? [...r.photos].sort((a, b) => a.n - b.n).find(p => p.shots.some(s => s.toLowerCase() === firstShot)) : undefined;
    if (lead) { order = [lead.n, ...order.filter(x => x !== lead.n)]; leadMoved = lead.n !== 1; }
    else if (r.lead_ok) order = [1, ...order.filter(x => x !== 1)];
    // The spec screenshots keep the STORE'S order among themselves; only their
    // slots move (BAL 2025 MacBook Air, 10-14: "the original order of the specs
    // from photos 3-8 is already in good order").
    const info = new Set(r.photos.filter(p => p.shots.some(s => INFO_SHOT.test(s))).map(p => p.n));
    const mine = [...info].sort((a, b) => a - b);
    let k = 0;
    order = order.map(x => info.has(x) ? mine[k++] : x);
  }
  const changed = order.length === n && order.some((x, i) => x !== i + 1);
  // ANY real order change is offered — a passing listing too, as a Quick Fix
  // (Ethan, 2026-10-14, BAL: Takumar's photo 7, the Sony ZV-1, the Canon). It
  // was the big moves only; both looks must still ask for it (see index.ts).
  const reorder = changed
    ? { current: l.photos.map((_, i) => i + 1), suggested: order, score: Math.round(oScore * 100) / 100,
        why: [boxFirst && "box photos come before the item", eiLate && "Everything Included should be photo 2",
              !r.lead_ok && "the first photo does not show the item",
              leadMoved && r.lead_ok && "the guide's first photo should lead",
              !boxFirst && !eiLate && r.lead_ok && !leadMoved && "photos are out of the guide's order"].filter(Boolean) as string[] }
    : null;
  if (!r.lead_ok && !reorder) findings.push({ code: "lead", photo: 1, text: "Photo 1 doesn't show what the item is." });

  if (retake) {
    findings.unshift({ code: "retake", shots: missingRequired,
      text: `Retake following the guide — ${missingRequired.length} of ${requiredShots.length} required shots are missing: ${missingRequired.join(", ")}.` });
    // The retake line names the guide's shots; If Needed ones still flag on their own.
    findings.push(...missing.filter(f => f.tier === "needed"));
  } else {
    findings.push(...missing);
  }

  // A photo that Approve Deletion removes is not ALSO sent back for a retake —
  // its own problems go with it (OVL Evercade, 10-13 A/B: photos 4 and 6 were
  // both repeats to delete and "not on the stand, retake them").
  if (repeatSet.size) {
    for (let i = findings.length - 1; i >= 0; i--) {
      const f = findings[i];
      if (f.code === "repeat") continue;
      if (f.photo && repeatSet.has(f.photo)) { findings.splice(i, 1); continue; }
      if (f.photos) {
        const kept = f.photos.filter(x => !repeatSet.has(x));
        if (!kept.length) findings.splice(i, 1);
        else if (kept.length < f.photos.length) {
          // The sentence names the photos; rebuild just the photo list in it.
          f.text = f.text.replace(/^(Photos?) [\d, and]+? (was|were|is|are)\b/, () => `${plural(kept, "Photo", "Photos")} ${list(kept)} ${plural(kept, "was", "were")}`)
            .replace(/in photos? [\d, and]+? —/, () => `in ${plural(kept, "photo", "photos")} ${list(kept)} —`)
            .replace(/(Photos?) [\d, and]+? (aren't|isn't)/, () => `${plural(kept, "Photo", "Photos")} ${list(kept)} ${plural(kept, "isn't", "aren't")}`);
          f.photos = kept;
        }
      }
    }
  }
  const pic = pictureScore(findings, n, l.price);
  const verdict = retake ? "retake" : pic.score < PASS_BAR ? "fix" : (reorder || deletion) ? "reorder" : "pass";
  // A flagged listing is being reshot anyway, so it hears about ANY real order
  // problem, not only the big moves a passing one is offered (Ethan, 10-13: OVL
  // HP Stream's keyboard in photo 2, the Surface Book 3). Ethan's first bar
  // (09-25): under ~85% in sheet order, or the first two photos wrong. No
  // points — it rides along with the retake.
  if ((verdict === "fix" || verdict === "retake") && changed && (reorder || oScore < 0.85 || order[0] !== 1 || order[1] !== 2)) {
    findings.push({ code: "order", text: "The photos are out of the guide's order — use the guide's order when you retake." });
  }
  return { verdict, findings, reorder, deletion, orderScore: Math.round(oScore * 100) / 100,
           pictureScore: pic.score, costs: pic.costs };
}

// --- is a second look worth paying for? ----------------------------------------------
// ⚠️ ONLY WHEN THE FLAG IS CLOSE TO THE LINE (Ethan approved, 2026-10-11, to cut
// cost). The second look exists to stop one look's mistake flagging a listing.
// A flag that would survive losing any ONE of its findings is not one mistake —
// a second look would cost another full review and almost never change the
// verdict. So: a second look only when dropping a single model finding would
// let the listing pass (or, for a retake, drop it out of retake). A flag that
// rests on something MEASURED (not square, no photos) is never second-guessed.
// The trade: a clearly flagged listing may show a finding only one look saw.
const MEASURED = new Set(["not_square", "no_photos"]);
export function needsSecondLook(l: ListingR, sheet: SheetR, r: ReportR): boolean {
  const d = decide(l, sheet, r);
  if (d.verdict === "pass") return false;
  // A REPEAT ALWAYS GETS ITS SECOND LOOK: it offers a one-click deletion, and
  // agree() keeps only a repeat both looks name. One look called the sides of
  // two WSP Galaxy watches and a Watch6's screen-off vs everything-included
  // "the same shot" (2026-10-11) — Approve Deletion would have removed good photos.
  if (d.deletion) return true;
  // A suggested ORDER still needs both looks: approving it changes the listing in
  // Shopify, and one look's labels once moved the Synology's photos wrongly.
  // Rare, so cheap. A repeat-only Quick Fix (deletion) does not.
  if (d.verdict === "reorder") return !!d.reorder;
  if (d.findings.some(f => MEASURED.has(f.code))) return false;
  if (d.verdict === "retake") {
    // One fewer missing shot: still a retake means the count is not marginal.
    const fewer = { ...r, missing_shots: r.missing_shots.slice(1) };
    return decide(l, sheet, fewer).verdict !== "retake";
  }
  for (let i = 0; i < d.findings.length; i++) {
    const rest = d.findings.filter((_, j) => j !== i);
    if (pictureScore(rest, l.photos.length, l.price).score >= PASS_BAR) return true;
  }
  return false;
}

// --- the second look ---------------------------------------------------------------
// ⚠️ A FLAG HAS TO BE SEEN TWICE. Merged at the REPORT level so decide() runs
// once on facts both looks agree on. Leniency runs one way: anything that would
// PASS a listing is taken from either look.
export function agree<T extends ReportR>(a: T, b: T): T {
  const photos = a.photos.map(p => {
    const q = b.photos.find(x => x.n === p.n);
    const probs = q ? p.framing_problems.filter(x => q.framing_problems.includes(x)) : [];
    const off = !!q && p.framing === "off" && q.framing === "off" && probs.length > 0;
    return {
      ...p,
      shots: [...new Set([...p.shots, ...(q?.shots || [])])],
      repeats: q && p.repeats != null && p.repeats === q.repeats ? p.repeats : null,
      whole_item: p.whole_item && !!q?.whole_item,
      framing: off ? "off" as const : "close" as const,
      framing_problems: off ? probs : [],
      issues: p.issues.filter(it => it.severity === "major"
        && !!q?.issues.some(x => x.type === it.type && x.severity === "major")),
    };
  });
  const both = (x?: string[], y?: string[]) => {
    const s = new Set((y || []).map(m => m.trim().toLowerCase()));
    return (x || []).filter(m => s.has(m.trim().toLowerCase()));
  };
  const bothNo = a.main_flaw.shown === "no" && b.main_flaw.shown === "no";
  return {
    ...a,
    photos,
    missing_shots: both(a.missing_shots, b.missing_shots),
    needed_missing: both(a.needed_missing, b.needed_missing),
    flaw_views: both(a.flaw_views, b.flaw_views),
    all_units_shown: a.all_units_shown !== false || b.all_units_shown !== false,
    units_together: a.units_together !== false || b.units_together !== false,
    all_sides_shown: a.all_sides_shown === true || b.all_sides_shown === true,
    flat_package: a.flat_package === true || b.flat_package === true,
    main_flaw: bothNo ? a.main_flaw
      : { ...a.main_flaw, shown: a.main_flaw.shown === "no" ? b.main_flaw.shown : a.main_flaw.shown },
    serial: a.serial === "shown" || b.serial === "shown" ? "shown"
      : a.serial === "hidden_behind_cover" || b.serial === "hidden_behind_cover" ? "hidden_behind_cover" : "not_shown",
    lead_ok: a.lead_ok || b.lead_ok,
    setups: (a.setups || []).length > 1 && (b.setups || []).length > 1 ? a.setups : [(a.setups || []).flat()],
  };
}
