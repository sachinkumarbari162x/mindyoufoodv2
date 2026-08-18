-- ============================================================
--  What the client's own account needs
-- ------------------------------------------------------------
--  Sleep, workout, health records, an FAQ and a way to sign in.
--
--  MOST OF IT NEEDED NO NEW TABLE, which is worth saying out
--  loud before the two below:
--
--    the wind-down routine   plan_items, kind 'habit', with the
--                            time in `schedule`
--    workout exercises       plan_items, kind 'activity'
--    meals and supplements   plan_items, as they already are
--    ticking any of it off   crm.checkins, unchanged
--    sessions               crm.consultations, unchanged
--    the sleep window        plans.targets, which is jsonb
--
--  A feature that fits the tables you have is a feature you can
--  ship. What follows is only the part that genuinely does not
--  fit.
-- ============================================================

-- ---- 1. what a measurement can be ---------------------------
--  Sleep is neither a body measurement nor a lab result, and a
--  client typing "6h40 last night" is the same shape of fact as
--  a client typing their weight: one number, one night, theirs.
--
--  AND 'device'. There is no wearable integration and none is
--  being built — but the question keeps coming up, and the honest
--  answer is that it is one enum value, not a subsystem. A watch
--  that syncs later writes measurements with source 'device', and
--  every chart already knows how to draw them. What it must never
--  do is arrive claiming to be 'clinic': she took that reading or
--  she did not.
ALTER TABLE crm.measurements DROP CONSTRAINT IF EXISTS measurements_kind_check;
ALTER TABLE crm.measurements ADD CONSTRAINT measurements_kind_check
  CHECK (kind IN ('body', 'lab', 'sleep', 'activity'));

ALTER TABLE crm.measurements DROP CONSTRAINT IF EXISTS measurements_source_check;
ALTER TABLE crm.measurements ADD CONSTRAINT measurements_source_check
  CHECK (source IN ('clinic', 'self', 'device'));

-- ---- 2. a plan line that is an exercise ---------------------
--  "4 × 8–12, 90 seconds rest, Monday, push" does not fit
--  quantity + unit + schedule without losing something, and the
--  thing it loses is the part a client needs on the day.
--
--  jsonb rather than six columns because the shape differs by
--  kind: an exercise has sets and reps, a meal has none of that,
--  and a table with four always-null columns per row teaches the
--  next reader nothing. `proposed` is not reused for this — that
--  one records what a model suggested, and conflating provenance
--  with content is how you lose the ability to tell them apart.
ALTER TABLE crm.plan_items ADD COLUMN IF NOT EXISTS detail jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN crm.plan_items.detail IS
  'Kind-specific content: {sets, reps, restSeconds, day, block} for an activity, {kcal} for a meal. Empty for kinds that need none.';

-- ---- 3. who a knowledge answer is for -----------------------
--  crm.knowledge is the front desk's answers — booking, hours,
--  what she works with. A client asking "can I swap rice for
--  roti" is a different audience with different questions, and
--  the desk must never answer one with the other.
--
--  Same table because it is the same shape and she should edit
--  both in one place; a column because the two must not mix.
ALTER TABLE crm.knowledge ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'desk';
ALTER TABLE crm.knowledge DROP CONSTRAINT IF EXISTS knowledge_audience_check;
ALTER TABLE crm.knowledge ADD CONSTRAINT knowledge_audience_check
  CHECK (audience IN ('desk', 'client'));

--  The "one active answer per intent" rule has to become one per
--  intent PER AUDIENCE, or adding a client answer would silently
--  collide with the desk's.
DROP INDEX IF EXISTS crm.knowledge_intent_active;
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_intent_active
  ON crm.knowledge (audience, intent) WHERE active;
