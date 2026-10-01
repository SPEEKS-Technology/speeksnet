-- Picture Guide: Cosmetic Flaws says what a cosmetic flaw is.
--
-- The words on a slot are what a lister has to go on until an example photo is
-- uploaded behind it, and "Cosmetic Flaws" alone is the card's own title read
-- back — it settles nothing about whether the scuff in front of them counts.
-- LCD Flaws already did this properly: "LCD Flaws (Bright Spots, Dark Spots,
-- etc.)". This is the same treatment for the shot next to it.
--
-- Three sheets were saying three different things:
--
--   android-tablets   null                                          (the label)
--   apple-watches     null                                          (the label)
--   processors        Cosmetic Flaws (Cracks, Heavy Scratching, etc.)
--
-- One wording across all three, because a lister who works two sheets in a
-- morning should not have to learn that the same shot means the same thing.
--
-- TITLE CASE ON EVERY WORD is the house style for these blocks, matching LCD
-- Flaws and the carrier-unlock note from 0082. It matters more than it looks:
-- these get read at arm's length off a shelf, and the fallback when a note is
-- absent is the label, which is already title case — so anything else makes one
-- card in a grid of sixteen look like a mistake.
--
-- Matched on the label rather than on ids, so this is safe to run anywhere and
-- safe to run twice.

update public.pg_shots
set note       = 'Cosmetic Flaws (Dings, Cracks, Scratches, etc.)',
    updated_at = now()
where label = 'Cosmetic Flaws'
  and note is distinct from 'Cosmetic Flaws (Dings, Cracks, Scratches, etc.)';
