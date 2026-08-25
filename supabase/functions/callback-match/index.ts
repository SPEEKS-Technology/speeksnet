// ============================================================================
// callback-match — "somebody already has what that customer asked for".
//
//   ?sweep=1&secret=...            match every open row against every store
//   ?sweep=1&dryRun=1&secret=...   score it and report, write nothing
//   ?sweep=1&store=WSP&...         one holding store only
//
// DIRECTION, and it is the opposite of the obvious one: each store matches its
// OWN stock against EVERY store's open call backs. The green row and the alert
// go to the store that HAS the item, not the store that logged the customer.
// That store rings the customer and sells it from its own online store. The
// requesting store finds out through the existing attribution line on the row.
//
// WHY A CATEGORY GATE AT ALL. Scored on titles alone, "Playstation 5" matches
// the PS5 HD Camera and a DualSense controller. Shopify collections are the
// category system — product_type is blank on 98% of the catalogue — so the
// collection is the gate and the type keywords do the discriminating inside it.
//
// FIVE MEASURED FACTS THIS DEPENDS ON (see the `callback_types` seed migration):
//
//  1. LONGEST KEYWORD WINS, always. "Sony PlayStation" appears in 488 titles
//     including every PS2/3/4/5; "Microsoft Xbox" in 364 including 360/One/
//     Series X. Take the first or shortest match and a PS5 want is answered
//     with a PlayStation 2 game.
//  2. THE CATEGORY IS OFTEN WRONG. 459 in-stock items sit in `other` and NOTHING
//     else — an Apple Pencil, three Dell docks, three GoPros. A strict gate
//     misses all of them. But searching `other` for GENERIC words is worse than
//     missing them: "charger" there returns hearing-aid chargers. So `other` is
//     searched only for MULTI-WORD keywords, and such a match is flagged
//     found_via='other' so the panel can say where it came from.
//  3. CONDITION WORDS LEAD TITLES. new / broken / unlocked / factory / t-mobile
//     are the first token of a huge number of titles, so they are stopwords on
//     both sides or every row matches "New".
//  4. A BROKEN UNIT IS STOCK, NOT AN ANSWER. 22 of 40 in-stock iPhones are
//     titled "Broken". Sending someone to ring a customer about a cracked phone
//     is worse than staying quiet — UNLESS that is what they asked for, and
//     people do ask (the recycle buyers). So broken units are excluded by
//     default and become eligible, ranked FIRST, when the row asks for one.
//  5. A TYPE IS EITHER THE ANSWER OR JUST A SHELF, and the first dry run proved
//     why that has to be modelled. "Sony PlayStation 3" matches every PS3 game
//     we own, so "ps3 pain" came back with Tiger Woods PGA Tour 13 at 3.5 while
//     the word that mattered — "pain" — was never required. Types carry
//     needs_item_text for exactly this: a platform or a shape narrows the
//     search, and then the customer's own words must land on the title.
//     Related: a chosen type is a REQUIREMENT. Without that an iPhone 15 want
//     matched an iPhone 13 on the bare word "iphone". And a BRAND is a shelf
//     too — "Sony FX30" came back with a Sony Alpha A100 at 2.57 until every
//     brand-only type was marked the same way.
//
// The sweep is idempotent. It refreshes scores, retires matches whose unit sold,
// and never resurrects a pair a human marked `rejected`.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SECRET = "sp33ks-sync-k3y-2026-x9mq";
const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];

// How many candidates one call back may surface per store. A manager ringing a
// customer needs the best one, not a catalogue; three leaves room to pick.
const MAX_PER_STORE = 3;
// Below this a "match" is a coincidence. Tuned so a category+type hit clears it
// and a bare category hit does not.
const MIN_SCORE = 1.0;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status: s,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Realtime "ping" — the same broadcast-as-ping every other tool uses: say that
// this changed, and let the client re-run its own check through the function
// that owns the data. No row ever travels over realtime, so the RLS-locked
// tables stay shut to the anon client. Fired only when the SET actually moved,
// because a sweep that finds the same 21 matches is not news to anybody.
async function broadcastChange(): Promise<void> {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{
          topic: "speeks-notify",
          event: "changed",
          payload: { tool: "callbackMatch", store: null, ts: Date.now() },
        }],
      }),
    });
  } catch (_) { /* the write already succeeded; realtime is best-effort */ }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

