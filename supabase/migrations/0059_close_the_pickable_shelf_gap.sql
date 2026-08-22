-- ============================================================================
-- 0059 — the invariant 0051 established, re-established for the shelves a
-- PERSON can now pick.
--
-- The guarantee was: every shelf the recategoriser files onto has a customer
-- vocabulary, because filing stock onto a wordless shelf tidies the storefront
-- and helps the Call Back matcher not at all. It held while only the 26 shelves
-- a RULE proposes could receive anything.
--
-- 0058's No Suggestion tab breaks that. The row has no proposal, so a person
-- picks from all 62 matchable shelves — and MEASURED at the vocab endpoint,
-- four of those have zero types:
--
--   other                      deliberate (fact 2 in the matcher's header)
--   audio-video-accessories    a real category, no words
--   marine-electronics         a real category, no words
--   paymore-finds              not a category at all
--
-- Two of them are real shelves that plausibly receive from that queue — the
-- Elan S12 AV controller and the Roland V-60HD switcher are both sitting in the
-- OVL No Suggestion list right now. So they get words.
--
-- PAYMORE FINDS IS MERCHANDISING, NOT A CATEGORY, and the user's call: it comes
-- off the pickable list the same way `newly-listed-devices` did. A shelf that
-- means "look at this" cannot gate a search, because nothing about an item makes
-- it belong there — someone decided it did.
-- ============================================================================

-- --- 1. the shelf that is not a category ------------------------------------
-- ⚠️ A rule pointing here would start failing the picker's own validation
-- (matchableShelves() filters matchable=is.true and the apply path checks
-- against it), so refuse to run rather than leave a rule that can never file.
do $$
declare n int;
begin
  select count(*) into n from collection_rules
   where active and target_handle = 'paymore-finds';
  if n > 0 then
    raise exception 'STOP: % active collection_rules target paymore-finds. '
      'Re-point them before making it unmatchable, or the queue will offer a '
      'shelf the apply path refuses.', n;
  end if;
end $$;

update shopify_collections set matchable = false where handle = 'paymore-finds';

-- Any Call Back type filed under it would become unreachable, so move them
-- rather than orphan them. (Expected: zero rows — it has none, which is half
-- the reason it turned up in this audit.)
update callback_types set collection_handle = 'other'
 where collection_handle = 'paymore-finds';

-- --- 2. words for the two real shelves --------------------------------------
-- needs_item_text follows the rule the matcher documents: a type is either THE
-- ANSWER or JUST A SHELF. "HDMI Cable" is an answer — any HDMI cable answers a
-- want for one. "AV Receiver" is an answer too. "Mount / Bracket" is a shelf:
-- there are twenty kinds and the customer's own words have to land on the title.
insert into callback_types (collection_handle, name, keywords, needs_item_text, sort_order) values
  -- Audio/Video Accessories — cables, remotes, mounts, switchers -------------
  ('audio-video-accessories','HDMI Cable',            array['hdmi cable','hdmi'],                          false, 1),
  ('audio-video-accessories','Audio Cable / Adapter', array['aux cable','rca cable','optical cable','toslink','audio adapter','3.5mm'], false, 2),
  ('audio-video-accessories','Display Cable',         array['displayport','display port','dvi','vga cable'], false, 3),
  ('audio-video-accessories','HDMI Switch / Splitter',array['hdmi switch','hdmi splitter','video switcher','matrix switcher'], false, 4),
  ('audio-video-accessories','Remote Control',        array['remote control','universal remote','tv remote'], true,  5),
  ('audio-video-accessories','AV Receiver',           array['av receiver','stereo receiver','surround receiver'], false, 6),
  ('audio-video-accessories','TV Mount / Bracket',    array['tv mount','wall mount','tv bracket'],         true,  7),
  ('audio-video-accessories','Streaming Device',      array['roku','fire stick','chromecast','apple tv','streaming stick'], true, 8),
  ('audio-video-accessories','Capture Card',          array['capture card','elgato'],                      false, 9),
  ('audio-video-accessories','Antenna',               array['tv antenna','hd antenna','digital antenna'],  false, 10),
  ('audio-video-accessories','AV Controller',         array['av controller','control processor','elan','crestron','control4'], true, 11),

  -- Marine Electronics -------------------------------------------------------
  ('marine-electronics','Fish Finder',                array['fish finder','fishfinder','depth finder'],    false, 1),
  ('marine-electronics','Chartplotter / GPS',         array['chartplotter','marine gps','marine navigation'], false, 2),
  ('marine-electronics','Marine Radio',               array['vhf radio','marine radio','marine vhf'],      false, 3),
  ('marine-electronics','Trolling Motor',             array['trolling motor'],                             false, 4),
  ('marine-electronics','Marine Stereo / Speakers',   array['marine stereo','marine speakers','boat stereo'], false, 5),
  ('marine-electronics','Transducer',                 array['transducer','sonar transducer'],              false, 6),
  ('marine-electronics','Garmin / Humminbird / Lowrance', array['garmin','humminbird','lowrance','minn kota'], true, 7)
on conflict do nothing;

-- --- 3. the invariant, asserted -------------------------------------------
-- `other` is the only matchable shelf allowed to have no words. If this fires,
-- a shelf somebody can pick has no way for a customer to ask for it.
do $$
declare bad text;
begin
  select string_agg(c.handle, ', ') into bad
    from shopify_collections c
   where c.matchable
     and c.handle <> 'other'
     and not exists (select 1 from callback_types t where t.collection_handle = c.handle);
  if bad is not null then
    raise exception 'A pickable shelf has no customer vocabulary: %', bad;
  end if;
end $$;
