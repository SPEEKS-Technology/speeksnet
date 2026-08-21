// ============================================================================
// google-reviews — read each store's review count from GOOGLE, not the POS.
//
//   ?find=1&secret=...            search for the five listings, WRITE NOTHING
//   ?find=1&save=1&secret=...     ...and persist the Place IDs once confirmed
//   ?snap=1&secret=...            today's snapshot per store (idempotent)
//   ?report=1&secret=...          what the surfaces read: total, today, MTD
//   ?report=1&store=LEE           one store
//   ?probe=1&store=LEE            can we see INDIVIDUAL reviews? read-only
//
// WHY THIS EXISTS. The review figure the whole site shows arrives through the
// POS in the nightly Day End Report, and it lags by days: LEE stood at 29 on the
// month while the report still said 26. That lag looks exactly like a store that
// has stopped earning reviews, so it cost us the review signal in the daily store
// messages (daily-brief v25 dropped it entirely). Google knows the real number.
//
// ⚠️ `userRatingCount` IS ALL REVIEWS, NOT FIVE-STAR ONLY, and the star split
// cannot be recovered from it by arithmetic: `rating` is rounded to one decimal,
// so rating x count carries an error of up to 0.05 x count, which at a store with
// hundreds of reviews is tens of stars. The four surfaces already say "Google
// Reviews", so counting all of them makes the label true — but the sheet's manual
// goal row was written as a five-star target.
//
// FIVE-STAR COUNTING MIGHT STILL BE POSSIBLE, and ?probe=1 is what settles it.
// Place Details also returns up to FIVE individual reviews, each with its own
// `rating`, `publishTime` and a stable resource `name`. Measured against 55
// store-days of Day End history, these stores average 1.1 to 1.6 reviews a day
// and only ONE day in 55 went past five (WSP, 7 — and that spike is probably the
// lagging POS catching up on three days at once, so true daily volume is likely
// lower). A daily poll would therefore see essentially every review individually
// and could count the five-star ones exactly.
//
// The one thing that decides it: whether Google hands back the NEWEST five or the
// most RELEVANT five. Newest is usable; "most relevant" would silently miss new
// reviews, which is the same class of quiet wrongness this whole feature exists
// to remove. ?probe=1 dumps what Google actually returns, including whether the
// publish times come back in descending order, so this is answered by measurement
// rather than by reading documentation.
//
// If it works, the design is: keep seen reviews by resource `name`, count five-star
// per month exactly, AND reconcile the count of reviews seen against the movement
// in `userRatingCount` — so a day that overflowed the five-review window reports
// "saw 5 of 7" instead of quietly under-counting.
//
// If it does not, the exact answer is the Google Business Profile API
// (`accounts.locations.reviews.list`), which returns every review with a
// `starRating` and `createTime`. PayMore owns the listings, so it is available to
// them; it needs an access request to Google and OAuth as the owner.
//
// ⚠️ ONE SNAPSHOT A DAY IS THE WHOLE MECHANISM. Places only ever reports the
// all-time count, so a month's reviews is the difference between today's snapshot
// and the last one on or before the end of last month. Consequences, both
// deliberate:
//   * `newToday` needs yesterday's row and is exact from the second day on.
//   * `newMtd` is exact only once a snapshot from the PREVIOUS month exists. Until
//     then it is reported as null with `mtdBasis: "no-baseline"` rather than
//     guessed. A wrong review count is the entire problem we are fixing; shipping
//     an estimate dressed as a measurement would just move it.
//
// COST. Five stores, one Place Details call each per day: ~150 calls a month,
// well inside Google's free monthly allowance for the Places API.
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SECRET = "sp33ks-sync-k3y-2026-x9mq";
const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];

// What to type into Google to find each shop. Deliberately the town, not a full
// address: PayMore's listings are named "PayMore <Town>", and a stale street
// address would fail to match where a town never will. The RESULT still has to be
// eyeballed before it is saved — see the `find` handler.
const SEARCH_FOR: Record<string, string> = {
  OVL: "PayMore Overland Park, KS",
  LEE: "PayMore Lee's Summit, MO",
  WSP: "PayMore Westport, Kansas City, MO",
  MPL: "PayMore Maplewood, MO",
  BAL: "PayMore Ballwin, MO",
};

const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
// Set as a Supabase Edge Function secret. Deliberately never defaulted to a
// literal: a key committed to a repo is a key that has to be rotated.
const PLACES_KEY = Deno.env.get("GOOGLE_PLACES_KEY") || "";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status: s, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function sb(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`supabase ${path}: ${res.status} ${await res.text()}`);
  return res;
}

