-- ============================================================================
-- Picture Quality GOLD SET — step 1 of the eval set: what the database knows.
--
-- READ-ONLY. A plain SELECT, no migration, nothing written. Run it in the
-- Supabase SQL editor (or the MCP execute_sql) and save the result as JSON to
-- scripts/pq-gold/gold-raw.json; scripts/pq-gold/export.mjs takes it from there
-- (live photo URLs, Ethan's calibration key, alignment checks) and writes
-- gold.json. One row per listing, one jsonb column `g`.
--
-- ⚠️ WHAT IS HUMAN AND WHAT IS NOT (2026-10-16). Almost everything in
-- picture_quality_reviews is MODEL OUTPUT: shots, missing_shots, findings,
-- verdict. Ethan's own judgement reaches the database in five ways, and each
-- says something different, so every label carries where it came from and the
-- scorer reports them separately:
--
--   pq_shot_labels (0148)        EXPLICIT, per photo, SHOT labels, made with
--                                Confirm Shots (Picture Quality, DM/CEO) from
--                                2026-10-16. THE PRIMARY SOURCE, and the only
--                                one that answers "which shot is this photo".
--                                It also holds the sheet he confirmed and
--                                optional flags (screen_on, label_legible,
--                                blurry, turned, cropped). From 0149, every
--                                photo field the rules read (flags named after
--                                the model's fields, repeat_of), plus the
--                                listing-level facts; flags_checked says a
--                                blank flag means NO. ⚠️ This query
--                                reads the table, so it fails until migration
--                                0148 is applied.
--   pq_photo_labels (0141)       EXPLICIT, per photo, FRAMING only — fine /
--                                problem (off_center, crooked, too_small,
--                                blurry, cut_off, dirty_backdrop, clutter,
--                                reflection, different_spot) / not_item. OVL
--                                only, 10-09..10-11. Its `shot` column is NOT
--                                his: it is what the Sonnet-era review said,
--                                shown to him beside that shot's guide example,
--                                with no button for "wrong shot". 97 of its 276
--                                shots disagree with today's Opus grade — so it
--                                is carried as context (`trainer_shot`), never
--                                as a gold shot label.
--   status 'applied', note       ACCEPTED, per listing. He looked at the photos
--     'reorder approved'         in the proposed order beside the guide sheet
--                                and approved it. The order is built in code
--                                from the model's shot labels, so approving it
--                                is his acceptance of those labels and of the
--                                missing-shot notes shown with it — not a
--                                photo-by-photo check. The saved report is
--                                renumbered to the new order on approval
--                                (renumberRow), so its n = today's Shopify n.
--   status 'applied', note       EXPLICIT for the deleted photo (it repeated
--     'deletion approved: …'     another) — but that photo is gone from Shopify
--                                and from the renumbered report, so nothing is
--                                left to test on. The listing still counts as
--                                ACCEPTED like an approved order.
--   status 'dismissed'           EXPLICIT verdict: the flag was wrong (one row,
--                                OVL Death Stranding 2, "New in box video games
--                                should be fine at 2 pictures").
--
-- Ethan's calibration key (29 listings with his verdict and reason, 09-24 to
-- 10-08) lives in scripts/picture-quality-calibrate.mjs, not the database;
-- export.mjs merges it. His store-by-store reviews (10-13..10-16) were given in
-- chat and became rules — there is no per-row record of which rows he looked
-- at, so "he reviewed the store and did not object" is NOT treated as gold.
--
-- No row of picture_quality_reviews is used for a label if it was re-graded
-- after the decision (reviewed_at > decided_at): the decision was about a
-- different look. saveRows resets status to 'open' on a re-grade, so today
-- none are, but the guard keeps that true if the save path ever changes.
--
-- PHOTO URLS ARE NOT HERE. The review stores no photo addresses (only the
-- stamp, a hash of them); export.mjs reads them live from the public
-- storefront. Never point anything at a Supabase image TRANSFORM URL
-- (/render/image/) — Pro has 100 a cycle ([[supabase-image-transform-quota]]);
-- guide examples below are plain /object/public/ URLs.
-- ============================================================================
with
labels as (
  select store_code, product_id,
         jsonb_agg(jsonb_build_object(
           'n_then', photo_n, 'src', photo_src, 'sheet', sheet_slug, 'trainer_shot', shot,
           'label', label, 'problems', to_jsonb(problems), 'note', note,
           'by', labelled_by, 'at', labelled_at) order by photo_n) as framing
  from pq_photo_labels
  group by store_code, product_id
),
confirmed as (
  select store_code, product_id,
         jsonb_agg(jsonb_build_object(
           'n', photo_n, 'src', photo_src, 'sheet', sheet_slug, 'model_sheet', model_sheet,
           'shots', to_jsonb(shots), 'model_shots', to_jsonb(model_shots), 'flags', to_jsonb(flags),
           'repeat_of', repeat_of, 'checked', flags_checked, 'listing', listing,
           'model', model, 'stamp', review_stamp, 'by', confirmed_by, 'at', confirmed_at) order by photo_n) as shots
  from pq_shot_labels
  group by store_code, product_id
),
reviews as (
  select r.*,
         case
           when r.decided_at is null or r.reviewed_at > r.decided_at then null
           when r.decided_note like 'reorder approved%'  then 'approved_order'
           when r.decided_note like 'deletion approved%' then 'approved_deletion'
           when r.decided_note like 'should flag%'       then 'should_flag'
           when r.decided_note like 'reorder denied%'    then 'reorder_denied'
           when r.status = 'dismissed'                   then 'dismissed'
         end as decision
  from picture_quality_reviews r
),
catalog as (
  select distinct on (product_id) product_id, product_handle, price
  from ebay_catalog
  order by product_id, seen_at desc nulls last
),
guide as (
  select c.slug,
         jsonb_agg(jsonb_build_object(
           'label', s.label, 'cond', s.cond_label,
           'img', case when s.image_path is null then null
                       else 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/storage/v1/object/public/picture-guide/' || s.image_path end)
           order by s.sort_order) as shots
  from pg_categories c join pg_shots s on s.category_id = c.id
  where c.active
  group by c.slug
)
select jsonb_build_object(
  'store',       coalesce(r.store_code, l.store_code),
  'product_id',  coalesce(r.product_id, l.product_id),
  'sku',         r.sku,
  'title',       r.title,
  'handle',      c.product_handle,
  'price',       c.price,
  'sheet',       r.sheet_slug,
  'sheet_name',  r.sheet_name,
  'guide',       g.shots,
  -- The saved grade, in the review shape the scorer reads. This is MODEL output
  -- (the baseline to score, and the source of ACCEPTED labels when decided).
  'graded', case when r.product_id is null then null else jsonb_build_object(
      'model', r.model, 'reviewed_at', r.reviewed_at, 'stamp', r.stamp,
      'photo_count', r.photo_count, 'verdict', r.verdict,
      'findings', (select coalesce(jsonb_agg(jsonb_build_object('code', f->>'code', 'photo', f->'photo', 'shot', f->>'shot')), '[]')
                   from jsonb_array_elements(r.findings) f),
      'report', r.report - array['summary','title_notes','looks','firstLook','secondLook','costs','batch','cache',
                                 'redecided','sample','sheetPick'],
      'notes', r.report->'notesAsSent') end,
  'decision', case when r.decision is null then null else jsonb_build_object(
      'kind', r.decision, 'note', r.decided_note, 'by', r.decided_by, 'at', r.decided_at) end,
  'framing', l.framing,
  'confirmed', k.shots,
  -- The confirmed sheet's guide, when he moved the listing to another sheet.
  'confirmed_guide', case when k.shots->0->>'sheet' is distinct from r.sheet_slug then cg.shots end
) as g
from reviews r
full join labels l on l.product_id = r.product_id and l.store_code = r.store_code
left join confirmed k on k.product_id = coalesce(r.product_id, l.product_id)
left join catalog c on c.product_id = coalesce(r.product_id, l.product_id)
left join guide g on g.slug = r.sheet_slug
left join guide cg on cg.slug = k.shots->0->>'sheet'
order by 1;
