-- ============================================================================
-- 0054_strong_rules_and_misfiled — which rules are safe to point at stock that
-- is ALREADY FILED, and the second queue that uses them.
--
-- Pointed at the whole catalogue, the rule set flags 421 in-stock products —
-- and sampling them, most are the RULES being wrong, not the filing:
--
--   "2019 Apple MacBook Pro 16in i9 2.3GHz 16GB RAM 1TB SSD"   -> Storage
--   "LIAN LI Ryzen 5 8400F 16GB RAM RTX 4060 TI with Keyboard" -> Accessories
--   "Frostpunk: Console Edition (Xbox One, 2019)"              -> Game Systems
--
-- The rules were tuned on a pile where THE TITLE IS THE ITEM. Every laptop,
-- MacBook and gaming PC recites its RAM, SSD and GPU, so a bare keyword match
-- reads a spec as a product. That is harmless inside `other` (a bare "WD Green
-- 2TB HDD" really is a drive) and useless everywhere else.
--
-- `strong` marks the rules whose keyword names the ITEM and is essentially
-- never a spec mention. Only those are scored against already-filed stock,
-- which takes 421 flags down to 21 — and those are real questions: 15
-- microphones under Speakers & Audio, three dash cams under Digital Cameras, a
-- SANYO VCR filed under BOTH DJ & Recording and Speakers & Audio.
--
-- Two of the 21 are the rule being wrong ("NETGEAR Arlo Motion Sensor Light"
-- is smart home, not networking; "Viture Luma XR Projector Smart Glasses" is
-- not a projector). That ratio is why this is a review queue and never a sweep.
--
-- `wrong_handles` is what filing it makes the product LEAVE: every real
-- collection it currently sits in, `newly-listed-devices` excepted, because
-- that one is a smart collection holding every product at every store.
-- ⚠️ This is the queue that can take a product OFF a shelf a person chose, so
-- it exists only behind a human clicking File It, one row at a time.
-- ============================================================================

alter table collection_rules add column if not exists strong boolean not null default false;

update collection_rules set strong = true where keyword in (
  'projector','camcorder','film camera','instant camera','polaroid','instax','handycam',
  'hearing aid','hearing aid charger','for hearing aids','charge & go','receiver-in-canal',
  'signia','oticon','massage gun',
  'walkie','two way radio','rangefinder','binoculars','monocular',
  'traxxas','rc car','rc truck','remote controlled',
  'dash cam','radar detector','radar scanner','car stereo','car audio speaker',
  'turntable','record player','cassette deck','dvd player','dvd recorder','vcr',
  'soundbar','subwoofer','av receiver','sonos',
  'microphone','audio interface','dj controller','di-box','in-ear monitor','studio monitor',
  'thermostat','doorbell','smart lock','smoke alarm','robot vacuum','curtain lights',
  'watering timer','nest cam','security camera','security cam','outdoor camera',
  'router','access point','poe switch','network switch','ethernet switch','managed switch',
  'desktop switch','scalable switch','firewall','cable modem','mobile hotspot','starlink',
  'meraki','netgear','linksys','ubiquiti','tp-link','aruba instant on','patch panel',
  'label maker','shredder','office phone','desk phone','check scanner','kiosk',
  '3d printer','arduino','raspberry pi','microcontroller','graphing calculator',
  'gimbal','handheld stabilizer','monolight','speedlight','speedlite','shoe mount flash',
  'label printer','laserjet','officejet','toner','ink cartridge',
  'lorcana','kindle','chromebook','thinkcentre','optiplex','apple pencil','airtag',
  'milwaukee','milwalkee','dewalt','ryobi','makita','husqvarna','heat gun','band saw',
  'knockout tool','hand grinder','oscillating multi','fitbit','oura','smart ring'
);

create or replace view collection_misfiled as
with pile as (
  select distinct on (store_code, product_id)
         store_code, product_id, sku, title, product_handle, collections
  from ebay_catalog
  where quantity > 0
    and not ('other' = any(collections))
    and cardinality(array(
          select c from unnest(collections) c where c <> 'newly-listed-devices'
        )) >= 1
  order by store_code, product_id, sku
), scored as (
  select p.store_code, p.product_id, p.sku, p.title, p.product_handle, p.collections,
         r.keyword, r.target_handle,
         row_number() over (
           partition by p.store_code, p.product_id
           order by length(r.keyword) desc, r.keyword
         ) rn
  from pile p
  join collection_rules r
    on r.active and r.strong
   and case when position(r.keyword in lower(p.title)) > 0
            then lower(p.title) ~ r.pattern
            else false end
)
select s.store_code, s.product_id, s.sku, s.title, s.product_handle,
       s.keyword, s.target_handle,
       array(select c from unnest(s.collections) c
              where c <> 'newly-listed-devices' and c <> s.target_handle) wrong_handles
from scored s
where s.rn = 1
  and not (s.target_handle = any(s.collections))
  and not exists (select 1 from collection_skips k
                   where k.store_code = s.store_code and k.product_id = s.product_id)
  and not exists (select 1 from collection_moves m
                   where m.store_code = s.store_code and m.product_id = s.product_id
                     and m.undone_at is null);

revoke all on collection_misfiled from anon, authenticated;
