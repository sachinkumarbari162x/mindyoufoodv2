-- ============================================================
--  0026_plan_reads — how many times the assistant has read a plan
-- ------------------------------------------------------------
--  A cap of three per version, counted here rather than in a
--  browser, because a counter in a browser is a suggestion.
--
--  WHY CAP IT AT ALL. Every press is a call to somebody else's
--  model with somebody's clinical text in it, and it costs money
--  per call. Neither of those is the real reason. The real reason
--  is that the fourth read of unchanged text tells her nothing the
--  first three did not: if the assistant has misread a sentence
--  three times, the sentence is the problem, and the fix is to
--  rewrite the line rather than to keep asking. A button with no
--  limit invites exactly the wrong response to a bad answer.
--
--  THREE, not one. The reconcile in plan_items.go means a re-read
--  after editing the text is a normal and useful thing to do —
--  write, read, fix a line, read again. Two is tight for that and
--  five is not a limit.
--
--  IT RESETS ON AN AMENDMENT, and that falls out of the design
--  rather than needing code: an amendment is a new row in
--  crm.plans, so it starts at zero. A plan she has genuinely
--  rewritten gets three fresh reads, which is right.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

ALTER TABLE crm.plans
  ADD COLUMN IF NOT EXISTS reads int NOT NULL DEFAULT 0;

COMMENT ON COLUMN crm.plans.reads IS
  'Times the assistant has been asked to read this version. Capped in the BFF before the model is called, and incremented in Go after the rows land.';
