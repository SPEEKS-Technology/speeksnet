import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// =============================================================================
// speeks-mcp — SPEEKSNET as a Claude custom connector
// =============================================================================
// The SPEEKS Technology org on claude.ai adds this URL once (Organization
// settings → Connectors → custom connector), then any member can ask Claude
// about SPEEKSNET data in a normal chat or in the shared org project.
//
// It speaks just enough MCP (Streamable HTTP, JSON responses, no SSE) to serve
// three read-only tools. All SQL goes through ai_readonly_query() (migration
// 0142), which runs as a SELECT-only role that cannot see tokens, PINs or the
// config tables — so the instructions below never have to be trusted to keep
// anything out. The rpc is called over GET, which PostgREST runs in a READ ONLY
// transaction: the second lock on writes.
//
// Auth: claude.ai connectors can't send a custom header, so the shared key is
// the last path segment — …/functions/v1/speeks-mcp/<SPEEKS_MCP_KEY>. Deploy
// with --no-verify-jwt (claude.ai sends no Supabase JWT). Rotating the key =
// `supabase secrets set SPEEKS_MCP_KEY=…` and re-entering the URL in claude.ai.
// =============================================================================

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function chicagoToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
}

// What a fresh chat needs to know before its first query. Keep it about the
// business and the data's quirks — table structure is discoverable through the
// tools, so it doesn't belong here.
function instructions(): string {
  return `SPEEKSNET is the internal operations system of SPEEKS Technology, a PayMore franchisee (buy/sell used electronics) in Kansas City and St. Louis. Today in Central time is ${chicagoToday()}.

Stores: OVL (Overland Park), LEE (Lee's Summit), WSP (Westport), MPL (Maplewood), BAL (Ballwin). "CORP" appears for corporate rows. BAL and MPL share a manager. Roles: CEO, MOCD, DM (district manager), manager, store.

How to answer:
- Start with list_tables, then describe_table on the tables you'll use before writing SQL. Column names and comments explain most things.
- Use run_query for SQL (Postgres, SELECT only). Aggregate in SQL rather than pulling raw rows.
- Show numbers with their date range and store, and say which table they came from.

Data notes:
- Net Profit (NP) is the headline metric; the company switched from Gross Profit (GP) to NP in October 2026, so lead with NP. daily_np = NP per store per day (sales, cost, gp, ebay_fee, shipping, cc_fee, royalty, np), mirrored from the Net Profit workbook tabs; it is the current source of truth for sales and profit. monthly_np_goals = NP goal per store per month (ym like '2026-10').
- store_daily_sales / store_daily_buying are keyed by month_year text like 'Sep 2026' plus day_number; store_daily_sales stopped updating after September 2026.
- day_end_facts = each store's end-of-day report (buying spend, customers, conversions, reviews, devices processed and listed).
- listing_goals / store_targets = weekly listing goals per employee and store.
- payment_disputes, ebay_cases, shopify_claims = claims and disputes.
- policies = the Processes & Policies library; announcements = company announcements; store_calendar_events = store calendar.
- Employee names are free text typed into the app, so the same person can appear spelled differently.

You can read data only. If someone asks you to change something, tell them where in SPEEKSNET (speeksnet.com) to do it.`;
}

