-- ============================================================
--  0021_plan_links — the way a client reads their plan
-- ------------------------------------------------------------
--  Same idea as crm.consultation_links: an opaque token that
--  reveals nothing by itself and resolves server-side. Different
--  table, because it is a different thing with a different
--  lifetime pointing at a different subject.
--
--  IT POINTS AT A PLAN, NOT AT A VERSION, and that is the whole
--  design. A token tied to plans.id would keep showing the copy it
--  was minted against — so a client who was given a corrected plan
--  would carry on following the wrong one, which is precisely the
--  failure the amend-forward rule exists to prevent. This points at
--  (person, plan_no) and resolves to the LATEST ISSUED amendment,
--  every time it is opened.
--
--  So one link per plan, handed over once, correct forever.
--
--  A DRAFT IS NEVER REACHABLE. The resolve reads issued rows only.
--  If she amends p0_0 into a draft p0_1 and has not issued it yet,
--  the client keeps seeing p0_0 — the version they were actually
--  given — until the moment she hands over the new one.
--
--  MONTHS, NOT HOURS. A consultation link outlives its appointment
--  by a day because it opens one room, once. A plan is read on a
--  Tuesday in week three, so this lives long enough to be useful
--  and not so long that a token in an old chat thread is worth
--  anything.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm.plan_links (
  -- 24 random bytes, base64url. Never sequential, never derived
  -- from anything about the person.
  token text PRIMARY KEY,

  /* CASCADE, unlike the plan itself which is RESTRICT. The plan is
     a clinical record and must survive; a link is only a doorway,
     and when a person is erased their doorways go with them. */
  person_id uuid NOT NULL REFERENCES crm.people (id) ON DELETE CASCADE,

  -- Which plan of theirs. Not which version.
  plan_no int NOT NULL,

  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Whether it has ever been opened, and how often. She should be
  -- able to see that a plan was never read.
  opened_at  timestamptz,
  open_count int NOT NULL DEFAULT 0
);

/* ONE LINK PER PLAN. Minting twice returns the first one rather
   than issuing a second — a client holding two URLs has no way to
   tell which is real, and both would work, which is worse. */
CREATE UNIQUE INDEX IF NOT EXISTS plan_links_one_per_plan
  ON crm.plan_links (person_id, plan_no);

CREATE INDEX IF NOT EXISTS plan_links_expiry
  ON crm.plan_links (expires_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'myf_viewer') THEN
    REVOKE ALL ON crm.plan_links FROM myf_viewer;
  END IF;
END $$;
