-- ============================================================================
-- 0063 — 0062 missed the three Game Boy types.
--
-- Its guard was `name !~* '\ygames?\y'`, which reads "leave anything that already
-- says Game or Games ANYWHERE in the name". "Nintendo Game Boy" says Game in the
-- middle, so it was spared — and it is exactly the kind of name 0062 exists to
-- disambiguate: a Game Boy is a console, and that type is the shelf for its
-- cartridges.
--
-- The test is the TRAILING word. "PC Game" still ends in Game and is still left
-- alone, correctly.
-- ============================================================================

update callback_types
   set name = name || ' Games'
 where collection_handle = 'video-games'
   and name !~* '\ygames?$';
