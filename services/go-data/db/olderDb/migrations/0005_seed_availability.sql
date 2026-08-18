-- ============================================================
--  0005 · SEED HER WORKING WEEK
--
--  availability_rules has existed since 0001 but has been empty,
--  so the desk has been offering times from a hard-coded pattern
--  in Node config while the table that is supposed to own them
--  sat unused. Two sources, one of them ignored.
--
--  This makes the table the real one. It is seeded with the hours
--  already in use — Mon-Fri 10:00-19:00, Sat 10:00-17:00, Sunday
--  closed — so nothing changes for a visitor today, and the Hours
--  editor edits rows rather than needing a deploy.
--
--  Minutes from midnight, in the practice's timezone: these are
--  rules about the clock on the wall. Stored as instants they
--  would drift by an hour in any country that changes its clocks.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

-- Only seed an empty table. Re-running must never duplicate her
-- week, and must never overwrite hours she has since edited.
INSERT INTO availability_rules (weekday, starts_min, ends_min)
SELECT * FROM (VALUES
  -- Monday to Friday, 10:00 to 19:00
  (1, 600, 1140),
  (2, 600, 1140),
  (3, 600, 1140),
  (4, 600, 1140),
  (5, 600, 1140),
  -- Saturday, 10:00 to 17:00
  (6, 600, 1020)
  -- Sunday (0) is deliberately absent: no row means closed, which
  -- is the same thing the desk already tells visitors.
) AS seed(weekday, starts_min, ends_min)
WHERE NOT EXISTS (SELECT 1 FROM availability_rules);
