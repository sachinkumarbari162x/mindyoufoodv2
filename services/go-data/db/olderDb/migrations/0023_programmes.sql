-- ============================================================
--  0023_programmes — the client working through their plan
-- ------------------------------------------------------------
--  Phase four. The plan exists, she can hand it over, and an
--  assistant can read it into rows she has confirmed. This is the
--  part where somebody actually does it, day by day, and she can
--  see whether they did.
--
--  NO PHOTOGRAPHS HERE, deliberately. They are the largest piece,
--  the whole of the storage cost and most of the consent weight,
--  and none of that is needed to find out whether the loop works.
--  Ticks first.
--
--  THREE THINGS, and they are separate because they have separate
--  lifetimes:
--
--    programmes  the client's long-lived way in. Revocable,
--                one per plan, survives an amendment.
--    checkins    what they did, append-only. A correction is a
--                new row, never an edit.
--    (weights)   NOT a new table — they go to crm.measurements,
--                which already draws her curves. A second weight
--                table is one copy too many, so this migration
--                only adds the column that says who put it there.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

/* ---- who is on a programme --------------------------------------
   THE CREDENTIAL IS NOT THE PLAN LINK. That one is read-only and
   lives 180 days; this one accepts WRITES from the open internet
   for weeks, is installed to a home screen, and has to be killable
   the moment a phone is lost. Different powers, different table,
   different token.

   It points at (person, plan_no) rather than at a plan row, for the
   same reason plan_links does: she corrects a plan precisely because
   the old one was wrong, and the person following it should move
   with the correction. */
CREATE TABLE IF NOT EXISTS crm.programmes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  token text NOT NULL,

  person_id uuid NOT NULL REFERENCES crm.people (id) ON DELETE CASCADE,
  plan_no   int NOT NULL,

  /* active  — they are working through it
     ended   — it finished, or she ended it
     revoked — the token is dead. Kept as a row rather than deleted,
               because "this link was cut off on the 3rd" is a fact
               worth being able to answer. */
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'ended', 'revoked')),

  started_on date NOT NULL DEFAULT current_date,
  ends_on    date,

  opened_at  timestamptz,
  open_count int NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS programmes_token ON crm.programmes (token);

/* ONE LIVE PROGRAMME PER PLAN. Re-issuing returns the existing one
   rather than minting a second, so a client cannot end up holding
   two apps that disagree about what they did yesterday. A revoked
   one does not block a fresh start. */
CREATE UNIQUE INDEX IF NOT EXISTS programmes_one_live
  ON crm.programmes (person_id, plan_no)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS programmes_person ON crm.programmes (person_id, started_on DESC);

-- ------------------------------------------------------------

/* ---- what they did ----------------------------------------------
   APPEND-ONLY, AND THAT IS THE PRODUCT RULE. A client who can
   quietly rewrite last Tuesday's dinner has destroyed the only
   thing this table is worth. So there is no UPDATE path and no
   unique key forcing one row per day: a correction is a NEW row,
   the latest one for a day is what counts, and both stay.

   The erasure obligation is met at the account level, not here —
   immutable while the account lives, erasable as an account. See
   docs/consent-draft.md, where that split is written down for the
   reviewer. */
CREATE TABLE IF NOT EXISTS crm.checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  programme_id uuid NOT NULL REFERENCES crm.programmes (id) ON DELETE CASCADE,

  /* Which row of the plan. RESTRICT rather than CASCADE: a plan item
     that somebody has been ticking for three weeks is not something
     a later delete should be able to take with it. */
  plan_item_id uuid NOT NULL REFERENCES crm.plan_items (id) ON DELETE RESTRICT,

  -- The day being reported on, which is not the moment of reporting.
  -- Somebody catching up on Sunday evening is normal.
  on_date date NOT NULL,

  state text NOT NULL
    CHECK (state IN ('done', 'part', 'skip')),

  -- Their words. Short on purpose: this is a phone, in a kitchen.
  note text NOT NULL DEFAULT '',

  at timestamptz NOT NULL DEFAULT now()
);

/* The query the app makes on every open: this programme, this week.
   Descending on `at` because the latest row for a day is the answer. */
CREATE INDEX IF NOT EXISTS checkins_day
  ON crm.checkins (programme_id, on_date DESC, at DESC);

CREATE INDEX IF NOT EXISTS checkins_item
  ON crm.checkins (plan_item_id, on_date DESC);

-- ------------------------------------------------------------

/* ---- who weighed them -------------------------------------------
   Client-reported weights land in crm.measurements beside the ones
   she took, because "what has her weight done since March" must be
   one query against one table. But a bathroom scale at home and a
   calibrated one in the clinic are not the same number, and a curve
   that mixes them without saying so is a curve that misleads. */
ALTER TABLE crm.measurements
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'clinic';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'measurements_source_check'
  ) THEN
    ALTER TABLE crm.measurements
      ADD CONSTRAINT measurements_source_check
      CHECK (source IN ('clinic', 'self'));
  END IF;
END $$;

-- Which programme a self-reported figure arrived through. Null for
-- everything she recorded herself, which is every existing row.
ALTER TABLE crm.measurements
  ADD COLUMN IF NOT EXISTS programme_id uuid REFERENCES crm.programmes (id) ON DELETE SET NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'myf_viewer') THEN
    REVOKE ALL ON crm.programmes FROM myf_viewer;
    REVOKE ALL ON crm.checkins   FROM myf_viewer;
  END IF;
END $$;