// Central date. The edge runtime is UTC, so a naive new Date() would roll the
// snapshot over at 7pm Central and put two "days" inside one real day.
const todayCentral = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());

// ---------------------------------------------------------------------------
// Places API (New). The field mask is REQUIRED and also decides what Google
// bills for, so it names exactly the four fields we use and nothing else.
// ---------------------------------------------------------------------------
async function placeSearch(query: string) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": PLACES_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount",
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 5 }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`places searchText ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return (body.places || []) as any[];
}

async function placeDetails(placeId: string) {
  const res = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: {
        "X-Goog-Api-Key": PLACES_KEY,
        "X-Goog-FieldMask": "id,displayName,rating,userRatingCount",
      },
    });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`places details ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body as any;
}

// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  if (url.searchParams.get("secret") !== SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  // Said plainly and early, because this is the one thing that stops all three
  // modes and it is a five-minute fix in the Google Cloud console.
  if (!PLACES_KEY) {
    return json({
      ok: false,
      error: "GOOGLE_PLACES_KEY is not set on this project, so Google cannot be asked anything.",
      howToFix: [
        "Google Cloud console -> APIs & Services -> Enable 'Places API (New)'.",
        "Credentials -> Create credentials -> API key. Restrict it to the Places API.",
        "Supabase -> Edge Functions -> Secrets -> add GOOGLE_PLACES_KEY.",
      ],
    }, 503);
  }

  const only = (url.searchParams.get("store") || "").toUpperCase().trim();
  const stores = only ? STORES.filter((s) => s === only) : STORES;

  // --- can we count FIVE-STAR reviews? -----------------------------------
  //
  // Read-only, writes nothing, and its whole job is to answer one question:
  // does Google hand back the NEWEST five reviews, or the most RELEVANT five?
  // Newest means we can count five-star reviews exactly at this volume; "most
  // relevant" means we cannot, and the honest answer becomes the Business
  // Profile API. `descending` is the verdict.
  //
  // Kept out of ?snap= deliberately: the reviews field is a larger field mask
  // and therefore a dearer billing SKU, so the daily job should not pay for it
  // until we know it is worth having.
  if (url.searchParams.get("probe") === "1") {
    const places = await (await sb("google_places?select=store,place_id")).json();
    const byStore = new Map<string, string>(places.map((p: any) => [p.store, p.place_id]));
    const out: any[] = [];
    for (const store of stores) {
      const pid = byStore.get(store);
      if (!pid) { out.push({ store, skipped: "no place_id — run ?find=1&save=1 first" }); continue; }
      try {
        const res = await fetch(
          `https://places.googleapis.com/v1/places/${encodeURIComponent(pid)}`, {
            headers: {
              "X-Goog-Api-Key": PLACES_KEY,
              "X-Goog-FieldMask": "id,displayName,rating,userRatingCount,reviews",
            },
          });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { out.push({ store, error: `${res.status}: ${JSON.stringify(body).slice(0, 300)}` }); continue; }
        const revs = (body.reviews || []) as any[];
        const times = revs.map((r) => r.publishTime).filter(Boolean);
        // Newest-first is the property we need. Checked rather than assumed.
        let descending: boolean | null = null;
        if (times.length > 1) {
          descending = times.every((t, i) =>
            i === 0 || Date.parse(times[i - 1]) >= Date.parse(t));
        }
        out.push({
          store,
          totalReviews: body.userRatingCount ?? null,
          rating: body.rating ?? null,
          returned: revs.length,
          descending,
          fiveStarAmongThem: revs.filter((r) => Number(r.rating) === 5).length,
          reviews: revs.map((r) => ({
            // The resource name is stable, so it is what a "have we already
            // counted this one" table would key on.
            name: r.name ?? null,
            rating: r.rating ?? null,
            publishTime: r.publishTime ?? null,
            relative: r.relativePublishTimeDescription ?? null,
          })),
        });
      } catch (e) {
        out.push({ store, error: String(e) });
      }
    }
    return json({
      ok: true,
      question: "Does Google return the NEWEST five reviews (usable) or the most RELEVANT five (not usable)?",
      readThis: "If `descending` is true and the newest publishTime is recent, five-star counting works. "
        + "If the times are out of order or stale, it does not, and the exact route is the Business Profile API.",
      results: out,
    });
  }

  // --- find the listings -------------------------------------------------
  //
  // Two steps on purpose. Matching the WRONG storefront would report another
  // shop's reviews forever, and it would look completely plausible, so the
  // search reports candidates and writes nothing until it is called with
  // &save=1. The address comes back for exactly that check.
  if (url.searchParams.get("find") === "1") {
    const save = url.searchParams.get("save") === "1";
    const out: any[] = [];
    for (const store of stores) {
      try {
        const hits = await placeSearch(SEARCH_FOR[store]);
        const best = hits[0] || null;
        out.push({
          store, query: SEARCH_FOR[store],
          candidates: hits.map((h) => ({
            placeId: h.id,
            name: h.displayName?.text ?? null,
            address: h.formattedAddress ?? null,
            rating: h.rating ?? null,
            totalReviews: h.userRatingCount ?? null,
          })),
          // Flagged rather than resolved: more than one PayMore in a metro is
          // exactly when a silent first-result pick would be wrong.
          ambiguous: hits.length > 1,
          saved: false as boolean,
        });
        if (save && best?.id) {
          await sb("google_places?on_conflict=store", {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates" },
            body: JSON.stringify({
              store, place_id: best.id,
              display_name: best.displayName?.text ?? null,
              formatted_address: best.formattedAddress ?? null,
              resolved_at: new Date().toISOString(),
            }),
          });
          out[out.length - 1].saved = true;
        }
      } catch (e) {
        out.push({ store, error: String(e) });
      }
    }
    return json({
      ok: true, mode: save ? "find+save" : "find (nothing written)",
      note: save ? undefined
        : "Check the name and address of each first candidate against the real shop, then re-run with &save=1.",
      results: out,
    });
  }

  // --- today's snapshot --------------------------------------------------
  if (url.searchParams.get("snap") === "1") {
    const places = await (await sb("google_places?select=store,place_id")).json();
    const byStore = new Map<string, string>(places.map((p: any) => [p.store, p.place_id]));
    const date = todayCentral();
    const out: any[] = [];
    for (const store of stores) {
      const pid = byStore.get(store);
      if (!pid) { out.push({ store, skipped: "no place_id — run ?find=1&save=1 first" }); continue; }
      try {
        const d = await placeDetails(pid);
        const total = Number(d.userRatingCount);
        // A missing count must NOT be written as 0: it would read as a store that
        // lost every review, and tomorrow's delta would be a huge phantom jump.
        if (!Number.isFinite(total)) {
          out.push({ store, error: "Google returned no userRatingCount" });
          continue;
        }
        await sb("google_reviews_daily?on_conflict=store,date", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({
            store, date, total_reviews: total,
            rating: d.rating == null ? null : Number(d.rating),
            captured_at: new Date().toISOString(),
          }),
        });
        out.push({ store, date, totalReviews: total, rating: d.rating ?? null });
      } catch (e) {
        out.push({ store, error: String(e) });
      }
    }
    return json({ ok: !out.some((o) => o.error), date, results: out });
  }

  // --- the report the surfaces read --------------------------------------
  if (url.searchParams.get("report") === "1") {
    const date = todayCentral();
    const monthStart = date.slice(0, 8) + "01";
    // The last snapshot on or before the end of last month IS the baseline. Asked
    // for as "before the 1st", newest first, so a gap in the history (a missed
    // cron, a store added late) resolves to the newest usable row rather than
    // failing outright.
    const rows = await (await sb(
      `google_reviews_daily?select=store,date,total_reviews,rating&order=date.desc&limit=2000`)).json();
    const byStore = new Map<string, any[]>();
    for (const r of rows) {
      const arr = byStore.get(r.store) ?? [];
      arr.push(r);
      byStore.set(r.store, arr);
    }

    const out: any[] = [];
    for (const store of stores) {
      const hist = (byStore.get(store) ?? []);         // already newest-first
      const latest = hist[0] ?? null;
      if (!latest) { out.push({ store, totalReviews: null, mtdBasis: "no-snapshots" }); continue; }

      const prev = hist.find((r: any) => r.date < latest.date) ?? null;
      const baseline = hist.find((r: any) => r.date < monthStart) ?? null;

      out.push({
        store,
        asOf: latest.date,
        totalReviews: latest.total_reviews,
        rating: latest.rating,
        // Exact from the second snapshot onward.
        newToday: prev ? latest.total_reviews - prev.total_reviews : null,
        // Exact, or null. Never estimated — see the header.
        newMtd: baseline ? latest.total_reviews - baseline.total_reviews : null,
        mtdBasis: baseline ? `since ${baseline.date}` : "no-baseline",
        // Said out loud so a caller cannot mistake this for the five-star figure
        // the POS reports and the sheet's goal was written against.
        counts: "all reviews, any star rating",
      });
    }
    return json({ ok: true, date, stores: out });
  }

  return json({ ok: false, error: "pass ?find=1, ?probe=1, ?snap=1 or ?report=1" }, 400);
});
