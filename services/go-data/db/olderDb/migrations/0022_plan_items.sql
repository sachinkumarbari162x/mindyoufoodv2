-- ============================================================
--  0022_plan_items — what a model thinks her plan says
-- ------------------------------------------------------------
--  Phase three, and it is a MEASUREMENT before it is a feature.
--  Nothing downstream reads these rows yet. They exist so that,
--  after a few dozen real plans, we can answer one question with
--  evidence rather than optimism: how often does the assistant
--  read her writing correctly?
--
--  That is why `proposed` is here. It is frozen at the moment the
--  model answered and never touched again, while the columns
--  beside it are what she confirmed. The difference between the
--  two IS the measurement — a row where they match is a proposal
--  she accepted, a row where they differ is one she had to fix,
--  and a rejected row is one that was simply wrong.
--
--  A ROW IS NOT PART OF THE PLAN UNTIL SHE SAYS SO. Everything
--  arrives as status='proposed' with confirmed_at NULL, and every
--  reader downstream — the client's app, in a later phase — must
--  filter on confirmed. That is not a convention to remember; the
--  partial index below exists so the filter is cheap and the
--  intent is written into the schema.
--
--  THESE ROWS ARE DERIVED AND crm.plans.body IS NOT. If the two
--  ever disagree, the text is right and these are wrong. They can
--  be regenerated from it; it cannot be regenerated from them.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm.plan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  /* CASCADE, unlike the plan's own person reference. A plan is a
     clinical record and survives; these are a reading of it, and a
     reading of a document that no longer exists is nothing. */
  plan_id uuid NOT NULL REFERENCES crm.plans (id) ON DELETE CASCADE,

  -- Reading order, so the panel lines up with the text.
  seq int NOT NULL DEFAULT 0,

  /* Which line of plans.body produced this. Zero-based, and the
     whole reason the panel can show a proposal BESIDE the sentence
     it came from rather than in a list she has to reconcile by
     eye. */
  source_line int,

  kind text NOT NULL DEFAULT 'other'
    CHECK (kind IN ('meal', 'supplement', 'activity', 'sleep', 'habit', 'other')),

  -- "Two eggs at breakfast", "Vitamin D 60,000 IU", "Walk 25 minutes"
  label text NOT NULL,

  /* Nullable on purpose, and often null. "Eat more slowly" has no
     quantity, and inventing 1 for it would be a number she then has
     to read past on every row. */
  quantity numeric,
  unit     text NOT NULL DEFAULT '',

  -- "daily", "five days a week", "after dinner", "weekly"
  schedule text NOT NULL DEFAULT '',

  /* WHAT THE MODEL ACTUALLY SAID, frozen. Never updated, not even
     when she edits the row — the edit belongs in the columns above
     and the original belongs here, or the comparison this table
     exists for is destroyed the first time she fixes anything. */
  proposed jsonb NOT NULL DEFAULT '{}'::jsonb,

  /* proposed  — the model said it, she has not looked yet
     confirmed — she agreed with it as written
     edited    — she agreed with it after changing it
     rejected  — she said no; kept, because a wrong proposal is
                 the most interesting row in this table */
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'confirmed', 'edited', 'rejected')),

  /* Which model, so a change of model does not silently invalidate
     the accuracy figures gathered under the old one. */
  model text NOT NULL DEFAULT '',

  confirmed_by text,
  confirmed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plan_items_plan
  ON crm.plan_items (plan_id, seq);

/* The only rows a later phase may ever act on. A partial index
   rather than a comment, so "confirmed only" is cheap to ask for
   and hard to forget. */
CREATE INDEX IF NOT EXISTS plan_items_live
  ON crm.plan_items (plan_id)
  WHERE status IN ('confirmed', 'edited');

/* CONSISTENCY, NOT CONVENTION. A confirmed row without a name and
   a time against it would be a row that claims she agreed with no
   evidence of it — and this is the table that decides what a client
   is told to eat. */
ALTER TABLE crm.plan_items DROP CONSTRAINT IF EXISTS plan_items_confirmed_has_who;
ALTER TABLE crm.plan_items ADD CONSTRAINT plan_items_confirmed_has_who
  CHECK (
    (status IN ('proposed', 'rejected'))
    OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'myf_viewer') THEN
    REVOKE ALL ON crm.plan_items FROM myf_viewer;
  END IF;
END $$;
