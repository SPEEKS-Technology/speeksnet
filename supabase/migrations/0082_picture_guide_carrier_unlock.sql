-- Picture Guide: say "carrier" on the carrier-unlock shot.
--
-- The Android Smart Tablets sheet seeded this shot as:
--
--     label       Setting Unlock Screen
--     cond_label  Unlock screen set
--     note        Setting Unlock Screen
--
-- and nowhere in those three columns does the word "carrier" appear. Read cold,
-- "unlock screen" is the PIN or pattern on the lock screen, which is a different
-- photograph proving a different thing — and the two readings point opposite
-- ways, because a locked device is a problem and a carrier-unlocked one is a
-- selling point. A lister who guesses wrong photographs the wrong screen and the
-- listing goes up missing the thing a buyer actually pays for.
--
-- What it always meant: the settings screen showing the tablet is CARRIER
-- unlocked. So the row now says that.
--
-- The condition changes with it. "Unlock screen set" was written as a label — a
-- noun phrase, not something that is true or false about the tablet in the
-- lister's hand — and the board renders a condition as "Only if <condition>", so
-- it came out as "Only if unlock screen set". The thing that actually decides
-- whether this shot applies is whether the tablet has a carrier at all: a
-- Wi-Fi-only model has none, so there is no status to photograph.
--
-- The note is the words printed on the grey slot until a real example photo is
-- uploaded. It used to repeat the label verbatim, which put the card's own title
-- in the middle of its own picture; now it tells the lister which screen to open.
--
-- Matched on the old label rather than on id 12, so this is safe to run against
-- any environment and safe to run twice — a database already corrected matches
-- nothing and the update is a no-op.

update public.pg_shots
set label      = 'Carrier Unlock Status',
    cond_label = 'The tablet is a cellular model',
    note       = 'Settings screen showing carrier unlocked',
    updated_at = now()
where label = 'Setting Unlock Screen'
  and category_id in (select id from public.pg_categories where slug = 'android-tablets');
