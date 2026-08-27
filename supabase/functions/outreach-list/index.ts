// ============================================================================
// outreach-list — one row per BUYER (not per order) for the refunded-buyer
// outreach, with the message pre-filled.
//
//   ?secret=<ops>[&format=csv]
//
// READ-ONLY. Builds a list for a human to send. Nothing is sent from here, and
// nothing is written anywhere.
//
// ONE ROW PER ORDER (user's call, 2026-08-26). An earlier version deduped to one
// message per buyer to avoid asking the same person for money three times, but
// per-order is the right shape for eBay: the contact link is tied to an ITEM and
// the message thread hangs off that transaction, so a single message covering
// four items would arrive in one item's thread and read as being about that item
// alone. Five buyers have more than one affected order; their rows carry
// `buyer_order_count` so a manager can see it and space the sends out.
//
// THE MESSAGE QUOTES THE SALE PRICE (user's call, 2026-08-26), because that is
// the number the buyer recognises from their own purchase. An earlier version
// quoted `ebay_refund_total`, which is the SELLER side of the same refund — it
// is net of the marketplace fee eBay credited back to us, so it named $139.67
// on a $149.99 sale and would have read as a mistake to every recipient.
// `our_loss` carries the seller-side figure for our own reporting; the two are
// summed separately so neither can be quoted as the other.
//
// THE GREETING IS THE EBAY USERNAME, not the shipping name. On eBay that is who
// the buyer is, and it retires the whole business-name/freight-forwarder mess
// the real names carried ("Hi 512", "Hi SDQ-27705").
//
// NO LISTING TITLE REACHES THE BUYER. `shortItem` reduces the title to a name a
// person would say — "Dell Precision 5520", not "Broken Dell Precision 5520
// 15.6\" i7-6820HQ 32GB RAM 512GB SSD Quadro M1200 READ". Opening a request for
// money with the word "Broken" is the specific thing being avoided.
//
// ⚠️ ONLY BUYERS WHO ACTUALLY RECEIVED SOMETHING ARE INCLUDED. Asking someone to
// send money back for an item they never got is the single worst thing this
// outreach could do, so "did it ship?" is answered from two sources, in order:
//
//   1. Shopify's fulfilment status. Shopify is where the stores ship from, so a
//      FULFILLED order with tracking is proof a label was bought.
//   2. eBay's shipment record — but ONLY when Shopify says no, and only a real
//      tracking NUMBER counts.
//
// Step 2 exists because Shopify's answer is not final. Cancelling an order
// rewrites its status, not its history: BAL 13-15066-46687 reads UNFULFILLED and
// cancelled on BOTH Shopify copies, while eBay holds USPS tracking stamped
// 9:43am — two and a half hours BEFORE either copy was cancelled. That buyer has
// the iPad and a full refund, and a Shopify-only rule silently excluded them.
//
// ⚠️ eBay's own orderFulfillmentStatus is still NOT used, and must not be: it
// reads FULFILLED on orders that were only marked shipped, with no parcel behind
// them. The tracking number is the evidence; the status flag is not.
//
// Neither source outranks the STORE. EXCLUDE_EBAY_ORDERS below holds orders a
// manager physically caught on the shelf after the label was printed — both
// systems call those shipped, and both are wrong.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";

const SHOP_BY_STORE: Record<string, string> = {
  OVL: "paymore-overland-park.myshopify.com",
  LEE: "paymore-lees-summit.myshopify.com",
  WSP: "paymore-westport.myshopify.com",
  MPL: "paymore-maplewood.myshopify.com",
  BAL: "paymore-ballwin.myshopify.com",
};

// Compact identity for the excluded/unresolved reports.
const pick = (r: any) => ({
  store: r.store_code,
  ebay_order_id: r.ebay_order_id,
  buyer: r.body?.buyer?.username ?? null,
  item: (r.body?.lineItems || []).map((li: any) => li?.title).filter(Boolean).join(" + ") || null,
  refunded: Number(r.ebay_refund_total) || 0,
});
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";

const STORES: Record<string, { label: string; manager: string; email: string; phone: string }> = {
  OVL: { label: "Overland Park", manager: "Nick",   email: "KS01@paymore.com", phone: "913-336-0620" },
  LEE: { label: "Lee's Summit",  manager: "Jurell", email: "MO01@paymore.com", phone: "816-608-2298" },
  WSP: { label: "Westport",      manager: "Eli",    email: "MO02@paymore.com", phone: "816-479-2767" },
  MPL: { label: "Maplewood",     manager: "Joseph", email: "MO03@paymore.com", phone: "314-499-8722" },
  BAL: { label: "Ballwin",       manager: "Joseph", email: "MO04@paymore.com", phone: "636-484-8788" },
};

