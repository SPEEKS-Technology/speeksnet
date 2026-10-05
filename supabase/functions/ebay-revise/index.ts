// ============================================================================
// ebay-revise — carry a change we already made in Shopify onto the live eBay
// listing, and nothing else.
//
//   GET  ?store=OVL&sku=X&secret=...            READ ONLY: what eBay holds now
//        &find=Reviever                         where a string sits in the HTML
//        &raw=1                                 the whole description back
//   POST ?secret=...  { store, sku,
//                       expectTitle,            eBay's title must equal this
//                       title?,                 the new title
//                       html?:  [{was, now}],   text swaps inside the description
//                       specifics?: [{name, was, now}] }
//   POST ?secret=...  { via:"inventory", store, sku, expectTitle, title?, specifics? }
//                                               title + specifics on a listing
//                                               PayMore's tool created (see below)
//   POST ?secret=...  { action:"end", store, sku, expectTitle, reason }
//                                               END the listing (item gone)
//
// WHY THIS EXISTS. PayMore's replacement for Marketplace Connect lists our
// Shopify items on eBay but does not carry later Shopify edits across, so a
// title we fix in Listing Health stays wrong on eBay forever (2026-09-23: the
// Sansui "Reviever" that was corrected in Shopify that morning was still live on
// eBay that afternoon, alongside four more). Ethan: "I don't want to do anything
// that can touch their system." This touches only the eBay listing, through the
// same Trading API ReviseItem a person's Seller Hub edit goes through.
//
// ⚠️ THE SKU IS NOT PROOF IT IS THE SAME ITEM. At BAL on 2026-09-23 three SKUs
// were a different game on eBay than in Shopify (eBay GoldenEye 007, Shopify
// Cruis'n USA — a SKU reused while the old eBay listing stayed up). Renaming by
// SKU alone would have retitled a live GoldenEye listing to Cruis'n USA. So the
// write refuses unless eBay's CURRENT title equals `expectTitle` — the title
// Shopify had before our change, from listing_title_moves.before_title. Any
// other title means somebody or something else has been at it, and a person
// decides.
//
// EVERY EDIT IS A SUBSTITUTION, NEVER A REPLACEMENT. The eBay description is
// PayMore's template wrapped around the Shopify HTML, so sending Shopify's HTML
// as the description would wipe the template. Instead each `was` must be found
// in eBay's own description and is swapped in place; a `was` that is not there
// refuses the whole call. Same for item specifics: ReviseItem replaces the
// entire specifics set, so we send back every existing one untouched and change
// only the named value, and only if it currently reads `was`.
//
// ⚠️ TESTED 2026-09-23: REVISE DOES NOT WORK ON PAYMORE'S LISTINGS; END DOES.
// Their replacement tool lists through the Inventory API, and eBay answers a
// Trading ReviseItem on those with 21919474 "Inventory-based listing management
// is not currently supported by this tool" (OVL Sansui, KS01-7184A-R4R1 — the
// revision was refused whole, nothing changed). EndItem on the same kind of
// listing succeeded (BAL Willow). The inventory_item and offer ARE readable with
// our token (ebay-peek?sku=), and writable in principle — but they are PayMore's
// records, createOrReplaceInventoryItem replaces the whole item, and their tool
// re-pushes its own copy. Ethan ruled out touching their system, so revise stays
// Trading-only and is useful only for listings that tool did not create.
//
// ONE ReviseItem CALL, SO IT IS ALL OR NOTHING. eBay applies a revision
// atomically — an error on the specifics means the title did not change either.
// There is deliberately no fallback to the Inventory API: listings that API owns
// belong to whichever tool created them, and editing those records is editing
// PayMore's system. If eBay refuses, we stop and report.
// ============================================================================
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const HOSTS = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};
const stripControl = (s: string) =>
  Array.from(s).filter(ch => ch.charCodeAt(0) >= 32).join("");
let EBAY_APPS: Record<string, any> = {};
{
  const raw = (Deno.env.get("EBAY_APPS") || "").trim();
  for (const text of [raw, stripControl(raw)]) {
    if (!text) break;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") { EBAY_APPS = parsed; break; }
    } catch { /* try stripped */ }
  }
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status, headers: { "Content-Type": "application/json" },
  });

async function sb(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`supabase ${path}: ${res.status} ${await res.text()}`);
  return res;
}

