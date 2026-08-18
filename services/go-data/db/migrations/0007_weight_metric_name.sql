-- ============================================================
--  0007 — ONE NAME FOR A WEIGHT
-- ------------------------------------------------------------
--  crm.measurements held the same measurement under two names.
--
--    weight_kg   written by the token app at /me/, since it was
--                built. Two rows.
--    weight      written by the seed, read by the client panel's
--                chart, and the key in crm.metric_defs. Ten rows.
--
--  So a client who typed their weight into /me/ — the only place
--  in the product where they can — produced a row that no screen
--  reading `weight` would ever show. It did not error, it did not
--  warn, and the chart simply stayed as it was. The client
--  assumed it had been recorded, because it had; it was recorded
--  under a name nothing looked for.
--
--  This surfaced while merging the two client apps and would
--  otherwise have travelled straight into the merge, where it
--  would have been much harder to see: the same panel would then
--  be both writing and failing to read its own data.
--
--  THE UNIT DOES NOT BELONG IN THE NAME. `crm.measurements.unit`
--  is a column, and the registry in 0005 gives every metric a
--  DIMENSION so the same stored value can be shown in kilograms
--  or pounds from a setting. A metric called `weight_kg` cannot
--  be shown in pounds without lying about its own name.
--
--  `weight` wins because it is what metric_defs, the seed and
--  every screen already use. programmes.go is corrected in the
--  same commit so both endpoints write it.
-- ============================================================

UPDATE crm.measurements
   SET metric = 'weight',
       unit = CASE WHEN btrim(coalesce(unit, '')) = '' THEN 'kg' ELSE unit END
 WHERE metric = 'weight_kg';

/* Nothing enforces the name — `metric` is free text on purpose, so
   a reading can be recorded before the catalogue has caught up.
   This is the discipline instead: a comment naming the one that
   is canonical, next to the column that holds it. */
COMMENT ON COLUMN crm.measurements.metric IS
  'The metric key, matching crm.metric_defs.key where one exists. Never carries a unit — that is the unit column, and the registry''s dimension is what lets the same value be shown in kg or lb. Weight is `weight`, not `weight_kg`; see migration 0007.';