// Orders NOT to contact anyone about, with the reason recorded so this is a
// decision on the record rather than a silent gap.
// ⚠️ THIS MAP IS NO LONGER THE SOURCE OF TRUTH — the `refund_recovered` table is,
// because the loss exports need the same answer and a constant living in one
// function cannot give it to them. Three OVL orders sat here while every
// accounting export still counted them, overstating the damage by $2,227.59.
// Kept as the historical record and merged with the table at runtime, so an
// order in either place is honoured. Add new ones to the TABLE.
const EXCLUDE_EBAY_ORDERS: Record<string, string> = {
  // Caught before they shipped and already dealt with by the store (2026-08-26).
  // Shopify shows these FULFILLED with tracking because labels were bought, but
  // the parcels never went out — which is exactly why fulfilment status alone
  // cannot decide this and the store's own knowledge overrides it.
  "18-15060-18719": "OVL caught before shipping — handled",
  "19-15060-99384": "OVL caught before shipping — handled",
  "23-15053-19861": "OVL caught before shipping — handled",
};

// Orders a manager has already messaged the buyer about. Kept here so a re-pull
// of the list never asks anyone to send the same message twice, and so progress
// survives a browser that has lost its local state.
//
// OVL, LEE and MPL are complete as of 2026-08-26, each reconciled line by line
// against the order numbers on that store's own Google Sheet — so these are
// orders a buyer really was written to, not orders that merely got a click.
// Three orders were deliberately skipped, one per store, and stay unpinned.
//
// Add a store the same way: take its sheet's order-number column, keep the IDs
// this function actually emits for that store, and paste them in. An ID with no
// row here is a note of ours, not a message that went out — don't pin it.
const ALREADY_SENT = new Set<string>([
  // OVL — 93 sent, confirmed against the store's own sheet.
  "10-15047-01220", "09-15053-06871", "11-15035-78681",
  "25-15017-36712", "16-15027-00098", "15-15045-40250",
  "02-15068-35239", "18-15049-87602", "02-15055-77610",
  "26-15047-33756", "21-15029-07123", "08-15053-43875",
  "23-15025-63290", "15-15058-30824", "27-15020-44801",
  "26-15025-27557", "21-15025-52221", "09-15064-57772",
  "12-15046-42056", "19-15047-69013", "18-15048-78967",
  "27-15033-32512", "24-15056-64696", "27-15009-78623",
  "22-15044-70779", "18-15050-09238", "16-15030-02329",
  "07-15043-22932", "24-15027-65126", "23-15035-63471",
  "02-15078-67469", "23-15040-16048", "08-15049-05569",
  "02-15078-67727", "12-15072-03384", "04-15061-26562",
  "27-15044-02506", "21-15043-34376", "19-15034-69169",
  "08-15067-18973", "14-15045-07030", "26-15025-29534",
  "04-15061-17226", "13-15033-39914", "22-15018-86868",
  "18-15035-21790", "26-15034-64763", "09-15056-77710",
  "15-15041-42029", "11-15054-71501", "07-15065-53324",
  "18-15050-27717", "15-15035-95073", "24-15050-91325",
  "06-15074-39058", "21-15035-74244", "13-15035-21562",
  "09-15057-25783", "09-15055-86123", "14-15048-35645",
  "16-15053-28583", "04-15048-21163", "23-15049-18244",
  "13-15050-48420", "17-15024-90767", "18-15026-78899",
  "06-15074-79605", "09-15051-84121", "19-15030-27208",
  "15-15044-01962", "20-15032-42692", "12-15052-13334",
  "17-15028-86919", "22-15019-01279", "11-15057-22609",
  "13-15045-25089", "09-15056-45499", "05-15049-06371",
  "07-15051-34137", "24-15029-35651", "01-15080-79099",
  "03-15062-90123", "25-15031-69448", "08-15065-60536",
  "10-15054-87494", "18-15025-97473", "10-15037-46355",
  "08-15047-33509", "03-15083-89016", "26-15018-13936",
  "09-15067-69276", "04-15069-27769", "05-15069-52683",
  // LEE — 80 sent, confirmed against the store's own sheet.
  "08-15041-22272", "27-15037-40979", "27-15036-41653",
  "17-15042-09383", "01-15077-63753", "11-15052-06342",
  "17-15045-61468", "20-15040-64805", "07-15073-81070",
  "05-15072-58456", "03-15072-27328", "27-15032-49785",
  "15-15056-75116", "06-15066-05311", "17-15051-54320",
  "11-15046-20970", "06-15074-41241", "11-15065-60366",
  "11-15057-12901", "07-15068-03669", "12-15065-66667",
  "06-15066-85077", "03-15081-19098", "13-15043-47879",
  "07-15067-98226", "26-15020-55486", "21-15046-80939",
  "20-15029-15510", "12-15050-14853", "13-15062-59725",
  "19-15022-18832", "04-15063-74862", "06-15073-10250",
  "16-15038-40331", "14-15031-05798", "21-15043-75035",
  "23-15029-58348", "20-15041-58890", "18-15040-05184",
  "11-15060-11558", "16-15027-64806", "25-15011-42740",
  "10-15055-89614", "26-15024-73143", "16-15038-95041",
  "15-15029-03085", "10-15068-88311", "22-15046-27227",
  "19-15047-30715", "24-15057-44040", "14-15045-49235",
  "03-15078-48892", "09-15054-91390", "06-15063-37011",
  "08-15041-17761", "06-15045-61654", "21-15017-97726",
  "19-15051-06190", "11-15035-99637", "25-15011-29164",
  "20-15020-41104", "03-15066-21023", "24-15028-19669",
  "04-15077-47253", "26-15038-22899", "24-15057-13139",
  "15-15056-37660", "14-15061-80591", "16-15056-34667",
  "15-15061-45580", "27-15043-90857", "03-15061-96987",
  "17-15030-48123", "21-15025-13486", "03-15084-28116",
  "04-15057-37878", "13-15033-07786", "20-15051-87347",
  "09-15061-97278", "10-15071-41337",
  // MPL — 18 sent, confirmed against the store's own sheet.
  "06-15074-80333", "23-15044-02481", "17-15059-14963",
  "27-15036-23385", "05-15069-64872", "24-15050-05797",
  "06-15066-88178", "05-15080-62723", "02-15088-65295",
  "20-15040-27009", "16-15054-80872", "17-15056-53014",
  "27-15029-47416", "18-15045-17484", "09-15073-11379",
  "25-15040-35554", "11-15069-26192", "15-15058-65492",
]);

