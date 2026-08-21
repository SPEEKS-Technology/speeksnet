-- ============================================================================
-- 0049_collection_rules_seed — the keyword→collection map, v1.
--
-- Derived from the 457 in-stock units sitting in `other` and nothing else,
-- read title by title rather than guessed. Notes on individual rules record
-- the title that forced them, because several look arbitrary until you see it.
--
-- THE TRAPS, all of them real titles from the pile:
--   · `controller`   — "Johnson Control Fec2611 Field Equipment Controller",
--                      "Mercury Security Intelligent Controller Board",
--                      "Crestron Control Processor". A bare `controller` rule
--                      files commercial building automation as a game pad, so
--                      there is none: only `gaming controller`, the brands
--                      that make nothing else, and the specific shapes.
--   · `stabilizer`   — "Monster Power AVS 2000 Automatic Voltage Stabilizer"
--                      is a power conditioner, not a camera gimbal. Hence
--                      `handheld stabilizer` and `gimbal`, never `stabilizer`.
--   · `quest`        — "Lorcana Illumineer's Quest" is a card game, so VR is
--                      reached by `meta quest` / `oculus` / `vive`.
--   · `tracker`      — "htc VIVE Tracker" outranks GPS only because
--                      `motion tracker` and `vr tracker` are longer.
--   · `tv`           — "TV Games", "TV Streamer For Wireless Hearing Aids",
--                      "Bose TV Speaker". Televisions is reached by
--                      `television` and `smart tv` only.
--   · `pokemon`      — ties with `power-a` on length ("POWER-A CONTROLLER
--                      POKEMON MEGA EVOLUTIONS"), so the card rules are
--                      `pokemon card` / `pokemon tcg` / `pokemon booster`.
--   · `milwalkee`    — five units are spelled that way. The misspelling is the
--                      rule; correcting the titles is the store's job.
--
-- TWO JUDGEMENT CALLS worth knowing about, because neither is obviously right:
--   · PROJECTORS (18 units) go to Monitors & Displays. PayMore has no
--     Projectors collection, and a projector is a display.
--   · HEARING AIDS (15 units) go to Health & Beauty, which exists and is
--     empty. The alternative is a new collection, which is a franchise
--     decision, not ours.
--   · DRIVES (SSD/HDD/NVMe/external) go to Memory Cards & Storage rather than
--     Computer Parts, so that all storage is on one shelf. RAM, boards, PSUs,
--     coolers, fans and cases stay in Computer Parts.
-- ============================================================================

insert into collection_rules (keyword, target_handle, note) values
  -- Networking -------------------------------------------------------------
  ('router',              'networking',   null),
  ('cable modem',         'networking',   null),
  ('access point',        'networking',   null),
  ('poe switch',          'networking',   null),
  ('gigabit switch',      'networking',   null),
  ('ethernet switch',     'networking',   null),
  ('network switch',      'networking',   null),
  ('managed switch',      'networking',   'also catches "Unmanaged Switch"'),
  ('desktop switch',      'networking',   null),
  ('layer 2 switch',      'networking',   null),
  ('layer 3 switch',      'networking',   null),
  ('scalable switch',     'networking',   null),
  ('firewall',            'networking',   null),
  ('patch panel',         'networking',   null),
  ('patch cord',          'networking',   'bag of Cat 6 patch cords'),
  ('ethernet cable',      'networking',   null),
  ('cisco',               'networking',   null),
  ('meraki',              'networking',   null),
  ('netgear',             'networking',   null),
  ('linksys',             'networking',   null),
  ('ubiquiti',            'networking',   null),
  ('unifi',               'networking',   'word boundary is what keeps "Unified Storage Array" out'),
  ('tp-link',             'networking',   null),
  ('aruba instant on',    'networking',   null),
  ('mobile hotspot',      'networking',   null),
  ('starlink',            'networking',   null),

  -- Cameras & lenses --------------------------------------------------------
  ('35mm',                'digital-cameras-lenses', null),
  ('film camera',         'digital-cameras-lenses', null),
  ('slr',                 'digital-cameras-lenses', null),
  ('dslr',                'digital-cameras-lenses', null),
  ('mirrorless',          'digital-cameras-lenses', null),
  ('digital camera',      'digital-cameras-lenses', null),
  ('video camera',        'digital-cameras-lenses', null),
  ('cinema camera',       'digital-cameras-lenses', null),
  ('action camera',       'digital-cameras-lenses', null),
  ('thermal camera',      'digital-cameras-lenses', null),
  ('camcorder',           'digital-cameras-lenses', null),
  ('handycam',            'digital-cameras-lenses', null),
  ('instant camera',      'digital-cameras-lenses', null),
  ('polaroid',            'digital-cameras-lenses', null),
  ('instax',              'digital-cameras-lenses', null),
  ('minolta',             'digital-cameras-lenses', null),
  ('pentax',              'digital-cameras-lenses', null),
  ('gopro',               'digital-cameras-lenses', null),
  ('speedlight',          'digital-cameras-lenses', 'Canon shoe-mount flash'),
  ('speedlite',           'digital-cameras-lenses', 'Canon spells it both ways'),
  ('shoe mount flash',    'digital-cameras-lenses', null),
  ('external flash',      'digital-cameras-lenses', null),
  ('lens filter',         'digital-cameras-lenses', null),
  ('filter kit',          'digital-cameras-lenses', null),
  ('conversion lens',     'digital-cameras-lenses', null),
  ('telephoto',           'digital-cameras-lenses', null),
  ('wide angle lens',     'digital-cameras-lenses', null),
  ('gimbal',              'digital-cameras-lenses', 'DJI Osmo/Ronin — camera gear, not a drone'),
  ('handheld stabilizer', 'digital-cameras-lenses', null),
  ('monolight',           'digital-cameras-lenses', null),
  ('dji osmo',            'digital-cameras-lenses', null),
  ('dji pocket',          'digital-cameras-lenses', null),

  -- Computer accessories ----------------------------------------------------
  ('keyboard',            'computer-accessories', null),
  ('mouse',               'computer-accessories', null),
  ('mousepad',            'computer-accessories', null),
  ('webcam',              'computer-accessories', null),
  ('web cam',             'computer-accessories', 'Logitech MX Brio is titled "Web Cam"'),
  ('docking station',     'computer-accessories', null),
  ('dock',                'computer-accessories', 'a separate rule: "dock" does not match "docking"'),
  ('laptop dock',         'computer-accessories', null),
  ('usb hub',             'computer-accessories', null),
  ('usb-c dock',          'computer-accessories', null),
  ('kvm',                 'computer-accessories', null),
  ('scanner',             'computer-accessories', null),
  ('screen protector',    'computer-accessories', null),
  ('stream deck',         'computer-accessories', 'Elgato macro pad'),
  ('macro pad',           'computer-accessories', null),
  ('phone mount',         'computer-accessories', null),
  ('dvd writer',          'computer-accessories', 'a PC peripheral; a DVD *player* is physical media'),
  ('dvd drive',           'computer-accessories', null),
  ('optical drive',       'computer-accessories', null),
  ('hdmi cable',          'computer-accessories', null),
  ('display port cable',  'computer-accessories', null),

  -- Computer parts ----------------------------------------------------------
  ('cpu',                 'computer-parts', null),
  ('cpu cooler',          'computer-parts', null),
  ('motherboard',         'computer-parts', null),
  ('graphics card',       'computer-parts', null),
  ('gpu',                 'computer-parts', null),
  ('radeon',              'computer-parts', null),
  ('geforce',             'computer-parts', null),
  ('power supply',        'computer-parts', null),
  ('psu',                 'computer-parts', null),
  ('case fan',            'computer-parts', null),
  ('pc fan',              'computer-parts', null),
  ('fan hub',             'computer-parts', null),
  ('heatsink',            'computer-parts', null),
  ('pc case',             'computer-parts', null),
  ('itx case',            'computer-parts', null),
  ('lian li',             'computer-parts', 'cases and fans only'),
  ('nzxt',                'computer-parts', null),
  ('noctua',              'computer-parts', null),
  ('asrock',              'computer-parts', null),
  ('wireless card',       'computer-parts', 'internal PCIe/M.2 — not networking gear'),
  ('wifi card',           'computer-parts', null),
  ('network card',        'computer-parts', null),
  ('capture card',        'computer-parts', null),
  ('pcie',                'computer-parts', null),

  -- Storage -----------------------------------------------------------------
  ('memory card',         'memory-cards-storage', null),
  ('microsd',             'memory-cards-storage', null),
  ('micro sd',            'memory-cards-storage', null),
  ('sd card',             'memory-cards-storage', null),
  ('sd adapter',          'memory-cards-storage', null),
  ('flash drive',         'memory-cards-storage', null),
  ('thumb drive',         'memory-cards-storage', null),
  ('hard drive',          'memory-cards-storage', null),
  ('external hard drive', 'memory-cards-storage', null),
  ('hdd',                 'memory-cards-storage', null),
  ('ssd',                 'memory-cards-storage', null),
  ('nvme',                'memory-cards-storage', null),
  ('my passport',         'memory-cards-storage', null),
  ('storage array',       'memory-cards-storage', null),
  ('ultrium',             'memory-cards-storage', 'LTO tape'),

  -- Displays ----------------------------------------------------------------
  ('monitor',             'monitors-displays', null),
  ('projector',           'monitors-displays', 'no Projectors collection exists; a projector is a display'),
  ('color calibrator',    'monitors-displays', null),
  ('television',          'monitors-displays', null),
  ('smart tv',            'televisions', null),
  ('led tv',              'televisions', null),
  ('oled tv',             'televisions', null),

  -- Print -------------------------------------------------------------------
  ('printer',             'printers', null),
  ('laserjet',            'printers', null),
  ('officejet',           'printers', null),
  ('toner',               'ink-toner', null),
  ('ink cartridge',       'ink-toner', null),

  -- Audio -------------------------------------------------------------------
  ('speaker',             'speakers-audio', null),
  ('soundbar',            'speakers-audio', null),
  ('receiver',            'speakers-audio', null),
  ('av receiver',         'speakers-audio', null),
  ('amplifier',           'speakers-audio', null),
  ('subwoofer',           'speakers-audio', null),
  ('turntable',           'speakers-audio', null),
  ('record player',       'speakers-audio', null),
  ('cd player',           'speakers-audio', null),
  ('disc changer',        'speakers-audio', null),
  ('cassette deck',       'speakers-audio', null),
  ('stereo',              'speakers-audio', null),
  ('tuner',               'speakers-audio', null),
  ('sonos',               'speakers-audio', null),
  ('headphones',          'headphones', null),
  ('earbuds',             'headphones', null),
  ('headset',             'headphones', null),
  ('beyerdynamic',        'headphones', 'they make nothing else'),
  ('audio interface',     'dj-recording-equipment', null),
  ('microphone',          'dj-recording-equipment', null),
  ('dj controller',       'dj-recording-equipment', null),
  ('mixer',               'dj-recording-equipment', null),
  ('di-box',              'dj-recording-equipment', null),
  ('studio monitor',      'dj-recording-equipment', 'beats the bare `monitor` rule on length'),
  ('car audio speaker',   'car-electronics-audio', 'beats `speaker` on length'),
  ('car stereo',          'car-electronics-audio', null),
  ('dash cam',            'car-electronics-audio', null),
  ('radar detector',      'car-electronics-audio', null),
  ('radar scanner',       'car-electronics-audio', null),
  ('jump starter',        'car-electronics-audio', null),

  -- Smart home & health -----------------------------------------------------
  ('thermostat',          'smart-home', null),
  ('doorbell',            'smart-home', null),
  ('smart lock',          'smart-home', null),
  ('security camera',     'smart-home', null),
  ('security cam',        'smart-home', null),
  ('outdoor camera',      'smart-home', null),
  ('smart bulb',          'smart-home', null),
  ('curtain lights',      'smart-home', null),
  ('smoke alarm',         'smart-home', null),
  ('watering timer',      'smart-home', null),
  ('smart plug',          'smart-home', null),
  ('nest cam',            'smart-home', null),
  ('smart home controller','smart-home', 'Control4 — residential automation, so this one does belong'),
  ('home controller',     'smart-home', null),
  ('robot vacuum',        'appliances', null),
  ('hearing aid',         'health-beauty', 'Health & Beauty exists and is empty; a new collection is a franchise call'),
  ('hearing device',      'health-beauty', null),
  ('hearing aid charger', 'health-beauty', 'must outrank `charger`'),
  ('signia',              'health-beauty', 'hearing aids only'),
  ('oticon',              'health-beauty', null),
  ('massage gun',         'health-beauty', null),

  -- Wearables ---------------------------------------------------------------
  ('fitbit',              'smart-watches-fitness', null),
  ('smart ring',          'smart-watches-fitness', null),
  ('fitness tracker',     'smart-watches-fitness', null),
  ('fitness watch',       'smart-watches-fitness', null),
  ('activity tracker',    'smart-watches-fitness', null),
  ('smartwatch',          'smart-watches-fitness', null),
  ('smart watch',         'smart-watches-fitness', null),
  ('oura',                'smart-watches-fitness', null),

  -- Power -------------------------------------------------------------------
  ('charger',             'charging-power', null),
  ('wall charger',        'charging-power', null),
  ('power adapter',       'charging-power', null),
  ('power bank',          'charging-power', null),
  ('charging station',    'charging-power', null),
  ('charging stand',      'charging-power', null),
  ('wireless charger',    'charging-power', null),
  ('ups',                 'charging-power', null),
  ('battery',             'charging-power', null),
  ('battery case',        'charging-power', null),
  ('surge protector',     'charging-power', null),
  ('voltage stabilizer',  'charging-power', 'NOT a gimbal — see the header'),

  -- Physical media ----------------------------------------------------------
  ('dvd player',          'movies-physical-media', null),
  ('dvd recorder',        'movies-physical-media', null),
  ('blu-ray player',      'movies-physical-media', null),
  ('vcr',                 'movies-physical-media', null),
  ('cassette recorder',   'movies-physical-media', null),

  -- Games -------------------------------------------------------------------
  ('gaming controller',   'video-game-accessories', null),
  ('game controller',     'video-game-accessories', null),
  ('wireless controller', 'video-game-accessories', null),
  ('backbone one',        'video-game-accessories', null),
  ('kishi',               'video-game-accessories', null),
  ('power-a',             'video-game-accessories', null),
  ('dualsense',           'video-game-accessories', null),
  ('dualshock',           'video-game-accessories', null),
  ('joy-con',             'video-game-accessories', null),
  ('racing wheel',        'video-game-accessories', null),
  ('servo base',          'video-game-accessories', 'Thrustmaster wheel base'),
  ('arcade stick',        'video-game-accessories', null),
  ('skylanders',          'video-game-accessories', null),
  ('action replay',       'video-game-accessories', null),
  ('console',             'video-game-systems', null),
  ('handheld console',    'video-game-systems', null),
  ('dreamcast',           'video-game-systems', null),
  ('turbografx',          'video-game-systems', null),
  ('steam deck',          'video-game-systems', null),
  ('game boy',            'video-game-systems', null),
  ('tabletop arcade',     'video-game-systems', null),
  ('meta quest',          'virtual-reality', null),
  ('oculus',              'virtual-reality', null),
  ('vive',                'virtual-reality', null),
  ('motion tracker',      'virtual-reality', 'must outrank `tracker`'),
  ('vr tracker',          'virtual-reality', null),
  ('vr headset',          'virtual-reality', null),
  ('virtual reality',     'virtual-reality', null),

  -- Tools, optics, tracking -------------------------------------------------
  ('milwaukee',           'power-tools-equipment', null),
  ('milwalkee',           'power-tools-equipment', 'five units are spelled this way'),
  ('dewalt',              'power-tools-equipment', null),
  ('ryobi',               'power-tools-equipment', null),
  ('makita',              'power-tools-equipment', null),
  ('husqvarna',           'power-tools-equipment', null),
  ('heat gun',            'power-tools-equipment', null),
  ('band saw',            'power-tools-equipment', null),
  ('knockout tool',       'power-tools-equipment', null),
  ('oscillating multi',   'power-tools-equipment', null),
  ('screwdriver',         'power-tools-equipment', null),
  ('screw driver',        'power-tools-equipment', null),
  ('hand grinder',        'power-tools-equipment', null),
  ('rangefinder',         'optics', null),
  ('binoculars',          'optics', null),
  ('monocular',           'optics', null),
  ('gps',                 'gps-tracking-devices', null),
  ('fleet tracker',       'gps-tracking-devices', null),
  ('airtag',              'gps-tracking-devices', null),
  ('walkie',              'two-way-radios-communication', null),
  ('two way radio',       'two-way-radios-communication', null),

  -- Everything else that has a shelf ---------------------------------------
  ('traxxas',             'remote-controlled-rc-vehicles', null),
  ('rc car',              'remote-controlled-rc-vehicles', null),
  ('rc truck',            'remote-controlled-rc-vehicles', null),
  ('remote controlled',   'remote-controlled-rc-vehicles', null),
  ('lorcana',             'lorcana-trading-cards', null),
  ('pokemon card',        'pokemon-trading-cards', null),
  ('pokemon tcg',         'pokemon-trading-cards', null),
  ('pokemon booster',     'pokemon-trading-cards', null),
  ('kindle',              'android-other-tablets', null),
  ('fire tablet',         'android-other-tablets', null),
  ('galaxy tab',          'android-other-tablets', null),
  ('chromebook',          'laptops', null),
  ('thinkcentre',         'windows-desktop-aio', null),
  ('optiplex',            'windows-desktop-aio', null),
  ('all-in-one pc',       'windows-desktop-aio', null),
  ('office phone',        'office-equipment', null),
  ('desk phone',          'office-equipment', null),
  ('shredder',            'office-equipment', null),
  ('label maker',         'office-equipment', null),
  ('label printer',       'printers', null),
  ('check scanner',       'office-equipment', null),
  ('kiosk',               'pos-systems-retail-equipment', null),
  ('roku',                'streaming', null),
  ('fire stick',          'streaming', null),
  ('chromecast',          'streaming', null),
  ('apple pencil',        'apple-genuine-accessories', null),
  ('magic keyboard',      'apple-genuine-accessories', 'must outrank `keyboard`'),
  ('graphing calculator', 'graphing-calculators', null),
  ('arduino',             'single-board-computers-sbcs', null),
  ('raspberry pi',        'single-board-computers-sbcs', null),
  ('microcontroller',     'single-board-computers-sbcs', null)
on conflict (keyword) do update
  set target_handle = excluded.target_handle,
      note          = excluded.note,
      active        = true;

-- ----------------------------------------------------------------------------
-- The corrections the first audit forced. Every one of these was found by
-- reading all 383 proposals the v1 rules produced, not by thinking harder:
-- a shorter keyword had won a title it had no business winning.
--
-- `base station` is a DELETION rather than a correction: it existed for the
-- HTC Vive lighthouse, which already matches `vive`, and its only other victim
-- was a ReSound hearing-aid charger. Removing the over-broad rule beat adding
-- a counter-rule to fight it.
--
-- STILL WRONG, on purpose: "Cyberpower CPS1500AVRa 1500AVR Power Supply" is a
-- UPS and lands in Computer Parts, because nothing in that title outranks
-- `power supply` without inventing a rule for one unit. It is a power supply
-- either way.
-- ----------------------------------------------------------------------------
insert into collection_rules (keyword, target_handle, note) values
  ('receiver-in-canal',        'health-beauty',           'a Signia RIC hearing aid, not an AV receiver'),
  ('for hearing aids',         'health-beauty',           'Oticon ConnectLine TV adapter'),
  ('charge & go',              'health-beauty',           'Signia/MiracleEar hearing aids; must outrank `charger`'),
  ('in-ear monitor',           'dj-recording-equipment',  'must outrank `monitor`'),
  ('hard drive docking station','memory-cards-storage',   'must outrank `docking station`'),
  ('uninterrupted power supply','charging-power',         'a UPS, not a PC power supply'),
  ('3d printer',               'crafting-machines-tools', 'must outrank `printer`'),
  ('personal computer',        'other',                   'VETO: a vintage Apple IIe with a keyboard in the title'),
  ('desktop computer',         'other',                   'VETO: a vintage Kaypro 286i. Not a Windows desktop.')
on conflict (keyword) do update
  set target_handle = excluded.target_handle,
      note          = excluded.note,
      active        = true;

delete from collection_rules where keyword = 'base station';
