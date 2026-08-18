-- ============================================================
--  HER PUBLISHED WEEK — back to the practice's real hours
-- ------------------------------------------------------------
--  The Hours page is exercised by several suites, and each one
--  adds a band or removes one. After an afternoon her published
--  week had been whittled down to
--
--      Mon 11:00–12:00 · Tue 11:00–13:00 · Fri 14:00–15:00
--
--  which is four hours, all of them already booked. The front
--  desk then offered a visitor nothing and the lifecycle walk
--  stopped at "0 slots" — a fixture problem reported as a broken
--  booking flow.
--
--  THESE ARE THE HOURS THE REST OF THE SYSTEM ALREADY BELIEVES.
--  services/node-bff/config.js prints "Mon–Fri 10:00–19:00 · Sat
--  10:00–17:00 · Sun closed (IST)" at boot, and that had quietly
--  stopped matching what the slot engine reads. The engine reads
--  THIS table, so this is the one that decides.
--
--  A LUNCH HOUR, because a working week with no gap in it is not
--  one anybody keeps. Two bands a day rather than one long one.
--
--  Existing rules are closed off rather than deleted: a booking
--  already taken under an old band still has to make sense when
--  somebody reads the diary back.
--
--      psql -d myf_trial -f services/go-data/db/seed/practice_hours.sql
-- ============================================================

\set ON_ERROR_STOP on

BEGIN;

-- Retire whatever is published today. The exclusion constraint
-- refuses overlapping bands on the same weekday, so the old ones
-- have to end before the new ones begin.
DELETE FROM public.availability_rules
 WHERE effective_to IS NULL OR effective_to >= CURRENT_DATE;

-- Monday to Friday: 10:00–13:00 and 14:00–19:00.
INSERT INTO public.availability_rules (weekday, starts_min, ends_min, effective_from)
SELECT d, 600, 780, CURRENT_DATE FROM generate_series(1, 5) AS d
UNION ALL
SELECT d, 840, 1140, CURRENT_DATE FROM generate_series(1, 5) AS d;

-- Saturday: 10:00–13:00 and 14:00–17:00.
INSERT INTO public.availability_rules (weekday, starts_min, ends_min, effective_from)
VALUES (6, 600, 780, CURRENT_DATE),
       (6, 840, 1020, CURRENT_DATE);

-- Sunday is closed, which is said by having no row rather than by
-- a row that says zero.

SELECT
  CASE weekday WHEN 0 THEN 'Sun' WHEN 1 THEN 'Mon' WHEN 2 THEN 'Tue'
               WHEN 3 THEN 'Wed' WHEN 4 THEN 'Thu' WHEN 5 THEN 'Fri'
               ELSE 'Sat' END AS day,
  to_char((starts_min || ' minutes')::interval, 'HH24:MI') AS opens,
  to_char((ends_min   || ' minutes')::interval, 'HH24:MI') AS shuts
FROM public.availability_rules
WHERE effective_to IS NULL
ORDER BY weekday, starts_min;

COMMIT;
