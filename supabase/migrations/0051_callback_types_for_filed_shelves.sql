-- ============================================================================
-- 0050_callback_types_for_filed_shelves — vocabulary for the shelves the
-- recategoriser fills.
--
-- The Call Back quick-add makes Category REQUIRED, because the category is the
-- matcher's gate. Twenty categories held in-stock units and had NO types at
-- all, which means the row could be logged and then answered only by luck: a
-- customer asking for a router picked Networking, got an empty Type list, and
-- the matcher had nothing to require. Filing the `other` pile (0048/0049)
-- makes that worse before it makes it better — 43 routers and switches arrive
-- on a shelf with no words for them.
--
-- needs_item_text follows the rule the matcher already documents: a type is
-- either THE ANSWER or JUST A SHELF. "Router" is an answer — any router
-- answers a want for a router. "Cisco / Meraki" is a shelf, and so is every
-- brand, so the customer's own words have to land on the title as well.
--
-- Two categories are seeded with no stock behind them on purpose:
-- TELEVISIONS (0 products at every store, and people ask for TVs constantly)
-- and STREAMING. A call back logged against an empty shelf costs nothing and
-- answers itself the day one is taken in.
-- ============================================================================

insert into callback_types (collection_handle, name, keywords, needs_item_text, sort_order) values
  -- Networking — 43 units arriving, no words at all --------------------------
  ('networking','Router',                  array['router','wifi router','wireless router'], false, 1),
  ('networking','Wi-Fi Mesh System',       array['mesh','orbi','eero','deco'],              false, 2),
  ('networking','Network Switch',          array['network switch','ethernet switch','poe switch','managed switch','gigabit switch','desktop switch'], false, 3),
  ('networking','Access Point',            array['access point'],                           false, 4),
  ('networking','Modem',                   array['modem','cable modem'],                    false, 5),
  ('networking','Firewall / Appliance',    array['firewall','security appliance'],          false, 6),
  ('networking','Ethernet Cable',          array['ethernet cable','patch cord','cat 6','cat6'], false, 7),
  ('networking','Cisco / Meraki',          array['cisco','meraki'],                         true,  8),
  ('networking','Netgear',                 array['netgear'],                                true,  9),

  -- Hearing aids: 16 in stock, and a category nobody could ask for -----------
  ('health-beauty','Hearing Aids',         array['hearing aid','hearing aids','hearing device'], true, 1),
  ('health-beauty','Hearing Aid Charger',  array['hearing aid charger','charge & go'],      false, 2),
  ('health-beauty','Massage Gun',          array['massage gun'],                            false, 3),

  -- Storage ------------------------------------------------------------------
  ('memory-cards-storage','SD / Memory Card',   array['memory card','sd card'],             false, 1),
  ('memory-cards-storage','MicroSD Card',       array['microsd','micro sd'],                false, 2),
  ('memory-cards-storage','External Hard Drive',array['external hard drive','my passport','portable storage'], false, 3),
  ('memory-cards-storage','Internal SSD',       array['ssd','nvme'],                        true,  4),
  ('memory-cards-storage','Flash Drive',        array['flash drive','thumb drive','usb drive'], false, 5),

  -- Recording ----------------------------------------------------------------
  ('dj-recording-equipment','Audio Interface',  array['audio interface','scarlett','audiobox'], false, 1),
  ('dj-recording-equipment','Microphone',       array['microphone'],                        true,  2),
  ('dj-recording-equipment','Mixer',            array['mixer'],                             true,  3),
  ('dj-recording-equipment','Studio Monitor',   array['studio monitor','in-ear monitor'],   true,  4),
  ('dj-recording-equipment','DJ Controller',    array['dj controller'],                     true,  5),

  -- Print --------------------------------------------------------------------
  ('printers','Printer',                   array['printer','laserjet','officejet'],         true,  1),
  ('printers','Label Printer',             array['label printer','p-touch'],                false, 2),
  ('printers','Photo Printer',             array['photo printer','picture station'],        false, 3),
  ('ink-toner','Ink Cartridge',            array['ink cartridge'],                          true,  1),
  ('ink-toner','Toner Cartridge',          array['toner'],                                  true,  2),

  -- Physical media -----------------------------------------------------------
  ('movies-physical-media','DVD Player',       array['dvd player'],                         false, 1),
  ('movies-physical-media','Blu-ray Player',   array['blu-ray player','blu ray player'],    false, 2),
  ('movies-physical-media','VCR / DVD Recorder',array['vcr','dvd recorder','cassette recorder'], false, 3),

  -- Car ----------------------------------------------------------------------
  ('car-electronics-audio','Car Stereo / Head Unit', array['car stereo','head unit'],       false, 1),
  ('car-electronics-audio','Car Speakers',     array['car audio speaker','car speaker'],    false, 2),
  ('car-electronics-audio','Subwoofer / Amp',  array['subwoofer','amplifier'],              true,  3),
  ('car-electronics-audio','Dash Cam',         array['dash cam'],                           false, 4),
  ('car-electronics-audio','Radar Detector',   array['radar detector','radar scanner'],     false, 5),

  -- The small shelves --------------------------------------------------------
  ('office-equipment','Office Phone',       array['office phone','desk phone'],             true,  1),
  ('office-equipment','Label Maker',        array['label maker','letratag'],                false, 2),
  ('office-equipment','Shredder',           array['shredder'],                              false, 3),
  ('optics','Rangefinder',                  array['rangefinder'],                           false, 1),
  ('optics','Binoculars',                   array['binoculars','monocular'],                false, 2),
  ('two-way-radios-communication','Two-Way Radio', array['walkie','two way radio','walkie talkie'], false, 1),
  ('remote-controlled-rc-vehicles','RC Car / Truck', array['rc car','rc truck','traxxas','remote controlled'], true, 1),
  ('apple-imacs','iMac',                    array['imac'],                                  true,  1),
  ('appliances','Vacuum',                   array['vacuum','robot vacuum'],                 false, 1),
  ('crafting-machines-tools','3D Printer',  array['3d printer','prusa'],                    false, 1),
  ('crafting-machines-tools','Cricut',      array['cricut'],                                false, 2),
  ('single-board-computers-sbcs','Raspberry Pi', array['raspberry pi'],                     false, 1),
  ('single-board-computers-sbcs','Arduino', array['arduino','microcontroller'],             false, 2),
  ('pos-systems-retail-equipment','POS Terminal', array['pos terminal','kiosk','touchscreen'], true, 1),
  ('gps-tracking-devices','GPS Tracker',    array['gps','tracker'],                         true,  1),
  ('gps-tracking-devices','AirTag',         array['airtag'],                                false, 2),
  ('graphing-calculators','Graphing Calculator', array['graphing calculator','ti-84','ti-83'], false, 1),

  -- Seeded ahead of the stock, deliberately ----------------------------------
  ('televisions','Smart TV',                array['smart tv','led tv','oled tv'],           true,  1),
  ('televisions','Samsung',                 array['samsung'],                               true,  2),
  ('televisions','LG',                      array['lg '],                                   true,  3),
  ('televisions','TCL / Hisense',           array['tcl','hisense'],                         true,  4),
  ('streaming','Roku',                      array['roku'],                                  true,  1),
  ('streaming','Fire Stick',                array['fire stick','fire tv'],                  false, 2),
  ('streaming','Apple TV',                  array['apple tv'],                              false, 3),
  ('streaming','Chromecast',                array['chromecast'],                            false, 4),

  -- Shapes the filing creates on shelves that already had words --------------
  ('monitors-displays','Projector',         array['projector'],                             false, 50),
  ('digital-cameras-lenses','Film Camera',  array['film camera','35mm'],                    false, 50),
  ('digital-cameras-lenses','Camcorder',    array['camcorder','handycam'],                  false, 51),
  ('digital-cameras-lenses','Instant Camera', array['instant camera','polaroid','instax'],  false, 52),
  ('digital-cameras-lenses','Flash / Speedlite', array['speedlight','speedlite','shoe mount flash','external flash'], false, 53),
  ('digital-cameras-lenses','Gimbal / Stabilizer', array['gimbal','handheld stabilizer'],   false, 54),
  ('digital-cameras-lenses','Minolta',      array['minolta'],                               true,  55),
  ('speakers-audio','AV Receiver',          array['av receiver','receiver'],                false, 50),
  ('speakers-audio','Turntable / Record Player', array['turntable','record player'],        false, 51),
  ('speakers-audio','CD Player',            array['cd player','disc changer'],              false, 52),
  ('speakers-audio','Cassette Deck',        array['cassette deck'],                         false, 53),
  ('computer-accessories','Scanner',        array['scanner','scanjet'],                     false, 50),
  ('computer-accessories','Stream Deck',    array['stream deck','macro pad'],               false, 51),
  ('computer-accessories','DVD / Optical Drive', array['dvd drive','dvd writer','optical drive'], false, 52),
  ('computer-parts','Capture Card',         array['capture card'],                          false, 50),
  ('computer-parts','Wi-Fi / Network Card', array['wireless card','wifi card','network card'], false, 51),
  ('computer-parts','Case Fans',            array['case fan','pc fan'],                     false, 52),
  ('charging-power','UPS / Battery Backup', array['ups','uninterrupted power supply','battery backup'], false, 50),
  ('headphones','Earbuds',                  array['earbuds'],                               false, 50),
  ('smart-home','Thermostat',               array['thermostat'],                            false, 50),
  ('smart-home','Smart Lock',               array['smart lock'],                            false, 51),
  ('smart-home','Smoke / CO Alarm',         array['smoke alarm','co alarm'],                false, 52),
  ('virtual-reality','HTC Vive',            array['vive','htc vive'],                       true,  50)
