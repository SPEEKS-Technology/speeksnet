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
const BROKEN_ITEM = /\b(broken|cracked|bad imei|bad battery|no face id|for parts|parts only|as-?is|does ?n[o']t work|not working|dead|damaged|water damage)\b/i;

// What "I want a broken one" looks like in a call back. Deliberately wider than
// BROKEN_ITEM: the customer says "for parts" or "to fix", not "bad IMEI".
const WANTS_BROKEN = /\b(broken|cracked|for parts|parts only|repair|fix|fixer|as-?is|recycle|damaged|dead|not working|does ?n[o']t work|salvage|junk|scrap)\b/i;

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
  // Fact 4: a broken unit is not an answer unless it is the answer.
  if (it._broken && !wantsBroken) return null;

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

  // What the customer said, minus the shelf words and minus anything the TYPE
  // already accounts for. "ps3 pain" reduces to ["pain"]; without this the
  // platform token "ps3" counted as if it identified the game.
  const typeWords = new Set((ty?.keywords ?? []).flatMap((k) => k.split(" ")));
  const residual = tokens(cb.item)
    .filter((t) => !SHELF.has(t) && !typeWords.has(t))
    .filter(distinctive);
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
        .select("store_code, sku, title, price, quantity, collections, product_handle, online_published, product_id, variant_id")
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
          _broken: BROKEN_ITEM.test(String(r.title || "")),
        } as Item);
      }
      if (page.length < 1000) break;
    }
  }

  // --- pairs a human already rejected -------------------------------------
  // Permanent for that (row, item) pair, by decision. Loading them up front is
  // what stops the sweep re-offering something somebody already dismissed.
  const { data: rejected } = await sb
    .from("callback_matches").select("callback_id, store_code, sku").eq("state", "rejected");
  const vetoed = new Set((rejected ?? []).map((r: any) => `${r.callback_id}|${r.store_code}|${r.sku}`));

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

    for (const st of holdingStores) {
      const hits: Scored[] = [];
      for (const it of (byStore[st] ?? [])) {
        if (vetoed.has(`${cb.id}|${st}|${it.sku}`)) continue;
        const sc = score(cb, ty, it, wantsBroken);
        if (sc) hits.push(sc);
      }
      hits.sort((a, b) => b.score - a.score);
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
        score: f.score,
        match_reason: f.reason,
        found_via: f.foundVia,
        state: "suggested",
        found_at: new Date().toISOString(),
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
  // and must refresh a score rather than pile up duplicates. `state` is NOT
  // overwritten for a row a human already confirmed — see the do-nothing guard.
  let written = 0;
  for (let i = 0; i < deduped.length; i += 500) {
    const chunk = deduped.slice(i, i + 500);
    const { error } = await sb.from("callback_matches")
      .upsert(chunk, { onConflict: "callback_id,store_code,sku", ignoreDuplicates: false });
    if (error) return json({ ok: false, error: error.message, summary }, 500);
    written += chunk.length;
  }

  // --- retire what sold ----------------------------------------------------
  // A matched unit that sells has to stop being green, and the row should say so
  // rather than the flag just vanishing.
  const live = new Set(deduped.map((r) => `${r.callback_id}|${r.store_code}|${r.sku}`));
  const { data: stale } = await sb
    .from("callback_matches").select("id, callback_id, store_code, sku, title").neq("state", "rejected");
  const gone = (stale ?? []).filter((m: any) =>
    !live.has(`${m.callback_id}|${m.store_code}|${m.sku}`));
  let retired = 0;
  if (gone.length) {
    const { error } = await sb.from("callback_matches")
      .delete().in("id", gone.map((g: any) => g.id));
    if (!error) retired = gone.length;
  }

  return json({ ok: true, summary: { ...summary, written, retired } });
});
