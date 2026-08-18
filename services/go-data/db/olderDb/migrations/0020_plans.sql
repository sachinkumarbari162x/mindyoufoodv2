-- ============================================================
--  0020_plans — the nutrition care plan she hands over
-- ------------------------------------------------------------
--  The assessment says what she FOUND. This says what she asked
--  the client to DO about it, and it is the thing that leaves the
--  room with them.
--
--  IT IS A PLAN, NOT A PRESCRIPTION, and the noun is deliberate
--  rather than squeamish. A dietitian in India is not a registered
--  medical practitioner; "prescription" implies a diagnosis and a
--  treatment authority she does not hold. The pad she writes it on
--  is shaped like a doctor's — one surface, write fast, hand it
--  over — and only the word is different.
--
--  ONE TEXT COLUMN, and that is the whole point of this phase.
--  Later versions will carry structured rows the client's app can
--  tick off, proposed by an assistant and confirmed by her. Those
--  rows will be a DERIVED VIEW of this column and never a
--  replacement for it: `body` is the record of what she actually
--  said, in her words, and it is what a court or a colleague would
--  be shown. A model's reading of it is an opinion about the
--  record, not the record.
--
--  SAME AMEND-FORWARD RULE AS crm.assessments. A plan is issued and
--  then amended, which writes a NEW row carrying the next amendment
--  number and a pointer back to the one it corrects:
--
--      aishap1_0 → aishap1_1        one plan, corrected once
--      aishap2_0                    the plan after the next visit
--
--  Once issued, a plan is never edited. The client has a copy of
--  it; a record that can be silently changed after they have acted
--  on it is worse than no record.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm.plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  person_id uuid NOT NULL REFERENCES crm.people (id) ON DELETE RESTRICT,

  /* Nullable, like the assessment's. Most plans follow a
     consultation, but she may write one after a phone call or
     revise one between visits, and the record should not depend on
     a booking existing. */
  consultation_id uuid REFERENCES crm.consultations (id) ON DELETE SET NULL,

  -- Which plan for this person, and which correction of it.
  plan_no   int NOT NULL DEFAULT 0,
  amendment int NOT NULL DEFAULT 0,

  -- "aishakhanp1_0" — sayable down a phone, and unique.
  ref text NOT NULL,

  -- The version this one corrects. Null for a first draft.
  amends uuid REFERENCES crm.plans (id) ON DELETE RESTRICT,

  /* draft   — she is still writing it, nobody has seen it
     issued  — handed over; frozen, and only amendable forward

     Not 'final'. A plan is not concluded, it is given to somebody,
     and the word she will read on the button should say which. */
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued')),

  /* THE PLAN ITSELF. One large text field, because that is how she
     writes it and because any schema imposed here would be a guess
     about a document that changes shape with every client.

     Structure comes later and comes from this, never instead of
     it. */
  body text NOT NULL DEFAULT '',

  /* Her own note about the plan — why she chose it, what she is
     watching for, what to check at the next visit. Kept apart from
     `body` because `body` is handed to the client and this is not.

     THIS IS THE COLUMN THAT MUST NOT LEAK. Everything else in this
     table is written to be read by the person it is about. */
  private_note text NOT NULL DEFAULT '',

  /* What the numbers were when she wrote it — energy target,
     protein, the activity factor she assumed. Copied from the
     assessment at the moment of issue rather than recomputed on
     read, so a plan issued in March still shows the March figures
     when the April weight arrives.

     A snapshot, not a link. The whole reason it is here. */
  targets jsonb NOT NULL DEFAULT '{}'::jsonb,

  recorded_by text NOT NULL DEFAULT 'unknown',
  started_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  issued_at   timestamptz
);

-- The reference is the identity she will actually use.
CREATE UNIQUE INDEX IF NOT EXISTS plans_ref
  ON crm.plans (ref);

-- One row per version of a plan, and no way to write two.
CREATE UNIQUE INDEX IF NOT EXISTS plans_version
  ON crm.plans (person_id, plan_no, amendment);

CREATE INDEX IF NOT EXISTS plans_person
  ON crm.plans (person_id, plan_no DESC, amendment DESC);

CREATE INDEX IF NOT EXISTS plans_consultation
  ON crm.plans (consultation_id)
  WHERE consultation_id IS NOT NULL;

/* ONE OPEN DRAFT PER PLAN. Two half-written versions of the same
   plan and no way to say which one the client is going to get. */
CREATE UNIQUE INDEX IF NOT EXISTS plans_one_draft
  ON crm.plans (person_id, plan_no)
  WHERE status = 'draft';

-- ============================================================
--  AND THE READ-EVERYTHING LOGIN STILL MAY NOT READ IT
-- ------------------------------------------------------------
--  Same reasoning as 0018: myf_viewer exists so she can inspect
--  her storage without a write path, and the clinical record is
--  the one thing it has no business seeing. A plan carries a named
--  person's conditions and what she told them to eat about it.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'myf_viewer') THEN
    REVOKE ALL ON crm.plans FROM myf_viewer;
  END IF;
END $$;