on conflict do nothing;

-- Five units are titled "Milwalkee" and the store spells it that way on the
-- shop floor too, so the type has to answer to both.
update callback_types
   set keywords = array['milwaukee','milwalkee']
 where collection_handle = 'power-tools-equipment' and name = 'Milwaukee';

-- Shelves that hold nothing today but that people walk in and ask for. A call
-- back logged against an empty shelf costs nothing and answers itself the day
-- one is taken in — and Lorcana is about to hold a unit the filing puts there.
insert into callback_types (collection_handle, name, keywords, needs_item_text, sort_order) values
  ('apple-mac-minis','Mac mini',                       array['mac mini'],                     true, 1),
  ('apple-mac-studios','Mac Studio',                   array['mac studio'],                   true, 1),
  ('apple-mac-pros','Mac Pro',                         array['mac pro'],                      true, 1),
  ('apple-vision-pros','Vision Pro',                   array['vision pro'],                   false,1),
  ('lorcana-trading-cards','Sealed Product',           array['lorcana'],                      true, 1),
  ('magic-the-gathering-trading-cards','Sealed Product',array['magic the gathering','mtg'],   true, 1),
  ('yu-gi-oh-trading-cards','Sealed Product',          array['yu-gi-oh','yugioh'],            true, 1),
  ('one-piece-trading-cards','Sealed Product',         array['one piece'],                    true, 1),
  ('lego','LEGO Set',                                  array['lego'],                         true, 1),
  ('graded-video-games','Graded Game',                 array['graded','wata','vga'],          true, 1)
on conflict do nothing;

-- After this, every matchable collection has a type vocabulary EXCEPT `other`,
-- which deliberately has none: it is reachable only by a multi-word keyword,
-- because searching it for generic words returns hearing-aid chargers when a
-- customer asked for a charger. See the callback-match header, fact 2.
