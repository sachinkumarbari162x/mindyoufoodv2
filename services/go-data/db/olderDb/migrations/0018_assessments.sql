-- ============================================================
--  0018_assessments — the nutrition assessment record
-- ------------------------------------------------------------
--  The most important table in this schema, and the reason the
--  rest of it exists. Everything else — the desk, the booking,
--  the reminders — is machinery for getting somebody in front of
--  her. This is the part that is worth anything afterwards.
--
--  THREE TABLES, because the sections of the form have genuinely
--  different lifetimes:
--
--    assessments   what she thought at one visit. A snapshot,
--                  versioned, never edited in place.
--    measurements  weights, waists and lab values. A TREND — the
--                  single most useful thing she owns is the shape
--                  of a curve, and a column holds one number.
--    goals         set at one visit, reviewed at later ones, so
--                  they outlive the row that created them.
--
--  NOTHING IS EVER DELETED AND NOTHING IS EVER EDITED. An
--  assessment is finalised and then amended, which writes a NEW
--  row carrying the next amendment number and a pointer back to
--  the one it corrects:
--
--      meera0_0 → meera0_1 → meera0_2      one visit, two corrections
--      meera1_0                            the next visit
--
--  A clinical note that can be silently rewritten is not a
--  record. Corrections are normal and expected; overwriting is
--  what is refused.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm.assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  person_id uuid NOT NULL REFERENCES crm.people (id) ON DELETE RESTRICT,

  /* Nullable on purpose. She opens the record when she likes — a
     phone consultation, a walk-in, or simply writing up something
     a client emailed. Requiring a booking would make the most
     important table in the system depend on the least important
     thing about it. */
  consultation_id uuid REFERENCES crm.consultations (id) ON DELETE SET NULL,

  -- Which visit, and which correction of that visit.
  visit     int NOT NULL DEFAULT 0,
  amendment int NOT NULL DEFAULT 0,

  -- "meera0_1" — human, sayable down a phone, and unique.
  ref text NOT NULL,

  -- The version this one corrects. Null for a first draft.
  amends uuid REFERENCES crm.assessments (id) ON DELETE RESTRICT,

  kind text NOT NULL DEFAULT 'first_visit'
    CHECK (kind IN ('first_visit', 'follow_up')),

  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'final')),

  /* EVERYTHING THAT IS NOT A TREND. The narrative half of the
     form — the recall, the PES statement, the plan, preferences,
     barriers. Kept as one document because it is read as one, is
     never queried field by field, and changes shape every time she
     decides a different question is worth asking.

     What is NOT in here: any number that belongs on a curve. Those
     live in crm.measurements and are not duplicated, because two
     copies of a weight is one copy too many. */
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Which sections she had open. Trivial, and it makes reopening
  -- the record feel like returning rather than starting again.
  open_sections jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- The box that is always there for whatever the form did not
  -- anticipate. Kept apart from `answers` because it is the one
  -- field guaranteed to be worth reading.
  notes text NOT NULL DEFAULT '',

  recorded_by text NOT NULL DEFAULT 'unknown',
  started_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  finalised_at timestamptz
);

-- The reference is the identity she will actually use.
CREATE UNIQUE INDEX IF NOT EXISTS assessments_ref
  ON crm.assessments (ref);

-- One row per version of a visit, and no way to write two.
CREATE UNIQUE INDEX IF NOT EXISTS assessments_version
  ON crm.assessments (person_id, visit, amendment);

CREATE INDEX IF NOT EXISTS assessments_person
  ON crm.assessments (person_id, visit DESC, amendment DESC);

CREATE INDEX IF NOT EXISTS assessments_consultation
  ON crm.assessments (consultation_id)
  WHERE consultation_id IS NOT NULL;

/* ONE OPEN DRAFT PER VISIT. Two drafts of the same visit means two
   half-written versions of one hour, and no way to tell which is
   the real one. */
CREATE UNIQUE INDEX IF NOT EXISTS assessments_one_draft
  ON crm.assessments (person_id, visit)
  WHERE status = 'draft';

-- ------------------------------------------------------------

/* THE TREND. One row per metric per moment, rather than a column
   per metric — so adding skinfold readings next year is an insert
   and not a migration, and a client weighed twice in a week has two
   rows instead of a conflict.

   Body measurements and lab values share this table because they
   are the same shape: a named quantity, a value, a unit and a time.
   `kind` keeps them apart where it matters. */
CREATE TABLE IF NOT EXISTS crm.measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  person_id uuid NOT NULL REFERENCES crm.people (id) ON DELETE RESTRICT,

  /* Which version recorded it. Kept so a measurement can be traced
     back to the note it was written in, and so amending a weight
     supersedes the old row rather than colliding with it. */
  assessment_id uuid REFERENCES crm.assessments (id) ON DELETE CASCADE,

  kind text NOT NULL DEFAULT 'body'
    CHECK (kind IN ('body', 'lab')),

  -- weight_kg, waist_cm, hba1c, ferritin — free text on purpose.
  metric text NOT NULL,
  value  numeric NOT NULL,
  unit   text NOT NULL DEFAULT '',

  -- How it was obtained. A bioimpedance body-fat reading and a
  -- self-reported one are not the same number.
  method text,

  -- Reference range, for labs. Null for body measurements.
  ref_low  numeric,
  ref_high numeric,

  taken_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS measurements_curve
  ON crm.measurements (person_id, metric, taken_at DESC);

CREATE INDEX IF NOT EXISTS measurements_assessment
  ON crm.measurements (assessment_id);

-- ------------------------------------------------------------

/* GOALS OUTLIVE THE VISIT THAT SET THEM, which is why they are rows
   and not a paragraph in the assessment. "Did the thing we agreed
   last month actually happen" is the question a follow-up exists to
   answer, and it cannot be asked of prose. */
CREATE TABLE IF NOT EXISTS crm.goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  person_id uuid NOT NULL REFERENCES crm.people (id) ON DELETE RESTRICT,
  set_at_assessment_id uuid REFERENCES crm.assessments (id) ON DELETE SET NULL,

  kind text NOT NULL DEFAULT 'behavioural'
    CHECK (kind IN ('behavioural', 'short_term', 'long_term')),

  goal text NOT NULL,

  -- What would show it happened.
  target_metric text,
  target_value  numeric,
  due_on        date,

  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'met', 'missed', 'dropped')),

  reviewed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS goals_person
  ON crm.goals (person_id, status, due_on);

-- ============================================================
--  AND THE ONE ACCOUNT THAT MAY NOT READ ANY OF IT
-- ------------------------------------------------------------
--  myf_viewer exists so she can inspect her own storage without a
--  write path, and it can currently SELECT every table in this
--  schema. These three are the exception: the clinical record is
--  the one thing the read-everything login has no business
--  reading, and saying so here is cheaper than remembering it
--  later.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'myf_viewer') THEN
    REVOKE ALL ON crm.assessments  FROM myf_viewer;
    REVOKE ALL ON crm.measurements FROM myf_viewer;
    REVOKE ALL ON crm.goals        FROM myf_viewer;
  END IF;
END $$;
