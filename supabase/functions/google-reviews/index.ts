// ============================================================================
// google-reviews — read each store's review count from GOOGLE, not the POS.
//
//   ?find=1&secret=...            search for the five listings, WRITE NOTHING
//   ?find=1&save=1&secret=...     ...and persist the Place IDs once confirmed
//   ?snap=1&secret=...            today's snapshot per store (idempotent)
//   ?report=1&secret=...          what the surfaces read: total, today, MTD
//   ?report=1&store=LEE           one store
//
// WHY THIS EXISTS. The review figure the whole site shows arrives through the
// POS in the nightly Day End Report, and it lags by days: LEE stood at 29 on the
// month while the report still said 26. That lag looks exactly like a store that
// has stopped earning reviews, so it cost us the review signal in the daily store
// messages (daily-brief v25 dropped it entirely). Google knows the real number.
//
// ⚠️ THE METRIC IS ALL REVIEWS, NOT FIVE-STAR ONLY. Places returns
// `userRatingCount` across every rating, and the star split cannot be recovered:
// `rating` is rounded to one decimal, so rating x count carries an error of up to
// 0.05 x count, which at a store with hundreds of reviews is tens of stars. The
// four surfaces already say "Google Reviews", so this makes the label true — but
// the sheet's manual goal row was written as a five-star target.
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

  return json({ ok: false, error: "pass ?find=1, ?snap=1 or ?report=1" }, 400);
});
