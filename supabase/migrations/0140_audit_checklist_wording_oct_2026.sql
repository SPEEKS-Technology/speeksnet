-- 0140 — PayMore audit checklist wording, revision of 7/22/26 (received 2026-10-07).
--
-- PayMore re-issued the checklist ("Full Audit Checklist - AS OF 10.07.2026",
-- condensed from Audit Playbook v3, updated 7/22/26). Same 94 items, same
-- points, same 165 total — only wording changed. The lines below are the ones
-- whose MEANING moved (new requirements, a relaxed one, or a clarified one);
-- lines the PDF merely abbreviated keep their longer playbook wording.
--
-- Text only: audit_scores keys answers by item_id and section notes/photos by
-- section title, so neither is touched. The PDF also prints Back of House as
-- two blocks (General & Holding / Stations) under the same "06"; we keep one
-- "Back of House" section because section_notes/section_photos are keyed by
-- title and splitting would orphan past audits' notes.
--
-- Mirrors the AUDIT_DEFINITION fallback in speeks.js.

update paymore_audit_items set item_text = v.t
from (values
  ('ex2',  'Exterior & road signage clean, lit (if applicable), no damage/fading; banners within brand standard, hung straight, not ripped/torn; hours sign not handwritten'),
  ('ex3',  'Building exterior clean & well-maintained (windows, paint, no handmade signs); approved window decals only; door hours match website'),
  ('ef6',  'Ceiling tiles in place & good shape; <10% affected; no water damage'),
  ('ef12', 'No QR codes / Google review signage in transaction area'),
  ('rc8',  'PayMore signage at counter; Freedom to Trade In trifold nearby; promos in plexi frames (not taped); posters in frames not wrinkled or faded'),
  ('bt10', 'Larger items in white boxes: PO attached, bubble-wrapped, on shelving or neatly stacked (must be boxed)'),
  ('bh10', 'Holding bins have Shopify barcode'),
  ('bh12', 'Black bins present, labeled E1/E2 etc. (not handwritten); items bubble-wrapped'),
  ('bh16', 'Listing Station: Lenovo computer present, clean and organized; cords not loose, proper cable management'),
  ('bh20', 'Shipping Area: bubble wrap / anti-static biodegradable peanuts (NOT white/pink polystyrene); unused boxes stacked by size'),
  ('bh21', 'Shipping Area: Lenovo computer, label printer, scale, scanner all present (box re-adjusting tool optional)'),
  ('ss3',  'Back door locked from outside, opens from inside without keys/tools; no obstructions'),
  ('pa6',  'Team conducting themselves professionally at all times')
) as v(id, t)
where paymore_audit_items.item_id = v.id;
