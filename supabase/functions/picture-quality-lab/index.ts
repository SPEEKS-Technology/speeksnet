// ============================================================================
// picture-quality-lab — the framing experiment bench. NOT the live checker.
//
// ⚠️ WHY IT EXISTS (2026-10-11). Ethan labelled 395 OVL photos in Train The
// Checker. The live checker caught 0 of his 12 crooked and 0 of his 32
// off-centre photos, and measuring the item's box in pixels — even against the
// guide's own example of the shot — could not reproduce his calls (a low lens
// is fine to him, a low PS3 controller is not). This asks the model ONE
// narrow question per photo, with his labelled examples shown first, so the
// answers can be scored against his labels before anything touches the
// checker. Secret-guarded; it saves nothing and touches no listing.
//
//   POST ?secret=…  { model?, effort?, examples: [Ex], items: [Item] }
//     Ex   = { photo, guide?, crooked, off_center, too_small, why }
//     Item = { id, photo, guide? }
//   → { results: [{ id, crooked, off_center, too_small, tilt_degrees, note }], usage, cost_usd }
// ============================================================================
import Anthropic from "npm:@anthropic-ai/sdk";
import { z } from "npm:zod";
import { zodOutputFormat } from "npm:@anthropic-ai/sdk/helpers/zod";

const SECRET = "sp33ks-sync-k3y-2026-x9mq";   // the same secret picture-quality checks
const PRICES: Record<string, [number, number]> = { "claude-sonnet-5": [2, 10], "claude-opus-5": [5, 25], "claude-haiku-5-5": [0.1, 0.5] };

const Answer = z.object({
  tilt_degrees: z.number(),
  crooked: z.boolean(),
  off_center: z.boolean(),
  too_small: z.boolean(),
  note: z.string(),
});

const RULES = `You check how a resale listing photo is FRAMED, compared with the store's guide example of the same shot. Judge only framing — not cleanliness, reflections or what is shown.

crooked: the item is rotated IN THE PICTURE PLANE by a few degrees or more — its straight edges (a case edge, a tablet edge, a keyboard row, a box edge) are visibly not parallel to the frame's edges, where the guide example's are. First estimate tilt_degrees: how far the item's main straight edge is rotated from level/upright (0 if level). A few degrees is enough to count. NOT crooked: a different viewpoint (a corner shot, a side shot, a box on the stand leaning back to show its side), a round item, or an item propped on the clear stand at the angle the stand holds it.

off_center: the item sits noticeably away from where the guide example puts it — most often too LOW, with a wide empty band of backdrop above it, or pushed to one side. A long or thin item lying low the way its example does is fine; judge against the example, not against the exact middle.

too_small: the item fills noticeably less of the frame than in the guide example — lots of empty backdrop all round, so a buyer cannot see it well. Thin edge-on views and closeups are never too small.

The examples below are the store owner's own calls. Match his judgement.`;

let imgCache = new Map<string, Promise<any>>();
function img(url: string) {
  if (!imgCache.has(url)) imgCache.set(url, (async () => {
    let last = "";
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const t = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
        return { type: "image", source: { type: "base64", media_type: ["image/jpeg", "image/png", "image/webp"].includes(t) ? t : "image/jpeg", data: btoa(bin) } };
      } catch (e) { last = String((e as Error).message || e); await new Promise(r => setTimeout(r, 400 * (a + 1))); }
    }
    throw new Error(`photo fetch failed (${last}) ${url.slice(0, 90)}`);
  })());
  return imgCache.get(url)!;
}

type Ex = { photo: string; guide?: string | null; crooked: boolean; off_center: boolean; too_small: boolean; why: string };
type Item = { id: number | string; photo: string; guide?: string | null };

async function exampleBlocks(examples: Ex[]) {
  const blocks: any[] = [{ type: "text", text: RULES + "\n\nEXAMPLES:" }];
  for (const [i, e] of examples.entries()) {
    blocks.push({ type: "text", text: `Example ${i + 1} — guide example:` });
    if (e.guide) blocks.push(await img(e.guide)); else blocks.push({ type: "text", text: "(no guide example for this shot)" });
    blocks.push({ type: "text", text: "Listing photo:" });
    blocks.push(await img(e.photo));
    blocks.push({ type: "text", text: `Owner's call: crooked ${e.crooked ? "YES" : "no"}, off_center ${e.off_center ? "YES" : "no"}, too_small ${e.too_small ? "YES" : "no"} — ${e.why}` });
  }
  blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
  return blocks;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if ((url.searchParams.get("secret") || "") !== SECRET) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST" }), { status: 405 });
  const body = await req.json();
  const model = body.model || "claude-sonnet-5", effort = body.effort || "low";
  const examples: Ex[] = body.examples || [], items: Item[] = (body.items || []).slice(0, 30);
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return new Response(JSON.stringify({ error: "no ANTHROPIC_API_KEY" }), { status: 500 });
  const client = new Anthropic({ apiKey });

  // Keep-alive: a space every 10s so the 150s gateway wall never sees silence.
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const tick = setInterval(() => ctrl.enqueue(enc.encode(" ")), 10000);
      try {
        const shared = await exampleBlocks(examples);
        let tin = 0, tout = 0, tcache = 0;
        const results: any[] = [];
        let next = 0;
        const one = async () => {
          while (next < items.length) {
            const it = items[next++];
            try {
              const content: any[] = [...shared, { type: "text", text: "NOW THIS ONE — guide example:" }];
              content.push(it.guide ? await img(it.guide) : { type: "text", text: "(no guide example for this shot — judge against a well-framed product photo: item centred, level, filling most of the frame)" });
              content.push({ type: "text", text: "Listing photo:" }, await img(it.photo));
              const res = await client.messages.parse({
                model, max_tokens: 4000,
                messages: [{ role: "user", content }],
                output_config: { effort, format: zodOutputFormat(Answer) },
              } as any);
              const u: any = res.usage || {};
              tin += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0); tcache += u.cache_read_input_tokens || 0; tout += u.output_tokens || 0;
              results.push({ id: it.id, ...(res as any).parsed_output });
            } catch (e) { results.push({ id: it.id, error: String((e as Error).message || e).slice(0, 200) }); }
          }
        };
        await Promise.all([1, 2, 3, 4, 5].map(one));
        const p = PRICES[model] || [2, 10];
        const cost = tin / 1e6 * p[0] + tcache / 1e6 * p[0] * 0.1 + tout / 1e6 * p[1];
        ctrl.enqueue(enc.encode(JSON.stringify({ results, usage: { in: tin, cache_read: tcache, out: tout }, cost_usd: Math.round(cost * 1e4) / 1e4 })));
      } catch (e) {
        ctrl.enqueue(enc.encode(JSON.stringify({ error: String((e as Error).message || e) })));
      } finally { clearInterval(tick); ctrl.close(); }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/json" } });
});
