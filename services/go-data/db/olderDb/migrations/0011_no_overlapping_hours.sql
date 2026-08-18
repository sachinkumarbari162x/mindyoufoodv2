-- ============================================================
--  0011_no_overlapping_hours — one band cannot sit inside another
-- ------------------------------------------------------------
--  Reported from the Hours page: 11:00-13:00 and 11:00-12:00 both
--  saved on the same Monday. Migration 0007 stopped EXACT
--  duplicates; this stops overlaps, which is the mistake actually
--  being made.
--
--  It was deliberately deferred then, and this is why: the table
--  held ten overlapping pairs from the seeded week, so the
--  constraint could not have been created and would have blocked
--  her from adding a narrow band on top of a wider day. Those rows
--  are gone now and the only overlap left is the one being
--  reported, so the rule can finally be made real.
--
--  WHY A CONSTRAINT AND NOT A CHECK IN THE HANDLER. Two requests
--  arriving together both pass an application check and both write.
--  Only the database can refuse the second one, which is the same
--  reasoning as the partial unique index that guards double
--  bookings.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ------------------------------------------------------------
--  Clear what is already overlapping, before the rule is imposed.
--
--  A band completely inside another is removed and the WIDER one
--  kept, which changes nothing about when she is available: the
--  narrow one was adding no minute the wide one did not already
--  cover. That is the whole of the case being reported.
--
--  Partial overlaps — 11:00-13:00 against 12:00-14:00 — are left
--  alone. There is no reading of those two that is obviously the
--  one she meant, and a migration that guesses at her working week
--  is worse than one that refuses to start. If any remain, the
--  constraint below will fail loudly and she can settle it herself.
-- ------------------------------------------------------------
DELETE FROM availability_rules a
 USING availability_rules b
 WHERE a.id <> b.id
   AND a.weekday = b.weekday
   AND b.starts_min <= a.starts_min
   AND b.ends_min   >= a.ends_min
   AND (b.ends_min - b.starts_min) > (a.ends_min - a.starts_min)
   AND daterange(b.effective_from, b.effective_to, '[]')
       @> daterange(a.effective_from, a.effective_to, '[]');

-- ------------------------------------------------------------
--  And the rule itself.
--
--  Ranges rather than a unique index, because "the same band twice"
--  and "a band inside another" are the same mistake and only a
--  range exclusion catches both. int4range on the minutes, daterange
--  on the period it applies to, so a band that ends in October does
--  not conflict with one that starts in November.
-- ------------------------------------------------------------
ALTER TABLE availability_rules
  DROP CONSTRAINT IF EXISTS availability_rules_no_overlap;

ALTER TABLE availability_rules
  ADD CONSTRAINT availability_rules_no_overlap
  EXCLUDE USING gist (
    weekday WITH =,
    int4range(starts_min, ends_min) WITH &&,
    daterange(effective_from, effective_to, '[]') WITH &&
  );