const TOOLS = [
  {
    name: "list_tables",
    description: "List every SPEEKSNET table and view you can read, with approximate row counts and descriptions. Call this first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "describe_table",
    description: "Columns, types and comments for one table or view, plus 3 recent sample rows.",
    inputSchema: {
      type: "object",
      properties: { table: { type: "string", description: "Table or view name, e.g. daily_np" } },
      required: ["table"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "run_query",
    description: "Run one read-only Postgres SELECT (or WITH … SELECT) against SPEEKSNET and get the rows back as JSON. Returns at most max_rows rows (default 200, max 2000); aggregate in SQL for big answers. Times out after 20 seconds.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT statement." },
        max_rows: { type: "integer", minimum: 1, maximum: 2000 },
      },
      required: ["sql"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

async function query(sql: string, maxRows = 500): Promise<unknown[]> {
  const { data, error } = await sb.rpc("ai_readonly_query", { q: sql, max_rows: maxRows }, { get: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown[];
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === "list_tables") {
    const rows = await query(`
      select c.relname as name,
             case when c.relkind in ('v','m') then 'view' else 'table' end as kind,
             greatest(c.reltuples, 0)::bigint as approx_rows,
             obj_description(c.oid, 'pg_class') as description
      from pg_class c
      where c.relnamespace = 'public'::regnamespace
        and c.relkind in ('r','v','m','p')
        and has_any_column_privilege(c.oid, 'SELECT')
      order by c.relname`, 2000);
    return JSON.stringify(rows);
  }

  if (name === "describe_table") {
    const table = String(args.table ?? "").trim();
    if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error("Table name must be letters, digits and underscores.");
    const cols = await query(`
      select column_name as name, data_type as type,
             col_description(('public.' || quote_ident(table_name))::regclass, ordinal_position::int) as description
      from information_schema.columns
      where table_schema = 'public' and table_name = '${table}'
      order by ordinal_position`, 500) as { name: string }[];
    if (!cols.length) throw new Error(`No readable table or view named "${table}". Use list_tables.`);
    const names = cols.map((c) => `"${c.name.replace(/"/g, '""')}"`).join(", ");
    // Newest-looking rows first when there's an obvious time column.
    const timeCol = ["created_at", "date", "updated_at", "synced_at", "event_date", "id"].find((t) => cols.some((c) => c.name === t));
    const sample = await query(`select ${names} from public."${table}"${timeCol ? ` order by "${timeCol}" desc nulls last` : ""} limit 3`, 3)
      .catch((e) => [{ sample_error: (e as Error).message }]);
    return JSON.stringify({ table, columns: cols, sample_rows: sample });
  }

  if (name === "run_query") {
    const sql = String(args.sql ?? "");
    const maxRows = Math.min(Math.max(Number(args.max_rows) || 200, 1), 2000);
    const rows = await query(sql, maxRows);
    return JSON.stringify({ row_count: rows.length, truncated: rows.length >= maxRows, rows });
  }

  throw new Error(`Unknown tool: ${name}`);
}

type RpcMsg = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };

async function handle(msg: RpcMsg): Promise<Record<string, unknown> | null> {
  const id = msg.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  // Notifications (no id) get no response body.
  if (msg.id === undefined || msg.id === null) return null;

  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return ok({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "speeksnet", version: "1.0.0" },
        instructions: instructions(),
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const t0 = Date.now();
      try {
        const text = await callTool(name, args);
        console.log(`speeks-mcp ${name} ok ${Date.now() - t0}ms`);
        return ok({ content: [{ type: "text", text }] });
      } catch (e) {
        console.log(`speeks-mcp ${name} error ${Date.now() - t0}ms: ${(e as Error).message}`);
        // A tool error goes back as a result so Claude can read it and fix its SQL.
        return ok({ content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

function keyMatches(given: string, expected: string): boolean {
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const url = new URL(req.url);
  const given = url.pathname.split("/").filter(Boolean).pop() ?? "";
  if (!keyMatches(given, Deno.env.get("SPEEKS_MCP_KEY") ?? "")) {
    return new Response("Not found", { status: 404, headers: cors });
  }

  // No server-initiated stream; Streamable HTTP lets a server refuse GET this way.
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

  let body: RpcMsg | RpcMsg[];
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: cors });
  }

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handle))).filter(Boolean);
    return out.length ? Response.json(out, { headers: cors }) : new Response(null, { status: 202, headers: cors });
  }
  const out = await handle(body);
  return out ? Response.json(out, { headers: cors }) : new Response(null, { status: 202, headers: cors });
});
