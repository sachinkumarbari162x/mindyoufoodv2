-- ============================================================
--  0019_ratings — what the client thought of the appointment
-- ------------------------------------------------------------
--  ITS OWN TABLE, AND DELIBERATELY NOT PART OF THE CLINICAL
--  RECORD. What was assessed at a consultation and what somebody
--  thought of it are two different kinds of fact: one is her
--  professional judgement, the other is their opinion of the
--  service. Putting an opinion inside crm.assessments would mean
--  a client's star rating sitting in a document that may be sent
--  to a physician.
--
--  It is also why the viewer role is left alone here. There is
--  nothing clinical in this table, so nothing to REVOKE.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm.ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  consultation_id uuid NOT NULL
    REFERENCES crm.consultations (id) ON DELETE CASCADE,

  -- Null is a real answer: somebody may leave a comment without a
  -- score, or a score without a comment. Neither is worth refusing.
  stars smallint CHECK (stars BETWEEN 1 AND 5),
  comment text NOT NULL DEFAULT '',

  created_at timestamptz NOT NULL DEFAULT now()
);

/* ONE RATING PER CONSULTATION. The page asks once, after it ends;
   a second submission is somebody reloading, not a second opinion.
   The insert upserts, so the last thing they said is what stands. */
CREATE UNIQUE INDEX IF NOT EXISTS ratings_one_per_consultation
  ON crm.ratings (consultation_id);
