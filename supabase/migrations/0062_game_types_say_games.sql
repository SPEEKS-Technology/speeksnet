-- ============================================================================
-- 0062 — the Video Games types say "Games", so a console cannot be logged onto
--        the games shelf by picking a name that reads the same.
--
-- WHAT WENT WRONG. A customer wanted a "PS5 Slim". It was logged as
-- Video Games -> Sony PlayStation 5, which is the shelf for PS5 *games*, and the
-- matcher duly searched the games collection for a console and found nothing —
-- forever, silently, while the same customer's neighbours on the list showed five
-- stores holding PS5s. The person choosing did nothing unreasonable: the dropdown
-- offered "Sony PlayStation 5" (games) and "Sony PlayStation 5 Console"
-- (systems), and the first one is what a PS5 is called.
--
-- Every console generation collides this way — PS2/3/4/5, Switch, Wii, Wii U,
-- N64, GameCube, NES, SNES, 3DS, Xbox 360, Xbox One (an EXACT duplicate name),
-- Xbox Original — so this is the class, not the instance.
--
-- WHY RENAMING IS SAFE. `callback_types.name` is display only. The matcher scores
-- against `keywords`, which is untouched here, so nothing about what matches what
-- changes — see the TypeDef read in callback-match. This is a label fix for the
-- human choosing, which is where the mistake was made.
--
-- The alternative was letting the matcher fall back to sibling collections when a
-- category yields nothing, and that was rejected: the category gate is the one
-- thing stopping a title-only guess from putting a customer on the phone about
-- the wrong item.
--
-- Idempotent: anything already saying Game or Games is left alone, which also
-- spares "PC Game".
-- ============================================================================

update callback_types
   set name = name || ' Games'
 where collection_handle = 'video-games'
   and name !~* '\ygames?\y';
