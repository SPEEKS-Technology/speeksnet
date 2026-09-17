-- 0091 — a person's hours, per person, and the day length that follows from them
--
-- WHY
-- The capacity model had two hour figures that never agreed.
--
--   The WEEKLY goal used real per-person hours: weeklyHoursFor() in the
--   store-targets function read employment_type / can_float and looked up
--   hours_full_time (40), hours_part_time (20) or hours_floater (25).
--
--   The DAILY goal used a flat listing_config.hours_per_day = 8 for EVERY
--   person, full-time or not. ListingGoalsEngine.goalFor() in speeks.js has no
--   idea who it is computing for beyond the new-hire ramp.
--
-- So a floater budgeted 25 hours a week was handed five 8-hour days, and a
-- part-timer budgeted 20 was handed the same day as a full-timer. Both showed
-- 18 on a lister day, exactly like the people on 40 hours.
--
-- That is not cosmetic. `Staffed For` on the DM's efficiency table is the SUM OF
-- THE DAILY GOALS, so the inflation lands straight in the denominator of the
-- efficiency ratio every store is judged on. The giveaway in the live data:
-- MPL and WSP, the only two stores with neither a part-timer nor a floater,
-- were the two reading sensibly; OVL, which has both, read 42%.
--
-- THE FIX
-- Two nullable columns on users. Shift length is DERIVED from them —
--
--     shift_hours = weekly_hours / days_per_week
--
-- — rather than being a third typed number, so the daily and weekly halves of
-- the model cannot drift apart again. Both figures are things a manager reads
-- straight off the schedule ("ten hours, two days"), which is why this shape was
-- chosen over storing weekly hours and shift length side by side: those two can
-- contradict each other silently, which is the failure being retired here.
--
-- NULL means "use the default for this person's employment type", so every row
-- that is not an exception keeps working with nothing typed into it.

ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_hours  INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS days_per_week INTEGER;

COMMENT ON COLUMN users.weekly_hours IS
  'Scheduled hours per week. NULL = the listing_config default for this person''s employment_type / can_float.';
COMMENT ON COLUMN users.days_per_week IS
  'Days present in a week. NULL = the listing_config default. weekly_hours / this = the shift length a daily listing goal is built from.';

-- Default days present, per employment type. These exist so the DERIVED shift
-- length lands on a sane number for someone nobody has typed hours for:
--
--   full-time  40 / 5 = 8h   — the store is open 6 days, a full-timer works 5
--                              (this is what days_off_full_time = 1 already said)
--   part-time  20 / 4 = 5h   — a part-timer works shorter days more often, not
--                              fewer whole ones
--   floater    25 / 5 = 5h   — the user's own description of the role: "if not
--                              at 40 hours per week will more than likely be at
--                              the 25 hours per week at 5 hours a day"
INSERT INTO listing_config (key, value, note) VALUES
  ('days_full_time', '5',
   'Days present in a week for a full-timer. weekly hours / this = shift length. Store is open 6 days; a full-timer works 5 of them, staggered across the team.'),
  ('days_part_time', '4',
   'Days present in a week for a part-timer. 20h / 4 = a 5-hour day — a part-timer works shorter days more often rather than fewer whole ones. Override per person with users.days_per_week.'),
  ('days_floater', '5',
   'Days present in a week for a floater. 25h / 5 = a 5-hour day, which is how the role is actually scheduled (user, 2026-09-17).'),
  ('max_shift_hours', '12',
   'Ceiling on a derived shift length, so a mistyped 40h / 2 days cannot hand one person a 20-hour day''s worth of goal.')
ON CONFLICT (key) DO NOTHING;

-- hours_per_day stays, and stays at 8, but it is no longer the day length every
-- goal is built from — it is now only the fallback for a person with no hours of
-- their own AND no default for their type. Say so, so the next reader does not
-- take the old note at its word.
UPDATE listing_config
   SET note = 'Fallback shift length, in clock hours. Since 0091 a shift is weekly_hours / days_per_week per person; this only stands in when neither is resolvable.'
 WHERE key = 'hours_per_day';

-- The one exception we already know about (user, 2026-09-17): Kaden at OVL is a
-- part-timer on TEN hours, not the twenty the part-time default assumes, and he
-- works them as two five-hour days.
UPDATE users SET weekly_hours = 10, days_per_week = 2
 WHERE lower(trim(name)) = 'kaden lamothe';
