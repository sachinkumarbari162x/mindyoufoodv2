-- ============================================================
--  0029_plan_drafts — how many times a plan has been WRITTEN from
--                      a finalised assessment
-- ------------------------------------------------------------
--  A SECOND COUNTER, NOT A SHARE OF THE FIRST, and the separation
--  matters.
--
--  `reads` (0026) counts the assistant READING her prose back into
--  rows. It is cheap, mechanical, and re-reading after editing a
--  line is a normal part of the work — which is why three is the
--  right number there.
--
--  This counts the assistant WRITING a first draft from the
--  nutrition assessment. It is a different job: a much larger
--  prompt, the whole clinical record as input, and a generative
--  answer rather than an extraction. Charging it against `reads`
--  would mean one press of Fetch and create eats a third of the
--  reads she needs afterwards to check her own edits — so the
--  expensive button would quietly disable the cheap one.
--
--  THREE AGAIN, for the same reason as 0026 rather than for
--  symmetry: if the assistant has produced three unusable drafts
--  from the same assessment, the assessment is what is thin, and
--  the fix is to fill it in rather than to press again.
--
--  IT RESETS ON AN AMENDMENT, which falls out of the design: an
--  amendment is a new row in crm.plans and starts at zero.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

ALTER TABLE crm.plans
  ADD COLUMN IF NOT EXISTS drafts int NOT NULL DEFAULT 0;

COMMENT ON COLUMN crm.plans.drafts IS
  'Times a first draft has been written from the finalised assessment. Claimed atomically in Go before the model is called, so a double click cannot spend two.';