// Words that lead our titles for reasons unrelated to what the thing IS.
// Measured: "New" is the first token of 97 video-game titles and 64 in `other`;
// "Broken" of 22 iPhones and 22 laptops. Carrier names lead most phone titles.
const NOISE = new Set([
  "new", "broken", "used", "like", "open", "box", "sealed", "read", "certified",
  "refurbished", "refurb", "tested", "working", "untested", "parts", "cracked",
  "bad", "issue", "issues", "lot", "various", "misc", "bundle", "for", "and",
  "the", "with", "only", "no", "not", "in", "of", "a", "an", "to", "or",
  "unlocked", "factory", "gsm", "carrier", "wifi", "gps", "cellular",
  "t-mobile", "tmobile", "verizon", "at&t", "att", "boost", "tracfone",
  "sprint", "cricket", "metro", "paymore", "qty",
]);

// What makes a unit unsellable as an answer to a want. Kept separate from NOISE
// because these are a DECISION, not just noise: they exclude the item unless the
// call back asked for exactly this.
// ⚠️ "bad <part>" IS HOW PAYMORE WRITES A FAULT, and this listed only two of them.
// A 2020 MacBook Air titled "... A2337 Bad LCD" was therefore scored as healthy
// stock and offered to a customer who asked for a working MacBook Air — the exact
// thing fact 4 exists to prevent. The part list is spelled out rather than using a
// bare \bbad\b: this regex REMOVES stock from the results, so a false positive
// hides a good unit silently, and "Bad Company" is a real game title.
// Measured when widened: 20 in-stock titles say "bad <part>", 19 of which already
// matched another word here, so this catches exactly the one that was slipping
// through and nothing else.
const BROKEN_ITEM = /\b(broken|cracked|bad (?:lcd|screen|glass|display|imei|esn|battery|port|board|camera|speaker|mic|touch|digitizer|housing|hinge|keyboard|trackpad|fan|charging)|no face id|for parts|parts only|as-?is|does ?n[o']t work|not working|dead|damaged|water damage)\b/i;

// THE SHELF NOW DECLARES ITS OWN GRADE, and where it does it beats the title.
// `ebay_catalog.condition` is read from the Condition row of the description spec
// table (see ebay-catalog) and is filled in on 94.9% of in-stock units — against
// a title regex that only fires when somebody happened to type the fault into the
// name. A short curated value, so a bare `bad` is safe here in a way it is not in
// a title: "Bad Company" is a game, "Bad" is not a grade anybody assigns.
const BROKEN_CONDITION = /\b(broken|for parts|parts only|dead|bad|damaged|cracked|does ?n[o']t work|not working|salvage|junk|scrap)\b/i;

// What "I want a broken one" looks like in a call back. Deliberately wider than
// BROKEN_ITEM: the customer says "for parts" or "to fix", not "bad IMEI".
const WANTS_BROKEN = /\b(broken|cracked|for parts|parts only|repair|fix|fixer|as-?is|recycle|damaged|dead|not working|does ?n[o']t work|salvage|junk|scrap)\b/i;

// A YEAR THE CUSTOMER NAMED IS A CONSTRAINT, NOT A HINT.
//
// "MacBook Air (2017-2019) with i7/8GB Ram" came back with a 2014, a 2020 and a
// 2026 alongside the 2017. The type gate was satisfied outright — `MacBook Air`
// is seeded needs_item_text:false, so ANY MacBook Air answered it — and nothing
// afterwards read the years at all. Four machines eleven years apart, offered as
// if they were the same answer, on a row that had said exactly which ones.
//
// PayMore titles lead with the model year ("2017 Apple MacBook Air 13.3\"…"), so
// this is cheap and reliable: take the years from the customer's words, take the
// year from the title, and drop the ones outside the range. A title with NO year
// is kept — we cannot disprove it, and silently dropping unlabelled stock is a
// worse failure than showing one extra row.
const YEAR_RE = /\b(19[89]\d|20[0-4]\d)\b/g;

// ...EXCEPT WHEN IT IS A BUDGET. "PS5 under 2000" would otherwise demand a title
// from the year 2000 and throw away every console in the district. Rare, and
// cheap to rule out: a number reached for by a price word is not a model year.
const PRICE_LEAD = /(?:\$|under|below|less than|up to|max|budget|around|about|~)\s*$/i;

function yearsWanted(text: string): { lo: number; hi: number } | null {
  const s = String(text || "");
  const ys: number[] = [];
  for (const m of s.matchAll(YEAR_RE)) {
    if (PRICE_LEAD.test(s.slice(0, m.index ?? 0))) continue;
    ys.push(Number(m[1]));
  }
  if (!ys.length) return null;
  return { lo: Math.min(...ys), hi: Math.max(...ys) };
}

// The FIRST year in a title, because that is where the model year sits. A later
// one is usually a spec or a bundled game.
function titleYear(title: string): number | null {
  const m = String(title || "").match(YEAR_RE);
  return m ? Number(m[0]) : null;
}

const norm = (s: unknown) =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9#/+.\- ]+/g, " ").replace(/\s+/g, " ").trim();

// Tokens worth matching on: a model number, a capacity, a distinctive word.
// A two-letter fragment or a noise word tells us nothing.
function tokens(s: string): string[] {
  return norm(s).split(" ").filter((t) =>
    t.length >= 3 && !NOISE.has(t) && !/^\d{1,2}$/.test(t));
}

// A token that could pin down a MODEL rather than a family: it has a digit, or
// it is long enough to be a real word. "iphone" is not distinctive inside the
// iPhone category; "15" and "pro" and "titanium" are what separate the units.
const distinctive = (t: string) => /\d/.test(t) || t.length >= 4;

// Words that describe the SHELF, not the thing on it. The first dry run matched
// "Enchanted Portals (Video Game)" against LEGO Pirates of the Caribbean on the
// strength of the words "video" and "game" — the customer's own category label,
// counted as if it identified a product. Stripped from the customer's text
// before we ask whether they named anything specific.
const SHELF = new Set([
  "video", "game", "games", "gaming", "console", "player", "system", "systems",
  "edition", "complete", "full", "digital", "disc", "cart", "cartridge", "copy",
  "phone", "cell", "tablet", "laptop", "computer", "camera", "lens", "charger",
  "cable", "controller", "headset", "monitor", "speaker", "watch", "card",
  "prefer", "prefers", "wants", "want", "looking", "please", "call", "back",
]);

// ---------------------------------------------------------------------------

type Item = {
  store_code: string; sku: string; title: string; price: number | null;
  quantity: number; collections: string[]; product_handle: string | null;
  online_published: boolean; product_id: string; variant_id: string;
  condition: string | null;
  _t: string;            // normalised title, computed once
  _broken: boolean;
};

type Cb = {
  id: string; store: string; item: string; customer_name: string;
  category_handle: string | null; type_id: number | null;
  any_model: boolean | null; status: string | null; archived_at: string | null;
};

type TypeDef = { keywords: string[]; name: string; needsItemText: boolean };

type Scored = {
  item: Item; score: number; reason: string; foundVia: string;
};

// What the customer said, minus the shelf words and minus anything the TYPE
// already accounts for. "ps3 pain" reduces to ["pain"]; without this the platform
// token "ps3" counted as if it identified the game.
//
// Lifted out of score() so the scorer and the constraint pass below read the SAME
// list. Two copies of this would be two definitions of "what the customer named",
// and they would drift.
function residualFor(cb: Cb, ty: TypeDef | null): string[] {
  const typeWords = new Set((ty?.keywords ?? []).flatMap((k) => k.split(" ")));
  return tokens(cb.item)
    .filter((t) => !SHELF.has(t) && !typeWords.has(t))
    .filter(distinctive);
}

/**
 * Score one item against one call back. Returns null when it is not a match at
 * all, which is the common case and must stay cheap.
 *
 * The shape of the decision:
 *   category gate   — the item must be IN the wanted collection, or in `other`
 *                     via a multi-word keyword (fact 2 in the header)
 *   type gate       — a type keyword must appear, longest one winning
 *   model gate      — unless the row says Any Model, something distinctive from
 *                     the customer's own words must appear too
 */
function score(cb: Cb, ty: TypeDef | null, it: Item, wantsBroken: boolean): Scored | null {
  // FACT 4 REVISED 2026-08-24, on the DM's call. A broken unit used to be dropped
  // here outright, on the reasoning that ringing a customer about a cracked phone
  // is worse than staying quiet. Two things changed that: the panel now SHOWS the
  // condition on every line, and "Not This" is back — so the floor can see what it
  // is and dismiss it permanently, which is a better answer than us deciding for
  // them. It is still never the first thing offered: the per-store sort below
  // pushes broken to the bottom, so with MAX_PER_STORE = 3 it surfaces mainly when
  // there is nothing sound to show instead.
  const inCategory = !!cb.category_handle && it.collections.includes(cb.category_handle);
  const inOther = it.collections.includes("other");
  if (!inCategory && !inOther) return null;

  // Fact 1: longest keyword wins. Sorting by length and taking the first hit is
  // what stops "Sony PlayStation" answering for "Sony PlayStation 5".
  let hit: string | null = null;
  for (const k of (ty?.keywords ?? [])) {
    if (it._t.includes(k)) { hit = k; break; }
  }

  // A CHOSEN TYPE IS A REQUIREMENT, not a hint. Without this an iPhone 15 want
  // matched an iPhone 13 and an iPhone 16 on the bare word "iphone", and an N64
  // want matched a Game Boy Pocket on "nintendo" + "console".
  if (ty && !hit) return null;

  // Fact 2: `other` is reachable only through a SPECIFIC keyword. A generic
  // single word there returns hearing-aid chargers for an Apple charger want.
  let foundVia = "category";
  if (!inCategory) {
    if (!hit || !hit.includes(" ")) return null;
    foundVia = "other";
  }

  const residual = residualFor(cb, ty);
  const matchedTokens = residual.filter((t) => it._t.includes(t));

  const anyModel = cb.any_model === true;

  // THE MODEL GATE.
  //
  // Satisfied outright when the type IS the model ("iPhone 15", "Nintendo 64
  // Console") or the row says any model will do. Otherwise — a shelf type, a
  // brand, or no type at all — the customer has to have named something, and
  // ALL of it has to land.
  //
  // "All of it" rather than "any of it" because one loose word is not a match:
  // "Enchanted Portals" hit Disney Princess Enchanted JOURNEY on the strength of
  // "enchanted" alone. Rambling rows get a floor of two instead, so a sentence
  // with an aside is not held to every word of it.
  // Before anything else about the model: a year they named rules out a year
  // they did not. This runs even when the type IS the answer, which is the whole
  // point — that is the path that let four MacBook Airs through.
  const wantYears = yearsWanted(cb.item || "");
  if (wantYears) {
    const ty2 = titleYear(it.title);
    if (ty2 !== null && (ty2 < wantYears.lo || ty2 > wantYears.hi)) return null;
  }

  const typeIsTheAnswer = !!hit && !ty?.needsItemText;
  if (!anyModel && !typeIsTheAnswer) {
    // Nothing specific said and the type is only a shelf: unmatchable by
    // design. This is precisely what the red Needs Detail tag is for.
    if (!residual.length) return null;
    const required = residual.length <= 3 ? residual.length : 2;
    if (matchedTokens.length < required) return null;
  }
  // No type at all: the customer's own words are the ONLY evidence there is.
  if (!ty && !matchedTokens.length) return null;

  let s = 0;
  const why: string[] = [];
  if (inCategory) { s += 1.0; } else { s += 0.5; why.push("filed under Other"); }
  if (hit) {
    // Longer keyword, more specific claim, more score.
    s += 1.0 + Math.min(hit.length, 24) / 24;
    why.push(`type "${hit}"`);
  }
  if (matchedTokens.length) {
    s += matchedTokens.length * 0.6;
    why.push(`words ${matchedTokens.map((t) => `"${t}"`).join(", ")}`);
  }
  if (anyModel && hit) { s += 0.4; why.push("any model"); }
  if (wantYears) {
    why.push(wantYears.lo === wantYears.hi
      ? `year ${wantYears.lo}` : `years ${wantYears.lo}-${wantYears.hi}`);
  }
  // The point is to sell it today, so a unit already live on the store beats one
  // that would need publishing first.
  if (it.online_published) s += 0.15;
  // Fact 4 again: if they asked for broken, broken is what they want first.
  if (wantsBroken && it._broken) { s += 0.8; why.push("broken, as asked"); }

  if (s < MIN_SCORE) return null;
  return { item: it, score: Math.round(s * 100) / 100, reason: why.join(" + "), foundVia };
}

// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  if (url.searchParams.get("secret") !== SECRET) return json({ ok: false, error: "unauthorized" }, 401);
  if (url.searchParams.get("sweep") !== "1") return json({ ok: false, error: "pass &sweep=1" }, 400);

  const dryRun = url.searchParams.get("dryRun") === "1";
  const only = (url.searchParams.get("store") || "").toUpperCase().trim();
  const holdingStores = only ? [only] : STORES;

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // --- the wants -----------------------------------------------------------
  // Archived rows stop matching, by decision. Completed rows too: the customer
  // has been served, so telling somebody else to ring them is noise.
  const { data: cbRows, error: cbErr } = await sb
    .from("customer_callbacks")
    .select("id, store, item, customer_name, category_handle, type_id, any_model, status, archived_at")
    .is("archived_at", null);
  if (cbErr) return json({ ok: false, error: cbErr.message }, 500);

  const cbs = (cbRows ?? []).filter((c: Cb) => (c.status || "open") !== "completed");

  // --- the type vocabulary -------------------------------------------------
  const { data: typeRows } = await sb
    .from("callback_types").select("id, keywords, name, collection_handle, needs_item_text").eq("active", true);
  const typeById = new Map<number, TypeDef>();
  for (const t of (typeRows ?? [])) {
    typeById.set(Number(t.id), {
      // Sorted longest-first ONCE, here, so the scoring loop can take the first
      // hit and be right. See fact 1.
      keywords: (t.keywords ?? []).map((k: string) => norm(k)).filter(Boolean)
        .sort((a: string, b: string) => b.length - a.length),
      name: t.name,
      needsItemText: t.needs_item_text === true,
    });
  }

  // --- the shelf -----------------------------------------------------------
  // Only what is in stock can be sold to anybody. PostgREST caps a page at
  // 1000, so this pages explicitly rather than silently truncating.
  const items: Item[] = [];
  for (const st of holdingStores) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from("ebay_catalog")
        .select("store_code, sku, title, price, quantity, collections, product_handle, online_published, product_id, variant_id, condition")
        .eq("store_code", st).gt("quantity", 0)
        // ORDER BY IS LOAD-BEARING. Without it Postgres may return page 1 and
        // page 2 in overlapping order, and OVL has 1,304 in-stock rows — two
        // pages. That put the same SKU in the batch twice and the upsert died
        // with "ON CONFLICT DO UPDATE command cannot affect row a second time".
        .order("sku", { ascending: true })
        .range(from, from + 999);
      if (error) return json({ ok: false, error: error.message }, 500);
      const page = data ?? [];
      for (const r of page) {
        items.push({
          ...r,
          collections: r.collections ?? [],
          _t: norm(r.title),
          // The graded value first, the title second. Either alone is a fault:
          // 5% of stock has no grade, and a grade of "Good" on a unit whose title
          // says "Bad LCD" means somebody graded the shell and not the screen.
          _broken: BROKEN_CONDITION.test(String(r.condition || ""))
                || BROKEN_ITEM.test(String(r.title || "")),
        } as Item);
      }
      if (page.length < 1000) break;
    }
  }

  // --- what a human already decided ---------------------------------------
  // One read, two different needs.
  //
  // `vetoed` is a permanent NO for that (row, item) pair. Loading it up front is
  // what stops the sweep re-offering something somebody already dismissed.
  //
  // `stateByKey` is the opposite problem, and it is the reason this read is no
  // longer filtered to rejected: the upsert below writes a `state` for EVERY row
  // in the batch, so with no knowledge of the current one it would demote a
  // CONFIRMED match back to `suggested` three times a day — a manager's "yes,
  // that's it" undone by the next sweep. A `sold` row whose unit is back in
  // stock deliberately does return to `suggested`: it is available again.
  const { data: decided } = await sb
    .from("callback_matches").select("callback_id, store_code, sku, state");
  const keyOf = (r: any) => `${r.callback_id}|${r.store_code}|${r.sku}`;
  const vetoed = new Set((decided ?? []).filter((r: any) => r.state === "rejected").map(keyOf));
  const stateByKey = new Map((decided ?? []).map((r: any) => [keyOf(r), r.state]));

  // --- match ---------------------------------------------------------------
  const byStore: Record<string, Item[]> = {};
  for (const it of items) (byStore[it.store_code] ||= []).push(it);

  const rows: any[] = [];
  const perCallback: any[] = [];
  let skippedNoCategory = 0;

  for (const cb of cbs) {
    if (!cb.category_handle) { skippedNoCategory += 1; continue; }
    const ty = cb.type_id ? (typeById.get(Number(cb.type_id)) ?? null) : null;
    const wantsBroken = WANTS_BROKEN.test(String(cb.item || ""));
    const found: Scored[] = [];

    // Scored per store first and capped LATER, because the constraint below needs
    // to see every candidate in the district before it can tell a product word
    // from an aside.
    const perStore: Record<string, Scored[]> = {};
    for (const st of holdingStores) {
      const hits: Scored[] = [];
      for (const it of (byStore[st] ?? [])) {
        if (vetoed.has(`${cb.id}|${st}|${it.sku}`)) continue;
        const sc = score(cb, ty, it, wantsBroken);
        if (sc) hits.push(sc);
      }
      perStore[st] = hits;
    }

    // ⚠️ A WORD THE CUSTOMER NAMED THAT OUR CATALOGUE ALSO USES IS A CONSTRAINT.
    //
    // "PS5 Slim" came back with three ordinary PS5s among the Slims. The type is
    // `Sony PlayStation 5 Console`, seeded needs_item_text:false, so the model gate
    // was satisfied outright and "slim" only ever ADDED score — the Slims sorted
    // first and the plain ones filled the remaining per-store slots. Which is fact
    // 5 working as written, and wrong: the customer named the variant.
    //
    // Requiring every named word always would break the opposite case. "iPhone 15
    // on the 13th" would demand a title containing "13th", and there is no such
    // iPhone — that row would go from three matches to none. The customer's aside
    // is not a product word.
    //
    // SO THE CATALOGUE DECIDES WHICH IT IS. A word that appears in at least one
    // candidate title is a word we use for products, and it becomes required;
    // a word that appears in none of them is an aside, and is ignored. Same shape
    // as the year rule above, and evidence-based for the same reason.
    //
    // Years are excluded: the range test already owns them, and requiring "2017"
    // literally would drop the 2018 machine that the range deliberately allows.
    const named = residualFor(cb, ty).filter((t) => !/^(19[89]\d|20[0-4]\d)$/.test(t));
    const pool = Object.values(perStore).flat();
    const required = named.filter((t) => pool.some((h) => h.item._t.includes(t)));

    for (const st of holdingStores) {
      const hits = perStore[st].filter((h) => required.every((t) => h.item._t.includes(t)));
      // BROKEN LAST, unless broken is what was asked for. This governs SELECTION,
      // not display: it decides which three survive MAX_PER_STORE, so a sound unit
      // is never dropped in favour of a broken one. Display order is the panel's
      // job — customer-callbacks returns matches by score — and the panel sorts
      // broken to the bottom of its own list for the same reason.
      hits.sort((a, b) =>
        (wantsBroken || a.item._broken === b.item._broken
          ? 0 : (a.item._broken ? 1 : -1))
        || b.score - a.score);
      found.push(...hits.slice(0, MAX_PER_STORE));
    }

    perCallback.push({
      id: cb.id, store: cb.store, item: cb.item,
      category: cb.category_handle,
      type: ty ? ty.name : null,
      typeNeedsItemText: ty ? ty.needsItemText : null,
      anyModel: cb.any_model === true,
      wantsBroken,
      matches: found.length,
      top: found.sort((a, b) => b.score - a.score).slice(0, 5).map((f) => ({
        store: f.item.store_code, sku: f.item.sku, title: f.item.title,
        price: f.item.price, score: f.score, why: f.reason, via: f.foundVia,
        live: f.item.online_published,
        condition: f.item.condition, broken: f.item._broken,
      })),
    });

    for (const f of found) {
      rows.push({
        callback_id: cb.id,
        store_code: f.item.store_code,
        sku: f.item.sku,
        product_id: f.item.product_id,
        variant_id: f.item.variant_id,
        title: f.item.title,
        price: f.item.price,
        product_handle: f.item.product_handle,
        online_published: f.item.online_published,
        // Copied onto the match, like title and price, so the panel can render a
        // line without joining the catalogue. It is what was true when this was
        // scored; the sweep refreshes it.
        condition: f.item.condition ?? null,
        score: f.score,
        match_reason: f.reason,
        found_via: f.foundVia,
        // Never demote a decision. See stateByKey above.
        state: stateByKey.get(`${cb.id}|${f.item.store_code}|${f.item.sku}`) === "confirmed"
          ? "confirmed" : "suggested",
        // found_at is DELIBERATELY absent. The column defaults to now() on
        // insert, and a column missing from an upsert payload is left alone on
        // conflict — so it keeps meaning "when we first spotted this", which is
        // what the panel shows. Sending it would reset the age three times a day
        // and no match would ever look older than the last sweep.
      });
    }
  }

  // Belt and braces after the paging fix above: one duplicate key anywhere in a
  // batch rejects the WHOLE batch, so the last thing before writing is to prove
  // the keys are unique rather than to assume it.
  const seenKey = new Set<string>();
  const deduped = rows.filter((r) => {
    const k = `${r.callback_id}|${r.store_code}|${r.sku}`;
    if (seenKey.has(k)) return false;
    seenKey.add(k);
    return true;
  });
  const duplicateKeys = rows.length - deduped.length;

  const summary = {
    callbacksConsidered: cbs.length,
    duplicateKeys,
    skippedNoCategory,
    itemsScanned: items.length,
    typesLoaded: typeById.size,
    matchesFound: deduped.length,
    callbacksWithAMatch: perCallback.filter((p) => p.matches > 0).length,
    vetoedPairs: vetoed.size,
  };

  if (dryRun) {
    return json({ ok: true, dryRun: true, summary, callbacks: perCallback });
  }

  // --- write ---------------------------------------------------------------
  // Upsert on (callback_id, store_code, sku): the sweep runs three times a day
  // and must refresh a score rather than pile up duplicates. The `state` in each
  // row was already resolved against stateByKey, so a confirmed match survives.
  let written = 0;
  for (let i = 0; i < deduped.length; i += 500) {
    const chunk = deduped.slice(i, i + 500);
    const { error } = await sb.from("callback_matches")
      .upsert(chunk, { onConflict: "callback_id,store_code,sku", ignoreDuplicates: false });
    if (error) return json({ ok: false, error: error.message, summary }, 500);
    written += chunk.length;
  }

  // --- what left the shelf -------------------------------------------------
  // A matched unit that sells has to stop being green. What HAPPENS to the row
  // depends on whether a human ever acted on it:
  //
  //   * a bare `suggested` row is deleted — it was never news, and keeping it
  //     would make the panel a graveyard;
  //   * a `confirmed` one becomes `sold`, because "we had it and it went" is the
  //     answer to "why is this not green any more" and a deleted row cannot
  //     give it. `rejected` is never touched: that veto has to outlive the unit.
  //
  // SCOPED TO THE STORES WE ACTUALLY SWEPT. With ?store=WSP the batch only ever
  // contains WSP items, so an unscoped retire reads every other store's matches
  // as vanished and clears the lot.
  let live = new Set(deduped.map((r) => `${r.callback_id}|${r.store_code}|${r.sku}`));
  let q = sb.from("callback_matches")
    .select("id, callback_id, store_code, sku, state").neq("state", "rejected");
  if (only) q = q.eq("store_code", only);
  const { data: stale } = await q;
  const gone = (stale ?? []).filter((m: any) =>
    !live.has(`${m.callback_id}|${m.store_code}|${m.sku}`));

  const toDelete = gone.filter((g: any) => g.state === "suggested").map((g: any) => g.id);
  const toSell = gone.filter((g: any) => g.state === "confirmed").map((g: any) => g.id);
  let retired = 0, markedSold = 0;
  if (toDelete.length) {
    const { error } = await sb.from("callback_matches").delete().in("id", toDelete);
    if (!error) retired = toDelete.length;
  }
  if (toSell.length) {
    const { error } = await sb.from("callback_matches")
      .update({ state: "sold" }).in("id", toSell);
    if (!error) markedSold = toSell.length;
  }

  // A pair we had never seen before is the only thing worth waking a client for.
  const newMatches = deduped.filter((r) =>
    !stateByKey.has(`${r.callback_id}|${r.store_code}|${r.sku}`)).length;
  if (newMatches || retired || markedSold) await broadcastChange();

  return json({ ok: true, summary: { ...summary, written, newMatches, retired, markedSold } });
});
