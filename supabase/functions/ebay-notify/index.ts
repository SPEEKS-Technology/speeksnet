// ebay-notify — eBay marketplace account deletion/closure notification endpoint.
//
// eBay will not issue a production keyset until this endpoint exists and passes
// their validation, so this is the first thing that has to go live.
//
// Two jobs:
//
//   GET  ?challenge_code=...  eBay's ownership check. We must answer with
//                             sha256(challengeCode + verificationToken + endpointUrl)
//                             as lowercase hex. The concatenation order is fixed
//                             by eBay and getting it wrong is the usual reason
//                             validation fails.
//
//   POST                      A real notification: an eBay user closed their
//                             account and we must delete any personal data we
//                             hold for them. We answer 200 immediately — eBay
//                             retries on anything else — and record the notice
//                             so the deletion can be handled deliberately.
//
// Setup:
//   1. Deploy with verify_jwt:false. eBay sends no auth header and will fail
//      validation outright if Supabase's JWT gate rejects the call.
//   2. Set EBAY_VERIFICATION_TOKEN (32-80 chars, only A-Z a-z 0-9 _ -) and
//      EBAY_NOTIFY_URL (this function's exact public https URL, no query string)
//      in the function environment.
//   3. Paste the same token and URL into the eBay developer portal under
//      Alerts & Notifications, then hit Send Test Notification.
//
// The URL below must match what eBay has on file byte for byte — a trailing
// slash difference changes the hash and the check fails with no useful error.

const VERIFICATION_TOKEN = Deno.env.get("EBAY_VERIFICATION_TOKEN") ?? "";
const ENDPOINT_URL = Deno.env.get("EBAY_NOTIFY_URL") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// Park the notice rather than deleting anything inline. eBay only needs a
// prompt 200; the actual purge is ours to run once we know what eBay data we
// store, and a durable record means a retry can't lose one.
async function recordNotice(payload: unknown) {
  if (!SUPABASE_URL || !SERVICE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/ebay_deletion_notices`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify([{
        payload,
        received_at: new Date().toISOString(),
      }]),
    });
  } catch (err) {
    // Never let bookkeeping turn into a non-200 for eBay.
    console.error("ebay-notify: could not record notice", err);
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const challengeCode = url.searchParams.get("challenge_code");

    if (!challengeCode) {
      // Plain browser visit — a small status page so it's obvious whether the
      // environment is set up before we hand the URL to eBay.
      const ready = Boolean(VERIFICATION_TOKEN && ENDPOINT_URL);
      return json({
        endpoint: "ebay-notify",
        ready,
        verificationTokenSet: Boolean(VERIFICATION_TOKEN),
        endpointUrlSet: Boolean(ENDPOINT_URL),
        endpointUrlSeen: ENDPOINT_URL || null,
        hint: ready
          ? "Ready. Paste this URL and the same token into the eBay developer portal."
          : "Set EBAY_VERIFICATION_TOKEN and EBAY_NOTIFY_URL in the function environment.",
      });
    }

    if (!VERIFICATION_TOKEN || !ENDPOINT_URL) {
      console.error("ebay-notify: challenge received but environment is incomplete");
      return json({ error: "endpoint not configured" }, 500);
    }

    const challengeResponse = await sha256Hex(
      challengeCode + VERIFICATION_TOKEN + ENDPOINT_URL,
    );
    return json({ challengeResponse });
  }

  if (req.method === "POST") {
    let payload: unknown = null;
    try {
      payload = await req.json();
    } catch {
      payload = null;
    }
    await recordNotice(payload);
    // 200 with no body is what eBay wants; anything else gets retried and
    // repeated failures can get the endpoint marked down.
    return new Response(null, { status: 200 });
  }

  return json({ error: "method not allowed" }, 405);
});
