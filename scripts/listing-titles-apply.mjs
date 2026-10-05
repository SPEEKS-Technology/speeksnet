// Apply corrections that came out of the review-queue feedback — through the
// SAME approve path the Listing Titles panel uses, so the description's copies of
// the title and every field that states the fact move with it, the change lands
// in listing_title_moves, and the approver is whoever's PIN is typed here.
//
//   node scripts/listing-titles-apply.mjs
//
// A row with a `title` is reopened (it was denied), PREVIEWED, and approved on
// "y" — title and `fields` together. A row with only `fields` is a listing whose
// title is already right: its named fields are previewed and corrected alone
// (action "fields"), the title untouched. Anything but "y" changes nothing.
//
// 2026-09-30, round 1: three titles applied (Might and Magic, Meraki, Gogeta).
// Round 2: their spec fields, which the title-only approve could not place —
// applied and verified live 19:33Z. Kept below as DONE for the record; a done
// row that runs again finds every field already right and changes nothing.
// Round 3: the Canon AE-1 (BAL MO04-1670A-E10). Ethan: everything in photo 3
// is included — "the person did not realize that the camera doesn't normally
// come with the 50mm lens. we also don't mention the other stuff it comes with."
// The cap in photo 3 is a LENS cap (Canon 1984 Olympics), which is why
// Included said "Camera Body Cap" while Not Included said "No Camera Body Cap".
import readline from "node:readline/promises";

const FN = "https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/listing-titles";

const ROWS = [
  { store: "BAL", productId: "gid://shopify/Product/10389080211747", sku: "MO04-1670A-E10",
    why: "an SLR, not a point & shoot (photo 1: Canon FD 50mm f/1.8 mounted); photo 3 kit all included",
    title: "Canon AE-1 Program 35mm SLR Film Camera FD 50mm f/1.8 + Zoom Lens, Flash & Bag",
    fields: [{ field: "Type", value: "35mm SLR Film Camera" },
             { field: "What's Included",
               value: "Canon FD 50mm f/1.8 Lens, Zoom Lens, Vivitar Flash, Camera Bag, Canon FD Lens Manuals, Lens Cap, Shoulder/Neck Strap" }] },
];
const DONE = [
  { store: "LEE", productId: "gid://shopify/Product/15187884146861", sku: "MO01-5716E",
    why: "box: Book One, Apple II 64K required — the II was the platform",
    fields: [{ field: "Platform", value: "Apple II" },
             { field: "Game Name", value: "Might and Magic Book One: Secret of the Inner Sanctum" },
             { field: "Model", value: "Might and Magic Book One" }] },
  { store: "LEE", productId: "gid://shopify/Product/10321549263021", sku: "MO01-5218B-R4R1",
    why: "label photo 6: Gigabit Ethernet Switch; only the 4 SFP+ uplinks are 10G",
    fields: [{ field: "Type", value: "Gigabit PoE+ Ethernet Switch" },
             { field: "What's Included", value: "Cisco Meraki MS250-48LP-HW 48-Port Gigabit PoE+ Switch Unclaimed" }] },
  { store: "LEE", productId: "gid://shopify/Product/8708565532845", sku: "MO01-5285A-F1R1",
    why: "PSA label photo 3: #BT11-012 SSB Gogeta, Technique Unchained",
    fields: [{ field: "Model", value: "SSB Gogeta, Technique Unchained" },
             { field: "MPN", value: "BT11-012" },
             { field: "Type", value: "Trading Card" }] },
];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pin = (await rl.question("Your SPEEKSNET PIN: ")).trim();
const post = async (payload) => {
  const r = await fetch(FN, { method: "POST",
    headers: { "Content-Type": "application/json", "x-user-pin": pin },
    body: JSON.stringify(payload) });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok && body.ok !== false, status: r.status, body };
};
const show = (p) => {
  console.log(`    will update: ${p.descriptionCopies || 0} title cop${p.descriptionCopies === 1 ? "y" : "ies"} in the description,`
    + ` ${p.specRows || 0} spot(s) in the description, ${p.metafields || 0} metafield(s)`);
  for (const e of p.alsoUpdated || []) console.log(`      + ${e.field}: "${e.was}" -> "${e.now}"   (${(e.where || []).join(", ")})`);
  for (const s of p.stillSays || []) console.log(`      ! still says the old thing: ${s.field} "${s.value}" (${(s.where || []).join(", ")})`);
  for (const f of p.fieldsNotFound || []) console.log(`      ? no such field on this listing: ${f}`);
};

for (const row of ROWS) {
  const key = { store: row.store, productId: row.productId };
  const withTitle = !!row.title;
  console.log(`\n=== ${row.store} ${row.sku}\n    why: ${row.why}`
    + (withTitle ? `\n    new title: ${row.title} (${row.title.length} chars)` : ""));
  if (withTitle) {
    const re = await post({ action: "reopen", ...key });
    if (!re.ok) { console.log(`    could not reopen (${re.status}): ${JSON.stringify(re.body)}`); continue; }
  }
  const pv = await post(withTitle
    ? { action: "preview", ...key, title: row.title, fields: row.fields }
    : { action: "fields-preview", ...key, fields: row.fields });
  if (!pv.ok) {
    console.log(`    preview refused (${pv.status}): ${JSON.stringify(pv.body)}`);
    if (withTitle) await post({ action: "deny", ...key, reason: "reopened by listing-titles-apply; preview refused" });
    continue;
  }
  show(pv.body);
  const yes = (await rl.question("    Apply? (y/N) ")).trim().toLowerCase() === "y";
  if (!yes) {
    if (withTitle) await post({ action: "deny", ...key, reason: "skipped in listing-titles-apply" });
    console.log("    skipped — nothing changed");
    continue;
  }
  const ap = await post(withTitle
    ? { action: "approve", ...key, title: row.title, fields: row.fields }
    : { action: "fields", ...key, fields: row.fields });
  console.log(ap.ok ? `    ✓ done: ${ap.body.title}` : `    ✗ failed (${ap.status}): ${JSON.stringify(ap.body)}`);
  if (ap.body?.metafieldsLeft) console.log(`    ! ${ap.body.metafieldsLeft} metafield(s) not saved: ${ap.body.metafieldsWhy}`);
}
rl.close();
