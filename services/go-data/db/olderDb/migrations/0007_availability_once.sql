-- ============================================================
--  0007_availability_once — the same band cannot be saved twice
-- ------------------------------------------------------------
--  Reported as "same timeslots are being pushed and getting
--  updated". It was real, and the evidence was still in the table:
--
--    Mon 11:00-13:00   created 04:23:43
--    Mon 11:00-13:00   created 04:24:14
--
--  Thirty-one seconds apart. A second click, or a second submit,
--  and crmAddRules inserted it again without looking — the table
--  had a lookup index but nothing unique about it.
--
--  WHAT THIS DOES NOT DO, AND WHY
--
--  The first draft of this fix was an EXCLUDE constraint forbidding
--  bands that OVERLAP, which is a stronger and more obvious rule.
--  It was wrong. The live table holds ten overlapping pairs — the
--  seeded 10:00-19:00 week against every narrower band added since
--  — so the constraint would have refused to install, and would
--  have blocked her from ever adding 11:00-13:00 on top of a wider
--  day.
--
--  Bands are additive by design: a split day is two rows. So an
--  overlap is legal, and a narrow band inside a wide one simply has
--  no effect. That is confusing, but it is a question for the
--  interface, not a violation for the database to refuse.
--
--  The overlap rule comes later, once her real hours are settled
--  through the slot picker and the data can actually satisfy it.
--  A constraint that cannot be installed protects nothing.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

-- ------------------------------------------------------------
--  The duplicates already in the table.
--
--  Keeps the EARLIEST of each identical set and drops the rest.
--  Safe to the row: the rows in a set are identical in every
--  column that decides availability, so removing one changes
--  nothing about when she is free. Only the accidental second
--  copy goes.
--
--  Ordered by created_at with id as the tiebreak, so the outcome
--  is the same on every database this ever runs against rather
--  than depending on physical row order.
-- ------------------------------------------------------------
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY weekday, starts_min, ends_min, effective_from,
                        COALESCE(effective_to, DATE 'infinity')
           ORDER BY created_at, id
         ) AS n
  FROM availability_rules
)
DELETE FROM availability_rules
 WHERE id IN (SELECT id FROM ranked WHERE n > 1);

-- ------------------------------------------------------------
--  And the guard, so it cannot happen again.
--
--  COALESCE rather than a plain column list because effective_to
--  is null for "until further notice", and in a unique index two
--  nulls are DISTINCT — which would let the same open-ended band
--  be saved any number of times and defeat the whole point.
--
--  Postgres 15 could express this as NULLS NOT DISTINCT. The
--  COALESCE works on any version, including whatever Neon is
--  running when this moves, which is worth more than the shorter
--  spelling.
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS availability_rules_once
  ON availability_rules (
    weekday,
    starts_min,
    ends_min,
    effective_from,
    (COALESCE(effective_to, DATE 'infinity'))
  );
