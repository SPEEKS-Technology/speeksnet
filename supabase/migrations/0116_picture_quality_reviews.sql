-- ============================================================================
-- 0116 — Picture Quality: one graded review per live listing.
--
-- The fourth tool on the Listing Health page. It reads a listing's photos, picks
-- the Picture Guide sheet the item belongs to, and says whether the photos give
-- a buyer enough to judge the item. Calibrated by hand with Ethan on ten WSP
-- listings (2026-09-24/25); the rules it enforces are in the picture-quality
-- function header, not here.
--
-- ONE ROW PER PRODUCT, NOT PER SKU. BAL gives several different games the same
-- SKU (MO04-1909B1-CB1R1 is Gauntlet, Willow, Treasure Master…), and a SKU key
-- would grade one game against another game's photos. product_id is the only
-- identity Shopify guarantees.
--
-- `stamp` is what makes a review reusable: a hash of the photos, the condition
-- notes, the guide sheet and the recipe. The sweep skips a listing whose stamp
-- still matches, so a store is paid for once, and re-graded only when somebody
-- changes a photo, the notes, or the sheet.
--
-- `verdict` is decided in CODE from what the model reported, never by the model:
--   retake  — half or more of the sheet's required shots missing
--   fix     — specific photos to redo (not square, tilted, fake, flaw not shown…)
--   reorder — photos are fine, the order is not (a one-click suggestion)
--   pass    — nothing a buyer would miss
--   no_sheet / error — not graded, and says why
--
-- Same RLS posture as every table here since 0063: RLS on, no policy, so only
-- the service role (the edge function) can read or write. See
-- [[supabase-rls-new-tables]].
-- ============================================================================

create table if not exists public.picture_quality_reviews (
    store_code     text        not null,
    product_id     text        not null,
    sku            text,
    title          text,
    sheet_slug     text,
    sheet_name     text,
    stamp          text        not null,
    verdict        text        not null
                   check (verdict in ('retake','fix','reorder','pass','no_sheet','error')),
    findings       jsonb       not null default '[]'::jsonb,
    reorder        jsonb,
    title_notes    jsonb       not null default '[]'::jsonb,
    report         jsonb,
    photo_count    int,
    model          text,
    input_tokens   int,
    output_tokens  int,
    cost_usd       numeric(10,5),
    reviewed_at    timestamptz not null default now(),
    -- The manager's half. A dismissed row stays dismissed until the stamp
    -- changes; a new photo set is a new question.
    status         text        not null default 'open'
                   check (status in ('open','dismissed','applied')),
    decided_by     text,
    decided_at     timestamptz,
    decided_note   text,
    primary key (store_code, product_id)
);

create index if not exists picture_quality_reviews_queue_idx
    on public.picture_quality_reviews (store_code, status, verdict);

alter table public.picture_quality_reviews enable row level security;
revoke all on public.picture_quality_reviews from anon, authenticated;

comment on table public.picture_quality_reviews is
  'Picture Quality (Listing Health): one graded photo review per live product. '
  'Written only by the picture-quality edge function. See 0116.';
