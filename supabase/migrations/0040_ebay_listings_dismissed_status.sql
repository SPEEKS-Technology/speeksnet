-- The panel's Remove writes status='dismissed' (ebay-channel action "dismiss"),
-- but this constraint predated that feature and allowed only five values. So
-- every Remove was refused by Postgres, surfaced through the function's
-- catch-all as {error:"failed"}, and reached the person as a one-word alert.
--
-- The row is kept rather than deleted: what we tried and why eBay refused it is
-- worth more than a tidy table, and re-uploading the SKU overwrites the status.
alter table ebay_listings drop constraint ebay_listings_status_check;
alter table ebay_listings add constraint ebay_listings_status_check
  check (status = any (array['pending','published','failed','ended','disabled','dismissed']));