// ---------------------------------------------------------------------------
// shortItem — an eBay listing title reduced to what a person would call the
// thing. "Broken Dell Precision 5520 15.6" i7-6820HQ 32GB RAM 512GB SSD Quadro
// M1200 READ" becomes "Dell Precision 5520".
//
// Two problems at once: the titles are spec sheets, and many of them lead with
// a condition word. Neither belongs in a message asking a customer to return
// money. Verified against all 216 titles in this set — every one resolves to a
// name, so the generic fallback below is a safety net rather than a routine
// path.
// ---------------------------------------------------------------------------

// Condition and channel words sellers put in FRONT of the product name.
const LEAD_NOISE = new RegExp(
  "^(?:" + [
    "broken", "for parts", "parts only", "parts\\/repair", "faulty", "cracked",
    "as[- ]is", "untested", "used", "pre[- ]owned", "preowned", "open box",
    "refurbished", "renewed", "sealed", "brand new", "new",
    "genuine", "oem", "original", "authentic",
    "factory unlocked", "unlocked", "carrier unlocked",
    "wifi only", "wi-fi only", "wifi \\+ cellular", "cellular",
    "t-mobile", "verizon", "at&t", "sprint",
    "lot of \\d+x?", "lot of", "lot",
    "(?:19|20)\\d{2}",              // a model year: "2024 Apple MacBook Pro"
  ].join("|") + ")\\b[\\s,:-]*",
  "i",
);

// What the thing IS — used when the model number sits so early in the title
// that nothing readable survives the cut.
const CATEGORY = new RegExp(
  "^(monitor|camera|laptop|desktop|drive|ssd|hdd|ram|memory|keyboard|mouse"
  + "|headset|headphones|earbuds|console|controller|router|switch|motherboard"
  + "|printer|supply|tablet|phone|smartphone|watch|smartwatch|speaker|lens"
  + "|projector|tv|webcam|microphone|dock|scanner|amplifier|receiver|card)$",
  "i",
);

const COLOR = new RegExp(
  "^(black|white|silver|gray|grey|blue|pink|gold|green|red|purple|titanium"
  + "|graphite|matte|midnight|starlight|obsidian|aquamarine|beige)$",
  "i",
);

