-- ============================================================================
-- Split the quote stage in two: `review` and `quote`.
--
-- Until now one stage held two states, told apart by quote_send_count: at 0 the
-- quote was waiting on internal approval, above 0 it was out with the client.
-- That derivation was read in five separate places in the frontend, made the
-- Overview contradict its own table, and meant sending a quote back for changes
-- had to remember to reset a counter or the deal came back claiming the client
-- already had the corrected numbers.
--
-- Now:
--   review  corp   priced, waiting on a CEO/TOM/DM to approve or send back
--   quote   corp   emailed to the client, waiting on their answer
--
-- ---------------------------------------------------------------------------
-- Why the ordering is the dangerous part
--
-- b2b_stage_rank is what three CHECK constraints use to say "from this stage
-- onward, this field is required". Inserting `review` at 4 pushes
-- listing_location, listing and completed up by one, which silently changes
-- what those constraints mean unless each threshold moves with them.
--
-- Worse, the function returns NULL for an unknown stage and a CHECK treats NULL
-- as satisfied -- so forgetting to add `review` to the rank function would not
-- fail, it would quietly disable the pickup, pricing and listing integrity
-- constraints for every row sitting at that stage.
--
--   old                        new
--   declined         0         declined         0
--   pickup           1         pickup           1
--   pricing_location 2         pricing_location 2
--   pricing          3         pricing          3
--   quote            4         review           4   <- inserted
--   listing_location 5         quote            5
--   listing          6         listing_location 6
--   completed        7         listing          7
--                              completed        8
--
-- Thresholds, checked one by one against that table:
--   b2b_deals_pickup_recorded  rank < 2  unchanged -- pricing_location is still 2
--   b2b_deals_pricing_located  rank < 3  unchanged -- pricing is still 3
--   b2b_deals_listing_located  rank < 6  MUST become < 7 -- it means "listing
--                                        and beyond", and listing moved 6 -> 7
--
-- All three are dropped and re-added even though only one changes: ADD
-- CONSTRAINT revalidates every existing row, so if any of this reasoning is
-- wrong the migration fails here and rolls back rather than leaving the table
-- guarded by constraints that no longer mean what they say.
--
-- b2b_deal_list needs no edit: it calls b2b_stage_rank(), so it picks the new
-- numbering up on its own, and its is_terminal test uses literal stage names.
-- b2b_client_list likewise counts by literal name, so `review` lands in
-- open_count exactly as it should. Nothing else in the schema calls the rank
-- function -- verified against pg_proc before writing this.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

create or replace function public.b2b_stage_rank(s text)
returns integer language sql immutable parallel safe as $$
  select case s
    when 'declined'         then 0
    when 'pickup'           then 1
    when 'pricing_location' then 2
    when 'pricing'          then 3
    when 'review'           then 4
    when 'quote'            then 5
    when 'listing_location' then 6
    when 'listing'          then 7
    when 'completed'        then 8
  end;
$$;

alter table public.b2b_deals drop constraint if exists b2b_deals_stage_check;
alter table public.b2b_deals add constraint b2b_deals_stage_check
  check (stage in ('pickup', 'pricing_location', 'pricing', 'review', 'quote',
                   'listing_location', 'listing', 'completed', 'declined'));

alter table public.b2b_deals drop constraint if exists b2b_deals_pickup_recorded;
alter table public.b2b_deals add constraint b2b_deals_pickup_recorded
  check (b2b_stage_rank(stage) < 2
         or (signed_by is not null and signed_at is not null and pickup_date is not null));

alter table public.b2b_deals drop constraint if exists b2b_deals_pricing_located;
alter table public.b2b_deals add constraint b2b_deals_pricing_located
  check (b2b_stage_rank(stage) < 3 or pricing_store is not null);

alter table public.b2b_deals drop constraint if exists b2b_deals_listing_located;
alter table public.b2b_deals add constraint b2b_deals_listing_located
  check (b2b_stage_rank(stage) < 7
         or (listing_store is not null and accepted_at is not null));

-- The split itself. A quote that was never sent was, by definition, still
-- waiting on approval -- which is precisely what quote_send_count was standing
-- in for. Anything already sent stays a quote.
update public.b2b_deals
   set stage = 'review'
 where stage = 'quote'
   and coalesce(quote_send_count, 0) = 0;

-- ---------------------------------------------------------------------------
-- RE-RUN THE STATEMENT ABOVE WHEN THE MATCHING FRONTEND SHIPS.
--
-- This migration is deliberately safe to apply ahead of the code: widening a
-- CHECK breaks nothing, the renumbered ranks are only read by constraints whose
-- thresholds moved with them, and no row is at `review` yet.
--
-- The edge function is NOT safe to deploy ahead of the frontend, which is the
-- opposite of the usual direction. b2b-deals v26 sends submit_pricing to
-- `review`, and a browser running the pre-split speeks.js has no B2B_STAGE or
-- B2B_ACTIONS entry for it -- the deal would simply stop appearing in corp's
-- queue. So v26 goes out WITH the frontend, not before.
--
-- Until it does, production still runs v25, which parks a freshly submitted
-- deal at `quote` with a send count of 0. Under the old derivation that reads
-- as awaiting approval and behaves correctly; under the new one it would read
-- as already sent to the client. Re-running the UPDATE at deploy time sweeps up
-- anything submitted in the gap. It is idempotent, so running it twice costs
-- nothing.
-- ---------------------------------------------------------------------------
