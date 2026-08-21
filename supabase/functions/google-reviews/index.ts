// ============================================================================
// SPEEKS — google-reviews: SCRAPPED. This is a deliberate tombstone.
//
// This function used to read review counts straight from the Google Places API,
// to get around the POS lag that had LEE at 29 reviews on the month while the
// nightly Day End Report still said 26.
//
// WHY IT IS GONE (user's call, 2026-08-21). Places requires a Google Cloud
// billing account with a card on file. At ~155 calls a month against a recurring
// 5,000/month free allowance the bill would have been zero, and a 30/day quota
// cap would have made overage arithmetically impossible — but "zero under today's
// price list" is not the same promise as "free", and Google restructured Maps
// pricing as recently as March 2025. Not worth a payment method to fix a lag of a
// few days. Review counts continue to arrive the way they always have, through
// the Day End Report into the sheet (google-apps-scripts/hub-google-reviews.gs),
// which is untouched by any of this.
//
// WHY THERE IS STILL A FILE HERE AT ALL. Edge functions cannot be deleted through
// the tooling available to me, only redeployed. Left as it was, this would have
// stayed publicly reachable (verify_jwt: false) and still able to spend money if
// GOOGLE_PLACES_KEY were ever present. So it is deliberately replaced with a stub
// that holds no key, calls nothing, and cannot cost anything. The repo matches
// what is deployed, which is the rule that keeps this project honest — see the
// deploy-drift note: editing and committing a function does NOT deploy it.
//
// TO FINISH THE CLEANUP (all optional, none of it leaves anything broken):
//   - Supabase -> Edge Functions -> google-reviews -> Delete, to remove this stub.
//   - Supabase -> Edge Functions -> Secrets -> delete GOOGLE_PLACES_KEY.
//   - Google Cloud -> delete the API key, or the whole speeks-google-reviews
//     project. That is the step that removes the billing surface for good.
//
// The database side is already fully reverted by migration
// 0047_remove_google_places_reviews: the snapshot cron is unscheduled, its
// cron_expectations row is deleted (a row left pointing at an unscheduled job is
// a permanent daily "Scheduled job stopped" false alarm), and both tables are
// dropped — verified empty first, so nothing was lost.
//
// The original 368-line implementation is in git history if this is ever revived.
// ============================================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // 410 Gone, not 404: this endpoint existed and was intentionally withdrawn.
  // Anything still calling it should be told why rather than left guessing.
  return new Response(
    JSON.stringify({
      ok: false,
      gone: true,
      what: "Google Places review tracking was scrapped on 2026-08-21.",
      why: "It needs a Google Cloud billing account. Review counts come from the Day End Report instead, as they always did.",
      fix: "Nothing to fix. If you are seeing this in a log, something is calling a withdrawn endpoint and can be pointed at the sheet path.",
    }),
    { status: 410, headers: CORS },
  );
});