// Same refresh as ebay-peek: the stored access token if it has a minute left,
// otherwise mint one from the long-lived refresh token and write it back.
async function accessToken(row: any): Promise<string> {
  const expiresAt = row.access_token_expires_at ? Date.parse(row.access_token_expires_at) : 0;
  if (row.access_token && expiresAt - Date.now() > 60000) return row.access_token;
  const creds = EBAY_APPS[row.store_code];
  const res = await fetch(`${HOSTS[row.environment as "production" | "sandbox"]}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: row.refresh_token,
      scope: row.scopes || "",
    }),
  });
  const tok = JSON.parse(await res.text());
  if (!tok.access_token) throw new Error("token refresh failed");
  await sb(`ebay_stores?store_code=eq.${encodeURIComponent(row.store_code)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      access_token: tok.access_token,
      access_token_expires_at: new Date(Date.now() + (tok.expires_in ?? 7200) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
  return tok.access_token;
}

const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";
function opsAuthed(url: URL): boolean {
  const given = url.searchParams.get("secret") || "";
  if (given.length !== OPS_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) diff |= given.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  return diff === 0;
}

// XML text in and out. The response escapes the description's HTML once
// (&lt;div&gt;), and a title with "&" arrives as &amp; — the same double
// encoding that makes ebay_live disagree with Shopify on every "Auto & Manual
// Lens", which is not a real difference.
const xmlEsc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const xmlUnesc = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

async function trading(row: any, token: string, call: string, body: string) {
  const host = row.environment === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
  const r = await fetch(`${host}/ws/api.dll`, {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": call,
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
      "X-EBAY-API-IAF-TOKEN": token,
      "Content-Type": "text/xml",
    },
    body: `<?xml version="1.0" encoding="utf-8"?>
<${call}Request xmlns="urn:ebay:apis:eBLBaseComponents">${body}</${call}Request>`,
  });
  const text = await r.text();
  const ack = (text.match(/<Ack>([^<]+)<\/Ack>/) || [])[1] || "unknown";
  const errors = [...text.matchAll(/<Errors>([\s\S]*?)<\/Errors>/g)].map(m => ({
    code: (m[1].match(/<ErrorCode>([^<]*)</) || [])[1] || null,
    severity: (m[1].match(/<SeverityCode>([^<]*)</) || [])[1] || null,
    message: xmlUnesc((m[1].match(/<LongMessage>([^<]*)</) || [])[1] || ""),
  }));
  return { ack, errors, text };
}

// Everything the guards and the report need, read by GetItem — which, unlike
// the Inventory API, sees a listing whichever tool created it.
async function readItem(row: any, token: string, itemId: string) {
  const r = await trading(row, token, "GetItem",
    `<ItemID>${xmlEsc(itemId)}</ItemID><DetailLevel>ReturnAll</DetailLevel>` +
    `<IncludeItemSpecifics>true</IncludeItemSpecifics>`);
  if (r.ack === "Failure") return { ok: false as const, errors: r.errors };
  const item = (r.text.match(/<Item>([\s\S]*)<\/Item>/) || [])[1] || "";
  const one = (tag: string, src = item) =>
    xmlUnesc((src.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1] || "");
  const specBlock = (item.match(/<ItemSpecifics>([\s\S]*?)<\/ItemSpecifics>/) || [])[1] || "";
  const specifics = [...specBlock.matchAll(/<NameValueList>([\s\S]*?)<\/NameValueList>/g)].map(m => ({
    name: one("Name", m[1]),
    values: [...m[1].matchAll(/<Value>([\s\S]*?)<\/Value>/g)].map(v => xmlUnesc(v[1])),
  }));
  return {
    ok: true as const,
    itemId,
    title: one("Title"),
    sku: one("SKU"),
    listingType: one("ListingType"),
    status: one("ListingStatus"),
    quantity: Number(one("Quantity") || 0),
    sold: Number((item.match(/<QuantitySold>(\d+)<\/QuantitySold>/) || [])[1] || 0),
    startTime: one("StartTime"),
    categoryId: one("CategoryID", (item.match(/<PrimaryCategory>([\s\S]*?)<\/PrimaryCategory>/) || [])[1] || ""),
    epid: one("EPID") || null,
    description: one("Description"),
    specifics,
    warnings: r.errors,
  };
}

const count = (hay: string, needle: string) =>
  needle ? hay.split(needle).length - 1 : 0;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!opsAuthed(url)) return json({ error: "unauthorised" }, 401);

  let input: any = {};
  if (req.method === "POST") {
    try { input = await req.json(); } catch { return json({ error: "body is not JSON" }, 400); }
  }
  const store = String(input.store || url.searchParams.get("store") || "").toUpperCase().trim();
  const sku = String(input.sku || url.searchParams.get("sku") || "").trim();
  if (!store || !sku) return json({ error: "pass store and sku" }, 400);

  // The SKU → item id step goes through ebay_live, the GetMyeBaySelling sweep,
  // because that is the only record that sees every live listing on the
  // account regardless of which tool created it.
  const live = (await (await sb(
    `ebay_live?store_code=eq.${encodeURIComponent(store)}&sku=eq.${encodeURIComponent(sku)}&select=item_id,title`)).json());
  if (live.length !== 1) {
    return json({ error: `expected one live eBay listing for ${store} ${sku}, found ${live.length}` }, 404);
  }
  const itemId = String(live[0].item_id);

  const row = (await (await sb(
    `ebay_stores?store_code=eq.${encodeURIComponent(store)}&select=*`)).json())[0];
  if (!row) return json({ error: `no ebay_stores row for ${store}` }, 404);
  const token = await accessToken(row);

  const cur = await readItem(row, token, itemId);
  if (!cur.ok) return json({ store, sku, itemId, error: "GetItem failed", errors: cur.errors }, 502);

  // --- GET: report, change nothing ------------------------------------------
  if (req.method !== "POST") {
    const find = url.searchParams.get("find") || "";
    const d = cur.description;
    const hits: string[] = [];
    for (let i = d.indexOf(find); find && i >= 0 && hits.length < 10; i = d.indexOf(find, i + find.length)) {
      hits.push(d.slice(Math.max(0, i - 120), i + find.length + 120));
    }
    return json({
      store, sku, itemId,
      title: cur.title, ebaySku: cur.sku, listingType: cur.listingType, status: cur.status,
      quantity: cur.quantity, sold: cur.sold, startTime: cur.startTime,
      categoryId: cur.categoryId, epid: cur.epid,
      specifics: cur.specifics,
      descriptionLength: cur.description.length,
      find: find ? { needle: find, count: count(d, find), context: hits } : undefined,
      description: url.searchParams.get("raw") === "1" ? cur.description : undefined,
    });
  }

  // --- POST: the guarded write ----------------------------------------------
  const refuse = (why: string, extra: Record<string, unknown> = {}) =>
    json({ store, sku, itemId, changed: false, refused: why, ebayTitle: cur.title, ...extra }, 409);

  if (cur.sku !== sku) return refuse(`eBay's listing carries SKU "${cur.sku}", not "${sku}"`);
  if (cur.status && cur.status !== "Active") return refuse(`listing is ${cur.status}, not Active`);

  // --- via "inventory": title + item specifics on an Inventory-API listing ---
  //
  // What Ethan's hand test proved (2026-09-23, OVL Sansui): a title and an item
  // specific edited on eBay DO flow back into PayMore's tool; a description
  // edit saves on eBay but never reaches it. So this path carries only title and
  // specifics, and it edits the inventory_item record the listing is published
  // from — the same record the tool writes. His Seller Hub edit changed the live
  // listing but left that record saying "Reviever", which is a revert waiting
  // for the tool's next publish; editing the record fixes both at once.
  //
  // ⚠️ createOrReplaceInventoryItem REPLACES THE WHOLE RECORD. So: read it,
  // change only product.title and the named aspect values, send every other
  // field back exactly as read. Omitting a field erases it.
  //
  // ⚠️ THE RECORD CARRIES QUANTITY. A sale between our read and our write would
  // be undone by sending back the old count, so the record is read a second
  // time immediately before the write and the call refuses if anything moved.
  //
  // The guard is the RECORD's title (it is what the tool last published), and
  // the live title may already be the new one if a person fixed it by hand.
  if (input.via === "inventory") {
    const host = HOSTS[row.environment as "production" | "sandbox"];
    const path = `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
    const hdrs = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Language": "en-US",
      "Accept-Language": "en-US",
    };
    const readRec = async () => {
      const r = await fetch(`${host}${path}`, { headers: hdrs });
      const t = await r.text();
      return { status: r.status, body: t ? JSON.parse(t) : null };
    };
    const rec = await readRec();
    if (rec.status !== 200) {
      return refuse(`no inventory record for this SKU (HTTP ${rec.status}) — not an Inventory-API listing`, { ebay: rec.body });
    }
    const expectRec = String(input.expectTitle ?? "");
    const recTitle = String(rec.body?.product?.title ?? "");
    if (!expectRec) return refuse("expectTitle is required — it is what proves this is the same item");
    if (recTitle !== expectRec) {
      return refuse("the inventory record's title is not the title Shopify had before our change — update it by hand", { recordTitle: recTitle });
    }
    const newTitle = input.title != null ? String(input.title).trim() : null;
    if (newTitle !== null) {
      if (!newTitle) return refuse("new title is empty");
      if (newTitle.length > 80) return refuse(`new title is ${newTitle.length} characters; eBay allows 80`);
    }
    if (cur.title !== expectRec && cur.title !== newTitle) {
      return refuse("the live eBay title is neither the old nor the new title — somebody else has edited it", { liveTitle: cur.title });
    }

    // Everything the GET returns except what the path already names.
    const body: any = JSON.parse(JSON.stringify(rec.body));
    delete body.sku;
    delete body.groupIds;
    delete body.inventoryItemGroupKeys;
    const plan: Record<string, unknown> = {};
    if (newTitle !== null && newTitle !== recTitle) {
      body.product.title = newTitle;
      plan.title = { was: recTitle, now: newTitle };
    }
    const changes: unknown[] = [];
    for (const c of (Array.isArray(input.specifics) ? input.specifics : [])) {
      const name = String(c?.name ?? ""), was = String(c?.was ?? ""), now = String(c?.now ?? "");
      const aspects = body.product.aspects || {};
      const key = Object.keys(aspects).find(k => k.toLowerCase() === name.toLowerCase());
      if (!key) return refuse(`the inventory record has no item specific named ${JSON.stringify(name)}`);
      const i = (aspects[key] || []).indexOf(was);
      if (i < 0) return refuse(`item specific ${key} reads ${JSON.stringify(aspects[key])}, not ${JSON.stringify(was)}`);
      aspects[key][i] = now;
      changes.push({ name: key, was, now });
    }
    if (changes.length) plan.specifics = changes;
    if (Array.isArray(input.html) && input.html.length) {
      plan.htmlSkipped = "description edits do not reach PayMore's tool — not sent";
    }
    if (!plan.title && !plan.specifics) {
      return json({ store, sku, itemId, changed: false, note: "record already matches", plan });
    }

    const again = await readRec();
    if (JSON.stringify(again.body?.availability) !== JSON.stringify(rec.body?.availability)) {
      return refuse("quantity changed while we were editing — try again", {
        before: rec.body?.availability, now: again.body?.availability,
      });
    }

    const w = await fetch(`${host}${path}`, { method: "PUT", headers: hdrs, body: JSON.stringify(body) });
    const wt = await w.text();
    if (w.status >= 300) {
      return json({ store, sku, itemId, changed: false, plan, ebayRefused: wt ? JSON.parse(wt) : w.status }, 502);
    }
    const recAfter = await readRec();
    const liveAfter = await readItem(row, token, itemId);
    return json({
      store, sku, itemId, changed: true, via: "inventory", plan,
      warnings: wt ? JSON.parse(wt) : null,
      recordNow: { title: recAfter.body?.product?.title, aspects: recAfter.body?.product?.aspects,
                   availability: recAfter.body?.availability },
      liveNow: liveAfter.ok ? { title: liveAfter.title, specifics: liveAfter.specifics } : null,
    });
  }

  const expect = String(input.expectTitle ?? "");
  if (!expect) return refuse("expectTitle is required — it is what proves this is the same item");
  if (cur.title !== expect) {
    return refuse("eBay's title is not the title Shopify had before our change, so this may be a different item or a hand edit — update it by hand");
  }

  // --- action "end": take down a listing for an item we no longer have ------
  //
  // Added for BAL Willow (2026-09-23): sold ON eBay Sept 21 (#MO04-3396), then a
  // NEW listing for the same game went up Sept 22 and sat live at qty 1 — the
  // shared SKU MO04-1909B1-CB1R1 still has stock on other products, which is
  // the likeliest reason something relisted it. The same title guard applies,
  // because with shared SKUs "end the listing for this SKU" is ambiguous.
  //
  // EndItem, not withdrawOffer: this listing was not created through the
  // Inventory API, so there is no offer of ours to withdraw — and ending a
  // listing is a seller action on the eBay listing, not an edit to whatever
  // tool created it. `reason` is required so the log says why.
  if (input.action === "end") {
    const reason = String(input.reason ?? "").trim();
    if (!reason) return refuse("reason is required to end a listing");
    const r = await trading(row, token, "EndItem",
      `<ItemID>${xmlEsc(itemId)}</ItemID><EndingReason>NotAvailable</EndingReason>`);
    if (r.ack === "Failure") {
      return json({ store, sku, itemId, ended: false, ebayRefused: r.errors }, 502);
    }
    const after = await readItem(row, token, itemId);
    return json({
      store, sku, itemId, title: cur.title, ended: true, reason, ack: r.ack,
      warnings: r.errors, statusNow: after.ok ? after.status : null,
    });
  }

  const parts: string[] = [];
  const plan: Record<string, unknown> = {};

  if (input.title != null) {
    const t = String(input.title).trim();
    if (!t) return refuse("new title is empty");
    if (t.length > 80) return refuse(`new title is ${t.length} characters; eBay allows 80`);
    if (t !== cur.title) { parts.push(`<Title>${xmlEsc(t)}</Title>`); plan.title = { was: cur.title, now: t }; }
  }

  if (Array.isArray(input.html) && input.html.length) {
    let d = cur.description;
    const swaps: unknown[] = [];
    for (const s of input.html) {
      const was = String(s?.was ?? ""), now = String(s?.now ?? "");
      const n = count(d, was);
      if (!was || n === 0) return refuse(`description does not contain ${JSON.stringify(was)}`);
      d = d.split(was).join(now);
      swaps.push({ was, now, replaced: n });
    }
    // CDATA cannot carry its own terminator; split it across two sections.
    const safe = d.split("]]>").join("]]]]><![CDATA[>");
    parts.push(`<Description><![CDATA[${safe}]]></Description>`);
    plan.html = swaps;
  }

  if (Array.isArray(input.specifics) && input.specifics.length) {
    const next = cur.specifics.map(s => ({ name: s.name, values: [...s.values] }));
    const changes: unknown[] = [];
    for (const c of input.specifics) {
      const name = String(c?.name ?? ""), was = String(c?.was ?? ""), now = String(c?.now ?? "");
      const hit = next.find(s => s.name.toLowerCase() === name.toLowerCase());
      if (!hit) return refuse(`eBay has no item specific named ${JSON.stringify(name)}`);
      const i = hit.values.indexOf(was);
      if (i < 0) return refuse(`item specific ${name} reads ${JSON.stringify(hit.values)}, not ${JSON.stringify(was)}`);
      hit.values[i] = now;
      changes.push({ name: hit.name, was, now });
    }
    // The whole set, because ReviseItem replaces it: leaving one out deletes it.
    parts.push(`<ItemSpecifics>${next.map(s =>
      `<NameValueList><Name>${xmlEsc(s.name)}</Name>${s.values.map(v => `<Value>${xmlEsc(v)}</Value>`).join("")}</NameValueList>`
    ).join("")}</ItemSpecifics>`);
    plan.specifics = changes;
  }

  if (!parts.length) return json({ store, sku, itemId, changed: false, note: "nothing to change" });

  const r = await trading(row, token, "ReviseItem",
    `<Item><ItemID>${xmlEsc(itemId)}</ItemID>${parts.join("")}</Item>`);
  if (r.ack === "Failure") {
    return json({ store, sku, itemId, changed: false, plan, ebayRefused: r.errors }, 502);
  }

  // Read it back rather than trusting the Ack: the listing as eBay now holds it.
  const after = await readItem(row, token, itemId);
  return json({
    store, sku, itemId, changed: true, ack: r.ack, plan,
    warnings: r.errors,
    after: after.ok ? {
      title: after.title,
      specifics: after.specifics.filter(s =>
        (plan.specifics as any[] | undefined)?.some(c => c.name === s.name)),
      html: (plan.html as any[] | undefined)?.map((s: any) => ({
        was: s.was, stillThere: count(after.description, s.was), now: s.now, nowThere: count(after.description, s.now),
      })),
    } : { error: "read-back failed", errors: after.errors },
  });
});
