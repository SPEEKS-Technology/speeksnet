// ============================================================================
// netprofit-runlog — the Net Profit pass reports its own progress here.
//
//   POST ?secret=<ops>   { run_id, pass, trigger, phase, ok, elapsed_ms, detail }
//   GET  ?secret=<ops>&hours=48     every run in the window, newest first, with
//                                    the phase it reached and how long it took
//
// WHY. Apps Script's execution log is readable only inside the script editor, so
// a pass that dies at the six-minute wall leaves no trace anyone else can see:
// no catch block runs, no email goes out, and the watchdog can only say "it did
// not finish". Each phase posts a row here as it clears, so the LAST row of a run
// is where it stopped. See migration 0090 for the morning that made this needed.
//
// ⚠️ THE SCRIPT NEVER WAITS ON THIS TO SUCCEED. A telemetry call that fails must
// not fail the pass it is describing — the caller wraps every post and carries
// on. So this does the one insert and returns; nothing slow belongs in here.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 1), { status: s, headers: { "Content-Type": "application/json" } });

function authed(url: URL) {
  const g = url.searchParams.get("secret") || "";
  if (g.length !== OPS_SECRET.length) return false;
  let d = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) d |= g.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  return d === 0;
}

const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json", ...(init.headers || {}),
    },
  });

const clip = (v: unknown, n: number) => (v === null || v === undefined ? null : String(v).slice(0, n));

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);

  if (req.method === "POST") {
    let b: any;
    try { b = await req.json(); } catch { return json({ error: "body is not JSON" }, 400); }
    if (!b?.run_id || !b?.phase || !b?.pass) return json({ error: "run_id, pass and phase are required" }, 400);
    const row = {
      run_id: clip(b.run_id, 120),
      pass: clip(b.pass, 20),
      trigger: clip(b.trigger, 30),
      phase: clip(b.phase, 60),
      ok: b.ok !== false,
      elapsed_ms: Number.isFinite(Number(b.elapsed_ms)) ? Math.round(Number(b.elapsed_ms)) : null,
      detail: b.detail ?? null,
    };
    const r = await rest("netprofit_runs", { method: "POST", body: JSON.stringify(row),
      headers: { Prefer: "return=minimal" } });
    if (!r.ok) return json({ error: `insert failed: ${r.status} ${(await r.text()).slice(0, 200)}` }, 502);
    return json({ ok: true });
  }

  // GET — one line per run, so "did this morning finish, and if not where did it
  // stop" is answered without reading raw rows.
  const hours = Math.min(24 * 14, Math.max(1, Number(url.searchParams.get("hours")) || 48));
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const r = await rest(`netprofit_runs?select=run_id,pass,trigger,phase,ok,elapsed_ms,detail,at`
    + `&at=gte.${encodeURIComponent(since)}&order=at.asc&limit=5000`);
  if (!r.ok) return json({ error: `read failed: ${r.status}` }, 502);
  const rows: any[] = await r.json();
  const runs: Record<string, any> = {};
  for (const x of rows) {
    const run = runs[x.run_id] ||= { run_id: x.run_id, pass: x.pass, trigger: x.trigger,
      started: x.at, phases: [] as string[], failed: null as any };
    run.phases.push(`${x.phase}@${Math.round((x.elapsed_ms || 0) / 1000)}s`);
    run.last_phase = x.phase;
    run.last_at = x.at;
    run.elapsed_s = Math.round((x.elapsed_ms || 0) / 1000);
    if (!x.ok) run.failed = { phase: x.phase, detail: x.detail };
  }
  const list = Object.values(runs).map((run: any) => ({
    ...run,
    finished: run.last_phase === "done",
  })).sort((a: any, b: any) => (a.started < b.started ? 1 : -1));
  return json({ hours, runs: list });
});
