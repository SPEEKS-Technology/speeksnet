-- What the Claude calls actually cost, per run.
--
-- WHY THIS EXISTS. Ethan, 2026-09-08: three $10 recharges since the title tool
-- went live, and nobody could say where the money went. The name check had been
-- computing its own cost correctly at $5/$25 per MTok and returning it in the
-- sweep response the whole time (listing-titles, the nameCheck block) — and then
-- throwing it away when the response was read. Answering "is this too much"
-- meant estimating from the source code and the prompt's character count, which
-- is a bad way to answer a billing question.
--
-- So every paid call writes one row. The next time the question is asked it is a
-- SELECT, not an estimate.
--
-- ONE ROW PER RUN, not per request: a run is the unit somebody recognises ("the
-- 4am name check for OVL"), and a per-request table would be 20x the rows to
-- answer the same question. `batches` and `items` carry the fan-out.
--
-- cost_usd IS STORED, not derived on read. Per-token prices change, and the
-- honest record of what a run cost is what it cost under the prices in force
-- when it ran — recomputing history against today's rate card would silently
-- restate the past. The writer works it out; this column remembers it.
--
-- NOT every tool writes here yet. `tool` says which one a row is, and a total
-- over this table is a total of the tools that log, not of the account. The
-- account's own figure is in the Anthropic console.

create table if not exists public.ai_usage_log (
    id            bigserial primary key,
    at            timestamptz not null default now(),
    -- '<function>:<pass>', e.g. 'listing-titles:names', 'daily-brief:drafts'.
    tool          text        not null,
    store_code    text,
    model         text        not null,
    -- Null where the call does not set one (the API's own default applies).
    effort        text,
    batches       integer     not null default 0,
    items         integer     not null default 0,
    input_tokens  bigint      not null default 0,
    output_tokens bigint      not null default 0,
    cost_usd      numeric(10, 4) not null default 0
);

-- Every question asked of this table is "what did the last N days cost",
-- optionally for one tool. That is this index.
create index if not exists ai_usage_log_at_idx  on public.ai_usage_log (at desc);
create index if not exists ai_usage_log_tool_idx on public.ai_usage_log (tool, at desc);

-- Written only by edge functions holding the service key, and read by nobody in
-- the browser: no anon or authenticated grants, and RLS on with no policy so a
-- leaked anon key sees an empty table rather than the shape of the spend.
alter table public.ai_usage_log enable row level security;