// The first token that stops being a product name and starts being a spec sheet.
function isSpecToken(tok: string): boolean {
  const t = tok.replace(/[),.]+$/, "");
  if (!t) return false;
  if (/^\(/.test(tok)) return true;                        // "(Nintendo Switch, 2023)"
  if (/^[-–—]$/.test(tok)) return false;                   // "Link - Ocarina" is a name
  if (/^[^A-Za-z0-9([]/.test(tok)) return true;            // "!6" — a typo in a title
  if (/^\d+(\.\d+)?["”]$/.test(t)) return true;            // 15.6"
  if (/^\d+(\.\d+)?(gb|tb|mb|ghz|mhz|hz|mah|mp|mm|w|k|c)$/i.test(t)) return true;
  if (/^\d+(st|nd|rd|th)$/i.test(t)) return false;         // "9th Gen" is identity
  if (/^(i[3579]|ryzen|celeron|pentium|xeon|snapdragon)[-\d]/i.test(t)) return true;
  // Apple-style chips are whole tokens ("M2", "A15"). Matching them as a PREFIX
  // ate "A35F" in "Canon A35F 35MM Film Camera" and left a bare brand behind.
  if (/^(a|m)\d{1,2}$/i.test(t)) return true;
  if (/^(ram|ssd|hdd|nvme|emmc|gpu|cpu|vram|ddr\d?|sata|pcie)$/i.test(t)) return true;
  if (/^(read|readme|dead|damaged|defective|repair)$/i.test(t)) return true;
  if (/^(19|20)\d{2}$/.test(t)) return true;               // a trailing year
  if (/^[A-Z0-9][A-Z0-9\/-]{5,}$/.test(t) && /\d/.test(t) && /[A-Z]/.test(t)) return true;
  return false;
}

// "Intel Core" and "Asus GeForce" name a family, not a product.
const NEEDS_ONE_MORE = /^(core|ryzen|geforce|radeon|arc)$/i;

function tidy(tokens: string[], truncated: boolean): string {
  let out = tokens.filter(Boolean);
  // "Canon EF-S EF-S 55-250mm" — sellers repeat themselves.
  out = out.filter((t, i) => i === 0 || t.toLowerCase() !== out[i - 1].toLowerCase());
  // Only a cut mid-phrase can leave a dangling connector or possessive.
  if (truncated) {
    while (out.length > 2 && /^(the|a|an|and|of|for|with|\+|&|\w+'s)$/i.test(out[out.length - 1])) {
      out.pop();
    }
  }
  return out.join(" ").replace(/[\s,:;\-+/]+$/, "").trim();
}

const wordCount = (s: string) => s.split(" ").filter(Boolean).length;

// Brand + what the thing is, read off the END of the title.
function brandPlusCategory(toks: string[], base: string | null): string {
  const brand = base || toks[0];
  if (!brand) return "";
  // Searched on the RAW tokens: "SSD" and "RAM" are spec tokens, so filtering
  // those out first is exactly what hid the category on every storage listing.
  const catAt = toks.map((t) => CATEGORY.test(t.replace(/[),.]+$/, ""))).lastIndexOf(true);
  if (catAt < 1) return "";
  const before = toks[catAt - 1] || "";
  // One qualifying word, but only a plain one — "USB-A HDD" is not a name.
  const keep = /^[A-Za-z]{3,}$/.test(before) && !COLOR.test(before) && !CATEGORY.test(before)
    ? before
    : "";
  return tidy([brand, keep, toks[catAt].replace(/[),.]+$/, "")], false);
}

function shortItem(title: string): string | null {
  let s = String(title || "").replace(/\s+/g, " ").trim();
  if (!s) return null;

  // Peel leading noise repeatedly: "New Factory Unlocked Samsung ..." is three
  // layers deep before the brand appears.
  for (let i = 0; i < 6; i++) {
    const next = s.replace(LEAD_NOISE, "");
    if (next === s) break;
    s = next.trim();
  }

  const toks = s.split(" ").filter(Boolean);
  const out: string[] = [];
  let truncated = false;
  let stoppedAtParen = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (isSpecToken(t)) {
      if (out.length && NEEDS_ONE_MORE.test(out[out.length - 1])) out.push(t);
      truncated = true;
      stoppedAtParen = /^\(/.test(t);
      break;
    }
    if (out.length >= 3 && COLOR.test(t.replace(/[),.]+$/, ""))) { truncated = true; break; }
    out.push(t);
    if (out.length >= 6) { truncated = i < toks.length - 1; break; }
  }

  let short = tidy(out, truncated);

  // A game's whole name can be one word — "Castlevania (Nintendo NES, 1987)" —
  // and only the parenthetical tells us that is a name and not a bare brand.
  if (wordCount(short) === 1 && stoppedAtParen && short.length >= 4) return short;

  if (wordCount(short) < 2) {
    const alt = brandPlusCategory(toks, null);
    if (wordCount(alt) >= 2) short = alt;
  } else if (wordCount(short) <= 2 && !/\d/.test(short)) {
    // "SK Hynix", "LITE-ON Technology" — two words, still only a maker.
    const alt = brandPlusCategory(toks, short);
    if (wordCount(alt) > wordCount(short)) short = alt;
  }

  return short.length >= 3 && wordCount(short) >= 2 ? short : null;
}


const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });

function authed(url: URL) {
  const g = url.searchParams.get("secret") || "";
  if (g.length !== OPS_SECRET.length) return false;
  let d = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) d |= g.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  return d === 0;
}

// --- the only door to eBay, and it only opens outward -----------------------
// Same discipline as ebay-refund-reprobe. The refund endpoint is a SIBLING of
// the path below (POST .../order/{id}/issue_refund), so the URL is checked
// against an anchored pattern before anything is sent — no extra path segment
// can ride along — and the method is hard-coded to GET as a second, independent
// guard. This function must never be able to move money.
const SHIPMENT_URL_RE =
  /^https:\/\/api(?:\.sandbox)?\.ebay\.com\/sell\/fulfillment\/v1\/order\/[^/]+\/shipping_fulfillment(?:\/[^/]+)?$/;

