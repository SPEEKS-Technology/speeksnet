-- 0195 — why a manager wants an insurance claim deleted.
--
-- Ethan, 2026-11-21: "add a notes field when a user requests to delete an
-- insurance claim, so I know why they are trying to delete the claim."
--
-- A delete request (shopify-claims action=request_delete) used to carry only
-- who and when. The DM then had to ring the store to find out why before
-- approving or denying. The reason is now required at request time, stored
-- here, shown on the DM's Delete Requests list and in the notification. The
-- request dialog enforces it; the function accepts a blank one so the old live
-- page keeps working until the front end is merged.
--
-- Cleared together with delete_requested_at/_by when the DM denies, so a later
-- request never shows an old reason. Additive and nullable: requests made
-- before this column existed simply show no reason.

alter table public.shopify_claims
  add column if not exists delete_reason text;

comment on column public.shopify_claims.delete_reason is
  'Why the manager asked to delete this claim (required by the request dialog). Cleared on deny.';
