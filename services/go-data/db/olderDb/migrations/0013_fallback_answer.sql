-- ============================================================
--  0013_fallback_answer — what the desk says when it knows nothing
-- ------------------------------------------------------------
--  Every question the desk cannot place got the same sentence,
--  written into flow.js: "I can book you a consultation, tell you
--  what she works with, or answer questions about how the sessions
--  run."
--
--  That is the single most-said sentence on the site — it is the
--  reply to everything nobody has taught it yet — and it was the
--  one sentence she could not change without a deploy.
--
--  It becomes a knowledge row like the rest, so it appears on the
--  Knowledge page and she edits it there.
--
--  WHY THE INTENT IS 'fallback' AND NOTHING CLASSIFIES AS IT.
--  The NLU has no such intent, so this can never be returned by a
--  match — it is fetched by name, deliberately, at the one point in
--  the flow where nothing else answered. A topic that could both be
--  matched AND used as the catch-all would answer questions it had
--  no business answering.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

INSERT INTO crm.knowledge (intent, label, answer, active)
SELECT
  'fallback',
  'when the desk does not know',
  'I can book you a consultation, tell you what she works with, or answer ' ||
  'questions about how the sessions run. If it is something else, say so and ' ||
  'she will pick it up herself.',
  true
WHERE NOT EXISTS (SELECT 1 FROM crm.knowledge WHERE intent = 'fallback');