// EBAY_APPS arrives as a hand-pasted JSON secret and has carried literal line
// breaks before now, so it is parsed defensively rather than trusted.
let EBAY_APPS: Record<string, any> = {};
{
  const raw = (Deno.env.get("EBAY_APPS") || "").trim();
  for (const attempt of [raw, raw.replace(/[\r\n\t]/g, "")]) {
    if (!attempt) continue;
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === "object") { EBAY_APPS = parsed; break; }
    } catch { /* try the next form */ }
  }
}

const EBAY_HOSTS: Record<string, string> = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};

// One token per store per run, minted on demand and never written back.
const tokenCache: Record<string, Promise<string>> = {};
function ebayToken(store: string): Promise<string> {
  return tokenCache[store] ||= (async () => {
    const creds = EBAY_APPS[store];
    if (!creds) throw new Error(`no EBAY_APPS entry for ${store}`);
    const rows = await sbGet(
      `ebay_stores?select=store_code,refresh_token,scopes,environment`
      + `&store_code=eq.${encodeURIComponent(store)}&limit=1`);
    const row = rows?.[0];
    if (!row) throw new Error(`no ebay_stores row for ${store}`);
    const host = EBAY_HOSTS[row.environment as string] || EBAY_HOSTS.production;
    const res = await fetch(`${host}/identity/v1/oauth2/token`, {
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
    const b = await res.json().catch(() => null);
    if (!res.ok || !b?.access_token) {
      throw new Error(`token ${res.status}: ${JSON.stringify(b).slice(0, 160)}`);
    }
    return b.access_token as string;
  })();
}

// Does eBay hold a real tracking number for this order? A shipment eBay
// recorded with no number behind it is a status flag somebody set, not evidence
// that a parcel exists — so only a number counts.
//
// Called ONLY for orders Shopify already called unshipped (1 of 220 on the run
// that found this), so it costs one eBay round trip, not two hundred. On any
// failure it returns no tracking and says why: an unknown must read as an
// unknown, never as proof that nothing shipped.
async function ebayTrackingFor(r: any): Promise<{ tracking: any[]; note: string }> {
  const hrefs: string[] = r?.body?.fulfillmentHrefs || [];
  if (!hrefs.length) return { tracking: [], note: "eBay holds no shipment record either" };

  let token: string;
  try { token = await ebayToken(String(r.store_code)); }
  catch (e) {
    return { tracking: [], note: `⚠️ could not ask eBay (${String(e).slice(0, 120)}) — treated as unshipped` };
  }

  const tracking: any[] = [];
  const problems: string[] = [];
  for (const href of hrefs) {
    if (!SHIPMENT_URL_RE.test(href)) {
      problems.push(`refused: not a read-only eBay shipment URL -> ${href}`);
      continue;
    }
    const res = await fetch(href, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const b = await res.json().catch(() => null);
    if (!res.ok) { problems.push(`eBay ${res.status} on ${href.slice(-24)}`); continue; }
    if (b?.shipmentTrackingNumber) {
      tracking.push({
        number: b.shipmentTrackingNumber,
        carrier: b.shippingCarrierCode || null,
        shipped_date: b.shippedDate || null,
      });
    }
  }
  const note = tracking.length
    ? `eBay holds tracking for ${tracking.length} shipment(s)`
    : problems.length
    ? `⚠️ eBay lookup incomplete: ${problems.join("; ").slice(0, 200)}`
    : `eBay recorded ${hrefs.length} shipment(s) but with NO tracking number`;
  return { tracking, note };
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n: number) => "$" + r2(n).toFixed(2);

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${path}: ${r.status}`);
  return await r.json();
}

// ⚠️ PostgREST caps a response at 1000 rows and says nothing about it. This bit
// the list once already: refund_reprobe crossed 1000 rows on the second probe
// run of 2026-08-26 and the unpaged read silently returned 156 refunded orders
// instead of 220 — a short list that looked entirely plausible. Anything reading
// refund_reprobe must page.
async function sbAll(path: string) {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Range: `${from}-${from + 999}`,
        "Range-Unit": "items",
      },
    });
    if (!r.ok) throw new Error(`supabase ${path}: ${r.status} ${await r.text()}`);
    const page = await r.json();
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

// The user's own wording, 2026-08-26, kept VERBATIM apart from the merge fields
// and the singular/plural swaps a multi-order buyer forces. Do not "improve" it.
function buildMessage(store: string, greeting: string, item: string | null, amount: number) {
  const s = STORES[store] || { label: store, manager: "the store manager", email: "", phone: "" };
  // No listing title survives into the message. A full eBay title is a spec
  // sheet, and half of these open with "Broken" or "For Parts" — a poor opening
  // line when the next paragraph asks the buyer for money back.
  const what = item ? `your recent purchase of the ${item}` : `your recent purchase`;

  return [
    `Hi ${greeting},`,
    ``,
    `This is ${s.manager}, the store manager of PayMore ${s.label}. I'm reaching out personally regarding ${what}.`,
    ``,
    `Unfortunately, a software issue on our end caused your order to be refunded. As a result, ${money(amount)} was refunded back to you even though your order had already been successfully completed and shipped or delivered.`,
    ``,
    `If you're happy with your purchase and would like to keep the item, we would really appreciate it if you could return the funds that were refunded in error. We can send over a simple invoice to make that easy.`,
    ``,
    `If you'd prefer not to keep the item, just let us know and we'll send a prepaid return shipping label at no cost to you.`,
    ``,
    `I'm sorry for putting you in this situation. We're a small, locally run store, and are having several completed orders refunded all at once, causing a real financial impact on us. Any help getting this corrected would mean a lot.`,
    ``,
    `Feel free to reply directly to this message, or give us a call at ${s.phone} and ask for ${s.manager} if you have any questions or concerns. You can also reach us at ${s.email}. Just let us know whether you'd like to keep the item and return the refund, or send it back with the prepaid label, and we'll take care of everything from there.`,
    ``,
    `Thank you so much for your understanding.`,
    ``,
    s.manager,
    `Store Manager, PayMore ${s.label}`,
  ].join("\n");
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);

  const rows = await sbAll(
    `refund_reprobe?select=run_at,store_code,order_name,ebay_order_id,ebay_refund_total,`
    + `ebay_order_total,body&order=ebay_order_id.asc,run_at.desc`);
  const newest: Record<string, any> = {};
  for (const r of rows) if (!newest[r.ebay_order_id]) newest[r.ebay_order_id] = r;
  const refunded = Object.values(newest).filter((r: any) => Number(r.ebay_refund_total) > 0);

  // --- did it actually ship? Shopify answers first, eBay breaks the tie ------
  const tokRows = await sbGet(`shopify_stores?select=shop,store_code,access_token`);
  const shipped: Record<string, any> = {};
  const notShipped: any[] = [];
  const unresolved: any[] = [];
  // Orders Shopify called unshipped that eBay proved otherwise. Reported
  // separately because each one is a buyer this list used to skip.
  const recoveredByEbay: any[] = [];

  // Merge the table over the constant above. A read failure must not silently
  // start chasing buyers whose parcels never left the shelf, so it throws
  // rather than falling back to the constant alone.
  const recoveredRows = await sbAll("refund_recovered?select=ebay_order_id,reason");
  const excludeNow: Record<string, string> = { ...EXCLUDE_EBAY_ORDERS };
  for (const r of recoveredRows) excludeNow[String(r.ebay_order_id)] = r.reason;

  const excludedByHand: any[] = [];
  const byStore: Record<string, any[]> = {};
  for (const r of refunded as any[]) {
    const why = excludeNow[String(r.ebay_order_id)];
    if (why) { excludedByHand.push({ ...pick(r), why }); continue; }
    (byStore[r.store_code] ||= []).push(r);
  }

  for (const [code, list] of Object.entries(byStore)) {
    const shop = SHOP_BY_STORE[code];
    const t = tokRows.find((x: any) => x.store_code === code) || tokRows.find((x: any) => x.shop === shop);
    if (!t) { for (const r of list) unresolved.push({ ...pick(r), why: "no shopify_stores row" }); continue; }

    const queue = [...list];
    const worker = async () => {
      for (;;) {
        const r: any = queue.shift();
        if (!r) return;
        const eid = String(r.ebay_order_id);
        const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": t.access_token },
          body: JSON.stringify({
            query: `query($q: String!) { orders(first: 20, query: $q) { edges { node {
                      name cancelledAt displayFulfillmentStatus tags sourceIdentifier
                      app { name }
                      customAttributes { key value }
                      fulfillments(first: 5) { status trackingInfo { number } }
                    } } } }`,
            variables: { q: eid },
          }),
        });
        const b = await res.json().catch(() => null);
        if (!b || b.errors?.length) {
          unresolved.push({ ...pick(r), why: `shopify lookup failed: ${JSON.stringify(b?.errors || "no body").slice(0, 120)}` });
          continue;
        }
        const tagForId = ("ebay-" + eid).toLowerCase();
        const hits = (b.data.orders.edges || []).map((e: any) => e.node).filter((o: any) =>
          (o.customAttributes || []).some((a: any) =>
            /ebay order id/i.test(String(a.key)) && String(a.value).trim() === eid)
          || String(o.sourceIdentifier || "").trim() === eid
          || (o.tags || []).some((tg: any) => String(tg).trim().toLowerCase() === tagForId));
        // Our copy is the SPEEKS Connect one; the MC twin is the phantom and its
        // fulfilment state says nothing about what the buyer received.
        const ours = hits.filter((o: any) =>
          String(o.app?.name || "").trim().toUpperCase() === "SPEEKS CONNECT");
        if (ours.length !== 1) {
          unresolved.push({ ...pick(r), why: `${ours.length} SPEEKS Connect orders matched` });
          continue;
        }
        const o = ours[0];
        const didShip = (o.fulfillments || []).some((f: any) => String(f.status) === "SUCCESS")
          || String(o.displayFulfillmentStatus) === "FULFILLED";
        if (didShip) {
          shipped[eid] = { shopify_order: o.name };
          continue;
        }

        // ⚠️ SHOPIFY IS NOT THE LAST WORD ON WHETHER A PARCEL EXISTS.
        // Cancelling an order in Shopify can leave it reading UNFULFILLED even
        // though a label was bought and the item went out hours earlier — the
        // cancellation rewrites the order's status, not history. eBay keeps the
        // shipment record either way, so when Shopify says "never shipped" we
        // ask eBay before writing a buyer off.
        //
        // BAL 13-15066-46687 is why: both Shopify copies read UNFULFILLED and
        // cancelled, and eBay holds USPS 9234690267338800008842 9465 shipped at
        // 9:43am — two and a half hours BEFORE either copy was cancelled. That
        // buyer has the iPad and a full refund, and this list had excluded them.
        const ship = await ebayTrackingFor(r);
        if (ship.tracking.length) {
          shipped[eid] = {
            shopify_order: o.name,
            shipped_per: "eBay tracking (Shopify shows the order cancelled)",
            tracking: ship.tracking,
          };
          recoveredByEbay.push({
            ...pick(r), shopify_order: o.name,
            shopify_fulfillment: o.displayFulfillmentStatus,
            cancelled: !!o.cancelledAt,
            tracking: ship.tracking,
            why: "Shopify says never shipped, but eBay holds tracking — the buyer received it",
          });
          continue;
        }

        notShipped.push({
          ...pick(r), shopify_order: o.name,
          shopify_fulfillment: o.displayFulfillmentStatus,
          cancelled: !!o.cancelledAt,
          // Says what was actually checked, so a future reader knows this is a
          // two-source answer rather than Shopify's word alone.
          ebay_shipment_check: ship.note,
          why: "never shipped — buyer received nothing, so nothing to ask for",
        });
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  }

  // store + username, not username alone: each store messages from its own eBay
  // account, so the same person at two stores is two separate conversations.
  const byBuyer: Record<string, any> = {};
  let noUsername = 0;

  for (const r of refunded as any[]) {
    if (!shipped[String(r.ebay_order_id)]) continue;   // never shipped, or unresolved
    const user = r.body?.buyer?.username ? String(r.body.buyer.username) : null;
    if (!user) { noUsername++; continue; }
    const key = `${r.store_code}|${user}`;
    const items = (r.body?.lineItems || []).map((li: any) => li?.title).filter(Boolean);
    const fullName = String(
      r.body?.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.fullName
      || r.body?.buyer?.buyerRegistrationAddress?.fullName || "").trim();
    byBuyer[key] = byBuyer[key] || {
      store: r.store_code, username: user, orders: [], total: 0,
      full_name: fullName,
    };
    // What the buyer paid for the item, which is the number they will recognise
    // on their own refund. `ebay_refund_total` is the seller-side figure — it is
    // net of the marketplace fee eBay credited back to us, so quoting it would
    // name an amount the buyer has never seen ($139.67 against a $149.99 sale).
    const salePrice = r2(Number(r.ebay_order_total)
      || Number(r.body?.pricingSummary?.total?.value) || 0);
    byBuyer[key].orders.push({
      ebay_order_id: r.ebay_order_id,
      item_id: r.body?.lineItems?.[0]?.legacyItemId ?? null,
      item: items.join(" + ") || null,
      short_item: shortItem(items[0] || ""),
      amount: salePrice,
      our_loss: r2(Number(r.ebay_refund_total) || 0),
      refund_date: r.body?.paymentSummary?.refunds?.[0]?.refundDate ?? null,
    });
    byBuyer[key].total = r2(byBuyer[key].total + salePrice);
  }

  // Flatten to ONE ROW PER ORDER. buyer_order_count rides along so a manager can
  // see at a glance that this person is getting more than one message from them.
  const list: any[] = [];
  for (const b of Object.values(byBuyer) as any[]) {
    for (const o of b.orders) {
      list.push({
        store: b.store,
        username: b.username,
        full_name: b.full_name,
        // The eBay username, not the shipping name. On eBay that is who the
        // buyer IS — it is what they see on their own account and the only name
        // guaranteed to be theirs, which also retires the business-name and
        // freight-forwarder problem the real names carried.
        greeting: b.username,
        buyer_order_count: b.orders.length,
        buyer_total: b.total,
        ebay_order_id: o.ebay_order_id,
        item: o.item,
        short_item: o.short_item,
        amount: o.amount,
        our_loss: o.our_loss,
        already_sent: ALREADY_SENT.has(String(o.ebay_order_id)),
        refund_date: o.refund_date,
        // Deep link into eBay's compose window, addressed to this buyer about
        // THIS item — the difference between ~90 messages and ~90 searches, and
        // the reason per-order is the right shape: the thread hangs off the item.
        // ⚠️ eBay changes these URL shapes without notice, so the order link is
        // included as a fallback and the first should be tested before a manager
        // works through a whole store.
        ebay_contact_url: o.item_id
          ? `https://contact.ebay.com/ws/eBayISAPI.dll?ContactUserNextGen`
            + `&recipient=${encodeURIComponent(b.username)}`
            + `&item=${encodeURIComponent(o.item_id)}`
          : null,
        ebay_order_url: `https://www.ebay.com/sh/ord/details?orderid=`
          + encodeURIComponent(o.ebay_order_id),
        message: buildMessage(b.store, b.username, o.short_item, o.amount),
      });
    }
  }
  // Grouped by buyer within a store, so a manager sending to someone with three
  // orders sees all three together rather than meeting them three times.
  list.sort((a: any, b: any) =>
    a.store !== b.store ? (a.store < b.store ? -1 : 1)
      : a.username !== b.username ? (a.buyer_total !== b.buyer_total
        ? b.buyer_total - a.buyer_total : (a.username < b.username ? -1 : 1))
      : b.amount - a.amount);

  const multiBuyers: Record<string, any> = {};
  for (const r of list) {
    if (r.buyer_order_count > 1) multiBuyers[`${r.store}|${r.username}`] =
      { store: r.store, username: r.username, orders: r.buyer_order_count, total: r.buyer_total };
  }
  const multi = Object.values(multiBuyers);

  const storeSummary: Record<string, { messages: number; buyers: number; total: number }> = {};
  const seenBuyer: Record<string, boolean> = {};
  for (const r of list) {
    storeSummary[r.store] = storeSummary[r.store] || { messages: 0, buyers: 0, total: 0 };
    storeSummary[r.store].messages++;
    storeSummary[r.store].total = r2(storeSummary[r.store].total + r.amount);
    const bk = `${r.store}|${r.username}`;
    if (!seenBuyer[bk]) { seenBuyer[bk] = true; storeSummary[r.store].buyers++; }
  }

  if (url.searchParams.get("format") === "csv") {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["store", "manager", "ebay_username", "already_sent", "ebay_order_id",
      "item", "sale_price", "our_loss", "buyer_order_count", "ebay_contact_url",
      "ebay_order_url", "listing_title", "message"];
    const body = list.map((b: any) =>
      [b.store, (STORES[b.store] || {}).manager || "", b.username, b.already_sent ? "SENT" : "",
       b.ebay_order_id, b.short_item || "", b.amount.toFixed(2), b.our_loss.toFixed(2),
       b.buyer_order_count, b.ebay_contact_url || "", b.ebay_order_url, b.item || "", b.message]
        .map(esc).join(","));
    return new Response([head.join(","), ...body].join("\r\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="refunded-buyer-outreach.csv"',
      },
    });
  }

  return json({
    generated_at: new Date().toISOString(),
    readOnly: "nothing sent, nothing written",
    refunded_orders: refunded.length,
    orders_shipped_and_lost: Object.keys(shipped).length,
    excluded_by_hand: excludedByHand.length,
    excluded_never_shipped: notShipped.length,
    excluded_never_shipped_amount: r2(notShipped.reduce((a, x) => a + x.refunded, 0)),
    // Buyers Shopify alone would have skipped. Surfaced at the top, not buried
    // in a row list, because a non-zero number here means the single-source
    // rule was wrong again and somebody should look.
    recovered_by_ebay_tracking: recoveredByEbay.length,
    unresolved: unresolved.length,
    messages_to_send: list.length,
    distinct_buyers: Object.keys(seenBuyer).length,
    buyers_with_multiple_orders: multi.length,
    orders_missing_a_username: noUsername,
    already_sent: list.filter((b: any) => b.already_sent).length,
    still_to_send: list.filter((b: any) => !b.already_sent).length,
    // What we ASK buyers for is the sale price they recognise. What the glitch
    // actually took off us is the seller-side figure, which is lower by eBay's
    // fee. Both are reported so neither number can be quoted as the other.
    total_to_ask_for: r2(list.reduce((a: number, b: any) => a + b.amount, 0)),
    total_we_actually_lost: r2(list.reduce((a: number, b: any) => a + b.our_loss, 0)),
    by_store: storeSummary,
    multi_order_buyers: multi,
    excluded_by_hand_rows: excludedByHand,
    never_shipped: notShipped,
    recovered_by_ebay_tracking_rows: recoveredByEbay,
    unresolved_rows: unresolved,
    rows: list,
  });
});
